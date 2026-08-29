import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { getDashboardController } from "./dashboard.controller";

// Mounted at /api/v1/dashboard (Phase 9.1). A single unfiltered read
// summary — no query params by design (date-range filtering is Phase 9.2's
// Finance Summary, not this endpoint). dashboard.read is granted to
// ADMIN/DISPATCHER/FINANCE (never DRIVER/CUSTOMER) — see the live
// permission catalog. Detailed finance figures require the separate
// finance.read permission, enforced inside the service layer (not a second
// route), since dashboard.read alone must still return the operational
// sections with `finance: null`.
export const dashboardRouter = Router();

dashboardRouter.get("/", authenticate, authorize("dashboard.read"), getDashboardController);
