import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import {
  CreateEmployeeSchema,
  EmployeeIdParamSchema,
  ListEmployeesQuerySchema,
  UpdateEmployeeSchema,
} from "./employee.schema";
import {
  createEmployeeController,
  getEmployeeController,
  getEmployeeRolesController,
  listEmployeesController,
  updateEmployeeController,
} from "./employee.controller";

// Mounted at /api/v1/employees (Phase 11.14). Reads require employees.read,
// mutations require employees.manage — the live permission catalog grants
// BOTH only to ADMIN (DISPATCHER/FINANCE/DRIVER/CUSTOMER have neither), which
// is what makes this an Admin-only surface. authorize() checks the actual
// role_permissions every request; there is no role-name bypass.
export const employeeRouter = Router();

// MUST precede "/:id" — a literal segment the dynamic route would otherwise
// try to parse as a UUID.
employeeRouter.get("/roles", authenticate, authorize("employees.read"), getEmployeeRolesController);

employeeRouter.get(
  "/",
  authenticate,
  authorize("employees.read"),
  validate({ query: ListEmployeesQuerySchema }),
  listEmployeesController
);

employeeRouter.post(
  "/",
  authenticate,
  authorize("employees.manage"),
  validate({ body: CreateEmployeeSchema }),
  createEmployeeController
);

employeeRouter.get(
  "/:id",
  authenticate,
  authorize("employees.read"),
  validate({ params: EmployeeIdParamSchema }),
  getEmployeeController
);

employeeRouter.patch(
  "/:id",
  authenticate,
  authorize("employees.manage"),
  validate({ params: EmployeeIdParamSchema, body: UpdateEmployeeSchema }),
  updateEmployeeController
);
