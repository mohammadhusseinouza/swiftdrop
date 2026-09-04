import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import {
  CreateFailedCollectionReasonSchema,
  FailedCollectionReasonIdParamSchema,
  ListFailedCollectionReasonsQuerySchema,
  UpdateFailedCollectionReasonSchema,
} from "./failed-collection-reason.schema";
import {
  createFailedCollectionReasonController,
  getFailedCollectionReasonController,
  listFailedCollectionReasonsController,
  updateFailedCollectionReasonController,
} from "./failed-collection-reason.controller";

// Mounted at /api/v1/settings/failed-collection-reasons — mirrors the
// failed-delivery-reasons routes exactly. DRIVER lacks settings.read /
// settings.manage, so authorize() denies them here automatically (403).
export const failedCollectionReasonRouter = Router();

failedCollectionReasonRouter.get(
  "/",
  authenticate,
  authorize("settings.read"),
  validate({ query: ListFailedCollectionReasonsQuerySchema }),
  listFailedCollectionReasonsController,
);

failedCollectionReasonRouter.post(
  "/",
  authenticate,
  authorize("settings.manage"),
  validate({ body: CreateFailedCollectionReasonSchema }),
  createFailedCollectionReasonController,
);

failedCollectionReasonRouter.get(
  "/:id",
  authenticate,
  authorize("settings.read"),
  validate({ params: FailedCollectionReasonIdParamSchema }),
  getFailedCollectionReasonController,
);

failedCollectionReasonRouter.patch(
  "/:id",
  authenticate,
  authorize("settings.manage"),
  validate({ params: FailedCollectionReasonIdParamSchema, body: UpdateFailedCollectionReasonSchema }),
  updateFailedCollectionReasonController,
);
