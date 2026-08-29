import { Prisma } from "../../generated/prisma/client";
import type { drivers, users } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { createAuditLog } from "../../shared/audit/audit.service";
import { hashPassword } from "../auth/auth.utils";
import { getUtcDayBoundary } from "../../shared/date/day-boundary";
import { ORDER_ACTIVE_STATUSES } from "../orders/order-lifecycle";
import {
  isNewLoginCreateInput,
  type CreateDriverInput,
  type ListDriversQuery,
  type UpdateDriverInput,
} from "./driver.schema";
import type {
  DriverDetail,
  DriverOperationalSummary,
  DriverSummary,
  DriverUserSummary,
} from "./driver.types";

type DriverWithUser = drivers & { users: users };

function toDriverUserSummary(user: users): DriverUserSummary {
  return {
    id: user.id,
    email: user.email,
    firstName: user.first_name,
    lastName: user.last_name,
    phone: user.phone,
    isActive: user.is_active,
  };
}

function emptyOperationalSummary(): DriverOperationalSummary {
  return { activeOrders: 0, outForDelivery: 0, completedToday: 0 };
}

function toDriverSummary(driver: DriverWithUser, operationalSummary: DriverOperationalSummary): DriverSummary {
  return {
    id: driver.id,
    driverNumber: driver.driver_number,
    isActive: driver.is_active,
    user: toDriverUserSummary(driver.users),
    operationalSummary,
    createdAt: driver.created_at.toISOString(),
    updatedAt: driver.updated_at.toISOString(),
  };
}

function handleKnownDriverError(error: unknown, fallbackMessage: string): never {
  if (error instanceof AppError) {
    throw error;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "A record with conflicting unique data already exists",
      });
    }
    if (error.code === "P2003") {
      throw new AppError({
        statusCode: 400,
        code: "VALIDATION_ERROR",
        message: "The specified user does not exist",
      });
    }
    if (error.code === "P2025") {
      throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Driver not found" });
    }
  }

  throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: fallbackMessage });
}

// ============================================================
// Operational summaries (Phase 11.7 correction) — pure DB aggregates,
// reusing the single shared ORDER_ACTIVE_STATUSES definition and the shared
// UTC day boundary. For a page of drivers this runs exactly THREE grouped
// queries total — never one (or three) per driver.
// ============================================================
export async function getDriverOperationalSummaries(
  driverIds: string[]
): Promise<Map<string, DriverOperationalSummary>> {
  const map = new Map<string, DriverOperationalSummary>();
  for (const id of driverIds) map.set(id, emptyOperationalSummary());
  if (driverIds.length === 0) return map;

  const { start, end } = getUtcDayBoundary();

  const [activeGrouped, outForDeliveryGrouped, completedTodayGrouped] = await Promise.all([
    prisma.orders.groupBy({
      by: ["current_driver_id"],
      where: { current_driver_id: { in: driverIds }, status: { in: [...ORDER_ACTIVE_STATUSES] } },
      _count: { _all: true },
    }),
    prisma.orders.groupBy({
      by: ["current_driver_id"],
      where: { current_driver_id: { in: driverIds }, status: "OUT_FOR_DELIVERY" },
      _count: { _all: true },
    }),
    prisma.delivery_attempts.groupBy({
      by: ["driver_id"],
      where: {
        driver_id: { in: driverIds },
        outcome: "DELIVERED",
        completed_at: { gte: start, lt: end },
      },
      _count: { _all: true },
    }),
  ]);

  for (const row of activeGrouped) {
    if (row.current_driver_id) {
      const entry = map.get(row.current_driver_id);
      if (entry) entry.activeOrders = row._count._all;
    }
  }
  for (const row of outForDeliveryGrouped) {
    if (row.current_driver_id) {
      const entry = map.get(row.current_driver_id);
      if (entry) entry.outForDelivery = row._count._all;
    }
  }
  for (const row of completedTodayGrouped) {
    const entry = map.get(row.driver_id);
    if (entry) entry.completedToday = row._count._all;
  }

  return map;
}

