import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import {
  CreateCustomerSchema,
  CustomerIdParamSchema,
  ListCustomersQuerySchema,
  UpdateCustomerSchema,
} from "./customer.schema";
import {
  createCustomerController,
  getCustomerController,
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

customerRouter.get(
  "/:id",
  authenticate,
  authorize("customers.read"),
  validate({ params: CustomerIdParamSchema }),
  getCustomerController
);

customerRouter.patch(
  "/:id",
  authenticate,
  authorize("customers.update"),
  validate({ params: CustomerIdParamSchema, body: UpdateCustomerSchema }),
  updateCustomerController
);
