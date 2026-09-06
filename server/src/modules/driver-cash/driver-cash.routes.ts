import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { requirePortal } from "../../middleware/require-portal";
import { validate } from "../../middleware/validate";
import { GetDriverCashQuerySchema } from "./driver-cash.schema";
import { getDriverCashController } from "./driver-cash.controller";

// Mounted at /api/v1/driver/me alongside driverOrderRouter (see
// src/routes/index.ts) — GET /api/v1/driver/me/cash.
//
// PORTAL HARDENING (Phase 12.1 correction, CLAUDE.md §72/§8) — see the
// identical note in driver-order.routes.ts. requirePortal now denies a
// non-DRIVER role BEFORE the getDriverProfileForUser() ownership lookup;
// business behavior for an actual DRIVER account is unchanged.
export const driverCashRouter = Router();

driverCashRouter.get(
  "/cash",
  authenticate,
  requirePortal("driver"),
  authorize("driver.cash.read_own"),
  validate({ query: GetDriverCashQuerySchema }),
  getDriverCashController
);
