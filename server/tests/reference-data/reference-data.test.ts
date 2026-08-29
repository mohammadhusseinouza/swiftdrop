import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import {
  cleanupTestArea,
  cleanupTestFailedDeliveryReason,
  cleanupTestPaymentMethod,
  cleanupTestUser,
  createTestArea,
  createTestUser,
  loginTestUser,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

describe("Reference Data backend (Phase 5.3)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driver: TestUser;
  let customer: TestUser;
  let tokens: Record<string, string>;

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    finance = await createTestUser("FINANCE");
    driver = await createTestUser("DRIVER");
    customer = await createTestUser("CUSTOMER");

    const [adminLogin, dispatcherLogin, financeLogin, driverLogin, customerLogin] = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, dispatcher.email, dispatcher.password),
      loginTestUser(app, finance.email, finance.password),
      loginTestUser(app, driver.email, driver.password),
      loginTestUser(app, customer.email, customer.password),
    ]);

    tokens = {
      admin: adminLogin.accessToken as string,
      dispatcher: dispatcherLogin.accessToken as string,
      finance: financeLogin.accessToken as string,
      driver: driverLogin.accessToken as string,
      customer: customerLogin.accessToken as string,
    };
    for (const [role, token] of Object.entries(tokens)) {
      assert.ok(token, `expected an access token for ${role}`);
    }
  });

  after(async () => {
    await Promise.all([admin, dispatcher, finance, driver, customer].map((u) => cleanupTestUser(u.id)));
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  // ===== AUTHORIZATION (shared shape across all three resources) =====

  describe("Authorization", () => {
    test("no auth -> 401 on areas list", async () => {
      const res = await request(app).get("/api/v1/settings/areas");
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, "UNAUTHORIZED");
    });

    test("ADMIN settings.read -> areas/payment-methods/failed-delivery-reasons list allowed", async () => {
      const areas = await request(app).get("/api/v1/settings/areas").set(auth(tokens.admin));
      const pm = await request(app).get("/api/v1/settings/payment-methods").set(auth(tokens.admin));
      const fdr = await request(app).get("/api/v1/settings/failed-delivery-reasons").set(auth(tokens.admin));
      assert.equal(areas.status, 200);
      assert.equal(pm.status, 200);
      assert.equal(fdr.status, 200);
    });

    test("DISPATCHER settings.read -> list allowed", async () => {
      const res = await request(app).get("/api/v1/settings/payment-methods").set(auth(tokens.dispatcher));
      assert.equal(res.status, 200);
    });

    test("FINANCE settings.read -> list allowed", async () => {
      const res = await request(app).get("/api/v1/settings/payment-methods").set(auth(tokens.finance));
      assert.equal(res.status, 200);
    });

    test("DRIVER -> forbidden", async () => {
      const res = await request(app).get("/api/v1/settings/payment-methods").set(auth(tokens.driver));
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "FORBIDDEN");
    });

    test("CUSTOMER -> forbidden", async () => {
      const res = await request(app).get("/api/v1/settings/payment-methods").set(auth(tokens.customer));
      assert.equal(res.status, 403);
    });

    test("ADMIN settings.manage -> mutation allowed", async () => {
      const res = await request(app)
        .post("/api/v1/settings/areas")
        .set(auth(tokens.admin))
        .send({ name: `Phase53 Auth Area ${uniqueSuffix()}` });
      assert.equal(res.status, 201);
      await cleanupTestArea(res.body.data.id);
    });

    test("DISPATCHER mutation -> 403", async () => {
      const res = await request(app)
        .post("/api/v1/settings/areas")
        .set(auth(tokens.dispatcher))
        .send({ name: `Phase53 Dispatcher Area ${uniqueSuffix()}` });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "FORBIDDEN");
    });

    test("FINANCE mutation -> 403", async () => {
      const res = await request(app)
        .post("/api/v1/settings/areas")
        .set(auth(tokens.finance))
        .send({ name: `Phase53 Finance Area ${uniqueSuffix()}` });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "FORBIDDEN");
    });
  });

  // ===== AREAS =====

  describe("Areas", () => {
    const createdAreaIds: string[] = [];

    after(async () => {
      for (const id of createdAreaIds) {
        await cleanupTestArea(id);
      }
    });

    test("list succeeds", async () => {
      const res = await request(app).get("/api/v1/settings/areas").set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.data));
      assert.ok(res.body.meta, "expected pagination meta for areas");
    });

    test("create succeeds", async () => {
      const name = `Phase53 Area ${uniqueSuffix()}`;
      const res = await request(app).post("/api/v1/settings/areas").set(auth(tokens.admin)).send({ name });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.name, name);
      assert.equal(res.body.data.isActive, true);
      createdAreaIds.push(res.body.data.id);
    });

    test("search works", async () => {
      const marker = `findme-area-${uniqueSuffix()}`;
      const created = await request(app)
        .post("/api/v1/settings/areas")
        .set(auth(tokens.admin))
        .send({ name: `Phase53 ${marker}` });
      createdAreaIds.push(created.body.data.id);

      const res = await request(app)
        .get(`/api/v1/settings/areas?search=${encodeURIComponent(marker)}`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 1);
      assert.match(res.body.data[0].name, new RegExp(marker));
    });

    test("isActive filter works", async () => {
      const area = await createTestArea();
      createdAreaIds.push(area.id);
      await request(app).patch(`/api/v1/settings/areas/${area.id}`).set(auth(tokens.admin)).send({ isActive: false });

      const res = await request(app)
        .get(`/api/v1/settings/areas?search=${encodeURIComponent(area.name)}&isActive=false`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.every((a: { isActive: boolean }) => a.isActive === false));
    });

    test("duplicate name -> 409", async () => {
      const name = `Phase53 Dup Area ${uniqueSuffix()}`;
      const first = await request(app).post("/api/v1/settings/areas").set(auth(tokens.admin)).send({ name });
      createdAreaIds.push(first.body.data.id);
      assert.equal(first.status, 201);

      const second = await request(app).post("/api/v1/settings/areas").set(auth(tokens.admin)).send({ name });
      assert.equal(second.status, 409);
      assert.equal(second.body.error.code, "CONFLICT");
      assert.doesNotMatch(JSON.stringify(second.body), /prisma/i);
    });

    test("detail succeeds", async () => {
      const created = await request(app)
        .post("/api/v1/settings/areas")
        .set(auth(tokens.admin))
        .send({ name: `Phase53 Detail Area ${uniqueSuffix()}` });
      createdAreaIds.push(created.body.data.id);

      const res = await request(app).get(`/api/v1/settings/areas/${created.body.data.id}`).set(auth(tokens.finance));
      assert.equal(res.status, 200);
      assert.equal(res.body.data.id, created.body.data.id);
    });

    test("malformed UUID -> 400", async () => {
      const res = await request(app).get("/api/v1/settings/areas/not-a-uuid").set(auth(tokens.admin));
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("missing area -> 404", async () => {
      const res = await request(app)
        .get("/api/v1/settings/areas/00000000-0000-0000-0000-000000000000")
        .set(auth(tokens.admin));
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, "NOT_FOUND");
    });

    test("update succeeds", async () => {
      const created = await request(app)
        .post("/api/v1/settings/areas")
        .set(auth(tokens.admin))
        .send({ name: `Phase53 Update Area ${uniqueSuffix()}` });
      createdAreaIds.push(created.body.data.id);

      const res = await request(app)
        .patch(`/api/v1/settings/areas/${created.body.data.id}`)
        .set(auth(tokens.admin))
        .send({ name: "Renamed Area", sortOrder: 7 });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.name, "Renamed Area");
      assert.equal(res.body.data.sortOrder, 7);
    });

    test("empty PATCH -> 400", async () => {
      const created = await request(app)
        .post("/api/v1/settings/areas")
        .set(auth(tokens.admin))
        .send({ name: `Phase53 Empty Patch Area ${uniqueSuffix()}` });
      createdAreaIds.push(created.body.data.id);

      const res = await request(app).patch(`/api/v1/settings/areas/${created.body.data.id}`).set(auth(tokens.admin)).send({});
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("immutable fields (id, createdAt) cannot change via PATCH", async () => {
      const created = await request(app)
        .post("/api/v1/settings/areas")
        .set(auth(tokens.admin))
        .send({ name: `Phase53 Immutable Area ${uniqueSuffix()}` });
      const areaId = created.body.data.id;
      createdAreaIds.push(areaId);

      const res = await request(app)
        .patch(`/api/v1/settings/areas/${areaId}`)
        .set(auth(tokens.admin))
        .send({ id: "00000000-0000-0000-0000-000000000000", createdAt: "2000-01-01T00:00:00.000Z", sortOrder: 3 });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.id, areaId);
      assert.equal(res.body.data.sortOrder, 3);
    });

    test("deactivate/reactivate works", async () => {
      const created = await request(app)
        .post("/api/v1/settings/areas")
        .set(auth(tokens.admin))
        .send({ name: `Phase53 Toggle Area ${uniqueSuffix()}` });
      const areaId = created.body.data.id;
      createdAreaIds.push(areaId);

      const deactivated = await request(app)
        .patch(`/api/v1/settings/areas/${areaId}`)
        .set(auth(tokens.admin))
        .send({ isActive: false });
      assert.equal(deactivated.status, 200);
      assert.equal(deactivated.body.data.isActive, false);

      const reactivated = await request(app)
        .patch(`/api/v1/settings/areas/${areaId}`)
        .set(auth(tokens.admin))
        .send({ isActive: true });
      assert.equal(reactivated.status, 200);
      assert.equal(reactivated.body.data.isActive, true);
    });

    test("no hard-delete route exists", async () => {
      const created = await request(app)
        .post("/api/v1/settings/areas")
        .set(auth(tokens.admin))
        .send({ name: `Phase53 NoDelete Area ${uniqueSuffix()}` });
      createdAreaIds.push(created.body.data.id);

      const res = await request(app).delete(`/api/v1/settings/areas/${created.body.data.id}`).set(auth(tokens.admin));
      assert.equal(res.status, 404);
    });
  });

  // ===== PAYMENT METHODS =====

  describe("Payment Methods", () => {
    const createdPaymentMethodIds: string[] = [];
    const CANONICAL_CODES = ["CASH", "CARD", "BANK_TRANSFER", "WHISH", "OTHER"];

    after(async () => {
      for (const id of createdPaymentMethodIds) {
        await cleanupTestPaymentMethod(id);
      }
    });

    test("list succeeds and seeded canonical payment methods remain intact", async () => {
      const res = await request(app).get("/api/v1/settings/payment-methods").set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.data));
      assert.equal(res.body.meta, undefined, "payment methods is a full small-catalog list, no pagination meta");

      const codes = res.body.data.map((pm: { code: string }) => pm.code);
      for (const code of CANONICAL_CODES) {
        assert.ok(codes.includes(code), `expected seeded payment method code ${code} to still exist`);
      }
    });

    test("create succeeds", async () => {
      const suffix = uniqueSuffix();
      const res = await request(app)
        .post("/api/v1/settings/payment-methods")
        .set(auth(tokens.admin))
        .send({ code: `PH53_${suffix}`, name: `Phase53 Method ${suffix}` });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.isActive, true);
      createdPaymentMethodIds.push(res.body.data.id);
    });

    test("duplicate code -> 409", async () => {
      const suffix = uniqueSuffix();
      const payload = { code: `PH53_DUP_${suffix}`, name: `Phase53 Dup ${suffix}` };
      const first = await request(app).post("/api/v1/settings/payment-methods").set(auth(tokens.admin)).send(payload);
      createdPaymentMethodIds.push(first.body.data.id);
      assert.equal(first.status, 201);

      const second = await request(app)
        .post("/api/v1/settings/payment-methods")
        .set(auth(tokens.admin))
        .send({ ...payload, name: "Different Name" });
      assert.equal(second.status, 409);
      assert.equal(second.body.error.code, "CONFLICT");
    });

    test("detail succeeds", async () => {
      const suffix = uniqueSuffix();
      const created = await request(app)
        .post("/api/v1/settings/payment-methods")
        .set(auth(tokens.admin))
        .send({ code: `PH53_D_${suffix}`, name: `Phase53 Detail ${suffix}` });
      createdPaymentMethodIds.push(created.body.data.id);

      const res = await request(app)
        .get(`/api/v1/settings/payment-methods/${created.body.data.id}`)
        .set(auth(tokens.finance));
      assert.equal(res.status, 200);
      assert.equal(res.body.data.id, created.body.data.id);
    });

    test("update allowed fields succeeds", async () => {
      const suffix = uniqueSuffix();
      const created = await request(app)
        .post("/api/v1/settings/payment-methods")
        .set(auth(tokens.admin))
        .send({ code: `PH53_U_${suffix}`, name: `Phase53 Update ${suffix}` });
      createdPaymentMethodIds.push(created.body.data.id);

      const res = await request(app)
        .patch(`/api/v1/settings/payment-methods/${created.body.data.id}`)
        .set(auth(tokens.admin))
        .send({ name: "Renamed Method", sortOrder: 9 });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.name, "Renamed Method");
      assert.equal(res.body.data.sortOrder, 9);
    });

    test("code is immutable via PATCH", async () => {
      const suffix = uniqueSuffix();
      const originalCode = `PH53_IMM_${suffix}`;
      const created = await request(app)
        .post("/api/v1/settings/payment-methods")
        .set(auth(tokens.admin))
        .send({ code: originalCode, name: `Phase53 Immutable ${suffix}` });
      createdPaymentMethodIds.push(created.body.data.id);

      const res = await request(app)
        .patch(`/api/v1/settings/payment-methods/${created.body.data.id}`)
        .set(auth(tokens.admin))
        .send({ code: "SHOULD-NOT-APPLY", name: "Still Renamed" });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.code, originalCode, "code must remain immutable");
      assert.equal(res.body.data.name, "Still Renamed");
    });

    test("activate/deactivate works", async () => {
      const suffix = uniqueSuffix();
      const created = await request(app)
        .post("/api/v1/settings/payment-methods")
        .set(auth(tokens.admin))
        .send({ code: `PH53_TOGGLE_${suffix}`, name: `Phase53 Toggle ${suffix}` });
      const id = created.body.data.id;
      createdPaymentMethodIds.push(id);

      const deactivated = await request(app)
        .patch(`/api/v1/settings/payment-methods/${id}`)
        .set(auth(tokens.admin))
        .send({ isActive: false });
      assert.equal(deactivated.status, 200);
      assert.equal(deactivated.body.data.isActive, false);

      const listActiveOnly = await request(app)
        .get("/api/v1/settings/payment-methods?isActive=true")
        .set(auth(tokens.admin));
      assert.ok(!listActiveOnly.body.data.some((pm: { id: string }) => pm.id === id));
    });

    test("no hard-delete route exists", async () => {
      const suffix = uniqueSuffix();
      const created = await request(app)
        .post("/api/v1/settings/payment-methods")
        .set(auth(tokens.admin))
        .send({ code: `PH53_NODEL_${suffix}`, name: `Phase53 NoDelete ${suffix}` });
      createdPaymentMethodIds.push(created.body.data.id);

      const res = await request(app)
        .delete(`/api/v1/settings/payment-methods/${created.body.data.id}`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 404);
    });
  });

  // ===== FAILED DELIVERY REASONS =====

  describe("Failed Delivery Reasons", () => {
    const createdReasonIds: string[] = [];
    const CANONICAL_NAMES = [
      "Receiver did not answer",
      "Receiver unavailable",
      "Receiver refused",
      "Incorrect address",
      "Incomplete address",
      "Customer requested rescheduling",
      "Unable to contact receiver",
      "Other",
    ];

    after(async () => {
      for (const id of createdReasonIds) {
        await cleanupTestFailedDeliveryReason(id);
      }
    });

    test("list succeeds and seeded approved reasons remain intact, including Other.requiresNotes", async () => {
      const res = await request(app).get("/api/v1/settings/failed-delivery-reasons").set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.data));

      const byName: Record<string, { requiresNotes: boolean }> = Object.fromEntries(
        res.body.data.map((r: { name: string; requiresNotes: boolean }) => [r.name, r])
      );
      for (const name of CANONICAL_NAMES) {
        assert.ok(byName[name], `expected seeded reason "${name}" to still exist`);
      }
      assert.equal(byName["Other"].requiresNotes, true, "Other must still require notes");
      assert.equal(byName["Receiver did not answer"].requiresNotes, false);
    });

    test("create succeeds", async () => {
      const suffix = uniqueSuffix();
      const res = await request(app)
        .post("/api/v1/settings/failed-delivery-reasons")
        .set(auth(tokens.admin))
        .send({ name: `Phase53 Reason ${suffix}`, requiresNotes: true });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.requiresNotes, true);
      assert.equal(res.body.data.isActive, true);
      createdReasonIds.push(res.body.data.id);
    });

    test("duplicate name -> 409", async () => {
      const suffix = uniqueSuffix();
      const name = `Phase53 Dup Reason ${suffix}`;
      const first = await request(app)
        .post("/api/v1/settings/failed-delivery-reasons")
        .set(auth(tokens.admin))
        .send({ name });
      createdReasonIds.push(first.body.data.id);
      assert.equal(first.status, 201);

      const second = await request(app)
        .post("/api/v1/settings/failed-delivery-reasons")
        .set(auth(tokens.admin))
        .send({ name });
      assert.equal(second.status, 409);
      assert.equal(second.body.error.code, "CONFLICT");
    });

    test("detail succeeds", async () => {
      const suffix = uniqueSuffix();
      const created = await request(app)
        .post("/api/v1/settings/failed-delivery-reasons")
        .set(auth(tokens.admin))
        .send({ name: `Phase53 Detail Reason ${suffix}` });
      createdReasonIds.push(created.body.data.id);

      const res = await request(app)
        .get(`/api/v1/settings/failed-delivery-reasons/${created.body.data.id}`)
        .set(auth(tokens.finance));
      assert.equal(res.status, 200);
      assert.equal(res.body.data.id, created.body.data.id);
    });

    test("update succeeds", async () => {
      const suffix = uniqueSuffix();
      const created = await request(app)
        .post("/api/v1/settings/failed-delivery-reasons")
        .set(auth(tokens.admin))
        .send({ name: `Phase53 Update Reason ${suffix}`, requiresNotes: false });
      createdReasonIds.push(created.body.data.id);

      const res = await request(app)
        .patch(`/api/v1/settings/failed-delivery-reasons/${created.body.data.id}`)
        .set(auth(tokens.admin))
        .send({ requiresNotes: true, sortOrder: 5 });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.requiresNotes, true);
      assert.equal(res.body.data.sortOrder, 5);
    });

    test("activation/deactivation works", async () => {
      const suffix = uniqueSuffix();
      const created = await request(app)
        .post("/api/v1/settings/failed-delivery-reasons")
        .set(auth(tokens.admin))
        .send({ name: `Phase53 Toggle Reason ${suffix}` });
      const id = created.body.data.id;
      createdReasonIds.push(id);

      const deactivated = await request(app)
        .patch(`/api/v1/settings/failed-delivery-reasons/${id}`)
        .set(auth(tokens.admin))
        .send({ isActive: false });
      assert.equal(deactivated.status, 200);
      assert.equal(deactivated.body.data.isActive, false);
    });

    test("no hard-delete route exists", async () => {
      const suffix = uniqueSuffix();
      const created = await request(app)
        .post("/api/v1/settings/failed-delivery-reasons")
        .set(auth(tokens.admin))
        .send({ name: `Phase53 NoDelete Reason ${suffix}` });
      createdReasonIds.push(created.body.data.id);

      const res = await request(app)
        .delete(`/api/v1/settings/failed-delivery-reasons/${created.body.data.id}`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 404);
    });
  });
});