export interface ListDriversResult {
  items: DriverSummary[];
  total: number;
}

export async function listDrivers(query: ListDriversQuery): Promise<ListDriversResult> {
  const where: Prisma.driversWhereInput = {};

  if (query.search) {
    where.OR = [
      { driver_number: { contains: query.search, mode: "insensitive" } },
      { users: { first_name: { contains: query.search, mode: "insensitive" } } },
      { users: { last_name: { contains: query.search, mode: "insensitive" } } },
      { users: { phone: { contains: query.search, mode: "insensitive" } } },
      { users: { email: { contains: query.search, mode: "insensitive" } } },
    ];
  }

  if (query.isActive !== undefined) {
    where.is_active = query.isActive;
  }

  const [rows, total] = await Promise.all([
    prisma.drivers.findMany({
      where,
      include: { users: true },
      orderBy: { created_at: "desc" },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.drivers.count({ where }),
  ]);

  const summaries = await getDriverOperationalSummaries(rows.map((r) => r.id));

  return {
    items: rows.map((r) => toDriverSummary(r, summaries.get(r.id) ?? emptyOperationalSummary())),
    total,
  };
}

// ============================================================
// Create
//
// New-login mode performs ONE atomic transaction: DRIVER role load -> email
// uniqueness -> password hash (approved bcrypt helper) -> User (role FORCED
// to DRIVER) -> Driver -> zero-balance cash account -> DRIVER_CREATED audit.
// Any failure rolls the whole thing back: no orphan User / Driver / cash
// account / success audit row.
// ============================================================
export async function createDriver(input: CreateDriverInput, actorUserId: string): Promise<DriverDetail> {
  try {
    const driver = await prisma.$transaction(async (tx) => {
      const driverRole = await tx.roles.findUnique({ where: { code: "DRIVER" } });
      if (!driverRole) {
        throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "DRIVER role is not configured" });
      }

      const existingDriverNumber = await tx.drivers.findUnique({ where: { driver_number: input.driverNumber } });
      if (existingDriverNumber) {
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: `A driver with number "${input.driverNumber}" already exists`,
        });
      }

      let userId: string;

      if (isNewLoginCreateInput(input)) {
        const emailTaken = await tx.users.findUnique({ where: { email: input.user.email } });
        if (emailTaken) {
          throw new AppError({
            statusCode: 409,
            code: "CONFLICT",
            message: "An account with this email already exists",
          });
        }

        const passwordHash = await hashPassword(input.user.password);
        const createdUser = await tx.users.create({
          data: {
            email: input.user.email,
            password_hash: passwordHash,
            first_name: input.user.firstName,
            last_name: input.user.lastName,
            phone: input.user.phone ?? null,
            // Role is FORCED — never taken from the request body.
            role_id: driverRole.id,
            is_active: true,
          },
        });
        userId = createdUser.id;
      } else {
        const user = await tx.users.findUnique({ where: { id: input.userId }, include: { roles: true } });
        if (!user) {
          throw new AppError({
            statusCode: 400,
            code: "VALIDATION_ERROR",
            message: "The specified user does not exist",
          });
        }
        if (user.roles.code !== "DRIVER") {
          throw new AppError({
            statusCode: 400,
            code: "VALIDATION_ERROR",
            message: "The linked user must have the DRIVER role",
          });
        }
        const existingDriverForUser = await tx.drivers.findUnique({ where: { user_id: input.userId } });
        if (existingDriverForUser) {
          throw new AppError({
            statusCode: 409,
            code: "CONFLICT",
            message: "This user is already linked to a driver profile",
          });
        }
        userId = input.userId;
      }

      const created = await tx.drivers.create({
        data: { user_id: userId, driver_number: input.driverNumber },
        include: { users: true },
      });

      // Every driver requires exactly one cash account (driver_cash_accounts.
      // driver_id is unique, and "one cash account per driver" is an approved
      // DB integrity rule) — created atomically here, zero balance, no ledger
      // entry needed for a zero-balance account creation.
      await tx.driver_cash_accounts.create({ data: { driver_id: created.id } });

      // Durable audit record — same transaction as the mutation. Never
      // records the password, password hash, cash balance, or auth data.
      await createAuditLog(tx, {
        actorUserId,
        action: "DRIVER_CREATED",
        entityType: "DRIVER",
        entityId: created.id,
        newValues: {
          driverNumber: created.driver_number,
          userId: created.user_id,
          email: created.users.email,
          firstName: created.users.first_name,
          lastName: created.users.last_name,
          isActive: created.is_active,
          mode: isNewLoginCreateInput(input) ? "NEW_LOGIN" : "EXISTING_USER",
        },
      });

      return created;
    });

    return toDriverSummary(driver, emptyOperationalSummary());
  } catch (error) {
    handleKnownDriverError(error, "Failed to create driver");
  }
}

