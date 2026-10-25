// ============================================================
// Settlement-Based Financial Release — release corrections (FR.6)
//
// Contract: docs/settlement-financial-release-contract.md §4.1, §8, §11
// (R6 / R12). Business rules: docs/requirements.md §55.8.
//
//   POST /finance/order-releases/:releaseId/void-collection
//     PENDING + unallocated -> VOIDED. Reverses the Driver Cash COLLECTION
//     (existing reversal key); nothing was ever posted, nothing is posted.
//   POST /finance/order-releases/:releaseId/reverse-release
//     RELEASED -> RELEASE_REVERSED. Reverses the released wallet credit /
//     company revenue with the existing reversal primitives and keys. Fails
//     (409 RELEASED_FUNDS_PAID_OUT) rather than forcing a wallet negative.
//
// Both are terminal: one order_financial_release_corrections row per
// release (UNIQUE release_id), deterministic idempotency keys
// release-void:<id> / release-reversal:<id>. A retry with the same reason
// returns the recorded correction; a different reason is a 409. Original
// ledger rows and the release's posting references are never edited.
// ============================================================

import { Prisma } from "../../generated/prisma/client";
import type { order_financial_release_corrections, order_financial_releases } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { createAuditLog } from "../../shared/audit/audit.service";
import { applyDriverCashTransaction } from "../driver-cash/driver-cash-ledger.service";
import { applyWalletTransaction } from "../wallets/wallet-ledger.service";
import { createSignedCompanyFinancialTransaction } from "../company-finance/company-finance-ledger.service";
import { assertReleaseCollectionIntact, lockDriverCashPosition, lockFinancialRelease } from "./financial-release.service";
import type { ReleaseCorrectionEntry } from "./financial-release.types";

type CorrectionKind = "COLLECTION_VOID" | "RELEASE_REVERSAL";

function correctionConflict(reason: string, message: string): AppError {
  return new AppError({ statusCode: 409, code: "CONFLICT", message, details: { reason } });
}

function integrityFailure(detail: string): AppError {
  console.error(`[financial-release-correction.service] data-integrity failure: ${detail}`);
  return new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Financial release is inconsistent — action was not performed" });
}

const correctionInclude = {
  release: { select: { order_id: true, release_status: true, orders: { select: { financial_status: true } } } },
  created_by: { select: { id: true, first_name: true, last_name: true } },
} satisfies Prisma.order_financial_release_correctionsInclude;

type CorrectionRow = Prisma.order_financial_release_correctionsGetPayload<{ include: typeof correctionInclude }>;

function toReleaseCorrectionEntry(row: CorrectionRow): ReleaseCorrectionEntry {
  return {
    id: row.id,
    releaseId: row.release_id,
    orderId: row.release.order_id,
    correctionType: row.correction_type,
    reason: row.reason,
    driverCashReversalTransactionId: row.driver_cash_reversal_transaction_id,
    walletReversalTransactionId: row.wallet_reversal_transaction_id,
    companyProductReversalTransactionId: row.company_product_reversal_transaction_id,
    companyFeeReversalTransactionId: row.company_fee_reversal_transaction_id,
    releaseStatus: row.release.release_status,
    orderFinancialStatus: row.release.orders.financial_status,
    createdBy: { id: row.created_by.id, firstName: row.created_by.first_name, lastName: row.created_by.last_name },
    createdAt: row.created_at.toISOString(),
  };
}

async function loadCorrectionEntry(correctionId: string): Promise<ReleaseCorrectionEntry> {
  const row = await prisma.order_financial_release_corrections.findUniqueOrThrow({ where: { id: correctionId }, include: correctionInclude });
  return toReleaseCorrectionEntry(row);
}

// A release has at most one terminal correction. A retry of the same
// correction (same type, same reason) is answered with the recorded one;
// anything else is a conflict — never a second correction.
function replayOrConflict(existing: order_financial_release_corrections, kind: CorrectionKind, reason: string): string {
  if (existing.correction_type === kind && existing.reason === reason) {
    return existing.id;
  }
  throw correctionConflict("RELEASE_ALREADY_CORRECTED", "This financial release has already been corrected");
}

