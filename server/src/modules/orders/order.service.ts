import { randomBytes } from "node:crypto";
import { Prisma } from "../../generated/prisma/client";
import type {
  areas,
  customers,
  delivery_attempts,
  drivers,
  failed_delivery_reasons,
  order_assignments,
  order_status_history,
  orders,
  payment_methods,
  users,
} from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { nextUtcDay, parseUtcCalendarDate } from "../../shared/date/day-boundary";
import { calculateCollectionDifference, calculateOrderFinancials, validatePaymentTypeConsistency } from "./order-financial.service";
import { creditWalletForOrder } from "../wallets/wallet-ledger.service";
import { recordCompanyOrderProductRevenue, recordDeliveryFeeRevenue } from "../company-finance/company-finance-ledger.service";
import { createAuditLog } from "../../shared/audit/audit.service";
import { assertDriverEligibleForAssignment, loadEligibleDriverForAssignment } from "../drivers/driver-eligibility";
import {
  assertConsistentCurrentParcelCollectionAssignment,
  assignParcelCollectionDriverTx,
} from "../parcel-collection/parcel-collection.service";
import {
  ORDER_INITIAL_ASSIGNMENT_STATUSES,
  PARCEL_NOT_READY_FOR_DELIVERY_MESSAGE,
  isParcelReadyForDelivery,
} from "./order-lifecycle";
import { buildWorkflowQueueWhere } from "./order-workflow-queue";
import type { OrderCreateFoundationInput } from "./order-create.schema";
import type { ListOrdersQuery, OrderUpdateInput, ResolveCollectionDifferenceInput } from "./order.schema";
import type {
  BulkAssignResult,
  DeliveryAttemptEntry,
  OrderAssignmentHistoryEntry,
  OrderDetail,
  OrderFinancialAllocation,
  OrderFinancialEvent,
  OrderFinancialEventLedger,
  OrderHistoryResponse,
  OrderStatusHistoryEntry,
  OrderSummary,
} from "./order.types";

// ============================================================
// Identifier generation (approved V1 convention, Phase 6.1 cleanup report):
//   order_number:  ORD-YYYYMMDD-XXXXXX   (<= varchar(50))
//   tracking_code: TRK-XXXXXXXXXXXX      (<= varchar(100))
// X is cryptographically-random uppercase alphanumeric data, generated via
// node:crypto randomBytes — never Math.random(), never SELECT MAX()+1.
// The date portion always uses the UTC calendar date (Date#toISOString is
// timezone-independent), never the server machine's local timezone.
// ============================================================

const IDENTIFIER_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
// Largest multiple of the alphabet length that fits in a byte (252 = 7*36) —
// bytes >= this are rejected so every kept byte maps onto the alphabet with
// exactly equal probability (no modulo bias).
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

function generateOrderNumber(): string {
  const utcDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `ORD-${utcDate}-${randomAlphanumeric(6)}`;
}

function generateTrackingCode(): string {
  return `TRK-${randomAlphanumeric(12)}`;
}

const MAX_IDENTIFIER_ATTEMPTS = 5;

function isIdentifierConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const target = error.meta?.target;
  const targetFields = Array.isArray(target) ? target : typeof target === "string" ? [target] : [];
  return targetFields.some((field) => field.includes("order_number") || field.includes("tracking_code"));
}

// ============================================================
// DTO mapping
// ============================================================

type OrderWithRelations = orders & {
  customers: customers;
  payment_methods_orders_prepaid_payment_method_idTopayment_methods: payment_methods | null;
  payment_methods_orders_collection_payment_method_idTopayment_methods: payment_methods | null;
  drivers: drivers | null;
};

type StatusHistoryWithActor = order_status_history & { users: users };

function toStatusHistoryEntry(row: StatusHistoryWithActor): OrderStatusHistoryEntry {
  return {
    id: row.id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    changedBy: { id: row.users.id, firstName: row.users.first_name, lastName: row.users.last_name },
    reason: row.reason,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
  };
}

const statusHistoryInclude = { users: true } satisfies Prisma.order_status_historyInclude;

async function loadStatusHistory(tx: Prisma.TransactionClient, orderId: string): Promise<StatusHistoryWithActor[]> {
  return tx.order_status_history.findMany({
    where: { order_id: orderId },
    include: statusHistoryInclude,
    // Oldest-first, matching the timeline example in requirements.md §39.
    orderBy: { created_at: "asc" },
  });
}

type AssignmentWithRelations = order_assignments & { drivers: drivers & { users: users }; users: users };

function toAssignmentHistoryEntry(row: AssignmentWithRelations): OrderAssignmentHistoryEntry {
  return {
    id: row.id,
    driver: {
      id: row.drivers.id,
      driverNumber: row.drivers.driver_number,
      user: {
        firstName: row.drivers.users.first_name,
        lastName: row.drivers.users.last_name,
        phone: row.drivers.users.phone,
      },
    },
    assignedBy: { id: row.users.id, firstName: row.users.first_name, lastName: row.users.last_name },
    assignedAt: row.assigned_at.toISOString(),
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    endReason: row.end_reason,
    isCurrent: row.is_current,
  };
}

const assignmentHistoryInclude = {
  drivers: { include: { users: true } },
  users: true,
} satisfies Prisma.order_assignmentsInclude;

async function loadAssignmentHistory(tx: Prisma.TransactionClient, orderId: string): Promise<AssignmentWithRelations[]> {
  return tx.order_assignments.findMany({
    where: { order_id: orderId },
    include: assignmentHistoryInclude,
    // Oldest-first, same convention as statusHistory.
    orderBy: { assigned_at: "asc" },
  });
}

type DeliveryAttemptWithRelations = delivery_attempts & {
  drivers: drivers & { users: users };
  failed_delivery_reasons: failed_delivery_reasons | null;
};

