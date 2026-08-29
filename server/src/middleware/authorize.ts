import { NextFunction, Request, Response } from "express";
import { AppError } from "../shared/errors/app-error";

// Reads the permission set authenticate() already loaded from the database
// for this request — no additional query here. Every role (including
// ADMIN) is checked the same way via its role_permissions rows; there is no
// role-name bypass.
export function authorize(permission: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.actor) {
      next(new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" }));
      return;
    }

    if (!req.actor.permissions.includes(permission)) {
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
