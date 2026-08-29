import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { applyWalletAdjustment, applyWalletTransaction, type WalletDirection } from "./wallet-ledger.service";
import { transactionSelect, toWalletTransactionEntry } from "./wallet.service";
import { createAuditLog } from "../../shared/audit/audit.service";
import type { AdjustWalletInput } from "./wallet-correction.schema";
import type { WalletTransactionEntry } from "./wallet.types";

// ============================================================
// Wallet Adjustments + Reversals (Phase 8.8)
//
// Corrections never mutate finalized financial history: an ADJUSTMENT is a
// brand-new independent correction row; a REVERSAL is a brand-new inverse
// row referencing the original via reversal_of_id. The original row is
// never touched. Both reuse the approved Phase 8.2 ledger primitives — no
// second balance-mutation algorithm exists here.
// ============================================================

// ============================================================
// PART A — POST /api/v1/wallets/:customerId/adjust
// ============================================================

export async function createWalletAdjustment(
  customerId: string,
  input: AdjustWalletInput,
  actorUserId: string
): Promise<WalletTransactionEntry> {
  const customer = await prisma.customers.findUnique({ where: { id: customerId } });
  if (!customer) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Customer not found" });
  }
  // Wallet existence/negative-balance protection is enforced by
  // applyWalletAdjustment itself (Phase 8.2) — not duplicated here.

  return prisma.$transaction(async (tx) => {
    const result = await applyWalletAdjustment(tx, {
      customerId,
      direction: input.direction,
      amount: input.amount,
      processedById: actorUserId,
      notes: input.reason,
    });

    await createAuditLog(tx, {
      actorUserId,
      action: "WALLET_ADJUSTMENT_CREATED",
      entityType: "CUSTOMER_WALLET",
      entityId: result.wallet.id,
      newValues: { direction: input.direction, amount: input.amount.toString() },
      metadata: {
        customerId,
        transactionId: result.transaction.id,
        direction: input.direction,
        amount: input.amount.toString(),
        reason: input.reason,
        balanceBefore: result.transaction.balance_before.toString(),
        balanceAfter: result.transaction.balance_after.toString(),
      },
    });

    const full = await tx.wallet_transactions.findUniqueOrThrow({ where: { id: result.transaction.id }, select: transactionSelect });
    return toWalletTransactionEntry(full);
  });
}

// ============================================================
// PART B — POST /api/v1/wallet-transactions/:transactionId/reverse
// ============================================================

export async function reverseWalletTransaction(
  transactionId: string,
  reason: string,
  actorUserId: string
): Promise<WalletTransactionEntry> {
  const original = await prisma.wallet_transactions.findUnique({ where: { id: transactionId } });
  if (!original) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Wallet transaction not found" });
  }

  if (original.type === "REVERSAL") {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "A REVERSAL transaction cannot itself be reversed — use an ADJUSTMENT to correct an incorrect reversal",
    });
  }

  // Fast pre-check for the common sequential-duplicate case — the real,
  // concurrency-safe guard is the deterministic idempotency key below.
  const existingReversal = await prisma.wallet_transactions.findFirst({ where: { reversal_of_id: transactionId } });
  if (existingReversal) {
    throw new AppError({ statusCode: 409, code: "CONFLICT", message: "This transaction has already been reversed" });
  }

  // Integrity check: exactly one of credit/debit must be positive, and the
  // stored balance delta must match it exactly. Never guess direction from
  // a corrupt row.
  const creditPositive = original.credit.greaterThan(0);
  const debitPositive = original.debit.greaterThan(0);
  if (creditPositive === debitPositive) {
    console.error(`[wallet-correction.service] data-integrity failure: wallet_transactions ${transactionId} has ambiguous credit/debit`);
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Original wallet transaction is inconsistent — action was not performed" });
  }
  const originalAmount = creditPositive ? original.credit : original.debit;
  const actualDelta = original.balance_after.minus(original.balance_before);
  const expectedDelta = creditPositive ? originalAmount : originalAmount.negated();
  if (!actualDelta.equals(expectedDelta)) {
    console.error(`[wallet-correction.service] data-integrity failure: wallet_transactions ${transactionId} balance delta does not match its credit/debit`);
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Original wallet transaction is inconsistent — action was not performed" });
  }
  const reversalDirection: WalletDirection = creditPositive ? "DEBIT" : "CREDIT";

  // PAYOUT-linked originals require additional business validation — a
  // production PAYOUT row should always have a linked, COMPLETED payout.
  let linkedPayoutId: string | null = null;
  if (original.type === "PAYOUT") {
    if (!original.payout_id) {
      console.error(`[wallet-correction.service] data-integrity failure: PAYOUT wallet_transactions ${transactionId} has no linked payout_id`);
      throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Original payout transaction is inconsistent — action was not performed" });
    }
    const payout = await prisma.customer_payouts.findUnique({ where: { id: original.payout_id } });
    if (!payout) {
      console.error(`[wallet-correction.service] data-integrity failure: wallet_transactions ${transactionId} references missing payout ${original.payout_id}`);
      throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Original payout transaction is inconsistent — action was not performed" });
    }
    if (payout.status !== "COMPLETED") {
      throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: `Payout cannot be reversed while its status is ${payout.status}` });
    }
    linkedPayoutId = payout.id;
  }

  return prisma.$transaction(async (tx) => {
    // Composable low-level primitive used directly (not the narrower
    // applyWalletReversal helper) because a reversal must copy order_id
    // from the original but explicitly NEVER copy payout_id — that UNIQUE
    // relation belongs to the original PAYOUT row alone.
    const result = await applyWalletTransaction(tx, {
      customerId: original.customer_id,
      type: "REVERSAL",
      direction: reversalDirection,
      amount: originalAmount,
      orderId: original.order_id ?? undefined,
      paymentMethodId: original.payment_method_id ?? undefined,
      processedById: actorUserId,
      notes: reason,
      reversalOfId: original.id,
      idempotencyKey: `reversal:wallet:${original.id}`,
    });

    if (linkedPayoutId) {
      const claim = await tx.customer_payouts.updateMany({
        where: { id: linkedPayoutId, status: "COMPLETED" },
        data: { status: "REVERSED", updated_at: new Date() },
      });
      if (claim.count !== 1) {
        throw new AppError({ statusCode: 409, code: "CONFLICT", message: "Payout status changed by another request — please retry" });
      }
    }

    await createAuditLog(tx, {
      actorUserId,
      action: linkedPayoutId ? "CUSTOMER_PAYOUT_REVERSED" : "WALLET_TRANSACTION_REVERSED",
      entityType: linkedPayoutId ? "CUSTOMER_PAYOUT" : "WALLET_TRANSACTION",
      entityId: linkedPayoutId ?? original.id,
      previousValues: { originalType: original.type, originalAmount: originalAmount.toString() },
      newValues: { reversalTransactionId: result.transaction.id, reversalDirection },
      metadata: {
        originalTransactionId: original.id,
        originalType: original.type,
        originalAmount: originalAmount.toString(),
        reversalTransactionId: result.transaction.id,
        reversalDirection,
        reason,
        payoutId: linkedPayoutId,
        customerId: original.customer_id,
      },
    });

    const full = await tx.wallet_transactions.findUniqueOrThrow({ where: { id: result.transaction.id }, select: transactionSelect });
    return toWalletTransactionEntry(full);
  });
}
