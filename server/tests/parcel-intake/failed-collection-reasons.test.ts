import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { createTestUser, cleanupTestUser, loginTestUser, uniqueSuffix, type TestUser } from "../helpers/fixtures";

// ============================================================
// Phase 11.17.3 — Failed Collection Reasons: Management Settings API +
// narrow Driver-safe active list. Mirrors the failed-delivery-reasons
// contract; separate catalog, separate audit entity type.
// ============================================================

const CANONICAL = [
  ["Sender unavailable", false, 10],
  ["Parcel not ready", false, 20],
  ["Unable to contact sender", false, 30],
  ["Incorrect collection address", false, 40],
  ["Sender requested reschedule", false, 50],
  ["Collection cancelled by sender", true, 60],
  ["Other", true, 70],
] as const;

describe("Failed Collection Reasons (Phase 11.17.3)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driver: TestUser;
  let customer: TestUser;
  let tokens: Record<string, string>;
  const createdIds: string[] = [];

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    finance = await createTestUser("FINANCE");
    driver = await createTestUser("DRIVER");
    customer = await createTestUser("CUSTOMER");
    const l = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, dispatcher.email, dispatcher.password),
      loginTestUser(app, finance.email, finance.password),
      loginTestUser(app, driver.email, driver.password),
      loginTestUser(app, customer.email, customer.password),
    ]);
    tokens = {
      admin: l[0].accessToken as string,
      dispatcher: l[1].accessToken as string,
      finance: l[2].accessToken as string,
      driver: l[3].accessToken as string,
      customer: l[4].accessToken as string,
    };
  });

  after(async () => {
    for (const id of createdIds) await prisma.failed_collection_reasons.deleteMany({ where: { id } });
    await prisma.audit_logs.deleteMany({ where: { entity_type: "FAILED_COLLECTION_REASON" } });
    for (const u of [admin, dispatcher, finance, driver, customer]) await cleanupTestUser(u.id);
  });

  test("the 7 canonical rows exist with the contract flags (incl. requiresNotes for 'Collection cancelled by sender' and 'Other')", async () => {
    const res = await request(app).get("/api/v1/settings/failed-collection-reasons").set(auth(tokens.admin));
    assert.equal(res.status, 200);
    const byName = new Map<string, { requiresNotes: boolean; sortOrder: number; isActive: boolean }>(
      res.body.data.map((r: { name: string; requiresNotes: boolean; sortOrder: number; isActive: boolean }) => [r.name, r]),
    );
    for (const [name, requiresNotes, sortOrder] of CANONICAL) {
      const row = byName.get(name);
      assert.ok(row, `missing canonical reason: ${name}`);
      assert.equal(row!.requiresNotes, requiresNotes, `${name}.requiresNotes`);
      assert.equal(row!.sortOrder, sortOrder, `${name}.sortOrder`);
      assert.equal(row!.isActive, true);
    }
  });

  test("catalog is strictly separate from failed_delivery_reasons", async () => {
    const collision = await prisma.failed_delivery_reasons.findFirst({ where: { name: "Sender unavailable" } });
    assert.equal(collision, null);
  });

  test("authorization: ADMIN/DISPATCHER/FINANCE read; DRIVER/CUSTOMER 403; unauth 401", async () => {
    for (const role of ["admin", "dispatcher", "finance"] as const) {
      assert.equal((await request(app).get("/api/v1/settings/failed-collection-reasons").set(auth(tokens[role]))).status, 200);
    }
    assert.equal((await request(app).get("/api/v1/settings/failed-collection-reasons").set(auth(tokens.driver))).status, 403);
    assert.equal((await request(app).get("/api/v1/settings/failed-collection-reasons").set(auth(tokens.customer))).status, 403);
    assert.equal((await request(app).get("/api/v1/settings/failed-collection-reasons")).status, 401);
  });

  test("only settings.manage may create/update; no DELETE route", async () => {
    const body = { name: `PC reason ${uniqueSuffix()}`, requiresNotes: true, sortOrder: 500 };
    assert.equal((await request(app).post("/api/v1/settings/failed-collection-reasons").set(auth(tokens.dispatcher)).send(body)).status, 403);
    assert.equal((await request(app).post("/api/v1/settings/failed-collection-reasons").set(auth(tokens.finance)).send(body)).status, 403);

    const created = await request(app).post("/api/v1/settings/failed-collection-reasons").set(auth(tokens.admin)).send(body);
    assert.equal(created.status, 201);
    createdIds.push(created.body.data.id);
    assert.equal(created.body.data.requiresNotes, true);

    const del = await request(app).delete(`/api/v1/settings/failed-collection-reasons/${created.body.data.id}`).set(auth(tokens.admin));
    assert.equal(del.status, 404); // no DELETE handler

    // audit written transactionally
    const audit = await prisma.audit_logs.findMany({
      where: { entity_type: "FAILED_COLLECTION_REASON", entity_id: created.body.data.id, action: "FAILED_COLLECTION_REASON_CREATED" },
    });
    assert.equal(audit.length, 1);
  });

  test("deactivate / reactivate produce the right audit actions; duplicate name -> 409", async () => {
    const c = await request(app)
      .post("/api/v1/settings/failed-collection-reasons")
      .set(auth(tokens.admin))
      .send({ name: `PC dup ${uniqueSuffix()}` });
    createdIds.push(c.body.data.id);

    const dup = await request(app).post("/api/v1/settings/failed-collection-reasons").set(auth(tokens.admin)).send({ name: c.body.data.name });
    assert.equal(dup.status, 409);

    const deact = await request(app).patch(`/api/v1/settings/failed-collection-reasons/${c.body.data.id}`).set(auth(tokens.admin)).send({ isActive: false });
    assert.equal(deact.status, 200);
    assert.equal(deact.body.data.isActive, false);

    const react = await request(app).patch(`/api/v1/settings/failed-collection-reasons/${c.body.data.id}`).set(auth(tokens.admin)).send({ isActive: true });
    assert.equal(react.status, 200);

    const actions = (
      await prisma.audit_logs.findMany({ where: { entity_type: "FAILED_COLLECTION_REASON", entity_id: c.body.data.id } })
    ).map((a) => a.action);
    assert.ok(actions.includes("FAILED_COLLECTION_REASON_DEACTIVATED"));
    assert.ok(actions.includes("FAILED_COLLECTION_REASON_REACTIVATED"));
  });

  test("no audit row is written on a read", async () => {
    const before = await prisma.audit_logs.count({ where: { entity_type: "FAILED_COLLECTION_REASON" } });
    await request(app).get("/api/v1/settings/failed-collection-reasons").set(auth(tokens.admin));
    await request(app).get("/api/v1/settings/failed-collection-reasons").set(auth(tokens.finance));
    const after = await prisma.audit_logs.count({ where: { entity_type: "FAILED_COLLECTION_REASON" } });
    assert.equal(before, after);
  });

  // ---- Driver-safe endpoint ----

  test("GET /api/v1/driver/failed-collection-reasons: DRIVER 200 active-only minimal list; every non-DRIVER role 403; unauth 401", async () => {
    const inactive = await prisma.failed_collection_reasons.create({
      data: { name: `PC hidden ${uniqueSuffix()}`, is_active: false, sort_order: 998 },
    });
    createdIds.push(inactive.id);

    const res = await request(app).get("/api/v1/driver/failed-collection-reasons").set(auth(tokens.driver));
    assert.equal(res.status, 200);
    const names: string[] = res.body.data.map((r: { name: string }) => r.name);
    assert.ok(names.includes("Sender unavailable"));
    assert.ok(!names.includes(inactive.name));
    // narrow shape: only id/name/requiresNotes/sortOrder
    for (const r of res.body.data) {
      assert.deepEqual(Object.keys(r).sort(), ["id", "name", "requiresNotes", "sortOrder"]);
    }
    // PORTAL FAMILY: ADMIN holds driver.orders.read_own in the full catalog but is
    // NOT in the DRIVER portal family -> 403 (not 200). Same for DISPATCHER/FINANCE/CUSTOMER.
    for (const role of ["admin", "dispatcher", "finance", "customer"] as const) {
      assert.equal(
        (await request(app).get("/api/v1/driver/failed-collection-reasons").set(auth(tokens[role]))).status,
        403,
        `role ${role}`,
      );
    }
    assert.equal((await request(app).get("/api/v1/driver/failed-collection-reasons")).status, 401);
  });

  test("DRIVER still gets 403 from the general Settings endpoints", async () => {
    for (const path of [
      "/api/v1/settings/failed-collection-reasons",
      "/api/v1/settings/failed-delivery-reasons",
      "/api/v1/settings/areas",
      "/api/v1/settings/payment-methods",
      "/api/v1/settings/roles",
    ]) {
      assert.equal((await request(app).get(path).set(auth(tokens.driver))).status, 403, path);
    }
    assert.equal((await request(app).get("/api/v1/system-settings").set(auth(tokens.driver))).status, 403);
  });
});
