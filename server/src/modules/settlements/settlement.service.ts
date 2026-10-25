import { randomBytes } from "node:crypto";
import { Prisma } from "../../generated/prisma/client";
import type { driver_settlements, drivers, order_financial_releases, payment_methods, users } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { readSnapshot } from "../../db/read-snapshot";
import { AppError } from "../../shared/errors/app-error";
import { debitDriverSettlement } from "../driver-cash/driver-cash-ledger.service";
import { createAuditLog } from "../../shared/audit/audit.service";
import { deriveRequestIdempotencyKey } from "../../shared/idempotency/request-idempotency";
import { lockDriverCashPosition, readSettlementModeActivation, releaseOrders } from "../financial-release/financial-release.service";
import type { CreateSettlementInput, ListSettlementsQuery } from "./settlement.schema";
import { collectionSettlementState, outstandingAmount } from "../financial-release/financial-release-read.service";
import type { SettlementDetail, SettlementSummary } from "./settlement.types";

// ============================================================
// Driver Settlement (Phase 8.6; allocations FR.4)
//
// A settlement represents physical cash a Driver hands over to the company —
// it changes CUSTODY of already-recorded money. It never debits
// customer_wallets/wallet_transactions (that would be a Customer Payout, a
// different concept entirely).
//
// Legacy / immediate collections: a settlement changes Driver Cash only —
// revenue / wallet credit was already recognized at successful delivery
// (Phase 8.3/8.4), so nothing else is touched.
//
// Settlement-Based Financial Release (FR.4, CLAUDE.md §74, contract §5.2):
// an allocation-format settlement also records explicit allocations to
// ON_SETTLEMENT collections (order_financial_releases). A collection that
// becomes FULLY allocated, with its difference review cleared, is released
// in the same transaction through financial-release.service releaseOrder()
// — the only code that posts a settlement-mode order's wallet credit /
// company revenue. This module never posts those rows itself.
// ============================================================

// Identifier generation mirrors the approved order_number/payout_number
// convention exactly: node:crypto randomBytes with rejection sampling
// (never Math.random(), never SELECT MAX()+1/COUNT(*)+1).
const IDENTIFIER_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const IDENTIFIER_BYTE_REJECTION_THRESHOLD = 256 - (256 % IDENTIFIER_ALPHABET.length);

function randomAlphanumeric(length: number): string {
  let result = "";
  while (result.length < length) {
    const bytes = randomBytes(length - result.length);
    for (const byte of bytes) {
      if (byte < IDENTIFIER_BYTE_REJECTION_THRESHOLD) {
        result += IDENTIFIER_ALPHABET[byte % IDENTIFIER_ALPHABET.length];
        if (result.length === length) break;
      }
    }
  }
  return result;
}

// SET-YYYYMMDD-XXXXXX, well within settlement_number's varchar(50). No
// approved format exists in docs/requirements.md or
// docs/implementation_plan.md — this mirrors ORD-YYYYMMDD-XXXXXX
// (order_number, Phase 6.1) and PAY-YYYYMMDD-XXXXXX (payout_number, Phase
// 8.5) for consistency.
function generateSettlementNumber(): string {
  const utcDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `SET-${utcDate}-${randomAlphanumeric(6)}`;
}

const MAX_IDENTIFIER_ATTEMPTS = 5;

function isSettlementNumberConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const target = error.meta?.target;
  const targetFields = Array.isArray(target) ? target : typeof target === "string" ? [target] : [];
  return targetFields.some((field) => field.includes("settlement_number"));
}

// ============================================================
// DTO mapping
// ============================================================

type SettlementWithRelations = driver_settlements & {
  drivers: drivers & { users: users };
  payment_methods: payment_methods;
  users: users;
};

const settlementInclude = {
  drivers: { include: { users: true } },
  payment_methods: true,
  users: true,
} satisfies Prisma.driver_settlementsInclude;

// FR.7 — correction state per settlement, batched (two queries for a page).
interface SettlementCorrectionState {
  reversed: boolean;
  shortfallTotal: Prisma.Decimal;
}

const NO_CORRECTIONS: SettlementCorrectionState = { reversed: false, shortfallTotal: new Prisma.Decimal(0) };

type SettlementReadDb = Pick<Prisma.TransactionClient, "driver_cash_transactions" | "driver_settlement_corrections">;

