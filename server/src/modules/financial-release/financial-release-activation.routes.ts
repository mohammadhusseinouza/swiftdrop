import { Router } from "express";
import { z } from "zod";
import {
  LATENCY_PROBE_DEFAULT_SAMPLES,
  LATENCY_PROBE_MAX_SAMPLES,
  LATENCY_PROBE_MIN_SAMPLES,
} from "./financial-release-activation.service";
import { authenticate } from "../../middleware/authenticate";
import { requireRole } from "../../middleware/require-role";
import { validate } from "../../middleware/validate";
import {
  activateController,
  deactivateController,
  getActivationReadinessController,
  getActivationStateController,
  latencyProbeController,
} from "./financial-release-activation.controller";

// Mounted at /api/v1/admin/financial-release. ADMINISTRATORS ONLY, by role
// code (decision A7) — settings.manage is grantable to non-Admin roles, so a
// permission cannot express this. The actions take no input.
export const financialReleaseActivationRouter = Router();

const NoBodySchema = z.object({}).strict();
const LatencyProbeQuerySchema = z
  .object({
    samples: z.coerce.number().int().min(LATENCY_PROBE_MIN_SAMPLES).max(LATENCY_PROBE_MAX_SAMPLES).default(LATENCY_PROBE_DEFAULT_SAMPLES),
  })
  .strict();

financialReleaseActivationRouter.use(authenticate, requireRole("ADMIN"));

financialReleaseActivationRouter.get("/", getActivationStateController);
financialReleaseActivationRouter.get("/readiness", getActivationReadinessController);
// FR.11B — read-only database round-trip measurement (SELECT 1 only).
financialReleaseActivationRouter.get("/latency-probe", validate({ query: LatencyProbeQuerySchema }), latencyProbeController);
financialReleaseActivationRouter.post("/activate", validate({ body: NoBodySchema }), activateController);
financialReleaseActivationRouter.post("/deactivate", validate({ body: NoBodySchema }), deactivateController);
