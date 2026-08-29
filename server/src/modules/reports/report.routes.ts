import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { CustomerReportQuerySchema, DriverReportQuerySchema, FinanceReportQuerySchema, OrderReportQuerySchema } from "./report.schema";
import {
  getCustomerReportController,
  getDriverReportController,
  getFinanceReportController,
  getOrderReportController,
} from "./report.controller";

// Mounted at /api/v1/reports (Phase 9.3). All four groups require only
// reports.read (never finance.read/dashboard.read/wallets.read) — the live
// permission catalog grants reports.read to ADMIN/DISPATCHER/FINANCE, never
// DRIVER/CUSTOMER. The Financial Report is deliberately AGGREGATE-ONLY
// (counts/sums, never raw ledger notes) since Dispatcher has reports.read
// but not finance.read — detailed ledger browsing stays behind
// GET /api/v1/finance/transactions (finance.read).
export const reportRouter = Router();

reportRouter.get("/orders", authenticate, authorize("reports.read"), validate({ query: OrderReportQuerySchema }), getOrderReportController);

reportRouter.get("/drivers", authenticate, authorize("reports.read"), validate({ query: DriverReportQuerySchema }), getDriverReportController);

reportRouter.get(
  "/customers",
  authenticate,
  authorize("reports.read"),
  validate({ query: CustomerReportQuerySchema }),
  getCustomerReportController
);

reportRouter.get("/finance", authenticate, authorize("reports.read"), validate({ query: FinanceReportQuerySchema }), getFinanceReportController);