export async function getDriverById(id: string): Promise<DriverDetail> {
  const driver = await prisma.drivers.findUnique({
    where: { id },
    include: { users: true },
  });

  if (!driver) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Driver not found" });
  }

  const summaries = await getDriverOperationalSummaries([driver.id]);
  return toDriverSummary(driver, summaries.get(driver.id) ?? emptyOperationalSummary());
}

// Profile fields (on the linked User) whose change is worth capturing in the
// audit previous/new values. isActive is handled separately.
const AUDITED_PROFILE_FIELDS = ["firstName", "lastName", "email", "phone"] as const;

export async function updateDriver(
  id: string,
  input: UpdateDriverInput,
  actorUserId: string
): Promise<DriverDetail> {
  const existing = await prisma.drivers.findUnique({ where: { id }, include: { users: true } });
  if (!existing) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Driver not found" });
  }

  const profileTouched = AUDITED_PROFILE_FIELDS.some(
    (f) => (input as Record<string, unknown>)[f] !== undefined
  );
  const isActiveChange = input.isActive !== undefined && input.isActive !== existing.is_active;

  let auditAction: string;
  if (profileTouched) {
    auditAction = "DRIVER_UPDATED";
  } else if (isActiveChange) {
    auditAction = input.isActive ? "DRIVER_REACTIVATED" : "DRIVER_DEACTIVATED";
  } else {
    auditAction = "DRIVER_UPDATED";
  }

  const previousValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  const existingByField: Record<(typeof AUDITED_PROFILE_FIELDS)[number], unknown> = {
    firstName: existing.users.first_name,
    lastName: existing.users.last_name,
    email: existing.users.email,
    phone: existing.users.phone,
  };
  for (const f of AUDITED_PROFILE_FIELDS) {
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

  const userData: Prisma.usersUpdateInput = {};
  if (input.firstName !== undefined) userData.first_name = input.firstName;
  if (input.lastName !== undefined) userData.last_name = input.lastName;
  if (input.email !== undefined) userData.email = input.email;
  if (input.phone !== undefined) userData.phone = input.phone;
  const userTouched = Object.keys(userData).length > 0;

  try {
    const driver = await prisma.$transaction(async (tx) => {
      if (userTouched) {
        userData.updated_at = new Date();
        // Driver deactivation must NEVER touch users.is_active — the linked
        // login's own active state is independent and is not editable here.
        await tx.users.update({ where: { id: existing.user_id }, data: userData });
      }

      const updated = await tx.drivers.update({
        where: { id },
        data: {
          ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
          updated_at: new Date(),
        },
        include: { users: true },
      });

      await createAuditLog(tx, {
        actorUserId,
        action: auditAction,
        entityType: "DRIVER",
        entityId: updated.id,
        previousValues: Object.keys(previousValues).length
          ? (previousValues as unknown as Prisma.InputJsonValue)
          : undefined,
        newValues: Object.keys(newValues).length
          ? (newValues as unknown as Prisma.InputJsonValue)
          : undefined,
      });

      return updated;
    });

    const summaries = await getDriverOperationalSummaries([driver.id]);
    return toDriverSummary(driver, summaries.get(driver.id) ?? emptyOperationalSummary());
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "An account with this email already exists",
      });
    }
    handleKnownDriverError(error, "Failed to update driver");
  }
}
