import { CookieOptions, Request, Response } from "express";

const DEFAULT_REFRESH_COOKIE_NAME = "refresh_token";
// Scoped narrowly to the auth routes that actually need the refresh token.
const REFRESH_COOKIE_PATH = "/api/v1/auth";

export function getRefreshCookieName(): string {
  return process.env.AUTH_REFRESH_COOKIE_NAME || DEFAULT_REFRESH_COOKIE_NAME;
}

function baseCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: REFRESH_COOKIE_PATH,
  };
}

export function setRefreshCookie(res: Response, rawToken: string, expiresAt: Date): void {
  res.cookie(getRefreshCookieName(), rawToken, {
    ...baseCookieOptions(),
    expires: expiresAt,
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(getRefreshCookieName(), baseCookieOptions());
}

export function readRefreshCookie(req: Request): string | undefined {
  const value = req.cookies?.[getRefreshCookieName()];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
