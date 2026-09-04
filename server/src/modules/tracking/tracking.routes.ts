import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { requirePortal } from "../../middleware/require-portal";
import { validate } from "../../middleware/validate";
import { OrderIdParamSchema, TrackingCodeParamSchema } from "./tracking.schema";
import { getCustomerOrderTrackingController, getPublicTrackingController } from "./tracking.controller";

// ============================================================
// Phase 11.17.6 — Customer/Public tracking BACKEND CONTRACTS ONLY (task
// §55). No Customer Portal / Public Tracking UI is built in this phase.
// ============================================================

// Mounted at /api/v1/customer/me (see src/routes/index.ts) — matches the
// existing Driver "/driver/me" own-scope namespace convention.
export const customerTrackingRouter = Router();

customerTrackingRouter.get(
  "/orders/:id/tracking",
  authenticate,
  requirePortal("customer"),
  authorize("customer.orders.read_own"),
  validate({ params: OrderIdParamSchema }),
  getCustomerOrderTrackingController
);

// Mounted at /api/v1/track (see src/routes/index.ts) — UNAUTHENTICATED,
// public. requirements.md §36.
export const publicTrackingRouter = Router();

publicTrackingRouter.get(
  "/:trackingCode",
  validate({ params: TrackingCodeParamSchema }),
  getPublicTrackingController
);
