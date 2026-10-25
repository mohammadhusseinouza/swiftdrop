import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { requireRole } from "../../middleware/require-role";
import { requireIdempotencyKey } from "../../middleware/idempotency-key";
import { validate } from "../../middleware/validate";
import {
  approveController,
  getIncidentController,
  getReconciliationController,
  getSummaryController,
  listIncidentsController,
  listReconciliationsController,
  proposeController,
  rejectController,
  revokeController,
  withdrawController,
} from "./historical-reconciliation.controller";
import {
  ApproveHistoricalReconciliationSchema,
  ListHistoricalReconciliationsQuerySchema,
  ListIncidentsQuerySchema,
  ProposeHistoricalReconciliationSchema,
  ReasonedDecisionSchema,
  ReconciliationIdParamsSchema,
} from "./historical-reconciliation.schema";

// Mounted at /api/v1/finance/historical-reconciliations (FR.12A.5).
//
// By ROLE code, never by permission (finance.* permissions are grantable to
// DISPATCHER from the Settings role matrix): reads ADMIN + FINANCE; propose /
// withdraw / revoke ADMIN; approve / reject FINANCE — no Admin fallback.
// Writes also need DRIVER_CASH_HISTORICAL_RECONCILIATION_ENABLED=true (the
// service refuses otherwise) and an Idempotency-Key header. Never exposed to
// the Driver Portal, Customer Portal or Public Tracking.
export const historicalReconciliationRouter = Router();

historicalReconciliationRouter.use(authenticate);

const readers = requireRole("ADMIN", "FINANCE");
const byId = validate({ params: ReconciliationIdParamsSchema });

historicalReconciliationRouter.get("/summary", readers, getSummaryController);
historicalReconciliationRouter.get("/incidents", readers, validate({ query: ListIncidentsQuerySchema }), listIncidentsController);
historicalReconciliationRouter.get("/incidents/:id", readers, byId, getIncidentController);
historicalReconciliationRouter.get("/", readers, validate({ query: ListHistoricalReconciliationsQuerySchema }), listReconciliationsController);
historicalReconciliationRouter.get("/:id", readers, byId, getReconciliationController);

historicalReconciliationRouter.post(
  "/",
  requireRole("ADMIN"),
  requireIdempotencyKey,
  validate({ body: ProposeHistoricalReconciliationSchema }),
  proposeController
);
historicalReconciliationRouter.post(
  "/:id/approve",
  requireRole("FINANCE"),
  requireIdempotencyKey,
  validate({ params: ReconciliationIdParamsSchema, body: ApproveHistoricalReconciliationSchema }),
  approveController
);
historicalReconciliationRouter.post(
  "/:id/reject",
  requireRole("FINANCE"),
  requireIdempotencyKey,
  validate({ params: ReconciliationIdParamsSchema, body: ReasonedDecisionSchema }),
  rejectController
);
historicalReconciliationRouter.post(
  "/:id/withdraw",
  requireRole("ADMIN"),
  requireIdempotencyKey,
  validate({ params: ReconciliationIdParamsSchema, body: ReasonedDecisionSchema }),
  withdrawController
);
historicalReconciliationRouter.post(
  "/:id/revoke",
  requireRole("ADMIN"),
  requireIdempotencyKey,
  validate({ params: ReconciliationIdParamsSchema, body: ReasonedDecisionSchema }),
  revokeController
);