async function loadCorrectionStates(db: SettlementReadDb, settlementIds: string[]): Promise<Map<string, SettlementCorrectionState>> {
  const map = new Map<string, SettlementCorrectionState>();
  if (settlementIds.length === 0) return map;
  const [cashRows, shortfalls] = await Promise.all([
    db.driver_cash_transactions.findMany({
      where: { settlement_id: { in: settlementIds } },
      select: { settlement_id: true, other_driver_cash_transactions: { select: { id: true }, take: 1 } },
    }),
    db.driver_settlement_corrections.groupBy({
      by: ["settlement_id"],
      where: { settlement_id: { in: settlementIds }, correction_type: "SETTLEMENT_SHORTFALL" },
      _sum: { amount: true },
    }),
  ]);
  for (const id of settlementIds) map.set(id, { reversed: false, shortfallTotal: new Prisma.Decimal(0) });
  for (const row of cashRows) {
    if (row.settlement_id && row.other_driver_cash_transactions.length > 0) map.get(row.settlement_id)!.reversed = true;
  }
  for (const row of shortfalls) map.get(row.settlement_id)!.shortfallTotal = row._sum.amount ?? new Prisma.Decimal(0);
  return map;
}

function toSettlementSummary(row: SettlementWithRelations, state: SettlementCorrectionState = NO_CORRECTIONS): SettlementSummary {
  return {
    id: row.id,
    settlementNumber: row.settlement_number,
    driver: {
      id: row.drivers.id,
      driverNumber: row.drivers.driver_number,
      user: { firstName: row.drivers.users.first_name, lastName: row.drivers.users.last_name, phone: row.drivers.users.phone },
    },
    balanceBefore: row.balance_before.toString(),
    amountReceived: row.amount_received.toString(),
    balanceAfter: row.balance_after.toString(),
    // FR.4 — scalar passthrough; all NULL on a legacy-format settlement.
    allocatedTotal: row.allocated_total?.toString() ?? null,
    unattributedAmount: row.unattributed_amount?.toString() ?? null,
    unattributedReason: row.unattributed_reason,
    reversed: state.reversed,
    shortfallTotal: state.shortfallTotal.toString(),
    paymentMethod: { id: row.payment_methods.id, code: row.payment_methods.code, name: row.payment_methods.name },
    receivedBy: { id: row.users.id, firstName: row.users.first_name, lastName: row.users.last_name },
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
  };
}

// ============================================================
// POST /api/v1/driver-settlements
// ============================================================

async function loadActivePaymentMethod(paymentMethodId: string): Promise<payment_methods> {
  const method = await prisma.payment_methods.findUnique({ where: { id: paymentMethodId } });
  if (!method) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "The specified payment method does not exist" });
  }
  if (!method.is_active) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "The specified payment method is not active" });
  }
  return method;
}

function allocationError(releaseId: string, problem: string): AppError {
  return new AppError({
    statusCode: 400,
    code: "VALIDATION_ERROR",
    message: `Allocation for release ${releaseId} is invalid: ${problem}`,
    details: { reason: "ALLOCATION_INVALID", releaseId, problem },
  });
}

// Lock the requested releases in id order (contract §6 lock step 4) and
// validate every allocation against the LOCKED rows.
async function lockAndValidateAllocations(
  tx: Prisma.TransactionClient,
  driverId: string,
  allocations: { releaseId: string; amount: Prisma.Decimal }[]
): Promise<Map<string, order_financial_releases>> {
  const ids = [...allocations.map((a) => a.releaseId)].sort();
  const locked = new Map<string, order_financial_releases>();
  if (ids.length === 0) return locked;

  await tx.$queryRaw`
    SELECT id FROM order_financial_releases WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR NO KEY UPDATE
  `;
  const rows = await tx.order_financial_releases.findMany({ where: { id: { in: ids } } });
  for (const row of rows) locked.set(row.id, row);

  const reversedCollections = new Set(
    (
      await tx.driver_cash_transactions.findMany({
        where: { reversal_of_id: { in: rows.map((r) => r.collection_transaction_id) } },
        select: { reversal_of_id: true },
      })
    ).map((r) => r.reversal_of_id)
  );

  for (const allocation of allocations) {
    const release = locked.get(allocation.releaseId);
    // Same message for "missing" and "another driver's" — never reveals
    // whether a release id exists for a different driver.
    if (!release || release.driver_id !== driverId) {
      throw allocationError(allocation.releaseId, "collection not found for this driver");
    }
    if (release.release_status !== "PENDING") {
      throw allocationError(allocation.releaseId, `collection is not eligible for settlement (${release.release_status})`);
    }
    if (reversedCollections.has(release.collection_transaction_id)) {
      throw allocationError(allocation.releaseId, "collection has been reversed");
    }
    const outstanding = release.collection_amount.minus(release.allocated_amount);
    if (allocation.amount.greaterThan(outstanding)) {
      throw allocationError(allocation.releaseId, `amount exceeds the unsettled amount (${outstanding.toString()})`);
    }
  }
  return locked;
}

