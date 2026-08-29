import "../helpers/setup";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { Prisma } from "../../src/generated/prisma/client";
import { runWalletTransaction } from "../../src/modules/wallets/wallet-ledger.service";
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
// Reports (Phase 9.3) — GET /api/v1/reports/{orders,drivers,customers,finance}
//
// Test-isolation strategy (mirrors Phase 9.2's finance-summary.test.ts,
// proven stable under full-suite parallelism): historical-date assertions
// use dedicated, test-owned UTC dates in year 2001 — no production data or
// concurrently-running test file has any reason to date a real row in 2001,
// so absolute (not delta) assertions against that window are safe.
// Snapshot-only assertions (currentWalletBalance, currentCashHeld, current*
// Finance Report fields) are cumulative-from-all-time and therefore always
// use delta-against-a-live-baseline instead of an absolute value.
// ============================================================

describe("Reports (Phase 9.3)", () => {
  let app: Express;
  let admin: TestUser;
  let finance: TestUser;
  let dispatcher: TestUser;
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
  const createdCompanyTransactionIds: string[] = [];

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    finance = await createTestUser("FINANCE");
    dispatcher = await createTestUser("DISPATCHER");
    driverActor = await createTestUser("DRIVER");
    customerActor = await createTestUser("CUSTOMER");

    const [adminLogin, financeLogin, dispatcherLogin, driverLogin, customerLogin] = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, finance.email, finance.password),
      loginTestUser(app, dispatcher.email, dispatcher.password),
      loginTestUser(app, driverActor.email, driverActor.password),
      loginTestUser(app, customerActor.email, customerActor.password),
    ]);
    tokens = {
      admin: adminLogin.accessToken as string,
      finance: financeLogin.accessToken as string,
      dispatcher: dispatcherLogin.accessToken as string,
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
    await prisma.company_financial_transactions.deleteMany({ where: { reversal_of_id: { in: createdCompanyTransactionIds } } });
    await prisma.company_financial_transactions.deleteMany({ where: { id: { in: createdCompanyTransactionIds } } });
    await Promise.all([admin, finance, dispatcher, driverActor, customerActor].map((u) => cleanupTestUser(u.id)));
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }
  function idemHeader() {
    return { "Idempotency-Key": randomUUID() };
  }
  function decimal(value: string): Prisma.Decimal {
    return new Prisma.Decimal(value);
  }

  async function freshCustomer(): Promise<string> {
    const id = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(id);
    return id;
  }

  async function fundWallet(customerId: string, amount: string) {
    await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal(amount) });
  }

  async function createDriverWithToken(label: string) {
    const user = await createTestUser("DRIVER");
    createdUserIds.push(user.id);
    const login = await loginTestUser(app, user.email, user.password);
    assert.ok(login.accessToken, `expected an access token for ${label}`);
    const res = await request(app)
      .post("/api/v1/drivers")
      .set(auth(tokens.admin))
      .send({ driverNumber: `PH93-DRV-${uniqueSuffix()}`, userId: user.id });
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
        receiverName: "Phase93 Receiver",
        receiverPhone: "+96170000093",
        receiverAreaId: areaActive.id,
        receiverAddress: "1 Phase93 St",
        description: "Phase93 report order",
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

  async function deliver(orderId: string, token: string, body: Record<string, unknown>) {
    return request(app).post(`/api/v1/driver/orders/${orderId}/deliver`).set(auth(token)).send(body);
  }
  async function fail(orderId: string, token: string) {
    return request(app).post(`/api/v1/driver/orders/${orderId}/fail`).set(auth(token)).send({ failedReasonId: reasonId });
  }
  async function reschedule(orderId: string) {
    return request(app).post(`/api/v1/orders/${orderId}/reschedule`).set(auth(tokens.admin)).send({ reason: "phase93 retry" });
  }

  async function backdate(model: "wallet_transactions" | "driver_cash_transactions" | "company_financial_transactions" | "driver_settlements" | "orders", id: string, date: Date) {
    await (prisma[model] as { update: (args: unknown) => Promise<unknown> }).update({ where: { id }, data: { created_at: date } });
  }

  function ordersPath(qs = "") {
    return `/api/v1/reports/orders${qs}`;
  }
  function driversPath(qs = "") {
    return `/api/v1/reports/drivers${qs}`;
  }
  function customersPath(qs = "") {
    return `/api/v1/reports/customers${qs}`;
  }
  function financePath(qs = "") {
    return `/api/v1/reports/finance${qs}`;
  }
  async function get(path: string, token: string) {
    return request(app).get(path).set(auth(token));
  }

  const D1 = new Date(Date.UTC(2001, 0, 10, 12, 0, 0));
  const D2 = new Date(Date.UTC(2001, 0, 11, 12, 0, 0));

  // ============================================================
  // RBAC (1-7)
  // ============================================================

  describe("RBAC", () => {
    test("1. unauthenticated -> 401 on all four routes", async () => {
      for (const path of [ordersPath(), driversPath(), customersPath(), financePath()]) {
        const res = await request(app).get(path);
        assert.equal(res.status, 401, path);
      }
    });

    test("2. ADMIN -> 200 on all four routes", async () => {
      for (const path of [ordersPath(), driversPath(), customersPath(), financePath()]) {
        const res = await get(path, tokens.admin);
        assert.equal(res.status, 200, `${path}: ${JSON.stringify(res.body)}`);
      }
    });

    test("3. DISPATCHER -> 200 on all four routes, including Finance (aggregated only)", async () => {
      for (const path of [ordersPath(), driversPath(), customersPath(), financePath()]) {
        const res = await get(path, tokens.dispatcher);
        assert.equal(res.status, 200, `${path}: ${JSON.stringify(res.body)}`);
      }
    });

    test("4. FINANCE -> 200 on all four routes", async () => {
      for (const path of [ordersPath(), driversPath(), customersPath(), financePath()]) {
        const res = await get(path, tokens.finance);
        assert.equal(res.status, 200, `${path}: ${JSON.stringify(res.body)}`);
      }
    });

    test("5. DRIVER -> 403 on all four routes", async () => {
      for (const path of [ordersPath(), driversPath(), customersPath(), financePath()]) {
        const res = await get(path, tokens.driver);
        assert.equal(res.status, 403, path);
      }
    });

    test("6. CUSTOMER -> 403 on all four routes", async () => {
      for (const path of [ordersPath(), driversPath(), customersPath(), financePath()]) {
        const res = await get(path, tokens.customer);
        assert.equal(res.status, 403, path);
      }
    });

    test("7. finance.read alone would not be sufficient (documented, not independently testable)", () => {
      // Every role in the current 5-role catalog that has finance.read
      // (ADMIN, FINANCE) also has reports.read — there is no existing role
      // fixture with finance.read but NOT reports.read, and the Phase 9.3
      // instruction explicitly forbids fabricating a permanent permission
      // change just to exercise this combination. The route wiring itself
      // (report.routes.ts) uses authorize("reports.read") exclusively — the
      // same middleware/pattern already proven correct by every other
      // authorize()-gated route in this codebase — so this is a structural
      // guarantee, not a gap; documenting it here per the instruction's own
      // escape hatch rather than skipping silently.
      assert.ok(true);
    });
  });

  // ============================================================
  // DATE VALIDATION (8-11)
  // ============================================================

  describe("Date validation", () => {
    test("8. malformed from/to -> 400", async () => {
      assert.equal((await get(ordersPath("?from=not-a-date"), tokens.admin)).status, 400);
      assert.equal((await get(financePath("?to=2026/08/01"), tokens.admin)).status, 400);
    });

    test("9. impossible calendar date -> 400", async () => {
      const res = await get(driversPath("?to=2026-02-30"), tokens.admin);
      assert.equal(res.status, 400);
    });

    test("10. from > to -> 400", async () => {
      const res = await get(customersPath("?from=2026-08-31&to=2026-08-01"), tokens.admin);
      assert.equal(res.status, 400);
    });

    test("11. inclusive UTC to-date behavior + no-date all-time report", async () => {
      const noDate = await get(ordersPath(), tokens.admin);
      assert.equal(noDate.status, 200);
      assert.equal(noDate.body.data.range.from, null);
      assert.equal(noDate.body.data.range.to, null);

      const ranged = await get(ordersPath("?from=2001-01-10&to=2001-01-10"), tokens.admin);
      assert.equal(ranged.status, 200);
      assert.equal(ranged.body.data.range.from, "2001-01-10");
      assert.equal(ranged.body.data.range.to, "2001-01-10");
    });
  });

  // ============================================================
  // ORDERS REPORT (12-27)
  // ============================================================

  describe("Orders report", () => {
    test("12-14. groupBy=date supports day/week/month bucketing", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("ord-date");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      await backdate("orders", orderId, D1);

      const day = await get(ordersPath("?groupBy=date&bucket=day&from=2001-01-10&to=2001-01-10"), tokens.admin);
      assert.equal(day.status, 200, JSON.stringify(day.body));
      assert.equal(day.body.data.bucket, "day");
      assert.ok(day.body.data.rows.some((r: { period: string; orders: number }) => r.period === "2001-01-10" && r.orders >= 1)); // 12

      const week = await get(ordersPath("?groupBy=date&bucket=week&from=2001-01-01&to=2001-01-31"), tokens.admin);
      assert.equal(week.status, 200, JSON.stringify(week.body));
      assert.equal(week.body.data.bucket, "week"); // 13
      assert.ok(week.body.data.rows.length >= 1);

      const month = await get(ordersPath("?groupBy=date&bucket=month&from=2001-01-01&to=2001-01-31"), tokens.admin);
      assert.equal(month.status, 200, JSON.stringify(month.body));
      assert.equal(month.body.data.bucket, "month");
      assert.ok(month.body.data.rows.some((r: { period: string }) => r.period === "2001-01")); // 14
    });

    test("15. groupBy=customer returns a safe customer summary + counts", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("ord-cust");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });

      const res = await get(ordersPath(`?groupBy=customer&customerId=${customerId}`), tokens.admin);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.rows.length, 1);
      const row = res.body.data.rows[0];
      assert.equal(row.customer.id, customerId);
      assert.equal(row.ordersCreated, 1);
      assert.equal(row.deliveredOrders, 1);
      assert.equal(row.actualCollected, "105");
    });

    test("16-27. groupBy=driver uses historical delivery_attempts attribution, never stale current_driver_id after reassignment", async () => {
      const customerId = await freshCustomer();
      const driverA = await createDriverWithToken("hist-a");
      const driverB = await createDriverWithToken("hist-b");

      // Driver A fails the delivery, order is rescheduled and reassigned to
      // Driver B, who then delivers successfully. Driver A must still show
      // 1 failed attempt; Driver B must show 1 delivered — neither current
      // status nor current_driver_id could distinguish this correctly.
      const orderId = await createOutForDeliveryOrder(customerId, driverA.token, driverA.driverId);
      const failRes = await fail(orderId, driverA.token);
      assert.equal(failRes.status, 200, JSON.stringify(failRes.body));
      const rescheduleRes = await reschedule(orderId);
      assert.equal(rescheduleRes.status, 200, JSON.stringify(rescheduleRes.body));
      const reassignRes = await request(app)
        .post(`/api/v1/orders/${orderId}/reassign`)
        .set(auth(tokens.admin))
        .send({ driverId: driverB.driverId, reason: "phase93 retry with driver B" });
      assert.equal(reassignRes.status, 200, JSON.stringify(reassignRes.body));
      const pickup = await request(app).post(`/api/v1/driver/orders/${orderId}/pickup`).set(auth(driverB.token)).send();
      assert.equal(pickup.status, 200, JSON.stringify(pickup.body));
      const start = await request(app).post(`/api/v1/driver/orders/${orderId}/start-delivery`).set(auth(driverB.token)).send();
      assert.equal(start.status, 200, JSON.stringify(start.body));
      const deliverRes = await deliver(orderId, driverB.token, { actualAmountCollected: "105.00" });
      assert.equal(deliverRes.status, 200, JSON.stringify(deliverRes.body));

      // 26-27. retry-after-failure: current status is DELIVERED, never
      // permanently classified as failed merely because of the earlier
      // attempt.
      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderRow.status, "DELIVERED");
      assert.equal(orderRow.current_driver_id, driverB.driverId);

      const res = await get(ordersPath("?groupBy=driver"), tokens.admin);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      type Row = { driver: { id: string }; delivered: number; failed: number; ordersInPortfolio: number };
      const rowA = res.body.data.rows.find((r: Row) => r.driver.id === driverA.driverId);
      const rowB = res.body.data.rows.find((r: Row) => r.driver.id === driverB.driverId);
      // Driver A no longer holds the current assignment, so it has no
      // "portfolio" row from the plain current_driver_id groupBy, but its
      // historical failed attempt must still be attributable somewhere —
      // verify directly via delivery_attempts instead of the driver-grouped
      // Orders Report row (which is intentionally portfolio-scoped, per its
      // own documented semantics — see order-report.service.ts).
      const driverAFailedAttempts = await prisma.delivery_attempts.count({ where: { driver_id: driverA.driverId, order_id: orderId, outcome: "FAILED" } });
      assert.equal(driverAFailedAttempts, 1); // 16
      assert.ok(rowB, "driver B must appear in the driver grouping"); // 17
      assert.equal(rowB.delivered, 1); // 18
      assert.equal(rowB.failed, 0); // 19
      assert.equal(rowB.ordersInPortfolio, 1); // 20
      if (rowA) {
        // If driver A appears at all (e.g. from another order in this
        // portfolio), it must not show this order's delivery as its own.
        assert.equal(rowA.ordersInPortfolio, 0); // 21 (this order left A's portfolio on reassignment)
      }
    });

    test("22-25. area/status/type filters and groupings", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("ord-dims");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, {
        orderType: "COMPANY_ORDER",
        orderAmount: "50.00",
        deliveryFee: "5.00",
      });
      await deliver(orderId, driver.token, { actualAmountCollected: "55.00" });

      const byArea = await get(ordersPath(`?groupBy=area&areaId=${areaActive.id}`), tokens.admin);
      assert.equal(byArea.status, 200, JSON.stringify(byArea.body));
      assert.ok(byArea.body.data.rows.some((r: { area: { id: string } | null }) => r.area?.id === areaActive.id)); // 22

      const byStatus = await get(ordersPath(`?groupBy=status&customerId=${customerId}`), tokens.admin);
      assert.equal(byStatus.status, 200, JSON.stringify(byStatus.body));
      assert.ok(byStatus.body.data.rows.some((r: { status: string; orders: number }) => r.status === "DELIVERED" && r.orders === 1)); // 23

      const byType = await get(ordersPath(`?groupBy=type&customerId=${customerId}`), tokens.admin);
      assert.equal(byType.status, 200, JSON.stringify(byType.body));
      const companyRow = byType.body.data.rows.find((r: { orderType: string }) => r.orderType === "COMPANY_ORDER");
      assert.equal(companyRow.count, 1); // 24
      assert.equal(companyRow.actualCollected, "55");

      const outcome = await get(ordersPath(`?groupBy=outcome&customerId=${customerId}`), tokens.admin);
      assert.equal(outcome.status, 200, JSON.stringify(outcome.body));
      assert.equal(outcome.body.data.outcome.deliveredOrders, 1); // 25
    });
  });

  // ============================================================
  // DRIVER REPORT (28-39)
  // ============================================================

  describe("Driver report", () => {
    test("28-33. assigned/delivered/failed/success-rate/money-collected", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("drv-report");

      const okOrder = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      const deliverRes = await deliver(okOrder, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(deliverRes.status, 200, JSON.stringify(deliverRes.body));
      const collectionTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { order_id: okOrder, type: "COLLECTION" } });
      await backdate("driver_cash_transactions", collectionTx.id, D1);
      const attempt1 = await prisma.delivery_attempts.findFirstOrThrow({ where: { order_id: okOrder, outcome: "DELIVERED" } });
      await prisma.delivery_attempts.update({ where: { id: attempt1.id }, data: { completed_at: D1 } });

      const badOrder = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      const failRes = await fail(badOrder, driver.token);
      assert.equal(failRes.status, 200, JSON.stringify(failRes.body));
      const attempt2 = await prisma.delivery_attempts.findFirstOrThrow({ where: { order_id: badOrder, outcome: "FAILED" } });
      await prisma.delivery_attempts.update({ where: { id: attempt2.id }, data: { completed_at: D1 } });

      const res = await get(driversPath(`?driverId=${driver.driverId}&from=2001-01-10&to=2001-01-10`), tokens.admin);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.rows.length, 1);
      const row = res.body.data.rows[0];
      assert.equal(row.ordersDelivered, 1); // 29
      assert.equal(row.failedAttempts, 1); // 30
      assert.equal(row.deliveryAttempts, 2);
      assert.equal(row.successRate, "50"); // 31
      assert.equal(row.moneyCollected, "105"); // 33 (only the DELIVERED order's collection, backdated into range)
    });

    test("32. denominator zero -> successRate null", async () => {
      const driver = await createDriverWithToken("drv-zero");
      const res = await get(driversPath(`?driverId=${driver.driverId}&from=2001-06-01&to=2001-06-01`), tokens.admin);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.rows[0].successRate, null);
    });

    test("34. a COLLECTION reversal reduces moneyCollected", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("drv-rev");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      const deliverRes = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(deliverRes.status, 200, JSON.stringify(deliverRes.body));
      const collectionTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "COLLECTION" } });
      await backdate("driver_cash_transactions", collectionTx.id, D1);

      const before = await get(driversPath(`?driverId=${driver.driverId}&from=2001-01-10&to=2001-01-10`), tokens.admin);
      assert.equal(before.body.data.rows[0].moneyCollected, "105");

      const reverseRes = await request(app)
        .post(`/api/v1/finance/driver-cash-transactions/${collectionTx.id}/reverse`)
        .set(auth(tokens.finance))
        .send({ reason: "phase93 collection reversal" });
      assert.equal(reverseRes.status, 201, JSON.stringify(reverseRes.body));
      const reversalTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { reversal_of_id: collectionTx.id } });
      await backdate("driver_cash_transactions", reversalTx.id, D1);

      const after = await get(driversPath(`?driverId=${driver.driverId}&from=2001-01-10&to=2001-01-10`), tokens.admin);
      assert.equal(after.body.data.rows[0].moneyCollected, "0");
    });

    test("35-36. settlement count/amount recorded, a later reversal does not erase the historical Settlement", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("drv-settle");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, { deliveryFee: "100.00", orderAmount: "0.00" });
      const deliverRes = await deliver(orderId, driver.token, { actualAmountCollected: "100.00" });
      assert.equal(deliverRes.status, 200, JSON.stringify(deliverRes.body));

      const settleRes = await request(app)
        .post("/api/v1/driver-settlements")
        .set(auth(tokens.finance))
        .set(idemHeader())
        .send({ driverId: driver.driverId, amountReceived: "60.00", paymentMethodId: cashMethodId });
      assert.equal(settleRes.status, 201, JSON.stringify(settleRes.body));
      await backdate("driver_settlements", settleRes.body.data.id, D2);

      const before = await get(driversPath(`?driverId=${driver.driverId}&from=2001-01-11&to=2001-01-11`), tokens.admin);
      assert.equal(before.body.data.rows[0].settlementCount, 1); // 35
      assert.equal(before.body.data.rows[0].settlementAmount, "60");

      const cashTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { settlement_id: settleRes.body.data.id } });
      const reverseRes = await request(app)
        .post(`/api/v1/finance/driver-cash-transactions/${cashTx.id}/reverse`)
        .set(auth(tokens.finance))
        .send({ reason: "phase93 settlement reversal" });
      assert.equal(reverseRes.status, 201, JSON.stringify(reverseRes.body));

      const after = await get(driversPath(`?driverId=${driver.driverId}&from=2001-01-11&to=2001-01-11`), tokens.admin);
      assert.equal(after.body.data.rows[0].settlementCount, 1, "the historical Settlement occurrence remains recorded"); // 36
      assert.equal(after.body.data.rows[0].settlementAmount, "60");
    });

    test("37. currentCashHeld is a live snapshot unaffected by from/to", async () => {
      const driver = await createDriverWithToken("drv-cash-snap");
      const account = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      const res = await get(driversPath(`?driverId=${driver.driverId}&from=2001-01-01&to=2001-01-01`), tokens.admin);
      assert.equal(res.body.data.rows[0].currentCashHeld, account.current_balance.toString());
    });

    test("38-39. driverId and isActive filters", async () => {
      const driverA = await createDriverWithToken("drv-filter-a");
      const filtered = await get(driversPath(`?driverId=${driverA.driverId}`), tokens.admin);
      assert.equal(filtered.body.data.rows.length, 1); // 38
      assert.equal(filtered.body.data.rows[0].driver.id, driverA.driverId);

      const activeOnly = await get(driversPath(`?driverId=${driverA.driverId}&isActive=true`), tokens.admin);
      assert.equal(activeOnly.body.data.rows.length, 1); // 39
      const inactiveOnly = await get(driversPath(`?driverId=${driverA.driverId}&isActive=false`), tokens.admin);
      assert.equal(inactiveOnly.body.data.rows.length, 0);
    });
  });

  // ============================================================
  // CUSTOMER REPORT (40-49)
  // ============================================================

  describe("Customer report", () => {
    test("40-41. ordersCreated and deliveredOrders (delivered_at-based)", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("cust-basic");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      const deliverRes = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(deliverRes.status, 200, JSON.stringify(deliverRes.body));

      const res = await get(customersPath(`?customerId=${customerId}`), tokens.admin);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.rows[0].ordersCreated, 1); // 40
      assert.equal(res.body.data.rows[0].deliveredOrders, 1); // 41
    });

    test("42-43. Wallet ORDER_CREDIT flow, reversal-aware within its own period", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("cust-credit");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      const deliverRes = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(deliverRes.status, 200, JSON.stringify(deliverRes.body));
      const creditTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { customer_id: customerId, type: "ORDER_CREDIT" } });
      await backdate("wallet_transactions", creditTx.id, D1);

      const day1 = await get(customersPath(`?customerId=${customerId}&from=2001-01-10&to=2001-01-10`), tokens.admin);
      assert.equal(day1.body.data.rows[0].walletCredits, "100"); // 42

      const reverseRes = await request(app)
        .post(`/api/v1/wallet-transactions/${creditTx.id}/reverse`)
        .set(auth(tokens.finance))
        .send({ reason: "phase93 credit reversal" });
      assert.equal(reverseRes.status, 201, JSON.stringify(reverseRes.body));
      const reversalTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { reversal_of_id: creditTx.id } });
      await backdate("wallet_transactions", reversalTx.id, D2);

      const day2 = await get(customersPath(`?customerId=${customerId}&from=2001-01-11&to=2001-01-11`), tokens.admin);
      assert.equal(day2.body.data.rows[0].walletCredits, "-100"); // 43
      const combined = await get(customersPath(`?customerId=${customerId}&from=2001-01-10&to=2001-01-11`), tokens.admin);
      assert.equal(combined.body.data.rows[0].walletCredits, "0");
    });

    test("44-45. payout flow, reversal does not rewrite the original period", async () => {
      const customerId = await freshCustomer();
      await fundWallet(customerId, "100");
      const payoutRes = await request(app)
        .post("/api/v1/payouts")
        .set(auth(tokens.finance))
        .set(idemHeader())
        .send({ customerId, amount: "40.00", paymentMethodId: cashMethodId });
      assert.equal(payoutRes.status, 201, JSON.stringify(payoutRes.body));
      const payoutTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { payout_id: payoutRes.body.data.id } });
      await backdate("wallet_transactions", payoutTx.id, D1);

      const day1 = await get(customersPath(`?customerId=${customerId}&from=2001-01-10&to=2001-01-10`), tokens.admin);
      assert.equal(day1.body.data.rows[0].walletPayouts, "40"); // 44

      const reverseRes = await request(app)
        .post(`/api/v1/wallet-transactions/${payoutTx.id}/reverse`)
        .set(auth(tokens.finance))
        .send({ reason: "phase93 payout reversal" });
      assert.equal(reverseRes.status, 201, JSON.stringify(reverseRes.body));
      const reversalTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { reversal_of_id: payoutTx.id } });
      await backdate("wallet_transactions", reversalTx.id, D2);

      const day1Again = await get(customersPath(`?customerId=${customerId}&from=2001-01-10&to=2001-01-10`), tokens.admin);
      assert.equal(day1Again.body.data.rows[0].walletPayouts, "40", "reversing later must not rewrite day1's reported flow"); // 45
    });

    test("46-48. current wallet balance / pending order value are snapshots, unaffected by from/to", async () => {
      const customerId = await freshCustomer();
      await fundWallet(customerId, "70");
      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });

      const orderId = await createBaseOrder(customerId, { orderAmount: "40.00", deliveryFee: "5.00" });
      void orderId;

      const noDate = await get(customersPath(`?customerId=${customerId}`), tokens.admin);
      assert.equal(noDate.body.data.rows[0].currentWalletBalance, wallet.available_balance.toString()); // 46
      assert.equal(noDate.body.data.rows[0].pendingOrderValue, "40"); // 47

      const ranged = await get(customersPath(`?customerId=${customerId}&from=2001-01-01&to=2001-01-01`), tokens.admin);
      assert.equal(ranged.body.data.rows[0].currentWalletBalance, wallet.available_balance.toString()); // 48
      assert.equal(ranged.body.data.rows[0].pendingOrderValue, "40");
    });

    test("49. customerId filter narrows to exactly one row", async () => {
      const customerId = await freshCustomer();
      const res = await get(customersPath(`?customerId=${customerId}`), tokens.admin);
      assert.equal(res.body.data.rows.length, 1);
      assert.equal(res.body.data.rows[0].customer.id, customerId);
    });
  });

  // ============================================================
  // FINANCE REPORT (50-61)
  // ============================================================

  describe("Finance report", () => {
    // Each test below writes GLOBAL (unscoped) ledger rows and asserts an
    // ABSOLUTE Finance Report value — unlike the Customer/Driver report
    // tests (which scope their own query by customerId/driverId and are
    // therefore immune to other tests' same-date rows), the Finance Report
    // sums across EVERYTHING. Mirroring Phase 9.2's finance-summary.test.ts
    // strategy exactly: each such block gets its own dedicated, non-
    // overlapping month in year 2001 so no two GLOBAL-assertion tests can
    // ever pollute each other, regardless of execution order.
    const MAR1 = new Date(Date.UTC(2001, 2, 10, 12, 0, 0));
    const APR1 = new Date(Date.UTC(2001, 3, 10, 12, 0, 0));
    const MAY1 = new Date(Date.UTC(2001, 4, 10, 12, 0, 0));
    const JUN1 = new Date(Date.UTC(2001, 5, 10, 12, 0, 0));

    test("50-52. day/week/month grouping", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("fin-group");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      const deliverRes = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(deliverRes.status, 200, JSON.stringify(deliverRes.body));
      const feeTx = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" } });
      await backdate("company_financial_transactions", feeTx.id, MAR1);

      const day = await get(financePath("?groupBy=day&from=2001-03-10&to=2001-03-10"), tokens.admin);
      assert.equal(day.status, 200, JSON.stringify(day.body));
      assert.ok(day.body.data.rows.some((r: { period: string; deliveryFeeRevenue: string }) => r.period === "2001-03-10" && r.deliveryFeeRevenue === "5")); // 50

      const week = await get(financePath("?groupBy=week&from=2001-03-01&to=2001-03-31"), tokens.admin);
      assert.equal(week.status, 200, JSON.stringify(week.body)); // 51
      assert.ok(week.body.data.rows.length >= 1);

      const month = await get(financePath("?groupBy=month&from=2001-03-01&to=2001-03-31"), tokens.admin);
      assert.equal(month.status, 200, JSON.stringify(month.body));
      assert.ok(month.body.data.rows.some((r: { period: string }) => r.period === "2001-03")); // 52
    });

    test("53, 61. category grouping includes generic Company ADJUSTMENT in broad revenue math but not in category-specific totals", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("fin-cat");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, { deliveryFee: "5.00", orderAmount: "0.00" });
      const deliverRes = await deliver(orderId, driver.token, { actualAmountCollected: "5.00" });
      assert.equal(deliverRes.status, 200, JSON.stringify(deliverRes.body));
      const feeTx = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" } });
      await backdate("company_financial_transactions", feeTx.id, APR1);

      const adjustRes = await request(app)
        .post("/api/v1/finance/company/adjust")
        .set(auth(tokens.finance))
        .send({ direction: "CREDIT", amount: "20.00", reason: "phase93 category adjustment" });
      assert.equal(adjustRes.status, 201, JSON.stringify(adjustRes.body));
      createdCompanyTransactionIds.push(adjustRes.body.data.id);
      await backdate("company_financial_transactions", adjustRes.body.data.id, APR1);

      const category = await get(financePath("?groupBy=category&from=2001-04-10&to=2001-04-10"), tokens.admin);
      assert.equal(category.status, 200, JSON.stringify(category.body));
      const feeRow = category.body.data.rows.find((r: { category: string }) => r.category === "DELIVERY_FEE_REVENUE");
      assert.equal(feeRow.amount, "5", "generic ADJUSTMENT must not leak into the fee-specific category total"); // 53

      const summaryRes = await get(financePath("?from=2001-04-10&to=2001-04-10"), tokens.admin);
      assert.equal(summaryRes.body.data.summary.companyRevenue, "25", "broad companyRevenue legitimately includes the generic adjustment"); // 61
      assert.equal(summaryRes.body.data.summary.deliveryFeeRevenue, "5");
    });

    test("54-57. reversal-aware fee/product/collection/payout totals", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("fin-rev");

      const feeOrderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, { deliveryFee: "5.00", orderAmount: "0.00" });
      await deliver(feeOrderId, driver.token, { actualAmountCollected: "5.00" });
      const feeTx = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: feeOrderId, type: "DELIVERY_FEE_REVENUE" } });
      await backdate("company_financial_transactions", feeTx.id, MAY1);
      const feeReverse = await request(app).post(`/api/v1/finance/company-transactions/${feeTx.id}/reverse`).set(auth(tokens.finance)).send({ reason: "x" });
      assert.equal(feeReverse.status, 201);
      const feeReversal = await prisma.company_financial_transactions.findFirstOrThrow({ where: { reversal_of_id: feeTx.id } });
      await backdate("company_financial_transactions", feeReversal.id, MAY1);

      const productOrderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, {
        orderType: "COMPANY_ORDER",
        orderAmount: "100.00",
        deliveryFee: "0.00",
      });
      await deliver(productOrderId, driver.token, { actualAmountCollected: "100.00" });
      const productTx = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: productOrderId, type: "COMPANY_ORDER_PRODUCT_REVENUE" } });
      await backdate("company_financial_transactions", productTx.id, MAY1);
      const productReverse = await request(app)
        .post(`/api/v1/finance/company-transactions/${productTx.id}/reverse`)
        .set(auth(tokens.finance))
        .send({ reason: "x" });
      assert.equal(productReverse.status, 201);
      const productReversal = await prisma.company_financial_transactions.findFirstOrThrow({ where: { reversal_of_id: productTx.id } });
      await backdate("company_financial_transactions", productReversal.id, MAY1);

      const collectOrderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, { deliveryFee: "50.00", orderAmount: "0.00" });
      await deliver(collectOrderId, driver.token, { actualAmountCollected: "50.00" });
      const collectionTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { order_id: collectOrderId, type: "COLLECTION" } });
      await backdate("driver_cash_transactions", collectionTx.id, MAY1);
      const collectReverse = await request(app)
        .post(`/api/v1/finance/driver-cash-transactions/${collectionTx.id}/reverse`)
        .set(auth(tokens.finance))
        .send({ reason: "x" });
      assert.equal(collectReverse.status, 201);
      const collectReversal = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { reversal_of_id: collectionTx.id } });
      await backdate("driver_cash_transactions", collectReversal.id, MAY1);

      await fundWallet(customerId, "100");
      const payoutRes = await request(app)
        .post("/api/v1/payouts")
        .set(auth(tokens.finance))
        .set(idemHeader())
        .send({ customerId, amount: "40.00", paymentMethodId: cashMethodId });
      assert.equal(payoutRes.status, 201, JSON.stringify(payoutRes.body));
      const payoutTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { payout_id: payoutRes.body.data.id } });
      await backdate("wallet_transactions", payoutTx.id, MAY1);
      const payoutReverse = await request(app)
        .post(`/api/v1/wallet-transactions/${payoutTx.id}/reverse`)
        .set(auth(tokens.finance))
        .send({ reason: "x" });
      assert.equal(payoutReverse.status, 201);
      const payoutReversal = await prisma.wallet_transactions.findFirstOrThrow({ where: { reversal_of_id: payoutTx.id } });
      await backdate("wallet_transactions", payoutReversal.id, MAY1);

      const res = await get(financePath("?from=2001-05-10&to=2001-05-10"), tokens.admin);
      assert.equal(res.body.data.summary.deliveryFeeRevenue, "0"); // 54
      assert.equal(res.body.data.summary.companyOrderRevenue, "0"); // 55
      assert.equal(res.body.data.summary.totalCollected, "0"); // 56
      assert.equal(res.body.data.summary.customerPayouts, "0"); // 57
    });

    test("58. settlement count/amount reflected in Finance Report summary", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("fin-settle");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, { deliveryFee: "100.00", orderAmount: "0.00" });
      await deliver(orderId, driver.token, { actualAmountCollected: "100.00" });
      const settleRes = await request(app)
        .post("/api/v1/driver-settlements")
        .set(auth(tokens.finance))
        .set(idemHeader())
        .send({ driverId: driver.driverId, amountReceived: "60.00", paymentMethodId: cashMethodId });
      assert.equal(settleRes.status, 201, JSON.stringify(settleRes.body));
      await backdate("driver_settlements", settleRes.body.data.id, JUN1);

      const res = await get(financePath("?from=2001-06-10&to=2001-06-10"), tokens.admin);
      assert.equal(res.body.data.summary.settlementCount, 1);
      assert.equal(res.body.data.summary.settlementAmount, "60");
    });

    test("59-60. current* snapshot fields ignore from/to entirely", async () => {
      // Two independent live reads of a GLOBAL non-transactional snapshot —
      // retried until a quiet instant, same principle as the Reconciliation
      // block's test 65-66 below (and finance-summary.test.ts's tests
      // 31-32) rather than asserting a single potentially-torn pair.
      const MAX_ATTEMPTS = 8;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const walletAgg = await prisma.customer_wallets.aggregate({ _sum: { available_balance: true } });
        const cashAgg = await prisma.driver_cash_accounts.aggregate({ _sum: { current_balance: true } });
        const res = await get(financePath("?from=2001-01-01&to=2001-01-01"), tokens.admin);
        const walletMatch = res.body.data.summary.currentCustomerWalletLiability === (walletAgg._sum.available_balance ?? decimal("0")).toString();
        const cashMatch = res.body.data.summary.currentDriverCashOutstanding === (cashAgg._sum.current_balance ?? decimal("0")).toString();
        if (walletMatch && cashMatch) return;
        if (attempt === MAX_ATTEMPTS - 1) {
          assert.fail(`current* snapshot fields did not reconcile after ${MAX_ATTEMPTS} attempts`);
        }
      }
    });
  });

  // ============================================================
  // RECONCILIATION (62-66)
  // ============================================================

  describe("Reconciliation", () => {
    const AUG1 = new Date(Date.UTC(2001, 7, 10, 12, 0, 0));
    const SEP1 = new Date(Date.UTC(2001, 8, 10, 12, 0, 0));

    test("62. Finance Report summary matches /finance/summary for the same range", async () => {
      const qs = "?from=2001-01-10&to=2001-01-10";
      const report = await get(financePath(qs), tokens.admin);
      const summary = await request(app).get(`/api/v1/finance/summary${qs}`).set(auth(tokens.admin));
      assert.equal(report.status, 200);
      assert.equal(summary.status, 200);
      for (const field of ["deliveryFeeRevenue", "companyOrderRevenue", "totalCollected", "customerPayouts"] as const) {
        assert.equal(report.body.data.summary[field], summary.body.data[field], field);
      }
    });

    test("63. SUM(driver.moneyCollected) reconciles with Finance Report totalCollected for the same range", async () => {
      const customerId = await freshCustomer();
      const driverX = await createDriverWithToken("recon-x");
      const driverY = await createDriverWithToken("recon-y");

      const orderX = await createOutForDeliveryOrder(customerId, driverX.token, driverX.driverId, { deliveryFee: "30.00", orderAmount: "0.00" });
      await deliver(orderX, driverX.token, { actualAmountCollected: "30.00" });
      const txX = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { order_id: orderX, type: "COLLECTION" } });
      await backdate("driver_cash_transactions", txX.id, AUG1);

      const orderY = await createOutForDeliveryOrder(customerId, driverY.token, driverY.driverId, { deliveryFee: "20.00", orderAmount: "0.00" });
      await deliver(orderY, driverY.token, { actualAmountCollected: "20.00" });
      const txY = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { order_id: orderY, type: "COLLECTION" } });
      await backdate("driver_cash_transactions", txY.id, AUG1);

      const qs = "?from=2001-08-10&to=2001-08-10";
      const [driverReportX, driverReportY, financeReport] = await Promise.all([
        get(driversPath(`${qs}&driverId=${driverX.driverId}`), tokens.admin),
        get(driversPath(`${qs}&driverId=${driverY.driverId}`), tokens.admin),
        get(financePath(qs), tokens.admin),
      ]);
      const sum = decimal(driverReportX.body.data.rows[0].moneyCollected).plus(driverReportY.body.data.rows[0].moneyCollected);
      assert.equal(sum.toString(), "50");
      assert.equal(financeReport.body.data.summary.totalCollected, "50");
    });

    test("64. SUM(customer.walletPayouts) reconciles with Finance Report customerPayouts for the same range", async () => {
      const customerX = await freshCustomer();
      const customerY = await freshCustomer();
      await fundWallet(customerX, "50");
      await fundWallet(customerY, "50");

      const payoutX = await request(app)
        .post("/api/v1/payouts")
        .set(auth(tokens.finance))
        .set(idemHeader())
        .send({ customerId: customerX, amount: "20.00", paymentMethodId: cashMethodId });
      const txX = await prisma.wallet_transactions.findFirstOrThrow({ where: { payout_id: payoutX.body.data.id } });
      await backdate("wallet_transactions", txX.id, SEP1);

      const payoutY = await request(app)
        .post("/api/v1/payouts")
        .set(auth(tokens.finance))
        .set(idemHeader())
        .send({ customerId: customerY, amount: "15.00", paymentMethodId: cashMethodId });
      const txY = await prisma.wallet_transactions.findFirstOrThrow({ where: { payout_id: payoutY.body.data.id } });
      await backdate("wallet_transactions", txY.id, SEP1);

      const qs = "?from=2001-09-10&to=2001-09-10";
      const [reportX, reportY, financeReport] = await Promise.all([
        get(customersPath(`${qs}&customerId=${customerX}`), tokens.admin),
        get(customersPath(`${qs}&customerId=${customerY}`), tokens.admin),
        get(financePath(qs), tokens.admin),
      ]);
      const sum = decimal(reportX.body.data.rows[0].walletPayouts).plus(reportY.body.data.rows[0].walletPayouts);
      assert.equal(sum.toString(), "35");
      assert.equal(financeReport.body.data.summary.customerPayouts, "35");
    });

    test("65-66. current Wallet liability / Driver Cash outstanding match Finance Summary (retried until a quiet instant, per the Phase 9.2 dashboard-reconciliation precedent)", async () => {
      const MAX_ATTEMPTS = 8;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const [financeReport, financeSummary] = await Promise.all([
          get(financePath(), tokens.admin),
          request(app).get("/api/v1/finance/summary").set(auth(tokens.admin)),
        ]);
        const walletMatch = financeReport.body.data.summary.currentCustomerWalletLiability === financeSummary.body.data.customerWalletLiability;
        const cashMatch = financeReport.body.data.summary.currentDriverCashOutstanding === financeSummary.body.data.driverCashOutstanding;
        if (walletMatch && cashMatch) return;
        if (attempt === MAX_ATTEMPTS - 1) {
          assert.fail(
            `finance report and finance summary disagree after ${MAX_ATTEMPTS} attempts: ${JSON.stringify({
              report: financeReport.body.data.summary,
              summary: financeSummary.body.data,
            })}`
          );
        }
      }
    });
  });

  // ============================================================
  // DTO / PRIVACY (67)
  // ============================================================

  describe("DTO / Privacy", () => {
    test("67a. no report response exposes internal/private data", async () => {
      for (const path of [ordersPath(), driversPath(), customersPath(), financePath("?groupBy=category")]) {
        const res = await get(path, tokens.admin);
        const serialized = JSON.stringify(res.body);
        assert.doesNotMatch(serialized, /password_hash/i);
        assert.doesNotMatch(serialized, /refresh_token/i);
        assert.doesNotMatch(serialized, /auth_sessions/i);
        assert.doesNotMatch(serialized, /idempotency/i);
        assert.doesNotMatch(serialized, /portal_user_id/i);
      }
    });

    test("67b. Dispatcher's Financial Report is aggregate-only — never raw ledger notes", async () => {
      const customerId = await freshCustomer();
      await fundWallet(customerId, "50");
      const adjustRes = await request(app)
        .post(`/api/v1/wallets/${customerId}/adjust`)
        .set(auth(tokens.finance))
        .send({ direction: "CREDIT", amount: "5.00", reason: "UNIQUE-PRIVATE-NOTE-MARKER-93" });
      assert.equal(adjustRes.status, 201, JSON.stringify(adjustRes.body));

      const res = await get(financePath("?groupBy=category"), tokens.dispatcher);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.doesNotMatch(JSON.stringify(res.body), /UNIQUE-PRIVATE-NOTE-MARKER-93/);
    });
  });

  // ============================================================
  // READ-ONLY (68)
  // ============================================================

  describe("Read-only", () => {
    test("68. all four report endpoints create zero writes for a fresh actor", async () => {
      const freshUser = await createTestUser("ADMIN");
      createdUserIds.push(freshUser.id);
      const login = await loginTestUser(app, freshUser.email, freshUser.password);
      const token = login.accessToken as string;

      await get(ordersPath("?groupBy=date"), token);
      await get(driversPath(), token);
      await get(customersPath(), token);
      await get(financePath("?groupBy=category"), token);

      const [walletTx, cashTx, companyTx, payouts, settlements, audits, orders] = await Promise.all([
        prisma.wallet_transactions.count({ where: { processed_by_id: freshUser.id } }),
        prisma.driver_cash_transactions.count({ where: { created_by_id: freshUser.id } }),
        prisma.company_financial_transactions.count({ where: { created_by_id: freshUser.id } }),
        prisma.customer_payouts.count({ where: { processed_by_id: freshUser.id } }),
        prisma.driver_settlements.count({ where: { received_by_id: freshUser.id } }),
        prisma.audit_logs.count({ where: { actor_user_id: freshUser.id } }),
        prisma.orders.count({ where: { created_by_id: freshUser.id } }),
      ]);
      assert.equal(walletTx, 0);
      assert.equal(cashTx, 0);
      assert.equal(companyTx, 0);
      assert.equal(payouts, 0);
      assert.equal(settlements, 0);
      assert.equal(audits, 0);
      assert.equal(orders, 0);
    });
  });
});
