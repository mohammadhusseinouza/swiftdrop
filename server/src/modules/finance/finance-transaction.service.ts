import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { nextUtcDay, parseUtcCalendarDate } from "../../shared/date/day-boundary";
import type { FinanceTransactionsQuery } from "./finance-read.schema";
import type {
  FinanceActorRef,
  FinanceTransactionEntry,
  FinanceTransactionsResult,
  LedgerName,
} from "./finance-read.types";

// ============================================================
// GET /api/v1/finance/transactions (Phase 9.2)
//
// A unified, GLOBALLY paginated feed over the three authoritative append-
// only ledgers (Customer Wallet, Driver Cash, Company Finance) — never a
// per-ledger concatenation of separately-paginated pages, and never
// CustomerPayout/DriverSettlement rows duplicated alongside their already-
// linked ledger row (Wallet PAYOUT / Driver Cash SETTLEMENT carry a payout/
// settlement summary instead — see toWalletEntry/toDriverCashEntry below).
//
// Two-phase design, deliberately narrow:
//   Phase 1 (raw SQL): normalize all three tables down to the MINIMUM
//     columns needed to filter/order/paginate globally (id, ledger, created_
//     at) — this is the only place a UNION ALL touches three differently-
//     shaped tables, and it never returns money or relation data.
//   Phase 2 (typed Prisma): batch-fetch the full row + every relation for
//     just this page's ids, split by ledger (never a query per row), then
//     re-zip into the phase-1 global order. All DTO shaping happens here, in
//     normal type-safe Prisma — never inside raw SQL.
// ============================================================

interface UnifiedRow {
  id: string;
  ledger: LedgerName;
}

interface CountRow {
  count: bigint | number | string;
}

function createdAtRangeSql(start?: Date, endExclusive?: Date): Prisma.Sql {
  const clauses: Prisma.Sql[] = [];
  if (start) clauses.push(Prisma.sql`created_at >= ${start}`);
  if (endExclusive) clauses.push(Prisma.sql`created_at < ${endExclusive}`);
  return clauses.length ? Prisma.join(clauses, " AND ") : Prisma.sql`TRUE`;
}

// Builds the normalized `(id, ledger, created_at)` derived table as a single
// reusable Prisma.Sql fragment, embedded (never string-concatenated) into
// both the count query and the paginated page query below. `ledger` prunes
// whole branches (a fixed, whitelisted set of three, never a dynamic table
// name); `type` is applied identically inside every remaining branch via a
// bound parameter compared against the enum column cast to text — safe
// because Postgres enum columns compare correctly once both sides are text,
// and the value itself was already validated against the real enum
// literals by finance-read.schema.ts before this ever runs.
function buildUnifiedSource(input: { from?: string; to?: string; ledger?: LedgerName; type?: string }): Prisma.Sql {
  const start = input.from ? (parseUtcCalendarDate(input.from) ?? undefined) : undefined;
  const toDate = input.to ? (parseUtcCalendarDate(input.to) ?? undefined) : undefined;
  const endExclusive = toDate ? nextUtcDay(toDate) : undefined;
  const dateClause = createdAtRangeSql(start, endExclusive);
  const typeClause = input.type ? Prisma.sql`AND type::text = ${input.type}` : Prisma.sql``;

  const branches: Prisma.Sql[] = [];
  if (!input.ledger || input.ledger === "WALLET") {
    branches.push(Prisma.sql`
      SELECT id, 'WALLET'::text AS ledger, created_at
      FROM wallet_transactions
      WHERE ${dateClause} ${typeClause}
    `);
  }
  if (!input.ledger || input.ledger === "DRIVER_CASH") {
    branches.push(Prisma.sql`
      SELECT id, 'DRIVER_CASH'::text AS ledger, created_at
      FROM driver_cash_transactions
      WHERE ${dateClause} ${typeClause}
    `);
  }
  if (!input.ledger || input.ledger === "COMPANY_FINANCE") {
    branches.push(Prisma.sql`
      SELECT id, 'COMPANY_FINANCE'::text AS ledger, created_at
      FROM company_financial_transactions
      WHERE ${dateClause} ${typeClause}
    `);
  }
  return Prisma.join(branches, " UNION ALL ");
}

// ------------------------------------------------------------
// Phase 2 — typed relation shaping (one findMany per ledger present on the
// page, never per row).
// ------------------------------------------------------------

const walletInclude = {
  customers: { select: { id: true, customer_number: true, name: true } },
  orders: { select: { id: true, order_number: true } },
  payment_methods: { select: { id: true, code: true, name: true } },
  customer_payouts: { select: { id: true, payout_number: true, status: true } },
  users: { select: { id: true, first_name: true, last_name: true } },
  wallet_transactions: { select: { id: true, type: true } },
} satisfies Prisma.wallet_transactionsInclude;

type WalletRow = Prisma.wallet_transactionsGetPayload<{ include: typeof walletInclude }>;

