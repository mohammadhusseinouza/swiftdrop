import { api } from './api';
import { clearAccessToken, setAccessToken } from './accessToken';
import { setAuthenticatedUser } from '../features/auth/authSlice';
import type { ApiSuccessResponse } from './apiTypes';
import type {
  AuthenticatedUser,
  AuthUserRole,
} from '../features/auth/auth.types';

/**
 * Auth transport layer (Phase 10.4). This maps the existing backend auth
 * endpoints and integrates the in-memory access token. It does NOT:
 *   - implement a Login page (Phase 11.1)
 *   - run any bootstrap / call these endpoints automatically (Phase 10.5)
 *   - store the access token anywhere persistent or cacheable
 *
 * Backend contracts (server/src/modules/auth):
 *   POST /auth/login    body {email,password}   -> data {user, permissions, accessToken}  (+ Set-Cookie refresh_token)
 *   POST /auth/refresh  (cookie only)           -> data {accessToken}                     (+ rotated Set-Cookie)   [handled inside baseQueryWithReauth]
 *   POST /auth/logout   (cookie only)           -> data {loggedOut: true}                 (+ cleared cookie)
 *   GET  /auth/me       Bearer                  -> data {user, permissions}
 */

export interface LoginRequest {
  email: string;
  password: string;
}

/** Backend SafeUser (server/src/modules/auth/auth.types.ts). */
interface SafeUserDto {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  isActive: boolean;
  role: AuthUserRole;
}

/** Raw `data` of POST /auth/login — CONTAINS accessToken; never cached as-is. */
interface RawLoginData {
  user: SafeUserDto;
  permissions: string[];
  accessToken: string;
}

/** Raw `data` of GET /auth/me. */
interface UserAccessData {
  user: SafeUserDto;
  permissions: string[];
}

function toAuthenticatedUser(
  data: UserAccessData | RawLoginData,
): AuthenticatedUser {
  return { ...data.user, permissions: data.permissions };
}

export const authApi = api.injectEndpoints({
  endpoints: (builder) => ({
    login: builder.mutation<AuthenticatedUser, LoginRequest>({
      query: (body) => ({ url: '/auth/login', method: 'POST', body }),
      // An invalid-credentials 401 here must not trigger a refresh attempt.
      extraOptions: { skipReauth: true },
      transformResponse: (
        response: ApiSuccessResponse<RawLoginData>,
      ): AuthenticatedUser => {
        // Capture the token into module memory BEFORE returning, and strip it
        // so the RTK Query cache only ever holds the safe identity.
        setAccessToken(response.data.accessToken);
        return toAuthenticatedUser(response.data);
      },
      invalidatesTags: [{ type: 'Auth', id: 'ME' }],
    }),

    getMe: builder.query<AuthenticatedUser, void>({
      query: () => ({ url: '/auth/me' }),
      transformResponse: (response: ApiSuccessResponse<UserAccessData>) =>
        toAuthenticatedUser(response.data),
      providesTags: [{ type: 'Auth', id: 'ME' }],
      // Auth-slice synchronization (Phase 10.5). Success -> hydrate identity.
      // A 401 after the reauth flow is handled centrally in baseQueryWithReauth
      // (it dispatches setUnauthenticated); a transport/5xx failure is left
      // alone so the bootstrap boundary can show its "retry" view instead of
      // wrongly logging the user out.
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(setAuthenticatedUser(data));
        } catch {
          // Intentionally no-op: a 401 after reauth is handled centrally in
          // baseQueryWithReauth (setUnauthenticated); a transport/5xx failure
          // must NOT log the user out — the bootstrap boundary shows a retry.
        }
      },
    }),

    logout: builder.mutation<{ loggedOut: boolean }, void>({
      query: () => ({ url: '/auth/logout', method: 'POST' }),
      extraOptions: { skipReauth: true },
      transformResponse: (
        response: ApiSuccessResponse<{ loggedOut: boolean }>,
      ) => response.data,
      async onQueryStarted(_arg, { queryFulfilled }) {
        try {
          await queryFulfilled;
        } finally {
          // Always drop the in-memory token on a logout attempt. Broader
          // cache reset (api.util.resetApiState) and navigation are left to
          // Phase 10.5 logout orchestration to avoid a reset/refetch loop here.
          clearAccessToken();
        }
      },
      invalidatesTags: [{ type: 'Auth', id: 'ME' }],
    }),
  }),
});

export const { useLoginMutation, useGetMeQuery, useLazyGetMeQuery, useLogoutMutation } =
  authApi;
