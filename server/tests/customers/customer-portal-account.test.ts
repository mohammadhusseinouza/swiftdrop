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
  createTestUser,
  loginTestUser,
  seedTestOrder,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

// Customer Portal credentials managed from the Management Customer endpoints:
// optional portalPassword on POST /customers (new login) and PATCH
// /customers/:id (grant later, or set a new password). Same architecture as
// Driver new-login: a CUSTOMER-role users row linked via portal_user_id.
describe("Customer portal account (Management-managed credentials)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driver: TestUser;
  let plainCustomerUser: TestUser;
  let tokens: Record<string, string>;
  let area: { id: string; name: string };

  const createdCustomerIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdOrderIds: string[] = [];

  const PASSWORD = "PortalPass#2026";
  const NEW_PASSWORD = "NewPortalPass#2026";

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    finance = await createTestUser("FINANCE");
    driver = await createTestUser("DRIVER");
    plainCustomerUser = await createTestUser("CUSTOMER");
    const logins = await Promise.all(
      [admin, dispatcher, finance, driver, plainCustomerUser].map((u) => loginTestUser(app, u.email, u.password))
    );
    tokens = {
      admin: logins[0].accessToken as string,
      dispatcher: logins[1].accessToken as string,
      finance: logins[2].accessToken as string,
      driver: logins[3].accessToken as string,
      customer: logins[4].accessToken as string,
    };
    for (const [role, token] of Object.entries(tokens)) assert.ok(token, `expected an access token for ${role}`);
    area = await createTestArea();
  });

  after(async () => {
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    for (const id of createdUserIds) await cleanupTestUser(id);
    await cleanupTestArea(area.id);
    await Promise.all([admin, dispatcher, finance, driver, plainCustomerUser].map((u) => cleanupTestUser(u.id)));
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  function uniqueEmailAddress() {
    return `portal-${uniqueSuffix()}@phase4-5-test.springcargo.local`;
  }

  function payload(overrides: Record<string, unknown> = {}) {
    return {
      name: `Portal Customer ${uniqueSuffix()}`,
      primaryPhone: "+96170000099",
      email: uniqueEmailAddress(),
      ...overrides,
    };
  }

  async function trackCustomer(customerId: string) {
    createdCustomerIds.push(customerId);
    const row = await prisma.customers.findUniqueOrThrow({ where: { id: customerId } });
    if (row.portal_user_id) createdUserIds.push(row.portal_user_id);
    return row;
  }

  async function createCustomer(body: Record<string, unknown>, token = tokens.admin) {
    const res = await request(app).post("/api/v1/customers").set(auth(token)).send(body);
    if (res.status === 201) await trackCustomer(res.body.data.id);
    return res;
  }

  async function patchCustomer(id: string, body: Record<string, unknown>, token = tokens.admin) {
    const res = await request(app).patch(`/api/v1/customers/${id}`).set(auth(token)).send(body);
    if (res.status === 200) {
      const row = await prisma.customers.findUniqueOrThrow({ where: { id } });
      if (row.portal_user_id && !createdUserIds.includes(row.portal_user_id)) createdUserIds.push(row.portal_user_id);
    }
    return res;
  }

  function assertNoSecrets(body: unknown) {
    const text = JSON.stringify(body);
    assert.ok(!text.includes(PASSWORD) && !text.includes(NEW_PASSWORD), `must not contain a plaintext password: ${text}`);
    assert.ok(!/"(password|password_hash|passwordHash|portalPassword)"\s*:/i.test(text), `must not contain a password field: ${text}`);
    assert.ok(!/\$2[aby]\$/.test(text), "must not contain a bcrypt hash");
  }

  async function portalUserCount(email: string) {
    return prisma.users.count({ where: { email } });
  }

  // ===========================================================
  // New customer
  // ===========================================================

  describe("New customer", () => {
    test("created without a password: no portal account, cannot log in", async () => {
      const body = payload();
      const res = await createCustomer(body);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.hasPortalAccount, false);

      const row = await prisma.customers.findUniqueOrThrow({ where: { id: res.body.data.id } });
      assert.equal(row.portal_user_id, null);
      assert.equal(await portalUserCount(body.email), 0);

      const login = await loginTestUser(app, body.email, PASSWORD);
      assert.equal(login.status, 401);
    });

    test("created with a password: linked CUSTOMER user, hashed password, can log in and resolves to this customer", async () => {
      const body = payload({ name: "Lina Haddad Trading" });
      const res = await createCustomer({ ...body, portalPassword: PASSWORD });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.hasPortalAccount, true);
      assertNoSecrets(res.body);

      const row = await prisma.customers.findUniqueOrThrow({ where: { id: res.body.data.id } });
      assert.ok(row.portal_user_id);
      const user = await prisma.users.findUniqueOrThrow({ where: { id: row.portal_user_id }, include: { roles: true } });
      assert.equal(user.roles.code, "CUSTOMER");
      assert.equal(user.email, body.email);
      assert.equal(user.is_active, true);
      assert.equal(user.first_name, "Lina");
      assert.equal(user.last_name, "Haddad Trading");
      assert.equal(user.phone, body.primaryPhone);
      assert.notEqual(user.password_hash, PASSWORD);
      assert.match(user.password_hash, /^\$2[aby]\$/);

      // No other role profile was created for this login.
      assert.equal(await prisma.drivers.count({ where: { user_id: user.id } }), 0);
      assert.equal(await prisma.employees.count({ where: { user_id: user.id } }), 0);

      const login = await loginTestUser(app, body.email, PASSWORD);
      assert.equal(login.status, 200, JSON.stringify(login.body));
      assertNoSecrets(login.body);

      const profile = await request(app).get("/api/v1/customer/me/profile").set(auth(login.accessToken as string));
      assert.equal(profile.status, 200, JSON.stringify(profile.body));
      assert.equal(profile.body.data.customerNumber, row.customer_number);
    });

    test("portal user has exactly the CUSTOMER role permissions", async () => {
      const body = payload();
      const res = await createCustomer({ ...body, portalPassword: PASSWORD });
      assert.equal(res.status, 201);
      const login = await loginTestUser(app, body.email, PASSWORD);
      const me = await request(app).get("/api/v1/auth/me").set(auth(login.accessToken as string));
      const reference = await request(app).get("/api/v1/auth/me").set(auth(tokens.customer));
      assert.equal(me.status, 200);
      assert.equal(me.body.data.user.role.code, "CUSTOMER");
      assert.deepEqual([...me.body.data.permissions].sort(), [...reference.body.data.permissions].sort());

      // And no management access.
      const mgmt = await request(app).get("/api/v1/customers").set(auth(login.accessToken as string));
      assert.equal(mgmt.status, 403);
    });

    test("password without email -> 400 on email, nothing created", async () => {
      const name = `Portal NoEmail ${uniqueSuffix()}`;
      const res = await createCustomer({ name, primaryPhone: "+96170000098", portalPassword: PASSWORD });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
      assert.equal(await prisma.customers.count({ where: { name } }), 0);
    });

    test("short password -> 400, nothing created", async () => {
      const body = payload();
      const res = await createCustomer({ ...body, portalPassword: "short" });
      assert.equal(res.status, 400);
      assert.equal(await prisma.customers.count({ where: { name: body.name } }), 0);
      assert.equal(await portalUserCount(body.email), 0);
    });

    test("duplicate login email -> 409 and the customer is NOT created (whole create rolled back)", async () => {
      const name = `Portal Dup ${uniqueSuffix()}`;
      const res = await createCustomer({ name, primaryPhone: "+96170000097", email: driver.email, portalPassword: PASSWORD });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.error.code, "CONFLICT");
      assert.equal(res.body.error.message, "An account with this email already exists");
      assert.equal(await prisma.customers.count({ where: { name } }), 0);
      assert.equal(await portalUserCount(driver.email), 1, "only the pre-existing driver user");
    });

    test("normal create without a portal password still allows an email shared with another account", async () => {
      // The contact email only becomes a login when portal access is given.
      const res = await createCustomer(payload({ email: driver.email }));
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.hasPortalAccount, false);
    });
  });

  // ===========================================================
  // Existing customer
  // ===========================================================

  describe("Existing customer", () => {
    test("customer without account is given credentials later: exactly one linked CUSTOMER user, can log in", async () => {
      const body = payload();
      const created = await createCustomer(body);
      const id = created.body.data.id;

      const res = await patchCustomer(id, { portalPassword: PASSWORD });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.hasPortalAccount, true);
      assertNoSecrets(res.body);

      const row = await prisma.customers.findUniqueOrThrow({ where: { id } });
      assert.ok(row.portal_user_id);
      assert.equal(await portalUserCount(body.email), 1);
      const user = await prisma.users.findUniqueOrThrow({ where: { id: row.portal_user_id }, include: { roles: true } });
      assert.equal(user.roles.code, "CUSTOMER");

      const login = await loginTestUser(app, body.email, PASSWORD);
      assert.equal(login.status, 200);
      const profile = await request(app).get("/api/v1/customer/me/profile").set(auth(login.accessToken as string));
      assert.equal(profile.body.data.customerNumber, row.customer_number);

      // The grant is audited without the password.
      const auditRows = await prisma.audit_logs.findMany({ where: { entity_type: "CUSTOMER", entity_id: id } });
      assert.ok(auditRows.some((a) => (a.new_values as Record<string, unknown> | null)?.portalAccess === "GRANTED"));
      assertNoSecrets(auditRows);
    });

    test("later edits never create a second user; blank password keeps the current one; profile stays in sync", async () => {
      const body = payload();
      const created = await createCustomer({ ...body, portalPassword: PASSWORD });
      const id = created.body.data.id;
      const before = await prisma.customers.findUniqueOrThrow({ where: { id } });
      const userBefore = await prisma.users.findUniqueOrThrow({ where: { id: before.portal_user_id as string } });

      const newEmail = uniqueEmailAddress();
      const res = await patchCustomer(id, {
        name: "Updated Portal Name",
        notes: "edited",
        email: newEmail,
        primaryPhone: "+96170000055",
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const after = await prisma.customers.findUniqueOrThrow({ where: { id } });
      assert.equal(after.portal_user_id, before.portal_user_id, "same linked user");
      assert.equal(await prisma.users.count({ where: { email: { in: [body.email, newEmail] } } }), 1);
      const userAfter = await prisma.users.findUniqueOrThrow({ where: { id: before.portal_user_id as string } });
      assert.equal(userAfter.password_hash, userBefore.password_hash, "password unchanged");
      assert.equal(userAfter.email, newEmail);
      assert.equal(userAfter.first_name, "Updated");
      assert.equal(userAfter.last_name, "Portal Name");
      assert.equal(userAfter.phone, "+96170000055");

      // The login moved with the email; the old email no longer works.
      assert.equal((await loginTestUser(app, newEmail, PASSWORD)).status, 200);
      assert.equal((await loginTestUser(app, body.email, PASSWORD)).status, 401);
    });

    test("explicit new password: new password works, old does not, existing portal sessions are revoked", async () => {
      const body = payload();
      const created = await createCustomer({ ...body, portalPassword: PASSWORD });
      const id = created.body.data.id;
      const oldLogin = await loginTestUser(app, body.email, PASSWORD);
      assert.equal(oldLogin.status, 200);
      assert.ok(oldLogin.refreshCookie);

      const res = await patchCustomer(id, { portalPassword: NEW_PASSWORD });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assertNoSecrets(res.body);

      const row = await prisma.customers.findUniqueOrThrow({ where: { id } });
      assert.equal(await portalUserCount(body.email), 1, "no duplicate account");
      assert.ok(row.portal_user_id);

      assert.equal((await loginTestUser(app, body.email, PASSWORD)).status, 401);
      assert.equal((await loginTestUser(app, body.email, NEW_PASSWORD)).status, 200);

      const refresh = await request(app)
        .post("/api/v1/auth/refresh")
        .set("Cookie", `refresh_token=${oldLogin.refreshCookie}`);
      assert.equal(refresh.status, 401, "old session must not be refreshable after a reset");

      const auditRows = await prisma.audit_logs.findMany({ where: { entity_type: "CUSTOMER", entity_id: id } });
      assert.ok(auditRows.some((a) => (a.new_values as Record<string, unknown> | null)?.portalAccess === "PASSWORD_RESET"));
      assertNoSecrets(auditRows);
    });

    test("grant later without an email -> 400; nothing created", async () => {
      const created = await createCustomer({ name: `Portal NoMail ${uniqueSuffix()}`, primaryPhone: "+96170000096" });
      const id = created.body.data.id;
      const res = await patchCustomer(id, { portalPassword: PASSWORD });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      const row = await prisma.customers.findUniqueOrThrow({ where: { id } });
      assert.equal(row.portal_user_id, null);
    });

    test("grant later with a taken email -> 409; customer left intact, no user created", async () => {
      const created = await createCustomer(payload({ email: finance.email }));
      const id = created.body.data.id;
      const before = await prisma.customers.findUniqueOrThrow({ where: { id } });
      const res = await patchCustomer(id, { portalPassword: PASSWORD, notes: "should roll back" });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.error.message, "An account with this email already exists");
      const after = await prisma.customers.findUniqueOrThrow({ where: { id } });
      assert.deepEqual(after, before, "customer unchanged");
      assert.equal(await portalUserCount(finance.email), 1);
    });

    test("changing the login email to one already taken -> 409, nothing changed", async () => {
      const body = payload();
      const created = await createCustomer({ ...body, portalPassword: PASSWORD });
      const id = created.body.data.id;
      const res = await patchCustomer(id, { email: dispatcher.email });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      const row = await prisma.customers.findUniqueOrThrow({ where: { id } });
      assert.equal(row.email, body.email);
      assert.equal((await loginTestUser(app, body.email, PASSWORD)).status, 200);
    });

    test("email cannot be cleared while a portal account exists -> 400", async () => {
      const body = payload();
      const created = await createCustomer({ ...body, portalPassword: PASSWORD });
      const res = await patchCustomer(created.body.data.id, { email: null });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal((await loginTestUser(app, body.email, PASSWORD)).status, 200);
    });

    test("inactive customer cannot be given portal access (409); reactivated customer can", async () => {
      const body = payload();
      const created = await createCustomer(body);
      const id = created.body.data.id;
      assert.equal((await patchCustomer(id, { isActive: false })).status, 200);

      const blocked = await patchCustomer(id, { portalPassword: PASSWORD });
      assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
      assert.equal((await prisma.customers.findUniqueOrThrow({ where: { id } })).portal_user_id, null);
      assert.equal(await portalUserCount(body.email), 0);

      const deactivateAndGrant = await patchCustomer(id, { isActive: true, portalPassword: PASSWORD });
      assert.equal(deactivateAndGrant.status, 200, JSON.stringify(deactivateAndGrant.body));
      assert.equal(deactivateAndGrant.body.data.hasPortalAccount, true);
    });

    test("deactivating a customer keeps users.is_active unchanged (Driver convention)", async () => {
      const body = payload();
      const created = await createCustomer({ ...body, portalPassword: PASSWORD });
      const id = created.body.data.id;
      const res = await patchCustomer(id, { isActive: false });
      assert.equal(res.status, 200);
      const row = await prisma.customers.findUniqueOrThrow({ where: { id } });
      const user = await prisma.users.findUniqueOrThrow({ where: { id: row.portal_user_id as string } });
      assert.equal(user.is_active, true);
    });

    test("two concurrent grants: exactly one succeeds, exactly one user", async () => {
      const body = payload();
      const created = await createCustomer(body);
      const id = created.body.data.id;
      const [r1, r2] = await Promise.all([
        request(app).patch(`/api/v1/customers/${id}`).set(auth(tokens.admin)).send({ portalPassword: PASSWORD }),
        request(app).patch(`/api/v1/customers/${id}`).set(auth(tokens.dispatcher)).send({ portalPassword: NEW_PASSWORD }),
      ]);
      const row = await prisma.customers.findUniqueOrThrow({ where: { id } });
      if (row.portal_user_id && !createdUserIds.includes(row.portal_user_id)) createdUserIds.push(row.portal_user_id);
      const statuses = [r1.status, r2.status].sort();
      // Either the second request lost the link race (409), or it ran after the
      // first committed and became a password reset (200). Never two accounts.
      assert.ok(statuses[0] === 200 && [200, 409].includes(statuses[1]), JSON.stringify({ r1: r1.body, r2: r2.body }));
      assert.equal(await portalUserCount(body.email), 1);
    });

    test("normal edit of a customer without portal access is unchanged", async () => {
      const created = await createCustomer(payload());
      const id = created.body.data.id;
      const res = await patchCustomer(id, { name: "Plain Edit", notes: "x", email: null });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.hasPortalAccount, false);
      assert.equal(res.body.data.email, null);
      assert.equal((await prisma.customers.findUniqueOrThrow({ where: { id } })).portal_user_id, null);
    });
  });

  // ===========================================================
  // Security / authorization
  // ===========================================================

  describe("Security", () => {
    test("customer list / detail responses never contain password data", async () => {
      const created = await createCustomer({ ...payload(), portalPassword: PASSWORD });
      const detail = await request(app).get(`/api/v1/customers/${created.body.data.id}`).set(auth(tokens.admin));
      assert.equal(detail.status, 200);
      assertNoSecrets(detail.body);
      const list = await request(app).get("/api/v1/customers").query({ hasPortalAccount: "true" }).set(auth(tokens.admin));
      assert.equal(list.status, 200);
      assertNoSecrets(list.body);
    });

    test("FINANCE / DRIVER / CUSTOMER cannot create credentials or reset passwords (403)", async () => {
      const target = await createCustomer(payload());
      const id = target.body.data.id;
      for (const role of ["finance", "driver", "customer"] as const) {
        const create = await request(app)
          .post("/api/v1/customers")
          .set(auth(tokens[role]))
          .send({ ...payload(), portalPassword: PASSWORD });
        assert.equal(create.status, 403, `${role} create`);
        const grant = await request(app).patch(`/api/v1/customers/${id}`).set(auth(tokens[role])).send({ portalPassword: PASSWORD });
        assert.equal(grant.status, 403, `${role} grant`);
      }
      assert.equal((await prisma.customers.findUniqueOrThrow({ where: { id } })).portal_user_id, null);
    });

    test("DISPATCHER (customers.create / customers.update) can manage credentials like Driver accounts", async () => {
      const body = payload();
      const res = await createCustomer({ ...body, portalPassword: PASSWORD }, tokens.dispatcher);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const reset = await patchCustomer(res.body.data.id, { portalPassword: NEW_PASSWORD }, tokens.dispatcher);
      assert.equal(reset.status, 200);
    });

    test("role cannot be smuggled in: extra role fields are ignored, account is CUSTOMER", async () => {
      const body = payload();
      const adminRole = await prisma.roles.findUniqueOrThrow({ where: { code: "ADMIN" } });
      const res = await createCustomer({ ...body, portalPassword: PASSWORD, roleId: adminRole.id, roleCode: "ADMIN" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const row = await prisma.customers.findUniqueOrThrow({ where: { id: res.body.data.id } });
      const user = await prisma.users.findUniqueOrThrow({ where: { id: row.portal_user_id as string }, include: { roles: true } });
      assert.equal(user.roles.code, "CUSTOMER");
    });

    test("portal customer sees only their own orders", async () => {
      const a = payload();
      const b = payload();
      const resA = await createCustomer({ ...a, portalPassword: PASSWORD });
      const resB = await createCustomer({ ...b, portalPassword: PASSWORD });
      const orderA = await seedTestOrder(resA.body.data.id, admin.id, { areaId: area.id, areaName: area.name });
      const orderB = await seedTestOrder(resB.body.data.id, admin.id, { areaId: area.id, areaName: area.name });
      createdOrderIds.push(orderA, orderB);

      const loginA = await loginTestUser(app, a.email, PASSWORD);
      const tokenA = loginA.accessToken as string;

      const list = await request(app).get("/api/v1/customer/me/orders").set(auth(tokenA));
      assert.equal(list.status, 200, JSON.stringify(list.body));
      const ids = (list.body.data as Array<{ id: string }>).map((o) => o.id);
      assert.ok(ids.includes(orderA));
      assert.ok(!ids.includes(orderB));

      const other = await request(app).get(`/api/v1/customer/me/orders/${orderB}`).set(auth(tokenA));
      assert.equal(other.status, 404);
      const own = await request(app).get(`/api/v1/customer/me/orders/${orderA}`).set(auth(tokenA));
      assert.equal(own.status, 200);

      const wallet = await request(app).get("/api/v1/customer/me/wallet").set(auth(tokenA));
      assert.equal(wallet.status, 200, JSON.stringify(wallet.body));
    });
  });
});
