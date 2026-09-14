import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { getCustomerProfileForUser } from "../auth/ownership.service";
import { ORDER_ACTIVE_STATUSES } from "../orders/order-lifecycle";
import { customerCollectionStage } from "../tracking/customer-collection-stage";
import { buildCustomerTrackingProgress, trackingSourceSelect } from "../tracking/tracking.service";
import type { ListCustomerOrdersQuery } from "./customer-order.schema";
import type { CustomerOrderDetail, CustomerOrderSummary } from "./customer-order.types";

// ============================================================
// GET /api/v1/customer/me/orders (Phase 13.2)
//
// SELF-SCOPED, READ-ONLY. The Customer is resolved ONLY from
// req.actor.userId (passed as `userId`) via getCustomerProfileForUser —
// there is no code path that reads a customerId/customerNumber from
// query/params/body, so `?customerId=<other>` has no effect (identical
// discipline to customer-dashboard.service.ts / tracking.service.ts).
//
// NO N+1 (task §25 / §53): the list is exactly TWO queries regardless of row
// count — one findMany with a fixed `select`, one count with the same
// `where`. The Customer-safe collection stage is derived in-process from the
// two scalar `orders` columns already selected — never a per-row
// tracking/collection lookup.
// ============================================================

const customerOrderSelect = {
  id: true,
  order_number: true,
  tracking_code: true,
  order_type: true,
  status: true,
  created_at: true,
  delivered_at: true,
  receiver_name: true,
  receiver_area: true,
  order_amount: true,
  delivery_fee: true,
  amount_to_collect: true,
  parcel_intake_method: true,
  parcel_collection_status: true,
} satisfies Prisma.ordersSelect;

type CustomerOrderRow = Prisma.ordersGetPayload<{ select: typeof customerOrderSelect }>;

function toCustomerOrderSummary(row: CustomerOrderRow): CustomerOrderSummary {
  return {
    id: row.id,
    orderNumber: row.order_number,
    trackingCode: row.tracking_code,
    orderType: row.order_type,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    deliveredAt: row.delivered_at ? row.delivered_at.toISOString() : null,
    receiverName: row.receiver_name,
    receiverArea: row.receiver_area,
    orderAmount: row.order_amount.toString(),
    deliveryFee: row.delivery_fee.toString(),
    amountToCollect: row.amount_to_collect.toString(),
    parcelIntakeMethod: row.parcel_intake_method,
    collectionStage: customerCollectionStage(row.parcel_intake_method, row.parcel_collection_status),
  };
}

export interface ListCustomerOrdersResult {
  items: CustomerOrderSummary[];
  total: number;
}

export async function listCustomerOrders(
  userId: string,
  query: ListCustomerOrdersQuery
): Promise<ListCustomerOrdersResult> {
  const customer = await getCustomerProfileForUser(userId);

  // customer_id is ALWAYS pinned — the `view` filter only ever narrows
  // further. "active" reuses the single shared non-terminal lifecycle set
  // (ORDER_ACTIVE_STATUSES) — the same definition the Phase 13.1 Dashboard's
  // activeOrders count uses, so the list and the Dashboard can never
  // disagree (task §20 / §34). FAILED_DELIVERY / RESCHEDULED are active per
  // that set. "delivered" is status = DELIVERED only — never inferred from a
  // wallet credit (a delivered COMPANY_ORDER credits no wallet, task §21).
  const where: Prisma.ordersWhereInput = { customer_id: customer.id };
  if (query.view === "active") {
    where.status = { in: [...ORDER_ACTIVE_STATUSES] };
  } else if (query.view === "delivered") {
    where.status = "DELIVERED";
  }

  const [rows, total] = await Promise.all([
    prisma.orders.findMany({
      where,
      select: customerOrderSelect,
      // Deterministic newest-first — created_at DESC, id DESC as the stable
      // tie-breaker (same convention as wallet.service.ts / order list).
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.orders.count({ where }),
  ]);

  return { items: rows.map(toCustomerOrderSummary), total };
}

// ============================================================
// GET /api/v1/customer/me/orders/:id (Phase 13.3)
//
// SELF-SCOPED (Customer from req.actor.userId only) + IDOR-SAFE: ownership is
// enforced IN the query (id + customer_id together, matching
// tracking.service.ts). An Order that exists but belongs to another Customer
// returns the IDENTICAL 404 as a nonexistent Order — never a 403, never any
// hint that the id is real (task §8 / §39).
//
// ONE query. The tracking section is built in-process from the same columns
// (trackingSourceSelect) via the shared Phase 11.17.6 "customer" builder —
// no second request, no per-event query, no second timeline (task §20 /
// §43). The receiver/package/money fields are the Customer's OWN stored
// Order snapshot (task §26 — never re-read from the live Customer profile).
// ============================================================

const customerOrderDetailSelect = {
  ...trackingSourceSelect,
  order_type: true,
  receiver_name: true,
  receiver_phone: true,
  receiver_alt_phone: true,
  receiver_area: true,
  receiver_address: true,
  receiver_building_floor: true,
  receiver_map_link: true,
  receiver_instructions: true,
  description: true,
  package_count: true,
  quantity: true,
  weight_kg: true,
  order_amount: true,
  delivery_fee: true,
  amount_to_collect: true,
  payment_type: true,
} satisfies Prisma.ordersSelect;

export async function getCustomerOrderDetail(userId: string, orderId: string): Promise<CustomerOrderDetail> {
  const customer = await getCustomerProfileForUser(userId);

  const order = await prisma.orders.findFirst({
    where: { id: orderId, customer_id: customer.id },
    select: customerOrderDetailSelect,
  });
  if (!order) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Order not found" });
  }

  const progress = buildCustomerTrackingProgress(order);

  return {
    id: order.id,
    orderNumber: order.order_number,
    trackingCode: order.tracking_code,
    orderType: order.order_type,
    status: order.status,
    createdAt: order.created_at.toISOString(),
    deliveredAt: order.delivered_at ? order.delivered_at.toISOString() : null,
    receiver: {
      name: order.receiver_name,
      phone: order.receiver_phone,
      altPhone: order.receiver_alt_phone,
      area: order.receiver_area,
      address: order.receiver_address,
      buildingFloor: order.receiver_building_floor,
      instructions: order.receiver_instructions,
      mapLink: order.receiver_map_link,
    },
    package: {
      description: order.description,
      packageCount: order.package_count,
      quantity: order.quantity,
      weightKg: order.weight_kg ? order.weight_kg.toString() : null,
    },
    payment: {
      type: order.payment_type,
      orderAmount: order.order_amount.toString(),
      deliveryFee: order.delivery_fee.toString(),
      amountToCollect: order.amount_to_collect.toString(),
    },
    parcelIntakeMethod: order.parcel_intake_method,
    collectionStage: customerCollectionStage(order.parcel_intake_method, order.parcel_collection_status),
    tracking: {
      stages: progress.stages,
      exception: progress.exception,
      isDelivered: progress.isDelivered,
    },
  };
}
