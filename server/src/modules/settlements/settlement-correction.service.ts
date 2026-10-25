import { randomUUID } from "node:crypto";
import { Prisma } from "../../generated/prisma/client";
import type { driver_settlement_corrections } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { createAuditLog } from "../../shared/audit/audit.service";
import { deriveRequestIdempotencyKey } from "../../shared/idempotency/request-idempotency";
import { applyDriverCashAdjustment, applyDriverCashTransaction } from "../driver-cash/driver-cash-ledger.service";
import { lockDriverCashPosition } from "../financial-release/financial-release.service";
import type { ReverseSettlementInput, SettlementShortfallInput } from "./settlement.schema";
import type { SettlementCorrectionEntry } from "./settlement.types";

// ============================================================
// Driver settlement corrections (FR.6, contract §3.6 / §8)
//
// A settlement changes CUSTODY of already-recorded money (Driver Cash ->
// company). Its corrections therefore only ever touch Driver Cash and the
// settlement's own allocations — never a wallet or company revenue.
//
//   POST /driver-settlements/:id/reverse   SETTLEMENT_REVERSAL
//     The settlement did not happen / was recorded in error. Credits the
//     whole amount back (existing reversal key), marks its ACTIVE
//     allocations REVERSED and returns their amounts to the collections'
//     unsettled balance. Blocked once any allocated collection has been
//     released (or its release reversed): released funds are corrected via
//     the release workflow, never by un-settling the cash.
//   POST /driver-settlements/:id/shortfall SETTLEMENT_SHORTFALL
//     The driver genuinely handed over LESS than recorded: the difference
//     is re-established as unattributed driver cash (a real obligation).
//     Releases and customer credits stand — the receiver paid.
//
// Both write a driver_settlement_corrections row linking the settlement,
// the corrective cash row, the actor, the reason and an idempotency key.
// Originals (settlement, cash rows, allocations) are never edited or
// deleted beyond the one-way allocation REVERSED marker.
// ============================================================

// FR.11A — fail-closed restriction on NEW settlement shortfalls.
// A shortfall creates a driver debt on the word of a single finance.adjust
// holder: no evidence, no second approver, no separation from the user who
// received the settlement, and no write-off path (contract §14 item 4). Until
// that authorization policy is approved, new shortfalls are refused unless
// the server environment explicitly carries SETTLEMENT_SHORTFALL_POLICY_APPROVED=true
// (unset by default; never set it before the policy is approved). Recorded
// shortfalls, their idempotent replays and every other correction are unaffected.
export const SHORTFALL_POLICY_ENV = "SETTLEMENT_SHORTFALL_POLICY_APPROVED";

export function isSettlementShortfallPolicyApproved(): boolean {
  return process.env[SHORTFALL_POLICY_ENV] === "true";
}

function correctionConflict(reason: string, message: string): AppError {
  return new AppError({ statusCode: 409, code: "CONFLICT", message, details: { reason } });
}

function integrityFailure(detail: string): AppError {
  console.error(`[settlement-correction.service] data-integrity failure: ${detail}`);
  return new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Settlement records are inconsistent — action was not performed" });
}

const correctionInclude = {
  created_by: { select: { id: true, first_name: true, last_name: true } },
  reversed_allocations: { select: { id: true, release_id: true, amount: true }, orderBy: { release_id: "asc" } },
} satisfies Prisma.driver_settlement_correctionsInclude;

async function loadCorrectionEntry(correctionId: string): Promise<SettlementCorrectionEntry> {
  const row = await prisma.driver_settlement_corrections.findUniqueOrThrow({ where: { id: correctionId }, include: correctionInclude });
  return {
    id: row.id,
    settlementId: row.settlement_id,
    driverId: row.driver_id,
    correctionType: row.correction_type,
    amount: row.amount.toString(),
    reason: row.reason,
    cashTransactionId: row.cash_transaction_id,
    reversedAllocations: row.reversed_allocations.map((a) => ({ id: a.id, releaseId: a.release_id, amount: a.amount.toString() })),
    createdBy: { id: row.created_by.id, firstName: row.created_by.first_name, lastName: row.created_by.last_name },
    createdAt: row.created_at.toISOString(),
  };
}

