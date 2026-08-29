/**
 * Central API configuration. The backend URL is read once, here — never
 * inlined into individual domain modules.
 *
 * `VITE_API_BASE_URL` is PUBLIC (embedded in the browser bundle) — it must
 * only ever hold the API root URL, never a secret. See client/.env.example.
 *
 * Dev options:
 *   - absolute (default):  http://localhost:3000/api/v1  — direct to backend.
 *     The backend currently has NO CORS middleware, so browser cross-origin
 *     requests with credentials will be blocked; use this value for Node
 *     tooling / tests, or once the backend enables CORS.
 *   - relative:            /api/v1  — routed through the Vite dev proxy
 *     (see vite.config.ts), same-origin, cookies work, no CORS needed.
 */
function resolveApiBaseUrl(): string {
  const raw = import.meta.env.VITE_API_BASE_URL;

  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(
      'VITE_API_BASE_URL is not set. Copy client/.env.example to client/.env ' +
        'and set the backend API root (e.g. http://localhost:3000/api/v1).',
    );
  }

  // Trim whitespace and any trailing slash so callers can always use
  // leading-slash paths ("/auth/login") without producing "//".
  return raw.trim().replace(/\/+$/, '');
}

export const API_BASE_URL = resolveApiBaseUrl();
