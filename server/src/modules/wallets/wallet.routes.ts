import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import {
  ListWalletsQuerySchema,
  ListWalletTransactionsQuerySchema,
  WalletCustomerIdParamSchema,
  WalletCustomerSummariesQuerySchema,
} from "./wallet.schema";
import { AdjustWalletBodySchema } from "./wallet-correction.schema";
import {
  getWalletCustomerSummariesController,
  getWalletDetailController,
  listWalletsController,
  listWalletTransactionsController,
} from "./wallet.controller";
import { adjustWalletController } from "./wallet-correction.controller";

// Mounted at /api/v1/wallets (see src/routes/index.ts). Management/Finance
// only — no Customer Portal own-scope routes exist here (Phase 13).
export const walletRouter = Router();

walletRouter.get("/", authenticate, authorize("wallets.read"), validate({ query: ListWalletsQuerySchema }), listWalletsController);

// MUST be registered before "/:customerId" — a literal path segment that the
// dynamic route would otherwise capture (and reject as a non-UUID).
walletRouter.get(
  "/customer-summaries",
  authenticate,
  authorize("wallets.read"),
  validate({ query: WalletCustomerSummariesQuerySchema }),
  getWalletCustomerSummariesController
);

walletRouter.get(
  "/:customerId",
  authenticate,
  authorize("wallets.read"),
  validate({ params: WalletCustomerIdParamSchema }),
  getWalletDetailController
);

walletRouter.get(
  "/:customerId/transactions",
  authenticate,
  authorize("wallets.read"),
  validate({ params: WalletCustomerIdParamSchema, query: ListWalletTransactionsQuerySchema }),
  listWalletTransactionsController
);

// Phase 8.8 — authorized manual correction, deliberately gated by
// wallets.adjust (not wallets.read) and never exposed to Driver/Customer
// self-service.
walletRouter.post(
  "/:customerId/adjust",
  authenticate,
  authorize("wallets.adjust"),
  validate({ params: WalletCustomerIdParamSchema, body: AdjustWalletBodySchema }),
  adjustWalletController
);
