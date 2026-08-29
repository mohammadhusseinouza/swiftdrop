# SwiftDrop Server

Backend for the SwiftDrop delivery management system (Node.js + Express +
PostgreSQL + Prisma).

## Getting started

```bash
cd server
npm install
cp .env.example .env      # set DATABASE_URL + AUTH_ACCESS_TOKEN_SECRET
npm run dev               # http://localhost:3000
```

The roles / permissions catalog must already exist in the database. Create the
first Admin interactively with `npm run admin:create`.

## Scripts

| Command              | Description                                    |
| -------------------- | --------------------------------------------- |
| `npm run dev`        | Start the API (watch mode)                     |
| `npm run build`      | Compile `src/` → `dist/`                       |
| `npm run typecheck`  | `tsc --noEmit` (app + tests)                   |
| `npm test`           | Run the full test suite                        |
| `npm run admin:create` | Interactively create the first Admin user   |
| `npm run seed:visual` | Seed development-only visual acceptance users |

## Visual acceptance accounts — LOCAL DEVELOPMENT / TESTING ONLY

`npm run seed:visual` creates deterministic, idempotent accounts for reviewing
the UI under every role. It **refuses to run when `NODE_ENV=production`** and
only ever touches the fixed `*@swiftdrop.test` fixtures below. Re-running resets
these fixtures' password / names / active flag to the documented values.

| Role       | Email                       | Status   |
| ---------- | --------------------------- | -------- |
| ADMIN      | `admin@swiftdrop.test`      | active   |
| DISPATCHER | `dispatcher@swiftdrop.test` | active   |
| FINANCE    | `finance@swiftdrop.test`    | active   |
| DRIVER     | `driver@swiftdrop.test`     | active (linked Driver `DRV-VISUAL-001` + zero-balance cash account) |
| CUSTOMER   | `customer@swiftdrop.test`   | active (linked Customer `CUS-VISUAL-001` + zero-balance wallet) |
| —          | `inactive@swiftdrop.test`   | **inactive** (DISPATCHER role — for login-rejection testing) |

**Password for all:** `VisualTest123!`

Permissions come from each account's role (the existing approved catalog) — the
seed never assigns permissions directly. These credentials are for
developers/testers only; **do not surface them in the product UI**.
