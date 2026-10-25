// ============================================================
// Settlement-Based Financial Release — domain service (FR.3)
//
// Contract: docs/settlement-financial-release-contract.md (§4 state
// machines, §5 algorithms, §6 locking). Business rules:
// docs/requirements.md §55. Implementation rules: CLAUDE.md §74.
//
// An ON_SETTLEMENT order's Driver Cash COLLECTION is recorded at delivery,
// but its ownership postings (customer wallet ORDER_CREDIT / company
// revenue) are deferred to a "release" that happens exactly once, when the
// collection is fully allocated through settlements (FR.4) and any
// collection-difference review is resolved (FR.5).
//
// This module is Express-independent. Every mutation takes the CALLER'S
// Prisma.TransactionClient so it commits atomically with the surrounding
// delivery / settlement / resolution — it never opens its own transaction.
//
// releaseOrder() is the ONLY code path that may post a settlement-mode
// order's wallet / company rows. It reuses the existing ledger primitives
// with the existing deterministic per-order idempotency keys, so a release
// attempted for an order that already received a legacy / immediate posting
// fails on the UNIQUE key and rolls the whole transaction back.
// ============================================================

import { Prisma } from "../../generated/prisma/client";
import type {
  FinancialReleaseMode,
  FinancialReleaseReviewStatus,
  OrderType,
  order_financial_releases,
} from "../../generated/prisma/client";
import { AppError } from "../../shared/errors/app-error";
import { createAuditLogs } from "../../shared/audit/audit.service";
import { MONEY_DECIMAL_PLACES, MONEY_MAX_VALUE } from "../orders/order-financial.schema";
import { creditWalletForOrder } from "../wallets/wallet-ledger.service";
import {
  createCompanyFinancialTransactions,
  type CompanyFinancialTransactionBatchInput,
} from "../company-finance/company-finance-ledger.service";

// ------------------------------------------------------------
// Activation setting
// ------------------------------------------------------------

// Seeded `false` by the FR.2 migration. Only the dedicated Admin activation
// workflow (FR.11) may change it — the generic settings PATCH rejects it.
export const FINANCIAL_RELEASE_ACTIVATION_SETTING_KEY = "financial_release.settlement_mode_enabled";

// Fail-safe: only the JSON boolean `true` enables settlement mode. A missing
// row or any other value means disabled (legacy immediate behavior).
export function isActivationValueEnabled(value: unknown): boolean {
  return value === true;
}

// Read INSIDE the caller's transaction with FOR SHARE, so a concurrent
// activation / deactivation (which takes FOR UPDATE on this row) is
// serialized against the delivery that reads it (contract §6, lock step 2).
export async function readSettlementModeActivation(tx: Prisma.TransactionClient): Promise<boolean> {
  const rows = await tx.$queryRaw<{ value: unknown }[]>`
    SELECT value FROM system_settings WHERE key = ${FINANCIAL_RELEASE_ACTIVATION_SETTING_KEY} FOR SHARE
  `;
  if (rows.length === 0) return false;
  const value = rows[0].value;
  if (value !== true && value !== false) {
    console.error(
      `[financial-release.service] activation setting has a non-boolean value — treated as DISABLED (legacy behavior)`
    );
  }
  return isActivationValueEnabled(value);
}

// ------------------------------------------------------------
// Driver cash position (contract §7)
// ------------------------------------------------------------

// The ONE definition of "a release that still reserves driver cash", shared
// by the locked position above and every FR.7 read (outstanding collections,
// pending settlement, under review). Requires the release alias `r`.
// A PENDING release whose COLLECTION row was reversed (possible only for
// data written before FR.6 blocked generic reversal of release-linked
// collections) no longer reserves any cash and is never repaired here.
export const PENDING_RELEASE_HOLDS_CASH = Prisma.sql`r.release_status = 'PENDING'
  AND NOT EXISTS (SELECT 1 FROM driver_cash_transactions x WHERE x.reversal_of_id = r.collection_transaction_id)`;

export interface DriverCashPosition {
  currentBalance: Prisma.Decimal;
  // Σ (collection − allocated) over the driver's PENDING releases.
  attributedOutstanding: Prisma.Decimal;
  // U = currentBalance − attributedOutstanding; never negative (500 otherwise).
  unattributed: Prisma.Decimal;
  pendingReleaseCount: number;
}

