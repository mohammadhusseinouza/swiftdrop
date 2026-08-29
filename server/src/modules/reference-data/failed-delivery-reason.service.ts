import { Prisma } from "../../generated/prisma/client";
import type { failed_delivery_reasons } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import type {
  CreateFailedDeliveryReasonInput,
  ListFailedDeliveryReasonsQuery,
  UpdateFailedDeliveryReasonInput,
} from "./failed-delivery-reason.schema";
import type { FailedDeliveryReasonSummary } from "./failed-delivery-reason.types";

function toFailedDeliveryReasonSummary(reason: failed_delivery_reasons): FailedDeliveryReasonSummary {
  return {
    id: reason.id,
    name: reason.name,
    requiresNotes: reason.requires_notes,
    isActive: reason.is_active,
    sortOrder: reason.sort_order,
    createdAt: reason.created_at.toISOString(),
    updatedAt: reason.updated_at.toISOString(),
  };
}

function handleKnownFailedDeliveryReasonError(error: unknown, fallbackMessage: string): never {
  if (error instanceof AppError) {
    throw error;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "A failed delivery reason with this name already exists",
      });
    }
    if (error.code === "P2025") {
      throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Failed delivery reason not found" });
    }
  }

  throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: fallbackMessage });
}

export async function listFailedDeliveryReasons(
  query: ListFailedDeliveryReasonsQuery
): Promise<FailedDeliveryReasonSummary[]> {
  const where: Prisma.failed_delivery_reasonsWhereInput = {};

  if (query.search) {
    where.name = { contains: query.search, mode: "insensitive" };
  }

  if (query.isActive !== undefined) {
    where.is_active = query.isActive;
  }

  const rows = await prisma.failed_delivery_reasons.findMany({
    where,
    orderBy: [{ sort_order: "asc" }, { name: "asc" }],
  });

  return rows.map(toFailedDeliveryReasonSummary);
}

export async function createFailedDeliveryReason(
  input: CreateFailedDeliveryReasonInput
): Promise<FailedDeliveryReasonSummary> {
  try {
    const reason = await prisma.failed_delivery_reasons.create({
      data: {
        name: input.name,
        ...(input.requiresNotes !== undefined ? { requires_notes: input.requiresNotes } : {}),
        ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
      },
    });

    return toFailedDeliveryReasonSummary(reason);
  } catch (error) {
    handleKnownFailedDeliveryReasonError(error, "Failed to create failed delivery reason");
  }
}

export async function getFailedDeliveryReasonById(id: string): Promise<FailedDeliveryReasonSummary> {
  const reason = await prisma.failed_delivery_reasons.findUnique({ where: { id } });

  if (!reason) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Failed delivery reason not found" });
  }

  return toFailedDeliveryReasonSummary(reason);
}

export async function updateFailedDeliveryReason(
  id: string,
  input: UpdateFailedDeliveryReasonInput
): Promise<FailedDeliveryReasonSummary> {
  try {
    const reason = await prisma.failed_delivery_reasons.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.requiresNotes !== undefined ? { requires_notes: input.requiresNotes } : {}),
        ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
        ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
        updated_at: new Date(),
      },
    });

    return toFailedDeliveryReasonSummary(reason);
  } catch (error) {
    handleKnownFailedDeliveryReasonError(error, "Failed to update failed delivery reason");
  }
}