// A settlement is a Management action against physical cash a Driver
// already holds — an inactive Driver (deactivated operational/login access)
// does not stop physically holding company/customer cash that must still be
// settled, so is_active is deliberately never checked here. This mirrors
// the same established precedent as Phase 8.5's Customer Payout (an
// inactive Customer is still owed money) and Phase 8.4's exact
// COMPANY_ORDER delivery path.
export async function createSettlement(
  input: CreateSettlementInput,
  actorUserId: string,
  idempotencyKey: string
): Promise<SettlementSummary> {
  const driver = await prisma.drivers.findUnique({ where: { id: input.driverId } });
  if (!driver) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Driver not found" });
  }

  // Validated up front (outside the identifier retry loop below) so a bad
  // payment method fails fast without ever touching Driver Cash.
  await loadActivePaymentMethod(input.paymentMethodId);

  // Phase 8.9 — request-level idempotency, mirroring Phase 8.5's Customer
  // Payout treatment exactly. The raw client Idempotency-Key header is
  // never persisted: it is derived (scoped to the authenticated actor) into
  // the SAME driver_cash_transactions.idempotency_key UNIQUE column Phase
  // 8.1 already uses for delivery/reversal ledger dedup — no new storage.
  // debitDriverSettlement below is called with settlementId omitted (see the
  // CRITICAL ORDERING comment further down), so the only unique-constraint
  // collision it can hit during a settlement creation is this
  // idempotency_key — never settlement_id (Postgres treats multiple NULLs
  // in a UNIQUE column as distinct).
  const derivedKey = deriveRequestIdempotencyKey("settlement", actorUserId, idempotencyKey);

  // Sequential-replay fast path (also covers "client timed out, retries
  // later"). The real concurrency mutex is the UNIQUE(idempotency_key)
  // constraint handled in the catch block below — this pre-check is an
  // optimization, not the safety guarantee. By the time any other request
  // can observe this row post-commit, settlement_id has already been linked
  // (see the same transaction's final update step below), so reconciliation
  // can always resolve the linked driver_settlements row from it.
  const existingByKey = await prisma.driver_cash_transactions.findUnique({ where: { idempotency_key: derivedKey } });
  if (existingByKey) {
    return reconcileSettlementReplay(existingByKey, input, prisma);
  }

  const isAllocationFormat = input.allocations !== undefined;
  // Deterministic processing order for allocation inserts / updates.
  const allocations = [...(input.allocations ?? [])].sort((a, b) => (a.releaseId < b.releaseId ? -1 : a.releaseId > b.releaseId ? 1 : 0));
  const unattributedAmount = new Prisma.Decimal(input.unattributedAmount ?? 0);

  // Bounded retry on settlement_number collisions only — identical
  // convention to Phase 6.1's order_number/Phase 8.5's payout_number retry.
  let lastConflict: unknown;
  for (let attempt = 0; attempt < MAX_IDENTIFIER_ATTEMPTS; attempt++) {
    const settlementNumber = generateSettlementNumber();

    try {
      const outcome = await prisma.$transaction(async (tx) => {
        // ---- Lock order (contract §6): 1 advisory key -> 2 activation row
        // (FOR SHARE) -> 3 driver cash account (FOR NO KEY UPDATE) -> 4
        // releases by id (FOR NO KEY UPDATE) -> 5 orders / 6 wallets (taken
        // inside releaseOrder) -> 7 inserts.
        //
        // Serializes concurrent requests sharing the SAME derived key before
        // either touches the Driver Cash balance. Without this, two
        // concurrent identical requests each independently attempt a FULL
        // balance decrement (neither yet sees the other's not-yet-committed
        // ledger row) — if the account holds enough for only one debit, the
        // loser would fail closed on "insufficient balance" instead of
        // recovering the committed original, which is not an acceptable
        // outcome for a same-key replay. A Postgres advisory lock scoped to
        // this transaction (auto-released on commit/rollback, no schema
        // involved) blocks the second attempt until the first fully commits
        // or rolls back; the recheck immediately below then finds the
        // committed row and reconciles instead of re-debiting.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${derivedKey})::bigint)`;
        const postLockExisting = await tx.driver_cash_transactions.findUnique({ where: { idempotency_key: derivedKey } });
        if (postLockExisting) {
          return { kind: "REPLAY" as const, cashTx: postLockExisting };
        }

        const settlementModeActive = await readSettlementModeActivation(tx);
        const position = await lockDriverCashPosition(tx, input.driverId);
        const unattributedBalance = position.unattributed;

        let locked = new Map<string, order_financial_releases>();
        if (isAllocationFormat) {
          locked = await lockAndValidateAllocations(tx, input.driverId, allocations);
          if (unattributedAmount.greaterThan(unattributedBalance)) {
            throw new AppError({
              statusCode: 400,
              code: "VALIDATION_ERROR",
              message: `unattributedAmount exceeds the driver's unattributed cash (${unattributedBalance.toString()})`,
              details: { reason: "UNATTRIBUTED_EXCEEDS_BALANCE", unattributedBalance: unattributedBalance.toString() },
            });
          }
        } else if (settlementModeActive || position.pendingReleaseCount > 0) {
          // A legacy-format request can never consume money reserved for
          // settlement-mode collections (contract §5.2).
          throw new AppError({
            statusCode: 400,
            code: "VALIDATION_ERROR",
            message: "This driver's cash must be settled with explicit collection allocations",
            details: { reason: "ALLOCATION_CONTRACT_REQUIRED" },
          });
        }

        // ------------------------------------------------------------
        // CRITICAL ORDERING — read this before changing it.
        //
        // driver_settlements.balance_before/balance_after are NOT NULL, so
        // the settlement row cannot be created before the exact serialized
        // balance is known — yet driver_cash_transactions.settlement_id is
        // a FK to driver_settlements.id, so the cash transaction can't be
        // *finally* linked before the settlement row exists either.
        //
        // The debit therefore runs FIRST, unlinked (settlementId omitted),
        // using the approved Phase 8.1 concurrency-safe primitive — this is
        // the single source of truth for balanceBefore/balanceAfter, never
        // a separate application-level pre-read that could go stale under
        // a concurrent settlement/collection. The settlement row is then
        // created using the EXACT values that atomic debit just produced,
        // and finally the cash transaction is updated to link back via
        // settlement_id. All three steps share this one transaction, so a
        // failure at any point rolls every earlier step back together —
        // there is no window where a settlement row and its cash debit can
        // disagree or exist independently.
        // ------------------------------------------------------------
        const cashResult = await debitDriverSettlement(tx, {
          driverId: input.driverId,
          amount: input.amountReceived,
          createdById: actorUserId,
          notes: input.notes,
          idempotencyKey: derivedKey,
        });

        const allocatedTotal = allocations.reduce((sum, a) => sum.plus(a.amount), new Prisma.Decimal(0));
        const settlement = await tx.driver_settlements.create({
          data: {
            settlement_number: settlementNumber,
            driver_id: input.driverId,
            balance_before: cashResult.transaction.balance_before,
            amount_received: cashResult.transaction.amount,
            balance_after: cashResult.transaction.balance_after,
            payment_method_id: input.paymentMethodId,
            received_by_id: actorUserId,
            notes: input.notes,
            ...(isAllocationFormat
              ? {
                  allocated_total: allocatedTotal,
                  unattributed_amount: unattributedAmount,
                  unattributed_reason: input.unattributedReason ?? null,
                }
              : {}),
          },
        });

        await tx.driver_cash_transactions.update({
          where: { id: cashResult.transaction.id },
          data: { settlement_id: settlement.id },
        });

        // ---- Allocations: insert + compare-and-set allocated_amount on the
        // LOCKED release rows, one statement each for all allocations
        // (FR.11A). Any lost race leaves a row unmatched and rolls back.
        const fullyAllocated: order_financial_releases[] = [];
        if (allocations.length > 0) {
          await tx.driver_settlement_allocations.createMany({
            data: allocations.map((allocation) => ({
              settlement_id: settlement.id,
              release_id: allocation.releaseId,
              driver_id: input.driverId,
              amount: allocation.amount,
              created_by_id: actorUserId,
            })),
          });
          const values = Prisma.join(
            allocations.map((allocation) => {
              const release = locked.get(allocation.releaseId) as order_financial_releases;
              return Prisma.sql`(${release.id}::uuid, ${allocation.amount}::numeric, ${release.allocated_amount}::numeric)`;
            })
          );
          const updated = await tx.$queryRaw<{ id: string }[]>`
            UPDATE order_financial_releases AS r
            SET allocated_amount = r.allocated_amount + v.amount, updated_at = ${new Date()}
            FROM (VALUES ${values}) AS v(id, amount, expected)
            WHERE r.id = v.id AND r.release_status = 'PENDING' AND r.allocated_amount = v.expected
            RETURNING r.id
          `;
          if (updated.length !== allocations.length) {
            throw new AppError({ statusCode: 409, code: "CONFLICT", message: "A collection was changed by another request — please retry" });
          }
          for (const allocation of allocations) {
            const release = locked.get(allocation.releaseId) as order_financial_releases;
            const newAllocated = release.allocated_amount.plus(allocation.amount);
            if (newAllocated.equals(release.collection_amount)) {
              fullyAllocated.push({ ...release, allocated_amount: newAllocated });
            }
          }
        }

        // ---- Automatic release: only fully settled AND review-cleared
        // collections. AWAITING_REVIEW stays PENDING until FR.5. Processed in
        // (customer_id, id) order so wallet locks are always taken in the
        // same order (contract §6).
        const releasable = fullyAllocated
          .filter((r) => r.review_status !== "AWAITING_REVIEW")
          .sort((a, b) => (a.customer_id === b.customer_id ? (a.id < b.id ? -1 : 1) : a.customer_id < b.customer_id ? -1 : 1));
        const releasedReleaseIds = (
          await releaseOrders(tx, {
            releaseIds: releasable.map((r) => r.id),
            actorUserId,
            trigger: { type: "SETTLEMENT", settlementId: settlement.id },
            releaseLocksHeld: true,
          })
        ).map((r) => r.releaseId);

        await createAuditLog(tx, {
          actorUserId,
          action: "DRIVER_SETTLEMENT_COMPLETED",
          entityType: "DRIVER_SETTLEMENT",
          entityId: settlement.id,
          newValues: {
            amountReceived: cashResult.transaction.amount.toString(),
            balanceBefore: cashResult.transaction.balance_before.toString(),
            balanceAfter: cashResult.transaction.balance_after.toString(),
          },
          metadata: {
            driverId: input.driverId,
            paymentMethodId: input.paymentMethodId,
            cashTransactionId: cashResult.transaction.id,
            ...(isAllocationFormat
              ? {
                  format: "ALLOCATION",
                  allocations: allocations.map((a) => ({ releaseId: a.releaseId, amount: a.amount.toString() })),
                  allocatedTotal: allocatedTotal.toString(),
                  unattributedAmount: unattributedAmount.toString(),
                  unattributedReason: input.unattributedReason ?? null,
                  releasedReleaseIds,
                  awaitingReviewReleaseIds: fullyAllocated.filter((r) => r.review_status === "AWAITING_REVIEW").map((r) => r.id),
                }
              : {}),
          },
        });

        return { kind: "CREATED" as const, settlementId: settlement.id };
      });

      if (outcome.kind === "REPLAY") {
        return reconcileSettlementReplay(outcome.cashTx, input, prisma);
      }
      // Response DTO built AFTER commit — never inside the financial transaction.
      const full = await prisma.driver_settlements.findUniqueOrThrow({ where: { id: outcome.settlementId }, include: settlementInclude });
      return toSettlementSummary(full);
    } catch (error) {
      if (isSettlementNumberConflict(error)) {
        lastConflict = error;
        continue;
      }
      // The only idempotency_key collision this transaction can hit is the
      // request-derived key on the SETTLEMENT debit (settlementId is omitted
      // from that debit call, so settlement_id can never collide). The
      // transaction that hit it rolled back entirely, so re-query for the
      // committed winner and reconcile instead of surfacing a raw conflict.
      // Any other CONFLICT (e.g. a lost allocation race) has no committed
      // winner under this key and is surfaced unchanged.
      if (error instanceof AppError && error.code === "CONFLICT") {
        const winner = await prisma.driver_cash_transactions.findUnique({ where: { idempotency_key: derivedKey } });
        if (winner) {
          return reconcileSettlementReplay(winner, input, prisma);
        }
      }
      throw error;
    }
  }

  console.error("[settlement.service] exhausted settlement_number generation attempts", lastConflict);
  throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Failed to generate a unique settlement number" });
}

