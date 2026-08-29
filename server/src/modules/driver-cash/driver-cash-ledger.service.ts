// ============================================================
// Driver Cash Ledger Foundation (Phase 8.1)
//
// Driver Cash = money physically collected by a Driver but not yet handed
// over to the company (CLAUDE.md §25). It is NOT the Customer Wallet and NOT
// Company Revenue — this module never touches customer_wallets,
// wallet_transactions, or company_financial_transactions.
//
// This is a pure, Express-independent domain service. Every mutation
// primitive here accepts a Prisma.TransactionClient rather than opening its
// own transaction, so Phase 8.3/8.4 can later compose a Driver Cash
// mutation into the SAME atomic transaction as an operational delivery
// finalization (and Phase 8.6 into the same transaction as a
// driver_settlements row creation). A convenience wrapper
// (runDriverCashTransaction) is provided for isolated/internal use, but the
// composable primitive is the actual foundation.
//
// Only the ledger MECHANICS are implemented here — not the business
// workflows that will eventually call it:
//   - COLLECTION (credit) is exposed via creditDriverCollection, usable
//     today by any trusted internal caller.
//   - SETTLEMENT (debit) is supported at the primitive level only; no
//     settlement business flow, settlement-number generation, or
//     driver_settlements row creation exists here (Phase 8.6).
//   - ADJUSTMENT/REVERSAL are supported technically (explicit direction,
//     optional reversal_of_id) with no authorization/business-reason/
//     exactly-once-reversal policy (Phase 8.8) and no public endpoint.
// ============================================================

import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { MONEY_DECIMAL_PLACES, MONEY_MAX_VALUE } from "../orders/order-financial.schema";
import type { driver_cash_accounts, driver_cash_transactions, DriverCashTransactionType } from "../../generated/prisma/client";

export type DriverCashDirection = "CREDIT" | "DEBIT";

// Locks which (type, direction) combinations are technically meaningful.
// COLLECTION is credit-only and SETTLEMENT is debit-only by definition;
// ADJUSTMENT/REVERSAL may go either way, but the caller must say which —
// this module never guesses a business direction for those two types
// (that judgment belongs to Phase 8.8).
const TYPE_DIRECTIONS: Record<DriverCashTransactionType, readonly DriverCashDirection[]> = {
  COLLECTION: ["CREDIT"],
  SETTLEMENT: ["DEBIT"],
  ADJUSTMENT: ["CREDIT", "DEBIT"],
  REVERSAL: ["CREDIT", "DEBIT"],
};

export interface ApplyDriverCashTransactionInput {
  driverId: string;
  type: DriverCashTransactionType;
  direction: DriverCashDirection;
  amount: Prisma.Decimal;
  orderId?: string;
  settlementId?: string;
  createdById?: string;
  notes?: string;
  reversalOfId?: string;
  idempotencyKey?: string;
}

export interface DriverCashTransactionResult {
  transaction: driver_cash_transactions;
  account: driver_cash_accounts;
}

// Ledger amount convention (locked for V1): amount is always a POSITIVE
// MAGNITUDE. Direction is expressed only via balance movement
// (CREDIT: after = before + amount; DEBIT: after = before - amount) — never
// by storing a negative amount. A zero-value row is meaningless and
// rejected here; callers (e.g. Phase 8.3/8.4) decide whether a $0 event
// should skip calling this primitive at all.
function assertValidLedgerAmount(amount: Prisma.Decimal): void {
  if (!amount.isFinite()) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "Driver cash amount is not a valid amount" });
  }
  if (amount.lessThanOrEqualTo(0)) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "Driver cash amount must be greater than zero" });
  }
  if (amount.decimalPlaces() > MONEY_DECIMAL_PLACES) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: `Driver cash amount supports at most ${MONEY_DECIMAL_PLACES} decimal places`,
    });
  }
  if (amount.greaterThan(MONEY_MAX_VALUE)) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "Driver cash amount exceeds the supported range" });
  }
}