async function loadSettlementDriverId(settlementId: string): Promise<string> {
  const settlement = await prisma.driver_settlements.findUnique({ where: { id: settlementId }, select: { driver_id: true } });
  if (!settlement) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Settlement not found" });
  }
  return settlement.driver_id;
}

// The settlement's SETTLEMENT debit row and whether it was already reversed
// (a SETTLEMENT_REVERSAL correction, or a pre-FR.6 generic reversal).
async function loadSettlementCashRow(tx: Prisma.TransactionClient, settlementId: string) {
  const settlement = await tx.driver_settlements.findUniqueOrThrow({ where: { id: settlementId } });
  const cashRow = await tx.driver_cash_transactions.findUnique({ where: { settlement_id: settlementId } });
  if (!cashRow || cashRow.type !== "SETTLEMENT" || cashRow.driver_id !== settlement.driver_id || !cashRow.amount.equals(settlement.amount_received)) {
    throw integrityFailure(`settlement ${settlementId} has no matching SETTLEMENT cash row`);
  }
  const reversal = await tx.driver_cash_transactions.findFirst({ where: { reversal_of_id: cashRow.id }, select: { id: true } });
  return { settlement, cashRow, alreadyReversed: reversal !== null };
}

// ============================================================
// Settlement reversal
// ============================================================