// Minimal read surface shared by the global `prisma` client and an
// in-flight Prisma.TransactionClient.
type SettlementReadClient = Pick<
  typeof prisma,
  "driver_settlements" | "driver_settlement_allocations" | "driver_cash_transactions" | "driver_settlement_corrections"
>;

// Same Idempotency-Key + same normalized request → return the original
// settlement resource (settlements have no status/lifecycle — Phase 8.6 —
// so the historical row is simply returned as-is). Same key + different
// request → 409, without ever executing or revealing internals. Comparison
// uses server-normalized PERSISTED business fields (never server-generated
// settlementNumber/id/createdAt, which a retrying client cannot know) —
// including (FR.4) the request format, every allocation (release + amount),
// the unattributed amount and its reason.
async function reconcileSettlementReplay(
  cashTx: { settlement_id: string | null },
  input: CreateSettlementInput,
  db: SettlementReadClient
): Promise<SettlementSummary> {
  if (!cashTx.settlement_id) {
    console.error("[settlement.service] data-integrity failure: idempotency-key-matched driver_cash_transactions row has no settlement_id");
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Settlement idempotency record is inconsistent" });
  }
  const existing = await db.driver_settlements.findUnique({ where: { id: cashTx.settlement_id }, include: settlementInclude });
  if (!existing) {
    console.error(
      `[settlement.service] data-integrity failure: driver_cash_transactions ${cashTx.settlement_id} settlement_id has no linked driver_settlements row`
    );
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Settlement idempotency record is inconsistent" });
  }

  const notesMatch = (existing.notes ?? null) === (input.notes ?? null);
  let matches =
    existing.driver_id === input.driverId &&
    existing.amount_received.equals(input.amountReceived) &&
    existing.payment_method_id === input.paymentMethodId &&
    notesMatch;

  const existingIsAllocationFormat = existing.allocated_total !== null;
  const inputIsAllocationFormat = input.allocations !== undefined;
  if (matches && existingIsAllocationFormat !== inputIsAllocationFormat) {
    matches = false;
  }
  if (matches && existingIsAllocationFormat) {
    const inputUnattributed = new Prisma.Decimal(input.unattributedAmount ?? 0);
    const reasonMatch = (existing.unattributed_reason ?? null) === (input.unattributedReason ?? null);
    const amountMatch = (existing.unattributed_amount as Prisma.Decimal).equals(inputUnattributed);
    const persisted = await db.driver_settlement_allocations.findMany({
      where: { settlement_id: existing.id },
      select: { release_id: true, amount: true },
      orderBy: { release_id: "asc" },
    });
    const requested = [...(input.allocations ?? [])].sort((a, b) => (a.releaseId < b.releaseId ? -1 : a.releaseId > b.releaseId ? 1 : 0));
    const allocationsMatch =
      persisted.length === requested.length &&
      persisted.every((p, i) => p.release_id === requested[i].releaseId && p.amount.equals(requested[i].amount));
    matches = reasonMatch && amountMatch && allocationsMatch;
  }

  if (!matches) {
    throw new AppError({
      statusCode: 409,
      code: "CONFLICT",
      message: "Idempotency key was already used for a different request.",
    });
  }

  const states = await loadCorrectionStates(db, [existing.id]);
  return toSettlementSummary(existing, states.get(existing.id));
}

