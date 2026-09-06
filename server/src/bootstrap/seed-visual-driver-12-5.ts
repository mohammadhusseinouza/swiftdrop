import "../config/load-env";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../db/prisma";

/**
 * DEVELOPMENT-ONLY visual acceptance data for the Driver Portal
 * (Phase 12.5 Completed / Failed / My Cash + Phase 12.6 final review).
 *
 * Run AFTER `npm run seed:visual`:   npm run seed:visual:driver-12-5
 *
 * Drives the REAL approved HTTP workflows (via the in-process Express app) to
 * give driver@swiftdrop.test a stable dataset covering every Driver Portal
 * surface:
 *   HISTORY batch  (marker PH125-VIS-*)
 *     Completed : 1 COLLECTION (through company receipt) + 1 DELIVERY
 *     Failed    : 1 COLLECTION (rescheduled -> resulting status differs)
 *                 + 1 DELIVERY (failed) + 1 DELIVERY later RETURNED_TO_COMPANY
 *   CURRENT-JOBS batch  (marker PH125-CUR-*)
 *     1 current COLLECTION in ASSIGNED
 *     1 current COLLECTION in COLLECTED_FROM_SENDER (custody)
 *     1 current DELIVERY in ASSIGNED
 *     1 current DELIVERY in PICKED_UP
 *     1 current DELIVERY in OUT_FOR_DELIVERY
 *   My Cash : a real COLLECTION row (cash-collecting delivery) + a real
 *             SETTLEMENT row (Finance settlement workflow)
 *
 * SAFETY:
 *   - refuses to run when NODE_ENV=production
 *   - only touches the *@swiftdrop.test visual fixtures + PH125-* scoped rows
 *   - each batch is INDEPENDENTLY idempotent (its marker order is detected)
 *   - NO schema change, NO migration, NO manual ledger-row fabrication
 */

const PASSWORD = "VisualTest123!";
const HISTORY_MARKER = "PH125-VIS";
const CURRENT_MARKER = "PH125-CUR";

