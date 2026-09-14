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
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Phase 13.7 — GET /api/v1/customer/me/profile.
//
// Covers: portal-family + permission authorization (portal denial BEFORE the
// Customer / area lookup), strict self-scoping (no customerId trust), exact
// Customer-safe DTO key set, basic identity fields, optional contact / area /
// address nullability, Management-notes privacy, is_active / portal-metadata
// privacy, auth/security privacy, financial privacy, order/tracking privacy,
// no timestamps / internal ids, single fixed query (no N+1), missing-linked-
// Customer safe failure, and zero write side effects.
// ============================================================

const SAFE_KEYS = [
  "customerNumber",
  "name",
  "primaryPhone",
  "secondaryPhone",
  "email",
  "defaultArea",
  "defaultAddress",
].sort();

const FORBIDDEN_SUBSTRINGS = [
  // internal ids
  '"id"',
  "portalUserId",
  "portal_user_id",
  "createdById",
  "created_by_id",
  "defaultAreaId",
  "default_area_id",
  "areaId",
  // Management notes
  "notes",
  // active / portal metadata
  "isActive",
  "is_active",
  "hasPortalAccount",
  "has_portal_account",
  // timestamps
  "createdAt",
  "created_at",
  "updatedAt",
  "updated_at",
  // auth / security
  "password",
  "password_hash",
  "passwordHash",
  "token",
  "session",
  "role",
  "permission",
  "lastLogin",
  "last_login",
  // finance
  "wallet",
  "balance",
  "pending",
  "payout",
  "transaction",
  "driverCash",
  "driver_cash",
  "companyRevenue",
  "financialStatus",
  "financial_status",
  "needsFinancialReview",
  // orders / tracking / collection
  "orderNumber",
  "trackingCode",
  "receiver",
  "parcelCollection",
  "parcel_collection",
  // area internals
  "sortOrder",
  "sort_order",
];

