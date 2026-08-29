import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import type { GetDriverCashQuery } from "./driver-cash.schema";
import type { DriverCashOverview, DriverCashTransactionEntry } from "./driver-cash.types";

// GET /api/v1/driver/me/cash (Phase 8.1) — strictly READ-ONLY. Never
// recalculates balances, rewrites history, repairs an inconsistent account,
// creates a missing account, or touches updated_at.

const transactionSelect = {
  id: true,
  type: true,
  amount: true,
  balance_before: true,
  balance_after: true,
  created_at: true,
  orders: { select: { id: true, order_number: true } },
  driver_settlements: { select: { id: true, settlement_number: true } },
} satisfies Prisma.driver_cash_transactionsSelect;

type TransactionRow = Prisma.driver_cash_transactionsGetPayload<{ select: typeof transactionSelect }>;

function toDriverCashTransactionEntry(row: TransactionRow): DriverCashTransactionEntry {
  return {
    id: row.id,
    type: row.type,
    amount: row.amount.toString(),
    balanceBefore: row.balance_before.toString(),
    balanceAfter: row.balance_after.toString(),
    order: row.orders ? { id: row.orders.id, orderNumber: row.orders.order_number } : null,
    settlement: row.driver_settlements
      ? { id: row.driver_settlements.id, settlementNumber: row.driver_settlements.settlement_number }
      : null,
    createdAt: row.created_at.toISOString(),
  };
}

export interface DriverCashOverviewResult {
  overview: DriverCashOverview;
  total: number;
}

// Reads the authenticated Driver's own cash account + a page of their own
// ledger transactions. `driverId` MUST already be resolved server-side via
// getDriverProfileForUser(req.actor.userId) by the caller — this function
// takes no client-supplied identity.
export async function getDriverCashOverview(driverId: string, query: GetDriverCashQuery): Promise<DriverCashOverviewResult> {
  const account = await prisma.driver_cash_accounts.findUnique({ where: { driver_id: driverId } });
  // Phase 5.2 creates the Driver + its cash account atomically — a linked
  // Driver should always have exactly one. A missing account is a data-
  // integrity failure, never silently repaired/auto-created here.
  if (!account) {
    console.error(`[driver-cash.service] data-integrity failure: driver ${driverId} has no linked driver_cash_accounts row`);
    throw new AppError({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Driver cash account is missing",
    });
  }

  const where: Prisma.driver_cash_transactionsWhereInput = { driver_id: driverId };
  if (query.type) {
    where.type = query.type;
  }

  const [rows, total] = await Promise.all([
    prisma.driver_cash_transactions.findMany({
      where,
      select: transactionSelect,
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.driver_cash_transactions.count({ where }),
  ]);

  return {
    overview: {
      account: { id: account.id, currentBalance: account.current_balance.toString() },
      transactions: rows.map(toDriverCashTransactionEntry),
    },
    total,
  };
}
