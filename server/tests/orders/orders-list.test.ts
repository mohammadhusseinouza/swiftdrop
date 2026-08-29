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
  seedTestOrder,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

describe("Orders list backend (Phase 6.3 — List / Search / Filters / Pagination)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driverActor: TestUser;
  let customerActor: TestUser;
  let tokens: Record<string, string>;

  let customerA: string;
  let customerAName: string;
  let customerANumber: string;
  let customerB: string;
  let areaA: { id: string; name: string };
  let areaB: { id: string; name: string };
  let driverId: string;
  let driverUserFirstName: string;

  const createdOrderIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdAreaIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdUserIds: string[] = [];

  const searchMarker = `ph63search${uniqueSuffix()}`;

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

    const suffix = uniqueSuffix();
    customerAName = `Phase63 SearchCo ${suffix}`;
    customerANumber = `PH63-CUST-A-${suffix}`;
    customerA = await seedCustomerRecord(admin.id, { name: customerAName, customerNumber: customerANumber });
    createdCustomerIds.push(customerA);
    customerB = await seedCustomerRecord(admin.id, { name: `Phase63 OtherCo ${suffix}` });
    createdCustomerIds.push(customerB);

    areaA = await createTestArea();
    createdAreaIds.push(areaA.id);
    areaB = await createTestArea();
    createdAreaIds.push(areaB.id);

    const linkableDriverUser = await createTestUser("DRIVER");
    createdUserIds.push(linkableDriverUser.id);
    driverUserFirstName = "Phase45"; // createTestUser always sets first_name "Phase45"
    const driverRes = await request(app)
      .post("/api/v1/drivers")
      .set({ Authorization: `Bearer ${tokens.admin}` })
      .send({ driverNumber: `PH63-DRV-${suffix}`, userId: linkableDriverUser.id });
    assert.equal(driverRes.status, 201);
    driverId = driverRes.body.data.id;
    createdDriverIds.push(driverId);
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

  async function seedOrder(overrides: Parameters<typeof seedTestOrder>[2] = {}) {
    const id = await seedTestOrder(customerA, admin.id, { areaId: areaA.id, areaName: areaA.name, ...overrides });
    createdOrderIds.push(id);
    return id;
  }

  // ===========================================================
  // AUTHORIZATION (1-6)
  // ===========================================================

  describe("Authorization", () => {
    test("1. unauthenticated -> 401", async () => {
      const res = await request(app).get("/api/v1/orders");
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, "UNAUTHORIZED");
    });

    test("2-4. ADMIN/DISPATCHER/FINANCE -> 200", async () => {
      for (const role of ["admin", "dispatcher", "finance"] as const) {
        const res = await request(app).get("/api/v1/orders").set(auth(tokens[role]));
        assert.equal(res.status, 200, `expected ${role} to be allowed`);
      }
    });

    test("5-6. DRIVER/CUSTOMER -> 403", async () => {
      for (const role of ["driver", "customer"] as const) {
        const res = await request(app).get("/api/v1/orders").set(auth(tokens[role]));
        assert.equal(res.status, 403, `expected ${role} to be forbidden`);
        assert.equal(res.body.error.code, "FORBIDDEN");
      }
    });
  });

  // ===========================================================
  // PAGINATION (7-15)
  // ===========================================================

  describe("Pagination", () => {
    before(async () => {
      // Ensure at least a handful of rows exist for pagination assertions.
      await Promise.all([seedOrder(), seedOrder(), seedOrder()]);
    });

    test("7. default page/limit correct", async () => {
      const res = await request(app).get("/api/v1/orders").set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.equal(res.body.meta.page, 1);
      assert.equal(res.body.meta.limit, 20);
      assert.ok(res.body.data.length <= 20);
    });

    test("8-9. explicit page/limit work", async () => {
      const res = await request(app).get("/api/v1/orders?page=1&limit=2").set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.equal(res.body.meta.page, 1);
      assert.equal(res.body.meta.limit, 2);
      assert.ok(res.body.data.length <= 2);
    });

    test("10-12. invalid page/limit -> 400", async () => {
      const badPage = await request(app).get("/api/v1/orders?page=0").set(auth(tokens.admin));
      assert.equal(badPage.status, 400);
      const badLimit = await request(app).get("/api/v1/orders?limit=0").set(auth(tokens.admin));
      assert.equal(badLimit.status, 400);
      const tooHigh = await request(app).get("/api/v1/orders?limit=101").set(auth(tokens.admin));
      assert.equal(tooHigh.status, 400);
    });

    test("13-14. total/totalPages correct", async () => {
      const marker = `ph63page${uniqueSuffix()}`;
      await seedOrder({ receiverName: marker });
      await seedOrder({ receiverName: marker });
      await seedOrder({ receiverName: marker });

      const res = await request(app).get(`/api/v1/orders?search=${marker}&limit=2`).set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.equal(res.body.meta.total, 3);
      assert.equal(res.body.meta.totalPages, 2);
    });

    test("15. empty result gives 200 + []", async () => {
      const res = await request(app)
        .get(`/api/v1/orders?search=ph63-definitely-nonexistent-${uniqueSuffix()}`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data, []);
      assert.equal(res.body.meta.total, 0);
      assert.equal(res.body.meta.totalPages, 0);
    });
  });

  // ===========================================================
  // SEARCH (16-24)
  // ===========================================================

  describe("Search", () => {
    let orderNumber: string;
    let trackingCode: string;
    let receiverNameMarker: string;
    let receiverPhoneMarker: string;

    before(async () => {
      const id = await seedOrder({ receiverName: `Phase63 ReceiverName ${searchMarker}`, receiverPhone: `+96170${uniqueSuffix().slice(0, 6)}` });
      const row = await prisma.orders.findUniqueOrThrow({ where: { id } });
      orderNumber = row.order_number;
      trackingCode = row.tracking_code;
      receiverNameMarker = row.receiver_name;
      receiverPhoneMarker = row.receiver_phone;
    });

    test("16. search by orderNumber", async () => {
      const res = await request(app).get(`/api/v1/orders?search=${orderNumber}`).set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.some((o: { orderNumber: string }) => o.orderNumber === orderNumber));
    });

    test("17. search by trackingCode", async () => {
      const res = await request(app).get(`/api/v1/orders?search=${trackingCode}`).set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.some((o: { trackingCode: string }) => o.trackingCode === trackingCode));
    });

    test("18. search by receiverName", async () => {
      const res = await request(app)
        .get(`/api/v1/orders?search=${encodeURIComponent(searchMarker)}`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.some((o: { receiverName: string }) => o.receiverName === receiverNameMarker));
    });

    test("19. search by receiverPhone", async () => {
      const res = await request(app)
        .get(`/api/v1/orders?search=${encodeURIComponent(receiverPhoneMarker)}`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.some((o: { receiverPhone: string }) => o.receiverPhone === receiverPhoneMarker));
    });

    test("20. search by customerNumber", async () => {
      const res = await request(app)
        .get(`/api/v1/orders?search=${encodeURIComponent(customerANumber)}`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.length > 0);
      assert.ok(res.body.data.every((o: { customer: { customerNumber: string } }) => o.customer.customerNumber === customerANumber));
    });

    test("21. search by customerName", async () => {
      const res = await request(app)
        .get(`/api/v1/orders?search=${encodeURIComponent(customerAName)}`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.length > 0);
      assert.ok(res.body.data.every((o: { customer: { name: string } }) => o.customer.name === customerAName));
    });

    test("22. search is case-insensitive", async () => {
      const res = await request(app)
        .get(`/api/v1/orders?search=${encodeURIComponent(searchMarker.toUpperCase())}`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.some((o: { receiverName: string }) => o.receiverName === receiverNameMarker));
    });

    test("23. non-matching search -> empty list", async () => {
      const res = await request(app)
        .get(`/api/v1/orders?search=zzz-no-such-order-${uniqueSuffix()}`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data, []);
    });

    test("24. search combines with a structured filter (AND semantics)", async () => {
      const matching = await request(app)
        .get(`/api/v1/orders?search=${encodeURIComponent(searchMarker)}&orderType=DELIVERY_ONLY`)
        .set(auth(tokens.admin));
      assert.equal(matching.status, 200);
      assert.ok(matching.body.data.length > 0);

      const nonMatching = await request(app)
        .get(`/api/v1/orders?search=${encodeURIComponent(searchMarker)}&orderType=COMPANY_ORDER`)
        .set(auth(tokens.admin));
      assert.equal(nonMatching.status, 200);
      assert.deepEqual(nonMatching.body.data, []);
    });
  });

  // ===========================================================
  // FILTERS (25-36)
  // ===========================================================

  describe("Filters", () => {
    test("25. status filter", async () => {
      const marker = `ph63status${uniqueSuffix()}`;
      await seedOrder({ status: "OUT_FOR_DELIVERY", receiverName: marker });
      const res = await request(app)
        .get(`/api/v1/orders?search=${marker}&status=OUT_FOR_DELIVERY`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.length >= 1);
      assert.ok(res.body.data.every((o: { status: string }) => o.status === "OUT_FOR_DELIVERY"));
    });

    test("26. orderType filter", async () => {
      const marker = `ph63type${uniqueSuffix()}`;
      await seedOrder({ orderType: "COMPANY_ORDER", receiverName: marker });
      const res = await request(app).get(`/api/v1/orders?search=${marker}&orderType=COMPANY_ORDER`).set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.every((o: { orderType: string }) => o.orderType === "COMPANY_ORDER"));
    });

    test("27. paymentType filter", async () => {
      const marker = `ph63pay${uniqueSuffix()}`;
      await seedOrder({ paymentType: "ALREADY_PAID", receiverName: marker });
      const res = await request(app)
        .get(`/api/v1/orders?search=${marker}&paymentType=ALREADY_PAID`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.length >= 1);
    });

    test("28. financialStatus filter", async () => {
      const marker = `ph63fin${uniqueSuffix()}`;
      await seedOrder({ financialStatus: "REVIEW_REQUIRED", receiverName: marker });
      const res = await request(app)
        .get(`/api/v1/orders?search=${marker}&financialStatus=REVIEW_REQUIRED`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.every((o: { financialStatus: string }) => o.financialStatus === "REVIEW_REQUIRED"));
    });

    test("29. customerId filter", async () => {
      const marker = `ph63cust${uniqueSuffix()}`;
      const id = await seedTestOrder(customerB, admin.id, { areaId: areaA.id, areaName: areaA.name, receiverName: marker });
      createdOrderIds.push(id);
      const res = await request(app).get(`/api/v1/orders?customerId=${customerB}`).set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.length >= 1);
      assert.ok(res.body.data.every((o: { customer: { id: string } }) => o.customer.id === customerB));
    });

    test("30. driverId filter", async () => {
      const marker = `ph63drv${uniqueSuffix()}`;
      await seedOrder({ currentDriverId: driverId, receiverName: marker });
      const res = await request(app).get(`/api/v1/orders?driverId=${driverId}`).set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.length >= 1);
      assert.ok(res.body.data.every((o: { currentDriver: { id: string } | null }) => o.currentDriver?.id === driverId));
      const withMarker = res.body.data.find((o: { receiverName: string }) => o.receiverName === marker);
      assert.ok(withMarker);
      assert.deepEqual(Object.keys(withMarker.currentDriver).sort(), ["driverNumber", "id", "user"]);
      assert.deepEqual(Object.keys(withMarker.currentDriver.user).sort(), ["firstName", "lastName", "phone"]);
      assert.equal(withMarker.currentDriver.user.firstName, driverUserFirstName);
    });

    test("31. areaId filter", async () => {
      const marker = `ph63area${uniqueSuffix()}`;
      const id = await seedTestOrder(customerA, admin.id, { areaId: areaB.id, areaName: areaB.name, receiverName: marker });
      createdOrderIds.push(id);
      const res = await request(app).get(`/api/v1/orders?areaId=${areaB.id}`).set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.length >= 1);
      const found = res.body.data.find((o: { receiverName: string }) => o.receiverName === marker);
      assert.ok(found);
      assert.equal(found.receiverArea, areaB.name);
    });

    test("32-33. needsFinancialReview true/false", async () => {
      const markerTrue = `ph63reviewtrue${uniqueSuffix()}`;
      const markerFalse = `ph63reviewfalse${uniqueSuffix()}`;
      await seedOrder({ needsFinancialReview: true, receiverName: markerTrue });
      await seedOrder({ needsFinancialReview: false, receiverName: markerFalse });

      const trueRes = await request(app)
        .get(`/api/v1/orders?search=${markerTrue}&needsFinancialReview=true`)
        .set(auth(tokens.admin));
      assert.equal(trueRes.status, 200);
      assert.ok(trueRes.body.data.every((o: { needsFinancialReview: boolean }) => o.needsFinancialReview === true));

      const falseRes = await request(app)
        .get(`/api/v1/orders?search=${markerFalse}&needsFinancialReview=false`)
        .set(auth(tokens.admin));
      assert.equal(falseRes.status, 200);
      assert.ok(falseRes.body.data.every((o: { needsFinancialReview: boolean }) => o.needsFinancialReview === false));
    });

    test("34-35. assignmentStatus assigned/unassigned", async () => {
      const markerAssigned = `ph63assigned${uniqueSuffix()}`;
      const markerUnassigned = `ph63unassigned${uniqueSuffix()}`;
      await seedOrder({ currentDriverId: driverId, receiverName: markerAssigned });
      await seedOrder({ receiverName: markerUnassigned });

      const assignedRes = await request(app)
        .get(`/api/v1/orders?search=${markerAssigned}&assignmentStatus=ASSIGNED`)
        .set(auth(tokens.admin));
      assert.equal(assignedRes.status, 200);
      assert.ok(assignedRes.body.data.length >= 1);
      assert.ok(assignedRes.body.data.every((o: { currentDriver: unknown }) => o.currentDriver !== null));

      const unassignedRes = await request(app)
        .get(`/api/v1/orders?search=${markerUnassigned}&assignmentStatus=UNASSIGNED`)
        .set(auth(tokens.admin));
      assert.equal(unassignedRes.status, 200);
      assert.ok(unassignedRes.body.data.length >= 1);
      assert.ok(unassignedRes.body.data.every((o: { currentDriver: unknown }) => o.currentDriver === null));

      // Cross-check: the assigned marker must never appear when filtering unassigned, and vice versa.
      const crossCheck1 = await request(app)
        .get(`/api/v1/orders?search=${markerAssigned}&assignmentStatus=UNASSIGNED`)
        .set(auth(tokens.admin));
      assert.deepEqual(crossCheck1.body.data, []);
    });

    test("36. multiple filters compose with AND semantics", async () => {
      const marker = `ph63multi${uniqueSuffix()}`;
      await seedOrder({
        status: "OUT_FOR_DELIVERY",
        orderType: "DELIVERY_ONLY",
        needsFinancialReview: false,
        receiverName: marker,
      });
      // A near-identical order that fails ONE of the AND'd conditions must be excluded.
      await seedOrder({
        status: "OUT_FOR_DELIVERY",
        orderType: "COMPANY_ORDER",
        needsFinancialReview: false,
        receiverName: marker,
      });

      const res = await request(app)
        .get(`/api/v1/orders?search=${marker}&status=OUT_FOR_DELIVERY&orderType=DELIVERY_ONLY&needsFinancialReview=false`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 1);
      assert.equal(res.body.data[0].orderType, "DELIVERY_ONLY");
    });
  });

  // ===========================================================
  // Phase 6.3 REVIEW CLEANUP — driverId + assignmentStatus composition
  // ===========================================================

  describe("driverId + assignmentStatus composition (Phase 6.3 review cleanup)", () => {
    test("1. driverId only returns only that driver's orders", async () => {
      const marker = `ph63cleanup-driveronly-${uniqueSuffix()}`;
      const otherMarker = `ph63cleanup-otherdriver-${uniqueSuffix()}`;
      await seedOrder({ currentDriverId: driverId, receiverName: marker });
      await seedOrder({ receiverName: otherMarker }); // unassigned, must not appear

      const res = await request(app).get(`/api/v1/orders?driverId=${driverId}`).set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.length >= 1);
      assert.ok(res.body.data.every((o: { currentDriver: { id: string } | null }) => o.currentDriver?.id === driverId));
    });

    test("2. assignmentStatus=ASSIGNED returns assigned orders", async () => {
      const marker = `ph63cleanup-assigned-${uniqueSuffix()}`;
      await seedOrder({ currentDriverId: driverId, receiverName: marker });

      const res = await request(app)
        .get(`/api/v1/orders?search=${marker}&assignmentStatus=ASSIGNED`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 1);
      assert.ok(res.body.data[0].currentDriver !== null);
    });

    test("3. assignmentStatus=UNASSIGNED returns unassigned orders", async () => {
      const marker = `ph63cleanup-unassigned-${uniqueSuffix()}`;
      await seedOrder({ receiverName: marker });

      const res = await request(app)
        .get(`/api/v1/orders?search=${marker}&assignmentStatus=UNASSIGNED`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 1);
      assert.equal(res.body.data[0].currentDriver, null);
    });

    test("4. driverId + ASSIGNED (compatible) returns that driver's orders, same as driverId alone", async () => {
      const marker = `ph63cleanup-compat-${uniqueSuffix()}`;
      await seedOrder({ currentDriverId: driverId, receiverName: marker });

      const driverOnly = await request(app)
        .get(`/api/v1/orders?search=${marker}&driverId=${driverId}`)
        .set(auth(tokens.admin));
      const driverPlusAssigned = await request(app)
        .get(`/api/v1/orders?search=${marker}&driverId=${driverId}&assignmentStatus=ASSIGNED`)
        .set(auth(tokens.admin));

      assert.equal(driverOnly.status, 200);
      assert.equal(driverPlusAssigned.status, 200);
      assert.equal(driverPlusAssigned.body.data.length, 1);
      assert.deepEqual(
        driverPlusAssigned.body.data.map((o: { id: string }) => o.id),
        driverOnly.body.data.map((o: { id: string }) => o.id)
      );
      assert.equal(driverPlusAssigned.body.data[0].currentDriver.id, driverId);
    });

    test("5. driverId + UNASSIGNED (contradictory) -> 200, empty list, total 0 — not a 400", async () => {
      const marker = `ph63cleanup-contradict-${uniqueSuffix()}`;
      // This order WOULD match driverId alone — proving the empty result
      // comes from the AND with UNASSIGNED, not from an unrelated cause.
      await seedOrder({ currentDriverId: driverId, receiverName: marker });

      const res = await request(app)
        .get(`/api/v1/orders?search=${marker}&driverId=${driverId}&assignmentStatus=UNASSIGNED`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data, []);
      assert.equal(res.body.meta.total, 0);
      assert.equal(res.body.meta.totalPages, 0);
    });

    test("6. driverId still composes correctly with status/orderType/customerId/areaId/needsFinancialReview/search", async () => {
      const marker = `ph63cleanup-composeall-${uniqueSuffix()}`;
      const matchingId = await seedOrder({
        currentDriverId: driverId,
        status: "OUT_FOR_DELIVERY",
        orderType: "DELIVERY_ONLY",
        needsFinancialReview: false,
        receiverName: marker,
      });
      // Same driver, same marker, but wrong status — must NOT match when
      // status is also filtered, proving driverId doesn't override/short-
      // circuit the other AND'd filters.
      await seedOrder({
        currentDriverId: driverId,
        status: "DELIVERED",
        orderType: "DELIVERY_ONLY",
        needsFinancialReview: false,
        receiverName: marker,
      });
      // Different driver-owning order for customerA/areaA — used to prove
      // customerId/areaId still narrow the driverId match.
      const otherCustomerOrderId = await seedTestOrder(customerB, admin.id, {
        areaId: areaA.id,
        areaName: areaA.name,
        currentDriverId: driverId,
        receiverName: marker,
      });
      createdOrderIds.push(otherCustomerOrderId);

      const res = await request(app)
        .get(
          `/api/v1/orders?search=${marker}&driverId=${driverId}&status=OUT_FOR_DELIVERY&orderType=DELIVERY_ONLY` +
            `&customerId=${customerA}&areaId=${areaA.id}&needsFinancialReview=false`
        )
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 1);
      assert.equal(res.body.data[0].id, matchingId);
      assert.equal(res.body.data[0].currentDriver.id, driverId);
      assert.equal(res.body.data[0].status, "OUT_FOR_DELIVERY");
    });
  });

  // ===========================================================
  // FILTER VALIDATION (37-45)
  // ===========================================================

  describe("Filter validation", () => {
    test("37-40. invalid enum filters -> 400", async () => {
      for (const qs of [
        "status=NOT_A_STATUS",
        "orderType=NOT_A_TYPE",
        "paymentType=NOT_A_PAYMENT_TYPE",
        "financialStatus=NOT_A_FINANCIAL_STATUS",
      ]) {
        const res = await request(app).get(`/api/v1/orders?${qs}`).set(auth(tokens.admin));
        assert.equal(res.status, 400, `expected ${qs} to be rejected`);
        assert.equal(res.body.error.code, "VALIDATION_ERROR");
      }
    });

    test("41-43. malformed UUID filters -> 400", async () => {
      for (const qs of ["customerId=not-a-uuid", "driverId=not-a-uuid", "areaId=not-a-uuid"]) {
        const res = await request(app).get(`/api/v1/orders?${qs}`).set(auth(tokens.admin));
        assert.equal(res.status, 400, `expected ${qs} to be rejected`);
      }
    });

    test("44. invalid boolean -> 400", async () => {
      const res = await request(app).get("/api/v1/orders?needsFinancialReview=maybe").set(auth(tokens.admin));
      assert.equal(res.status, 400);
    });

    test("45. invalid assignmentStatus -> 400", async () => {
      const res = await request(app).get("/api/v1/orders?assignmentStatus=SOMETIMES").set(auth(tokens.admin));
      assert.equal(res.status, 400);
    });
  });

  // ===========================================================
  // DATE FILTERS (46-50)
  // ===========================================================

  describe("Date filters", () => {
    let oldId: string;
    let midId: string;
    let recentId: string;
    const base = new Date();
    const dateMarker = `ph63date${uniqueSuffix()}`;

    before(async () => {
      oldId = await seedOrder({ createdAt: new Date(base.getTime() - 3 * 86400000), receiverName: dateMarker });
      midId = await seedOrder({ createdAt: new Date(base.getTime() - 2 * 86400000), receiverName: dateMarker });
      recentId = await seedOrder({ createdAt: new Date(base.getTime() - 1 * 86400000), receiverName: dateMarker });
    });

    test("46. createdFrom works", async () => {
      const from = new Date(base.getTime() - 2.5 * 86400000).toISOString();
      const res = await request(app)
        .get(`/api/v1/orders?search=${dateMarker}&createdFrom=${from}`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      const ids = res.body.data.map((o: { id: string }) => o.id);
      assert.ok(ids.includes(midId));
      assert.ok(ids.includes(recentId));
      assert.ok(!ids.includes(oldId));
    });

    test("47. createdTo works", async () => {
      const to = new Date(base.getTime() - 1.5 * 86400000).toISOString();
      const res = await request(app)
        .get(`/api/v1/orders?search=${dateMarker}&createdTo=${to}`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      const ids = res.body.data.map((o: { id: string }) => o.id);
      assert.ok(ids.includes(oldId));
      assert.ok(ids.includes(midId));
      assert.ok(!ids.includes(recentId));
    });

    test("48. bounded date range works", async () => {
      const from = new Date(base.getTime() - 2.5 * 86400000).toISOString();
      const to = new Date(base.getTime() - 1.5 * 86400000).toISOString();
      const res = await request(app)
        .get(`/api/v1/orders?search=${dateMarker}&createdFrom=${from}&createdTo=${to}`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      const ids = res.body.data.map((o: { id: string }) => o.id);
      assert.deepEqual(ids, [midId]);
    });

    test("49. createdFrom > createdTo -> 400", async () => {
      const from = new Date(base.getTime() - 1 * 86400000).toISOString();
      const to = new Date(base.getTime() - 2 * 86400000).toISOString();
      const res = await request(app)
        .get(`/api/v1/orders?createdFrom=${from}&createdTo=${to}`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("50. malformed date -> 400", async () => {
      const res = await request(app).get("/api/v1/orders?createdFrom=banana").set(auth(tokens.admin));
      assert.equal(res.status, 400);
      const res2 = await request(app).get("/api/v1/orders?createdTo=2026-99-99").set(auth(tokens.admin));
      assert.equal(res2.status, 400);
    });

    test("Phase 6.3 review cleanup: impossible calendar date (2026-02-30) is rejected, not silently rolled over to March 2", async () => {
      const fromRes = await request(app).get("/api/v1/orders?createdFrom=2026-02-30").set(auth(tokens.admin));
      assert.equal(fromRes.status, 400);
      assert.equal(fromRes.body.error.code, "VALIDATION_ERROR");

      const toRes = await request(app).get("/api/v1/orders?createdTo=2026-02-30T10:00:00.000Z").set(auth(tokens.admin));
      assert.equal(toRes.status, 400);

      // A real leap day must still be accepted (round-trip check must not
      // over-reject valid dates).
      const leapRes = await request(app).get("/api/v1/orders?createdFrom=2024-02-29").set(auth(tokens.admin));
      assert.equal(leapRes.status, 200);

      // ...and a non-leap year's Feb 29 must still be rejected (it also
      // rolls over under the naive Date parser).
      const nonLeapRes = await request(app).get("/api/v1/orders?createdFrom=2026-02-29").set(auth(tokens.admin));
      assert.equal(nonLeapRes.status, 400);

      // A valid, ordinary explicit-UTC datetime must still be accepted.
      const validDatetimeRes = await request(app)
        .get("/api/v1/orders?createdFrom=2026-01-15T10:30:00.000Z")
        .set(auth(tokens.admin));
      assert.equal(validDatetimeRes.status, 200);
    });
  });

  // ===========================================================
  // SORTING (51-52)
  // ===========================================================

  describe("Sorting", () => {
    test("51. newest records returned first", async () => {
      const marker = `ph63sort${uniqueSuffix()}`;
      const base = new Date();
      const olderId = await seedOrder({ createdAt: new Date(base.getTime() - 5000), receiverName: marker });
      const newerId = await seedOrder({ createdAt: new Date(base.getTime()), receiverName: marker });

      const res = await request(app).get(`/api/v1/orders?search=${marker}`).set(auth(tokens.admin));
      assert.equal(res.status, 200);
      const ids = res.body.data.map((o: { id: string }) => o.id);
      assert.ok(ids.indexOf(newerId) < ids.indexOf(olderId));

      const timestamps = res.body.data.map((o: { createdAt: string }) => new Date(o.createdAt).getTime());
      const sorted = [...timestamps].sort((a, b) => b - a);
      assert.deepEqual(timestamps, sorted);
    });

    test("52. deterministic ordering when createdAt values are identical (id DESC tiebreaker)", async () => {
      const marker = `ph63tie${uniqueSuffix()}`;
      const sameInstant = new Date();
      await seedOrder({ createdAt: sameInstant, receiverName: marker });
      await seedOrder({ createdAt: sameInstant, receiverName: marker });
      await seedOrder({ createdAt: sameInstant, receiverName: marker });

      const first = await request(app).get(`/api/v1/orders?search=${marker}`).set(auth(tokens.admin));
      const second = await request(app).get(`/api/v1/orders?search=${marker}`).set(auth(tokens.admin));
      assert.equal(first.status, 200);
      assert.deepEqual(
        first.body.data.map((o: { id: string }) => o.id),
        second.body.data.map((o: { id: string }) => o.id),
        "repeated identical requests must return the same order for tied timestamps"
      );
    });
  });

  // ===========================================================
  // DTO / SECURITY (53-60)
  // ===========================================================

  describe("DTO / security", () => {
    test("53-60. list DTO is a safe, small OrderSummary", async () => {
      const marker = `ph63dto${uniqueSuffix()}`;
      await seedOrder({
        currentDriverId: driverId,
        actualAmountCollected: "50.00",
        receiverName: marker,
      });

      const res = await request(app).get(`/api/v1/orders?search=${marker}`).set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.length >= 1);
      const row = res.body.data[0];

      // 53. OrderSummary shape, not full OrderDetail (no receiver/package/
      // financial nested groups, no statusHistory, no prepaid/collection
      // payment-method objects).
      assert.deepEqual(
        Object.keys(row).sort(),
        [
          "actualAmountCollected",
          "amountToCollect",
          "assignedAt",
          "createdAt",
          "currentDriver",
          "customer",
          "deliveredAt",
          "deliveryFee",
          "financialStatus",
          "id",
          "needsFinancialReview",
          "orderAmount",
          "orderNumber",
          "orderType",
          "receiverArea",
          "receiverName",
          "receiverPhone",
          "status",
          "trackingCode",
        ]
      );

      // 54. money as strings
      assert.equal(typeof row.orderAmount, "string");
      assert.equal(typeof row.deliveryFee, "string");
      assert.equal(typeof row.amountToCollect, "string");
      assert.equal(typeof row.actualAmountCollected, "string");

      // 55. safe customer summary only
      assert.deepEqual(Object.keys(row.customer).sort(), ["customerNumber", "id", "name", "primaryPhone"]);

      // 56. safe current-driver summary only
      assert.deepEqual(Object.keys(row.currentDriver).sort(), ["driverNumber", "id", "user"]);
      assert.deepEqual(Object.keys(row.currentDriver.user).sort(), ["firstName", "lastName", "phone"]);

      const serialized = JSON.stringify(res.body);
      // 57. no password/auth/session data
      assert.doesNotMatch(serialized, /password_hash/i);
      assert.doesNotMatch(serialized, /refresh_token/i);
      assert.doesNotMatch(serialized, /auth_sessions/i);
      // 58. no status history
      assert.doesNotMatch(serialized, /statusHistory/);
      // 59. no ledger data
      assert.doesNotMatch(serialized, /wallet_transactions/i);
      assert.doesNotMatch(serialized, /driver_cash_transactions/i);
      // 60. no receiver instructions / package notes (excluded from list DTO entirely)
      assert.doesNotMatch(serialized, /receiverInstructions/);
      assert.doesNotMatch(serialized, /packageNotes/);
      assert.doesNotMatch(serialized, /receiver_instructions/);
    });
  });

  // ===========================================================
  // QUERY BEHAVIOR (61-63)
  // ===========================================================

  describe("Query behavior for unknown valid ids", () => {
    test("61. unknown valid customerId -> 200 empty", async () => {
      const res = await request(app)
        .get("/api/v1/orders?customerId=00000000-0000-0000-0000-000000000000")
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data, []);
    });

    test("62. unknown valid driverId -> 200 empty", async () => {
      const res = await request(app)
        .get("/api/v1/orders?driverId=00000000-0000-0000-0000-000000000000")
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data, []);
    });

    test("63. unknown valid areaId -> 200 empty", async () => {
      const res = await request(app)
        .get("/api/v1/orders?areaId=00000000-0000-0000-0000-000000000000")
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data, []);
    });
  });

  // ===========================================================
  // REGRESSION SMOKE (64-65)
  // ===========================================================

  describe("Create/detail regression smoke", () => {
    test("64-65. POST /orders and GET /orders/:id still work alongside the list endpoint", async () => {
      const cashMethod = await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } });
      const created = await request(app)
        .post("/api/v1/orders")
        .set(auth(tokens.admin))
        .send({
          customerId: customerA,
          orderType: "DELIVERY_ONLY",
          paymentType: "CASH_ON_DELIVERY",
          receiverName: "Phase63 Regression Receiver",
          receiverPhone: "+96170009999",
          receiverAreaId: areaA.id,
          receiverAddress: "1 Regression St",
          description: "phase63 regression order",
          orderAmount: "50.00",
          deliveryFee: "5.00",
          collectionPaymentMethodId: cashMethod.id,
        });
      assert.equal(created.status, 201);
      createdOrderIds.push(created.body.data.id);

      const detail = await request(app).get(`/api/v1/orders/${created.body.data.id}`).set(auth(tokens.admin));
      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.id, created.body.data.id);

      const list = await request(app)
        .get(`/api/v1/orders?search=${encodeURIComponent("Phase63 Regression Receiver")}`)
        .set(auth(tokens.admin));
      assert.equal(list.status, 200);
      assert.ok(list.body.data.some((o: { id: string }) => o.id === created.body.data.id));
    });
  });
});
