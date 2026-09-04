import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { resolveRange, type ResolvedRange } from "../finance/finance-summary.service";
import type { DriverReportQuery } from "./report.schema";
import type { DriverReportDto, DriverReportRow } from "./report.types";

// ============================================================
// GET /api/v1/reports/drivers (Phase 9.3)
//
// Historical performance (deliveries/failures/money collected) is derived
// from delivery_attempts.driver_id and its own completed_at timestamp —
// NEVER orders.current_driver_id, which only reflects the CURRENT/latest
// assignment and would silently re-attribute a delivery to a driver the
// Order was later reassigned to. ordersAssigned uses order_assignments
// (assigned_at in range), for the same historical-accuracy reason.
// currentCashHeld is an explicit CURRENT snapshot (never restricted by
// from/to) — the field name says so.
// ============================================================

interface NetSumRow {
  total: string | null;
}

function toAmount(value: string | null | undefined): string {
  return new Prisma.Decimal(value ?? "0").toString();
}

function dateRangeSql(column: string, range: ResolvedRange): Prisma.Sql {
  const clauses: Prisma.Sql[] = [];
  if (range.start) clauses.push(Prisma.sql`${Prisma.raw(column)} >= ${range.start}`);
  if (range.endExclusive) clauses.push(Prisma.sql`${Prisma.raw(column)} < ${range.endExclusive}`);
  return clauses.length ? Prisma.join(clauses, " AND ") : Prisma.sql`TRUE`;
}

// Mirrors Phase 9.2's getNetCollectedFlow (finance-summary.service.ts)
// exactly, scoped to one Driver — driver_cash_transactions.amount is always
// a positive magnitude, so a COLLECTION reversal is explicitly subtracted,
// never added. Reconciles with Finance Report's totalCollected when summed
// across every Driver for the same range.
async function getDriverMoneyCollected(driverId: string, range: ResolvedRange): Promise<string> {
  const rows = await prisma.$queryRaw<NetSumRow[]>`
    SELECT (
      COALESCE(SUM(CASE WHEN type = 'COLLECTION' THEN amount ELSE 0 END), 0)
      - COALESCE(
          SUM(
            CASE
              WHEN type = 'REVERSAL' AND reversal_of_id IN (SELECT id FROM driver_cash_transactions WHERE type = 'COLLECTION' AND driver_id = ${driverId}::uuid)
              THEN amount
              ELSE 0
            END
          ),
          0
        )
    )::text AS total
    FROM driver_cash_transactions
    WHERE driver_id = ${driverId}::uuid AND ${dateRangeSql("created_at", range)}
  `;
  return toAmount(rows[0]?.total);
}

