import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { cleanupTestUser, createTestUser, loginTestUser, type TestUser } from "../helpers/fixtures";

/**
 * Phase 11.16 — Settings Role → Permission configuration.
 *
 * IMPORTANT: node:test runs test FILES concurrently against ONE database.
 * A real permission REMOVE/ADD on the GLOBAL DISPATCHER/FINANCE role would
 * race every other suite that logs in as those roles. So this file only
 * covers the NON-MUTATING paths (reads, authorization, ADMIN lock,
 * validation rejections that roll back before any write, and a no-op
 * self-replacement that exercises the full transaction + audit path without
 * changing the effective permission set). The destructive add/remove +
 * same-token refresh + concurrency + restore lifecycle is covered by the
 * serial live smoke (scratchpad/settings-smoke.mjs), mirroring the Phase
 * 11.14 last-active-admin approach.
 */
describe("Settings Role Config backend (Phase 11.16)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driver: TestUser;
  let customer: TestUser;
  let tokens: Record<string, string>;
  const authoredAuditActorIds: string[] = [];

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    finance = await createTestUser("FINANCE");
    driver = await createTestUser("DRIVER");
    customer = await createTestUser("CUSTOMER");
    authoredAuditActorIds.push(admin.id);

    const [a, d, f, dr, c] = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, dispatcher.email, dispatcher.password),
      loginTestUser(app, finance.email, finance.password),
      loginTestUser(app, driver.email, driver.password),
      loginTestUser(app, customer.email, customer.password),
    ]);
    tokens = {
      admin: a.accessToken as string,
      dispatcher: d.accessToken as string,
      finance: f.accessToken as string,
      driver: dr.accessToken as string,
      customer: c.accessToken as string,
    };
    for (const [k, v] of Object.entries(tokens)) assert.ok(v, `token for ${k}`);
  });

  after(async () => {
    for (const id of authoredAuditActorIds) {
      await prisma.audit_logs.deleteMany({ where: { actor_user_id: id } });
    }
    await Promise.all(
      [admin, dispatcher, finance, driver, customer].map((u) => cleanupTestUser(u.id)),
    );
  });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function getRoles() {
    const res = await request(app).get("/api/v1/settings/roles").set(auth(tokens.admin));
    assert.equal(res.status, 200);
    return res.body.data as {
      roles: {
        id: string;
        code: string;
        editable: boolean;
        locked: boolean;
        permissionCodes: string[];
      }[];
      permissionCatalog: { code: string }[];
      assignablePermissionCodes: string[];
      editableRoleCodes: string[];
      lockedRoleCodes: string[];
    };
  }

  // ===== AUTHORIZATION =====

  describe("Authorization", () => {
    test("no auth -> 401", async () => {
      const res = await request(app).get("/api/v1/settings/roles");
      assert.equal(res.status, 401);
    });

    for (const role of ["admin", "dispatcher", "finance"]) {
      test(`${role} settings.read -> GET allowed`, async () => {
        const res = await request(app).get("/api/v1/settings/roles").set(auth(tokens[role]));
        assert.equal(res.status, 200);
      });
    }

    for (const role of ["driver", "customer"]) {
      test(`${role} -> GET forbidden`, async () => {
        const res = await request(app).get("/api/v1/settings/roles").set(auth(tokens[role]));
        assert.equal(res.status, 403);
      });
    }

    test("DISPATCHER PUT -> 403 (no settings.manage)", async () => {
      const { roles } = await getRoles();
      const target = roles.find((r) => r.code === "DISPATCHER")!;
      const res = await request(app)
        .put(`/api/v1/settings/roles/${target.id}/permissions`)
        .set(auth(tokens.dispatcher))
        .send({ permissionCodes: target.permissionCodes });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "FORBIDDEN");
    });

    test("FINANCE PUT -> 403", async () => {
      const { roles } = await getRoles();
      const target = roles.find((r) => r.code === "FINANCE")!;
      const res = await request(app)
        .put(`/api/v1/settings/roles/${target.id}/permissions`)
        .set(auth(tokens.finance))
        .send({ permissionCodes: target.permissionCodes });
      assert.equal(res.status, 403);
    });

    test("DRIVER PUT -> 403", async () => {
      const { roles } = await getRoles();
      const target = roles.find((r) => r.code === "DISPATCHER")!;
      const res = await request(app)
        .put(`/api/v1/settings/roles/${target.id}/permissions`)
        .set(auth(tokens.driver))
        .send({ permissionCodes: [] });
      assert.equal(res.status, 403);
    });
  });

  // ===== READ CONTRACT =====

  describe("GET /settings/roles", () => {
    test("returns only the three management roles, sorted ADMIN/DISPATCHER/FINANCE", async () => {
      const data = await getRoles();
      assert.deepEqual(
        data.roles.map((r) => r.code),
        ["ADMIN", "DISPATCHER", "FINANCE"],
      );
    });

    test("full 35-permission catalog, sorted by code", async () => {
      const data = await getRoles();
      assert.equal(data.permissionCatalog.length, 35);
      const codes = data.permissionCatalog.map((p) => p.code);
      assert.deepEqual([...codes].sort(), codes);
    });

    test("ADMIN is locked + not editable and holds every catalog permission", async () => {
      const data = await getRoles();
      const adminRole = data.roles.find((r) => r.code === "ADMIN")!;
      assert.equal(adminRole.locked, true);
      assert.equal(adminRole.editable, false);
      assert.equal(adminRole.permissionCodes.length, data.permissionCatalog.length);
    });

    test("DISPATCHER and FINANCE are editable, not locked", async () => {
      const data = await getRoles();
      for (const code of ["DISPATCHER", "FINANCE"]) {
        const r = data.roles.find((x) => x.code === code)!;
        assert.equal(r.editable, true);
        assert.equal(r.locked, false);
      }
      assert.deepEqual(data.editableRoleCodes.sort(), ["DISPATCHER", "FINANCE"]);
      assert.deepEqual(data.lockedRoleCodes, ["ADMIN"]);
    });

    test("assignablePermissionCodes excludes every driver.* / customer.* portal permission", async () => {
      const data = await getRoles();
      assert.ok(data.assignablePermissionCodes.length > 0);
      assert.ok(
        data.assignablePermissionCodes.every(
          (c) => !c.startsWith("driver.") && !c.startsWith("customer."),
        ),
      );
      // and it is a strict subset of the catalog
      const catalog = new Set(data.permissionCatalog.map((p) => p.code));
      assert.ok(data.assignablePermissionCodes.every((c) => catalog.has(c)));
      assert.ok(data.assignablePermissionCodes.length < data.permissionCatalog.length);
    });

    test("no password / token / hash / session field anywhere in the response", async () => {
      const data = await getRoles();
      assert.doesNotMatch(JSON.stringify(data), /password|token|hash|secret|session|refresh/i);
    });
  });

  // ===== MUTATION — NON-DESTRUCTIVE ONLY =====

  describe("PUT /settings/roles/:id/permissions — guarded paths", () => {
    test("ADMIN role rejected with 409, matrix unchanged", async () => {
      const { roles } = await getRoles();
      const adminRole = roles.find((r) => r.code === "ADMIN")!;
      const before = adminRole.permissionCodes.length;
      const res = await request(app)
        .put(`/api/v1/settings/roles/${adminRole.id}/permissions`)
        .set(auth(tokens.admin))
        .send({ permissionCodes: ["dashboard.read"] });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "CONFLICT");

      const after = await prisma.role_permissions.count({ where: { role_id: adminRole.id } });
      assert.equal(after, before, "ADMIN matrix must be untouched");
    });

    test("unknown role id -> 404", async () => {
      const res = await request(app)
        .put("/api/v1/settings/roles/00000000-0000-0000-0000-000000000000/permissions")
        .set(auth(tokens.admin))
        .send({ permissionCodes: [] });
      assert.equal(res.status, 404);
    });

    test("malformed role id -> 400", async () => {
      const res = await request(app)
        .put("/api/v1/settings/roles/not-a-uuid/permissions")
        .set(auth(tokens.admin))
        .send({ permissionCodes: [] });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("DRIVER role id -> 400 (not a Settings-configurable role), matrix unchanged", async () => {
      const driverRole = await prisma.roles.findUniqueOrThrow({ where: { code: "DRIVER" } });
      const before = await prisma.role_permissions.count({ where: { role_id: driverRole.id } });
      const res = await request(app)
        .put(`/api/v1/settings/roles/${driverRole.id}/permissions`)
        .set(auth(tokens.admin))
        .send({ permissionCodes: [] });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
      const after = await prisma.role_permissions.count({ where: { role_id: driverRole.id } });
      assert.equal(after, before);
    });

    test("unknown permission code -> 400, DISPATCHER matrix unchanged", async () => {
      const { roles } = await getRoles();
      const target = roles.find((r) => r.code === "DISPATCHER")!;
      const before = await prisma.role_permissions.count({ where: { role_id: target.id } });
      const res = await request(app)
        .put(`/api/v1/settings/roles/${target.id}/permissions`)
        .set(auth(tokens.admin))
        .send({ permissionCodes: [...target.permissionCodes, "orders.teleport"] });
      assert.equal(res.status, 400);
      assert.match(res.body.error.message, /orders\.teleport/);
      const after = await prisma.role_permissions.count({ where: { role_id: target.id } });
      assert.equal(after, before, "a rejected update must roll back completely");
    });

    test("duplicate permission code -> 400, matrix unchanged", async () => {
      const { roles } = await getRoles();
      const target = roles.find((r) => r.code === "FINANCE")!;
      const before = await prisma.role_permissions.count({ where: { role_id: target.id } });
      const res = await request(app)
        .put(`/api/v1/settings/roles/${target.id}/permissions`)
        .set(auth(tokens.admin))
        .send({ permissionCodes: ["orders.read", "orders.read"] });
      assert.equal(res.status, 400);
      const after = await prisma.role_permissions.count({ where: { role_id: target.id } });
      assert.equal(after, before);
    });

    test("assigning a driver.* portal permission to DISPATCHER -> 400, matrix unchanged", async () => {
      const { roles } = await getRoles();
      const target = roles.find((r) => r.code === "DISPATCHER")!;
      const before = await prisma.role_permissions.count({ where: { role_id: target.id } });
      const res = await request(app)
        .put(`/api/v1/settings/roles/${target.id}/permissions`)
        .set(auth(tokens.admin))
        .send({ permissionCodes: [...target.permissionCodes, "driver.cash.read_own"] });
      assert.equal(res.status, 400);
      assert.match(res.body.error.message, /driver\.cash\.read_own/);
      const after = await prisma.role_permissions.count({ where: { role_id: target.id } });
      assert.equal(after, before);
    });

    test("no-op self-replacement succeeds, exercises the txn + writes ONE audit row, effective set unchanged", async () => {
      const { roles } = await getRoles();
      const target = roles.find((r) => r.code === "FINANCE")!;
      const currentIds = new Set(
        (await prisma.role_permissions.findMany({ where: { role_id: target.id } })).map(
          (rp) => rp.permission_id,
        ),
      );

      const res = await request(app)
        .put(`/api/v1/settings/roles/${target.id}/permissions`)
        .set(auth(tokens.admin))
        .send({ permissionCodes: target.permissionCodes });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.code, "FINANCE");
      assert.deepEqual([...res.body.data.permissionCodes].sort(), [...target.permissionCodes].sort());

      const afterIds = new Set(
        (await prisma.role_permissions.findMany({ where: { role_id: target.id } })).map(
          (rp) => rp.permission_id,
        ),
      );
      assert.equal(afterIds.size, currentIds.size);
      for (const id of currentIds) assert.ok(afterIds.has(id), "effective permission set must be identical");

      const auditRow = await prisma.audit_logs.findFirst({
        where: { action: "ROLE_PERMISSIONS_UPDATED", entity_id: target.id, actor_user_id: admin.id },
        orderBy: { created_at: "desc" },
      });
      assert.ok(auditRow, "a ROLE_PERMISSIONS_UPDATED audit row must exist");
      assert.equal((auditRow!.new_values as { roleCode: string }).roleCode, "FINANCE");
      assert.deepEqual((auditRow!.metadata as { added: string[]; removed: string[] }).added, []);
      assert.deepEqual((auditRow!.metadata as { added: string[]; removed: string[] }).removed, []);
      assert.doesNotMatch(JSON.stringify(auditRow), /password|token|hash|jwt|secret/i);
    });
  });
});
