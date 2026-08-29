import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import type { OrderStatus } from "../../src/generated/prisma/client";
import {
  cleanupTestArea,
  cleanupTestCustomerRecord,
  cleanupTestOrder,
  cleanupTestUser,
  createTestArea,
  createTestUser,
  loginTestUser,
  seedTestOrder,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Phase 11.6 correction — Customer Management backend contract + privacy:
//   - CustomerDetail no longer exposes wallet (customers.read must not
//     bypass wallets.read)
//   - CustomerSummary.activeOrders (batched) + CustomerDetail.orderSummary
//   - GET /wallets/customer-summaries (wallets.read) — the list financial source
//   - CUSTOMER audit producer + audit-logs?entityType=CUSTOMER query
// ============================================================

describe("Customer contract + privacy correction (Phase 11.6)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let tokens: Record<string, string>;
  let area: { id: string; name: string };
  let cashMethodId: string;

  const createdCustomerIds: string[] = [];
  const createdOrderIds: string[] = [];

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    finance = await createTestUser("FINANCE");
    const [a, d, f] = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, dispatcher.email, dispatcher.password),
      loginTestUser(app, finance.email, finance.password),
    ]);
    tokens = {
      admin: a.accessToken as string,
      dispatcher: d.accessToken as string,
      finance: f.accessToken as string,
    };
    area = await createTestArea();
    cashMethodId = (await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } })).id;
  });

  after(async () => {
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    await cleanupTestArea(area.id);
    await Promise.all([admin, dispatcher, finance].map((u) => cleanupTestUser(u.id)));
  });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function createCustomer(token = tokens.admin, overrides: Record<string, unknown> = {}) {
    const suffix = uniqueSuffix();
    const res = await request(app)
      .post("/api/v1/customers")
      .set(auth(token))
      .send({ customerNumber: `PH116C-${suffix}`, name: `PH116C ${suffix}`, primaryPhone: "+10000000009", ...overrides });
    if (res.status === 201) createdCustomerIds.push(res.body.data.id);
    return res;
  }

  async function seedOrder(customerId: string, status: OrderStatus) {
    const id = await seedTestOrder(customerId, admin.id, { status, areaId: area.id, areaName: area.name });
    createdOrderIds.push(id);
    return id;
  }

  // ---------------------------------------------------------------------------

  describe("wallet privacy", () => {
    test("1. CustomerDetail exposes no wallet field for ADMIN / DISPATCHER / FINANCE", async () => {
      const c = await createCustomer();
      for (const role of ["admin", "dispatcher", "finance"] as const) {
        const res = await request(app).get(`/api/v1/customers/${c.body.data.id}`).set(auth(tokens[role]));
        assert.equal(res.status, 200, role);
        assert.ok(!("wallet" in res.body.data), `${role}: wallet leaked`);
        assert.ok(!("availableBalance" in res.body.data), `${role}: availableBalance leaked`);
        const serialized = JSON.stringify(res.body.data);
        assert.doesNotMatch(serialized, /availableBalance|available_balance/i, `${role}`);
      }
    });

    test("2. wallets.read stays authoritative — dispatcher 403, admin/finance 200", async () => {
      const c = await createCustomer();
      assert.equal((await request(app).get(`/api/v1/wallets/${c.body.data.id}`).set(auth(tokens.dispatcher))).status, 403);
      assert.equal((await request(app).get(`/api/v1/wallets/${c.body.data.id}`).set(auth(tokens.admin))).status, 200);
      assert.equal((await request(app).get(`/api/v1/wallets/${c.body.data.id}`).set(auth(tokens.finance))).status, 200);
    });

    test("3. no route bypasses wallets.read for wallet data", async () => {
      const c = await createCustomer();
      // list + detail under customers.read
      const list = await request(app).get("/api/v1/customers?limit=5").set(auth(tokens.dispatcher));
      assert.doesNotMatch(JSON.stringify(list.body), /availableBalance/i);
      const detail = await request(app).get(`/api/v1/customers/${c.body.data.id}`).set(auth(tokens.dispatcher));
      assert.doesNotMatch(JSON.stringify(detail.body), /availableBalance/i);
      // customer-summaries endpoint requires wallets.read
      const summaries = await request(app)
        .get(`/api/v1/wallets/customer-summaries?customerIds=${c.body.data.id}`)
        .set(auth(tokens.dispatcher));
      assert.equal(summaries.status, 403);
    });
  });

  // ---------------------------------------------------------------------------

  describe("active / delivered order counts", () => {
    const ALL_STATUSES: OrderStatus[] = [
      "RECEIVED",
      "READY_FOR_PICKUP",
      "ASSIGNED",
      "PICKED_UP",
      "OUT_FOR_DELIVERY",
      "FAILED_DELIVERY",
      "RESCHEDULED",
      "DELIVERED",
      "RETURNED_TO_COMPANY",
      "RETURNED_TO_CUSTOMER",
      "CANCELLED",
    ];

    test("4. activeOrders excludes DELIVERED / RETURNED_* / CANCELLED; delivered = DELIVERED only", async () => {
      const c = await createCustomer();
      for (const s of ALL_STATUSES) await seedOrder(c.body.data.id, s);

      const detail = await request(app).get(`/api/v1/customers/${c.body.data.id}`).set(auth(tokens.admin));
      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.orderSummary.activeOrders, 7, "7 non-terminal statuses");
      assert.equal(detail.body.data.orderSummary.deliveredOrders, 1);
      assert.equal(detail.body.data.orderSummary.totalOrders, 11);
      // top-level (list) field mirrors detail's activeOrders
      assert.equal(detail.body.data.activeOrders, 7);
    });

    test("5. list activeOrders is per-customer, page-scoped, no cross-leak", async () => {
      const a = await createCustomer();
      const b = await createCustomer();
      await seedOrder(a.body.data.id, "RECEIVED");
      await seedOrder(a.body.data.id, "ASSIGNED");
      await seedOrder(a.body.data.id, "DELIVERED"); // not active
      await seedOrder(b.body.data.id, "OUT_FOR_DELIVERY");

      const list = await request(app).get("/api/v1/customers?limit=100").set(auth(tokens.admin));
      const rowA = list.body.data.find((r: any) => r.id === a.body.data.id);
      const rowB = list.body.data.find((r: any) => r.id === b.body.data.id);
      assert.equal(rowA.activeOrders, 2);
      assert.equal(rowB.activeOrders, 1);
      // a customer with zero orders reports 0, not undefined
      const c = await createCustomer();
      const list2 = await request(app).get(`/api/v1/customers?search=${c.body.data.customerNumber}`).set(auth(tokens.admin));
      assert.equal(list2.body.data[0].activeOrders, 0);
    });
  });

  // ---------------------------------------------------------------------------

  describe("wallets/customer-summaries", () => {
    test("6. finance gets balance + pending for multiple customers; only requested ids", async () => {
      const c1 = await createCustomer();
      const c2 = await createCustomer();
      const other = await createCustomer();
      // give c1 a pending delivery-only order and a wallet balance
      await seedOrder(c1.body.data.id, "OUT_FOR_DELIVERY"); // remaining_order 100 -> pending
      await prisma.customer_wallets.update({
        where: { customer_id: c1.body.data.id },
        data: { available_balance: "42.50" },
      });

      const res = await request(app)
        .get(`/api/v1/wallets/customer-summaries?customerIds=${c1.body.data.id},${c2.body.data.id}`)
        .set(auth(tokens.finance));
      assert.equal(res.status, 200);
      const byId = new Map<string, any>(res.body.data.map((e: any) => [e.customerId, e]));
      assert.equal(byId.size, 2);
      assert.ok(!byId.has(other.body.data.id), "unrequested id must not appear");
      assert.equal(byId.get(c1.body.data.id).availableBalance, "42.5");
      assert.equal(byId.get(c1.body.data.id).pendingAmount, "100");
      assert.equal(byId.get(c2.body.data.id).availableBalance, "0");
      assert.equal(byId.get(c2.body.data.id).pendingAmount, "0");
      assert.doesNotMatch(JSON.stringify(res.body.data), /idempotency|balance_before|password/i);
    });

    test("7. dispatcher cannot obtain the financial summary anywhere", async () => {
      const c = await createCustomer();
      assert.equal(
        (await request(app).get(`/api/v1/wallets/customer-summaries?customerIds=${c.body.data.id}`).set(auth(tokens.dispatcher))).status,
        403
      );
    });

    test("8. malformed customerIds -> 400", async () => {
      assert.equal(
        (await request(app).get(`/api/v1/wallets/customer-summaries?customerIds=not-a-uuid`).set(auth(tokens.admin))).status,
        400
      );
      assert.equal(
        (await request(app).get(`/api/v1/wallets/customer-summaries`).set(auth(tokens.admin))).status,
        400
      );
    });
  });

  // ---------------------------------------------------------------------------

  describe("customer audit producer + activity query", () => {
    test("9. create / update / deactivate / reactivate each emit one CUSTOMER audit row", async () => {
      const c = await createCustomer(tokens.admin, { name: "Audit Start" });
      const id = c.body.data.id;

      await request(app).patch(`/api/v1/customers/${id}`).set(auth(tokens.dispatcher)).send({ name: "Audit Updated", notes: "vip" });
      await request(app).patch(`/api/v1/customers/${id}`).set(auth(tokens.admin)).send({ isActive: false });
      await request(app).patch(`/api/v1/customers/${id}`).set(auth(tokens.admin)).send({ isActive: true });

      const rows = await prisma.audit_logs.findMany({
        where: { entity_type: "CUSTOMER", entity_id: id },
        orderBy: { created_at: "asc" },
      });
      assert.deepEqual(
        rows.map((r) => r.action),
        ["CUSTOMER_CREATED", "CUSTOMER_UPDATED", "CUSTOMER_DEACTIVATED", "CUSTOMER_REACTIVATED"]
      );
      // actor recorded
      assert.equal(rows[0].actor_user_id, admin.id);
      assert.equal(rows[1].actor_user_id, dispatcher.id);
      // safe values only
      const serialized = JSON.stringify(rows);
      assert.doesNotMatch(serialized, /availableBalance|password_hash|portal_user|refresh/i);
      // update captured the changed fields
      const updRow = rows[1];
      assert.equal((updRow.new_values as any).name, "Audit Updated");
      assert.equal((updRow.previous_values as any).name, "Audit Start");
      // deactivate captured isActive transition
      assert.equal((rows[2].new_values as any).isActive, false);
    });

    test("10. audit atomicity — a failed update writes no audit row", async () => {
      const c = await createCustomer();
      const before = await prisma.audit_logs.count({ where: { entity_type: "CUSTOMER", entity_id: c.body.data.id } });
      // invalid area FK -> update fails
      const bad = await request(app)
        .patch(`/api/v1/customers/${c.body.data.id}`)
        .set(auth(tokens.admin))
        .send({ defaultAreaId: "00000000-0000-0000-0000-000000000000" });
      assert.ok(bad.status >= 400);
      const afterCount = await prisma.audit_logs.count({ where: { entity_type: "CUSTOMER", entity_id: c.body.data.id } });
      assert.equal(afterCount, before, "no audit row for a rolled-back update");
    });

    test("11. GET /audit-logs?entityType=CUSTOMER&entityId=<id> is isolated + audit.read-gated", async () => {
      const a = await createCustomer();
      const b = await createCustomer();
      await request(app).patch(`/api/v1/customers/${a.body.data.id}`).set(auth(tokens.admin)).send({ notes: "a-only" });

      const res = await request(app)
        .get(`/api/v1/audit-logs?entityType=CUSTOMER&entityId=${a.body.data.id}`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.length >= 2); // CREATED + UPDATED
      assert.ok(res.body.data.every((r: any) => r.entityType === "CUSTOMER" && r.entityId === a.body.data.id));
      assert.ok(!res.body.data.some((r: any) => r.entityId === b.body.data.id), "no cross-customer leak");

      // dispatcher + finance lack audit.read
      assert.equal((await request(app).get(`/api/v1/audit-logs?entityType=CUSTOMER`).set(auth(tokens.dispatcher))).status, 403);
      assert.equal((await request(app).get(`/api/v1/audit-logs?entityType=CUSTOMER`).set(auth(tokens.finance))).status, 403);
    });
  });

  // ---------------------------------------------------------------------------

  describe("regression", () => {
    test("12. customerNumber still immutable; create/edit still work; receiver snapshot unchanged", async () => {
      const c = await createCustomer(tokens.admin, { name: "Reg Original", defaultAreaId: area.id });
      const orderId = await request(app)
        .post("/api/v1/orders")
        .set(auth(tokens.admin))
        .send({
          customerId: c.body.data.id, orderType: "DELIVERY_ONLY", paymentType: "CASH_ON_DELIVERY",
          receiverName: "Snap Receiver", receiverPhone: "+9617", receiverAreaId: area.id,
          receiverAddress: "1 Snap St", description: "d", orderAmount: "10.00", deliveryFee: "2.00",
          collectionPaymentMethodId: cashMethodId,
        });
      assert.equal(orderId.status, 201, JSON.stringify(orderId.body));
      createdOrderIds.push(orderId.body.data.id);
      const snapBefore = orderId.body.data.receiver;

      const upd = await request(app)
        .patch(`/api/v1/customers/${c.body.data.id}`)
        .set(auth(tokens.admin))
        .send({ name: "Reg Edited", customerNumber: "HACK-NUMBER", primaryPhone: "+9611234" });
      assert.equal(upd.status, 200);
      assert.equal(upd.body.data.name, "Reg Edited");
      assert.equal(upd.body.data.customerNumber, c.body.data.customerNumber, "customerNumber immutable");

      const orderAfter = await request(app).get(`/api/v1/orders/${orderId.body.data.id}`).set(auth(tokens.admin));
      assert.deepEqual(orderAfter.body.data.receiver, snapBefore, "receiver snapshot untouched by customer edit");
    });
  });
});
