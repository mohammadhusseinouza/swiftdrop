import { Prisma } from "../../generated/prisma/client";
import type { areas } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
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

export async function createArea(input: CreateAreaInput): Promise<AreaSummary> {
  try {
    const area = await prisma.areas.create({
      data: {
        name: input.name,
        ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
      },
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

export async function updateArea(id: string, input: UpdateAreaInput): Promise<AreaSummary> {
  try {
    const area = await prisma.areas.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
        ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
        updated_at: new Date(),
      },
    });

    return toAreaSummary(area);
  } catch (error) {
    handleKnownAreaError(error, "Failed to update area");
  }
}
