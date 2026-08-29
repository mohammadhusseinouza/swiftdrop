import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { applyDriverCashAdjustment, applyDriverCashTransaction, type DriverCashDirection } from "../driver-cash/driver-cash-ledger.service";
import { createAuditLog } from "../../shared/audit/audit.service";
import type { AdjustDriverCashInput } from "./finance-correction.schema";
import type { DriverCashCorrectionEntry } from "./finance-correction.types";

// ============================================================
// Driver Cash Adjustments + Reversals (Phase 8.8)
//
// Same append-only correction model as Wallet corrections
// (wallet-correction.service.ts): an ADJUSTMENT is a brand-new independent
// row; a REVERSAL is a brand-new inverse row referencing the original via
// reversal_of_id. Reuses the approved Phase 8.1 ledger primitives — no
// second Driver Cash balance algorithm exists here.
// ============================================================

const correctionSelect = {
  id: true,
  driver_id: true,
  type: true,
  amount: true,
  balance_before: true,
  balance_after: true,
  order_id: true,
  settlement_id: true,
  reversal_of_id: true,
  notes: true,
  created_at: true,
  users: { select: { id: true, first_name: true, last_name: true } },
} satisfies Prisma.driver_cash_transactionsSelect;

type CorrectionRow = Prisma.driver_cash_transactionsGetPayload<{ select: typeof correctionSelect }>;

function toDriverCashCorrectionEntry(row: CorrectionRow): DriverCashCorrectionEntry {
  return {
    id: row.id,
    driverId: row.driver_id,
    type: row.type,
    amount: row.amount.toString(),
    balanceBefore: row.balance_before.toString(),
    balanceAfter: row.balance_after.toString(),
    orderId: row.order_id,
    settlementId: row.settlement_id,
    reversalOfId: row.reversal_of_id,
    createdBy: row.users ? { id: row.users.id, firstName: row.users.first_name, lastName: row.users.last_name } : null,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
  };
}

// ============================================================
// PART A — POST /api/v1/finance/driver-cash/:driverId/adjust
// ============================================================

export async function createDriverCashAdjustment(
  driverId: string,
  input: AdjustDriverCashInput,
  actorUserId: string
): Promise<DriverCashCorrectionEntry> {
  const driver = await prisma.drivers.findUnique({ where: { id: driverId } });
  if (!driver) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Driver not found" });
  }
  // Cash-account existence/negative-balance protection is enforced by
  // applyDriverCashAdjustment itself (Phase 8.1) — not duplicated here.

  return prisma.$transaction(async (tx) => {
    const result = await applyDriverCashAdjustment(tx, {
      driverId,
      direction: input.direction,
      amount: input.amount,
      createdById: actorUserId,
      notes: input.reason,
    });

    await createAuditLog(tx, {
      actorUserId,
      action: "DRIVER_CASH_ADJUSTMENT_CREATED",
      entityType: "DRIVER_CASH_ACCOUNT",
      entityId: result.account.id,
      newValues: { direction: input.direction, amount: input.amount.toString() },
      metadata: {
        driverId,
        transactionId: result.transaction.id,
        direction: input.direction,
        amount: input.amount.toString(),
        reason: input.reason,
        balanceBefore: result.transaction.balance_before.toString(),
        balanceAfter: result.transaction.balance_after.toString(),
      },
    });

    const full = await tx.driver_cash_transactions.findUniqueOrThrow({ where: { id: result.transaction.id }, select: correctionSelect });
    return toDriverCashCorrectionEntry(full);
  });
}

// ============================================================
// PART B — POST /api/v1/finance/driver-cash-transactions/:transactionId/reverse
// ============================================================

