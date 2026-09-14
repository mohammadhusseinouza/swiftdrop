import "../config/load-env";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../db/prisma";

/**
 * DEVELOPMENT-ONLY visual acceptance data for Customer Order Detail
 * (Phase 13.3). Run AFTER seed:visual (+ 13-1 / 13-2):
 *   npm run seed:visual:customer-13-3
 *
 * Adds the two order shapes the earlier batches don't cover, so every state
 * the Order Detail / tracking review needs exists for customer@swiftdrop.test:
 *   - DRIVER_COLLECTION taken all the way to RECEIVED_AT_COMPANY
 *   - a FAILED_DELIVERY order ("Delivery Attempt Unsuccessful")
 *
 * SAFETY: refuses NODE_ENV=production; only *@swiftdrop.test + PH133-VIS
 * rows; idempotent (marker-detected); NO schema change / migration / manual
 * ledger fabrication.
 */

const PASSWORD = "VisualTest123!";
const MARKER = "PH133-VIS";
type App = ReturnType<typeof createApp>;

async function login(app: App, email: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password: PASSWORD });
  if (res.status !== 200 || !res.body?.data?.accessToken) {
    throw new Error(`[seed:visual:customer-13-3] login failed for ${email} (status ${res.status}).`);
  }
  return res.body.data.accessToken as string;
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function main(): Promise<void> {
  if ((process.env.NODE_ENV ?? "development") === "production") {
    console.error("[seed:visual:customer-13-3] Refusing to run with NODE_ENV=production.");
    process.exitCode = 1;
    return;
  }
  const app = createApp();

  const customerUser = await prisma.users.findUnique({ where: { email: "customer@swiftdrop.test" }, select: { id: true } });
  if (!customerUser) throw new Error('[seed:visual:customer-13-3] customer@swiftdrop.test not found — run "npm run seed:visual" first.');
  const customer = await prisma.customers.findUniqueOrThrow({ where: { portal_user_id: customerUser.id } });
  const driverUser = await prisma.users.findUniqueOrThrow({ where: { email: "driver@swiftdrop.test" }, select: { id: true } });
  const driverRow = await prisma.drivers.findUniqueOrThrow({ where: { user_id: driverUser.id } });

  const existing = await prisma.orders.findFirst({ where: { order_number: { startsWith: MARKER } }, select: { id: true } });
  if (existing) {
    console.log("[seed:visual:customer-13-3] PH133-VIS batch already present — skipping.");
  } else {
    const [adminToken, driverToken] = await Promise.all([login(app, "admin@swiftdrop.test"), login(app, "driver@swiftdrop.test")]);
    const area =
      (await prisma.areas.findFirst({ where: { name: "PH133 Visual Area" } })) ??
      (await prisma.areas.create({ data: { name: "PH133 Visual Area" } }));
    const cashMethod = await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } });
    const failedReason = await prisma.failed_delivery_reasons.findFirstOrThrow({ where: { is_active: true, requires_notes: false } });

    let seq = 0;
    async function createOrder(overrides: Record<string, unknown>): Promise<string> {
      seq += 1;
      const res = await request(app)
        .post("/api/v1/orders")
        .set(bearer(adminToken))
        .send({
          customerId: customer.id,
          orderType: "DELIVERY_ONLY",
          paymentType: "CASH_ON_DELIVERY",
          receiverName: `Phase 13.3 Visual Receiver ${seq}`,
          receiverPhone: "+15550009330",
          receiverAreaId: area.id,
          receiverAddress: `${seq} Visual Delivery Way`,
          description: "Phase 13.3 visual acceptance parcel",
          orderAmount: "70.00",
          deliveryFee: "7.00",
          collectionPaymentMethodId: cashMethod.id,
          parcelIntakeMethod: "ALREADY_AT_COMPANY",
          ...overrides,
        });
      if (res.status !== 201) throw new Error(`create order failed: ${JSON.stringify(res.body)}`);
      const id = res.body.data.id as string;
      await prisma.orders.update({ where: { id }, data: { order_number: `${MARKER}-${String(seq).padStart(2, "0")}` } });
      return id;
    }
    const post = (url: string, token: string, body?: unknown) => request(app).post(url).set(bearer(token)).send(body ?? {});
    async function ok(p: request.Test, label: string) {
      const res = await p;
      if (res.status < 200 || res.status >= 300) throw new Error(`[seed:visual:customer-13-3] ${label} failed (${res.status}): ${JSON.stringify(res.body)}`);
      return res;
    }

    // (1) DRIVER_COLLECTION -> RECEIVED_AT_COMPANY.
    const received = await createOrder({
      parcelIntakeMethod: "DRIVER_COLLECTION",
      parcelCollectionContactName: "Phase 13.3 Visual Sender",
      parcelCollectionPhone: "+15550001330",
      parcelCollectionAddress: "3 Visual Collection Ct",
      parcelCollectionAreaId: area.id,
    });
    await ok(post(`/api/v1/orders/${received}/parcel-collection/assign`, adminToken, { driverId: driverRow.id }), "assign collection");
    await ok(post(`/api/v1/driver/orders/${received}/parcel-collection/collected`, driverToken), "collected from sender");
    await ok(post(`/api/v1/orders/${received}/parcel-collection/receive-at-company`, adminToken), "receive at company");

    // (2) FAILED_DELIVERY.
    const failed = await createOrder({});
    await ok(post(`/api/v1/orders/${failed}/assign`, adminToken, { driverId: driverRow.id }), "assign delivery (failed)");
    await ok(post(`/api/v1/driver/orders/${failed}/pickup`, driverToken), "pickup (failed)");
    await ok(post(`/api/v1/driver/orders/${failed}/start-delivery`, driverToken), "start (failed)");
    await ok(post(`/api/v1/driver/orders/${failed}/fail`, driverToken, { failedReasonId: failedReason.id }), "fail delivery");

    console.log("[seed:visual:customer-13-3] PH133-VIS batch created.");
  }

  const customerToken = await login(app, "customer@swiftdrop.test");
  const all = await request(app).get("/api/v1/customer/me/orders?limit=100").set(bearer(customerToken));
  console.log(`[seed:visual:customer-13-3] Done. My Orders total = ${all.body?.meta?.total}`);
}

main()
  .catch((error) => {
    console.error("[seed:visual:customer-13-3] Failed.");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
