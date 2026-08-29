import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { resolveRange, type ResolvedRange } from "../finance/finance-summary.service";
import type { OrderReportQuery } from "./report.schema";
import type {
  OrderReportAreaRow,
  OrderReportCustomerRow,
  OrderReportDateRow,
  OrderReportDriverRow,
  OrderReportDto,
  OrderReportOutcomeSummary,
  OrderReportRow,
  OrderReportStatusRow,
  OrderReportSummary,
  OrderReportTypeRow,
} from "./report.types";

// ============================================================
// GET /api/v1/reports/orders (Phase 9.3)
//
// SEMANTICS (documented once here, applies to every grouping below):
//   - The base POPULATION for every row is "Orders CREATED within
//     [from,to)" (orders.created_at) plus the optional customerId/driverId/
//     areaId/status/orderType filters — the Phase 9.3 contract's default
//     rule ("unless the metric is specifically delivery/failure based").
//   - Within that population, `delivered`/`failed` sub-counts use the
//     Order's CURRENT status (DELIVERED/FAILED_DELIVERY) — this is safe and
//     never misattributes a successfully-retried Order as failed, because
//     the Order's current status already reflects its final outcome after
//     any retry. It answers "of what was created in this period, how many
//     are now delivered / currently stuck failed".
//   - The one deliberate exception is groupBy=driver: current_driver_id
//     only reflects the CURRENT/latest assignment, so a delivery performed
//     by a driver who has since been reassigned away must not be silently
//     re-attributed to the new current driver. That grouping uses
//     delivery_attempts.driver_id (real historical attribution) for its
//     delivered/failed counts — see getOrdersByDriver below.
//   - groupBy=outcome additionally reports `failedAttempts` — a strictly
//     historical EVENT count (delivery_attempts with outcome=FAILED
//     belonging to the population), which can exceed `failedCurrent` when an
//     Order failed once and was later retried successfully.
//   - The plain `driverId` QUERY FILTER (as opposed to groupBy=driver's
//     AGGREGATION) uses current_driver_id, identical to the existing
//     GET /orders list filter convention (order.service.ts) — a simple
//     "Orders currently assigned to this Driver" filter, not a historical
//     attribution query.
// ============================================================

const DELIVERED = "DELIVERED" as const;
const FAILED_DELIVERY = "FAILED_DELIVERY" as const;
const CANCELLED = "CANCELLED" as const;

function toAmount(value: Prisma.Decimal | null | undefined): string {
  return (value ?? new Prisma.Decimal(0)).toString();
}

function baseWhere(query: OrderReportQuery, range: ResolvedRange): Prisma.ordersWhereInput {
  const where: Prisma.ordersWhereInput = {};
  if (range.start || range.endExclusive) {
    where.created_at = {
      ...(range.start ? { gte: range.start } : {}),
      ...(range.endExclusive ? { lt: range.endExclusive } : {}),
    };
  }
  if (query.customerId) where.customer_id = query.customerId;
  if (query.driverId) where.current_driver_id = query.driverId;
  if (query.areaId) where.receiver_area_id = query.areaId;
  if (query.status) where.status = query.status;
  if (query.orderType) where.order_type = query.orderType;
  return where;
}

// Raw-SQL mirror of baseWhere for the two groupings that need SQL
// (date_trunc bucketing, and the delivery_attempts join for historical
// driver attribution) — every value is a bound parameter, never
// interpolated; the resulting fragment always reads `orders.<column>`,
// which is valid both in a bare `FROM orders` query and in a
// `FROM orders JOIN delivery_attempts` query, so both call sites can share
// this one builder.
function baseWhereSql(query: OrderReportQuery, range: ResolvedRange): Prisma.Sql {
  const clauses: Prisma.Sql[] = [];
  if (range.start) clauses.push(Prisma.sql`orders.created_at >= ${range.start}`);
  if (range.endExclusive) clauses.push(Prisma.sql`orders.created_at < ${range.endExclusive}`);
  if (query.customerId) clauses.push(Prisma.sql`orders.customer_id = ${query.customerId}::uuid`);
  if (query.driverId) clauses.push(Prisma.sql`orders.current_driver_id = ${query.driverId}::uuid`);
  if (query.areaId) clauses.push(Prisma.sql`orders.receiver_area_id = ${query.areaId}::uuid`);
  if (query.status) clauses.push(Prisma.sql`orders.status = ${query.status}::"OrderStatus"`);
  if (query.orderType) clauses.push(Prisma.sql`orders.order_type = ${query.orderType}::"OrderType"`);
  return clauses.length ? Prisma.join(clauses, " AND ") : Prisma.sql`TRUE`;
}

