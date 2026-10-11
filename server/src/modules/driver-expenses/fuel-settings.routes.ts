import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { requireRole } from "../../middleware/require-role";
import { validate } from "../../middleware/validate";
import {
  CreateFuelSettingsSchema,
  EffectiveFuelSettingsQuerySchema,
  ListFuelSettingsQuerySchema,
} from "./fuel-settings.schema";
import {
  createFuelSettingsController,
  getCurrentFuelSettingsController,
  getEffectiveFuelSettingsController,
  listFuelSettingsController,
} from "./fuel-settings.controller";

// Mounted at /api/v1/driver-expenses/fuel-settings. ADMINISTRATORS ONLY —
// enforced server-side by role code (see middleware/require-role.ts for why
// this is role- rather than permission-based). Append-only: deliberately no
// PATCH / PUT / DELETE routes.
export const fuelSettingsRouter = Router();

fuelSettingsRouter.use(authenticate, requireRole("ADMIN"));

// Literal segments are registered before any future "/:id" route.
fuelSettingsRouter.get("/current", getCurrentFuelSettingsController);

fuelSettingsRouter.get(
  "/effective",
  validate({ query: EffectiveFuelSettingsQuerySchema }),
  getEffectiveFuelSettingsController
);

fuelSettingsRouter.get("/", validate({ query: ListFuelSettingsQuerySchema }), listFuelSettingsController);

fuelSettingsRouter.post("/", validate({ body: CreateFuelSettingsSchema }), createFuelSettingsController);
