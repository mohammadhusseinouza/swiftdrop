import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
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
  seedDriverRecord,
  seedTestOrder,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Phase 11.17.6 FINAL REVIEW CORRECTION — Timeline authorization + financial
// privacy verification (task §7-§10).
//
// GET /api/v1/orders/:id/timeline is orders.read-gated, identical to every
// other Order Detail read (GET /orders/:id, GET /orders/:id/history, GET
// /orders/:id/parcel-collection) — no portal-family middleware, no
// ownership check, no finance.read distinction. Its FINANCIAL_EVENT entries
// are a direct re-shaping of the ALREADY-approved OrderDetail.financialEvents
// (order.types.ts's OrderFinancialEvent — orders.read-gated since the Phase
// 11.5 correction, deliberately excluding idempotency keys, reversal-link
// internals and running balances). This suite proves the timeline endpoint
// introduces NO additional financial exposure beyond what a Dispatcher
// (orders.read, no finance.read) already sees today via Order Detail.
// ============================================================

const FORBIDDEN_SUBSTRINGS = [
  "reversalOfId",
  "reversal_of_id",
  "driverCashAccount",
  "driver_cash_account",
  "settlementNumber",
  "settlement_number",
  "payoutNumber",
  "payout_number",
  "idempotencyKey",
  "idempotency_key",
  "balanceBefore",
  "balanceAfter",
  "balance_before",
  "balance_after",
  "runningBalance",
  "password",
  "passwordHash",
  "password_hash",
  "token",
  "secret",
  "refreshToken",
];

