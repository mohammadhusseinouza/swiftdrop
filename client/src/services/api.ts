import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type {
  BaseQueryFn,
  FetchArgs,
  FetchBaseQueryError,
} from '@reduxjs/toolkit/query';
import { API_BASE_URL } from './config';
import {
  clearAccessToken,
  getAccessToken,
  setAccessToken,
} from './accessToken';
import type { ApiSuccessResponse } from './apiTypes';
import { setUnauthenticated } from '../features/auth/authSlice';

/**
 * The ONE shared RTK Query API slice for the whole frontend.
 *
 * Every domain module (auth, orders, customers, ...) calls
 * `api.injectEndpoints(...)` — there is exactly one `createApi` instance, so
 * one cache reducer (`api`), one middleware, one set of tag types.
 */

/** Per-endpoint options understood by `baseQueryWithReauth`. */
export interface ReauthExtraOptions {
  /**
   * Skip the 401 → refresh → retry cycle. Set on the auth endpoints
   * themselves (login/refresh/logout) so e.g. an invalid-credentials 401 from
   * `/auth/login` never triggers an irrelevant refresh.
   */
  skipReauth?: boolean;
}

const rawBaseQuery = fetchBaseQuery({
  baseUrl: API_BASE_URL,
  // Required so the backend HttpOnly refresh cookie is sent on
  // /auth/refresh and /auth/logout (and received on /auth/login).
  credentials: 'include',
  prepareHeaders: (headers) => {
    const token = getAccessToken();
    // Only ever attach the in-memory token; never send an empty header.
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    return headers;
  },
});

/**
 * Single-flight refresh guard: the first qualifying 401 starts one
 * `POST /auth/refresh`; every concurrent 401 awaits that same promise, so a
 * burst of simultaneously-expired requests produces exactly one refresh HTTP
 * call and one rotation of the refresh cookie.
 */
let inFlightRefresh: Promise<string | null> | null = null;

function runSingleFlightRefresh(
  api: Parameters<BaseQueryFn>[1],
): Promise<string | null> {
  if (!inFlightRefresh) {
    inFlightRefresh = (async () => {
      const refreshResult = await rawBaseQuery(
        { url: '/auth/refresh', method: 'POST' },
        api,
        // skipReauth is irrelevant to rawBaseQuery itself, but keeps intent
        // explicit: the refresh call must never re-enter reauth.
        { skipReauth: true },
      );

      const body = refreshResult.data as
        | ApiSuccessResponse<{ accessToken: string }>
        | undefined;
      const newToken = body?.data?.accessToken;

      if (typeof newToken === 'string' && newToken.length > 0) {
        setAccessToken(newToken);
        return newToken;
      }

      // Refresh session invalid/expired — drop the stale in-memory token.
      clearAccessToken();
      return null;
    })().finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
}

export const baseQueryWithReauth: BaseQueryFn<
  string | FetchArgs,
  unknown,
  FetchBaseQueryError,
  ReauthExtraOptions
> = async (args, api, extraOptions) => {
  const result = await rawBaseQuery(args, api, extraOptions);

  // Only a genuine 401 qualifies. 403 (forbidden), 400 (validation), 409
  // (conflict), 5xx and transport errors (FETCH_ERROR/TIMEOUT/PARSING) are
  // returned untouched — never refreshed.
  if (result.error?.status !== 401 || extraOptions?.skipReauth) {
    return result;
  }

  const newToken = await runSingleFlightRefresh(api);
  if (!newToken) {
    // Refresh failed — the session is invalid. Centralized session-expiry
    // sync (Phase 10.5): flip the auth slice out of "authenticated" so no
    // page keeps trusting a dead session. Redirects stay in the route guards,
    // never here; the access token was already cleared by the refresh helper.
    api.dispatch(setUnauthenticated());
    return result;
  }

  // Retry the ORIGINAL request exactly once, with reauth disabled so a
  // second 401 cannot start another refresh (no recursion, no loop).
  const retryResult = await rawBaseQuery(args, api, {
    ...extraOptions,
    skipReauth: true,
  });

  // Refresh succeeded but the retry is still 401 (e.g. the account was
  // deactivated between refresh and retry) — the session is effectively dead.
  if (retryResult.error?.status === 401) {
    api.dispatch(setUnauthenticated());
  }

  return retryResult;
};

/**
 * Cache tag taxonomy. LIST/singleton ids are used per convention:
 *   { type: 'Order', id: 'LIST' } / { type: 'Order', id: <orderId> }
 *   { type: 'Finance', id: 'SUMMARY' | 'TRANSACTIONS' }
 *   { type: 'Dashboard', id: 'ROOT' }
 *   { type: 'DriverCash', id: 'ME' }
 *   { type: 'Settings', id: 'AREAS' | 'PAYMENT_METHODS' | 'FAILED_DELIVERY_REASONS' | 'SYSTEM' | 'LIST' }
 */
export const API_TAG_TYPES = [
  'Auth',
  'Order',
  'DriverOrder',
  'Customer',
  'Driver',
  'Wallet',
  'WalletTransaction',
  'Payout',
  'DriverCash',
  'Settlement',
  'Dashboard',
  'Finance',
  'Report',
  'Settings',
  'AuditLog',
] as const;

export type ApiTagType = (typeof API_TAG_TYPES)[number];

export const api = createApi({
  reducerPath: 'api',
  baseQuery: baseQueryWithReauth,
  tagTypes: API_TAG_TYPES,
  // Domain modules add endpoints via api.injectEndpoints(...).
  endpoints: () => ({}),
});
