import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { prisma } from "../../src/db/prisma";
import {
  buildIncidentEvidenceReport,
  renderOperatorSql,
  validateEvidenceInput,
  type EvidenceQuery,
  type IncidentEvidenceReport,
} from "../../src/modules/historical-reconciliation/incident-evidence-report";
import { cleanupTestCustomerRecord, cleanupTestOrder, seedCustomerRecord, seedTestOrder } from "../helpers/fixtures";
import {
  actors,
  cleanupReconciliationFixtures,
  createGapFixture,
  financialSnapshot,
  initReconciliationFixtures,
  inRolledBackTransaction,
  type GapFixture,
} from "./reconciliation-fixtures";

// FR.12A.8b — the evidence report is read-only, lists potential matches with
// separate signals and never identifies a replacement.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RECEIVER = "EvidenceReceiverSecret";
const PHONE = "+96179999123";

let fx: GapFixture;
let customerId = "";
const orders: Record<string, string> = {};
const numbers: Record<string, string> = {};
let payoutId = "";

async function readOnly<T>(fn: (q: EvidenceQuery) => Promise<T>): Promise<T> {
  let out: T | undefined;
  await inRolledBackTransaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    out = await fn((sql, params) => tx.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params));
  });
  return out as T;
}

const report = (ref: string) => readOnly((q) => buildIncidentEvidenceReport(q, ref));
const match = (r: IncidentEvidenceReport, key: string) => r.potentialMatches.find((m) => m.orderNumber === numbers[key]);

async function order(key: string, overrides: Parameters<typeof seedTestOrder>[2], assignToIncidentDriver = false) {
  const id = await seedTestOrder(customerId, actors.proposer.id, { receiverName: RECEIVER, receiverPhone: PHONE, ...overrides });
  orders[key] = id;
  numbers[key] = (await prisma.orders.findUniqueOrThrow({ where: { id } })).order_number;
  if (assignToIncidentDriver) {
    await prisma.order_assignments.create({
      data: { order_id: id, driver_id: fx.driverId, assigned_by_id: actors.proposer.id, assigned_at: overrides?.createdAt ?? new Date() },
    });
  }
}

