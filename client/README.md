# SwiftDrop Client

Frontend for the SwiftDrop delivery management system.

**Stack:** React + TypeScript + Vite + Tailwind CSS.

## Getting started

```bash
cd client
npm install
cp .env.example .env   # adjust VITE_API_BASE_URL if the backend runs elsewhere
npm run dev
```

## Scripts

| Command             | Description                              |
| ------------------- | ---------------------------------------- |
| `npm run dev`       | Start the Vite dev server                |
| `npm run build`     | Type-check and build the production bundle to `dist/` |
| `npm run preview`   | Preview the production build locally     |
| `npm run typecheck` | Run the TypeScript compiler (no emit)    |

## Environment

Only public configuration is allowed in `VITE_`-prefixed variables — they are
embedded into the browser bundle. See `.env.example`.

## Routing & auth guards

React Router 7 (`createBrowserRouter` + `RouterProvider`), tree in
`src/routes/routeTree.tsx`, guards in `src/routes/guards/`.

- **AuthBootstrapBoundary** wraps `/`, `/auth/*`, `/management/*`, `/driver/*`,
  `/customer/*`. On load it calls `GET /auth/me`; nothing renders until the
  session resolves. `/track` and the 404 route sit outside it (public).
- **`/` (RootRedirect)** — auth-aware: unauthenticated → `/auth/login`;
  authenticated → the role's portal home.
- **RequirePortal** — portal family is chosen by ROLE CODE (ADMIN/DISPATCHER/
  FINANCE → management, DRIVER → driver, CUSTOMER → customer), never by
  permissions. Wrong portal → redirect to the user's own portal home;
  unrecognized role → `/unauthorized`.
- **RequirePermission** — per-page permission (backend catalog codes in
  `src/features/auth/permissions.ts`); missing → Unauthorized rendered in place.
- **GuestOnly** — `/auth/*` redirects an already-authenticated user home.

Frontend guards are UX only — every backend endpoint independently enforces
auth, permissions, ownership and IDOR prevention.

Session helpers for Phase 11.1 / the future Navbar: `useLogin()` / `useLogout()`
in `src/features/auth/useSession.ts`. Non-visual permission hooks:
`src/features/auth/usePermissions.ts`.

Production hosting must serve `index.html` for unknown routes (Phase 16); the
Vite dev server already does.

## Local auth dev setup

- backend: `http://localhost:3000`   (`cd server && npm run dev`)
- client:  `http://localhost:5173`   (`cd client && npm run dev`)
- `client/.env`: `VITE_API_BASE_URL=/api/v1`  (git-ignored, not committed)
- Vite proxies `/api` → `http://localhost:3000`, so browser requests are
  same-origin and the HttpOnly refresh cookie works without backend CORS.

Production HTTPS / CORS / cookie-domain configuration is Phase 16 deployment
work.

## State

Redux Toolkit store in `src/app/` (`store.ts`, typed `hooks.ts`). Client/global
state only — `auth` (identity summary + `unknown`/`authenticated`/
`unauthenticated` status, no tokens), `ui` (sidebar / mobile-nav), `ordersUi`
(bulk-selection ids). The `/auth/me` result also lives in the RTK Query cache;
the safe user summary in the `auth` slice is the one approved server-data
exception (true global identity state).

## Server state (RTK Query)

All server state lives in the single RTK Query cache (`api` reducer) — see
`src/services/`. One `createApi` instance (`api.ts`); every domain module
(`ordersApi`, `customersApi`, …) injects into it. Auth transport lives in
`authApi.ts`; the access token is held only in memory (`accessToken.ts`), never
in Redux / storage. `baseQueryWithReauth` does a single-flight
401 → `/auth/refresh` → retry-once.

## Shared UI

Design tokens live in `src/index.css` (Tailwind v4 `@theme` — brand / ink /
line / canvas+card / chrome / status tones / radii / shadows). Reusable
presentational components in `src/components/` (`ui`, `navigation`,
`data-display`, `filters`, `forms`, `feedback`, `orders`, `auth`) — no API
calls, no business calculations, money is always a display string.
`PermissionGuard` (action visibility) is distinct from `RequirePermission`
(route access). Icons: `lucide-react`. Class composition: `clsx` via
`components/ui/cn.ts`.

## Status

Phase 10 complete. Phase 11.1 (Login page), 11.2 (Management Shell), 11.3
(Orders List, incl. its correction against the completed Phase 6.3 contract)
and 11.4 (Create Order) complete. Phase 11.5 (Order Detail) next.

Create Order (`src/pages/management/orders/create/`) posts the real
`POST /api/v1/orders`; "Create & assign" then calls `POST /orders/:id/assign`
(two non-atomic requests — a failed assignment leaves the created order and
offers a retry that never re-POSTs). Money stays a string end-to-end; the
"remaining / to collect" preview uses exact bigint-cents arithmetic
(`createOrderFinancialPreview.ts`) and is display-only — the server recomputes
every total. The shared server-backed picker `ServerSearchSelect` (+
`FilterPopover`) now lives in `src/components/forms/`.

The Orders list (`src/pages/management/orders/`) is fully backend-driven:
URL search params are the source of truth for search / filters / sort / page
(`ordersListParams.ts`); all querying — including the payment-method filter,
the delivered/undelivered filter, and column sorting — is server-side via
`useGetOrdersQuery`; nothing is filtered or sorted in the browser.
`ordersUi.selectedOrderIds` holds only the current bulk selection.
`createdFrom` / `createdTo` are passed as bare `YYYY-MM-DD` (the backend treats
a bare `createdTo` as the whole UTC day); there is no client end-of-day math.

The only remaining Orders workflow gap is the absence of an atomic bulk
"mark ready" endpoint, so there is no bulk Mark Ready control (single-order
ready lives in Order Detail, Phase 11.5).

Forms use React Hook Form + Zod (`@hookform/resolvers`).

The Management shell (`src/layouts/ManagementLayout.tsx`) composes the shared
`AppSidebar` + `TopNavbar` + `UserMenu` with permission-aware navigation
(`src/features/navigation/managementNavigation.ts` — one shared permission
mapping, asserted equal to the route guards), the `ui` slice
(`sidebarCollapsed` / `mobileNavigationOpen`), and `useLogout`. Route pages are
still placeholders.
