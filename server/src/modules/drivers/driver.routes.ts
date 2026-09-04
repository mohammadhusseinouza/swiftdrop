import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import {
  CreateDriverSchema,
  DriverIdParamSchema,
  DriverWorkListQuerySchema,
  ListDriversQuerySchema,
  UpdateDriverSchema,
} from "./driver.schema";
import {
  createDriverController,
  getDriverController,
  listDriverCurrentOrdersController,
  listDriverDeliveryHistoryController,
  listDriverParcelCollectionHistoryController,
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

// Driver-scoped CURRENT operational work (Phase 11.7 correction). orders.read
// (held by all three Management roles) — this is operational data, not
// financial. Precise ORDER_ACTIVE_STATUSES filter, server-paginated.
driverRouter.get(
  "/:id/current-orders",
  authenticate,
  authorize("orders.read"),
  validate({ params: DriverIdParamSchema, query: DriverWorkListQuerySchema }),
  listDriverCurrentOrdersController
);

// Driver-scoped HISTORICAL delivery work (Phase 11.7 correction) — attributed
// via delivery_attempts.driver_id, server-paginated.
driverRouter.get(
  "/:id/delivery-history",
  authenticate,
  authorize("orders.read"),
  validate({ params: DriverIdParamSchema, query: DriverWorkListQuerySchema }),
  listDriverDeliveryHistoryController
);

// Driver-scoped HISTORICAL Parcel Collection work (Phase 11.17.6, task §27) —
// attributed via parcel_collection_assignments.driver_id, server-paginated.
// drivers.read (NOT finance.read — Parcel Collection is financially neutral;
// NOT orders.read — this is Driver-detail operational history, task §27).
driverRouter.get(
  "/:id/parcel-collection-history",
  authenticate,
  authorize("drivers.read"),
  validate({ params: DriverIdParamSchema, query: DriverWorkListQuerySchema }),
  listDriverParcelCollectionHistoryController
);
