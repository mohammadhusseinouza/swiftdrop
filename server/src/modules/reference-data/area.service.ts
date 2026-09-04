import { Prisma } from "../../generated/prisma/client";
import type { areas } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { createAuditLog } from "../../shared/audit/audit.service";
import { classifyReferenceUpdate, diffReferenceFields } from "./reference-audit";
import type { CreateAreaInput, ListAreasQuery, UpdateAreaInput } from "./area.schema";
import type { AreaSummary } from "./area.types";

function toAreaSummary(area: areas): AreaSummary {
  return {
    id: area.id,
    name: area.name,
    isActive: area.is_active,
    sortOrder: area.sort_order,
    createdAt: area.created_at.toISOString(),
    updatedAt: area.updated_at.toISOString(),
  };
}

function handleKnownAreaError(error: unknown, fallbackMessage: string): never {
  if (error instanceof AppError) {
    throw error;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      throw new AppError({ statusCode: 409, code: "CONFLICT", message: "An area with this name already exists" });
    }
    if (error.code === "P2025") {
      throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Area not found" });
    }
  }

  throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: fallbackMessage });
}

export interface ListAreasResult {
  items: AreaSummary[];
  total: number;
}

export async function listAreas(query: ListAreasQuery): Promise<ListAreasResult> {
  const where: Prisma.areasWhereInput = {};

  if (query.search) {
    where.name = { contains: query.search, mode: "insensitive" };
  }

  if (query.isActive !== undefined) {
    where.is_active = query.isActive;
  }

  const [rows, total] = await Promise.all([
    prisma.areas.findMany({
      where,
      orderBy: [{ sort_order: "asc" }, { name: "asc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.areas.count({ where }),
  ]);

  return { items: rows.map(toAreaSummary), total };
}

export async function createArea(input: CreateAreaInput, actorUserId: string): Promise<AreaSummary> {
  try {
    const area = await prisma.$transaction(async (tx) => {
      const created = await tx.areas.create({
        data: {
          name: input.name,
          ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
        },
      });

      await createAuditLog(tx, {
        actorUserId,
        action: "AREA_CREATED",
        entityType: "AREA",
        entityId: created.id,
        newValues: { name: created.name, sortOrder: created.sort_order, isActive: created.is_active },
      });

      return created;
    });

    return toAreaSummary(area);
  } catch (error) {
    handleKnownAreaError(error, "Failed to create area");
  }
}

export async function getAreaById(id: string): Promise<AreaSummary> {
  const area = await prisma.areas.findUnique({ where: { id } });

  if (!area) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Area not found" });
  }

  return toAreaSummary(area);
}

export async function updateArea(id: string, input: UpdateAreaInput, actorUserId: string): Promise<AreaSummary> {
  try {
    const area = await prisma.$transaction(async (tx) => {
      const existing = await tx.areas.findUnique({ where: { id } });
      if (!existing) {
        throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Area not found" });
      }

      const updated = await tx.areas.update({
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
        const action = `AREA_${classifyReferenceUpdate({
          wasActive: existing.is_active,
          nextActive: input.isActive,
          otherFieldsTouched,
        })}`;

        await createAuditLog(tx, {
          actorUserId,
          action,
          entityType: "AREA",
          entityId: id,
          previousValues: previousValues as Prisma.InputJsonValue,
          newValues: newValues as Prisma.InputJsonValue,
        });
      }

      return updated;
    });

    return toAreaSummary(area);
  } catch (error) {
    handleKnownAreaError(error, "Failed to update area");
  }
}
