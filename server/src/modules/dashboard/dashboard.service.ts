import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { getUtcDayBoundary } from "../../shared/date/day-boundary";
import { buildWorkflowQueueWhere, WORKFLOW_QUEUE_VALUES } from "../orders/order-workflow-queue";
import type {
  DashboardActivityItem,
  DashboardAttention,
  DashboardAttentionItem,
  DashboardAttentionItemType,
  DashboardDriverMetrics,
  DashboardFinanceMetrics,
  DashboardOrderMetrics,
  DashboardParcelCollectionMetrics,
  DashboardSummary,
} from "./dashboard.types";

// ============================================================
// Management Dashboard (Phase 9.1)
//
// GET /api/v1/dashboard is read-only and system-wide (no query params —
// see CLAUDE.md/implementation-plan: a single unfiltered V1 snapshot; date-
// range filtering is Phase 9.2's Finance Summary, not this endpoint). Every
// query below is a plain SELECT/aggregate — this module must never write.
//
// Money is the same NUMERIC(14,2)/Prisma.Decimal convention as every other
// financial module (CLAUDE.md §15) and is serialized via `.toString()`
// exactly like every other financial DTO in this codebase (payout.service.
// ts, wallet-ledger.service.ts, etc.) — decimal.js's toString() drops
// trailing zeros (e.g. "105", not "105.00"), which is the established
// project convention, not a bug.
// ============================================================

// "Today" convention (Phase 9.1): the current UTC calendar day,
// [00:00:00.000Z, next 00:00:00.000Z). getUtcDayBoundary now lives in
// src/shared/date/day-boundary.ts (Phase 9.2 extracted it there so
// finance-summary.service.ts's from/to range parsing shares the exact same
// UTC-midnight arithmetic instead of a second copy).

const UNASSIGNED_STATUSES = ["RECEIVED", "READY_FOR_PICKUP"] as const;
const ACTIVE_ASSIGNED_STATUSES = ["ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY", "RESCHEDULED"] as const;
const RETURNED_STATUSES = ["RETURNED_TO_COMPANY", "RETURNED_TO_CUSTOMER"] as const;

function decimalToString(value: Prisma.Decimal | null | undefined): string {
  return (value ?? new Prisma.Decimal(0)).toString();
}

// ============================================================
// ORDER METRICS
// ============================================================

async function getOrderMetrics(dayBoundary: { start: Date; end: Date }): Promise<DashboardOrderMetrics & { deliveredTodayCount: number }> {
  const { start, end } = dayBoundary;

  const [
    ordersToday,
    readyForPickup,
    // "unassigned" also asserts current_driver_id: null as a harmless,
    // self-documenting invariant check — RECEIVED/READY_FOR_PICKUP orders
    // are always unassigned by construction (see order.service.ts's assign
    // claim), this never narrows the real result.
    unassigned,
    assigned,
    outForDelivery,
    deliveredTodayCount,
    // Distinct Orders with a FAILED_DELIVERY transition today — not FAILED
    // delivery_attempts, so one Order failing twice in one day still counts
    // once (Phase 9.1 contract: "Failed Today" is an Order-level card).
    failedTodayRows,
    returned,
    cancelled,
  ] = await Promise.all([
    prisma.orders.count({ where: { created_at: { gte: start, lt: end } } }),
    prisma.orders.count({ where: { status: "READY_FOR_PICKUP" } }),
    prisma.orders.count({ where: { status: { in: [...UNASSIGNED_STATUSES] }, current_driver_id: null } }),
    prisma.orders.count({ where: { status: "ASSIGNED" } }),
    prisma.orders.count({ where: { status: "OUT_FOR_DELIVERY" } }),
    prisma.orders.count({ where: { delivered_at: { gte: start, lt: end } } }),
    prisma.order_status_history.findMany({
      where: { to_status: "FAILED_DELIVERY", created_at: { gte: start, lt: end } },
      distinct: ["order_id"],
      select: { order_id: true },
    }),
    prisma.orders.count({ where: { status: { in: [...RETURNED_STATUSES] } } }),
    prisma.orders.count({ where: { status: "CANCELLED" } }),
  ]);

  return {
    ordersToday,
    readyForPickup,
    unassigned,
    assigned,
    outForDelivery,
    deliveredToday: deliveredTodayCount,
    failedToday: failedTodayRows.length,
    returned,
    cancelled,
    deliveredTodayCount,
  };
}