export async function reverseDriverCashTransaction(
  transactionId: string,
  reason: string,
  actorUserId: string
): Promise<DriverCashCorrectionEntry> {
  const original = await prisma.driver_cash_transactions.findUnique({ where: { id: transactionId } });
  if (!original) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Driver cash transaction not found" });
  }

  if (original.type === "REVERSAL") {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "A REVERSAL transaction cannot itself be reversed — use an ADJUSTMENT to correct an incorrect reversal",
    });
  }

  const existingReversal = await prisma.driver_cash_transactions.findFirst({ where: { reversal_of_id: transactionId } });
  if (existingReversal) {
    throw new AppError({ statusCode: 409, code: "CONFLICT", message: "This transaction has already been reversed" });
  }

  // Driver Cash stores a positive magnitude + balance movement (Phase 8.1
  // convention) — direction must be derived from the balance boundaries,
  // never trusted from the enum alone.
  const actualDelta = original.balance_after.minus(original.balance_before);
  const magnitude = actualDelta.abs();
  if (!magnitude.equals(original.amount)) {
    console.error(`[driver-cash-correction.service] data-integrity failure: driver_cash_transactions ${transactionId} balance delta does not match its amount`);
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Original driver cash transaction is inconsistent — action was not performed" });
  }
  if (actualDelta.isZero()) {
    console.error(`[driver-cash-correction.service] data-integrity failure: driver_cash_transactions ${transactionId} has a zero balance delta`);
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Original driver cash transaction is inconsistent — action was not performed" });
  }
  const originalDirection: DriverCashDirection = actualDelta.greaterThan(0) ? "CREDIT" : "DEBIT";
  const reversalDirection: DriverCashDirection = originalDirection === "CREDIT" ? "DEBIT" : "CREDIT";

  // A production SETTLEMENT row should always have a linked settlement_id.
  let linkedSettlementId: string | null = null;
  if (original.type === "SETTLEMENT") {
    if (!original.settlement_id) {
      console.error(`[driver-cash-correction.service] data-integrity failure: SETTLEMENT driver_cash_transactions ${transactionId} has no linked settlement_id`);
      throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Original settlement transaction is inconsistent — action was not performed" });
    }
    const settlement = await prisma.driver_settlements.findUnique({ where: { id: original.settlement_id } });
    if (!settlement) {
      console.error(`[driver-cash-correction.service] data-integrity failure: driver_cash_transactions ${transactionId} references missing settlement ${original.settlement_id}`);
      throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Original settlement transaction is inconsistent — action was not performed" });
    }
    // DriverSettlement has no status column (Phase 8.6) — the historical
    // row stays exactly as recorded; nothing to validate/transition here.
    linkedSettlementId = settlement.id;
  }

  return prisma.$transaction(async (tx) => {
    // Composable low-level primitive used directly (not the narrower
    // applyDriverCashReversal helper) because a reversal must copy
    // order_id from the original but explicitly NEVER copy settlement_id —
    // that UNIQUE relation belongs to the original SETTLEMENT row alone.
    const result = await applyDriverCashTransaction(tx, {
      driverId: original.driver_id,
      type: "REVERSAL",
      direction: reversalDirection,
      amount: original.amount,
      orderId: original.order_id ?? undefined,
      createdById: actorUserId,
      notes: reason,
      reversalOfId: original.id,
      idempotencyKey: `reversal:driver-cash:${original.id}`,
    });

    await createAuditLog(tx, {
      actorUserId,
      action: linkedSettlementId ? "DRIVER_SETTLEMENT_REVERSED" : "DRIVER_CASH_TRANSACTION_REVERSED",
      entityType: linkedSettlementId ? "DRIVER_SETTLEMENT" : "DRIVER_CASH_TRANSACTION",
      entityId: linkedSettlementId ?? original.id,
      previousValues: { originalType: original.type, originalAmount: original.amount.toString() },
      newValues: { reversalTransactionId: result.transaction.id, reversalDirection },
      metadata: {
        originalTransactionId: original.id,
        originalType: original.type,
        originalAmount: original.amount.toString(),
        reversalTransactionId: result.transaction.id,
        reversalDirection,
        reason,
        settlementId: linkedSettlementId,
        driverId: original.driver_id,
      },
    });

    const full = await tx.driver_cash_transactions.findUniqueOrThrow({ where: { id: result.transaction.id }, select: correctionSelect });
    return toDriverCashCorrectionEntry(full);
  });
}
