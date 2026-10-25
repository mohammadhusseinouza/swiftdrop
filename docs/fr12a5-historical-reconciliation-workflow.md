# FR.12A.5 — Historical Reconciliation Proposal and Approval Workflow

Status: **implemented locally, pending review.** Isolated databases only. Production, the main
local development database and git were not touched. No reconciliation exists outside test
fixtures. Settlement-based release and shortfalls stay disabled. No schema change.

Builds on FR.12A.2 (design §8), FR.12A.3 (schema) and FR.12A.4 (validity SQL, gates).

---

## 1. Routes and permissions

All routes are under `/api/v1/finance/historical-reconciliations`. Access is by **role code**,
never by permission, because `finance.*` permissions can be granted to Dispatcher. The router is
mounted before the permission-based `/finance` router.

| Method / path | Role | Notes |
|---|---|---|
| `GET /summary` | ADMIN, FINANCE | per-account raw discrepancy, approved amount, residual, invalid count, plus evaluated records |
| `GET /incidents` | ADMIN, FINANCE | paginated (`page`, `limit` ≤ 100) |
| `GET /incidents/:id` | ADMIN, FINANCE | the incident and its evaluated reconciliations |
| `GET /` | ADMIN, FINANCE | filters `status`, `driverId`, `incidentId`; paginated with `meta` |
| `GET /:id` | ADMIN, FINANCE | evidence, `evidenceDigest`, derived status, failures, decision history, account figures, ownership |
| `POST /` | ADMIN | propose (creates the incident atomically, or cites `incidentId`) |
| `POST /:id/approve` | FINANCE | body `{ evidenceDigest, note? }`; no Admin fallback |
| `POST /:id/reject` | FINANCE | body `{ reason ≥ 20 }` |
| `POST /:id/withdraw` | ADMIN | body `{ reason ≥ 20 }` — any Admin (design §8: "proposer or ADMIN") |
| `POST /:id/revoke` | ADMIN | body `{ reason ≥ 20 }`; revoker ≠ proposer and ≠ approver |

Every write:
- requires the `Idempotency-Key` header;
- returns the full detail (201 for a proposal, 200 for a decision), built **after** commit;
- requires `DRIVER_CASH_HISTORICAL_RECONCILIATION_ENABLED=true`. When unset (the default) every
  write returns `403 HISTORICAL_RECONCILIATION_DISABLED`; reads are unaffected. This is a safety
  restriction for a maintenance window, not an authorization.

Driver, Customer and Dispatcher get 403. Nothing is exposed through the Driver or Customer Portal
or Public Tracking.

## 2. Proposal evidence derivation

The client supplies only:
- `anchorTransactionId` — the first surviving row after the gap;
- `sourceAuditLogId` — the surviving `COLLECTION_DIFFERENCE_RECORDED` audit;
- an optional `relatedSettlementId`;
- a `reason`;
- the incident (new) or `incidentId` (existing).

Amounts, ownership, the driver, the digest, and any unknown field are rejected with 400 (strict
schemas).

In one transaction, under the locks in §5, the server:
1. reads the anchor and its account (same driver), and locates the anchor's immediate predecessor
   in `(created_at, id)` order. Any shared timestamp → `ORDERING_AMBIGUOUS`. Comparisons are
   stored-to-stored in SQL;
2. computes `observedJump = anchor.balance_before − predecessor.balance_after` (0 at the start). It
   must be positive;
3. reads the audit: action and entity, the missing cash row id, the order id and order type.
   `actualAmount`, `expectedAmount` and `difference` must be exact two-decimal amounts with
   `difference = actual − expected ≠ 0`. `actualAmount = observedJump`, or `JUMP_MISMATCH`;
