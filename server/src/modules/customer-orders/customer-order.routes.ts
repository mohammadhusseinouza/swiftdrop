import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { requirePortal } from "../../middleware/require-portal";
import { validate } from "../../middleware/validate";
import { CustomerOrderIdParamSchema, ListCustomerOrdersQuerySchema } from "./customer-order.schema";
import { getCustomerOrderDetailController, listCustomerOrdersController } from "./customer-order.controller";

// ============================================================
// Phase 13.2 — Customer "My Orders".
//
// Mounted at /api/v1/customer/me (see src/routes/index.ts) — the same
// own-scope namespace as the Phase 13.1 Dashboard and the Phase 11.17.6
// Customer tracking contract.
//
// GUARD ORDER: authenticate -> requirePortal("customer") -> authorize(perm)
// -> validate(query) -> (controller) self-scoped Customer lookup.
// requirePortal denies a Management/Driver role with a clean 403 BEFORE
// getCustomerProfileForUser runs and BEFORE any Order query.
//
// PERMISSION: the existing catalog permission customer.orders.read_own
// (already assigned to the CUSTOMER role, and already used by the Phase
// 11.17.6 tracking route) — no new permission (catalog stays 35, task §58).
// ============================================================
export const customerOrderRouter = Router();

customerOrderRouter.get(
  "/orders",
  authenticate,
  requirePortal("customer"),
  authorize("customer.orders.read_own"),
  validate({ query: ListCustomerOrdersQuerySchema }),
  listCustomerOrdersController
);

// Phase 13.3 — Customer Order Detail + simplified tracking. Same guard
// chain. Distinct from the Phase 11.17.6 tracking route
// (GET /orders/:id/tracking) which stays as-is; this one returns the safe
// Order snapshot + the SAME "customer" tracking progress in one response.
customerOrderRouter.get(
  "/orders/:id",
  authenticate,
  requirePortal("customer"),
  authorize("customer.orders.read_own"),
  validate({ params: CustomerOrderIdParamSchema }),
  getCustomerOrderDetailController
);