async function login(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password: PASSWORD });
  if (res.status !== 200 || !res.body?.data?.accessToken) {
    throw new Error(`[seed:visual:driver-12-5] login failed for ${email} (status ${res.status}). Run "npm run seed:visual" first.`);
  }
  return res.body.data.accessToken as string;
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function main(): Promise<void> {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (nodeEnv === "production") {
    console.error("[seed:visual:driver-12-5] Refusing to run with NODE_ENV=production.");
    process.exitCode = 1;
    return;
  }

  const app = createApp();

  const driver = await prisma.users.findUnique({ where: { email: "driver@swiftdrop.test" }, select: { id: true } });
  if (!driver) {
    throw new Error('[seed:visual:driver-12-5] driver@swiftdrop.test not found — run "npm run seed:visual" first.');
  }
  const driverRow = await prisma.drivers.findUniqueOrThrow({ where: { user_id: driver.id } });
  const adminUser = await prisma.users.findUniqueOrThrow({ where: { email: "admin@swiftdrop.test" }, select: { id: true } });

  const [adminToken, driverToken, financeToken] = await Promise.all([
    login(app, "admin@swiftdrop.test"),
    login(app, "driver@swiftdrop.test"),
    login(app, "finance@swiftdrop.test"),
  ]);

  // Reference data — scoped, idempotent. Areas/customers are master data.
  const area =
    (await prisma.areas.findFirst({ where: { name: "PH125 Visual Area" } })) ??
    (await prisma.areas.create({ data: { name: "PH125 Visual Area" } }));

  let customer = await prisma.customers.findFirst({ where: { customer_number: "CUS-PH125-VIS" } });
  if (!customer) {
    customer = await prisma.customers.create({
      data: {
        customer_number: "CUS-PH125-VIS",
        name: "Phase 12.5 Visual Sender",
        primary_phone: "+15550001250",
        default_address: "12 Visual Collection Rd",
        default_area_id: area.id,
        created_by_id: adminUser.id,
      },
    });
    await prisma.customer_wallets.create({ data: { customer_id: customer.id } });
  }

  const cashMethod = await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } });
  const activeDeliveryReason = await prisma.failed_delivery_reasons.findFirstOrThrow({ where: { is_active: true, requires_notes: false } });
  const activeCollectionReason = await prisma.failed_collection_reasons.findFirstOrThrow({ where: { is_active: true, requires_notes: false } });

  let seq = 0;
  async function createOrder(marker: string, overrides: Record<string, unknown>): Promise<{ id: string; orderNumber: string }> {
    seq += 1;
    const res = await request(app)
      .post("/api/v1/orders")
      .set(bearer(adminToken))
      .send({
        customerId: customer!.id,
        orderType: "DELIVERY_ONLY",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: `Phase 12 Visual Receiver ${seq}`,
        receiverPhone: "+15550009250",
        receiverAreaId: area.id,
        receiverAddress: `${seq} Visual Delivery St, floor 3`,
        description: "Phase 12 visual acceptance parcel",
        orderAmount: "100.00",
        deliveryFee: "5.00",
        collectionPaymentMethodId: cashMethod.id,
        parcelIntakeMethod: "ALREADY_AT_COMPANY",
        ...overrides,
      });
    if (res.status !== 201) throw new Error(`create order failed: ${JSON.stringify(res.body)}`);
    const num = `${marker}-${String(seq).padStart(2, "0")}`;
    await prisma.orders.update({ where: { id: res.body.data.id }, data: { order_number: num } });
    return { id: res.body.data.id, orderNumber: num };
  }

  function collectionOverrides(): Record<string, unknown> {
    return {
      parcelIntakeMethod: "DRIVER_COLLECTION",
      parcelCollectionContactName: "Phase 12 Visual Sender",
      parcelCollectionPhone: "+15550001250",
      parcelCollectionAddress: "12 Visual Collection Rd, building B",
      parcelCollectionAreaId: area.id,
      parcelCollectionNotes: "Ring the side buzzer; parcel is behind the counter.",
    };
  }

  const post = (url: string, token: string, body?: unknown) => request(app).post(url).set(bearer(token)).send(body ?? {});
  async function ok(p: request.Test, label: string) {
    const res = await p;
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`[seed:visual:driver-12-5] ${label} failed (${res.status}): ${JSON.stringify(res.body)}`);
    }
    return res;
  }

  // ============================================================
  // BATCH 1 — HISTORY (Completed / Failed pages)
  // ============================================================
  const historyMarker = await prisma.orders.findFirst({ where: { order_number: { startsWith: HISTORY_MARKER } }, select: { id: true } });
  if (historyMarker) {
    console.log("[seed:visual:driver-12-5] History batch already present — skipping.");
  } else {
    // Completed DELIVERY (also the Driver Cash COLLECTION row).
    {
      const o = await createOrder(HISTORY_MARKER, {});
      await ok(post(`/api/v1/orders/${o.id}/assign`, adminToken, { driverId: driverRow.id }), "assign delivery (completed)");
      await ok(post(`/api/v1/driver/orders/${o.id}/pickup`, driverToken), "pickup (completed)");
      await ok(post(`/api/v1/driver/orders/${o.id}/start-delivery`, driverToken), "start (completed)");
      await ok(post(`/api/v1/driver/orders/${o.id}/deliver`, driverToken, { actualAmountCollected: "105.00" }), "deliver (completed)");
    }
    // Failed DELIVERY.
    {
      const o = await createOrder(HISTORY_MARKER, {});
      await ok(post(`/api/v1/orders/${o.id}/assign`, adminToken, { driverId: driverRow.id }), "assign delivery (failed)");
      await ok(post(`/api/v1/driver/orders/${o.id}/pickup`, driverToken), "pickup (failed)");
      await ok(post(`/api/v1/driver/orders/${o.id}/start-delivery`, driverToken), "start (failed)");
      await ok(post(`/api/v1/driver/orders/${o.id}/fail`, driverToken, { failedReasonId: activeDeliveryReason.id }), "fail delivery");
    }
    // Failed DELIVERY that Management later returns to company.
    {
      const o = await createOrder(HISTORY_MARKER, {});
      await ok(post(`/api/v1/orders/${o.id}/assign`, adminToken, { driverId: driverRow.id }), "assign delivery (returned)");
      await ok(post(`/api/v1/driver/orders/${o.id}/pickup`, driverToken), "pickup (returned)");
      await ok(post(`/api/v1/driver/orders/${o.id}/start-delivery`, driverToken), "start (returned)");
      await ok(post(`/api/v1/driver/orders/${o.id}/fail`, driverToken, { failedReasonId: activeDeliveryReason.id }), "fail delivery (returned)");
      const r = await post(`/api/v1/orders/${o.id}/reschedule`, adminToken, { reason: "visual: retry" });
      if (r.status >= 200 && r.status < 300) {
        await prisma.orders.update({ where: { id: o.id }, data: { status: "RETURNED_TO_COMPANY" } });
        await prisma.order_status_history.create({
          data: { order_id: o.id, from_status: "RESCHEDULED", to_status: "RETURNED_TO_COMPANY", changed_by_id: adminUser.id },
        });
      }
    }
    // Completed COLLECTION.
    {
      const o = await createOrder(HISTORY_MARKER, collectionOverrides());
      await ok(post(`/api/v1/orders/${o.id}/parcel-collection/assign`, adminToken, { driverId: driverRow.id }), "assign collection (completed)");
      await ok(post(`/api/v1/driver/orders/${o.id}/parcel-collection/collected`, driverToken), "collected");
      await ok(post(`/api/v1/orders/${o.id}/parcel-collection/receive-at-company`, adminToken), "receive at company");
    }
    // Failed COLLECTION -> Management reschedules.
    {
      const o = await createOrder(HISTORY_MARKER, collectionOverrides());
      await ok(post(`/api/v1/orders/${o.id}/parcel-collection/assign`, adminToken, { driverId: driverRow.id }), "assign collection (failed)");
      await ok(post(`/api/v1/driver/orders/${o.id}/parcel-collection/failed`, driverToken, { failedCollectionReasonId: activeCollectionReason.id }), "fail collection");
      await ok(post(`/api/v1/orders/${o.id}/parcel-collection/reschedule`, adminToken), "reschedule collection");
    }
    // Real Finance SETTLEMENT (My Cash).
    {
      const s = await request(app)
        .post("/api/v1/driver-settlements")
        .set(bearer(financeToken))
        .set("Idempotency-Key", `ph125-visual-${driverRow.id}`)
        .send({ driverId: driverRow.id, amountReceived: "40.00", paymentMethodId: cashMethod.id });
      if (s.status !== 201) throw new Error(`[seed:visual:driver-12-5] settlement failed (${s.status}): ${JSON.stringify(s.body)}`);
    }
    console.log("[seed:visual:driver-12-5] History batch created.");
  }

  // ============================================================
  // BATCH 2 — CURRENT JOBS (My Jobs page — one per state)
  // ============================================================
  const currentMarker = await prisma.orders.findFirst({ where: { order_number: { startsWith: CURRENT_MARKER } }, select: { id: true } });
  if (currentMarker) {
    console.log("[seed:visual:driver-12-5] Current-jobs batch already present — skipping.");
  } else {
    // Current COLLECTION — ASSIGNED.
    {
      const o = await createOrder(CURRENT_MARKER, collectionOverrides());
      await ok(post(`/api/v1/orders/${o.id}/parcel-collection/assign`, adminToken, { driverId: driverRow.id }), "assign collection (current ASSIGNED)");
    }
    // Current COLLECTION — COLLECTED_FROM_SENDER (custody).
    {
      const o = await createOrder(CURRENT_MARKER, collectionOverrides());
      await ok(post(`/api/v1/orders/${o.id}/parcel-collection/assign`, adminToken, { driverId: driverRow.id }), "assign collection (current custody)");
      await ok(post(`/api/v1/driver/orders/${o.id}/parcel-collection/collected`, driverToken), "collected (current custody)");
    }
    // Current DELIVERY — ASSIGNED.
    {
      const o = await createOrder(CURRENT_MARKER, {});
      await ok(post(`/api/v1/orders/${o.id}/assign`, adminToken, { driverId: driverRow.id }), "assign delivery (current ASSIGNED)");
    }
    // Current DELIVERY — PICKED_UP.
    {
      const o = await createOrder(CURRENT_MARKER, {});
      await ok(post(`/api/v1/orders/${o.id}/assign`, adminToken, { driverId: driverRow.id }), "assign delivery (current PICKED_UP)");
      await ok(post(`/api/v1/driver/orders/${o.id}/pickup`, driverToken), "pickup (current PICKED_UP)");
    }
    // Current DELIVERY — OUT_FOR_DELIVERY.
    {
      const o = await createOrder(CURRENT_MARKER, {});
      await ok(post(`/api/v1/orders/${o.id}/assign`, adminToken, { driverId: driverRow.id }), "assign delivery (current OUT_FOR_DELIVERY)");
      await ok(post(`/api/v1/driver/orders/${o.id}/pickup`, driverToken), "pickup (current OUT_FOR_DELIVERY)");
      await ok(post(`/api/v1/driver/orders/${o.id}/start-delivery`, driverToken), "start (current OUT_FOR_DELIVERY)");
    }
    console.log("[seed:visual:driver-12-5] Current-jobs batch created.");
  }

  const [cash, jobs] = await Promise.all([
    request(app).get("/api/v1/driver/me/cash").set(bearer(driverToken)),
    request(app).get("/api/v1/driver/jobs?limit=50").set(bearer(driverToken)),
  ]);
  console.log("[seed:visual:driver-12-5] Done.");
  console.log(`  cash held: ${cash.body?.data?.account?.currentBalance ?? "?"}  |  current jobs: ${jobs.body?.meta?.total ?? "?"}`);
}

main()
  .catch((error) => {
    console.error("[seed:visual:driver-12-5] Failed.");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
