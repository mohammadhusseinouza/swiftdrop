import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import type { ApiSuccessResponse } from "../../shared/types/api-response";
import {
  activateFinancialRelease,
  deactivateFinancialRelease,
  getFinancialReleaseActivationState,
  getFinancialReleaseReadiness,
  probeDatabaseLatency,
  type LatencyProbeReport,
  type ActivationChangeResult,
  type FinancialReleaseActivationState,
  type ReadinessReport,
} from "./financial-release-activation.service";

export const getActivationStateController: RequestHandler<Record<string, never>, ApiSuccessResponse<FinancialReleaseActivationState>> = async (
  _req,
  res,
  next
) => {
  try {
    res.json({ success: true, data: await getFinancialReleaseActivationState() });
  } catch (error) {
    next(error);
  }
};

export const getActivationReadinessController: RequestHandler<Record<string, never>, ApiSuccessResponse<ReadinessReport>> = async (
  _req,
  res,
  next
) => {
  try {
    res.json({ success: true, data: await getFinancialReleaseReadiness() });
  } catch (error) {
    next(error);
  }
};

export const activateController: RequestHandler<Record<string, never>, ApiSuccessResponse<ActivationChangeResult>> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    res.json({ success: true, data: await activateFinancialRelease(req.actor.userId) });
  } catch (error) {
    next(error);
  }
};

export const deactivateController: RequestHandler<Record<string, never>, ApiSuccessResponse<ActivationChangeResult>> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    res.json({ success: true, data: await deactivateFinancialRelease(req.actor.userId) });
  } catch (error) {
    next(error);
  }
};

export const latencyProbeController: RequestHandler<Record<string, never>, ApiSuccessResponse<LatencyProbeReport>> = async (req, res, next) => {
  try {
    // validate({ query }) already replaced req.query with the parsed shape.
    const { samples } = req.query as unknown as { samples: number };
    res.json({ success: true, data: await probeDatabaseLatency(samples) });
  } catch (error) {
    next(error);
  }
};
