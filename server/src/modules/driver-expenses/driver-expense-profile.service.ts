import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { createAuditLog } from "../../shared/audit/audit.service";
import type { ListExpenseDriversQuery, UpsertExpenseProfileInput } from "./daily-expense.schema";
import type { ExpenseDriverSummary, ExpenseProfileDetail, ExpenseVehicleType } from "./daily-expense.types";

// ============================================================================
// Driver Expenses — driver list + default-vehicle profiles (Phase 3).
//
// Reads driver identity from drivers -> users only (first/last name and the
// driver's active flag); writes ONLY driver_expense_profiles + the shared
// audit log. A missing profile means "not configured". Changing a profile
// never touches recorded daily expenses — each keeps the vehicle type it was
// actually recorded with.
// ============================================================================

export function driverDisplayName(user: { first_name: string; last_name: string }): string {
  return `${user.first_name} ${user.last_name}`.trim();
}

export async function assertDriverExists(
  client: Prisma.TransactionClient | typeof prisma,
  driverId: string
): Promise<void> {
  const driver = await client.drivers.findUnique({ where: { id: driverId }, select: { id: true } });
  if (!driver) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Driver not found" });
  }
}

export interface ListExpenseDriversResult {
  items: ExpenseDriverSummary[];
  total: number;
}

// GET /driver-expenses/drivers — same search/filter/pagination shape as the
// Management Drivers list, ordered by name for data entry.
export async function listExpenseDrivers(query: ListExpenseDriversQuery): Promise<ListExpenseDriversResult> {
  const where: Prisma.driversWhereInput = {};
  if (query.search) {
    where.OR = [
      { driver_number: { contains: query.search, mode: "insensitive" } },
      { users: { first_name: { contains: query.search, mode: "insensitive" } } },
      { users: { last_name: { contains: query.search, mode: "insensitive" } } },
    ];
  }
  if (query.isActive !== undefined) where.is_active = query.isActive;

  const [rows, total] = await Promise.all([
    prisma.drivers.findMany({
      where,
      select: {
        id: true,
        is_active: true,
        users: { select: { first_name: true, last_name: true } },
        driver_expense_profiles: { select: { default_vehicle_type: true } },
      },
      orderBy: [{ users: { first_name: "asc" } }, { users: { last_name: "asc" } }, { id: "asc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.drivers.count({ where }),
  ]);

  return {
    items: rows.map((r) => ({
      driverId: r.id,
      displayName: driverDisplayName(r.users),
      isActive: r.is_active,
      profileConfigured: r.driver_expense_profiles !== null,
      defaultVehicleType: r.driver_expense_profiles?.default_vehicle_type ?? null,
    })),
    total,
  };
}

function toProfileDetail(row: {
  driver_id: string;
  default_vehicle_type: ExpenseVehicleType;
  created_at: Date;
  updated_at: Date;
}): ExpenseProfileDetail {
  return {
    driverId: row.driver_id,
    defaultVehicleType: row.default_vehicle_type,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// Serializes profile writes PER DRIVER (create-vs-create and create-vs-update
// races), so the read-then-write below is race-free and the audit event is
// accurate. Unrelated drivers never contend.
async function lockDriverProfile(tx: Prisma.TransactionClient, driverId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`swiftdrop.driver_expenses.profile:${driverId}`}, 0))`;
}

export interface UpsertExpenseProfileResult {
  profile: ExpenseProfileDetail;
  created: boolean;
}

// PUT /driver-expenses/drivers/:driverId/profile — create or change the
// default vehicle type. A no-op change writes nothing and audits nothing.
export async function upsertExpenseProfile(
  driverId: string,
  input: UpsertExpenseProfileInput,
  actorUserId: string
): Promise<UpsertExpenseProfileResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      await lockDriverProfile(tx, driverId);
      await assertDriverExists(tx, driverId);

      const existing = await tx.driver_expense_profiles.findUnique({ where: { driver_id: driverId } });

      if (!existing) {
        const row = await tx.driver_expense_profiles.create({
          data: { driver_id: driverId, default_vehicle_type: input.defaultVehicleType },
        });
        await createAuditLog(tx, {
          actorUserId,
          action: "DRIVER_EXPENSE_PROFILE_CREATED",
          entityType: "DRIVER_EXPENSE_PROFILE",
          entityId: row.id,
          newValues: { driverId, defaultVehicleType: row.default_vehicle_type },
        });
        return { profile: toProfileDetail(row), created: true };
      }

      if (existing.default_vehicle_type === input.defaultVehicleType) {
        return { profile: toProfileDetail(existing), created: false };
      }

      const row = await tx.driver_expense_profiles.update({
        where: { id: existing.id },
        data: { default_vehicle_type: input.defaultVehicleType, updated_at: new Date() },
      });
      await createAuditLog(tx, {
        actorUserId,
        action: "DRIVER_EXPENSE_PROFILE_UPDATED",
        entityType: "DRIVER_EXPENSE_PROFILE",
        entityId: row.id,
        previousValues: { defaultVehicleType: existing.default_vehicle_type },
        newValues: { defaultVehicleType: row.default_vehicle_type },
        metadata: { driverId },
      });
      return { profile: toProfileDetail(row), created: false };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    // Unique-index backstop (driver_expense_profiles.driver_id).
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "This driver's profile was changed by another request — please retry",
        details: { reason: "PROFILE_CONFLICT" },
      });
    }
    throw error;
  }
}
