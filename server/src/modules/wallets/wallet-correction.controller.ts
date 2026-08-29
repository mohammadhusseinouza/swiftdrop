import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import { createWalletAdjustment, reverseWalletTransaction } from "./wallet-correction.service";
import type { AdjustWalletInput, ReverseWalletTransactionInput } from "./wallet-correction.schema";
import type { WalletTransactionEntry } from "./wallet.types";
import type { ApiSuccessResponse } from "../../shared/types/api-response";

export const adjustWalletController: RequestHandler<
  { customerId: string },
  ApiSuccessResponse<WalletTransactionEntry>,
  AdjustWalletInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const transaction = await createWalletAdjustment(req.params.customerId, req.body, req.actor.userId);
    res.status(201).json({ success: true, data: transaction });
  } catch (error) {
    next(error);
  }
};

export const reverseWalletTransactionController: RequestHandler<
  { transactionId: string },
  ApiSuccessResponse<WalletTransactionEntry>,
  ReverseWalletTransactionInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const transaction = await reverseWalletTransaction(req.params.transactionId, req.body.reason, req.actor.userId);
    res.status(201).json({ success: true, data: transaction });
  } catch (error) {
    next(error);
  }
};
