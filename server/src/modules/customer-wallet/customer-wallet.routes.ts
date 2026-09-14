import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { requirePortal } from "../../middleware/require-portal";
import { validate } from "../../middleware/validate";
import { ListCustomerWalletTransactionsQuerySchema } from "./customer-wallet.schema";
import {
  getCustomerWalletController,
  listCustomerWalletTransactionsController,
} from "./customer-wallet.controller";

// ============================================================
// Phase 13.4 — Customer Wallet (self-scoped, read-only summary).
//
// Mounted at /api/v1/customer/me (see src/routes/index.ts). GUARD ORDER:
// authenticate -> requirePortal("customer") -> authorize(perm) -> controller
// -> self-scoped lookup. requirePortal denies a Management/Driver role with a
// clean 403 BEFORE getCustomerProfileForUser / the wallet lookup / the
// pending aggregate — no "no customer profile" message, no Prisma text, no
// wallet-existence clue for the wrong portal (task §7).
//
// PERMISSION: the existing catalog permission customer.wallet.read_own
// (already assigned to the CUSTOMER role). No new permission — catalog stays
// 35 (task §5 / §62). This is deliberately NOT any /api/v1/wallets/*
// Management route (task §3).
// ============================================================
export const customerWalletRouter = Router();

customerWalletRouter.get(
  "/wallet",
  authenticate,
  requirePortal("customer"),
  authorize("customer.wallet.read_own"),
  getCustomerWalletController
);

// Phase 13.5 — Customer Wallet Transactions (self-scoped, read-only,
// paginated). Nested under the /wallet resource for consistency with the
// Phase 13.4 summary route and the Management /wallets/:id/transactions
// nesting (task §4). Same guard chain + the same customer.wallet.read_own
// permission (no new permission).
customerWalletRouter.get(
  "/wallet/transactions",
  authenticate,
  requirePortal("customer"),
  authorize("customer.wallet.read_own"),
  validate({ query: ListCustomerWalletTransactionsQuerySchema }),
  listCustomerWalletTransactionsController
);
