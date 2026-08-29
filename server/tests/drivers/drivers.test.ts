import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { getDriverProfileForUser } from "../../src/modules/auth/ownership.service";
import {
  cleanupTestDriverRecord,
  cleanupTestUser,
  createTestUser,
  loginTestUser,
  seedDriverRecord,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

describe("Drivers backend (Phase 5.2)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driverActor: TestUser;
  let tokens: Record<string, string>;
  const createdDriverIds: string[] = [];
  const createdUserIds: string[] = [];

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    finance = await createTestUser("FINANCE");
    driverActor = await createTestUser("DRIVER");

    const [adminLogin, dispatcherLogin, financeLogin, driverLogin] = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, dispatcher.email, dispatcher.password),
      loginTestUser(app, finance.email, finance.password),
      loginTestUser(app, driverActor.email, driverActor.password),
    ]);

    tokens = {
      admin: adminLogin.accessToken as string,
      dispatcher: dispatcherLogin.accessToken as string,
      finance: financeLogin.accessToken as string,
      driver: driverLogin.accessToken as string,
    };
    for (const [role, token] of Object.entries(tokens)) {
      assert.ok(token, `expected an access token for ${role}`);
    }
  });

  after(async () => {
    for (const id of createdDriverIds) {
      await cleanupTestDriverRecord(id);
    }
    for (const id of createdUserIds) {
      await cleanupTestUser(id);
    }
    await Promise.all([admin, dispatcher, finance, driverActor].map((u) => cleanupTestUser(u.id)));
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  // Creates a fresh DRIVER-role user (no driver profile yet) to link in a
  // create-driver request. Tracked for cleanup.
  async function newLinkableDriverUser(): Promise<TestUser> {
    const user = await createTestUser("DRIVER");
    createdUserIds.push(user.id);
    return user;
  }

  function newDriverPayload(userId: string, overrides: Record<string, unknown> = {}) {
    return {
      driverNumber: `PH52-API-${uniqueSuffix()}`,
      userId,
      ...overrides,
    };
  }

  async function createDriverViaApi(token: string, payload: Record<string, unknown>) {
    const res = await request(app).post("/api/v1/drivers").set(auth(token)).send(payload);
    if (res.status === 201) {
      createdDriverIds.push(res.body.data.id);
    }
    return res;
  }

  // ===== AUTHORIZATION =====

  describe("Authorization", () => {
    test("no auth -> 401 on list", async () => {
      const res = await request(app).get("/api/v1/drivers");
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, "UNAUTHORIZED");
    });

    test("no auth -> 401 on create", async () => {
      const linkable = await newLinkableDriverUser();
      const res = await request(app).post("/api/v1/drivers").send(newDriverPayload(linkable.id));
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, "UNAUTHORIZED");
    });

    test("DRIVER (lacks drivers.read) -> 403 on list and detail", async () => {
      const linkable = await newLinkableDriverUser();
      const created = await createDriverViaApi(tokens.admin, newDriverPayload(linkable.id));
      assert.equal(created.status, 201);

      const list = await request(app).get("/api/v1/drivers").set(auth(tokens.driver));
      assert.equal(list.status, 403);
      assert.equal(list.body.error.code, "FORBIDDEN");

      const detail = await request(app).get(`/api/v1/drivers/${created.body.data.id}`).set(auth(tokens.driver));
      assert.equal(detail.status, 403);
    });

    test("ADMIN with drivers.read -> list/detail allowed", async () => {
      const linkable = await newLinkableDriverUser();
      const created = await createDriverViaApi(tokens.admin, newDriverPayload(linkable.id));
      assert.equal(created.status, 201);

      const list = await request(app).get("/api/v1/drivers").set(auth(tokens.admin));
      assert.equal(list.status, 200);

      const detail = await request(app).get(`/api/v1/drivers/${created.body.data.id}`).set(auth(tokens.admin));
      assert.equal(detail.status, 200);
    });

    test("DISPATCHER with drivers.read -> list/detail allowed", async () => {
      const linkable = await newLinkableDriverUser();
      const created = await createDriverViaApi(tokens.admin, newDriverPayload(linkable.id));
      assert.equal(created.status, 201);

      const list = await request(app).get("/api/v1/drivers").set(auth(tokens.dispatcher));
      assert.equal(list.status, 200);

      const detail = await request(app).get(`/api/v1/drivers/${created.body.data.id}`).set(auth(tokens.dispatcher));
      assert.equal(detail.status, 200);
    });

    test("FINANCE with drivers.read -> list/detail allowed", async () => {
      const linkable = await newLinkableDriverUser();
      const created = await createDriverViaApi(tokens.admin, newDriverPayload(linkable.id));
      assert.equal(created.status, 201);

      const list = await request(app).get("/api/v1/drivers").set(auth(tokens.finance));
      assert.equal(list.status, 200);

      const detail = await request(app).get(`/api/v1/drivers/${created.body.data.id}`).set(auth(tokens.finance));
      assert.equal(detail.status, 200);
    });

    test("ADMIN with drivers.manage -> create/update allowed", async () => {
      const linkable = await newLinkableDriverUser();
      const created = await createDriverViaApi(tokens.admin, newDriverPayload(linkable.id));
      assert.equal(created.status, 201);

      const updated = await request(app)
        .patch(`/api/v1/drivers/${created.body.data.id}`)
        .set(auth(tokens.admin))
        .send({ isActive: false });
      assert.equal(updated.status, 200);
    });

    test("DISPATCHER without drivers.manage -> create/update forbidden", async () => {
      const linkable = await newLinkableDriverUser();
      const create = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.dispatcher))
        .send(newDriverPayload(linkable.id));
      assert.equal(create.status, 403);
      assert.equal(create.body.error.code, "FORBIDDEN");

      const seededUser = await newLinkableDriverUser();
      const seededDriverId = await seedDriverRecord(seededUser.id);
      createdDriverIds.push(seededDriverId);

      const update = await request(app)
        .patch(`/api/v1/drivers/${seededDriverId}`)
        .set(auth(tokens.dispatcher))
        .send({ isActive: false });
      assert.equal(update.status, 403);
    });

    test("FINANCE without drivers.manage -> create/update forbidden", async () => {
      const linkable = await newLinkableDriverUser();
      const create = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.finance))
        .send(newDriverPayload(linkable.id));
      assert.equal(create.status, 403);
      assert.equal(create.body.error.code, "FORBIDDEN");

      const seededUser = await newLinkableDriverUser();
      const seededDriverId = await seedDriverRecord(seededUser.id);
      createdDriverIds.push(seededDriverId);

      const update = await request(app)
        .patch(`/api/v1/drivers/${seededDriverId}`)
        .set(auth(tokens.finance))
        .send({ isActive: false });
      assert.equal(update.status, 403);
    });
  });

  // ===== CREATE =====

  describe("Create", () => {
    test("valid driver creation succeeds with linked user, zero-balance cash account", async () => {
      const linkable = await newLinkableDriverUser();
      const payload = newDriverPayload(linkable.id);
      const res = await createDriverViaApi(tokens.admin, payload);

      assert.equal(res.status, 201);
      assert.equal(res.body.data.driverNumber, payload.driverNumber);
      assert.equal(res.body.data.isActive, true);
      assert.equal(res.body.data.user.id, linkable.id);
      assert.equal(res.body.data.user.email, linkable.email);
      // Phase 11.7 correction: cash is NOT in the generic Driver DTO.
      assert.equal("cashAccount" in res.body.data, false);
      assert.deepEqual(Object.keys(res.body.data.operationalSummary).sort(), [
        "activeOrders",
        "completedToday",
        "outForDelivery",
      ]);
      const account = await prisma.driver_cash_accounts.findUniqueOrThrow({
        where: { driver_id: res.body.data.id },
      });
      assert.equal(account.current_balance.toString(), "0");
    });

    test("non-DRIVER-role user link rejected with 400", async () => {
      const nonDriverUser = await createTestUser("DISPATCHER");
      createdUserIds.push(nonDriverUser.id);

      const res = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.admin))
        .send(newDriverPayload(nonDriverUser.id));
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("nonexistent userId -> 400", async () => {
      const res = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.admin))
        .send(newDriverPayload("00000000-0000-0000-0000-000000000000"));
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("already-linked user -> controlled 409 CONFLICT", async () => {
      const linkable = await newLinkableDriverUser();
      const first = await createDriverViaApi(tokens.admin, newDriverPayload(linkable.id));
      assert.equal(first.status, 201);

      const second = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.admin))
        .send(newDriverPayload(linkable.id));
      assert.equal(second.status, 409);
      assert.equal(second.body.error.code, "CONFLICT");
    });

    test("duplicate driverNumber -> controlled 409 CONFLICT", async () => {
      const linkableA = await newLinkableDriverUser();
      const linkableB = await newLinkableDriverUser();
      const payload = newDriverPayload(linkableA.id);
      const first = await createDriverViaApi(tokens.admin, payload);
      assert.equal(first.status, 201);

      const second = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.admin))
        .send(newDriverPayload(linkableB.id, { driverNumber: payload.driverNumber }));
      assert.equal(second.status, 409);
      assert.equal(second.body.error.code, "CONFLICT");
      assert.doesNotMatch(JSON.stringify(second.body), /prisma/i);
    });

    test("validation failures -> 400", async () => {
      const linkable = await newLinkableDriverUser();

      const missingNumber = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.admin))
        .send({ userId: linkable.id });
      assert.equal(missingNumber.status, 400);
      assert.equal(missingNumber.body.error.code, "VALIDATION_ERROR");

      const badUserId = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.admin))
        .send(newDriverPayload("not-a-uuid"));
      assert.equal(badUserId.status, 400);

      const tooLongNumber = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.admin))
        .send(newDriverPayload(linkable.id, { driverNumber: "x".repeat(51) }));
      assert.equal(tooLongNumber.status, 400);
    });

    test("no password/auth secret fields accepted or returned", async () => {
      const linkable = await newLinkableDriverUser();
      const res = await createDriverViaApi(
        tokens.admin,
        newDriverPayload(linkable.id, { password: "hunter2", passwordHash: "x" })
      );
      assert.equal(res.status, 201);
      const serialized = JSON.stringify(res.body);
      assert.doesNotMatch(serialized, /password/i);
      assert.doesNotMatch(serialized, /token/i);
    });

    test("initial cash account is zero-balance with no ledger transaction", async () => {
      const linkable = await newLinkableDriverUser();
      const res = await createDriverViaApi(tokens.admin, newDriverPayload(linkable.id));
      assert.equal(res.status, 201);

      const account = await prisma.driver_cash_accounts.findUniqueOrThrow({
        where: { driver_id: res.body.data.id },
      });
      assert.equal(account.current_balance.toString(), "0");

      const txCount = await prisma.driver_cash_transactions.count({ where: { account_id: account.id } });
      assert.equal(txCount, 0, "a zero-balance cash account creation must not produce a ledger transaction");
    });

    test("ownership resolver works for a management-created linked driver", async () => {
      const linkable = await newLinkableDriverUser();
      const res = await createDriverViaApi(tokens.admin, newDriverPayload(linkable.id));
      assert.equal(res.status, 201);

      const profile = await getDriverProfileForUser(linkable.id);
      assert.equal(profile.id, res.body.data.id);
      assert.equal(profile.userId, linkable.id);
      assert.equal(profile.isActive, true);
    });
  });

  // ===== LIST / SEARCH / FILTER =====

  describe("List, search, filter, pagination", () => {
    let searchMarker: string;
    const seededDriverIds: string[] = [];

    before(async () => {
      searchMarker = `findme-${uniqueSuffix()}`;
      const base = new Date();

      const userA = await createTestUser("DRIVER");
      createdUserIds.push(userA.id);
      seededDriverIds.push(
        await seedDriverRecord(userA.id, {
          driverNumber: `PH52-LIST-A-${searchMarker}`,
          isActive: true,
          createdAt: new Date(base.getTime() - 3000),
        })
      );

      const userB = await createTestUser("DRIVER");
      createdUserIds.push(userB.id);
      seededDriverIds.push(
        await seedDriverRecord(userB.id, {
          driverNumber: `PH52-LIST-B-${uniqueSuffix()}`,
          isActive: false,
          createdAt: new Date(base.getTime() - 2000),
        })
      );

      const userC = await createTestUser("DRIVER");
      createdUserIds.push(userC.id);
      seededDriverIds.push(
        await seedDriverRecord(userC.id, {
          driverNumber: `PH52-LIST-C-${uniqueSuffix()}`,
          isActive: true,
          createdAt: new Date(base.getTime() - 1000),
        })
      );

      createdDriverIds.push(...seededDriverIds);
    });

    test("list is paginated with correct meta shape", async () => {
      const res = await request(app).get("/api/v1/drivers?page=1&limit=2").set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.data));
      assert.ok(res.body.data.length <= 2);
      assert.equal(res.body.meta.page, 1);
      assert.equal(res.body.meta.limit, 2);
      assert.ok(res.body.meta.total >= 3);
      assert.equal(res.body.meta.totalPages, Math.ceil(res.body.meta.total / 2));
    });

    test("page/limit validation rejects invalid values", async () => {
      const badPage = await request(app).get("/api/v1/drivers?page=0").set(auth(tokens.admin));
      assert.equal(badPage.status, 400);

      const badLimit = await request(app).get("/api/v1/drivers?limit=0").set(auth(tokens.admin));
      assert.equal(badLimit.status, 400);

      const nonNumeric = await request(app).get("/api/v1/drivers?page=abc").set(auth(tokens.admin));
      assert.equal(nonNumeric.status, 400);
    });

    test("maximum limit is enforced", async () => {
      const res = await request(app).get("/api/v1/drivers?limit=1000").set(auth(tokens.admin));
      assert.equal(res.status, 400);
    });

    test("search matches on driver_number", async () => {
      const res = await request(app)
        .get(`/api/v1/drivers?search=${encodeURIComponent(searchMarker)}`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 1);
      assert.match(res.body.data[0].driverNumber, new RegExp(searchMarker));
    });

    test("search matches on linked user's email", async () => {
      const userWithEmail = await createTestUser("DRIVER");
      createdUserIds.push(userWithEmail.id);
      const driverId = await seedDriverRecord(userWithEmail.id, { driverNumber: `PH52-EMAIL-${uniqueSuffix()}` });
      createdDriverIds.push(driverId);

      const emailMarker = userWithEmail.email.split("@")[0];
      const res = await request(app)
        .get(`/api/v1/drivers?search=${encodeURIComponent(emailMarker)}`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.some((d: { user: { email: string } }) => d.user.email === userWithEmail.email));
    });

    test("isActive filter works", async () => {
      const res = await request(app)
        .get(`/api/v1/drivers?search=PH52-LIST&isActive=false`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.length >= 1);
      assert.ok(res.body.data.every((d: { isActive: boolean }) => d.isActive === false));
    });

    test("default ordering is created_at DESC", async () => {
      const res = await request(app)
        .get(`/api/v1/drivers?search=${encodeURIComponent("PH52-LIST")}&limit=100`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      const timestamps = res.body.data.map((d: { createdAt: string }) => new Date(d.createdAt).getTime());
      const sorted = [...timestamps].sort((a, b) => b - a);
      assert.deepEqual(timestamps, sorted, "results must be ordered by created_at descending");
    });
  });

  // ===== DETAIL =====

  describe("Detail", () => {
    test("valid driver detail -> 200 with expected shape", async () => {
      const linkable = await newLinkableDriverUser();
      const created = await createDriverViaApi(tokens.admin, newDriverPayload(linkable.id));
      assert.equal(created.status, 201);

      const res = await request(app).get(`/api/v1/drivers/${created.body.data.id}`).set(auth(tokens.finance));
      assert.equal(res.status, 200);
      assert.equal(res.body.data.id, created.body.data.id);
      assert.equal("cashAccount" in res.body.data, false);
      assert.ok("operationalSummary" in res.body.data);
      assert.ok("user" in res.body.data);
    });

    test("nonexistent UUID -> 404", async () => {
      const res = await request(app)
        .get("/api/v1/drivers/00000000-0000-0000-0000-000000000000")
        .set(auth(tokens.admin));
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, "NOT_FOUND");
    });

    test("malformed UUID -> 400", async () => {
      const res = await request(app).get("/api/v1/drivers/not-a-uuid").set(auth(tokens.admin));
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("response never exposes auth/private/financial fields; user + operational summaries only", async () => {
      const linkable = await newLinkableDriverUser();
      const created = await createDriverViaApi(tokens.admin, newDriverPayload(linkable.id));
      assert.equal(created.status, 201);

      const res = await request(app).get(`/api/v1/drivers/${created.body.data.id}`).set(auth(tokens.admin));
      const serialized = JSON.stringify(res.body);

      assert.doesNotMatch(serialized, /password_hash/i);
      assert.doesNotMatch(serialized, /refresh_token/i);
      assert.doesNotMatch(serialized, /auth_sessions/i);
      // Phase 11.7 correction: no cash / balance in the generic Driver DTO.
      assert.equal("cashAccount" in res.body.data, false);
      assert.doesNotMatch(serialized, /currentBalance/i);

      assert.deepEqual(Object.keys(res.body.data.user).sort(), [
        "email",
        "firstName",
        "id",
        "isActive",
        "lastName",
        "phone",
      ]);
      assert.deepEqual(Object.keys(res.body.data.operationalSummary).sort(), [
        "activeOrders",
        "completedToday",
        "outForDelivery",
      ]);
    });
  });

  // ===== UPDATE =====

  describe("Update", () => {
    test("valid isActive update succeeds", async () => {
      const linkable = await newLinkableDriverUser();
      const created = await createDriverViaApi(tokens.admin, newDriverPayload(linkable.id));
      assert.equal(created.status, 201);

      const res = await request(app)
        .patch(`/api/v1/drivers/${created.body.data.id}`)
        .set(auth(tokens.admin))
        .send({ isActive: false });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.isActive, false);
    });

    test("empty PATCH body is rejected with 400", async () => {
      const linkable = await newLinkableDriverUser();
      const created = await createDriverViaApi(tokens.admin, newDriverPayload(linkable.id));
      assert.equal(created.status, 201);

      const res = await request(app).patch(`/api/v1/drivers/${created.body.data.id}`).set(auth(tokens.admin)).send({});
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("immutable/internal fields in PATCH body are rejected (strict); driver_number + user link stay fixed", async () => {
      const linkable = await newLinkableDriverUser();
      const otherUser = await newLinkableDriverUser();
      const created = await createDriverViaApi(tokens.admin, newDriverPayload(linkable.id));
      assert.equal(created.status, 201);
      const driverId = created.body.data.id;
      const originalNumber = created.body.data.driverNumber;

      // Phase 11.7 correction: the update schema is strict — an unknown /
      // protected key is a 400, never silently ignored.
      for (const body of [
        { driverNumber: "SHOULD-NOT-APPLY", isActive: false },
        { userId: otherUser.id },
        { id: "00000000-0000-0000-0000-000000000000" },
        { roleCode: "ADMIN" },
        { permissions: ["drivers.manage"] },
        { password: "hunter2xyz" },
        { passwordHash: "x" },
        { cashBalance: "999.00" },
      ]) {
        const res = await request(app).patch(`/api/v1/drivers/${driverId}`).set(auth(tokens.admin)).send(body);
        assert.equal(res.status, 400, `expected 400 for PATCH body ${JSON.stringify(body)}`);
        assert.equal(res.body.error.code, "VALIDATION_ERROR");
      }

      // The one legitimate operational toggle still works.
      const ok = await request(app)
        .patch(`/api/v1/drivers/${driverId}`)
        .set(auth(tokens.admin))
        .send({ isActive: false });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.data.isActive, false);
      assert.equal(ok.body.data.driverNumber, originalNumber);

      const row = await prisma.drivers.findUniqueOrThrow({ where: { id: driverId }, include: { users: true } });
      assert.equal(row.driver_number, originalNumber);
      assert.equal(row.user_id, linkable.id);
      // role escalation attempt never touched the linked user's role
      const roleRow = await prisma.roles.findUniqueOrThrow({ where: { id: row.users.role_id } });
      assert.equal(roleRow.code, "DRIVER");
    });

    test("nonexistent driver -> 404", async () => {
      const res = await request(app)
        .patch("/api/v1/drivers/00000000-0000-0000-0000-000000000000")
        .set(auth(tokens.admin))
        .send({ isActive: false });
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, "NOT_FOUND");
    });

    test("activation and deactivation via drivers.manage; linked user's own active state is untouched", async () => {
      const linkable = await newLinkableDriverUser();
      const created = await createDriverViaApi(tokens.admin, newDriverPayload(linkable.id));
      assert.equal(created.status, 201);
      const driverId = created.body.data.id;

      const deactivated = await request(app)
        .patch(`/api/v1/drivers/${driverId}`)
        .set(auth(tokens.admin))
        .send({ isActive: false });
      assert.equal(deactivated.status, 200);
      assert.equal(deactivated.body.data.isActive, false);

      const userAfterDeactivation = await prisma.users.findUniqueOrThrow({ where: { id: linkable.id } });
      assert.equal(userAfterDeactivation.is_active, true, "deactivating the driver must not deactivate the user");

      const reactivated = await request(app)
        .patch(`/api/v1/drivers/${driverId}`)
        .set(auth(tokens.admin))
        .send({ isActive: true });
      assert.equal(reactivated.status, 200);
      assert.equal(reactivated.body.data.isActive, true);
    });
  });
});
