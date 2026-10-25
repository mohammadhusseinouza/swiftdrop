import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { requireIdempotencyKey } from "../../middleware/idempotency-key";
import {
  AdjustCompanyBodySchema,
  AdjustDriverCashBodySchema,
  CompanyTransactionIdParamSchema,
  DriverCashTransactionIdParamSchema,
  DriverIdParamSchema,
  ReleaseCorrectionBodySchema,
  ReleaseIdParamSchema,
  ReverseCompanyTransactionBodySchema,
  ReverseDriverCashTransactionBodySchema,
} from "./finance-correction.schema";
import {
  adjustCompanyController,
  adjustDriverCashController,
  reverseCompanyTransactionController,
  reverseDriverCashTransactionController,
  reverseReleaseController,
  voidReleaseCollectionController,
} from "./finance-correction.controller";
import { FinanceSummaryQuerySchema, FinanceTransactionsQuerySchema } from "./finance-read.schema";
import { getFinanceSummaryController, getFinanceTransactionsController, getFinancialReleaseReconciliationController } from "./finance-read.controller";
import {
  DriverCashDriverIdParamSchema,
  DriverCashSummariesQuerySchema,
  DriverCashTransactionsQuerySchema,
  OutstandingCollectionsQuerySchema,
} from "./driver-cash-read.schema";
import {
  getDriverCashDetailController,
  getDriverOutstandingCollectionsController,
  getDriverCashSummariesController,
  getDriverCashTotalsController,
  getDriverCashTransactionsController,
} from "./driver-cash-read.controller";

// Mounted at /api/v1/finance. Management/Finance only — never exposed to
// Driver/Customer self-service. Phase 8.8's correction (adjust/reverse)
// mutations and Phase 9.2's read-only summary/transactions endpoints share
// this one router rather than a second competing /finance router.
export const financeRouter = Router();

// Phase 9.2 — read-only, finance.read (not dashboard.read/reports.read/
// wallets.read — finance.read is the specific permission for this module).
// FR.8 — read-only R1–R14 reconciliation of settlement-based release
// (contract §11). finance.read only — never Dispatcher / Driver / Customer.
financeRouter.get("/reconciliation/financial-release", authenticate, authorize("finance.read"), getFinancialReleaseReconciliationController);

financeRouter.get(
  "/summary",
  authenticate,
  authorize("finance.read"),
  validate({ query: FinanceSummaryQuerySchema }),
  getFinanceSummaryController
);

financeRouter.get(
  "/transactions",
  authenticate,
  authorize("finance.read"),
  validate({ query: FinanceTransactionsQuerySchema }),
  getFinanceTransactionsController
);

// ============================================================
// Management-safe Driver Cash READ contract (Phase 11.7 correction) — all
// finance.read (ADMIN + FINANCE; DISPATCHER -> 403). The static
// /driver-cash/summaries route is declared BEFORE the dynamic
// /driver-cash/:driverId route so "summaries" is never parsed as a driverId.
// ============================================================
financeRouter.get(
  "/driver-cash/summaries",
  authenticate,
  authorize("finance.read"),
  validate({ query: DriverCashSummariesQuerySchema }),
  getDriverCashSummariesController
);

// System-wide Cash Held across ALL drivers (Management Drivers page). Same
// finance.read gate; also static, so declared before /driver-cash/:driverId.
financeRouter.get("/driver-cash/totals", authenticate, authorize("finance.read"), getDriverCashTotalsController);

financeRouter.get(
  "/driver-cash/:driverId",
  authenticate,
  authorize("finance.read"),
  validate({ params: DriverCashDriverIdParamSchema }),
  getDriverCashDetailController
);

// FR.7 — outstanding settlement-mode collections + attributed / unattributed cash.
financeRouter.get(
  "/driver-cash/:driverId/outstanding-collections",
  authenticate,
  authorize("finance.read"),
  validate({ params: DriverCashDriverIdParamSchema, query: OutstandingCollectionsQuerySchema }),
  getDriverOutstandingCollectionsController
);

financeRouter.get(
  "/driver-cash/:driverId/transactions",
  authenticate,
  authorize("finance.read"),
  validate({ params: DriverCashDriverIdParamSchema, query: DriverCashTransactionsQuerySchema }),
  getDriverCashTransactionsController
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

// FR.6 — dedicated corrections for settlement-mode financial releases
// (contract §8). The generic reverse endpoints above refuse release-linked
// rows (USE_RELEASE_CORRECTION). Idempotency-Key is required like every
// correction endpoint; the deterministic keys release-void:<id> /
// release-reversal:<id> are what make a retry safe.
financeRouter.post(
  "/order-releases/:releaseId/void-collection",
  authenticate,
  authorize("finance.adjust"),
  requireIdempotencyKey,
  validate({ params: ReleaseIdParamSchema, body: ReleaseCorrectionBodySchema }),
  voidReleaseCollectionController
);

financeRouter.post(
  "/order-releases/:releaseId/reverse-release",
  authenticate,
  authorize("finance.adjust"),
  requireIdempotencyKey,
  validate({ params: ReleaseIdParamSchema, body: ReleaseCorrectionBodySchema }),
  reverseReleaseController
);
