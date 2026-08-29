import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { AreaIdParamSchema, CreateAreaSchema, ListAreasQuerySchema, UpdateAreaSchema } from "./area.schema";
import { createAreaController, getAreaController, listAreasController, updateAreaController } from "./area.controller";

export const areaRouter = Router();

areaRouter.get(
  "/",
  authenticate,
  authorize("settings.read"),
  validate({ query: ListAreasQuerySchema }),
  listAreasController
);

areaRouter.post(
  "/",
  authenticate,
  authorize("settings.manage"),
  validate({ body: CreateAreaSchema }),
  createAreaController
);

areaRouter.get(
  "/:id",
  authenticate,
  authorize("settings.read"),
  validate({ params: AreaIdParamSchema }),
  getAreaController
);

areaRouter.patch(
  "/:id",
  authenticate,
  authorize("settings.manage"),
  validate({ params: AreaIdParamSchema, body: UpdateAreaSchema }),
  updateAreaController
);
