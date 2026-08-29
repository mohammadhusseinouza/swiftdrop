// Phase 5.4 — Core Management Data Integration Tests.
//
// This file intentionally does NOT re-test everything already covered by
// the per-module suites (tests/customers, tests/drivers,
// tests/reference-data, tests/settings). It focuses on what isolated
// module tests cannot catch: cross-module interactions, atomicity,
// concurrency, DTO-security across resource boundaries, and canonical
// seed/RBAC preservation at the Phase 5 review gate.
//
// All fixtures use unique PH54-prefixed identifiers so this file is safe to
// run concurrently with every other test file (Node's test runner executes
// test files in parallel by default).

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
  cleanupTestDriverRecord,
  cleanupTestFailedDeliveryReason,
  cleanupTestPaymentMethod,
  cleanupTestSetting,
  cleanupTestUser,
  createTestArea,
  createTestUser,
  loginTestUser,
  seedTestSetting,
  setUserActive,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

describe("Phase 5.4 — Core Management Data Integration", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driverActor: TestUser;
  let customerActor: TestUser;
  let tokens: Record<string, string>;

  const cleanup = {
    customerIds: [] as string[],
    driverIds: [] as string[],
    areaIds: [] as string[],
    paymentMethodIds: [] as string[],
    failedReasonIds: [] as string[],
    settingKeys: [] as string[],
    userIds: [] as string[],
  };

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    finance = await createTestUser("FINANCE");
    driverActor = await createTestUser("DRIVER");
    customerActor = await createTestUser("CUSTOMER");

    const [adminLogin, dispatcherLogin, financeLogin, driverLogin, customerLogin] = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, dispatcher.email, dispatcher.password),
      loginTestUser(app, finance.email, finance.password),
      loginTestUser(app, driverActor.email, driverActor.password),
      loginTestUser(app, customerActor.email, customerActor.password),
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
    for (const id of cleanup.customerIds) await cleanupTestCustomerRecord(id);
    for (const id of cleanup.driverIds) await cleanupTestDriverRecord(id);
    for (const id of cleanup.areaIds) await cleanupTestArea(id);
    for (const id of cleanup.paymentMethodIds) await cleanupTestPaymentMethod(id);
    for (const id of cleanup.failedReasonIds) await cleanupTestFailedDeliveryReason(id);
    for (const key of cleanup.settingKeys) await cleanupTestSetting(key);
    for (const id of cleanup.userIds) await cleanupTestUser(id);
    await Promise.all([admin, dispatcher, finance, driverActor, customerActor].map((u) => cleanupTestUser(u.id)));
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function newLinkableDriverUser(): Promise<TestUser> {
    const user = await createTestUser("DRIVER");
    cleanup.userIds.push(user.id);
    return user;
  }

  // ===========================================================
  // 1. RBAC MATRIX ACROSS PHASE 5 MODULES
  // ===========================================================

  describe("RBAC matrix across Phase 5 modules", () => {
    test("canonical role permission counts are exactly the approved V1 matrix", async () => {
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

      // Scoped to the exact 5 canonical role codes (not a raw
      // prisma.roles.count()) — tests/auth/authorize.test.ts's dynamic-
      // permission fixture creates its own temporary role/permission, and
      // Node's test runner executes files concurrently, so an unscoped
      // total count can transiently observe that other file's still-live
      // (properly self-cleaned-up) fixture and flake. Same reasoning as
      // the Phase 6.3 cleanup applied to reference-data.test.ts.
      const canonicalRoleCount = await prisma.roles.count({
        where: { code: { in: ["ADMIN", "DISPATCHER", "FINANCE", "DRIVER", "CUSTOMER"] } },
      });
      assert.equal(canonicalRoleCount, 5);

      // Same reasoning for permissions — excludes only the one known
      // temporary-permission code prefix used by that fixture
      // ("_test.dynamic.<suffix>"), not a broad/fragile pattern.
      const canonicalPermissionCount = await prisma.permissions.count({
        where: { code: { not: { startsWith: "_test." } } },
      });
      assert.equal(canonicalPermissionCount, 35);
    });

    // One request per (resource, role) cell of the matrix described in the
    // task, using real HTTP calls through real authorize() middleware —
    // not a re-derivation of the permission list.
    const READ_ENDPOINTS: Array<{ resource: string; path: string }> = [
      { resource: "customers", path: "/api/v1/customers" },
      { resource: "drivers", path: "/api/v1/drivers" },
      { resource: "areas", path: "/api/v1/settings/areas" },
      { resource: "payment-methods", path: "/api/v1/settings/payment-methods" },
      { resource: "failed-delivery-reasons", path: "/api/v1/settings/failed-delivery-reasons" },
      { resource: "system-settings", path: "/api/v1/system-settings" },
    ];

    for (const { resource, path } of READ_ENDPOINTS) {
      test(`ADMIN/DISPATCHER/FINANCE can read ${resource}; DRIVER/CUSTOMER cannot`, async () => {
        const [adminRes, dispatcherRes, financeRes, driverRes, customerRes] = await Promise.all([
          request(app).get(path).set(auth(tokens.admin)),
          request(app).get(path).set(auth(tokens.dispatcher)),
          request(app).get(path).set(auth(tokens.finance)),
          request(app).get(path).set(auth(tokens.driver)),
          request(app).get(path).set(auth(tokens.customer)),
        ]);

        assert.equal(adminRes.status, 200, `ADMIN should read ${resource}`);
        assert.equal(dispatcherRes.status, 200, `DISPATCHER should read ${resource}`);
        assert.equal(financeRes.status, 200, `FINANCE should read ${resource}`);
        assert.equal(driverRes.status, 403, `DRIVER must be forbidden from ${resource}`);
        assert.equal(customerRes.status, 403, `CUSTOMER must be forbidden from ${resource}`);
      });
    }

    test("DISPATCHER: customers create/update allowed, drivers.manage forbidden, settings.manage forbidden", async () => {
      const createCustomer = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.dispatcher))
        .send({
          customerNumber: `PH54-RBAC-CUST-${uniqueSuffix()}`,
          name: "Phase54 RBAC Customer",
          primaryPhone: "+10000000001",
        });
      assert.equal(createCustomer.status, 201);
      cleanup.customerIds.push(createCustomer.body.data.id);

      const linkable = await newLinkableDriverUser();
      const createDriver = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.dispatcher))
        .send({ driverNumber: `PH54-RBAC-${uniqueSuffix()}`, userId: linkable.id });
      assert.equal(createDriver.status, 403);

      const createArea = await request(app)
        .post("/api/v1/settings/areas")
        .set(auth(tokens.dispatcher))
        .send({ name: `Phase54 RBAC Area ${uniqueSuffix()}` });
      assert.equal(createArea.status, 403);
    });

    test("FINANCE: customers create/update forbidden, drivers.manage forbidden, settings.manage forbidden", async () => {
      const createCustomer = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.finance))
        .send({
          customerNumber: `PH54-RBAC-FIN-${uniqueSuffix()}`,
          name: "Phase54 RBAC Finance Customer",
          primaryPhone: "+10000000002",
        });
      assert.equal(createCustomer.status, 403);

      const linkable = await newLinkableDriverUser();
      const createDriver = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.finance))
        .send({ driverNumber: `PH54-RBAC-FIN-${uniqueSuffix()}`, userId: linkable.id });
      assert.equal(createDriver.status, 403);

      const createArea = await request(app)
        .post("/api/v1/settings/areas")
        .set(auth(tokens.finance))
        .send({ name: `Phase54 RBAC Finance Area ${uniqueSuffix()}` });
      assert.equal(createArea.status, 403);
    });

    test("DRIVER and CUSTOMER have no Phase 5 management access at all (list + create)", async () => {
      for (const role of ["driver", "customer"] as const) {
        const list = await request(app).get("/api/v1/customers").set(auth(tokens[role]));
        assert.equal(list.status, 403);
        const create = await request(app)
          .post("/api/v1/settings/areas")
          .set(auth(tokens[role]))
          .send({ name: `should-not-be-created-${uniqueSuffix()}` });
        assert.equal(create.status, 403);
      }
    });
  });

  // ===========================================================
  // 2. CUSTOMER + AREA INTEGRATION
  // ===========================================================

  describe("Customer + Area integration", () => {
    test("full lifecycle: area created, customer linked, detail/filter reflect it, area deactivation is non-destructive", async () => {
      const areaName = `Phase54 Integration Area ${uniqueSuffix()}`;
      const areaRes = await request(app).post("/api/v1/settings/areas").set(auth(tokens.admin)).send({ name: areaName });
      assert.equal(areaRes.status, 201);
      const areaId = areaRes.body.data.id;
      cleanup.areaIds.push(areaId);

      const customerRes = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.dispatcher))
        .send({
          customerNumber: `PH54-AREA-CUST-${uniqueSuffix()}`,
          name: "Phase54 Area Customer",
          primaryPhone: "+10000000003",
          defaultAreaId: areaId,
        });
      assert.equal(customerRes.status, 201);
      const customerId = customerRes.body.data.id;
      cleanup.customerIds.push(customerId);
      assert.equal(customerRes.body.data.area.id, areaId);
      assert.equal(customerRes.body.data.area.name, areaName);

      const detail = await request(app).get(`/api/v1/customers/${customerId}`).set(auth(tokens.admin));
      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.area.id, areaId);

      const filtered = await request(app)
        .get(`/api/v1/customers?areaId=${areaId}`)
        .set(auth(tokens.admin));
      assert.equal(filtered.status, 200);
      assert.ok(filtered.body.data.some((c: { id: string }) => c.id === customerId));
      assert.ok(filtered.body.data.every((c: { area: { id: string } | null }) => c.area?.id === areaId));

      const deactivateArea = await request(app)
        .patch(`/api/v1/settings/areas/${areaId}`)
        .set(auth(tokens.admin))
        .send({ isActive: false });
      assert.equal(deactivateArea.status, 200);
      assert.equal(deactivateArea.body.data.isActive, false);

      // The existing customer's historical/default area link must survive
      // the area being deactivated — deactivation must not be destructive.
      const detailAfterDeactivation = await request(app).get(`/api/v1/customers/${customerId}`).set(auth(tokens.admin));
      assert.equal(detailAfterDeactivation.status, 200);
      assert.equal(detailAfterDeactivation.body.data.area.id, areaId);
      assert.equal(detailAfterDeactivation.body.data.area.name, areaName);
    });

    // BUSINESS-RULE GAP (reported, not invented): neither requirements.md
    // nor implementation_plan.md defines whether a Customer may be
    // created/updated to reference an INACTIVE area. The current Customer
    // service only checks the area FK exists (P2003 -> 400); it does not
    // check areas.is_active. These two tests document that actual current
    // behavior (allowed) rather than adding a new restriction.
    test("[business-rule gap] creating a Customer with an inactive area's id currently succeeds (no active-area enforcement exists)", async () => {
      const area = await createTestArea();
      cleanup.areaIds.push(area.id);
      const deactivate = await request(app)
        .patch(`/api/v1/settings/areas/${area.id}`)
        .set(auth(tokens.admin))
        .send({ isActive: false });
      assert.equal(deactivate.status, 200);

      const res = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.dispatcher))
        .send({
          customerNumber: `PH54-INACTIVE-AREA-${uniqueSuffix()}`,
          name: "Phase54 Inactive Area Customer",
          primaryPhone: "+10000000004",
          defaultAreaId: area.id,
        });

      assert.equal(res.status, 201, "current behavior: no active-area restriction is enforced on create");
      cleanup.customerIds.push(res.body.data.id);
      assert.equal(res.body.data.area.id, area.id);
    });

    test("[business-rule gap] updating a Customer to reference an inactive area's id currently succeeds", async () => {
      const area = await createTestArea();
      cleanup.areaIds.push(area.id);
      await request(app).patch(`/api/v1/settings/areas/${area.id}`).set(auth(tokens.admin)).send({ isActive: false });

      const created = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.dispatcher))
        .send({
          customerNumber: `PH54-INACTIVE-AREA-UPD-${uniqueSuffix()}`,
          name: "Phase54 Inactive Area Update Customer",
          primaryPhone: "+10000000005",
        });
      cleanup.customerIds.push(created.body.data.id);

      const res = await request(app)
        .patch(`/api/v1/customers/${created.body.data.id}`)
        .set(auth(tokens.dispatcher))
        .send({ defaultAreaId: area.id });

      assert.equal(res.status, 200, "current behavior: no active-area restriction is enforced on update");
      assert.equal(res.body.data.area.id, area.id);
    });

    test("invalid/nonexistent areaId -> 400 VALIDATION_ERROR (FK check), no customer or wallet is created", async () => {
      const fakeAreaId = "00000000-0000-0000-0000-000000000000";
      const customerNumber = `PH54-BADAREA-${uniqueSuffix()}`;

      const res = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.dispatcher))
        .send({
          customerNumber,
          name: "Phase54 Bad Area Customer",
          primaryPhone: "+10000000006",
          defaultAreaId: fakeAreaId,
        });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
      assert.doesNotMatch(JSON.stringify(res.body), /prisma/i);

      // Scoped to this exact attempted customerNumber rather than a raw
      // global prisma.customers.count() before/after delta — Node's test
      // runner executes files concurrently, and many other suites create/
      // delete customers throughout a full run, so an unscoped global count
      // can shift between the two reads for reasons unrelated to this
      // request and flake. Same reasoning as the Phase 6.3/6.4 cleanups.
      const orphan = await prisma.customers.findUnique({ where: { customer_number: customerNumber } });
      assert.equal(orphan, null, "a failed create must not leave a partial customer row");
    });
  });

  // ===========================================================
  // 3. CUSTOMER + WALLET ATOMICITY / CONCURRENCY
  // ===========================================================

  describe("Customer + Wallet integration", () => {
    test("creation is atomic: exactly one customer_wallets row, balance 0, no wallet_transactions row", async () => {
      const res = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.dispatcher))
        .send({
          customerNumber: `PH54-WALLET-${uniqueSuffix()}`,
          name: "Phase54 Wallet Customer",
          primaryPhone: "+10000000007",
        });
      assert.equal(res.status, 201);
      const customerId = res.body.data.id;
      cleanup.customerIds.push(customerId);

      assert.equal(res.body.data.wallet.availableBalance, "0");

      const wallets = await prisma.customer_wallets.findMany({ where: { customer_id: customerId } });
      assert.equal(wallets.length, 1);
      assert.equal(wallets[0].available_balance.toString(), "0");

      const txCount = await prisma.wallet_transactions.count({ where: { wallet_id: wallets[0].id } });
      assert.equal(txCount, 0);
    });

    test("customer detail wallet balance always matches the stored DB row", async () => {
      const res = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.dispatcher))
        .send({
          customerNumber: `PH54-WALLETSYNC-${uniqueSuffix()}`,
          name: "Phase54 Wallet Sync Customer",
          primaryPhone: "+10000000008",
        });
      const customerId = res.body.data.id;
      cleanup.customerIds.push(customerId);

      // Simulate a wallet balance change the way a future Finance module
      // would (direct ledger write) — Customer APIs themselves expose no
      // way to do this; see the "cannot mutate wallet" test below.
      await prisma.customer_wallets.update({
        where: { customer_id: customerId },
        data: { available_balance: 42.5 },
      });

      const detail = await request(app).get(`/api/v1/customers/${customerId}`).set(auth(tokens.admin));
      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.wallet.availableBalance, "42.5");
    });

    test("update/deactivation never creates a wallet_transactions row", async () => {
      const created = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.dispatcher))
        .send({
          customerNumber: `PH54-NOTX-${uniqueSuffix()}`,
          name: "Phase54 No Tx Customer",
          primaryPhone: "+10000000009",
        });
      const customerId = created.body.data.id;
      cleanup.customerIds.push(customerId);
      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });

      await request(app)
        .patch(`/api/v1/customers/${customerId}`)
        .set(auth(tokens.dispatcher))
        .send({ name: "Renamed", isActive: false });
      await request(app)
        .patch(`/api/v1/customers/${customerId}`)
        .set(auth(tokens.dispatcher))
        .send({ isActive: true });

      const txCount = await prisma.wallet_transactions.count({ where: { wallet_id: wallet.id } });
      assert.equal(txCount, 0, "Customer update/deactivation must never touch the wallet ledger");
    });

    test("Customer create/update APIs expose no field that can set a wallet balance", async () => {
      const res = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.dispatcher))
        .send({
          customerNumber: `PH54-NOWALLETFIELD-${uniqueSuffix()}`,
          name: "Phase54 No Wallet Field Customer",
          primaryPhone: "+10000000010",
          wallet: { availableBalance: "999999" },
          availableBalance: "999999",
        });
      assert.equal(res.status, 201);
      cleanup.customerIds.push(res.body.data.id);
      assert.equal(res.body.data.wallet.availableBalance, "0");
    });

    test("concurrent duplicate customerNumber creates: exactly one succeeds, exactly one customer + one wallet exist", async () => {
      const customerNumber = `PH54-RACE-CUST-${uniqueSuffix()}`;
      const payload = {
        customerNumber,
        name: "Phase54 Race Customer",
        primaryPhone: "+10000000011",
      };

      const [first, second] = await Promise.all([
        request(app).post("/api/v1/customers").set(auth(tokens.dispatcher)).send(payload),
        request(app).post("/api/v1/customers").set(auth(tokens.dispatcher)).send(payload),
      ]);

      const statuses = [first.status, second.status].sort();
      assert.deepEqual(statuses, [201, 409], "exactly one of the two concurrent creates must succeed");

      const winner = first.status === 201 ? first : second;
      const loser = first.status === 201 ? second : first;
      assert.equal(loser.body.error.code, "CONFLICT");
      cleanup.customerIds.push(winner.body.data.id);

      const matchingCustomers = await prisma.customers.findMany({ where: { customer_number: customerNumber } });
      assert.equal(matchingCustomers.length, 1);

      const wallets = await prisma.customer_wallets.findMany({ where: { customer_id: matchingCustomers[0].id } });
      assert.equal(wallets.length, 1, "no orphan wallet from the losing concurrent request");
    });
  });

  // ===========================================================
  // 4. DRIVER + USER + CASH ACCOUNT INTEGRATION
  // ===========================================================

  describe("Driver + User + Cash Account integration", () => {
    test("creation is atomic: exactly one driver_cash_accounts row, balance 0, no driver_cash_transactions row", async () => {
      const linkable = await newLinkableDriverUser();
      const res = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.admin))
        .send({ driverNumber: `PH54-CASH-${uniqueSuffix()}`, userId: linkable.id });
      assert.equal(res.status, 201);
      const driverId = res.body.data.id;
      cleanup.driverIds.push(driverId);

      assert.equal(res.body.data.cashAccount.currentBalance, "0");

      const accounts = await prisma.driver_cash_accounts.findMany({ where: { driver_id: driverId } });
      assert.equal(accounts.length, 1);
      assert.equal(accounts[0].current_balance.toString(), "0");

      const txCount = await prisma.driver_cash_transactions.count({ where: { account_id: accounts[0].id } });
      assert.equal(txCount, 0);
    });

    test("getDriverProfileForUser resolves a management-linked driver end-to-end", async () => {
      const { getDriverProfileForUser } = await import("../../src/modules/auth/ownership.service");
      const linkable = await newLinkableDriverUser();
      const res = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.admin))
        .send({ driverNumber: `PH54-OWN-${uniqueSuffix()}`, userId: linkable.id });
      assert.equal(res.status, 201);
      cleanup.driverIds.push(res.body.data.id);

      const profile = await getDriverProfileForUser(linkable.id);
      assert.equal(profile.id, res.body.data.id);
      assert.equal(profile.userId, linkable.id);
      assert.equal(profile.driverNumber, res.body.data.driverNumber);
      assert.equal(profile.isActive, true);
    });

    test("driver detail exposes only safe linked-user fields", async () => {
      const linkable = await newLinkableDriverUser();
      const created = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.admin))
        .send({ driverNumber: `PH54-SAFE-${uniqueSuffix()}`, userId: linkable.id });
      cleanup.driverIds.push(created.body.data.id);

      const detail = await request(app).get(`/api/v1/drivers/${created.body.data.id}`).set(auth(tokens.finance));
      assert.equal(detail.status, 200);
      assert.deepEqual(Object.keys(detail.body.data.user).sort(), [
        "email",
        "firstName",
        "id",
        "isActive",
        "lastName",
        "phone",
      ]);
    });

    test("driver deactivation does not alter users.is_active; user deactivation does not alter drivers.is_active", async () => {
      const linkable = await newLinkableDriverUser();
      const created = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.admin))
        .send({ driverNumber: `PH54-INDEP-${uniqueSuffix()}`, userId: linkable.id });
      const driverId = created.body.data.id;
      cleanup.driverIds.push(driverId);

      await request(app).patch(`/api/v1/drivers/${driverId}`).set(auth(tokens.admin)).send({ isActive: false });
      const userAfterDriverDeactivation = await prisma.users.findUniqueOrThrow({ where: { id: linkable.id } });
      assert.equal(userAfterDriverDeactivation.is_active, true);

      await request(app).patch(`/api/v1/drivers/${driverId}`).set(auth(tokens.admin)).send({ isActive: true });

      // Reverse direction: deactivating the underlying user must not touch
      // the driver row's own is_active flag.
      await setUserActive(linkable.id, false);
      const driverAfterUserDeactivation = await request(app)
        .get(`/api/v1/drivers/${driverId}`)
        .set(auth(tokens.admin));
      assert.equal(driverAfterUserDeactivation.status, 200);
      assert.equal(driverAfterUserDeactivation.body.data.isActive, true, "driver.is_active must be independent of users.is_active");

      // ...but auth still fails independently for the now-inactive user.
      const loginAttempt = await loginTestUser(app, linkable.email, linkable.password);
      assert.equal(loginAttempt.status, 401);

      await setUserActive(linkable.id, true);
    });

    test("failed create (non-DRIVER-role user) leaves no partial driver or cash-account row", async () => {
      const nonDriverUser = await createTestUser("DISPATCHER");
      cleanup.userIds.push(nonDriverUser.id);

      const res = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.admin))
        .send({ driverNumber: `PH54-NOPARTIAL-${uniqueSuffix()}`, userId: nonDriverUser.id });
      assert.equal(res.status, 400);

      const driverRow = await prisma.drivers.findUnique({ where: { user_id: nonDriverUser.id } });
      assert.equal(driverRow, null, "no driver row may exist after a rejected link attempt");
    });

    test("concurrent duplicate driverNumber creates: exactly one succeeds, exactly one driver + one cash account exist", async () => {
      const driverNumber = `PH54-RACE-DRV-${uniqueSuffix()}`;
      const userA = await newLinkableDriverUser();
      const userB = await newLinkableDriverUser();

      const [first, second] = await Promise.all([
        request(app).post("/api/v1/drivers").set(auth(tokens.admin)).send({ driverNumber, userId: userA.id }),
        request(app).post("/api/v1/drivers").set(auth(tokens.admin)).send({ driverNumber, userId: userB.id }),
      ]);

      const statuses = [first.status, second.status].sort();
      assert.deepEqual(statuses, [201, 409]);

      const winner = first.status === 201 ? first : second;
      cleanup.driverIds.push(winner.body.data.id);

      const matchingDrivers = await prisma.drivers.findMany({ where: { driver_number: driverNumber } });
      assert.equal(matchingDrivers.length, 1);

      const accounts = await prisma.driver_cash_accounts.findMany({ where: { driver_id: matchingDrivers[0].id } });
      assert.equal(accounts.length, 1, "no orphan cash account from the losing concurrent request");

      // The losing user must remain unlinked — no partial driver row for it.
      const loserUserId = matchingDrivers[0].user_id === userA.id ? userB.id : userA.id;
      const loserDriverRow = await prisma.drivers.findUnique({ where: { user_id: loserUserId } });
      assert.equal(loserDriverRow, null);
    });

    test("concurrent duplicate userId link: exactly one succeeds, exactly one driver + one cash account exist for that user", async () => {
      const sharedUser = await newLinkableDriverUser();

      const [first, second] = await Promise.all([
        request(app)
          .post("/api/v1/drivers")
          .set(auth(tokens.admin))
          .send({ driverNumber: `PH54-RACEUSER-A-${uniqueSuffix()}`, userId: sharedUser.id }),
        request(app)
          .post("/api/v1/drivers")
          .set(auth(tokens.admin))
          .send({ driverNumber: `PH54-RACEUSER-B-${uniqueSuffix()}`, userId: sharedUser.id }),
      ]);

      const statuses = [first.status, second.status].sort();
      assert.deepEqual(statuses, [201, 409]);

      const winner = first.status === 201 ? first : second;
      cleanup.driverIds.push(winner.body.data.id);

      const matchingDrivers = await prisma.drivers.findMany({ where: { user_id: sharedUser.id } });
      assert.equal(matchingDrivers.length, 1);

      const accounts = await prisma.driver_cash_accounts.findMany({ where: { driver_id: matchingDrivers[0].id } });
      assert.equal(accounts.length, 1);
    });
  });

  // ===========================================================
  // 5. REFERENCE-DATA INTEGRATION
  // ===========================================================

  describe("Reference-data integration", () => {
    test("canonical 5 payment methods remain present with immutable codes", async () => {
      const res = await request(app).get("/api/v1/settings/payment-methods").set(auth(tokens.admin));
      assert.equal(res.status, 200);
      const byCode: Record<string, unknown> = Object.fromEntries(
        res.body.data.map((pm: { code: string }) => [pm.code, pm])
      );
      for (const code of ["CASH", "CARD", "BANK_TRANSFER", "WHISH", "OTHER"]) {
        assert.ok(byCode[code], `expected canonical payment method ${code}`);
      }

      // Scoped to the exact canonical codes rather than "count minus one
      // prefix exclusion" — the latter flaked whenever another concurrently
      // running test file created a payment method fixture under a
      // different prefix (e.g. Phase 6.7's PH67-PM-*), which a bare
      // not-startsWith("PH54") filter does not exclude.
      const dbCount = await prisma.payment_methods.count({
        where: { code: { in: ["CASH", "CARD", "BANK_TRANSFER", "WHISH", "OTHER"] } },
      });
      assert.equal(dbCount, 5);
    });

    test("payment method deactivation preserves the row (no delete) and id/createdAt remain immutable", async () => {
      const suffix = uniqueSuffix();
      const created = await request(app)
        .post("/api/v1/settings/payment-methods")
        .set(auth(tokens.admin))
        .send({ code: `PH54_PM_${suffix}`, name: `Phase54 PM ${suffix}` });
      assert.equal(created.status, 201);
      cleanup.paymentMethodIds.push(created.body.data.id);
      const originalId = created.body.data.id;
      const originalCreatedAt = created.body.data.createdAt;

      const deactivated = await request(app)
        .patch(`/api/v1/settings/payment-methods/${originalId}`)
        .set(auth(tokens.admin))
        .send({ isActive: false, id: "00000000-0000-0000-0000-000000000000", createdAt: "2000-01-01T00:00:00.000Z" });
      assert.equal(deactivated.status, 200);
      assert.equal(deactivated.body.data.isActive, false);
      assert.equal(deactivated.body.data.id, originalId);
      assert.equal(deactivated.body.data.createdAt, originalCreatedAt);

      const row = await prisma.payment_methods.findUnique({ where: { id: originalId } });
      assert.ok(row, "deactivation must not delete the row");
      assert.equal(row.is_active, false);
    });

    test("canonical 8 failed delivery reasons remain present; Other.requiresNotes stays true", async () => {
      const res = await request(app).get("/api/v1/settings/failed-delivery-reasons").set(auth(tokens.admin));
      assert.equal(res.status, 200);
      const byName: Record<string, { requiresNotes: boolean }> = Object.fromEntries(
        res.body.data.map((r: { name: string; requiresNotes: boolean }) => [r.name, r])
      );
      assert.equal(byName["Other"]?.requiresNotes, true);

      // Scoped to the exact canonical names rather than "count minus one
      // prefix exclusion" — the latter flaked whenever another concurrently
      // running test file created a failed_delivery_reasons fixture under a
      // different prefix (e.g. Phase 7.4's "Phase74 ..." reasons), which a
      // bare not-startsWith("Phase54") filter does not exclude. Same fix
      // already applied to the analogous payment_methods count above.
      const dbCount = await prisma.failed_delivery_reasons.count({
        where: {
          name: {
            in: [
              "Receiver did not answer",
              "Receiver unavailable",
              "Receiver refused",
              "Incorrect address",
              "Incomplete address",
              "Customer requested rescheduling",
              "Unable to contact receiver",
              "Other",
            ],
          },
        },
      });
      assert.equal(dbCount, 8);
    });

    test("failed delivery reason deactivation preserves the row and id/createdAt remain immutable", async () => {
      const suffix = uniqueSuffix();
      const created = await request(app)
        .post("/api/v1/settings/failed-delivery-reasons")
        .set(auth(tokens.admin))
        .send({ name: `Phase54 Reason ${suffix}` });
      cleanup.failedReasonIds.push(created.body.data.id);
      const originalId = created.body.data.id;
      const originalCreatedAt = created.body.data.createdAt;

      const deactivated = await request(app)
        .patch(`/api/v1/settings/failed-delivery-reasons/${originalId}`)
        .set(auth(tokens.admin))
        .send({ isActive: false, id: "00000000-0000-0000-0000-000000000000", createdAt: "2000-01-01T00:00:00.000Z" });
      assert.equal(deactivated.status, 200);
      assert.equal(deactivated.body.data.id, originalId);
      assert.equal(deactivated.body.data.createdAt, originalCreatedAt);

      const row = await prisma.failed_delivery_reasons.findUnique({ where: { id: originalId } });
      assert.ok(row, "deactivation must not delete the row");
    });

    test("areas: temporary lifecycle is clean and search/sort ordering is deterministic across repeated requests", async () => {
      const marker = `ph54-order-${uniqueSuffix()}`;
      const created = await Promise.all(
        [3, 1, 2].map((sortOrder) =>
          request(app)
            .post("/api/v1/settings/areas")
            .set(auth(tokens.admin))
            .send({ name: `${marker}-${sortOrder}`, sortOrder })
        )
      );
      for (const c of created) {
        assert.equal(c.status, 201);
        cleanup.areaIds.push(c.body.data.id);
      }

      const first = await request(app).get(`/api/v1/settings/areas?search=${marker}`).set(auth(tokens.admin));
      const second = await request(app).get(`/api/v1/settings/areas?search=${marker}`).set(auth(tokens.admin));
      assert.equal(first.status, 200);
      assert.deepEqual(
        first.body.data.map((a: { id: string }) => a.id),
        second.body.data.map((a: { id: string }) => a.id),
        "repeated identical requests must return the same order"
      );
      assert.deepEqual(
        first.body.data.map((a: { sortOrder: number }) => a.sortOrder),
        [1, 2, 3]
      );
    });
  });

  // ===========================================================
  // 6. SYSTEM SETTINGS INTEGRATION
  // ===========================================================

  describe("System settings integration", () => {
    test("GET list succeeds regardless of table contents (never assumes global emptiness)", async () => {
      const res = await request(app).get("/api/v1/system-settings").set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.data));
    });

    test("GET/PATCH an unknown key -> 404, and PATCH never creates a row", async () => {
      const unknownKey = `ph54.unknown.${uniqueSuffix()}`;

      const getRes = await request(app).get(`/api/v1/system-settings/${unknownKey}`).set(auth(tokens.admin));
      assert.equal(getRes.status, 404);
      assert.equal(getRes.body.error.code, "NOT_FOUND");

      const patchRes = await request(app)
        .patch(`/api/v1/system-settings/${unknownKey}`)
        .set(auth(tokens.admin))
        .send({ value: { x: 1 } });
      assert.equal(patchRes.status, 404);
      assert.equal(patchRes.body.error.code, "NOT_FOUND");

      const row = await prisma.system_settings.findUnique({ where: { key: unknownKey } });
      assert.equal(row, null, "PATCH must never upsert an unknown key");
    });

    test("updated_by_id is server-derived and cannot be spoofed by the client", async () => {
      const setting = await seedTestSetting();
      cleanup.settingKeys.push(setting.key);

      const res = await request(app)
        .patch(`/api/v1/system-settings/${setting.key}`)
        .set(auth(tokens.admin))
        .send({ value: { changed: true }, updatedById: dispatcher.id, updated_by_id: finance.id });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.updatedBy.id, admin.id);

      const row = await prisma.system_settings.findUniqueOrThrow({ where: { key: setting.key } });
      assert.equal(row.updated_by_id, admin.id);
    });

    test("no secret-like setting value leaks in list or detail responses", async () => {
      const key = `ph54.stripe_api_key.${uniqueSuffix()}`;
      const created = await prisma.system_settings.create({ data: { key, value: { raw: "sk_live_should_not_leak" } } });
      cleanup.settingKeys.push(key);
      void created;

      const detail = await request(app).get(`/api/v1/system-settings/${key}`).set(auth(tokens.admin));
      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.isSensitive, true);
      assert.equal(detail.body.data.value, null);
      assert.doesNotMatch(JSON.stringify(detail.body), /sk_live_should_not_leak/);

      const list = await request(app).get("/api/v1/system-settings").set(auth(tokens.admin));
      assert.doesNotMatch(JSON.stringify(list.body), /sk_live_should_not_leak/);
    });

    test("no POST /api/v1/system-settings route exists", async () => {
      const res = await request(app)
        .post("/api/v1/system-settings")
        .set(auth(tokens.admin))
        .send({ key: `ph54.should-not-be-creatable.${uniqueSuffix()}`, value: {} });
      assert.equal(res.status, 404);

      const row = await prisma.system_settings.findFirst({ where: { key: { startsWith: "ph54.should-not-be-creatable" } } });
      assert.equal(row, null);
    });
  });

  // ===========================================================
  // 7. CROSS-MODULE DTO SECURITY
  // ===========================================================

  describe("Cross-module DTO security", () => {
    test("no Phase 5 response ever leaks auth secrets, session data, or raw tokens", async () => {
      const linkable = await newLinkableDriverUser();
      const driverRes = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.admin))
        .send({ driverNumber: `PH54-DTO-${uniqueSuffix()}`, userId: linkable.id });
      cleanup.driverIds.push(driverRes.body.data.id);

      const customerRes = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.dispatcher))
        .send({
          customerNumber: `PH54-DTO-CUST-${uniqueSuffix()}`,
          name: "Phase54 DTO Customer",
          primaryPhone: "+10000000012",
        });
      cleanup.customerIds.push(customerRes.body.data.id);

      const setting = await seedTestSetting();
      cleanup.settingKeys.push(setting.key);

      const [customerDetail, driverDetail, areas, paymentMethods, failedReasons, settingsList] = await Promise.all([
        request(app).get(`/api/v1/customers/${customerRes.body.data.id}`).set(auth(tokens.admin)),
        request(app).get(`/api/v1/drivers/${driverRes.body.data.id}`).set(auth(tokens.admin)),
        request(app).get("/api/v1/settings/areas").set(auth(tokens.admin)),
        request(app).get("/api/v1/settings/payment-methods").set(auth(tokens.admin)),
        request(app).get("/api/v1/settings/failed-delivery-reasons").set(auth(tokens.admin)),
        request(app).get("/api/v1/system-settings").set(auth(tokens.admin)),
      ]);

      const combined = JSON.stringify([
        customerDetail.body,
        driverDetail.body,
        areas.body,
        paymentMethods.body,
        failedReasons.body,
        settingsList.body,
      ]);

      for (const forbidden of [
        /password_hash/i,
        /refresh_token/i,
        /auth_sessions/i,
        /"passwordHash"/i,
        /portal_user_id/,
      ]) {
        assert.doesNotMatch(combined, forbidden);
      }
    });

    test("driver safe-user summary contains exactly the documented fields, nothing more", async () => {
      const linkable = await newLinkableDriverUser();
      const created = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.admin))
        .send({ driverNumber: `PH54-DTOFIELDS-${uniqueSuffix()}`, userId: linkable.id });
      cleanup.driverIds.push(created.body.data.id);

      assert.deepEqual(Object.keys(created.body.data.user).sort(), [
        "email",
        "firstName",
        "id",
        "isActive",
        "lastName",
        "phone",
      ]);
    });

    test("customer detail never exposes portal-user auth details, only the derived hasPortalAccount boolean", async () => {
      const portalUser = await createTestUser("CUSTOMER");
      cleanup.userIds.push(portalUser.id);

      const created = await prisma.customers.create({
        data: {
          customer_number: `PH54-PORTAL-${uniqueSuffix()}`,
          name: "Phase54 Portal Customer",
          primary_phone: "+10000000013",
          portal_user_id: portalUser.id,
          created_by_id: admin.id,
        },
      });
      await prisma.customer_wallets.create({ data: { customer_id: created.id } });
      cleanup.customerIds.push(created.id);

      const detail = await request(app).get(`/api/v1/customers/${created.id}`).set(auth(tokens.admin));
      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.hasPortalAccount, true);
      assert.doesNotMatch(JSON.stringify(detail.body), /portalUserId/);
      assert.doesNotMatch(JSON.stringify(detail.body), /portal_user_id/);
    });
  });

  // ===========================================================
  // 8. ACTIVATION-STATE INDEPENDENCE
  // ===========================================================

  describe("Activation-state independence", () => {
    test("customer.is_active does not cascade to its portal user's is_active", async () => {
      const portalUser = await createTestUser("CUSTOMER");
      cleanup.userIds.push(portalUser.id);
      const created = await prisma.customers.create({
        data: {
          customer_number: `PH54-CASCADE-${uniqueSuffix()}`,
          name: "Phase54 Cascade Customer",
          primary_phone: "+10000000014",
          portal_user_id: portalUser.id,
          created_by_id: admin.id,
        },
      });
      await prisma.customer_wallets.create({ data: { customer_id: created.id } });
      cleanup.customerIds.push(created.id);

      const deactivate = await request(app)
        .patch(`/api/v1/customers/${created.id}`)
        .set(auth(tokens.dispatcher))
        .send({ isActive: false });
      assert.equal(deactivate.status, 200);

      const userRow = await prisma.users.findUniqueOrThrow({ where: { id: portalUser.id } });
      assert.equal(userRow.is_active, true, "deactivating a customer must not deactivate its portal user");
    });

    test("reference-row is_active flags are independent of each other across resources", async () => {
      const area = await createTestArea();
      cleanup.areaIds.push(area.id);
      const suffix = uniqueSuffix();
      const pm = await request(app)
        .post("/api/v1/settings/payment-methods")
        .set(auth(tokens.admin))
        .send({ code: `PH54_INDEP_${suffix}`, name: `Phase54 Independence ${suffix}` });
      cleanup.paymentMethodIds.push(pm.body.data.id);

      await request(app).patch(`/api/v1/settings/areas/${area.id}`).set(auth(tokens.admin)).send({ isActive: false });

      const pmAfter = await request(app)
        .get(`/api/v1/settings/payment-methods/${pm.body.data.id}`)
        .set(auth(tokens.admin));
      assert.equal(pmAfter.body.data.isActive, true, "deactivating an area must not affect an unrelated payment method");
    });
  });

  // ===========================================================
  // 9. IMMUTABLE / UNKNOWN FIELD BEHAVIOR (cross-resource summary)
  // ===========================================================

  describe("Immutable/unknown field behavior", () => {
    test("wallet/cash balances are not accepted fields on any Phase 5 write endpoint (black-box parse check)", async () => {
      const { CreateCustomerSchema, UpdateCustomerSchema } = await import("../../src/modules/customers/customer.schema");
      const { UpdateDriverSchema } = await import("../../src/modules/drivers/driver.schema");

      const pollutedCustomerCreate = CreateCustomerSchema.parse({
        customerNumber: `PH54-SCHEMA-${uniqueSuffix()}`,
        name: "Phase54 Schema Customer",
        primaryPhone: "+10000000016",
        wallet: { availableBalance: "999999" },
        availableBalance: "999999",
        walletBalance: "999999",
      });
      assert.ok(!("wallet" in pollutedCustomerCreate));
      assert.ok(!("availableBalance" in pollutedCustomerCreate));
      assert.ok(!("walletBalance" in pollutedCustomerCreate));

      const pollutedCustomerUpdate = UpdateCustomerSchema.parse({
        name: "still valid",
        walletBalance: "999999",
      });
      assert.ok(!("walletBalance" in pollutedCustomerUpdate));

      const pollutedDriverUpdate = UpdateDriverSchema.parse({
        isActive: true,
        cashAccount: { currentBalance: "999999" },
        currentBalance: "999999",
      });
      assert.ok(!("cashAccount" in pollutedDriverUpdate));
      assert.ok(!("currentBalance" in pollutedDriverUpdate));
    });

    test("summary: id/createdAt/created_by_id/customerNumber survive a PATCH attempt unchanged (Customer)", async () => {
      const created = await request(app)
        .post("/api/v1/customers")
        .set(auth(tokens.dispatcher))
        .send({
          customerNumber: `PH54-IMMUT-${uniqueSuffix()}`,
          name: "Phase54 Immutable Customer",
          primaryPhone: "+10000000015",
        });
      const customerId = created.body.data.id;
      cleanup.customerIds.push(customerId);

      const res = await request(app)
        .patch(`/api/v1/customers/${customerId}`)
        .set(auth(tokens.dispatcher))
        .send({
          id: "00000000-0000-0000-0000-000000000000",
          customerNumber: "SHOULD-NOT-APPLY",
          createdById: admin.id,
          createdAt: "2000-01-01T00:00:00.000Z",
          name: "Legit rename",
        });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.id, customerId);
      assert.equal(res.body.data.customerNumber, created.body.data.customerNumber);
      assert.equal(res.body.data.name, "Legit rename");

      const row = await prisma.customers.findUniqueOrThrow({ where: { id: customerId } });
      assert.equal(row.created_by_id, dispatcher.id);
    });

    test("summary: id/createdAt/driverNumber/userId survive a PATCH attempt unchanged (Driver)", async () => {
      const linkable = await newLinkableDriverUser();
      const otherUser = await newLinkableDriverUser();
      const created = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.admin))
        .send({ driverNumber: `PH54-DIMMUT-${uniqueSuffix()}`, userId: linkable.id });
      const driverId = created.body.data.id;
      cleanup.driverIds.push(driverId);

      const res = await request(app)
        .patch(`/api/v1/drivers/${driverId}`)
        .set(auth(tokens.admin))
        .send({
          id: "00000000-0000-0000-0000-000000000000",
          driverNumber: "SHOULD-NOT-APPLY",
          userId: otherUser.id,
          createdAt: "2000-01-01T00:00:00.000Z",
          isActive: false,
        });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.driverNumber, created.body.data.driverNumber);
      assert.equal(res.body.data.user.id, linkable.id);

      const row = await prisma.drivers.findUniqueOrThrow({ where: { id: driverId } });
      assert.equal(row.user_id, linkable.id);
    });
  });

  // ===========================================================
  // 10. ERROR CONTRACT CONSISTENCY
  // ===========================================================

  describe("Error contract consistency across Phase 5 resources", () => {
    const RESOURCES = [
      { name: "customers", base: "/api/v1/customers" },
      { name: "drivers", base: "/api/v1/drivers" },
      { name: "areas", base: "/api/v1/settings/areas" },
      { name: "payment-methods", base: "/api/v1/settings/payment-methods" },
      { name: "failed-delivery-reasons", base: "/api/v1/settings/failed-delivery-reasons" },
    ];

    for (const { name, base } of RESOURCES) {
      test(`${name}: malformed id -> 400, missing id -> 404, standard error envelope shape`, async () => {
        const malformed = await request(app).get(`${base}/not-a-uuid`).set(auth(tokens.admin));
        assert.equal(malformed.status, 400);
        assert.equal(malformed.body.success, false);
        assert.equal(malformed.body.error.code, "VALIDATION_ERROR");
        assert.equal(typeof malformed.body.error.message, "string");

        const missing = await request(app)
          .get(`${base}/00000000-0000-0000-0000-000000000000`)
          .set(auth(tokens.admin));
        assert.equal(missing.status, 404);
        assert.equal(missing.body.success, false);
        assert.equal(missing.body.error.code, "NOT_FOUND");
      });

      test(`${name}: unauthenticated -> 401, authenticated-without-permission -> 403`, async () => {
        const unauth = await request(app).get(base);
        assert.equal(unauth.status, 401);
        assert.equal(unauth.body.error.code, "UNAUTHORIZED");

        const forbidden = await request(app).get(base).set(auth(tokens.driver));
        assert.equal(forbidden.status, 403);
        assert.equal(forbidden.body.error.code, "FORBIDDEN");
      });
    }

    test("system-settings: malformed lookups still resolve safely (arbitrary key -> 404, not 400/500)", async () => {
      const res = await request(app)
        .get(`/api/v1/system-settings/${encodeURIComponent("weird key with spaces")}`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, "NOT_FOUND");
    });

    test("500 sanitization infrastructure still intact (no stack/message leakage) — smoke check via 400 path", async () => {
      const res = await request(app)
        .post("/api/v1/settings/areas")
        .set(auth(tokens.admin))
        .send({ name: "" });
      assert.equal(res.status, 400);
      assert.doesNotMatch(JSON.stringify(res.body), /at\s+.*\(.*:\d+:\d+\)/, "no stack trace leaked");
      assert.doesNotMatch(JSON.stringify(res.body), /prisma/i);
    });
  });

  // ===========================================================
  // 11. LIST / PAGINATION SHAPE CONSISTENCY
  // ===========================================================

  describe("List/pagination shape consistency", () => {
    test("Customers, Drivers, Areas are paginated ({data,meta}); Payment Methods, Failed Delivery Reasons, System Settings are full-list ({data} only)", async () => {
      const [customers, drivers, areas, paymentMethods, failedReasons, settings] = await Promise.all([
        request(app).get("/api/v1/customers").set(auth(tokens.admin)),
        request(app).get("/api/v1/drivers").set(auth(tokens.admin)),
        request(app).get("/api/v1/settings/areas").set(auth(tokens.admin)),
        request(app).get("/api/v1/settings/payment-methods").set(auth(tokens.admin)),
        request(app).get("/api/v1/settings/failed-delivery-reasons").set(auth(tokens.admin)),
        request(app).get("/api/v1/system-settings").set(auth(tokens.admin)),
      ]);

      for (const [label, res] of [
        ["customers", customers],
        ["drivers", drivers],
        ["areas", areas],
      ] as const) {
        assert.ok(res.body.meta, `${label} must return pagination meta`);
        assert.ok(
          ["page", "limit", "total", "totalPages"].every((k) => k in res.body.meta),
          `${label} meta must have the standard pagination shape`
        );
      }

      for (const [label, res] of [
        ["payment-methods", paymentMethods],
        ["failed-delivery-reasons", failedReasons],
        ["system-settings", settings],
      ] as const) {
        assert.equal(res.body.meta, undefined, `${label} is a small full-list catalog and must not carry pagination meta`);
        assert.ok(Array.isArray(res.body.data));
      }
    });
  });
});
