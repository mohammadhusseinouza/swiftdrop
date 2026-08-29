/**
 * In-memory access-token holder.
 *
 * The access token lives ONLY in this module's closure for the lifetime of the
 * page. It is deliberately NOT put in Redux, RTK Query cache, localStorage,
 * sessionStorage or any persisted store — so a page reload drops it, and the
 * Phase 10.5 `/auth/me` bootstrap recovers the session via the backend's
 * HttpOnly refresh cookie instead.
 *
 * Never log the value. Never serialize it into a response/DTO.
 */
let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string): void {
  accessToken = token;
}

export function clearAccessToken(): void {
  accessToken = null;
}
