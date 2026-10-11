import { NextFunction, Request, Response } from "express";
import { AppError } from "../shared/errors/app-error";

// Restricts a route to specific role codes, read from the trusted actor
// context authenticate() reloaded from the database (never the JWT). Used
// where a requirement is genuinely role-scoped rather than permission-scoped:
// a permission in this project is grantable to DISPATCHER / FINANCE from the
// Settings role matrix, so it cannot express "administrators only". This is a
// stricter gate, not a bypass — it never grants anything authorize() denies.
export function requireRole(...roleCodes: string[]) {
  const allowed = new Set(roleCodes);
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.actor) {
      next(new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" }));
      return;
    }
    if (!allowed.has(req.actor.role.code)) {
      next(
        new AppError({
          statusCode: 403,
          code: "FORBIDDEN",
          message: "You do not have permission to perform this action",
        })
      );
      return;
    }
    next();
  };
}
