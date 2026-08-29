import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { CreateDriverSchema, DriverIdParamSchema, ListDriversQuerySchema, UpdateDriverSchema } from "./driver.schema";
import {
  createDriverController,
  getDriverController,
  listDriversController,
  updateDriverController,
} from "./driver.controller";

export const driverRouter = Router();

driverRouter.get(
  "/",
  authenticate,
  authorize("drivers.read"),
  validate({ query: ListDriversQuerySchema }),
  listDriversController
);

driverRouter.post(
  "/",
  authenticate,
  authorize("drivers.manage"),
  validate({ body: CreateDriverSchema }),
  createDriverController
);

driverRouter.get(
  "/:id",
  authenticate,
  authorize("drivers.read"),
  validate({ params: DriverIdParamSchema }),
  getDriverController
);

driverRouter.patch(
  "/:id",
  authenticate,
  authorize("drivers.manage"),
  validate({ params: DriverIdParamSchema, body: UpdateDriverSchema }),
  updateDriverController
);
