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

## Routing

React Router 7 (`createBrowserRouter` + `RouterProvider`). The route tree and
layout shells live in `src/routes/` and `src/layouts/`; every route currently
renders a `RoutePlaceholder` (see `src/pages/`). Route-group ownership:
`/auth` → Phase 11.1, `/management` → Phase 11, `/driver` → Phase 12,
`/customer` → Phase 13, `/track` → Phase 14.

`/` redirects to `/auth/login` as a neutral default — Phase 10.5 replaces this
with authenticated bootstrap. There are **no** auth or permission guards yet.

Production hosting must serve `index.html` for unknown routes (Phase 16); the
Vite dev server already does.

## State

Redux Toolkit store in `src/app/` (`store.ts`, typed `hooks.ts`). Client/global
state only — `auth` (identity summary + status, no tokens), `ui` (sidebar /
mobile-nav), `ordersUi` (bulk-selection ids). Server collections are **not** in
Redux; RTK Query owns server state from Phase 10.4.

## Status

Phase 10.1 (bootstrap), 10.2 (router + layouts) and 10.3 (Redux store) complete.
RTK Query, auth guards and the shared design system come in later Phase 10
sub-phases.
