import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { ReverseWalletTransactionBodySchema, WalletTransactionIdParamSchema } from "./wallet-correction.schema";
import { reverseWalletTransactionController } from "./wallet-correction.controller";

// Mounted at /api/v1/wallet-transactions (Phase 8.8) — deliberately a
// separate top-level namespace from /api/v1/wallets, since a reversal
// targets a specific ledger transaction, not a Customer.
export const walletTransactionRouter = Router();

walletTransactionRouter.post(
  "/:transactionId/reverse",
  authenticate,
  authorize("wallets.adjust"),
  validate({ params: WalletTransactionIdParamSchema, body: ReverseWalletTransactionBodySchema }),
  reverseWalletTransactionController
);
