import "../helpers/setup";
import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { FINANCIAL_RELEASE_ACTIVATION_SETTING_KEY } from "../../src/modules/financial-release/financial-release.service";
import {
  ACTIVATION_AUTHORIZATION_ENV,
  FINANCIAL_RELEASE_CONTRACT_VERSION,
  allocationLimitVerdict,
  latencyStats,
  percentile,
  probeClientContract,
  recommendedAllocationLimit,
} from "../../src/modules/financial-release/financial-release-activation.service";
import {
  cleanupTestArea,
  cleanupTestCustomerRecord,
  cleanupTestDriverRecord,
  cleanupTestOrder,
  cleanupTestUser,
  createTestArea,
  createTestUser,
  loginTestUser,
  seedCustomerRecord,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// FR.11A — Admin-only activation endpoint + hard gate G0–G7
// Contract: docs/settlement-financial-release-contract.md §10
//
// FINANCIAL_RELEASE_ACTIVATION_AUTHORIZED is never set by the environment
// of this suite; tests that need G0 to pass set it in-process only and
// always restore it. The activation setting row (value, updated_by_id,
// updated_at) is restored after every test.
// ============================================================

const KEY = FINANCIAL_RELEASE_ACTIVATION_SETTING_KEY;
const BASE = "/api/v1/admin/financial-release";

describe("Financial release activation (FR.11A)", () => {
  let app: Express;
  let admin: TestUser;
  let finance: TestUser;
  let dispatcher: TestUser;
  let tokens: { admin: string; finance: string; dispatcher: string };
  let original: { value: unknown; updated_by_id: string | null; updated_at: Date };
  let clientServer: http.Server;
  let clientBody: string | null = null;
  let clientUrl: string;
  const savedEnv = { authorized: process.env[ACTIVATION_AUTHORIZATION_ENV], clientUrl: process.env.CLIENT_URL };

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const setting = () => prisma.system_settings.findUniqueOrThrow({ where: { key: KEY } });
  const activationAudits = () =>
    prisma.audit_logs.count({ where: { action: { in: ["FINANCIAL_RELEASE_ACTIVATED", "FINANCIAL_RELEASE_DEACTIVATED"] }, actor_user_id: admin.id } });

  before(async () => {
    assert.notEqual(savedEnv.authorized, "true", "the suite must not run with activation authorized by the environment");
    app = createApp();
    admin = await createTestUser("ADMIN");
    finance = await createTestUser("FINANCE");
    dispatcher = await createTestUser("DISPATCHER");
    const [a, f, d] = await Promise.all([admin, finance, dispatcher].map((u) => loginTestUser(app, u.email, u.password)));
    tokens = { admin: a.accessToken as string, finance: f.accessToken as string, dispatcher: d.accessToken as string };
    const row = await setting();
    assert.equal(row.value, false);
    original = { value: row.value, updated_by_id: row.updated_by_id, updated_at: row.updated_at };

    // A stand-in for the deployed client build's /version.json (G7).
    clientServer = http.createServer((req, res) => {
      if (req.url === "/version.json" && clientBody !== null) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(clientBody);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => clientServer.listen(0, "127.0.0.1", resolve));
    clientUrl = `http://127.0.0.1:${(clientServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    if (savedEnv.authorized === undefined) delete process.env[ACTIVATION_AUTHORIZATION_ENV];
    else process.env[ACTIVATION_AUTHORIZATION_ENV] = savedEnv.authorized;
    if (savedEnv.clientUrl === undefined) delete process.env.CLIENT_URL;
    else process.env.CLIENT_URL = savedEnv.clientUrl;
    clientBody = null;
    await prisma.system_settings.update({
      where: { key: KEY },
      data: { value: original.value as boolean, updated_by_id: original.updated_by_id, updated_at: original.updated_at },
    });
  });

  after(async () => {
    await prisma.audit_logs.deleteMany({
      where: { action: { in: ["FINANCIAL_RELEASE_ACTIVATED", "FINANCIAL_RELEASE_DEACTIVATED"] }, actor_user_id: admin.id },
    });
    await new Promise<void>((resolve) => clientServer.close(() => resolve()));
    await Promise.all([admin, finance, dispatcher].map((u) => cleanupTestUser(u.id)));
    assert.equal((await setting()).value, false);
  });

  describe("authorization", () => {
    const routes: [method: "get" | "post", path: string][] = [
      ["get", BASE],
      ["get", `${BASE}/readiness`],
      ["post", `${BASE}/activate`],
      ["post", `${BASE}/deactivate`],
    ];

    test("1. unauthenticated requests are rejected with 401", async () => {
      for (const [method, path] of routes) {
        const res = await request(app)[method](path).send();
        assert.equal(res.status, 401, `${method} ${path}`);
      }
    });

    test("2. FINANCE and DISPATCHER are rejected with 403 (Admin role only) and nothing changes", async () => {
      for (const token of [tokens.finance, tokens.dispatcher]) {
        for (const [method, path] of routes) {
          const res = await request(app)[method](path).set(auth(token)).send();
          assert.equal(res.status, 403, `${method} ${path}`);
        }
      }
      assert.equal((await setting()).value, false);
      assert.equal(await activationAudits(), 0);
    });

    test("3. the generic settings PATCH still rejects the activation key", async () => {
      const res = await request(app).patch(`/api/v1/system-settings/${encodeURIComponent(KEY)}`).set(auth(tokens.admin)).send({ value: true });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.error.details.reason, "SETTING_MANAGED_ELSEWHERE");
      assert.equal((await setting()).value, false);
    });

    test("4. activate / deactivate accept no request body fields", async () => {
      for (const path of [`${BASE}/activate`, `${BASE}/deactivate`]) {
        const res = await request(app).post(path).set(auth(tokens.admin)).send({ force: true });
        assert.equal(res.status, 400, path);
      }
      assert.equal((await setting()).value, false);
    });
  });

  describe("state and readiness", () => {
    test("5. state reports disabled, not environment-authorized, and the server contract version", async () => {
      const res = await request(app).get(BASE).set(auth(tokens.admin));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.enabled, false);
      assert.equal(res.body.data.environmentAuthorized, false);
      assert.equal(res.body.data.serverContractVersion, FINANCIAL_RELEASE_CONTRACT_VERSION);
    });

    test("6. readiness is a dry run: G0 fails, G1 passes, every gate is reported, nothing is written", async () => {
      const before = await setting();
      const res = await request(app).get(`${BASE}/readiness`).set(auth(tokens.admin));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const report = res.body.data;
      assert.equal(report.ready, false);
      assert.deepEqual(
        report.gates.map((g: { id: string }) => g.id),
        ["G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7"]
      );
      const byId = Object.fromEntries(report.gates.map((g: { id: string }) => [g.id, g]));
      assert.equal(byId.G0.passed, false);
      assert.equal(byId.G1.passed, true, JSON.stringify(byId.G1));
      assert.ok(report.failedGates.includes("G0"));
      assert.ok(Array.isArray(report.historicalFindings));
      for (const h of report.historicalFindings) assert.match(h.id, /^H\d+$/);
      const afterRow = await setting();
      assert.equal(afterRow.value, false);
      assert.equal(afterRow.updated_at.getTime(), before.updated_at.getTime());
      assert.equal(await activationAudits(), 0);
    });

    test("7. G7 is evaluated against the deployed client's /version.json", async () => {
      delete process.env.CLIENT_URL;
      assert.match((await probeClientContract()).problem ?? "", /CLIENT_URL is not configured/);

      process.env.CLIENT_URL = clientUrl;
      assert.match((await probeClientContract()).problem ?? "", /HTTP 404/);

      clientBody = JSON.stringify({ app: "swiftdrop-client", financialReleaseContract: "FR.10" });
      const old = await request(app).get(`${BASE}/readiness`).set(auth(tokens.admin));
      const g7old = old.body.data.gates.find((g: { id: string }) => g.id === "G7");
      assert.equal(g7old.passed, false);
      assert.match(g7old.detail, /declares FR\.10/);

      clientBody = JSON.stringify({ app: "swiftdrop-client", financialReleaseContract: FINANCIAL_RELEASE_CONTRACT_VERSION });
      const ok = await request(app).get(`${BASE}/readiness`).set(auth(tokens.admin));
      assert.equal(ok.body.data.gates.find((g: { id: string }) => g.id === "G7").passed, true);
    });
  });

  describe("activation", () => {
    test("8. without environment authorization activation is rejected (G0) without any change", async () => {
      process.env.CLIENT_URL = clientUrl;
      clientBody = JSON.stringify({ financialReleaseContract: FINANCIAL_RELEASE_CONTRACT_VERSION });
      for (const value of [undefined, "1", "TRUE", "yes"]) {
        if (value === undefined) delete process.env[ACTIVATION_AUTHORIZATION_ENV];
        else process.env[ACTIVATION_AUTHORIZATION_ENV] = value;
        const res = await request(app).post(`${BASE}/activate`).set(auth(tokens.admin)).send();
        assert.equal(res.status, 409, `${value}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.error.details.reason, "ACTIVATION_GATE_FAILED");
        assert.deepEqual(res.body.error.details.failedGates, ["G0"]);
      }
      assert.equal((await setting()).value, false);
      assert.equal(await activationAudits(), 0);
    });

    test("9. with G0 authorized in-process, any failing data gate still rejects activation and changes nothing", async () => {
      process.env[ACTIVATION_AUTHORIZATION_ENV] = "true";
      // No client configured -> G7 fails at minimum, whatever the data gates say.
      delete process.env.CLIENT_URL;
      const before = await setting();
      const res = await request(app).post(`${BASE}/activate`).set(auth(tokens.admin)).send();
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.error.details.reason, "ACTIVATION_GATE_FAILED");
      assert.ok(res.body.error.details.failedGates.includes("G7"));
      assert.ok(!res.body.error.details.failedGates.includes("G0"));
      assert.equal(res.body.error.details.gates.length, 8);
      const afterRow = await setting();
      assert.equal(afterRow.value, false);
      assert.equal(afterRow.updated_at.getTime(), before.updated_at.getTime());
      assert.equal(await activationAudits(), 0);
    });

    test("10. activation when already enabled is a no-op (no gate evaluation, no audit)", async () => {
      process.env[ACTIVATION_AUTHORIZATION_ENV] = "true";
      await prisma.system_settings.update({ where: { key: KEY }, data: { value: true } });
      const res = await request(app).post(`${BASE}/activate`).set(auth(tokens.admin)).send();
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.changed, false);
      assert.equal(res.body.data.state.enabled, true);
      assert.equal(await activationAudits(), 0);
    });
  });

  describe("deactivation", () => {
    test("11. deactivation is always allowed (no environment authorization), audited once, and idempotent", async () => {
      await prisma.system_settings.update({ where: { key: KEY }, data: { value: true } });
      const res = await request(app).post(`${BASE}/deactivate`).set(auth(tokens.admin)).send();
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.changed, true);
      assert.equal(res.body.data.state.enabled, false);
      const row = await setting();
      assert.equal(row.value, false);
      assert.equal(row.updated_by_id, admin.id);
      const audit = await prisma.audit_logs.findFirstOrThrow({ where: { action: "FINANCIAL_RELEASE_DEACTIVATED", actor_user_id: admin.id } });
      assert.equal(audit.entity_type, "SYSTEM_SETTING");
      assert.equal(audit.entity_id, row.id);

      const again = await request(app).post(`${BASE}/deactivate`).set(auth(tokens.admin)).send();
      assert.equal(again.status, 200);
      assert.equal(again.body.data.changed, false);
      assert.equal(await activationAudits(), 1);
    });
  });
});