// Takes the driver's account lock (contract §6 lock step 3) and computes U.
// Every writer of allocated_amount / VOID / a driver cash debit takes this
// lock first, and a new release is only created after a delivery's account
// increment, so the result cannot move underneath the caller's transaction.
export async function lockDriverCashPosition(tx: Prisma.TransactionClient, driverId: string): Promise<DriverCashPosition> {
  const accounts = await tx.$queryRaw<{ current_balance: Prisma.Decimal }[]>`
    SELECT current_balance FROM driver_cash_accounts WHERE driver_id = ${driverId}::uuid FOR NO KEY UPDATE
  `;
  if (accounts.length === 0) {
    console.error(`[financial-release.service] data-integrity failure: driver ${driverId} has no linked driver_cash_accounts row`);
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Driver cash account is missing — action was not performed" });
  }
  const pending = await tx.$queryRaw<{ outstanding: Prisma.Decimal | null; n: number }[]>`
    SELECT COALESCE(SUM(r.collection_amount - r.allocated_amount), 0) AS outstanding, COUNT(*)::int AS n
    FROM order_financial_releases r
    WHERE r.driver_id = ${driverId}::uuid AND ${PENDING_RELEASE_HOLDS_CASH}
  `;
  const currentBalance = new Prisma.Decimal(accounts[0].current_balance);
  const attributedOutstanding = new Prisma.Decimal(pending[0]?.outstanding ?? 0);
  const unattributed = currentBalance.minus(attributedOutstanding);
  if (unattributed.isNegative()) {
    console.error(
      `[financial-release.service] data-integrity failure: driver ${driverId} cash ${currentBalance.toString()} is below its attributed outstanding ${attributedOutstanding.toString()}`
    );
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Driver cash position is inconsistent — action was not performed" });
  }
  return { currentBalance, attributedOutstanding, unattributed, pendingReleaseCount: pending[0]?.n ?? 0 };
}

// A driver cash DEBIT that is not a settlement (adjustment, reversal of a
// credit) may only consume unattributed cash — never money reserved for a
// pending settlement-mode collection (contract §7, requirements §55.8).
export function assertDebitWithinUnattributed(position: DriverCashPosition, amount: Prisma.Decimal): void {
  if (amount.greaterThan(position.unattributed)) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: `Amount exceeds the driver's unattributed cash (${position.unattributed.toString()})`,
      details: { reason: "ADJUSTMENT_EXCEEDS_UNATTRIBUTED", unattributedBalance: position.unattributed.toString() },
    });
  }
}

// ------------------------------------------------------------
// Mode decision (contract §5.1 step 4)
// ------------------------------------------------------------

export type CollectionRoute = "NONE" | "DIRECT_COMPANY" | "DRIVER_CASH";

// Decided ONCE, at delivery, and persisted on the order. Never re-derived
// later from dates or from the current setting.
//   activation off                 -> NULL (legacy immediate processing)
//   activation on + Driver Cash    -> ON_SETTLEMENT
//   activation on + bypass / zero  -> IMMEDIATE
export function decideFinancialReleaseMode(activationEnabled: boolean, route: CollectionRoute): FinancialReleaseMode | null {
  if (!activationEnabled) return null;
  return route === "DRIVER_CASH" ? "ON_SETTLEMENT" : "IMMEDIATE";
}

// ------------------------------------------------------------
// Planned ownership amounts
// ------------------------------------------------------------

export interface PlannedReleaseAmounts {
  customerWalletAmount: Prisma.Decimal;
  companyProductAmount: Prisma.Decimal;
  companyFeeAmount: Prisma.Decimal;
}

function moneyProblem(label: string, amount: Prisma.Decimal): string | null {
  if (!amount.isFinite()) return `${label} is not a valid amount`;
  if (amount.isNegative()) return `${label} must not be negative`;
  if (amount.decimalPlaces() > MONEY_DECIMAL_PLACES) return `${label} supports at most ${MONEY_DECIMAL_PLACES} decimal places`;
  if (amount.greaterThan(MONEY_MAX_VALUE)) return `${label} exceeds the supported range`;
  return null;
}

