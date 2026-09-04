import { Router } from "express";
import { areaRouter } from "./area.routes";
import { paymentMethodRouter } from "./payment-method.routes";
import { failedDeliveryReasonRouter } from "./failed-delivery-reason.routes";
import { failedCollectionReasonRouter } from "./failed-collection-reason.routes";
import { roleConfigRouter } from "../role-config/role-config.routes";

// Mounted at /api/v1/settings, matching the paths documented in
// docs/implementation_plan.md (Phase 5.3): GET /api/v1/settings/areas,
// GET /api/v1/settings/payment-methods, GET /api/v1/settings/failed-delivery-reasons.
// Phase 11.16 adds /api/v1/settings/roles (Role → Permission configuration),
// deliberately settings-authorized rather than employees-authorized.
export const referenceDataRouter = Router();

referenceDataRouter.use("/areas", areaRouter);
referenceDataRouter.use("/payment-methods", paymentMethodRouter);
referenceDataRouter.use("/failed-delivery-reasons", failedDeliveryReasonRouter);
// Phase 11.17.3 — separate catalog from failed-delivery-reasons, never merged.
referenceDataRouter.use("/failed-collection-reasons", failedCollectionReasonRouter);
referenceDataRouter.use("/roles", roleConfigRouter);
