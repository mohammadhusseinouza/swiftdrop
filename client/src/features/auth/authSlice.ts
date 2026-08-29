import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '../../app/store';
import type { AuthenticatedUser, AuthStatus } from './auth.types';

/**
 * Client/global identity state only. No login, /auth/me, refresh or logout
 * requests here — that is Phase 10.5. No tokens are stored (see auth.types.ts).
 */
export interface AuthState {
  user: AuthenticatedUser | null;
  status: AuthStatus;
}

const initialState: AuthState = {
  user: null,
  status: 'unknown',
};

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    /** Hydrate the identity summary from the backend safe auth response. */
    setAuthenticatedUser(state, action: PayloadAction<AuthenticatedUser>) {
      state.user = action.payload;
      state.status = 'authenticated';
    },
    /** Bootstrap resolved with no active session, or session ended. */
    setUnauthenticated(state) {
      state.user = null;
      state.status = 'unauthenticated';
    },
    /** Back to the pre-bootstrap `unknown` state. */
    resetAuth() {
      return initialState;
    },
  },
});

export const { setAuthenticatedUser, setUnauthenticated, resetAuth } =
  authSlice.actions;
export const authReducer = authSlice.reducer;

export const selectCurrentUser = (state: RootState): AuthenticatedUser | null =>
  state.auth.user;
export const selectAuthStatus = (state: RootState): AuthStatus =>
  state.auth.status;
export const selectIsAuthenticated = (state: RootState): boolean =>
  state.auth.status === 'authenticated';

/** Permission codes from the hydrated identity — never synthesised from role. */
export const selectPermissions = (state: RootState): string[] =>
  state.auth.user?.permissions ?? [];

/**
 * Membership check against the actual hydrated permission strings. This is a UX
 * helper only; the backend is the authoritative authorization boundary.
 */
export const selectHasPermission =
  (permission: string) =>
  (state: RootState): boolean =>
    selectPermissions(state).includes(permission);
