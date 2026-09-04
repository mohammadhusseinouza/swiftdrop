import { Prisma } from "../../generated/prisma/client";
import type { payment_methods } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { createAuditLog } from "../../shared/audit/audit.service";
import { classifyReferenceUpdate, diffReferenceFields } from "./reference-audit";
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

export async function createPaymentMethod(
  input: CreatePaymentMethodInput,
  actorUserId: string
): Promise<PaymentMethodSummary> {
  try {
    const paymentMethod = await prisma.$transaction(async (tx) => {
      const created = await tx.payment_methods.create({
        data: {
          code: input.code,
          name: input.name,
          ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
        },
      });

      await createAuditLog(tx, {
        actorUserId,
        action: "PAYMENT_METHOD_CREATED",
        entityType: "PAYMENT_METHOD",
        entityId: created.id,
        newValues: {
          code: created.code,
          name: created.name,
          sortOrder: created.sort_order,
          isActive: created.is_active,
        },
      });

      return created;
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
  input: UpdatePaymentMethodInput,
  actorUserId: string
): Promise<PaymentMethodSummary> {
  try {
    const paymentMethod = await prisma.$transaction(async (tx) => {
      const existing = await tx.payment_methods.findUnique({ where: { id } });
      if (!existing) {
        throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Payment method not found" });
      }

      const updated = await tx.payment_methods.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
          ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
          updated_at: new Date(),
        },
      });

      const { previousValues, newValues, otherFieldsTouched } = diffReferenceFields(
        { name: existing.name, sortOrder: existing.sort_order, isActive: existing.is_active },
        { name: input.name, sortOrder: input.sortOrder, isActive: input.isActive },
      );

      if (Object.keys(newValues).length > 0) {
        const action = `PAYMENT_METHOD_${classifyReferenceUpdate({
          wasActive: existing.is_active,
          nextActive: input.isActive,
          otherFieldsTouched,
        })}`;

        await createAuditLog(tx, {
          actorUserId,
          action,
          entityType: "PAYMENT_METHOD",
          entityId: id,
          previousValues: previousValues as Prisma.InputJsonValue,
          newValues: newValues as Prisma.InputJsonValue,
          metadata: { code: existing.code },
        });
      }

      return updated;
    });

    return toPaymentMethodSummary(paymentMethod);
  } catch (error) {
    handleKnownPaymentMethodError(error, "Failed to update payment method");
  }
}