// ============================================================
// PARCEL COLLECTION METRICS (Phase 11.17.6 — requirements.md §37)
//
// Every count reuses order-workflow-queue.ts's buildWorkflowQueueWhere — the
// SAME predicate the Orders List `workflowQueue` filter uses — so the
// Dashboard and the Orders List quick tabs can never disagree for the same
// data state (task §80). Never gated by finance.read: Parcel Collection is
// financially neutral.
// ============================================================

async function getParcelCollectionMetrics(): Promise<DashboardParcelCollectionMetrics> {
  const [awaitingCollectionAssignment, collectionInProgress, collectionAttention, awaitingCompanyReceipt, readyForDeliveryAssignment] =
    await Promise.all(
      WORKFLOW_QUEUE_VALUES.map((queue) => prisma.orders.count({ where: buildWorkflowQueueWhere(queue) }))
    );

  return {
    awaitingCollectionAssignment,
    collectionInProgress,
    collectionAttention,
    awaitingCompanyReceipt,
    readyForDeliveryAssignment,
  };
}

// ============================================================
// DRIVER METRICS
// ============================================================

async function getDriverMetrics(deliveredTodayCount: number, hasFinanceRead: boolean): Promise<DashboardDriverMetrics> {
  const { start, end } = getUtcDayBoundary();

  const [activeDrivers, currentlyDeliveringRows, ordersAssigned, activeCollectionJobs, collectionsCompletedToday] = await Promise.all([
    prisma.drivers.count({ where: { is_active: true } }),
    // DISTINCT current Driver IDs — one Driver with several OUT_FOR_DELIVERY
    // Orders counts once (Phase 9.1 contract), never Order count.
    prisma.orders.findMany({
      where: { status: "OUT_FOR_DELIVERY", current_driver_id: { not: null } },
      distinct: ["current_driver_id"],
      select: { current_driver_id: true },
    }),
    // Active current-Driver assignments only — RESCHEDULED keeps its
    // current_driver_id (order.service.ts's rescheduleOrder preserves
    // assignment untouched), so it legitimately belongs here; DELIVERED/
    // CANCELLED/RETURNED/FAILED_DELIVERY historical assignments do not.
    prisma.orders.count({ where: { status: { in: [...ACTIVE_ASSIGNED_STATUSES] }, current_driver_id: { not: null } } }),
    // "Active collection jobs" (requirements.md §37 Driver Statistics) —
    // identical population to the COLLECTION_IN_PROGRESS queue.
    prisma.orders.count({ where: buildWorkflowQueueWhere("COLLECTION_IN_PROGRESS") }),
    // "Collections completed today" — company receipt confirmed today.
    // received_at_company_at is set for BOTH intake methods (ALREADY_AT_COMPANY
    // at creation), so this is scoped to DRIVER_COLLECTION only — an
    // ALREADY_AT_COMPANY order never represents completed Driver collection
    // work.
    prisma.orders.count({
      where: {
        parcel_intake_method: "DRIVER_COLLECTION",
        received_at_company_at: { gte: start, lt: end },
      },
    }),
  ]);

  let driversWithUnsettledCash: number | null = null;
  let totalDriverCashHeld: string | null = null;
  if (hasFinanceRead) {
    const [unsettledCount, cashSum] = await Promise.all([
      prisma.driver_cash_accounts.count({ where: { current_balance: { gt: 0 } } }),
      prisma.driver_cash_accounts.aggregate({ _sum: { current_balance: true } }),
    ]);
    driversWithUnsettledCash = unsettledCount;
    totalDriverCashHeld = decimalToString(cashSum._sum.current_balance);
  }

  return {
    activeDrivers,
    driversCurrentlyDelivering: currentlyDeliveringRows.length,
    ordersAssigned,
    deliveriesCompletedToday: deliveredTodayCount,
    driversWithUnsettledCash,
    totalDriverCashHeld,
    activeCollectionJobs,
    collectionsCompletedToday,
  };
}

