import { RequestHandler } from "express";
import { getCurrentUser, login, logout, refreshSession } from "./auth.service";
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from "./auth.cookies";
import { AppError } from "../../shared/errors/app-error";
import type { LoginInput } from "./auth.schema";
import type { LoginResult, UserAccess } from "./auth.types";
import type { RefreshResult } from "./auth.service";
import type { ApiSuccessResponse } from "../../shared/types/api-response";

export const loginController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<LoginResult>,
  LoginInput
> = async (req, res, next) => {
  try {
    const { refreshToken, refreshTokenExpiresAt, ...body } = await login(req.body);
    setRefreshCookie(res, refreshToken, refreshTokenExpiresAt);
    res.json({ success: true, data: body });
  } catch (error) {
    next(error);
  }
};

export const refreshController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<RefreshResult>
> = async (req, res, next) => {
  try {
    const { accessToken, refreshToken, refreshTokenExpiresAt } = await refreshSession(readRefreshCookie(req));
    setRefreshCookie(res, refreshToken, refreshTokenExpiresAt);
    res.json({ success: true, data: { accessToken } });
  } catch (error) {
    next(error);
  }
};

export const logoutController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<{ loggedOut: boolean }>
> = async (req, res, next) => {
  try {
    await logout(readRefreshCookie(req));
    clearRefreshCookie(res);
    res.json({ success: true, data: { loggedOut: true } });
  } catch (error) {
    next(error);
  }
};

export const meController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<UserAccess>
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const result = await getCurrentUser(req.actor.userId);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
