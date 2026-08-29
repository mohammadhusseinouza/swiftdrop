import { randomBytes } from "node:crypto";
import { Prisma } from "../../generated/prisma/client";
import type { driver_settlements, drivers, payment_methods, users } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { debitDriverSettlement } from "../driver-cash/driver-cash-ledger.service";
import { createAuditLog } from "../../shared/audit/audit.service";
import { deriveRequestIdempotencyKey } from "../../shared/idempotency/request-idempotency";
import type { CreateSettlementInput, ListSettlementsQuery } from "./settlement.schema";
import type { SettlementSummary } from "./settlement.types";

// ============================================================
// Driver Settlement (Phase 8.6)
//
// A settlement represents physical cash a Driver hands over to the company —
// it changes CUSTODY of already-recorded money, never OWNERSHIP or REVENUE.
// It ONLY ever changes driver_cash_accounts/driver_cash_transactions (via
// the approved Phase 8.1 debitDriverSettlement primitive) — never
// customer_wallets/wallet_transactions (that would be a Customer Payout, a
// different concept entirely), never company_financial_transactions
// (revenue was already recognized at successful delivery — Phase 8.3/8.4),
// and never orders/delivery_attempts/order_status_history (settlement is
// account-level, not Order-level).
// ============================================================

// Identifier generation mirrors the approved order_number/payout_number
// convention exactly: node:crypto randomBytes with rejection sampling
// (never Math.random(), never SELECT MAX()+1/COUNT(*)+1).
const IDENTIFIER_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const IDENTIFIER_BYTE_REJECTION_THRESHOLD = 256 - (256 % IDENTIFIER_ALPHABET.length);

function randomAlphanumeric(length: number): string {
  let result = "";
  while (result.length < length) {
    const bytes = randomBytes(length - result.length);
    for (const byte of bytes) {
      if (byte < IDENTIFIER_BYTE_REJECTION_THRESHOLD) {
        result += IDENTIFIER_ALPHABET[byte % IDENTIFIER_ALPHABET.length];
        if (result.length === length) break;
      }
    }
  }
  return result;
}

// SET-YYYYMMDD-XXXXXX, well within settlement_number's varchar(50). No
// approved format exists in docs/requirements.md or
// docs/implementation_plan.md — this mirrors ORD-YYYYMMDD-XXXXXX
// (order_number, Phase 6.1) and PAY-YYYYMMDD-XXXXXX (payout_number, Phase
// 8.5) for consistency.
function generateSettlementNumber(): string {
  const utcDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `SET-${utcDate}-${randomAlphanumeric(6)}`;
}

const MAX_IDENTIFIER_ATTEMPTS = 5;

function isSettlementNumberConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const target = error.meta?.target;
  const targetFields = Array.isArray(target) ? target : typeof target === "string" ? [target] : [];
  return targetFields.some((field) => field.includes("settlement_number"));
}

// ============================================================
// DTO mapping
// ============================================================

type SettlementWithRelations = driver_settlements & {
  drivers: drivers & { users: users };
  payment_methods: payment_methods;
  users: users;
};

const settlementInclude = {
  drivers: { include: { users: true } },
  payment_methods: true,
  users: true,
} satisfies Prisma.driver_settlementsInclude;

function toSettlementSummary(row: SettlementWithRelations): SettlementSummary {
  return {
    id: row.id,
    settlementNumber: row.settlement_number,
    driver: {
      id: row.drivers.id,
      driverNumber: row.drivers.driver_number,
      user: { firstName: row.drivers.users.first_name, lastName: row.drivers.users.last_name, phone: row.drivers.users.phone },
    },
    balanceBefore: row.balance_before.toString(),
    amountReceived: row.amount_received.toString(),
    balanceAfter: row.balance_after.toString(),
    paymentMethod: { id: row.payment_methods.id, code: row.payment_methods.code, name: row.payment_methods.name },
    receivedBy: { id: row.users.id, firstName: row.users.first_name, lastName: row.users.last_name },
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
  };
}

// ============================================================
// POST /api/v1/driver-settlements
// ============================================================

async function loadActivePaymentMethod(paymentMethodId: string): Promise<payment_methods> {
  const method = await prisma.payment_methods.findUnique({ where: { id: paymentMethodId } });
  if (!method) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "The specified payment method does not exist" });
  }
  if (!method.is_active) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "The specified payment method is not active" });
  }
  return method;
}

