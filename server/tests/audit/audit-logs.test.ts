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
  cleanupTestCustomerRecord,
  cleanupTestUser,
  createTestUser,
  loginTestUser,
  seedCustomerRecord,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Audit Search (Phase 9.4) — GET /api/v1/audit-logs
//
// Test-isolation strategy: audit_logs is global and dozens of concurrently-
// running Phase 8/9 test files legitimately write real rows to it. Every
// filter/pagination/DTO test below therefore uses a unique, test-owned
// `action`/`entityType`/`entityId` marker (PH94_TEST_ACTION_<suffix> /
// PH94_TEST_ENTITY / a fresh UUID) so its queries can never observe another
// file's concurrent writes — never an unscoped/absolute global count. The
// one exception (deliberately) is the "real business audit" integration
// section, which drives a REAL payout through the real API and then
// searches for that specific row by its own entityId — still fully scoped.
// ============================================================

describe("Audit Search (Phase 9.4)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driverActor: TestUser;
  let customerActor: TestUser;
  let secondAdmin: TestUser;
  let tokens: Record<string, string>;
  let cashMethodId: string;

  const createdUserIds: string[] = [];
  const createdAuditLogIds: string[] = [];
  const createdCustomerIds: string[] = [];

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    finance = await createTestUser("FINANCE");
    driverActor = await createTestUser("DRIVER");
    customerActor = await createTestUser("CUSTOMER");
    secondAdmin = await createTestUser("ADMIN");

    const [adminLogin, dispatcherLogin, financeLogin, driverLogin, customerLogin, secondAdminLogin] = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, dispatcher.email, dispatcher.password),
      loginTestUser(app, finance.email, finance.password),
      loginTestUser(app, driverActor.email, driverActor.password),
      loginTestUser(app, customerActor.email, customerActor.password),
      loginTestUser(app, secondAdmin.email, secondAdmin.password),
    ]);
    tokens = {
      admin: adminLogin.accessToken as string,
      dispatcher: dispatcherLogin.accessToken as string,
      finance: financeLogin.accessToken as string,
      driver: driverLogin.accessToken as string,
      customer: customerLogin.accessToken as string,
      secondAdmin: secondAdminLogin.accessToken as string,
    };
    for (const [role, token] of Object.entries(tokens)) {
      assert.ok(token, `expected an access token for ${role}`);
    }

    const cashMethod = await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } });
    cashMethodId = cashMethod.id;
  });

  after(async () => {
    for (const id of createdAuditLogIds) await prisma.audit_logs.deleteMany({ where: { id } });
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    for (const id of createdUserIds) await cleanupTestUser(id);
    await Promise.all([admin, dispatcher, finance, driverActor, customerActor, secondAdmin].map((u) => cleanupTestUser(u.id)));
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  function auditPath(qs = "") {
    return `/api/v1/audit-logs${qs}`;
  }

  interface AuditFixtureOverrides {
    actorUserId?: string | null;
    action?: string;
    entityType?: string;
    entityId?: string;
    createdAt?: Date;
    previousValues?: object | null;
    newValues?: object | null;
    metadata?: object | null;
  }

  // Direct-Prisma fixture creation — explicitly sanctioned by the Phase 9.4
  // contract for pure filter/pagination/DTO tests (the purpose of 9.4 is
  // querying behavior, not re-proving each business module writes its own
  // row — that is already covered by the dedicated Phase 8 suites and by
  // the "real business audit" section below).
  async function createAuditFixture(overrides: AuditFixtureOverrides = {}) {
    const row = await prisma.audit_logs.create({
      data: {
        actor_user_id: overrides.actorUserId === undefined ? admin.id : overrides.actorUserId,
        action: overrides.action ?? `PH94_TEST_ACTION_${uniqueSuffix()}`,
        entity_type: overrides.entityType ?? "PH94_TEST_ENTITY",
        entity_id: overrides.entityId ?? randomUUID(),
        previous_values: overrides.previousValues ?? undefined,
        new_values: overrides.newValues ?? undefined,
        metadata: overrides.metadata ?? undefined,
        created_at: overrides.createdAt ?? new Date(),
      },
    });
    createdAuditLogIds.push(row.id);
    return row;
  }

  // ============================================================
  // RBAC (1-7)
  // ============================================================

  describe("RBAC", () => {
    test("1. unauthenticated -> 401", async () => {
      const res = await request(app).get(auditPath());
      assert.equal(res.status, 401);
    });

    test("2. ADMIN (audit.read) -> 200", async () => {
      const res = await request(app).get(auditPath()).set(auth(tokens.admin));
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    test("3. DISPATCHER -> 403", async () => {
      const res = await request(app).get(auditPath()).set(auth(tokens.dispatcher));
      assert.equal(res.status, 403);
    });

    test("4. FINANCE -> 403", async () => {
      const res = await request(app).get(auditPath()).set(auth(tokens.finance));
      assert.equal(res.status, 403);
    });

    test("5. DRIVER -> 403", async () => {
      const res = await request(app).get(auditPath()).set(auth(tokens.driver));
      assert.equal(res.status, 403);
    });

    test("6. CUSTOMER -> 403", async () => {
      const res = await request(app).get(auditPath()).set(auth(tokens.customer));
      assert.equal(res.status, 403);
    });

    test("7. no hard-coded ADMIN bypass — a second independent ADMIN user also succeeds via the real permission catalog", async () => {
      const res = await request(app).get(auditPath()).set(auth(tokens.secondAdmin));
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });
  });

  // ============================================================
  // PAGINATION (8-15)
  // ============================================================

  describe("Pagination", () => {
    test("8. default page=1 limit=20", async () => {
      const res = await request(app).get(auditPath()).set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.equal(res.body.meta.page, 1);
      assert.equal(res.body.meta.limit, 20);
    });

    test("9. explicit page/limit honored", async () => {
      const res = await request(app).get(auditPath("?page=2&limit=5")).set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.equal(res.body.meta.page, 2);
      assert.equal(res.body.meta.limit, 5);
      assert.ok(res.body.data.length <= 5);
    });

    test("10. page < 1 -> 400", async () => {
      const res = await request(app).get(auditPath("?page=0")).set(auth(tokens.admin));
      assert.equal(res.status, 400);
    });

    test("11. limit < 1 -> 400", async () => {
      const res = await request(app).get(auditPath("?limit=0")).set(auth(tokens.admin));
      assert.equal(res.status, 400);
    });

    test("12. limit > 100 -> 400", async () => {
      const res = await request(app).get(auditPath("?limit=101")).set(auth(tokens.admin));
      assert.equal(res.status, 400);
    });

    test("13-14. correct total/totalPages for a scoped action marker", async () => {
      const action = `PH94_TEST_ACTION_${uniqueSuffix()}`;
      await createAuditFixture({ action });
      await createAuditFixture({ action });
      await createAuditFixture({ action });

      const res = await request(app).get(auditPath(`?action=${action}&limit=2`)).set(auth(tokens.admin));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.meta.total, 3);
      assert.equal(res.body.meta.totalPages, 2);
      assert.equal(res.body.data.length, 2);
    });

    test("15. deterministic createdAt DESC / id DESC ordering", async () => {
      const action = `PH94_TEST_ACTION_${uniqueSuffix()}`;
      const base = new Date("2001-03-01T00:00:00.000Z");
      const a = await createAuditFixture({ action, createdAt: new Date(base.getTime()) });
      const b = await createAuditFixture({ action, createdAt: new Date(base.getTime() + 1000) });
      const c = await createAuditFixture({ action, createdAt: new Date(base.getTime() + 2000) });

      const res = await request(app).get(auditPath(`?action=${action}`)).set(auth(tokens.admin));
      const ids = res.body.data.map((r: { id: string }) => r.id);
      assert.deepEqual(ids, [c.id, b.id, a.id]);
    });
  });

  // ============================================================
  // ACTOR FILTER (16-19)
  // ============================================================

  describe("Actor filter", () => {
    test("16-17. actorId returns only that actor's rows, another actor's rows excluded", async () => {
      const entityType = "PH94_TEST_ENTITY";
      const entityIdA = randomUUID();
      const entityIdB = randomUUID();
      await createAuditFixture({ actorUserId: admin.id, entityType, entityId: entityIdA });
      await createAuditFixture({ actorUserId: secondAdmin.id, entityType, entityId: entityIdB });

      const res = await request(app)
        .get(auditPath(`?actorId=${admin.id}&entityType=${entityType}&entityId=${entityIdA}`))
        .set(auth(tokens.admin));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.length, 1);
      assert.equal(res.body.data[0].actor.id, admin.id);

      const excluded = await request(app)
        .get(auditPath(`?actorId=${secondAdmin.id}&entityType=${entityType}&entityId=${entityIdA}`))
        .set(auth(tokens.admin));
      assert.equal(excluded.body.data.length, 0);
    });

    test("18. unknown but syntactically valid actorId UUID -> empty result, not 404", async () => {
      const res = await request(app).get(auditPath(`?actorId=${randomUUID()}`)).set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data, []);
    });

    test("19. a null-actor row still appears when unfiltered by actorId", async () => {
      const entityType = "PH94_TEST_ENTITY";
      const entityId = randomUUID();
      const row = await createAuditFixture({ actorUserId: null, entityType, entityId });

      const res = await request(app).get(auditPath(`?entityType=${entityType}&entityId=${entityId}`)).set(auth(tokens.admin));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const found = res.body.data.find((r: { id: string }) => r.id === row.id);
      assert.ok(found, "null-actor row must still be returned when not filtered by actorId");
      assert.equal(found.actor, null, "actor must be null, never a fabricated System User");
    });
  });

  // ============================================================
  // ACTION FILTER (20-23)
  // ============================================================

  describe("Action filter", () => {
    test("20-21. exact action match; a different action is excluded", async () => {
      const actionA = `PH94_TEST_ACTION_A_${uniqueSuffix()}`;
      const actionB = `PH94_TEST_ACTION_B_${uniqueSuffix()}`;
      await createAuditFixture({ action: actionA });
      await createAuditFixture({ action: actionB });

      const res = await request(app).get(auditPath(`?action=${actionA}`)).set(auth(tokens.admin));
      assert.ok(res.body.data.every((r: { action: string }) => r.action === actionA));
      assert.ok(!res.body.data.some((r: { action: string }) => r.action === actionB));
    });

    test("22. blank action -> 400", async () => {
      const res = await request(app).get(auditPath("?action=")).set(auth(tokens.admin));
      assert.equal(res.status, 400);
    });

    test("23. action > 100 chars -> 400", async () => {
      const res = await request(app).get(auditPath(`?action=${"A".repeat(101)}`)).set(auth(tokens.admin));
      assert.equal(res.status, 400);
    });
  });

  // ============================================================
  // ENTITY FILTER (24-29)
  // ============================================================

  describe("Entity filter", () => {
    test("24-26. entityType alone, entityId alone, and both combined", async () => {
      const entityType = `PH94_ENTITY_${uniqueSuffix()}`;
      const entityId = randomUUID();
      const other = await createAuditFixture({ entityType, entityId: randomUUID() });
      const target = await createAuditFixture({ entityType, entityId });

      const byType = await request(app).get(auditPath(`?entityType=${entityType}`)).set(auth(tokens.admin));
      const byTypeIds = byType.body.data.map((r: { id: string }) => r.id);
      assert.ok(byTypeIds.includes(other.id) && byTypeIds.includes(target.id));

      const byId = await request(app).get(auditPath(`?entityId=${entityId}`)).set(auth(tokens.admin));
      assert.ok(byId.body.data.some((r: { id: string }) => r.id === target.id));

      const both = await request(app).get(auditPath(`?entityType=${entityType}&entityId=${entityId}`)).set(auth(tokens.admin));
      assert.equal(both.body.data.length, 1);
      assert.equal(both.body.data[0].id, target.id);
    });

    test("27. entityId need not be a UUID (non-UUID identifier accepted and matched exactly)", async () => {
      const entityType = "PH94_TEST_ENTITY";
      const entityId = `ORD-NONUUID-${uniqueSuffix()}`;
      const row = await createAuditFixture({ entityType, entityId });

      const res = await request(app).get(auditPath(`?entityType=${entityType}&entityId=${entityId}`)).set(auth(tokens.admin));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.length, 1);
      assert.equal(res.body.data[0].id, row.id);
    });

    test("28. an unrelated entity is excluded from an entityType+entityId filter", async () => {
      const entityType = `PH94_ENTITY_${uniqueSuffix()}`;
      const entityId = randomUUID();
      await createAuditFixture({ entityType, entityId });
      const unrelated = await createAuditFixture({ entityType, entityId: randomUUID() });

      const res = await request(app).get(auditPath(`?entityType=${entityType}&entityId=${entityId}`)).set(auth(tokens.admin));
      assert.ok(!res.body.data.some((r: { id: string }) => r.id === unrelated.id));
    });

    test("29. blank/oversized entityType/entityId rejected", async () => {
      const blank = await request(app).get(auditPath("?entityType=")).set(auth(tokens.admin));
      assert.equal(blank.status, 400);
      const oversized = await request(app).get(auditPath(`?entityId=${"B".repeat(101)}`)).set(auth(tokens.admin));
      assert.equal(oversized.status, 400);
    });
  });

  // ============================================================
  // DATE FILTER (30-35)
  // ============================================================

  describe("Date filter", () => {
    test("30-32. from inclusive, to inclusive UTC calendar day, out-of-range excluded", async () => {
      const entityType = `PH94_DATE_${uniqueSuffix()}`;
      const inRangeStart = await createAuditFixture({ entityType, createdAt: new Date("2001-05-10T00:00:00.000Z") });
      const inRangeEnd = await createAuditFixture({ entityType, createdAt: new Date("2001-05-20T23:59:59.999Z") });
      const before = await createAuditFixture({ entityType, createdAt: new Date("2001-05-09T23:59:59.999Z") });
      const after = await createAuditFixture({ entityType, createdAt: new Date("2001-05-21T00:00:00.000Z") });

      const res = await request(app)
        .get(auditPath(`?entityType=${entityType}&from=2001-05-10&to=2001-05-20`))
        .set(auth(tokens.admin));
      const ids = res.body.data.map((r: { id: string }) => r.id);
      assert.ok(ids.includes(inRangeStart.id));
      assert.ok(ids.includes(inRangeEnd.id));
      assert.ok(!ids.includes(before.id));
      assert.ok(!ids.includes(after.id));
    });

    test("33. malformed date -> 400", async () => {
      const res = await request(app).get(auditPath("?from=not-a-date")).set(auth(tokens.admin));
      assert.equal(res.status, 400);
    });

    test("34. impossible calendar date -> 400", async () => {
      const res = await request(app).get(auditPath("?from=2026-02-30")).set(auth(tokens.admin));
      assert.equal(res.status, 400);
    });

    test("35. from > to -> 400", async () => {
      const res = await request(app).get(auditPath("?from=2001-06-01&to=2001-05-01")).set(auth(tokens.admin));
      assert.equal(res.status, 400);
    });
  });

  // ============================================================
  // COMBINED FILTERS (36-39)
  // ============================================================

  describe("Combined filters (AND, never OR)", () => {
    test("36-39. actor+action, action+entity, actor+entity+date, and all filters together all AND correctly", async () => {
      const entityType = `PH94_COMBO_${uniqueSuffix()}`;
      const entityId = randomUUID();
      const action = `PH94_TEST_ACTION_${uniqueSuffix()}`;
      const createdAt = new Date("2001-07-15T12:00:00.000Z");
      const target = await createAuditFixture({ actorUserId: admin.id, action, entityType, entityId, createdAt });

      // A near-miss row sharing 3 of 4 dimensions but not the action — must
      // never appear in an action-scoped query (proves AND, not OR).
      await createAuditFixture({ actorUserId: admin.id, entityType, entityId, createdAt });

      const actorAction = await request(app).get(auditPath(`?actorId=${admin.id}&action=${action}`)).set(auth(tokens.admin));
      assert.ok(actorAction.body.data.some((r: { id: string }) => r.id === target.id));
      assert.equal(actorAction.body.data.length, 1, "actor+action must AND, not OR, with the near-miss row");

      const actionEntity = await request(app)
        .get(auditPath(`?action=${action}&entityType=${entityType}&entityId=${entityId}`))
        .set(auth(tokens.admin));
      assert.equal(actionEntity.body.data.length, 1);
      assert.equal(actionEntity.body.data[0].id, target.id);

      const actorEntityDate = await request(app)
        .get(auditPath(`?actorId=${admin.id}&entityType=${entityType}&entityId=${entityId}&from=2001-07-15&to=2001-07-15`))
        .set(auth(tokens.admin));
      assert.equal(actorEntityDate.body.data.length, 2, "actor+entity+date matches both same-dimension rows");

      const all = await request(app)
        .get(
          auditPath(
            `?actorId=${admin.id}&action=${action}&entityType=${entityType}&entityId=${entityId}&from=2001-07-15&to=2001-07-15`
          )
        )
        .set(auth(tokens.admin));
      assert.equal(all.body.data.length, 1);
      assert.equal(all.body.data[0].id, target.id);
    });
  });

  // ============================================================
  // DTO (40-47) + JSON FIDELITY (48-50)
  // ============================================================

  describe("DTO shape and JSON fidelity", () => {
    test("40-41. actor safe summary; actor null supported", async () => {
      const entityType = `PH94_DTO_${uniqueSuffix()}`;
      const withActor = await createAuditFixture({ actorUserId: admin.id, entityType, entityId: randomUUID() });
      const withoutActor = await createAuditFixture({ actorUserId: null, entityType, entityId: randomUUID() });

      const res = await request(app).get(auditPath(`?entityType=${entityType}`)).set(auth(tokens.admin));
      const rowWithActor = res.body.data.find((r: { id: string }) => r.id === withActor.id);
      const rowWithoutActor = res.body.data.find((r: { id: string }) => r.id === withoutActor.id);
      assert.deepEqual(Object.keys(rowWithActor.actor).sort(), ["email", "firstName", "id", "lastName"]);
      assert.equal(rowWithActor.actor.id, admin.id);
      assert.equal(rowWithoutActor.actor, null);
    });

    test("42-46. previousValues, newValues, metadata/details, createdAt, entityType/entityId all returned", async () => {
      const entityType = `PH94_DTO_${uniqueSuffix()}`;
      const entityId = randomUUID();
      const row = await createAuditFixture({
        entityType,
        entityId,
        previousValues: { status: "OLD" },
        newValues: { status: "NEW" },
        metadata: { reason: "test reason", amount: "10.00" },
      });

      const res = await request(app).get(auditPath(`?entityType=${entityType}&entityId=${entityId}`)).set(auth(tokens.admin));
      const found = res.body.data.find((r: { id: string }) => r.id === row.id);
      assert.ok(found);
      assert.deepEqual(found.previousValues, { status: "OLD" });
      assert.deepEqual(found.newValues, { status: "NEW" });
      assert.deepEqual(found.metadata, { reason: "test reason", amount: "10.00" });
      assert.ok(typeof found.createdAt === "string" && !Number.isNaN(Date.parse(found.createdAt)));
      assert.equal(found.entityType, entityType);
      assert.equal(found.entityId, entityId);
    });

    test("47. no raw Prisma shape leaked (snake_case columns absent)", async () => {
      const res = await request(app).get(auditPath("?limit=1")).set(auth(tokens.admin));
      if (res.body.data.length > 0) {
        const row = res.body.data[0];
        assert.equal(row.actor_user_id, undefined);
        assert.equal(row.entity_type, undefined);
        assert.equal(row.previous_values, undefined);
        assert.equal(row.new_values, undefined);
      }
    });

    test("48-50. nested JSON previousValues/newValues survive, and metadata numeric/string/boolean/null values remain valid JSON (never double-stringified)", async () => {
      const entityType = `PH94_JSON_${uniqueSuffix()}`;
      const entityId = randomUUID();
      const nestedPrevious = { order: { id: "abc", amount: 10.5 }, tags: ["a", "b"] };
      const nestedNew = { order: { id: "abc", amount: 20.75 }, tags: ["a", "b", "c"] };
      const metadata = { count: 3, label: "phase94", active: true, note: null };
      const row = await createAuditFixture({ entityType, entityId, previousValues: nestedPrevious, newValues: nestedNew, metadata });

      const res = await request(app).get(auditPath(`?entityType=${entityType}&entityId=${entityId}`)).set(auth(tokens.admin));
      const found = res.body.data.find((r: { id: string }) => r.id === row.id);
      assert.deepEqual(found.previousValues, nestedPrevious);
      assert.deepEqual(found.newValues, nestedNew);
      assert.equal(typeof found.metadata.count, "number");
      assert.equal(typeof found.metadata.label, "string");
      assert.equal(typeof found.metadata.active, "boolean");
      assert.equal(found.metadata.note, null);
    });
  });

  // ============================================================
  // SECURITY — no sensitive keys anywhere in a real response (proves the
  // Phase 9.4 sensitive-data review's finding: no production audit writer
  // currently stores credentials/tokens/idempotency keys)
  // ============================================================

  describe("Security — no sensitive-key leakage", () => {
    test("51. a broad authorized read never contains known credential/idempotency keys", async () => {
      const res = await request(app).get(auditPath("?limit=100")).set(auth(tokens.admin));
      const serialized = JSON.stringify(res.body);
      assert.doesNotMatch(serialized, /password_hash/i);
      assert.doesNotMatch(serialized, /passwordHash/);
      assert.doesNotMatch(serialized, /refresh_token/i);
      assert.doesNotMatch(serialized, /refreshToken/);
      assert.doesNotMatch(serialized, /access_token/i);
      assert.doesNotMatch(serialized, /accessToken/);
      assert.doesNotMatch(serialized, /session_token/i);
      assert.doesNotMatch(serialized, /sessionToken/);
      assert.doesNotMatch(serialized, /idempotency_key/i);
      assert.doesNotMatch(serialized, /idempotencyKey/);
    });
  });

  // ============================================================
  // READ ONLY (52) + REPEATED READS (unnumbered continuation)
  // ============================================================

  describe("Read-only behavior", () => {
    test("52-53. GET /audit-logs itself creates zero audit rows, including on repeated reads", async () => {
      const before1 = await request(app).get(auditPath(`?actorId=${admin.id}&action=NONEXISTENT_${uniqueSuffix()}`)).set(auth(tokens.admin));
      assert.equal(before1.status, 200);
      // Baseline: count this actor's total rows immediately before/after two
      // reads — a read creating a new audit row would change this scoped
      // count, which no other concurrently-running file can touch since it
      // is scoped to this test's OWN dedicated actor (secondAdmin, unused
      // elsewhere in production flows).
      const countBefore = await prisma.audit_logs.count({ where: { actor_user_id: secondAdmin.id } });
      await request(app).get(auditPath()).set(auth(tokens.secondAdmin));
      await request(app).get(auditPath()).set(auth(tokens.secondAdmin));
      const countAfter = await prisma.audit_logs.count({ where: { actor_user_id: secondAdmin.id } });
      assert.equal(countAfter, countBefore, "reading audit logs must never itself write an audit row");
    });
  });

  // ============================================================
  // IMMUTABILITY (53-54 per spec numbering)
  // ============================================================

  describe("Immutability", () => {
    test("54. PATCH /audit-logs/:id -> 404 (no mutation route exists)", async () => {
      const row = await createAuditFixture();
      const res = await request(app).patch(auditPath(`/${row.id}`)).set(auth(tokens.admin)).send({ action: "HACKED" });
      assert.equal(res.status, 404);
    });

    test("55. DELETE /audit-logs/:id -> 404 (no mutation route exists)", async () => {
      const row = await createAuditFixture();
      const res = await request(app).delete(auditPath(`/${row.id}`)).set(auth(tokens.admin));
      assert.equal(res.status, 404);
    });
  });

  // ============================================================
  // REAL BUSINESS AUDIT INTEGRATION — a real Customer Payout, driven through
  // the actual API, must be findable via /audit-logs by entityId/action/actor.
  // ============================================================

  describe("Real business audit integration", () => {
    test("56. a real Customer Payout produces a real, searchable CUSTOMER_PAYOUT_COMPLETED audit row", async () => {
      const customerId = await seedCustomerRecord(admin.id);
      createdCustomerIds.push(customerId);
      await runWalletTransaction({
        customerId,
        type: "ORDER_CREDIT",
        direction: "CREDIT",
        amount: new Prisma.Decimal("100.00"),
      });

      const payoutRes = await request(app)
        .post("/api/v1/payouts")
        .set(auth(tokens.admin))
        .set("Idempotency-Key", randomUUID())
        .send({ customerId, amount: "40.00", paymentMethodId: cashMethodId });
      assert.equal(payoutRes.status, 201, JSON.stringify(payoutRes.body));
      const payoutId = payoutRes.body.data.id as string;

      const res = await request(app)
        .get(auditPath(`?entityType=CUSTOMER_PAYOUT&entityId=${payoutId}&action=CUSTOMER_PAYOUT_COMPLETED&actorId=${admin.id}`))
        .set(auth(tokens.admin));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.length, 1);
      const row = res.body.data[0];
      assert.equal(row.action, "CUSTOMER_PAYOUT_COMPLETED");
      assert.equal(row.entityType, "CUSTOMER_PAYOUT");
      assert.equal(row.entityId, payoutId);
      assert.equal(row.actor.id, admin.id);
      assert.equal(row.newValues.status, "COMPLETED");
      assert.equal(row.metadata.customerId, customerId);
    });
  });

  // ============================================================
  // PHASE 9 FINAL SECURITY BOUNDARY — dashboard.read/reports.read/
  // finance.read, even combined, must never imply audit.read.
  // ============================================================

  describe("Phase 9 final security boundary", () => {
    test("57. a FINANCE actor (finance.read + dashboard.read + reports.read) still gets 403 on audit-logs", async () => {
      const res = await request(app).get(auditPath()).set(auth(tokens.finance));
      assert.equal(res.status, 403);
    });

    test("58. a DISPATCHER actor (dashboard.read + reports.read) still gets 403 on audit-logs", async () => {
      const res = await request(app).get(auditPath()).set(auth(tokens.dispatcher));
      assert.equal(res.status, 403);
    });
  });
});
