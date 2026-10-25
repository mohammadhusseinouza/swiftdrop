import { NextFunction, Request, Response } from "express";
import { Prisma } from "../generated/prisma/client";
import { AppError } from "../shared/errors/app-error";
import type { ApiErrorResponse } from "../shared/types/api-response";

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response<ApiErrorResponse>,
  next: NextFunction
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof AppError) {
    if (!err.isOperational) {
      console.error("[error]", err);
    }

    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
    return;
  }

  if (isMalformedJsonError(err)) {
    res.status(400).json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Malformed JSON in request body",
      },
    });
    return;
  }

  // An interactive transaction that exceeded its timeout (P2028). The client
  // cannot know whether it committed, so the response never claims an
  // outcome: it asks for the SAME request (same Idempotency-Key) to be
  // retried — every financial endpoint replays a committed result instead of
  // applying it twice.
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2028") {
    console.error("[error] transaction timeout (P2028):", err.message);
    res.status(503).json({
      success: false,
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "The operation timed out before it could be confirmed. Retry the same request unchanged — it will not be applied twice.",
        details: { reason: "TRANSACTION_TIMEOUT", retrySameRequest: true },
      },
    });
    return;
  }

  console.error("[error] unhandled:", err);

  res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    },
  });
}

function isMalformedJsonError(err: unknown): boolean {
  return (
    err instanceof SyntaxError &&
    "status" in err &&
    (err as { status?: unknown }).status === 400 &&
    "body" in err
  );
}
