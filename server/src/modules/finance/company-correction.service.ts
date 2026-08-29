import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { createSignedCompanyFinancialTransaction, recordCompanyAdjustment } from "../company-finance/company-finance-ledger.service";
import { createAuditLog } from "../../shared/audit/audit.service";
import type { AdjustCompanyInput } from "./finance-correction.schema";
import type { CompanyCorrectionEntry } from "./finance-correction.types";

// ============================================================
// Company Finance Adjustments + Reversals (Phase 8.8)
//
// Company Finance has no cached running balance, so a correction is simply
// another append-only signed row (see company-finance-ledger.service.ts's
// ADJUSTMENT/REVERSAL section for the signed-amount convention). Reuses
// that same primitive — no second Company Finance insertion path exists
// here.
// ============================================================

const correctionSelect = {
  id: true,
  type: true,
  amount: true,
  order_id: true,
  payment_method_id: true,
  reversal_of_id: true,
  notes: true,
  created_at: true,
  users: { select: { id: true, first_name: true, last_name: true } },
} satisfies Prisma.company_financial_transactionsSelect;

type CorrectionRow = Prisma.company_financial_transactionsGetPayload<{ select: typeof correctionSelect }>;

function toCompanyCorrectionEntry(row: CorrectionRow): CompanyCorrectionEntry {
  return {
    id: row.id,
    type: row.type,
    amount: row.amount.toString(),
    orderId: row.order_id,
    paymentMethodId: row.payment_method_id,
    reversalOfId: row.reversal_of_id,
    createdBy: row.users ? { id: row.users.id, firstName: row.users.first_name, lastName: row.users.last_name } : null,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
  };
}

// ============================================================
// PART A — POST /api/v1/finance/company/adjust
// ============================================================

export async function createCompanyAdjustment(input: AdjustCompanyInput, actorUserId: string): Promise<CompanyCorrectionEntry> {
  return prisma.$transaction(async (tx) => {
    const created = await recordCompanyAdjustment(tx, {
      direction: input.direction,
      amount: input.amount,
      createdById: actorUserId,
      notes: input.reason,
    });

    await createAuditLog(tx, {
      actorUserId,
      action: "COMPANY_FINANCIAL_ADJUSTMENT_CREATED",
      entityType: "COMPANY_FINANCIAL_TRANSACTION",
      entityId: created.id,
      newValues: { direction: input.direction, amount: created.amount.toString() },
      metadata: {
        transactionId: created.id,
        direction: input.direction,
        requestedAmount: input.amount.toString(),
        storedAmount: created.amount.toString(),
        reason: input.reason,
      },
    });

    const full = await tx.company_financial_transactions.findUniqueOrThrow({ where: { id: created.id }, select: correctionSelect });
    return toCompanyCorrectionEntry(full);
  });
}

// ============================================================
// PART B — POST /api/v1/finance/company-transactions/:transactionId/reverse
// ============================================================

export async function reverseCompanyTransaction(
  transactionId: string,
  reason: string,
  actorUserId: string
): Promise<CompanyCorrectionEntry> {
  const original = await prisma.company_financial_transactions.findUnique({ where: { id: transactionId } });
  if (!original) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Company financial transaction not found" });
  }

  if (original.type === "REVERSAL") {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "A REVERSAL transaction cannot itself be reversed — use an ADJUSTMENT to correct an incorrect reversal",
    });
  }

  const existingReversal = await prisma.company_financial_transactions.findFirst({ where: { reversal_of_id: transactionId } });
  if (existingReversal) {
    throw new AppError({ statusCode: 409, code: "CONFLICT", message: "This transaction has already been reversed" });
  }

  // Revenue types must be strictly positive; a zero-value row of any type
  // is meaningless and treated as integrity corruption. ADJUSTMENT amounts
  // may legitimately be positive or negative, but never zero.
  if (original.amount.isZero()) {
    console.error(`[company-correction.service] data-integrity failure: company_financial_transactions ${transactionId} has a zero amount`);
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Original company financial transaction is inconsistent — action was not performed" });
  }
  if ((original.type === "DELIVERY_FEE_REVENUE" || original.type === "COMPANY_ORDER_PRODUCT_REVENUE") && original.amount.lessThanOrEqualTo(0)) {
    console.error(`[company-correction.service] data-integrity failure: revenue-type company_financial_transactions ${transactionId} has amount <= 0`);
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Original company financial transaction is inconsistent — action was not performed" });
  }

  const reversalAmount = original.amount.negated();

  return prisma.$transaction(async (tx) => {
    const created = await createSignedCompanyFinancialTransaction(tx, {
      type: "REVERSAL",
      amount: reversalAmount,
      orderId: original.order_id ?? undefined,
      paymentMethodId: original.payment_method_id ?? undefined,
      createdById: actorUserId,
      notes: reason,
      reversalOfId: original.id,
      idempotencyKey: `reversal:company:${original.id}`,
    });

    await createAuditLog(tx, {
      actorUserId,
      action: "COMPANY_FINANCIAL_TRANSACTION_REVERSED",
      entityType: "COMPANY_FINANCIAL_TRANSACTION",
      entityId: original.id,
      previousValues: { originalType: original.type, originalAmount: original.amount.toString() },
      newValues: { reversalTransactionId: created.id, reversalAmount: reversalAmount.toString() },
      metadata: {
        originalTransactionId: original.id,
        originalType: original.type,
        originalAmount: original.amount.toString(),
        reversalTransactionId: created.id,
        reversalAmount: reversalAmount.toString(),
        reason,
        orderId: original.order_id,
      },
    });

    const full = await tx.company_financial_transactions.findUniqueOrThrow({ where: { id: created.id }, select: correctionSelect });
    return toCompanyCorrectionEntry(full);
  });
}
