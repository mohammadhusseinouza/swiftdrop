import { Router } from "express";
import { prisma } from "../db/prisma";
import { AppError } from "../shared/errors/app-error";
import { authRouter } from "../modules/auth/auth.routes";
import { auditRouter } from "../modules/audit/audit-read.routes";
import { customerRouter } from "../modules/customers/customer.routes";
import { dashboardRouter } from "../modules/dashboard/dashboard.routes";
import { driverRouter } from "../modules/drivers/driver.routes";
import { driverCashRouter } from "../modules/driver-cash/driver-cash.routes";
import { driverOrderActionRouter, driverOrderRouter } from "../modules/driver-orders/driver-order.routes";
import { employeeRouter } from "../modules/employees/employee.routes";
import {
  driverParcelCollectionRouter,
  parcelCollectionOrderRouter,
} from "../modules/parcel-collection/parcel-collection.routes";
import { financeRouter } from "../modules/finance/finance.routes";
import { orderRouter } from "../modules/orders/order.routes";
import { payoutRouter } from "../modules/payouts/payout.routes";
import { referenceDataRouter } from "../modules/reference-data/reference-data.routes";
import { reportRouter } from "../modules/reports/report.routes";
import { settingRouter } from "../modules/settings/setting.routes";
import { settlementRouter } from "../modules/settlements/settlement.routes";
import { customerTrackingRouter, publicTrackingRouter } from "../modules/tracking/tracking.routes";
import { walletRouter } from "../modules/wallets/wallet.routes";
import { walletTransactionRouter } from "../modules/wallets/wallet-transaction.routes";

export const apiRouter = Router();

apiRouter.use("/auth", authRouter);
// Audit Search (Phase 9.4, audit.read only — independently gated from
// dashboard.read/reports.read/finance.read, all of which are intentionally
// insufficient for audit history).
apiRouter.use("/audit-logs", auditRouter);
apiRouter.use("/customers", customerRouter);
// Management Dashboard (Phase 9.1, Management/Finance/Dispatcher only —
// dashboard.read; detailed finance figures additionally require
// finance.read, enforced inside the service layer).
apiRouter.use("/dashboard", dashboardRouter);
apiRouter.use("/drivers", driverRouter);
// Employee Management (Phase 11.14, Admin-only via employees.read /
// employees.manage) — User + Employee + management-role assignment.
apiRouter.use("/employees", employeeRouter);
// Driver Portal (own-scope, read-only in Phase 7.1) — a separate namespace
// from the Management /drivers CRUD routes above.
apiRouter.use("/driver/me", driverOrderRouter);
// Driver Cash (Phase 8.1, own-scope, read-only) — GET /api/v1/driver/me/cash.
apiRouter.use("/driver/me", driverCashRouter);
// Driver Portal action routes (Phase 7.2+) — POST /api/v1/driver/orders/:id/pickup
// per docs/implementation_plan.md, deliberately without the /me/ segment.
apiRouter.use("/driver", driverOrderActionRouter);
// Phase 11.17.3 — Parcel Collection (Driver own-job actions + Driver-safe
// active Failed Collection Reasons list). Mounted at /api/v1/driver like the
// existing Driver action routes.
apiRouter.use("/driver", driverParcelCollectionRouter);
apiRouter.use("/orders", orderRouter);
// Phase 11.17.3 — Parcel Collection Management read + assign/reassign/
// reschedule/receive-at-company. A second router on /api/v1/orders,
// following the same /orders/:id/<action> convention as orderRouter.
apiRouter.use("/orders", parcelCollectionOrderRouter);
apiRouter.use("/settings", referenceDataRouter);
apiRouter.use("/system-settings", settingRouter);
// Customer Wallet Ledger Foundation (Phase 8.2, Management/Finance only).
apiRouter.use("/wallets", walletRouter);
// Customer Payouts (Phase 8.5, Management/Finance only).
apiRouter.use("/payouts", payoutRouter);
// Driver Settlements (Phase 8.6, Management/Finance only).
apiRouter.use("/driver-settlements", settlementRouter);
// Wallet transaction corrections (Phase 8.8) — POST /wallet-transactions/:id/reverse.
apiRouter.use("/wallet-transactions", walletTransactionRouter);
// Driver Cash / Company Finance adjustments + reversals (Phase 8.8, Management/Finance only).
apiRouter.use("/finance", financeRouter);
// Reports (Phase 9.3, reports.read — Management/Dispatcher/Finance).
apiRouter.use("/reports", reportRouter);
// Phase 11.17.6 — Customer/Public tracking BACKEND CONTRACTS ONLY (no
// Customer Portal / Public Tracking UI yet). Own-scope, customer.orders.
// read_own — matches the existing "/driver/me" own-scope namespace pattern.
apiRouter.use("/customer/me", customerTrackingRouter);
// UNAUTHENTICATED public route (requirements.md §36) — deliberately mounted
// directly on apiRouter, not nested under any authenticated namespace.
apiRouter.use("/track", publicTrackingRouter);

apiRouter.get("/health", async (_req, res, next) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    res.json({
      success: true,
      data: {
        status: "ok",
        database: "connected",
        environment: process.env.NODE_ENV ?? "development",
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("[health] database check failed:", error);
    next(
      new AppError({
        statusCode: 503,
        code: "SERVICE_UNAVAILABLE",
        message: "Database connectivity check failed",
      })
    );
  }
});