describe("Customer Portal — Profile (Phase 13.7)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driver: TestUser;
  let customerAUser: TestUser;
  let customerBUser: TestUser;
  let sparseCustomerUser: TestUser;
  let unlinkedCustomerUser: TestUser;
  let tokens: Record<string, string>;

  let area: { id: string; name: string };
  let customerAId: string;
  let customerBId: string;
  let sparseCustomerId: string;

  const customerRecordIds: string[] = [];
  const areaIds: string[] = [];
  const userIds: string[] = [];

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const getProfile = (t?: string, qs = "") => {
    const r = request(app).get(`/api/v1/customer/me/profile${qs}`);
    return t ? r.set(auth(t)) : r;
  };

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    finance = await createTestUser("FINANCE");
    driver = await createTestUser("DRIVER");
    customerAUser = await createTestUser("CUSTOMER");
    customerBUser = await createTestUser("CUSTOMER");
    sparseCustomerUser = await createTestUser("CUSTOMER");
    unlinkedCustomerUser = await createTestUser("CUSTOMER");
    userIds.push(
      dispatcher.id,
      finance.id,
      driver.id,
      customerAUser.id,
      customerBUser.id,
      sparseCustomerUser.id,
      unlinkedCustomerUser.id
    );

    const logins = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, dispatcher.email, dispatcher.password),
      loginTestUser(app, finance.email, finance.password),
      loginTestUser(app, driver.email, driver.password),
      loginTestUser(app, customerAUser.email, customerAUser.password),
      loginTestUser(app, customerBUser.email, customerBUser.password),
      loginTestUser(app, sparseCustomerUser.email, sparseCustomerUser.password),
      loginTestUser(app, unlinkedCustomerUser.email, unlinkedCustomerUser.password),
    ]);
    tokens = {
      admin: logins[0].accessToken as string,
      dispatcher: logins[1].accessToken as string,
      finance: logins[2].accessToken as string,
      driver: logins[3].accessToken as string,
      customerA: logins[4].accessToken as string,
      customerB: logins[5].accessToken as string,
      sparseCustomer: logins[6].accessToken as string,
      unlinkedCustomer: logins[7].accessToken as string,
    };
    for (const [k, v] of Object.entries(tokens)) assert.ok(v, `missing token: ${k}`);

    area = await createTestArea();
    areaIds.push(area.id);

    // Customer A — fully populated, with Management-only `notes` set directly.
    customerAId = await seedCustomerRecord(admin.id, {
      name: "Profile Customer A",
      primaryPhone: "+96170111111",
      secondaryPhone: "+96171222222",
      email: "profile-a@example.test",
      defaultAddress: "12 Main St, Building 3, Floor 2",
      areaId: area.id,
      portalUserId: customerAUser.id,
    });
    customerBId = await seedCustomerRecord(admin.id, {
      name: "Profile Customer B",
      primaryPhone: "+96170999999",
      email: "profile-b@example.test",
      areaId: area.id,
      portalUserId: customerBUser.id,
    });
    // Customer with the optional fields all unset + inactive.
    sparseCustomerId = await seedCustomerRecord(admin.id, {
      name: "Sparse Profile Customer",
      primaryPhone: "+96170333333",
      isActive: false,
      portalUserId: sparseCustomerUser.id,
    });
    customerRecordIds.push(customerAId, customerBId, sparseCustomerId);

    await prisma.customers.update({
      where: { id: customerAId },
      data: { notes: "VIP — internal management note, do not disclose" },
    });
  });

  after(async () => {
    for (const id of customerRecordIds) await cleanupTestCustomerRecord(id);
    for (const id of areaIds) await cleanupTestArea(id);
    for (const id of userIds) await cleanupTestUser(id);
    await cleanupTestUser(admin.id);
  });

  // ===========================================================
  // Portal / permission matrix (task §46)
  // ===========================================================
  describe("authorization", () => {
    test("CUSTOMER -> 200", async () => {
      assert.equal((await getProfile(tokens.customerA)).status, 200);
    });

    test("ADMIN / DISPATCHER / FINANCE / DRIVER -> 403; unauthenticated -> 401", async () => {
      for (const role of ["admin", "dispatcher", "finance", "driver"] as const) {
        const res = await getProfile(tokens[role]);
        assert.equal(res.status, 403, role);
        assert.equal(res.body.error.code, "FORBIDDEN");
      }
      assert.equal((await getProfile()).status, 401);
    });

    test("portal denial precedes Customer lookup — ADMIN 403 leaks nothing (task §47)", async () => {
      const res = await getProfile(tokens.admin);
      assert.equal(res.status, 403);
      const json = JSON.stringify(res.body);
      assert.ok(!/customer profile/i.test(json));
      assert.ok(!/prisma/i.test(json));
      assert.ok(!/relation/i.test(json));
      assert.ok(!/no customer/i.test(json));
    });
  });

  // ===========================================================
  // DTO shape + privacy (task §49 / §54 - §57)
  // ===========================================================
  describe("DTO", () => {
    test("exact top-level key set; nested defaultArea key set", async () => {
      const res = await getProfile(tokens.customerA);
      assert.deepEqual(Object.keys(res.body.data).sort(), SAFE_KEYS);
      assert.deepEqual(Object.keys(res.body.data.defaultArea).sort(), ["name"]);
    });

    test("no Management notes / active / portal metadata / auth / finance / order / timestamp / id fields", async () => {
      const res = await getProfile(tokens.customerA);
      const json = JSON.stringify(res.body.data);
      for (const term of FORBIDDEN_SUBSTRINGS) {
        assert.ok(!json.includes(term), `leaked "${term}"`);
      }
      assert.ok(!json.includes("internal management note"));
    });
  });

  // ===========================================================
  // Self-scoping (task §48)
  // ===========================================================
  describe("self-scoping", () => {
    test("A sees only A; ?customerId=<B> and ?userId=<B> have no effect", async () => {
      const plain = await getProfile(tokens.customerA);
      const spoofCustomer = await getProfile(tokens.customerA, `?customerId=${customerBId}`);
      const spoofUser = await getProfile(tokens.customerA, `?userId=${customerBUser.id}`);
      assert.equal(spoofCustomer.status, 200);
      assert.deepEqual(spoofCustomer.body.data, plain.body.data);
      assert.deepEqual(spoofUser.body.data, plain.body.data);
      assert.equal(plain.body.data.name, "Profile Customer A");
    });

    test("B sees only B", async () => {
      const res = await getProfile(tokens.customerB);
      assert.equal(res.body.data.name, "Profile Customer B");
      assert.equal(res.body.data.email, "profile-b@example.test");
    });
  });

  // ===========================================================
  // Basic information (task §50)
  // ===========================================================
  describe("basic information", () => {
    test("customerNumber / name / primaryPhone match the authoritative Customer record", async () => {
      const res = await getProfile(tokens.customerA);
      const row = await prisma.customers.findUniqueOrThrow({ where: { id: customerAId } });
      assert.equal(res.body.data.customerNumber, row.customer_number);
      assert.equal(res.body.data.name, row.name);
      assert.equal(res.body.data.primaryPhone, row.primary_phone);
    });
  });

  // ===========================================================
  // Optional contact (task §51)
  // ===========================================================
  describe("optional contact fields", () => {
    test("populated: secondaryPhone + email are the stored strings", async () => {
      const res = await getProfile(tokens.customerA);
      assert.equal(res.body.data.secondaryPhone, "+96171222222");
      assert.equal(res.body.data.email, "profile-a@example.test");
    });

    test("unset: secondaryPhone / email / defaultAddress are explicit null (never undefined / missing)", async () => {
      const res = await getProfile(tokens.sparseCustomer);
      for (const key of ["secondaryPhone", "email", "defaultAddress", "defaultArea"]) {
        assert.ok(key in res.body.data, `missing key ${key}`);
        assert.equal(res.body.data[key], null, key);
      }
    });
  });

  // ===========================================================
  // Default area (task §52)
  // ===========================================================
  describe("default area", () => {
    test("with area -> { name } only, matching areas.name; no id / sort order / isActive", async () => {
      const res = await getProfile(tokens.customerA);
      assert.deepEqual(res.body.data.defaultArea, { name: area.name });
    });

    test("without area -> null", async () => {
      const res = await getProfile(tokens.sparseCustomer);
      assert.equal(res.body.data.defaultArea, null);
    });
  });

  // ===========================================================
  // Default address (task §53)
  // ===========================================================
  describe("default address", () => {
    test("returned exactly from the current Customer record", async () => {
      const res = await getProfile(tokens.customerA);
      assert.equal(res.body.data.defaultAddress, "12 Main St, Building 3, Floor 2");
    });
  });

  // ===========================================================
  // is_active privacy (task §55) — inactive Customer still authenticates,
  // but the Profile response never reveals the internal status.
  // ===========================================================
  describe("inactive Customer", () => {
    test("inactive Customer -> 200 with the same safe key set, no status field", async () => {
      const res = await getProfile(tokens.sparseCustomer);
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(res.body.data).sort(), SAFE_KEYS);
      const row = await prisma.customers.findUniqueOrThrow({ where: { id: sparseCustomerId } });
      assert.equal(row.is_active, false);
    });
  });

  // ===========================================================
  // Missing linked Customer (task §59)
  // ===========================================================
  describe("missing linked Customer", () => {
    test("CUSTOMER-role user with no customers row -> safe 403, no auto-link/create, no raw DB error", async () => {
      const res = await getProfile(tokens.unlinkedCustomer);
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "FORBIDDEN");
      const json = JSON.stringify(res.body);
      assert.ok(!/prisma/i.test(json));
      assert.ok(!/findUnique/i.test(json));
      // no customers row was created as a side effect
      const created = await prisma.customers.findUnique({
        where: { portal_user_id: unlinkedCustomerUser.id },
      });
      assert.equal(created, null);
    });
  });

  // ===========================================================
  // Read-only (task §58)
  // ===========================================================
  describe("read-only", () => {
    test("repeated reads create no customer / user / audit mutations; customer row unchanged", async () => {
      const snap = async () => {
        const [audit, customer, user] = await Promise.all([
          prisma.audit_logs.count({ where: { entity_id: customerAId } }),
          prisma.customers.findUnique({
            where: { id: customerAId },
            select: { name: true, email: true, updated_at: true },
          }),
          prisma.users.findUnique({
            where: { id: customerAUser.id },
            select: { email: true, updated_at: true },
          }),
        ]);
        return {
          audit,
          cName: customer?.name,
          cEmail: customer?.email,
          cUpdatedAt: customer?.updated_at.toISOString(),
          uEmail: user?.email,
          uUpdatedAt: user?.updated_at.toISOString(),
        };
      };
      const before = await snap();
      await getProfile(tokens.customerA);
      await getProfile(tokens.customerA);
      await getProfile(tokens.customerA);
      assert.deepEqual(await snap(), before);
    });
  });

  // ===========================================================
  // No mutation route (task §27)
  // ===========================================================
  describe("no self-edit route", () => {
    test("PATCH / PUT / POST /customer/me/profile are not routed (404/405, never a mutation)", async () => {
      for (const method of ["patch", "put", "post"] as const) {
        const res = await request(app)
          [method]("/api/v1/customer/me/profile")
          .set(auth(tokens.customerA))
          .send({ name: "Hacked Name", email: "hacked@example.test" });
        assert.ok(res.status === 404 || res.status === 405, `${method} -> ${res.status}`);
      }
      const row = await prisma.customers.findUniqueOrThrow({ where: { id: customerAId } });
      assert.equal(row.name, "Profile Customer A");
      assert.equal(row.email, "profile-a@example.test");
    });
  });
});
