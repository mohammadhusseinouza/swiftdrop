// ============================================================
// Settlement-Based Financial Release — reporting (FR.8)
//
// Contract: docs/settlement-financial-release-contract.md §9, §12.
// Strictly read-only; callers run these inside readSnapshot().
//
// Two reporting bases, never mixed in one figure:
//
//   RELEASED (default) — every ledger row counts on its OWN created_at. For
//     an ON_SETTLEMENT order that is the release time; legacy / IMMEDIATE
//     rows keep their delivery-time posting date. This is what the existing
//     finance-summary / report flows already compute — nothing changes there.
//
//   DELIVERY DATE — amounts attributed to the order's delivered_at:
//       posted original category rows of orders delivered in range
//     + REVERSAL rows of those originals (attributed to the ORIGINAL order's
//       delivery date, whatever the reversal's own date)
//     + planned amounts of PENDING releases delivered in range whose review
//       is cleared (approved split only)
//     Unresolved differences contribute NO amount — only the under-review
//     collected cash, reported separately. A release posts its rows and
//     leaves PENDING in one transaction, so no component is counted twice.
//
// Category rows without an order (legacy / historical anomalies) cannot be
// attributed to a delivery date; on the delivery-date basis they are
// reported separately (by their own posting date), never dropped silently
// and never attached to an order. They remain in the released-basis totals.
// ============================================================

import { Prisma } from "../../generated/prisma/client";
import { PENDING_RELEASE_HOLDS_CASH } from "./financial-release.service";

export interface DateRange {
  start?: Date;
  endExclusive?: Date;
}

export type PeriodBucket = "day" | "week" | "month";

const dec = (v: Prisma.Decimal | string | number | null | undefined) => new Prisma.Decimal(v ?? 0);

function rangeSql(column: Prisma.Sql, range: DateRange): Prisma.Sql {
  const clauses: Prisma.Sql[] = [];
  if (range.start) clauses.push(Prisma.sql`${column} >= ${range.start}`);
  if (range.endExclusive) clauses.push(Prisma.sql`${column} < ${range.endExclusive}`);
  return clauses.length ? Prisma.join(clauses, " AND ") : Prisma.sql`TRUE`;
}