describe("Database latency probe and allocation-limit model (FR.11B)", () => {
  let app: Express;
  let admin: TestUser;
  let finance: TestUser;
  let tokens: { admin: string; finance: string };
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    finance = await createTestUser("FINANCE");
    const [a, f] = await Promise.all([admin, finance].map((u) => loginTestUser(app, u.email, u.password)));
    tokens = { admin: a.accessToken as string, finance: f.accessToken as string };
  });

  after(async () => {
    await Promise.all([admin, finance].map((u) => cleanupTestUser(u.id)));
  });

  test("13. nearest-rank percentiles and the recommended limit follow the FR.11A model; 20 is never exceeded", () => {
    const s = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(percentile(s, 50), 50);
    assert.equal(percentile(s, 95), 95);
    assert.equal(percentile(s, 99), 99);
    assert.equal(percentile([7], 95), 7);
    assert.equal(recommendedAllocationLimit(5), 20);
    assert.equal(recommendedAllocationLimit(20), 20);
    assert.equal(recommendedAllocationLimit(25), 17);
    assert.equal(recommendedAllocationLimit(30), 12);
    assert.equal(recommendedAllocationLimit(40), 7);
    assert.equal(recommendedAllocationLimit(50), 4);
    assert.equal(recommendedAllocationLimit(70), 0);
    assert.equal(allocationLimitVerdict(20), "LIMIT_CONFIRMED");
    assert.equal(allocationLimitVerdict(12), "REDUCE_LIMIT");
    assert.equal(allocationLimitVerdict(0), "DO_NOT_ACTIVATE");
    const stats = latencyStats([3, 1, 2, 4]);
    assert.deepEqual([stats.minMs, stats.p50Ms, stats.maxMs, stats.samples], [1, 2, 4, 4]);
  });

  test("14. the probe is Admin-only, validates its sample count, and only reads", async () => {
    assert.equal((await request(app).get(`${BASE}/latency-probe`).set(auth(tokens.finance))).status, 403);
    assert.equal((await request(app).get(`${BASE}/latency-probe?samples=10`).set(auth(tokens.admin))).status, 400);
    assert.equal((await request(app).get(`${BASE}/latency-probe?samples=501`).set(auth(tokens.admin))).status, 400);
    const before = await prisma.system_settings.findUniqueOrThrow({ where: { key: KEY } });
    const auditsBefore = await prisma.audit_logs.count();
    const res = await request(app).get(`${BASE}/latency-probe?samples=50`).set(auth(tokens.admin));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const r = res.body.data;
    assert.equal(r.singleStatement.samples, 50);
    assert.equal(r.inTransaction.samples, 50);
    assert.equal(r.inTransactionError, null);
    assert.ok(r.singleStatement.p95Ms >= r.singleStatement.p50Ms);
    assert.equal(r.currentMaxAllocations, 20);
    assert.ok(r.recommendedMaxAllocations <= 20);
    assert.ok(["LIMIT_CONFIRMED", "REDUCE_LIMIT", "DO_NOT_ACTIVATE"].includes(r.verdict));
    const afterRow = await prisma.system_settings.findUniqueOrThrow({ where: { key: KEY } });
    assert.equal(afterRow.updated_at.getTime(), before.updated_at.getTime());
    assert.equal(await prisma.audit_logs.count(), auditsBefore);
  });
});

