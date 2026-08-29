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
  cleanupTestOrder,
  cleanupTestPaymentMethod,
  cleanupTestUser,
  createTestArea,
  createTestUser,
  loginTestUser,
  seedCustomerRecord,
  seedTestOrder,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

describe("Orders update backend (Phase 6.4 — Order Editing)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driverActor: TestUser;
  let customerActor: TestUser;
  let tokens: Record<string, string>;

  let customerActive: string;
  let customerActive2: string;
  let customerInactive: string;
  let areaActive: { id: string; name: string };
  let areaActive2: { id: string; name: string };
  let areaInactive: { id: string; name: string };
  let cashMethodId: string;
  let inactivePaymentMethodId: string;

  const createdOrderIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdAreaIds: string[] = [];
  const createdPaymentMethodIds: string[] = [];

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

    customerActive = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(customerActive);
    customerActive2 = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(customerActive2);
    customerInactive = await seedCustomerRecord(admin.id, { isActive: false });
    createdCustomerIds.push(customerInactive);

    areaActive = await createTestArea();
    createdAreaIds.push(areaActive.id);
    areaActive2 = await createTestArea();
    createdAreaIds.push(areaActive2.id);
    areaInactive = await createTestArea();
    createdAreaIds.push(areaInactive.id);
    await prisma.areas.update({ where: { id: areaInactive.id }, data: { is_active: false } });

    const cashMethod = await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } });
    cashMethodId = cashMethod.id;

    const inactiveMethod = await prisma.payment_methods.create({
      data: { code: `PH64_INACTIVE_${uniqueSuffix()}`, name: "Phase64 Inactive Method", is_active: false },
    });
    inactivePaymentMethodId = inactiveMethod.id;
    createdPaymentMethodIds.push(inactiveMethod.id);
  });

  after(async () => {
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    for (const id of createdAreaIds) await cleanupTestArea(id);
    for (const id of createdPaymentMethodIds) await cleanupTestPaymentMethod(id);
    await Promise.all([admin, dispatcher, finance, driverActor, customerActor].map((u) => cleanupTestUser(u.id)));
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function createBaseOrder(overrides: Record<string, unknown> = {}) {
    const res = await request(app)
      .post("/api/v1/orders")
      .set(auth(tokens.admin))
      .send({
        customerId: customerActive,
        orderType: "DELIVERY_ONLY",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: "Phase64 Receiver",
        receiverPhone: "+96170000001",
        receiverAreaId: areaActive.id,
        receiverAddress: "1 Phase64 St",
        description: "Phase64 base order",
        orderAmount: "100.00",
        deliveryFee: "5.00",
        collectionPaymentMethodId: cashMethodId,
        ...overrides,
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdOrderIds.push(res.body.data.id);
    return res.body.data;
  }

  async function patchOrder(id: string, body: Record<string, unknown>, token = tokens.admin) {
    return request(app).patch(`/api/v1/orders/${id}`).set(auth(token)).send(body);
  }

  // ===========================================================
  // AUTHORIZATION (1-6)
  // ===========================================================

  describe("Authorization", () => {
    test("1. unauthenticated PATCH -> 401", async () => {
      const order = await createBaseOrder();
      const res = await request(app).patch(`/api/v1/orders/${order.id}`).send({ receiverName: "X" });
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, "UNAUTHORIZED");
    });

    test("2. ADMIN -> allowed", async () => {
      const order = await createBaseOrder();
      const res = await patchOrder(order.id, { receiverName: "Admin Edit" }, tokens.admin);
      assert.equal(res.status, 200);
    });

    test("3. DISPATCHER -> allowed", async () => {
      const order = await createBaseOrder();
      const res = await patchOrder(order.id, { receiverName: "Dispatcher Edit" }, tokens.dispatcher);
      assert.equal(res.status, 200);
    });

    test("4. FINANCE -> 403", async () => {
      const order = await createBaseOrder();
      const res = await patchOrder(order.id, { receiverName: "X" }, tokens.finance);
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "FORBIDDEN");
    });

    test("5. DRIVER -> 403", async () => {
      const order = await createBaseOrder();
      const res = await patchOrder(order.id, { receiverName: "X" }, tokens.driver);
      assert.equal(res.status, 403);
    });

    test("6. CUSTOMER -> 403", async () => {
      const order = await createBaseOrder();
      const res = await patchOrder(order.id, { receiverName: "X" }, tokens.customer);
      assert.equal(res.status, 403);
    });
  });

  // ===========================================================
  // BASIC EDIT (7-13)
  // ===========================================================

  describe("Basic edit", () => {
    test("7-9. edit receiver name/phone/address", async () => {
      const order = await createBaseOrder();
      const res = await patchOrder(order.id, {
        receiverName: "Updated Name",
        receiverPhone: "+96170009999",
        receiverAddress: "Updated Address",
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.receiver.name, "Updated Name");
      assert.equal(res.body.data.receiver.phone, "+96170009999");
      assert.equal(res.body.data.receiver.address, "Updated Address");
    });

    test("10. edit package fields", async () => {
      const order = await createBaseOrder();
      const res = await patchOrder(order.id, {
        description: "Updated description",
        packageCount: 3,
        quantity: 10,
        weightKg: 2.5,
        packageNotes: "handle with care",
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.package.description, "Updated description");
      assert.equal(res.body.data.package.packageCount, 3);
      assert.equal(res.body.data.package.quantity, 10);
      assert.equal(res.body.data.package.weightKg, "2.5");
      assert.equal(res.body.data.package.notes, "handle with care");
    });

    test("11-12. updatedAt changes, createdAt unchanged", async () => {
      const order = await createBaseOrder();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const res = await patchOrder(order.id, { receiverName: "Timestamp Check" });
      assert.equal(res.status, 200);
      assert.notEqual(res.body.data.updatedAt, order.updatedAt);
      assert.equal(res.body.data.createdAt, order.createdAt);
    });

    test("13. response uses the same OrderDetail DTO shape as create/detail", async () => {
      const order = await createBaseOrder();
      const res = await patchOrder(order.id, { receiverName: "DTO Check" });
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(res.body.data).sort(), Object.keys(order).sort());
      assert.ok(Array.isArray(res.body.data.statusHistory));
      assert.ok("financial" in res.body.data);
      assert.ok("customer" in res.body.data);
    });
  });

  // ===========================================================
  // AREA SNAPSHOT (14-17)
  // ===========================================================

  describe("Area snapshot", () => {
    test("14. changing receiverAreaId updates FK + snapshot text", async () => {
      const order = await createBaseOrder();
      const res = await patchOrder(order.id, { receiverAreaId: areaActive2.id });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.receiver.areaId, areaActive2.id);
      assert.equal(res.body.data.receiver.area, areaActive2.name);
    });

    test("15. editing an unrelated field preserves the old receiver_area snapshot even after the Area is renamed", async () => {
      const tempArea = await createTestArea();
      createdAreaIds.push(tempArea.id);
      const order = await createBaseOrder({ receiverAreaId: tempArea.id });
      assert.equal(order.receiver.area, tempArea.name);

      const newName = `Renamed ${uniqueSuffix()}`;
      await prisma.areas.update({ where: { id: tempArea.id }, data: { name: newName } });

      const res = await patchOrder(order.id, { receiverPhone: "+96170001111" });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.receiver.area, tempArea.name, "snapshot must stay the original name");
      assert.notEqual(res.body.data.receiver.area, newName);
      assert.equal(res.body.data.receiver.areaId, tempArea.id);
    });

    test("16. inactive newly-selected Area rejected", async () => {
      const order = await createBaseOrder();
      const res = await patchOrder(order.id, { receiverAreaId: areaInactive.id });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("17. nonexistent Area rejected", async () => {
      const order = await createBaseOrder();
      const res = await patchOrder(order.id, { receiverAreaId: "00000000-0000-0000-0000-000000000000" });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });
  });

  // ===========================================================
  // CUSTOMER (18-21)
  // ===========================================================

  describe("Customer reference", () => {
    test("18. changing to an active Customer succeeds", async () => {
      const order = await createBaseOrder();
      const res = await patchOrder(order.id, { customerId: customerActive2 });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.customer.id, customerActive2);
    });

    test("19. changing to an inactive Customer rejected", async () => {
      const order = await createBaseOrder();
      const res = await patchOrder(order.id, { customerId: customerInactive });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("20. changing to a missing Customer rejected", async () => {
      const order = await createBaseOrder();
      const res = await patchOrder(order.id, { customerId: "00000000-0000-0000-0000-000000000000" });
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, "NOT_FOUND");
    });

    test("21. an unrelated edit preserves an existing inactive Customer relationship", async () => {
      const dedicatedCustomer = await seedCustomerRecord(admin.id);
      createdCustomerIds.push(dedicatedCustomer);
      const order = await createBaseOrder({ customerId: dedicatedCustomer });

      await prisma.customers.update({ where: { id: dedicatedCustomer }, data: { is_active: false } });

      const res = await patchOrder(order.id, { receiverPhone: "+96170002222" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.customer.id, dedicatedCustomer);
      assert.equal(res.body.data.customer.isActive, false);

      const row = await prisma.customers.findUniqueOrThrow({ where: { id: dedicatedCustomer } });
      assert.equal(row.is_active, false, "the customer itself must not be silently reactivated");
    });
  });

  // ===========================================================
  // FINANCIAL (22-30)
  // ===========================================================

  describe("Financial editing", () => {
    test("22. orderAmount edit recalculates all remaining/collection fields", async () => {
      const order = await createBaseOrder({ orderAmount: "100.00", deliveryFee: "5.00" });
      const res = await patchOrder(order.id, { orderAmount: "200.00" });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.financial.orderAmount, "200");
      assert.equal(res.body.data.financial.remainingOrderAmount, "200");
      assert.equal(res.body.data.financial.amountToCollect, "205");
    });

    test("23. deliveryFee edit recalculates", async () => {
      const order = await createBaseOrder({ orderAmount: "100.00", deliveryFee: "5.00" });
      const res = await patchOrder(order.id, { deliveryFee: "15.00" });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.financial.deliveryFee, "15");
      assert.equal(res.body.data.financial.remainingDeliveryFee, "15");
      assert.equal(res.body.data.financial.amountToCollect, "115");
    });

    test("24. prepaidOrderAmount edit recalculates (requires a prepaid method)", async () => {
      const order = await createBaseOrder({ orderAmount: "100.00", deliveryFee: "5.00" });
      const res = await patchOrder(order.id, {
        paymentType: "PARTIALLY_PAID",
        prepaidOrderAmount: "40.00",
        prepaidPaymentMethodId: cashMethodId,
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.financial.remainingOrderAmount, "60");
      assert.equal(res.body.data.financial.amountToCollect, "65");
    });

    test("25. prepaidDeliveryFee edit recalculates", async () => {
      const order = await createBaseOrder({ orderAmount: "100.00", deliveryFee: "10.00" });
      const res = await patchOrder(order.id, {
        paymentType: "PARTIALLY_PAID",
        prepaidDeliveryFee: "4.00",
        prepaidPaymentMethodId: cashMethodId,
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.financial.remainingDeliveryFee, "6");
      assert.equal(res.body.data.financial.amountToCollect, "106");
    });

    test("26. paymentType edit revalidates rules (COD -> ALREADY_PAID with full prepayment)", async () => {
      const order = await createBaseOrder({ orderAmount: "100.00", deliveryFee: "5.00" });
      const res = await patchOrder(order.id, {
        paymentType: "ALREADY_PAID",
        prepaidOrderAmount: "100.00",
        prepaidPaymentMethodId: cashMethodId,
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.financial.remainingOrderAmount, "0");
      assert.equal(res.body.data.financial.amountToCollect, "5");
    });

    test("27. invalid COD + prepaid combination rejected", async () => {
      const order = await createBaseOrder({ paymentType: "CASH_ON_DELIVERY" });
      const res = await patchOrder(order.id, { prepaidOrderAmount: "10.00", prepaidPaymentMethodId: cashMethodId });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("28. invalid ALREADY_PAID combination rejected (order amount not fully prepaid)", async () => {
      const order = await createBaseOrder({ orderAmount: "100.00", deliveryFee: "5.00" });
      const res = await patchOrder(order.id, {
        paymentType: "ALREADY_PAID",
        prepaidOrderAmount: "40.00",
        prepaidPaymentMethodId: cashMethodId,
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("29. invalid PARTIALLY_PAID combination rejected (fully prepaid alias)", async () => {
      const order = await createBaseOrder({ orderAmount: "100.00", deliveryFee: "5.00" });
      const res = await patchOrder(order.id, {
        paymentType: "PARTIALLY_PAID",
        prepaidOrderAmount: "100.00",
        prepaidDeliveryFee: "5.00",
        prepaidPaymentMethodId: cashMethodId,
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("30. Decimal precision remains exact through an edit", async () => {
      const order = await createBaseOrder({ orderAmount: "0.10", deliveryFee: "0.20" });
      const res = await patchOrder(order.id, { orderAmount: "0.10" });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.financial.amountToCollect, "0.3");
    });
  });

  // ===========================================================
  // PAYMENT METHODS (31-36)
  // ===========================================================

  describe("Payment method handling", () => {
    test("31. newly-required prepaid method missing -> rejected", async () => {
      const order = await createBaseOrder({ paymentType: "CASH_ON_DELIVERY" });
      const res = await patchOrder(order.id, { paymentType: "PARTIALLY_PAID", prepaidOrderAmount: "20.00" });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("32. newly-selected inactive prepaid method -> rejected", async () => {
      const order = await createBaseOrder();
      const res = await patchOrder(order.id, {
        paymentType: "PARTIALLY_PAID",
        prepaidOrderAmount: "20.00",
        prepaidPaymentMethodId: inactivePaymentMethodId,
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("33. newly-selected inactive collection method -> rejected", async () => {
      const order = await createBaseOrder();
      const res = await patchOrder(order.id, { collectionPaymentMethodId: inactivePaymentMethodId });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("34. changing financial state to zero prepaid clears the prepaid method", async () => {
      const order = await createBaseOrder({
        orderAmount: "100.00",
        deliveryFee: "5.00",
        paymentType: "PARTIALLY_PAID",
        prepaidOrderAmount: "40.00",
        prepaidPaymentMethodId: cashMethodId,
      });
      assert.equal(order.prepaidPaymentMethod.id, cashMethodId);

      const res = await patchOrder(order.id, { paymentType: "CASH_ON_DELIVERY", prepaidOrderAmount: "0" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.prepaidPaymentMethod, null);

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(row.prepaid_payment_method_id, null);
    });

    test("35. changing amountToCollect to 0 clears the collection method", async () => {
      const order = await createBaseOrder({ orderAmount: "100.00", deliveryFee: "5.00" });
      assert.equal(order.collectionPaymentMethod.id, cashMethodId);

      const res = await patchOrder(order.id, {
        paymentType: "ALREADY_PAID",
        prepaidOrderAmount: "100.00",
        prepaidDeliveryFee: "5.00",
        prepaidPaymentMethodId: cashMethodId,
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.financial.amountToCollect, "0");
      assert.equal(res.body.data.collectionPaymentMethod, null);

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(row.collection_payment_method_id, null);
    });

    test("36. an unrelated edit preserves an already-linked method even if it was later deactivated", async () => {
      const suffix = uniqueSuffix();
      const tempMethod = await prisma.payment_methods.create({
        data: { code: `PH64_TOBEDEACT_${suffix}`, name: "Phase64 To Be Deactivated" },
      });
      createdPaymentMethodIds.push(tempMethod.id);

      const order = await createBaseOrder({ collectionPaymentMethodId: tempMethod.id });
      await prisma.payment_methods.update({ where: { id: tempMethod.id }, data: { is_active: false } });

      const res = await patchOrder(order.id, { receiverPhone: "+96170003333" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.collectionPaymentMethod.id, tempMethod.id);
    });
  });

  // ===========================================================
  // IMMUTABLE / SERVER FIELDS (37-47)
  // ===========================================================

  describe("Immutable / server-controlled fields", () => {
    test("37-47. no immutable/server-controlled field can be changed via PATCH", async () => {
      const order = await createBaseOrder();
      const bogusDate = "2000-01-01T00:00:00.000Z";
      const res = await patchOrder(order.id, {
        id: "00000000-0000-0000-0000-000000000000",
        orderNumber: "SHOULD-NOT-APPLY",
        trackingCode: "SHOULD-NOT-APPLY",
        orderType: "COMPANY_ORDER",
        status: "DELIVERED",
        financialStatus: "FINALIZED",
        remainingOrderAmount: "999999.99",
        remainingDeliveryFee: "999999.99",
        amountToCollect: "999999.99",
        actualAmountCollected: "999999.99",
        needsFinancialReview: true,
        currentDriverId: "00000000-0000-0000-0000-000000000000",
        createdById: dispatcher.id,
        createdAt: bogusDate,
        assignedAt: bogusDate,
        pickedUpAt: bogusDate,
        outForDeliveryAt: bogusDate,
        deliveredAt: bogusDate,
        cancelledAt: bogusDate,
        receiverName: "Legit change so the PATCH is not empty",
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.id, order.id);
      assert.equal(res.body.data.orderNumber, order.orderNumber);
      assert.equal(res.body.data.trackingCode, order.trackingCode);
      assert.equal(res.body.data.orderType, order.orderType);
      assert.equal(res.body.data.status, "RECEIVED");
      assert.equal(res.body.data.financialStatus, "PENDING");
      assert.equal(res.body.data.financial.remainingOrderAmount, "100");
      assert.equal(res.body.data.financial.amountToCollect, "105");
      assert.equal(res.body.data.financial.actualAmountCollected, null);
      assert.equal(res.body.data.financial.needsFinancialReview, false);
      assert.equal(res.body.data.currentDriver, null);
      assert.equal(res.body.data.createdAt, order.createdAt);
      assert.equal(res.body.data.assignedAt, null);
      assert.equal(res.body.data.pickedUpAt, null);
      assert.equal(res.body.data.outForDeliveryAt, null);
      assert.equal(res.body.data.deliveredAt, null);
      assert.equal(res.body.data.cancelledAt, null);

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(row.created_by_id, admin.id, "createdById is derived from the original creating actor, not the editor");
      assert.notEqual(row.created_by_id, dispatcher.id);
    });
  });

  // ===========================================================
  // EMPTY / UNKNOWN (48-49)
  // ===========================================================

  describe("Empty / unknown-only PATCH", () => {
    test("48. {} -> 400", async () => {
      const order = await createBaseOrder();
      const res = await patchOrder(order.id, {});
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("49. only immutable/unknown fields -> 400 (must not silently no-op)", async () => {
      const order = await createBaseOrder();
      const res = await patchOrder(order.id, { status: "DELIVERED" });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });
  });

  // ===========================================================
  // LIFECYCLE (50-58 + ASSIGNED/RESCHEDULED)
  // ===========================================================

  describe("Lifecycle editability", () => {
    const EDITABLE = ["RECEIVED", "READY_FOR_PICKUP", "ASSIGNED"];
    const NOT_EDITABLE = [
      "PICKED_UP",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
      "FAILED_DELIVERY",
      "RESCHEDULED",
      "RETURNED_TO_COMPANY",
      "RETURNED_TO_CUSTOMER",
      "CANCELLED",
    ];

    for (const status of EDITABLE) {
      test(`editable: ${status}`, async () => {
        const id = await seedTestOrder(customerActive, admin.id, {
          areaId: areaActive.id,
          areaName: areaActive.name,
          status: status as never,
        });
        createdOrderIds.push(id);
        const res = await patchOrder(id, { receiverName: `Edited while ${status}` });
        assert.equal(res.status, 200, `expected ${status} to be editable: ${JSON.stringify(res.body)}`);
      });
    }

    for (const status of NOT_EDITABLE) {
      test(`not editable: ${status}`, async () => {
        const id = await seedTestOrder(customerActive, admin.id, {
          areaId: areaActive.id,
          areaName: areaActive.name,
          status: status as never,
        });
        createdOrderIds.push(id);
        const res = await patchOrder(id, { receiverName: `Attempted edit while ${status}` });
        assert.equal(res.status, 400, `expected ${status} to be rejected`);
        assert.equal(res.body.error.code, "VALIDATION_ERROR");
      });
    }
  });

  // ===========================================================
  // STATUS HISTORY (59)
  // ===========================================================

  describe("Status history", () => {
    test("59. a generic edit creates no status-history row", async () => {
      const order = await createBaseOrder();
      const before = await prisma.order_status_history.count({ where: { order_id: order.id } });

      const res = await patchOrder(order.id, { receiverName: "History Check" });
      assert.equal(res.status, 200);

      const after = await prisma.order_status_history.count({ where: { order_id: order.id } });
      assert.equal(after, before, "a generic edit must not add any status-history row");
    });
  });

  // ===========================================================
  // NO SIDE EFFECTS (60)
  // ===========================================================

  describe("No finance side effects", () => {
    test("60. an edit produces zero wallet/driver-cash/company-finance ledger rows", async () => {
      const order = await createBaseOrder({ orderAmount: "100.00", deliveryFee: "5.00" });
      const res = await patchOrder(order.id, {
        orderAmount: "150.00",
        paymentType: "PARTIALLY_PAID",
        prepaidOrderAmount: "50.00",
        prepaidPaymentMethodId: cashMethodId,
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const walletTx = await prisma.wallet_transactions.count({ where: { order_id: order.id } });
      const driverCashTx = await prisma.driver_cash_transactions.count({ where: { order_id: order.id } });
      const companyFinanceTx = await prisma.company_financial_transactions.count({ where: { order_id: order.id } });
      assert.equal(walletTx, 0);
      assert.equal(driverCashTx, 0);
      assert.equal(companyFinanceTx, 0);
    });
  });

  // ===========================================================
  // REGRESSION SMOKE (61-63)
  // ===========================================================

  describe("Create/detail/list regression smoke", () => {
    test("61-63. create, detail, and list still work alongside PATCH", async () => {
      const order = await createBaseOrder();
      assert.ok(order.id);

      const detail = await request(app).get(`/api/v1/orders/${order.id}`).set(auth(tokens.admin));
      assert.equal(detail.status, 200);

      await patchOrder(order.id, { receiverName: "Regression Smoke" });

      const list = await request(app)
        .get(`/api/v1/orders?search=${encodeURIComponent("Regression Smoke")}`)
        .set(auth(tokens.admin));
      assert.equal(list.status, 200);
      assert.ok(list.body.data.some((o: { id: string }) => o.id === order.id));
    });
  });
});