function toDeliveryAttemptEntry(row: DeliveryAttemptWithRelations): DeliveryAttemptEntry {
  return {
    id: row.id,
    attemptNumber: row.attempt_number,
    driver: {
      id: row.drivers.id,
      driverNumber: row.drivers.driver_number,
      user: {
        firstName: row.drivers.users.first_name,
        lastName: row.drivers.users.last_name,
        phone: row.drivers.users.phone,
      },
    },
    expectedCollection: row.expected_collection.toString(),
    actualCollection: row.actual_collection ? row.actual_collection.toString() : null,
    outcome: row.outcome,
    failedReason: row.failed_delivery_reasons
      ? { id: row.failed_delivery_reasons.id, name: row.failed_delivery_reasons.name }
      : null,
    notes: row.notes,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

const deliveryAttemptInclude = {
  drivers: { include: { users: true } },
  failed_delivery_reasons: true,
} satisfies Prisma.delivery_attemptsInclude;

async function loadDeliveryAttempts(tx: Prisma.TransactionClient, orderId: string): Promise<DeliveryAttemptWithRelations[]> {
  return tx.delivery_attempts.findMany({
    where: { order_id: orderId },
    include: deliveryAttemptInclude,
    // attemptNumber ascending — deterministic chronological order (also
    // matches MAX(attempt_number)+1 allocation in Phase 7.4's /fail).
    orderBy: { attempt_number: "asc" },
  });
}

// ============================================================
// Authoritative per-Order financial allocation + events (Phase 11.5
// correction). Both read ONLY order_id-scoped ledger rows — never derived
// from orderType/amountToCollect. The ledger sign conventions reused here
// are the exact ones finance-summary.service.ts / dashboard.service.ts
// already established:
//   - company_financial_transactions.amount is SIGNED (REVERSAL = negated
//     original) -> plain SUM(amount) nets correctly
//   - wallet_transactions.credit/debit are POSITIVE MAGNITUDES -> net is
//     SUM(credit - debit); a REVERSAL of an ORDER_CREDIT copies the
//     original's order_id and posts a DEBIT, so it subtracts here
//   - driver_cash rows are NOT part of company/wallet allocation (mandatory
//     Customer Wallet != Driver Cash != Company Revenue invariant) — they
//     appear only as financial EVENTS ("Amount collected"), never in the
//     allocation totals
// ============================================================

const FINANCIAL_EVENT_ACTOR_SELECT = { select: { id: true, first_name: true, last_name: true } } as const;

async function loadOrderFinancialAllocation(
  client: Prisma.TransactionClient,
  orderId: string
): Promise<OrderFinancialAllocation> {
  const walletAgg = await client.wallet_transactions.aggregate({
    where: { order_id: orderId },
    _sum: { credit: true, debit: true },
  });
  const companyAgg = await client.company_financial_transactions.aggregate({
    where: { order_id: orderId },
    _sum: { amount: true },
  });

  const walletCredit = walletAgg._sum.credit ?? new Prisma.Decimal(0);
  const walletDebit = walletAgg._sum.debit ?? new Prisma.Decimal(0);
  const companyAmount = companyAgg._sum.amount ?? new Prisma.Decimal(0);

  return {
    companyAmount: companyAmount.toString(),
    customerWalletAmount: walletCredit.minus(walletDebit).toString(),
  };
}

function toFinancialEventActor(
  user: { id: string; first_name: string; last_name: string } | null
): OrderFinancialEvent["actor"] {
  return user ? { id: user.id, firstName: user.first_name, lastName: user.last_name } : null;
}

const FINANCIAL_EVENT_LEDGER_ORDER: Record<OrderFinancialEventLedger, number> = {
  DRIVER_CASH: 0,
  WALLET: 1,
  COMPANY_FINANCE: 2,
};

async function loadOrderFinancialEvents(
  client: Prisma.TransactionClient,
  orderId: string
): Promise<OrderFinancialEvent[]> {
  const cashRows = await client.driver_cash_transactions.findMany({
    where: { order_id: orderId },
    select: {
      id: true,
      type: true,
      amount: true,
      balance_before: true,
      balance_after: true,
      notes: true,
      created_at: true,
      users: FINANCIAL_EVENT_ACTOR_SELECT,
    },
    orderBy: { created_at: "asc" },
  });
  const walletRows = await client.wallet_transactions.findMany({
    where: { order_id: orderId },
    select: {
      id: true,
      type: true,
      credit: true,
      debit: true,
      notes: true,
      created_at: true,
      users: FINANCIAL_EVENT_ACTOR_SELECT,
    },
    orderBy: { created_at: "asc" },
  });
  const companyRows = await client.company_financial_transactions.findMany({
    where: { order_id: orderId },
    select: {
      id: true,
      type: true,
      amount: true,
      notes: true,
      created_at: true,
      users: FINANCIAL_EVENT_ACTOR_SELECT,
    },
    orderBy: { created_at: "asc" },
  });

  const wrapped: { event: OrderFinancialEvent; at: number; ledgerRank: number }[] = [];

  for (const row of cashRows) {
    // Driver Cash stores a positive magnitude + expresses direction via the
    // balance delta (Phase 8.1). Never a stored negative amount.
    const signed = row.balance_after.minus(row.balance_before);
    wrapped.push({
      event: {
        id: row.id,
        ledger: "DRIVER_CASH",
        type: row.type,
        direction: signed.isNegative() ? "DEBIT" : "CREDIT",
        amount: row.amount.toString(),
        signedAmount: signed.toString(),
        actor: toFinancialEventActor(row.users),
        notes: row.notes,
        occurredAt: row.created_at.toISOString(),
      },
      at: row.created_at.getTime(),
      ledgerRank: FINANCIAL_EVENT_LEDGER_ORDER.DRIVER_CASH,
    });
  }
  for (const row of walletRows) {
    const signed = row.credit.minus(row.debit);
    wrapped.push({
      event: {
        id: row.id,
        ledger: "WALLET",
        type: row.type,
        direction: signed.isNegative() ? "DEBIT" : "CREDIT",
        amount: signed.abs().toString(),
        signedAmount: signed.toString(),
        actor: toFinancialEventActor(row.users),
        notes: row.notes,
        occurredAt: row.created_at.toISOString(),
      },
      at: row.created_at.getTime(),
      ledgerRank: FINANCIAL_EVENT_LEDGER_ORDER.WALLET,
    });
  }
  for (const row of companyRows) {
    // company_financial_transactions.amount is already SIGNED.
    const signed = row.amount;
    wrapped.push({
      event: {
        id: row.id,
        ledger: "COMPANY_FINANCE",
        type: row.type,
        direction: signed.isNegative() ? "DEBIT" : "CREDIT",
        amount: signed.abs().toString(),
        signedAmount: signed.toString(),
        actor: toFinancialEventActor(row.users),
        notes: row.notes,
        occurredAt: row.created_at.toISOString(),
      },
      at: row.created_at.getTime(),
      ledgerRank: FINANCIAL_EVENT_LEDGER_ORDER.COMPANY_FINANCE,
    });
  }

  // Oldest-first (matches every other Order history array). Deterministic
  // tie-break for identical timestamps: ledger order (cash -> wallet ->
  // company, roughly the /deliver posting sequence), then id.
  wrapped.sort(
    (a, b) =>
      a.at - b.at ||
      a.ledgerRank - b.ledgerRank ||
      (a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0)
  );

  return wrapped.map((w) => w.event);
}

// Assembles a full OrderDetail: the rich order row + the five history/
// financial collections. Used by every endpoint that returns an OrderDetail
// EXCEPT createOrder (a brand-new Order provably has none of these). `client`
// may be the base prisma client (getOrderById) or an open transaction client
// (every mutation) — the load helpers accept both.
async function assembleOrderDetail(
  client: Prisma.TransactionClient,
  order: OrderWithRelations
): Promise<OrderDetail> {
  const statusHistory = await loadStatusHistory(client, order.id);
  const assignmentHistory = await loadAssignmentHistory(client, order.id);
  const deliveryAttempts = await loadDeliveryAttempts(client, order.id);
  const financialAllocation = await loadOrderFinancialAllocation(client, order.id);
  const financialEvents = await loadOrderFinancialEvents(client, order.id);
  return toOrderDetail(order, statusHistory, assignmentHistory, deliveryAttempts, financialAllocation, financialEvents);
}

function toOrderDetail(
  order: OrderWithRelations,
  statusHistory: StatusHistoryWithActor[],
  assignmentHistory: AssignmentWithRelations[],
  deliveryAttempts: DeliveryAttemptWithRelations[],
  financialAllocation: OrderFinancialAllocation,
  financialEvents: OrderFinancialEvent[]
): OrderDetail {
  const prepaidMethod = order.payment_methods_orders_prepaid_payment_method_idTopayment_methods;
  const collectionMethod = order.payment_methods_orders_collection_payment_method_idTopayment_methods;

  return {
    id: order.id,
    orderNumber: order.order_number,
    trackingCode: order.tracking_code,
    orderType: order.order_type,
    paymentType: order.payment_type,
    status: order.status,
    financialStatus: order.financial_status,

    parcelIntakeMethod: order.parcel_intake_method,
    parcelCollectionStatus: order.parcel_collection_status,

    customer: {
      id: order.customers.id,
      customerNumber: order.customers.customer_number,
      name: order.customers.name,
      primaryPhone: order.customers.primary_phone,
      isActive: order.customers.is_active,
    },

    receiver: {
      name: order.receiver_name,
      phone: order.receiver_phone,
      altPhone: order.receiver_alt_phone,
      areaId: order.receiver_area_id,
      area: order.receiver_area,
      address: order.receiver_address,
      buildingFloor: order.receiver_building_floor,
      mapLink: order.receiver_map_link,
      instructions: order.receiver_instructions,
    },

    package: {
      description: order.description,
      packageCount: order.package_count,
      quantity: order.quantity,
      weightKg: order.weight_kg ? order.weight_kg.toString() : null,
      notes: order.package_notes,
    },

    financial: {
      orderAmount: order.order_amount.toString(),
      deliveryFee: order.delivery_fee.toString(),
      prepaidOrderAmount: order.prepaid_order_amount.toString(),
      prepaidDeliveryFee: order.prepaid_delivery_fee.toString(),
      remainingOrderAmount: order.remaining_order_amount.toString(),
      remainingDeliveryFee: order.remaining_delivery_fee.toString(),
      amountToCollect: order.amount_to_collect.toString(),
      actualAmountCollected: order.actual_amount_collected ? order.actual_amount_collected.toString() : null,
      collectionDifferenceReason: order.collection_difference_reason,
      needsFinancialReview: order.needs_financial_review,
    },

    financialAllocation,

    prepaidPaymentMethod: prepaidMethod
      ? { id: prepaidMethod.id, code: prepaidMethod.code, name: prepaidMethod.name }
      : null,
    collectionPaymentMethod: collectionMethod
      ? { id: collectionMethod.id, code: collectionMethod.code, name: collectionMethod.name }
      : null,

    currentDriver: order.drivers
      ? { id: order.drivers.id, driverNumber: order.drivers.driver_number, isActive: order.drivers.is_active }
      : null,

    createdAt: order.created_at.toISOString(),
    updatedAt: order.updated_at.toISOString(),
    assignedAt: order.assigned_at ? order.assigned_at.toISOString() : null,
    pickedUpAt: order.picked_up_at ? order.picked_up_at.toISOString() : null,
    outForDeliveryAt: order.out_for_delivery_at ? order.out_for_delivery_at.toISOString() : null,
    deliveredAt: order.delivered_at ? order.delivered_at.toISOString() : null,
    cancelledAt: order.cancelled_at ? order.cancelled_at.toISOString() : null,

    statusHistory: statusHistory.map(toStatusHistoryEntry),
    assignmentHistory: assignmentHistory.map(toAssignmentHistoryEntry),
    deliveryAttempts: deliveryAttempts.map(toDeliveryAttemptEntry),
    financialEvents,
  };
}

const orderDetailInclude = {
  customers: true,
  payment_methods_orders_prepaid_payment_method_idTopayment_methods: true,
  payment_methods_orders_collection_payment_method_idTopayment_methods: true,
  drivers: true,
} satisfies Prisma.ordersInclude;

// ============================================================
// List DTO mapping (Phase 6.3) — a dedicated, deliberately narrow `select`
// (not the rich orderDetailInclude above) so the list endpoint never loads
// receiver instructions/package notes/payment-method objects/history.
// ============================================================

export const orderSummarySelect = {
  id: true,
  order_number: true,
  tracking_code: true,
  order_type: true,
  status: true,
  financial_status: true,
  payment_type: true,
  parcel_intake_method: true,
  parcel_collection_status: true,
  receiver_name: true,
  receiver_phone: true,
  receiver_area: true,
  order_amount: true,
  delivery_fee: true,
  amount_to_collect: true,
  actual_amount_collected: true,
  needs_financial_review: true,
  created_at: true,
  assigned_at: true,
  delivered_at: true,
  customers: {
    select: { id: true, customer_number: true, name: true, primary_phone: true },
  },
  drivers: {
    select: {
      id: true,
      driver_number: true,
      users: { select: { first_name: true, last_name: true, phone: true } },
    },
  },
  // Current COLLECTION driver (Phase 11.17.6 — task §9). `drivers` above
  // remains the FINAL DELIVERY driver only; this is a distinct relation on
  // orders.current_parcel_collection_driver_id. One extra join on the same
  // paginated query — no N+1.
  current_parcel_collection_driver: {
    select: {
      id: true,
      driver_number: true,
      users: { select: { first_name: true, last_name: true, phone: true } },
    },
  },
} satisfies Prisma.ordersSelect;

export type OrderSummaryRow = Prisma.ordersGetPayload<{ select: typeof orderSummarySelect }>;

export function toOrderSummary(row: OrderSummaryRow): OrderSummary {
  return {
    id: row.id,
    orderNumber: row.order_number,
    trackingCode: row.tracking_code,
    orderType: row.order_type,
    status: row.status,
    financialStatus: row.financial_status,
    paymentType: row.payment_type,
    parcelIntakeMethod: row.parcel_intake_method,
    parcelCollectionStatus: row.parcel_collection_status,

    customer: {
      id: row.customers.id,
      customerNumber: row.customers.customer_number,
      name: row.customers.name,
      primaryPhone: row.customers.primary_phone,
    },

    receiverName: row.receiver_name,
    receiverPhone: row.receiver_phone,
    receiverArea: row.receiver_area,

    orderAmount: row.order_amount.toString(),
    deliveryFee: row.delivery_fee.toString(),
    amountToCollect: row.amount_to_collect.toString(),
    actualAmountCollected: row.actual_amount_collected ? row.actual_amount_collected.toString() : null,
    needsFinancialReview: row.needs_financial_review,

    currentDriver: row.drivers
      ? {
          id: row.drivers.id,
          driverNumber: row.drivers.driver_number,
          user: {
            firstName: row.drivers.users.first_name,
            lastName: row.drivers.users.last_name,
            phone: row.drivers.users.phone,
          },
        }
      : null,

    currentCollectionDriver: row.current_parcel_collection_driver
      ? {
          id: row.current_parcel_collection_driver.id,
          driverNumber: row.current_parcel_collection_driver.driver_number,
          user: {
            firstName: row.current_parcel_collection_driver.users.first_name,
            lastName: row.current_parcel_collection_driver.users.last_name,
            phone: row.current_parcel_collection_driver.users.phone,
          },
        }
      : null,

    createdAt: row.created_at.toISOString(),
    assignedAt: row.assigned_at ? row.assigned_at.toISOString() : null,
    deliveredAt: row.delivered_at ? row.delivered_at.toISOString() : null,
  };
}

// ============================================================
// Reference validation (entity existence + active state). Deliberately
// separate from the pure Phase 6.1 financial functions, which never touch
// the database — see order-financial.service.ts.
//
// Error-code convention (matches the existing Phase 5.1 pattern of mapping
// an invalid FK reference to 400 VALIDATION_ERROR, e.g. Customer.default_area_id):
//   Customer not found       -> 404 NOT_FOUND   (the order's primary subject)
//   Area / Payment Method
//     not found or inactive  -> 400 VALIDATION_ERROR (secondary references)
// ============================================================

async function loadActiveCustomer(customerId: string): Promise<customers> {
  const customer = await prisma.customers.findUnique({ where: { id: customerId } });
  if (!customer) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Customer not found" });
  }
  if (!customer.is_active) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "Orders cannot be created for an inactive customer",
    });
  }
  return customer;
}