describe("Timeline authorization + financial privacy (Phase 11.17.6 final review)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driverActor: TestUser;
  let customerActor: TestUser;
  let tokens: Record<string, string>;
  let area: { id: string; name: string };
  let customerId: string;

  const orderIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdAreaIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdDriverUserIds: string[] = [];

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

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
    for (const [role, token] of Object.entries(tokens)) assert.ok(token, `expected a token for ${role}`);

    area = await createTestArea();
    createdAreaIds.push(area.id);
    customerId = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(customerId);
  });

  after(async () => {
    for (const id of orderIds) await cleanupTestOrder(id);
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    for (const id of createdDriverUserIds) await cleanupTestUser(id);
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    for (const id of createdAreaIds) await cleanupTestArea(id);
    await Promise.all([admin, dispatcher, finance, driverActor, customerActor].map((u) => cleanupTestUser(u.id)));
  });

  /** Creates an exact DELIVERY_ONLY finalized delivery — produces Driver
   *  Cash + Wallet + Company delivery-fee FINANCIAL_EVENT timeline entries. */
  async function createFinalizedDeliveryOrder(): Promise<string> {
    const driverUser = await createTestUser("DRIVER");
    createdDriverUserIds.push(driverUser.id);
    const driverId = await seedDriverRecord(driverUser.id);
    createdDriverIds.push(driverId);
    const driverLogin = await loginTestUser(app, driverUser.email, driverUser.password);

    const orderId = await seedTestOrder(customerId, admin.id, {
      areaId: area.id,
      areaName: area.name,
      orderType: "DELIVERY_ONLY",
    });
    orderIds.push(orderId);

    const assign = await request(app).post(`/api/v1/orders/${orderId}/assign`).set(auth(tokens.admin)).send({ driverId });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));
    const pickup = await request(app).post(`/api/v1/driver/orders/${orderId}/pickup`).set(auth(driverLogin.accessToken as string));
    assert.equal(pickup.status, 200, JSON.stringify(pickup.body));
    const start = await request(app).post(`/api/v1/driver/orders/${orderId}/start-delivery`).set(auth(driverLogin.accessToken as string));
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const deliver = await request(app)
      .post(`/api/v1/driver/orders/${orderId}/deliver`)
      .set(auth(driverLogin.accessToken as string))
      .send({ actualAmountCollected: "105.00" });
    assert.equal(deliver.status, 200, JSON.stringify(deliver.body));

    return orderId;
  }

  test("route middleware chain: authenticate -> authorize(orders.read) -> validate -> controller (no portal/ownership gate, matches GET /orders/:id)", async () => {
    const orderId = await createFinalizedDeliveryOrder();

    const unauth = await request(app).get(`/api/v1/orders/${orderId}/timeline`);
    assert.equal(unauth.status, 401);

    const asDriver = await request(app).get(`/api/v1/orders/${orderId}/timeline`).set(auth(tokens.driver));
    assert.equal(asDriver.status, 403, "DRIVER role lacks orders.read and must not gain Management timeline access");

    const asCustomer = await request(app).get(`/api/v1/orders/${orderId}/timeline`).set(auth(tokens.customer));
    assert.equal(asCustomer.status, 403, "CUSTOMER role lacks orders.read and must not gain Management timeline access");

    for (const role of ["admin", "dispatcher", "finance"] as const) {
      const res = await request(app).get(`/api/v1/orders/${orderId}/timeline`).set(auth(tokens[role]));
      assert.equal(res.status, 200, `${role} (holds orders.read) must succeed`);
    }
  });

  test("ADMIN / DISPATCHER / FINANCE receive the identical timeline shape and event set", async () => {
    const orderId = await createFinalizedDeliveryOrder();

    const [adminRes, dispatcherRes, financeRes] = await Promise.all(
      (["admin", "dispatcher", "finance"] as const).map((role) =>
        request(app).get(`/api/v1/orders/${orderId}/timeline`).set(auth(tokens[role])),
      ),
    );
    for (const res of [adminRes, dispatcherRes, financeRes]) assert.equal(res.status, 200);

    // Byte-identical response — DISPATCHER (no finance.read) does not
    // receive a stripped-down or an enriched view relative to FINANCE/ADMIN.
    assert.deepEqual(dispatcherRes.body, adminRes.body);
    assert.deepEqual(dispatcherRes.body, financeRes.body);

    const events = adminRes.body.data as Array<{ type: string; ledger: string | null; financialType: string | null }>;
    const financial = events.filter((e) => e.type === "FINANCIAL_EVENT");
    assert.ok(financial.length >= 1, "expected at least one FINANCIAL_EVENT (Driver Cash collection)");
    // Every financial entry's `ledger`/`financialType` are the same safe
    // symbolic names as the approved OrderDetail.financialEvents contract.
    for (const f of financial) {
      assert.ok(["DRIVER_CASH", "WALLET", "COMPANY_FINANCE"].includes(f.ledger as string));
    }
  });

  test("no forbidden financial-internal keys anywhere in the timeline response, for any authorized role", async () => {
    const orderId = await createFinalizedDeliveryOrder();

    for (const role of ["admin", "dispatcher", "finance"] as const) {
      const res = await request(app).get(`/api/v1/orders/${orderId}/timeline`).set(auth(tokens[role]));
      assert.equal(res.status, 200);
      const serialized = JSON.stringify(res.body);
      for (const term of FORBIDDEN_SUBSTRINGS) {
        assert.ok(!serialized.includes(term), `${role} response leaked forbidden term "${term}"`);
      }
    }
  });

  test("timeline FINANCIAL_EVENT fields are a strict subset of the approved Order Detail financial contract", async () => {
    const orderId = await createFinalizedDeliveryOrder();
    const [timelineRes, detailRes] = await Promise.all([
      request(app).get(`/api/v1/orders/${orderId}/timeline`).set(auth(tokens.dispatcher)),
      request(app).get(`/api/v1/orders/${orderId}`).set(auth(tokens.dispatcher)),
    ]);
    assert.equal(timelineRes.status, 200);
    assert.equal(detailRes.status, 200);

    const timelineFinancial = (timelineRes.body.data as Array<{ type: string; id: string; amount: string | null }>).filter(
      (e) => e.type === "FINANCIAL_EVENT",
    );
    const detailFinancial = detailRes.body.data.financialEvents as Array<{ id: string; signedAmount: string }>;

    // Every timeline financial event id traces back to an approved
    // order.financialEvents row (id prefixed "finance:<rowId>") — never a
    // synthesized or additional financial record.
    const detailIds = new Set(detailFinancial.map((e) => e.id));
    for (const ev of timelineFinancial) {
      const rawId = ev.id.replace(/^finance:/, "");
      assert.ok(detailIds.has(rawId), `timeline financial event ${ev.id} must trace to an approved OrderDetail.financialEvents row`);
    }
    assert.equal(timelineFinancial.length, detailFinancial.length);

    // Field set is a strict subset of the wide OrderTimelineEvent DTO — no
    // ledger-internal-only field (e.g. a raw table name) is present.
    for (const ev of timelineRes.body.data as Array<Record<string, unknown>>) {
      assert.deepEqual(
        Object.keys(ev).sort(),
        [
          "id",
          "type",
          "occurredAt",
          "actor",
          "driver",
          "toDriver",
          "fromStatus",
          "toStatus",
          "endReason",
          "attemptNumber",
          "outcome",
          "reason",
          "notes",
          "amount",
          "ledger",
          "financialType",
        ].sort(),
      );
    }
  });
});