export async function reverseSettlement(settlementId: string, input: ReverseSettlementInput, actorUserId: string): Promise<SettlementCorrectionEntry> {
  const driverId = await loadSettlementDriverId(settlementId);

  const correctionId = await prisma.$transaction(async (tx) => {
    // Lock order (contract §6): account 3 -> releases by id 4 -> inserts 7.
    await lockDriverCashPosition(tx, driverId);

    const existing = await tx.driver_settlement_corrections.findFirst({
      where: { settlement_id: settlementId, correction_type: "SETTLEMENT_REVERSAL" },
    });
    if (existing) {
      // A retry with the same reason returns the recorded reversal.
      if (existing.reason === input.reason) return existing.id;
      throw correctionConflict("SETTLEMENT_ALREADY_REVERSED", "This settlement has already been reversed");
    }
    const { settlement, cashRow, alreadyReversed } = await loadSettlementCashRow(tx, settlementId);
    if (alreadyReversed) {
      throw correctionConflict("SETTLEMENT_ALREADY_REVERSED", "This settlement has already been reversed");
    }
    // Reversing after a shortfall would credit the driver for money already
    // re-established as owed — the two corrections are mutually exclusive.
    const shortfall = await tx.driver_settlement_corrections.findFirst({
      where: { settlement_id: settlementId, correction_type: "SETTLEMENT_SHORTFALL" },
      select: { id: true },
    });
    if (shortfall) {
      throw correctionConflict("SETTLEMENT_HAS_SHORTFALL", "A shortfall was recorded for this settlement — it cannot be reversed");
    }

    const allocations = await tx.driver_settlement_allocations.findMany({
      where: { settlement_id: settlementId, reversed_by_correction_id: null },
      orderBy: { release_id: "asc" },
    });
    const releaseIds = allocations.map((a) => a.release_id);
    if (releaseIds.length > 0) {
      await tx.$queryRaw`SELECT id FROM order_financial_releases WHERE id = ANY(${releaseIds}::uuid[]) ORDER BY id FOR NO KEY UPDATE`;
    }
    const releases = new Map(
      (await tx.order_financial_releases.findMany({ where: { id: { in: releaseIds } } })).map((r) => [r.id, r])
    );
    for (const allocation of allocations) {
      const release = releases.get(allocation.release_id);
      if (!release || release.driver_id !== driverId) {
        throw integrityFailure(`allocation ${allocation.id} has no matching release`);
      }
      if (release.release_status === "RELEASED" || release.release_status === "RELEASE_REVERSED") {
        throw correctionConflict(
          "SETTLEMENT_HAS_RELEASED_FUNDS",
          "A collection allocated by this settlement has released funds — correct the release first; the settlement cannot be reversed"
        );
      }
      if (release.release_status !== "PENDING" || release.allocated_amount.lessThan(allocation.amount)) {
        throw integrityFailure(`release ${release.id} cannot absorb the reversal of allocation ${allocation.id}`);
      }
    }

    // Credit: restores the driver's obligation; never consumes U.
    const cash = await applyDriverCashTransaction(tx, {
      driverId,
      type: "REVERSAL",
      direction: "CREDIT",
      amount: cashRow.amount,
      createdById: actorUserId,
      notes: input.reason,
      reversalOfId: cashRow.id,
      idempotencyKey: `reversal:driver-cash:${cashRow.id}`,
    });

    const correction = await tx.driver_settlement_corrections.create({
      data: {
        settlement_id: settlementId,
        driver_id: driverId,
        correction_type: "SETTLEMENT_REVERSAL",
        amount: cashRow.amount,
        reason: input.reason,
        cash_transaction_id: cash.transaction.id,
        created_by_id: actorUserId,
        idempotency_key: `settlement-reversal:${settlementId}`,
      },
    });

    if (allocations.length > 0) {
      const marked = await tx.driver_settlement_allocations.updateMany({
        where: { settlement_id: settlementId, reversed_by_correction_id: null },
        data: { reversed_by_correction_id: correction.id },
      });
      if (marked.count !== allocations.length) {
        throw correctionConflict("ALLOCATIONS_CHANGED", "Settlement allocations were changed by another request — please retry");
      }
    }
    const now = new Date();
    for (const allocation of allocations) {
      const release = releases.get(allocation.release_id)!;
      const updated = await tx.order_financial_releases.updateMany({
        where: { id: release.id, release_status: "PENDING", allocated_amount: release.allocated_amount },
        data: { allocated_amount: release.allocated_amount.minus(allocation.amount), updated_at: now },
      });
      if (updated.count !== 1) {
        throw correctionConflict("RELEASE_STATE_CHANGED", "A collection was changed by another request — please retry");
      }
    }

    await createAuditLog(tx, {
      actorUserId,
      action: "DRIVER_SETTLEMENT_REVERSED",
      entityType: "DRIVER_SETTLEMENT",
      entityId: settlementId,
      previousValues: { originalType: "SETTLEMENT", originalAmount: cashRow.amount.toString() },
      newValues: { reversalTransactionId: cash.transaction.id, reversalDirection: "CREDIT" },
      metadata: {
        correctionId: correction.id,
        correctionType: "SETTLEMENT_REVERSAL",
        reason: input.reason,
        driverId,
        originalTransactionId: cashRow.id,
        reversalTransactionId: cash.transaction.id,
        format: settlement.allocated_total === null ? "LEGACY" : "ALLOCATION",
        reversedAllocations: allocations.map((a) => ({ allocationId: a.id, releaseId: a.release_id, amount: a.amount.toString() })),
      },
    });
    return correction.id;
  });

  return loadCorrectionEntry(correctionId);
}

// ============================================================
// Settlement shortfall
// ============================================================

function reconcileShortfallReplay(existing: driver_settlement_corrections, settlementId: string, input: SettlementShortfallInput): string {
  if (
    existing.correction_type === "SETTLEMENT_SHORTFALL" &&
    existing.settlement_id === settlementId &&
    existing.amount.equals(input.amount) &&
    existing.reason === input.reason
  ) {
    return existing.id;
  }
  throw new AppError({ statusCode: 409, code: "CONFLICT", message: "Idempotency key was already used for a different request." });
}

