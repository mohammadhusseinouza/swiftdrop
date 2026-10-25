# FR.12A.6 — Historical Reconciliation Management UI

Status: **implemented locally, pending review.** No schema, migration, production, main
development database or git change. Writes stay disabled by default
(`DRIVER_CASH_HISTORICAL_RECONCILIATION_ENABLED` unset).

## 1. Location and access

| Item | Decision |
|---|---|
| Routes | `/management/finance/historical-reconciliations` (list) and `/management/finance/historical-reconciliations/:id` (detail) — a dedicated section inside Finance |
| Route guard | `RequireRole(['ADMIN','FINANCE'])`, matching the backend's `requireRole`. `finance.read` cannot express this, because it can be granted to Dispatcher. |
| Sidebar | "Ledger Reconciliation", indented under Finance, role-scoped (the same mechanism as Driver Expenses) |
| Driver / Customer portals, Public Tracking | no route, link or API usage |

Guards are UX only; the backend authorizes every request.

## 2. Screens

- **List.**
  - Notices: "evidence only" and "ownership unresolved".
  - Totals: raw discrepancy, approved explanation, unexplained residual, invalid approvals.
  - Server-side filters: status and incident.
  - Columns: incident, driver, amount, raw discrepancy, approved explanation, residual, status,
    **ownership** (always "Ownership unresolved"), evidence validity, proposal date.
  - Server pagination; loading, error and empty states; cards on mobile.
- **Detail:**
  - status, ownership and evidence badges with the evidence-only and ownership notices;
  - the account's figures;
  - the proposal (proposer, reason, superseded record);
  - evidence: missing amount, expected vs actual, difference, order type, located gap, deleted
    order and missing-row references;
  - the original audit (id, action, recorded time);
  - the surviving ledger rows before and after the gap (type, amount, balances, time);
  - the related settlement;
  - the live V1–V7 result with explanations, and the fingerprint;
  - the full append-only decision history;
  - only the actions this user may be offered.

**"Approved" is never shown as ownership resolved.** The status reads "Approved (evidence only)",
and a separate badge and notice always read "Ownership unresolved — G5 keeps blocking".

## 3. Workflows

| Action | Offered to | Behavior |
|---|---|---|
| Propose | ADMIN | Fields: anchor row, surviving audit, optional settlement, reason, and a new incident (summary, times, missing-records table, uncertainties, query ids, notes) or an existing one. **No** amount, driver, order, fingerprint or ownership input. Server errors (failure codes) are shown as returned. |
| Approve | FINANCE, not the proposer, evidence currently valid | See §4 |
| Reject | FINANCE, not the proposer | reason ≥ 20 characters → explicit consequences → confirm |
| Withdraw | ADMIN | as Reject |
| Revoke | ADMIN who is neither proposer nor approver | as Reject; consequences state that G3 / R1 may block activation again |

Every write:
- uses one `Idempotency-Key` per intended action, bound to its content;
- after an ambiguous failure (network, 5xx, timeout), allows only the unchanged request to be
  retried (`settlementSubmission` helpers, as in the existing correction dialogs);
- is never optimistic.

Blocked actions are shown disabled with the reason. The backend remains the final authority.

## 4. Finance approval and fingerprint handling

1. Opening the review captures a **snapshot** of the evidence. The reviewer inspects it in full:
   the audit, the ledger rows, the missing amount, the settlement, the discrepancy, the validation
   result and the fingerprint.
2. Approve stays disabled until the reviewer ticks the acknowledgment ("evidence only — posts no
   money, changes no balance, does not resolve ownership").
3. The request carries the **snapshot's** fingerprint. Newer server data never replaces it: if the
   record changes while the dialog is open, approval is disabled until the reviewer explicitly
   starts a new review.
4. `STALE_EVIDENCE_DIGEST`, `RECONCILIATION_EVIDENCE_INVALID`, a changed state or 404 →
   - nothing is approved;
   - the evidence is refreshed;
   - the review must be restarted (new snapshot, new acknowledgment, new request key);
   - **there is no automatic retry and no path that resubmits with a different fingerprint.**

## 5. Maintenance window

The API exposes no read-only "writes enabled" state, so none is invented. Buttons reflect role,
status and independence only. A `403 HISTORICAL_RECONCILIATION_DISABLED` is shown as "changes are
disabled in this environment … Nothing was changed".

## 6. API contract additions (backend, additive, read-only)

To show the required data without guessing:
- list rows gained `driver` (number, name) and `account` (raw discrepancy, approved amount,
  residual), both batch-loaded;
- the detail gained `driver` and `evidenceContext` (predecessor / anchor rows, source audit
  action and time, related settlement).

No write path, schema or permission changed. Covered by the FR.12A.5 read-API test.

**Gaps reported, not worked around:**
- the list API has no free-text search, so only structured server filters are offered;
- there is no read-only maintenance-window state.

## 7. Tests

- `client/tests/historicalReconciliationUi.test.ts`: 16 tests covering the 20 requested points as
  pure logic, the project's frontend test convention. They cover navigation and guards, list
  params and requests, presentation, the proposal body, the approval state machine (exact
  fingerprint, stale handling, no automatic retry, ambiguous retry with the same key), action
  rules, request builders with `Idempotency-Key`, error classification including the disabled
  window, ownership wording, no posting endpoints, and the responsive column layout.
- Rendering is not unit-tested (no DOM test tooling in the project); it was verified end to end
  in a browser (§8).

## 8. Visual review (repeatable)

Verified with headless Edge, on the local dev app backed by the isolated
`swiftdrop_fr12a3_reg2` database, with writes enabled for that local server process only:
- Admin propose → Finance review and approve → independent Admin revoke;
- desktop 1440 px and mobile 390 px;
- no console errors, no horizontal overflow.

All seeded data was removed afterwards.

To repeat:
1. Point `server` at an isolated copy (never production or the main dev database). Seed an Admin,
   a Finance user, a second Admin and one gap fixture (`tests/historical-reconciliation/reconciliation-fixtures.ts`
   `createGapFixture`).
2. Start the backend with `DRIVER_CASH_HISTORICAL_RECONCILIATION_ENABLED=true` for that local
   process only, then `client` `npm run dev` (proxy `/api/v1`).
3. As Admin, open Finance → Ledger Reconciliation → **Propose reconciliation**. Enter the fixture's
   anchor row and audit ids, the incident details and a reason. Check that the detail shows
   PROPOSED, "Ownership unresolved", and residual = raw discrepancy, and that only **Withdraw** is
   offered.
4. As Finance, open the detail → **Approve**. Check that the button stays disabled until the
   acknowledgment is ticked; approve; the residual becomes 0.00 and ownership still reads
   unresolved.
5. As the second Admin → **Revoke approval** with a reason. The residual returns to the raw
   discrepancy, and the history shows APPROVED then REVOKED.
6. Restart the backend **without** the flag and repeat a write: a "disabled in this environment"
   message, nothing changed.
7. Repeat steps 3–5 at 390 px width.
