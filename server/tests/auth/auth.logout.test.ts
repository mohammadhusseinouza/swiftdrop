import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { generateRefreshToken, hashRefreshToken } from "../../src/modules/auth/auth.utils";
import { cleanupTestUser, createTestUser, loginTestUser, type TestUser } from "../helpers/fixtures";

describe("POST /api/v1/auth/logout", () => {
  let app: Express;
  let user: TestUser;

  before(async () => {
    app = createApp();
    user = await createTestUser("DISPATCHER");
  });

  after(async () => {
    await cleanupTestUser(user.id);
  });

  test("valid logout succeeds, revokes the server-side session, and clears the cookie", async () => {
    const login = await loginTestUser(app, user.email, user.password);
    const rawToken = login.refreshCookie as string;
    const sessionBefore = await prisma.auth_sessions.findFirstOrThrow({
      where: { refresh_token_hash: hashRefreshToken(rawToken) },
    });
    assert.equal(sessionBefore.revoked_at, null);

    const res = await request(app).post("/api/v1/auth/logout").set("Cookie", `refresh_token=${rawToken}`);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true, data: { loggedOut: true } });

    const setCookie = res.headers["set-cookie"] as unknown as string[];
    const clearHeader = setCookie.find((c) => c.startsWith("refresh_token="));
    assert.ok(clearHeader);
    assert.match(clearHeader, /Expires=Thu, 01 Jan 1970/);

    const sessionAfter = await prisma.auth_sessions.findUniqueOrThrow({ where: { id: sessionBefore.id } });
    assert.ok(sessionAfter.revoked_at !== null, "session must be revoked after logout");
  });

  test("second logout with the already-revoked cookie still succeeds safely", async () => {
    const login = await loginTestUser(app, user.email, user.password);
    const rawToken = login.refreshCookie as string;

    const first = await request(app).post("/api/v1/auth/logout").set("Cookie", `refresh_token=${rawToken}`);
    const second = await request(app).post("/api/v1/auth/logout").set("Cookie", `refresh_token=${rawToken}`);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, { success: true, data: { loggedOut: true } });
  });

  test("logout without any cookie succeeds safely", async () => {
    const res = await request(app).post("/api/v1/auth/logout");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true, data: { loggedOut: true } });
  });

  test("logout with an unknown token returns the same response as a known one (no session-existence leak)", async () => {
    const login = await loginTestUser(app, user.email, user.password);
    const known = await request(app)
      .post("/api/v1/auth/logout")
      .set("Cookie", `refresh_token=${login.refreshCookie}`);
    const unknown = await request(app)
      .post("/api/v1/auth/logout")
      .set("Cookie", `refresh_token=${generateRefreshToken()}`);

    assert.equal(known.status, unknown.status);
    assert.deepEqual(known.body, unknown.body);
  });

  test("a revoked refresh token cannot subsequently be used to refresh", async () => {
    const login = await loginTestUser(app, user.email, user.password);
    const rawToken = login.refreshCookie as string;

    await request(app).post("/api/v1/auth/logout").set("Cookie", `refresh_token=${rawToken}`);

    const refreshAttempt = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", `refresh_token=${rawToken}`);

    assert.equal(refreshAttempt.status, 401);
    assert.equal(refreshAttempt.body.error.code, "UNAUTHORIZED");
  });
});
