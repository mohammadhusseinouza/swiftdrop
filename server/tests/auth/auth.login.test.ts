import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import {
  cleanupTestUser,
  createTestUser,
  extractCookieValue,
  TEST_PASSWORD,
  type TestUser,
} from "../helpers/fixtures";

describe("POST /api/v1/auth/login", () => {
  let app: Express;
  let activeUser: TestUser;
  let inactiveUser: TestUser;

  before(async () => {
    app = createApp();
    activeUser = await createTestUser("DISPATCHER");
    inactiveUser = await createTestUser("DISPATCHER", { isActive: false });
  });

  after(async () => {
    await cleanupTestUser(activeUser.id);
    await cleanupTestUser(inactiveUser.id);
  });

  test("valid login succeeds and returns SafeUser + accessToken + permissions", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: activeUser.email, password: TEST_PASSWORD });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.user.id, activeUser.id);
    assert.equal(res.body.data.user.email, activeUser.email);
    assert.equal(res.body.data.user.role.code, "DISPATCHER");
    assert.equal(typeof res.body.data.accessToken, "string");
    assert.ok(res.body.data.accessToken.length > 0);
    assert.ok(Array.isArray(res.body.data.permissions));
  });

  test("password_hash is never present anywhere in the response", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: activeUser.email, password: TEST_PASSWORD });

    const serialized = JSON.stringify(res.body);
    assert.doesNotMatch(serialized, /password_hash/i);
    assert.doesNotMatch(serialized, /passwordHash/i);
    assert.ok(!("passwordHash" in res.body.data.user));
    assert.ok(!("password_hash" in res.body.data.user));
  });

  test("sets an HttpOnly refresh cookie and never returns the refresh token in JSON", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: activeUser.email, password: TEST_PASSWORD });

    const setCookie = res.headers["set-cookie"] as unknown as string[];
    assert.ok(setCookie, "expected a Set-Cookie header");
    const refreshCookieHeader = setCookie.find((c) => c.startsWith("refresh_token="));
    assert.ok(refreshCookieHeader, "expected a refresh_token cookie");
    assert.match(refreshCookieHeader, /HttpOnly/i);
    assert.match(refreshCookieHeader, /SameSite=Lax/i);
    assert.match(refreshCookieHeader, /Path=\/api\/v1\/auth/i);

    const serializedBody = JSON.stringify(res.body);
    const rawToken = extractCookieValue(setCookie, "refresh_token");
    assert.ok(rawToken && rawToken.length > 0);
    assert.ok(!serializedBody.includes(rawToken!), "raw refresh token must not appear in the JSON body");
    assert.doesNotMatch(serializedBody, /refreshToken/i);
    assert.doesNotMatch(serializedBody, /refresh_token/i);
  });

  test("unknown email returns generic 401 INVALID_CREDENTIALS", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "no-such-user@phase4-5-test.swiftdrop.local", password: "whatever12345" });

    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "INVALID_CREDENTIALS");
  });

  test("wrong password returns the same generic 401 as unknown email", async () => {
    const wrongPasswordRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: activeUser.email, password: "totally-wrong-password" });
    const unknownEmailRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "no-such-user@phase4-5-test.swiftdrop.local", password: "whatever12345" });

    assert.equal(wrongPasswordRes.status, 401);
    assert.deepEqual(wrongPasswordRes.body, unknownEmailRes.body);
  });

  test("inactive user returns the same generic 401", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: inactiveUser.email, password: TEST_PASSWORD });

    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "INVALID_CREDENTIALS");
    assert.equal(res.body.error.message, "Invalid email or password");
  });

  test("validation failures return controlled 400", async () => {
    const missingPassword = await request(app).post("/api/v1/auth/login").send({ email: activeUser.email });
    assert.equal(missingPassword.status, 400);
    assert.equal(missingPassword.body.error.code, "VALIDATION_ERROR");

    const badEmail = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "not-an-email", password: "whatever12345" });
    assert.equal(badEmail.status, 400);
    assert.equal(badEmail.body.error.code, "VALIDATION_ERROR");
  });
});
