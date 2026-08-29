import { Router } from "express";
import { areaRouter } from "./area.routes";
import { paymentMethodRouter } from "./payment-method.routes";
import { failedDeliveryReasonRouter } from "./failed-delivery-reason.routes";

// Mounted at /api/v1/settings, matching the paths documented in
// docs/implementation_plan.md (Phase 5.3): GET /api/v1/settings/areas,
// GET /api/v1/settings/payment-methods, GET /api/v1/settings/failed-delivery-reasons.
export const referenceDataRouter = Router();

referenceDataRouter.use("/areas", areaRouter);
referenceDataRouter.use("/payment-methods", paymentMethodRouter);
referenceDataRouter.use("/failed-delivery-reasons", failedDeliveryReasonRouter);
