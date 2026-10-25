import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { requireIdempotencyKey } from "../../middleware/idempotency-key";
import { validate } from "../../middleware/validate";
import {
  CreateSettlementBodySchema,
  ListSettlementsQuerySchema,
  ReverseSettlementBodySchema,
  SettlementIdParamSchema,
  SettlementShortfallBodySchema,
} from "./settlement.schema";
import {
  createSettlementController,
  getSettlementDetailController,
  listSettlementsController,
  recordSettlementShortfallController,
  reverseSettlementController,
} from "./settlement.controller";

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

// FR.7 — settlement detail.
settlementRouter.get("/:id", authenticate, authorize("settlements.read"), validate({ params: SettlementIdParamSchema }), getSettlementDetailController);

settlementRouter.post(
  "/",
  authenticate,
  authorize("settlements.create"),
  requireIdempotencyKey,
  validate({ body: CreateSettlementBodySchema }),
  createSettlementController
);

// FR.6 — settlement corrections. Financial corrections, so gated by
// finance.adjust (like every other correction endpoint), not settlements.*.
settlementRouter.post(
  "/:id/reverse",
  authenticate,
  authorize("finance.adjust"),
  requireIdempotencyKey,
  validate({ params: SettlementIdParamSchema, body: ReverseSettlementBodySchema }),
  reverseSettlementController
);

settlementRouter.post(
  "/:id/shortfall",
  authenticate,
  authorize("finance.adjust"),
  requireIdempotencyKey,
  validate({ params: SettlementIdParamSchema, body: SettlementShortfallBodySchema }),
  recordSettlementShortfallController
);