export async function getDriverReport(query: DriverReportQuery): Promise<DriverReportDto> {
  const range = resolveRange(query);

  const driverWhere: Prisma.driversWhereInput = {};
  if (query.driverId) driverWhere.id = query.driverId;
  if (query.isActive !== undefined) driverWhere.is_active = query.isActive;

  const drivers = await prisma.drivers.findMany({
    where: driverWhere,
    select: { id: true, driver_number: true, is_active: true, users: { select: { first_name: true, last_name: true } } },
  });
  if (drivers.length === 0) {
    return { report: "DRIVERS", range: { from: query.from ?? null, to: query.to ?? null }, rows: [] };
  }
  const driverIds = drivers.map((d) => d.id);

  const attemptDateClause = dateRangeSql("completed_at", range);
  // Phase 11.17.6 (task §37) — Parcel Collection date semantics, DISTINCT
  // from the delivery `attemptDateClause` above:
  //   collectionAssignments   -> assigned_at in range
  //   collectionsCompleted    -> ended_at in range AND end_reason = RECEIVED_AT_COMPANY
  //   failedCollectionAttempts -> attempt.completed_at in range AND outcome = FAILED
  const collectionAssignedClause = dateRangeSql("assigned_at", range);
  const collectionEndedClause = dateRangeSql("ended_at", range);
  const collectionAttemptDateClause = dateRangeSql("completed_at", range);

  const [
    assignedRows,
    deliveredRows,
    failedRows,
    settlementRows,
    cashAccounts,
    moneyCollectedByDriver,
    collectionAssignedRows,
    collectionsCompletedRows,
    failedCollectionAttemptRows,
  ] = await Promise.all([
    prisma.order_assignments.groupBy({
      by: ["driver_id"],
      where: { driver_id: { in: driverIds }, assigned_at: rangeToWhere(range) },
      _count: true,
    }),
    prisma.$queryRaw<{ driver_id: string; count: bigint }[]>`
      SELECT driver_id, COUNT(*) AS count FROM delivery_attempts
      WHERE driver_id = ANY(${driverIds}::uuid[]) AND outcome = 'DELIVERED' AND ${attemptDateClause}
      GROUP BY driver_id
    `,
    prisma.$queryRaw<{ driver_id: string; count: bigint }[]>`
      SELECT driver_id, COUNT(*) AS count FROM delivery_attempts
      WHERE driver_id = ANY(${driverIds}::uuid[]) AND outcome = 'FAILED' AND ${attemptDateClause}
      GROUP BY driver_id
    `,
    prisma.driver_settlements.groupBy({
      by: ["driver_id"],
      where: { driver_id: { in: driverIds }, created_at: rangeToWhere(range) },
      _count: true,
      _sum: { amount_received: true },
    }),
    prisma.driver_cash_accounts.findMany({ where: { driver_id: { in: driverIds } }, select: { driver_id: true, current_balance: true } }),
    Promise.all(driverIds.map(async (id) => [id, await getDriverMoneyCollected(id, range)] as const)),
    prisma.$queryRaw<{ driver_id: string; count: bigint }[]>`
      SELECT driver_id, COUNT(*) AS count FROM parcel_collection_assignments
      WHERE driver_id = ANY(${driverIds}::uuid[]) AND ${collectionAssignedClause}
      GROUP BY driver_id
    `,
    prisma.$queryRaw<{ driver_id: string; count: bigint }[]>`
      SELECT driver_id, COUNT(*) AS count FROM parcel_collection_assignments
      WHERE driver_id = ANY(${driverIds}::uuid[]) AND end_reason = 'RECEIVED_AT_COMPANY' AND ${collectionEndedClause}
      GROUP BY driver_id
    `,
    prisma.$queryRaw<{ driver_id: string; count: bigint }[]>`
      SELECT driver_id, COUNT(*) AS count FROM parcel_collection_attempts
      WHERE driver_id = ANY(${driverIds}::uuid[]) AND outcome = 'FAILED' AND ${collectionAttemptDateClause}
      GROUP BY driver_id
    `,
  ]);

  const assignedById = new Map(assignedRows.map((r) => [r.driver_id, r._count]));
  const deliveredById = new Map(deliveredRows.map((r) => [r.driver_id, Number(r.count)]));
  const failedById = new Map(failedRows.map((r) => [r.driver_id, Number(r.count)]));
  const settlementById = new Map(settlementRows.map((r) => [r.driver_id, r]));
  const cashById = new Map(cashAccounts.map((a) => [a.driver_id, a.current_balance]));
  const collectedById = new Map(moneyCollectedByDriver);
  const collectionAssignedById = new Map(collectionAssignedRows.map((r) => [r.driver_id, Number(r.count)]));
  const collectionsCompletedById = new Map(collectionsCompletedRows.map((r) => [r.driver_id, Number(r.count)]));
  const failedCollectionAttemptsById = new Map(failedCollectionAttemptRows.map((r) => [r.driver_id, Number(r.count)]));

  const rows: DriverReportRow[] = drivers.map((driver) => {
    const delivered = deliveredById.get(driver.id) ?? 0;
    const failed = failedById.get(driver.id) ?? 0;
    const attempts = delivered + failed;
    const settlement = settlementById.get(driver.id);

    return {
      driver: {
        id: driver.id,
        driverNumber: driver.driver_number,
        name: `${driver.users.first_name} ${driver.users.last_name}`,
        isActive: driver.is_active,
      },
      ordersAssigned: assignedById.get(driver.id) ?? 0,
      ordersDelivered: delivered,
      failedAttempts: failed,
      deliveryAttempts: attempts,
      // successRate is a percentage string with 2 decimal places, computed
      // via Decimal (never JS floating point); null (not 0) when there is
      // no terminal attempt evidence at all, per the Phase 9.3 contract.
      successRate:
        attempts === 0
          ? null
          : new Prisma.Decimal(delivered).dividedBy(attempts).times(100).toDecimalPlaces(2).toString(),
      moneyCollected: collectedById.get(driver.id) ?? "0",
      settlementCount: settlement?._count ?? 0,
      settlementAmount: toAmount(settlement?._sum.amount_received?.toString()),
      currentCashHeld: toAmount(cashById.get(driver.id)?.toString()),
      collectionAssignments: collectionAssignedById.get(driver.id) ?? 0,
      collectionsCompleted: collectionsCompletedById.get(driver.id) ?? 0,
      failedCollectionAttempts: failedCollectionAttemptsById.get(driver.id) ?? 0,
    };
  });

  return { report: "DRIVERS", range: { from: query.from ?? null, to: query.to ?? null }, rows };
}

// Prisma's typed groupBy/findMany `where` needs a proper filter object, not
// a raw Prisma.Sql fragment — this small adapter turns the same ResolvedRange
// into the { gte, lt } shape the typed client calls above use.
function rangeToWhere(range: ResolvedRange): { gte?: Date; lt?: Date } | undefined {
  if (!range.start && !range.endExclusive) return undefined;
  return {
    ...(range.start ? { gte: range.start } : {}),
    ...(range.endExclusive ? { lt: range.endExclusive } : {}),
  };
}