async function loadActiveArea(areaId: string): Promise<areas> {
  const area = await prisma.areas.findUnique({ where: { id: areaId } });
  if (!area) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "The specified area does not exist" });
  }
  if (!area.is_active) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "The specified area is not active" });
  }
  return area;
}

async function loadActivePaymentMethod(paymentMethodId: string, field: string): Promise<payment_methods> {
  const method = await prisma.payment_methods.findUnique({ where: { id: paymentMethodId } });
  if (!method) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: `The specified ${field} does not exist` });
  }
  if (!method.is_active) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: `The specified ${field} is not active` });
  }
  return method;
}

// Assignment eligibility (Phase 6.5): a Driver must be operationally
// active AND have an active login account to receive a NEW assignment.
// drivers.user_id is a required (NOT NULL) FK, so "linked users row
// exists" is already structurally guaranteed by the schema — only the two
// is_active flags need checking here. Never activates/modifies the Driver
// or User; a rejection here changes nothing.
function toAssignmentDriverSummary(driver: drivers & { users: users }) {
  return {
    id: driver.id,
    driverNumber: driver.driver_number,
    user: { firstName: driver.users.first_name, lastName: driver.users.last_name, phone: driver.users.phone },
  };
}

// Delivery-readiness gate (Phase 11.17.4) — PARCEL_NOT_READY_FOR_DELIVERY_MESSAGE
// and isParcelReadyForDelivery now live in order-lifecycle.ts (Phase 11.17.6
// correction, imported at the top of this file) so order-workflow-queue.ts /
// dashboard.service.ts / order-report.service.ts can share the exact same
// predicate instead of a second, possibly-inconsistent copy.

// Transaction-aware final-Delivery assignment — used by createOrder's
// "Create & Assign" path. The standalone assignOrder() keeps its own
// (identical-shape) body; this is not a refactor of Phase 6.5. The
// parcel_collection_status = RECEIVED_AT_COMPANY guard is inside the
// conditional claim, so a concurrent parcel-collection change cannot slip a
// delivery assignment through.
async function assignDeliveryDriverTx(
  tx: Prisma.TransactionClient,
  params: { orderId: string; driverId: string; actorUserId: string; fromStatus: "RECEIVED" | "READY_FOR_PICKUP"; now: Date },
): Promise<void> {
  const { orderId, driverId, actorUserId, fromStatus, now } = params;
  // Authoritative driver eligibility — inside `tx`, immediately before the
  // claim, so a driver deactivated after the create-path pre-check cannot be
  // assigned at commit (no TOCTOU — Phase 11.17.4 correction).
  await assertDriverEligibleForAssignment(tx, driverId);
  const claim = await tx.orders.updateMany({
    where: {
      id: orderId,
      current_driver_id: null,
      status: fromStatus,
      parcel_collection_status: "RECEIVED_AT_COMPANY",
    },
    data: { current_driver_id: driverId, assigned_at: now, status: "ASSIGNED", updated_at: now },
  });
  if (claim.count !== 1) {
    throw new AppError({ statusCode: 409, code: "CONFLICT", message: PARCEL_NOT_READY_FOR_DELIVERY_MESSAGE });
  }
  await tx.order_assignments.create({
    data: {
      order_id: orderId,
      driver_id: driverId,
      assigned_by_id: actorUserId,
      assigned_at: now,
      ended_at: null,
      end_reason: null,
      is_current: true,
    },
  });
  await tx.order_status_history.create({
    data: { order_id: orderId, from_status: fromStatus, to_status: "ASSIGNED", changed_by_id: actorUserId },
  });
}

// ============================================================
// Create
// ============================================================

interface ResolvedParcelIntakeFields {
  parcel_intake_method: "ALREADY_AT_COMPANY" | "DRIVER_COLLECTION";
  parcel_collection_status: "AWAITING_ASSIGNMENT" | "RECEIVED_AT_COMPANY";
  received_at_company_at?: Date;
  received_at_company_by_id?: string;
  parcel_collection_contact_name?: string;
  parcel_collection_phone?: string;
  parcel_collection_alt_phone?: string | null;
  parcel_collection_area_id?: string;
  parcel_collection_area?: string | null;
  parcel_collection_address?: string;
  parcel_collection_notes?: string | null;
}

interface ResolvedParcelIntake {
  fields: ResolvedParcelIntakeFields;
  collectionDriverId: string | null;
  deliveryDriverId: string | null;
}

async function resolveParcelIntake(
  input: OrderCreateFoundationInput,
  customer: customers,
  actorUserId: string,
  now: Date,
): Promise<ResolvedParcelIntake> {
  // Phase 11.17.4 backward compatibility: an omitted parcelIntakeMethod (old
  // frontend) is resolved to ALREADY_AT_COMPANY at THIS layer — never a DB
  // default, never DRIVER_COLLECTION. Phase 11.17.5 makes the client explicit.
  const intakeMethod = input.parcelIntakeMethod ?? "ALREADY_AT_COMPANY";

  if (intakeMethod === "ALREADY_AT_COMPANY") {
    // The schema already rejects parcelCollectionDriverId / snapshot overrides
    // for this method; the parcel is considered received the moment the order
    // is recorded (§8/§9 — received_at_company_at IS the creation moment).
    return {
      fields: {
        parcel_intake_method: "ALREADY_AT_COMPANY",
        parcel_collection_status: "RECEIVED_AT_COMPANY",
        received_at_company_at: now,
        received_at_company_by_id: actorUserId,
      },
      collectionDriverId: null,
      deliveryDriverId: input.deliveryDriverId ?? null,
    };
  }

  // DRIVER_COLLECTION — resolve the collection snapshot: request override wins
  // over the Customer default; the result is a historical Order snapshot that
  // later Customer edits never rewrite.
  const contactName = input.parcelCollectionContactName ?? customer.name;
  const phone = input.parcelCollectionPhone ?? customer.primary_phone;
  const altPhone = input.parcelCollectionAltPhone ?? customer.secondary_phone ?? null;
  const address = input.parcelCollectionAddress ?? customer.default_address ?? null;
  const notes = input.parcelCollectionNotes ?? null;
  const collectionAreaId = input.parcelCollectionAreaId ?? customer.default_area_id ?? null;

  let collectionAreaName: string | null = null;
  if (collectionAreaId) {
    const collectionArea = await loadActiveArea(collectionAreaId);
    collectionAreaName = collectionArea.name;
  }

  // §13 — the minimum operational fields a Driver needs to actually collect.
  // Area is required because the rest of the system requires an Area for
  // location workflows (receiver_area_id is required on every Order).
  if (!contactName || !phone || !address || !collectionAreaId) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message:
        "A collection contact, phone, address and area are required for a driver-collection order — " +
        "the selected customer's saved data does not provide them and no override was given",
    });
  }

  return {
    fields: {
      parcel_intake_method: "DRIVER_COLLECTION",
      // Always created AWAITING_ASSIGNMENT; assignParcelCollectionDriverTx
      // flips it to ASSIGNED in the same transaction when a driver is chosen.
      parcel_collection_status: "AWAITING_ASSIGNMENT",
      parcel_collection_contact_name: contactName,
      parcel_collection_phone: phone,
      parcel_collection_alt_phone: altPhone,
      parcel_collection_area_id: collectionAreaId,
      parcel_collection_area: collectionAreaName,
      parcel_collection_address: address,
      parcel_collection_notes: notes,
      // received_at_company_* / parcel_collected_from_sender_at stay NULL.
    },
    collectionDriverId: input.parcelCollectionDriverId ?? null,
    deliveryDriverId: null, // schema forbids a delivery driver for DRIVER_COLLECTION at create
  };
}