describe("Deactivation preserves settlement-mode processing (FR.11A)", () => {
  let app: Express;
  let admin: TestUser;
  let finance: TestUser;
  let driverUser: TestUser;
  let tokens: { admin: string; finance: string; driver: string };
  let customerId: string;
  let area: { id: string; name: string };
  let cashMethodId: string;
  let driverId: string;
  let original: { value: unknown; updated_by_id: string | null; updated_at: Date };
  const orderIds: string[] = [];
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    finance = await createTestUser("FINANCE");
    driverUser = await createTestUser("DRIVER");
    const [a, f, d] = await Promise.all([admin, finance, driverUser].map((u) => loginTestUser(app, u.email, u.password)));
    tokens = { admin: a.accessToken as string, finance: f.accessToken as string, driver: d.accessToken as string };
    const row = await prisma.system_settings.findUniqueOrThrow({ where: { key: KEY } });
    assert.equal(row.value, false);
    original = { value: row.value, updated_by_id: row.updated_by_id, updated_at: row.updated_at };
    customerId = await seedCustomerRecord(admin.id);
    area = await createTestArea();
    cashMethodId = (await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } })).id;
    const res = await request(app).post("/api/v1/drivers").set(auth(tokens.admin)).send({ userId: driverUser.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    driverId = res.body.data.id;
  });

  after(async () => {
    await prisma.system_settings.update({
      where: { key: KEY },
      data: { value: false, updated_by_id: original.updated_by_id, updated_at: original.updated_at },
    });
    await prisma.audit_logs.deleteMany({ where: { action: "FINANCIAL_RELEASE_DEACTIVATED", actor_user_id: admin.id } });
    await prisma.audit_logs.deleteMany({ where: { entity_type: "DRIVER_SETTLEMENT", actor_user_id: finance.id } });
    for (const id of orderIds) await cleanupTestOrder(id);
    await cleanupTestDriverRecord(driverId);
    await cleanupTestCustomerRecord(customerId);
    await cleanupTestArea(area.id);
    await Promise.all([admin, finance, driverUser].map((u) => cleanupTestUser(u.id)));
  });

  test("12. an ON_SETTLEMENT order delivered before deactivation is still settled and released after it", async () => {
    const created = await request(app).post("/api/v1/orders").set(auth(tokens.admin)).send({
      customerId,
      orderType: "DELIVERY_ONLY",
      paymentType: "CASH_ON_DELIVERY",
      receiverName: "FR11 Receiver",
      receiverPhone: "+96170000111",
      receiverAreaId: area.id,
      receiverAddress: "11 FR11 St",
      description: "FR.11A order",
      orderAmount: "100.00",
      deliveryFee: "5.00",
      collectionPaymentMethodId: cashMethodId,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const orderId = created.body.data.id as string;
    orderIds.push(orderId);
    assert.equal((await request(app).post(`/api/v1/orders/${orderId}/assign`).set(auth(tokens.admin)).send({ driverId })).status, 200);
    for (const step of ["pickup", "start-delivery"]) {
      assert.equal((await request(app).post(`/api/v1/driver/orders/${orderId}/${step}`).set(auth(tokens.driver)).send()).status, 200);
    }
    // Activation on only for the delivery itself (isolated test DB).
    await prisma.system_settings.update({ where: { key: KEY }, data: { value: true } });
    try {
      const delivered = await request(app).post(`/api/v1/driver/orders/${orderId}/deliver`).set(auth(tokens.driver)).send({ actualAmountCollected: "105.00" });
      assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
    } finally {
      const off = await request(app).post(`${BASE}/deactivate`).set(auth(tokens.admin)).send();
      assert.equal(off.status, 200, JSON.stringify(off.body));
      assert.equal(off.body.data.changed, true);
    }
    const order = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
    assert.equal(order.financial_release_mode, "ON_SETTLEMENT");
    assert.equal(order.financial_status, "AWAITING_SETTLEMENT");
    const release = await prisma.order_financial_releases.findUniqueOrThrow({ where: { order_id: orderId } });

    // A legacy-format settlement still cannot consume the reserved cash.
    const legacy = await request(app)
      .post("/api/v1/driver-settlements")
      .set(auth(tokens.finance))
      .set("Idempotency-Key", `fr11a-legacy-${Date.now()}`)
      .send({ driverId, amountReceived: "105.00", paymentMethodId: cashMethodId });
    assert.equal(legacy.status, 400, JSON.stringify(legacy.body));
    assert.equal(legacy.body.error.details.reason, "ALLOCATION_CONTRACT_REQUIRED");

    const settled = await request(app)
      .post("/api/v1/driver-settlements")
      .set(auth(tokens.finance))
      .set("Idempotency-Key", `fr11a-alloc-${Date.now()}`)
      .send({ driverId, amountReceived: "105.00", paymentMethodId: cashMethodId, allocations: [{ releaseId: release.id, amount: "105.00" }] });
    assert.equal(settled.status, 201, JSON.stringify(settled.body));

    const [after, orderAfter, wallet, fee] = await Promise.all([
      prisma.order_financial_releases.findUniqueOrThrow({ where: { id: release.id } }),
      prisma.orders.findUniqueOrThrow({ where: { id: orderId } }),
      prisma.wallet_transactions.findUniqueOrThrow({ where: { idempotency_key: `delivery:${orderId}:wallet-order-credit` } }),
      prisma.company_financial_transactions.findUniqueOrThrow({ where: { idempotency_key: `delivery:${orderId}:delivery-fee-revenue` } }),
    ]);
    assert.equal(after.release_status, "RELEASED");
    assert.equal(orderAfter.financial_status, "FINALIZED");
    assert.equal(wallet.credit.toString(), "100");
    assert.equal(fee.amount.toString(), "5");
    assert.equal(after.released_at?.getTime(), orderAfter.updated_at.getTime(), "batched release timestamps use the same write path as Prisma");
    const cash = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driverId } });
    assert.equal(cash.current_balance.toString(), "0");
  });
});
