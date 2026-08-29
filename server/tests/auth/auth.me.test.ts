import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { cleanupTestUser, createTestUser, loginTestUser, setUserActive, type TestUser } from "../helpers/fixtures";

const ADMIN_FULL_PERMISSION_SET = [
  "audit.read",
  "customer.dashboard.read_own",
  "customer.orders.read_own",
  "customer.payouts.read_own",
  "customer.profile.read_own",
  "customer.profile.update_own",
  "customer.wallet.read_own",
  "customers.create",
  "customers.read",
  "customers.update",
  "dashboard.read",
  "driver.cash.read_own",
  "driver.orders.read_own",
  "driver.orders.update_own",
  "drivers.manage",
  "drivers.read",
  "employees.manage",
  "employees.read",
  "finance.adjust",
  "finance.read",
  "orders.assign",
  "orders.cancel",
  "orders.change_status",
  "orders.create",
  "orders.read",
  "orders.update",
  "payouts.create",
  "payouts.read",
  "reports.read",
  "settings.manage",
  "settings.read",
  "settlements.create",
  "settlements.read",
  "wallets.adjust",
  "wallets.read",
].sort();

const DRIVER_PERMISSION_SET = ["driver.cash.read_own", "driver.orders.read_own", "driver.orders.update_own"].sort();

const CUSTOMER_PERMISSION_SET = [
  "customer.dashboard.read_own",
  "customer.orders.read_own",
  "customer.payouts.read_own",
  "customer.profile.read_own",
  "customer.profile.update_own",
  "customer.wallet.read_own",
].sort();

describe("GET /api/v1/auth/me", () => {
  let app: Express;
  let admin: TestUser;
  let driver: TestUser;
  let customer: TestUser;
  let inactiveUser: TestUser;
  let inactiveToken: string;

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    driver = await createTestUser("DRIVER");
    customer = await createTestUser("CUSTOMER");
    inactiveUser = await createTestUser("DISPATCHER");

    const inactiveLogin = await loginTestUser(app, inactiveUser.email, inactiveUser.password);
    inactiveToken = inactiveLogin.accessToken as string;
    await setUserActive(inactiveUser.id, false);
  });

  after(async () => {
    await cleanupTestUser(admin.id);
    await cleanupTestUser(driver.id);
    await cleanupTestUser(customer.id);
    await cleanupTestUser(inactiveUser.id);
  });

  test("valid authenticated user -> 200 with SafeUser, role, and permission codes", async () => {
    const login = await loginTestUser(app, admin.email, admin.password);
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${login.accessToken}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.data.user.id, admin.id);
    assert.equal(res.body.data.user.email, admin.email);
    assert.equal(res.body.data.user.role.code, "ADMIN");
    assert.ok(Array.isArray(res.body.data.permissions));
  });

  test("password/hash fields are absent from the response", async () => {
    const login = await loginTestUser(app, admin.email, admin.password);
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${login.accessToken}`);

    const serialized = JSON.stringify(res.body);
    assert.doesNotMatch(serialized, /password_hash/i);
    assert.doesNotMatch(serialized, /passwordHash/i);
  });

  test("ADMIN resolves the full approved V1 permission set (exact codes, not just a count)", async () => {
    const login = await loginTestUser(app, admin.email, admin.password);
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${login.accessToken}`);

    assert.deepEqual([...res.body.data.permissions].sort(), ADMIN_FULL_PERMISSION_SET);
  });

  test("DRIVER resolves exactly its three approved permission codes", async () => {
    const login = await loginTestUser(app, driver.email, driver.password);
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${login.accessToken}`);

    assert.equal(res.body.data.user.role.code, "DRIVER");
    assert.deepEqual([...res.body.data.permissions].sort(), DRIVER_PERMISSION_SET);
  });

  test("CUSTOMER resolves exactly its six approved permission codes", async () => {
    const login = await loginTestUser(app, customer.email, customer.password);
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${login.accessToken}`);

    assert.equal(res.body.data.user.role.code, "CUSTOMER");
    assert.deepEqual([...res.body.data.permissions].sort(), CUSTOMER_PERMISSION_SET);
  });

  test("no token -> 401", async () => {
    const res = await request(app).get("/api/v1/auth/me");
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "UNAUTHORIZED");
  });

  test("invalid token -> 401", async () => {
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", "Bearer garbage-token-value");
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "UNAUTHORIZED");
  });

  test("inactive user -> 401 even with a previously-valid access token", async () => {
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${inactiveToken}`);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "UNAUTHORIZED");
  });
});
