import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { cleanupTestUser, createTestUser, loginTestUser, uniqueSuffix, type TestUser } from "../helpers/fixtures";

describe("Employee Management backend (Phase 11.14)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driver: TestUser;
  let tokens: Record<string, string>;

  const createdEmployeeIds: string[] = [];
  const createdUserIds: string[] = [];

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    finance = await createTestUser("FINANCE");
    driver = await createTestUser("DRIVER");
    // The acting admin needs an employees row too (it is created via createTestUser
    // as a plain user; that's fine — authorization is role-based, not employee-based).

    const [a, d, f, dr] = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, dispatcher.email, dispatcher.password),
      loginTestUser(app, finance.email, finance.password),
      loginTestUser(app, driver.email, driver.password),
    ]);
    tokens = {
      admin: a.accessToken as string,
      dispatcher: d.accessToken as string,
      finance: f.accessToken as string,
      driver: dr.accessToken as string,
    };
    for (const [k, v] of Object.entries(tokens)) assert.ok(v, `token for ${k}`);
  });

  after(async () => {
    for (const id of createdEmployeeIds) {
      await prisma.audit_logs.deleteMany({ where: { entity_type: "EMPLOYEE", entity_id: id } });
      await prisma.employees.deleteMany({ where: { id } });
    }
    for (const id of createdUserIds) {
      await prisma.auth_sessions.deleteMany({ where: { user_id: id } });
      await prisma.employees.deleteMany({ where: { user_id: id } });
      await prisma.audit_logs.deleteMany({ where: { actor_user_id: id } });
      await prisma.users.deleteMany({ where: { id } });
    }
    await Promise.all([admin, dispatcher, finance, driver].map((u) => cleanupTestUser(u.id)));
  });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  function newEmployeePayload(overrides: Record<string, unknown> = {}) {
    const s = uniqueSuffix();
    return {
      employeeNumber: `PH1114-${s}`,
      // roleId filled per-test
      user: {
        email: `ph1114.${s}@example.test`,
        password: "EmployeePass123!",
        firstName: "Phase1114",
        lastName: "Employee",
        phone: "+15550001114",
      },
      ...overrides,
    };
  }

  async function roleId(code: string): Promise<string> {
    const r = await prisma.roles.findUniqueOrThrow({ where: { code } });
    return r.id;
  }

  async function trackCreated(res: request.Response): Promise<string> {
    const id = res.body?.data?.id as string;
    const userId = res.body?.data?.userId as string;
    if (id) createdEmployeeIds.push(id);
    if (userId) createdUserIds.push(userId);
    return id;
  }

  /* ============================ authorization ============================ */

  test("1. no auth -> 401 on every endpoint", async () => {
    assert.equal((await request(app).get("/api/v1/employees")).status, 401);
    assert.equal((await request(app).get("/api/v1/employees/roles")).status, 401);
    assert.equal((await request(app).post("/api/v1/employees").send({})).status, 401);
  });

  test("2. DISPATCHER / FINANCE / DRIVER -> 403 on read + manage", async () => {
    for (const who of ["dispatcher", "finance", "driver"] as const) {
      assert.equal((await request(app).get("/api/v1/employees").set(auth(tokens[who]))).status, 403, `${who} GET list`);
      assert.equal((await request(app).get("/api/v1/employees/roles").set(auth(tokens[who]))).status, 403, `${who} GET roles`);
      assert.equal(
        (await request(app).post("/api/v1/employees").set(auth(tokens[who])).send(newEmployeePayload())).status,
        403,
        `${who} POST`
      );
      assert.equal(
        (await request(app).patch(`/api/v1/employees/${crypto.randomUUID()}`).set(auth(tokens[who])).send({ firstName: "x" }))
          .status,
        403,
        `${who} PATCH`
      );
    }
  });

  test("3. ADMIN can read", async () => {
    const res = await request(app).get("/api/v1/employees").set(auth(tokens.admin));
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.meta && typeof res.body.meta.total === "number");
  });

  /* ============================ roles ============================ */

  test("4. GET /employees/roles returns the three management roles with inherited permissions", async () => {
    const res = await request(app).get("/api/v1/employees/roles").set(auth(tokens.admin));
    assert.equal(res.status, 200);
    const codes = res.body.data.map((r: { code: string }) => r.code);
    assert.deepEqual(codes, ["ADMIN", "DISPATCHER", "FINANCE"]);
    for (const role of res.body.data) {
      assert.ok(Array.isArray(role.permissions), `${role.code} permissions[]`);
      assert.equal(role.permissionCount, role.permissions.length, `${role.code} count matches`);
      assert.ok(role.permissions.every((p: { code: string }) => typeof p.code === "string"));
    }
    const adminRole = res.body.data.find((r: { code: string }) => r.code === "ADMIN");
    const dispatcherRole = res.body.data.find((r: { code: string }) => r.code === "DISPATCHER");
    assert.ok(adminRole.permissionCount > dispatcherRole.permissionCount, "ADMIN has more permissions than DISPATCHER");
    // roles response must never leak permission-assignment internals
    const raw = JSON.stringify(res.body).toLowerCase();
    assert.ok(raw.indexOf("role_permissions") === -1 && raw.indexOf("permission_id") === -1, "no join-table internals");
  });

  test("5. role preview matches /auth/me for that role", async () => {
    const roles = (await request(app).get("/api/v1/employees/roles").set(auth(tokens.admin))).body.data;
    const dispatcherRole = roles.find((r: { code: string }) => r.code === "DISPATCHER");
    const me = (await request(app).get("/api/v1/auth/me").set(auth(tokens.dispatcher))).body.data;
    const previewCodes = dispatcherRole.permissions.map((p: { code: string }) => p.code).sort();
    assert.deepEqual(previewCodes, [...me.permissions].sort(), "DISPATCHER role preview == /auth/me permissions");
  });

  /* ============================ create ============================ */

  test("6. ADMIN creates a DISPATCHER employee — atomic, safe, audited, loginable", async () => {
    const payload = newEmployeePayload({ roleId: await roleId("DISPATCHER") });
    const res = await request(app).post("/api/v1/employees").set(auth(tokens.admin)).send(payload);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const empId = await trackCreated(res);

    const body = res.body.data;
    assert.equal(body.employeeNumber, payload.employeeNumber);
    assert.equal(body.email, payload.user.email);
    assert.equal(body.role.code, "DISPATCHER");
    assert.equal(body.isActive, true);
    assert.equal(body.lastLoginAt, null);
    assert.ok(body.role.permissions.length > 0);

    // privacy
    const raw = JSON.stringify(res.body).toLowerCase();
    assert.ok(raw.indexOf("password") === -1, "no 'password' anywhere in the response");
    assert.ok(raw.indexOf("hash") === -1, "no 'hash' anywhere in the response");
    assert.ok(raw.indexOf("token") === -1, "no 'token' anywhere in the response");

    // User + Employee both exist and are linked
    const user = await prisma.users.findUniqueOrThrow({ where: { id: body.userId }, include: { roles: true, employees: true } });
    assert.equal(user.roles.code, "DISPATCHER");
    assert.ok(user.employees, "linked employees row exists");
    assert.equal(user.employees?.id, empId);

    // login works with the given password
    const login = await request(app).post("/api/v1/auth/login").send({ email: payload.user.email, password: payload.user.password });
    assert.equal(login.status, 200, "new employee can log in");
    assert.equal(login.body.data.user.role.code, "DISPATCHER");

    // audit
    const audit = await prisma.audit_logs.findFirst({
      where: { entity_type: "EMPLOYEE", entity_id: empId, action: "EMPLOYEE_CREATED" },
    });
    assert.ok(audit, "EMPLOYEE_CREATED audit row exists");
    assert.ok(JSON.stringify(audit).toLowerCase().indexOf("password") === -1, "audit has no password");
  });

  test("7. create with a non-management role (DRIVER) -> 400, nothing created", async () => {
    const payload = newEmployeePayload({ roleId: await roleId("DRIVER") });
    const res = await request(app).post("/api/v1/employees").set(auth(tokens.admin)).send(payload);
    assert.equal(res.status, 400);
    // the transaction rolled back — neither the user nor the employee exists
    assert.equal(await prisma.users.findUnique({ where: { email: payload.user.email } }), null, "no user created");
    assert.equal(await prisma.employees.findUnique({ where: { employee_number: payload.employeeNumber } }), null, "no employee created");
  });

  test("8. create with an unknown role id -> 400", async () => {
    const res = await request(app)
      .post("/api/v1/employees")
      .set(auth(tokens.admin))
      .send(newEmployeePayload({ roleId: crypto.randomUUID() }));
    assert.equal(res.status, 400);
  });

  test("9. duplicate email -> 409; duplicate employee number -> 409", async () => {
    const dispatcherRole = await roleId("DISPATCHER");
    const first = newEmployeePayload({ roleId: dispatcherRole });
    const r1 = await request(app).post("/api/v1/employees").set(auth(tokens.admin)).send(first);
    assert.equal(r1.status, 201);
    await trackCreated(r1);

    const dupEmail = newEmployeePayload({ roleId: dispatcherRole });
    dupEmail.user.email = first.user.email;
    assert.equal((await request(app).post("/api/v1/employees").set(auth(tokens.admin)).send(dupEmail)).status, 409);

    const dupNumber = newEmployeePayload({ roleId: dispatcherRole });
    dupNumber.employeeNumber = first.employeeNumber;
    assert.equal((await request(app).post("/api/v1/employees").set(auth(tokens.admin)).send(dupNumber)).status, 409);
  });

  test("10. strict create schema — extra field / short password -> 400", async () => {
    const dispatcherRole = await roleId("DISPATCHER");
    const extra = { ...newEmployeePayload({ roleId: dispatcherRole }), permissions: ["orders.read"] };
    assert.equal((await request(app).post("/api/v1/employees").set(auth(tokens.admin)).send(extra)).status, 400);

    const shortPw = newEmployeePayload({ roleId: dispatcherRole });
    shortPw.user.password = "short";
    assert.equal((await request(app).post("/api/v1/employees").set(auth(tokens.admin)).send(shortPw)).status, 400);
  });

  /* ============================ detail + list ============================ */

  test("11. GET /:id returns inherited permissions; unknown -> 404", async () => {
    const created = await request(app)
      .post("/api/v1/employees")
      .set(auth(tokens.admin))
      .send(newEmployeePayload({ roleId: await roleId("FINANCE") }));
    const id = await trackCreated(created);

    const detail = await request(app).get(`/api/v1/employees/${id}`).set(auth(tokens.admin));
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.role.code, "FINANCE");
    assert.ok(detail.body.data.role.permissions.some((p: { code: string }) => p.code === "finance.read"));

    assert.equal((await request(app).get(`/api/v1/employees/${crypto.randomUUID()}`).set(auth(tokens.admin))).status, 404);
  });

  test("12. list search / roleId / isActive / pagination", async () => {
    const unique = `SEARCHME-${uniqueSuffix()}`;
    const r = await request(app)
      .post("/api/v1/employees")
      .set(auth(tokens.admin))
      .send(newEmployeePayload({ roleId: await roleId("DISPATCHER"), employeeNumber: unique }));
    await trackCreated(r);

    const byNumber = await request(app).get(`/api/v1/employees?search=${unique}`).set(auth(tokens.admin));
    assert.equal(byNumber.body.data.length, 1);
    assert.equal(byNumber.body.data[0].employeeNumber, unique);

    const dispatcherRole = await roleId("DISPATCHER");
    const byRole = await request(app).get(`/api/v1/employees?roleId=${dispatcherRole}&limit=1`).set(auth(tokens.admin));
    assert.ok(byRole.body.data.every((e: { role: { id: string } }) => e.role.id === dispatcherRole));
    assert.ok(byRole.body.meta.totalPages >= 1);

    const active = await request(app).get(`/api/v1/employees?isActive=true&limit=100`).set(auth(tokens.admin));
    assert.ok(active.body.data.every((e: { isActive: boolean }) => e.isActive === true));
  });

  /* ============================ update ============================ */

  test("13. edit profile -> EMPLOYEE_UPDATED, IDs unchanged", async () => {
    const created = await request(app)
      .post("/api/v1/employees")
      .set(auth(tokens.admin))
      .send(newEmployeePayload({ roleId: await roleId("DISPATCHER") }));
    const id = await trackCreated(created);
    const userId = created.body.data.userId;

    const res = await request(app)
      .patch(`/api/v1/employees/${id}`)
      .set(auth(tokens.admin))
      .send({ firstName: "Renamed", phone: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.id, id);
    assert.equal(res.body.data.userId, userId);
    assert.equal(res.body.data.firstName, "Renamed");
    assert.equal(res.body.data.phone, null);

    const audit = await prisma.audit_logs.findFirst({
      where: { entity_type: "EMPLOYEE", entity_id: id, action: "EMPLOYEE_UPDATED" },
      orderBy: { created_at: "desc" },
    });
    assert.ok(audit, "EMPLOYEE_UPDATED audit row");
  });

  test("14. strict update schema — password / employeeNumber in body -> 400", async () => {
    const created = await request(app)
      .post("/api/v1/employees")
      .set(auth(tokens.admin))
      .send(newEmployeePayload({ roleId: await roleId("DISPATCHER") }));
    const id = await trackCreated(created);
    assert.equal((await request(app).patch(`/api/v1/employees/${id}`).set(auth(tokens.admin)).send({ password: "NewPass123!" })).status, 400);
    assert.equal((await request(app).patch(`/api/v1/employees/${id}`).set(auth(tokens.admin)).send({ employeeNumber: "X" })).status, 400);
    assert.equal((await request(app).patch(`/api/v1/employees/${id}`).set(auth(tokens.admin)).send({})).status, 400);
  });

  test("15. role change DISPATCHER -> FINANCE: same IDs, effective permissions follow the new role", async () => {
    const payload = newEmployeePayload({ roleId: await roleId("DISPATCHER") });
    const created = await request(app).post("/api/v1/employees").set(auth(tokens.admin)).send(payload);
    const id = await trackCreated(created);
    const userId = created.body.data.userId;

    const res = await request(app)
      .patch(`/api/v1/employees/${id}`)
      .set(auth(tokens.admin))
      .send({ roleId: await roleId("FINANCE") });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.id, id, "same employee id");
    assert.equal(res.body.data.userId, userId, "same user id");
    assert.equal(res.body.data.employeeNumber, payload.employeeNumber, "same employee number");
    assert.equal(res.body.data.role.code, "FINANCE");

    // the employee's own next request sees the new permission set
    const login = await request(app).post("/api/v1/auth/login").send({ email: payload.user.email, password: payload.user.password });
    assert.deepEqual(
      [...login.body.data.permissions].sort(),
      [...res.body.data.role.permissions.map((p: { code: string }) => p.code)].sort(),
      "login permissions == new FINANCE role permissions"
    );

    const audit = await prisma.audit_logs.findFirst({
      where: { entity_type: "EMPLOYEE", entity_id: id },
      orderBy: { created_at: "desc" },
    });
    assert.ok(audit, "role change audited");
    const nv = audit?.new_values as Record<string, unknown> | null;
    assert.equal(nv?.role, "FINANCE", "audit new role");
  });

  test("16. role change takes effect on the very next request (no stale token authz)", async () => {
    const payload = newEmployeePayload({ roleId: await roleId("FINANCE") });
    const created = await request(app).post("/api/v1/employees").set(auth(tokens.admin)).send(payload);
    const id = await trackCreated(created);

    const login = await request(app).post("/api/v1/auth/login").send({ email: payload.user.email, password: payload.user.password });
    const empToken = login.body.data.accessToken as string;
    // FINANCE has finance.read -> /finance/summary 200
    assert.equal((await request(app).get("/api/v1/finance/summary").set(auth(empToken))).status, 200);

    // demote to DISPATCHER (no finance.read)
    await request(app).patch(`/api/v1/employees/${id}`).set(auth(tokens.admin)).send({ roleId: await roleId("DISPATCHER") });

    // SAME (old) access token — must now be forbidden
    assert.equal((await request(app).get("/api/v1/finance/summary").set(auth(empToken))).status, 403, "old token loses finance.read immediately");
  });

  test("17. deactivate -> login fails with the generic message; reactivate -> login works; IDs stable", async () => {
    const payload = newEmployeePayload({ roleId: await roleId("DISPATCHER") });
    const created = await request(app).post("/api/v1/employees").set(auth(tokens.admin)).send(payload);
    const id = await trackCreated(created);

    const deact = await request(app).patch(`/api/v1/employees/${id}`).set(auth(tokens.admin)).send({ isActive: false });
    assert.equal(deact.status, 200);
    assert.equal(deact.body.data.isActive, false);

    const badLogin = await request(app).post("/api/v1/auth/login").send({ email: payload.user.email, password: payload.user.password });
    assert.equal(badLogin.status, 401);
    assert.match(String(badLogin.body?.error?.message ?? ""), /invalid email or password/i);

    const react = await request(app).patch(`/api/v1/employees/${id}`).set(auth(tokens.admin)).send({ isActive: true });
    assert.equal(react.status, 200);
    assert.equal(react.body.data.id, id);
    const goodLogin = await request(app).post("/api/v1/auth/login").send({ email: payload.user.email, password: payload.user.password });
    assert.equal(goodLogin.status, 200);

    const deactAudit = await prisma.audit_logs.findFirst({ where: { entity_type: "EMPLOYEE", entity_id: id, action: "EMPLOYEE_DEACTIVATED" } });
    const reactAudit = await prisma.audit_logs.findFirst({ where: { entity_type: "EMPLOYEE", entity_id: id, action: "EMPLOYEE_REACTIVATED" } });
    assert.ok(deactAudit && reactAudit, "deactivate + reactivate audited");
  });

  test("18. an admin cannot deactivate their OWN account", async () => {
    // create a fresh admin employee, log in as them, have them try to self-deactivate
    const payload = newEmployeePayload({ roleId: await roleId("ADMIN") });
    const created = await request(app).post("/api/v1/employees").set(auth(tokens.admin)).send(payload);
    const id = await trackCreated(created);
    const selfLogin = await request(app).post("/api/v1/auth/login").send({ email: payload.user.email, password: payload.user.password });
    const selfToken = selfLogin.body.data.accessToken as string;

    const res = await request(app).patch(`/api/v1/employees/${id}`).set(auth(selfToken)).send({ isActive: false });
    assert.equal(res.status, 400);
    assert.match(String(res.body?.error?.message ?? ""), /your own account/i);
  });

  // NOTE: the LAST-ACTIVE-ADMIN invariant is verified by a dedicated
  // single-process live smoke (scratchpad/employee-last-admin-smoke.mjs),
  // NOT here — asserting it requires temporarily deactivating every OTHER
  // active ADMIN in the shared DB, which would race with the other test
  // suites node:test runs in parallel. The invariant itself lives in
  // employee.service.ts:updateEmployee (Serializable transaction).

  test("19. self role-change to a still-valid admin scenario is allowed (guard is specific)", async () => {
    // With the seed/other admins present, a normal admin -> admin no-op-ish
    // role set and a demotion of a NON-last admin both succeed.
    const created = await request(app)
      .post("/api/v1/employees")
      .set(auth(tokens.admin))
      .send(newEmployeePayload({ roleId: await roleId("ADMIN") }));
    const id = await trackCreated(created);
    const res = await request(app)
      .patch(`/api/v1/employees/${id}`)
      .set(auth(tokens.admin))
      .send({ roleId: await roleId("DISPATCHER") });
    assert.equal(res.status, 200, "demoting a non-last admin is allowed");
    assert.equal(res.body.data.role.code, "DISPATCHER");
  });

  test("20. update with a non-management role -> 400", async () => {
    const created = await request(app)
      .post("/api/v1/employees")
      .set(auth(tokens.admin))
      .send(newEmployeePayload({ roleId: await roleId("DISPATCHER") }));
    const id = await trackCreated(created);
    assert.equal((await request(app).patch(`/api/v1/employees/${id}`).set(auth(tokens.admin)).send({ roleId: await roleId("CUSTOMER") })).status, 400);
  });
});
