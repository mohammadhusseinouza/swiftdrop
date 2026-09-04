import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import {
  createEmployee,
  getEmployeeById,
  getManagementRoleOptions,
  listEmployees,
  updateEmployee,
} from "./employee.service";
import type { CreateEmployeeInput, ListEmployeesQuery, UpdateEmployeeInput } from "./employee.schema";
import type { EmployeeDetail, EmployeeRoleOption, EmployeeSummary } from "./employee.types";
import type { ApiListResponse, ApiSuccessResponse } from "../../shared/types/api-response";

export const listEmployeesController: RequestHandler<Record<string, never>, ApiListResponse<EmployeeSummary>> = async (
  req,
  res,
  next
) => {
  try {
    const query = req.query as unknown as ListEmployeesQuery;
    const { items, total } = await listEmployees(query);
    const totalPages = Math.ceil(total / query.limit);
    res.json({ success: true, data: items, meta: { page: query.page, limit: query.limit, total, totalPages } });
  } catch (error) {
    next(error);
  }
};

export const getEmployeeRolesController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<EmployeeRoleOption[]>
> = async (_req, res, next) => {
  try {
    const roles = await getManagementRoleOptions();
    res.json({ success: true, data: roles });
  } catch (error) {
    next(error);
  }
};

export const getEmployeeController: RequestHandler<{ id: string }, ApiSuccessResponse<EmployeeDetail>> = async (
  req,
  res,
  next
) => {
  try {
    const employee = await getEmployeeById(req.params.id);
    res.json({ success: true, data: employee });
  } catch (error) {
    next(error);
  }
};

export const createEmployeeController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<EmployeeDetail>,
  CreateEmployeeInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const employee = await createEmployee(req.body, req.actor.userId);
    res.status(201).json({ success: true, data: employee });
  } catch (error) {
    next(error);
  }
};

export const updateEmployeeController: RequestHandler<
  { id: string },
  ApiSuccessResponse<EmployeeDetail>,
  UpdateEmployeeInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const employee = await updateEmployee(req.params.id, req.body, req.actor.userId);
    res.json({ success: true, data: employee });
  } catch (error) {
    next(error);
  }
};
