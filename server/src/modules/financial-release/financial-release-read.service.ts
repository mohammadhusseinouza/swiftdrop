// ============================================================
// Settlement-Based Financial Release — read APIs (FR.7)
//
// Contract: docs/settlement-financial-release-contract.md §4.3, §7, §9.
// Strictly READ-ONLY: every query runs inside readSnapshot() (one REPEATABLE
// READ, READ ONLY transaction) so the figures returned together — cash
// balance, attributed outstanding, unattributed cash, the page of
// collections — come from the same instant. Nothing here locks, posts,
// releases or repairs.
//
//   GET /finance/driver-cash/:driverId/outstanding-collections   finance.read
//   GET /orders/:id/financial-release                             finance.read
// ============================================================

import { Prisma } from "../../generated/prisma/client";
import type { FinancialReleaseStatus } from "../../generated/prisma/client";
import { readSnapshot } from "../../db/read-snapshot";
import { AppError } from "../../shared/errors/app-error";
import { PENDING_RELEASE_HOLDS_CASH } from "./financial-release.service";
import type {
  CollectionSettlementState,
  DriverOutstandingCollections,
  OrderFinancialReleaseView,
  OutstandingCollectionEntry,
} from "./financial-release.types";

// Contract §4.3 — derived, never stored.
export function collectionSettlementState(collection: Prisma.Decimal, allocated: Prisma.Decimal): CollectionSettlementState {
  if (allocated.isZero()) return "UNSETTLED";
  return allocated.equals(collection) ? "FULLY_SETTLED" : "PARTIALLY_SETTLED";
}

// Only a PENDING release still owes an unsettled amount; a terminal
// release (RELEASED / VOIDED / RELEASE_REVERSED) owes nothing.
export function outstandingAmount(status: FinancialReleaseStatus, collection: Prisma.Decimal, allocated: Prisma.Decimal): Prisma.Decimal {
  return status === "PENDING" ? collection.minus(allocated) : new Prisma.Decimal(0);
}

function integrityFailure(detail: string): AppError {
  console.error(`[financial-release-read.service] data-integrity failure: ${detail}`);
  return new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Driver cash position is inconsistent" });
}

// ============================================================
// Outstanding collections of one driver
// ============================================================

type OutstandingRow = {
  release_id: string;
  order_id: string;
  order_number: string;
  customer_id: string;
  customer_number: string;
  customer_name: string;
  order_type: string;
  delivered_at: Date;
  collection_amount: Prisma.Decimal;
  allocated_amount: Prisma.Decimal;
  review_status: string;
  release_status: FinancialReleaseStatus;
  planned_customer_wallet_amount: Prisma.Decimal | null;
  planned_company_product_amount: Prisma.Decimal | null;
  planned_company_fee_amount: Prisma.Decimal | null;
};

export async function getDriverOutstandingCollections(
  driverId: string,
  query: { page: number; limit: number }
): Promise<DriverOutstandingCollections> {
  return readSnapshot(async (tx) => {
    const driver = await tx.drivers.findUnique({ where: { id: driverId }, select: { id: true } });
    if (!driver) {
      throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Driver not found" });
    }

    // Position: the same predicate lockDriverCashPosition uses, so this read
    // always agrees with what a settlement will validate against.
    const position = await tx.$queryRaw<
      { current_balance: Prisma.Decimal | null; attributed: Prisma.Decimal | null; outstanding_count: number }[]
    >`
      SELECT
        (SELECT current_balance FROM driver_cash_accounts WHERE driver_id = ${driverId}::uuid) AS current_balance,
        COALESCE(SUM(r.collection_amount - r.allocated_amount), 0) AS attributed,
        (COUNT(*) FILTER (WHERE r.allocated_amount < r.collection_amount))::int AS outstanding_count
      FROM order_financial_releases r
      WHERE r.driver_id = ${driverId}::uuid AND ${PENDING_RELEASE_HOLDS_CASH}
    `;
    const row = position[0];
    if (!row || row.current_balance === null) {
      throw integrityFailure(`driver ${driverId} has no linked driver_cash_accounts row`);
    }
    const cashBalance = new Prisma.Decimal(row.current_balance);
    const attributed = new Prisma.Decimal(row.attributed ?? 0);
    const unattributed = cashBalance.minus(attributed);
    if (unattributed.isNegative()) {
      throw integrityFailure(`driver ${driverId} cash ${cashBalance.toString()} is below its attributed outstanding ${attributed.toString()}`);
    }

    // Oldest first, id as the tie-breaker — stable across pages. Served by
    // the partial index ofr_outstanding_idx (driver_id, delivered_at, id).
    const rows = await tx.$queryRaw<OutstandingRow[]>`
      SELECT r.id AS release_id, o.id AS order_id, o.order_number, c.id AS customer_id, c.customer_number,
             c.name AS customer_name, r.order_type::text AS order_type, r.delivered_at, r.collection_amount,
             r.allocated_amount, r.review_status::text AS review_status, r.release_status,
             r.planned_customer_wallet_amount, r.planned_company_product_amount, r.planned_company_fee_amount
      FROM order_financial_releases r
      JOIN orders o ON o.id = r.order_id
      JOIN customers c ON c.id = r.customer_id
      WHERE r.driver_id = ${driverId}::uuid AND ${PENDING_RELEASE_HOLDS_CASH} AND r.allocated_amount < r.collection_amount
      ORDER BY r.delivered_at ASC, r.id ASC
      LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}
    `;

    const items: OutstandingCollectionEntry[] = rows.map((r) => {
      const collection = new Prisma.Decimal(r.collection_amount);
      const allocated = new Prisma.Decimal(r.allocated_amount);
      return {
        releaseId: r.release_id,
        order: { id: r.order_id, orderNumber: r.order_number },
        customer: { id: r.customer_id, customerNumber: r.customer_number, name: r.customer_name },
        orderType: r.order_type,
        deliveredAt: r.delivered_at.toISOString(),
        collectionAmount: collection.toString(),
        allocatedAmount: allocated.toString(),
        outstandingAmount: collection.minus(allocated).toString(),
        settlementState: collectionSettlementState(collection, allocated),
        reviewStatus: r.review_status,
        releaseStatus: r.release_status,
        plannedCustomerWalletAmount: r.planned_customer_wallet_amount?.toString() ?? null,
        plannedCompanyProductAmount: r.planned_company_product_amount?.toString() ?? null,
        plannedCompanyFeeAmount: r.planned_company_fee_amount?.toString() ?? null,
      };
    });

    return {
      driverId,
      cashBalance: cashBalance.toString(),
      attributedOutstanding: attributed.toString(),
      unattributedBalance: unattributed.toString(),
      outstandingCollectionCount: row.outstanding_count,
      items,
    };
  });
}