// A settlement is a Management action against physical cash a Driver
// already holds — an inactive Driver (deactivated operational/login access)
// does not stop physically holding company/customer cash that must still be
// settled, so is_active is deliberately never checked here. This mirrors
// the same established precedent as Phase 8.5's Customer Payout (an
// inactive Customer is still owed money) and Phase 8.4's exact
// COMPANY_ORDER delivery path.
export async function createSettlement(
  input: CreateSettlementInput,
  actorUserId: string,
  idempotencyKey: string
): Promise<SettlementSummary> {
  const driver = await prisma.drivers.findUnique({ where: { id: input.driverId } });
  if (!driver) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Driver not found" });
  }

  // Validated up front (outside the identifier retry loop below) so a bad
  // payment method fails fast without ever touching Driver Cash.
  await loadActivePaymentMethod(input.paymentMethodId);

  // Phase 8.9 — request-level idempotency, mirroring Phase 8.5's Customer
  // Payout treatment exactly. The raw client Idempotency-Key header is
  // never persisted: it is derived (scoped to the authenticated actor) into
  // the SAME driver_cash_transactions.idempotency_key UNIQUE column Phase
  // 8.1 already uses for delivery/reversal ledger dedup — no new storage.
  // debitDriverSettlement below is called with settlementId omitted (see the
  // CRITICAL ORDERING comment further down), so the only unique-constraint
  // collision it can hit during a settlement creation is this
  // idempotency_key — never settlement_id (Postgres treats multiple NULLs
  // in a UNIQUE column as distinct).
  const derivedKey = deriveRequestIdempotencyKey("settlement", actorUserId, idempotencyKey);

  // Sequential-replay fast path (also covers "client timed out, retries
  // later"). The real concurrency mutex is the UNIQUE(idempotency_key)
  // constraint handled in the catch block below — this pre-check is an
  // optimization, not the safety guarantee. By the time any other request
  // can observe this row post-commit, settlement_id has already been linked
  // (see the same transaction's final update step below), so reconciliation
  // can always resolve the linked driver_settlements row from it.
  const existingByKey = await prisma.driver_cash_transactions.findUnique({ where: { idempotency_key: derivedKey } });
  if (existingByKey) {
    return reconcileSettlementReplay(existingByKey, input, prisma);
  }

  // Bounded retry on settlement_number collisions only — identical
  // convention to Phase 6.1's order_number/Phase 8.5's payout_number retry.
  let lastConflict: unknown;
  for (let attempt = 0; attempt < MAX_IDENTIFIER_ATTEMPTS; attempt++) {
    const settlementNumber = generateSettlementNumber();

    try {
      return await prisma.$transaction(async (tx) => {
        // Serializes concurrent requests sharing the SAME derived key before
        // either touches the Driver Cash balance. Without this, two
        // concurrent identical requests each independently attempt a FULL
        // balance decrement (neither yet sees the other's not-yet-committed
        // ledger row) — if the account holds enough for only one debit, the
        // loser would fail closed on "insufficient balance" instead of
        // recovering the committed original, which is not an acceptable
        // outcome for a same-key replay. A Postgres advisory lock scoped to
        // this transaction (auto-released on commit/rollback, no schema
        // involved) blocks the second attempt until the first fully commits
        // or rolls back; the recheck immediately below then finds the
        // committed row and reconciles instead of re-debiting. Two DIFFERENT
        // keys hash to different lock ids and never block each other (an
        // occasional hash collision only costs a brief serialization, never
        // a correctness issue).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${derivedKey})::bigint)`;
        const postLockExisting = await tx.driver_cash_transactions.findUnique({ where: { idempotency_key: derivedKey } });
        if (postLockExisting) {
          return reconcileSettlementReplay(postLockExisting, input, tx);
        }

        // ------------------------------------------------------------
        // CRITICAL ORDERING — read this before changing it.
        //
        // driver_settlements.balance_before/balance_after are NOT NULL, so
        // the settlement row cannot be created before the exact serialized
        // balance is known — yet driver_cash_transactions.settlement_id is
        // a FK to driver_settlements.id, so the cash transaction can't be
        // *finally* linked before the settlement row exists either.
        //
        // The debit therefore runs FIRST, unlinked (settlementId omitted),
        // using the approved Phase 8.1 concurrency-safe primitive — this is
        // the single source of truth for balanceBefore/balanceAfter, never
        // a separate application-level pre-read that could go stale under
        // a concurrent settlement/collection. The settlement row is then
        // created using the EXACT values that atomic debit just produced,
        // and finally the cash transaction is updated to link back via
        // settlement_id. All three steps share this one transaction, so a
        // failure at any point rolls every earlier step back together —
        // there is no window where a settlement row and its cash debit can
        // disagree or exist independently.
        // ------------------------------------------------------------
        const cashResult = await debitDriverSettlement(tx, {
          driverId: input.driverId,
          amount: input.amountReceived,
          createdById: actorUserId,
          notes: input.notes,
          idempotencyKey: derivedKey,
        });

        const settlement = await tx.driver_settlements.create({
          data: {
            settlement_number: settlementNumber,
            driver_id: input.driverId,
            balance_before: cashResult.transaction.balance_before,
            amount_received: cashResult.transaction.amount,
            balance_after: cashResult.transaction.balance_after,
            payment_method_id: input.paymentMethodId,
            received_by_id: actorUserId,
            notes: input.notes,
          },
        });

        await tx.driver_cash_transactions.update({
          where: { id: cashResult.transaction.id },
          data: { settlement_id: settlement.id },
        });

        await createAuditLog(tx, {
          actorUserId,
          action: "DRIVER_SETTLEMENT_COMPLETED",
          entityType: "DRIVER_SETTLEMENT",
          entityId: settlement.id,
          newValues: {
            amountReceived: cashResult.transaction.amount.toString(),
            balanceBefore: cashResult.transaction.balance_before.toString(),
            balanceAfter: cashResult.transaction.balance_after.toString(),
          },
          metadata: {
            driverId: input.driverId,
            paymentMethodId: input.paymentMethodId,
            cashTransactionId: cashResult.transaction.id,
          },
        });

        const full = await tx.driver_settlements.findUniqueOrThrow({ where: { id: settlement.id }, include: settlementInclude });
        return toSettlementSummary(full);
      });
    } catch (error) {
      if (isSettlementNumberConflict(error)) {
        lastConflict = error;
        continue;
      }
      // Any CONFLICT here during settlement creation can only be the
      // idempotency_key race (settlementId is omitted from this debit call,
      // so settlement_id can never collide — see comment above). The
      // transaction that hit P2002 rolled back entirely, so re-query for the
      // committed winner and reconcile instead of surfacing a raw conflict —
      // the loser of a same-key concurrent race must recover the original
      // resource, not error out.
      if (error instanceof AppError && error.code === "CONFLICT") {
        const winner = await prisma.driver_cash_transactions.findUnique({ where: { idempotency_key: derivedKey } });
        if (!winner) {
          // Should be structurally impossible (P2002 means a row committed)
          // — fail closed rather than silently retry a financial op.
          throw error;
        }
        return reconcileSettlementReplay(winner, input, prisma);
      }
      throw error;
    }
  }

  console.error("[settlement.service] exhausted settlement_number generation attempts", lastConflict);
  throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Failed to generate a unique settlement number" });
}