// ------------------------------------------------------------
// SUMMARY — always computed over the base population, regardless of groupBy.
// ------------------------------------------------------------
async function getSummary(where: Prisma.ordersWhereInput): Promise<OrderReportSummary> {
  const [totals, delivered, failed, cancelled, companyOrders, deliveryOnlyOrders] = await Promise.all([
    prisma.orders.aggregate({
      where,
      _count: true,
      _sum: { order_amount: true, delivery_fee: true, amount_to_collect: true, actual_amount_collected: true },
    }),
    prisma.orders.count({ where: { ...where, status: DELIVERED } }),
    prisma.orders.count({ where: { ...where, status: FAILED_DELIVERY } }),
    prisma.orders.count({ where: { ...where, status: CANCELLED } }),
    prisma.orders.count({ where: { ...where, order_type: "COMPANY_ORDER" } }),
    prisma.orders.count({ where: { ...where, order_type: "DELIVERY_ONLY" } }),
  ]);

  return {
    totalOrders: totals._count,
    deliveredOrders: delivered,
    failedOrders: failed,
    cancelledOrders: cancelled,
    companyOrders,
    deliveryOnlyOrders,
    totalOrderAmount: toAmount(totals._sum.order_amount),
    totalDeliveryFee: toAmount(totals._sum.delivery_fee),
    totalExpectedCollection: toAmount(totals._sum.amount_to_collect),
    totalActualCollection: toAmount(totals._sum.actual_amount_collected),
  };
}

// ------------------------------------------------------------
// groupBy=date — a single raw SQL GROUP BY (no reversal/signed-amount
// complexity here, unlike Finance's flow metrics, so one grouped query is
// both correct and more efficient than the Finance Report's per-bucket-
// function-reuse approach). AT TIME ZONE 'UTC' before date_trunc is
// mandatory — date_trunc on a bare timestamptz truncates in the DB
// session's timezone, not UTC (see report.schema.ts/day-boundary.ts
// convention notes).
// ------------------------------------------------------------
interface DateRow {
  period: string;
  orders: bigint;
  delivered: bigint;
  failed: bigint;
  cancelled: bigint;
}

async function getOrdersByDate(query: OrderReportQuery, range: ResolvedRange): Promise<OrderReportDateRow[]> {
  const whereSql = baseWhereSql(query, range);
  const truncUnit = query.bucket; // "day" | "week" | "month" — a validated enum value, safe as a bound date_trunc field argument (a value, not an identifier).
  const rows = await prisma.$queryRaw<DateRow[]>`
    SELECT
      to_char(date_trunc(${truncUnit}, orders.created_at AT TIME ZONE 'UTC'), ${truncUnit === "month" ? "YYYY-MM" : "YYYY-MM-DD"}) AS period,
      COUNT(*) AS orders,
      COUNT(*) FILTER (WHERE orders.status = 'DELIVERED') AS delivered,
      COUNT(*) FILTER (WHERE orders.status = 'FAILED_DELIVERY') AS failed,
      COUNT(*) FILTER (WHERE orders.status = 'CANCELLED') AS cancelled
    FROM orders
    WHERE ${whereSql}
    GROUP BY period
    ORDER BY period ASC
  `;
  return rows.map((row) => ({
    period: row.period,
    orders: Number(row.orders),
    delivered: Number(row.delivered),
    failed: Number(row.failed),
    cancelled: Number(row.cancelled),
  }));
}

// ------------------------------------------------------------
// groupBy=customer / area / type — plain unsigned counts, safe with typed
// Prisma groupBy. Three parallel groupBy calls (population, delivered
// subset, failed subset) merged by dimension key — see module doc comment
// for why delivered/failed use CURRENT status here (safe for these
// groupings, unlike groupBy=driver).
// ------------------------------------------------------------

