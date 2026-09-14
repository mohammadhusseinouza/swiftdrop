import "../config/load-env";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../db/prisma";

/**
 * DEVELOPMENT-ONLY visual acceptance data for the Customer Portal Profile
 * page (Phase 13.7).
 *
 * Run AFTER `npm run seed:visual`:   npm run seed:visual:customer-13-7
 *
 * Ensures customer@swiftdrop.test's Customer record has every OPTIONAL
 * profile field populated so /customer/profile visibly renders all of:
 *   Name, Customer Number, Primary Phone, Secondary Phone, Email,
 *   Default Area, Default Address.
 *
 * It changes the customer through the REAL approved Management workflow
 * (PATCH /api/v1/customers/:id as admin) — never a hand-written UPDATE on a
 * production data path. The only direct write is creating the dev reference
 * Area (same approach as seed-visual-customer-13-1).
 *
 * SAFETY:
 *   - refuses to run when NODE_ENV=production
 *   - only touches customer@swiftdrop.test + the "PH137 Visual Area" row
 *   - idempotent: skips any field that is already set; re-running is a no-op
 *   - NO schema change, NO migration, NO financial-history change
 */

const PASSWORD = "VisualTest123!";
const SECONDARY_PHONE = "+15550009377";
const DEFAULT_ADDRESS = "18 Visual Avenue, Building A, Floor 4";
const AREA_NAME = "PH137 Visual Area";

type App = ReturnType<typeof createApp>;

async function login(app: App, email: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password: PASSWORD });
  if (res.status !== 200 || !res.body?.data?.accessToken) {
    throw new Error(
      `[seed:visual:customer-13-7] login failed for ${email} (status ${res.status}). Run "npm run seed:visual" first.`
    );
  }
  return res.body.data.accessToken as string;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function main(): Promise<void> {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (nodeEnv === "production") {
    console.error("[seed:visual:customer-13-7] Refusing to run with NODE_ENV=production.");
    process.exitCode = 1;
    return;
  }

  const app = createApp();

  const customerUser = await prisma.users.findUnique({
    where: { email: "customer@swiftdrop.test" },
    select: { id: true },
  });
  if (!customerUser) {
    throw new Error('[seed:visual:customer-13-7] customer@swiftdrop.test not found — run "npm run seed:visual" first.');
  }
  const customer = await prisma.customers.findUniqueOrThrow({
    where: { portal_user_id: customerUser.id },
    select: {
      id: true,
      secondary_phone: true,
      default_address: true,
      default_area_id: true,
    },
  });

  const area =
    (await prisma.areas.findFirst({ where: { name: AREA_NAME } })) ??
    (await prisma.areas.create({ data: { name: AREA_NAME } }));

  const patch: Record<string, unknown> = {};
  if (!customer.secondary_phone) patch.secondaryPhone = SECONDARY_PHONE;
  if (!customer.default_address) patch.defaultAddress = DEFAULT_ADDRESS;
  if (!customer.default_area_id) patch.defaultAreaId = area.id;

  if (Object.keys(patch).length === 0) {
    console.log("[seed:visual:customer-13-7] All optional profile fields already set — nothing to do.");
  } else {
    const adminToken = await login(app, "admin@swiftdrop.test");
    const res = await request(app)
      .patch(`/api/v1/customers/${customer.id}`)
      .set(bearer(adminToken))
      .send(patch);
    if (res.status !== 200) {
      throw new Error(`[seed:visual:customer-13-7] PATCH customer failed (${res.status}): ${JSON.stringify(res.body)}`);
    }
    console.log("[seed:visual:customer-13-7] Applied:", JSON.stringify(Object.keys(patch)));
  }

  const customerToken = await login(app, "customer@swiftdrop.test");
  const profile = await request(app).get("/api/v1/customer/me/profile").set(bearer(customerToken));
  console.log("[seed:visual:customer-13-7] Done. Profile now:", JSON.stringify(profile.body?.data));
}

main()
  .catch((error) => {
    console.error("[seed:visual:customer-13-7] Failed.");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
