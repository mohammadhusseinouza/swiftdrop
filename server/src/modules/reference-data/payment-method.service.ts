import { Prisma } from "../../generated/prisma/client";
import type { payment_methods } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import type {
  CreatePaymentMethodInput,
  ListPaymentMethodsQuery,
  UpdatePaymentMethodInput,
} from "./payment-method.schema";
import type { PaymentMethodSummary } from "./payment-method.types";

function toPaymentMethodSummary(paymentMethod: payment_methods): PaymentMethodSummary {
  return {
    id: paymentMethod.id,
    code: paymentMethod.code,
    name: paymentMethod.name,
    isActive: paymentMethod.is_active,
    sortOrder: paymentMethod.sort_order,
    createdAt: paymentMethod.created_at.toISOString(),
    updatedAt: paymentMethod.updated_at.toISOString(),
  };
}

function handleKnownPaymentMethodError(error: unknown, fallbackMessage: string): never {
  if (error instanceof AppError) {
    throw error;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "A payment method with this code already exists",
      });
    }
    if (error.code === "P2025") {
      throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Payment method not found" });
    }
  }

  throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: fallbackMessage });
}

export async function listPaymentMethods(query: ListPaymentMethodsQuery): Promise<PaymentMethodSummary[]> {
  const where: Prisma.payment_methodsWhereInput = {};

  if (query.search) {
    where.OR = [
      { code: { contains: query.search, mode: "insensitive" } },
      { name: { contains: query.search, mode: "insensitive" } },
    ];
  }

  if (query.isActive !== undefined) {
    where.is_active = query.isActive;
  }

  const rows = await prisma.payment_methods.findMany({
    where,
    orderBy: [{ sort_order: "asc" }, { name: "asc" }],
  });

  return rows.map(toPaymentMethodSummary);
}

export async function createPaymentMethod(input: CreatePaymentMethodInput): Promise<PaymentMethodSummary> {
  try {
    const paymentMethod = await prisma.payment_methods.create({
      data: {
        code: input.code,
        name: input.name,
        ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
      },
    });

    return toPaymentMethodSummary(paymentMethod);
  } catch (error) {
    handleKnownPaymentMethodError(error, "Failed to create payment method");
  }
}

export async function getPaymentMethodById(id: string): Promise<PaymentMethodSummary> {
  const paymentMethod = await prisma.payment_methods.findUnique({ where: { id } });

  if (!paymentMethod) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Payment method not found" });
  }

  return toPaymentMethodSummary(paymentMethod);
}

export async function updatePaymentMethod(
  id: string,
  input: UpdatePaymentMethodInput
): Promise<PaymentMethodSummary> {
  try {
    const paymentMethod = await prisma.payment_methods.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
        ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
        updated_at: new Date(),
      },
    });

    return toPaymentMethodSummary(paymentMethod);
  } catch (error) {
    handleKnownPaymentMethodError(error, "Failed to update payment method");
  }
}