// Pure validation shared by delivery (FR.3) and difference resolution
// (FR.5). Returns every problem found; an empty list means valid. Mirrors
// the SQL CHECKs ofr_planned_values_chk / ofr_order_type_buckets_chk so a
// caller fails with a readable error before the database rejects the row.
export function plannedAmountProblems(
  orderType: OrderType,
  collectionAmount: Prisma.Decimal,
  planned: PlannedReleaseAmounts
): string[] {
  const problems = [
    moneyProblem("Customer wallet amount", planned.customerWalletAmount),
    moneyProblem("Company product amount", planned.companyProductAmount),
    moneyProblem("Company delivery fee amount", planned.companyFeeAmount),
  ].filter((p): p is string => p !== null);

  // CLAUDE.md §12/§63 — a COMPANY_ORDER never credits a wallet; a
  // DELIVERY_ONLY order never produces company product revenue.
  if (orderType === "COMPANY_ORDER" && !planned.customerWalletAmount.isZero()) {
    problems.push("A COMPANY_ORDER cannot credit a customer wallet");
  }
  if (orderType === "DELIVERY_ONLY" && !planned.companyProductAmount.isZero()) {
    problems.push("A DELIVERY_ONLY order cannot produce company product revenue");
  }

  const sum = planned.customerWalletAmount.plus(planned.companyProductAmount).plus(planned.companyFeeAmount);
  if (!sum.equals(collectionAmount)) {
    problems.push("Planned amounts must sum exactly to the collected amount");
  }
  return problems;
}

export interface ExactDeliveryAmounts {
  orderType: OrderType;
  remainingOrderAmount: Prisma.Decimal;
  remainingDeliveryFee: Prisma.Decimal;
  collectionAmount: Prisma.Decimal;
}

// Exact-collection split — the SAME ownership rule the immediate path posts
// (Phase 8.3 / 8.4): DELIVERY_ONLY -> wallet gets the remaining order amount;
// COMPANY_ORDER -> company product revenue gets it; the remaining delivery
// fee is company revenue for both. Only valid for an EXACT collection; a
// difference must never be split here (CLAUDE.md §21).
export function deriveExactPlannedAmounts(input: ExactDeliveryAmounts): PlannedReleaseAmounts {
  const zero = new Prisma.Decimal(0);
  const planned: PlannedReleaseAmounts =
    input.orderType === "DELIVERY_ONLY"
      ? { customerWalletAmount: input.remainingOrderAmount, companyProductAmount: zero, companyFeeAmount: input.remainingDeliveryFee }
      : { customerWalletAmount: zero, companyProductAmount: input.remainingOrderAmount, companyFeeAmount: input.remainingDeliveryFee };

  const problems = plannedAmountProblems(input.orderType, input.collectionAmount, planned);
  if (problems.length > 0) {
    // amount_to_collect = remaining_order_amount + remaining_delivery_fee is a
    // server-calculated invariant, so an exact collection always satisfies
    // this — a failure is corrupt order data, never silently repaired.
    console.error(`[financial-release.service] data-consistency failure deriving planned amounts: ${problems.join("; ")}`);
    throw new AppError({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Order financial amounts are inconsistent — action was not performed",
    });
  }
  return planned;
}

// ------------------------------------------------------------
// Release obligation creation (contract §5.1 step 8)
// ------------------------------------------------------------

export interface CreateOrderFinancialReleaseInput {
  orderId: string;
  customerId: string;
  driverId: string;
  collectionTransactionId: string;
  orderType: OrderType;
  deliveredAt: Date;
  collectionAmount: Prisma.Decimal;
  // null <=> collection difference awaiting review (no split is invented).
  planned: PlannedReleaseAmounts | null;
}