// ============================================================
// FINANCE METRICS — reversal-aware net category totals (Phase 9.1)
//
// company_financial_transactions.amount is SIGNED (a REVERSAL row's amount
// is the negated original — see company-correction.service.ts), so a plain
// SUM already nets correctly once REVERSAL rows belonging to the category
// are included via reversal_of_id. driver_cash_transactions.amount is
// always a POSITIVE MAGNITUDE (direction is balance movement, never sign —
// driver-cash-ledger.service.ts), so a COLLECTION reversal must be
// SUBTRACTED explicitly. Generic ADJUSTMENT rows are deliberately excluded
// from every category here: they have no approved revenue/collection
// attribution (CLAUDE.md §62/§27) and are surfaced only via the /finance
// correction endpoints, never folded into these totals.
// ============================================================

interface NetSumRow {
  total: string | null;
}

async function getNetCompanyRevenue(type: "DELIVERY_FEE_REVENUE" | "COMPANY_ORDER_PRODUCT_REVENUE"): Promise<Prisma.Decimal> {
  const rows = await prisma.$queryRaw<NetSumRow[]>`
    SELECT COALESCE(SUM(amount), 0)::text AS total
    FROM company_financial_transactions
    WHERE type = ${type}::"CompanyFinancialTransactionType"
       OR reversal_of_id IN (
         SELECT id FROM company_financial_transactions WHERE type = ${type}::"CompanyFinancialTransactionType"
       )
  `;
  return new Prisma.Decimal(rows[0]?.total ?? "0");
}

async function getNetDriverCollected(): Promise<Prisma.Decimal> {
  const rows = await prisma.$queryRaw<NetSumRow[]>`
    SELECT (
      COALESCE(SUM(CASE WHEN type = 'COLLECTION' THEN amount ELSE 0 END), 0)
      - COALESCE(
          SUM(
            CASE
              WHEN type = 'REVERSAL'
                AND reversal_of_id IN (SELECT id FROM driver_cash_transactions WHERE type = 'COLLECTION')
              THEN amount
              ELSE 0
            END
          ),
          0
        )
    )::text AS total
    FROM driver_cash_transactions
  `;
  return new Prisma.Decimal(rows[0]?.total ?? "0");
}

async function getFinanceMetrics(): Promise<DashboardFinanceMetrics> {
  const [deliveryFeeRevenue, companyOrderRevenue, totalCollected, walletSum, payoutSum, driverCashSum] = await Promise.all([
    getNetCompanyRevenue("DELIVERY_FEE_REVENUE"),
    getNetCompanyRevenue("COMPANY_ORDER_PRODUCT_REVENUE"),
    getNetDriverCollected(),
    prisma.customer_wallets.aggregate({ _sum: { available_balance: true } }),
    prisma.customer_payouts.aggregate({ _sum: { amount: true }, where: { status: "COMPLETED" } }),
    prisma.driver_cash_accounts.aggregate({ _sum: { current_balance: true } }),
  ]);

  return {
    deliveryFeeRevenue: deliveryFeeRevenue.toString(),
    companyOrderRevenue: companyOrderRevenue.toString(),
    totalCollected: totalCollected.toString(),
    customerWalletLiability: decimalToString(walletSum._sum.available_balance),
    customerPayouts: decimalToString(payoutSum._sum.amount),
    driverCashOutstanding: decimalToString(driverCashSum._sum.current_balance),
  };
}

// ============================================================
// ATTENTION QUEUE
// ============================================================

const ATTENTION_ITEM_LIMIT = 10;
const ATTENTION_CATEGORY_QUERY_LIMIT = ATTENTION_ITEM_LIMIT;

const attentionOrderSelect = {
  id: true,
  order_number: true,
  status: true,
  order_type: true,
  created_at: true,
  delivered_at: true,
  updated_at: true,
  customers: { select: { id: true, customer_number: true, name: true } },
  drivers: { select: { id: true, driver_number: true, users: { select: { first_name: true, last_name: true } } } },
} satisfies Prisma.ordersSelect;

