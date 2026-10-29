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
  cleanupTestUser,
  createTestArea,
  createTestUser,
  loginTestUser,
  seedCustomerRecord,
  seedTestOrder,
  type TestUser,
} from "../helpers/fixtures";

describe("Customer Receiver Memory", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driverActor: TestUser;
  let tokens: Record<string, string>;

  let area: { id: string; name: string };
  let area2: { id: string; name: string };
  let cashMethodId: string;

  const createdOrderIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdAreaIds: string[] = [];

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    finance = await createTestUser("FINANCE");
    driverActor = await createTestUser("DRIVER");
    const logins = await Promise.all(
      [admin, dispatcher, finance, driverActor].map((u) => loginTestUser(app, u.email, u.password))
    );
    tokens = {
      admin: logins[0].accessToken as string,
      dispatcher: logins[1].accessToken as string,
      finance: logins[2].accessToken as string,
      driver: logins[3].accessToken as string,
    };

    area = await createTestArea();
    area2 = await createTestArea();
    createdAreaIds.push(area.id, area2.id);
    cashMethodId = (await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } })).id;
  });

  after(async () => {
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    for (const id of createdAreaIds) await cleanupTestArea(id);
    await Promise.all([admin, dispatcher, finance, driverActor].map((u) => cleanupTestUser(u.id)));
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function newCustomer(): Promise<string> {
    const id = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(id);
    return id;
  }

  function orderBody(customerId: string, overrides: Record<string, unknown> = {}) {
    return {
      customerId,
      orderType: "DELIVERY_ONLY",
      paymentType: "CASH_ON_DELIVERY",
      parcelIntakeMethod: "ALREADY_AT_COMPANY",
      receiverName: "Ahmad Haddad",
      receiverPhone: "03 123 456",
      receiverAreaId: area.id,
      receiverAddress: "Hamra Street, Bldg 4",
      description: "Receiver memory order",
      orderAmount: "100.00",
      deliveryFee: "5.00",
      collectionPaymentMethodId: cashMethodId,
      ...overrides,
    };
  }

  async function createOrder(customerId: string, overrides: Record<string, unknown> = {}, token = tokens.admin) {
    const res = await request(app).post("/api/v1/orders").set(auth(token)).send(orderBody(customerId, overrides));
    if (res.status === 201) createdOrderIds.push(res.body.data.id);
    return res;
  }

  async function createOrderOk(customerId: string, overrides: Record<string, unknown> = {}) {
    const res = await createOrder(customerId, overrides);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  }

  const patchOrder = (id: string, body: Record<string, unknown>) =>
    request(app).patch(`/api/v1/orders/${id}`).set(auth(tokens.admin)).send(body);

  const lookup = (customerId: string, query: Record<string, string> = {}, token = tokens.admin) =>
    request(app).get(`/api/v1/customers/${customerId}/receivers`).query(query).set(auth(token));

  const savedReceivers = (customerId: string) =>
    prisma.customer_receivers.findMany({ where: { customer_id: customerId }, orderBy: { created_at: "asc" } });

  // =========================================================
  // Lookup endpoint
  // =========================================================
  describe("GET /customers/:id/receivers", () => {
    let customerA: string;
    let customerB: string;

    before(async () => {
      customerA = await newCustomer();
      customerB = await newCustomer();
      await createOrderOk(customerA, { receiverName: "Ahmad Haddad", receiverPhone: "03 123 456" });
      await createOrderOk(customerA, { receiverName: "Maya Khoury", receiverPhone: "+961 70 555 111" });
      await createOrderOk(customerA, { receiverName: "John Smith", receiverPhone: "+44 20 7946 0958" });
    });

    test("requires authentication", async () => {
      const res = await request(app).get(`/api/v1/customers/${customerA}/receivers`);
      assert.equal(res.status, 401);
    });

    test("rejects a role without customers.read (DRIVER)", async () => {
      assert.equal((await lookup(customerA, {}, tokens.driver)).status, 403);
    });

    test("rejects customers.read without orders.create / orders.update (FINANCE)", async () => {
      assert.equal((await lookup(customerA, {}, tokens.finance)).status, 403);
    });

    test("DISPATCHER can look up receivers", async () => {
      const res = await lookup(customerA, {}, tokens.dispatcher);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 3);
    });

    test("unknown customer -> 404, malformed id / limit -> 400", async () => {
      assert.equal((await lookup("00000000-0000-4000-8000-000000000000")).status, 404);
      assert.equal((await lookup("not-a-uuid")).status, 400);
      assert.equal((await lookup(customerA, { limit: "21" })).status, 400);
      assert.equal((await lookup(customerA, { limit: "0" })).status, 400);
    });

    test("no search returns the customer's receivers, most recent first, with a safe DTO", async () => {
      const res = await lookup(customerA);
      assert.equal(res.status, 200);
      assert.deepEqual(
        res.body.data.map((r: { name: string }) => r.name),
        ["John Smith", "Maya Khoury", "Ahmad Haddad"]
      );
      const row = res.body.data[2];
      assert.deepEqual(Object.keys(row).sort(), [
        "address",
        "alternativePhone",
        "area",
        "buildingFloor",
        "id",
        "instructions",
        "mapLink",
        "name",
        "phone",
        "updatedAt",
      ]);
      assert.equal(row.phone, "03 123 456");
      assert.deepEqual(row.area, { id: area.id, name: area.name, isActive: true });
      assert.equal(res.body.meta.total, 3);
    });

    test("search by partial name (case-insensitive)", async () => {
      const res = await lookup(customerA, { search: "khou" });
      assert.deepEqual(res.body.data.map((r: { name: string }) => r.name), ["Maya Khoury"]);
    });

    test("search by partial phone in a different format than saved", async () => {
      // saved as "03 123 456" -> +9613123456
      for (const search of ["03123", "+961 3 12", "123 456"]) {
        const res = await lookup(customerA, { search });
        assert.deepEqual(res.body.data.map((r: { name: string }) => r.name), ["Ahmad Haddad"], search);
      }
      const intl = await lookup(customerA, { search: "7946" });
      assert.deepEqual(intl.body.data.map((r: { name: string }) => r.name), ["John Smith"]);
    });

    test("empty results", async () => {
      const res = await lookup(customerA, { search: "Nobody Here" });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data, []);
      assert.equal(res.body.meta.total, 0);
    });

    test("customer isolation — B never sees A's receivers", async () => {
      const all = await lookup(customerB);
      assert.deepEqual(all.body.data, []);
      const byPhone = await lookup(customerB, { search: "03 123 456" });
      assert.deepEqual(byPhone.body.data, []);
    });

    test("limit bounds the result while total reports all matches", async () => {
      const res = await lookup(customerA, { limit: "2" });
      assert.equal(res.body.data.length, 2);
      assert.equal(res.body.meta.total, 3);
      assert.equal(res.body.meta.limit, 2);
    });
  });

  // =========================================================
  // Saving during order creation
  // =========================================================
  describe("order creation", () => {
    test("a new receiver is saved with the entered details; the order snapshot is unchanged", async () => {
      const customer = await newCustomer();
      const order = await createOrderOk(customer, {
        receiverAltPhone: "71 000 111",
        receiverBuildingFloor: "3rd floor",
        receiverMapLink: "https://maps.example/x",
        receiverInstructions: "Ring twice",
      });

      const [saved, ...rest] = await savedReceivers(customer);
      assert.equal(rest.length, 0);
      assert.equal(saved.name, "Ahmad Haddad");
      assert.equal(saved.phone, "03 123 456");
      assert.equal(saved.normalized_phone, "+9613123456");
      assert.equal(saved.alternative_phone, "71 000 111");
      assert.equal(saved.area_id, area.id);
      assert.equal(saved.address, "Hamra Street, Bldg 4");
      assert.equal(saved.building_floor, "3rd floor");
      assert.equal(saved.map_link, "https://maps.example/x");
      assert.equal(saved.instructions, "Ring twice");

      assert.equal(order.receiver.phone, "03 123 456", "the displayed phone is never rewritten");
      assert.equal(order.receiver.name, "Ahmad Haddad");
    });

    test("an equivalent phone format reuses the receiver, refreshes it, and older orders keep their snapshot", async () => {
      const customer = await newCustomer();
      const first = await createOrderOk(customer, { receiverAltPhone: "71 000 111" });
      await createOrderOk(customer, {
        receiverName: "Ahmad H.",
        receiverPhone: "+961 3 123456",
        receiverAddress: "Verdun, Bldg 9",
        receiverAreaId: area2.id,
      });

      const rows = await savedReceivers(customer);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, "Ahmad H.");
      assert.equal(rows[0].phone, "+961 3 123456");
      assert.equal(rows[0].address, "Verdun, Bldg 9");
      assert.equal(rows[0].area_id, area2.id);
      assert.equal(rows[0].alternative_phone, "71 000 111", "an omitted optional field keeps the saved value");

      const firstNow = await prisma.orders.findUniqueOrThrow({ where: { id: first.id } });
      assert.equal(firstNow.receiver_address, "Hamra Street, Bldg 4");
      assert.equal(firstNow.receiver_name, "Ahmad Haddad");
      assert.equal(firstNow.receiver_area_id, area.id);
    });

    test("different customers can save the same phone independently", async () => {
      const a = await newCustomer();
      const b = await newCustomer();
      await createOrderOk(a, { receiverName: "For A" });
      await createOrderOk(b, { receiverName: "For B" });
      assert.equal((await savedReceivers(a))[0].name, "For A");
      assert.equal((await savedReceivers(b))[0].name, "For B");
    });

    test("a phone that cannot be normalized creates the order but no saved receiver", async () => {
      const customer = await newCustomer();
      const order = await createOrderOk(customer, { receiverPhone: "12345" });
      assert.equal(order.receiver.phone, "12345");
      assert.equal((await savedReceivers(customer)).length, 0);
    });

    test("a failed order creation saves no receiver", async () => {
      const customer = await newCustomer();
      const inactiveArea = await createTestArea();
      createdAreaIds.push(inactiveArea.id);
      await prisma.areas.update({ where: { id: inactiveArea.id }, data: { is_active: false } });

      assert.equal((await createOrder(customer, { receiverAreaId: inactiveArea.id })).status, 400);
      assert.equal((await createOrder(customer, { orderAmount: "-1" })).status, 400);
      assert.equal((await createOrder(customer, {}, tokens.finance)).status, 403);
      assert.equal((await savedReceivers(customer)).length, 0);
    });

    test("concurrent creations for the same receiver produce exactly one saved receiver", async () => {
      const customer = await newCustomer();
      const phones = ["03 123 456", "+961 3 123 456", "03-123-456", "009613123456", "9613123456", "03123456"];
      const results = await Promise.all(phones.map((receiverPhone) => createOrder(customer, { receiverPhone })));
      for (const res of results) assert.equal(res.status, 201, JSON.stringify(res.body));
      const rows = await savedReceivers(customer);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].normalized_phone, "+9613123456");
    });

    test("an inactive saved area is reported, and does not bypass the active-area rule", async () => {
      const customer = await newCustomer();
      const soonInactive = await createTestArea();
      createdAreaIds.push(soonInactive.id);
      await createOrderOk(customer, { receiverAreaId: soonInactive.id });
      await prisma.areas.update({ where: { id: soonInactive.id }, data: { is_active: false } });

      const res = await lookup(customer);
      assert.equal(res.body.data[0].area.isActive, false);

      const reuse = await createOrder(customer, { receiverAreaId: soonInactive.id });
      assert.equal(reuse.status, 400);
      assert.equal((await savedReceivers(customer))[0].area_id, soonInactive.id);
    });
  });

  // =========================================================
  // Updating during order editing
  // =========================================================
  describe("order editing", () => {
    test("editing receiver details updates the saved receiver; other orders keep their snapshot", async () => {
      const customer = await newCustomer();
      const first = await createOrderOk(customer);
      const second = await createOrderOk(customer);

      const res = await patchOrder(second.id, { receiverAddress: "Achrafieh, Bldg 1", receiverBuildingFloor: "Ground" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const [saved] = await savedReceivers(customer);
      assert.equal(saved.address, "Achrafieh, Bldg 1");
      assert.equal(saved.building_floor, "Ground");
      const firstNow = await prisma.orders.findUniqueOrThrow({ where: { id: first.id } });
      assert.equal(firstNow.receiver_address, "Hamra Street, Bldg 4");
      assert.equal(firstNow.receiver_building_floor, null);
    });

    test("an edit that leaves the receiver unchanged does not touch receiver memory", async () => {
      const customer = await newCustomer();
      const historical = await seedTestOrder(customer, admin.id, { receiverPhone: "70 333 444", areaId: area.id });
      createdOrderIds.push(historical);

      const res = await patchOrder(historical, { description: "Only the description changed" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal((await savedReceivers(customer)).length, 0);
    });

    test("a historical order without a saved receiver keeps working; a receiver edit creates one", async () => {
      const customer = await newCustomer();
      const historical = await seedTestOrder(customer, admin.id, { receiverPhone: "70 333 444", areaId: area.id });
      createdOrderIds.push(historical);

      const before = await prisma.orders.findUniqueOrThrow({ where: { id: historical } });
      const res = await patchOrder(historical, { receiverName: "Historic Receiver" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const [saved, ...rest] = await savedReceivers(customer);
      assert.equal(rest.length, 0);
      assert.equal(saved.name, "Historic Receiver");
      assert.equal(saved.normalized_phone, "+96170333444");
      assert.equal(saved.address, before.receiver_address);
      assert.equal(saved.area_id, area.id);
    });

    test("changing the phone to a new identity creates a new receiver; the old one is untouched", async () => {
      const customer = await newCustomer();
      const order = await createOrderOk(customer);
      const [original] = await savedReceivers(customer);

      const res = await patchOrder(order.id, { receiverPhone: "76 999 000", receiverName: "New Person" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const rows = await savedReceivers(customer);
      assert.equal(rows.length, 2);
      const old = rows.find((r) => r.id === original.id)!;
      assert.equal(old.name, original.name);
      assert.equal(old.phone, original.phone);
      assert.equal(old.updated_at.getTime(), original.updated_at.getTime());
      const fresh = rows.find((r) => r.id !== original.id)!;
      assert.equal(fresh.normalized_phone, "+96176999000");
      assert.equal(fresh.name, "New Person");
    });

    test("changing the phone to another saved receiver's phone updates that receiver without duplicating", async () => {
      const customer = await newCustomer();
      const orderA = await createOrderOk(customer, { receiverName: "Person A", receiverPhone: "03 111 222" });
      await createOrderOk(customer, {
        receiverName: "Person B",
        receiverPhone: "03 333 444",
        receiverInstructions: "B's instructions",
      });

      const res = await patchOrder(orderA.id, { receiverPhone: "+961 3 333444", receiverName: "Person B (corrected)" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const rows = await savedReceivers(customer);
      assert.equal(rows.length, 2);
      const a = rows.find((r) => r.normalized_phone === "+9613111222")!;
      const b = rows.find((r) => r.normalized_phone === "+9613333444")!;
      assert.equal(a.name, "Person A");
      assert.equal(b.name, "Person B (corrected)");
      assert.equal(b.instructions, "B's instructions", "a different identity's optional fields are never cleared");
    });

    test("a deliberately cleared optional field clears the saved value; an already-empty one keeps it", async () => {
      const customer = await newCustomer();
      const withoutAlt = await createOrderOk(customer, { receiverInstructions: "Call first" });
      const withAlt = await createOrderOk(customer, { receiverAltPhone: "71 222 333" });
      assert.equal((await savedReceivers(customer))[0].alternative_phone, "71 222 333");

      // withoutAlt never had an alt phone: sending null with another change keeps the saved one.
      let res = await patchOrder(withoutAlt.id, { receiverName: "Ahmad (edit 1)", receiverAltPhone: null });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      let [saved] = await savedReceivers(customer);
      assert.equal(saved.alternative_phone, "71 222 333");
      assert.equal(saved.instructions, "Call first");

      // withAlt clears its alt phone deliberately: the saved value is cleared too.
      res = await patchOrder(withAlt.id, { receiverAltPhone: null });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      [saved] = await savedReceivers(customer);
      assert.equal(saved.alternative_phone, null);
      assert.equal(saved.instructions, "Call first");
    });

    test("a customer change saves under the final customer only", async () => {
      const original = await newCustomer();
      const target = await newCustomer();
      const order = await createOrderOk(original);
      const [before] = await savedReceivers(original);

      const res = await patchOrder(order.id, { customerId: target, receiverAddress: "Moved address" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const [stillOriginal] = await savedReceivers(original);
      assert.equal(stillOriginal.address, before.address);
      assert.equal(stillOriginal.updated_at.getTime(), before.updated_at.getTime());
      const targetRows = await savedReceivers(target);
      assert.equal(targetRows.length, 1);
      assert.equal(targetRows[0].address, "Moved address");
      assert.equal((await lookup(original)).body.data[0].address, before.address);
    });

    test("a rejected edit does not update the saved receiver", async () => {
      const customer = await newCustomer();
      const inactiveArea = await createTestArea();
      createdAreaIds.push(inactiveArea.id);
      await prisma.areas.update({ where: { id: inactiveArea.id }, data: { is_active: false } });

      const order = await createOrderOk(customer);
      const [before] = await savedReceivers(customer);

      let res = await patchOrder(order.id, { receiverName: "Should not save", receiverAreaId: inactiveArea.id });
      assert.equal(res.status, 400);

      const delivered = await seedTestOrder(customer, admin.id, {
        status: "DELIVERED",
        receiverPhone: "03 123 456",
        areaId: area.id,
      });
      createdOrderIds.push(delivered);
      res = await patchOrder(delivered, { receiverName: "Should not save either" });
      assert.equal(res.status, 409);

      const [after] = await savedReceivers(customer);
      assert.equal(after.name, before.name);
      assert.equal(after.updated_at.getTime(), before.updated_at.getTime());
    });

    test("concurrent edits of two orders sharing a receiver leave one consistent receiver", async () => {
      const customer = await newCustomer();
      const o1 = await createOrderOk(customer);
      const o2 = await createOrderOk(customer, { receiverPhone: "+961 3 123 456" });

      const [r1, r2] = await Promise.all([
        patchOrder(o1.id, { receiverAddress: "Address from edit 1" }),
        patchOrder(o2.id, { receiverAddress: "Address from edit 2" }),
      ]);
      assert.equal(r1.status, 200, JSON.stringify(r1.body));
      assert.equal(r2.status, 200, JSON.stringify(r2.body));

      const rows = await savedReceivers(customer);
      assert.equal(rows.length, 1);
      assert.ok(["Address from edit 1", "Address from edit 2"].includes(rows[0].address));
      const [o1Now, o2Now] = await Promise.all([
        prisma.orders.findUniqueOrThrow({ where: { id: o1.id } }),
        prisma.orders.findUniqueOrThrow({ where: { id: o2.id } }),
      ]);
      assert.equal(o1Now.receiver_address, "Address from edit 1");
      assert.equal(o2Now.receiver_address, "Address from edit 2");
    });
  });

  // =========================================================
  // Receiver phone format validation
  // =========================================================
  describe("receiver phone validation", () => {
    const CHARACTERS_MESSAGE = "Phone can contain only digits, spaces, dots, hyphens, parentheses and a leading +";

    function fieldError(res: request.Response, field: string): string | undefined {
      return res.body?.error?.details?.properties?.[field]?.errors?.[0];
    }

    test("create rejects an invalid primary phone with the standard validation error; nothing is saved", async () => {
      const customer = await newCustomer();
      for (const receiverPhone of ["03 123 456 ext 2", "٠٣ ١٢٣ ٤٥٦ تحويلة", "03#123456", "03+123456", "++961 3 123456"]) {
        const res = await createOrder(customer, { receiverPhone });
        assert.equal(res.status, 400, receiverPhone);
        assert.equal(res.body.error.code, "VALIDATION_ERROR");
        assert.equal(fieldError(res, "receiverPhone"), CHARACTERS_MESSAGE, receiverPhone);
      }
      const noDigits = await createOrder(customer, { receiverPhone: "+ ( )" });
      assert.equal(fieldError(noDigits, "receiverPhone"), "Phone must contain at least one digit");
      const tooLong = await createOrder(customer, { receiverPhone: "1".repeat(31) });
      assert.equal(tooLong.status, 400);
      assert.ok(fieldError(tooLong, "receiverPhone"));
      assert.equal((await savedReceivers(customer)).length, 0);
    });

    test("create rejects an invalid alternative phone; nothing is saved", async () => {
      const customer = await newCustomer();
      for (const receiverAltPhone of ["n/a", "71 000 111 (home) x2", "71_000_111"]) {
        const res = await createOrder(customer, { receiverAltPhone });
        assert.equal(res.status, 400, receiverAltPhone);
        assert.ok(fieldError(res, "receiverAltPhone"), receiverAltPhone);
      }
      assert.equal((await savedReceivers(customer)).length, 0);
    });

    test("dots, hyphens, parentheses and a leading + are accepted; Arabic-Indic digits are stored as ASCII", async () => {
      const customer = await newCustomer();
      const order = await createOrderOk(customer, {
        receiverPhone: "٠٣.١٢٣.٤٥٦",
        receiverAltPhone: "+961 (۷۰) ۱۲۳-۴۵۶",
      });
      assert.equal(order.receiver.phone, "03.123.456");
      assert.equal(order.receiver.altPhone, "+961 (70) 123-456");

      const [saved] = await savedReceivers(customer);
      assert.equal(saved.phone, "03.123.456");
      assert.equal(saved.normalized_phone, "+9613123456");
      assert.equal(saved.alternative_phone, "+961 (70) 123-456");

      // The suggestion an employee would autofill carries the validated value.
      const suggestion = (await lookup(customer, { search: "03 123" })).body.data[0];
      assert.equal(suggestion.phone, "03.123.456");
      assert.equal(suggestion.alternativePhone, "+961 (70) 123-456");
    });

    test("edit rejects an invalid primary or alternative phone and leaves order + saved receiver unchanged", async () => {
      const customer = await newCustomer();
      const order = await createOrderOk(customer);
      const [before] = await savedReceivers(customer);

      let res = await patchOrder(order.id, { receiverPhone: "03 123 456 ext 2", receiverName: "Not saved" });
      assert.equal(res.status, 400);
      assert.equal(fieldError(res, "receiverPhone"), CHARACTERS_MESSAGE);

      res = await patchOrder(order.id, { receiverAltPhone: "call first" });
      assert.equal(res.status, 400);
      assert.ok(fieldError(res, "receiverAltPhone"));

      const now = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(now.receiver_phone, "03 123 456");
      assert.equal(now.receiver_name, "Ahmad Haddad");
      assert.equal(now.receiver_alt_phone, null);
      const [after] = await savedReceivers(customer);
      assert.equal(after.updated_at.getTime(), before.updated_at.getTime());
    });

    test("a historical invalid phone stays unchanged while unrelated fields are edited", async () => {
      const customer = await newCustomer();
      const historical = await seedTestOrder(customer, admin.id, { receiverPhone: "call Ahmad", areaId: area.id });
      createdOrderIds.push(historical);
      await prisma.orders.update({ where: { id: historical }, data: { receiver_alt_phone: "n/a" } });

      // Phones omitted (what the Edit dialog sends when they are untouched).
      let res = await patchOrder(historical, { description: "Edited description", receiverName: "Renamed receiver" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      let now = await prisma.orders.findUniqueOrThrow({ where: { id: historical } });
      assert.equal(now.receiver_phone, "call Ahmad");
      assert.equal(now.receiver_alt_phone, "n/a");
      assert.equal(now.receiver_name, "Renamed receiver");
      // The legacy phone cannot be normalized -> no saved receiver is created from it.
      assert.equal((await savedReceivers(customer)).length, 0);

      // Explicitly sending the invalid value again is a change request and is validated.
      res = await patchOrder(historical, { receiverPhone: "call Ahmad" });
      assert.equal(res.status, 400);

      // Explicitly correcting it works and starts receiver memory.
      res = await patchOrder(historical, { receiverPhone: "70 333 444" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      now = await prisma.orders.findUniqueOrThrow({ where: { id: historical } });
      assert.equal(now.receiver_phone, "70 333 444");
      assert.equal(now.receiver_alt_phone, "n/a", "an untouched legacy alternative phone is preserved");
      const [saved] = await savedReceivers(customer);
      assert.equal(saved.normalized_phone, "+96170333444");
      assert.equal(saved.alternative_phone, "n/a");

      // Explicitly clearing the legacy alternative phone is allowed (null is not format-checked).
      res = await patchOrder(historical, { receiverAltPhone: null });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      now = await prisma.orders.findUniqueOrThrow({ where: { id: historical } });
      assert.equal(now.receiver_alt_phone, null);
      assert.equal((await savedReceivers(customer))[0].alternative_phone, null);
    });
  });
});
