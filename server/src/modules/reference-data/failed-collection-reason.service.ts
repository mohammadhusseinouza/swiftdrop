import { Prisma } from "../../generated/prisma/client";
import type { failed_collection_reasons } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { createAuditLog } from "../../shared/audit/audit.service";
import { classifyReferenceUpdate, diffReferenceFields } from "./reference-audit";
import type {
  CreateFailedCollectionReasonInput,
  ListFailedCollectionReasonsQuery,
  UpdateFailedCollectionReasonInput,
} from "./failed-collection-reason.schema";
import type {
  DriverFailedCollectionReasonSummary,
  FailedCollectionReasonSummary,
} from "./failed-collection-reason.types";

// Mirrors failed-delivery-reason.service.ts exactly. Separate DB table,
// separate audit entity type. No hard delete.

function toSummary(reason: failed_collection_reasons): FailedCollectionReasonSummary {
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

function handleKnownError(error: unknown, fallbackMessage: string): never {
  if (error instanceof AppError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "A failed collection reason with this name already exists",
      });
    }
    if (error.code === "P2025") {
      throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Failed collection reason not found" });
    }
  }
  throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: fallbackMessage });
}

export async function listFailedCollectionReasons(
  query: ListFailedCollectionReasonsQuery,
): Promise<FailedCollectionReasonSummary[]> {
  const where: Prisma.failed_collection_reasonsWhereInput = {};
  if (query.search) where.name = { contains: query.search, mode: "insensitive" };
  if (query.isActive !== undefined) where.is_active = query.isActive;

  const rows = await prisma.failed_collection_reasons.findMany({
    where,
    orderBy: [{ sort_order: "asc" }, { name: "asc" }],
  });
  return rows.map(toSummary);
}

// Driver-facing: ACTIVE reasons only, narrow shape. Used by the Phase 12
// failure UI via GET /api/v1/driver/failed-collection-reasons — the DRIVER
// role must NOT be granted settings.read.
export async function listActiveFailedCollectionReasonsForDriver(): Promise<DriverFailedCollectionReasonSummary[]> {
  const rows = await prisma.failed_collection_reasons.findMany({
    where: { is_active: true },
    orderBy: [{ sort_order: "asc" }, { name: "asc" }],
    select: { id: true, name: true, requires_notes: true, sort_order: true },
  });
  return rows.map((r) => ({ id: r.id, name: r.name, requiresNotes: r.requires_notes, sortOrder: r.sort_order }));
}

export async function createFailedCollectionReason(
  input: CreateFailedCollectionReasonInput,
  actorUserId: string,
): Promise<FailedCollectionReasonSummary> {
  try {
    const reason = await prisma.$transaction(async (tx) => {
      const created = await tx.failed_collection_reasons.create({
        data: {
          name: input.name,
          ...(input.requiresNotes !== undefined ? { requires_notes: input.requiresNotes } : {}),
          ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
        },
      });

      await createAuditLog(tx, {
        actorUserId,
        action: "FAILED_COLLECTION_REASON_CREATED",
        entityType: "FAILED_COLLECTION_REASON",
        entityId: created.id,
        newValues: {
          name: created.name,
          requiresNotes: created.requires_notes,
          sortOrder: created.sort_order,
          isActive: created.is_active,
        },
      });

      return created;
    });
    return toSummary(reason);
  } catch (error) {
    handleKnownError(error, "Failed to create failed collection reason");
  }
}

export async function getFailedCollectionReasonById(id: string): Promise<FailedCollectionReasonSummary> {
  const reason = await prisma.failed_collection_reasons.findUnique({ where: { id } });
  if (!reason) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Failed collection reason not found" });
  }
  return toSummary(reason);
}

export async function updateFailedCollectionReason(
  id: string,
  input: UpdateFailedCollectionReasonInput,
  actorUserId: string,
): Promise<FailedCollectionReasonSummary> {
  try {
    const reason = await prisma.$transaction(async (tx) => {
      const existing = await tx.failed_collection_reasons.findUnique({ where: { id } });
      if (!existing) {
        throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Failed collection reason not found" });
      }

      const updated = await tx.failed_collection_reasons.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.requiresNotes !== undefined ? { requires_notes: input.requiresNotes } : {}),
          ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
          ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
          updated_at: new Date(),
        },
      });

      const { previousValues, newValues, otherFieldsTouched } = diffReferenceFields(
        {
          name: existing.name,
          requiresNotes: existing.requires_notes,
          sortOrder: existing.sort_order,
          isActive: existing.is_active,
        },
        {
          name: input.name,
          requiresNotes: input.requiresNotes,
          sortOrder: input.sortOrder,
          isActive: input.isActive,
        },
      );

      if (Object.keys(newValues).length > 0) {
        const action = `FAILED_COLLECTION_REASON_${classifyReferenceUpdate({
          wasActive: existing.is_active,
          nextActive: input.isActive,
          otherFieldsTouched,
        })}`;

        await createAuditLog(tx, {
          actorUserId,
          action,
          entityType: "FAILED_COLLECTION_REASON",
          entityId: id,
          previousValues: previousValues as Prisma.InputJsonValue,
          newValues: newValues as Prisma.InputJsonValue,
        });
      }

      return updated;
    });
    return toSummary(reason);
  } catch (error) {
    handleKnownError(error, "Failed to update failed collection reason");
  }
}
