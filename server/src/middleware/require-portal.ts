import { NextFunction, Request, Response } from "express";
import { AppError } from "../shared/errors/app-error";

// ============================================================
// Portal-family guard (Phase 11.17.3 correction).
//
// PORTAL ISOLATION is decided by the authenticated ROLE CODE, never by
// permissions — because ADMIN holds every V1 permission, including
// `driver.*.read_own` / `driver.*.update_own` / `customer.*.read_own`. A
// permission-only guard would therefore wrongly admit an Admin into the
// Driver / Customer portals. This mirrors the frontend rule in
// client/src/features/auth/portal.ts, and the backend enforces it here.
//
// Order on a route: authenticate -> requirePortal(family) -> authorize(perm)
// -> (controller) ownership / IDOR. Portal denial happens BEFORE any
// own-resource lookup, so a Management user gets a clean 403 rather than a
// misleading "no driver profile" 403 from getDriverProfileForUser.
//
// NOTE (reported to review): the pre-existing Phase 7 Driver routes
// (/api/v1/driver/me/*, /api/v1/driver/orders/:id/{pickup,...}) and the
// Phase 8.1 /api/v1/driver/me/cash route do NOT use this middleware — they
// rely on the controller's getDriverProfileForUser() throwing 403 for an
// account with no `drivers` row. That works today (Management/Customer
// accounts have no drivers row) but is an ownership check doing a portal
// check's job, and it does not protect a pure-list Driver endpoint. Those
// routes are intentionally left unchanged here (out of Phase 11.17.3
// scope); applying this middleware to them is a small, safe follow-up.
// ============================================================

const MANAGEMENT_ROLE_CODES = new Set(["ADMIN", "DISPATCHER", "FINANCE"]);

export type PortalFamily = "management" | "driver" | "customer";

function portalFamilyForRole(roleCode: string): PortalFamily | null {
  if (MANAGEMENT_ROLE_CODES.has(roleCode)) return "management";
  if (roleCode === "DRIVER") return "driver";
  if (roleCode === "CUSTOMER") return "customer";
  return null;
}

export function requirePortal(family: PortalFamily) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.actor) {
      next(new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" }));
      return;
    }
    if (portalFamilyForRole(req.actor.role.code) !== family) {
      next(
        new AppError({
          statusCode: 403,
          code: "FORBIDDEN",
          message: "You do not have permission to perform this action",
        }),
      );
      return;
    }
    next();
  };
}