4. takes the related settlement from the anchor row itself, or a verified one (same driver; a
   different settlement from the anchor's own is refused);
5. checks the evidence chain:
   - a live record (PROPOSED / APPROVED / INVALID_HISTORY) for the same anchor, missing row, audit
     or order → `409 RECONCILIATION_ALREADY_PROPOSED`;
   - partially overlapping evidence → `409 CONFLICTING_EVIDENCE`;
   - a terminal head → the new record **supersedes** it, citing its terminal decision;
6. creates the incident if needed (`LI-<UTC year>-<NNNN>`, numbered under an advisory lock);
7. computes the evidence digest and inserts the record;
8. runs the **authoritative FR.12A.4 validity SQL** on the new record in the same transaction. Any
   failure → `409 RECONCILIATION_EVIDENCE_INVALID` with `failures`, and nothing is committed;
9. writes the `LEDGER_INCIDENT_RECORDED` (new incident) and
   `DRIVER_CASH_HISTORICAL_RECONCILIATION_PROPOSED` audits.

A proposal never changes G3 / R1 (tested).

## 3. Decisions

Each decision **appends** a row; no row is edited. Status is derived (FR.12A.3).

| Decision | Who | Preconditions (checked under the locks) |
|---|---|---|
| APPROVED | FINANCE ≠ proposer | status PROPOSED. `evidenceDigest` = stored digest (else `409 STALE_EVIDENCE_DIGEST`). V1–V7 valid now (else `409 RECONCILIATION_EVIDENCE_INVALID`). After the insert **and** its audit, the record must contribute exactly its amount, or the whole transaction rolls back. |
| REJECTED | FINANCE ≠ proposer | status PROPOSED |
| WITHDRAWN | ADMIN | status PROPOSED |
| REVOKED | ADMIN ≠ proposer and ≠ approver | status APPROVED (also when its evidence has become invalid — revocation is how an invalid approval is cleared). Appends REVOKED citing the approval; the approval is preserved. |

Other refusals:
- the wrong status → `409 RECONCILIATION_NOT_PENDING` / `RECONCILIATION_NOT_APPROVED`;
- a record whose history is `INVALID_HISTORY` accepts no decision;
- missing independence → `403 REVIEWER_NOT_INDEPENDENT` / `REVOKER_NOT_INDEPENDENT`;
- the service re-checks the role (defense in depth below the route guard).

### Independence enforcement and its gap

| Rule | Enforced by |
|---|---|
| approver / rejecter ≠ proposer | database (`dchrd_independent_reviewer_chk` + pinned proposer copy) **and** service |
| approval by FINANCE only | route (`requireRole`) and service |
| revoker ≠ proposer and ≠ approver | **service only**, under the account lock |

The database cannot express the revoker rule without new columns copying the approver onto the
revocation row (a schema change). As instructed, I am reporting this gap rather than expanding
the schema. The risk is limited: a revocation only ever **removes** an explanation. It fails
closed and can never make G3 or R1 pass.

## 4. Audit

Every decision writes exactly one audit row in its own transaction:
- entity `DRIVER_CASH_HISTORICAL_RECONCILIATION` and the reconciliation id;
- actions `…_PROPOSED / _APPROVED / _REJECTED / _WITHDRAWN / _REVOKED`;
- the incident action `LEDGER_INCIDENT_RECORDED`;
- metadata with the decision id, evidence digest, revoked decision, reason, amount,
  `ownershipStatus: UNRESOLVED`, and the account's figures before and after;
- ids and amounts only, no customer data.

A failing audit insert rolls the decision back (tested).

**Audit corroboration (new validity code `APPROVAL_AUDIT_MISSING`).** An APPROVED decision explains
nothing unless an audit row exists with the same reconciliation, the approver as actor, the
decision id and the evidence digest. An approval inserted by direct SQL without its audit is
therefore blocking, not explaining. The audit is a **second** condition, never proof on its own:
the decision row, the database CHECKs and V1–V7 still apply.

### Residual threat: unrestricted production database write access

A person with direct write access can still do any of the following, and so remains outside what
the application can prevent:
- forge both the decision row and its audit row;
- edit an unreferenced decision (for example turn a lone REJECTED into APPROVED with a matching
  audit);
- drop constraints, or edit `current_balance` and ledger rows.

Mitigations: restrict production write access (a prerequisite, design §14), and use the read API's
decision history and audit trail for after-the-fact review. Every forged explanation must also
satisfy V1–V7 against the live ledger.

## 5. Transactions, locking, idempotency

- **Lock order** (contract §6), the same as settlements and activation:
  1. advisory lock on the derived idempotency key;
  2. activation row `FOR SHARE`;
  3. the driver cash account `FOR NO KEY UPDATE`;
  4. the incident-number advisory lock (proposal only);
  5. inserts.

  Effects: two decisions on one account are serialized; a decision can never interleave with a
  delivery, a settlement or an activation gate evaluation on that account; ledger rows of that
  account cannot change during validation.
- **Validation** is a single SQL statement after the locks (READ COMMITTED; the account's ledger
  is frozen by the lock).
- **Transactions** are bounded at 15 s / 5 s maxWait. Response DTOs are built after commit.
- **Idempotency:** the key is derived from the actor and the `Idempotency-Key` header, stored in
  the record's or decision's `idempotency_key`, and checked both before the transaction and after
  the advisory lock:
  - same key, same content → replays the original result (one row, one audit);
  - different content → `409 IDEMPOTENCY_KEY_REUSED`.
- Unique or foreign-key violations that race past the explicit checks map to 409, never 500.

## 6. Financial effect and ownership

None. The full lifecycle (propose → approve → revoke) leaves every driver cash, settlement, wallet,
payout, company revenue, direct collection, release and order row identical (whole-table
fingerprints, test 25).

Ownership stays `UNRESOLVED`. G5 keeps blocking after approval and after revocation, and the
detail always shows `ownership.blocksActivation = true`.

Resolving it needs the future approved extension described in
`docs/fr12a4-historical-reconciliation-validation.md` §5.

## 7. How the future Admin and Finance interfaces use this (FR.12A.6)

- **Admin:** the incident form plus "Propose" (anchor row and audit picked from the H3 / I3 lists).
  The detail page shows the evidence, digest, status, failures and history. Withdraw and Revoke ask
  for a reason. Generate one `Idempotency-Key` per user action and reuse it on retry.
- **Finance:** a review queue (`GET /?status=PROPOSED`) and the detail page. Approve sends the
  `evidenceDigest` **from the detail the reviewer looked at**. On `STALE_EVIDENCE_DIGEST`, reload and
  review again. Reject asks for a reason.
- Both can show the summary (raw discrepancy, approved amount, residual) and must state that
  ownership remains unresolved and activation stays blocked.

## 8. Tests

- `tests/historical-reconciliation/historical-reconciliation-workflow.test.ts`: 29 tests over HTTP,
  covering the 27 requested cases plus the approval-vs-evidence-change and revocation-vs-reads
  races, read APIs and access.
- Shared fixtures now write the corroborating audit for fixture approvals (`audit: false` omits it),
  and use incident year 1999 so they never collide with workflow numbering.
- Results: see the completion report.