type AttentionOrderRow = Prisma.ordersGetPayload<{ select: typeof attentionOrderSelect }>;

function toAttentionItem(row: AttentionOrderRow, type: DashboardAttentionItemType, occurredAt: Date): DashboardAttentionItem {
  return {
    type,
    order: { id: row.id, orderNumber: row.order_number, status: row.status, orderType: row.order_type },
    customer: { id: row.customers.id, customerNumber: row.customers.customer_number, name: row.customers.name },
    driver: row.drivers
      ? {
          id: row.drivers.id,
          driverNumber: row.drivers.driver_number,
          name: `${row.drivers.users.first_name} ${row.drivers.users.last_name}`,
        }
      : null,
    occurredAt: occurredAt.toISOString(),
  };
}

async function getAttention(): Promise<DashboardAttention> {
  // needs_financial_review/financial_status are written together in the
  // same transaction everywhere they're set (driver-order.service.ts,
  // order.service.ts's resolveCollectionDifference) — both conditions are
  // ANDed here as an integrity expectation, not merely a filter. A row
  // where they disagree is flagged (logged), never silently included or
  // silently "repaired" by this read-only endpoint (CLAUDE.md §62/§68).
  const collectionAttentionWhere = buildWorkflowQueueWhere("COLLECTION_ATTENTION");
  // Phase 11.17.6 correction — replaces the old UNASSIGNED_STATUSES-based
  // query (`status IN (RECEIVED, READY_FOR_PICKUP) AND current_driver_id IS
  // NULL`), which silently included orders whose Parcel Collection was
  // still in progress (AWAITING_ASSIGNMENT/ASSIGNED/FAILED/RESCHEDULED/
  // COLLECTED_FROM_SENDER) as a false Delivery-assignment problem. Reuses
  // the exact same shared predicate as the Orders List `workflowQueue`
  // filter and the `parcelCollection.readyForDeliveryAssignment` metric —
  // never a second, independently-drifting definition.
  const readyForDeliveryWhere = buildWorkflowQueueWhere("READY_FOR_DELIVERY_ASSIGNMENT");

  const [
    financialReviewRows,
    failedRows,
    readyForDeliveryRows,
    returnedRows,
    collectionAttentionRows,
    readyForDeliveryCount,
    failedCount,
    collectionDifferenceCount,
    returnedCount,
    collectionAttentionCount,
    inconsistentReviewCount,
  ] = await Promise.all([
    prisma.orders.findMany({
      where: { needs_financial_review: true, financial_status: "REVIEW_REQUIRED" },
      select: attentionOrderSelect,
      orderBy: [{ delivered_at: "asc" }, { id: "asc" }],
      take: ATTENTION_CATEGORY_QUERY_LIMIT,
    }),
    prisma.orders.findMany({
      where: { status: "FAILED_DELIVERY" },
      select: attentionOrderSelect,
      orderBy: [{ updated_at: "asc" }, { id: "asc" }],
      take: ATTENTION_CATEGORY_QUERY_LIMIT,
    }),
    prisma.orders.findMany({
      where: readyForDeliveryWhere,
      select: attentionOrderSelect,
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
      take: ATTENTION_CATEGORY_QUERY_LIMIT,
    }),
    prisma.orders.findMany({
      where: { status: { in: [...RETURNED_STATUSES] } },
      select: attentionOrderSelect,
      orderBy: [{ updated_at: "asc" }, { id: "asc" }],
      take: ATTENTION_CATEGORY_QUERY_LIMIT,
    }),
    // Phase 11.17.6 — a FAILED Parcel Collection needs a Management decision
    // (reassign / reschedule). Same shared queue predicate as the Orders
    // List / Dashboard operational count — never a second definition.
    prisma.orders.findMany({
      where: collectionAttentionWhere,
      select: attentionOrderSelect,
      orderBy: [{ updated_at: "asc" }, { id: "asc" }],
      take: ATTENTION_CATEGORY_QUERY_LIMIT,
    }),
    prisma.orders.count({ where: readyForDeliveryWhere }),
    prisma.orders.count({ where: { status: "FAILED_DELIVERY" } }),
    prisma.orders.count({ where: { needs_financial_review: true, financial_status: "REVIEW_REQUIRED" } }),
    prisma.orders.count({ where: { status: { in: [...RETURNED_STATUSES] } } }),
    prisma.orders.count({ where: collectionAttentionWhere }),
    prisma.orders.count({
      where: {
        OR: [
          { needs_financial_review: true, financial_status: { not: "REVIEW_REQUIRED" } },
          { needs_financial_review: false, financial_status: "REVIEW_REQUIRED" },
        ],
      },
    }),
  ]);

  if (inconsistentReviewCount > 0) {
    console.error(
      `[dashboard.service] data-integrity warning: ${inconsistentReviewCount} Order(s) have needs_financial_review/financial_status disagreeing — dashboard counts exclude them rather than guessing`
    );
  }

  // Deterministic priority: FINANCIAL_REVIEW > FAILED_DELIVERY >
  // COLLECTION_ATTENTION > READY_FOR_DELIVERY_ASSIGNMENT > RETURNED (Phase
  // 9.1 contract, extended Phase 11.17.6 — a failed collection sits
  // alongside a failed delivery as an operational failure, ahead of the
  // plain "needs assignment" categories); oldest-first within each category
  // (longest-waiting is most urgent), bounded to ATTENTION_ITEM_LIMIT total.
  const items: DashboardAttentionItem[] = [
    ...financialReviewRows.map((row) => toAttentionItem(row, "FINANCIAL_REVIEW", row.delivered_at ?? row.created_at)),
    ...failedRows.map((row) => toAttentionItem(row, "FAILED_DELIVERY", row.updated_at)),
    ...collectionAttentionRows.map((row) => toAttentionItem(row, "COLLECTION_ATTENTION", row.updated_at)),
    ...readyForDeliveryRows.map((row) => toAttentionItem(row, "READY_FOR_DELIVERY_ASSIGNMENT", row.created_at)),
    ...returnedRows.map((row) => toAttentionItem(row, "RETURNED", row.updated_at)),
  ].slice(0, ATTENTION_ITEM_LIMIT);

  return {
    counts: {
      readyForDeliveryAssignment: readyForDeliveryCount,
      failedDeliveries: failedCount,
      collectionDifferences: collectionDifferenceCount,
      returned: returnedCount,
      collectionAttention: collectionAttentionCount,
    },
    items,
  };
}

