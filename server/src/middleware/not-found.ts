import { Request, Response } from "express";
import type { ApiErrorResponse } from "../shared/types/api-response";

export function notFound(_req: Request, res: Response<ApiErrorResponse>): void {
  res.status(404).json({
    success: false,
    error: {
      code: "NOT_FOUND",
      message: "Route not found",
    },
  });
}
