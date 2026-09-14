import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { requirePortal } from "../../middleware/require-portal";
import { getCustomerDashboardController } from "./customer-dashboard.controller";

// ============================================================
// Phase 13.1 — Customer Portal Dashboard.
//
// Mounted at /api/v1/customer/me (see src/routes/index.ts) — the same
// own-scope namespace as the existing Customer tracking contract and the
// Driver "/driver/me" routes.
//
// GUARD ORDER: authenticate -> requirePortal("customer") -> authorize(perm)
// -> (controller) self-scoped Customer lookup. requirePortal denies a
// Management/Driver role with a clean 403 BEFORE getCustomerProfileForUser
// runs, so an ADMIN (who holds customer.dashboard.read_own in the full
// permission catalog) never reaches the profile lookup and never sees a
// misleading "no customer profile" message.
//
// PERMISSION: the existing catalog permission customer.dashboard.read_own
// (already assigned to the CUSTOMER role) — no new permission was added
// (catalog stays 35, task §8/§61).
// ============================================================
export const customerDashboardRouter = Router();

customerDashboardRouter.get(
  "/dashboard",
  authenticate,
  requirePortal("customer"),
  authorize("customer.dashboard.read_own"),
  getCustomerDashboardController
);
