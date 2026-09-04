import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../../src/db/prisma";
import {
  cleanupTestArea,
  cleanupTestCustomerRecord,
  cleanupTestOrder,
  cleanupTestUser,
  createTestArea,
  createTestDriver,
  createTestUser,
  seedCustomerRecord,
  seedTestOrder,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Phase 11.17.2 — Parcel Intake & Collection: DATABASE SCHEMA smoke tests.
//
// These verify the migration's structural guarantees only — enums, the
// staged legacy default/backfill, the assignment CHECK, the two partial
// unique indexes, attempt-number uniqueness, FK behaviour, and the
// Failed Collection Reasons catalog. NO business/service/API behaviour is
// exercised (that is Phase 11.17.3). All rows are inserted directly through
// Prisma and cleaned up by this file.
// ============================================================

describe("Parcel Intake & Collection — DB schema (Phase 11.17.2)", () => {
  let admin: TestUser;
  let driverUserA: TestUser;
  let driverUserB: TestUser;
  let driverA: string;
  let driverB: string;
  let area: { id: string; name: string };
  let customerId: string;
  let orderId: string;
  let order2Id: string;

  // rows this file creates in the parcel tables — torn down first (RESTRICT FKs)
  const createdAssignmentIds: string[] = [];
  const createdAttemptIds: string[] = [];

  before(async () => {
    admin = await createTestUser("ADMIN");
    driverUserA = await createTestUser("DRIVER");
    driverUserB = await createTestUser("DRIVER");
    driverA = await createTestDriver(driverUserA.id);
    driverB = await createTestDriver(driverUserB.id);
    area = await createTestArea();
    customerId = await seedCustomerRecord(admin.id, { areaId: area.id });
    orderId = await seedTestOrder(customerId, admin.id, { areaId: area.id, areaName: area.name });
    order2Id = await seedTestOrder(customerId, admin.id, { areaId: area.id, areaName: area.name });
  });

  after(async () => {
    await prisma.parcel_collection_attempts.deleteMany({ where: { order_id: { in: [orderId, order2Id] } } });
    await prisma.parcel_collection_assignments.deleteMany({ where: { order_id: { in: [orderId, order2Id] } } });
    await cleanupTestOrder(order2Id);
    await cleanupTestOrder(orderId);
    await cleanupTestCustomerRecord(customerId);
    await cleanupTestArea(area.id);
    await cleanupTestUser(driverUserA.id);
    await cleanupTestUser(driverUserB.id);
    await cleanupTestUser(admin.id);
  });

  // ---- staged legacy compatibility ----------------------------------------

  test("1. an order seeded WITHOUT parcel fields defaults to legacy ALREADY_AT_COMPANY / RECEIVED_AT_COMPANY", async () => {
    const row = await prisma.orders.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        parcel_intake_method: true,
        parcel_collection_status: true,
        current_parcel_collection_driver_id: true,
        parcel_collection_contact_name: true,
        parcel_collected_from_sender_at: true,
      },
    });
    assert.equal(row.parcel_intake_method, "ALREADY_AT_COMPANY");
    assert.equal(row.parcel_collection_status, "RECEIVED_AT_COMPANY");
    assert.equal(row.current_parcel_collection_driver_id, null);
    assert.equal(row.parcel_collection_contact_name, null);
    assert.equal(row.parcel_collected_from_sender_at, null);
  });

  // ---- enum persistence ---------------------------------------------------

  test("2. all four new enums round-trip through Prisma", async () => {
    const a = await prisma.parcel_collection_assignments.create({
      data: {
        order_id: orderId,
        driver_id: driverA,
        assigned_by_id: admin.id,
        is_current: false,
        ended_at: new Date(),
        end_reason: "ORDER_CANCELLED",
      },
    });
    createdAssignmentIds.push(a.id);
    assert.equal(a.end_reason, "ORDER_CANCELLED");

    const att = await prisma.parcel_collection_attempts.create({
      data: { order_id: orderId, driver_id: driverA, attempt_number: 1, outcome: "FAILED" },
    });
    createdAttemptIds.push(att.id);
    assert.equal(att.outcome, "FAILED");

    await prisma.orders.update({
      where: { id: order2Id },
      data: { parcel_intake_method: "DRIVER_COLLECTION", parcel_collection_status: "AWAITING_ASSIGNMENT" },
    });
    const updated = await prisma.orders.findUniqueOrThrow({
      where: { id: order2Id },
      select: { parcel_intake_method: true, parcel_collection_status: true },
    });
    assert.equal(updated.parcel_intake_method, "DRIVER_COLLECTION");
    assert.equal(updated.parcel_collection_status, "AWAITING_ASSIGNMENT");
    // reset so cleanup / other tests see a clean order2
    await prisma.orders.update({
      where: { id: order2Id },
      data: { parcel_intake_method: "ALREADY_AT_COMPANY", parcel_collection_status: "RECEIVED_AT_COMPANY" },
    });
  });

  // ---- assignment CHECK: is_current <=> (ended_at IS NULL AND end_reason IS NULL) ----

  test("3a. CHECK rejects is_current=true with ended_at set", async () => {
    await assert.rejects(
      prisma.parcel_collection_assignments.create({
        data: {
          order_id: order2Id,
          driver_id: driverA,
          assigned_by_id: admin.id,
          is_current: true,
          ended_at: new Date(),
        },
      }),
    );
  });

  test("3b. CHECK rejects is_current=true with end_reason set", async () => {
    await assert.rejects(
      prisma.parcel_collection_assignments.create({
        data: {
          order_id: order2Id,
          driver_id: driverA,
          assigned_by_id: admin.id,
          is_current: true,
          end_reason: "FAILED",
        },
      }),
    );
  });

  test("3c. CHECK rejects is_current=false with ended_at NULL / end_reason NULL", async () => {
    await assert.rejects(
      prisma.parcel_collection_assignments.create({
        data: { order_id: order2Id, driver_id: driverA, assigned_by_id: admin.id, is_current: false },
      }),
    );
  });

  test("3d. CHECK allows a valid current row and a valid historical row", async () => {
    const historical = await prisma.parcel_collection_assignments.create({
      data: {
        order_id: order2Id,
        driver_id: driverA,
        assigned_by_id: admin.id,
        is_current: false,
        ended_at: new Date(),
        end_reason: "REASSIGNED",
      },
    });
    createdAssignmentIds.push(historical.id);

    const current = await prisma.parcel_collection_assignments.create({
      data: { order_id: order2Id, driver_id: driverB, assigned_by_id: admin.id, is_current: true },
    });
    createdAssignmentIds.push(current.id);
    assert.equal(current.is_current, true);
    assert.equal(current.ended_at, null);
    assert.equal(current.end_reason, null);
  });

  // ---- one current assignment per order (partial unique) ------------------

  test("4. a second is_current=true assignment for the same order is rejected", async () => {
    await assert.rejects(
      prisma.parcel_collection_assignments.create({
        data: { order_id: order2Id, driver_id: driverA, assigned_by_id: admin.id, is_current: true },
      }),
    );
    // a different order may still have its own current row
    const otherCurrent = await prisma.parcel_collection_assignments.create({
      data: { order_id: orderId, driver_id: driverA, assigned_by_id: admin.id, is_current: true },
    });
    createdAssignmentIds.push(otherCurrent.id);
  });

  // ---- attempt_number uniqueness -----------------------------------------

  test("5. (order_id, attempt_number) is unique; same number on another order is fine", async () => {
    await assert.rejects(
      prisma.parcel_collection_attempts.create({
        data: { order_id: orderId, driver_id: driverA, attempt_number: 1, outcome: "FAILED" },
      }),
    );
    const onOrder2 = await prisma.parcel_collection_attempts.create({
      data: { order_id: order2Id, driver_id: driverA, attempt_number: 1, outcome: "FAILED" },
    });
    createdAttemptIds.push(onOrder2.id);
  });

  // ---- at most one COLLECTED attempt per order (partial unique) ----------

  test("6. a second COLLECTED attempt for the same order is rejected; multiple FAILED are allowed", async () => {
    const failed2 = await prisma.parcel_collection_attempts.create({
      data: { order_id: orderId, driver_id: driverA, attempt_number: 2, outcome: "FAILED" },
    });
    createdAttemptIds.push(failed2.id);

    const collected = await prisma.parcel_collection_attempts.create({
      data: {
        order_id: orderId,
        driver_id: driverA,
        attempt_number: 3,
        outcome: "COLLECTED",
        completed_at: new Date(),
      },
    });
    createdAttemptIds.push(collected.id);

    await assert.rejects(
      prisma.parcel_collection_attempts.create({
        data: {
          order_id: orderId,
          driver_id: driverA,
          attempt_number: 4,
          outcome: "COLLECTED",
          completed_at: new Date(),
        },
      }),
    );
  });

  // ---- FK behaviour -----------------------------------------------------

  test("7. FKs reject unknown order / driver / assigned_by / failed reason", async () => {
    const bogus = "00000000-0000-0000-0000-000000000000";
    await assert.rejects(
      prisma.parcel_collection_assignments.create({
        data: { order_id: bogus, driver_id: driverA, assigned_by_id: admin.id, is_current: true },
      }),
    );
    await assert.rejects(
      prisma.parcel_collection_assignments.create({
        data: { order_id: order2Id, driver_id: bogus, assigned_by_id: admin.id, is_current: true },
      }),
    );
    await assert.rejects(
      prisma.parcel_collection_assignments.create({
        data: { order_id: order2Id, driver_id: driverA, assigned_by_id: bogus, is_current: true },
      }),
    );
    await assert.rejects(
      prisma.parcel_collection_attempts.create({
        data: {
          order_id: order2Id,
          driver_id: driverA,
          attempt_number: 9,
          outcome: "FAILED",
          failed_collection_reason_id: bogus,
        },
      }),
    );
  });

  // ---- Failed Collection Reasons catalog -------------------------------

  test("8. failed_collection_reasons holds exactly the 7 canonical rows with the contract flags", async () => {
    const rows = await prisma.failed_collection_reasons.findMany({ orderBy: [{ sort_order: "asc" }, { name: "asc" }] });
    assert.deepEqual(
      rows.map((r) => [r.name, r.requires_notes, r.is_active, r.sort_order]),
      [
        ["Sender unavailable", false, true, 10],
        ["Parcel not ready", false, true, 20],
        ["Unable to contact sender", false, true, 30],
        ["Incorrect collection address", false, true, 40],
        ["Sender requested reschedule", false, true, 50],
        ["Collection cancelled by sender", true, true, 60],
        ["Other", true, true, 70],
      ],
    );
    // strictly separate from failed_delivery_reasons
    const overlap = await prisma.failed_delivery_reasons.findFirst({ where: { name: "Sender unavailable" } });
    assert.equal(overlap, null);
  });

  // ---- Order attempt/assignment link works from the order side --------

  test("9. an order exposes its collection assignments and attempts via Prisma relations", async () => {
    const suffix = uniqueSuffix();
    const linkAssignment = await prisma.parcel_collection_assignments.create({
      data: {
        order_id: order2Id,
        driver_id: driverA,
        assigned_by_id: admin.id,
        is_current: false,
        ended_at: new Date(),
        end_reason: "RECEIVED_AT_COMPANY",
      },
    });
    createdAssignmentIds.push(linkAssignment.id);
    const linkAttempt = await prisma.parcel_collection_attempts.create({
      data: { order_id: order2Id, driver_id: driverA, attempt_number: 2, outcome: "FAILED", notes: `smoke-${suffix}` },
    });
    createdAttemptIds.push(linkAttempt.id);

    const withRelations = await prisma.orders.findUniqueOrThrow({
      where: { id: order2Id },
      include: { parcel_collection_assignments: true, parcel_collection_attempts: true },
    });
    assert.ok(withRelations.parcel_collection_assignments.some((a) => a.id === linkAssignment.id));
    assert.ok(withRelations.parcel_collection_attempts.some((a) => a.id === linkAttempt.id));
  });
});
