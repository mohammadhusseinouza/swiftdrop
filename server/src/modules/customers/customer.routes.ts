import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import {
  CreateCustomerSchema,
  CustomerIdParamSchema,
  ListCustomerReceiversQuerySchema,
  ListCustomersQuerySchema,
  UpdateCustomerSchema,
} from "./customer.schema";
import {
  createCustomerController,
  getCustomerController,
  getCustomerOrderTotalsController,
  listCustomerReceiversController,
  listCustomersController,
  updateCustomerController,
} from "./customer.controller";

export const customerRouter = Router();

customerRouter.get(
  "/",
  authenticate,
  authorize("customers.read"),
  validate({ query: ListCustomersQuerySchema }),
  listCustomersController
);

customerRouter.post(
  "/",
  authenticate,
  authorize("customers.create"),
  validate({ body: CreateCustomerSchema }),
  createCustomerController
);

// MUST be registered before "/:id" — a literal segment the dynamic route
// would otherwise capture (and reject as a non-UUID).
customerRouter.get("/totals", authenticate, authorize("customers.read"), getCustomerOrderTotalsController);

customerRouter.get(
  "/:id",
  authenticate,
  authorize("customers.read"),
  validate({ params: CustomerIdParamSchema }),
  getCustomerController
);

// Customer Receiver Memory autocomplete — see listCustomerReceiversController
// for the additional orders.create / orders.update requirement.
customerRouter.get(
  "/:id/receivers",
  authenticate,
  authorize("customers.read"),
  validate({ params: CustomerIdParamSchema, query: ListCustomerReceiversQuerySchema }),
  listCustomerReceiversController
);

customerRouter.patch(
  "/:id",
  authenticate,
  authorize("customers.update"),
  validate({ params: CustomerIdParamSchema, body: UpdateCustomerSchema }),
  updateCustomerController
);
