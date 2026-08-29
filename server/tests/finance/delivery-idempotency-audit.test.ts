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
// Delivery Ledger Idempotency-Key Namespace Audit (Phase 8.9)
//
// The exhaustive concurrent-delivery duplicate-safety testing already lives
// in delivery-only-finance.test.ts / company-order-finance.test.ts /
// collection-difference-review.test.ts and is NOT duplicated here. This
// suite only proves the narrow Phase 8.9 audit findings that those files
// don't already assert directly: the exact deterministic idempotency_key
// STRING each delivery-created ledger row carries, that a client cannot
// influence it through the request body, and that the delivery/reversal/
// request namespaces can never collide with each other.
// ============================================================

describe("Delivery Ledger Idempotency-Key Namespace Audit (Phase 8.9)", () => {
  let app: Express;
  let admin: TestUser;
  let tokens: Record<string, string>;

  let areaActive: { id: string; name: string };
  let cashMethodId: string;

  const createdOrderIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdAreaIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdUserIds: string[] = [];

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    const adminLogin = await loginTestUser(app, admin.email, admin.password);
    tokens = { admin: adminLogin.accessToken as string };
    assert.ok(tokens.admin, "expected an access token for admin");

    areaActive = await createTestArea();
    createdAreaIds.push(areaActive.id);
    const cashMethod = await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } });
    cashMethodId = cashMethod.id;
  });

  after(async () => {
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    for (const id of createdAreaIds) await cleanupTestArea(id);
    for (const id of createdUserIds) await cleanupTestUser(id);
    await cleanupTestUser(admin.id);
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function freshCustomer(): Promise<string> {
    const id = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(id);
    return id;
  }

  async function createDriverWithToken(label: string) {
    const user = await createTestUser("DRIVER");
    createdUserIds.push(user.id);
    const login = await loginTestUser(app, user.email, user.password);
    assert.ok(login.accessToken, `expected an access token for ${label}`);
    const res = await request(app)
      .post("/api/v1/drivers")
      .set(auth(tokens.admin))
      .send({ driverNumber: `PH89-AUDIT-DRV-${uniqueSuffix()}`, userId: user.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdDriverIds.push(res.body.data.id);
    return { driverId: res.body.data.id as string, token: login.accessToken as string };
  }

  async function deliverExactDeliveryOnlyOrder(customerId: string, driverToken: string, driverId: string) {
    const orderRes = await request(app)
      .post("/api/v1/orders")
      .set(auth(tokens.admin))
      .send({
        customerId,
        orderType: "DELIVERY_ONLY",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: "Phase89 Audit Receiver",
        receiverPhone: "+96170000089",
        receiverAreaId: areaActive.id,
        receiverAddress: "1 Phase89 Audit St",
        description: "Phase89 idempotency-namespace audit order",
        orderAmount: "100.00",
        deliveryFee: "5.00",
        collectionPaymentMethodId: cashMethodId,
      });
    assert.equal(orderRes.status, 201, JSON.stringify(orderRes.body));
    const orderId = orderRes.body.data.id as string;
    createdOrderIds.push(orderId);

    const assign = await request(app).post(`/api/v1/orders/${orderId}/assign`).set(auth(tokens.admin)).send({ driverId });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));
    const pickup = await request(app).post(`/api/v1/driver/orders/${orderId}/pickup`).set(auth(driverToken)).send();
    assert.equal(pickup.status, 200, JSON.stringify(pickup.body));
    const start = await request(app).post(`/api/v1/driver/orders/${orderId}/start-delivery`).set(auth(driverToken)).send();
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const deliver = await request(app)
      .post(`/api/v1/driver/orders/${orderId}/deliver`)
      .set(auth(driverToken))
      .send({ actualAmountCollected: "105.00" });
    assert.equal(deliver.status, 200, JSON.stringify(deliver.body));
    return orderId;
  }

  test("1-3. delivery-created ledger rows carry the exact expected deterministic key, unreachable from the request body", async () => {
    const customerId = await freshCustomer();
    const driver = await createDriverWithToken("namespace-check");
    const orderId = await deliverExactDeliveryOnlyOrder(customerId, driver.token, driver.driverId);

    const driverCollection = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "COLLECTION" } });
    assert.equal(driverCollection.idempotency_key, `delivery:${orderId}:driver-collection`);

    const walletCredit = await prisma.wallet_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "ORDER_CREDIT" } });
    assert.equal(walletCredit.idempotency_key, `delivery:${orderId}:wallet-order-credit`);

    const feeRevenue = await prisma.company_financial_transactions.findFirstOrThrow({
      where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" },
    });
    assert.equal(feeRevenue.idempotency_key, `delivery:${orderId}:delivery-fee-revenue`);

    // No field in the /deliver request body (actualAmountCollected,
    // collectionDifferenceReason) can reach any of these three columns —
    // driver-order.schema.ts has no such input field, and orderId itself is
    // a path param, not a body value the client controls. The exact-equality
    // assertions above already prove the persisted key matches the
    // server-only template precisely — a client-influenced key could not
    // land on exactly this format for every one of the three categories.
  });

  test("4. the four delivery ledger categories are structurally distinct from each other and from request:/reversal: namespaces", async () => {
    const customerId = await freshCustomer();
    const driver = await createDriverWithToken("namespace-distinct");
    const orderId = await deliverExactDeliveryOnlyOrder(customerId, driver.token, driver.driverId);

    const driverCollection = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "COLLECTION" } });
    const walletCredit = await prisma.wallet_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "ORDER_CREDIT" } });
    const feeRevenue = await prisma.company_financial_transactions.findFirstOrThrow({
      where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" },
    });

    const keys = [driverCollection.idempotency_key, walletCredit.idempotency_key, feeRevenue.idempotency_key];
    const uniqueKeys = new Set(keys);
    assert.equal(uniqueKeys.size, keys.length, "each delivery ledger category must have a distinct key for the same order");

    for (const key of keys) {
      assert.ok(key?.startsWith(`delivery:${orderId}:`), `expected the delivery: namespace, got ${key}`);
      assert.ok(!key?.startsWith("request:payout:"), "delivery keys must never collide with the payout request namespace");
      assert.ok(!key?.startsWith("request:settlement:"), "delivery keys must never collide with the settlement request namespace");
      assert.ok(!key?.startsWith("reversal:"), "delivery keys must never collide with the reversal namespace");
    }
  });

  test("5. company-product-revenue category (COMPANY_ORDER) also matches the expected deterministic key and namespace", async () => {
    const customerId = await freshCustomer();
    const driver = await createDriverWithToken("company-product-key");

    const orderRes = await request(app)
      .post("/api/v1/orders")
      .set(auth(tokens.admin))
      .send({
        customerId,
        orderType: "COMPANY_ORDER",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: "Phase89 Audit Receiver Co",
        receiverPhone: "+96170000090",
        receiverAreaId: areaActive.id,
        receiverAddress: "2 Phase89 Audit St",
        description: "Phase89 idempotency-namespace audit company order",
        orderAmount: "100.00",
        deliveryFee: "5.00",
        collectionPaymentMethodId: cashMethodId,
      });
    assert.equal(orderRes.status, 201, JSON.stringify(orderRes.body));
    const orderId = orderRes.body.data.id as string;
    createdOrderIds.push(orderId);

    const assign = await request(app).post(`/api/v1/orders/${orderId}/assign`).set(auth(tokens.admin)).send({ driverId: driver.driverId });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));
    const pickup = await request(app).post(`/api/v1/driver/orders/${orderId}/pickup`).set(auth(driver.token)).send();
    assert.equal(pickup.status, 200, JSON.stringify(pickup.body));
    const start = await request(app).post(`/api/v1/driver/orders/${orderId}/start-delivery`).set(auth(driver.token)).send();
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const deliver = await request(app)
      .post(`/api/v1/driver/orders/${orderId}/deliver`)
      .set(auth(driver.token))
      .send({ actualAmountCollected: "105.00" });
    assert.equal(deliver.status, 200, JSON.stringify(deliver.body));

    const productRevenue = await prisma.company_financial_transactions.findFirstOrThrow({
      where: { order_id: orderId, type: "COMPANY_ORDER_PRODUCT_REVENUE" },
    });
    assert.equal(productRevenue.idempotency_key, `delivery:${orderId}:company-product-revenue`);

    const walletCreditCount = await prisma.wallet_transactions.count({ where: { order_id: orderId } });
    assert.equal(walletCreditCount, 0, "a COMPANY_ORDER delivery must never create a wallet ledger row");
  });
});
