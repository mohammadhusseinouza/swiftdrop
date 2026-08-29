import { NextFunction, Request, Response } from "express";
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
