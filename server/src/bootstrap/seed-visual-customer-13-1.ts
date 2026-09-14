import "../config/load-env";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../db/prisma";

/**
 * DEVELOPMENT-ONLY visual acceptance data for the Customer Portal Dashboard
 * (Phase 13.1).
 *
 * Run AFTER `npm run seed:visual`:   npm run seed:visual:customer-13-1
 *
 * Drives the REAL approved HTTP workflows (via the in-process Express app) so
 * customer@swiftdrop.test's /customer/dashboard visibly shows all four cards
 * non-zero:
 *   - one extra ACTIVE DELIVERY_ONLY order  -> Active Orders + Pending Amount
 *   - one DELIVERY_ONLY order taken all the way through an EXACT successful
 *     delivery -> Delivered Orders + Available Wallet (real Phase 8.3
 *     ORDER_CREDIT, never a fabricated ledger row)
 *
 * SAFETY:
 *   - refuses to run when NODE_ENV=production
 *   - only touches the *@swiftdrop.test visual fixtures + PH131-VIS scoped rows
 *   - idempotent: re-running detects the PH131-VIS marker and does nothing
 *   - NO schema change, NO migration, NO manual ledger-row fabrication
 */

const PASSWORD = "VisualTest123!";
const MARKER = "PH131-VIS";

type App = ReturnType<typeof createApp>;

async function login(app: App, email: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password: PASSWORD });
  if (res.status !== 200 || !res.body?.data?.accessToken) {
    throw new Error(`[seed:visual:customer-13-1] login failed for ${email} (status ${res.status}). Run "npm run seed:visual" first.`);
  }
  return res.body.data.accessToken as string;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function main(): Promise<void> {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (nodeEnv === "production") {
    console.error("[seed:visual:customer-13-1] Refusing to run with NODE_ENV=production.");
    process.exitCode = 1;
    return;
  }

  const app = createApp();

  const customerUser = await prisma.users.findUnique({
    where: { email: "customer@swiftdrop.test" },
    select: { id: true },
  });
  if (!customerUser) {
    throw new Error('[seed:visual:customer-13-1] customer@swiftdrop.test not found — run "npm run seed:visual" first.');
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
    console.log("[seed:visual:customer-13-1] PH131-VIS batch already present — skipping.");
  } else {
    const [adminToken, driverToken] = await Promise.all([
      login(app, "admin@swiftdrop.test"),
      login(app, "driver@swiftdrop.test"),
    ]);

    const area =
      (await prisma.areas.findFirst({ where: { name: "PH131 Visual Area" } })) ??
      (await prisma.areas.create({ data: { name: "PH131 Visual Area" } }));
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
          receiverName: `Phase 13.1 Visual Receiver ${seq}`,
          receiverPhone: "+15550009310",
          receiverAreaId: area.id,
          receiverAddress: `${seq} Visual Delivery St, floor 2`,
          description: "Phase 13.1 visual acceptance parcel",
          orderAmount: "120.00",
          deliveryFee: "5.00",
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

    const post = (url: string, token: string, body?: unknown) =>
      request(app).post(url).set(bearer(token)).send(body ?? {});
    async function ok(p: request.Test, label: string) {
      const res = await p;
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`[seed:visual:customer-13-1] ${label} failed (${res.status}): ${JSON.stringify(res.body)}`);
      }
      return res;
    }

    // (1) An extra ACTIVE order — left at RECEIVED. orderAmount 120,
    //     nothing prepaid -> +120 pending (remaining_order_amount).
    await createOrder({ orderAmount: "120.00" });

    // (2) A full EXACT successful delivery -> Delivered Orders + a real
    //     Phase 8.3 wallet ORDER_CREDIT of 120 into Available Wallet.
    const delivered = await createOrder({});
    await ok(post(`/api/v1/orders/${delivered}/assign`, adminToken, { driverId: driverRow.id }), "assign delivery");
    await ok(post(`/api/v1/driver/orders/${delivered}/pickup`, driverToken), "pickup");
    await ok(post(`/api/v1/driver/orders/${delivered}/start-delivery`, driverToken), "start-delivery");
    await ok(
      post(`/api/v1/driver/orders/${delivered}/deliver`, driverToken, { actualAmountCollected: "125.00" }),
      "deliver (exact)"
    );

    console.log("[seed:visual:customer-13-1] PH131-VIS batch created.");
  }

  const customerToken = await login(app, "customer@swiftdrop.test");
  const dash = await request(app).get("/api/v1/customer/me/dashboard").set(bearer(customerToken));
  console.log("[seed:visual:customer-13-1] Done. Dashboard now:", JSON.stringify(dash.body?.data));
}

main()
  .catch((error) => {
    console.error("[seed:visual:customer-13-1] Failed.");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
