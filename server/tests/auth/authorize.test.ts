import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { hashPassword } from "../../src/modules/auth/auth.utils";
import { createRbacTestApp } from "../helpers/rbac-test-app";
import { cleanupTestUser, createTestUser, loginTestUser, uniqueSuffix, type TestUser } from "../helpers/fixtures";

describe("authorize(permission) — RBAC matrix", () => {
  // Login goes through the REAL production app (it owns /api/v1/auth/login).
  // The permission checks below go through the minimal RBAC test harness,
  // which mounts the real authenticate/authorize middleware against an
  // arbitrary permission code. A JWT's validity does not depend on which
  // Express app instance receives it, so reusing tokens across the two is
  // safe and exercises the real, unmodified middleware either way.
  let authApp: Express;
  let rbacApp: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driver: TestUser;
  let customer: TestUser;
  let tokens: Record<string, string>;

  before(async () => {
    authApp = createApp();
    rbacApp = createRbacTestApp();

    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    finance = await createTestUser("FINANCE");
    driver = await createTestUser("DRIVER");
    customer = await createTestUser("CUSTOMER");

    const [adminLogin, dispatcherLogin, financeLogin, driverLogin, customerLogin] = await Promise.all([
      loginTestUser(authApp, admin.email, admin.password),
      loginTestUser(authApp, dispatcher.email, dispatcher.password),
      loginTestUser(authApp, finance.email, finance.password),
      loginTestUser(authApp, driver.email, driver.password),
      loginTestUser(authApp, customer.email, customer.password),
    ]);

    tokens = {
      admin: adminLogin.accessToken as string,
      dispatcher: dispatcherLogin.accessToken as string,
      finance: financeLogin.accessToken as string,
      driver: driverLogin.accessToken as string,
      customer: customerLogin.accessToken as string,
    };

    for (const [role, token] of Object.entries(tokens)) {
      assert.ok(token, `expected a real access token for ${role}`);
    }
  });

  after(async () => {
    await Promise.all([admin, dispatcher, finance, driver, customer].map((u) => cleanupTestUser(u.id)));
  });

  function authed(token: string, permission: string) {
    return request(rbacApp).get(`/rbac/${permission}`).set("Authorization", `Bearer ${token}`);
  }

  test("ADMIN is permitted for a management permission (settings.manage) — no role-name bypass, matches its real role_permissions row", async () => {
    const res = await authed(tokens.admin, "settings.manage");
    assert.equal(res.status, 200);
  });

  test("DISPATCHER: orders.create -> allowed", async () => {
    const res = await authed(tokens.dispatcher, "orders.create");
    assert.equal(res.status, 200);
  });

  test("DISPATCHER: finance.read -> forbidden", async () => {
    const res = await authed(tokens.dispatcher, "finance.read");
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "FORBIDDEN");
  });

  test("FINANCE: finance.read -> allowed", async () => {
    const res = await authed(tokens.finance, "finance.read");
    assert.equal(res.status, 200);
  });

  test("FINANCE: orders.create -> forbidden", async () => {
    const res = await authed(tokens.finance, "orders.create");
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "FORBIDDEN");
  });

  test("DRIVER: driver.orders.read_own -> allowed", async () => {
    const res = await authed(tokens.driver, "driver.orders.read_own");
    assert.equal(res.status, 200);
  });

  test("DRIVER: management orders.read -> forbidden", async () => {
    const res = await authed(tokens.driver, "orders.read");
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "FORBIDDEN");
  });

  test("CUSTOMER: customer.orders.read_own -> allowed", async () => {
    const res = await authed(tokens.customer, "customer.orders.read_own");
    assert.equal(res.status, 200);
  });

  test("CUSTOMER: driver.orders.read_own -> forbidden", async () => {
    const res = await authed(tokens.customer, "driver.orders.read_own");
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "FORBIDDEN");
  });

  test("unauthenticated request -> 401 (not 403)", async () => {
    const res = await request(rbacApp).get("/rbac/orders.read");
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "UNAUTHORIZED");
  });

  test("authenticated but missing permission -> 403 (not 401)", async () => {
    const res = await authed(tokens.dispatcher, "audit.read");
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "FORBIDDEN");
  });
});

