import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { requirePortal } from "../../middleware/require-portal";
import { validate } from "../../middleware/validate";
import { ListCustomerPayoutsQuerySchema } from "./customer-payout.schema";
import { listCustomerPayoutsController } from "./customer-payout.controller";

// ============================================================
// Phase 13.6 — Customer Payout History (self-scoped, read-only, paginated).
//
// Mounted at /api/v1/customer/me (see src/routes/index.ts) — the same
// own-scope namespace as the Phase 13.1 Dashboard / 13.2 Orders / 13.4-13.5
// Wallet routes.
//
// GUARD ORDER: authenticate -> requirePortal("customer") -> authorize(perm)
// -> validate(query) -> (controller) self-scoped Customer lookup.
// requirePortal denies a Management/Driver role with a clean 403 BEFORE
// getCustomerProfileForUser runs and BEFORE any customer_payouts /
// payment_methods query — no "no customer profile" message, no Prisma text,
// no payout-existence clue for the wrong portal (task §7).
//
// PERMISSION: the existing catalog permission customer.payouts.read_own
// (already assigned to the CUSTOMER role) — no new permission, catalog stays
// 35 (task §5 / §66). This is deliberately NOT the Management
// GET /api/v1/payouts route (task §4) — that stays payouts.read only.
// ============================================================
export const customerPayoutRouter = Router();

customerPayoutRouter.get(
  "/payouts",
  authenticate,
  requirePortal("customer"),
  authorize("customer.payouts.read_own"),
  validate({ query: ListCustomerPayoutsQuerySchema }),
  listCustomerPayoutsController
);
