import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import {
  CreatePaymentMethodSchema,
  ListPaymentMethodsQuerySchema,
  PaymentMethodIdParamSchema,
  UpdatePaymentMethodSchema,
} from "./payment-method.schema";
import {
  createPaymentMethodController,
  getPaymentMethodController,
  listPaymentMethodsController,
  updatePaymentMethodController,
} from "./payment-method.controller";

export const paymentMethodRouter = Router();

paymentMethodRouter.get(
  "/",
  authenticate,
  authorize("settings.read"),
  validate({ query: ListPaymentMethodsQuerySchema }),
  listPaymentMethodsController
);

paymentMethodRouter.post(
  "/",
  authenticate,
  authorize("settings.manage"),
  validate({ body: CreatePaymentMethodSchema }),
  createPaymentMethodController
);

paymentMethodRouter.get(
  "/:id",
  authenticate,
  authorize("settings.read"),
  validate({ params: PaymentMethodIdParamSchema }),
  getPaymentMethodController
);

paymentMethodRouter.patch(
  "/:id",
  authenticate,
  authorize("settings.manage"),
  validate({ params: PaymentMethodIdParamSchema, body: UpdatePaymentMethodSchema }),
  updatePaymentMethodController
);
