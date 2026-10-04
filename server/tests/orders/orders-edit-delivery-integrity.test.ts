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
  cleanupTestOrder,
  cleanupTestUser,
  createTestArea,
  createTestUser,
  loginTestUser,
  seedCustomerRecord,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

// Order editing is allowed in every status except DELIVERED. These tests use
// the REAL driver workflow (assign -> pickup -> start -> deliver/fail) to prove:
//   - a genuinely DELIVERED order (with real ledger rows) rejects edits and
//     every order/ledger/balance row stays byte-identical;
//   - OUT_FOR_DELIVERY is editable, and delivery then posts the EDITED amounts;
//   - an edit that commits between the driver action's pre-read and its claim
//     makes the driver action 409 (no stale financial posting).
describe("Order editing vs delivery financial integrity", () => {
  let app: Express;
  let admin: TestUser;
  let adminToken: string;
  let areaActive: { id: string; name: string };
  let cashMethodId: string;
  let failedReasonId: string;

  const createdOrderIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdUserIds: string[] = [];

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    const login = await loginTestUser(app, admin.email, admin.password);
    adminToken = login.accessToken as string;
    assert.ok(adminToken);

    areaActive = await createTestArea();
    const cashMethod = await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } });
    cashMethodId = cashMethod.id;
    const reason = await prisma.failed_delivery_reasons.create({
      data: { name: `EditIntegrity Reason ${uniqueSuffix()}`, requires_notes: false, is_active: true },
    });
    failedReasonId = reason.id;
  });

  after(async () => {
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    await cleanupTestArea(areaActive.id);
    await cleanupTestFailedDeliveryReason(failedReasonId);
    for (const id of createdUserIds) await cleanupTestUser(id);
    await cleanupTestUser(admin.id);
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function createDriverWithToken() {
    const user = await createTestUser("DRIVER");
    createdUserIds.push(user.id);
    const login = await loginTestUser(app, user.email, user.password);
    const res = await request(app)
      .post("/api/v1/drivers")
      .set(auth(adminToken))
      .send({ driverNumber: `EDIT-DRV-${Math.random().toString(36).slice(2)}`, userId: user.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdDriverIds.push(res.body.data.id);
    return { driverId: res.body.data.id as string, token: login.accessToken as string };
  }

  // A fresh Customer per scenario keeps wallet balances isolated.
  async function createOutForDeliveryOrder() {
    const customerId = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(customerId);
    const driver = await createDriverWithToken();

    const created = await request(app)
      .post("/api/v1/orders")
      .set(auth(adminToken))
      .send({
        customerId,
        orderType: "DELIVERY_ONLY",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: "EditIntegrity Receiver",
        receiverPhone: "+96170000099",
        receiverAreaId: areaActive.id,
        receiverAddress: "1 EditIntegrity St",
        description: "EditIntegrity order",
        orderAmount: "100.00",
        deliveryFee: "5.00",
        collectionPaymentMethodId: cashMethodId,
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const orderId = created.body.data.id as string;
    createdOrderIds.push(orderId);

    const assign = await request(app).post(`/api/v1/orders/${orderId}/assign`).set(auth(adminToken)).send({ driverId: driver.driverId });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));
    const pickup = await request(app).post(`/api/v1/driver/orders/${orderId}/pickup`).set(auth(driver.token)).send();
    assert.equal(pickup.status, 200, JSON.stringify(pickup.body));
    const start = await request(app).post(`/api/v1/driver/orders/${orderId}/start-delivery`).set(auth(driver.token)).send();
    assert.equal(start.status, 200, JSON.stringify(start.body));

    return { orderId, customerId, driver };
  }

  function deliver(orderId: string, driverToken: string, actualAmountCollected: string) {
    return request(app).post(`/api/v1/driver/orders/${orderId}/deliver`).set(auth(driverToken)).send({ actualAmountCollected });
  }

  function patchOrder(orderId: string, body: Record<string, unknown>) {
    return request(app).patch(`/api/v1/orders/${orderId}`).set(auth(adminToken)).send(body);
  }

  async function financialSnapshot(orderId: string, customerId: string, driverId: string) {
    const [order, walletTx, cashTx, companyTx, directCollections, wallet, cashAccount] = await Promise.all([
      prisma.orders.findUniqueOrThrow({ where: { id: orderId } }),
      prisma.wallet_transactions.findMany({ where: { order_id: orderId }, orderBy: { id: "asc" } }),
      prisma.driver_cash_transactions.findMany({ where: { order_id: orderId }, orderBy: { id: "asc" } }),
      prisma.company_financial_transactions.findMany({ where: { order_id: orderId }, orderBy: { id: "asc" } }),
      prisma.company_direct_collections.findMany({ where: { order_id: orderId }, orderBy: { id: "asc" } }),
      prisma.customer_wallets.findUnique({ where: { customer_id: customerId } }),
      prisma.driver_cash_accounts.findUnique({ where: { driver_id: driverId } }),
    ]);
    return { order, walletTx, cashTx, companyTx, directCollections, wallet, cashAccount };
  }

  // Runs `beforeClaim` right before the next prisma.$transaction executes,
  // simulating a concurrent request committing between a service's
  // pre-transaction read and its conditional claim.
  async function withInterleavedWrite<T>(beforeClaim: () => Promise<unknown>, action: () => Promise<T>): Promise<T> {
    const originalTransaction = prisma.$transaction.bind(prisma);
    let fired = false;
    (prisma as { $transaction: typeof prisma.$transaction }).$transaction = (async (
      ...args: Parameters<typeof originalTransaction>
    ) => {
      if (!fired) {
        fired = true;
        await beforeClaim();
      }
      return (originalTransaction as (...a: typeof args) => Promise<unknown>)(...args);
    }) as typeof prisma.$transaction;
    try {
      return await action();
    } finally {
      (prisma as { $transaction: typeof prisma.$transaction }).$transaction = originalTransaction;
    }
  }

  test("a genuinely DELIVERED order rejects edits; order, ledgers and balances are unchanged", async () => {
    const { orderId, customerId, driver } = await createOutForDeliveryOrder();
    const delivered = await deliver(orderId, driver.token, "105.00");
    assert.equal(delivered.status, 200, JSON.stringify(delivered.body));

    const before = await financialSnapshot(orderId, customerId, driver.driverId);
    assert.equal(before.order.status, "DELIVERED");
    assert.ok(before.walletTx.length > 0, "fixture sanity: delivery posted a wallet credit");
    assert.ok(before.cashTx.length > 0, "fixture sanity: delivery posted driver cash");
    assert.ok(before.companyTx.length > 0, "fixture sanity: delivery posted company revenue");

    const res = await patchOrder(orderId, {
      receiverName: "Edit after delivery",
      orderAmount: "500.00",
      deliveryFee: "50.00",
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error.code, "CONFLICT");
    assert.equal(res.body.error.message, "Delivered orders cannot be edited.");

    const after = await financialSnapshot(orderId, customerId, driver.driverId);
    assert.deepEqual(after, before, "a rejected delivered edit must not create or modify any order/financial row");
  });

  test("OUT_FOR_DELIVERY is editable and the delivery then posts the EDITED amounts", async () => {
    const { orderId, customerId, driver } = await createOutForDeliveryOrder();

    const edit = await patchOrder(orderId, { orderAmount: "120.00", receiverPhone: "+96170000123" });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal(edit.body.data.status, "OUT_FOR_DELIVERY");
    assert.equal(edit.body.data.financial.amountToCollect, "125");

    const delivered = await deliver(orderId, driver.token, "125.00");
    assert.equal(delivered.status, 200, JSON.stringify(delivered.body));

    const snap = await financialSnapshot(orderId, customerId, driver.driverId);
    assert.equal(snap.order.needs_financial_review, false, "exact against the edited expected amount");
    assert.equal(snap.walletTx.length, 1);
    assert.equal(snap.walletTx[0]?.credit.toString(), "120");
    assert.equal(snap.wallet?.available_balance.toString(), "120");
  });

  test("an edit committing mid-delivery makes the delivery 409 (no stale posting); a retry posts the edited amounts", async () => {
    const { orderId, customerId, driver } = await createOutForDeliveryOrder();

    const raced = await withInterleavedWrite(
      () =>
        prisma.orders.update({
          where: { id: orderId },
          data: { order_amount: "150.00", remaining_order_amount: "150.00", amount_to_collect: "155.00" },
        }),
      () => deliver(orderId, driver.token, "105.00")
    );
    assert.equal(raced.status, 409, JSON.stringify(raced.body));
    assert.equal(raced.body.error.code, "CONFLICT");

    const mid = await financialSnapshot(orderId, customerId, driver.driverId);
    assert.equal(mid.order.status, "OUT_FOR_DELIVERY");
    assert.equal(mid.order.actual_amount_collected, null);
    assert.equal(mid.walletTx.length, 0);
    assert.equal(mid.cashTx.length, 0);
    assert.equal(mid.companyTx.length, 0);
    assert.equal(mid.directCollections.length, 0);

    const retry = await deliver(orderId, driver.token, "155.00");
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    const final = await financialSnapshot(orderId, customerId, driver.driverId);
    assert.equal(final.order.needs_financial_review, false);
    assert.equal(final.walletTx[0]?.credit.toString(), "150");
  });

  test("an edit changing the Customer mid-delivery makes the delivery 409 (wallet credit never goes to the old Customer)", async () => {
    const { orderId, customerId, driver } = await createOutForDeliveryOrder();
    const otherCustomer = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(otherCustomer);

    const raced = await withInterleavedWrite(
      () => prisma.orders.update({ where: { id: orderId }, data: { customer_id: otherCustomer } }),
      () => deliver(orderId, driver.token, "105.00")
    );
    assert.equal(raced.status, 409, JSON.stringify(raced.body));
    assert.equal(await prisma.wallet_transactions.count({ where: { order_id: orderId } }), 0);
    const oldWallet = await prisma.customer_wallets.findUnique({ where: { customer_id: customerId } });
    assert.ok(!oldWallet || oldWallet.available_balance.isZero());
  });

  test("an edit committing mid failed-delivery makes the fail action 409 (no stale expected-collection snapshot)", async () => {
    const { orderId, driver } = await createOutForDeliveryOrder();

    const raced = await withInterleavedWrite(
      () =>
        prisma.orders.update({
          where: { id: orderId },
          data: { order_amount: "150.00", remaining_order_amount: "150.00", amount_to_collect: "155.00" },
        }),
      () => request(app).post(`/api/v1/driver/orders/${orderId}/fail`).set(auth(driver.token)).send({ failedReasonId })
    );
    assert.equal(raced.status, 409, JSON.stringify(raced.body));

    const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
    assert.equal(row.status, "OUT_FOR_DELIVERY");
    assert.equal(await prisma.delivery_attempts.count({ where: { order_id: orderId, outcome: "FAILED" } }), 0);

    const retry = await request(app).post(`/api/v1/driver/orders/${orderId}/fail`).set(auth(driver.token)).send({ failedReasonId });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
  });
});