export async function createOrderFinancialRelease(
  tx: Prisma.TransactionClient,
  input: CreateOrderFinancialReleaseInput
): Promise<order_financial_releases> {
  const amountProblem = moneyProblem("Collection amount", input.collectionAmount);
  if (amountProblem || !input.collectionAmount.greaterThan(0)) {
    // Only a positive Driver Cash collection creates a release (zero cash is
    // IMMEDIATE) — anything else is a caller bug.
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Invalid financial release collection amount" });
  }
  if (input.planned) {
    const problems = plannedAmountProblems(input.orderType, input.collectionAmount, input.planned);
    if (problems.length > 0) {
      console.error(`[financial-release.service] rejected planned amounts for order ${input.orderId}: ${problems.join("; ")}`);
      throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Invalid planned financial release amounts" });
    }
  }
  const reviewStatus: FinancialReleaseReviewStatus = input.planned ? "NOT_REQUIRED" : "AWAITING_REVIEW";

  try {
    return await tx.order_financial_releases.create({
      data: {
        order_id: input.orderId,
        customer_id: input.customerId,
        driver_id: input.driverId,
        collection_transaction_id: input.collectionTransactionId,
        order_type: input.orderType,
        delivered_at: input.deliveredAt,
        collection_amount: input.collectionAmount,
        review_status: reviewStatus,
        planned_customer_wallet_amount: input.planned?.customerWalletAmount ?? null,
        planned_company_product_amount: input.planned?.companyProductAmount ?? null,
        planned_company_fee_amount: input.planned?.companyFeeAmount ?? null,
      },
    });
  } catch (error) {
    // UNIQUE(order_id) / UNIQUE(collection_transaction_id): one release per
    // order and per COLLECTION row. The caller's transaction rolls back.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError({ statusCode: 409, code: "CONFLICT", message: "Financial release already recorded for this order" });
    }
    throw error;
  }
}

// ------------------------------------------------------------
// Release (contract §5.3) — exported for FR.4 (settlement) and FR.5
// (difference resolution). Never exposed through a route of its own.
// ------------------------------------------------------------

export type ReleaseTrigger = { type: "SETTLEMENT"; settlementId: string } | { type: "RESOLUTION" };

export interface ReleaseOrderInput {
  releaseId: string;
  actorUserId: string;
  trigger: ReleaseTrigger;
}

export interface ReleaseOrderResult {
  releaseId: string;
  orderId: string;
  walletTransactionId: string | null;
  companyProductTransactionId: string | null;
  companyFeeTransactionId: string | null;
}

function integrityFailure(message: string, detail: string): AppError {
  console.error(`[financial-release.service] data-integrity failure: ${detail}`);
  return new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message });
}

function releaseConflict(message: string): AppError {
  return new AppError({ statusCode: 409, code: "CONFLICT", message });
}

// Lock the release row (contract §6 lock step 4). Callers that also hold the
// driver's account lock (FR.4) must take that FIRST.
export async function lockFinancialRelease(tx: Prisma.TransactionClient, releaseId: string): Promise<order_financial_releases | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM order_financial_releases WHERE id = ${releaseId}::uuid FOR NO KEY UPDATE
  `;
  if (locked.length === 0) return null;
  return tx.order_financial_releases.findUnique({ where: { id: releaseId } });
}

// Same lock as lockFinancialRelease, addressed by the order (UNIQUE
// order_id) — used by difference resolution, which starts from the order.
export async function lockFinancialReleaseByOrderId(
  tx: Prisma.TransactionClient,
  orderId: string
): Promise<order_financial_releases | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM order_financial_releases WHERE order_id = ${orderId}::uuid FOR NO KEY UPDATE
  `;
  if (locked.length === 0) return null;
  return tx.order_financial_releases.findUnique({ where: { id: locked[0].id } });
}

// The release's COLLECTION row must still be the original, unreversed
// Driver Cash collection of this order, driver and amount. A mismatch is
// corrupt data (500); a reversed collection is a business conflict (409).
export async function assertReleaseCollectionIntact(tx: Prisma.TransactionClient, release: order_financial_releases): Promise<void> {
  return assertReleaseCollectionsIntact(tx, [release]);
}

// Same check for several releases with two queries in total (FR.11A).
export async function assertReleaseCollectionsIntact(tx: Prisma.TransactionClient, releases: order_financial_releases[]): Promise<void> {
  if (releases.length === 0) return;
  const collectionIds = releases.map((r) => r.collection_transaction_id);
  const collections = new Map(
    (
      await tx.driver_cash_transactions.findMany({
        where: { id: { in: collectionIds } },
        select: { id: true, type: true, order_id: true, driver_id: true, amount: true },
      })
    ).map((c) => [c.id, c])
  );
  for (const release of releases) {
    const collection = collections.get(release.collection_transaction_id);
    if (
      !collection ||
      collection.type !== "COLLECTION" ||
      collection.order_id !== release.order_id ||
      collection.driver_id !== release.driver_id ||
      !collection.amount.equals(release.collection_amount)
    ) {
      throw integrityFailure("Financial release is inconsistent — action was not performed", `release ${release.id} does not match its COLLECTION row`);
    }
  }
  const collectionReversed = await tx.driver_cash_transactions.findFirst({
    where: { reversal_of_id: { in: collectionIds } },
    select: { id: true },
  });
  if (collectionReversed) {
    throw releaseConflict("The driver collection for this order has been reversed");
  }
}