// ============================================================
// Financial release detail of one order
// ============================================================

const releaseInclude = {
  released_by: { select: { id: true, first_name: true, last_name: true } },
  released_by_settlement: { select: { id: true, settlement_number: true } },
  allocations: {
    select: {
      id: true,
      amount: true,
      created_at: true,
      reversed_by_correction_id: true,
      driver_settlements: { select: { id: true, settlement_number: true, created_at: true } },
    },
    orderBy: [{ created_at: "asc" }, { id: "asc" }],
  },
  correction: { include: { created_by: { select: { id: true, first_name: true, last_name: true } } } },
} satisfies Prisma.order_financial_releasesInclude;

export async function getOrderFinancialRelease(orderId: string): Promise<OrderFinancialReleaseView> {
  return readSnapshot(async (tx) => {
    const order = await tx.orders.findUnique({
      where: { id: orderId },
      select: { id: true, financial_release_mode: true, financial_status: true },
    });
    if (!order) {
      throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Order not found" });
    }
    const release = await tx.order_financial_releases.findUnique({ where: { order_id: orderId }, include: releaseInclude });
    const base = { orderId: order.id, financialReleaseMode: order.financial_release_mode, financialStatus: order.financial_status };
    if (!release) {
      // Legacy (NULL) and IMMEDIATE orders have no release (contract R9).
      return { ...base, release: null };
    }
    const reversal = await tx.driver_cash_transactions.findFirst({
      where: { reversal_of_id: release.collection_transaction_id },
      select: { id: true },
    });
    const outstanding = outstandingAmount(release.release_status, release.collection_amount, release.allocated_amount);
    const correction = release.correction;
    return {
      ...base,
      release: {
        id: release.id,
        releaseStatus: release.release_status,
        reviewStatus: release.review_status,
        orderType: release.order_type,
        deliveredAt: release.delivered_at.toISOString(),
        collectionAmount: release.collection_amount.toString(),
        allocatedAmount: release.allocated_amount.toString(),
        outstandingAmount: outstanding.toString(),
        settlementState: collectionSettlementState(release.collection_amount, release.allocated_amount),
        // NULL while a difference awaits review — no split is ever invented.
        plannedCustomerWalletAmount: release.planned_customer_wallet_amount?.toString() ?? null,
        plannedCompanyProductAmount: release.planned_company_product_amount?.toString() ?? null,
        plannedCompanyFeeAmount: release.planned_company_fee_amount?.toString() ?? null,
        postedTransactions: {
          walletTransactionId: release.wallet_transaction_id,
          companyProductTransactionId: release.company_product_transaction_id,
          companyFeeTransactionId: release.company_fee_transaction_id,
        },
        releasedAt: release.released_at?.toISOString() ?? null,
        releasedBy: release.released_by
          ? { id: release.released_by.id, firstName: release.released_by.first_name, lastName: release.released_by.last_name }
          : null,
        releaseTrigger: release.released_at === null ? null : release.released_by_settlement_id ? "SETTLEMENT" : "RESOLUTION",
        releasedBySettlement: release.released_by_settlement
          ? { id: release.released_by_settlement.id, settlementNumber: release.released_by_settlement.settlement_number }
          : null,
        // A pre-FR.6 generic reversal of this collection (never repaired).
        collectionReversed: reversal !== null,
        allocations: release.allocations.map((a) => ({
          id: a.id,
          settlement: {
            id: a.driver_settlements.id,
            settlementNumber: a.driver_settlements.settlement_number,
            createdAt: a.driver_settlements.created_at.toISOString(),
          },
          amount: a.amount.toString(),
          status: a.reversed_by_correction_id === null ? "ACTIVE" : "REVERSED",
          reversedByCorrectionId: a.reversed_by_correction_id,
          createdAt: a.created_at.toISOString(),
        })),
        correction: correction
          ? {
              id: correction.id,
              correctionType: correction.correction_type,
              reason: correction.reason,
              driverCashReversalTransactionId: correction.driver_cash_reversal_transaction_id,
              walletReversalTransactionId: correction.wallet_reversal_transaction_id,
              companyProductReversalTransactionId: correction.company_product_reversal_transaction_id,
              companyFeeReversalTransactionId: correction.company_fee_reversal_transaction_id,
              createdBy: { id: correction.created_by.id, firstName: correction.created_by.first_name, lastName: correction.created_by.last_name },
              createdAt: correction.created_at.toISOString(),
            }
          : null,
      },
    };
  });
}
