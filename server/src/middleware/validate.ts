import { NextFunction, Request, RequestHandler, Response } from "express";
import { z, ZodError, ZodType } from "zod";
import { AppError } from "../shared/errors/app-error";

interface ValidationSchemas {
  body?: ZodType;
  params?: ZodType;
  query?: ZodType;
}

export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (schemas.params) {
      const result = schemas.params.safeParse(req.params);
      if (!result.success) {
        next(toValidationError("params", result.error));
        return;
      }
      req.params = result.data as typeof req.params;
    }

    if (schemas.query) {
      const result = schemas.query.safeParse(req.query);
      if (!result.success) {
        next(toValidationError("query", result.error));
        return;
      }
      req.query = result.data as typeof req.query;
    }

    if (schemas.body) {
      const result = schemas.body.safeParse(req.body);
      if (!result.success) {
        next(toValidationError("body", result.error));
        return;
      }
      req.body = result.data;
    }

    next();
  };
}

function toValidationError(part: "params" | "query" | "body", error: ZodError): AppError {
  return new AppError({
    statusCode: 400,
    code: "VALIDATION_ERROR",
    message: `Request ${part} validation failed`,
    details: z.treeifyError(error),
  });
}
