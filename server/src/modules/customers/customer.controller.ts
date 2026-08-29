import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import { createCustomer, getCustomerById, listCustomers, updateCustomer } from "./customer.service";
import type { CreateCustomerInput, ListCustomersQuery, UpdateCustomerInput } from "./customer.schema";
import type { CustomerDetail, CustomerSummary } from "./customer.types";
import type { ApiListResponse, ApiSuccessResponse } from "../../shared/types/api-response";

export const listCustomersController: RequestHandler<
  Record<string, never>,
  ApiListResponse<CustomerSummary>
> = async (req, res, next) => {
  try {
    // validate({ query: ListCustomersQuerySchema }) has already replaced
    // req.query with the parsed/typed/defaulted result by the time this
    // controller runs — Express's own Query generic stays ParsedQs for
    // route-chain compatibility, so this cast reflects that real shape.
    const query = req.query as unknown as ListCustomersQuery;
    const { items, total } = await listCustomers(query);
    const totalPages = Math.ceil(total / query.limit);

    res.json({
      success: true,
      data: items,
      meta: { page: query.page, limit: query.limit, total, totalPages },
    });
  } catch (error) {
    next(error);
  }
};

export const createCustomerController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<CustomerDetail>,
  CreateCustomerInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const customer = await createCustomer(req.body, req.actor.userId);
    res.status(201).json({ success: true, data: customer });
  } catch (error) {
    next(error);
  }
};

export const getCustomerController: RequestHandler<
  { id: string },
  ApiSuccessResponse<CustomerDetail>
> = async (req, res, next) => {
  try {
    const customer = await getCustomerById(req.params.id);
    res.json({ success: true, data: customer });
  } catch (error) {
    next(error);
  }
};

export const updateCustomerController: RequestHandler<
  { id: string },
  ApiSuccessResponse<CustomerDetail>,
  UpdateCustomerInput
> = async (req, res, next) => {
  try {
    const customer = await updateCustomer(req.params.id, req.body);
    res.json({ success: true, data: customer });
  } catch (error) {
    next(error);
  }
};
