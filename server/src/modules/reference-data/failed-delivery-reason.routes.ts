import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import {
  CreateFailedDeliveryReasonSchema,
  FailedDeliveryReasonIdParamSchema,
  ListFailedDeliveryReasonsQuerySchema,
  UpdateFailedDeliveryReasonSchema,
} from "./failed-delivery-reason.schema";
import {
  createFailedDeliveryReasonController,
  getFailedDeliveryReasonController,
  listFailedDeliveryReasonsController,
  updateFailedDeliveryReasonController,
} from "./failed-delivery-reason.controller";

export const failedDeliveryReasonRouter = Router();

failedDeliveryReasonRouter.get(
  "/",
  authenticate,
  authorize("settings.read"),
  validate({ query: ListFailedDeliveryReasonsQuerySchema }),
  listFailedDeliveryReasonsController
);

failedDeliveryReasonRouter.post(
  "/",
  authenticate,
  authorize("settings.manage"),
  validate({ body: CreateFailedDeliveryReasonSchema }),
  createFailedDeliveryReasonController
);

failedDeliveryReasonRouter.get(
  "/:id",
  authenticate,
  authorize("settings.read"),
  validate({ params: FailedDeliveryReasonIdParamSchema }),
  getFailedDeliveryReasonController
);

failedDeliveryReasonRouter.patch(
  "/:id",
  authenticate,
  authorize("settings.manage"),
  validate({ params: FailedDeliveryReasonIdParamSchema, body: UpdateFailedDeliveryReasonSchema }),
  updateFailedDeliveryReasonController
);