// ============================================================
// RECENT ACTIVITY
// ============================================================

const ACTIVITY_LIMIT = 10;

// The COMPLETE, actual set of audit actions this repository ever produces
// (verified by inspecting every createAuditLog call site — Phase 6/7 order
// workflow actions do not write audit_logs today; order_status_history is
// that layer's own trail). Order-entity finance-finalization/review events
// are treated as OPERATIONAL (visible to any dashboard.read caller,
// Dispatcher included) rather than finance-gated: the curated DTO below
// never includes a dollar amount, so exposing "this Order had a
// delivery/review event" leaks nothing Dispatcher can't already see via
// orders.read, and the Phase 9.1 spec's own activity-content list places
// "Order delivered"/"Collection difference recorded/resolved" in the
// general bucket, not the "for authorized actors" bucket.
const OPERATIONAL_ACTIONS = [
  "DELIVERY_ONLY_FINANCE_FINALIZED",
  "COMPANY_ORDER_FINANCE_FINALIZED",
  "COLLECTION_DIFFERENCE_RECORDED",
  "COLLECTION_DIFFERENCE_RESOLVED",
] as const;

function buildAllowedActions(permissions: string[]): string[] {
  const allowed: string[] = [...OPERATIONAL_ACTIONS];
  if (permissions.includes("payouts.read")) {
    allowed.push("CUSTOMER_PAYOUT_COMPLETED", "CUSTOMER_PAYOUT_REVERSED");
  }
  if (permissions.includes("settlements.read")) {
    allowed.push("DRIVER_SETTLEMENT_COMPLETED", "DRIVER_SETTLEMENT_REVERSED");
  }
  if (permissions.includes("wallets.read")) {
    allowed.push("WALLET_ADJUSTMENT_CREATED", "WALLET_TRANSACTION_REVERSED");
  }
  if (permissions.includes("finance.read")) {
    allowed.push(
      "DRIVER_CASH_ADJUSTMENT_CREATED",
      "DRIVER_CASH_TRANSACTION_REVERSED",
      "COMPANY_FINANCIAL_ADJUSTMENT_CREATED",
      "COMPANY_FINANCIAL_TRANSACTION_REVERSED"
    );
  }
  return allowed;
}

