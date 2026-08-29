import { NextFunction, Request, RequestHandler, Response } from "express";
import { AppError } from "../shared/errors/app-error";

declare module "express-serve-static-core" {
  interface Request {
    idempotencyKey?: string;
  }
}

const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

// Required for financial creation endpoints whose retries must not double-
// execute (payouts, settlements — Phase 8.9). Never required for GET, never
// accepted from the request body (header only), never echoed back to the
// client. The raw value is never persisted — see deriveRequestIdempotencyKey.
export const requireIdempotencyKey: RequestHandler = (req: Request, _res: Response, next: NextFunction): void => {
  const header = req.headers["idempotency-key"];
  if (typeof header !== "string") {
    next(
      new AppError({
        statusCode: 400,
        code: "VALIDATION_ERROR",
        message: Array.isArray(header)
          ? "Idempotency-Key header must be provided exactly once"
          : "Idempotency-Key header is required",
      })
    );
    return;
  }
  const trimmed = header.trim();
  if (trimmed.length === 0) {
    next(new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "Idempotency-Key header must not be empty" }));
    return;
  }
  if (trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    next(
      new AppError({
        statusCode: 400,
        code: "VALIDATION_ERROR",
        message: `Idempotency-Key header must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      })
    );
    return;
  }
  req.idempotencyKey = trimmed;
  next();
};
