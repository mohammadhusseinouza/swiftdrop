# server/migrations

> **Superseded — Prisma Migrate is now the standard migration system.**
>
> New schema changes go in `server/prisma/migrations/` (create them with
> `npx prisma migrate dev --create-only` against a development database, review the SQL,
> commit). Production receives them only through `npx prisma migrate deploy`, run by
> `server/scripts/build.mjs` during Vercel **Production** builds (never Preview, never local),
> before `prisma generate` and `tsc` (`server/vercel.json` pins the Build Command to
> `npm run build`). See the header of that script for the required
> `PRISMA_MIGRATE_MODE` / `MIGRATION_DATABASE_URL` settings. Build logs show only counts
> and fingerprints; to keep a private copy of the customer/driver number mapping, use
> `scripts/export-number-mapping.mjs --out <file outside the repo>`.
>
> The two most recent files here were converted, byte-for-byte, into Prisma migrations:
>
> | Manual file | Prisma migration |
> |---|---|
> | `2026-09-22__5152__customer_driver_sequential_numbers.sql` | `prisma/migrations/20260922000000_customer_driver_sequential_numbers` |
> | `2026-09-23__0923__payment_method_bypass_driver_cash.sql` | `prisma/migrations/20260923000000_payment_method_bypass_driver_cash` |
>
> The earlier files (`1117`, `1173`, `1174`) are already contained in the `0_init` baseline.
> Do **not** run `apply.mjs` against a database managed by Prisma Migrate: it would change
> the schema without recording it in `_prisma_migrations`. This directory is kept only as
> history.

## Why this directory exists

This project's PostgreSQL database was **bootstrapped from a hand-authored SQL script**
(`docs/spring_cargo_database`, a `pg_dump` artifact), and `prisma/schema.prisma` has been kept
in sync **manually** ever since. There is no `prisma/migrations/` history and no
`_prisma_migrations` table — `prisma migrate` has never been used here. `npx prisma generate`
only regenerates the client; it never touches the database.

Phase 11.17.2 (Parcel Intake & Collection) is the first schema change since the initial
bootstrap. Rather than switch the whole project onto `prisma migrate` (which would require
baselining the entire existing schema), this directory holds **reviewable, hand-authored
forward-only SQL migrations**, applied with `apply.mjs`. `schema.prisma` is then updated by
hand to match and `prisma generate` is run.

## Files

| File | Purpose |
|---|---|
| `2026-09-01__1117__parcel_intake_collection.sql` | Phase 11.17.2 bootstrap (single transaction; guarded by the `ParcelIntakeMethod` enum). |
| `2026-09-01__1173__parcel_collection_attempt_started_at_nullable.sql` | Phase 11.17.3 correction — makes `parcel_collection_attempts.started_at` nullable with no default. Marked `-- IDEMPOTENT`, so `apply.mjs` always runs it. |
| `2026-09-23__0923__payment_method_bypass_driver_cash.sql` | Direct Payment Settlement — adds `payment_methods.bypass_driver_cash` (NOT NULL DEFAULT false; existing rows keep driver-cash behavior) and the append-only `company_direct_collections` table. Additive only. Marked `-- IDEMPOTENT`. |
| `apply.mjs` | Applies a migration file to `$DATABASE_URL` inside one transaction. A file whose SQL contains `-- IDEMPOTENT` is always applied; otherwise the bootstrap is skipped once the `ParcelIntakeMethod` enum exists. |
| `verify.mjs` | Post-migration data / non-regression verification for the Phase 11.17.2 bootstrap. |

## Usage

```sh
# from server/
node migrations/apply.mjs migrations/2026-09-01__1117__parcel_intake_collection.sql
node migrations/verify.mjs
npx prisma generate
npm run typecheck && npm run build && npm test
```

## Notes

- `docs/spring_cargo_database` is a point-in-time dump and is **already stale** relative to
  `schema.prisma` (e.g. it predates the `auth_sessions` table). It is not the sync target
  and is intentionally left untouched by this phase. Refreshing it is a separate decision
  for the team.
- Prisma schema cannot express CHECK constraints or partial (`WHERE`) unique indexes
  declaratively, so those live only in the SQL migration + the live DB. They are documented
  with `///` comments in `schema.prisma`.
