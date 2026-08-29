import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { Prisma as PrismaNamespace } from "../../src/generated/prisma/client";
import { createOrder } from "../../src/modules/orders/order.service";
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
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

const ORDER_NUMBER_PATTERN = /^ORD-\d{8}-[A-Z0-9]{6}$/;
const TRACKING_CODE_PATTERN = /^TRK-[A-Z0-9]{12}$/;

describe("Orders backend (Phase 6.2 — Create Order + Order Detail)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driverActor: TestUser;
  let customerActor: TestUser;
  let tokens: Record<string, string>;

  let activeCustomerId: string;
  let inactiveCustomerId: string;
  let activeArea: { id: string; name: string };
  let inactiveArea: { id: string; name: string };
  let cashMethodId: string;
  let cashMethodCode: string;
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

    activeCustomerId = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(activeCustomerId);
    inactiveCustomerId = await seedCustomerRecord(admin.id, { isActive: false });
    createdCustomerIds.push(inactiveCustomerId);

    activeArea = await createTestArea();
    createdAreaIds.push(activeArea.id);
    inactiveArea = await createTestArea();
    createdAreaIds.push(inactiveArea.id);
    await prisma.areas.update({ where: { id: inactiveArea.id }, data: { is_active: false } });

    const cashMethod = await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } });
    cashMethodId = cashMethod.id;
    cashMethodCode = cashMethod.code;

    const inactiveMethod = await prisma.payment_methods.create({
      data: { code: `PH62_INACTIVE_${uniqueSuffix()}`, name: "Phase62 Inactive Method", is_active: false },
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

  function newOrderPayload(overrides: Record<string, unknown> = {}) {
    return {
      customerId: activeCustomerId,
      orderType: "DELIVERY_ONLY",
      paymentType: "CASH_ON_DELIVERY",
      receiverName: "Jane Receiver",
      receiverPhone: "+96170000001",
      receiverAreaId: activeArea.id,
      receiverAddress: "123 Test Street",
      description: "Phase62 test package",
      orderAmount: "100.00",
      deliveryFee: "5.00",
      collectionPaymentMethodId: cashMethodId,
      ...overrides,
    };
  }

  async function createOrderViaApi(token: string, payload: Record<string, unknown>) {
    const res = await request(app).post("/api/v1/orders").set(auth(token)).send(payload);
    if (res.status === 201) {
      createdOrderIds.push(res.body.data.id);
    }
    return res;
  }

  // ===========================================================
  // AUTHORIZATION (1-11)
  // ===========================================================

  describe("Authorization", () => {
    test("1. unauthenticated POST -> 401", async () => {
      const res = await request(app).post("/api/v1/orders").send(newOrderPayload());
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, "UNAUTHORIZED");
    });

    test("2. Dispatcher orders.create -> allowed", async () => {
      const res = await createOrderViaApi(tokens.dispatcher, newOrderPayload());
      assert.equal(res.status, 201);
    });

    test("3. Admin orders.create -> allowed", async () => {
      const res = await createOrderViaApi(tokens.admin, newOrderPayload());
      assert.equal(res.status, 201);
    });

    test("4. Finance POST -> 403", async () => {
      const res = await request(app).post("/api/v1/orders").set(auth(tokens.finance)).send(newOrderPayload());
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "FORBIDDEN");
    });

    test("5. Driver POST -> 403", async () => {
      const res = await request(app).post("/api/v1/orders").set(auth(tokens.driver)).send(newOrderPayload());
      assert.equal(res.status, 403);
    });

    test("6. Customer POST -> 403", async () => {
      const res = await request(app).post("/api/v1/orders").set(auth(tokens.customer)).send(newOrderPayload());
      assert.equal(res.status, 403);
    });

    test("7-11. GET detail: Admin/Dispatcher/Finance allowed, Driver/Customer forbidden", async () => {
      const created = await createOrderViaApi(tokens.admin, newOrderPayload());
      assert.equal(created.status, 201);
      const orderId = created.body.data.id;

      const admin_ = await request(app).get(`/api/v1/orders/${orderId}`).set(auth(tokens.admin));
      assert.equal(admin_.status, 200);
      const dispatcher_ = await request(app).get(`/api/v1/orders/${orderId}`).set(auth(tokens.dispatcher));
      assert.equal(dispatcher_.status, 200);
      const finance_ = await request(app).get(`/api/v1/orders/${orderId}`).set(auth(tokens.finance));
      assert.equal(finance_.status, 200);
      const driver_ = await request(app).get(`/api/v1/orders/${orderId}`).set(auth(tokens.driver));
      assert.equal(driver_.status, 403);
      const customer_ = await request(app).get(`/api/v1/orders/${orderId}`).set(auth(tokens.customer));
      assert.equal(customer_.status, 403);
    });
  });

  // ===========================================================
  // CREATE SUCCESS (12-26)
  // ===========================================================

  describe("Create success", () => {
    test("12. valid COMPANY_ORDER create -> 201", async () => {
      const res = await createOrderViaApi(tokens.admin, newOrderPayload({ orderType: "COMPANY_ORDER" }));
      assert.equal(res.status, 201);
      assert.equal(res.body.data.orderType, "COMPANY_ORDER");
    });

    test("13. valid DELIVERY_ONLY create -> 201", async () => {
      const res = await createOrderViaApi(tokens.admin, newOrderPayload({ orderType: "DELIVERY_ONLY" }));
      assert.equal(res.status, 201);
      assert.equal(res.body.data.orderType, "DELIVERY_ONLY");
    });

    test("14-15. status = RECEIVED, financialStatus = PENDING", async () => {
      const res = await createOrderViaApi(tokens.admin, newOrderPayload());
      assert.equal(res.status, 201);
      assert.equal(res.body.data.status, "RECEIVED");
      assert.equal(res.body.data.financialStatus, "PENDING");
    });

    test("16-17. generated orderNumber/trackingCode match the approved format", async () => {
      const res = await createOrderViaApi(tokens.admin, newOrderPayload());
      assert.equal(res.status, 201);
      assert.match(res.body.data.orderNumber, ORDER_NUMBER_PATTERN);
      assert.match(res.body.data.trackingCode, TRACKING_CODE_PATTERN);
      assert.ok(res.body.data.orderNumber.length <= 50);
      assert.ok(res.body.data.trackingCode.length <= 100);
    });

    test("18. client cannot override generated identifiers", async () => {
      const res = await createOrderViaApi(
        tokens.admin,
        newOrderPayload({ orderNumber: "SHOULD-NOT-APPLY", trackingCode: "SHOULD-NOT-APPLY" })
      );
      assert.equal(res.status, 201);
      assert.notEqual(res.body.data.orderNumber, "SHOULD-NOT-APPLY");
      assert.notEqual(res.body.data.trackingCode, "SHOULD-NOT-APPLY");
      assert.match(res.body.data.orderNumber, ORDER_NUMBER_PATTERN);
    });

    test("19. createdBy derives from the authenticated actor, never client input", async () => {
      const res = await createOrderViaApi(
        tokens.dispatcher,
        newOrderPayload({ createdById: admin.id, created_by_id: admin.id })
      );
      assert.equal(res.status, 201);
      const row = await prisma.orders.findUniqueOrThrow({ where: { id: res.body.data.id } });
      assert.equal(row.created_by_id, dispatcher.id);
      assert.notEqual(row.created_by_id, admin.id);
    });

    test("20-22. currentDriver null, actualAmountCollected null, needsFinancialReview false", async () => {
      const res = await createOrderViaApi(tokens.admin, newOrderPayload());
      assert.equal(res.status, 201);
      assert.equal(res.body.data.currentDriver, null);
      assert.equal(res.body.data.financial.actualAmountCollected, null);
      assert.equal(res.body.data.financial.needsFinancialReview, false);
    });

    test("23-24. receiver area text equals the Area's real name; independent client receiverArea text is ignored", async () => {
      const res = await createOrderViaApi(
        tokens.admin,
        newOrderPayload({ receiverArea: "Totally Different Client Text" })
      );
      assert.equal(res.status, 201);
      assert.equal(res.body.data.receiver.area, activeArea.name);
      assert.notEqual(res.body.data.receiver.area, "Totally Different Client Text");
      assert.equal(res.body.data.receiver.areaId, activeArea.id);
    });

    test("25-26. exactly one initial status-history row exists, recorded by the actor", async () => {
      const res = await createOrderViaApi(tokens.dispatcher, newOrderPayload());
      assert.equal(res.status, 201);

      const history = await prisma.order_status_history.findMany({ where: { order_id: res.body.data.id } });
      assert.equal(history.length, 1);
      assert.equal(history[0].to_status, "RECEIVED");
      assert.equal(history[0].from_status, null);
      assert.equal(history[0].changed_by_id, dispatcher.id);
    });
  });

  // ===========================================================
  // FINANCIAL PERSISTENCE (27-34)
  // ===========================================================

  describe("Financial persistence", () => {
    test("27. COD values persist correctly", async () => {
      const res = await createOrderViaApi(
        tokens.admin,
        newOrderPayload({ orderAmount: "100.00", deliveryFee: "5.00" })
      );
      assert.equal(res.status, 201);
      const f = res.body.data.financial;
      assert.equal(f.orderAmount, "100");
      assert.equal(f.deliveryFee, "5");
      assert.equal(f.prepaidOrderAmount, "0");
      assert.equal(f.prepaidDeliveryFee, "0");
      assert.equal(f.remainingOrderAmount, "100");
      assert.equal(f.remainingDeliveryFee, "5");
      assert.equal(f.amountToCollect, "105");
    });

    test("28. PARTIALLY_PAID persists correct remaining values (requirements.md §8.3 example)", async () => {
      const res = await createOrderViaApi(
        tokens.admin,
        newOrderPayload({
          paymentType: "PARTIALLY_PAID",
          orderAmount: "100.00",
          deliveryFee: "5.00",
          prepaidOrderAmount: "40.00",
          prepaidPaymentMethodId: cashMethodId,
        })
      );
      assert.equal(res.status, 201);
      const f = res.body.data.financial;
      assert.equal(f.remainingOrderAmount, "60");
      assert.equal(f.remainingDeliveryFee, "5");
      assert.equal(f.amountToCollect, "65");
    });

    test("29-30. ALREADY_PAID: remainingOrderAmount=0, unpaid delivery fee still yields correct amountToCollect (requirements.md §8.2 example)", async () => {
      const res = await createOrderViaApi(
        tokens.admin,
        newOrderPayload({
          paymentType: "ALREADY_PAID",
          orderAmount: "100.00",
          deliveryFee: "5.00",
          prepaidOrderAmount: "100.00",
          prepaidPaymentMethodId: cashMethodId,
        })
      );
      assert.equal(res.status, 201);
      const f = res.body.data.financial;
      assert.equal(f.remainingOrderAmount, "0");
      assert.equal(f.amountToCollect, "5");
    });

    test("31. fully paid order (ALREADY_PAID, both amounts prepaid) persists amountToCollect=0, no collection method", async () => {
      const res = await createOrderViaApi(
        tokens.admin,
        newOrderPayload({
          paymentType: "ALREADY_PAID",
          orderAmount: "100.00",
          deliveryFee: "5.00",
          prepaidOrderAmount: "100.00",
          prepaidDeliveryFee: "5.00",
          prepaidPaymentMethodId: cashMethodId,
          collectionPaymentMethodId: undefined,
        })
      );
      assert.equal(res.status, 201);
      assert.equal(res.body.data.financial.amountToCollect, "0");
      assert.equal(res.body.data.collectionPaymentMethod, null);
    });

    test("32. COMPANY_ORDER financial values persist correctly", async () => {
      const res = await createOrderViaApi(
        tokens.admin,
        newOrderPayload({ orderType: "COMPANY_ORDER", orderAmount: "200.00", deliveryFee: "10.00" })
      );
      assert.equal(res.status, 201);
      assert.equal(res.body.data.orderType, "COMPANY_ORDER");
      assert.equal(res.body.data.financial.amountToCollect, "210");
    });

    test("33. DELIVERY_ONLY financial values persist correctly", async () => {
      const res = await createOrderViaApi(
        tokens.admin,
        newOrderPayload({ orderType: "DELIVERY_ONLY", orderAmount: "80.00", deliveryFee: "5.00" })
      );
      assert.equal(res.status, 201);
      assert.equal(res.body.data.orderType, "DELIVERY_ONLY");
      assert.equal(res.body.data.financial.amountToCollect, "85");
    });

    test("34. money serializes as strings, never JS numbers", async () => {
      const res = await createOrderViaApi(tokens.admin, newOrderPayload());
      assert.equal(res.status, 201);
      const f = res.body.data.financial;
      for (const key of ["orderAmount", "deliveryFee", "prepaidOrderAmount", "prepaidDeliveryFee", "remainingOrderAmount", "remainingDeliveryFee", "amountToCollect"]) {
        assert.equal(typeof f[key], "string", `${key} must serialize as a string`);
      }
    });
  });

  // ===========================================================
  // PAYMENT METHOD TESTS (35-42)
  // ===========================================================

  describe("Payment method validation", () => {
    test("35. prepaid total > 0 + active prepaid method -> success", async () => {
      const res = await createOrderViaApi(
        tokens.admin,
        newOrderPayload({
          paymentType: "PARTIALLY_PAID",
          prepaidOrderAmount: "20.00",
          prepaidPaymentMethodId: cashMethodId,
        })
      );
      assert.equal(res.status, 201, JSON.stringify(res.body));
    });

    test("36. prepaid total > 0 without prepaid method -> 400", async () => {
      const res = await request(app)
        .post("/api/v1/orders")
        .set(auth(tokens.admin))
        .send(newOrderPayload({ paymentType: "PARTIALLY_PAID", prepaidOrderAmount: "20.00" }));
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("37. zero prepaid + prepaid method provided -> 400", async () => {
      const res = await request(app)
        .post("/api/v1/orders")
        .set(auth(tokens.admin))
        .send(newOrderPayload({ prepaidPaymentMethodId: cashMethodId }));
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("38. amountToCollect > 0 + active collection method -> success", async () => {
      const res = await createOrderViaApi(tokens.admin, newOrderPayload({ collectionPaymentMethodId: cashMethodId }));
      assert.equal(res.status, 201);
    });

    test("39. amountToCollect > 0 without collection method -> 400", async () => {
      const body = newOrderPayload();
      delete (body as Record<string, unknown>).collectionPaymentMethodId;
      const res = await request(app).post("/api/v1/orders").set(auth(tokens.admin)).send(body);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("40. amountToCollect = 0 + collection method provided -> 400", async () => {
      const res = await request(app)
        .post("/api/v1/orders")
        .set(auth(tokens.admin))
        .send(
          newOrderPayload({
            paymentType: "ALREADY_PAID",
            prepaidOrderAmount: "100.00",
            prepaidDeliveryFee: "5.00",
            prepaidPaymentMethodId: cashMethodId,
            collectionPaymentMethodId: cashMethodId,
          })
        );
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("41. nonexistent payment method -> controlled 400", async () => {
      const res = await request(app)
        .post("/api/v1/orders")
        .set(auth(tokens.admin))
        .send(newOrderPayload({ collectionPaymentMethodId: "00000000-0000-0000-0000-000000000000" }));
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
      assert.doesNotMatch(JSON.stringify(res.body), /prisma/i);
    });

    test("42. inactive payment method -> controlled 400", async () => {
      const res = await request(app)
        .post("/api/v1/orders")
        .set(auth(tokens.admin))
        .send(newOrderPayload({ collectionPaymentMethodId: inactivePaymentMethodId }));
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });
  });

  // ===========================================================
  // CUSTOMER / AREA TESTS (43-49)
  // ===========================================================

  describe("Customer / Area validation", () => {
    test("43. nonexistent Customer -> 404", async () => {
      const res = await request(app)
        .post("/api/v1/orders")
        .set(auth(tokens.admin))
        .send(newOrderPayload({ customerId: "00000000-0000-0000-0000-000000000000" }));
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, "NOT_FOUND");
    });

    test("44. inactive Customer -> controlled 400 rejection", async () => {
      const res = await request(app)
        .post("/api/v1/orders")
        .set(auth(tokens.admin))
        .send(newOrderPayload({ customerId: inactiveCustomerId }));
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("45. active Customer -> success", async () => {
      const res = await createOrderViaApi(tokens.admin, newOrderPayload({ customerId: activeCustomerId }));
      assert.equal(res.status, 201);
    });

    test("46. nonexistent Area -> controlled 400 rejection", async () => {
      const res = await request(app)
        .post("/api/v1/orders")
        .set(auth(tokens.admin))
        .send(newOrderPayload({ receiverAreaId: "00000000-0000-0000-0000-000000000000" }));
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("47. inactive Area -> controlled 400 rejection", async () => {
      const res = await request(app)
        .post("/api/v1/orders")
        .set(auth(tokens.admin))
        .send(newOrderPayload({ receiverAreaId: inactiveArea.id }));
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("48. active Area -> success", async () => {
      const res = await createOrderViaApi(tokens.admin, newOrderPayload({ receiverAreaId: activeArea.id }));
      assert.equal(res.status, 201);
    });

    test("49. Area rename after creation does not change the stored receiver_area snapshot", async () => {
      const renamableArea = await createTestArea();
      createdAreaIds.push(renamableArea.id);

      const created = await createOrderViaApi(tokens.admin, newOrderPayload({ receiverAreaId: renamableArea.id }));
      assert.equal(created.status, 201);
      assert.equal(created.body.data.receiver.area, renamableArea.name);

      const newName = `Renamed ${uniqueSuffix()}`;
      await prisma.areas.update({ where: { id: renamableArea.id }, data: { name: newName } });

      const detail = await request(app).get(`/api/v1/orders/${created.body.data.id}`).set(auth(tokens.admin));
      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.receiver.area, created.body.data.receiver.area);
      assert.notEqual(detail.body.data.receiver.area, newName);
    });
  });

  // ===========================================================
  // DETAIL TESTS (50-58)
  // ===========================================================

  describe("Order detail", () => {
    test("50. valid Order detail -> 200", async () => {
      const created = await createOrderViaApi(tokens.admin, newOrderPayload());
      const res = await request(app).get(`/api/v1/orders/${created.body.data.id}`).set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.equal(res.body.data.id, created.body.data.id);
    });

    test("51. malformed UUID -> 400", async () => {
      const res = await request(app).get("/api/v1/orders/not-a-uuid").set(auth(tokens.admin));
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("52. missing Order -> 404", async () => {
      const res = await request(app)
        .get("/api/v1/orders/00000000-0000-0000-0000-000000000000")
        .set(auth(tokens.admin));
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, "NOT_FOUND");
    });

    test("53. safe Customer summary returned", async () => {
      const created = await createOrderViaApi(tokens.admin, newOrderPayload());
      const res = await request(app).get(`/api/v1/orders/${created.body.data.id}`).set(auth(tokens.admin));
      assert.deepEqual(Object.keys(res.body.data.customer).sort(), [
        "customerNumber",
        "id",
        "isActive",
        "name",
        "primaryPhone",
      ]);
      assert.equal(res.body.data.customer.id, activeCustomerId);
    });

    test("54. receiver snapshot returned with expected shape", async () => {
      const created = await createOrderViaApi(tokens.admin, newOrderPayload());
      const res = await request(app).get(`/api/v1/orders/${created.body.data.id}`).set(auth(tokens.admin));
      assert.deepEqual(Object.keys(res.body.data.receiver).sort(), [
        "address",
        "altPhone",
        "area",
        "areaId",
        "buildingFloor",
        "instructions",
        "mapLink",
        "name",
        "phone",
      ]);
      assert.equal(res.body.data.receiver.name, "Jane Receiver");
    });

    test("55. safe payment-method summaries returned", async () => {
      const created = await createOrderViaApi(
        tokens.admin,
        newOrderPayload({
          paymentType: "PARTIALLY_PAID",
          prepaidOrderAmount: "10.00",
          prepaidPaymentMethodId: cashMethodId,
        })
      );
      assert.equal(created.status, 201);
      const res = await request(app).get(`/api/v1/orders/${created.body.data.id}`).set(auth(tokens.admin));
      assert.deepEqual(Object.keys(res.body.data.prepaidPaymentMethod).sort(), ["code", "id", "name"]);
      assert.equal(res.body.data.prepaidPaymentMethod.code, cashMethodCode);
      assert.deepEqual(Object.keys(res.body.data.collectionPaymentMethod).sort(), ["code", "id", "name"]);
    });

    test("56. financial Decimal fields serialized as strings in detail", async () => {
      const created = await createOrderViaApi(tokens.admin, newOrderPayload());
      const res = await request(app).get(`/api/v1/orders/${created.body.data.id}`).set(auth(tokens.admin));
      assert.equal(typeof res.body.data.financial.amountToCollect, "string");
      assert.equal(res.body.data.financial.actualAmountCollected, null);
    });

    test("57. no auth/session/password data leaks", async () => {
      const created = await createOrderViaApi(tokens.admin, newOrderPayload());
      const res = await request(app).get(`/api/v1/orders/${created.body.data.id}`).set(auth(tokens.admin));
      const serialized = JSON.stringify(res.body);
      assert.doesNotMatch(serialized, /password_hash/i);
      assert.doesNotMatch(serialized, /refresh_token/i);
      assert.doesNotMatch(serialized, /auth_sessions/i);
    });

    test("58. no financial ledger records included in the DTO", async () => {
      const created = await createOrderViaApi(tokens.admin, newOrderPayload());
      const res = await request(app).get(`/api/v1/orders/${created.body.data.id}`).set(auth(tokens.admin));
      const serialized = JSON.stringify(res.body);
      assert.doesNotMatch(serialized, /wallet_transactions/i);
      assert.doesNotMatch(serialized, /driver_cash_transactions/i);
      assert.doesNotMatch(serialized, /company_financial_transactions/i);
    });
  });

  // ===========================================================
  // SERVER-CONTROLLED FIELD TESTS (59-60)
  // ===========================================================

  describe("Server-controlled fields", () => {
    test("59. client cannot override status/financialStatus/remaining amounts/amountToCollect/actualAmountCollected/needsFinancialReview/createdById/currentDriverId/timestamps", async () => {
      const bogusDate = "2000-01-01T00:00:00.000Z";
      const res = await createOrderViaApi(
        tokens.dispatcher,
        newOrderPayload({
          status: "DELIVERED",
          financialStatus: "FINALIZED",
          remainingOrderAmount: "999999.99",
          remainingDeliveryFee: "999999.99",
          amountToCollect: "999999.99",
          actualAmountCollected: "999999.99",
          needsFinancialReview: true,
          createdById: admin.id,
          currentDriverId: "00000000-0000-0000-0000-000000000000",
          createdAt: bogusDate,
          updatedAt: bogusDate,
        })
      );
      assert.equal(res.status, 201, JSON.stringify(res.body));

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: res.body.data.id } });
      assert.equal(row.status, "RECEIVED");
      assert.equal(row.financial_status, "PENDING");
      assert.equal(row.remaining_order_amount.toString(), "100");
      assert.equal(row.amount_to_collect.toString(), "105");
      assert.equal(row.actual_amount_collected, null);
      assert.equal(row.needs_financial_review, false);
      assert.equal(row.created_by_id, dispatcher.id);
      assert.equal(row.current_driver_id, null);
      assert.notEqual(row.created_at.toISOString(), bogusDate);
    });

    test("60. client cannot assign a Driver during create", async () => {
      const res = await createOrderViaApi(
        tokens.admin,
        newOrderPayload({ driverId: "00000000-0000-0000-0000-000000000000", currentDriverId: "00000000-0000-0000-0000-000000000000" })
      );
      assert.equal(res.status, 201);
      assert.equal(res.body.data.currentDriver, null);
      const row = await prisma.orders.findUniqueOrThrow({ where: { id: res.body.data.id } });
      assert.equal(row.current_driver_id, null);
      assert.equal(row.assigned_at, null);
    });
  });

  // ===========================================================
  // ATOMICITY (61)
  // ===========================================================

  describe("Atomicity", () => {
    // Forcing the SECOND write (order_status_history) to fail in isolation
    // would require a permanent debug switch in production code, which is
    // explicitly disallowed. Instead this exercises a real transactional
    // failure: an actor id that does not exist in `users` violates the
    // orders.created_by_id FK constraint — a genuine Postgres-level error,
    // not a simulated one — and proves the transaction as a whole rolls
    // back with zero partial rows. (order.service.ts's createOrder() runs
    // both tx.orders.create(...) and tx.order_status_history.create(...)
    // inside the same prisma.$transaction(async (tx) => {...}) callback —
    // verified by inspection of that file.)
    test("61. a real transactional failure (invalid actor FK) leaves no partial Order or history row", async () => {
      const nonExistentActorId = "00000000-0000-0000-0000-000000000000";
      const beforeCount = await prisma.orders.count({ where: { customer_id: activeCustomerId } });

      const { Decimal } = PrismaNamespace;
      await assert.rejects(() =>
        createOrder(
          {
            customerId: activeCustomerId,
            orderType: "DELIVERY_ONLY",
            paymentType: "CASH_ON_DELIVERY",
            receiverName: "Atomicity Test",
            receiverPhone: "+96170000099",
            receiverAreaId: activeArea.id,
            receiverAddress: "Atomicity St",
            description: "atomicity test",
            orderAmount: new Decimal("50.00"),
            deliveryFee: new Decimal("0.00"),
            prepaidOrderAmount: new Decimal(0),
            prepaidDeliveryFee: new Decimal(0),
            collectionPaymentMethodId: cashMethodId,
          } as Parameters<typeof createOrder>[0],
          nonExistentActorId
        )
      );

      const afterCount = await prisma.orders.count({ where: { customer_id: activeCustomerId } });
      assert.equal(afterCount, beforeCount, "a failed transaction must not leave a partial order row");

      const orphanHistory = await prisma.order_status_history.count({ where: { changed_by_id: nonExistentActorId } });
      assert.equal(orphanHistory, 0, "a failed transaction must not leave a partial history row");
    });
  });

  // ===========================================================
  // IDENTIFIER CONCURRENCY (62-63)
  // ===========================================================

  describe("Identifier concurrency", () => {
    test("62-63. concurrent Order creates all produce unique orderNumber and trackingCode values", async () => {
      const CONCURRENCY = 6;
      const responses = await Promise.all(
        Array.from({ length: CONCURRENCY }, () =>
          request(app).post("/api/v1/orders").set(auth(tokens.admin)).send(newOrderPayload())
        )
      );

      for (const res of responses) {
        assert.equal(res.status, 201, JSON.stringify(res.body));
        createdOrderIds.push(res.body.data.id);
      }

      const orderNumbers = new Set(responses.map((r) => r.body.data.orderNumber));
      const trackingCodes = new Set(responses.map((r) => r.body.data.trackingCode));
      assert.equal(orderNumbers.size, CONCURRENCY, "all orderNumbers must be unique");
      assert.equal(trackingCodes.size, CONCURRENCY, "all trackingCodes must be unique");
    });
  });

  // ===========================================================
  // HISTORY (64-66)
  // ===========================================================

  describe("Status history", () => {
    test("64-66. exactly one RECEIVED history row, no fake previous status, correct actor", async () => {
      const created = await createOrderViaApi(tokens.dispatcher, newOrderPayload());
      const history = await prisma.order_status_history.findMany({ where: { order_id: created.body.data.id } });
      assert.equal(history.length, 1);
      assert.equal(history[0].from_status, null);
      assert.equal(history[0].to_status, "RECEIVED");
      assert.equal(history[0].changed_by_id, dispatcher.id);

      const detail = await request(app).get(`/api/v1/orders/${created.body.data.id}`).set(auth(tokens.dispatcher));
      assert.equal(detail.body.data.statusHistory.length, 1);
      assert.equal(detail.body.data.statusHistory[0].fromStatus, null);
      assert.equal(detail.body.data.statusHistory[0].toStatus, "RECEIVED");
    });
  });

  // ===========================================================
  // NO FINANCE SIDE EFFECTS (67)
  // ===========================================================

  describe("No finance side effects", () => {
    test("67. order creation produces zero wallet/driver-cash/company-finance ledger rows", async () => {
      const created = await createOrderViaApi(
        tokens.admin,
        newOrderPayload({
          orderType: "DELIVERY_ONLY",
          paymentType: "PARTIALLY_PAID",
          prepaidOrderAmount: "20.00",
          prepaidPaymentMethodId: cashMethodId,
        })
      );
      assert.equal(created.status, 201);
      const orderId = created.body.data.id;

      const walletTx = await prisma.wallet_transactions.count({ where: { order_id: orderId } });
      const driverCashTx = await prisma.driver_cash_transactions.count({ where: { order_id: orderId } });
      const companyFinanceTx = await prisma.company_financial_transactions.count({ where: { order_id: orderId } });

      assert.equal(walletTx, 0);
      assert.equal(driverCashTx, 0);
      assert.equal(companyFinanceTx, 0);
    });
  });
});