export async function createOrder(input: OrderCreateFoundationInput, actorUserId: string): Promise<OrderDetail> {
  // 1. Customer — must exist and be active (CLAUDE.md-locked V1 rule: no
  // new Orders for inactive Customers; historical Orders are unaffected).
  const customer = await loadActiveCustomer(input.customerId);

  // 2. Receiver Area — must exist and be active. receiver_area (the
  // snapshot) is ALWAYS derived from area.name here, never from client text
  // (OrderCreateFoundationSchema does not even accept a receiverArea field).
  const area = await loadActiveArea(input.receiverAreaId);

  // 3. Financial calculation + payment-type consistency — reuse Phase 6.1
  // exactly, never reimplemented here.
  const financials = calculateOrderFinancials({
    orderAmount: input.orderAmount,
    deliveryFee: input.deliveryFee,
    prepaidOrderAmount: input.prepaidOrderAmount,
    prepaidDeliveryFee: input.prepaidDeliveryFee,
  });
  validatePaymentTypeConsistency(input.paymentType, financials);

  // 4. Payment methods — OrderCreateFoundationSchema's superRefine already
  // guarantees presence/absence is consistent with the prepaid total and
  // amountToCollect; only DB existence + active state remain to check here.
  if (input.prepaidPaymentMethodId) {
    await loadActivePaymentMethod(input.prepaidPaymentMethodId, "prepaid payment method");
  }
  if (input.collectionPaymentMethodId) {
    await loadActivePaymentMethod(input.collectionPaymentMethodId, "collection payment method");
  }

  // 4b. Parcel Intake (Phase 11.17.4) — resolve method + collection snapshot,
  // and pre-validate any driver eligibility OUTSIDE the transaction so a bad
  // driver fails before an Order row is ever created (no rollback needed).
  const now = new Date();
  const parcel = await resolveParcelIntake(input, customer, actorUserId, now);
  if (parcel.collectionDriverId) {
    await loadEligibleDriverForAssignment(parcel.collectionDriverId);
  }
  if (parcel.deliveryDriverId) {
    await loadEligibleDriverForAssignment(parcel.deliveryDriverId);
  }

  // 5. Persist atomically, with a bounded retry on order_number/tracking_code
  // collisions only (never on unrelated P2002 conflicts).
  let lastConflict: unknown;
  for (let attempt = 0; attempt < MAX_IDENTIFIER_ATTEMPTS; attempt++) {
    const orderNumber = generateOrderNumber();
    const trackingCode = generateTrackingCode();

    try {
      return await prisma.$transaction(async (tx) => {
        const order = await tx.orders.create({
          data: {
            order_number: orderNumber,
            tracking_code: trackingCode,
            customer_id: input.customerId,
            created_by_id: actorUserId,
            order_type: input.orderType,
            status: "RECEIVED",
            financial_status: "PENDING",

            receiver_name: input.receiverName,
            receiver_phone: input.receiverPhone,
            receiver_alt_phone: input.receiverAltPhone,
            receiver_area_id: area.id,
            receiver_area: area.name,
            receiver_address: input.receiverAddress,
            receiver_building_floor: input.receiverBuildingFloor,
            receiver_map_link: input.receiverMapLink,
            receiver_instructions: input.receiverInstructions,

            description: input.description,
            ...(input.packageCount !== undefined ? { package_count: input.packageCount } : {}),
            quantity: input.quantity,
            weight_kg: input.weightKg,
            package_notes: input.packageNotes,

            order_amount: financials.orderAmount,
            delivery_fee: financials.deliveryFee,
            payment_type: input.paymentType,
            prepaid_order_amount: financials.prepaidOrderAmount,
            prepaid_delivery_fee: financials.prepaidDeliveryFee,
            remaining_order_amount: financials.remainingOrderAmount,
            remaining_delivery_fee: financials.remainingDeliveryFee,
            amount_to_collect: financials.amountToCollect,
            actual_amount_collected: null,
            prepaid_payment_method_id: input.prepaidPaymentMethodId ?? null,
            collection_payment_method_id: input.collectionPaymentMethodId ?? null,
            needs_financial_review: false,
            // current_driver_id / assigned_at stay NULL here — any final
            // Delivery assignment happens via assignDeliveryDriverTx below.
            // For ALREADY_AT_COMPANY, parcel.fields carries received_at_company_at
            // = `now` (computed just before this transaction); created_at is the
            // DB default now() of the same transaction — §9: the same logical
            // creation moment (sub-millisecond apart, one transaction event).
            ...parcel.fields,
          },
          include: orderDetailInclude,
        });

        const historyRow = await tx.order_status_history.create({
          data: { order_id: order.id, from_status: null, to_status: "RECEIVED", changed_by_id: actorUserId },
          include: statusHistoryInclude,
        });

        // Optional initial Parcel Collection driver (DRIVER_COLLECTION) —
        // reuses the exact Phase 11.17.3 invariant, INCLUDING its in-`tx`
        // driver-eligibility re-check; a failure rolls back the whole create
        // (no orphan Order).
        if (parcel.collectionDriverId) {
          await assignParcelCollectionDriverTx(tx, {
            orderId: order.id,
            driverId: parcel.collectionDriverId,
            actorUserId,
            expectedStatus: "AWAITING_ASSIGNMENT",
          });
        }

        // Optional final Delivery driver ("Create & Assign") — ALREADY_AT_COMPANY
        // only (the parcel is RECEIVED_AT_COMPANY, so the gate passes).
        if (parcel.deliveryDriverId) {
          await assignDeliveryDriverTx(tx, {
            orderId: order.id,
            driverId: parcel.deliveryDriverId,
            actorUserId,
            fromStatus: "RECEIVED",
            now,
          });
        }

        // Fast path when nothing was assigned (the overwhelmingly common
        // case) — a brand-new Order has no assignment / attempt / ledger row
        // and its status history is exactly the one RECEIVED row above.
        // Only reload + fully assemble when an assign helper mutated state.
        if (!parcel.collectionDriverId && !parcel.deliveryDriverId) {
          return toOrderDetail(order, [historyRow], [], [], { companyAmount: "0", customerWalletAmount: "0" }, []);
        }
        const finalOrder = await tx.orders.findUniqueOrThrow({ where: { id: order.id }, include: orderDetailInclude });
        return assembleOrderDetail(tx, finalOrder);
      });
    } catch (error) {
      if (isIdentifierConflict(error)) {
        lastConflict = error;
        continue;
      }
      if (error instanceof AppError) {
        throw error;
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Failed to create order" });
      }
      throw error;
    }
  }

  throw new AppError({
    statusCode: 500,
    code: "INTERNAL_ERROR",
    message: "Failed to generate a unique order identifier after multiple attempts",
    details: lastConflict instanceof Error ? undefined : lastConflict,
  });
}

// ============================================================
// Detail
// ============================================================

export async function getOrderById(id: string): Promise<OrderDetail> {
  const order = await prisma.orders.findUnique({
    where: { id },
    include: orderDetailInclude,
  });

  if (!order) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Order not found" });
  }

  return assembleOrderDetail(prisma, order);
}

// ============================================================
// Update (Phase 6.4)
//
// LIFECYCLE DECISION (see the Phase 6.4 final report for the full
// rationale): requirements.md defines what each OrderStatus MEANS but
// never states whether generic business-data editing is allowed in it.
// Conservative V1 policy adopted here:
//   Editable:     RECEIVED, READY_FOR_PICKUP, ASSIGNED
//   Not editable: PICKED_UP, OUT_FOR_DELIVERY, DELIVERED, FAILED_DELIVERY,
//                 RESCHEDULED, RETURNED_TO_COMPANY, RETURNED_TO_CUSTOMER,
//                 CANCELLED
// ASSIGNED is included because it is still strictly before physical
// pickup. RESCHEDULED is excluded even though it precedes another delivery
// attempt, because it is itself the product of a controlled workflow
// decision (Phase 6.6) whose next action should come from workflow logic,
// not a generic field-level PATCH.
// ============================================================

const EDITABLE_ORDER_STATUSES = new Set(["RECEIVED", "READY_FOR_PICKUP", "ASSIGNED"]);

export async function updateOrder(id: string, input: OrderUpdateInput): Promise<OrderDetail> {
  const existing = await prisma.orders.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Order not found" });
  }

  if (!EDITABLE_ORDER_STATUSES.has(existing.status)) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: `Order cannot be edited while its status is ${existing.status}`,
    });
  }

  // Unchecked variant: exposes raw scalar FK columns (customer_id,
  // receiver_area_id, prepaid_payment_method_id, collection_payment_method_id)
  // directly, matching how createOrder() already assigns them — the
  // "checked" ordersUpdateInput would instead require relation-style
  // connect/disconnect objects for every FK change.
  const data: Prisma.ordersUncheckedUpdateInput = {};

  // Customer — only re-validated when an EXPLICITLY DIFFERENT customerId is
  // supplied (CLAUDE.md-locked V1 rule + the INACTIVE CUSTOMER HISTORICAL
  // CASE rule: resending the same id, or omitting the field entirely, must
  // never require the existing — possibly since-deactivated — Customer to
  // be active). Customer data/wallet are never touched.
  if (input.customerId !== undefined && input.customerId !== existing.customer_id) {
    const customer = await loadActiveCustomer(input.customerId);
    data.customer_id = customer.id;
  }

  if (input.receiverName !== undefined) data.receiver_name = input.receiverName;
  if (input.receiverPhone !== undefined) data.receiver_phone = input.receiverPhone;
  if (input.receiverAltPhone !== undefined) data.receiver_alt_phone = input.receiverAltPhone;
  if (input.receiverAddress !== undefined) data.receiver_address = input.receiverAddress;
  if (input.receiverBuildingFloor !== undefined) data.receiver_building_floor = input.receiverBuildingFloor;
  if (input.receiverMapLink !== undefined) data.receiver_map_link = input.receiverMapLink;
  if (input.receiverInstructions !== undefined) data.receiver_instructions = input.receiverInstructions;

  // Area / snapshot — only refreshed when an EXPLICITLY DIFFERENT
  // receiverAreaId is supplied. Omitting it, or resending the same id,
  // preserves the existing receiver_area text exactly, even if the
  // referenced Area was renamed since creation.
  if (input.receiverAreaId !== undefined && input.receiverAreaId !== existing.receiver_area_id) {
    const area = await loadActiveArea(input.receiverAreaId);
    data.receiver_area_id = area.id;
    data.receiver_area = area.name;
  }

  if (input.description !== undefined) data.description = input.description;
  if (input.packageCount !== undefined) data.package_count = input.packageCount;
  if (input.quantity !== undefined) data.quantity = input.quantity;
  if (input.weightKg !== undefined) data.weight_kg = input.weightKg;
  if (input.packageNotes !== undefined) data.package_notes = input.packageNotes;

  // Financial — recomputed from the COMPLETE effective state (existing DB
  // values overridden by whatever this PATCH supplies), never from just the
  // changed component, using the exact Phase 6.1 functions unchanged.
  const financialFieldTouched =
    input.orderAmount !== undefined ||
    input.deliveryFee !== undefined ||
    input.paymentType !== undefined ||
    input.prepaidOrderAmount !== undefined ||
    input.prepaidDeliveryFee !== undefined;
  const paymentMethodFieldTouched =
    input.prepaidPaymentMethodId !== undefined || input.collectionPaymentMethodId !== undefined;

  if (financialFieldTouched || paymentMethodFieldTouched) {
    const effectivePaymentType = input.paymentType ?? existing.payment_type;
    const financials = calculateOrderFinancials({
      orderAmount: input.orderAmount ?? existing.order_amount,
      deliveryFee: input.deliveryFee ?? existing.delivery_fee,
      prepaidOrderAmount: input.prepaidOrderAmount ?? existing.prepaid_order_amount,
      prepaidDeliveryFee: input.prepaidDeliveryFee ?? existing.prepaid_delivery_fee,
    });
    validatePaymentTypeConsistency(effectivePaymentType, financials);

    // prepaidPaymentMethodId: required iff the effective prepaid total > 0.
    // A newly-required-but-missing method is rejected; a method that
    // becomes inapplicable (effective prepaid total drops to 0) is
    // auto-cleared to null server-side rather than requiring the client to
    // send null explicitly. Only an EXPLICITLY supplied id is re-validated
    // for existence/active state — an untouched existing (possibly
    // since-deactivated) reference is preserved as-is.
    const prepaidTotal = financials.prepaidOrderAmount.plus(financials.prepaidDeliveryFee);
    let effectivePrepaidMethodId: string | null;
    if (prepaidTotal.isZero()) {
      effectivePrepaidMethodId = null;
    } else {
      effectivePrepaidMethodId =
        input.prepaidPaymentMethodId !== undefined ? input.prepaidPaymentMethodId : existing.prepaid_payment_method_id;
      if (!effectivePrepaidMethodId) {
        throw new AppError({
          statusCode: 400,
          code: "VALIDATION_ERROR",
          message: "prepaidPaymentMethodId is required when a prepaid amount is provided",
        });
      }
      if (input.prepaidPaymentMethodId !== undefined) {
        await loadActivePaymentMethod(effectivePrepaidMethodId, "prepaid payment method");
      }
    }

    // collectionPaymentMethodId: the same rule, keyed off the effective
    // amountToCollect instead.
    let effectiveCollectionMethodId: string | null;
    if (financials.amountToCollect.isZero()) {
      effectiveCollectionMethodId = null;
    } else {
      effectiveCollectionMethodId =
        input.collectionPaymentMethodId !== undefined
          ? input.collectionPaymentMethodId
          : existing.collection_payment_method_id;
      if (!effectiveCollectionMethodId) {
        throw new AppError({
          statusCode: 400,
          code: "VALIDATION_ERROR",
          message: "collectionPaymentMethodId is required when an amount remains to be collected",
        });
      }
      if (input.collectionPaymentMethodId !== undefined) {
        await loadActivePaymentMethod(effectiveCollectionMethodId, "collection payment method");
      }
    }

    data.order_amount = financials.orderAmount;
    data.delivery_fee = financials.deliveryFee;
    data.payment_type = effectivePaymentType;
    data.prepaid_order_amount = financials.prepaidOrderAmount;
    data.prepaid_delivery_fee = financials.prepaidDeliveryFee;
    data.remaining_order_amount = financials.remainingOrderAmount;
    data.remaining_delivery_fee = financials.remainingDeliveryFee;
    data.amount_to_collect = financials.amountToCollect;
    data.prepaid_payment_method_id = effectivePrepaidMethodId;
    data.collection_payment_method_id = effectiveCollectionMethodId;
  }

  // status, financial_status, actual_amount_collected, needs_financial_review,
  // current_driver_id, assigned_at, and every other workflow timestamp are
  // never assigned above — OrderUpdateSchema doesn't even expose them, so
  // there is nothing to strip; `data` structurally cannot contain them.
  data.updated_at = new Date();

  // CONCURRENCY GUARD (Phase 6.6): Phase 6.6 introduces real concurrent
  // workflow transitions (ready/reschedule/cancel/reassign) that can change
  // an Order's status out from under a generic PATCH that already read and
  // validated an older status. The smallest safe fix: claim the write
  // conditionally on the EXACT status just read, using the same
  // updateMany-count-check pattern proven in Phase 6.5, instead of a blind
  // update-by-id. If a workflow transition won the race first, this affects
  // 0 rows and the PATCH safely fails with 409 rather than silently writing
  // business data onto an Order that has already left the editable window
  // (e.g. just got cancelled). This does not need to guard against every
  // concurrent change — reassignment, for instance, only touches
  // assignment/current-driver fields that PATCH never writes, so the two
  // may safely proceed together while status stays ASSIGNED.
  return prisma.$transaction(async (tx) => {
    const claim = await tx.orders.updateMany({
      where: { id, status: existing.status },
      data,
    });
    if (claim.count !== 1) {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "Order was changed by another request — please retry",
      });
    }

    const updated = await tx.orders.findUniqueOrThrow({ where: { id }, include: orderDetailInclude });

    // No order_status_history row is written — status is not changing, and
    // status history is not a general edit-audit log (deferred to the
    // Audit infrastructure phase, same decision as Phases 5.1/5.2).
    // Assignment history / financial ledgers are untouched by a generic edit
    // (an editable Order is pre-DELIVERED, so its financialAllocation is "0"
    // and financialEvents is empty) but the full DTO is still assembled.
    return assembleOrderDetail(tx, updated);
  });
}

