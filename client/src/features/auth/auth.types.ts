/**
 * Client-side mirror of the backend safe auth DTO.
 *
 * Source of truth: server/src/modules/auth/auth.types.ts
 *   GET  /api/v1/auth/me    -> data: { user: SafeUser, permissions: string[] }
 *   POST /api/v1/auth/login -> data: { user: SafeUser, permissions: string[], accessToken }
 *
 * The `accessToken` and the HttpOnly refresh cookie are deliberately NOT modeled
 * here: token handling is Phase 10.4 / 10.5 and never belongs in Redux state.
 *
 * These types are hand-written (client and server are separate packages — do not
 * import from server/). Phase 10.4 RTK Query response types can reuse them.
 */
export interface AuthUserRole {
  id: string;
  code: string;
  name: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  isActive: boolean;
  role: AuthUserRole;
  /**
   * Permission codes exactly as returned by the backend safe auth response.
   * UX state only — the backend independently re-authorizes every request.
   */
  permissions: string[];
}

/**
 * `unknown`  — no bootstrap has run yet (Phase 10.5 will call /auth/me first).
 * `authenticated` / `unauthenticated` — resolved identity state.
 *
 * `user === null` alone does NOT mean unauthenticated before bootstrap.
 */
export type AuthStatus = 'unknown' | 'authenticated' | 'unauthenticated';
