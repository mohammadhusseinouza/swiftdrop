// ============================================================
// Customer Wallet Ledger Foundation (Phase 8.2)
//
// Customer Wallet = money the COMPANY OWES the CUSTOMER (CLAUDE.md §22). It
// is NOT physical cash held by a Driver and NOT company revenue — this
// module never touches driver_cash_accounts, driver_cash_transactions, or
// company_financial_transactions.
//
// Architecturally this mirrors Phase 8.1's Driver Cash ledger foundation
// (same Express-independent design, same transaction-client-first
// primitive, same concurrency-safe credit/debit patterns) — but the wallet
// schema is NOT identical to Driver Cash's, and this module does not copy
// Driver Cash's positive-magnitude-plus-direction amount convention:
// wallet_transactions already has separate `credit`/`debit` columns, so a
// normal transaction sets exactly one of them to the amount and the other
// to zero (never both nonzero, never negative).
//
// Every mutation primitive accepts a Prisma.TransactionClient rather than
// opening its own transaction, so Phase 8.3 can later compose a wallet
// credit into the SAME atomic transaction as an operational delivery
// finalization + Driver Cash collection + company revenue posting. A
// convenience wrapper (runWalletTransaction) is provided for isolated/
// internal use, but the composable primitive is the actual foundation.
//
// Only ledger MECHANICS are implemented here — not the business workflows
// that will eventually call it:
//   - ORDER_CREDIT (credit) is exposed via creditWalletForOrder, usable
//     today by any trusted internal caller. Phase 8.3 decides WHICH Orders
//     qualify; this module never guesses eligibility.
//   - PAYOUT (debit) is supported at the primitive level only; no payout
//     business flow, payout-number generation, or customer_payouts row
//     creation exists here (Phase 8.5).
//   - ADJUSTMENT/REVERSAL are supported technically (explicit direction,
//     optional reversal_of_id) with no authorization/business-reason/
//     exactly-once-reversal policy (Phase 8.8) and no public endpoint.
// ============================================================

import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { MONEY_DECIMAL_PLACES, MONEY_MAX_VALUE } from "../orders/order-financial.schema";
import type { customer_wallets, wallet_transactions, WalletTransactionType } from "../../generated/prisma/client";

export type WalletDirection = "CREDIT" | "DEBIT";

// Locks which (type, direction) combinations are technically meaningful.
// ORDER_CREDIT is credit-only and PAYOUT is debit-only by definition;
// ADJUSTMENT/REVERSAL may go either way, but the caller must say which —
// this module never guesses a business direction for those two types
// (that judgment belongs to Phase 8.8).
const TYPE_DIRECTIONS: Record<WalletTransactionType, readonly WalletDirection[]> = {
  ORDER_CREDIT: ["CREDIT"],
  PAYOUT: ["DEBIT"],
  ADJUSTMENT: ["CREDIT", "DEBIT"],
  REVERSAL: ["CREDIT", "DEBIT"],
};

export interface ApplyWalletTransactionInput {
  customerId: string;
  type: WalletTransactionType;
  direction: WalletDirection;
  amount: Prisma.Decimal;
  orderId?: string;
  payoutId?: string;
  paymentMethodId?: string;
  processedById?: string;
  notes?: string;
  reversalOfId?: string;
  idempotencyKey?: string;
}

export interface WalletTransactionResult {
  transaction: wallet_transactions;
  wallet: customer_wallets;
}

// Every mutation amount must be a positive magnitude — never zero, never
// negative. The wallet schema's separate credit/debit columns hold this
// same value in exactly one column (see applyWalletTransaction below);
// nothing here ever stores a negative credit or debit.
function assertValidLedgerAmount(amount: Prisma.Decimal): void {
  if (!amount.isFinite()) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "Wallet amount is not a valid amount" });
  }
  if (amount.lessThanOrEqualTo(0)) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "Wallet amount must be greater than zero" });
  }
  if (amount.decimalPlaces() > MONEY_DECIMAL_PLACES) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: `Wallet amount supports at most ${MONEY_DECIMAL_PLACES} decimal places`,
    });
  }
  if (amount.greaterThan(MONEY_MAX_VALUE)) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "Wallet amount exceeds the supported range" });
  }
}

