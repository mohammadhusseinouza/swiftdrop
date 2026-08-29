import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import {
  AdjustCompanyBodySchema,
  AdjustDriverCashBodySchema,
  CompanyTransactionIdParamSchema,
  DriverCashTransactionIdParamSchema,
  DriverIdParamSchema,
  ReverseCompanyTransactionBodySchema,
  ReverseDriverCashTransactionBodySchema,
} from "./finance-correction.schema";
import {
  adjustCompanyController,
  adjustDriverCashController,
  reverseCompanyTransactionController,
  reverseDriverCashTransactionController,
} from "./finance-correction.controller";
import { FinanceDateRangeQuerySchema, FinanceTransactionsQuerySchema } from "./finance-read.schema";
import { getFinanceSummaryController, getFinanceTransactionsController } from "./finance-read.controller";

// Mounted at /api/v1/finance. Management/Finance only — never exposed to
// Driver/Customer self-service. Phase 8.8's correction (adjust/reverse)
// mutations and Phase 9.2's read-only summary/transactions endpoints share
// this one router rather than a second competing /finance router.
export const financeRouter = Router();

// Phase 9.2 — read-only, finance.read (not dashboard.read/reports.read/
// wallets.read — finance.read is the specific permission for this module).
financeRouter.get(
  "/summary",
  authenticate,
  authorize("finance.read"),
  validate({ query: FinanceDateRangeQuerySchema }),
  getFinanceSummaryController
);

financeRouter.get(
  "/transactions",
  authenticate,
  authorize("finance.read"),
  validate({ query: FinanceTransactionsQuerySchema }),
  getFinanceTransactionsController
);

financeRouter.post(
  "/driver-cash/:driverId/adjust",
  authenticate,
  authorize("finance.adjust"),
  validate({ params: DriverIdParamSchema, body: AdjustDriverCashBodySchema }),
  adjustDriverCashController
);

financeRouter.post(
  "/driver-cash-transactions/:transactionId/reverse",
  authenticate,
  authorize("finance.adjust"),
  validate({ params: DriverCashTransactionIdParamSchema, body: ReverseDriverCashTransactionBodySchema }),
  reverseDriverCashTransactionController
);

financeRouter.post(
  "/company/adjust",
  authenticate,
  authorize("finance.adjust"),
  validate({ body: AdjustCompanyBodySchema }),
  adjustCompanyController
);

financeRouter.post(
  "/company-transactions/:transactionId/reverse",
  authenticate,
  authorize("finance.adjust"),
  validate({ params: CompanyTransactionIdParamSchema, body: ReverseCompanyTransactionBodySchema }),
  reverseCompanyTransactionController
);
