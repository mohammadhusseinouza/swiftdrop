import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { requireRole } from "../../middleware/require-role";
import { requireIdempotencyKey } from "../../middleware/idempotency-key";
import { validate } from "../../middleware/validate";
import {
  approvePolicyController,
  approveResolutionController,
  getPolicyController,
  getResolutionController,
  getSummaryController,
  listPoliciesController,
  listResolutionsController,
  proposePolicyController,
  proposeResolutionController,
  recordLiabilityController,
  rejectPolicyController,
  rejectResolutionController,
  reviewLiabilityController,
  revokePolicyController,
  revokeResolutionController,
  withdrawPolicyController,
  withdrawResolutionController,
} from "./historical-ownership.controller";
import {
  ApprovePolicySchema,
  ApproveResolutionSchema,
  IdParamsSchema,
  ListQuerySchema,
  ProposeLiabilityPolicySchema,
  ProposeResolutionSchema,
  ReasonedSchema,
  RecordLiabilitySchema,
  ReviewLiabilitySchema,
} from "./historical-ownership.schema";

// Mounted at /api/v1/finance/historical-ownership (FR.12A.11).
//
// By ROLE code, never by permission (finance.* permissions are grantable to
// DISPATCHER): reads ADMIN + FINANCE; propose / withdraw / revoke ADMIN;
// approve / reject / record / review FINANCE — no Admin fallback. The
// services additionally enforce separation of duties (D8) and need
// HISTORICAL_OWNERSHIP_RESOLUTION_ENABLED=true; every write needs an
// Idempotency-Key header. Never exposed to the Driver Portal, Customer
// Portal or Public Tracking.
export const historicalOwnershipRouter = Router();

historicalOwnershipRouter.use(authenticate);

const readers = requireRole("ADMIN", "FINANCE");
const admin = requireRole("ADMIN");
const finance = requireRole("FINANCE");
const byId = validate({ params: IdParamsSchema });
const write = (role: typeof admin, body: NonNullable<Parameters<typeof validate>[0]["body"]>) => [
  role,
  requireIdempotencyKey,
  validate({ params: IdParamsSchema, body }),
];

historicalOwnershipRouter.get("/summary", readers, getSummaryController);
historicalOwnershipRouter.get("/policies", readers, listPoliciesController);
historicalOwnershipRouter.get("/policies/:id", readers, byId, getPolicyController);
historicalOwnershipRouter.get("/resolutions", readers, validate({ query: ListQuerySchema }), listResolutionsController);
historicalOwnershipRouter.get("/resolutions/:id", readers, byId, getResolutionController);

historicalOwnershipRouter.post("/policies", admin, requireIdempotencyKey, validate({ body: ProposeLiabilityPolicySchema }), proposePolicyController);
historicalOwnershipRouter.post("/policies/:id/approve", ...write(finance, ApprovePolicySchema), approvePolicyController);
historicalOwnershipRouter.post("/policies/:id/reject", ...write(finance, ReasonedSchema), rejectPolicyController);
historicalOwnershipRouter.post("/policies/:id/withdraw", ...write(admin, ReasonedSchema), withdrawPolicyController);
historicalOwnershipRouter.post("/policies/:id/revoke", ...write(admin, ReasonedSchema), revokePolicyController);

historicalOwnershipRouter.post("/resolutions", admin, requireIdempotencyKey, validate({ body: ProposeResolutionSchema }), proposeResolutionController);
historicalOwnershipRouter.post("/resolutions/:id/approve", ...write(finance, ApproveResolutionSchema), approveResolutionController);
historicalOwnershipRouter.post("/resolutions/:id/reject", ...write(finance, ReasonedSchema), rejectResolutionController);
historicalOwnershipRouter.post("/resolutions/:id/withdraw", ...write(admin, ReasonedSchema), withdrawResolutionController);
historicalOwnershipRouter.post("/resolutions/:id/revoke", ...write(admin, ReasonedSchema), revokeResolutionController);
historicalOwnershipRouter.post("/resolutions/:id/record-liability", ...write(finance, RecordLiabilitySchema), recordLiabilityController);

historicalOwnershipRouter.post("/liabilities/:id/reviews", ...write(finance, ReviewLiabilitySchema), reviewLiabilityController);
