import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { SettingKeyParamSchema, UpdateSettingSchema } from "./setting.schema";
import { getSettingController, listSettingsController, updateSettingController } from "./setting.controller";

// Mounted at /api/v1/system-settings — deliberately NOT nested under
// /api/v1/settings/:key. docs/implementation_plan.md already reserves
// /api/v1/settings/areas, /api/v1/settings/payment-methods, and
// /api/v1/settings/failed-delivery-reasons as concrete sub-resources; a
// generic /api/v1/settings/:key route would collide with those paths if a
// future setting key were ever literally "areas", "payment-methods", or
// "failed-delivery-reasons". Using the table's own name avoids that
// collision entirely without relying on Express route-registration order.
export const settingRouter = Router();

settingRouter.get("/", authenticate, authorize("settings.read"), listSettingsController);

settingRouter.get(
  "/:key",
  authenticate,
  authorize("settings.read"),
  validate({ params: SettingKeyParamSchema }),
  getSettingController
);

settingRouter.patch(
  "/:key",
  authenticate,
  authorize("settings.manage"),
  validate({ params: SettingKeyParamSchema, body: UpdateSettingSchema }),
  updateSettingController
);
