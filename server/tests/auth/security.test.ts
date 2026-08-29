import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { createErrorTestApp } from "../helpers/error-test-app";
import { cleanupTestUser, createTestUser, loginTestUser, TEST_PASSWORD, type TestUser } from "../helpers/fixtures";

describe("Cookie security", () => {
  let app: Express;
  let user: TestUser;

  before(async () => {
    app = createApp();
    user = await createTestUser("DISPATCHER");
  });

  after(async () => {
    await cleanupTestUser(user.id);
  });

  test("development mode: HttpOnly, SameSite=Lax, correct Path, explicit expiration, no Secure", async () => {
    const res = await request(app).post("/api/v1/auth/login").send({ email: user.email, password: TEST_PASSWORD });
    const setCookie = res.headers["set-cookie"] as unknown as string[];
    const cookie = setCookie.find((c) => c.startsWith("refresh_token="))!;

    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Path=\/api\/v1\/auth/i);
    assert.match(cookie, /Expires=/i);
    assert.doesNotMatch(cookie, /Secure/i);
  });

  test("production mode: Secure flag is present", async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const prodApp = createApp();
      const res = await request(prodApp)
        .post("/api/v1/auth/login")
        .send({ email: user.email, password: TEST_PASSWORD });
      const setCookie = res.headers["set-cookie"] as unknown as string[];
      const cookie = setCookie.find((c) => c.startsWith("refresh_token="))!;

      assert.match(cookie, /Secure/i);
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /SameSite=Lax/i);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});

describe("Secret/data leakage", () => {
  let app: Express;
  let user: TestUser;

  before(async () => {
    app = createApp();
    user = await createTestUser("DISPATCHER");
  });

  after(async () => {
    await cleanupTestUser(user.id);
  });

  test("login response never exposes password_hash, raw password, or the JWT signing secret", async () => {
    const res = await request(app).post("/api/v1/auth/login").send({ email: user.email, password: TEST_PASSWORD });
    const serialized = JSON.stringify(res.body);

    assert.doesNotMatch(serialized, /password_hash/i);
    assert.doesNotMatch(serialized, new RegExp(TEST_PASSWORD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const secret = process.env.AUTH_ACCESS_TOKEN_SECRET;
    if (secret) {
      assert.ok(!serialized.includes(secret));
    }
  });

  test("/me response never exposes refresh_token_hash or any Prisma/database error detail", async () => {
    const login = await loginTestUser(app, user.email, user.password);
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${login.accessToken}`);
    const serialized = JSON.stringify(res.body);

    assert.doesNotMatch(serialized, /refresh_token_hash/i);
    assert.doesNotMatch(serialized, /prisma/i);
    assert.doesNotMatch(serialized, /PrismaClient/i);
  });
});

describe("Error contract", () => {
  let app: Express;
  let user: TestUser;

  before(async () => {
    app = createApp();
    user = await createTestUser("DISPATCHER");
  });

  after(async () => {
    await cleanupTestUser(user.id);
  });

  test("400: validation failure returns the standard error shape", async () => {
    const res = await request(app).post("/api/v1/auth/login").send({ email: "not-an-email" });
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, "VALIDATION_ERROR");
  });

  test("401: authentication failure returns the standard error shape", async () => {
    const res = await request(app).get("/api/v1/auth/me");
    assert.equal(res.status, 401);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, "UNAUTHORIZED");
  });

  test("403: authenticated authorization failure returns the standard error shape", async () => {
    // Reuses the real ownership service (403 FORBIDDEN path) rather than a
    // permanent business route, since none exists yet.
    const { getDriverProfileForUser } = await import("../../src/modules/auth/ownership.service");
    const { AppError } = await import("../../src/shared/errors/app-error");
    await assert.rejects(
      () => getDriverProfileForUser(user.id),
      (error: unknown) => error instanceof AppError && error.statusCode === 403 && error.code === "FORBIDDEN"
    );
  });

  test("404: unknown route returns the standard error shape (not Express's default HTML page)", async () => {
    const res = await request(app).get("/api/v1/this-route-does-not-exist");
    assert.equal(res.status, 404);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, "NOT_FOUND");
  });

  test("500: unexpected error is sanitized (no stack, no internal message) via the real centralized error handler", async () => {
    const errorApp = createErrorTestApp();
    const res = await request(errorApp).get("/boom");

    assert.equal(res.status, 500);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, "INTERNAL_ERROR");
    const serialized = JSON.stringify(res.body);
    assert.doesNotMatch(serialized, /secret\/path/);
    assert.doesNotMatch(serialized, /at Object/); // stack-trace-shaped text
  });
});

describe("Health regression", () => {
  test("GET /api/v1/health still returns 200 with a connected database", async () => {
    const app = createApp();
    const res = await request(app).get("/api/v1/health");

    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, "ok");
    assert.equal(res.body.data.database, "connected");
  });
});
