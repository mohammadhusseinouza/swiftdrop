import { Request, RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import {
  approveHistoricalReconciliation,
  proposeHistoricalReconciliation,
  rejectHistoricalReconciliation,
  revokeHistoricalReconciliation,
  withdrawHistoricalReconciliation,
  type WorkflowActor,
} from "./historical-reconciliation-workflow.service";
import {
  getHistoricalReconciliationDetail,
  getHistoricalReconciliationSummary,
  getLedgerIncidentDetail,
  listHistoricalReconciliations,
  listLedgerIncidents,
} from "./historical-reconciliation-read.service";
import type {
  ListHistoricalReconciliationsQuery,
  ListIncidentsQuery,
  ProposeHistoricalReconciliationInput,
} from "./historical-reconciliation.schema";

// Thin controllers. Each write returns the full reconciliation detail, built
// AFTER the workflow transaction committed (never inside it).

function actorOf(req: Request): WorkflowActor {
  if (!req.actor) throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
  return { userId: req.actor.userId, roleCode: req.actor.role.code };
}

const idOf = (req: Request) => req.params.id as string;

export const listReconciliationsController: RequestHandler = async (req, res, next) => {
  try {
    const { data, meta } = await listHistoricalReconciliations(req.query as unknown as ListHistoricalReconciliationsQuery);
    res.json({ success: true, data, meta });
  } catch (error) {
    next(error);
  }
};

export const getReconciliationController: RequestHandler = async (req, res, next) => {
  try {
    res.json({ success: true, data: await getHistoricalReconciliationDetail(idOf(req)) });
  } catch (error) {
    next(error);
  }
};

export const listIncidentsController: RequestHandler = async (req, res, next) => {
  try {
    const { data, meta } = await listLedgerIncidents(req.query as unknown as ListIncidentsQuery);
    res.json({ success: true, data, meta });
  } catch (error) {
    next(error);
  }
};

export const getIncidentController: RequestHandler = async (req, res, next) => {
  try {
    res.json({ success: true, data: await getLedgerIncidentDetail(idOf(req)) });
  } catch (error) {
    next(error);
  }
};

export const getSummaryController: RequestHandler = async (_req, res, next) => {
  try {
    res.json({ success: true, data: await getHistoricalReconciliationSummary() });
  } catch (error) {
    next(error);
  }
};

export const proposeController: RequestHandler = async (req, res, next) => {
  try {
    const id = await proposeHistoricalReconciliation(req.body as ProposeHistoricalReconciliationInput, actorOf(req), req.idempotencyKey as string);
    res.status(201).json({ success: true, data: await getHistoricalReconciliationDetail(id) });
  } catch (error) {
    next(error);
  }
};

type DecisionRun<B> = (id: string, body: B, actor: WorkflowActor, key: string) => Promise<{ reconciliationId: string }>;

function decisionController<B>(run: DecisionRun<B>): RequestHandler {
  return async (req, res, next) => {
    try {
      const result = await run(idOf(req), req.body as B, actorOf(req), req.idempotencyKey as string);
      res.json({ success: true, data: await getHistoricalReconciliationDetail(result.reconciliationId) });
    } catch (error) {
      next(error);
    }
  };
}

export const approveController = decisionController(approveHistoricalReconciliation);
export const rejectController = decisionController(rejectHistoricalReconciliation);
export const withdrawController = decisionController(withdrawHistoricalReconciliation);
export const revokeController = decisionController(revokeHistoricalReconciliation);