// ============================================================
// List
// ============================================================

export interface ListOrdersResult {
  items: OrderSummary[];
  total: number;
}

// created_at range from the validated query strings. A BARE YYYY-MM-DD is an
// inclusive UTC calendar day: from -> gte 00:00:00Z of that day; to -> lt
// 00:00:00Z of the NEXT day (Phase 6.3 correction — fixes "to" excluding the
// rest of that day). An explicit UTC datetime keeps its literal, already-
// approved meaning (gte / lte the exact instant). Mirrors Finance/Reports'
// day-boundary convention (shared/date/day-boundary.ts).
function buildCreatedAtRange(
  from: string | undefined,
  to: string | undefined
): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  const range: Prisma.DateTimeFilter = {};
  if (from) {
    range.gte = parseUtcCalendarDate(from) ?? new Date(from);
  }
  if (to) {
    const bareTo = parseUtcCalendarDate(to);
    if (bareTo) range.lt = nextUtcDay(bareTo);
    else range.lte = new Date(to);
  }
  return range;
}

// Server-side sort — an explicit allowlist mapped to real scalar columns
// (Phase 6.3 correction). No dynamic property access, no raw SQL. Every
// branch appends an `id: desc` tiebreaker for deterministic pagination.
// delivered_at is nullable -> NULLS LAST in both directions (delivered
// Orders sort together; undelivered Orders always trail).
function buildOrderBy(
  sortBy: ListOrdersQuery["sortBy"],
  sortOrder: "asc" | "desc"
): Prisma.ordersOrderByWithRelationInput[] {
  const tie: Prisma.ordersOrderByWithRelationInput = { id: "desc" };
  switch (sortBy) {
    case "createdAt":
      return [{ created_at: sortOrder }, tie];
    case "orderNumber":
      return [{ order_number: sortOrder }, tie];
    case "status":
      return [{ status: sortOrder }, tie];
    case "orderAmount":
      return [{ order_amount: sortOrder }, tie];
    case "deliveryFee":
      return [{ delivery_fee: sortOrder }, tie];
    case "amountToCollect":
      return [{ amount_to_collect: sortOrder }, tie];
    case "deliveredAt":
      return [{ delivered_at: { sort: sortOrder, nulls: "last" } }, tie];
    default:
      // No sortBy supplied — preserve the historical default.
      return [{ created_at: "desc" }, tie];
  }
}

