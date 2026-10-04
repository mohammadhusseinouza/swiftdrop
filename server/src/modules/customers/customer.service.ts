import { Prisma } from "../../generated/prisma/client";
import type { areas, customers } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { createAuditLog } from "../../shared/audit/audit.service";
import { hashPassword } from "../auth/auth.utils";
import {
  ORDER_ACTIVE_STATUSES,
  ORDER_TERMINAL_STATUSES,
} from "../orders/order-lifecycle";
import { PORTAL_EMAIL_REQUIRED_MESSAGE } from "./customer.schema";
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
// Customer Portal account (same architecture as Driver new-login): a users
// row with the role FORCED to CUSTOMER and a bcrypt password hash, linked via
// customers.portal_user_id (unique — one portal account per customer). The
// login identifier is the customer's own email. The users profile (name /
// email / phone) is derived from the customer record and kept in sync on
// edit. Passwords are never stored on customers, returned, logged or audited.
// ============================================================

const PORTAL_EMAIL_TAKEN_MESSAGE = "An account with this email already exists";
const USER_NAME_MAX_LENGTH = 100;

// users.first_name / last_name are NOT NULL VARCHAR(100); a customer has a
// single display name, split on the first whitespace.
function portalUserNames(name: string): { first_name: string; last_name: string } {
  const trimmed = name.trim();
  const idx = trimmed.search(/\s/);
  const first = idx === -1 ? trimmed : trimmed.slice(0, idx);
  const last = idx === -1 ? "" : trimmed.slice(idx + 1).trim();
  return { first_name: first.slice(0, USER_NAME_MAX_LENGTH), last_name: last.slice(0, USER_NAME_MAX_LENGTH) };
}

async function assertPortalEmailAvailable(
  tx: Prisma.TransactionClient,
  email: string,
  exceptUserId: string | null
): Promise<void> {
  const taken = await tx.users.findUnique({ where: { email } });
  if (taken && taken.id !== exceptUserId) {
    throw new AppError({ statusCode: 409, code: "CONFLICT", message: PORTAL_EMAIL_TAKEN_MESSAGE });
  }
}

async function createPortalUserTx(
  tx: Prisma.TransactionClient,
  params: { email: string; name: string; phone: string; passwordHash: string }
): Promise<string> {
  const customerRole = await tx.roles.findUnique({ where: { code: "CUSTOMER" } });
  if (!customerRole) {
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "CUSTOMER role is not configured" });
  }
  await assertPortalEmailAvailable(tx, params.email, null);
  const user = await tx.users.create({
    data: {
      email: params.email,
      password_hash: params.passwordHash,
      ...portalUserNames(params.name),
      phone: params.phone,
      // Role is FORCED — never taken from the request body.
      role_id: customerRole.id,
      is_active: true,
    },
  });
  return user.id;
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
  const grantsPortalAccess = input.portalPassword !== undefined;
  if (grantsPortalAccess && !input.email) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: PORTAL_EMAIL_REQUIRED_MESSAGE });
  }
  // bcrypt runs BEFORE the transaction so it never holds the transaction open.
  const passwordHash = grantsPortalAccess ? await hashPassword(input.portalPassword as string) : null;

  try {
    return await prisma.$transaction(async (tx) => {
      // Optional portal login, created first so a duplicate email (409) rolls
      // the whole create back — no customer without its requested account.
      const portalUserId =
        passwordHash !== null
          ? await createPortalUserTx(tx, {
              email: input.email as string,
              name: input.name,
              phone: input.primaryPhone,
              passwordHash,
            })
          : null;

      // customer_number is never supplied here — the column DEFAULT (backed
      // by customer_number_seq, an atomic Postgres sequence) generates the
      // next CUST-###### value on INSERT. See customer.schema.ts.
      const customer = await tx.customers.create({
        data: {
          name: input.name,
          primary_phone: input.primaryPhone,
          secondary_phone: input.secondaryPhone,
          email: input.email,
          default_address: input.defaultAddress,
          default_area_id: input.defaultAreaId,
          notes: input.notes,
          portal_user_id: portalUserId,
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
          hasPortalAccount: portalUserId !== null,
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

  // Portal account handling. portalPassword omitted -> password unchanged.
  const existingPortalUserId = existing.portal_user_id;
  const portalAction: "GRANTED" | "PASSWORD_RESET" | null =
    input.portalPassword === undefined ? null : existingPortalUserId === null ? "GRANTED" : "PASSWORD_RESET";
  const resultingEmail = input.email !== undefined ? input.email : existing.email;

  if (existingPortalUserId !== null && input.email === null) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "The email cannot be removed while the customer has portal access — it is their login",
    });
  }
  if (portalAction === "GRANTED") {
    if (!resultingEmail) {
      throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: PORTAL_EMAIL_REQUIRED_MESSAGE });
    }
    // Never create a login for a customer that is (or is being made) inactive.
    if (!(input.isActive ?? existing.is_active)) {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "Reactivate the customer before giving them portal access",
      });
    }
  }
  if (portalAction !== null) {
    // Marker only — the password itself is never audited.
    newValues.portalAccess = portalAction;
  }
  // bcrypt runs BEFORE the transaction so it never holds the transaction open.
  const passwordHash = input.portalPassword !== undefined ? await hashPassword(input.portalPassword) : null;

  try {
    return await prisma.$transaction(async (tx) => {
      if (portalAction === "GRANTED" && passwordHash !== null) {
        const portalUserId = await createPortalUserTx(tx, {
          email: resultingEmail as string,
          name: input.name ?? existing.name,
          phone: input.primaryPhone ?? existing.primary_phone,
          passwordHash,
        });
        // Conditional link: a concurrent grant that linked first makes this
        // match 0 rows -> 409, and the user created above is rolled back.
        const linked = await tx.customers.updateMany({
          where: { id, portal_user_id: null },
          data: { portal_user_id: portalUserId },
        });
        if (linked.count !== 1) {
          throw new AppError({
            statusCode: 409,
            code: "CONFLICT",
            message: "Customer was changed by another request — please retry",
          });
        }
      } else if (existingPortalUserId !== null) {
        // Keep the existing login in sync with the customer record — never a
        // second account. Customer deactivation does NOT touch users.is_active
        // (same convention as Driver deactivation).
        const userData: Prisma.usersUpdateInput = {};
        if (input.email !== undefined && input.email !== null && input.email !== existing.email) {
          await assertPortalEmailAvailable(tx, input.email, existingPortalUserId);
          userData.email = input.email;
        }
        if (input.name !== undefined && input.name !== existing.name) {
          Object.assign(userData, portalUserNames(input.name));
        }
        if (input.primaryPhone !== undefined && input.primaryPhone !== existing.primary_phone) {
          userData.phone = input.primaryPhone;
        }
        if (passwordHash !== null) {
          userData.password_hash = passwordHash;
        }
        if (Object.keys(userData).length > 0) {
          userData.updated_at = new Date();
          await tx.users.update({ where: { id: existingPortalUserId }, data: userData });
        }
        if (passwordHash !== null) {
          // A reset password ends every existing portal session.
          await tx.auth_sessions.updateMany({
            where: { user_id: existingPortalUserId, revoked_at: null },
            data: { revoked_at: new Date() },
          });
        }
      }

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