describe("Seeded reference data restoration check (Phase 5.3)", () => {
  test("canonical payment_methods and failed_delivery_reasons row counts are unchanged by this suite", async () => {
    // Match the exact canonical codes/names rather than excluding a
    // "PH53_"-prefixed pattern — other test files (e.g. Phase 6.2's Order
    // tests) legitimately create their own temporary payment methods with
    // different prefixes, and Node's test runner executes files
    // concurrently, so an exclusion-by-prefix check can race against any
    // other suite's still-live (properly self-cleaned-up) fixtures.
    const paymentMethodCount = await prisma.payment_methods.count({
      where: { code: { in: ["CASH", "CARD", "BANK_TRANSFER", "WHISH", "OTHER"] } },
    });
    const reasonCount = await prisma.failed_delivery_reasons.count({
      where: {
        name: {
          in: [
            "Receiver did not answer",
            "Receiver unavailable",
            "Receiver refused",
            "Incorrect address",
            "Incomplete address",
            "Customer requested rescheduling",
            "Unable to contact receiver",
            "Other",
          ],
        },
      },
    });
    assert.equal(paymentMethodCount, 5, "the 5 canonical seeded payment methods must remain untouched");
    assert.equal(reasonCount, 8, "the 8 canonical seeded failed delivery reasons must remain untouched");
  });
});
