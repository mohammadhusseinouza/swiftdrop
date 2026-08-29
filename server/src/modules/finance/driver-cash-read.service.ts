import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import type { DriverCashTransactionsQuery } from "./driver-cash-read.schema";
import type {
  ManagementDriverCashDetail,
  ManagementDriverCashSummary,
  ManagementDriverCashTransactionEntry,
} from "./driver-cash-read.types";

// ============================================================
// GET /api/v1/finance/driver-cash/:driverId(/transactions)
// GET /api/v1/finance/driver-cash/summaries
//
// Strictly READ-ONLY, finance.read-gated. Never recalculates a balance,
// rewrites history, repairs, or creates a missing account.
// ============================================================

async function assertDriverExists(driverId: string): Promise<void> {
  const driver = await prisma.drivers.findUnique({ where: { id: driverId }, select: { id: true } });
  if (!driver) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Driver not found" });
  }
}

export async function getManagementDriverCashDetail(driverId: string): Promise<ManagementDriverCashDetail> {
  await assertDriverExists(driverId);

  const account = await prisma.driver_cash_accounts.findUnique({ where: { driver_id: driverId } });
  if (!account) {
    // Phase 5.2 creates the Driver + its cash account atomically — a missing
    // account is a data-integrity failure, never silently repaired here.
    console.error(
      `[driver-cash-read.service] data-integrity failure: driver ${driverId} has no linked driver_cash_accounts row`
    );
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Driver cash account is missing" });
  }

  return { driverId, currentBalance: account.current_balance.toString() };
}

const transactionSelect = {
  id: true,
  type: true,
  amount: true,
  balance_before: true,
  balance_after: true,
  notes: true,
  created_at: true,
  orders: { select: { id: true, order_number: true } },
  driver_settlements: {
    select: {
      id: true,
      settlement_number: true,
      payment_methods: { select: { id: true, code: true, name: true } },
    },
  },
  users: { select: { id: true, first_name: true, last_name: true } },
} satisfies Prisma.driver_cash_transactionsSelect;

type TransactionRow = Prisma.driver_cash_transactionsGetPayload<{ select: typeof transactionSelect }>;

function toEntry(row: TransactionRow): ManagementDriverCashTransactionEntry {
  const delta = row.balance_after.minus(row.balance_before);
  const settlementPaymentMethod = row.driver_settlements?.payment_methods;
  return {
    id: row.id,
    type: row.type,
    direction: delta.isNegative() ? "DEBIT" : "CREDIT",
    amount: row.amount.toString(),
    balanceBefore: row.balance_before.toString(),
    balanceAfter: row.balance_after.toString(),
    order: row.orders ? { id: row.orders.id, orderNumber: row.orders.order_number } : null,
    settlement: row.driver_settlements
      ? { id: row.driver_settlements.id, settlementNumber: row.driver_settlements.settlement_number }
      : null,
    paymentMethod: settlementPaymentMethod
      ? { id: settlementPaymentMethod.id, code: settlementPaymentMethod.code, name: settlementPaymentMethod.name }
      : null,
    actor: row.users
      ? { id: row.users.id, firstName: row.users.first_name, lastName: row.users.last_name }
      : null,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
  };
}

export interface ManagementDriverCashTransactionsResult {
  items: ManagementDriverCashTransactionEntry[];
  total: number;
}

export async function listManagementDriverCashTransactions(
  driverId: string,
  query: DriverCashTransactionsQuery
): Promise<ManagementDriverCashTransactionsResult> {
  await assertDriverExists(driverId);

  const where: Prisma.driver_cash_transactionsWhereInput = { driver_id: driverId };

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

  return { items: rows.map(toEntry), total };
}

// Batched Cash-Held for a page of the Driver List — one query, only the
// requested drivers that have a cash account.
export async function getManagementDriverCashSummaries(
  driverIds: string[]
): Promise<ManagementDriverCashSummary[]> {
  if (driverIds.length === 0) return [];
  const accounts = await prisma.driver_cash_accounts.findMany({
    where: { driver_id: { in: driverIds } },
    select: { driver_id: true, current_balance: true },
  });
  return accounts.map((a) => ({ driverId: a.driver_id, currentBalance: a.current_balance.toString() }));
}
