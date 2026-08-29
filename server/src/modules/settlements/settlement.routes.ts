import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { requireIdempotencyKey } from "../../middleware/idempotency-key";
import { validate } from "../../middleware/validate";
import { CreateSettlementBodySchema, ListSettlementsQuerySchema } from "./settlement.schema";
import { createSettlementController, listSettlementsController } from "./settlement.controller";

// Mounted at /api/v1/driver-settlements (see src/routes/index.ts).
// Management/Finance only — not to be confused with the Driver's own
// read-only /api/v1/driver/me/cash (Phase 8.1).
export const settlementRouter = Router();

settlementRouter.get(
  "/",
  authenticate,
  authorize("settlements.read"),
  validate({ query: ListSettlementsQuerySchema }),
  listSettlementsController
);

settlementRouter.post(
  "/",
  authenticate,
  authorize("settlements.create"),
  requireIdempotencyKey,
  validate({ body: CreateSettlementBodySchema }),
  createSettlementController
);
