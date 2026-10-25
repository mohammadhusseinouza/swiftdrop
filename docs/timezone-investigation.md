# PostgreSQL Session Time Zone — Investigation and Proposed Plan

Status: **investigated, not changed** (FR.8 stabilization checkpoint, 2026-10-18).
Activation blocker: contract §14 item 0, implementation_plan §63.

## 1. Environment facts

| Item | Value |
|---|---|
| PostgreSQL | 18.6 (local, Windows) |
| Server `TimeZone` | `America/Los_Angeles`, source `configuration file` (postgresql.conf) |
| Timestamp columns | 70 × `timestamptz` (68 `Timestamptz(3)`), 2 × `date` (driver expenses) |
| Driver | `@prisma/adapter-pg` 7.9.1 over `pg` 8.23.0; the connection sets no session time zone |

## 2. How the adapter binds and reads timestamps

From `node_modules/@prisma/adapter-pg/dist/index.js`:

- **Write:** `formatDateTime(date)` sends `YYYY-MM-DD HH:MM:SS.mmm`, built from the **UTC**
  components and sent **without an offset**. PostgreSQL interprets an offset-less literal bound to
  `timestamptz` in the **session** time zone.
- **Read:** `normalize_timestamptz` takes the session-zone text (e.g. `… 23:30:00-07`) and
  **replaces** the offset with `+00:00`.
- `@default(now())` is filled client-side by Prisma, so it goes through the same write path.
  A raw-SQL `INSERT` relying on the column `DEFAULT now()` does not.
- `date` columns are bound as `YYYY-MM-DD` (UTC date) and returned as text, so they are
  independent of the session time zone.

## 3. Evidence (isolated database `swiftdrop_tzlab`, a copy of an idle dev copy)

App-supplied `2026-10-18T23:30:00Z`, Prisma default, and SQL default, under each session time zone:

| Session | Row | Prisma reads | True stored instant | `AT TIME ZONE 'UTC'` day |
|---|---|---|---|---|
| LA (default) | app Date 23:30Z | 23:30Z ✔ | **2026-10-19 06:30Z** (+7h) | **2026-10-19** ✘ |
| LA (default) | Prisma `@default(now())` | correct | +7h | shifted |
| LA (default) | SQL `DEFAULT now()` | **−7h** ✘ | correct | correct |
| UTC | all three | correct | correct | correct |

Other observations:

- **Filters.** Prisma `where` ranges and raw-SQL ranges with bound `Date` parameters are shifted
  the same way, so they are consistent with app-written rows under both sessions.
- **Spring-forward corruption (LA session).** An app timestamp of `2027-03-14T02:30Z` reads back
  through Prisma as **03:30Z**, because 02:30 does not exist in LA that day. App timestamps from
  02:00–02:59 UTC on each US spring-forward date are corrupted by +1h even for Prisma readers.
  The fall-back hour round-tripped correctly in the lab.
- **Switching an existing database to UTC.** Rows written under the LA session read back +7h/+8h
  (their stored instant is shifted). Switching is therefore not a transparent fix for data that
  already exists.

## 4. Impact

- Prisma CRUD, filters and API timestamps are internally consistent, except for the spring-forward
  hour.
- SQL-side calendar labels are wrong for activity after 16:00/17:00 UTC (late in the day), which
  is labelled the next day:
  - `reports/finance-report.service.ts` period rows
  - `reports/order-report.service.ts` periods
  - `financial-release-reporting.service.ts` delivery-date rows
  - the reconciliation sample text
- Values written by SQL defaults or migration backfills (`DEFAULT now()`) read back early through
  Prisma.
- Any external SQL consumer (BI, backups inspected manually) sees shifted instants.
- With a UTC session (typical for managed PostgreSQL), none of this occurs.

## 5. Why it was not fixed in this checkpoint

The correct fix pins the session to UTC. It is one line, but it **reinterprets every
timestamp already written** under a non-UTC session (+7h/+8h). Correcting that data would mean
rewriting historical timestamps, which is forbidden without approval. Compensating SQL
(`AT TIME ZONE current_setting('TimeZone')`) would hide the misconfiguration, still be wrong for
SQL-default rows, and leave the DST corruption in place.

## 6. Proposed separate implementation plan (requires approval)

1. **Verify production first.** Run `SHOW TimeZone` through the production pooler/connection
   string. If it is already `UTC`, production data is correct and the issue is local-only.
2. **Pin the session.** `new PrismaPg({ connectionString, options: "-c TimeZone=UTC" })` in
   `src/db/prisma.ts` (or `?options=-c%20TimeZone%3DUTC` on `DATABASE_URL`). It is a no-op on a
   UTC server. Document it in `.env.example`.
3. **Guard it.** Add a startup check that `SHOW TimeZone` = `UTC` (fail fast in production, warn
   in development) and a test asserting the session zone.
4. **Non-UTC databases with existing data** (local/dev only): either recreate them from a UTC
   environment, or run a one-off, explicitly approved, audited correction that shifts timestamps
   written by the app. Never apply that correction to a database that was always UTC.
5. **Regression.** Run the full suite under a UTC session, plus a midnight-boundary test
   (an event at 23:30Z is labelled the same UTC day by finance, order and delivery-date reports)
   and a DST-boundary round-trip test.