// The core reusable primitive. Must be called with an ALREADY-OPEN
// transaction client — see the module doc comment above for why this is
// mandatory, not merely convenient.
//
// Atomicity/concurrency (identical strategy to Phase 8.1's Driver Cash
// primitive, applied to customer_wallets.available_balance):
//   - CREDIT uses a single atomic `update` with `increment`; the returned
//     row's available_balance IS the exact post-credit balance, so
//     balanceBefore is derived from it via Decimal subtraction.
//   - DEBIT uses a conditional `updateMany` whose WHERE clause re-asserts
//     available_balance >= amount against the LIVE committed row — a
//     concurrent debit that already reduced the balance causes this
//     updateMany to affect 0 rows, failing closed with a controlled 400
//     rather than ever producing a negative wallet balance.
//   - The ledger row insert happens in the same transaction as the balance
//     mutation; if the insert fails (e.g. a duplicate idempotency_key), the
//     whole transaction — including the balance mutation — rolls back.
export async function applyWalletTransaction(
  tx: Prisma.TransactionClient,
  input: ApplyWalletTransactionInput
): Promise<WalletTransactionResult> {
  if (!TYPE_DIRECTIONS[input.type].includes(input.direction)) {
    throw new AppError({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Invalid wallet transaction type/direction combination",
    });
  }
  assertValidLedgerAmount(input.amount);

  // Phase 5.1 creates the Customer + its wallet atomically — a valid
  // Customer should always have exactly one. If it doesn't, this is a
  // financial data-integrity failure: fail closed, never auto-create the
  // wallet here (that would silently repair financial state).
  const existingWallet = await tx.customer_wallets.findUnique({ where: { customer_id: input.customerId } });
  if (!existingWallet) {
    console.error(`[wallet-ledger.service] data-integrity failure: customer ${input.customerId} has no linked customer_wallets row`);
    throw new AppError({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Customer wallet is missing — action was not performed",
    });
  }

  let wallet: customer_wallets;
  if (input.direction === "CREDIT") {
    wallet = await tx.customer_wallets.update({
      where: { customer_id: input.customerId },
      data: { available_balance: { increment: input.amount }, updated_at: new Date() },
    });
  } else {
    const claim = await tx.customer_wallets.updateMany({
      where: { customer_id: input.customerId, available_balance: { gte: input.amount } },
      data: { available_balance: { decrement: input.amount }, updated_at: new Date() },
    });
    if (claim.count !== 1) {
      throw new AppError({
        statusCode: 400,
        code: "VALIDATION_ERROR",
        message: "Insufficient wallet balance for this operation",
      });
    }
    wallet = await tx.customer_wallets.findUniqueOrThrow({ where: { customer_id: input.customerId } });
  }

  const balanceAfter = wallet.available_balance;
  const balanceBefore = input.direction === "CREDIT" ? balanceAfter.minus(input.amount) : balanceAfter.plus(input.amount);
  const credit = input.direction === "CREDIT" ? input.amount : new Prisma.Decimal(0);
  const debit = input.direction === "DEBIT" ? input.amount : new Prisma.Decimal(0);

  try {
    const transaction = await tx.wallet_transactions.create({
      data: {
        wallet_id: wallet.id,
        customer_id: input.customerId,
        order_id: input.orderId,
        payout_id: input.payoutId,
        type: input.type,
        credit,
        debit,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        payment_method_id: input.paymentMethodId,
        processed_by_id: input.processedById,
        notes: input.notes,
        reversal_of_id: input.reversalOfId,
        idempotency_key: input.idempotencyKey,
      },
    });
    return { transaction, wallet };
  } catch (error) {
    // The wallet mutation above and this insert share one transaction —
    // throwing here rolls the balance change back too. Never leak the raw
    // Prisma error (e.g. a P2002 on the UNIQUE idempotency_key/payout_id
    // constraints).
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "Wallet transaction already recorded for this request",
      });
    }
    throw error;
  }
}

// Focused ORDER_CREDIT helper — CREDIT only. orderId is REQUIRED here
// (unlike Driver Cash's generic COLLECTION helper): an ORDER_CREDIT
// transaction is semantically customer money originating from a specific
// Order, so the reference must always be present. This module does not
// decide which Orders qualify for a credit — Phase 8.3 owns that business
// eligibility; /deliver is not touched here.
export interface CreditWalletForOrderInput {
  customerId: string;
  amount: Prisma.Decimal;
  orderId: string;
  processedById?: string;
  notes?: string;
  idempotencyKey?: string;
}

