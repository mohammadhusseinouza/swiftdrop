import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import {
  DeliverOrderSchema,
  DriverOrderIdParamSchema,
  FailDeliveryOrderSchema,
  ListDriverOrdersQuerySchema,
} from "./driver-order.schema";
import {
  deliverDriverOrderController,
  failDriverOrderController,
  getDriverOrderController,
  listDriverOrdersController,
  pickupDriverOrderController,
  startDeliveryDriverOrderController,
} from "./driver-order.controller";

// Mounted at /api/v1/driver/me (see src/routes/index.ts) — a deliberately
// separate namespace from the Management /api/v1/orders routes, per
// docs/implementation_plan.md Phase 7.1:
//   GET /api/v1/driver/me/orders
//   GET /api/v1/driver/me/orders/:id
export const driverOrderRouter = Router();

driverOrderRouter.get(
  "/orders",
  authenticate,
  authorize("driver.orders.read_own"),
  validate({ query: ListDriverOrdersQuerySchema }),
  listDriverOrdersController
);

driverOrderRouter.get(
  "/orders/:id",
  authenticate,
  authorize("driver.orders.read_own"),
  validate({ params: DriverOrderIdParamSchema }),
  getDriverOrderController
);

// Mounted at /api/v1/driver (see src/routes/index.ts) — a separate router
// from driverOrderRouter above because docs/implementation_plan.md Phase 7.2
// specifies this action WITHOUT the /me/ segment:
//   POST /api/v1/driver/orders/:id/pickup
export const driverOrderActionRouter = Router();

driverOrderActionRouter.post(
  "/orders/:id/pickup",
  authenticate,
  authorize("driver.orders.update_own"),
  validate({ params: DriverOrderIdParamSchema }),
  pickupDriverOrderController
);

// POST /api/v1/driver/orders/:id/start-delivery (Phase 7.3)
driverOrderActionRouter.post(
  "/orders/:id/start-delivery",
  authenticate,
  authorize("driver.orders.update_own"),
  validate({ params: DriverOrderIdParamSchema }),
  startDeliveryDriverOrderController
);

// POST /api/v1/driver/orders/:id/fail (Phase 7.4)
driverOrderActionRouter.post(
  "/orders/:id/fail",
  authenticate,
  authorize("driver.orders.update_own"),
  validate({ params: DriverOrderIdParamSchema, body: FailDeliveryOrderSchema }),
  failDriverOrderController
);

// POST /api/v1/driver/orders/:id/deliver (Phase 7.5)
driverOrderActionRouter.post(
  "/orders/:id/deliver",
  authenticate,
  authorize("driver.orders.update_own"),
  validate({ params: DriverOrderIdParamSchema, body: DeliverOrderSchema }),
  deliverDriverOrderController
);