// A posting primitive's P2002 (a row with the same deterministic key
// already exists) means this order was already posted — a historical
// legacy / immediate posting or a duplicate. Never retried, never skipped:
// the whole transaction rolls back.
async function postOrThrowIntegrity<T>(subject: string, label: string, post: () => Promise<T>): Promise<T> {
  try {
    return await post();
  } catch (error) {
    if (error instanceof AppError && error.code === "CONFLICT") {
      throw integrityFailure(
        "A financial posting already exists for this order — release was not performed",
        `release of ${subject} hit an existing ${label} posting key`
      );
    }
    throw error;
  }
}

export async function releaseOrder(tx: Prisma.TransactionClient, input: ReleaseOrderInput): Promise<ReleaseOrderResult> {
  const [result] = await releaseOrders(tx, { releaseIds: [input.releaseId], actorUserId: input.actorUserId, trigger: input.trigger });
  return result;
}

export interface ReleaseOrdersInput {
  releaseIds: string[];
  actorUserId: string;
  trigger: ReleaseTrigger;
  // The caller already holds FOR NO KEY UPDATE on every release row (lock
  // step 4) — settlement locks them in id order before it allocates.
  releaseLocksHeld?: boolean;
}

interface LockedOrderRow {
  id: string;
  status: string;
  customer_id: string;
  order_type: string;
  financial_status: string;
  financial_release_mode: string | null;
  actual_amount_collected: Prisma.Decimal | string | null;
  collection_payment_method_id: string | null;
}

const byCustomerThenId = (a: order_financial_releases, b: order_financial_releases) =>
  a.customer_id === b.customer_id ? (a.id < b.id ? -1 : 1) : a.customer_id < b.customer_id ? -1 : 1;

