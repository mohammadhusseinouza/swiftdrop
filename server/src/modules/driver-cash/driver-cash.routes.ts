import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { GetDriverCashQuerySchema } from "./driver-cash.schema";
import { getDriverCashController } from "./driver-cash.controller";

// Mounted at /api/v1/driver/me alongside driverOrderRouter (see
// src/routes/index.ts) — GET /api/v1/driver/me/cash.
export const driverCashRouter = Router();

driverCashRouter.get(
  "/cash",
  authenticate,
  authorize("driver.cash.read_own"),
  validate({ query: GetDriverCashQuerySchema }),
  getDriverCashController
);