const driverCashInclude = {
  drivers: { select: { id: true, driver_number: true, users: { select: { first_name: true, last_name: true } } } },
  orders: { select: { id: true, order_number: true } },
  driver_settlements: { select: { id: true, settlement_number: true, payment_methods: { select: { id: true, code: true, name: true } } } },
  users: { select: { id: true, first_name: true, last_name: true } },
  driver_cash_transactions: { select: { id: true, type: true } },
} satisfies Prisma.driver_cash_transactionsInclude;

type DriverCashRow = Prisma.driver_cash_transactionsGetPayload<{ include: typeof driverCashInclude }>;

const companyInclude = {
  orders: { select: { id: true, order_number: true } },
  payment_methods: { select: { id: true, code: true, name: true } },
  users: { select: { id: true, first_name: true, last_name: true } },
  company_financial_transactions: { select: { id: true, type: true } },
} satisfies Prisma.company_financial_transactionsInclude;

type CompanyRow = Prisma.company_financial_transactionsGetPayload<{ include: typeof companyInclude }>;

function toActorRef(user: { id: string; first_name: string; last_name: string } | null | undefined): FinanceActorRef | null {
  return user ? { id: user.id, firstName: user.first_name, lastName: user.last_name } : null;
}

function integrityError(ledger: LedgerName, id: string, detail: string): AppError {
  console.error(`[finance-transaction.service] data-integrity failure: ${ledger} row ${id} — ${detail}`);
  return new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Financial transaction feed is inconsistent" });
}

// Wallet direction: separate credit/debit columns, exactly one positive.
function toWalletEntry(row: WalletRow): FinanceTransactionEntry {
  const creditPositive = row.credit.greaterThan(0);
  const debitPositive = row.debit.greaterThan(0);
  if (creditPositive === debitPositive) {
    throw integrityError("WALLET", row.id, "credit/debit are not exactly one positive");
  }
  const direction = creditPositive ? "CREDIT" : "DEBIT";
  const amount = creditPositive ? row.credit : row.debit;

  return {
    id: row.id,
    ledger: "WALLET",
    type: row.type,
    direction,
    amount: amount.toString(),
    signedAmount: row.credit.minus(row.debit).toString(),
    balanceBefore: row.balance_before.toString(),
    balanceAfter: row.balance_after.toString(),
    order: row.orders ? { id: row.orders.id, orderNumber: row.orders.order_number } : null,
    customer: row.customers ? { id: row.customers.id, customerNumber: row.customers.customer_number, name: row.customers.name } : null,
    driver: null,
    payout: row.customer_payouts
      ? { id: row.customer_payouts.id, payoutNumber: row.customer_payouts.payout_number, status: row.customer_payouts.status }
      : null,
    settlement: null,
    paymentMethod: row.payment_methods ? { id: row.payment_methods.id, code: row.payment_methods.code, name: row.payment_methods.name } : null,
    actor: toActorRef(row.users),
    reversalOf: row.wallet_transactions ? { id: row.wallet_transactions.id, type: row.wallet_transactions.type } : null,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
  };
}

// Driver Cash direction: derived from balance_after - balance_before (the
// stored `amount` is always a positive magnitude — never trust an enum-type
// assumption for direction, per the approved Phase 8.1 convention).
function toDriverCashEntry(row: DriverCashRow): FinanceTransactionEntry {
  const delta = row.balance_after.minus(row.balance_before);
  if (delta.isZero()) {
    throw integrityError("DRIVER_CASH", row.id, "zero balance delta");
  }
  const direction = delta.greaterThan(0) ? "CREDIT" : "DEBIT";
  const settlementPaymentMethod = row.driver_settlements?.payment_methods;

  return {
    id: row.id,
    ledger: "DRIVER_CASH",
    type: row.type,
    direction,
    amount: row.amount.toString(),
    signedAmount: delta.toString(),
    balanceBefore: row.balance_before.toString(),
    balanceAfter: row.balance_after.toString(),
    order: row.orders ? { id: row.orders.id, orderNumber: row.orders.order_number } : null,
    customer: null,
    driver: { id: row.drivers.id, driverNumber: row.drivers.driver_number, name: `${row.drivers.users.first_name} ${row.drivers.users.last_name}` },
    payout: null,
    settlement: row.driver_settlements ? { id: row.driver_settlements.id, settlementNumber: row.driver_settlements.settlement_number } : null,
    // Payment method lives on driver_settlements, never on
    // driver_cash_transactions itself (Phase 8.6) — resolved through the
    // linked Settlement relation only, never invented on the cash row.
    paymentMethod: settlementPaymentMethod
      ? { id: settlementPaymentMethod.id, code: settlementPaymentMethod.code, name: settlementPaymentMethod.name }
      : null,
    actor: toActorRef(row.users),
    reversalOf: row.driver_cash_transactions ? { id: row.driver_cash_transactions.id, type: row.driver_cash_transactions.type } : null,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
  };
}