// Order ↔ release consistency the database does not enforce. Fails closed.
async function loadConsistentOrder(tx: Prisma.TransactionClient, release: order_financial_releases) {
  const order = await tx.orders.findUnique({
    where: { id: release.order_id },
    select: { status: true, customer_id: true, order_type: true, financial_status: true, financial_release_mode: true, actual_amount_collected: true },
  });
  if (
    !order ||
    order.status !== "DELIVERED" ||
    order.financial_release_mode !== "ON_SETTLEMENT" ||
    order.customer_id !== release.customer_id ||
    order.order_type !== release.order_type ||
    order.actual_amount_collected === null ||
    !order.actual_amount_collected.equals(release.collection_amount)
  ) {
    throw integrityFailure(`release ${release.id} does not match its order`);
  }
  return order;
}

// ============================================================
// Collection void
// ============================================================

export async function voidReleaseCollection(releaseId: string, reason: string, actorUserId: string): Promise<ReleaseCorrectionEntry> {
  // driver_id is an immutable snapshot — read unlocked only to know which
  // account lock to take first (contract §6: account 3 before release 4).
  const snapshot = await prisma.order_financial_releases.findUnique({ where: { id: releaseId }, select: { driver_id: true } });
  if (!snapshot) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Financial release not found" });
  }

  const correctionId = await prisma.$transaction(async (tx) => {
    await lockDriverCashPosition(tx, snapshot.driver_id);
    const release = await lockFinancialRelease(tx, releaseId);
    if (!release) {
      throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Financial release not found" });
    }
    const existing = await tx.order_financial_release_corrections.findUnique({ where: { release_id: releaseId } });
    if (existing) {
      return replayOrConflict(existing, "COLLECTION_VOID", reason);
    }
    if (release.release_status === "RELEASED" || release.allocated_amount.greaterThan(0)) {
      throw correctionConflict(
        "COLLECTION_HAS_ALLOCATIONS",
        "This collection has settlement allocations or released funds — reverse the allocating settlement(s) first"
      );
    }
    if (release.release_status !== "PENDING") {
      throw integrityFailure(`release ${release.id} is ${release.release_status} without a correction record`);
    }
    const order = await loadConsistentOrder(tx, release);
    await assertReleaseCollectionIntact(tx, release);
    const previousFinancialStatus = order.financial_status;

    const now = new Date();
    const claimed = await tx.orders.updateMany({
      where: {
        id: release.order_id,
        status: "DELIVERED",
        financial_release_mode: "ON_SETTLEMENT",
        financial_status: { in: ["AWAITING_SETTLEMENT", "REVIEW_REQUIRED"] },
      },
      data: { financial_status: "COLLECTION_VOIDED", needs_financial_review: false, updated_at: now },
    });
    if (claimed.count !== 1) {
      throw correctionConflict("ORDER_STATE_CHANGED", "Order financial state was changed by another request — please retry");
    }

    // The reversed cash was reserved by this release (outstanding =
    // collection), so it never consumes unattributed cash.
    const cash = await applyDriverCashTransaction(tx, {
      driverId: release.driver_id,
      type: "REVERSAL",
      direction: "DEBIT",
      amount: release.collection_amount,
      orderId: release.order_id,
      createdById: actorUserId,
      notes: reason,
      reversalOfId: release.collection_transaction_id,
      idempotencyKey: `reversal:driver-cash:${release.collection_transaction_id}`,
    });

    const correction = await tx.order_financial_release_corrections.create({
      data: {
        release_id: release.id,
        correction_type: "COLLECTION_VOID",
        reason,
        driver_cash_reversal_transaction_id: cash.transaction.id,
        created_by_id: actorUserId,
        idempotency_key: `release-void:${release.id}`,
      },
    });

    const voided = await tx.order_financial_releases.updateMany({
      where: { id: release.id, release_status: "PENDING", allocated_amount: 0 },
      data: { release_status: "VOIDED", updated_at: now },
    });
    if (voided.count !== 1) {
      throw correctionConflict("RELEASE_STATE_CHANGED", "Financial release was changed by another request — please retry");
    }

    await createAuditLog(tx, {
      actorUserId,
      action: "FINANCIAL_RELEASE_COLLECTION_VOIDED",
      entityType: "ORDER",
      entityId: release.order_id,
      previousValues: { financialStatus: previousFinancialStatus, releaseStatus: "PENDING" },
      newValues: { financialStatus: "COLLECTION_VOIDED", releaseStatus: "VOIDED" },
      metadata: {
        releaseId: release.id,
        correctionId: correction.id,
        reason,
        driverId: release.driver_id,
        collectionTransactionId: release.collection_transaction_id,
        driverCashReversalTransactionId: cash.transaction.id,
        collectionAmount: release.collection_amount.toString(),
        reviewStatus: release.review_status,
      },
    });
    return correction.id;
  });

  return loadCorrectionEntry(correctionId);
}

