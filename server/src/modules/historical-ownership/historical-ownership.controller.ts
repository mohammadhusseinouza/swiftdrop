import { Request, RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import {
  approveLiabilityPolicy,
  approveOwnershipResolution,
  proposeLiabilityPolicy,
  proposeOwnershipResolution,
  recordHistoricalLiability,
  rejectLiabilityPolicy,
  rejectOwnershipResolution,
  reviewHistoricalLiability,
  revokeLiabilityPolicy,
  revokeOwnershipResolution,
  withdrawLiabilityPolicy,
  withdrawOwnershipResolution,
  type WorkflowActor,
} from "./historical-ownership-workflow.service";
import {
  getHistoricalOwnershipSummary,
  getLiabilityPolicy,
  getOwnershipResolutionDetail,
  listLiabilityPolicies,
  listOwnershipResolutions,
} from "./historical-ownership-read.service";
import type { ListQuery, ProposeLiabilityPolicyInput, ProposeResolutionInput } from "./historical-ownership.schema";

// Thin controllers. Each write returns the full detail, built AFTER the
// workflow transaction committed (never inside it).

function actorOf(req: Request): WorkflowActor {
  if (!req.actor) throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
  return { userId: req.actor.userId, roleCode: req.actor.role.code };
}

const idOf = (req: Request) => req.params.id as string;
const keyOf = (req: Request) => req.idempotencyKey as string;

function handler(run: (req: Request) => Promise<{ status?: number; data: unknown; meta?: unknown }>): RequestHandler {
  return async (req, res, next) => {
    try {
      const { status, data, meta } = await run(req);
      res.status(status ?? 200).json(meta === undefined ? { success: true, data } : { success: true, data, meta });
    } catch (error) {
      next(error);
    }
  };
}

export const getSummaryController = handler(async () => ({ data: await getHistoricalOwnershipSummary() }));
export const listPoliciesController = handler(async () => ({ data: await listLiabilityPolicies() }));
export const getPolicyController = handler(async (req) => ({ data: await getLiabilityPolicy(idOf(req)) }));
export const listResolutionsController = handler(async (req) => listOwnershipResolutions(req.query as unknown as ListQuery));
export const getResolutionController = handler(async (req) => ({ data: await getOwnershipResolutionDetail(idOf(req)) }));

export const proposePolicyController = handler(async (req) => {
  const id = await proposeLiabilityPolicy(req.body as ProposeLiabilityPolicyInput, actorOf(req), keyOf(req));
  return { status: 201, data: await getLiabilityPolicy(id) };
});

type PolicyRun<B> = (id: string, body: B, actor: WorkflowActor, key: string) => Promise<{ policyId: string }>;
const policyDecision = <B>(run: PolicyRun<B>) =>
  handler(async (req) => {
    const { policyId } = await run(idOf(req), req.body as B, actorOf(req), keyOf(req));
    return { data: await getLiabilityPolicy(policyId) };
  });

export const approvePolicyController = policyDecision(approveLiabilityPolicy);
export const rejectPolicyController = policyDecision(rejectLiabilityPolicy);
export const withdrawPolicyController = policyDecision(withdrawLiabilityPolicy);
export const revokePolicyController = policyDecision(revokeLiabilityPolicy);

export const proposeResolutionController = handler(async (req) => {
  const id = await proposeOwnershipResolution(req.body as ProposeResolutionInput, actorOf(req), keyOf(req));
  return { status: 201, data: await getOwnershipResolutionDetail(id) };
});

type ResolutionRun<B> = (id: string, body: B, actor: WorkflowActor, key: string) => Promise<{ resolutionId: string }>;
const resolutionAction = <B>(run: ResolutionRun<B>) =>
  handler(async (req) => {
    const { resolutionId } = await run(idOf(req), req.body as B, actorOf(req), keyOf(req));
    return { data: await getOwnershipResolutionDetail(resolutionId) };
  });

export const approveResolutionController = resolutionAction(approveOwnershipResolution);
export const rejectResolutionController = resolutionAction(rejectOwnershipResolution);
export const withdrawResolutionController = resolutionAction(withdrawOwnershipResolution);
export const revokeResolutionController = resolutionAction(revokeOwnershipResolution);
export const recordLiabilityController = resolutionAction(recordHistoricalLiability);
export const reviewLiabilityController = resolutionAction(reviewHistoricalLiability);