async function getOrdersByCustomer(where: Prisma.ordersWhereInput): Promise<OrderReportCustomerRow[]> {
  const [main, delivered, failed] = await Promise.all([
    prisma.orders.groupBy({
      by: ["customer_id"],
      where,
      _count: true,
      _sum: { order_amount: true, delivery_fee: true, actual_amount_collected: true },
      orderBy: { _count: { customer_id: "desc" } },
    }),
    prisma.orders.groupBy({ by: ["customer_id"], where: { ...where, status: DELIVERED }, _count: true }),
    prisma.orders.groupBy({ by: ["customer_id"], where: { ...where, status: FAILED_DELIVERY }, _count: true }),
  ]);
  if (main.length === 0) return [];

  const deliveredById = new Map(delivered.map((r) => [r.customer_id, r._count]));
  const failedById = new Map(failed.map((r) => [r.customer_id, r._count]));
  const customers = await prisma.customers.findMany({
    where: { id: { in: main.map((r) => r.customer_id) } },
    select: { id: true, customer_number: true, name: true },
  });
  const customerById = new Map(customers.map((c) => [c.id, c]));

  return main
    .map((row) => {
      const customer = customerById.get(row.customer_id);
      if (!customer) return null;
      return {
        customer: { id: customer.id, customerNumber: customer.customer_number, name: customer.name },
        ordersCreated: row._count,
        deliveredOrders: deliveredById.get(row.customer_id) ?? 0,
        failedOrders: failedById.get(row.customer_id) ?? 0,
        totalOrderAmount: toAmount(row._sum.order_amount),
        totalDeliveryFee: toAmount(row._sum.delivery_fee),
        actualCollected: toAmount(row._sum.actual_amount_collected),
      };
    })
    .filter((row): row is OrderReportCustomerRow => row !== null)
    // Deterministic tie-breaker: ordersCreated DESC (already applied via the
    // Prisma orderBy above), then customer name.
    .sort((a, b) => b.ordersCreated - a.ordersCreated || a.customer.name.localeCompare(b.customer.name));
}

async function getOrdersByArea(where: Prisma.ordersWhereInput): Promise<OrderReportAreaRow[]> {
  const [main, delivered, failed] = await Promise.all([
    prisma.orders.groupBy({ by: ["receiver_area_id"], where, _count: true }),
    prisma.orders.groupBy({ by: ["receiver_area_id"], where: { ...where, status: DELIVERED }, _count: true }),
    prisma.orders.groupBy({ by: ["receiver_area_id"], where: { ...where, status: FAILED_DELIVERY }, _count: true }),
  ]);
  if (main.length === 0) return [];

  const deliveredById = new Map(delivered.map((r) => [r.receiver_area_id, r._count]));
  const failedById = new Map(failed.map((r) => [r.receiver_area_id, r._count]));
  const areaIds = main.map((r) => r.receiver_area_id).filter((id): id is string => id !== null);
  // areas has NO "code" column (prisma/schema.prisma) — id/name only.
  const areas = await prisma.areas.findMany({ where: { id: { in: areaIds } }, select: { id: true, name: true } });
  const areaById = new Map(areas.map((a) => [a.id, a]));

  return main
    .map((row) => {
      const area = row.receiver_area_id ? (areaById.get(row.receiver_area_id) ?? null) : null;
      return {
        area,
        orders: row._count,
        delivered: deliveredById.get(row.receiver_area_id) ?? 0,
        failed: failedById.get(row.receiver_area_id) ?? 0,
      };
    })
    .sort((a, b) => b.orders - a.orders);
}

async function getOrdersByStatus(where: Prisma.ordersWhereInput): Promise<OrderReportStatusRow[]> {
  const rows = await prisma.orders.groupBy({ by: ["status"], where, _count: true, orderBy: { _count: { status: "desc" } } });
  return rows.map((row) => ({ status: row.status, orders: row._count }));
}

// Per the Phase 9.3 contract's "ORDERS BY TYPE" spec: count + money totals
// only (no delivered/failed breakdown requested for this grouping — that
// belongs to groupBy=outcome/status/date instead).
async function getOrdersByType(where: Prisma.ordersWhereInput): Promise<OrderReportTypeRow[]> {
  const main = await prisma.orders.groupBy({
    by: ["order_type"],
    where,
    _count: true,
    _sum: { order_amount: true, delivery_fee: true, actual_amount_collected: true },
  });
  return main.map((row) => ({
    orderType: row.order_type,
    count: row._count,
    totalOrderAmount: toAmount(row._sum.order_amount),
    totalDeliveryFee: toAmount(row._sum.delivery_fee),
    actualCollected: toAmount(row._sum.actual_amount_collected),
  }));
}

// ------------------------------------------------------------
// groupBy=driver — the one grouping that MUST use delivery_attempts.driver_id
// for delivered/failed (real historical attribution), never
// orders.current_driver_id. "ordersInPortfolio" is a plain population count
// grouped by current_driver_id (consistent with the simple driverId query
// filter elsewhere) — a distinct concept from delivered/failed.
// ------------------------------------------------------------
interface DriverAttemptRow {
  driver_id: string;
  outcome: "DELIVERED" | "FAILED";
  count: bigint;
}