// ============================================================
// Release reversal
// ============================================================

interface PostedOriginal {
  id: string;
  amount: Prisma.Decimal;
  paymentMethodId: string | null;
}

async function loadWalletOriginal(tx: Prisma.TransactionClient, release: order_financial_releases): Promise<PostedOriginal | null> {
  const planned = release.planned_customer_wallet_amount as Prisma.Decimal;
  if (!planned.greaterThan(0)) return null;
  const row = release.wallet_transaction_id ? await tx.wallet_transactions.findUnique({ where: { id: release.wallet_transaction_id } }) : null;
  if (!row || row.type !== "ORDER_CREDIT" || row.order_id !== release.order_id || row.customer_id !== release.customer_id || !row.credit.equals(planned)) {
    throw integrityFailure(`release ${release.id} wallet posting does not match its planned amount`);
  }
  return { id: row.id, amount: row.credit, paymentMethodId: row.payment_method_id };
}

async function loadCompanyOriginal(
  tx: Prisma.TransactionClient,
  release: order_financial_releases,
  transactionId: string | null,
  planned: Prisma.Decimal,
  type: "COMPANY_ORDER_PRODUCT_REVENUE" | "DELIVERY_FEE_REVENUE"
): Promise<PostedOriginal | null> {
  if (!planned.greaterThan(0)) return null;
  const row = transactionId ? await tx.company_financial_transactions.findUnique({ where: { id: transactionId } }) : null;
  if (!row || row.type !== type || row.order_id !== release.order_id || !row.amount.equals(planned)) {
    throw integrityFailure(`release ${release.id} ${type} posting does not match its planned amount`);
  }
  return { id: row.id, amount: row.amount, paymentMethodId: row.payment_method_id };
}

