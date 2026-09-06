import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { requirePortal } from "../../middleware/require-portal";
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
import { listDriverFailedDeliveryReasonsController } from "../reference-data/failed-delivery-reason.controller";

// Mounted at /api/v1/driver/me (see src/routes/index.ts) — a deliberately
// separate namespace from the Management /api/v1/orders routes, per
// docs/implementation_plan.md Phase 7.1:
//   GET /api/v1/driver/me/orders
//   GET /api/v1/driver/me/orders/:id
//
// PORTAL HARDENING (Phase 12.1 correction, CLAUDE.md §72/§8): these routes
// previously relied on getDriverProfileForUser() throwing a 403 for an
// account with no `drivers` row as an INDIRECT portal-family guard — that
// worked for Management/Customer accounts today but was an ownership check
// doing a portal check's job. Guard order is now identical to the Phase
// 11.17.3 parcel-collection Driver routes: authenticate -> requirePortal
// ("driver") -> authorize(perm) -> (controller) own-resource lookup. Portal
// denial happens BEFORE any profile/DB lookup. Business behavior for an
// actual DRIVER account is unchanged.
export const driverOrderRouter = Router();

driverOrderRouter.get(
  "/orders",
  authenticate,
  requirePortal("driver"),
  authorize("driver.orders.read_own"),
  validate({ query: ListDriverOrdersQuerySchema }),
  listDriverOrdersController
);

driverOrderRouter.get(
  "/orders/:id",
  authenticate,
  requirePortal("driver"),
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
  requirePortal("driver"),
  authorize("driver.orders.update_own"),
  validate({ params: DriverOrderIdParamSchema }),
  pickupDriverOrderController
);

// POST /api/v1/driver/orders/:id/start-delivery (Phase 7.3)
driverOrderActionRouter.post(
  "/orders/:id/start-delivery",
  authenticate,
  requirePortal("driver"),
  authorize("driver.orders.update_own"),
  validate({ params: DriverOrderIdParamSchema }),
  startDeliveryDriverOrderController
);

// POST /api/v1/driver/orders/:id/fail (Phase 7.4)
driverOrderActionRouter.post(
  "/orders/:id/fail",
  authenticate,
  requirePortal("driver"),
  authorize("driver.orders.update_own"),
  validate({ params: DriverOrderIdParamSchema, body: FailDeliveryOrderSchema }),
  failDriverOrderController
);

// POST /api/v1/driver/orders/:id/deliver (Phase 7.5)
driverOrderActionRouter.post(
  "/orders/:id/deliver",
  authenticate,
  requirePortal("driver"),
  authorize("driver.orders.update_own"),
  validate({ params: DriverOrderIdParamSchema, body: DeliverOrderSchema }),
  deliverDriverOrderController
);

// GET /api/v1/driver/failed-delivery-reasons (Phase 12.4) — resolves the
// Phase 12.1/12.2/12.3 documented blocker: a narrow Driver-safe active
// Failed Delivery Reasons list, authorized by driver.orders.read_own
// (NEVER settings.read). Mirrors the existing
// GET /api/v1/driver/failed-collection-reasons route exactly (Phase 11.17.3).
driverOrderActionRouter.get(
  "/failed-delivery-reasons",
  authenticate,
  requirePortal("driver"),
  authorize("driver.orders.read_own"),
  listDriverFailedDeliveryReasonsController
);
