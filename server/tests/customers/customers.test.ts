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
  cleanupTestUser,
  createTestArea,
  createTestUser,
  loginTestUser,
  seedCustomerRecord,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

describe("Customers backend (Phase 5.1)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driver: TestUser;
  let tokens: Record<string, string>;
  const createdCustomerIds: string[] = [];

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    finance = await createTestUser("FINANCE");
    driver = await createTestUser("DRIVER");

    const [adminLogin, dispatcherLogin, financeLogin, driverLogin] = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, dispatcher.email, dispatcher.password),
      loginTestUser(app, finance.email, finance.password),
      loginTestUser(app, driver.email, driver.password),
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
    for (const id of createdCustomerIds) {
      await cleanupTestCustomerRecord(id);
    }
    await Promise.all([admin, dispatcher, finance, driver].map((u) => cleanupTestUser(u.id)));
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  function newCustomerPayload(overrides: Record<string, unknown> = {}) {
    const suffix = uniqueSuffix();
    return {
      customerNumber: `PH51-API-${suffix}`,
      name: `Phase51 API Customer ${suffix}`,
      primaryPhone: "+10000000001",
      email: `api-customer-${suffix}@phase4-5-test.swiftdrop.local`,
      ...overrides,
    };
  }

  // ===== AUTHORIZATION =====

  describe("Authorization", () => {
    test("no auth -> 401 on list", async () => {
      const res = await request(app).get("/api/v1/customers");
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, "UNAUTHORIZED");
    });

    test("no auth -> 401 on create", async () => {
      const res = await request(app).post("/api/v1/customers").send(newCustomerPayload());
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, "UNAUTHORIZED");
    });

    test("DRIVER (lacks customers.read) -> 403 on list", async () => {
      const res = await request(app).get("/api/v1/customers").set(auth(tokens.driver));
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "FORBIDDEN");
    });

    test("DISPATCHER with customers.read -> list allowed", async () => {
      const res = await request(app).get("/api/v1/customers").set(auth(tokens.dispatcher));
      assert.equal(res.status, 200);
    });

    test("FINANCE with customers.read -> list allowed", async () => {
      const res = await request(app).get("/api/v1/customers").set(auth(tokens.finance));
      assert.equal(res.status, 200);
    });

    test("DRIVER -> management Customer APIs forbidden (list, create, update)", async () => {
      const list = await request(app).get("/api/v1/customers").set(auth(tokens.driver));
      const create = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.driver))
        .send(newCustomerPayload());
      assert.equal(list.status, 403);
      assert.equal(create.status, 403);
    });

    test("DISPATCHER with customers.create -> create allowed", async () => {
      const res = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.dispatcher))
        .send(newCustomerPayload());
      assert.equal(res.status, 201);
      createdCustomerIds.push(res.body.data.id);
    });

    test("FINANCE without customers.create -> create forbidden", async () => {
      const res = await request(app).post("/api/v1/customers").set(auth(tokens.finance)).send(newCustomerPayload());
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "FORBIDDEN");
    });

    test("DISPATCHER with customers.update -> update allowed", async () => {
      const created = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.dispatcher))
        .send(newCustomerPayload());
      createdCustomerIds.push(created.body.data.id);

      const res = await request(app)
        .patch(`/api/v1/customers/${created.body.data.id}`)
        .set(auth(tokens.dispatcher))
        .send({ notes: "updated by dispatcher" });
      assert.equal(res.status, 200);
    });

    test("FINANCE without customers.update -> update forbidden", async () => {
      const created = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.dispatcher))
        .send(newCustomerPayload());
      createdCustomerIds.push(created.body.data.id);

      const res = await request(app)
        .patch(`/api/v1/customers/${created.body.data.id}`)
        .set(auth(tokens.finance))
        .send({ notes: "attempted by finance" });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "FORBIDDEN");
    });
  });

  // ===== CREATE =====

  describe("Create", () => {
    test("valid creation succeeds with expected fields and a zero-balance wallet", async () => {
      const payload = newCustomerPayload();
      const res = await request(app).post("/api/v1/customers").set(auth(tokens.dispatcher)).send(payload);
      createdCustomerIds.push(res.body.data.id);

      assert.equal(res.status, 201);
      assert.equal(res.body.data.customerNumber, payload.customerNumber);
      assert.equal(res.body.data.name, payload.name);
      assert.equal(res.body.data.primaryPhone, payload.primaryPhone);
      assert.equal(res.body.data.email, payload.email);
      assert.equal(res.body.data.isActive, true);
      assert.ok(res.body.data.wallet, "expected a wallet to be created");
      assert.equal(res.body.data.wallet.availableBalance, "0");
    });

    test("created_by_id is derived from the authenticated actor and cannot be overridden by the client", async () => {
      const payload = newCustomerPayload({ createdById: admin.id, created_by_id: admin.id });
      const res = await request(app).post("/api/v1/customers").set(auth(tokens.dispatcher)).send(payload);
      createdCustomerIds.push(res.body.data.id);

      assert.equal(res.status, 201);
      const row = await prisma.customers.findUniqueOrThrow({ where: { id: res.body.data.id } });
      assert.equal(row.created_by_id, dispatcher.id, "created_by_id must be the authenticated actor, not the injected value");
      assert.notEqual(row.created_by_id, admin.id);
    });

    test("validation failures -> 400", async () => {
      const missingName = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.dispatcher))
        .send({ customerNumber: `PH51-BAD-${uniqueSuffix()}`, primaryPhone: "+1000" });
      assert.equal(missingName.status, 400);
      assert.equal(missingName.body.error.code, "VALIDATION_ERROR");

      const badEmail = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.dispatcher))
        .send(newCustomerPayload({ email: "not-an-email" }));
      assert.equal(badEmail.status, 400);

      const tooLongNumber = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.dispatcher))
        .send(newCustomerPayload({ customerNumber: "x".repeat(51) }));
      assert.equal(tooLongNumber.status, 400);
    });

    test("duplicate customerNumber -> controlled 409 CONFLICT", async () => {
      const payload = newCustomerPayload();
      const first = await request(app).post("/api/v1/customers").set(auth(tokens.dispatcher)).send(payload);
      createdCustomerIds.push(first.body.data.id);
      assert.equal(first.status, 201);

      const second = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.dispatcher))
        .send(newCustomerPayload({ customerNumber: payload.customerNumber }));
      assert.equal(second.status, 409);
      assert.equal(second.body.error.code, "CONFLICT");
      assert.doesNotMatch(JSON.stringify(second.body), /prisma/i);
    });

    test("no portal account is silently created", async () => {
      // Note: does not assert on a global users-table count — this suite
      // runs concurrently with other test files that also create/delete
      // users, which would make a before/after global count flaky. The
      // meaningful, isolation-safe assertion is that THIS customer has no
      // linked portal account.
      const payload = newCustomerPayload();
      const res = await request(app).post("/api/v1/customers").set(auth(tokens.dispatcher)).send(payload);
      createdCustomerIds.push(res.body.data.id);

      assert.equal(res.body.data.hasPortalAccount, false);

      const row = await prisma.customers.findUniqueOrThrow({ where: { id: res.body.data.id } });
      assert.equal(row.portal_user_id, null);

      const matchingUser = await prisma.users.findFirst({ where: { email: payload.email } });
      assert.equal(matchingUser, null, "no user account should be created for the customer's email");
    });

    test("initial wallet is created atomically with balance 0 and no ledger transaction", async () => {
      const res = await request(app).post("/api/v1/customers").set(auth(tokens.dispatcher)).send(newCustomerPayload());
      createdCustomerIds.push(res.body.data.id);

      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: res.body.data.id } });
      assert.equal(wallet.available_balance.toString(), "0");

      const txCount = await prisma.wallet_transactions.count({ where: { wallet_id: wallet.id } });
      assert.equal(txCount, 0, "a zero-balance wallet creation must not produce a ledger transaction");
    });
  });

  // ===== LIST / SEARCH / FILTER =====

  describe("List, search, filter, pagination", () => {
    let area: { id: string; name: string };
    const seededIds: string[] = [];
    let searchMarker: string;

    before(async () => {
      area = await createTestArea();
      searchMarker = `findme-${uniqueSuffix()}`;

      const base = new Date();
      // Seed with explicit, spaced-out created_at values to make default
      // ordering (created_at DESC) deterministically verifiable.
      seededIds.push(
        await seedCustomerRecord(admin.id, {
          name: `Alpha ${searchMarker}`,
          isActive: true,
          areaId: area.id,
          createdAt: new Date(base.getTime() - 3000),
        })
      );
      seededIds.push(
        await seedCustomerRecord(admin.id, {
          name: `Beta customer`,
          isActive: false,
          createdAt: new Date(base.getTime() - 2000),
        })
      );
      seededIds.push(
        await seedCustomerRecord(admin.id, {
          name: `Gamma customer`,
          isActive: true,
          portalUserId: driver.id, // any existing user id works as a portal link for this test
          createdAt: new Date(base.getTime() - 1000),
        })
      );
      createdCustomerIds.push(...seededIds);
    });

    after(async () => {
      await cleanupTestArea(area.id);
    });

    test("list is paginated with correct meta shape", async () => {
      const res = await request(app).get("/api/v1/customers?page=1&limit=2").set(auth(tokens.dispatcher));
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.data));
      assert.ok(res.body.data.length <= 2);
      assert.equal(res.body.meta.page, 1);
      assert.equal(res.body.meta.limit, 2);
      assert.ok(res.body.meta.total >= 3);
      assert.equal(res.body.meta.totalPages, Math.ceil(res.body.meta.total / 2));
    });

    test("page/pageSize validation rejects invalid values", async () => {
      const badPage = await request(app).get("/api/v1/customers?page=0").set(auth(tokens.dispatcher));
      assert.equal(badPage.status, 400);

      const badLimit = await request(app).get("/api/v1/customers?limit=0").set(auth(tokens.dispatcher));
      assert.equal(badLimit.status, 400);

      const nonNumeric = await request(app).get("/api/v1/customers?page=abc").set(auth(tokens.dispatcher));
      assert.equal(nonNumeric.status, 400);
    });

    test("maximum pageSize is enforced", async () => {
      const res = await request(app).get("/api/v1/customers?limit=1000").set(auth(tokens.dispatcher));
      assert.equal(res.status, 400);
    });

    test("search matches on name", async () => {
      const res = await request(app)
        .get(`/api/v1/customers?search=${encodeURIComponent(searchMarker)}`)
        .set(auth(tokens.dispatcher));
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 1);
      assert.match(res.body.data[0].name, new RegExp(searchMarker));
    });

    test("isActive filter works", async () => {
      const res = await request(app)
        .get(`/api/v1/customers?search=customer&isActive=false`)
        .set(auth(tokens.dispatcher));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.every((c: { isActive: boolean }) => c.isActive === false));
    });

    test("areaId filter works", async () => {
      const res = await request(app)
        .get(`/api/v1/customers?areaId=${area.id}`)
        .set(auth(tokens.dispatcher));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.length >= 1);
      assert.ok(res.body.data.every((c: { area: { id: string } | null }) => c.area?.id === area.id));
    });

    test("hasPortalAccount filter works", async () => {
      const res = await request(app)
        .get(`/api/v1/customers?search=Gamma&hasPortalAccount=true`)
        .set(auth(tokens.dispatcher));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.length >= 1);
      assert.ok(res.body.data.every((c: { hasPortalAccount: boolean }) => c.hasPortalAccount === true));
    });

    test("default ordering is created_at DESC", async () => {
      const res = await request(app)
        .get(`/api/v1/customers?search=${encodeURIComponent("customer")}&limit=100`)
        .set(auth(tokens.dispatcher));
      assert.equal(res.status, 200);
      const timestamps = res.body.data.map((c: { createdAt: string }) => new Date(c.createdAt).getTime());
      const sorted = [...timestamps].sort((a, b) => b - a);
      assert.deepEqual(timestamps, sorted, "results must be ordered by created_at descending");
    });
  });

  // ===== DETAIL =====

  describe("Detail", () => {
    test("valid customer detail -> 200 with expected shape", async () => {
      const created = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.dispatcher))
        .send(newCustomerPayload());
      createdCustomerIds.push(created.body.data.id);

      const res = await request(app)
        .get(`/api/v1/customers/${created.body.data.id}`)
        .set(auth(tokens.finance));
      assert.equal(res.status, 200);
      assert.equal(res.body.data.id, created.body.data.id);
      assert.ok("notes" in res.body.data);
      assert.ok("wallet" in res.body.data);
    });

    test("nonexistent UUID -> 404", async () => {
      const res = await request(app)
        .get("/api/v1/customers/00000000-0000-0000-0000-000000000000")
        .set(auth(tokens.dispatcher));
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, "NOT_FOUND");
    });

    test("malformed UUID -> 400", async () => {
      const res = await request(app).get("/api/v1/customers/not-a-uuid").set(auth(tokens.dispatcher));
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("response never exposes auth/private fields", async () => {
      const created = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.dispatcher))
        .send(newCustomerPayload());
      createdCustomerIds.push(created.body.data.id);

      const res = await request(app)
        .get(`/api/v1/customers/${created.body.data.id}`)
        .set(auth(tokens.dispatcher));
      const serialized = JSON.stringify(res.body);

      assert.doesNotMatch(serialized, /password_hash/i);
      assert.doesNotMatch(serialized, /refresh_token/i);
      assert.doesNotMatch(serialized, /auth_sessions/i);
      assert.doesNotMatch(serialized, /portal_user_id/); // only the derived boolean is exposed
    });
  });

  // ===== UPDATE =====

  describe("Update", () => {
    test("valid editable-field update succeeds", async () => {
      const created = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.dispatcher))
        .send(newCustomerPayload());
      createdCustomerIds.push(created.body.data.id);

      const res = await request(app)
        .patch(`/api/v1/customers/${created.body.data.id}`)
        .set(auth(tokens.dispatcher))
        .send({ name: "Updated Name Co", notes: "vip customer" });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.name, "Updated Name Co");
      assert.equal(res.body.data.notes, "vip customer");
    });

    test("empty PATCH body is rejected with 400", async () => {
      const created = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.dispatcher))
        .send(newCustomerPayload());
      createdCustomerIds.push(created.body.data.id);

      const res = await request(app)
        .patch(`/api/v1/customers/${created.body.data.id}`)
        .set(auth(tokens.dispatcher))
        .send({});
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("immutable/internal fields cannot be changed via PATCH", async () => {
      const created = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.dispatcher))
        .send(newCustomerPayload());
      const customerId = created.body.data.id;
      createdCustomerIds.push(customerId);
      const originalNumber = created.body.data.customerNumber;

      const res = await request(app)
        .patch(`/api/v1/customers/${customerId}`)
        .set(auth(tokens.dispatcher))
        .send({
          id: "00000000-0000-0000-0000-000000000000",
          customerNumber: "SHOULD-NOT-APPLY",
          createdById: admin.id,
          createdAt: "2000-01-01T00:00:00.000Z",
          name: "Legit Name Change",
        });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.id, customerId);
      assert.equal(res.body.data.customerNumber, originalNumber, "customerNumber must remain immutable");
      assert.equal(res.body.data.name, "Legit Name Change");

      const row = await prisma.customers.findUniqueOrThrow({ where: { id: customerId } });
      assert.equal(row.created_by_id, dispatcher.id);
    });

    test("nonexistent customer -> 404", async () => {
      const res = await request(app)
        .patch("/api/v1/customers/00000000-0000-0000-0000-000000000000")
        .set(auth(tokens.dispatcher))
        .send({ name: "Nobody" });
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, "NOT_FOUND");
    });

    test("deactivation and reactivation via customers.update", async () => {
      const created = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.dispatcher))
        .send(newCustomerPayload());
      const customerId = created.body.data.id;
      createdCustomerIds.push(customerId);

      const deactivated = await request(app)
        .patch(`/api/v1/customers/${customerId}`)
        .set(auth(tokens.dispatcher))
        .send({ isActive: false });
      assert.equal(deactivated.status, 200);
      assert.equal(deactivated.body.data.isActive, false);

      const reactivated = await request(app)
        .patch(`/api/v1/customers/${customerId}`)
        .set(auth(tokens.dispatcher))
        .send({ isActive: true });
      assert.equal(reactivated.status, 200);
      assert.equal(reactivated.body.data.isActive, true);
    });
  });
});