export async function listOrders(query: ListOrdersQuery): Promise<ListOrdersResult> {
  const where: Prisma.ordersWhereInput = {};

  if (query.status) where.status = query.status;
  if (query.orderType) where.order_type = query.orderType;
  if (query.paymentType) where.payment_type = query.paymentType;
  if (query.financialStatus) where.financial_status = query.financialStatus;
  if (query.customerId) where.customer_id = query.customerId;
  if (query.areaId) where.receiver_area_id = query.areaId;
  if (query.needsFinancialReview !== undefined) where.needs_financial_review = query.needsFinancialReview;

  // Parcel Intake filters (Phase 11.17.6 — task §5-§8). Independent of
  // OrderType; independent equality filters, safe as plain top-level keys.
  // parcelCollectionDriverId filters CURRENT collection work only
  // (orders.current_parcel_collection_driver_id) — never "ever had a
  // collection assignment" (that is historical reporting, out of scope
  // here — see the new Driver parcel-collection-history endpoint).
  if (query.parcelIntakeMethod) where.parcel_intake_method = query.parcelIntakeMethod;
  if (query.parcelCollectionStatus) where.parcel_collection_status = query.parcelCollectionStatus;
  if (query.parcelCollectionDriverId) where.current_parcel_collection_driver_id = query.parcelCollectionDriverId;

  // Every remaining condition composes with AND at the outer level so no
  // filter can silently overwrite another (search + payment-method both need
  // their own OR sub-clause; driverId + assignmentStatus both target
  // current_driver_id).
  const and: Prisma.ordersWhereInput[] = [];

  if (query.search) {
    and.push({
      OR: [
        { order_number: { contains: query.search, mode: "insensitive" } },
        { tracking_code: { contains: query.search, mode: "insensitive" } },
        { receiver_name: { contains: query.search, mode: "insensitive" } },
        { receiver_phone: { contains: query.search, mode: "insensitive" } },
        { customers: { customer_number: { contains: query.search, mode: "insensitive" } } },
        { customers: { name: { contains: query.search, mode: "insensitive" } } },
        { customers: { primary_phone: { contains: query.search, mode: "insensitive" } } },
      ],
    });
  }

  // Payment method: an Order matches if EITHER the prepaid OR the collection
  // method is this id (requirements.md §14 — the two are independent). A
  // single Order that uses the same method for both is still ONE row.
  if (query.paymentMethodId) {
    and.push({
      OR: [
        { prepaid_payment_method_id: query.paymentMethodId },
        { collection_payment_method_id: query.paymentMethodId },
      ],
    });
  }

  // Coarse delivered-vs-not filter — independent of the exact `status`
  // filter; both compose with AND.
  if (query.deliveryStatus === "DELIVERED") {
    and.push({ status: "DELIVERED" });
  } else if (query.deliveryStatus === "UNDELIVERED") {
    and.push({ status: { not: "DELIVERED" } });
  }

  // driverId and assignmentStatus both target current_driver_id and must
  // compose with AND — neither may be silently dropped when both are
  // supplied (Phase 6.3 review cleanup):
  //   driverId only        -> current_driver_id = X
  //   ASSIGNED only         -> current_driver_id IS NOT NULL
  //   UNASSIGNED only       -> current_driver_id IS NULL
  //   driverId + ASSIGNED   -> "= X" already implies IS NOT NULL
  //   driverId + UNASSIGNED -> "= X" AND IS NULL -> valid empty (200 []) result
  if (query.driverId) {
    and.push({ current_driver_id: query.driverId });
  }
  if (query.assignmentStatus === "ASSIGNED") {
    and.push({ current_driver_id: { not: null } });
  } else if (query.assignmentStatus === "UNASSIGNED") {
    and.push({ current_driver_id: null });
  }

  // Operational queue (Phase 11.17.6 — task §12/§19). Pushed as its own AND
  // branch (never spread into the top-level `where`) so it composes safely
  // even when it targets a key (e.g. `status`) another filter above already
  // set — the two conditions both apply, exactly like every other AND
  // branch in this function. Reuses the single shared queue definition in
  // order-workflow-queue.ts — the Dashboard and Reports use the identical
  // predicate, so counts always agree.
  if (query.workflowQueue) {
    and.push(buildWorkflowQueueWhere(query.workflowQueue));
  }

  if (and.length > 0) where.AND = and;

  const createdAt = buildCreatedAtRange(query.createdFrom, query.createdTo);
  if (createdAt) where.created_at = createdAt;

  const orderBy = buildOrderBy(query.sortBy, query.sortOrder);

  const [rows, total] = await Promise.all([
    prisma.orders.findMany({
      where,
      select: orderSummarySelect,
      orderBy,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.orders.count({ where }),
  ]);

  return { items: rows.map(toOrderSummary), total };
}

// ============================================================
// Assignment / Reassignment / Bulk Assignment (Phase 6.5)
//
// An Order may be assigned immediately from RECEIVED, or after being
// marked READY_FOR_PICKUP — both are approved initial-assignment source
// statuses (requirements.md §15/§17). Once current_driver_id is non-null,
// /assign must be rejected in favor of /reassign.
// ============================================================

// ORDER_INITIAL_ASSIGNMENT_STATUSES (order-lifecycle.ts) is the shared
// source — order-workflow-queue.ts's READY_FOR_DELIVERY_ASSIGNMENT queue
// reuses the identical Set contents (Phase 11.17.6).
const INITIAL_ASSIGNMENT_SOURCE_STATUSES = new Set<string>(ORDER_INITIAL_ASSIGNMENT_STATUSES);

// CONCURRENCY DESIGN (assign, reassign, and bulk-assign all follow this
// shape): the initial read happens OUTSIDE the transaction purely to
// produce a specific, helpful error (404 Order not found / 400 wrong
// status / 409 already assigned) in the common, non-racing case. The
// actual safety guarantee comes entirely from the conditional
// tx.orders.updateMany(...) inside the transaction, whose WHERE clause
// re-states the exact state that was just read (id + current_driver_id/
// status). Postgres's row-level UPDATE locking re-evaluates that WHERE
// clause against the live committed row, so if a concurrent request won
// the race in between, this updateMany affects 0 rows — which is the
// single source of truth this code trusts, not the earlier read. A 0-row
// result always means "state changed since we read it" and is reported as
// 409 CONFLICT.

export async function assignOrder(orderId: string, driverId: string, actorUserId: string): Promise<OrderDetail> {
  const driver = await loadEligibleDriverForAssignment(driverId);

  const existing = await prisma.orders.findUnique({ where: { id: orderId } });
  if (!existing) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Order not found" });
  }
  if (existing.current_driver_id !== null) {
    throw new AppError({
      statusCode: 409,
      code: "CONFLICT",
      message: "Order already has an assigned driver — use reassign instead",
    });
  }
  if (!INITIAL_ASSIGNMENT_SOURCE_STATUSES.has(existing.status)) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: `Order cannot be assigned while its status is ${existing.status}`,
    });
  }
  // Phase 11.17.4 — hard Parcel Intake gate for FINAL Delivery assignment.
  if (!isParcelReadyForDelivery(existing.parcel_collection_status)) {
    throw new AppError({ statusCode: 409, code: "CONFLICT", message: PARCEL_NOT_READY_FOR_DELIVERY_MESSAGE });
  }

  const now = new Date();

  return prisma.$transaction(async (tx) => {
    // Authoritative driver eligibility — re-checked inside the transaction so a
    // driver deactivated between the pre-read above and this commit cannot be
    // assigned (no TOCTOU — Phase 11.17.4 correction). The pre-read stays for
    // the friendly early error only.
    await assertDriverEligibleForAssignment(tx, driver.id);

    const claim = await tx.orders.updateMany({
      // parcel_collection_status is part of the claim so a concurrent
      // parcel-collection transition can never let a delivery assignment slip.
      where: {
        id: orderId,
        current_driver_id: null,
        status: existing.status,
        parcel_collection_status: "RECEIVED_AT_COMPANY",
      },
      data: { current_driver_id: driver.id, assigned_at: now, status: "ASSIGNED", updated_at: now },
    });
    if (claim.count !== 1) {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "Order was changed by another request — please retry",
      });
    }

    await tx.order_assignments.create({
      data: {
        order_id: orderId,
        driver_id: driver.id,
        assigned_by_id: actorUserId,
        assigned_at: now,
        ended_at: null,
        end_reason: null,
        is_current: true,
      },
    });

    await tx.order_status_history.create({
      data: { order_id: orderId, from_status: existing.status, to_status: "ASSIGNED", changed_by_id: actorUserId },
    });

    const updated = await tx.orders.findUniqueOrThrow({ where: { id: orderId }, include: orderDetailInclude });
    return assembleOrderDetail(tx, updated);
  });
}

// Phase 6.6: extended from Phase 6.5's ASSIGNED-only rule to also allow
// reassigning a RESCHEDULED order (the approved V1 exception-reassignment
// sequence is FAILED_DELIVERY -> /reschedule -> RESCHEDULED -> optional
// /reassign -> ASSIGNED; direct FAILED_DELIVERY -> reassign is not
// supported — the Order must first explicitly enter RESCHEDULED).
const REASSIGNABLE_SOURCE_STATUSES = new Set(["ASSIGNED", "RESCHEDULED"]);

export async function reassignOrder(
  orderId: string,
  newDriverId: string,
  reason: string,
  actorUserId: string
): Promise<OrderDetail> {
  const newDriver = await loadEligibleDriverForAssignment(newDriverId);

  const existing = await prisma.orders.findUnique({ where: { id: orderId } });
  if (!existing) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Order not found" });
  }
  // Reassignment is only allowed while ASSIGNED or RESCHEDULED — once
  // PICKED_UP or later, changing the driver belongs to a different
  // controlled operational workflow, not generic management reassignment.
  if (!REASSIGNABLE_SOURCE_STATUSES.has(existing.status) || !existing.current_driver_id) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "Order can only be reassigned while it is ASSIGNED or RESCHEDULED with a current driver",
    });
  }
  const sourceStatus = existing.status as "ASSIGNED" | "RESCHEDULED";
  if (newDriverId === existing.current_driver_id) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "The new driver must be different from the current driver",
    });
  }
  // Phase 11.17.4 — fail closed: a delivery-assigned Order should already be
  // RECEIVED_AT_COMPANY, but if legacy/corrupt state is not, reassignment must
  // NOT be a way to hold a driver on an order whose parcel is not at the company.
  if (!isParcelReadyForDelivery(existing.parcel_collection_status)) {
    console.error(
      `[order.service] integrity failure for order ${orderId}: has a current delivery driver but ` +
        `parcel_collection_status=${existing.parcel_collection_status}`,
    );
    throw new AppError({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Order parcel-intake state is inconsistent with its delivery assignment — action was not performed",
    });
  }

  // Assignment-history integrity check — there must be EXACTLY one current
  // assignment row and it must correspond to orders.current_driver_id.
  // This is never expected to fail in normal operation; if it does, that
  // is a real data-consistency problem this code must not try to silently
  // repair. Shared with ready/reschedule/cancel — see
  // assertConsistentCurrentAssignment below.
  const currentAssignment = await assertConsistentCurrentAssignment(orderId, existing.current_driver_id);
  const currentAssignmentId = currentAssignment.id;
  const oldDriverId = existing.current_driver_id;

  const now = new Date();

  return prisma.$transaction(async (tx) => {
    // Authoritative NEW-driver eligibility — in-transaction (no TOCTOU;
    // Phase 11.17.4). Pre-read above is the friendly early error only.
    await assertDriverEligibleForAssignment(tx, newDriver.id);

    const claim = await tx.orders.updateMany({
      where: {
        id: orderId,
        status: sourceStatus,
        current_driver_id: oldDriverId,
        parcel_collection_status: "RECEIVED_AT_COMPANY",
      },
      // status is always (re)set to ASSIGNED: a no-op when the source was
      // already ASSIGNED, a real transition when the source was RESCHEDULED.
      data: { current_driver_id: newDriver.id, assigned_at: now, updated_at: now, status: "ASSIGNED" },
    });
    if (claim.count !== 1) {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "Order was changed by another request — please retry",
      });
    }

    const ended = await tx.order_assignments.updateMany({
      where: { id: currentAssignmentId, is_current: true },
      data: { is_current: false, ended_at: now, end_reason: reason },
    });
    if (ended.count !== 1) {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "Order was changed by another request — please retry",
      });
    }

    await tx.order_assignments.create({
      data: {
        order_id: orderId,
        driver_id: newDriver.id,
        assigned_by_id: actorUserId,
        assigned_at: now,
        ended_at: null,
        end_reason: null,
        is_current: true,
      },
    });

    // Status history only when a REAL transition occurred. Ordinary
    // ASSIGNED -> reassign -> ASSIGNED is not a transition (no row) — the
    // reassignment is already permanently recorded in order_assignments.
    // RESCHEDULED -> reassign -> ASSIGNED IS a real transition and gets one.
    if (sourceStatus === "RESCHEDULED") {
      await tx.order_status_history.create({
        data: { order_id: orderId, from_status: "RESCHEDULED", to_status: "ASSIGNED", changed_by_id: actorUserId },
      });
    }

    const updated = await tx.orders.findUniqueOrThrow({ where: { id: orderId }, include: orderDetailInclude });
    return assembleOrderDetail(tx, updated);
  });
}

