import { randomBytes } from "node:crypto";
import { Prisma } from "../../generated/prisma/client";
import type { customer_payouts, customers, payment_methods, users } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { debitWalletPayout } from "../wallets/wallet-ledger.service";
import { createAuditLog } from "../../shared/audit/audit.service";
import { deriveRequestIdempotencyKey } from "../../shared/idempotency/request-idempotency";
import type { CreatePayoutInput, ListPayoutsQuery } from "./payout.schema";
import type { PayoutSummary } from "./payout.types";

// ============================================================
// Customer Payout (Phase 8.5)
//
// A payout means: the company pays money it already owes the Customer.
// It ONLY ever changes customer_wallets/wallet_transactions (via the
// approved Phase 8.2 debitWalletPayout primitive) — never driver_cash_*
// (that would be a Driver Settlement, a different concept entirely) and
// never company_financial_transactions (a payout is not company revenue).
// ============================================================

// Identifier generation mirrors the approved order_number convention
// (Phase 6.1) exactly: node:crypto randomBytes with rejection sampling
// (never Math.random(), never SELECT MAX()+1/COUNT(*)+1 — those predictably
// collide under concurrent payouts).
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

// PAY-YYYYMMDD-XXXXXX, well within payout_number's varchar(50). No approved
// format exists in docs/requirements.md or docs/implementation_plan.md — this
// mirrors ORD-YYYYMMDD-XXXXXX (order_number) for consistency.
function generatePayoutNumber(): string {
  const utcDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `PAY-${utcDate}-${randomAlphanumeric(6)}`;
}

const MAX_IDENTIFIER_ATTEMPTS = 5;

function isPayoutNumberConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const target = error.meta?.target;
  const targetFields = Array.isArray(target) ? target : typeof target === "string" ? [target] : [];
  return targetFields.some((field) => field.includes("payout_number"));
}

// ============================================================
// DTO mapping
// ============================================================

type PayoutWithRelations = customer_payouts & {
  customers: customers;
  payment_methods: payment_methods;
  users: users;
};

const payoutInclude = {
  customers: true,
  payment_methods: true,
  users: true,
} satisfies Prisma.customer_payoutsInclude;

