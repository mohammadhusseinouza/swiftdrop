import { Prisma } from "../../generated/prisma/client";
import type { driver_cash_accounts, drivers, users } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import type { CreateDriverInput, ListDriversQuery, UpdateDriverInput } from "./driver.schema";
import type { DriverDetail, DriverSummary, DriverUserSummary } from "./driver.types";

type DriverWithUser = drivers & { users: users };
type DriverWithUserAndCash = DriverWithUser & { driver_cash_accounts: driver_cash_accounts | null };

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

function toDriverSummary(driver: DriverWithUser): DriverSummary {
  return {
    id: driver.id,
    driverNumber: driver.driver_number,
    isActive: driver.is_active,
    user: toDriverUserSummary(driver.users),
    createdAt: driver.created_at.toISOString(),
    updatedAt: driver.updated_at.toISOString(),
  };
}

function toDriverDetail(driver: DriverWithUserAndCash): DriverDetail {
  return {
    ...toDriverSummary(driver),
    cashAccount: driver.driver_cash_accounts
      ? { currentBalance: driver.driver_cash_accounts.current_balance.toString() }
      : null,
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
        message: "A driver with conflicting unique data already exists",
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

  return { items: rows.map(toDriverSummary), total };
}

// A management request may link a Driver only to an EXISTING user — this
// function never creates, invites, or resets authentication accounts. The
// linked user's role is resolved from the database and must already be
// DRIVER; it is never trusted from client input.
export async function createDriver(input: CreateDriverInput): Promise<DriverDetail> {
  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.users.findUnique({
        where: { id: input.userId },
        include: { roles: true },
      });

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

      const existingDriverNumber = await tx.drivers.findUnique({ where: { driver_number: input.driverNumber } });
      if (existingDriverNumber) {
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: `A driver with number "${input.driverNumber}" already exists`,
        });
      }

      const driver = await tx.drivers.create({
        data: {
          user_id: input.userId,
          driver_number: input.driverNumber,
        },
        include: { users: true },
      });

      // Every driver requires exactly one cash account (driver_cash_accounts.
      // driver_id is unique, and "one cash account per driver" is an approved
      // DB integrity rule) — created atomically here, zero balance, no ledger
      // entry needed for a zero-balance account creation.
      const cashAccount = await tx.driver_cash_accounts.create({
        data: { driver_id: driver.id },
      });

      return toDriverDetail({ ...driver, driver_cash_accounts: cashAccount });
    });
  } catch (error) {
    handleKnownDriverError(error, "Failed to create driver");
  }
}

export async function getDriverById(id: string): Promise<DriverDetail> {
  const driver = await prisma.drivers.findUnique({
    where: { id },
    include: { users: true, driver_cash_accounts: true },
  });

  if (!driver) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Driver not found" });
  }

  return toDriverDetail(driver);
}

export async function updateDriver(id: string, input: UpdateDriverInput): Promise<DriverDetail> {
  try {
    const driver = await prisma.drivers.update({
      where: { id },
      data: {
        ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
        updated_at: new Date(),
      },
      include: { users: true, driver_cash_accounts: true },
    });

    return toDriverDetail(driver);
  } catch (error) {
    handleKnownDriverError(error, "Failed to update driver");
  }
}
