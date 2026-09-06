import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { requirePortal } from "../../middleware/require-portal";
import { validate } from "../../middleware/validate";
import { DriverJobDetailParamsSchema, ListDriverJobsQuerySchema } from "./driver-job.schema";
import { getDriverJobDetailController, listDriverJobsController } from "./driver-job.controller";

// Mounted at /api/v1/driver (see src/routes/index.ts) — GET /api/v1/driver/jobs
// (Phase 12.1 "My Jobs"). Guard order matches the Phase 11.17.3 Driver
// parcel-collection routes: authenticate -> requirePortal("driver") ->
// authorize(perm) -> (controller) own-Driver scoping. requirePortal denies
// Management/Customer roles with a clean 403 BEFORE any driver-profile
// lookup, so an ADMIN (who holds driver.orders.read_own in the full
// permission catalog) cannot reach this route.
//
// PERMISSION: reuses the existing driver.orders.read_own — it already means
// "read my own current Driver work" and now covers both Collection and
// Delivery jobs. No new permission was added (permission catalog stays 35,
// task §68).
export const driverJobRouter = Router();

driverJobRouter.get(
  "/jobs",
  authenticate,
  requirePortal("driver"),
  authorize("driver.orders.read_own"),
  validate({ query: ListDriverJobsQuerySchema }),
  listDriverJobsController
);

// GET /api/v1/driver/jobs/:jobType/:orderId (Phase 12.2 "Job Detail").
// Identical guard order/permission as the list above — the current-job-only
// scoping and IDOR safety live entirely in driver-job.service.ts.
driverJobRouter.get(
  "/jobs/:jobType/:orderId",
  authenticate,
  requirePortal("driver"),
  authorize("driver.orders.read_own"),
  validate({ params: DriverJobDetailParamsSchema }),
  getDriverJobDetailController
);