export async function reverseRelease(releaseId: string, reason: string, actorUserId: string): Promise<ReleaseCorrectionEntry> {
  const correctionId = await prisma.$transaction(async (tx) => {
    // Lock order (contract §6): release 4 -> order 5 -> wallet 6 -> inserts 7.
    const release = await lockFinancialRelease(tx, releaseId);
    if (!release) {
      throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Financial release not found" });
    }
    const existing = await tx.order_financial_release_corrections.findUnique({ where: { release_id: releaseId } });
    if (existing) {
      return replayOrConflict(existing, "RELEASE_REVERSAL", reason);
    }
    if (release.release_status !== "RELEASED") {
      throw correctionConflict("RELEASE_NOT_RELEASED", "Only a released financial release can be reversed");
    }
    const order = await loadConsistentOrder(tx, release);
    if (order.financial_status !== "FINALIZED") {
      throw integrityFailure(`RELEASED release ${release.id} has order financial_status ${order.financial_status}`);
    }

    const wallet = await loadWalletOriginal(tx, release);
    const product = await loadCompanyOriginal(
      tx,
      release,
      release.company_product_transaction_id,
      release.planned_company_product_amount as Prisma.Decimal,
      "COMPANY_ORDER_PRODUCT_REVENUE"
    );
    const fee = await loadCompanyOriginal(tx, release, release.company_fee_transaction_id, release.planned_company_fee_amount as Prisma.Decimal, "DELIVERY_FEE_REVENUE");
    if (!wallet && !product && !fee) {
      throw integrityFailure(`RELEASED release ${release.id} has no postings`);
    }
    // The generic reverse endpoints refuse release-linked rows (FR.6), so an
    // existing reversal here predates that guard — never reversed twice.
    const originalIds = [wallet?.id, product?.id, fee?.id].filter((id): id is string => id !== undefined);
    const alreadyReversed =
      (wallet && (await tx.wallet_transactions.findFirst({ where: { reversal_of_id: wallet.id }, select: { id: true } }))) ||
      (await tx.company_financial_transactions.findFirst({ where: { reversal_of_id: { in: originalIds } }, select: { id: true } }));
    if (alreadyReversed) {
      throw correctionConflict("POSTING_ALREADY_REVERSED", "A posting of this release has already been reversed — resolve it manually");
    }

    const now = new Date();
    const claimed = await tx.orders.updateMany({
      where: { id: release.order_id, status: "DELIVERED", financial_release_mode: "ON_SETTLEMENT", financial_status: "FINALIZED" },
      data: { financial_status: "RELEASE_REVERSED", updated_at: now },
    });
    if (claimed.count !== 1) {
      throw correctionConflict("ORDER_STATE_CHANGED", "Order financial state was changed by another request — please retry");
    }

    let walletReversalId: string | null = null;
    if (wallet) {
      // Explicit wallet lock (step 6), then the balance check under it: a
      // wallet is never forced negative, and no receivable is created.
      const locked = await tx.$queryRaw<{ available_balance: Prisma.Decimal }[]>`
        SELECT available_balance FROM customer_wallets WHERE customer_id = ${release.customer_id}::uuid FOR NO KEY UPDATE
      `;
      if (locked.length === 0) {
        throw integrityFailure(`customer ${release.customer_id} has no wallet`);
      }
      if (new Prisma.Decimal(locked[0].available_balance).lessThan(wallet.amount)) {
        throw correctionConflict(
          "RELEASED_FUNDS_PAID_OUT",
          "The customer's available balance no longer covers the released credit (funds were paid out) — nothing was changed"
        );
      }
      const reversal = await applyWalletTransaction(tx, {
        customerId: release.customer_id,
        type: "REVERSAL",
        direction: "DEBIT",
        amount: wallet.amount,
        orderId: release.order_id,
        paymentMethodId: wallet.paymentMethodId ?? undefined,
        processedById: actorUserId,
        notes: reason,
        reversalOfId: wallet.id,
        idempotencyKey: `reversal:wallet:${wallet.id}`,
      });
      walletReversalId = reversal.transaction.id;
    }

    const reverseCompany = async (original: PostedOriginal | null): Promise<string | null> => {
      if (!original) return null;
      const reversal = await createSignedCompanyFinancialTransaction(tx, {
        type: "REVERSAL",
        amount: original.amount.negated(),
        orderId: release.order_id,
        paymentMethodId: original.paymentMethodId ?? undefined,
        createdById: actorUserId,
        notes: reason,
        reversalOfId: original.id,
        idempotencyKey: `reversal:company:${original.id}`,
      });
      return reversal.id;
    };
    const productReversalId = await reverseCompany(product);
    const feeReversalId = await reverseCompany(fee);

    const correction = await tx.order_financial_release_corrections.create({
      data: {
        release_id: release.id,
        correction_type: "RELEASE_REVERSAL",
        reason,
        wallet_reversal_transaction_id: walletReversalId,
        company_product_reversal_transaction_id: productReversalId,
        company_fee_reversal_transaction_id: feeReversalId,
        created_by_id: actorUserId,
        idempotency_key: `release-reversal:${release.id}`,
      },
    });

    // The release keeps its original posting references (history).
    const reversed = await tx.order_financial_releases.updateMany({
      where: { id: release.id, release_status: "RELEASED" },
      data: { release_status: "RELEASE_REVERSED", updated_at: now },
    });
    if (reversed.count !== 1) {
      throw correctionConflict("RELEASE_STATE_CHANGED", "Financial release was changed by another request — please retry");
    }

    await createAuditLog(tx, {
      actorUserId,
      action: "FINANCIAL_RELEASE_REVERSED",
      entityType: "ORDER",
      entityId: release.order_id,
      previousValues: { financialStatus: "FINALIZED", releaseStatus: "RELEASED" },
      newValues: { financialStatus: "RELEASE_REVERSED", releaseStatus: "RELEASE_REVERSED" },
      metadata: {
        releaseId: release.id,
        correctionId: correction.id,
        reason,
        orderType: release.order_type,
        customerId: release.customer_id,
        walletTransactionId: wallet?.id ?? null,
        walletReversalTransactionId: walletReversalId,
        companyProductTransactionId: product?.id ?? null,
        companyProductReversalTransactionId: productReversalId,
        companyFeeTransactionId: fee?.id ?? null,
        companyFeeReversalTransactionId: feeReversalId,
        customerWalletAmount: wallet?.amount.toString() ?? "0",
        companyProductAmount: product?.amount.toString() ?? "0",
        companyFeeAmount: fee?.amount.toString() ?? "0",
      },
    });
    return correction.id;
  });

  return loadCorrectionEntry(correctionId);
}