// The single release path (FR.11A batch form). Releasing N collections in
// one settlement uses a fixed number of statements plus the per-order
// wallet credit, instead of ~15 round trips per order; every check, key,
// lock and audit row is the same as releasing them one by one.
export async function releaseOrders(tx: Prisma.TransactionClient, input: ReleaseOrdersInput): Promise<ReleaseOrderResult[]> {
  const ids = [...new Set(input.releaseIds)].sort();
  if (ids.length === 0) return [];

  // Lock order: releases (step 4, by id) -> orders (step 5, by id) ->
  // wallets (step 6, by customer_id, inside creditWalletForOrder).
  if (!input.releaseLocksHeld) {
    await tx.$queryRaw`
      SELECT id FROM order_financial_releases WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR NO KEY UPDATE
    `;
  }
  const releases = (await tx.order_financial_releases.findMany({ where: { id: { in: ids } } })).sort(byCustomerThenId);
  if (releases.length !== ids.length) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Financial release not found" });
  }

  const plannedById = new Map<string, PlannedReleaseAmounts>();
  for (const release of releases) {
    if (release.release_status !== "PENDING") {
      throw releaseConflict("Financial release is not pending");
    }
    if (release.review_status === "AWAITING_REVIEW") {
      throw releaseConflict("Collection difference must be resolved before release");
    }
    if (!release.allocated_amount.equals(release.collection_amount)) {
      throw releaseConflict("Collection is not fully settled");
    }
    const walletAmount = release.planned_customer_wallet_amount;
    const productAmount = release.planned_company_product_amount;
    const feeAmount = release.planned_company_fee_amount;
    if (walletAmount === null || productAmount === null || feeAmount === null) {
      throw integrityFailure("Financial release is inconsistent — action was not performed", `release ${release.id} is review-cleared without planned amounts`);
    }
    const planned: PlannedReleaseAmounts = { customerWalletAmount: walletAmount, companyProductAmount: productAmount, companyFeeAmount: feeAmount };
    const plannedProblems = plannedAmountProblems(release.order_type, release.collection_amount, planned);
    if (plannedProblems.length > 0) {
      throw integrityFailure("Financial release is inconsistent — action was not performed", `release ${release.id}: ${plannedProblems.join("; ")}`);
    }
    plannedById.set(release.id, planned);
  }
  if (input.trigger.type === "SETTLEMENT") {
    const settlement = await tx.driver_settlements.findUnique({
      where: { id: input.trigger.settlementId },
      select: { driver_id: true },
    });
    for (const release of releases) {
      if (!settlement || settlement.driver_id !== release.driver_id) {
        throw integrityFailure("Financial release is inconsistent — action was not performed", `release ${release.id} triggered by a settlement of another driver`);
      }
    }
  }

  // Cross-table consistency the database does not enforce (contract
  // FR.3 dependencies) — verified here, fail closed, never repaired.
  const orderIds = releases.map((r) => r.order_id).sort();
  const lockedOrders = await tx.$queryRaw<LockedOrderRow[]>`
    SELECT id, status::text AS status, customer_id, order_type::text AS order_type,
           financial_status::text AS financial_status, financial_release_mode::text AS financial_release_mode,
           actual_amount_collected, collection_payment_method_id
    FROM orders WHERE id = ANY(${orderIds}::uuid[]) ORDER BY id FOR NO KEY UPDATE
  `;
  const orders = new Map(lockedOrders.map((o) => [o.id, o]));
  for (const release of releases) {
    const order = orders.get(release.order_id);
    const actual = order?.actual_amount_collected == null ? null : new Prisma.Decimal(order.actual_amount_collected);
    if (
      !order ||
      order.status !== "DELIVERED" ||
      order.financial_release_mode !== "ON_SETTLEMENT" ||
      order.customer_id !== release.customer_id ||
      order.order_type !== release.order_type ||
      actual === null ||
      !actual.equals(release.collection_amount)
    ) {
      throw integrityFailure("Financial release is inconsistent — action was not performed", `release ${release.id} does not match its order`);
    }
    if (order.financial_status !== "AWAITING_SETTLEMENT") {
      throw releaseConflict("Order is not awaiting settlement");
    }
  }
  await assertReleaseCollectionsIntact(tx, releases);

  // ---- postings: existing primitives, existing keys, original payment method (decision A8).
  // Wallet credits one by one in (customer_id, id) order — the ledger keeps
  // a running balance per wallet. Company rows in one INSERT.
  const postings = new Map(
    releases.map((r) => [r.id, { wallet: null as string | null, product: null as string | null, fee: null as string | null }])
  );
  const companyRows: { releaseId: string; bucket: "product" | "fee"; input: CompanyFinancialTransactionBatchInput }[] = [];
  for (const release of releases) {
    const planned = plannedById.get(release.id) as PlannedReleaseAmounts;
    const orderId = release.order_id;
    const paymentMethodId = orders.get(orderId)?.collection_payment_method_id ?? undefined;
    if (release.order_type === "DELIVERY_ONLY" && planned.customerWalletAmount.greaterThan(0)) {
      const wallet = await postOrThrowIntegrity(`order ${orderId}`, "wallet ORDER_CREDIT", () =>
        creditWalletForOrder(tx, {
          customerId: release.customer_id,
          orderId,
          amount: planned.customerWalletAmount,
          processedById: input.actorUserId,
          idempotencyKey: `delivery:${orderId}:wallet-order-credit`,
        })
      );
      (postings.get(release.id) as { wallet: string | null }).wallet = wallet.transaction.id;
    }
    if (release.order_type === "COMPANY_ORDER" && planned.companyProductAmount.greaterThan(0)) {
      companyRows.push({
        releaseId: release.id,
        bucket: "product",
        input: {
          type: "COMPANY_ORDER_PRODUCT_REVENUE",
          orderId,
          amount: planned.companyProductAmount,
          paymentMethodId,
          createdById: input.actorUserId,
          idempotencyKey: `delivery:${orderId}:company-product-revenue`,
        },
      });
    }
    if (planned.companyFeeAmount.greaterThan(0)) {
      companyRows.push({
        releaseId: release.id,
        bucket: "fee",
        input: {
          type: "DELIVERY_FEE_REVENUE",
          orderId,
          amount: planned.companyFeeAmount,
          paymentMethodId,
          createdById: input.actorUserId,
          idempotencyKey: `delivery:${orderId}:delivery-fee-revenue`,
        },
      });
    }
  }
  if (companyRows.length > 0) {
    const created = await postOrThrowIntegrity(`orders ${orderIds.join(", ")}`, "company revenue", () =>
      createCompanyFinancialTransactions(
        tx,
        companyRows.map((c) => c.input)
      )
    );
    companyRows.forEach((c, i) => {
      const p = postings.get(c.releaseId) as { product: string | null; fee: string | null };
      p[c.bucket] = created[i].id;
    });
  }

  // ---- state transitions: compare-and-set, all inside the caller's transaction.
  // Status and posting ids change in ONE update per row (ofr_posted_transactions_chk).
  const now = new Date();
  const settlementId = input.trigger.type === "SETTLEMENT" ? input.trigger.settlementId : null;
  const values = Prisma.join(
    releases.map((r) => {
      const p = postings.get(r.id) as { wallet: string | null; product: string | null; fee: string | null };
      return Prisma.sql`(${r.id}::uuid, ${p.wallet}::uuid, ${p.product}::uuid, ${p.fee}::uuid)`;
    })
  );
  const claimed = await tx.$queryRaw<{ id: string }[]>`
    UPDATE order_financial_releases AS r
    SET release_status = 'RELEASED',
        released_at = ${now},
        released_by_id = ${input.actorUserId}::uuid,
        released_by_settlement_id = ${settlementId}::uuid,
        wallet_transaction_id = v.wallet_id,
        company_product_transaction_id = v.product_id,
        company_fee_transaction_id = v.fee_id,
        updated_at = ${now}
    FROM (VALUES ${values}) AS v(id, wallet_id, product_id, fee_id)
    WHERE r.id = v.id
      AND r.release_status = 'PENDING'
      AND r.allocated_amount = r.collection_amount
      AND r.review_status <> 'AWAITING_REVIEW'
    RETURNING r.id
  `;
  if (claimed.length !== releases.length) {
    throw releaseConflict("Financial release was changed by another request — please retry");
  }
  const finalized = await tx.orders.updateMany({
    where: { id: { in: orderIds }, status: "DELIVERED", financial_release_mode: "ON_SETTLEMENT", financial_status: "AWAITING_SETTLEMENT" },
    data: { financial_status: "FINALIZED", updated_at: now },
  });
  if (finalized.count !== releases.length) {
    throw releaseConflict("Order financial state was changed by another request — please retry");
  }

  const results: ReleaseOrderResult[] = releases.map((release) => {
    const p = postings.get(release.id) as { wallet: string | null; product: string | null; fee: string | null };
    return {
      releaseId: release.id,
      orderId: release.order_id,
      walletTransactionId: p.wallet,
      companyProductTransactionId: p.product,
      companyFeeTransactionId: p.fee,
    };
  });

  await createAuditLogs(
    tx,
    releases.map((release, i) => {
      const planned = plannedById.get(release.id) as PlannedReleaseAmounts;
      return {
        actorUserId: input.actorUserId,
        action: "FINANCIAL_RELEASE_COMPLETED",
        entityType: "ORDER",
        entityId: release.order_id,
        previousValues: { financialStatus: "AWAITING_SETTLEMENT", releaseStatus: "PENDING" },
        newValues: { financialStatus: "FINALIZED", releaseStatus: "RELEASED" },
        metadata: {
          releaseId: release.id,
          trigger: input.trigger.type,
          settlementId,
          orderType: release.order_type,
          collectionAmount: release.collection_amount.toString(),
          customerWalletAmount: planned.customerWalletAmount.toString(),
          companyProductAmount: planned.companyProductAmount.toString(),
          companyFeeAmount: planned.companyFeeAmount.toString(),
          walletTransactionId: results[i].walletTransactionId,
          companyProductTransactionId: results[i].companyProductTransactionId,
          companyFeeTransactionId: results[i].companyFeeTransactionId,
        },
      };
    })
  );

  return results;
}

