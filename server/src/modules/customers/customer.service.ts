import { Prisma } from "../../generated/prisma/client";
import type { areas, customer_wallets, customers } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import type { CreateCustomerInput, ListCustomersQuery, UpdateCustomerInput } from "./customer.schema";
import type { CustomerDetail, CustomerSummary } from "./customer.types";

type CustomerWithArea = customers & { areas: areas | null };
type CustomerWithAreaAndWallet = CustomerWithArea & { customer_wallets: customer_wallets | null };

function toCustomerSummary(customer: CustomerWithArea): CustomerSummary {
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
    createdAt: customer.created_at.toISOString(),
    updatedAt: customer.updated_at.toISOString(),
  };
}

function toCustomerDetail(customer: CustomerWithAreaAndWallet): CustomerDetail {
  return {
    ...toCustomerSummary(customer),
    notes: customer.notes,
    wallet: customer.customer_wallets
      ? { availableBalance: customer.customer_wallets.available_balance.toString() }
      : null,
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

  return { items: rows.map(toCustomerSummary), total };
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
      const wallet = await tx.customer_wallets.create({
        data: { customer_id: customer.id },
      });

      return toCustomerDetail({ ...customer, customer_wallets: wallet });
    });
  } catch (error) {
    handleKnownCustomerError(error, "Failed to create customer");
  }
}

export async function getCustomerById(id: string): Promise<CustomerDetail> {
  const customer = await prisma.customers.findUnique({
    where: { id },
    include: { areas: true, customer_wallets: true },
  });

  if (!customer) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Customer not found" });
  }

  return toCustomerDetail(customer);
}

export async function updateCustomer(id: string, input: UpdateCustomerInput): Promise<CustomerDetail> {
  try {
    const customer = await prisma.customers.update({
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
      include: { areas: true, customer_wallets: true },
    });

    return toCustomerDetail(customer);
  } catch (error) {
    handleKnownCustomerError(error, "Failed to update customer");
  }
}
