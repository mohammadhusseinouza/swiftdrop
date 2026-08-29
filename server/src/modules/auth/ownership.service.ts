import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";

export interface DriverProfile {
  id: string;
  userId: string;
  driverNumber: string;
  isActive: boolean;
}

export interface CustomerProfile {
  id: string;
  userId: string;
  customerNumber: string;
  isActive: boolean;
}

// Resolves the Driver profile belonging to the AUTHENTICATED user. userId
// must come from req.actor (trusted, database-derived) — never from a
// client-supplied value. Rejects safely when no linked profile exists,
// e.g. an ADMIN-role account or a DRIVER-role user without a drivers row.
export async function getDriverProfileForUser(userId: string): Promise<DriverProfile> {
  const driver = await prisma.drivers.findUnique({ where: { user_id: userId } });

  if (!driver) {
    throw new AppError({
      statusCode: 403,
      code: "FORBIDDEN",
      message: "No driver profile is associated with this account",
    });
  }

  return {
    id: driver.id,
    userId: driver.user_id,
    driverNumber: driver.driver_number,
    isActive: driver.is_active,
  };
}

// Resolves the Customer profile whose portal_user_id matches the
// AUTHENTICATED user. userId must come from req.actor — never a
// client-supplied customerId. A customer created by staff without portal
// access has no portal_user_id and will not resolve here.
export async function getCustomerProfileForUser(userId: string): Promise<CustomerProfile> {
  const customer = await prisma.customers.findUnique({ where: { portal_user_id: userId } });

  if (!customer) {
    throw new AppError({
      statusCode: 403,
      code: "FORBIDDEN",
      message: "No customer profile is associated with this account",
    });
  }

  return {
    id: customer.id,
    userId: userId,
    customerNumber: customer.customer_number,
    isActive: customer.is_active,
  };
}
