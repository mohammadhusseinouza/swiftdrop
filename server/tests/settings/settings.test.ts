import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import {
  cleanupTestSetting,
  cleanupTestUser,
  createTestUser,
  loginTestUser,
  seedTestSetting,
  type TestUser,
} from "../helpers/fixtures";

describe("System Settings backend (Phase 5.3)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driver: TestUser;
  let customer: TestUser;
  let tokens: Record<string, string>;
  const createdSettingKeys: string[] = [];

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
    for (const key of createdSettingKeys) {
      await cleanupTestSetting(key);
    }
    await Promise.all([admin, dispatcher, finance, driver, customer].map((u) => cleanupTestUser(u.id)));
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function seedAndTrack(overrides: Parameters<typeof seedTestSetting>[0] = {}) {
    const setting = await seedTestSetting(overrides);
    createdSettingKeys.push(setting.key);
    return setting;
  }

  // ===== AUTHORIZATION =====

  describe("Authorization", () => {
    test("unauthenticated access -> 401", async () => {
      const res = await request(app).get("/api/v1/system-settings");
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, "UNAUTHORIZED");
    });

    test("ADMIN settings.read -> allowed", async () => {
      const res = await request(app).get("/api/v1/system-settings").set(auth(tokens.admin));
      assert.equal(res.status, 200);
    });

    test("DISPATCHER settings.read -> allowed", async () => {
      const res = await request(app).get("/api/v1/system-settings").set(auth(tokens.dispatcher));
      assert.equal(res.status, 200);
    });

    test("FINANCE settings.read -> allowed", async () => {
      const res = await request(app).get("/api/v1/system-settings").set(auth(tokens.finance));
      assert.equal(res.status, 200);
    });

    test("DRIVER -> forbidden", async () => {
      const res = await request(app).get("/api/v1/system-settings").set(auth(tokens.driver));
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "FORBIDDEN");
    });

    test("CUSTOMER -> forbidden", async () => {
      const res = await request(app).get("/api/v1/system-settings").set(auth(tokens.customer));
      assert.equal(res.status, 403);
    });

    test("ADMIN settings.manage -> mutation allowed", async () => {
      const setting = await seedAndTrack();
      const res = await request(app)
        .patch(`/api/v1/system-settings/${setting.key}`)
        .set(auth(tokens.admin))
        .send({ description: "updated by admin" });
      assert.equal(res.status, 200);
    });

    test("DISPATCHER mutation -> 403", async () => {
      const setting = await seedAndTrack();
      const res = await request(app)
        .patch(`/api/v1/system-settings/${setting.key}`)
        .set(auth(tokens.dispatcher))
        .send({ description: "attempted by dispatcher" });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "FORBIDDEN");
    });

    test("FINANCE mutation -> 403", async () => {
      const setting = await seedAndTrack();
      const res = await request(app)
        .patch(`/api/v1/system-settings/${setting.key}`)
        .set(auth(tokens.finance))
        .send({ description: "attempted by finance" });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "FORBIDDEN");
    });
  });

  // ===== READ =====

  describe("List / read", () => {
    test("list/read succeeds for settings.read", async () => {
      const setting = await seedAndTrack({ value: { threshold: 42 } });
      const res = await request(app).get("/api/v1/system-settings").set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.data));
      assert.ok(res.body.data.some((s: { key: string }) => s.key === setting.key));
    });

    test("detail/key lookup succeeds", async () => {
      const setting = await seedAndTrack({ value: { threshold: 7 }, description: "phase53 fixture" });
      const res = await request(app).get(`/api/v1/system-settings/${setting.key}`).set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.equal(res.body.data.key, setting.key);
      assert.deepEqual(res.body.data.value, { threshold: 7 });
      assert.equal(res.body.data.description, "phase53 fixture");
      assert.equal(res.body.data.isSensitive, false);
    });

    test("missing setting -> 404", async () => {
      const res = await request(app)
        .get(`/api/v1/system-settings/ph53.nonexistent.${Date.now()}`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, "NOT_FOUND");
    });
  });

  // ===== UPDATE =====

  describe("Update", () => {
    test("update succeeds for settings.manage", async () => {
      const setting = await seedAndTrack({ value: { enabled: false } });
      const res = await request(app)
        .patch(`/api/v1/system-settings/${setting.key}`)
        .set(auth(tokens.admin))
        .send({ value: { enabled: true }, description: "flipped on" });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data.value, { enabled: true });
      assert.equal(res.body.data.description, "flipped on");
    });

    test("updatedBy derives from req.actor and cannot be overridden by the client", async () => {
      const setting = await seedAndTrack();
      const res = await request(app)
        .patch(`/api/v1/system-settings/${setting.key}`)
        .set(auth(tokens.admin))
        .send({ value: { x: 1 }, updatedById: dispatcher.id, updated_by_id: dispatcher.id });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.updatedBy.id, admin.id);

      const row = await prisma.system_settings.findUniqueOrThrow({ where: { key: setting.key } });
      assert.equal(row.updated_by_id, admin.id, "updated_by_id must be the authenticated actor, not client input");
      assert.notEqual(row.updated_by_id, dispatcher.id);
    });

    test("client cannot override internal fields (id, key, createdAt)", async () => {
      const setting = await seedAndTrack();
      const res = await request(app)
        .patch(`/api/v1/system-settings/${setting.key}`)
        .set(auth(tokens.admin))
        .send({
          id: "00000000-0000-0000-0000-000000000000",
          key: "should-not-apply",
          createdAt: "2000-01-01T00:00:00.000Z",
          description: "legit change",
        });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.key, setting.key, "key must remain immutable via PATCH");
      assert.equal(res.body.data.description, "legit change");

      const row = await prisma.system_settings.findUnique({ where: { key: setting.key } });
      assert.ok(row, "the original key must still resolve — no row was created under the injected key");
      const injected = await prisma.system_settings.findUnique({ where: { key: "should-not-apply" } });
      assert.equal(injected, null);
    });

    test("empty PATCH -> 400", async () => {
      const setting = await seedAndTrack();
      const res = await request(app).patch(`/api/v1/system-settings/${setting.key}`).set(auth(tokens.admin)).send({});
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("update on a nonexistent key -> 404, never upserts", async () => {
      const key = `ph53.nonexistent.update.${Date.now()}`;
      const res = await request(app)
        .patch(`/api/v1/system-settings/${key}`)
        .set(auth(tokens.admin))
        .send({ value: { x: 1 } });
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, "NOT_FOUND");

      const row = await prisma.system_settings.findUnique({ where: { key } });
      assert.equal(row, null, "PATCH on an unknown key must never create it");
    });

    test("no hard-delete route exists", async () => {
      const setting = await seedAndTrack();
      const res = await request(app).delete(`/api/v1/system-settings/${setting.key}`).set(auth(tokens.admin));
      assert.equal(res.status, 404);
    });
  });

  // ===== SENSITIVE VALUE HANDLING =====

  describe("Sensitive setting handling", () => {
    test("a key that looks like a secret is redacted in both list and detail responses", async () => {
      const key = `ph53.test.api_secret_key.${Date.now()}`;
      const setting = await prisma.system_settings.create({
        data: { key, value: { raw: "super-secret-value" } },
      });
      createdSettingKeys.push(key);

      const detail = await request(app).get(`/api/v1/system-settings/${key}`).set(auth(tokens.admin));
      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.isSensitive, true);
      assert.equal(detail.body.data.value, null);
      assert.doesNotMatch(JSON.stringify(detail.body), /super-secret-value/);

      const list = await request(app).get("/api/v1/system-settings").set(auth(tokens.admin));
      const row = list.body.data.find((s: { key: string }) => s.key === key);
      assert.ok(row);
      assert.equal(row.isSensitive, true);
      assert.equal(row.value, null);
      assert.doesNotMatch(JSON.stringify(list.body), /super-secret-value/);

      void setting;
    });

    test("a non-sensitive key exposes its real value normally", async () => {
      const setting = await seedAndTrack({ value: { limit: 100 } });
      const res = await request(app).get(`/api/v1/system-settings/${setting.key}`).set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.equal(res.body.data.isSensitive, false);
      assert.deepEqual(res.body.data.value, { limit: 100 });
    });
  });
});
