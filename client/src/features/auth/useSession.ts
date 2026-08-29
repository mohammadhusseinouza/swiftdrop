import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppDispatch } from '../../app/hooks';
import { api } from '../../services/api';
import {
  useLoginMutation,
  useLogoutMutation,
  type LoginRequest,
} from '../../services/authApi';
import { clearAccessToken } from '../../services/accessToken';
import { getApiErrorStatus, type UnknownApiError } from '../../services/apiError';
import { setAuthenticatedUser, setUnauthenticated } from './authSlice';
import { getDefaultAuthenticatedPath, isSafeInternalPath } from './portal';
import type { AuthenticatedUser } from './auth.types';

/**
 * Session orchestration for Phase 11.1's Login page and the future Navbar
 * logout control. Phase 10.5 owns the wiring between the RTK Query auth
 * transport (Phase 10.4) and the auth Redux slice.
 *
 * Navigation lives here (session orchestration) — never inside the low-level
 * baseQuery.
 */

export interface LoginOptions {
  /** Post-login redirect target; used only if it is a safe app-internal path. */
  redirectTo?: string | null;
}

export function useLogin() {
  const [loginMutation, state] = useLoginMutation();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();

  const login = useCallback(
    async (
      credentials: LoginRequest,
      options: LoginOptions = {},
    ): Promise<AuthenticatedUser> => {
      // `.unwrap()` throws the RTK error on failure, preserving the backend
      // error body for the Login page to display. On an invalid-credentials
      // 401 nothing below runs: no refresh (endpoint is skipReauth), no
      // auth-state change, no cache reset.
      const user = await loginMutation(credentials).unwrap();

      // The mutation result has been consumed — now it is safe to drop any
      // stale cache left by a previous user in this browser session, before
      // the new user's protected data is fetched.
      dispatch(api.util.resetApiState());
      dispatch(setAuthenticatedUser(user));

      const fallback = getDefaultAuthenticatedPath(user) ?? '/unauthorized';
      const target = isSafeInternalPath(options.redirectTo)
        ? options.redirectTo
        : fallback;
      navigate(target, { replace: true });

      return user;
    },
    [loginMutation, dispatch, navigate],
  );

  return { login, ...state };
}

export function useLogout() {
  const [logoutMutation, state] = useLogoutMutation();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();

  const logout = useCallback(async (): Promise<void> => {
    try {
      await logoutMutation().unwrap();
    } catch (error) {
      // A 401 means the session was already invalid on the backend — safe to
      // finish the local logout. Anything else (transport / 5xx) may mean the
      // refresh cookie is still live server-side: surface it rather than
      // pretending revocation happened.
      if (getApiErrorStatus(error as UnknownApiError) !== 401) {
        throw error;
      }
    }

    // authApi.logout already clears the in-memory token; do it again
    // defensively, then reset auth state + wipe all protected cache so the
    // next user cannot see this user's data.
    clearAccessToken();
    dispatch(setUnauthenticated());
    dispatch(api.util.resetApiState());
    navigate('/auth/login', { replace: true });
  }, [logoutMutation, dispatch, navigate]);

  return { logout, ...state };
}