// ============================================================
// GET /api/v1/driver-settlements
// ============================================================

export interface ListSettlementsResult {
  items: SettlementSummary[];
  total: number;
}

export async function listSettlements(query: ListSettlementsQuery): Promise<ListSettlementsResult> {
  const where: Prisma.driver_settlementsWhereInput = {};

  if (query.driverId) {
    where.driver_id = query.driverId;
  }
  if (query.paymentMethodId) {
    where.payment_method_id = query.paymentMethodId;
  }
  if (query.search) {
    where.OR = [
      { settlement_number: { contains: query.search, mode: "insensitive" } },
      { drivers: { driver_number: { contains: query.search, mode: "insensitive" } } },
      { drivers: { users: { first_name: { contains: query.search, mode: "insensitive" } } } },
      { drivers: { users: { last_name: { contains: query.search, mode: "insensitive" } } } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.driver_settlements.findMany({
      where,
      include: settlementInclude,
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.driver_settlements.count({ where }),
  ]);

  const states = await loadCorrectionStates(prisma, rows.map((r) => r.id));
  return { items: rows.map((r) => toSettlementSummary(r, states.get(r.id))), total };
}

// ============================================================
// GET /api/v1/driver-settlements/:id (FR.7)
//
// Read-only, one snapshot: the settlement, its allocations with the current
// state of each allocated collection, the releases it triggered, and its
// corrections. Fixed number of queries regardless of allocation count.
// ============================================================

export async function getSettlementDetail(settlementId: string): Promise<SettlementDetail> {
  return readSnapshot(async (tx) => {
    const settlement = await tx.driver_settlements.findUnique({
      where: { id: settlementId },
      include: {
        ...settlementInclude,
        allocations: {
          orderBy: [{ created_at: "asc" }, { id: "asc" }],
          include: {
            release: {
              include: {
                orders: { select: { id: true, order_number: true } },
                customers: { select: { id: true, customer_number: true, name: true } },
              },
            },
          },
        },
        corrections: {
          orderBy: [{ created_at: "asc" }, { id: "asc" }],
          include: { created_by: { select: { id: true, first_name: true, last_name: true } } },
        },
        released_financial_releases: {
          orderBy: [{ released_at: "asc" }, { id: "asc" }],
          select: { id: true, released_at: true, orders: { select: { id: true, order_number: true } } },
        },
      },
    });
    if (!settlement) {
      throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Settlement not found" });
    }
    const states = await loadCorrectionStates(tx, [settlement.id]);

    const allocations = settlement.allocations.map((a) => {
      const r = a.release;
      return {
        id: a.id,
        releaseId: r.id,
        order: { id: r.orders.id, orderNumber: r.orders.order_number },
        customer: { id: r.customers.id, customerNumber: r.customers.customer_number, name: r.customers.name },
        orderType: r.order_type,
        amount: a.amount.toString(),
        status: a.reversed_by_correction_id === null ? ("ACTIVE" as const) : ("REVERSED" as const),
        reversedByCorrectionId: a.reversed_by_correction_id,
        releasedByThisSettlement: r.released_by_settlement_id === settlement.id,
        collection: {
          collectionAmount: r.collection_amount.toString(),
          allocatedAmount: r.allocated_amount.toString(),
          outstandingAmount: outstandingAmount(r.release_status, r.collection_amount, r.allocated_amount).toString(),
          settlementState: collectionSettlementState(r.collection_amount, r.allocated_amount),
          releaseStatus: r.release_status,
          reviewStatus: r.review_status,
        },
      };
    });

    return {
      ...toSettlementSummary(settlement, states.get(settlement.id)),
      format: settlement.allocated_total === null ? "LEGACY" : "ALLOCATION",
      allocations,
      releasedOrders: settlement.released_financial_releases.map((r) => ({
        releaseId: r.id,
        order: { id: r.orders.id, orderNumber: r.orders.order_number },
        releasedAt: r.released_at?.toISOString() ?? null,
      })),
      collectionsFullySettled: allocations.filter((a) => a.collection.settlementState === "FULLY_SETTLED").length,
      collectionsPartiallySettled: allocations.filter((a) => a.collection.settlementState === "PARTIALLY_SETTLED").length,
      corrections: settlement.corrections.map((c) => ({
        id: c.id,
        correctionType: c.correction_type,
        amount: c.amount.toString(),
        reason: c.reason,
        cashTransactionId: c.cash_transaction_id,
        createdBy: { id: c.created_by.id, firstName: c.created_by.first_name, lastName: c.created_by.last_name },
        createdAt: c.created_at.toISOString(),
      })),
    };
  });
}
