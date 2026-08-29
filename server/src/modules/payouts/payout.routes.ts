import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { requireIdempotencyKey } from "../../middleware/idempotency-key";
import { validate } from "../../middleware/validate";
import { CreatePayoutBodySchema, ListPayoutsQuerySchema } from "./payout.schema";
import { createPayoutController, listPayoutsController } from "./payout.controller";

// Mounted at /api/v1/payouts (see src/routes/index.ts). Management/Finance
// only — no Customer Portal self-service routes exist here (later phase,
// customer.payouts.read_own).
export const payoutRouter = Router();

payoutRouter.get("/", authenticate, authorize("payouts.read"), validate({ query: ListPayoutsQuerySchema }), listPayoutsController);

payoutRouter.post(
  "/",
  authenticate,
  authorize("payouts.create"),
  requireIdempotencyKey,
  validate({ body: CreatePayoutBodySchema }),
  createPayoutController
);