// ------------------------------------------------------------
// Collection-difference resolution of an ON_SETTLEMENT order (FR.5,
// contract §5.4). Called by order.service resolveCollectionDifference
// inside ITS transaction; legacy (NULL) / IMMEDIATE orders never come here.
//
// Release requires BOTH a fully allocated collection AND a resolved
// review. Resolution only records the Finance-approved split on the
// release; whichever condition is satisfied last triggers releaseOrder():
//   - not yet fully settled -> AWAITING_SETTLEMENT, nothing posted; the
//     completing settlement (FR.4) releases later.
//   - already fully settled -> releaseOrder() now, in this transaction.
//
// Lock order (contract §6): release (4) -> order (5) -> wallet (6, inside
// releaseOrder). Settlement takes the release lock before it ever reads
// review_status, so resolution and the completing settlement serialize on
// that row and exactly one of them observes both conditions satisfied.
// ------------------------------------------------------------

export interface ResolveReleaseDifferenceInput {
  orderId: string;
  actorUserId: string;
  planned: PlannedReleaseAmounts;
}

export interface ResolveReleaseDifferenceResult {
  releaseId: string;
  collectionAmount: Prisma.Decimal;
  allocatedAmount: Prisma.Decimal;
  // true <=> the collection is not fully settled yet; nothing was posted.
  deferredRelease: boolean;
  released: ReleaseOrderResult | null;
}