async function getRecentActivity(permissions: string[]): Promise<DashboardActivityItem[]> {
  const allowedActions = buildAllowedActions(permissions);

  const rows = await prisma.audit_logs.findMany({
    where: { action: { in: allowedActions } },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    take: ACTIVITY_LIMIT,
    select: {
      id: true,
      action: true,
      entity_type: true,
      entity_id: true,
      created_at: true,
      users: { select: { id: true, first_name: true, last_name: true } },
    },
  });

  // Context resolution is intentionally shallow and batched: only the
  // entity types with a natural human-readable number get one, everything
  // else gets a null context rather than a deep multi-hop join — recent
  // activity is a curated summary, not a raw audit-log replacement (Phase
  // 9.4 owns that). Batched (max 3 extra queries regardless of row count),
  // never N+1.
  const orderIds = rows.filter((r) => r.entity_type === "ORDER").map((r) => r.entity_id);
  const payoutIds = rows.filter((r) => r.entity_type === "CUSTOMER_PAYOUT").map((r) => r.entity_id);
  const settlementIds = rows.filter((r) => r.entity_type === "DRIVER_SETTLEMENT").map((r) => r.entity_id);

  const [orderRows, payoutRows, settlementRows] = await Promise.all([
    orderIds.length
      ? prisma.orders.findMany({ where: { id: { in: orderIds } }, select: { id: true, order_number: true } })
      : Promise.resolve([]),
    payoutIds.length
      ? prisma.customer_payouts.findMany({ where: { id: { in: payoutIds } }, select: { id: true, payout_number: true } })
      : Promise.resolve([]),
    settlementIds.length
      ? prisma.driver_settlements.findMany({ where: { id: { in: settlementIds } }, select: { id: true, settlement_number: true } })
      : Promise.resolve([]),
  ]);

  const orderNumberById = new Map(orderRows.map((o) => [o.id, o.order_number]));
  const payoutNumberById = new Map(payoutRows.map((p) => [p.id, p.payout_number]));
  const settlementNumberById = new Map(settlementRows.map((s) => [s.id, s.settlement_number]));

  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actor: row.users ? { id: row.users.id, firstName: row.users.first_name, lastName: row.users.last_name } : null,
    occurredAt: row.created_at.toISOString(),
    context: {
      orderNumber: orderNumberById.get(row.entity_id) ?? null,
      payoutNumber: payoutNumberById.get(row.entity_id) ?? null,
      settlementNumber: settlementNumberById.get(row.entity_id) ?? null,
    },
  }));
}

// ============================================================
// GET /api/v1/dashboard
// ============================================================

export async function getDashboardSummary(permissions: string[]): Promise<DashboardSummary> {
  const hasFinanceRead = permissions.includes("finance.read");
  const dayBoundary = getUtcDayBoundary();

  const [orderMetrics, attention, recentActivity, parcelCollection] = await Promise.all([
    getOrderMetrics(dayBoundary),
    getAttention(),
    getRecentActivity(permissions),
    getParcelCollectionMetrics(),
  ]);

  const { deliveredTodayCount, ...orders } = orderMetrics;
  const [drivers, finance] = await Promise.all([
    getDriverMetrics(deliveredTodayCount, hasFinanceRead),
    hasFinanceRead ? getFinanceMetrics() : Promise.resolve(null),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    orders,
    drivers,
    finance,
    attention,
    recentActivity,
    parcelCollection,
  };
}