// The core reusable primitive. Must be called with an ALREADY-OPEN
// transaction client — see the module doc comment above for why this is
// mandatory, not merely convenient.
//
// Atomicity/concurrency:
//   - CREDIT uses a single atomic `update` with `increment`, letting
//     Postgres serialize concurrent credits at the row level; the returned
//     row's current_balance IS the exact post-credit balance, so
//     balanceBefore is derived from it via Decimal subtraction (never a
//     separately-read, potentially-stale value).
//   - DEBIT uses a conditional `updateMany` whose WHERE clause re-asserts
//     current_balance >= amount against the LIVE committed row — if a
//     concurrent debit already reduced the balance below what this debit
//     needs, this updateMany affects 0 rows and the operation fails closed
//     with a controlled 400, never a negative balance and never relying on
//     a pre-read check alone.
//   - The ledger row insert happens in the same transaction as the balance
//     mutation; if the insert fails (e.g. a duplicate idempotency_key), the
//     whole transaction — including the balance mutation — rolls back.
export async function applyDriverCashTransaction(
  tx: Prisma.TransactionClient,
  input: ApplyDriverCashTransactionInput
): Promise<DriverCashTransactionResult> {
  if (!TYPE_DIRECTIONS[input.type].includes(input.direction)) {
    throw new AppError({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Invalid driver cash transaction type/direction combination",
    });
  }
  assertValidLedgerAmount(input.amount);

  // Phase 5.2 creates the Driver + its cash account atomically — a linked
  // Driver should always have exactly one. If it doesn't, this is a
  // data-integrity failure: fail closed, never auto-create the account
  // here (that would silently repair financial state).
  const existingAccount = await tx.driver_cash_accounts.findUnique({ where: { driver_id: input.driverId } });
  if (!existingAccount) {
    console.error(
      `[driver-cash-ledger.service] data-integrity failure: driver ${input.driverId} has no linked driver_cash_accounts row`
    );
    throw new AppError({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Driver cash account is missing — action was not performed",
    });
  }

  let account: driver_cash_accounts;
  if (input.direction === "CREDIT") {
    account = await tx.driver_cash_accounts.update({
      where: { driver_id: input.driverId },
      data: { current_balance: { increment: input.amount }, updated_at: new Date() },
    });
  } else {
    const claim = await tx.driver_cash_accounts.updateMany({
      where: { driver_id: input.driverId, current_balance: { gte: input.amount } },
      data: { current_balance: { decrement: input.amount }, updated_at: new Date() },
    });
    if (claim.count !== 1) {
      throw new AppError({
        statusCode: 400,
        code: "VALIDATION_ERROR",
        message: "Insufficient driver cash balance for this operation",
      });
    }
    account = await tx.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: input.driverId } });
  }

  const balanceAfter = account.current_balance;
  const balanceBefore = input.direction === "CREDIT" ? balanceAfter.minus(input.amount) : balanceAfter.plus(input.amount);

  try {
    const transaction = await tx.driver_cash_transactions.create({
      data: {
        account_id: account.id,
        driver_id: input.driverId,
        order_id: input.orderId,
        settlement_id: input.settlementId,
        type: input.type,
        amount: input.amount,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        created_by_id: input.createdById,
        notes: input.notes,
        reversal_of_id: input.reversalOfId,
        idempotency_key: input.idempotencyKey,
      },
    });
    return { transaction, account };
  } catch (error) {
    // The account mutation above and this insert share one transaction —
    // throwing here rolls the balance change back too. Never leak the raw
    // Prisma error (e.g. a P2002 on the UNIQUE idempotency_key/settlement_id
    // constraints).
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "Driver cash transaction already recorded for this request",
      });
    }
    throw error;
  }
}