// Company Finance direction: amount is SIGNED (positive = CREDIT/revenue,
// negative = DEBIT) — the DTO's `amount` field is the absolute magnitude,
// `signedAmount` preserves the sign.
function toCompanyEntry(row: CompanyRow): FinanceTransactionEntry {
  if (row.amount.isZero()) {
    throw integrityError("COMPANY_FINANCE", row.id, "zero amount");
  }
  const direction = row.amount.greaterThan(0) ? "CREDIT" : "DEBIT";

  return {
    id: row.id,
    ledger: "COMPANY_FINANCE",
    type: row.type,
    direction,
    amount: row.amount.abs().toString(),
    signedAmount: row.amount.toString(),
    balanceBefore: null,
    balanceAfter: null,
    order: row.orders ? { id: row.orders.id, orderNumber: row.orders.order_number } : null,
    customer: null,
    driver: null,
    payout: null,
    settlement: null,
    paymentMethod: row.payment_methods ? { id: row.payment_methods.id, code: row.payment_methods.code, name: row.payment_methods.name } : null,
    actor: toActorRef(row.users),
    reversalOf: row.company_financial_transactions ? { id: row.company_financial_transactions.id, type: row.company_financial_transactions.type } : null,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
  };
}

async function hydrateTransactionRows(db: Prisma.TransactionClient, rows: UnifiedRow[]): Promise<FinanceTransactionEntry[]> {
  const walletIds = rows.filter((r) => r.ledger === "WALLET").map((r) => r.id);
  const driverCashIds = rows.filter((r) => r.ledger === "DRIVER_CASH").map((r) => r.id);
  const companyIds = rows.filter((r) => r.ledger === "COMPANY_FINANCE").map((r) => r.id);

  const [walletRows, driverCashRows, companyRows] = await Promise.all([
    walletIds.length ? db.wallet_transactions.findMany({ where: { id: { in: walletIds } }, include: walletInclude }) : Promise.resolve([]),
    driverCashIds.length
      ? db.driver_cash_transactions.findMany({ where: { id: { in: driverCashIds } }, include: driverCashInclude })
      : Promise.resolve([]),
    companyIds.length
      ? db.company_financial_transactions.findMany({ where: { id: { in: companyIds } }, include: companyInclude })
      : Promise.resolve([]),
  ]);

  const walletById = new Map(walletRows.map((r) => [r.id, r]));
  const driverCashById = new Map(driverCashRows.map((r) => [r.id, r]));
  const companyById = new Map(companyRows.map((r) => [r.id, r]));

  // Re-zip into the Phase-1 global order — the ONLY correct order (never
  // re-sorted by anything else here).
  return rows.map((row) => {
    if (row.ledger === "WALLET") {
      const full = walletById.get(row.id);
      if (!full) throw integrityError(row.ledger, row.id, "missing on hydration");
      return toWalletEntry(full);
    }
    if (row.ledger === "DRIVER_CASH") {
      const full = driverCashById.get(row.id);
      if (!full) throw integrityError(row.ledger, row.id, "missing on hydration");
      return toDriverCashEntry(full);
    }
    const full = companyById.get(row.id);
    if (!full) throw integrityError(row.ledger, row.id, "missing on hydration");
    return toCompanyEntry(full);
  });
}

// The Phase-1 id/ledger selection and the Phase-2 typed relation fetch are
// two separate round trips, not one query — outside a shared snapshot,
// production's append-only ledgers (rows are never deleted, CLAUDE.md §22/
// §25/§27) make that harmless, but nothing GUARANTEES it in general (a
// hypothetical future correction path, an admin action, or simply two
// requests racing a page boundary). REPEATABLE READ pins the whole read to
// one consistent snapshot for both phases, so a row Phase 1 saw can never
// vanish out from under Phase 2 — this is what actually surfaced the gap:
// concurrently-running test suites legitimately delete rows via their own
// cleanup, and without this the two phases could observe different data.
export async function getFinanceTransactions(query: FinanceTransactionsQuery): Promise<FinanceTransactionsResult> {
  const unified = buildUnifiedSource(query);
  const offset = (query.page - 1) * query.limit;

  return prisma.$transaction(
    async (tx) => {
      const [countRows, pageRows] = await Promise.all([
        tx.$queryRaw<CountRow[]>`SELECT COUNT(*) AS count FROM (${unified}) AS unified`,
        tx.$queryRaw<UnifiedRow[]>`
          SELECT id, ledger
          FROM (${unified}) AS unified
          ORDER BY created_at DESC, id DESC
          LIMIT ${query.limit} OFFSET ${offset}
        `,
      ]);

      const total = Number(countRows[0]?.count ?? 0);
      const items = await hydrateTransactionRows(tx, pageRows);

      return { items, total };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );
}
