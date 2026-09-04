import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { hashPassword } from "../../src/modules/auth/auth.utils";
import {
  cleanupTestArea,
  cleanupTestCustomerRecord,
  cleanupTestOrder,
  cleanupTestUser,
  createTestArea,
  createTestDriver,
  createTestUser,
  loginTestUser,
  seedCustomerRecord,
  seedTestOrder,
  TEST_PASSWORD,
  uniqueEmail,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Phase 11.17.4 — Order Engine Integration.
// ============================================================

describe("Parcel Intake — Order Engine Integration (Phase 11.17.4)", () => {
  let app: Express;
  let admin: TestUser;
  let finance: TestUser;
  let driverUserA: TestUser;
  let driverUserB: TestUser;
  let inactiveDriverUser: TestUser;
  let driverA: string;
  let driverB: string;
  let inactiveDriver: string;
  let area: { id: string; name: string };
  let otherArea: { id: string; name: string };
  let customerId: string;
  let customerNoDefaultsId: string;
  let cashMethodId: string;
  let tokens: Record<string, string>;

  // a bespoke role: orders.create + orders.read, but NOT orders.assign
  let createOnlyRoleId: string;
  let createOnlyUser: TestUser;
  let createOnlyToken: string;

  const orderIds: string[] = [];
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  function baseBody(overrides: Record<string, unknown> = {}) {
    return {
      customerId,
      orderType: "DELIVERY_ONLY",
      paymentType: "CASH_ON_DELIVERY",
      receiverName: "PC Receiver",
      receiverPhone: "+96170000009",
      receiverAreaId: area.id,
      receiverAddress: "9 Receiver St",
      description: "11.17.4 order",
      orderAmount: "100.00",
      deliveryFee: "5.00",
      collectionPaymentMethodId: cashMethodId,
      ...overrides,
    };
  }
  async function createOrder(overrides: Record<string, unknown> = {}, token = tokens.admin) {
    const res = await request(app).post("/api/v1/orders").set(auth(token)).send(baseBody(overrides));
    if (res.status === 201) orderIds.push(res.body.data.id);
    return res;
  }
  const seedCollection = async (status: string) => {
    const id = await seedTestOrder(customerId, admin.id, {
      areaId: area.id,
      areaName: area.name,
      parcelIntakeMethod: "DRIVER_COLLECTION",
      parcelCollectionStatus: status as never,
    });
    orderIds.push(id);
    return id;
  };

  before(async () => {
    app = createApp();
    [admin, finance, driverUserA, driverUserB, inactiveDriverUser] = await Promise.all([
      createTestUser("ADMIN"),
      createTestUser("FINANCE"),
      createTestUser("DRIVER"),
      createTestUser("DRIVER"),
      createTestUser("DRIVER"),
    ]);
    [driverA, driverB, inactiveDriver] = await Promise.all([
      createTestDriver(driverUserA.id),
      createTestDriver(driverUserB.id),
      createTestDriver(inactiveDriverUser.id),
    ]);
    await prisma.drivers.update({ where: { id: inactiveDriver }, data: { is_active: false } });
    [area, otherArea] = await Promise.all([createTestArea(), createTestArea()]);
    customerId = await seedCustomerRecord(admin.id, {
      areaId: area.id,
      primaryPhone: "+96170123456",
      secondaryPhone: "+96170999888",
      defaultAddress: "Beirut, Hamra, Main St",
      name: "PC Sender Co",
    });
    customerNoDefaultsId = await seedCustomerRecord(admin.id, { name: "No Defaults Co" });
    cashMethodId = (await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } })).id;

    // bespoke role: orders.create + orders.read only
    const role = await prisma.roles.create({
      data: { name: `PC CreateOnly ${uniqueSuffix()}`, code: `PH1174-CREATE-ONLY-${uniqueSuffix()}` },
    });
    createOnlyRoleId = role.id;
    const perms = await prisma.permissions.findMany({ where: { code: { in: ["orders.create", "orders.read"] } } });
    await prisma.role_permissions.createMany({
      data: perms.map((p) => ({ role_id: role.id, permission_id: p.id })),
    });
    const email = uniqueEmail("createonly");
    const u = await prisma.users.create({
      data: {
        email,
        password_hash: await hashPassword(TEST_PASSWORD),
        first_name: "Create",
        last_name: "Only",
        role_id: role.id,
      },
    });
    createOnlyUser = { id: u.id, email, password: TEST_PASSWORD, roleCode: role.code };

    const logins = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, finance.email, finance.password),
      loginTestUser(app, driverUserA.email, driverUserA.password),
      loginTestUser(app, driverUserB.email, driverUserB.password),
      loginTestUser(app, createOnlyUser.email, createOnlyUser.password),
    ]);
    tokens = {
      admin: logins[0].accessToken as string,
      finance: logins[1].accessToken as string,
      driverA: logins[2].accessToken as string,
      driverB: logins[3].accessToken as string,
    };
    createOnlyToken = logins[4].accessToken as string;
  });

  after(async () => {
    // Defensive: the eligibility-race tests toggle driverB / its user — make
    // sure they are active again even if an assertion threw mid-loop.
    await prisma.drivers.updateMany({ where: { id: { in: [driverA, driverB] } }, data: { is_active: true } });
    await prisma.users.updateMany({ where: { id: { in: [driverUserA.id, driverUserB.id] } }, data: { is_active: true } });
    for (const id of orderIds) await cleanupTestOrder(id);
    await cleanupTestCustomerRecord(customerId);
    await cleanupTestCustomerRecord(customerNoDefaultsId);
    await cleanupTestArea(area.id);
    await cleanupTestArea(otherArea.id);
    await cleanupTestUser(createOnlyUser.id);
    await prisma.role_permissions.deleteMany({ where: { role_id: createOnlyRoleId } });
    await prisma.roles.deleteMany({ where: { id: createOnlyRoleId } });
    for (const u of [driverUserA, driverUserB, inactiveDriverUser, finance, admin]) await cleanupTestUser(u.id);
  });

  // ---- Create: ALREADY_AT_COMPANY (explicit + legacy) --------------

  test("create ALREADY_AT_COMPANY (explicit): RECEIVED_AT_COMPANY, receipt time+actor set, no collection assignment, financials unchanged", async () => {
    const res = await createOrder({ parcelIntakeMethod: "ALREADY_AT_COMPANY" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.parcelIntakeMethod, "ALREADY_AT_COMPANY");
    assert.equal(res.body.data.parcelCollectionStatus, "RECEIVED_AT_COMPANY");
    assert.equal(Number(res.body.data.financial.amountToCollect), 105);

    const row = await prisma.orders.findUniqueOrThrow({ where: { id: res.body.data.id } });
    assert.equal(row.parcel_intake_method, "ALREADY_AT_COMPANY");
    assert.equal(row.parcel_collection_status, "RECEIVED_AT_COMPANY");
    assert.equal(row.current_parcel_collection_driver_id, null);
    assert.equal(row.received_at_company_by_id, admin.id);
    assert.ok(row.received_at_company_at);
    // same logical creation moment (§9) — within a few ms
    assert.ok(Math.abs(row.received_at_company_at!.getTime() - row.created_at.getTime()) < 1000);
    assert.equal(row.parcel_collection_contact_name, null);
    assert.equal(await prisma.parcel_collection_assignments.count({ where: { order_id: row.id } }), 0);
    assert.equal(await prisma.parcel_collection_attempts.count({ where: { order_id: row.id } }), 0);
  });

  test("create with NO parcelIntakeMethod (legacy request) still works -> resolved to ALREADY_AT_COMPANY with coherent receipt", async () => {
    const res = await createOrder();
    assert.equal(res.status, 201);
    assert.equal(res.body.data.parcelIntakeMethod, "ALREADY_AT_COMPANY");
    assert.equal(res.body.data.parcelCollectionStatus, "RECEIVED_AT_COMPANY");
    const row = await prisma.orders.findUniqueOrThrow({ where: { id: res.body.data.id } });
    assert.equal(row.received_at_company_by_id, admin.id);
    assert.ok(row.received_at_company_at);
  });

  // ---- Create: DRIVER_COLLECTION --------------------------------

  test("create DRIVER_COLLECTION without a driver: AWAITING_ASSIGNMENT, snapshot from customer, receipt NULL, no delivery driver", async () => {
    const res = await createOrder({ parcelIntakeMethod: "DRIVER_COLLECTION" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.parcelCollectionStatus, "AWAITING_ASSIGNMENT");

    const row = await prisma.orders.findUniqueOrThrow({ where: { id: res.body.data.id } });
    assert.equal(row.parcel_intake_method, "DRIVER_COLLECTION");
    assert.equal(row.parcel_collection_status, "AWAITING_ASSIGNMENT");
    assert.equal(row.current_parcel_collection_driver_id, null);
    assert.equal(row.received_at_company_at, null);
    assert.equal(row.received_at_company_by_id, null);
    assert.equal(row.parcel_collected_from_sender_at, null);
    // snapshot derived from the customer defaults
    assert.equal(row.parcel_collection_contact_name, "PC Sender Co");
    assert.equal(row.parcel_collection_phone, "+96170123456");
    assert.equal(row.parcel_collection_alt_phone, "+96170999888");
    assert.equal(row.parcel_collection_area_id, area.id);
    assert.equal(row.parcel_collection_area, area.name);
    assert.equal(row.parcel_collection_address, "Beirut, Hamra, Main St");
    assert.equal(row.current_driver_id, null);
    assert.equal(await prisma.parcel_collection_assignments.count({ where: { order_id: row.id } }), 0);
  });

  test("create DRIVER_COLLECTION with a collection driver: ASSIGNED + pointer + one assignment + audit, all atomic; delivery driver stays null", async () => {
    const res = await createOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionDriverId: driverA });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.parcelCollectionStatus, "ASSIGNED");

    const row = await prisma.orders.findUniqueOrThrow({ where: { id: res.body.data.id } });
    assert.equal(row.parcel_collection_status, "ASSIGNED");
    assert.equal(row.current_parcel_collection_driver_id, driverA);
    assert.equal(row.current_driver_id, null);
    const current = await prisma.parcel_collection_assignments.findMany({ where: { order_id: row.id, is_current: true } });
    assert.equal(current.length, 1);
    assert.equal(current[0].driver_id, driverA);
    assert.equal(current[0].assigned_by_id, admin.id);
    assert.equal(
      await prisma.audit_logs.count({ where: { entity_id: row.id, action: "PARCEL_COLLECTION_DRIVER_ASSIGNED" } }),
      1,
    );
  });

  test("create DRIVER_COLLECTION with an INACTIVE collection driver -> 400 and NO order is created", async () => {
    const res = await createOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionDriverId: inactiveDriver });
    assert.equal(res.status, 400);
    // driver eligibility runs BEFORE prisma.$transaction, so no Order row is
    // ever created; the response carries no data.id.
    assert.equal(res.body.data, undefined);
  });

  // ---- Snapshot rules ----------------------------------------

  test("snapshot override wins over the customer default; the customer profile is never modified", async () => {
    const res = await createOrder({
      parcelIntakeMethod: "DRIVER_COLLECTION",
      parcelCollectionAddress: "Beirut, Verdun, Side St",
      parcelCollectionAreaId: otherArea.id,
      parcelCollectionNotes: "ring twice",
    });
    assert.equal(res.status, 201);
    const row = await prisma.orders.findUniqueOrThrow({ where: { id: res.body.data.id } });
    assert.equal(row.parcel_collection_address, "Beirut, Verdun, Side St");
    assert.equal(row.parcel_collection_area_id, otherArea.id);
    assert.equal(row.parcel_collection_area, otherArea.name);
    assert.equal(row.parcel_collection_notes, "ring twice");
    // customer untouched
    const cust = await prisma.customers.findUniqueOrThrow({ where: { id: customerId } });
    assert.equal(cust.default_address, "Beirut, Hamra, Main St");
    assert.equal(cust.default_area_id, area.id);
  });

  test("snapshot immutability: editing the customer after creation does not rewrite the order snapshot", async () => {
    const res = await createOrder({ parcelIntakeMethod: "DRIVER_COLLECTION" });
    const orderId = res.body.data.id;
    await prisma.customers.update({
      where: { id: customerId },
      data: { default_address: "MOVED ADDRESS", name: "RENAMED CO" },
    });
    const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
    assert.equal(row.parcel_collection_address, "Beirut, Hamra, Main St");
    assert.equal(row.parcel_collection_contact_name, "PC Sender Co");
    // restore for other tests
    await prisma.customers.update({
      where: { id: customerId },
      data: { default_address: "Beirut, Hamra, Main St", name: "PC Sender Co" },
    });
  });

  test("snapshot validation: customer has no default address/area and no override -> 400, no order, no assignment", async () => {
    const res = await request(app)
      .post("/api/v1/orders")
      .set(auth(tokens.admin))
      .send(baseBody({ customerId: customerNoDefaultsId, parcelIntakeMethod: "DRIVER_COLLECTION" }));
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.data, undefined);
    assert.equal(await prisma.orders.count({ where: { customer_id: customerNoDefaultsId } }), 0);
  });

  // ---- Invalid combinations (§65) ----------------------------

  test("invalid create combinations", async () => {
    // ALREADY_AT_COMPANY + collection driver -> 400
    assert.equal((await createOrder({ parcelIntakeMethod: "ALREADY_AT_COMPANY", parcelCollectionDriverId: driverA })).status, 400);
    // DRIVER_COLLECTION + delivery driver -> 400
    assert.equal((await createOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", deliveryDriverId: driverA })).status, 400);
    // DRIVER_COLLECTION + collection driver only -> 201 (covered above, re-confirm)
    assert.equal((await createOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionDriverId: driverB })).status, 201);
    // ALREADY_AT_COMPANY + delivery driver -> 201, order ASSIGNED for delivery
    const r = await createOrder({ parcelIntakeMethod: "ALREADY_AT_COMPANY", deliveryDriverId: driverA });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.status, "ASSIGNED");
    assert.equal(r.body.data.currentDriver.id, driverA);
    const row = await prisma.orders.findUniqueOrThrow({ where: { id: r.body.data.id } });
    assert.equal(row.parcel_collection_status, "RECEIVED_AT_COMPANY");
    assert.equal(await prisma.order_assignments.count({ where: { order_id: row.id, is_current: true } }), 1);
  });

  // ---- Create + driver permission (§49/§61) ------------------

  test("create + a driver requires orders.assign (bespoke create-only role -> 403); create WITHOUT a driver -> 201", async () => {
    const denied = await request(app)
      .post("/api/v1/orders")
      .set(auth(createOnlyToken))
      .send(baseBody({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionDriverId: driverA }));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.data, undefined);
    const denied2 = await request(app)
      .post("/api/v1/orders")
      .set(auth(createOnlyToken))
      .send(baseBody({ parcelIntakeMethod: "ALREADY_AT_COMPANY", deliveryDriverId: driverA }));
    assert.equal(denied2.status, 403);

    const ok = await request(app)
      .post("/api/v1/orders")
      .set(auth(createOnlyToken))
      .send(baseBody({ parcelIntakeMethod: "DRIVER_COLLECTION" }));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    orderIds.push(ok.body.data.id);
  });

  // ---- Delivery-assignment gate (§66/§92 — the central invariant) ----

  test("a delivery driver cannot be assigned to a DRIVER_COLLECTION order until parcel_collection_status = RECEIVED_AT_COMPANY", async () => {
    for (const status of ["AWAITING_ASSIGNMENT", "ASSIGNED", "COLLECTED_FROM_SENDER", "FAILED", "RESCHEDULED"]) {
      // The gate reads orders.parcel_collection_status, so seeding just that
      // value exercises it for every non-ready state.
      const orderId = await seedCollection(status);
      const res = await request(app).post(`/api/v1/orders/${orderId}/assign`).set(auth(tokens.admin)).send({ driverId: driverA });
      assert.equal(res.status, 409, `status ${status}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error.message, /received at the company/i);
      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.current_driver_id, null);
      assert.equal(await prisma.order_assignments.count({ where: { order_id: orderId } }), 0);
    }
    // RECEIVED_AT_COMPANY -> allowed
    const readyId = await seedCollection("RECEIVED_AT_COMPANY");
    const ok = await request(app).post(`/api/v1/orders/${readyId}/assign`).set(auth(tokens.admin)).send({ driverId: driverA });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await prisma.orders.findUniqueOrThrow({ where: { id: readyId } })).current_driver_id, driverA);
  });

  test("ALREADY_AT_COMPANY orders keep working with delivery assignment (existing behavior preserved)", async () => {
    const orderId = await seedTestOrder(customerId, admin.id, { areaId: area.id, areaName: area.name });
    orderIds.push(orderId);
    const res = await request(app).post(`/api/v1/orders/${orderId}/assign`).set(auth(tokens.admin)).send({ driverId: driverA });
    assert.equal(res.status, 200);
  });

  test("delivery reassign fails closed when the order's parcel is somehow not at the company", async () => {
    const orderId = await seedCollection("RECEIVED_AT_COMPANY");
    await request(app).post(`/api/v1/orders/${orderId}/assign`).set(auth(tokens.admin)).send({ driverId: driverA });
    // corrupt: push parcel state back
    await prisma.orders.update({ where: { id: orderId }, data: { parcel_collection_status: "ASSIGNED" } });
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/reassign`)
      .set(auth(tokens.admin))
      .send({ driverId: driverB, reason: "test" });
    assert.equal(res.status, 500);
    assert.doesNotMatch(JSON.stringify(res.body), /prisma|P20\d\d/i);
    await prisma.orders.update({ where: { id: orderId }, data: { parcel_collection_status: "RECEIVED_AT_COMPANY" } });
  });

  // ---- Bulk delivery gate (§69) -----------------------------

  test("bulk delivery assign is atomic: one collection-in-progress order rejects the whole batch", async () => {
    const a = await seedCollection("RECEIVED_AT_COMPANY");
    const b = await seedCollection("RECEIVED_AT_COMPANY");
    const c = await seedCollection("ASSIGNED");
    const res = await request(app)
      .post("/api/v1/orders/bulk-assign")
      .set(auth(tokens.admin))
      .send({ orderIds: [a, b, c], driverId: driverA });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    for (const id of [a, b, c]) {
      const row = await prisma.orders.findUniqueOrThrow({ where: { id } });
      assert.equal(row.current_driver_id, null, `${id} must not be assigned`);
    }
    assert.equal(await prisma.order_assignments.count({ where: { order_id: { in: [a, b, c] } } }), 0);
  });

  // ---- Cancellation integration (§70-77) --------------------

  test("cancel from AWAITING_ASSIGNMENT: order CANCELLED, parcel status stays AWAITING_ASSIGNMENT, no assignment/attempt", async () => {
    const orderId = await createOrder({ parcelIntakeMethod: "DRIVER_COLLECTION" }).then((r) => r.body.data.id);
    const res = await request(app).post(`/api/v1/orders/${orderId}/cancel`).set(auth(tokens.admin)).send({ reason: "x" });
    assert.equal(res.status, 200);
    const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
    assert.equal(row.status, "CANCELLED");
    assert.equal(row.parcel_collection_status, "AWAITING_ASSIGNMENT");
    assert.equal(row.current_parcel_collection_driver_id, null);
    assert.equal(await prisma.parcel_collection_assignments.count({ where: { order_id: orderId } }), 0);
    assert.equal(await prisma.parcel_collection_attempts.count({ where: { order_id: orderId } }), 0);
  });

  test("cancel from ASSIGNED: assignment ended ORDER_CANCELLED, pointer NULL, parcel status stays ASSIGNED, OrderStatus CANCELLED, no fabricated attempt", async () => {
    const orderId = await createOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionDriverId: driverA }).then((r) => r.body.data.id);
    const res = await request(app).post(`/api/v1/orders/${orderId}/cancel`).set(auth(tokens.admin)).send({ reason: "customer withdrew" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
    assert.equal(row.status, "CANCELLED");
    assert.equal(row.parcel_collection_status, "ASSIGNED"); // §34 — no CANCELLED collection status
    assert.equal(row.current_parcel_collection_driver_id, null);
    const asg = await prisma.parcel_collection_assignments.findFirstOrThrow({ where: { order_id: orderId } });
    assert.equal(asg.is_current, false);
    assert.equal(asg.end_reason, "ORDER_CANCELLED");
    assert.ok(asg.ended_at);
    assert.equal(await prisma.parcel_collection_attempts.count({ where: { order_id: orderId } }), 0);
    // no CANCELLED current collection assignment; pointer null
    assert.equal(await prisma.parcel_collection_assignments.count({ where: { order_id: orderId, is_current: true } }), 0);
  });

  test("cancelled ASSIGNED-state order: not auto-repaired; parcel-collection mutations 409 (OrderStatus terminal guard wins)", async () => {
    const orderId = await createOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionDriverId: driverA }).then((r) => r.body.data.id);
    await request(app).post(`/api/v1/orders/${orderId}/cancel`).set(auth(tokens.admin)).send({ reason: "x" });
    // read still coherent
    const read = await request(app).get(`/api/v1/orders/${orderId}/parcel-collection`).set(auth(tokens.admin));
    assert.equal(read.status, 200);
    assert.equal(read.body.data.status, "ASSIGNED");
    assert.equal(read.body.data.currentCollectionDriver, null);
    assert.equal(read.body.data.assignments[0].endReason, "ORDER_CANCELLED");
    // every management mutation rejected (terminal order guard wins)
    assert.equal((await request(app).post(`/api/v1/orders/${orderId}/parcel-collection/assign`).set(auth(tokens.admin)).send({ driverId: driverB })).status, 409);
    assert.equal((await request(app).post(`/api/v1/orders/${orderId}/parcel-collection/reschedule`).set(auth(tokens.admin)).send({})).status, 409);
    // driver action: pointer was cleared on cancel -> IDOR-safe 404 (or 409)
    assert.ok(
      [404, 409].includes(
        (await request(app).post(`/api/v1/driver/orders/${orderId}/parcel-collection/collected`).set(auth(tokens.driverA)).send({})).status,
      ),
    );
    // pointer still null, still not repaired
    assert.equal((await prisma.orders.findUniqueOrThrow({ where: { id: orderId } })).current_parcel_collection_driver_id, null);
  });

  test("cancel from COLLECTED_FROM_SENDER is REJECTED (409) — the driver holds the parcel", async () => {
    const orderId = await createOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionDriverId: driverA }).then((r) => r.body.data.id);
    await request(app).post(`/api/v1/driver/orders/${orderId}/parcel-collection/collected`).set(auth(tokens.driverA)).send({});
    const res = await request(app).post(`/api/v1/orders/${orderId}/cancel`).set(auth(tokens.admin)).send({ reason: "x" });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
    assert.equal(row.status, "RECEIVED"); // still active
    assert.equal(row.parcel_collection_status, "COLLECTED_FROM_SENDER");
    assert.equal(row.current_parcel_collection_driver_id, driverA);
    assert.equal(await prisma.order_status_history.count({ where: { order_id: orderId, to_status: "CANCELLED" } }), 0);
  });

  test("cancel from FAILED / RESCHEDULED / RECEIVED_AT_COMPANY proceeds; collection history preserved", async () => {
    for (const status of ["FAILED", "RESCHEDULED", "RECEIVED_AT_COMPANY"] as const) {
      const orderId = await seedCollection(status);
      const res = await request(app).post(`/api/v1/orders/${orderId}/cancel`).set(auth(tokens.admin)).send({ reason: "x" });
      assert.equal(res.status, 200, `${status}: ${JSON.stringify(res.body)}`);
      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.status, "CANCELLED");
      assert.equal(row.parcel_collection_status, status);
      assert.equal(row.current_parcel_collection_driver_id, null);
    }
  });

  test("concurrency: cancel vs driver collected from ASSIGNED -> exactly one wins, DB matches the winner", async () => {
    const orderId = await createOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionDriverId: driverA }).then((r) => r.body.data.id);
    const [cancelRes, collectedRes] = await Promise.all([
      request(app).post(`/api/v1/orders/${orderId}/cancel`).set(auth(tokens.admin)).send({ reason: "race" }),
      request(app).post(`/api/v1/driver/orders/${orderId}/parcel-collection/collected`).set(auth(tokens.driverA)).send({}),
    ]);
    assert.ok([cancelRes.status, collectedRes.status].includes(200));
    const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
    const attempts = await prisma.parcel_collection_attempts.count({ where: { order_id: orderId } });
    if (cancelRes.status === 200) {
      assert.equal(collectedRes.status === 200, false, "both cannot win");
      assert.equal(row.status, "CANCELLED");
      assert.equal(attempts, 0);
      const asg = await prisma.parcel_collection_assignments.findFirstOrThrow({ where: { order_id: orderId } });
      assert.equal(asg.end_reason, "ORDER_CANCELLED");
    } else {
      assert.equal(collectedRes.status, 200);
      assert.equal(row.status, "RECEIVED");
      assert.equal(row.parcel_collection_status, "COLLECTED_FROM_SENDER");
      assert.equal(attempts, 1);
    }
  });

  test("concurrency: cancel vs driver failed from ASSIGNED -> exactly one wins, coherent final state", async () => {
    const orderId = await createOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionDriverId: driverA }).then((r) => r.body.data.id);
    const reason = await prisma.failed_collection_reasons.findFirstOrThrow({ where: { name: "Sender unavailable" } });
    const [cancelRes, failedRes] = await Promise.all([
      request(app).post(`/api/v1/orders/${orderId}/cancel`).set(auth(tokens.admin)).send({ reason: "race" }),
      request(app).post(`/api/v1/driver/orders/${orderId}/parcel-collection/failed`).set(auth(tokens.driverA)).send({ failedCollectionReasonId: reason.id }),
    ]);
    assert.ok([cancelRes.status, failedRes.status].includes(200));
    const asg = await prisma.parcel_collection_assignments.findFirstOrThrow({ where: { order_id: orderId } });
    assert.ok(["ORDER_CANCELLED", "FAILED"].includes(asg.end_reason as string));
    const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
    if (asg.end_reason === "ORDER_CANCELLED") {
      assert.equal(row.status, "CANCELLED");
      assert.equal(await prisma.parcel_collection_attempts.count({ where: { order_id: orderId } }), 0);
    } else {
      assert.equal(row.parcel_collection_status, "FAILED");
      assert.equal(await prisma.parcel_collection_attempts.count({ where: { order_id: orderId } }), 1);
    }
  });

  // ---- Create + driver eligibility ATOMICITY (Phase 11.17.4 correction) ----
  //
  // The authoritative eligibility check runs INSIDE the create transaction
  // (assertDriverEligibleForAssignment(tx, driverId)), immediately before the
  // assignment write. Under READ COMMITTED, that SELECT sees any concurrently
  // committed deactivation — so "deactivation commits, then a stale-validated
  // assignment commits" is impossible.

  test("create + collection driver: a fully-deactivated DRIVER is rejected 400 — no order, no assignment, no audit, no finance", async () => {
    await prisma.drivers.update({ where: { id: driverB }, data: { is_active: false } });
    const beforeAudit = await prisma.audit_logs.count({ where: { action: "PARCEL_COLLECTION_DRIVER_ASSIGNED" } });
    const beforeAssignments = await prisma.parcel_collection_assignments.count({ where: { driver_id: driverB } });
    const res = await createOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionDriverId: driverB });
    await prisma.drivers.update({ where: { id: driverB }, data: { is_active: true } });

    assert.equal(res.status, 400);
    assert.equal(res.body.data, undefined);
    // rolled back: no new assignment row, no new assignment audit for this driver
    assert.equal(await prisma.parcel_collection_assignments.count({ where: { driver_id: driverB } }), beforeAssignments);
    assert.equal(await prisma.audit_logs.count({ where: { action: "PARCEL_COLLECTION_DRIVER_ASSIGNED" } }), beforeAudit);
  });

  test("create + collection driver: a deactivated linked USER is rejected 400", async () => {
    await prisma.users.update({ where: { id: driverUserB.id }, data: { is_active: false } });
    const res = await createOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionDriverId: driverB });
    await prisma.users.update({ where: { id: driverUserB.id }, data: { is_active: true } });
    assert.equal(res.status, 400);
    assert.equal(res.body.data, undefined);
  });

  test("create + delivery driver (Create & Assign): a fully-deactivated driver is rejected 400 — no order, no order_assignments", async () => {
    await prisma.drivers.update({ where: { id: driverB }, data: { is_active: false } });
    const res = await createOrder({ parcelIntakeMethod: "ALREADY_AT_COMPANY", deliveryDriverId: driverB });
    await prisma.drivers.update({ where: { id: driverB }, data: { is_active: true } });
    assert.equal(res.status, 400);
    assert.equal(res.body.data, undefined);
    assert.equal(await prisma.order_assignments.count({ where: { driver_id: driverB, is_current: true } }), 0);
  });

  test("race: create-with-collection-driver vs that driver's deactivation — never a stale assignment", async () => {
    for (let i = 0; i < 6; i++) {
      const [createRes] = await Promise.all([
        createOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionDriverId: driverB }),
        prisma.drivers.update({ where: { id: driverB }, data: { is_active: false } }),
      ]);
      // Both outcomes are valid: create wins (driver was eligible at the in-tx
      // check) OR deactivation wins (create 400, fully rolled back).
      if (createRes.status === 201) {
        const row = await prisma.orders.findUniqueOrThrow({ where: { id: createRes.body.data.id } });
        assert.equal(row.parcel_collection_status, "ASSIGNED");
        assert.equal(row.current_parcel_collection_driver_id, driverB);
        assert.equal(
          (await prisma.parcel_collection_assignments.findMany({ where: { order_id: row.id, is_current: true } })).length,
          1,
        );
      } else {
        assert.equal(createRes.status, 400, JSON.stringify(createRes.body));
        assert.equal(createRes.body.data, undefined);
      }
      await prisma.drivers.update({ where: { id: driverB }, data: { is_active: true } });
    }
    // scoped: no collection assignment was ever created for an order that does
    // not also exist (a rolled-back create leaves nothing behind)
    const orphanAssignments = await prisma.parcel_collection_assignments.findMany({
      where: { driver_id: driverB },
      select: { order_id: true },
    });
    for (const a of orphanAssignments) {
      assert.ok(await prisma.orders.findUnique({ where: { id: a.order_id } }), "assignment must belong to a real order");
    }
  });

  test("race: create-with-delivery-driver vs that driver's deactivation — never a stale delivery assignment", async () => {
    for (let i = 0; i < 6; i++) {
      const [createRes] = await Promise.all([
        createOrder({ parcelIntakeMethod: "ALREADY_AT_COMPANY", deliveryDriverId: driverB }),
        prisma.drivers.update({ where: { id: driverB }, data: { is_active: false } }),
      ]);
      if (createRes.status === 201) {
        const row = await prisma.orders.findUniqueOrThrow({ where: { id: createRes.body.data.id } });
        assert.equal(row.status, "ASSIGNED");
        assert.equal(row.current_driver_id, driverB);
      } else {
        assert.equal(createRes.status, 400);
        assert.equal(createRes.body.data, undefined);
      }
      await prisma.drivers.update({ where: { id: driverB }, data: { is_active: true } });
    }
  });

  test("standalone assign / reassign / bulk-assign also re-check eligibility in-transaction (deactivated driver -> rejected, nothing assigned)", async () => {
    const a = await seedCollection("RECEIVED_AT_COMPANY");
    const b = await seedCollection("RECEIVED_AT_COMPANY");
    await prisma.drivers.update({ where: { id: driverB }, data: { is_active: false } });
    const assignRes = await request(app).post(`/api/v1/orders/${a}/assign`).set(auth(tokens.admin)).send({ driverId: driverB });
    const bulkRes = await request(app).post("/api/v1/orders/bulk-assign").set(auth(tokens.admin)).send({ orderIds: [a, b], driverId: driverB });
    await prisma.drivers.update({ where: { id: driverB }, data: { is_active: true } });
    assert.equal(assignRes.status, 400);
    assert.equal(bulkRes.status, 400);
    for (const id of [a, b]) {
      assert.equal((await prisma.orders.findUniqueOrThrow({ where: { id } })).current_driver_id, null);
    }
    assert.equal(await prisma.order_assignments.count({ where: { order_id: { in: [a, b] } } }), 0);
  });

  // ---- Temp DB default removal (§79) -------------------------

  test("the temporary orders parcel-intake DB defaults are gone; the API still works because the service writes them", async () => {
    const cols = await prisma.$queryRaw<{ column_name: string; column_default: string | null; is_nullable: string }[]>`
      select column_name, column_default, is_nullable from information_schema.columns
       where table_schema='public' and table_name='orders'
         and column_name in ('parcel_intake_method','parcel_collection_status')`;
    for (const c of cols) {
      assert.equal(c.column_default, null, `${c.column_name} default must be null`);
      assert.equal(c.is_nullable, "NO", `${c.column_name} must stay NOT NULL`);
    }
    assert.equal((await createOrder()).status, 201);
  });

  // ---- Order Type matrix (§93) ------------------------------

  test("all four OrderType x ParcelIntakeMethod combinations create successfully", async () => {
    for (const orderType of ["COMPANY_ORDER", "DELIVERY_ONLY"] as const) {
      for (const intake of ["ALREADY_AT_COMPANY", "DRIVER_COLLECTION"] as const) {
        const res = await createOrder({ orderType, parcelIntakeMethod: intake });
        assert.equal(res.status, 201, `${orderType} + ${intake}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.data.orderType, orderType);
        assert.equal(res.body.data.parcelIntakeMethod, intake);
      }
    }
  });

  // ---- E2E + financial / delivery non-regression (§90-92) ----

  test("E2E: create DRIVER_COLLECTION+driver -> collected -> received -> delivery assign succeeds; zero financial/extra-delivery rows from parcel collection", async () => {
    const res = await createOrder({
      orderType: "COMPANY_ORDER",
      parcelIntakeMethod: "DRIVER_COLLECTION",
      parcelCollectionDriverId: driverA,
    });
    const orderId = res.body.data.id;

    assert.equal((await request(app).post(`/api/v1/orders/${orderId}/assign`).set(auth(tokens.admin)).send({ driverId: driverB })).status, 409);
    assert.equal((await request(app).post(`/api/v1/driver/orders/${orderId}/parcel-collection/collected`).set(auth(tokens.driverA)).send({})).status, 200);
    assert.equal((await request(app).post(`/api/v1/orders/${orderId}/assign`).set(auth(tokens.admin)).send({ driverId: driverB })).status, 409);
    assert.equal((await request(app).post(`/api/v1/orders/${orderId}/parcel-collection/receive-at-company`).set(auth(tokens.admin)).send({})).status, 200);

    const ok = await request(app).post(`/api/v1/orders/${orderId}/assign`).set(auth(tokens.admin)).send({ driverId: driverB });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.currentDriver.id, driverB);

    // parcel collection itself created no financial rows and exactly one (delivery) assignment
    assert.equal(await prisma.wallet_transactions.count({ where: { order_id: orderId } }), 0);
    assert.equal(await prisma.driver_cash_transactions.count({ where: { order_id: orderId } }), 0);
    assert.equal(await prisma.company_financial_transactions.count({ where: { order_id: orderId } }), 0);
    assert.equal(await prisma.order_assignments.count({ where: { order_id: orderId } }), 1);
  });

  test("no parcel-collection order-engine action created any wallet/driver-cash/company-finance row for the test orders", async () => {
    const scope = { order_id: { in: orderIds } };
    assert.deepEqual(
      await Promise.all([
        prisma.wallet_transactions.count({ where: scope }),
        prisma.driver_cash_transactions.count({ where: scope }),
        prisma.company_financial_transactions.count({ where: scope }),
      ]),
      [0, 0, 0],
    );
  });
});
