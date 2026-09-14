import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import type { CustomerProfile } from "./customer-profile.types";

// ============================================================
// GET /api/v1/customer/me/profile (Phase 13.7)
//
// SELF-SCOPED, READ-ONLY. The Customer is resolved ONLY from
// req.actor.userId (passed in as `userId`) — there is no code path that
// reads a customerId / customerNumber / userId from query/params/body, so a
// `?customerId=<other>` spoof has no effect (identical discipline to
// customer-dashboard.service.ts / customer-wallet.service.ts).
//
// ONE fixed query (task §60): a single `customers.findUnique` on the unique
// `portal_user_id` with a fixed `select` and the `default_area` relation
// joined in the same query — no per-field lookup, no second round-trip.
// (This deliberately does NOT layer getCustomerProfileForUser + a second
// findUnique the way the wallet/dashboard services do — those need the
// shared wallet-figures helper; the Profile read needs none, so one query
// with the area join is both correct and the minimum.)
//
// The 403 for an account with no linked `customers` row is byte-identical to
// getCustomerProfileForUser's — a CUSTOMER-role user whose portal account was
// never linked to a customer record gets a safe, controlled failure. No
// auto-create, no email-based guess, no account linking (task §39).
//
// Pure read — this module issues no writes and creates zero side effects
// (task §26 / §58).
// ============================================================

const customerProfileSelect = {
  customer_number: true,
  name: true,
  primary_phone: true,
  secondary_phone: true,
  email: true,
  default_address: true,
  areas: { select: { name: true } },
} as const;

export async function getCustomerProfile(userId: string): Promise<CustomerProfile> {
  const customer = await prisma.customers.findUnique({
    where: { portal_user_id: userId },
    select: customerProfileSelect,
  });

  if (!customer) {
    throw new AppError({
      statusCode: 403,
      code: "FORBIDDEN",
      message: "No customer profile is associated with this account",
    });
  }

  return {
    customerNumber: customer.customer_number,
    name: customer.name,
    primaryPhone: customer.primary_phone,
    secondaryPhone: customer.secondary_phone,
    email: customer.email,
    defaultArea: customer.areas ? { name: customer.areas.name } : null,
    defaultAddress: customer.default_address,
  };
}
