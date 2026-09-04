import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { requirePortal } from "../../middleware/require-portal";
import { validate } from "../../middleware/validate";
import { listDriverFailedCollectionReasonsController } from "../reference-data/failed-collection-reason.controller";
import {
  AssignParcelCollectionDriverSchema,
  FailParcelCollectionSchema,
  ParcelCollectionOrderIdParamSchema,
  ReassignParcelCollectionDriverSchema,
} from "./parcel-collection.schema";
import {
  assignParcelCollectionDriverController,
  confirmReceivedAtCompanyController,
  failParcelCollectionController,
  getParcelCollectionController,
  markCollectedFromSenderController,
  reassignParcelCollectionDriverController,
  rescheduleParcelCollectionController,
} from "./parcel-collection.controller";

// ---- Management: mounted at /api/v1/orders (see src/routes/index.ts) ----
// Follows the existing Order action-route conventions
// (POST /api/v1/orders/:id/<action>).
export const parcelCollectionOrderRouter = Router();

parcelCollectionOrderRouter.get(
  "/:id/parcel-collection",
  authenticate,
  authorize("orders.read"),
  validate({ params: ParcelCollectionOrderIdParamSchema }),
  getParcelCollectionController,
);

parcelCollectionOrderRouter.post(
  "/:id/parcel-collection/assign",
  authenticate,
  authorize("orders.assign"),
  validate({ params: ParcelCollectionOrderIdParamSchema, body: AssignParcelCollectionDriverSchema }),
  assignParcelCollectionDriverController,
);

parcelCollectionOrderRouter.post(
  "/:id/parcel-collection/reassign",
  authenticate,
  authorize("orders.assign"),
  validate({ params: ParcelCollectionOrderIdParamSchema, body: ReassignParcelCollectionDriverSchema }),
  reassignParcelCollectionDriverController,
);

parcelCollectionOrderRouter.post(
  "/:id/parcel-collection/reschedule",
  authenticate,
  authorize("orders.change_status"),
  validate({ params: ParcelCollectionOrderIdParamSchema }),
  rescheduleParcelCollectionController,
);

parcelCollectionOrderRouter.post(
  "/:id/parcel-collection/receive-at-company",
  authenticate,
  authorize("orders.change_status"),
  validate({ params: ParcelCollectionOrderIdParamSchema }),
  confirmReceivedAtCompanyController,
);

// ---- Driver own-job: mounted at /api/v1/driver (see src/routes/index.ts) ----
// Matches the existing Driver action-route convention (no /me/ segment),
// e.g. POST /api/v1/driver/orders/:id/pickup.
//
// Guard order: authenticate -> requirePortal("driver") -> authorize(perm)
// -> (controller) own-Driver / IDOR. requirePortal denies Management /
// Customer roles with a clean 403 BEFORE any driver-profile lookup, so an
// ADMIN (who holds driver.* in the full permission catalog) cannot reach
// these routes.
export const driverParcelCollectionRouter = Router();

driverParcelCollectionRouter.post(
  "/orders/:id/parcel-collection/collected",
  authenticate,
  requirePortal("driver"),
  authorize("driver.orders.update_own"),
  validate({ params: ParcelCollectionOrderIdParamSchema }),
  markCollectedFromSenderController,
);

driverParcelCollectionRouter.post(
  "/orders/:id/parcel-collection/failed",
  authenticate,
  requirePortal("driver"),
  authorize("driver.orders.update_own"),
  validate({ params: ParcelCollectionOrderIdParamSchema, body: FailParcelCollectionSchema }),
  failParcelCollectionController,
);

// Narrow Driver-safe active Failed Collection Reasons list.
// GET /api/v1/driver/failed-collection-reasons — DRIVER portal family +
// driver.orders.read_own, NOT settings.read. This route has no own-resource
// lookup, so requirePortal is the only thing that keeps ADMIN out.
driverParcelCollectionRouter.get(
  "/failed-collection-reasons",
  authenticate,
  requirePortal("driver"),
  authorize("driver.orders.read_own"),
  listDriverFailedCollectionReasonsController,
);