// Minimal read surface shared by the global `prisma` client and an
// in-flight Prisma.TransactionClient — reconciliation may run either inside
// the transaction that just acquired the advisory lock, or standalone
// (the pre-check fast path; the post-P2002 defense-in-depth path, whose
// transaction already rolled back by the time it runs).
type SettlementReadClient = Pick<typeof prisma, "driver_settlements">;

// Same Idempotency-Key + same normalized request → return the original
// settlement resource (settlements have no status/lifecycle — Phase 8.6 —
// so the historical row is simply returned as-is). Same key + different
// request → 409, without ever executing or revealing internals. Comparison
// uses server-normalized PERSISTED business fields (never server-generated
// settlementNumber/id/createdAt, which a retrying client cannot know).
async function reconcileSettlementReplay(
  cashTx: { settlement_id: string | null },
  input: CreateSettlementInput,
  db: SettlementReadClient
): Promise<SettlementSummary> {
  if (!cashTx.settlement_id) {
    console.error("[settlement.service] data-integrity failure: idempotency-key-matched driver_cash_transactions row has no settlement_id");
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Settlement idempotency record is inconsistent" });
  }
  const existing = await db.driver_settlements.findUnique({ where: { id: cashTx.settlement_id }, include: settlementInclude });
  if (!existing) {
    console.error(
      `[settlement.service] data-integrity failure: driver_cash_transactions ${cashTx.settlement_id} settlement_id has no linked driver_settlements row`
    );
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Settlement idempotency record is inconsistent" });
  }

  const notesMatch = (existing.notes ?? null) === (input.notes ?? null);
  const matches =
    existing.driver_id === input.driverId &&
    existing.amount_received.equals(input.amountReceived) &&
    existing.payment_method_id === input.paymentMethodId &&
    notesMatch;

  if (!matches) {
    throw new AppError({
      statusCode: 409,
      code: "CONFLICT",
      message: "Idempotency key was already used for a different request.",
    });
  }

  return toSettlementSummary(existing);
}

// ============================================================
// GET /api/v1/driver-settlements
// ============================================================

export interface ListSettlementsResult {
  items: SettlementSummary[];
  total: number;
}

export async function listSettlements(query: ListSettlementsQuery): Promise<ListSettlementsResult> {
  const where: Prisma.driver_settlementsWhereInput = {};

  if (query.driverId) {
    where.driver_id = query.driverId;
  }
  if (query.paymentMethodId) {
    where.payment_method_id = query.paymentMethodId;
  }
  if (query.search) {
    where.OR = [
      { settlement_number: { contains: query.search, mode: "insensitive" } },
      { drivers: { driver_number: { contains: query.search, mode: "insensitive" } } },
      { drivers: { users: { first_name: { contains: query.search, mode: "insensitive" } } } },
      { drivers: { users: { last_name: { contains: query.search, mode: "insensitive" } } } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.driver_settlements.findMany({
      where,
      include: settlementInclude,
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.driver_settlements.count({ where }),
  ]);

  return { items: rows.map(toSettlementSummary), total };
}
