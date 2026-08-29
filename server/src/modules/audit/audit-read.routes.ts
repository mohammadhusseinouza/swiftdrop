import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { ListAuditLogsQuerySchema } from "./audit-read.schema";
import { listAuditLogsController } from "./audit-read.controller";

// Mounted at /api/v1/audit-logs (Phase 9.4). audit.read only — deliberately
// NOT dashboard.read/reports.read/finance.read: audit history is more
// sensitive than Dashboard/Reports/Finance and is independently permission-
// gated (none of those three grant it, and none should). Search-only — no
// POST/PATCH/DELETE. Audit history is append-only evidence written
// exclusively by src/shared/audit/audit.service.ts's createAuditLog, always
// from inside the transaction it documents; this router never writes.
export const auditRouter = Router();

auditRouter.get("/", authenticate, authorize("audit.read"), validate({ query: ListAuditLogsQuerySchema }), listAuditLogsController);
