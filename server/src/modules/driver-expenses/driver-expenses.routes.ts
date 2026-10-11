import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { requireRole } from "../../middleware/require-role";
import { validate } from "../../middleware/validate";
import {
  CreateDailyExpenseSchema,
  DailyExpenseIdParamSchema,
  DriverExpenseHistoryQuerySchema,
  DriverIdParamSchema,
  ExpenseDateParamSchema,
  ListDailyExpensesQuerySchema,
  ListExpenseDriversQuerySchema,
  UpdateDailyExpenseSchema,
  UpsertExpenseProfileSchema,
} from "./daily-expense.schema";
import {
  createDailyExpenseController,
  getDailyExpenseController,
  listDailyExpensesController,
  listDailyExpensesForDateController,
  listDriverExpenseHistoryController,
  listExpenseDriversController,
  updateDailyExpenseController,
  upsertExpenseProfileController,
  getDailyTrendController,
  getDriverReportController,
  getReportSummaryController,
  getVehicleReportController,
} from "./daily-expense.controller";
import { DailyTrendQuerySchema, DriverReportQuerySchema, ReportFilterQuerySchema } from "./report.schema";

// Mounted at /api/v1/driver-expenses (fuel settings are a separate router at
// /driver-expenses/fuel-settings). ADMINISTRATORS ONLY, enforced server-side
// on every route. No DELETE routes in V1.
export const driverExpensesRouter = Router();

driverExpensesRouter.use(authenticate, requireRole("ADMIN"));

// ---- drivers + default-vehicle profiles ----
driverExpensesRouter.get("/drivers", validate({ query: ListExpenseDriversQuerySchema }), listExpenseDriversController);

driverExpensesRouter.put(
  "/drivers/:driverId/profile",
  validate({ params: DriverIdParamSchema, body: UpsertExpenseProfileSchema }),
  upsertExpenseProfileController
);

driverExpensesRouter.get(
  "/drivers/:driverId/daily-expenses",
  validate({ params: DriverIdParamSchema, query: DriverExpenseHistoryQuerySchema }),
  listDriverExpenseHistoryController
);

// ---- daily expenses ----
driverExpensesRouter.get("/daily-expenses", validate({ query: ListDailyExpensesQuerySchema }), listDailyExpensesController);

driverExpensesRouter.post("/daily-expenses", validate({ body: CreateDailyExpenseSchema }), createDailyExpenseController);

// Literal segment before "/:id" (which only accepts a UUID).
driverExpensesRouter.get(
  "/daily-expenses/by-date/:date",
  validate({ params: ExpenseDateParamSchema }),
  listDailyExpensesForDateController
);

driverExpensesRouter.get("/daily-expenses/:id", validate({ params: DailyExpenseIdParamSchema }), getDailyExpenseController);

driverExpensesRouter.patch(
  "/daily-expenses/:id",
  validate({ params: DailyExpenseIdParamSchema, body: UpdateDailyExpenseSchema }),
  updateDailyExpenseController
);

// ---- reports (Phase 5): read-only aggregates of the saved daily records ----
driverExpensesRouter.get("/reports/summary", validate({ query: ReportFilterQuerySchema }), getReportSummaryController);
driverExpensesRouter.get("/reports/by-driver", validate({ query: DriverReportQuerySchema }), getDriverReportController);
driverExpensesRouter.get("/reports/by-vehicle", validate({ query: ReportFilterQuerySchema }), getVehicleReportController);
driverExpensesRouter.get("/reports/daily-trend", validate({ query: DailyTrendQuerySchema }), getDailyTrendController);