export async function bulkAssignOrders(
  orderIds: string[],
  driverId: string,
  actorUserId: string
): Promise<BulkAssignResult> {
  const driver = await loadEligibleDriverForAssignment(driverId);

  const targetOrders = await prisma.orders.findMany({ where: { id: { in: orderIds } } });
  if (targetOrders.length !== orderIds.length) {
    const foundIds = new Set(targetOrders.map((o) => o.id));
    const missing = orderIds.filter((id) => !foundIds.has(id));
    throw new AppError({
      statusCode: 404,
      code: "NOT_FOUND",
      message: `One or more orders were not found: ${missing.join(", ")}`,
    });
  }
  for (const order of targetOrders) {
    if (order.current_driver_id !== null) {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: `Order ${order.order_number} already has an assigned driver`,
      });
    }
    if (!INITIAL_ASSIGNMENT_SOURCE_STATUSES.has(order.status)) {
      throw new AppError({
        statusCode: 400,
        code: "VALIDATION_ERROR",
        message: `Order ${order.order_number} cannot be assigned while its status is ${order.status}`,
      });
    }
    // Phase 11.17.4 — every selected Order must have its parcel at the company.
    // Bulk stays ALL-OR-NOTHING: one ineligible order rejects the whole batch.
    if (!isParcelReadyForDelivery(order.parcel_collection_status)) {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: `Order ${order.order_number}: ${PARCEL_NOT_READY_FOR_DELIVERY_MESSAGE.toLowerCase()}`,
      });
    }
  }

  const now = new Date();

  // V1 bulk semantics are explicitly ALL-OR-NOTHING (approved decision —
  // see the Phase 6.5 report): every selected Order's conditional update
  // must individually match its own exact previously-read id/status, one
  // at a time, inside a single transaction. A broad updateMany with
  // status IN (...) is deliberately avoided — it cannot preserve each
  // Order's individual original status as an accurate from_status if one
  // of them changed between the read and the write. If ANY Order's
  // conditional update affects 0 rows, the thrown error aborts the whole
  // transaction and Prisma rolls back every write made so far in it.
  await prisma.$transaction(async (tx) => {
    // Authoritative driver eligibility — in-transaction, once for the batch
    // (no TOCTOU; Phase 11.17.4). The pre-read above is the friendly early error.
    await assertDriverEligibleForAssignment(tx, driver.id);

    for (const order of targetOrders) {
      const claim = await tx.orders.updateMany({
        where: {
          id: order.id,
          current_driver_id: null,
          status: order.status,
          parcel_collection_status: "RECEIVED_AT_COMPANY",
        },
        data: { current_driver_id: driver.id, assigned_at: now, status: "ASSIGNED", updated_at: now },
      });
      if (claim.count !== 1) {
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: `Order ${order.order_number} was changed by another request — the entire bulk assignment was rolled back`,
        });
      }

      await tx.order_assignments.create({
        data: {
          order_id: order.id,
          driver_id: driver.id,
          assigned_by_id: actorUserId,
          assigned_at: now,
          ended_at: null,
          end_reason: null,
          is_current: true,
        },
      });

      await tx.order_status_history.create({
        data: { order_id: order.id, from_status: order.status, to_status: "ASSIGNED", changed_by_id: actorUserId },
      });
    }
  });

  return {
    assignedCount: targetOrders.length,
    driver: toAssignmentDriverSummary(driver),
    orderIds: targetOrders.map((o) => o.id),
  };
}

// ============================================================
// Ready / Reschedule / Cancel (Phase 6.6)
// ============================================================

// Verifies a Driver-bearing Order's assignment state is internally
// consistent BEFORE any write: current_driver_id must be non-null, and
// there must be EXACTLY ONE order_assignments row with is_current=true
// whose driver_id matches it. Never attempts to silently repair a
// mismatch — logs the specifics and fails safely with a sanitized 500.
// Exported for reuse by modules/driver-orders (Phase 7.2 Pickup) — the same
// invariant applies there before a Driver-initiated transition, and the
// task's own instruction is to reuse this rather than duplicate a subtly
// different check.
export async function assertConsistentCurrentAssignment(
  orderId: string,
  currentDriverId: string | null
): Promise<order_assignments> {
  if (!currentDriverId) {
    console.error(
      `[order.service] data-consistency failure for order ${orderId}: expected a current driver but current_driver_id is null`
    );
    throw new AppError({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Order assignment state is inconsistent — action was not performed",
    });
  }

  const currentAssignments = await prisma.order_assignments.findMany({ where: { order_id: orderId, is_current: true } });
  if (currentAssignments.length !== 1 || currentAssignments[0].driver_id !== currentDriverId) {
    console.error(
      `[order.service] assignment-history integrity failure for order ${orderId}: expected exactly one ` +
        `is_current row matching driver ${currentDriverId}, found ${currentAssignments.length} ` +
        `(drivers: ${currentAssignments.map((a) => a.driver_id).join(", ")})`
    );
    throw new AppError({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Order assignment history is inconsistent — action was not performed",
    });
  }

  return currentAssignments[0];
}

// POST /:id/ready — RECEIVED -> READY_FOR_PICKUP only. Does not touch
// assignment fields at all; a RECEIVED order is expected to have no
// current driver (verified, not assumed).
export async function readyOrder(orderId: string, actorUserId: string): Promise<OrderDetail> {
  const existing = await prisma.orders.findUnique({ where: { id: orderId } });
  if (!existing) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Order not found" });
  }
  if (existing.status !== "RECEIVED") {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: `Order cannot be marked ready while its status is ${existing.status}`,
    });
  }
  if (existing.current_driver_id !== null) {
    console.error(
      `[order.service] data-consistency failure for order ${orderId}: RECEIVED order unexpectedly has current_driver_id=${existing.current_driver_id}`
    );
    throw new AppError({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Order assignment state is inconsistent — action was not performed",
    });
  }

  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const claim = await tx.orders.updateMany({
      where: { id: orderId, status: "RECEIVED", current_driver_id: null },
      data: { status: "READY_FOR_PICKUP", updated_at: now },
    });
    if (claim.count !== 1) {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "Order was changed by another request — please retry",
      });
    }

    await tx.order_status_history.create({
      data: { order_id: orderId, from_status: "RECEIVED", to_status: "READY_FOR_PICKUP", changed_by_id: actorUserId },
    });

    const updated = await tx.orders.findUniqueOrThrow({ where: { id: orderId }, include: orderDetailInclude });
    return assembleOrderDetail(tx, updated);
  });
}

// POST /:id/reschedule — FAILED_DELIVERY -> RESCHEDULED only. Preserves
// the current Driver assignment untouched (current_driver_id, assigned_at,
// and the current order_assignments row all stay exactly as they were) —
// a rescheduled delivery may be retried later by the same Driver
// (Phase 7's responsibility, not implemented here).
export async function rescheduleOrder(
  orderId: string,
  reason: string,
  notes: string | undefined,
  actorUserId: string
): Promise<OrderDetail> {
  const existing = await prisma.orders.findUnique({ where: { id: orderId } });
  if (!existing) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Order not found" });
  }
  if (existing.status !== "FAILED_DELIVERY") {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: `Order cannot be rescheduled while its status is ${existing.status}`,
    });
  }

  await assertConsistentCurrentAssignment(orderId, existing.current_driver_id);
  const currentDriverId = existing.current_driver_id;

  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const claim = await tx.orders.updateMany({
      where: { id: orderId, status: "FAILED_DELIVERY", current_driver_id: currentDriverId },
      data: { status: "RESCHEDULED", updated_at: now },
    });
    if (claim.count !== 1) {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "Order was changed by another request — please retry",
      });
    }

    // No assignment row is created, ended, or otherwise touched — see the
    // module doc comment above. No delivery_attempts row either (Phase 7).
    await tx.order_status_history.create({
      data: {
        order_id: orderId,
        from_status: "FAILED_DELIVERY",
        to_status: "RESCHEDULED",
        changed_by_id: actorUserId,
        reason,
        notes: notes ?? null,
      },
    });

    const updated = await tx.orders.findUniqueOrThrow({ where: { id: orderId }, include: orderDetailInclude });
    return assembleOrderDetail(tx, updated);
  });
}

// POST /:id/cancel
const CANCELLABLE_STATUSES = new Set(["RECEIVED", "READY_FOR_PICKUP", "ASSIGNED", "FAILED_DELIVERY", "RESCHEDULED"]);
// These three statuses always carry an active current-driver assignment
// that cancellation must close; RECEIVED/READY_FOR_PICKUP never do.
const CANCEL_STATUSES_WITH_ACTIVE_ASSIGNMENT = new Set(["ASSIGNED", "FAILED_DELIVERY", "RESCHEDULED"]);

export async function cancelOrder(
  orderId: string,
  reason: string,
  notes: string | undefined,
  actorUserId: string
): Promise<OrderDetail> {
  const existing = await prisma.orders.findUnique({ where: { id: orderId } });
  if (!existing) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Order not found" });
  }
  if (!CANCELLABLE_STATUSES.has(existing.status)) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: `Order cannot be cancelled while its status is ${existing.status}`,
    });
  }

  // Phase 11.17.4 — Parcel Collection integration.
  //  - COLLECTED_FROM_SENDER: a driver physically holds the parcel; cancellation
  //    is forbidden until Management confirms RECEIVED_AT_COMPANY (§32).
  //  - ASSIGNED: the current collection assignment is closed with
  //    end_reason = ORDER_CANCELLED in the same transaction, and the collection
  //    driver pointer is cleared. parcel_collection_status stays ASSIGNED as the
  //    last historical stage — there is NO ParcelCollectionStatus.CANCELLED (§34).
  const parcelStatus = existing.parcel_collection_status;
  if (parcelStatus === "COLLECTED_FROM_SENDER") {
    throw new AppError({
      statusCode: 409,
      code: "CONFLICT",
      message:
        "The collection driver is holding this parcel — confirm it has been received at the company before cancelling the order",
    });
  }
  const closesParcelCollectionAssignment = parcelStatus === "ASSIGNED";
  let parcelAssignmentId: string | null = null;
  if (closesParcelCollectionAssignment) {
    const parcelAssignment = await assertConsistentCurrentParcelCollectionAssignment(
      prisma,
      orderId,
      existing.current_parcel_collection_driver_id,
    );
    parcelAssignmentId = parcelAssignment.id;
  } else if (existing.current_parcel_collection_driver_id !== null) {
    // AWAITING_ASSIGNMENT / FAILED / RESCHEDULED / RECEIVED_AT_COMPANY must all
    // carry a NULL collection-driver pointer.
    console.error(
      `[order.service] data-consistency failure for order ${orderId}: parcel_collection_status=${parcelStatus} ` +
        `unexpectedly has current_parcel_collection_driver_id=${existing.current_parcel_collection_driver_id}`,
    );
    throw new AppError({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Parcel collection assignment state is inconsistent — action was not performed",
    });
  }

  const hasActiveAssignment = CANCEL_STATUSES_WITH_ACTIVE_ASSIGNMENT.has(existing.status);
  let currentAssignmentId: string | null = null;

  if (hasActiveAssignment) {
    const assignment = await assertConsistentCurrentAssignment(orderId, existing.current_driver_id);
    currentAssignmentId = assignment.id;
  } else if (existing.current_driver_id !== null) {
    // RECEIVED/READY_FOR_PICKUP are expected to have no current driver.
    console.error(
      `[order.service] data-consistency failure for order ${orderId}: ${existing.status} order unexpectedly ` +
        `has current_driver_id=${existing.current_driver_id}`
    );
    throw new AppError({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Order assignment state is inconsistent — action was not performed",
    });
  }

  const now = new Date();
  const sourceStatus = existing.status;
  const currentDriverId = existing.current_driver_id;

  return prisma.$transaction(async (tx) => {
    const claim = await tx.orders.updateMany({
      // parcel_collection_status is part of the claim: a concurrent
      // driver `collected`/`failed` (which moves it off ASSIGNED) makes this
      // claim match 0 rows -> 409, and the whole cancel rolls back.
      where: {
        id: orderId,
        status: sourceStatus,
        current_driver_id: currentDriverId,
        parcel_collection_status: parcelStatus,
      },
      data: {
        status: "CANCELLED",
        cancelled_at: now,
        updated_at: now,
        // Only cleared when an assignment is actually being closed — see
        // CANCEL WITHOUT CURRENT ASSIGNMENT: for RECEIVED/READY_FOR_PICKUP
        // these are already null, so this is a harmless no-op assignment.
        ...(hasActiveAssignment ? { current_driver_id: null, assigned_at: null } : {}),
        // parcel_collection_status is deliberately NOT changed (§34).
        ...(closesParcelCollectionAssignment ? { current_parcel_collection_driver_id: null } : {}),
      },
    });
    if (claim.count !== 1) {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "Order was changed by another request — please retry",
      });
    }

    if (hasActiveAssignment && currentAssignmentId) {
      const ended = await tx.order_assignments.updateMany({
        where: { id: currentAssignmentId, is_current: true },
        data: { is_current: false, ended_at: now, end_reason: reason },
      });
      if (ended.count !== 1) {
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: "Order was changed by another request — please retry",
        });
      }
    }

    if (closesParcelCollectionAssignment && parcelAssignmentId) {
      // The parcel_collection_assignments_current_state_chk CHECK requires
      // ended_at + end_reason to be set together with is_current = false.
      const endedParcel = await tx.parcel_collection_assignments.updateMany({
        where: { id: parcelAssignmentId, is_current: true },
        data: { is_current: false, ended_at: now, end_reason: "ORDER_CANCELLED" },
      });
      if (endedParcel.count !== 1) {
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: "Order was changed by another request — please retry",
        });
      }
      // No parcel_collection_attempts row is fabricated (§33/§41). The
      // assignment row's end_reason = ORDER_CANCELLED is the operational
      // evidence for why the collection assignment ended.
    }

    // financial_status/actual_amount_collected/needs_financial_review and
    // every workflow timestamp other than cancelled_at are left untouched —
    // cancellation performs no financial finalization (Phase 6.6 is
    // operational workflow only).
    await tx.order_status_history.create({
      data: {
        order_id: orderId,
        from_status: sourceStatus,
        to_status: "CANCELLED",
        changed_by_id: actorUserId,
        reason,
        notes: notes ?? null,
      },
    });

    const updated = await tx.orders.findUniqueOrThrow({ where: { id: orderId }, include: orderDetailInclude });
    return assembleOrderDetail(tx, updated);
  });
}

