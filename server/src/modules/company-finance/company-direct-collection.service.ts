// ============================================================
// Company Direct Collection writer (Direct Payment Settlement).
//
// Records money collected at delivery with a payment method configured
// `bypass_driver_cash = true` — i.e. received DIRECTLY by the company (e.g. a
// wallet/transfer app) and never physically held by the Driver. It is the
// counterpart of creditDriverCollection() (driver-cash-ledger.service.ts) for
// that routing, and deliberately NOT:
//   - Driver Cash: no balance change, no settlement obligation
//   - Company revenue: ownership is still posted separately to
//     company_financial_transactions (revenue) / wallet_transactions
//     (customer liability) exactly as for a driver-held collection
//   - Customer wallet
// The row's existence IS the persisted routing decision for that delivery, so
// toggling payment_methods.bypass_driver_cash later never rewrites history.
//
// Must be called with an ALREADY-OPEN transaction client — it is composed
// into the /deliver transaction so a failure here rolls the delivery back.
// ============================================================

import { Prisma } from "../../generated/prisma/client";
import type { company_direct_collections } from "../../generated/prisma/client";
import { AppError } from "../../shared/errors/app-error";
import { MONEY_DECIMAL_PLACES, MONEY_MAX_VALUE } from "../orders/order-financial.schema";

// Same positive-magnitude rule as every other collection ledger — a zero
// collection posts nothing (callers skip the call entirely).
function assertValidDirectCollectionAmount(amount: Prisma.Decimal): void {
  if (!amount.isFinite() || amount.lessThanOrEqualTo(0)) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "Direct collection amount must be greater than zero" });
  }
  if (amount.decimalPlaces() > MONEY_DECIMAL_PLACES) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: `Direct collection amount supports at most ${MONEY_DECIMAL_PLACES} decimal places`,
    });
  }
  if (amount.greaterThan(MONEY_MAX_VALUE)) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "Direct collection amount exceeds the supported range" });
  }
}

export interface RecordDirectCompanyCollectionInput {
  orderId: string;
  driverId?: string;
  paymentMethodId: string;
  amount: Prisma.Decimal;
  createdById?: string;
  notes?: string;
  idempotencyKey?: string;
}

export async function recordDirectCompanyCollection(
  tx: Prisma.TransactionClient,
  input: RecordDirectCompanyCollectionInput
): Promise<company_direct_collections> {
  assertValidDirectCollectionAmount(input.amount);

  try {
    return await tx.company_direct_collections.create({
      data: {
        order_id: input.orderId,
        driver_id: input.driverId,
        payment_method_id: input.paymentMethodId,
        amount: input.amount,
        created_by_id: input.createdById,
        notes: input.notes,
        idempotency_key: input.idempotencyKey,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "Direct company collection already recorded for this request",
      });
    }
    throw error;
  }
}
