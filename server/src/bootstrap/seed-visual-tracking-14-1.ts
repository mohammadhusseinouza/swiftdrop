import "../config/load-env";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../db/prisma";

/**
 * DEVELOPMENT-ONLY visual acceptance data for Public Tracking (Phase 14.1).
 * Run AFTER seed:visual (+ earlier 13.x/11.17 batches):
 *   npm run seed:visual:tracking-14-1
 *
 * The existing PH12x/PH13x visual batches already cover every Public
 * Tracking stage EXCEPT "Out for Delivery" (no prior visual order was ever
 * left mid-delivery, only assigned/picked-up/delivered/failed). This adds
 * exactly that one missing order via the approved Management assign +
 * Driver pickup/start-delivery workflow endpoints, then stops (never calls
 * /deliver) — no other business rule/state is fabricated.
 *
 * SAFETY: refuses NODE_ENV=production; only *@swiftdrop.test + PH141-VIS
 * rows; idempotent (marker-detected); NO schema change / migration / manual
 * status/ledger fabrication (every transition goes through its real
 * service-layer endpoint).
 */

const PASSWORD = "VisualTest123!";
const MARKER = "PH141-VIS";
type App = ReturnType<typeof createApp>;

async function login(app: App, email: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password: PASSWORD });
  if (res.status !== 200 || !res.body?.data?.accessToken) {
    throw new Error(`[seed:visual:tracking-14-1] login failed for ${email} (status ${res.status}).`);
  }
  return res.body.data.accessToken as string;
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function main(): Promise<void> {
  if ((process.env.NODE_ENV ?? "development") === "production") {
    console.error("[seed:visual:tracking-14-1] Refusing to run with NODE_ENV=production.");
    process.exitCode = 1;
    return;
  }
  const app = createApp();

  const existing = await prisma.orders.findFirst({ where: { order_number: { startsWith: MARKER } }, select: { id: true, tracking_code: true } });
  if (existing) {
    console.log(`[seed:visual:tracking-14-1] ${MARKER} batch already present — tracking code: ${existing.tracking_code}`);
    await prisma.$disconnect();
    return;
  }

  const customerUser = await prisma.users.findUnique({ where: { email: "customer@swiftdrop.test" }, select: { id: true } });
  if (!customerUser) throw new Error('[seed:visual:tracking-14-1] customer@swiftdrop.test not found — run "npm run seed:visual" first.');
  const customer = await prisma.customers.findUniqueOrThrow({ where: { portal_user_id: customerUser.id } });
  const driverUser = await prisma.users.findUniqueOrThrow({ where: { email: "driver@swiftdrop.test" }, select: { id: true } });
  const driverRow = await prisma.drivers.findUniqueOrThrow({ where: { user_id: driverUser.id } });

  const [adminToken, driverToken] = await Promise.all([login(app, "admin@swiftdrop.test"), login(app, "driver@swiftdrop.test")]);
  const area =
    (await prisma.areas.findFirst({ where: { name: "PH141 Visual Area" } })) ??
    (await prisma.areas.create({ data: { name: "PH141 Visual Area" } }));
  const cashMethod = await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } });

  const post = (url: string, token: string, body?: unknown) => request(app).post(url).set(bearer(token)).send(body ?? {});
  async function ok(p: request.Test, label: string) {
    const res = await p;
    if (res.status < 200 || res.status >= 300) throw new Error(`[seed:visual:tracking-14-1] ${label} failed (${res.status}): ${JSON.stringify(res.body)}`);
    return res;
  }

  const createRes = await request(app)
    .post("/api/v1/orders")
    .set(bearer(adminToken))
    .send({
      customerId: customer.id,
      orderType: "DELIVERY_ONLY",
      paymentType: "CASH_ON_DELIVERY",
      receiverName: "Phase 14.1 Visual Receiver",
      receiverPhone: "+15550014100",
      receiverAreaId: area.id,
      receiverAddress: "1 Visual Out-For-Delivery Way",
      description: "Phase 14.1 visual acceptance parcel (Out for Delivery)",
      orderAmount: "70.00",
      deliveryFee: "7.00",
      collectionPaymentMethodId: cashMethod.id,
      parcelIntakeMethod: "ALREADY_AT_COMPANY",
    });
  if (createRes.status !== 201) throw new Error(`create order failed: ${JSON.stringify(createRes.body)}`);
  const orderId = createRes.body.data.id as string;
  await prisma.orders.update({ where: { id: orderId }, data: { order_number: `${MARKER}-01` } });

  await ok(post(`/api/v1/orders/${orderId}/assign`, adminToken, { driverId: driverRow.id }), "assign delivery");
  await ok(post(`/api/v1/driver/orders/${orderId}/pickup`, driverToken), "pickup");
  await ok(post(`/api/v1/driver/orders/${orderId}/start-delivery`, driverToken), "start delivery");

  const order = await prisma.orders.findUniqueOrThrow({ where: { id: orderId }, select: { tracking_code: true, status: true } });
  console.log(`[seed:visual:tracking-14-1] Created ${MARKER}-01 — status=${order.status} tracking code: ${order.tracking_code}`);
}

main()
  .catch((error) => {
    console.error("[seed:visual:tracking-14-1] Failed.");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