describe("FR.12A.8b incident evidence report", () => {
  before(async () => {
    await initReconciliationFixtures();
    fx = await createGapFixture();
    // The incident audit is recorded by the delivering driver.
    await prisma.audit_logs.update({ where: { id: fx.auditId }, data: { actor_user_id: fx.driverUserId } });
    customerId = await seedCustomerRecord(actors.proposer.id);
    const t = fx.evidenceAt.getTime();

    // A: expected total 210, incident driver -> potential match
    await order("A", { createdAt: new Date(t + DAY), orderAmount: "200", deliveryFee: "10", status: "DELIVERED", deliveredAt: new Date(t + DAY + 5 * HOUR) }, true);
    // B: incident driver but no content signal -> counted, not listed
    await order("B", { createdAt: new Date(t + 2 * DAY), orderAmount: "150", deliveryFee: "7", status: "DELIVERED", deliveredAt: new Date(t + 2 * DAY + 3 * HOUR) }, true);
    // C: nothing to collect, back-entered, another driver
    await order("C", {
      createdAt: new Date(t + DAY),
      orderAmount: "60",
      deliveryFee: "4",
      prepaidOrderAmount: "60",
      prepaidDeliveryFee: "4",
      paymentType: "ALREADY_PAID",
      status: "DELIVERED",
      deliveredAt: new Date(t + DAY + 10 * 60_000),
    });
    // D: expected total but outside the window
    await order("D", { createdAt: new Date(t + 60 * DAY), orderAmount: "200", deliveryFee: "10" });
    // E: mentions the deleted reference in its description
    await order("E", { createdAt: new Date(t + 3 * DAY), orderAmount: "41", deliveryFee: "3" });
    await prisma.orders.update({ where: { id: orders.E }, data: { description: `re-entry of ${fx.deletedOrderId.slice(0, 8)}` } });
    // F: same-day delivery by the incident driver, no signal
    await order("F", { createdAt: new Date(t - HOUR), orderAmount: "33", deliveryFee: "2", status: "DELIVERED", deliveredAt: new Date(t + HOUR), currentDriverId: fx.driverId });
    // G: created before the delivery, inside the window
    await order("G", { createdAt: new Date(t - 3 * DAY), orderAmount: "200", deliveryFee: "10" });

    await prisma.company_financial_transactions.create({
      data: { order_id: orders.A, type: "DELIVERY_FEE_REVENUE", amount: "10", created_by_id: actors.proposer.id, created_at: new Date(t + DAY + 5 * HOUR) },
    });
    const cash = await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } });
    payoutId = (
      await prisma.customer_payouts.create({
        data: {
          payout_number: `FR12A8B-${randomUUID().slice(0, 10)}`,
          customer_id: customerId,
          amount: "40",
          payment_method_id: cash.id,
          status: "COMPLETED",
          processed_by_id: actors.reviewer.id,
          created_at: new Date(t + 3 * DAY),
        },
      })
    ).id;
  });

  after(async () => {
    for (const id of Object.values(orders)) await cleanupTestOrder(id);
    await cleanupTestCustomerRecord(customerId);
    await cleanupReconciliationFixtures();
  });

  test("lists potential matches with separate signals and never identifies a replacement", async () => {
    const before = await financialSnapshot();
    const r = await report(fx.deletedOrderId);
    assert.deepEqual(await financialSnapshot(), before);

    assert.equal(r.status, "POTENTIAL_MATCHES_FOR_FINANCE_REVIEW");
    assert.equal(r.replacementIdentified, false);

    const a = match(r, "A");
    assert.ok(a, "A is a potential match");
    assert.ok(a.signals.some((s) => s.includes("expected amount")));
    assert.ok(a.annotations.some((s) => s.includes("incident driver")));
    const c = match(r, "C");
    assert.ok(c);
    assert.ok(c.signals.some((s) => s.includes("nothing to collect")));
    assert.ok(c.signals.some((s) => s.includes("30 minutes")));
    assert.equal(c.annotations.some((s) => s.includes("incident driver")), false);
    assert.ok(match(r, "E")?.signals.some((s) => s.includes("deleted order reference")));
    assert.ok(match(r, "G"), "an order created shortly before the delivery is inside the window");

    // Driver identity or same day alone never makes a match; the window bounds it.
    assert.equal(match(r, "B"), undefined);
    assert.equal(match(r, "D"), undefined);
    assert.equal(match(r, "F"), undefined);
    assert.ok(Number(r.results.E12[0].incident_driver_orders_without_content_signal) >= 1);
    assert.ok(r.unresolvedAssumptions.some((s) => s.includes("show no content signal")));
  });

  test("records confirmed facts, corroboration and related history", async () => {
    const r = await report(fx.deletedOrderId);
    const settlement = await prisma.driver_settlements.findUniqueOrThrow({ where: { id: fx.settlementId } });
    assert.ok(r.confirmedFacts.some((f) => f.source === "E1S" && f.statement.includes("expected 210.00, actual 110.00")));
    assert.ok(r.confirmedFacts.some((f) => f.source === "E1S" && f.statement.includes("no longer exists.") && f.statement.includes("COLLECTION")));
    assert.ok(r.confirmedFacts.some((f) => f.source === "E5S" && f.statement.includes(settlement.settlement_number)));
    assert.ok(r.results.E6S.some((row) => row.order_number === numbers.F));
    assert.ok(r.results.E8.some((row) => row.order_number === numbers.A && row.ledger === "COMPANY"));
    assert.ok(r.results.E9.some((row) => row.order_number === numbers.A && row.kind === "DELIVERY_ASSIGNMENT" && row.is_incident_driver === true));
    assert.ok(r.results.E10.some((row) => row.amount === "40.00"));
    assert.ok(r.results.E11.some((row) => row.settlement_number === settlement.settlement_number && row.amount_only_legacy_format === true));
    assert.ok(r.missingEvidence.some((s) => s.startsWith("Customer of the deleted order")));
    assert.ok(payoutId);
  });

  test("selects no receiver, customer or free-text data", async () => {
    const r = await report(fx.deletedOrderId);
    const json = JSON.stringify(r);
    for (const secret of [RECEIVER, PHONE, "re-entry of", "Phase51 Test Customer", "Phase63 seeded order"]) {
      assert.equal(json.includes(secret), false, `report leaks ${secret}`);
    }
  });

  test("stops when the reference is not exactly one unresolved deleted-order difference", async () => {
    const none = await report(randomUUID());
    assert.equal(none.status, "STOP");
    assert.equal(none.potentialMatches.length, 0);

    const existing = await prisma.audit_logs.create({
      data: { action: "COLLECTION_DIFFERENCE_RECORDED", entity_type: "ORDER", entity_id: orders.A, metadata: {} },
    });
    const live = await report(orders.A);
    assert.equal(live.status, "STOP");
    assert.match(live.confirmedFacts[0].statement, /still exists/);
    await prisma.audit_logs.delete({ where: { id: existing.id } });

    const duplicate = await prisma.audit_logs.create({
      data: { action: "COLLECTION_DIFFERENCE_RECORDED", entity_type: "ORDER", entity_id: fx.deletedOrderId, metadata: {} },
    });
    try {
      const twice = await report(fx.deletedOrderId);
      assert.equal(twice.status, "STOP");
      assert.match(twice.confirmedFacts[0].statement, /2 collection-difference audits/);
    } finally {
      await prisma.audit_logs.delete({ where: { id: duplicate.id } });
    }
  });

  test("reports a missing driver when the audit actor is not a driver", async () => {
    const other = await createGapFixture();
    const r = await report(other.deletedOrderId);
    assert.notEqual(r.status, "STOP");
    assert.ok(r.missingEvidence.some((s) => s.includes("audit actor is not a driver")));
    assert.equal(r.results.E5S.length, 0);
  });

  test("operator SQL is read-only, bound to validated literals and returns the same rows", async () => {
    assert.throws(() => validateEvidenceInput("not-a-uuid", { daysBefore: 7, daysAfter: 30 }));
    assert.throws(() => validateEvidenceInput(fx.deletedOrderId, { daysBefore: -1, daysAfter: 30 }));
    assert.throws(() => renderOperatorSql(`${fx.deletedOrderId}'; select 1; --`));

    const text = renderOperatorSql(fx.deletedOrderId);
    assert.ok(text.startsWith("BEGIN TRANSACTION READ ONLY;"));
    assert.ok(text.trimEnd().endsWith("ROLLBACK;"));
    assert.equal(/\$\d/.test(text), false);
    assert.equal(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|COPY)\b/.test(text), false);

    const statements = text
      .split(/;\n/)
      .map((s) => s.replace(/^(\s*--[^\n]*\n)+/, "").trim())
      .filter((s) => s.startsWith("SELECT") || s.startsWith("WITH"));
    assert.equal(statements.length, 10);
    const r = await report(fx.deletedOrderId);
    const ids = Object.keys(r.results);
    await readOnly(async (q) => {
      for (const [i, sql] of statements.entries()) {
        const rows = await q(sql, []);
        assert.equal(rows.length, r.results[ids[i]].length, `${ids[i]} row count`);
      }
    });
  });

  // Regression: an operator copy of the E12 line once read `SELECTto_at FROM win`
  // (42601). The complete generated script must parse and run as one unit, and
  // every line must be short enough that no token boundary depends on a wrap.
  test("the complete generated operator script runs in PostgreSQL as one unit", async () => {
    for (const ref of [fx.deletedOrderId, randomUUID()]) {
      const text = renderOperatorSql(ref, { daysBefore: 7, daysAfter: 30 });
      for (const [i, line] of text.split("\n").entries()) {
        assert.ok(line.length <= 110, `line ${i + 1} is ${line.length} characters`);
        assert.equal(/\b(SELECT|FROM|WHERE|JOIN|WITH|AND|OR|ON|AS|BY)(?=[a-z0-9_(])/.test(line), false, `keyword glued to the next token on line ${i + 1}: ${line}`);
        assert.equal(/[a-z0-9_)](SELECT|FROM|WHERE|JOIN)\b/.test(line), false, `keyword glued to the previous token on line ${i + 1}: ${line}`);
      }

      const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        // Simple query protocol: the whole text, BEGIN READ ONLY … ROLLBACK, in one round trip.
        const results = (await client.query(text)) as unknown as pg.QueryResult[];
        assert.equal(results.length, 12, "BEGIN, 10 queries, ROLLBACK");
        assert.equal(results[0].command, "BEGIN");
        assert.equal(results[11].command, "ROLLBACK");
        const r = await report(ref);
        for (const [i, id] of Object.keys(r.results).entries()) {
          assert.equal(results[i + 1].command, "SELECT", id);
          assert.equal(results[i + 1].rows.length, r.results[id].length, `${id} row count for ${ref}`);
        }
        assert.equal(results[10].rows.length, 1, "E12 always returns its coverage row");
      } finally {
        await client.end();
      }
    }
  });
});
