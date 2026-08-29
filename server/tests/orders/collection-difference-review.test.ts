import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { Prisma } from "../../src/generated/prisma/client";
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
  seedTestOrder,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Collection Difference Review (Phase 8.7)
//
// Part A: an actual-!=-expected /deliver now records the REAL physical cash
// in Driver Cash (reusing the Phase 8.1 primitive) while still creating
// ZERO Wallet/Company rows — ownership of that cash is unresolved.
// Part B: POST /orders/:id/resolve-collection-difference is the authorized
// Finance/Admin action that supplies an explicit type-appropriate
// allocation reconciling exactly to actual_amount_collected, using the
// approved Phase 8.2/Company-Finance ledger primitives. It never touches
// Driver Cash — physical custody and accounting ownership are separate.
// ============================================================

describe("Collection Difference Review (Phase 8.7)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driverActor: TestUser;
  let customerActor: TestUser;
  let tokens: Record<string, string>;

  let areaActive: { id: string; name: string };
  let cashMethodId: string;
  let reasonId: string;

  const createdOrderIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdAreaIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdUserIds: string[] = [];

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

    areaActive = await createTestArea();
    createdAreaIds.push(areaActive.id);
    const cashMethod = await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } });
    cashMethodId = cashMethod.id;
    const reason = await prisma.failed_delivery_reasons.findFirstOrThrow();
    reasonId = reason.id;
  });

  after(async () => {
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    for (const id of createdAreaIds) await cleanupTestArea(id);
    for (const id of createdUserIds) await cleanupTestUser(id);
    await Promise.all([admin, dispatcher, finance, driverActor, customerActor].map((u) => cleanupTestUser(u.id)));
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
      .send({ driverNumber: `PH87-DRV-${uniqueSuffix()}`, userId: user.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdDriverIds.push(res.body.data.id);
    return { driverId: res.body.data.id as string, userId: user.id, token: login.accessToken as string };
  }

  async function createBaseOrder(customerId: string, overrides: Record<string, unknown> = {}) {
    const res = await request(app)
      .post("/api/v1/orders")
      .set(auth(tokens.admin))
      .send({
        customerId,
        orderType: "DELIVERY_ONLY",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: "Phase87 Receiver",
        receiverPhone: "+96170000087",
        receiverAreaId: areaActive.id,
        receiverAddress: "1 Phase87 St",
        description: "Phase87 review order",
        orderAmount: "100.00",
        deliveryFee: "5.00",
        collectionPaymentMethodId: cashMethodId,
        ...overrides,
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdOrderIds.push(res.body.data.id);
    return res.body.data;
  }

  async function createOutForDeliveryOrder(customerId: string, driverToken: string, driverId: string, overrides: Record<string, unknown> = {}) {
    const order = await createBaseOrder(customerId, overrides);
    const assign = await request(app).post(`/api/v1/orders/${order.id}/assign`).set(auth(tokens.admin)).send({ driverId });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));
    const pickup = await request(app).post(`/api/v1/driver/orders/${order.id}/pickup`).set(auth(driverToken)).send();
    assert.equal(pickup.status, 200, JSON.stringify(pickup.body));
    const start = await request(app).post(`/api/v1/driver/orders/${order.id}/start-delivery`).set(auth(driverToken)).send();
    assert.equal(start.status, 200, JSON.stringify(start.body));
    return order.id as string;
  }

  function deliverPath(orderId: string) {
    return `/api/v1/driver/orders/${orderId}/deliver`;
  }
  function failPath(orderId: string) {
    return `/api/v1/driver/orders/${orderId}/fail`;
  }
  function resolvePath(orderId: string) {
    return `/api/v1/orders/${orderId}/resolve-collection-difference`;
  }

  async function deliverWithDifference(
    customerId: string,
    driverToken: string,
    driverId: string,
    actualAmountCollected: string,
    overrides: Record<string, unknown> = {},
    reason = "collection differed"
  ) {
    const orderId = await createOutForDeliveryOrder(customerId, driverToken, driverId, overrides);
    const res = await request(app)
      .post(deliverPath(orderId))
      .set(auth(driverToken))
      .send({ actualAmountCollected, collectionDifferenceReason: reason });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return orderId;
  }

  async function postResolve(token: string, orderId: string, body: Record<string, unknown>) {
    return request(app).post(resolvePath(orderId)).set(auth(token)).send(body);
  }

  async function getOrderRow(orderId: string) {
    return prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
  }

  // ============================================================
  // PART A — DIFFERENCE DELIVERY: DRIVER CASH (1-9)
  // ============================================================

  describe("Difference delivery — Driver Cash", () => {
    test("1. DELIVERY_ONLY undercollection: Driver Cash += actual (95), not expected (105); REVIEW_REQUIRED; zero wallet/company", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-under");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00");

      const row = await getOrderRow(orderId);
      assert.equal(row.status, "DELIVERED");
      assert.equal(row.financial_status, "REVIEW_REQUIRED");
      assert.equal(row.needs_financial_review, true);
      assert.equal(row.actual_amount_collected?.toString(), "95");
      assert.equal(row.collection_difference_reason, "collection differed");

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "95", "Driver Cash must equal actual, never expected");

      const walletTxCount = await prisma.wallet_transactions.count({ where: { order_id: orderId } });
      assert.equal(walletTxCount, 0);
      const companyTxCount = await prisma.company_financial_transactions.count({ where: { order_id: orderId } });
      assert.equal(companyTxCount, 0);
    });

    test("2. DELIVERY_ONLY overcollection: Driver Cash += actual (110), not expected (105)", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-over");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "110.00");

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "110");
      const row = await getOrderRow(orderId);
      assert.equal(row.financial_status, "REVIEW_REQUIRED");
    });

    test("3. COMPANY_ORDER difference: Driver Cash += actual; zero product/fee revenue", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-company-diff");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00", { orderType: "COMPANY_ORDER" });

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "95");
      const companyTxCount = await prisma.company_financial_transactions.count({ where: { order_id: orderId } });
      assert.equal(companyTxCount, 0);
      const walletTxCount = await prisma.wallet_transactions.count({ where: { order_id: orderId } });
      assert.equal(walletTxCount, 0);
    });

    test("4. zero actual: DELIVERED/REVIEW_REQUIRED, no zero-value Driver Cash row", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-zero-actual");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "0", {}, "receiver could not pay");

      const row = await getOrderRow(orderId);
      assert.equal(row.status, "DELIVERED");
      assert.equal(row.financial_status, "REVIEW_REQUIRED");
      assert.equal(row.actual_amount_collected?.toString(), "0");

      const cashTxCount = await prisma.driver_cash_transactions.count({ where: { order_id: orderId } });
      assert.equal(cashTxCount, 0, "a zero-value COLLECTION row must never be created");
    });

    test("5. audit COLLECTION_DIFFERENCE_RECORDED created with correct metadata", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-audit-diff");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00", {}, "receiver short-paid");

      const auditRows = await prisma.audit_logs.findMany({ where: { entity_type: "ORDER", entity_id: orderId } });
      assert.equal(auditRows.length, 1);
      assert.equal(auditRows[0].action, "COLLECTION_DIFFERENCE_RECORDED");
      assert.equal(auditRows[0].actor_user_id, driver.userId);
      const metadata = auditRows[0].metadata as Record<string, unknown>;
      assert.equal(metadata.orderType, "DELIVERY_ONLY");
      assert.equal(metadata.expectedAmount, "105");
      assert.equal(metadata.actualAmount, "95");
      assert.equal(metadata.difference, "-10");
      assert.equal(metadata.collectionDifferenceReason, "receiver short-paid");
      assert.ok(metadata.driverCashTransactionId);
    });

    test("6. rollback: missing Driver Cash account -> entire difference delivery rolls back", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-diff-rollback");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      await prisma.driver_cash_accounts.deleteMany({ where: { driver_id: driver.driverId } });

      const res = await request(app)
        .post(deliverPath(orderId))
        .set(auth(driver.token))
        .send({ actualAmountCollected: "95.00", collectionDifferenceReason: "shortage" });
      assert.equal(res.status, 500, JSON.stringify(res.body));
      assert.equal(res.body.error.code, "INTERNAL_ERROR");

      const row = await getOrderRow(orderId);
      assert.equal(row.status, "OUT_FOR_DELIVERY");
      assert.equal(row.financial_status, "PENDING");
      assert.equal(row.actual_amount_collected, null);
      const attempts = await prisma.delivery_attempts.count({ where: { order_id: orderId } });
      assert.equal(attempts, 0);
      const history = await prisma.order_status_history.count({ where: { order_id: orderId, to_status: "DELIVERED" } });
      assert.equal(history, 0);
      const auditCount = await prisma.audit_logs.count({ where: { entity_type: "ORDER", entity_id: orderId } });
      assert.equal(auditCount, 0);

      await prisma.driver_cash_accounts.create({ data: { driver_id: driver.driverId } });
    });

    test("7. sequential duplicate difference /deliver: second rejected, exactly one COLLECTION", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-diff-dup-seq");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00");

      const second = await request(app)
        .post(deliverPath(orderId))
        .set(auth(driver.token))
        .send({ actualAmountCollected: "95.00", collectionDifferenceReason: "shortage" });
      assert.equal(second.status, 400, JSON.stringify(second.body));

      const cashTxCount = await prisma.driver_cash_transactions.count({ where: { order_id: orderId } });
      assert.equal(cashTxCount, 1);
    });

    test("8. concurrent difference /deliver vs /deliver: exactly one winner, exactly one COLLECTION", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-diff-conc");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      const [a, b] = await Promise.all([
        request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "95.00", collectionDifferenceReason: "shortage" }),
        request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "95.00", collectionDifferenceReason: "shortage" }),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.equal(statuses[0], 200);
      assert.ok([400, 409].includes(statuses[1]));

      const cashTxCount = await prisma.driver_cash_transactions.count({ where: { order_id: orderId } });
      assert.equal(cashTxCount, 1);
      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "95");
    });

    test("9. concurrent difference /deliver vs /fail: exactly one outcome, Driver Cash only if delivered", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-diff-vs-fail");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      const [deliverRes, failRes] = await Promise.all([
        request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "95.00", collectionDifferenceReason: "shortage" }),
        request(app).post(failPath(orderId)).set(auth(driver.token)).send({ failedReasonId: reasonId }),
      ]);
      const statuses = [deliverRes.status, failRes.status].sort();
      assert.equal(statuses[0], 200);
      assert.ok([400, 409].includes(statuses[1]));

      const row = await getOrderRow(orderId);
      const cashTxCount = await prisma.driver_cash_transactions.count({ where: { order_id: orderId } });
      if (row.status === "DELIVERED") {
        assert.equal(cashTxCount, 1);
      } else {
        assert.equal(row.status, "FAILED_DELIVERY");
        assert.equal(cashTxCount, 0);
      }
    });
  });

  // ============================================================
  // PART B — RESOLUTION RBAC (10-15)
  // ============================================================

  describe("Resolution RBAC", () => {
    test("10. unauthenticated -> 401", async () => {
      const res = await request(app).post(resolvePath("00000000-0000-0000-0000-000000000000")).send({});
      assert.equal(res.status, 401);
    });

    test("11. ADMIN -> allowed", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-rbac-admin");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00");
      const res = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "90.00",
        companyProductRevenue: "0.00",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "admin resolution",
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    test("12. FINANCE -> allowed", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-rbac-finance");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00");
      const res = await postResolve(tokens.finance, orderId, {
        customerWalletCredit: "90.00",
        companyProductRevenue: "0.00",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "finance resolution",
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    test("13-15. DISPATCHER/DRIVER/CUSTOMER -> 403", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-rbac-forbidden");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00");
      const body = { customerWalletCredit: "90.00", companyProductRevenue: "0.00", companyDeliveryFeeRevenue: "5.00", resolutionNotes: "x" };

      const asDispatcher = await postResolve(tokens.dispatcher, orderId, body);
      assert.equal(asDispatcher.status, 403);
      const asDriver = await postResolve(tokens.driver, orderId, body);
      assert.equal(asDriver.status, 403);
      const asCustomer = await postResolve(tokens.customer, orderId, body);
      assert.equal(asCustomer.status, 403);

      const row = await getOrderRow(orderId);
      assert.equal(row.financial_status, "REVIEW_REQUIRED", "a forbidden attempt must not change Order state");
    });
  });

  // ============================================================
  // RESOLUTION VALIDATION (16-27)
  // ============================================================

  describe("Resolution validation", () => {
    test("16. malformed order id -> 400", async () => {
      const res = await postResolve(tokens.admin, "not-a-uuid", {
        customerWalletCredit: "0",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "0",
        resolutionNotes: "x",
      });
      assert.equal(res.status, 400);
    });

    test("17. nonexistent order -> 404", async () => {
      const res = await postResolve(tokens.admin, "00000000-0000-0000-0000-000000000000", {
        customerWalletCredit: "0",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "0",
        resolutionNotes: "x",
      });
      assert.equal(res.status, 404);
    });

    test("18. order not in review (still OUT_FOR_DELIVERY) -> 400", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-not-in-review");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      const res = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "0",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "0",
        resolutionNotes: "x",
      });
      assert.equal(res.status, 400);
    });

    test("18b. an already-FINALIZED exact delivery cannot be resolved", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-exact-not-review");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      const deliver = await request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "105.00" });
      assert.equal(deliver.status, 200, JSON.stringify(deliver.body));

      const res = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "100.00",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "x",
      });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      const walletTxCount = await prisma.wallet_transactions.count({ where: { order_id: orderId } });
      assert.equal(walletTxCount, 1, "still only the exact-delivery ORDER_CREDIT — no duplicate posted");
    });

    test("19. FAILED_DELIVERY order is not eligible -> 400", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-failed-not-review");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      const fail = await request(app).post(failPath(orderId)).set(auth(driver.token)).send({ failedReasonId: reasonId });
      assert.equal(fail.status, 200, JSON.stringify(fail.body));

      const res = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "0",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "0",
        resolutionNotes: "x",
      });
      assert.equal(res.status, 400);
    });

    test("20. DELIVERY_ONLY: nonzero companyProductRevenue rejected", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-forbidden-bucket-do");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00");
      const res = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "90.00",
        companyProductRevenue: "1.00",
        companyDeliveryFeeRevenue: "4.00",
        resolutionNotes: "x",
      });
      assert.equal(res.status, 400, JSON.stringify(res.body));
    });

    test("21. COMPANY_ORDER: nonzero customerWalletCredit rejected", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-forbidden-bucket-co");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00", { orderType: "COMPANY_ORDER" });
      const res = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "1.00",
        companyProductRevenue: "89.00",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "x",
      });
      assert.equal(res.status, 400, JSON.stringify(res.body));
    });

    test("22. sum != actual rejected (both under-sum and over-sum)", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-sum-mismatch");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00");

      const under = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "90.00",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "0",
        resolutionNotes: "x",
      });
      assert.equal(under.status, 400, JSON.stringify(under.body));

      const over = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "100.00",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "x",
      });
      assert.equal(over.status, 400, JSON.stringify(over.body));

      const walletTxCount = await prisma.wallet_transactions.count({ where: { order_id: orderId } });
      assert.equal(walletTxCount, 0);
    });

    test("23-25. negative component, >2 decimals, overflow all rejected", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-money-validation");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00");

      const negative = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "-90.00",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "x",
      });
      assert.equal(negative.status, 400);

      const tooManyDecimals = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "90.001",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "x",
      });
      assert.equal(tooManyDecimals.status, 400);

      const overflow = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "999999999999999.99",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "x",
      });
      assert.equal(overflow.status, 400);
    });

    test("26-27. empty and missing resolutionNotes rejected", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-notes-validation");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00");

      const empty = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "90.00",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "   ",
      });
      assert.equal(empty.status, 400);

      const missing = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "90.00",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "5.00",
      });
      assert.equal(missing.status, 400);
    });

    test("client-supplied server-authoritative fields are ignored without effect", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-strip-fields");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00");
      const res = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "90.00",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "x",
        financialStatus: "FINALIZED",
        needsFinancialReview: false,
        actorId: dispatcher.id,
        status: "CANCELLED",
      } as never);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const row = await getOrderRow(orderId);
      assert.equal(row.status, "DELIVERED", "status must remain server-derived, never client-set to CANCELLED");
      const auditRow = await prisma.audit_logs.findFirstOrThrow({ where: { entity_type: "ORDER", entity_id: orderId, action: "COLLECTION_DIFFERENCE_RESOLVED" } });
      assert.equal(auditRow.actor_user_id, admin.id, "actor must be the authenticated caller, never a client-supplied actorId");
    });
  });

  // ============================================================
  // REVIEW DATA CORRUPTION (28-30)
  // ============================================================

  describe("Review data corruption", () => {
    test("28. REVIEW_REQUIRED + actual null -> sanitized 500", async () => {
      const customerId = await freshCustomer();
      const orderId = await seedTestOrder(customerId, admin.id, {
        areaId: areaActive.id,
        areaName: areaActive.name,
        status: "DELIVERED",
        financialStatus: "REVIEW_REQUIRED",
        needsFinancialReview: true,
        collectionDifferenceReason: "corrupt fixture: actual missing",
      });
      createdOrderIds.push(orderId);
      const res = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "0",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "0",
        resolutionNotes: "x",
      });
      assert.equal(res.status, 500, JSON.stringify(res.body));
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
      assert.doesNotMatch(JSON.stringify(res.body), /prisma|stack|at Object/i);
    });

    test("29. REVIEW_REQUIRED + reason null -> sanitized 500", async () => {
      const customerId = await freshCustomer();
      const orderId = await seedTestOrder(customerId, admin.id, {
        areaId: areaActive.id,
        areaName: areaActive.name,
        status: "DELIVERED",
        financialStatus: "REVIEW_REQUIRED",
        needsFinancialReview: true,
        actualAmountCollected: "95.00",
        // collectionDifferenceReason intentionally omitted (defaults null)
      });
      createdOrderIds.push(orderId);
      const res = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "0",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "95.00",
        resolutionNotes: "x",
      });
      assert.equal(res.status, 500, JSON.stringify(res.body));
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
    });

    test("30. REVIEW_REQUIRED + actual == expected -> sanitized 500", async () => {
      const customerId = await freshCustomer();
      const orderId = await seedTestOrder(customerId, admin.id, {
        areaId: areaActive.id,
        areaName: areaActive.name,
        status: "DELIVERED",
        financialStatus: "REVIEW_REQUIRED",
        needsFinancialReview: true,
        actualAmountCollected: "105.00",
        collectionDifferenceReason: "corrupt fixture: actual equals expected",
      });
      createdOrderIds.push(orderId);
      const res = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "100.00",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "x",
      });
      assert.equal(res.status, 500, JSON.stringify(res.body));
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
    });
  });

  // ============================================================
  // DELIVERY_ONLY RESOLUTION END-TO-END (31-32)
  // ============================================================

  describe("DELIVERY_ONLY resolution", () => {
    test("31. shortage: wallet=90 + fee=5 = actual 95; Driver Cash unchanged; FINALIZED; reason preserved; audit created", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-do-shortage");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00", {}, "receiver paid 95 only");

      const cashBefore = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashBefore.current_balance.toString(), "95");

      const res = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "90.00",
        companyProductRevenue: "0.00",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "Receiver paid 95; customer accepted 90 and company fee is 5.",
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.financialStatus, "FINALIZED");
      assert.equal(res.body.data.financial.needsFinancialReview, false);
      assert.equal(res.body.data.financial.collectionDifferenceReason, "receiver paid 95 only", "the Driver's original reason must be preserved, not overwritten");

      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "90");
      const feeRevenue = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" } });
      assert.equal(feeRevenue.amount.toString(), "5");

      const cashAfter = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAfter.current_balance.toString(), "95", "resolution must never touch Driver Cash");

      const auditRow = await prisma.audit_logs.findFirstOrThrow({ where: { entity_type: "ORDER", entity_id: orderId, action: "COLLECTION_DIFFERENCE_RESOLVED" } });
      assert.equal(auditRow.actor_user_id, admin.id);
      const metadata = auditRow.metadata as Record<string, unknown>;
      assert.equal(metadata.originalDifferenceReason, "receiver paid 95 only");
      assert.equal(metadata.resolutionNotes, "Receiver paid 95; customer accepted 90 and company fee is 5.");
      assert.equal(metadata.customerWalletCredit, "90");
      assert.equal(metadata.companyDeliveryFeeRevenue, "5");
    });

    test("32. overcollection: actual=110 explicitly allocated wallet=105 + fee=5, not auto-normalized to expected 105", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-do-over");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "110.00", {}, "receiver overpaid");

      const res = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "105.00",
        companyProductRevenue: "0.00",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "Full 110 allocated: 105 to customer, 5 company fee.",
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "105");
      const feeRevenue = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" } });
      assert.equal(feeRevenue.amount.toString(), "5");
    });
  });

  // ============================================================
  // COMPANY_ORDER RESOLUTION END-TO-END (33)
  // ============================================================

  describe("COMPANY_ORDER resolution", () => {
    test("33. shortage: product=90 + fee=5 = actual 95; Company +95 total; Driver Cash/Wallet unchanged; FINALIZED", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-co-shortage");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00", { orderType: "COMPANY_ORDER" }, "short payment");

      const res = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "0.00",
        companyProductRevenue: "90.00",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "Company absorbs the 10 shortfall on product revenue.",
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.financialStatus, "FINALIZED");

      const companyRows = await prisma.company_financial_transactions.findMany({ where: { order_id: orderId } });
      assert.equal(companyRows.length, 2);
      const total = companyRows.reduce((sum, r) => sum.plus(r.amount), new Prisma.Decimal(0));
      assert.equal(total.toString(), "95");

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "95", "resolution never touches Driver Cash");
      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "0");
      const walletTxCount = await prisma.wallet_transactions.count({ where: { order_id: orderId } });
      assert.equal(walletTxCount, 0, "a COMPANY_ORDER resolution must never create a wallet transaction");
    });
  });

  // ============================================================
  // ZERO ALLOCATION COMPONENTS (34)
  // ============================================================

  describe("Zero allocation components", () => {
    test("34. DELIVERY_ONLY wallet=95/fee=0: only the wallet row is created, no zero-value fee row", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-zero-fee-bucket");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00", { deliveryFee: "0.00" }, "fee waived");
      // amount_to_collect = 100 (order) + 0 (fee) = 100, actual = 95 -> difference recorded.

      const res = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "95.00",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "0",
        resolutionNotes: "Full amount to customer, no fee.",
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const feeRowCount = await prisma.company_financial_transactions.count({ where: { order_id: orderId } });
      assert.equal(feeRowCount, 0, "no zero-value DELIVERY_FEE_REVENUE row");
      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "95");
    });
  });

  // ============================================================
  // WALLET INTEGRITY (35) / COMPANY ORDER DOES NOT NEED WALLET (36)
  // ============================================================

  describe("Account integrity", () => {
    test("35. DELIVERY_ONLY resolution with missing Customer Wallet -> 500, full rollback", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-missing-wallet-resolve");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00");
      await prisma.customer_wallets.deleteMany({ where: { customer_id: customerId } });

      const res = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "90.00",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "x",
      });
      assert.equal(res.status, 500, JSON.stringify(res.body));

      const row = await getOrderRow(orderId);
      assert.equal(row.financial_status, "REVIEW_REQUIRED");
      const companyTxCount = await prisma.company_financial_transactions.count({ where: { order_id: orderId } });
      assert.equal(companyTxCount, 0, "the fee revenue that would run after the wallet step must also roll back");
      const auditRow = await prisma.audit_logs.findFirst({ where: { entity_type: "ORDER", entity_id: orderId, action: "COLLECTION_DIFFERENCE_RESOLVED" } });
      assert.equal(auditRow, null);

      await prisma.customer_wallets.create({ data: { customer_id: customerId } });
    });

    test("36. COMPANY_ORDER resolution succeeds even with the Customer's Wallet missing entirely", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-co-no-wallet-needed");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00", { orderType: "COMPANY_ORDER" });
      await prisma.customer_wallets.deleteMany({ where: { customer_id: customerId } });

      const res = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "0.00",
        companyProductRevenue: "90.00",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "Company order — wallet not needed.",
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      await prisma.customer_wallets.create({ data: { customer_id: customerId } });
    });
  });

  // ============================================================
  // SETTLEMENT BEFORE RESOLUTION (37)
  // ============================================================

  describe("Settlement before resolution", () => {
    test("37. Driver Cash fully settled to 0 before resolution — resolution still succeeds", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-settle-before-resolve");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00");

      const settlement = await request(app)
        .post("/api/v1/driver-settlements")
        .set(auth(tokens.admin))
        .set("Idempotency-Key", randomUUID())
        .send({ driverId: driver.driverId, amountReceived: "95.00", paymentMethodId: cashMethodId });
      assert.equal(settlement.status, 201, JSON.stringify(settlement.body));
      const cashAfterSettlement = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAfterSettlement.current_balance.toString(), "0");

      const res = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "90.00",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "Resolved after full settlement — ownership is independent of current custody.",
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "90");
      const cashFinal = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashFinal.current_balance.toString(), "0", "resolution must not re-credit/debit Driver Cash");
    });
  });

  // ============================================================
  // CONCURRENCY (38-39)
  // ============================================================

  describe("Resolution concurrency", () => {
    test("38. duplicate resolution: second call rejected, no duplicate ledger rows", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-dup-resolve");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00");

      const first = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "90.00",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "first",
      });
      assert.equal(first.status, 200, JSON.stringify(first.body));

      const second = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "90.00",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "second",
      });
      assert.equal(second.status, 400, JSON.stringify(second.body));

      const walletTxCount = await prisma.wallet_transactions.count({ where: { order_id: orderId } });
      assert.equal(walletTxCount, 1);
      const companyTxCount = await prisma.company_financial_transactions.count({ where: { order_id: orderId } });
      assert.equal(companyTxCount, 1);
      const auditCount = await prisma.audit_logs.count({ where: { entity_type: "ORDER", entity_id: orderId, action: "COLLECTION_DIFFERENCE_RESOLVED" } });
      assert.equal(auditCount, 1);
    });

    test("39. concurrent resolution A vs B (different allocations): exactly one wins", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-conc-resolve");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00");

      const [a, b] = await Promise.all([
        postResolve(tokens.admin, orderId, { customerWalletCredit: "90.00", companyProductRevenue: "0", companyDeliveryFeeRevenue: "5.00", resolutionNotes: "A" }),
        postResolve(tokens.finance, orderId, { customerWalletCredit: "80.00", companyProductRevenue: "0", companyDeliveryFeeRevenue: "15.00", resolutionNotes: "B" }),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.equal(statuses[0], 200, JSON.stringify([a.body, b.body]));
      assert.ok([400, 409].includes(statuses[1]));

      const walletTxCount = await prisma.wallet_transactions.count({ where: { order_id: orderId } });
      assert.equal(walletTxCount, 1, "never ledger rows from both competing resolutions");
      const companyTxCount = await prisma.company_financial_transactions.count({ where: { order_id: orderId } });
      assert.equal(companyTxCount, 1);

      const row = await getOrderRow(orderId);
      assert.equal(row.financial_status, "FINALIZED");
      // The winner's wallet credit and the persisted wallet balance must agree with each other.
      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      const winnerWasA = a.status === 200;
      assert.equal(wallet.available_balance.toString(), winnerWasA ? "90" : "80");
    });
  });

  // ============================================================
  // ROLLBACK (40-42)
  // ============================================================

  describe("Resolution rollback", () => {
    test("41. forced company fee-revenue idempotency collision -> full rollback, wallet credit rolls back too", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-resolve-fee-collision");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00");

      await prisma.company_financial_transactions.create({
        data: { type: "DELIVERY_FEE_REVENUE", amount: new Prisma.Decimal("1.00"), idempotency_key: `delivery:${orderId}:delivery-fee-revenue` },
      });

      const res = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "90.00",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "x",
      });
      assert.ok([409, 500].includes(res.status), JSON.stringify(res.body));

      const row = await getOrderRow(orderId);
      assert.equal(row.financial_status, "REVIEW_REQUIRED");
      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "0", "the wallet credit that ran before the fee collision must roll back too");
      const walletTxCount = await prisma.wallet_transactions.count({ where: { order_id: orderId } });
      assert.equal(walletTxCount, 0);
      const auditCount = await prisma.audit_logs.count({ where: { entity_type: "ORDER", entity_id: orderId, action: "COLLECTION_DIFFERENCE_RESOLVED" } });
      assert.equal(auditCount, 0);

      await prisma.company_financial_transactions.deleteMany({ where: { idempotency_key: `delivery:${orderId}:delivery-fee-revenue` } });
    });

    test("42. COMPANY_ORDER: forced product-revenue idempotency collision -> Order remains REVIEW_REQUIRED, no company allocation", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-resolve-product-collision");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00", { orderType: "COMPANY_ORDER" });

      await prisma.company_financial_transactions.create({
        data: { type: "COMPANY_ORDER_PRODUCT_REVENUE", amount: new Prisma.Decimal("1.00"), idempotency_key: `delivery:${orderId}:company-product-revenue` },
      });

      const res = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "0",
        companyProductRevenue: "90.00",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "x",
      });
      assert.ok([409, 500].includes(res.status), JSON.stringify(res.body));

      const row = await getOrderRow(orderId);
      assert.equal(row.financial_status, "REVIEW_REQUIRED");
      const feeRows = await prisma.company_financial_transactions.count({ where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" } });
      assert.equal(feeRows, 0, "no company allocation remains from the rolled-back resolution");

      await prisma.company_financial_transactions.deleteMany({ where: { idempotency_key: `delivery:${orderId}:company-product-revenue` } });
    });
  });

  // ============================================================
  // MANAGEMENT DISCOVERY (44-45 in spec numbering)
  // ============================================================

  describe("Management discovery", () => {
    test("Finance discovers pending reviews via GET /orders?needsFinancialReview=true and financialStatus=REVIEW_REQUIRED; resolved Orders disappear", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-discovery");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00");

      const byReviewFlag = await request(app).get("/api/v1/orders?needsFinancialReview=true&limit=100").set(auth(tokens.finance));
      assert.equal(byReviewFlag.status, 200, JSON.stringify(byReviewFlag.body));
      assert.ok(byReviewFlag.body.data.some((o: { id: string }) => o.id === orderId));

      const byStatus = await request(app).get("/api/v1/orders?financialStatus=REVIEW_REQUIRED&limit=100").set(auth(tokens.finance));
      assert.equal(byStatus.status, 200);
      assert.ok(byStatus.body.data.some((o: { id: string }) => o.id === orderId));

      const res = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "90.00",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "x",
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const afterReviewFlag = await request(app).get("/api/v1/orders?needsFinancialReview=true&limit=100").set(auth(tokens.finance));
      assert.ok(!afterReviewFlag.body.data.some((o: { id: string }) => o.id === orderId), "resolved Orders must disappear from the review filter");
      const afterStatus = await request(app).get("/api/v1/orders?financialStatus=REVIEW_REQUIRED&limit=100").set(auth(tokens.finance));
      assert.ok(!afterStatus.body.data.some((o: { id: string }) => o.id === orderId));
    });
  });

  // ============================================================
  // PENDING-TO-AVAILABLE BEHAVIOR
  // ============================================================

  describe("Pending-to-available behavior", () => {
    test("during review the Order contributes neither pending nor available; after resolution the allocated amount becomes available", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-pending-review");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00");

      const duringReview = await request(app).get(`/api/v1/wallets/${customerId}`).set(auth(tokens.admin));
      assert.equal(duringReview.status, 200, JSON.stringify(duringReview.body));
      assert.equal(duringReview.body.data.wallet.pendingAmount, "0", "a DELIVERED order (even under review) is no longer 'active' for pending");
      assert.equal(duringReview.body.data.wallet.availableBalance, "0", "unresolved ownership must not yet be available");

      const res = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "90.00",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "x",
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const afterResolution = await request(app).get(`/api/v1/wallets/${customerId}`).set(auth(tokens.admin));
      assert.equal(afterResolution.body.data.wallet.availableBalance, "90");
      assert.equal(afterResolution.body.data.wallet.pendingAmount, "0");
    });
  });

  // ============================================================
  // MONEY SEPARATION RECONFIRMATION
  // ============================================================

  describe("Money separation", () => {
    test("difference delivery changes only Driver Cash; resolution changes only Wallet/Company — never the same step doing both", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-separation-recheck");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      const walletBeforeDelivery = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      const deliver = await request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "95.00", collectionDifferenceReason: "x" });
      assert.equal(deliver.status, 200, JSON.stringify(deliver.body));
      const cashAfterDelivery = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAfterDelivery.current_balance.toString(), "95");
      const walletAfterDelivery = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(walletAfterDelivery.available_balance.toString(), walletBeforeDelivery.available_balance.toString());

      const res = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "90.00",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "x",
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const cashAfterResolution = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAfterResolution.current_balance.toString(), "95", "resolution never changes Driver Cash");
      const walletAfterResolution = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(walletAfterResolution.available_balance.toString(), "90");
    });
  });

  // ============================================================
  // DRIVER DTO PRIVACY
  // ============================================================

  describe("Driver DTO privacy", () => {
    test("a difference /deliver response never leaks Finance-only fields to the Driver", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-dto-privacy");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      const res = await request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "95.00", collectionDifferenceReason: "shortage" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const raw = JSON.stringify(res.body);
      assert.equal(raw.includes("financialStatus"), false);
      assert.equal(raw.includes("needsFinancialReview"), false);
      assert.equal(raw.includes("collectionDifferenceReason"), false);
    });
  });

  // ============================================================
  // APPEND-ONLY
  // ============================================================

  describe("Append-only", () => {
    test("the original Driver COLLECTION row is byte-for-byte unchanged after resolution", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-append-only-cash");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00");
      const original = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { order_id: orderId } });
      const snapshot = { ...original };

      const res = await postResolve(tokens.admin, orderId, {
        customerWalletCredit: "90.00",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "x",
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const after = await prisma.driver_cash_transactions.findUniqueOrThrow({ where: { id: original.id } });
      assert.deepEqual(after, snapshot);
    });

    test("no resolve-collection-difference route exists as GET/PATCH/DELETE", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-append-only-route");
      const orderId = await deliverWithDifference(customerId, driver.token, driver.driverId, "95.00");

      const getAttempt = await request(app).get(resolvePath(orderId)).set(auth(tokens.admin));
      assert.equal(getAttempt.status, 404);
      const patchAttempt = await request(app).patch(resolvePath(orderId)).set(auth(tokens.admin)).send({});
      assert.equal(patchAttempt.status, 404);
      const deleteAttempt = await request(app).delete(resolvePath(orderId)).set(auth(tokens.admin));
      assert.equal(deleteAttempt.status, 404);
    });
  });
});