describe("authorize(permission) — dynamic DB permission behavior (isolated fixture)", () => {
  let authApp: Express;
  let rbacApp: Express;
  let tempRoleId: string;
  let tempPermissionId: string;
  let tempPermissionCode: string;
  let tempUser: TestUser;
  let tempUserToken: string;

  before(async () => {
    authApp = createApp();
    rbacApp = createRbacTestApp();

    const suffix = uniqueSuffix();
    tempPermissionCode = `_test.dynamic.${suffix}`;

    const tempRole = await prisma.roles.create({
      data: { code: `_TEST_DYN_ROLE_${suffix}`, name: `Test Dynamic Role ${suffix}`, is_active: true },
    });
    tempRoleId = tempRole.id;

    const tempPermission = await prisma.permissions.create({
      data: { code: tempPermissionCode, name: `Test Dynamic Permission ${suffix}` },
    });
    tempPermissionId = tempPermission.id;

    const user = await prisma.users.create({
      data: {
        email: `dyn-perm-${suffix}@phase4-5-test.swiftdrop.local`,
        password_hash: await hashPassword("Phase45-Test-Pw!"),
        first_name: "Phase45",
        last_name: "DynamicPermission",
        role_id: tempRoleId,
      },
    });
    tempUser = { id: user.id, email: user.email, password: "Phase45-Test-Pw!", roleCode: tempRole.code };

    const login = await loginTestUser(authApp, tempUser.email, tempUser.password);
    tempUserToken = login.accessToken as string;
    assert.ok(tempUserToken);
  });

  after(async () => {
    // Full isolated-fixture teardown, in FK-safe order. Never touches any
    // canonical role/permission/role_permissions row.
    await prisma.role_permissions.deleteMany({ where: { role_id: tempRoleId } });
    await cleanupTestUser(tempUser.id);
    await prisma.permissions.deleteMany({ where: { id: tempPermissionId } });
    await prisma.roles.deleteMany({ where: { id: tempRoleId } });

    // Excludes only the "_test." temp-permission prefix (same reasoning as
    // the canonical V1 matrix regression test below) — an unscoped count
    // can otherwise race against another concurrently-running test file.
    const permissionCount = await prisma.permissions.count({ where: { code: { not: { startsWith: "_test." } } } });
    assert.equal(permissionCount, 35, "permission catalog must be back to exactly 35 after fixture teardown");
  });

  test("before assignment: temp user lacks the temp permission -> 403", async () => {
    const res = await request(rbacApp)
      .get(`/rbac/${tempPermissionCode}`)
      .set("Authorization", `Bearer ${tempUserToken}`);
    assert.equal(res.status, 403);
  });

  test("after granting role_permission in DB: SAME access token is now allowed", async () => {
    await prisma.role_permissions.create({
      data: { role_id: tempRoleId, permission_id: tempPermissionId },
    });

    const res = await request(rbacApp)
      .get(`/rbac/${tempPermissionCode}`)
      .set("Authorization", `Bearer ${tempUserToken}`);
    assert.equal(res.status, 200);
  });

  test("after revoking role_permission in DB: SAME access token is forbidden again", async () => {
    await prisma.role_permissions.deleteMany({ where: { role_id: tempRoleId, permission_id: tempPermissionId } });

    const res = await request(rbacApp)
      .get(`/rbac/${tempPermissionCode}`)
      .set("Authorization", `Bearer ${tempUserToken}`);
    assert.equal(res.status, 403);
  });
});

describe("authorize(permission) — canonical V1 matrix regression", () => {
  test("permission catalog and per-role counts match the approved V1 matrix", async () => {
    const counts = await prisma.roles.findMany({
      select: { code: true, _count: { select: { role_permissions: true } } },
      orderBy: { code: "asc" },
    });

    const byCode = Object.fromEntries(counts.map((r) => [r.code, r._count.role_permissions]));

    assert.equal(byCode.ADMIN, 35);
    assert.equal(byCode.DISPATCHER, 13);
    assert.equal(byCode.FINANCE, 14);
    assert.equal(byCode.DRIVER, 3);
    assert.equal(byCode.CUSTOMER, 6);

    // Excludes only the one known temporary-permission code prefix this
    // file's own dynamic-permission fixture uses ("_test.dynamic.<suffix>")
    // — a raw prisma.permissions.count() can otherwise transiently observe
    // a still-live temp permission from a concurrently-running test file.
    const totalPermissions = await prisma.permissions.count({ where: { code: { not: { startsWith: "_test." } } } });
    assert.equal(totalPermissions, 35);
  });
});