// Focused COLLECTION helper — CREDIT only, no Order required (the generic
// foundation must not assume every collection is delivery-linked; Phase
// 8.3/8.4 will supply orderId when wiring real delivery finance).
export interface CreditDriverCollectionInput {
  driverId: string;
  amount: Prisma.Decimal;
  orderId?: string;
  createdById?: string;
  notes?: string;
  idempotencyKey?: string;
}

export async function creditDriverCollection(
  tx: Prisma.TransactionClient,
  input: CreditDriverCollectionInput
): Promise<DriverCashTransactionResult> {
  return applyDriverCashTransaction(tx, {
    driverId: input.driverId,
    type: "COLLECTION",
    direction: "CREDIT",
    amount: input.amount,
    orderId: input.orderId,
    createdById: input.createdById,
    notes: input.notes,
    idempotencyKey: input.idempotencyKey,
  });
}

// SETTLEMENT ledger primitive — DEBIT only. Deliberately does NOT create a
// driver_settlements row or generate a settlement number; Phase 8.6 owns
// that orchestration and is expected to create the driver_settlements row
// first (inside its own transaction) and pass the resulting settlementId
// here.
export interface DebitDriverSettlementInput {
  driverId: string;
  amount: Prisma.Decimal;
  settlementId?: string;
  createdById?: string;
  notes?: string;
  idempotencyKey?: string;
}

export async function debitDriverSettlement(
  tx: Prisma.TransactionClient,
  input: DebitDriverSettlementInput
): Promise<DriverCashTransactionResult> {
  return applyDriverCashTransaction(tx, {
    driverId: input.driverId,
    type: "SETTLEMENT",
    direction: "DEBIT",
    amount: input.amount,
    settlementId: input.settlementId,
    createdById: input.createdById,
    notes: input.notes,
    idempotencyKey: input.idempotencyKey,
  });
}

// ADJUSTMENT technical foundation — the caller must supply an explicit
// direction; this module never infers whether a given business adjustment
// should credit or debit (Phase 8.8 owns that judgment, plus authorization
// and business-reason requirements). No public endpoint exists.
export interface ApplyDriverCashAdjustmentInput {
  driverId: string;
  direction: DriverCashDirection;
  amount: Prisma.Decimal;
  createdById?: string;
  notes?: string;
  idempotencyKey?: string;
}

export async function applyDriverCashAdjustment(
  tx: Prisma.TransactionClient,
  input: ApplyDriverCashAdjustmentInput
): Promise<DriverCashTransactionResult> {
  return applyDriverCashTransaction(tx, {
    driverId: input.driverId,
    type: "ADJUSTMENT",
    direction: input.direction,
    amount: input.amount,
    createdById: input.createdById,
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
export interface ApplyDriverCashReversalInput {
  driverId: string;
  direction: DriverCashDirection;
  amount: Prisma.Decimal;
  reversalOfId?: string;
  createdById?: string;
  notes?: string;
  idempotencyKey?: string;
}

export async function applyDriverCashReversal(
  tx: Prisma.TransactionClient,
  input: ApplyDriverCashReversalInput
): Promise<DriverCashTransactionResult> {
  return applyDriverCashTransaction(tx, {
    driverId: input.driverId,
    type: "REVERSAL",
    direction: input.direction,
    amount: input.amount,
    reversalOfId: input.reversalOfId,
    createdById: input.createdById,
    notes: input.notes,
    idempotencyKey: input.idempotencyKey,
  });
}

// Convenience wrapper that opens its own transaction — for isolated/
// internal callers (tests, one-off scripts) that are not already composing
// into a larger transaction. Phase 8.3/8.4/8.6 must call
// applyDriverCashTransaction (or one of the focused helpers above) directly
// with THEIR OWN transaction client instead of this wrapper, so the Driver
// Cash mutation commits atomically with the rest of their operation.
export async function runDriverCashTransaction(
  input: ApplyDriverCashTransactionInput
): Promise<DriverCashTransactionResult> {
  return prisma.$transaction((tx) => applyDriverCashTransaction(tx, input));
}