// ============================================================
// POST /:id/resolve-collection-difference (Phase 8.7)
//
// A collection-difference /deliver (see driver-order.service.ts) already
// recorded the REAL physical cash in Driver Cash and left the Order
// REVIEW_REQUIRED without guessing how it splits between the Customer
// Wallet and Company Revenue. This is the authorized Finance/Admin action
// that supplies that split explicitly — it never re-touches Driver Cash
// (physical custody was already settled at delivery time, and may even
// have been handed to the company via a Phase 8.6 settlement already;
// accounting ownership is a separate concern from physical custody) and
// never guesses an allocation on its own.
// ============================================================

// Fails closed on any inconsistency rather than silently repairing —
// distinguishes "not currently eligible" (400, a normal business state) from
// "claims to be eligible but the underlying data is corrupt" (500, should be
// structurally impossible given how /deliver writes these fields together).
async function loadEligibleReviewOrder(orderId: string): Promise<orders> {
  const order = await prisma.orders.findUnique({ where: { id: orderId } });
  if (!order) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Order not found" });
  }
  if (order.status !== "DELIVERED" || order.financial_status !== "REVIEW_REQUIRED" || !order.needs_financial_review) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "Order is not pending collection-difference review",
    });
  }

  if (order.actual_amount_collected === null || !order.collection_difference_reason?.trim()) {
    console.error(
      `[order.service] data-consistency failure for order ${orderId}: REVIEW_REQUIRED order missing actual_amount_collected/collection_difference_reason`
    );
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Order review state is inconsistent — action was not performed" });
  }
  const difference = calculateCollectionDifference(order.amount_to_collect, order.actual_amount_collected);
  if (!difference.needsFinancialReview) {
    console.error(`[order.service] data-consistency failure for order ${orderId}: REVIEW_REQUIRED order has actual == expected`);
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Order review state is inconsistent — action was not performed" });
  }

  return order;
}

// Order-type-appropriate buckets validated here (never inferred/auto-split);
// the actual reconciliation amount always comes from the server-authoritative
// actual_amount_collected, never a client-supplied total.
function validateCollectionDifferenceAllocation(order: orders, input: ResolveCollectionDifferenceInput): void {
  if (order.order_type === "DELIVERY_ONLY" && !input.companyProductRevenue.isZero()) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "companyProductRevenue must be zero for a DELIVERY_ONLY order",
    });
  }
  if (order.order_type === "COMPANY_ORDER" && !input.customerWalletCredit.isZero()) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "customerWalletCredit must be zero for a COMPANY_ORDER order",
    });
  }

  const sum = input.customerWalletCredit.plus(input.companyProductRevenue).plus(input.companyDeliveryFeeRevenue);
  // actual_amount_collected is guaranteed non-null by loadEligibleReviewOrder.
  if (!sum.equals(order.actual_amount_collected as Prisma.Decimal)) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "Allocation must sum exactly to the actual amount collected",
    });
  }
}

export async function resolveCollectionDifference(
  orderId: string,
  input: ResolveCollectionDifferenceInput,
  actorUserId: string
): Promise<OrderDetail> {
  const existing = await loadEligibleReviewOrder(orderId);
  validateCollectionDifferenceAllocation(existing, input);

  return prisma.$transaction(async (tx) => {
    // The conditional claim (not the earlier read) is the real concurrency
    // mutex — identical pattern to every other Order action in this file.
    const claim = await tx.orders.updateMany({
      where: { id: orderId, status: "DELIVERED", financial_status: "REVIEW_REQUIRED", needs_financial_review: true },
      data: { financial_status: "FINALIZED", needs_financial_review: false, updated_at: new Date() },
    });
    if (claim.count !== 1) {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "Order review state was changed by another request — please retry",
      });
    }

    // No Driver Cash mutation anywhere in this transaction — physical
    // custody was already recorded at delivery time; this only assigns
    // accounting ownership of that already-recorded cash.
    let walletTransactionId: string | null = null;
    let companyProductTransactionId: string | null = null;
    let companyFeeTransactionId: string | null = null;

    if (existing.order_type === "DELIVERY_ONLY") {
      if (input.customerWalletCredit.greaterThan(0)) {
        const wallet = await creditWalletForOrder(tx, {
          customerId: existing.customer_id,
          orderId,
          amount: input.customerWalletCredit,
          processedById: actorUserId,
          notes: input.resolutionNotes,
          // Same deterministic category key exact finance uses (Phase 8.3)
          // — an Order can only ever be exact OR difference-resolved, never
          // both, so this guarantees at most one ORDER_CREDIT row per Order.
          idempotencyKey: `delivery:${orderId}:wallet-order-credit`,
        });
        walletTransactionId = wallet.transaction.id;
      }
      if (input.companyDeliveryFeeRevenue.greaterThan(0)) {
        const fee = await recordDeliveryFeeRevenue(tx, {
          orderId,
          amount: input.companyDeliveryFeeRevenue,
          paymentMethodId: existing.collection_payment_method_id ?? undefined,
          createdById: actorUserId,
          notes: input.resolutionNotes,
          idempotencyKey: `delivery:${orderId}:delivery-fee-revenue`,
        });
        companyFeeTransactionId = fee.id;
      }
    } else {
      // COMPANY_ORDER — never touches the Customer Wallet (already
      // guaranteed by validateCollectionDifferenceAllocation).
      if (input.companyProductRevenue.greaterThan(0)) {
        const product = await recordCompanyOrderProductRevenue(tx, {
          orderId,
          amount: input.companyProductRevenue,
          paymentMethodId: existing.collection_payment_method_id ?? undefined,
          createdById: actorUserId,
          notes: input.resolutionNotes,
          idempotencyKey: `delivery:${orderId}:company-product-revenue`,
        });
        companyProductTransactionId = product.id;
      }
      if (input.companyDeliveryFeeRevenue.greaterThan(0)) {
        const fee = await recordDeliveryFeeRevenue(tx, {
          orderId,
          amount: input.companyDeliveryFeeRevenue,
          paymentMethodId: existing.collection_payment_method_id ?? undefined,
          createdById: actorUserId,
          notes: input.resolutionNotes,
          idempotencyKey: `delivery:${orderId}:delivery-fee-revenue`,
        });
        companyFeeTransactionId = fee.id;
      }
    }

    await createAuditLog(tx, {
      actorUserId,
      action: "COLLECTION_DIFFERENCE_RESOLVED",
      entityType: "ORDER",
      entityId: orderId,
      previousValues: { financialStatus: "REVIEW_REQUIRED", needsFinancialReview: true },
      newValues: { financialStatus: "FINALIZED", needsFinancialReview: false },
      metadata: {
        orderType: existing.order_type,
        expectedAmount: existing.amount_to_collect.toString(),
        // actual_amount_collected is guaranteed non-null by loadEligibleReviewOrder.
        actualAmount: (existing.actual_amount_collected as Prisma.Decimal).toString(),
        originalDifferenceReason: existing.collection_difference_reason,
        resolutionNotes: input.resolutionNotes,
        customerWalletCredit: input.customerWalletCredit.toString(),
        companyProductRevenue: input.companyProductRevenue.toString(),
        companyDeliveryFeeRevenue: input.companyDeliveryFeeRevenue.toString(),
        walletTransactionId,
        companyProductTransactionId,
        companyFeeTransactionId,
      },
    });

    const updated = await tx.orders.findUniqueOrThrow({ where: { id: orderId }, include: orderDetailInclude });
    return assembleOrderDetail(tx, updated);
  });
}

// ============================================================
// GET /:id/history
// ============================================================

export async function getOrderHistory(orderId: string): Promise<OrderHistoryResponse> {
  const order = await prisma.orders.findUnique({ where: { id: orderId }, select: { id: true } });
  if (!order) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Order not found" });
  }

  const statusHistory = await loadStatusHistory(prisma, orderId);
  const assignmentHistory = await loadAssignmentHistory(prisma, orderId);

  return {
    orderId: order.id,
    statusHistory: statusHistory.map(toStatusHistoryEntry),
    assignmentHistory: assignmentHistory.map(toAssignmentHistoryEntry),
  };
}
