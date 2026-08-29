// ============================================================
// Company Finance ledger writer (Phase 8.3 — minimal foundation).
//
// There is no dedicated Company Finance foundation sub-phase yet (unlike
// Driver Cash/Phase 8.1 and Customer Wallet/Phase 8.2) — company revenue has
// no cached running balance to mutate, just an append-only ledger. This is
// therefore a deliberately small, Express-independent transaction-client
// helper: enough for Phase 8.3's exact Delivery Only delivery-fee revenue
// posting, reusable as-is by Phase 8.4's Company Order integration. It does
// NOT implement a Finance API, summary/read endpoints, adjustments, or
// reversals — those remain later work.
// ============================================================

import { Prisma } from "../../generated/prisma/client";
import { AppError } from "../../shared/errors/app-error";
import { MONEY_DECIMAL_PLACES, MONEY_MAX_VALUE } from "../orders/order-financial.schema";
import type { company_financial_transactions, CompanyFinancialTransactionType } from "../../generated/prisma/client";

// Same Decimal-safe positive-magnitude convention as Phase 8.1/8.2 — a
// zero-value ledger row is meaningless; callers must skip calling this
// helper entirely when there is nothing to post (see Phase 8.3's
// zero-component handling in driver-order.service.ts).
function assertValidLedgerAmount(amount: Prisma.Decimal): void {
  if (!amount.isFinite()) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "Company finance amount is not a valid amount" });
  }
  if (amount.lessThanOrEqualTo(0)) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "Company finance amount must be greater than zero" });
  }
  if (amount.decimalPlaces() > MONEY_DECIMAL_PLACES) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: `Company finance amount supports at most ${MONEY_DECIMAL_PLACES} decimal places`,
    });
  }
  if (amount.greaterThan(MONEY_MAX_VALUE)) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "Company finance amount exceeds the supported range" });
  }
}

export interface CreateCompanyFinancialTransactionInput {
  type: CompanyFinancialTransactionType;
  amount: Prisma.Decimal;
  orderId?: string;
  paymentMethodId?: string;
  createdById?: string;
  notes?: string;
  reversalOfId?: string;
  idempotencyKey?: string;
}

// Core append-only primitive. Must be called with an ALREADY-OPEN
// transaction client — Phase 8.3 composes this into the same transaction as
// the operational delivery finalization, Driver Cash collection, and
// Customer Wallet credit, so a company-finance insert failure rolls the
// entire delivery back, never leaving a partially-financed Order.
export async function createCompanyFinancialTransaction(
  tx: Prisma.TransactionClient,
  input: CreateCompanyFinancialTransactionInput
): Promise<company_financial_transactions> {
  assertValidLedgerAmount(input.amount);

  try {
    return await tx.company_financial_transactions.create({
      data: {
        type: input.type,
        amount: input.amount,
        order_id: input.orderId,
        payment_method_id: input.paymentMethodId,
        created_by_id: input.createdById,
        notes: input.notes,
        reversal_of_id: input.reversalOfId,
        idempotency_key: input.idempotencyKey,
      },
    });
  } catch (error) {
    // Never leak the raw Prisma error (e.g. a P2002 on the UNIQUE
    // idempotency_key constraint) — the caller's outer transaction rolls
    // back entirely when this throws.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "Company financial transaction already recorded for this request",
      });
    }
    throw error;
  }
}

// Focused helper for Phase 8.3's exact Delivery Only delivery-fee revenue.
// Also reused as-is by Phase 8.4's exact Company Order delivery-fee revenue
// — the fee-revenue rule (remaining_delivery_fee, whichever order type) is
// identical for both.
export interface RecordDeliveryFeeRevenueInput {
  orderId: string;
  amount: Prisma.Decimal;
  paymentMethodId?: string;
  createdById?: string;
  notes?: string;
  idempotencyKey?: string;
}

export async function recordDeliveryFeeRevenue(
  tx: Prisma.TransactionClient,
  input: RecordDeliveryFeeRevenueInput
): Promise<company_financial_transactions> {
  return createCompanyFinancialTransaction(tx, {
    type: "DELIVERY_FEE_REVENUE",
    amount: input.amount,
    orderId: input.orderId,
    paymentMethodId: input.paymentMethodId,
    createdById: input.createdById,
    notes: input.notes,
    idempotencyKey: input.idempotencyKey,
  });
}

