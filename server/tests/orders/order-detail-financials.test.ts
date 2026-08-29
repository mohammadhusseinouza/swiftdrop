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
  cleanupTestOrder,
  cleanupTestUser,
  createTestArea,
  createTestUser,
  loginTestUser,
  seedCustomerRecord,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Phase 11.5 correction — Management Order Detail financial contract:
//   - OrderDetail.paymentType
//   - OrderDetail.financialAllocation.{companyAmount,customerWalletAmount}
//     (authoritative NET order-scoped ledger sums — never derived from
//     orderType/amountToCollect)
//   - OrderDetail.financialEvents (normalized order-scoped ledger events for
//     the operational Order Timeline)
//
// Operational workflow correctness is already covered by Phase 6/7/8 suites;
// this file focuses purely on the new fields.
// ============================================================

describe("Order Detail — financial contract (Phase 11.5 correction)", () => {
  let app: Express;
  let admin: TestUser;
  let finance: TestUser;
  let customerActor: TestUser;
  let tokens: Record<string, string>;

  let area: { id: string; name: string };
  let cashMethodId: string;

  const createdOrderIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdUserIds: string[] = [];

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    finance = await createTestUser("FINANCE");
    customerActor = await createTestUser("CUSTOMER");

    const [adminLogin, financeLogin, customerLogin] = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, finance.email, finance.password),
      loginTestUser(app, customerActor.email, customerActor.password),
    ]);
    tokens = {
      admin: adminLogin.accessToken as string,
      finance: financeLogin.accessToken as string,
      customer: customerLogin.accessToken as string,
    };
    for (const [role, token] of Object.entries(tokens)) {
      assert.ok(token, `expected an access token for ${role}`);
    }

    area = await createTestArea();
    const cashMethod = await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } });
    cashMethodId = cashMethod.id;
  });

  after(async () => {
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    await cleanupTestArea(area.id);
    for (const id of createdUserIds) await cleanupTestUser(id);
    await Promise.all([admin, finance, customerActor].map((u) => cleanupTestUser(u.id)));
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function freshCustomer(): Promise<string> {
    const id = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(id);
    return id;
  }

  async function createDriver(label: string) {
    const user = await createTestUser("DRIVER");
    createdUserIds.push(user.id);
    const login = await loginTestUser(app, user.email, user.password);
    assert.ok(login.accessToken, `token for ${label}`);
    const res = await request(app)
      .post("/api/v1/drivers")
      .set(auth(tokens.admin))
      .send({ driverNumber: `PH115-DRV-${uniqueSuffix()}`, userId: user.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdDriverIds.push(res.body.data.id);
    return { driverId: res.body.data.id as string, token: login.accessToken as string };
  }

  async function createOrder(customerId: string, overrides: Record<string, unknown> = {}) {
    const res = await request(app)
      .post("/api/v1/orders")
      .set(auth(tokens.admin))
      .send({
        customerId,
        orderType: "DELIVERY_ONLY",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: "PH115 Receiver",
        receiverPhone: "+96170000115",
        receiverAreaId: area.id,
        receiverAddress: "1 PH115 St",
        description: "PH115 finance-contract order",
        orderAmount: "100.00",
        deliveryFee: "5.00",
        collectionPaymentMethodId: cashMethodId,
        ...overrides,
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdOrderIds.push(res.body.data.id);
    return res.body.data;
  }

  async function toOutForDelivery(customerId: string, driverToken: string, driverId: string, overrides: Record<string, unknown> = {}) {
    const order = await createOrder(customerId, overrides);
    let r = await request(app).post(`/api/v1/orders/${order.id}/assign`).set(auth(tokens.admin)).send({ driverId });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await request(app).post(`/api/v1/driver/orders/${order.id}/pickup`).set(auth(driverToken)).send();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await request(app).post(`/api/v1/driver/orders/${order.id}/start-delivery`).set(auth(driverToken)).send();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return order.id as string;
  }

  async function deliver(orderId: string, token: string, body: Record<string, unknown>) {
    const r = await request(app).post(`/api/v1/driver/orders/${orderId}/deliver`).set(auth(token)).send(body);
    return r;
  }

  async function getDetail(orderId: string, token = tokens.admin) {
    const r = await request(app).get(`/api/v1/orders/${orderId}`).set(auth(token));
    return r;
  }

  // -------------------------------------------------------------------------
  // 1. Payment Type
  // -------------------------------------------------------------------------

  describe("paymentType", () => {
    test("1. returned for CASH_ON_DELIVERY", async () => {
      const c = await freshCustomer();
      const o = await createOrder(c, { paymentType: "CASH_ON_DELIVERY" });
      const res = await getDetail(o.id);
      assert.equal(res.body.data.paymentType, "CASH_ON_DELIVERY");
    });

    test("2. returned for PARTIALLY_PAID", async () => {
      const c = await freshCustomer();
      const o = await createOrder(c, {
        paymentType: "PARTIALLY_PAID",
        prepaidOrderAmount: "30.00",
        prepaidPaymentMethodId: cashMethodId,
      });
      const res = await getDetail(o.id);
      assert.equal(res.body.data.paymentType, "PARTIALLY_PAID");
    });

    test("3. returned for ALREADY_PAID", async () => {
      const c = await freshCustomer();
      const o = await createOrder(c, {
        paymentType: "ALREADY_PAID",
        prepaidOrderAmount: "100.00",
        prepaidPaymentMethodId: cashMethodId,
      });
      const res = await getDetail(o.id);
      assert.equal(res.body.data.paymentType, "ALREADY_PAID");
    });

    test("4. PATCH response also carries paymentType (edit-seed source)", async () => {
      const c = await freshCustomer();
      const o = await createOrder(c, {
        paymentType: "PARTIALLY_PAID",
        prepaidOrderAmount: "30.00",
        prepaidPaymentMethodId: cashMethodId,
      });
      const res = await request(app)
        .patch(`/api/v1/orders/${o.id}`)
        .set(auth(tokens.admin))
        .send({ receiverName: "Edited" });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.paymentType, "PARTIALLY_PAID");
    });
  });

  // -------------------------------------------------------------------------
  // 2. Allocation — pre-finalization
  // -------------------------------------------------------------------------

  describe("financialAllocation — before any ledger posting", () => {
    test('5. fresh order: companyAmount "0", customerWalletAmount "0", financialEvents []', async () => {
      const c = await freshCustomer();
      const o = await createOrder(c);
      const res = await getDetail(o.id);
      assert.deepEqual(res.body.data.financialAllocation, {
        companyAmount: "0",
        customerWalletAmount: "0",
      });
      assert.deepEqual(res.body.data.financialEvents, []);
    });

    test('6. all-prepaid exact delivery posts NO wallet/company ledger rows -> both "0"', async () => {
      const c = await freshCustomer();
      const d = await createDriver("all-prepaid");
      const orderId = await toOutForDelivery(c, d.token, d.driverId, {
        paymentType: "ALREADY_PAID",
        orderAmount: "100.00",
        deliveryFee: "0.00",
        prepaidOrderAmount: "100.00",
        prepaidPaymentMethodId: cashMethodId,
        // amountToCollect is 0 — the backend rejects a collection method here.
        collectionPaymentMethodId: undefined,
      });
      const res = await deliver(orderId, d.token, { actualAmountCollected: "0.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const detail = await getDetail(orderId);
      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.financial_status, "FINALIZED");
      assert.deepEqual(detail.body.data.financialAllocation, {
        companyAmount: "0",
        customerWalletAmount: "0",
      });
      assert.deepEqual(detail.body.data.financialEvents, []);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Delivery Only exact
  // -------------------------------------------------------------------------

  test('7. Delivery Only exact: customerWalletAmount "100", companyAmount "5"', async () => {
    const c = await freshCustomer();
    const d = await createDriver("do-exact");
    const orderId = await toOutForDelivery(c, d.token, d.driverId);
    const res = await deliver(orderId, d.token, { actualAmountCollected: "105.00" });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const detail = await getDetail(orderId);
    assert.deepEqual(detail.body.data.financialAllocation, {
      companyAmount: "5",
      customerWalletAmount: "100",
    });

    const events = detail.body.data.financialEvents;
    assert.equal(events.length, 3, JSON.stringify(events));
    // oldest-first, deterministic ledger order for the same instant
    assert.deepEqual(
      events.map((e: { ledger: string; type: string; direction: string; amount: string }) => [e.ledger, e.type, e.direction, e.amount]),
      [
        ["DRIVER_CASH", "COLLECTION", "CREDIT", "105"],
        ["WALLET", "ORDER_CREDIT", "CREDIT", "100"],
        ["COMPANY_FINANCE", "DELIVERY_FEE_REVENUE", "CREDIT", "5"],
      ]
    );
    // no duplicate for one persisted occurrence
    assert.equal(new Set(events.map((e: { id: string }) => e.id)).size, 3);
  });

  // -------------------------------------------------------------------------
  // 4. Company Order exact
  // -------------------------------------------------------------------------

  test('8. Company Order exact: customerWalletAmount "0", companyAmount "105"', async () => {
    const c = await freshCustomer();
    const d = await createDriver("co-exact");
    const orderId = await toOutForDelivery(c, d.token, d.driverId, { orderType: "COMPANY_ORDER" });
    const res = await deliver(orderId, d.token, { actualAmountCollected: "105.00" });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const detail = await getDetail(orderId);
    assert.deepEqual(detail.body.data.financialAllocation, {
      companyAmount: "105",
      customerWalletAmount: "0",
    });
    const types = detail.body.data.financialEvents
      .map((e: { type: string }) => e.type)
      .sort();
    assert.deepEqual(types, ["COLLECTION", "COMPANY_ORDER_PRODUCT_REVENUE", "DELIVERY_FEE_REVENUE"].sort());
    // wallet never touched for a COMPANY_ORDER
    assert.ok(!detail.body.data.financialEvents.some((e: { ledger: string }) => e.ledger === "WALLET"));
  });

  test('9. Company Order partial prepayment: companyAmount = ledger-posted remaining only', async () => {
    const c = await freshCustomer();
    const d = await createDriver("co-partial");
    // prepaid product 40 -> remaining product 60 + fee 5 -> amountToCollect 65
    const orderId = await toOutForDelivery(c, d.token, d.driverId, {
      orderType: "COMPANY_ORDER",
      paymentType: "PARTIALLY_PAID",
      prepaidOrderAmount: "40.00",
      prepaidPaymentMethodId: cashMethodId,
    });
    const res = await deliver(orderId, d.token, { actualAmountCollected: "65.00" });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const detail = await getDetail(orderId);
    // 60 product + 5 fee actually posted to the company ledger — NOT the
    // theoretical full 105.
    assert.equal(detail.body.data.financialAllocation.companyAmount, "65");
    assert.equal(detail.body.data.financialAllocation.customerWalletAmount, "0");
  });

  // -------------------------------------------------------------------------
  // 5. Collection difference — before / after resolution
  // -------------------------------------------------------------------------

  describe("collection difference", () => {
    test('10. before resolution: both "0" (no guessed split); only the Driver Cash event exists', async () => {
      const c = await freshCustomer();
      const d = await createDriver("diff-before");
      const orderId = await toOutForDelivery(c, d.token, d.driverId);
      const res = await deliver(orderId, d.token, {
        actualAmountCollected: "95.00",
        collectionDifferenceReason: "short on cash",
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const detail = await getDetail(orderId);
      assert.equal(detail.body.data.financial.needsFinancialReview, true);
      assert.equal(detail.body.data.financialStatus, "REVIEW_REQUIRED");
      assert.deepEqual(detail.body.data.financialAllocation, {
        companyAmount: "0",
        customerWalletAmount: "0",
      });
      const events = detail.body.data.financialEvents;
      assert.equal(events.length, 1);
      assert.equal(events[0].ledger, "DRIVER_CASH");
      assert.equal(events[0].type, "COLLECTION");
      assert.equal(events[0].amount, "95");
    });

    test("11. after authorized resolution: allocation reflects the posted split", async () => {
      const c = await freshCustomer();
      const d = await createDriver("diff-after");
      const orderId = await toOutForDelivery(c, d.token, d.driverId);
      let res = await deliver(orderId, d.token, {
        actualAmountCollected: "95.00",
        collectionDifferenceReason: "short on cash",
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      res = await request(app)
        .post(`/api/v1/orders/${orderId}/resolve-collection-difference`)
        .set(auth(tokens.admin))
        .send({
          customerWalletCredit: "90.00",
          companyProductRevenue: "0",
          companyDeliveryFeeRevenue: "5.00",
          resolutionNotes: "customer absorbs the shortfall",
        });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const detail = await getDetail(orderId);
      assert.deepEqual(detail.body.data.financialAllocation, {
        companyAmount: "5",
        customerWalletAmount: "90",
      });
      const types = detail.body.data.financialEvents.map((e: { type: string }) => e.type).sort();
      assert.deepEqual(types, ["COLLECTION", "DELIVERY_FEE_REVENUE", "ORDER_CREDIT"].sort());
    });
  });

  // -------------------------------------------------------------------------
  // 6. Reversals / adjustments
  // -------------------------------------------------------------------------

  describe("adjustment / reversal effects", () => {
    test('12. reversing the wallet ORDER_CREDIT nets customerWalletAmount to "0"; companyAmount unchanged', async () => {
      const c = await freshCustomer();
      const d = await createDriver("wallet-rev");
      const orderId = await toOutForDelivery(c, d.token, d.driverId);
      let res = await deliver(orderId, d.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      let detail = await getDetail(orderId);
      const creditEvent = detail.body.data.financialEvents.find(
        (e: { ledger: string; type: string }) => e.ledger === "WALLET" && e.type === "ORDER_CREDIT"
      );
      assert.ok(creditEvent, "expected a wallet ORDER_CREDIT event");

      res = await request(app)
        .post(`/api/v1/wallet-transactions/${creditEvent.id}/reverse`)
        .set(auth(tokens.admin))
        .send({ reason: "posted in error" });
      assert.equal(res.status, 201, JSON.stringify(res.body));

      detail = await getDetail(orderId);
      assert.deepEqual(detail.body.data.financialAllocation, {
        companyAmount: "5",
        customerWalletAmount: "0",
      });
      const walletEvents = detail.body.data.financialEvents.filter((e: { ledger: string }) => e.ledger === "WALLET");
      assert.equal(walletEvents.length, 2);
      // The reversal renders from type + direction + amount alone — the
      // internal reversal_of_id relation is deliberately NOT in the DTO.
      const reversal = walletEvents.find((e: { type: string }) => e.type === "REVERSAL");
      assert.ok(reversal);
      assert.equal(reversal.direction, "DEBIT");
      assert.equal(reversal.amount, "100");
      assert.ok(!("reversalOfId" in reversal));
    });

    test('13. reversing the company DELIVERY_FEE_REVENUE nets companyAmount to "0"; walletAmount unchanged', async () => {
      const c = await freshCustomer();
      const d = await createDriver("company-rev");
      const orderId = await toOutForDelivery(c, d.token, d.driverId);
      let res = await deliver(orderId, d.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      let detail = await getDetail(orderId);
      const feeEvent = detail.body.data.financialEvents.find(
        (e: { ledger: string; type: string }) => e.ledger === "COMPANY_FINANCE" && e.type === "DELIVERY_FEE_REVENUE"
      );
      assert.ok(feeEvent);

      res = await request(app)
        .post(`/api/v1/finance/company-transactions/${feeEvent.id}/reverse`)
        .set(auth(tokens.admin))
        .send({ reason: "fee waived" });
      assert.equal(res.status, 201, JSON.stringify(res.body));

      detail = await getDetail(orderId);
      assert.deepEqual(detail.body.data.financialAllocation, {
        companyAmount: "0",
        customerWalletAmount: "100",
      });
      const companyEvents = detail.body.data.financialEvents.filter((e: { ledger: string }) => e.ledger === "COMPANY_FINANCE");
      assert.equal(companyEvents.length, 2);
      assert.equal(companyEvents.find((e: { type: string }) => e.type === "REVERSAL").direction, "DEBIT");
    });
  });

  // -------------------------------------------------------------------------
  // 7. Permissions + privacy
  // -------------------------------------------------------------------------

  describe("permissions + privacy", () => {
    test("14. FINANCE (orders.read) sees the full financial contract", async () => {
      const c = await freshCustomer();
      const d = await createDriver("finance-view");
      const orderId = await toOutForDelivery(c, d.token, d.driverId);
      await deliver(orderId, d.token, { actualAmountCollected: "105.00" });

      const res = await getDetail(orderId, tokens.finance);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.paymentType, "CASH_ON_DELIVERY");
      assert.deepEqual(res.body.data.financialAllocation, { companyAmount: "5", customerWalletAmount: "100" });
      assert.equal(res.body.data.financialEvents.length, 3);
    });

    test("15. financialEvents expose no ledger internals / raw table names / running balances", async () => {
      const c = await freshCustomer();
      const d = await createDriver("privacy");
      const orderId = await toOutForDelivery(c, d.token, d.driverId);
      await deliver(orderId, d.token, { actualAmountCollected: "105.00" });

      const res = await getDetail(orderId);
      const events = res.body.data.financialEvents;
      assert.equal(events.length, 3);
      for (const e of events) {
        assert.deepEqual(
          Object.keys(e).sort(),
          ["actor", "amount", "direction", "id", "ledger", "notes", "occurredAt", "signedAmount", "type"].sort()
        );
      }
      const serialized = JSON.stringify(res.body.data.financialEvents);
      assert.doesNotMatch(serialized, /idempotency/i);
      assert.doesNotMatch(serialized, /reversal_of_id|reversalOfId/i);
      assert.doesNotMatch(serialized, /balance_before|balanceBefore|balance_after|balanceAfter/i);
      assert.doesNotMatch(serialized, /wallet_transactions/i);
      assert.doesNotMatch(serialized, /driver_cash_transactions/i);
      assert.doesNotMatch(serialized, /company_financial_transactions/i);
      assert.doesNotMatch(serialized, /password_hash/i);
    });

    test("17. a REVERSAL financial event also carries no reversal_of_id", async () => {
      const c = await freshCustomer();
      const d = await createDriver("privacy-reversal");
      const orderId = await toOutForDelivery(c, d.token, d.driverId);
      await deliver(orderId, d.token, { actualAmountCollected: "105.00" });

      const before = await getDetail(orderId);
      const creditEvent = before.body.data.financialEvents.find(
        (e: { ledger: string; type: string }) => e.ledger === "WALLET" && e.type === "ORDER_CREDIT"
      );
      const rev = await request(app)
        .post(`/api/v1/wallet-transactions/${creditEvent.id}/reverse`)
        .set(auth(tokens.admin))
        .send({ reason: "privacy check" });
      assert.equal(rev.status, 201, JSON.stringify(rev.body));

      const after = await getDetail(orderId);
      const reversalEvent = after.body.data.financialEvents.find((e: { type: string }) => e.type === "REVERSAL");
      assert.ok(reversalEvent);
      assert.deepEqual(
        Object.keys(reversalEvent).sort(),
        ["actor", "amount", "direction", "id", "ledger", "notes", "occurredAt", "signedAmount", "type"].sort()
      );
      assert.ok(!("reversalOfId" in reversalEvent));
      // still enough to render "Customer wallet credit reversed"
      assert.equal(reversalEvent.ledger, "WALLET");
      assert.equal(reversalEvent.direction, "DEBIT");
      assert.equal(reversalEvent.amount, "100");
    });

    test("16. driver self-service DTO does NOT carry the new management fields", async () => {
      const c = await freshCustomer();
      const d = await createDriver("driver-dto");
      const orderId = await toOutForDelivery(c, d.token, d.driverId);
      const res = await request(app).get(`/api/v1/driver/me/orders/${orderId}`).set(auth(d.token));
      assert.equal(res.status, 200);
      assert.ok(!("financialAllocation" in res.body.data));
      assert.ok(!("financialEvents" in res.body.data));
      assert.ok(!("paymentType" in res.body.data));
    });
  });
});
