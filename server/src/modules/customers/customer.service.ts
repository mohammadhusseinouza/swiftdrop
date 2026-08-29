import { Prisma } from "../../generated/prisma/client";
import type { areas, customers } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { createAuditLog } from "../../shared/audit/audit.service";
import {
  ORDER_ACTIVE_STATUSES,
  ORDER_TERMINAL_STATUSES,
} from "../orders/order-lifecycle";
import type { CreateCustomerInput, ListCustomersQuery, UpdateCustomerInput } from "./customer.schema";
import type { CustomerDetail, CustomerOrderSummary, CustomerSummary } from "./customer.types";

type CustomerWithArea = customers & { areas: areas | null };

function toCustomerSummary(customer: CustomerWithArea, activeOrders: number): CustomerSummary {
  return {
    id: customer.id,
    customerNumber: customer.customer_number,
    name: customer.name,
    primaryPhone: customer.primary_phone,
    secondaryPhone: customer.secondary_phone,
    email: customer.email,
    defaultAddress: customer.default_address,
    area: customer.areas ? { id: customer.areas.id, name: customer.areas.name } : null,
    hasPortalAccount: customer.portal_user_id !== null,
    isActive: customer.is_active,
    activeOrders,
    createdAt: customer.created_at.toISOString(),
    updatedAt: customer.updated_at.toISOString(),
  };
}

function toCustomerDetail(customer: CustomerWithArea, orderSummary: CustomerOrderSummary): CustomerDetail {
  return {
    ...toCustomerSummary(customer, orderSummary.activeOrders),
    notes: customer.notes,
    orderSummary,
  };
}

function handleKnownCustomerError(error: unknown, fallbackMessage: string): never {
  if (error instanceof AppError) {
    throw error;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "A customer with conflicting unique data already exists",
      });
    }
    if (error.code === "P2003") {
      throw new AppError({
        statusCode: 400,
        code: "VALIDATION_ERROR",
        message: "The specified area does not exist",
      });
    }
    if (error.code === "P2025") {
      throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Customer not found" });
    }
  }

  throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: fallbackMessage });
}

// ============================================================
// Operational order counts (Phase 11.6 correction) — pure DB aggregates,
// reusing the single shared ORDER_TERMINAL_STATUSES / ORDER_ACTIVE_STATUSES
// definition. The client never counts orders.
// ============================================================

// Batched active-order counts for a page of Customers — one grouped query
// scoped to the current page's ids, never one query per row.
async function getActiveOrderCounts(customerIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (customerIds.length === 0) return map;
  const grouped = await prisma.orders.groupBy({
    by: ["customer_id"],
    where: {
      customer_id: { in: customerIds },
      status: { notIn: [...ORDER_TERMINAL_STATUSES] },
    },
    _count: { _all: true },
  });
  for (const row of grouped) {
    map.set(row.customer_id, row._count._all);
  }
  return map;
}

async function getCustomerOrderSummary(customerId: string): Promise<CustomerOrderSummary> {
  const [activeOrders, deliveredOrders, totalOrders] = await Promise.all([
    prisma.orders.count({
      where: { customer_id: customerId, status: { in: [...ORDER_ACTIVE_STATUSES] } },
    }),
    prisma.orders.count({ where: { customer_id: customerId, status: "DELIVERED" } }),
    prisma.orders.count({ where: { customer_id: customerId } }),
  ]);
  return { activeOrders, deliveredOrders, totalOrders };
}

export interface ListCustomersResult {
  items: CustomerSummary[];
  total: number;
}

