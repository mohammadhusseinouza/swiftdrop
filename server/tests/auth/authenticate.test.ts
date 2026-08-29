import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { cleanupTestUser, createTestUser, loginTestUser, setUserActive, type TestUser } from "../helpers/fixtures";

function signToken(payload: object, secret: string, opts: jwt.SignOptions = {}): string {
  return jwt.sign(payload, secret, { algorithm: "HS256", expiresIn: "15m", ...opts });
}

describe("authenticate middleware (via GET /api/v1/auth/me)", () => {
  let app: Express;
  let user: TestUser;
  let accessToken: string;
  const secret = process.env.AUTH_ACCESS_TOKEN_SECRET as string;

  before(async () => {
    assert.ok(secret, "AUTH_ACCESS_TOKEN_SECRET must be set for this test to run meaningfully");
    app = createApp();
    user = await createTestUser("DISPATCHER");
    const login = await loginTestUser(app, user.email, user.password);
    accessToken = login.accessToken as string;
    assert.ok(accessToken);
  });

  after(async () => {
    await cleanupTestUser(user.id);
  });

  test("valid Bearer token authenticates and attaches a DB-derived actor", async () => {
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${accessToken}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.data.user.id, user.id);
    assert.equal(res.body.data.user.role.code, "DISPATCHER");
    assert.ok(Array.isArray(res.body.data.permissions));
    assert.ok(res.body.data.permissions.length > 0, "DISPATCHER should resolve a non-empty permission set");
  });

  test("missing token -> 401", async () => {
    const res = await request(app).get("/api/v1/auth/me");
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "UNAUTHORIZED");
  });

  test("malformed token -> 401", async () => {
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", "Bearer not.a.jwt");
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "UNAUTHORIZED");
  });

  test("expired token -> 401", async () => {
    const expired = signToken({ sub: user.id }, secret, { expiresIn: -10 });
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${expired}`);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "UNAUTHORIZED");
  });

  test("wrong signature -> 401", async () => {
    const wrongSig = signToken({ sub: user.id }, "a-completely-different-wrong-secret");
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${wrongSig}`);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "UNAUTHORIZED");
  });

  test("unexpected algorithm (alg=none) -> 401", async () => {
    const noneAlg = jwt.sign({ sub: user.id }, "", { algorithm: "none" });
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${noneAlg}`);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "UNAUTHORIZED");
  });

  test("unexpected algorithm (HS384 signed with the real secret) -> 401", async () => {
    const hs384 = jwt.sign({ sub: user.id }, secret, { algorithm: "HS384", expiresIn: "15m" });
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${hs384}`);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "UNAUTHORIZED");
  });

  test("missing sub claim -> 401", async () => {
    const noSub = signToken({}, secret);
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${noSub}`);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "UNAUTHORIZED");
  });

  test("invalid (non-string) sub claim -> 401", async () => {
    const badSub = signToken({ sub: 12345 }, secret);
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${badSub}`);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "UNAUTHORIZED");
  });

  test("deleted/nonexistent user sub -> 401", async () => {
    const nonexistentUserToken = signToken({ sub: "00000000-0000-0000-0000-000000000000" }, secret);
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${nonexistentUserToken}`);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "UNAUTHORIZED");
  });

  test("inactive user with an otherwise-valid, unexpired token -> 401", async () => {
    await setUserActive(user.id, false);
    try {
      const res = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${accessToken}`);
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, "UNAUTHORIZED");
    } finally {
      await setUserActive(user.id, true);
    }
  });

  test("actor never trusts role/permissions forged into a custom JWT payload", async () => {
    // Sign a token whose payload claims an ADMIN role and a fabricated
    // permission list; the DB user is really DISPATCHER. The response must
    // reflect the real DB-derived role/permissions, not the forged claims.
    const forged = signToken(
      { sub: user.id, role: { id: "fake", code: "ADMIN" }, permissions: ["settings.manage", "audit.read"] },
      secret
    );
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${forged}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.data.user.role.code, "DISPATCHER");
    assert.ok(!res.body.data.permissions.includes("settings.manage"), "settings.manage is ADMIN-only");
  });
});
