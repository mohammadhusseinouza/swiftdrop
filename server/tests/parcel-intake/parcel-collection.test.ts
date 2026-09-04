import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
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
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Phase 11.17.3 — Parcel Collection Backend.
//
// Kept deliberately lean (orders are reused within each describe block) so
// the shared-DB test suite's parallelism headroom is not perturbed.
// ============================================================

describe("Parcel Collection Backend (Phase 11.17.3)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let customerUser: TestUser;
  let driverUserA: TestUser;
  let driverUserB: TestUser;
  let driverUserC: TestUser;
  let inactiveDriverUser: TestUser;
  let driverA: string;
  let driverB: string;
  let driverC: string;
  let inactiveDriver: string;
  let area: { id: string; name: string };
  let customerId: string;
  let tokens: Record<string, string>;

  const orderIds: string[] = [];
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function seedCollectionOrder(overrides: Parameters<typeof seedTestOrder>[2] = {}): Promise<string> {
    const id = await seedTestOrder(customerId, admin.id, {
      areaId: area.id,
      areaName: area.name,
      parcelIntakeMethod: "DRIVER_COLLECTION",
      parcelCollectionStatus: "AWAITING_ASSIGNMENT",
      ...overrides,
    });
    orderIds.push(id);
    return id;
  }
  const assign = (orderId: string, driverId: string, token = tokens.admin) =>
    request(app).post(`/api/v1/orders/${orderId}/parcel-collection/assign`).set(auth(token)).send({ driverId });
  const collected = (orderId: string, token: string) =>
    request(app).post(`/api/v1/driver/orders/${orderId}/parcel-collection/collected`).set(auth(token)).send({});
  const failCollection = (orderId: string, token: string, reasonId: string, notes?: string) =>
    request(app)
      .post(`/api/v1/driver/orders/${orderId}/parcel-collection/failed`)
      .set(auth(token))
      .send({ failedCollectionReasonId: reasonId, ...(notes ? { notes } : {}) });

  before(async () => {
    app = createApp();
    [admin, dispatcher, finance, customerUser, driverUserA, driverUserB, driverUserC, inactiveDriverUser] =
      await Promise.all([
        createTestUser("ADMIN"),
        createTestUser("DISPATCHER"),
        createTestUser("FINANCE"),
        createTestUser("CUSTOMER"),
        createTestUser("DRIVER"),
        createTestUser("DRIVER"),
        createTestUser("DRIVER"),
        createTestUser("DRIVER"),
      ]);
    [driverA, driverB, driverC, inactiveDriver] = await Promise.all([
      createTestDriver(driverUserA.id),
      createTestDriver(driverUserB.id),
      createTestDriver(driverUserC.id),
      createTestDriver(inactiveDriverUser.id),
    ]);
    await prisma.drivers.update({ where: { id: inactiveDriver }, data: { is_active: false } });
    area = await createTestArea();
    customerId = await seedCustomerRecord(admin.id, { areaId: area.id });

    const l = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, dispatcher.email, dispatcher.password),
      loginTestUser(app, finance.email, finance.password),
      loginTestUser(app, customerUser.email, customerUser.password),
      loginTestUser(app, driverUserA.email, driverUserA.password),
      loginTestUser(app, driverUserB.email, driverUserB.password),
    ]);
    tokens = {
      admin: l[0].accessToken as string,
      dispatcher: l[1].accessToken as string,
      finance: l[2].accessToken as string,
      customer: l[3].accessToken as string,
      driverA: l[4].accessToken as string,
      driverB: l[5].accessToken as string,
    };
  });

  after(async () => {
    for (const id of orderIds) await cleanupTestOrder(id);
    await cleanupTestCustomerRecord(customerId);
    await cleanupTestArea(area.id);
    for (const u of [driverUserA, driverUserB, driverUserC, inactiveDriverUser, customerUser, finance, dispatcher, admin]) {
      await cleanupTestUser(u.id);
    }
  });

  // ---- Happy-path full lifecycle + delivery/finance neutrality --------

  test("full lifecycle assign -> collected -> received: state, history, audit, zero delivery/finance rows", async () => {
    const orderId = await seedCollectionOrder({ orderType: "DELIVERY_ONLY" });

    const a = await assign(orderId, driverA, tokens.dispatcher);
    assert.equal(a.status, 200);
    assert.equal(a.body.data.status, "ASSIGNED");
    assert.equal(a.body.data.currentCollectionDriver.id, driverA);
    assert.equal(a.body.data.assignments[0].assignedBy.id, dispatcher.id);

    const c = await collected(orderId, tokens.driverA);
    assert.equal(c.status, 200);
    assert.equal(c.body.data.parcelCollectionStatus, "COLLECTED_FROM_SENDER");
    assert.ok(c.body.data.parcelCollectedFromSenderAt);
    assert.equal(c.body.data.latestAttempt.outcome, "COLLECTED");
    assert.equal(c.body.data.assignments, undefined, "driver DTO must be narrow");
    // custody kept
    let row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
    assert.equal(row.current_parcel_collection_driver_id, driverA);
    assert.equal((await prisma.parcel_collection_assignments.findMany({ where: { order_id: orderId, is_current: true } })).length, 1);

    // COLLECTED attempt: started_at is NULL (no "start collection" action in V1),
    // completed_at is set — in both the DB row and the read DTO.
    const collectedAttempt = await prisma.parcel_collection_attempts.findFirstOrThrow({ where: { order_id: orderId } });
    assert.equal(collectedAttempt.started_at, null);
    assert.notEqual(collectedAttempt.completed_at, null);

    const r = await request(app).post(`/api/v1/orders/${orderId}/parcel-collection/receive-at-company`).set(auth(tokens.dispatcher)).send({});
    assert.equal(r.status, 200);
    assert.equal(r.body.data.status, "RECEIVED_AT_COMPANY");
    assert.equal(r.body.data.currentCollectionDriver, null);
    assert.equal(r.body.data.receivedAtCompanyBy.id, dispatcher.id);
    assert.equal(r.body.data.assignments.length, 1);
    assert.equal(r.body.data.attempts.length, 1);
    assert.equal(r.body.data.attempts[0].startedAt, null, "DTO must expose the real NULL, not hide it");
    assert.ok(r.body.data.attempts[0].completedAt);

    row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
    assert.equal(row.parcel_collection_status, "RECEIVED_AT_COMPANY");
    assert.equal(row.current_parcel_collection_driver_id, null);
    assert.equal(row.received_at_company_by_id, dispatcher.id);
    assert.equal(row.status, "RECEIVED", "OrderStatus untouched by parcel collection");
    assert.equal(row.current_driver_id, null, "delivery driver untouched");
    assert.equal((await prisma.parcel_collection_assignments.findFirstOrThrow({ where: { order_id: orderId } })).end_reason, "RECEIVED_AT_COMPANY");

    const auditActions = (
      await prisma.audit_logs.findMany({ where: { entity_type: "ORDER", entity_id: orderId } })
    ).map((x) => x.action);
    // Management actions audit; Driver COLLECTED outcome is operational-only
    // (parcel_collection_attempts), matching the Driver /fail convention.
    assert.ok(auditActions.includes("PARCEL_COLLECTION_DRIVER_ASSIGNED"));
    assert.ok(auditActions.includes("PARCEL_RECEIPT_CONFIRMED"));
    assert.ok(!auditActions.includes("PARCEL_COLLECTED_FROM_SENDER"));
    const auditJson = JSON.stringify(await prisma.audit_logs.findMany({ where: { entity_id: orderId } }));
    assert.doesNotMatch(auditJson, /password|hash|token|secret|cookie|authorization|idempotency|refresh/i);

    for (const [t, w] of [
      [prisma.order_assignments, "order_assignments"],
      [prisma.delivery_attempts, "delivery_attempts"],
      [prisma.wallet_transactions, "wallet_transactions"],
      [prisma.driver_cash_transactions, "driver_cash_transactions"],
      [prisma.company_financial_transactions, "company_financial_transactions"],
    ] as const) {
      assert.equal(await (t as { count: (a: unknown) => Promise<number> }).count({ where: { order_id: orderId } }), 0, w);
    }
  });

  test("COMPANY_ORDER collection lifecycle also works and stays financially neutral", async () => {
    const orderId = await seedCollectionOrder({ orderType: "COMPANY_ORDER" });
    await assign(orderId, driverA);
    await collected(orderId, tokens.driverA);
    const r = await request(app).post(`/api/v1/orders/${orderId}/parcel-collection/receive-at-company`).set(auth(tokens.admin)).send({});
    assert.equal(r.status, 200);
    assert.equal(await prisma.wallet_transactions.count({ where: { order_id: orderId } }), 0);
    assert.equal(await prisma.company_financial_transactions.count({ where: { order_id: orderId } }), 0);
  });

  // ---- Reassign ------------------------------------------------------

  test("reassign A->B ends old row REASSIGNED, opens new current row, audited; same-driver -> 400; blocked after collected", async () => {
    const orderId = await seedCollectionOrder();
    await assign(orderId, driverA);

    const same = await request(app).post(`/api/v1/orders/${orderId}/parcel-collection/reassign`).set(auth(tokens.admin)).send({ driverId: driverA });
    assert.equal(same.status, 400);

    const re = await request(app).post(`/api/v1/orders/${orderId}/parcel-collection/reassign`).set(auth(tokens.dispatcher)).send({ driverId: driverB });
    assert.equal(re.status, 200);
    assert.equal(re.body.data.currentCollectionDriver.id, driverB);
    const rows = await prisma.parcel_collection_assignments.findMany({ where: { order_id: orderId }, orderBy: { assigned_at: "asc" } });
    assert.equal(rows.length, 2);
    assert.deepEqual([rows[0].is_current, rows[0].end_reason, rows[1].is_current, rows[1].end_reason], [false, "REASSIGNED", true, null]);
    assert.equal(await prisma.audit_logs.count({ where: { entity_id: orderId, action: "PARCEL_COLLECTION_DRIVER_REASSIGNED" } }), 1);

    await collected(orderId, tokens.driverB);
    const afterCollect = await request(app).post(`/api/v1/orders/${orderId}/parcel-collection/reassign`).set(auth(tokens.admin)).send({ driverId: driverA });
    assert.equal(afterCollect.status, 409);
  });

  // ---- Failure / reschedule / retry -------------------------------

  test("fail (notes required) -> FAILED, assignment ended FAILED, pointer NULL, order still active, no delivery attempt; reschedule + same-driver retry creates a new assignment; attempt numbers 1,2,3", async () => {
    const orderId = await seedCollectionOrder();
    const other = await prisma.failed_collection_reasons.findFirstOrThrow({ where: { name: "Other" } });
    const senderUnavailable = await prisma.failed_collection_reasons.findFirstOrThrow({ where: { name: "Sender unavailable" } });

    await assign(orderId, driverA);
    const noNotes = await failCollection(orderId, tokens.driverA, other.id);
    assert.equal(noNotes.status, 400);
    let row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
    assert.equal(row.parcel_collection_status, "ASSIGNED");

    const f1 = await failCollection(orderId, tokens.driverA, other.id, "sender no-show");
    assert.equal(f1.status, 200);
    row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
    assert.equal(row.parcel_collection_status, "FAILED");
    assert.equal(row.current_parcel_collection_driver_id, null);
    assert.equal(row.status, "RECEIVED");
    const a1 = await prisma.parcel_collection_assignments.findFirstOrThrow({ where: { order_id: orderId } });
    assert.deepEqual([a1.is_current, a1.end_reason], [false, "FAILED"]);
    assert.equal(await prisma.delivery_attempts.count({ where: { order_id: orderId } }), 0);
    const attempt1 = await prisma.parcel_collection_attempts.findFirstOrThrow({ where: { order_id: orderId, attempt_number: 1 } });
    // FAILED attempt: started_at NULL, completed_at set.
    assert.equal(attempt1.started_at, null);
    assert.notEqual(attempt1.completed_at, null);
    assert.equal(f1.body.data.latestAttempt.completedAt !== null, true);

    // reschedule then SAME driver again -> new assignment row
    assert.equal((await request(app).post(`/api/v1/orders/${orderId}/parcel-collection/reschedule`).set(auth(tokens.dispatcher)).send({})).body.data.status, "RESCHEDULED");
    assert.equal((await assign(orderId, driverA)).status, 200);
    assert.equal(await prisma.parcel_collection_assignments.count({ where: { order_id: orderId } }), 2);

    await failCollection(orderId, tokens.driverA, senderUnavailable.id);
    await request(app).post(`/api/v1/orders/${orderId}/parcel-collection/reschedule`).set(auth(tokens.admin)).send({});
    await assign(orderId, driverB);
    assert.equal((await collected(orderId, tokens.driverB)).status, 200);

    const attempts = await prisma.parcel_collection_attempts.findMany({ where: { order_id: orderId }, orderBy: { attempt_number: "asc" } });
    assert.deepEqual(attempts.map((x) => x.attempt_number), [1, 2, 3]);
    assert.deepEqual(attempts.map((x) => x.outcome), ["FAILED", "FAILED", "COLLECTED"]);
    const attempt1After = await prisma.parcel_collection_attempts.findFirstOrThrow({ where: { order_id: orderId, attempt_number: 1 } });
    assert.equal(attempt1After.completed_at?.getTime(), attempt1.completed_at?.getTime(), "old attempt immutable");
  });

  test("reschedule rejected from non-FAILED; assign rejected from ASSIGNED; inactive/unknown driver rejected", async () => {
    const orderId = await seedCollectionOrder();
    assert.equal((await request(app).post(`/api/v1/orders/${orderId}/parcel-collection/reschedule`).set(auth(tokens.admin)).send({})).status, 409);
    assert.equal((await assign(orderId, inactiveDriver)).status, 400);
    assert.equal((await assign(orderId, "00000000-0000-0000-0000-000000000000")).status, 404);
    await assign(orderId, driverA);
    assert.equal((await assign(orderId, driverB)).status, 409);
  });

  // ---- ALREADY_AT_COMPANY / legacy ---------------------------------

  test("ALREADY_AT_COMPANY / legacy orders: every mutation rejected 409, read returns coherent empty state", async () => {
    const legacyId = await seedTestOrder(customerId, admin.id, { areaId: area.id, areaName: area.name });
    orderIds.push(legacyId);
    for (const path of ["assign", "reassign"]) {
      assert.equal(
        (await request(app).post(`/api/v1/orders/${legacyId}/parcel-collection/${path}`).set(auth(tokens.admin)).send({ driverId: driverA })).status,
        409,
      );
    }
    for (const path of ["reschedule", "receive-at-company"]) {
      assert.equal((await request(app).post(`/api/v1/orders/${legacyId}/parcel-collection/${path}`).set(auth(tokens.admin)).send({})).status, 409);
    }
    const read = await request(app).get(`/api/v1/orders/${legacyId}/parcel-collection`).set(auth(tokens.finance));
    assert.equal(read.status, 200);
    assert.equal(read.body.data.intakeMethod, "ALREADY_AT_COMPANY");
    assert.equal(read.body.data.status, "RECEIVED_AT_COMPANY");
    assert.equal(read.body.data.currentCollectionDriver, null);
    assert.deepEqual(read.body.data.assignments, []);
    assert.deepEqual(read.body.data.attempts, []);
    // (receivedAtCompanyAt is null for a staged-window seeded order — Phase
    // 11.17.4 populates it on create; the 11.17.2 migration backfilled it for
    // pre-existing production orders.)
  });

  test("terminal order (DELIVERED) rejects parcel collection mutation", async () => {
    const orderId = await seedCollectionOrder({ status: "DELIVERED" });
    assert.equal((await assign(orderId, driverA)).status, 409);
  });

  // ---- Authorization + IDOR ---------------------------------------

  test("authorization matrix for all parcel-collection routes", async () => {
    const orderId = await seedCollectionOrder();
    // GET (orders.read): ADMIN/DISPATCHER/FINANCE ok, DRIVER/CUSTOMER 403, unauth 401
    for (const role of ["admin", "dispatcher", "finance"] as const) {
      assert.equal((await request(app).get(`/api/v1/orders/${orderId}/parcel-collection`).set(auth(tokens[role]))).status, 200);
    }
    assert.equal((await request(app).get(`/api/v1/orders/${orderId}/parcel-collection`).set(auth(tokens.driverA))).status, 403);
    assert.equal((await request(app).get(`/api/v1/orders/${orderId}/parcel-collection`).set(auth(tokens.customer))).status, 403);
    assert.equal((await request(app).get(`/api/v1/orders/${orderId}/parcel-collection`)).status, 401);

    // assign/reassign (orders.assign): FINANCE/DRIVER/CUSTOMER 403
    for (const role of ["finance", "driverA", "customer"] as const) {
      assert.equal((await assign(orderId, driverA, tokens[role])).status, 403);
    }
    // reschedule/receive (orders.change_status): DRIVER 403
    assert.equal((await request(app).post(`/api/v1/orders/${orderId}/parcel-collection/reschedule`).set(auth(tokens.driverA)).send({})).status, 403);
    assert.equal((await request(app).post(`/api/v1/orders/${orderId}/parcel-collection/receive-at-company`).set(auth(tokens.driverA)).send({})).status, 403);
  });

  test("driver routes are DRIVER portal-family only: Management roles get 403 BEFORE any driver-profile lookup", async () => {
    const orderId = await seedCollectionOrder();
    await assign(orderId, driverA);
    const reason = await prisma.failed_collection_reasons.findFirstOrThrow({ where: { name: "Sender unavailable" } });
    const routes = [
      () => request(app).post(`/api/v1/driver/orders/${orderId}/parcel-collection/collected`),
      () => request(app).post(`/api/v1/driver/orders/${orderId}/parcel-collection/failed`).send({ failedCollectionReasonId: reason.id }),
      () => request(app).get(`/api/v1/driver/failed-collection-reasons`),
    ];
    for (const make of routes) {
      // ADMIN holds driver.orders.* in the full permission catalog — must STILL be 403.
      for (const role of ["admin", "dispatcher", "finance", "customer"] as const) {
        assert.equal((await make().set(auth(tokens[role])).send({})).status, 403, `role ${role}`);
      }
      assert.equal((await make().send({})).status, 401);
    }
    // and the DRIVER (correct family) is admitted
    assert.equal((await request(app).get(`/api/v1/driver/failed-collection-reasons`).set(auth(tokens.driverA))).status, 200);
  });

  test("driver IDOR: correct DRIVER family but wrong owned resource -> safe 404; no driverId is read from the body", async () => {
    const orderId = await seedCollectionOrder();
    await assign(orderId, driverA);

    // driver B is in the DRIVER family but is NOT the current collection driver -> 404 (not 403)
    assert.equal((await collected(orderId, tokens.driverB)).status, 404);
    const reason = await prisma.failed_collection_reasons.findFirstOrThrow({ where: { name: "Sender unavailable" } });
    assert.equal((await failCollection(orderId, tokens.driverB, reason.id)).status, 404);

    // a spoofed driverId in the body is ignored — driver A still succeeds, as driver A
    const spoof = await request(app)
      .post(`/api/v1/driver/orders/${orderId}/parcel-collection/collected`)
      .set(auth(tokens.driverA))
      .send({ driverId: driverB });
    assert.equal(spoof.status, 200);
    const attempt = await prisma.parcel_collection_attempts.findFirstOrThrow({ where: { order_id: orderId } });
    assert.equal(attempt.driver_id, driverA);
  });

  test("fail-closed on pointer/assignment corruption: no auto-repair, sanitized error", async () => {
    const orderId = await seedCollectionOrder();
    await assign(orderId, driverA);
    await prisma.orders.update({ where: { id: orderId }, data: { current_parcel_collection_driver_id: driverB } });
    const res = await request(app).post(`/api/v1/orders/${orderId}/parcel-collection/reassign`).set(auth(tokens.admin)).send({ driverId: driverC });
    assert.equal(res.status, 500);
    assert.doesNotMatch(JSON.stringify(res.body), /prisma|P20\d\d/i);
    assert.equal((await prisma.orders.findUniqueOrThrow({ where: { id: orderId } })).current_parcel_collection_driver_id, driverB, "not repaired");
    await prisma.orders.update({ where: { id: orderId }, data: { current_parcel_collection_driver_id: driverA } });
  });

  // ---- Concurrency (§90) — each is a cheap 2-request race ----------

  test("concurrency: two initial assigns -> exactly one 200 / one 409; one current row; one audit", async () => {
    const orderId = await seedCollectionOrder();
    const [a, b] = await Promise.all([assign(orderId, driverA), assign(orderId, driverB)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const current = await prisma.parcel_collection_assignments.findMany({ where: { order_id: orderId, is_current: true } });
    assert.equal(current.length, 1);
    assert.equal(await prisma.audit_logs.count({ where: { entity_id: orderId, action: "PARCEL_COLLECTION_DRIVER_ASSIGNED" } }), 1);
    assert.equal((await prisma.orders.findUniqueOrThrow({ where: { id: orderId } })).current_parcel_collection_driver_id, current[0].driver_id);
  });

  test("concurrency: two reassigns from the same current assignment -> one wins; pointer matches the current row", async () => {
    const orderId = await seedCollectionOrder();
    await assign(orderId, driverA);
    const [a, b] = await Promise.all([
      request(app).post(`/api/v1/orders/${orderId}/parcel-collection/reassign`).set(auth(tokens.admin)).send({ driverId: driverB }),
      request(app).post(`/api/v1/orders/${orderId}/parcel-collection/reassign`).set(auth(tokens.admin)).send({ driverId: driverC }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const current = await prisma.parcel_collection_assignments.findMany({ where: { order_id: orderId, is_current: true } });
    assert.equal(current.length, 1);
    assert.equal((await prisma.orders.findUniqueOrThrow({ where: { id: orderId } })).current_parcel_collection_driver_id, current[0].driver_id);
  });

  test("concurrency: duplicate collected / duplicate failed -> exactly one attempt; collected-vs-failed race -> DB matches winner", async () => {
    const reason = await prisma.failed_collection_reasons.findFirstOrThrow({ where: { name: "Sender unavailable" } });

    const dupC = await seedCollectionOrder();
    await assign(dupC, driverA);
    const [c1, c2] = await Promise.all([collected(dupC, tokens.driverA), collected(dupC, tokens.driverA)]);
    assert.deepEqual([c1.status, c2.status].sort(), [200, 409]);
    assert.equal(await prisma.parcel_collection_attempts.count({ where: { order_id: dupC } }), 1);

    const dupF = await seedCollectionOrder();
    await assign(dupF, driverA);
    const [f1, f2] = await Promise.all([failCollection(dupF, tokens.driverA, reason.id), failCollection(dupF, tokens.driverA, reason.id)]);
    assert.equal(f1.status === 200 || f2.status === 200, true);
    assert.equal(await prisma.parcel_collection_attempts.count({ where: { order_id: dupF } }), 1);

    const race = await seedCollectionOrder();
    await assign(race, driverA);
    const [rc, rf] = await Promise.all([collected(race, tokens.driverA), failCollection(race, tokens.driverA, reason.id)]);
    assert.deepEqual([rc.status, rf.status].sort(), [200, 409]);
    const attempts = await prisma.parcel_collection_attempts.findMany({ where: { order_id: race } });
    assert.equal(attempts.length, 1);
    const row = await prisma.orders.findUniqueOrThrow({ where: { id: race } });
    if (attempts[0].outcome === "COLLECTED") {
      assert.equal(row.parcel_collection_status, "COLLECTED_FROM_SENDER");
      assert.equal(row.current_parcel_collection_driver_id, driverA);
    } else {
      assert.equal(row.parcel_collection_status, "FAILED");
      assert.equal(row.current_parcel_collection_driver_id, null);
    }
  });

  test("concurrency: two receipt confirmations -> one wins; single receipt actor/timestamp; one audit; still works if driver later inactive", async () => {
    const orderId = await seedCollectionOrder();
    await assign(orderId, driverB);
    await collected(orderId, tokens.driverB);
    await prisma.drivers.update({ where: { id: driverB }, data: { is_active: false } });
    const [a, b] = await Promise.all([
      request(app).post(`/api/v1/orders/${orderId}/parcel-collection/receive-at-company`).set(auth(tokens.admin)).send({}),
      request(app).post(`/api/v1/orders/${orderId}/parcel-collection/receive-at-company`).set(auth(tokens.dispatcher)).send({}),
    ]);
    await prisma.drivers.update({ where: { id: driverB }, data: { is_active: true } });
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(await prisma.audit_logs.count({ where: { entity_id: orderId, action: "PARCEL_RECEIPT_CONFIRMED" } }), 1);
    const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
    assert.equal(row.parcel_collection_status, "RECEIVED_AT_COMPANY");
    assert.ok([admin.id, dispatcher.id].includes(row.received_at_company_by_id as string));
  });

  // ---- validation ------------------------------------------------

  test("assign/reassign require a uuid driverId; failed requires a uuid reason id", async () => {
    const orderId = await seedCollectionOrder();
    assert.equal((await request(app).post(`/api/v1/orders/${orderId}/parcel-collection/assign`).set(auth(tokens.admin)).send({ driverId: "nope" })).status, 400);
    await assign(orderId, driverA);
    assert.equal(
      (await request(app).post(`/api/v1/driver/orders/${orderId}/parcel-collection/failed`).set(auth(tokens.driverA)).send({ failedCollectionReasonId: "nope" })).status,
      400,
    );
  });

  // ---- global non-regression ------------------------------------

  test("no parcel-collection action created ANY delivery/financial row for the test orders", async () => {
    const scope = { order_id: { in: orderIds } };
    assert.deepEqual(
      await Promise.all([
        prisma.delivery_attempts.count({ where: scope }),
        prisma.order_assignments.count({ where: scope }),
        prisma.wallet_transactions.count({ where: scope }),
        prisma.driver_cash_transactions.count({ where: scope }),
        prisma.company_financial_transactions.count({ where: scope }),
      ]),
      [0, 0, 0, 0, 0],
    );
  });
});