export async function listCustomers(query: ListCustomersQuery): Promise<ListCustomersResult> {
  const where: Prisma.customersWhereInput = {};

  if (query.search) {
    where.OR = [
      { customer_number: { contains: query.search, mode: "insensitive" } },
      { name: { contains: query.search, mode: "insensitive" } },
      { primary_phone: { contains: query.search, mode: "insensitive" } },
      { email: { contains: query.search, mode: "insensitive" } },
    ];
  }

  if (query.isActive !== undefined) {
    where.is_active = query.isActive;
  }

  if (query.areaId) {
    where.default_area_id = query.areaId;
  }

  if (query.hasPortalAccount !== undefined) {
    where.portal_user_id = query.hasPortalAccount ? { not: null } : null;
  }

  const [rows, total] = await Promise.all([
    prisma.customers.findMany({
      where,
      include: { areas: true },
      orderBy: { created_at: "desc" },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.customers.count({ where }),
  ]);

  const activeCounts = await getActiveOrderCounts(rows.map((r) => r.id));

  return {
    items: rows.map((r) => toCustomerSummary(r, activeCounts.get(r.id) ?? 0)),
    total,
  };
}

export async function createCustomer(input: CreateCustomerInput, createdByUserId: string): Promise<CustomerDetail> {
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.customers.findUnique({ where: { customer_number: input.customerNumber } });
      if (existing) {
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: `A customer with number "${input.customerNumber}" already exists`,
        });
      }

      const customer = await tx.customers.create({
        data: {
          customer_number: input.customerNumber,
          name: input.name,
          primary_phone: input.primaryPhone,
          secondary_phone: input.secondaryPhone,
          email: input.email,
          default_address: input.defaultAddress,
          default_area_id: input.defaultAreaId,
          notes: input.notes,
          created_by_id: createdByUserId,
        },
        include: { areas: true },
      });

      // Every customer requires exactly one wallet (customer_wallets.customer_id
      // is unique, and "unique wallet per customer" is an approved DB
      // integrity rule) — created atomically here, zero balance, no ledger
      // entry needed for a zero-balance wallet creation.
      await tx.customer_wallets.create({ data: { customer_id: customer.id } });

      // Durable audit record (Phase 11.6 correction) — same transaction as
      // the mutation, following the established createAuditLog convention.
      // Never records wallet balance / auth / portal-token data.
      await createAuditLog(tx, {
        actorUserId: createdByUserId,
        action: "CUSTOMER_CREATED",
        entityType: "CUSTOMER",
        entityId: customer.id,
        newValues: {
          customerNumber: customer.customer_number,
          name: customer.name,
          primaryPhone: customer.primary_phone,
          isActive: customer.is_active,
        },
        metadata: { defaultAreaId: customer.default_area_id },
      });

      // A brand-new customer has no orders.
      return toCustomerDetail(customer, { activeOrders: 0, deliveredOrders: 0, totalOrders: 0 });
    });
  } catch (error) {
    handleKnownCustomerError(error, "Failed to create customer");
  }
}

export async function getCustomerById(id: string): Promise<CustomerDetail> {
  const customer = await prisma.customers.findUnique({
    where: { id },
    include: { areas: true },
  });

  if (!customer) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Customer not found" });
  }

  const orderSummary = await getCustomerOrderSummary(customer.id);
  return toCustomerDetail(customer, orderSummary);
}

// Fields whose change is worth capturing in the audit previous/new values.
const AUDITED_UPDATE_FIELDS = [
  "name",
  "primaryPhone",
  "secondaryPhone",
  "email",
  "defaultAddress",
  "defaultAreaId",
  "notes",
] as const;

export async function updateCustomer(
  id: string,
  input: UpdateCustomerInput,
  actorUserId: string
): Promise<CustomerDetail> {
  const existing = await prisma.customers.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Customer not found" });
  }

  const isActiveChange =
    input.isActive !== undefined && input.isActive !== existing.is_active;
  // A pure isActive toggle is a deactivate/reactivate; any other field change
  // (with or without isActive) is a general update.
  const otherFieldTouched = AUDITED_UPDATE_FIELDS.some(
    (f) => (input as Record<string, unknown>)[f] !== undefined
  );

  let auditAction: string;
  if (otherFieldTouched) {
    auditAction = "CUSTOMER_UPDATED";
  } else if (isActiveChange) {
    auditAction = input.isActive ? "CUSTOMER_REACTIVATED" : "CUSTOMER_DEACTIVATED";
  } else {
    // isActive supplied but unchanged, and nothing else — still a valid
    // no-op PATCH; record it as a plain update.
    auditAction = "CUSTOMER_UPDATED";
  }

  const previousValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  const existingByField: Record<(typeof AUDITED_UPDATE_FIELDS)[number], unknown> = {
    name: existing.name,
    primaryPhone: existing.primary_phone,
    secondaryPhone: existing.secondary_phone,
    email: existing.email,
    defaultAddress: existing.default_address,
    defaultAreaId: existing.default_area_id,
    notes: existing.notes,
  };
  for (const f of AUDITED_UPDATE_FIELDS) {
    const next = (input as Record<string, unknown>)[f];
    if (next !== undefined && next !== existingByField[f]) {
      previousValues[f] = existingByField[f];
      newValues[f] = next;
    }
  }
  if (isActiveChange) {
    previousValues.isActive = existing.is_active;
    newValues.isActive = input.isActive;
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const customer = await tx.customers.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.primaryPhone !== undefined ? { primary_phone: input.primaryPhone } : {}),
          ...(input.secondaryPhone !== undefined ? { secondary_phone: input.secondaryPhone } : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.defaultAddress !== undefined ? { default_address: input.defaultAddress } : {}),
          ...(input.defaultAreaId !== undefined ? { default_area_id: input.defaultAreaId } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
          updated_at: new Date(),
        },
        include: { areas: true },
      });

      await createAuditLog(tx, {
        actorUserId,
        action: auditAction,
        entityType: "CUSTOMER",
        entityId: customer.id,
        previousValues: Object.keys(previousValues).length
          ? (previousValues as unknown as Prisma.InputJsonValue)
          : undefined,
        newValues: Object.keys(newValues).length
          ? (newValues as unknown as Prisma.InputJsonValue)
          : undefined,
      });

      const orderSummary = await getCustomerOrderSummary(customer.id);
      return toCustomerDetail(customer, orderSummary);
    });
  } catch (error) {
    handleKnownCustomerError(error, "Failed to update customer");
  }
}
