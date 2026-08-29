import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { generateRefreshToken, hashRefreshToken } from "../../src/modules/auth/auth.utils";
import { cleanupTestUser, createTestUser, loginTestUser, type TestUser } from "../helpers/fixtures";

describe("POST /api/v1/auth/refresh", () => {
  let app: Express;
  let user: TestUser;

  before(async () => {
    app = createApp();
    user = await createTestUser("DISPATCHER");
  });

  after(async () => {
    await cleanupTestUser(user.id);
  });

  test("valid refresh returns a new access token, rotates the cookie, and old/new tokens behave correctly", async () => {
    const login = await loginTestUser(app, user.email, user.password);
    const originalCookie = login.refreshCookie as string;
    assert.ok(originalCookie);

    const refreshRes = await request(app).post("/api/v1/auth/refresh").set("Cookie", `refresh_token=${originalCookie}`);

    assert.equal(refreshRes.status, 200);
    assert.equal(typeof refreshRes.body.data.accessToken, "string");
    // A fresh access token is always issued, but JWT `iat`/`exp` claims are
    // second-precision — if login and refresh land in the same second, the
    // reissued token can be byte-identical to the original. That is
    // expected, not a bug, so assert validity/subject rather than
    // inequality (avoids a flaky, timing-dependent assertion).
    const decoded = jwt.verify(refreshRes.body.data.accessToken, process.env.AUTH_ACCESS_TOKEN_SECRET as string, {
      algorithms: ["HS256"],
    }) as jwt.JwtPayload;
    assert.equal(decoded.sub, user.id);

    const setCookie = refreshRes.headers["set-cookie"] as unknown as string[];
    const rotatedCookieHeader = setCookie.find((c) => c.startsWith("refresh_token="));
    assert.ok(rotatedCookieHeader);
    const rotatedCookie = rotatedCookieHeader.split(";")[0].split("=")[1];
    assert.notEqual(rotatedCookie, originalCookie, "refresh cookie must rotate to a new value");

    // old refresh token becomes unusable
    const oldTokenReuse = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", `refresh_token=${originalCookie}`);
    assert.equal(oldTokenReuse.status, 401);
    assert.equal(oldTokenReuse.body.error.code, "UNAUTHORIZED");

    // new refresh token remains usable
    const newTokenWorks = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", `refresh_token=${rotatedCookie}`);
    assert.equal(newTokenWorks.status, 200);
    assert.equal(typeof newTokenWorks.body.data.accessToken, "string");
  });

  test("missing refresh cookie -> generic 401", async () => {
    const res = await request(app).post("/api/v1/auth/refresh");
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "UNAUTHORIZED");
  });

  test("random/unknown refresh token -> generic 401 (same shape as missing)", async () => {
    const missing = await request(app).post("/api/v1/auth/refresh");
    const unknown = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", `refresh_token=${generateRefreshToken()}`);

    assert.equal(unknown.status, 401);
    assert.deepEqual(unknown.body, missing.body);
  });

  test("expired session -> generic 401", async () => {
    const rawToken = generateRefreshToken();
    await prisma.auth_sessions.create({
      data: {
        user_id: user.id,
        refresh_token_hash: hashRefreshToken(rawToken),
        expires_at: new Date(Date.now() - 1000), // already expired
      },
    });

    const res = await request(app).post("/api/v1/auth/refresh").set("Cookie", `refresh_token=${rawToken}`);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "UNAUTHORIZED");
  });

  test("revoked session -> generic 401", async () => {
    const rawToken = generateRefreshToken();
    await prisma.auth_sessions.create({
      data: {
        user_id: user.id,
        refresh_token_hash: hashRefreshToken(rawToken),
        expires_at: new Date(Date.now() + 60_000),
        revoked_at: new Date(),
      },
    });

    const res = await request(app).post("/api/v1/auth/refresh").set("Cookie", `refresh_token=${rawToken}`);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "UNAUTHORIZED");
  });

  test("inactive user cannot refresh, and its presented session is revoked as a result", async () => {
    const inactiveTestUser = await createTestUser("DISPATCHER", { isActive: false });
    try {
      const rawToken = generateRefreshToken();
      const session = await prisma.auth_sessions.create({
        data: {
          user_id: inactiveTestUser.id,
          refresh_token_hash: hashRefreshToken(rawToken),
          expires_at: new Date(Date.now() + 60_000),
        },
      });

      const res = await request(app).post("/api/v1/auth/refresh").set("Cookie", `refresh_token=${rawToken}`);
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, "UNAUTHORIZED");

      const reloaded = await prisma.auth_sessions.findUniqueOrThrow({ where: { id: session.id } });
      assert.ok(reloaded.revoked_at !== null, "the presented session must be revoked even though refresh failed");
    } finally {
      await cleanupTestUser(inactiveTestUser.id);
    }
  });

  test("raw refresh token is never stored in the database; stored hash is a 64-character digest", async () => {
    const login = await loginTestUser(app, user.email, user.password);
    const rawToken = login.refreshCookie as string;

    const session = await prisma.auth_sessions.findFirst({
      where: { refresh_token_hash: hashRefreshToken(rawToken) },
    });
    assert.ok(session, "expected a session row matching this login's token hash");
    assert.equal(session!.refresh_token_hash.length, 64);
    assert.notEqual(session!.refresh_token_hash, rawToken);
    assert.equal(session!.refresh_token_hash, hashRefreshToken(rawToken));
  });

  test("raw refresh token and its hash never appear in any API response body", async () => {
    const login = await loginTestUser(app, user.email, user.password);
    const rawToken = login.refreshCookie as string;
    const hash = hashRefreshToken(rawToken);

    const refreshRes = await request(app).post("/api/v1/auth/refresh").set("Cookie", `refresh_token=${rawToken}`);
    const serialized = JSON.stringify(refreshRes.body);

    assert.ok(!serialized.includes(rawToken));
    assert.ok(!serialized.includes(hash));
    assert.doesNotMatch(serialized, /refresh_token_hash/i);
  });
});

describe("POST /api/v1/auth/refresh — concurrency", () => {
  let app: Express;
  let user: TestUser;

  before(async () => {
    app = createApp();
    user = await createTestUser("DISPATCHER");
  });

  after(async () => {
    await cleanupTestUser(user.id);
  });

  test("exactly one of two simultaneous requests using the same refresh credential succeeds", async () => {
    const login = await loginTestUser(app, user.email, user.password);
    const cookie = `refresh_token=${login.refreshCookie}`;

    const [resA, resB] = await Promise.all([
      request(app).post("/api/v1/auth/refresh").set("Cookie", cookie),
      request(app).post("/api/v1/auth/refresh").set("Cookie", cookie),
    ]);

    const statuses = [resA.status, resB.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 401], "exactly one request must succeed and exactly one must fail");

    const winner = resA.status === 200 ? resA : resB;
    assert.equal(typeof winner.body.data.accessToken, "string");

    // Exactly one active session must remain for this user after the race —
    // the old credential consumed exactly once, exactly one replacement issued.
    const activeSessions = await prisma.auth_sessions.count({
      where: { user_id: user.id, revoked_at: null },
    });
    assert.equal(activeSessions, 1);
  });
});
