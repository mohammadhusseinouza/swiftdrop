import "../config/load-env";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../db/prisma";

/**
 * DEVELOPMENT-ONLY visual acceptance data for the Customer Portal "My Orders"
 * page (Phase 13.2).
 *
 * Run AFTER `npm run seed:visual` (and ideally after seed:visual:customer-13-1):
 *   npm run seed:visual:customer-13-2
 *
 * Drives the REAL approved HTTP workflows so customer@swiftdrop.test's
 * /customer/orders shows every shape the page must render:
 *   - active COMPANY_ORDER (ALREADY_AT_COMPANY)
 *   - active DELIVERY_ONLY that is DRIVER_COLLECTION: awaiting / assigned /
 *     collected-from-sender
 *   - delivered COMPANY_ORDER (real exact successful delivery)
 * (Phase 13.1's PH131-VIS batch already covers active + delivered
 * DELIVERY_ONLY and ALREADY_AT_COMPANY.)
 *
 * SAFETY: refuses NODE_ENV=production; only touches *@swiftdrop.test fixtures
 * + PH132-VIS scoped rows; idempotent (marker-detected); NO schema change,
 * NO migration, NO manual ledger-row fabrication.
 */

const PASSWORD = "VisualTest123!";
const MARKER = "PH132-VIS";

type App = ReturnType<typeof createApp>;

async function login(app: App, email: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password: PASSWORD });
  if (res.status !== 200 || !res.body?.data?.accessToken) {
    throw new Error(`[seed:visual:customer-13-2] login failed for ${email} (status ${res.status}). Run "npm run seed:visual" first.`);
  }
  return res.body.data.accessToken as string;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function main(): Promise<void> {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (nodeEnv === "production") {
    console.error("[seed:visual:customer-13-2] Refusing to run with NODE_ENV=production.");
    process.exitCode = 1;
    return;
  }

  const app = createApp();

  const customerUser = await prisma.users.findUnique({
    where: { email: "customer@swiftdrop.test" },
    select: { id: true },
  });
  if (!customerUser) {
    throw new Error('[seed:visual:customer-13-2] customer@swiftdrop.test not found — run "npm run seed:visual" first.');
  }
  const customer = await prisma.customers.findUniqueOrThrow({ where: { portal_user_id: customerUser.id } });
  const driverUser = await prisma.users.findUniqueOrThrow({
    where: { email: "driver@swiftdrop.test" },
    select: { id: true },
  });
  const driverRow = await prisma.drivers.findUniqueOrThrow({ where: { user_id: driverUser.id } });

  const existing = await prisma.orders.findFirst({
    where: { order_number: { startsWith: MARKER } },
    select: { id: true },
  });
  if (existing) {
    console.log("[seed:visual:customer-13-2] PH132-VIS batch already present — skipping.");
  } else {
    const [adminToken, driverToken] = await Promise.all([
      login(app, "admin@swiftdrop.test"),
      login(app, "driver@swiftdrop.test"),
    ]);

    const area =
      (await prisma.areas.findFirst({ where: { name: "PH132 Visual Area" } })) ??
      (await prisma.areas.create({ data: { name: "PH132 Visual Area" } }));
    const cashMethod = await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } });

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
          receiverName: `Phase 13.2 Visual Receiver ${seq}`,
          receiverPhone: "+15550009320",
          receiverAreaId: area.id,
          receiverAddress: `${seq} Visual Delivery Ave`,
          description: "Phase 13.2 visual acceptance parcel",
          orderAmount: "80.00",
          deliveryFee: "6.00",
          collectionPaymentMethodId: cashMethod.id,
          parcelIntakeMethod: "ALREADY_AT_COMPANY",
          ...overrides,
        });
      if (res.status !== 201) throw new Error(`create order failed: ${JSON.stringify(res.body)}`);
      const id = res.body.data.id as string;
      await prisma.orders.update({
        where: { id },
        data: { order_number: `${MARKER}-${String(seq).padStart(2, "0")}` },
      });
      return id;
    }

    const collectionBody = () => ({
      parcelIntakeMethod: "DRIVER_COLLECTION",
      parcelCollectionContactName: "Phase 13.2 Visual Sender",
      parcelCollectionPhone: "+15550001320",
      parcelCollectionAddress: "9 Visual Collection Blvd, unit 4",
      parcelCollectionAreaId: area.id,
      parcelCollectionNotes: "Front desk holds the parcel.",
    });

    const post = (url: string, token: string, body?: unknown) =>
      request(app).post(url).set(bearer(token)).send(body ?? {});
    async function ok(p: request.Test, label: string) {
      const res = await p;
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`[seed:visual:customer-13-2] ${label} failed (${res.status}): ${JSON.stringify(res.body)}`);
      }
      return res;
    }

    // (1) Active COMPANY_ORDER, already at the company — left at RECEIVED.
    await createOrder({ orderType: "COMPANY_ORDER", orderAmount: "150.00" });

    // (2) DRIVER_COLLECTION — awaiting collection assignment.
    await createOrder(collectionBody());

    // (3) DRIVER_COLLECTION — collection assigned to a driver.
    const assigned = await createOrder(collectionBody());
    await ok(
      post(`/api/v1/orders/${assigned}/parcel-collection/assign`, adminToken, { driverId: driverRow.id }),
      "assign collection (assigned)"
    );

    // (4) DRIVER_COLLECTION — parcel collected from sender (driver in transit).
    const collected = await createOrder(collectionBody());
    await ok(
      post(`/api/v1/orders/${collected}/parcel-collection/assign`, adminToken, { driverId: driverRow.id }),
      "assign collection (collected)"
    );
    await ok(
      post(`/api/v1/driver/orders/${collected}/parcel-collection/collected`, driverToken),
      "collected from sender"
    );

    // (5) Delivered COMPANY_ORDER — real exact successful delivery.
    const deliveredCompany = await createOrder({ orderType: "COMPANY_ORDER", orderAmount: "90.00" });
    await ok(post(`/api/v1/orders/${deliveredCompany}/assign`, adminToken, { driverId: driverRow.id }), "assign delivery (company)");
    await ok(post(`/api/v1/driver/orders/${deliveredCompany}/pickup`, driverToken), "pickup (company)");
    await ok(post(`/api/v1/driver/orders/${deliveredCompany}/start-delivery`, driverToken), "start (company)");
    await ok(
      post(`/api/v1/driver/orders/${deliveredCompany}/deliver`, driverToken, { actualAmountCollected: "96.00" }),
      "deliver company order (exact)"
    );

    console.log("[seed:visual:customer-13-2] PH132-VIS batch created.");
  }

  const customerToken = await login(app, "customer@swiftdrop.test");
  const [all, active, delivered] = await Promise.all([
    request(app).get("/api/v1/customer/me/orders?limit=100").set(bearer(customerToken)),
    request(app).get("/api/v1/customer/me/orders?view=active&limit=100").set(bearer(customerToken)),
    request(app).get("/api/v1/customer/me/orders?view=delivered&limit=100").set(bearer(customerToken)),
  ]);
  console.log(
    `[seed:visual:customer-13-2] Done. My Orders: all=${all.body?.meta?.total} active=${active.body?.meta?.total} delivered=${delivered.body?.meta?.total}`
  );
}

main()
  .catch((error) => {
    console.error("[seed:visual:customer-13-2] Failed.");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