export async function recordSettlementShortfall(
  settlementId: string,
  input: SettlementShortfallInput,
  actorUserId: string,
  idempotencyKey: string
): Promise<SettlementCorrectionEntry> {
  const driverId = await loadSettlementDriverId(settlementId);
  const derivedKey = deriveRequestIdempotencyKey("settlement-shortfall", actorUserId, idempotencyKey);

  const replay = await prisma.driver_settlement_corrections.findUnique({ where: { idempotency_key: derivedKey } });
  if (replay) {
    return loadCorrectionEntry(reconcileShortfallReplay(replay, settlementId, input));
  }
  if (!isSettlementShortfallPolicyApproved()) {
    throw new AppError({
      statusCode: 403,
      code: "FORBIDDEN",
      message: "Recording a settlement shortfall is disabled until its authorization policy is approved",
      details: { reason: "SHORTFALL_POLICY_NOT_APPROVED" },
    });
  }

  const correctionId = await prisma.$transaction(async (tx) => {
    // Lock order: advisory key 1 -> account 3 -> inserts 7.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${derivedKey})::bigint)`;
    const postLock = await tx.driver_settlement_corrections.findUnique({ where: { idempotency_key: derivedKey } });
    if (postLock) {
      return reconcileShortfallReplay(postLock, settlementId, input);
    }
    await lockDriverCashPosition(tx, driverId);

    const { settlement, alreadyReversed } = await loadSettlementCashRow(tx, settlementId);
    const reversal = await tx.driver_settlement_corrections.findFirst({
      where: { settlement_id: settlementId, correction_type: "SETTLEMENT_REVERSAL" },
      select: { id: true },
    });
    if (alreadyReversed || reversal) {
      throw correctionConflict("SETTLEMENT_ALREADY_REVERSED", "This settlement has been reversed — a shortfall cannot be recorded");
    }
    const previous = await tx.driver_settlement_corrections.aggregate({
      where: { settlement_id: settlementId, correction_type: "SETTLEMENT_SHORTFALL" },
      _sum: { amount: true },
    });
    const previousTotal = previous._sum.amount ?? new Prisma.Decimal(0);
    if (previousTotal.plus(input.amount).greaterThan(settlement.amount_received)) {
      throw new AppError({
        statusCode: 400,
        code: "VALIDATION_ERROR",
        message: `Total shortfall cannot exceed the settlement amount (${settlement.amount_received.minus(previousTotal).toString()} remaining)`,
        details: { reason: "SHORTFALL_EXCEEDS_SETTLEMENT" },
      });
    }

    // The correction id is generated here because the corrective cash row's
    // deterministic key (settlement-shortfall:<correctionId>) must exist
    // before the correction row that references that cash row.
    const id = randomUUID();
    const cash = await applyDriverCashAdjustment(tx, {
      driverId,
      direction: "CREDIT",
      amount: input.amount,
      createdById: actorUserId,
      notes: input.reason,
      idempotencyKey: `settlement-shortfall:${id}`,
    });
    const correction = await tx.driver_settlement_corrections.create({
      data: {
        id,
        settlement_id: settlementId,
        driver_id: driverId,
        correction_type: "SETTLEMENT_SHORTFALL",
        amount: input.amount,
        reason: input.reason,
        cash_transaction_id: cash.transaction.id,
        created_by_id: actorUserId,
        idempotency_key: derivedKey,
      },
    });

    await createAuditLog(tx, {
      actorUserId,
      action: "DRIVER_SETTLEMENT_SHORTFALL_RECORDED",
      entityType: "DRIVER_SETTLEMENT",
      entityId: settlementId,
      newValues: { shortfallAmount: input.amount.toString(), totalShortfall: previousTotal.plus(input.amount).toString() },
      metadata: {
        correctionId: correction.id,
        correctionType: "SETTLEMENT_SHORTFALL",
        reason: input.reason,
        driverId,
        amountReceived: settlement.amount_received.toString(),
        cashTransactionId: cash.transaction.id,
        balanceBefore: cash.transaction.balance_before.toString(),
        balanceAfter: cash.transaction.balance_after.toString(),
      },
    });
    return correction.id;
  });

  return loadCorrectionEntry(correctionId);
}
