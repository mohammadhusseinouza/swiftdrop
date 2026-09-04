import { Prisma } from "../../generated/prisma/client";
import type { drivers, users } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";

// ============================================================
// Driver assignment eligibility (Phase 6.5; extracted to its own module in
// Phase 11.17.4).
//
// A Driver may receive a NEW assignment — final Delivery OR Parcel Collection
// — only when the drivers row AND its linked users account are both active.
// drivers.user_id is a NOT NULL FK, so "a users row exists" is structurally
// guaranteed; only the two is_active flags need checking. This never
// activates/modifies the Driver or User — a rejection here changes nothing.
//
// Lives here (not in orders/order.service.ts) so both modules/orders and
// modules/parcel-collection can import it without a circular dependency.
//
// SINGLE eligibility definition. `assertDriverEligibleForAssignment` takes a
// client so the AUTHORITATIVE check can run inside the same transaction that
// commits the assignment (Phase 11.17.4 correction — a pre-transaction read
// alone is a TOCTOU race: the Driver/User could be deactivated between the
// read and the commit). Under READ COMMITTED, a SELECT issued after a
// concurrent deactivation has committed sees is_active = false, so running
// this immediately before the assignment write is sufficient — no row lock
// needed. `loadEligibleDriverForAssignment` is the pre-transaction wrapper
// kept only for a friendly early error.
// ============================================================

type EligibilityClient = Prisma.TransactionClient | typeof prisma;

export async function assertDriverEligibleForAssignment(
  client: EligibilityClient,
  driverId: string,
): Promise<drivers & { users: users }> {
  const driver = await client.drivers.findUnique({ where: { id: driverId }, include: { users: true } });
  if (!driver) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Driver not found" });
  }
  if (!driver.is_active) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "Driver is not active" });
  }
  if (!driver.users.is_active) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "Driver's linked user account is not active",
    });
  }
  return driver;
}

export function loadEligibleDriverForAssignment(driverId: string): Promise<drivers & { users: users }> {
  return assertDriverEligibleForAssignment(prisma, driverId);
}
