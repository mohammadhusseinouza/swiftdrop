import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import { createDriverCashAdjustment, reverseDriverCashTransaction } from "./driver-cash-correction.service";
import { createCompanyAdjustment, reverseCompanyTransaction } from "./company-correction.service";
import { reverseRelease, voidReleaseCollection } from "../financial-release/financial-release-correction.service";
import type { ReleaseCorrectionEntry } from "../financial-release/financial-release.types";
import type {
  AdjustCompanyInput,
  AdjustDriverCashInput,
  ReleaseCorrectionInput,
  ReverseCompanyTransactionInput,
  ReverseDriverCashTransactionInput,
} from "./finance-correction.schema";
import type { CompanyCorrectionEntry, DriverCashCorrectionEntry } from "./finance-correction.types";
import type { ApiSuccessResponse } from "../../shared/types/api-response";

export const adjustDriverCashController: RequestHandler<
  { driverId: string },
  ApiSuccessResponse<DriverCashCorrectionEntry>,
  AdjustDriverCashInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const transaction = await createDriverCashAdjustment(req.params.driverId, req.body, req.actor.userId);
    res.status(201).json({ success: true, data: transaction });
  } catch (error) {
    next(error);
  }
};

export const reverseDriverCashTransactionController: RequestHandler<
  { transactionId: string },
  ApiSuccessResponse<DriverCashCorrectionEntry>,
  ReverseDriverCashTransactionInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const transaction = await reverseDriverCashTransaction(req.params.transactionId, req.body.reason, req.actor.userId);
    res.status(201).json({ success: true, data: transaction });
  } catch (error) {
    next(error);
  }
};

export const adjustCompanyController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<CompanyCorrectionEntry>,
  AdjustCompanyInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const transaction = await createCompanyAdjustment(req.body, req.actor.userId);
    res.status(201).json({ success: true, data: transaction });
  } catch (error) {
    next(error);
  }
};

export const reverseCompanyTransactionController: RequestHandler<
  { transactionId: string },
  ApiSuccessResponse<CompanyCorrectionEntry>,
  ReverseCompanyTransactionInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const transaction = await reverseCompanyTransaction(req.params.transactionId, req.body.reason, req.actor.userId);
    res.status(201).json({ success: true, data: transaction });
  } catch (error) {
    next(error);
  }
};

// FR.6 — settlement-mode financial release corrections.
export const voidReleaseCollectionController: RequestHandler<
  { releaseId: string },
  ApiSuccessResponse<ReleaseCorrectionEntry>,
  ReleaseCorrectionInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const correction = await voidReleaseCollection(req.params.releaseId, req.body.reason, req.actor.userId);
    res.status(201).json({ success: true, data: correction });
  } catch (error) {
    next(error);
  }
};

export const reverseReleaseController: RequestHandler<
  { releaseId: string },
  ApiSuccessResponse<ReleaseCorrectionEntry>,
  ReleaseCorrectionInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const correction = await reverseRelease(req.params.releaseId, req.body.reason, req.actor.userId);
    res.status(201).json({ success: true, data: correction });
  } catch (error) {
    next(error);
  }
};