// Focused helper for Phase 8.4's exact Company Order product revenue — the
// qualifying unpaid order value (remaining_order_amount) belongs to the
// company for a COMPANY_ORDER, never the customer wallet.
export interface RecordCompanyOrderProductRevenueInput {
  orderId: string;
  amount: Prisma.Decimal;
  paymentMethodId?: string;
  createdById?: string;
  notes?: string;
  idempotencyKey?: string;
}

export async function recordCompanyOrderProductRevenue(
  tx: Prisma.TransactionClient,
  input: RecordCompanyOrderProductRevenueInput
): Promise<company_financial_transactions> {
  return createCompanyFinancialTransaction(tx, {
    type: "COMPANY_ORDER_PRODUCT_REVENUE",
    amount: input.amount,
    orderId: input.orderId,
    paymentMethodId: input.paymentMethodId,
    createdById: input.createdById,
    notes: input.notes,
    idempotencyKey: input.idempotencyKey,
  });
}

// ============================================================
// ADJUSTMENT / REVERSAL (Phase 8.8) — signed-amount convention.
//
// Company Finance has no cached running balance (unlike Driver Cash/Wallet),
// so there is nothing to debit/credit — a correction is simply another
// append-only row. Revenue types (DELIVERY_FEE_REVENUE,
// COMPANY_ORDER_PRODUCT_REVENUE) stay strictly positive via
// createCompanyFinancialTransaction/assertValidLedgerAmount above — that
// invariant is deliberately NOT relaxed. ADJUSTMENT/REVERSAL instead use
// this separate signed insert path: a stored NEGATIVE amount represents a
// DEBIT-direction correction, so future Finance reporting can reconcile
// company money with a plain SUM(amount) across all types.
// ============================================================

function assertValidSignedLedgerAmount(amount: Prisma.Decimal): void {
  if (!amount.isFinite()) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "Company finance amount is not a valid amount" });
  }
  if (amount.isZero()) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "Company finance amount must not be zero" });
  }
  if (amount.decimalPlaces() > MONEY_DECIMAL_PLACES) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: `Company finance amount supports at most ${MONEY_DECIMAL_PLACES} decimal places`,
    });
  }
  if (amount.abs().greaterThan(MONEY_MAX_VALUE)) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "Company finance amount exceeds the supported range" });
  }
}

export interface CreateSignedCompanyFinancialTransactionInput {
  type: "ADJUSTMENT" | "REVERSAL";
  // Already signed: negative represents a DEBIT-direction correction.
  amount: Prisma.Decimal;
  orderId?: string;
  paymentMethodId?: string;
  createdById?: string;
  notes?: string;
  reversalOfId?: string;
  idempotencyKey?: string;
}

// Low-level signed-amount primitive — must be called with an ALREADY-OPEN
// transaction client, exactly like createCompanyFinancialTransaction above.
export async function createSignedCompanyFinancialTransaction(
  tx: Prisma.TransactionClient,
  input: CreateSignedCompanyFinancialTransactionInput
): Promise<company_financial_transactions> {
  assertValidSignedLedgerAmount(input.amount);

  try {
    return await tx.company_financial_transactions.create({
      data: {
        type: input.type,
        amount: input.amount,
        order_id: input.orderId,
        payment_method_id: input.paymentMethodId,
        created_by_id: input.createdById,
        notes: input.notes,
        reversal_of_id: input.reversalOfId,
        idempotency_key: input.idempotencyKey,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "Company financial transaction already recorded for this request",
      });
    }
    throw error;
  }
}

// Focused ADJUSTMENT helper for Phase 8.8's manual correction endpoint. The
// request amount is always a positive magnitude (the API contract); this
// derives the stored signed value. No Order association is required or
// invented — a manual adjustment need not belong to any Order.
export interface RecordCompanyAdjustmentInput {
  direction: "CREDIT" | "DEBIT";
  amount: Prisma.Decimal;
  createdById?: string;
  notes?: string;
  idempotencyKey?: string;
}

export async function recordCompanyAdjustment(
  tx: Prisma.TransactionClient,
  input: RecordCompanyAdjustmentInput
): Promise<company_financial_transactions> {
  if (input.amount.lessThanOrEqualTo(0)) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "Amount must be greater than zero" });
  }
  const signedAmount = input.direction === "CREDIT" ? input.amount : input.amount.negated();
  return createSignedCompanyFinancialTransaction(tx, {
    type: "ADJUSTMENT",
    amount: signedAmount,
    createdById: input.createdById,
    notes: input.notes,
    idempotencyKey: input.idempotencyKey,
  });
}
