import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../../src/shared/errors/app-error";
import { getCustomerProfileForUser, getDriverProfileForUser } from "../../src/modules/auth/ownership.service";
import {
  cleanupTestUser,
  createTestCustomer,
  createTestDriver,
  createTestUser,
  type TestUser,
} from "../helpers/fixtures";

describe("Driver ownership resolution", () => {
  let admin: TestUser;
  let driverWithProfile: TestUser;
  let driverProfileId: string;
  let driverWithoutProfile: TestUser;
  let secondDriverWithProfile: TestUser;
  let secondDriverProfileId: string;

  before(async () => {
    admin = await createTestUser("ADMIN");
    driverWithProfile = await createTestUser("DRIVER");
    driverProfileId = await createTestDriver(driverWithProfile.id);
    driverWithoutProfile = await createTestUser("DRIVER");
    secondDriverWithProfile = await createTestUser("DRIVER");
    secondDriverProfileId = await createTestDriver(secondDriverWithProfile.id);
  });

  after(async () => {
    await cleanupTestUser(admin.id);
    await cleanupTestUser(driverWithProfile.id);
    await cleanupTestUser(driverWithoutProfile.id);
    await cleanupTestUser(secondDriverWithProfile.id);
  });

  test("resolves the linked Driver profile for the authenticated user", async () => {
    const profile = await getDriverProfileForUser(driverWithProfile.id);
    assert.equal(profile.id, driverProfileId);
    assert.equal(profile.userId, driverWithProfile.id);
    assert.equal(profile.isActive, true);
  });

  test("DRIVER-role user with no Driver profile fails safely (403 FORBIDDEN, not a raw DB error)", async () => {
    await assert.rejects(
      () => getDriverProfileForUser(driverWithoutProfile.id),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.statusCode, 403);
        assert.equal(error.code, "FORBIDDEN");
        return true;
      }
    );
  });

  test("non-driver user (ADMIN) fails safely", async () => {
    await assert.rejects(
      () => getDriverProfileForUser(admin.id),
      (error: unknown) => error instanceof AppError && error.statusCode === 403
    );
  });

  test("each user's id resolves only that user's own profile — no cross-identity leakage through the single userId input", async () => {
    const profileA = await getDriverProfileForUser(driverWithProfile.id);
    const profileB = await getDriverProfileForUser(secondDriverWithProfile.id);

    assert.equal(profileA.id, driverProfileId);
    assert.equal(profileB.id, secondDriverProfileId);
    assert.notEqual(profileA.id, profileB.id);
    // The helper's only input is the trusted, server-derived userId — there
    // is no second parameter (e.g. a client-suppliable driverId) through
    // which a caller could request a different identity's profile.
    assert.equal(getDriverProfileForUser.length, 1);
  });
});

describe("Customer ownership resolution", () => {
  let admin: TestUser;
  let customerWithProfile: TestUser;
  let customerProfileId: string;
  let customerWithoutProfile: TestUser;
  let secondCustomerWithProfile: TestUser;
  let secondCustomerProfileId: string;

  before(async () => {
    admin = await createTestUser("ADMIN");
    customerWithProfile = await createTestUser("CUSTOMER");
    customerProfileId = await createTestCustomer(customerWithProfile.id, admin.id);
    customerWithoutProfile = await createTestUser("CUSTOMER");
    secondCustomerWithProfile = await createTestUser("CUSTOMER");
    secondCustomerProfileId = await createTestCustomer(secondCustomerWithProfile.id, admin.id);
  });

  after(async () => {
    await cleanupTestUser(customerWithProfile.id);
    await cleanupTestUser(customerWithoutProfile.id);
    await cleanupTestUser(secondCustomerWithProfile.id);
    await cleanupTestUser(admin.id);
  });

  test("resolves the Customer profile whose portal_user_id matches the authenticated user", async () => {
    const profile = await getCustomerProfileForUser(customerWithProfile.id);
    assert.equal(profile.id, customerProfileId);
    assert.equal(profile.userId, customerWithProfile.id);
    assert.equal(profile.isActive, true);
  });

  test("CUSTOMER-role user with no Customer profile fails safely", async () => {
    await assert.rejects(
      () => getCustomerProfileForUser(customerWithoutProfile.id),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.statusCode, 403);
        assert.equal(error.code, "FORBIDDEN");
        return true;
      }
    );
  });

  test("non-customer user (ADMIN) fails safely", async () => {
    await assert.rejects(
      () => getCustomerProfileForUser(admin.id),
      (error: unknown) => error instanceof AppError && error.statusCode === 403
    );
  });

  test("each user's id resolves only that user's own profile — no cross-identity leakage through HTTP-exposed input", async () => {
    const profileA = await getCustomerProfileForUser(customerWithProfile.id);
    const profileB = await getCustomerProfileForUser(secondCustomerWithProfile.id);

    assert.equal(profileA.id, customerProfileId);
    assert.equal(profileB.id, secondCustomerProfileId);
    assert.notEqual(profileA.id, profileB.id);
    assert.equal(getCustomerProfileForUser.length, 1);
  });
});
