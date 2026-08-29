import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { OrderCreateFoundationSchema } from "./order-create.schema";
import {
  AssignOrderSchema,
  BulkAssignOrdersSchema,
  CancelOrderSchema,
  ListOrdersQuerySchema,
  OrderIdParamSchema,
  OrderUpdateSchema,
  ReassignOrderSchema,
  ResolveCollectionDifferenceSchema,
  RescheduleOrderSchema,
} from "./order.schema";
import {
  assignOrderController,
  bulkAssignOrdersController,
  cancelOrderController,
  createOrderController,
  getOrderController,
  getOrderHistoryController,
  listOrdersController,
  reassignOrderController,
  readyOrderController,
  resolveCollectionDifferenceController,
  rescheduleOrderController,
  updateOrderController,
} from "./order.controller";

export const orderRouter = Router();

orderRouter.get(
  "/",
  authenticate,
  authorize("orders.read"),
  validate({ query: ListOrdersQuerySchema }),
  listOrdersController
);

orderRouter.post(
  "/",
  authenticate,
  authorize("orders.create"),
  validate({ body: OrderCreateFoundationSchema }),
  createOrderController
);

orderRouter.get(
  "/:id",
  authenticate,
  authorize("orders.read"),
  validate({ params: OrderIdParamSchema }),
  getOrderController
);

orderRouter.patch(
  "/:id",
  authenticate,
  authorize("orders.update"),
  validate({ params: OrderIdParamSchema, body: OrderUpdateSchema }),
  updateOrderController
);

orderRouter.post(
  "/bulk-assign",
  authenticate,
  authorize("orders.assign"),
  validate({ body: BulkAssignOrdersSchema }),
  bulkAssignOrdersController
);

orderRouter.post(
  "/:id/assign",
  authenticate,
  authorize("orders.assign"),
  validate({ params: OrderIdParamSchema, body: AssignOrderSchema }),
  assignOrderController
);

orderRouter.post(
  "/:id/reassign",
  authenticate,
  authorize("orders.assign"),
  validate({ params: OrderIdParamSchema, body: ReassignOrderSchema }),
  reassignOrderController
);

orderRouter.post(
  "/:id/ready",
  authenticate,
  authorize("orders.change_status"),
  validate({ params: OrderIdParamSchema }),
  readyOrderController
);

orderRouter.post(
  "/:id/reschedule",
  authenticate,
  authorize("orders.change_status"),
  validate({ params: OrderIdParamSchema, body: RescheduleOrderSchema }),
  rescheduleOrderController
);

orderRouter.post(
  "/:id/cancel",
  authenticate,
  authorize("orders.cancel"),
  validate({ params: OrderIdParamSchema, body: CancelOrderSchema }),
  cancelOrderController
);

orderRouter.get(
  "/:id/history",
  authenticate,
  authorize("orders.read"),
  validate({ params: OrderIdParamSchema }),
  getOrderHistoryController
);

// Phase 8.7 — a cross-ledger Finance adjustment/review action (can create
// Customer Wallet liability and/or Company revenue), deliberately gated by
// finance.adjust rather than any orders.* permission.
orderRouter.post(
  "/:id/resolve-collection-difference",
  authenticate,
  authorize("finance.adjust"),
  validate({ params: OrderIdParamSchema, body: ResolveCollectionDifferenceSchema }),
  resolveCollectionDifferenceController
);