function toPayoutSummary(row: PayoutWithRelations): PayoutSummary {
  return {
    id: row.id,
    payoutNumber: row.payout_number,
    customer: {
      id: row.customers.id,
      customerNumber: row.customers.customer_number,
      name: row.customers.name,
      primaryPhone: row.customers.primary_phone,
    },
    amount: row.amount.toString(),
    paymentMethod: { id: row.payment_methods.id, code: row.payment_methods.code, name: row.payment_methods.name },
    processedBy: { id: row.users.id, firstName: row.users.first_name, lastName: row.users.last_name },
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// ============================================================
// POST /api/v1/payouts
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

// A payout is a Management action against money already owed to the
// Customer — an inactive Customer (deactivated portal/account access) does
// not forfeit money the company owes them, so is_active is deliberately
// never checked here. This mirrors the same established precedent already
// used by getWalletDetail (Phase 8.2) and the exact COMPANY_ORDER delivery
// path (Phase 8.4) — both explicitly keep serving/crediting an inactive
// Customer's financial data.
export async function createPayout(input: CreatePayoutInput, actorUserId: string, idempotencyKey: string): Promise<PayoutSummary> {
  const customer = await prisma.customers.findUnique({ where: { id: input.customerId } });
  if (!customer) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Customer not found" });
  }

  // Validated up front (outside the identifier retry loop below) so a bad
  // payment method fails fast without ever generating a payout_number.
  await loadActivePaymentMethod(input.paymentMethodId);

  // Phase 8.9 — request-level idempotency. The raw client Idempotency-Key
  // header is never persisted: it is derived (scoped to the authenticated
  // actor) into the SAME wallet_transactions.idempotency_key UNIQUE column
  // Phase 8.2 already uses for delivery/reversal ledger dedup — no new
  // storage. payoutId passed to debitWalletPayout below is always a fresh
  // customer_payouts UUID, so it can never collide on wallet_transactions.
  // payout_id; the only unique-constraint collision debitWalletPayout can
  // hit during a payout creation is therefore this idempotency_key.
  const derivedKey = deriveRequestIdempotencyKey("payout", actorUserId, idempotencyKey);

  // Sequential-replay fast path (also covers "client timed out, retries
  // later"). The real concurrency mutex is the UNIQUE(idempotency_key)
  // constraint handled in the catch block below — this pre-check is an
  // optimization, not the safety guarantee.
  const existingByKey = await prisma.wallet_transactions.findUnique({ where: { idempotency_key: derivedKey } });
  if (existingByKey) {
    return reconcilePayoutReplay(existingByKey, input, prisma);
  }

  // Bounded retry on payout_number collisions only — identical convention to
  // Phase 6.1's order_number/tracking_code retry. Available-balance
  // enforcement is NOT pre-checked here: it is enforced exactly once, inside
  // the transaction, by debitWalletPayout's concurrency-safe conditional
  // decrement (Phase 8.2) — a separate advisory pre-read here would be
  // redundant and could go stale under concurrent payouts.
  let lastConflict: unknown;
  for (let attempt = 0; attempt < MAX_IDENTIFIER_ATTEMPTS; attempt++) {
    const payoutNumber = generatePayoutNumber();

    try {
      return await prisma.$transaction(async (tx) => {
        // Serializes concurrent requests sharing the SAME derived key before
        // either touches the Wallet balance. Without this, two concurrent
        // identical requests each independently attempt a FULL balance
        // decrement (neither yet sees the other's not-yet-committed ledger
        // row) — if the wallet holds enough for only one debit, the loser
        // would fail closed on "insufficient balance" instead of recovering
        // the committed original, which is not an acceptable outcome for a
        // same-key replay. A Postgres advisory lock scoped to this
        // transaction (auto-released on commit/rollback, no schema
        // involved) blocks the second attempt until the first fully
        // commits or rolls back; the recheck immediately below then finds
        // the committed row and reconciles instead of re-debiting. Two
        // DIFFERENT keys hash to different lock ids and never block each
        // other (an occasional hash collision only costs a brief
        // serialization, never a correctness issue — the derived key
        // itself, not the lock id, is still what UNIQUE(idempotency_key)
        // and the reconciliation comparison rely on).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${derivedKey})::bigint)`;
        const postLockExisting = await tx.wallet_transactions.findUnique({ where: { idempotency_key: derivedKey } });
        if (postLockExisting) {
          return reconcilePayoutReplay(postLockExisting, input, tx);
        }

        const payout = await tx.customer_payouts.create({
          data: {
            payout_number: payoutNumber,
            customer_id: input.customerId,
            amount: input.amount,
            payment_method_id: input.paymentMethodId,
            status: "COMPLETED",
            processed_by_id: actorUserId,
            notes: input.notes,
          },
        });

        // Reuses the approved Phase 8.2 primitive verbatim — no second
        // Wallet balance/debit algorithm exists here. Throws a controlled
        // AppError (400 insufficient balance, or 500 if the Customer's
        // wallet is unexpectedly missing) that rolls this entire
        // transaction back, including the customer_payouts row just
        // created above. A concurrent winner of the same idempotencyKey
        // rolls back the same way (409 CONFLICT), handled below.
        const walletResult = await debitWalletPayout(tx, {
          customerId: input.customerId,
          amount: input.amount,
          payoutId: payout.id,
          paymentMethodId: input.paymentMethodId,
          processedById: actorUserId,
          notes: input.notes,
          idempotencyKey: derivedKey,
        });

        await createAuditLog(tx, {
          actorUserId,
          action: "CUSTOMER_PAYOUT_COMPLETED",
          entityType: "CUSTOMER_PAYOUT",
          entityId: payout.id,
          newValues: { status: "COMPLETED", amount: input.amount.toString() },
          metadata: {
            customerId: input.customerId,
            paymentMethodId: input.paymentMethodId,
            walletTransactionId: walletResult.transaction.id,
            balanceBefore: walletResult.transaction.balance_before.toString(),
            balanceAfter: walletResult.transaction.balance_after.toString(),
          },
        });

        const full = await tx.customer_payouts.findUniqueOrThrow({ where: { id: payout.id }, include: payoutInclude });
        return toPayoutSummary(full);
      });
    } catch (error) {
      if (isPayoutNumberConflict(error)) {
        lastConflict = error;
        continue;
      }
      // Any CONFLICT here during payout creation can only be the
      // idempotency_key race (payoutId is always a fresh UUID and can never
      // collide on wallet_transactions.payout_id — see comment above). The
      // transaction that hit P2002 rolled back entirely, so re-query for the
      // committed winner and reconcile instead of surfacing a raw conflict —
      // the loser of a same-key concurrent race must recover the original
      // resource, not error out.
      if (error instanceof AppError && error.code === "CONFLICT") {
        const winner = await prisma.wallet_transactions.findUnique({ where: { idempotency_key: derivedKey } });
        if (!winner) {
          // Should be structurally impossible (P2002 means a row committed)
          // — fail closed rather than silently retry a financial op.
          throw error;
        }
        return reconcilePayoutReplay(winner, input, prisma);
      }
      throw error;
    }
  }

  console.error("[payout.service] exhausted payout_number generation attempts", lastConflict);
  throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Failed to generate a unique payout number" });
}

// Minimal read surface shared by the global `prisma` client and an
// in-flight Prisma.TransactionClient — reconciliation may run either inside
// the transaction that just acquired the advisory lock, or standalone
// (the pre-check fast path; the post-P2002 defense-in-depth path, whose
// transaction already rolled back by the time it runs).
type PayoutReadClient = Pick<typeof prisma, "customer_payouts">;

// Same Idempotency-Key + same normalized request → return the original
// payout resource in its CURRENT state (e.g. REVERSED if it was later
// reversed — Phase 8.9 never recreates, never re-mutates). Same key +
// different request → 409, without ever executing or revealing internals.
// Comparison uses server-normalized PERSISTED business fields (never
// server-generated payoutNumber/id/createdAt, which a retrying client
// cannot know).
async function reconcilePayoutReplay(
  walletTx: { payout_id: string | null },
  input: CreatePayoutInput,
  db: PayoutReadClient
): Promise<PayoutSummary> {
  if (!walletTx.payout_id) {
    console.error("[payout.service] data-integrity failure: idempotency-key-matched wallet_transactions row has no payout_id");
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Payout idempotency record is inconsistent" });
  }
  const existing = await db.customer_payouts.findUnique({ where: { id: walletTx.payout_id }, include: payoutInclude });
  if (!existing) {
    console.error(
      `[payout.service] data-integrity failure: wallet_transactions ${walletTx.payout_id} payout_id has no linked customer_payouts row`
    );
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Payout idempotency record is inconsistent" });
  }

  const notesMatch = (existing.notes ?? null) === (input.notes ?? null);
  const matches =
    existing.customer_id === input.customerId &&
    existing.amount.equals(input.amount) &&
    existing.payment_method_id === input.paymentMethodId &&
    notesMatch;

  if (!matches) {
    throw new AppError({
      statusCode: 409,
      code: "CONFLICT",
      message: "Idempotency key was already used for a different request.",
    });
  }

  return toPayoutSummary(existing);
}

// ============================================================
// GET /api/v1/payouts
// ============================================================

export interface ListPayoutsResult {
  items: PayoutSummary[];
  total: number;
}

export async function listPayouts(query: ListPayoutsQuery): Promise<ListPayoutsResult> {
  const where: Prisma.customer_payoutsWhereInput = {};

  if (query.customerId) {
    where.customer_id = query.customerId;
  }
  if (query.status) {
    where.status = query.status;
  }
  if (query.paymentMethodId) {
    where.payment_method_id = query.paymentMethodId;
  }
  if (query.search) {
    where.OR = [
      { payout_number: { contains: query.search, mode: "insensitive" } },
      { customers: { customer_number: { contains: query.search, mode: "insensitive" } } },
      { customers: { name: { contains: query.search, mode: "insensitive" } } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.customer_payouts.findMany({
      where,
      include: payoutInclude,
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.customer_payouts.count({ where }),
  ]);

  return { items: rows.map(toPayoutSummary), total };
}