export async function creditWalletForOrder(
  tx: Prisma.TransactionClient,
  input: CreditWalletForOrderInput
): Promise<WalletTransactionResult> {
  return applyWalletTransaction(tx, {
    customerId: input.customerId,
    type: "ORDER_CREDIT",
    direction: "CREDIT",
    amount: input.amount,
    orderId: input.orderId,
    processedById: input.processedById,
    notes: input.notes,
    idempotencyKey: input.idempotencyKey,
  });
}

// PAYOUT ledger primitive — DEBIT only. Deliberately does NOT create a
// customer_payouts row or generate a payout number; Phase 8.5 owns that
// orchestration and is expected to create the customer_payouts row first
// (inside its own transaction) and pass the resulting payoutId here.
export interface DebitWalletPayoutInput {
  customerId: string;
  amount: Prisma.Decimal;
  payoutId?: string;
  paymentMethodId?: string;
  processedById?: string;
  notes?: string;
  idempotencyKey?: string;
}

export async function debitWalletPayout(
  tx: Prisma.TransactionClient,
  input: DebitWalletPayoutInput
): Promise<WalletTransactionResult> {
  return applyWalletTransaction(tx, {
    customerId: input.customerId,
    type: "PAYOUT",
    direction: "DEBIT",
    amount: input.amount,
    payoutId: input.payoutId,
    paymentMethodId: input.paymentMethodId,
    processedById: input.processedById,
    notes: input.notes,
    idempotencyKey: input.idempotencyKey,
  });
}

// ADJUSTMENT technical foundation — the caller must supply an explicit
// direction; this module never infers whether a given business adjustment
// should credit or debit (Phase 8.8 owns that judgment, plus authorization
// and business-reason requirements). No public endpoint exists.
export interface ApplyWalletAdjustmentInput {
  customerId: string;
  direction: WalletDirection;
  amount: Prisma.Decimal;
  processedById?: string;
  notes?: string;
  idempotencyKey?: string;
}

export async function applyWalletAdjustment(
  tx: Prisma.TransactionClient,
  input: ApplyWalletAdjustmentInput
): Promise<WalletTransactionResult> {
  return applyWalletTransaction(tx, {
    customerId: input.customerId,
    type: "ADJUSTMENT",
    direction: input.direction,
    amount: input.amount,
    processedById: input.processedById,
    notes: input.notes,
    idempotencyKey: input.idempotencyKey,
  });
}

// REVERSAL technical foundation — records the ledger fields the schema
// supports (explicit direction, optional reversal_of_id) only. This is NOT
// the complete reversal workflow: original-transaction eligibility,
// exactly-once enforcement, inverse-direction/amount derivation,
// authorization, and audit all belong to Phase 8.8. No public endpoint
// exists.
export interface ApplyWalletReversalInput {
  customerId: string;
  direction: WalletDirection;
  amount: Prisma.Decimal;
  reversalOfId?: string;
  processedById?: string;
  notes?: string;
  idempotencyKey?: string;
}

export async function applyWalletReversal(
  tx: Prisma.TransactionClient,
  input: ApplyWalletReversalInput
): Promise<WalletTransactionResult> {
  return applyWalletTransaction(tx, {
    customerId: input.customerId,
    type: "REVERSAL",
    direction: input.direction,
    amount: input.amount,
    reversalOfId: input.reversalOfId,
    processedById: input.processedById,
    notes: input.notes,
    idempotencyKey: input.idempotencyKey,
  });
}

// Convenience wrapper that opens its own transaction — for isolated/
// internal callers (tests, one-off scripts) that are not already composing
// into a larger transaction. Phase 8.3/8.5/8.8 must call
// applyWalletTransaction (or one of the focused helpers above) directly
// with THEIR OWN transaction client instead of this wrapper, so the wallet
// mutation commits atomically with the rest of their operation (e.g. the
// same transaction as a Driver Cash collection and a company revenue
// posting).
export async function runWalletTransaction(input: ApplyWalletTransactionInput): Promise<WalletTransactionResult> {
  return prisma.$transaction((tx) => applyWalletTransaction(tx, input));
}