export async function resolveReleaseDifference(
  tx: Prisma.TransactionClient,
  input: ResolveReleaseDifferenceInput
): Promise<ResolveReleaseDifferenceResult> {
  const release = await lockFinancialReleaseByOrderId(tx, input.orderId);
  if (!release) {
    // A settlement-mode delivery always creates its release in the same
    // transaction that persists the mode.
    throw integrityFailure("Order review state is inconsistent — action was not performed", `ON_SETTLEMENT order ${input.orderId} has no financial release`);
  }
  // Terminal (VOIDED / RELEASED / RELEASE_REVERSED) or already resolved
  // releases are never resolved again.
  if (release.release_status !== "PENDING") {
    throw releaseConflict("Financial release is not pending");
  }
  if (release.review_status !== "AWAITING_REVIEW") {
    throw releaseConflict("Collection difference was already resolved by another request");
  }

  const order = await tx.orders.findUnique({
    where: { id: input.orderId },
    select: {
      status: true,
      customer_id: true,
      order_type: true,
      current_driver_id: true,
      financial_release_mode: true,
      actual_amount_collected: true,
    },
  });
  if (
    !order ||
    order.status !== "DELIVERED" ||
    order.financial_release_mode !== "ON_SETTLEMENT" ||
    order.customer_id !== release.customer_id ||
    order.order_type !== release.order_type ||
    order.current_driver_id !== release.driver_id ||
    order.actual_amount_collected === null ||
    !order.actual_amount_collected.equals(release.collection_amount)
  ) {
    throw integrityFailure("Financial release is inconsistent — action was not performed", `release ${release.id} does not match its order`);
  }
  await assertReleaseCollectionIntact(tx, release);

  const problems = plannedAmountProblems(release.order_type, release.collection_amount, input.planned);
  if (problems.length > 0) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: problems.join("; ") });
  }

  // ---- compare-and-set transitions (order, then release).
  const now = new Date();
  const claimed = await tx.orders.updateMany({
    where: {
      id: input.orderId,
      status: "DELIVERED",
      financial_release_mode: "ON_SETTLEMENT",
      financial_status: "REVIEW_REQUIRED",
      needs_financial_review: true,
    },
    data: { financial_status: "AWAITING_SETTLEMENT", needs_financial_review: false, updated_at: now },
  });
  if (claimed.count !== 1) {
    throw releaseConflict("Order review state was changed by another request — please retry");
  }
  // Planned amounts and RESOLVED are written in ONE update
  // (ofr_planned_presence_chk: planned NULL <=> AWAITING_REVIEW).
  const resolved = await tx.order_financial_releases.updateMany({
    where: { id: release.id, release_status: "PENDING", review_status: "AWAITING_REVIEW" },
    data: {
      review_status: "RESOLVED",
      planned_customer_wallet_amount: input.planned.customerWalletAmount,
      planned_company_product_amount: input.planned.companyProductAmount,
      planned_company_fee_amount: input.planned.companyFeeAmount,
      updated_at: now,
    },
  });
  if (resolved.count !== 1) {
    throw releaseConflict("Financial release was changed by another request — please retry");
  }

  const fullySettled = release.allocated_amount.equals(release.collection_amount);
  const released = fullySettled
    ? await releaseOrder(tx, { releaseId: release.id, actorUserId: input.actorUserId, trigger: { type: "RESOLUTION" } })
    : null;

  return {
    releaseId: release.id,
    collectionAmount: release.collection_amount,
    allocatedAmount: release.allocated_amount,
    deferredRelease: !fullySettled,
    released,
  };
}
