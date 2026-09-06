import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { createTestUser, cleanupTestUser, loginTestUser, uniqueSuffix, type TestUser } from "../helpers/fixtures";

// ============================================================
// Phase 12.4 — GET /api/v1/driver/failed-delivery-reasons.
//
// Resolves the documented Phase 12.1/12.2/12.3 blocker: a narrow Driver-safe
// active Failed Delivery Reasons list, authorized by driver.orders.read_own
// (never settings.read). Reuses the EXISTING failed_delivery_reasons table
// — no new catalog, no schema change. Mirrors the driver-safe portion of
// tests/parcel-intake/failed-collection-reasons.test.ts exactly.
// ============================================================

describe("Driver-safe Failed Delivery Reasons (Phase 12.4)", () => {
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
    for (const id of createdIds) await prisma.failed_delivery_reasons.deleteMany({ where: { id } });
    await prisma.audit_logs.deleteMany({ where: { entity_type: "FAILED_DELIVERY_REASON", entity_id: { in: createdIds } } });
    for (const u of [admin, dispatcher, finance, driver, customer]) await cleanupTestUser(u.id);
  });

  test("DRIVER 200 active-only minimal list; every non-DRIVER role 403; unauth 401", async () => {
    const inactive = await prisma.failed_delivery_reasons.create({
      data: { name: `PH124 hidden ${uniqueSuffix()}`, is_active: false, sort_order: 997 },
    });
    createdIds.push(inactive.id);
    const active = await prisma.failed_delivery_reasons.create({
      data: { name: `PH124 visible ${uniqueSuffix()}`, is_active: true, sort_order: 996 },
    });
    createdIds.push(active.id);

    const res = await request(app).get("/api/v1/driver/failed-delivery-reasons").set(auth(tokens.driver));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const names: string[] = res.body.data.map((r: { name: string }) => r.name);
    assert.ok(names.includes(active.name), "an active reason must be present");
    assert.ok(!names.includes(inactive.name), "an inactive reason must never appear");

    // narrow shape: only id/name/requiresNotes/sortOrder — no isActive/timestamps/Management metadata
    for (const r of res.body.data) {
      assert.deepEqual(Object.keys(r).sort(), ["id", "name", "requiresNotes", "sortOrder"]);
    }

    // PORTAL FAMILY: ADMIN holds driver.orders.read_own in the full permission
    // catalog but is NOT in the DRIVER portal family -> 403, not 200. Same for
    // DISPATCHER/FINANCE/CUSTOMER.
    for (const role of ["admin", "dispatcher", "finance", "customer"] as const) {
      assert.equal(
        (await request(app).get("/api/v1/driver/failed-delivery-reasons").set(auth(tokens[role]))).status,
        403,
        `role ${role}`,
      );
    }
    assert.equal((await request(app).get("/api/v1/driver/failed-delivery-reasons")).status, 401);
  });

  test("deterministic sort: sort_order asc, then name asc — stable across repeated calls", async () => {
    const a = await prisma.failed_delivery_reasons.create({
      data: { name: `PH124 sort A ${uniqueSuffix()}`, is_active: true, sort_order: 995 },
    });
    const b = await prisma.failed_delivery_reasons.create({
      data: { name: `PH124 sort B ${uniqueSuffix()}`, is_active: true, sort_order: 995 },
    });
    createdIds.push(a.id, b.id);

    const call1 = await request(app).get("/api/v1/driver/failed-delivery-reasons").set(auth(tokens.driver));
    const call2 = await request(app).get("/api/v1/driver/failed-delivery-reasons").set(auth(tokens.driver));
    assert.deepEqual(
      call1.body.data.map((r: { id: string }) => r.id),
      call2.body.data.map((r: { id: string }) => r.id),
      "repeated calls must return an identical order",
    );

    const idxA = call1.body.data.findIndex((r: { id: string }) => r.id === a.id);
    const idxB = call1.body.data.findIndex((r: { id: string }) => r.id === b.id);
    assert.ok(idxA !== -1 && idxB !== -1);
    // Same sort_order -> tie-break by name ascending.
    const expectedFirst = a.name < b.name ? idxA : idxB;
    const expectedSecond = a.name < b.name ? idxB : idxA;
    assert.ok(expectedFirst < expectedSecond);
  });

  test("no audit row is written on a read", async () => {
    const before = await prisma.audit_logs.count({ where: { entity_type: "FAILED_DELIVERY_REASON" } });
    await request(app).get("/api/v1/driver/failed-delivery-reasons").set(auth(tokens.driver));
    await request(app).get("/api/v1/driver/failed-delivery-reasons").set(auth(tokens.driver));
    const after = await prisma.audit_logs.count({ where: { entity_type: "FAILED_DELIVERY_REASON" } });
    assert.equal(before, after);
  });

  test("DRIVER still gets 403 from the general Settings failed-delivery-reasons endpoint", async () => {
    assert.equal(
      (await request(app).get("/api/v1/settings/failed-delivery-reasons").set(auth(tokens.driver))).status,
      403,
    );
  });

  test("reuses the existing failed_delivery_reasons catalog — no parallel table", async () => {
    const active = await prisma.failed_delivery_reasons.create({
      data: { name: `PH124 catalog-check ${uniqueSuffix()}`, is_active: true, sort_order: 994 },
    });
    createdIds.push(active.id);

    const res = await request(app).get("/api/v1/driver/failed-delivery-reasons").set(auth(tokens.driver));
    const found = res.body.data.find((r: { id: string }) => r.id === active.id);
    assert.ok(found, "the driver-safe endpoint must read from the same failed_delivery_reasons table Management edits");
  });
});