// `bucket` is a validated enum value bound as a parameter to date_trunc();
// AT TIME ZONE 'UTC' first (project UTC business-day convention).
function periodSql(column: Prisma.Sql, bucket: PeriodBucket | null): Prisma.Sql {
  if (bucket === null) return Prisma.sql`'ALL'`;
  return Prisma.sql`to_char(date_trunc(${bucket}, ${column} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
}

// ============================================================
// Current settlement-release position (snapshot, ignores any date range)
// ============================================================

export interface SettlementReleaseSnapshot {
  customerFundsAwaitingSettlement: string;
  companyDeliveryFeesAwaitingSettlement: string;
  companyProductRevenueAwaitingSettlement: string;
  awaitingSettlementOrderCount: number;
  driverCashHeld: string;
  attributedDriverCash: string;
  unattributedDriverCash: string;
  underReview: {
    // Every order awaiting collection-difference review (any release mode).
    orderCount: number;
    collectionAmount: string;
    // Of which settlement-mode (their cash is reserved in driver cash).
    settlementModeOrderCount: number;
    settlementModeCollectionAmount: string;
  };
}

export async function getSettlementReleaseSnapshot(db: Prisma.TransactionClient): Promise<SettlementReleaseSnapshot> {
  const [releases, cash, review] = await Promise.all([
    db.$queryRaw<
      {
        customer_funds: Prisma.Decimal | null;
        fees: Prisma.Decimal | null;
        product: Prisma.Decimal | null;
        awaiting_count: number;
        review_count: number;
        review_amount: Prisma.Decimal | null;
        attributed: Prisma.Decimal | null;
      }[]
    >`
      SELECT
        SUM(r.planned_customer_wallet_amount) FILTER (WHERE r.review_status <> 'AWAITING_REVIEW' AND r.order_type = 'DELIVERY_ONLY') AS customer_funds,
        SUM(r.planned_company_fee_amount) FILTER (WHERE r.review_status <> 'AWAITING_REVIEW') AS fees,
        SUM(r.planned_company_product_amount) FILTER (WHERE r.review_status <> 'AWAITING_REVIEW' AND r.order_type = 'COMPANY_ORDER') AS product,
        (COUNT(*) FILTER (WHERE r.review_status <> 'AWAITING_REVIEW'))::int AS awaiting_count,
        (COUNT(*) FILTER (WHERE r.review_status = 'AWAITING_REVIEW'))::int AS review_count,
        SUM(r.collection_amount) FILTER (WHERE r.review_status = 'AWAITING_REVIEW') AS review_amount,
        SUM(r.collection_amount - r.allocated_amount) AS attributed
      FROM order_financial_releases r
      WHERE ${PENDING_RELEASE_HOLDS_CASH}
    `,
    db.driver_cash_accounts.aggregate({ _sum: { current_balance: true } }),
    db.orders.aggregate({
      where: { needs_financial_review: true, financial_status: "REVIEW_REQUIRED" },
      _count: true,
      _sum: { actual_amount_collected: true },
    }),
  ]);
  const r = releases[0];
  const held = dec(cash._sum.current_balance);
  const attributed = dec(r?.attributed);
  return {
    customerFundsAwaitingSettlement: dec(r?.customer_funds).toString(),
    companyDeliveryFeesAwaitingSettlement: dec(r?.fees).toString(),
    companyProductRevenueAwaitingSettlement: dec(r?.product).toString(),
    awaitingSettlementOrderCount: r?.awaiting_count ?? 0,
    driverCashHeld: held.toString(),
    attributedDriverCash: attributed.toString(),
    unattributedDriverCash: held.minus(attributed).toString(),
    underReview: {
      orderCount: review._count,
      collectionAmount: dec(review._sum.actual_amount_collected).toString(),
      settlementModeOrderCount: r?.review_count ?? 0,
      settlementModeCollectionAmount: dec(r?.review_amount).toString(),
    },
  };
}

// ============================================================
// Release activity in a period (by released_at / correction created_at)
// ============================================================

export interface ReleaseActivity {
  // Releases performed in the period (including ones reversed later — they
  // were released then; their reversal counts in its own period).
  releasesCompleted: number;
  releasedCustomerWalletCredits: string;
  releasedDeliveryFeeRevenue: string;
  releasedCompanyProductRevenue: string;
  releasedCollectionAmount: string;
  releaseReversals: number;
  collectionVoids: number;
}

export async function getReleaseActivity(db: Prisma.TransactionClient, range: DateRange): Promise<ReleaseActivity> {
  const [released, corrections] = await Promise.all([
    db.$queryRaw<{ n: number; wallet: Prisma.Decimal | null; fee: Prisma.Decimal | null; product: Prisma.Decimal | null; collection: Prisma.Decimal | null }[]>`
      SELECT COUNT(*)::int AS n,
             SUM(r.planned_customer_wallet_amount) AS wallet,
             SUM(r.planned_company_fee_amount) AS fee,
             SUM(r.planned_company_product_amount) AS product,
             SUM(r.collection_amount) AS collection
      FROM order_financial_releases r
      WHERE r.released_at IS NOT NULL AND ${rangeSql(Prisma.sql`r.released_at`, range)}
    `,
    db.$queryRaw<{ reversals: number; voids: number }[]>`
      SELECT (COUNT(*) FILTER (WHERE c.correction_type = 'RELEASE_REVERSAL'))::int AS reversals,
             (COUNT(*) FILTER (WHERE c.correction_type = 'COLLECTION_VOID'))::int AS voids
      FROM order_financial_release_corrections c
      WHERE ${rangeSql(Prisma.sql`c.created_at`, range)}
    `,
  ]);
  const r = released[0];
  return {
    releasesCompleted: r?.n ?? 0,
    releasedCustomerWalletCredits: dec(r?.wallet).toString(),
    releasedDeliveryFeeRevenue: dec(r?.fee).toString(),
    releasedCompanyProductRevenue: dec(r?.product).toString(),
    releasedCollectionAmount: dec(r?.collection).toString(),
    releaseReversals: corrections[0]?.reversals ?? 0,
    collectionVoids: corrections[0]?.voids ?? 0,
  };
}

// ============================================================
// Delivery-date basis
// ============================================================

export interface DeliveryDateFigures {
  period: string;
  // posted (net of reversals) + pending approved = total, per category.
  deliveryFeeRevenue: string;
  postedDeliveryFeeRevenue: string;
  pendingDeliveryFeeRevenue: string;
  companyOrderRevenue: string;
  postedCompanyOrderRevenue: string;
  pendingCompanyOrderRevenue: string;
  customerWalletCredits: string;
  postedCustomerWalletCredits: string;
  pendingCustomerWalletCredits: string;
  // Confirmed nowhere: cash collected on differences still under review.
  underReviewOrderCount: number;
  underReviewCollectionAmount: string;
}

type DeliveryDateRow = {
  period: string;
  posted_fee: Prisma.Decimal | null;
  posted_product: Prisma.Decimal | null;
  posted_wallet: Prisma.Decimal | null;
  pending_fee: Prisma.Decimal | null;
  pending_product: Prisma.Decimal | null;
  pending_wallet: Prisma.Decimal | null;
  review_count: number | null;
  review_amount: Prisma.Decimal | null;
};

// One statement for any grouping (bucket null = one 'ALL' row).
export async function getDeliveryDateFigures(
  db: Prisma.TransactionClient,
  range: DateRange,
  bucket: PeriodBucket | null
): Promise<DeliveryDateFigures[]> {
  const oDelivered = Prisma.sql`o.delivered_at`;
  const rDelivered = Prisma.sql`r.delivered_at`;
  const rows = await db.$queryRaw<DeliveryDateRow[]>`
    WITH company AS (
      SELECT ${periodSql(oDelivered, bucket)} AS period,
             SUM(c.amount) FILTER (WHERE orig.type = 'DELIVERY_FEE_REVENUE') AS fee,
             SUM(c.amount) FILTER (WHERE orig.type = 'COMPANY_ORDER_PRODUCT_REVENUE') AS product
      FROM company_financial_transactions c
      JOIN company_financial_transactions orig ON orig.id = COALESCE(c.reversal_of_id, c.id)
      JOIN orders o ON o.id = orig.order_id
      WHERE orig.type IN ('DELIVERY_FEE_REVENUE', 'COMPANY_ORDER_PRODUCT_REVENUE')
        AND (c.reversal_of_id IS NULL OR c.type = 'REVERSAL')
        AND o.delivered_at IS NOT NULL AND ${rangeSql(oDelivered, range)}
      GROUP BY 1
    ),
    wallet AS (
      SELECT ${periodSql(oDelivered, bucket)} AS period, SUM(w.credit - w.debit) AS wallet
      FROM wallet_transactions w
      JOIN wallet_transactions orig ON orig.id = COALESCE(w.reversal_of_id, w.id)
      JOIN orders o ON o.id = orig.order_id
      WHERE orig.type = 'ORDER_CREDIT'
        AND (w.reversal_of_id IS NULL OR w.type = 'REVERSAL')
        AND o.delivered_at IS NOT NULL AND ${rangeSql(oDelivered, range)}
      GROUP BY 1
    ),
    pending AS (
      SELECT ${periodSql(rDelivered, bucket)} AS period,
             SUM(r.planned_company_fee_amount) AS fee,
             SUM(r.planned_company_product_amount) FILTER (WHERE r.order_type = 'COMPANY_ORDER') AS product,
             SUM(r.planned_customer_wallet_amount) FILTER (WHERE r.order_type = 'DELIVERY_ONLY') AS wallet
      FROM order_financial_releases r
      WHERE ${PENDING_RELEASE_HOLDS_CASH} AND r.review_status <> 'AWAITING_REVIEW' AND ${rangeSql(rDelivered, range)}
      GROUP BY 1
    ),
    review AS (
      SELECT ${periodSql(oDelivered, bucket)} AS period, COUNT(*)::int AS n, SUM(o.actual_amount_collected) AS amount
      FROM orders o
      WHERE o.needs_financial_review AND o.financial_status = 'REVIEW_REQUIRED'
        AND o.delivered_at IS NOT NULL AND ${rangeSql(oDelivered, range)}
      GROUP BY 1
    ),
    periods AS (
      SELECT period FROM company UNION SELECT period FROM wallet UNION SELECT period FROM pending UNION SELECT period FROM review
    )
    SELECT p.period,
           company.fee AS posted_fee, company.product AS posted_product, wallet.wallet AS posted_wallet,
           pending.fee AS pending_fee, pending.product AS pending_product, pending.wallet AS pending_wallet,
           review.n AS review_count, review.amount AS review_amount
    FROM periods p
    LEFT JOIN company ON company.period = p.period
    LEFT JOIN wallet ON wallet.period = p.period
    LEFT JOIN pending ON pending.period = p.period
    LEFT JOIN review ON review.period = p.period
    ORDER BY p.period ASC
  `;
  return rows.map((row) => toFigures(row));
}

function toFigures(row: DeliveryDateRow): DeliveryDateFigures {
  const pf = dec(row.posted_fee);
  const pp = dec(row.posted_product);
  const pw = dec(row.posted_wallet);
  const nf = dec(row.pending_fee);
  const np = dec(row.pending_product);
  const nw = dec(row.pending_wallet);
  return {
    period: row.period,
    deliveryFeeRevenue: pf.plus(nf).toString(),
    postedDeliveryFeeRevenue: pf.toString(),
    pendingDeliveryFeeRevenue: nf.toString(),
    companyOrderRevenue: pp.plus(np).toString(),
    postedCompanyOrderRevenue: pp.toString(),
    pendingCompanyOrderRevenue: np.toString(),
    customerWalletCredits: pw.plus(nw).toString(),
    postedCustomerWalletCredits: pw.toString(),
    pendingCustomerWalletCredits: nw.toString(),
    underReviewOrderCount: row.review_count ?? 0,
    underReviewCollectionAmount: dec(row.review_amount).toString(),
  };
}

export function emptyDeliveryDateFigures(period = "ALL"): DeliveryDateFigures {
  return toFigures({
    period,
    posted_fee: null,
    posted_product: null,
    posted_wallet: null,
    pending_fee: null,
    pending_product: null,
    pending_wallet: null,
    review_count: null,
    review_amount: null,
  });
}

// Category postings that have no order — not attributable to a delivery
// date. Counted by their own posting date; reported beside (never inside)
// the delivery-date figures.
export interface OrderlessCategoryPostings {
  rowCount: number;
  deliveryFeeRevenue: string;
  companyOrderRevenue: string;
  customerWalletCredits: string;
}

export async function getOrderlessCategoryPostings(db: Prisma.TransactionClient, range: DateRange): Promise<OrderlessCategoryPostings> {
  const [company, wallet] = await Promise.all([
    db.$queryRaw<{ n: number; fee: Prisma.Decimal | null; product: Prisma.Decimal | null }[]>`
      SELECT COUNT(*)::int AS n,
             SUM(c.amount) FILTER (WHERE orig.type = 'DELIVERY_FEE_REVENUE') AS fee,
             SUM(c.amount) FILTER (WHERE orig.type = 'COMPANY_ORDER_PRODUCT_REVENUE') AS product
      FROM company_financial_transactions c
      JOIN company_financial_transactions orig ON orig.id = COALESCE(c.reversal_of_id, c.id)
      WHERE orig.type IN ('DELIVERY_FEE_REVENUE', 'COMPANY_ORDER_PRODUCT_REVENUE') AND orig.order_id IS NULL
        AND (c.reversal_of_id IS NULL OR c.type = 'REVERSAL')
        AND ${rangeSql(Prisma.sql`c.created_at`, range)}
    `,
    db.$queryRaw<{ n: number; wallet: Prisma.Decimal | null }[]>`
      SELECT COUNT(*)::int AS n, SUM(w.credit - w.debit) AS wallet
      FROM wallet_transactions w
      JOIN wallet_transactions orig ON orig.id = COALESCE(w.reversal_of_id, w.id)
      WHERE orig.type = 'ORDER_CREDIT' AND orig.order_id IS NULL
        AND (w.reversal_of_id IS NULL OR w.type = 'REVERSAL')
        AND ${rangeSql(Prisma.sql`w.created_at`, range)}
    `,
  ]);
  return {
    rowCount: (company[0]?.n ?? 0) + (wallet[0]?.n ?? 0),
    deliveryFeeRevenue: dec(company[0]?.fee).toString(),
    companyOrderRevenue: dec(company[0]?.product).toString(),
    customerWalletCredits: dec(wallet[0]?.wallet).toString(),
  };
}

export interface DeliveryDateSummary {
  basis: "DELIVERY_DATE";
  figures: DeliveryDateFigures;
  orderlessCategoryPostings: OrderlessCategoryPostings;
}

export async function getDeliveryDateSummary(db: Prisma.TransactionClient, range: DateRange): Promise<DeliveryDateSummary> {
  const [rows, orderless] = await Promise.all([getDeliveryDateFigures(db, range, null), getOrderlessCategoryPostings(db, range)]);
  return { basis: "DELIVERY_DATE", figures: rows[0] ?? emptyDeliveryDateFigures(), orderlessCategoryPostings: orderless };
}