async function getOrdersByDriver(query: OrderReportQuery, where: Prisma.ordersWhereInput, range: ResolvedRange): Promise<OrderReportDriverRow[]> {
  const portfolioWhere: Prisma.ordersWhereInput = { ...where, current_driver_id: { not: null } };
  const [portfolio, actualCollectedByDriver] = await Promise.all([
    prisma.orders.groupBy({ by: ["current_driver_id"], where: portfolioWhere, _count: true }),
    prisma.orders.groupBy({
      by: ["current_driver_id"],
      where: { ...portfolioWhere, status: DELIVERED },
      _sum: { actual_amount_collected: true },
    }),
  ]);
  if (portfolio.length === 0) return [];

  const whereSql = baseWhereSql(query, range);
  const attemptRows = await prisma.$queryRaw<DriverAttemptRow[]>`
    SELECT da.driver_id AS driver_id, da.outcome AS outcome, COUNT(*) AS count
    FROM delivery_attempts da
    JOIN orders ON orders.id = da.order_id
    WHERE ${whereSql} AND da.outcome IN ('DELIVERED', 'FAILED')
    GROUP BY da.driver_id, da.outcome
  `;
  const deliveredByDriver = new Map<string, number>();
  const failedByDriver = new Map<string, number>();
  for (const row of attemptRows) {
    if (row.outcome === "DELIVERED") deliveredByDriver.set(row.driver_id, Number(row.count));
    else failedByDriver.set(row.driver_id, Number(row.count));
  }
  const collectedByDriver = new Map(actualCollectedByDriver.map((r) => [r.current_driver_id, toAmount(r._sum.actual_amount_collected)]));

  const driverIds = portfolio.map((r) => r.current_driver_id).filter((id): id is string => id !== null);
  const drivers = await prisma.drivers.findMany({
    where: { id: { in: driverIds } },
    select: { id: true, driver_number: true, users: { select: { first_name: true, last_name: true } } },
  });
  const driverById = new Map(drivers.map((d) => [d.id, d]));

  return portfolio
    .map((row) => {
      const driverId = row.current_driver_id;
      if (!driverId) return null;
      const driver = driverById.get(driverId);
      if (!driver) return null;
      return {
        driver: { id: driver.id, driverNumber: driver.driver_number, name: `${driver.users.first_name} ${driver.users.last_name}` },
        ordersInPortfolio: row._count,
        delivered: deliveredByDriver.get(driverId) ?? 0,
        failed: failedByDriver.get(driverId) ?? 0,
        actualCollected: collectedByDriver.get(driverId) ?? "0",
      };
    })
    .filter((row): row is OrderReportDriverRow => row !== null)
    .sort((a, b) => b.ordersInPortfolio - a.ordersInPortfolio);
}

// ------------------------------------------------------------
// groupBy=outcome — Delivered vs Failed. deliveredOrders/failedCurrent are
// CURRENT-status counts over the population (never misattributes a
// successfully-retried Order); failedAttempts is a strictly historical
// EVENT count and may exceed failedCurrent.
// ------------------------------------------------------------
async function getOutcomeSummary(where: Prisma.ordersWhereInput): Promise<OrderReportOutcomeSummary> {
  const [deliveredOrders, failedCurrent, failedAttempts] = await Promise.all([
    prisma.orders.count({ where: { ...where, status: DELIVERED } }),
    prisma.orders.count({ where: { ...where, status: FAILED_DELIVERY } }),
    prisma.delivery_attempts.count({ where: { outcome: "FAILED", orders: where } }),
  ]);
  return { deliveredOrders, failedCurrent, failedAttempts };
}

export async function getOrderReport(query: OrderReportQuery): Promise<OrderReportDto> {
  const range = resolveRange(query);
  const where = baseWhere(query, range);

  const [summary, outcome, rows] = await Promise.all([
    getSummary(where),
    query.groupBy === "outcome" ? getOutcomeSummary(where) : Promise.resolve(null),
    getRows(query, where, range),
  ]);

  return {
    report: "ORDERS",
    range: { from: query.from ?? null, to: query.to ?? null },
    groupBy: query.groupBy,
    bucket: query.groupBy === "date" ? query.bucket : null,
    summary,
    outcome,
    rows,
  };
}

async function getRows(query: OrderReportQuery, where: Prisma.ordersWhereInput, range: ResolvedRange): Promise<OrderReportRow[]> {
  switch (query.groupBy) {
    case "date":
      return getOrdersByDate(query, range);
    case "customer":
      return getOrdersByCustomer(where);
    case "driver":
      return getOrdersByDriver(query, where, range);
    case "area":
      return getOrdersByArea(where);
    case "status":
      return getOrdersByStatus(where);
    case "type":
      return getOrdersByType(where);
    case "outcome":
      // The outcome summary itself carries all the numbers for this
      // grouping (see `outcome` field on the DTO) — `rows` stays empty
      // rather than duplicating the same counts in row form.
      return [];
    default:
      return [];
  }
}
