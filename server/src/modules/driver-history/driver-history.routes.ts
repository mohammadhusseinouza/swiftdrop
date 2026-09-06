import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { requirePortal } from "../../middleware/require-portal";
import { validate } from "../../middleware/validate";
import { ListDriverHistoryQuerySchema } from "./driver-history.schema";
import { listDriverHistoryController } from "./driver-history.controller";

// Mounted at /api/v1/driver (see src/routes/index.ts) — GET /api/v1/driver/history
// (Phase 12.5 "Completed" + "Failed / Returned").
//
// Guard order matches the Phase 12.1 "My Jobs" route exactly:
// authenticate -> requirePortal("driver") -> authorize(perm) -> (controller)
// own-Driver scoping. requirePortal denies Management/Customer roles with a
// clean 403 BEFORE any driver-profile lookup, so an ADMIN (who holds
// driver.orders.read_own in the full permission catalog) cannot reach this
// route.
//
// PERMISSION: reuses the existing driver.orders.read_own — it already means
// "read my own Driver work" and now covers Collection + Delivery history
// too. No new permission code was added (catalog stays 35, task §79).
export const driverHistoryRouter = Router();

driverHistoryRouter.get(
  "/history",
  authenticate,
  requirePortal("driver"),
  authorize("driver.orders.read_own"),
  validate({ query: ListDriverHistoryQuerySchema }),
  listDriverHistoryController,
);
