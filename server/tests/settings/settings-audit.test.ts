import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import {
  cleanupTestFailedDeliveryReason,
  cleanupTestPaymentMethod,
  cleanupTestSetting,
  cleanupTestUser,
  createTestUser,
  loginTestUser,
  seedTestSetting,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

/**
 * Phase 11.16 — reference-data + system-setting mutations must now be
 * traceable. Phase 5.3 built these APIs before audit infrastructure existed
 * and deferred audit; this verifies the producers added in 11.16. Every
 * fixture here is test-owned (never a canonical seeded row).
 */
describe("Settings mutation audit (Phase 11.16)", () => {
  let app: Express;
  let admin: TestUser;
  let token: string;
  const areaIds: string[] = [];
  const pmIds: string[] = [];
  const reasonIds: string[] = [];
  const settingKeys: string[] = [];

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    const login = await loginTestUser(app, admin.email, admin.password);
    token = login.accessToken as string;
    assert.ok(token);
  });

  after(async () => {
    for (const id of areaIds) {
      await prisma.audit_logs.deleteMany({ where: { entity_type: "AREA", entity_id: id } });
      await prisma.areas.deleteMany({ where: { id } });
    }
    for (const id of pmIds) {
      await prisma.audit_logs.deleteMany({ where: { entity_type: "PAYMENT_METHOD", entity_id: id } });
      await cleanupTestPaymentMethod(id);
    }
    for (const id of reasonIds) {
      await prisma.audit_logs.deleteMany({ where: { entity_type: "FAILED_DELIVERY_REASON", entity_id: id } });
      await cleanupTestFailedDeliveryReason(id);
    }
    for (const key of settingKeys) {
      await prisma.audit_logs.deleteMany({ where: { entity_type: "SYSTEM_SETTING", entity_id: key } });
      await cleanupTestSetting(key);
    }
    await prisma.audit_logs.deleteMany({ where: { actor_user_id: admin.id } });
    await cleanupTestUser(admin.id);
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function auditFor(entityType: string, entityId: string) {
    return prisma.audit_logs.findMany({
      where: { entity_type: entityType, entity_id: entityId, actor_user_id: admin.id },
      orderBy: { created_at: "asc" },
    });
  }

  // ===== AREAS =====

  test("area create/update/deactivate/reactivate each write a traceable audit row", async () => {
    const created = await request(app)
      .post("/api/v1/settings/areas")
      .set(auth())
      .send({ name: `PH1116 Area ${uniqueSuffix()}` });
    assert.equal(created.status, 201);
    const id = created.body.data.id as string;
    areaIds.push(id);

    await request(app).patch(`/api/v1/settings/areas/${id}`).set(auth()).send({ name: "PH1116 Renamed", sortOrder: 3 });
    await request(app).patch(`/api/v1/settings/areas/${id}`).set(auth()).send({ isActive: false });
    await request(app).patch(`/api/v1/settings/areas/${id}`).set(auth()).send({ isActive: true });

    const rows = await auditFor("AREA", id);
    const actions = rows.map((r) => r.action);
    assert.deepEqual(actions, ["AREA_CREATED", "AREA_UPDATED", "AREA_DEACTIVATED", "AREA_REACTIVATED"]);

    const update = rows[1]!;
    assert.equal((update.previous_values as { name: string }).name !== undefined, true);
    assert.equal((update.new_values as { name: string }).name, "PH1116 Renamed");
    const deact = rows[2]!;
    assert.equal((deact.previous_values as { isActive: boolean }).isActive, true);
    assert.equal((deact.new_values as { isActive: boolean }).isActive, false);
  });

  test("area update that changes nothing writes no audit row", async () => {
    const created = await request(app)
      .post("/api/v1/settings/areas")
      .set(auth())
      .send({ name: `PH1116 NoChange ${uniqueSuffix()}`, sortOrder: 2 });
    const id = created.body.data.id as string;
    areaIds.push(id);

    const res = await request(app).patch(`/api/v1/settings/areas/${id}`).set(auth()).send({ sortOrder: 2 });
    assert.equal(res.status, 200);

    const rows = await auditFor("AREA", id);
    assert.deepEqual(rows.map((r) => r.action), ["AREA_CREATED"]);
  });

  // ===== PAYMENT METHODS =====

  test("payment method create/update/deactivate/reactivate each write a traceable audit row", async () => {
    const s = uniqueSuffix();
    const created = await request(app)
      .post("/api/v1/settings/payment-methods")
      .set(auth())
      .send({ code: `PH1116_${s}`, name: `PH1116 Method ${s}` });
    assert.equal(created.status, 201);
    const id = created.body.data.id as string;
    pmIds.push(id);

    await request(app).patch(`/api/v1/settings/payment-methods/${id}`).set(auth()).send({ name: "PH1116 Renamed Method" });
    await request(app).patch(`/api/v1/settings/payment-methods/${id}`).set(auth()).send({ isActive: false });
    await request(app).patch(`/api/v1/settings/payment-methods/${id}`).set(auth()).send({ isActive: true });

    const rows = await auditFor("PAYMENT_METHOD", id);
    assert.deepEqual(rows.map((r) => r.action), [
      "PAYMENT_METHOD_CREATED",
      "PAYMENT_METHOD_UPDATED",
      "PAYMENT_METHOD_DEACTIVATED",
      "PAYMENT_METHOD_REACTIVATED",
    ]);
    assert.equal((rows[0]!.new_values as { code: string }).code, `PH1116_${s}`);
    assert.equal((rows[1]!.metadata as { code: string }).code, `PH1116_${s}`);
  });

  // ===== FAILED DELIVERY REASONS =====

  test("failed delivery reason create/update each write a traceable audit row incl. requiresNotes", async () => {
    const created = await request(app)
      .post("/api/v1/settings/failed-delivery-reasons")
      .set(auth())
      .send({ name: `PH1116 Reason ${uniqueSuffix()}`, requiresNotes: false });
    assert.equal(created.status, 201);
    const id = created.body.data.id as string;
    reasonIds.push(id);

    await request(app)
      .patch(`/api/v1/settings/failed-delivery-reasons/${id}`)
      .set(auth())
      .send({ requiresNotes: true });
    await request(app)
      .patch(`/api/v1/settings/failed-delivery-reasons/${id}`)
      .set(auth())
      .send({ isActive: false });

    const rows = await auditFor("FAILED_DELIVERY_REASON", id);
    assert.deepEqual(rows.map((r) => r.action), [
      "FAILED_DELIVERY_REASON_CREATED",
      "FAILED_DELIVERY_REASON_UPDATED",
      "FAILED_DELIVERY_REASON_DEACTIVATED",
    ]);
    assert.equal((rows[1]!.new_values as { requiresNotes: boolean }).requiresNotes, true);
  });

  // ===== SYSTEM SETTINGS =====

  test("non-sensitive system setting update writes SYSTEM_SETTING_UPDATED with the real values", async () => {
    const setting = await seedTestSetting({ value: { limit: 10 } });
    settingKeys.push(setting.key);

    const res = await request(app)
      .patch(`/api/v1/system-settings/${setting.key}`)
      .set(auth())
      .send({ value: { limit: 20 }, description: "raised" });
    assert.equal(res.status, 200);

    const rows = await auditFor("SYSTEM_SETTING", setting.key);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.action, "SYSTEM_SETTING_UPDATED");
    assert.deepEqual((rows[0]!.previous_values as { value: unknown }).value, { limit: 10 });
    assert.deepEqual((rows[0]!.new_values as { value: unknown }).value, { limit: 20 });
    assert.equal((rows[0]!.metadata as { isSensitive: boolean }).isSensitive, false);
  });

  test("SENSITIVE system setting update NEVER records the real value in audit", async () => {
    const key = `ph1116.test.api_secret_key.${uniqueSuffix()}`;
    await prisma.system_settings.create({ data: { key, value: { raw: "old-secret" } } });
    settingKeys.push(key);

    const res = await request(app)
      .patch(`/api/v1/system-settings/${key}`)
      .set(auth())
      .send({ value: { raw: "new-super-secret-value" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.value, null, "response still redacts");

    const rows = await auditFor("SYSTEM_SETTING", key);
    assert.equal(rows.length, 1);
    assert.equal((rows[0]!.previous_values as { value: string }).value, "[redacted]");
    assert.equal((rows[0]!.new_values as { value: string }).value, "[redacted]");
    assert.equal((rows[0]!.metadata as { isSensitive: boolean }).isSensitive, true);
    assert.doesNotMatch(JSON.stringify(rows[0]), /old-secret|new-super-secret-value/);
  });

  test("system setting update on unknown key -> 404 and writes no audit row", async () => {
    const key = `ph1116.unknown.${uniqueSuffix()}`;
    const res = await request(app).patch(`/api/v1/system-settings/${key}`).set(auth()).send({ value: { x: 1 } });
    assert.equal(res.status, 404);
    const rows = await auditFor("SYSTEM_SETTING", key);
    assert.equal(rows.length, 0);
  });
});
