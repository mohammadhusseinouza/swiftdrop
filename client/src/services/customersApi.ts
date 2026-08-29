import { api } from './api';
import { cleanParams } from './queryParams';
import { unwrapData, unwrapList } from './unwrap';
import type {
  ApiListResponse,
  ApiSuccessResponse,
  Paginated,
  PaginationParams,
} from './apiTypes';
import type { CustomerDetail, CustomerSummary } from './domain.types';

/**
 * Customers (Phase 5.1). Backend: server/src/modules/customers.
 * Note: the backend exposes NO `/customers/:id/orders` route — a customer's
 * orders are fetched via `getOrders({ customerId })` in ordersApi.
 *
 * A customer mutation does NOT invalidate Order caches: order receiver data
 * is an immutable snapshot (CLAUDE.md §11), and a customer's name change does
 * not retro-edit historical orders.
 */

export interface ListCustomersParams extends PaginationParams {
  search?: string;
  isActive?: boolean;
  areaId?: string;
  hasPortalAccount?: boolean;
}

export interface CreateCustomerRequest {
  customerNumber: string;
  name: string;
  primaryPhone: string;
  secondaryPhone?: string;
  email?: string;
  defaultAddress?: string;
  defaultAreaId?: string;
  notes?: string;
}

export interface UpdateCustomerRequest {
  name?: string;
  primaryPhone?: string;
  secondaryPhone?: string | null;
  email?: string | null;
  defaultAddress?: string | null;
  defaultAreaId?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

export const customersApi = api.injectEndpoints({
  endpoints: (builder) => ({
    getCustomers: builder.query<
      Paginated<CustomerSummary>,
      ListCustomersParams | void
    >({
      query: (params) => ({
        url: '/customers',
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (r: ApiListResponse<CustomerSummary>) => unwrapList(r),
      providesTags: [{ type: 'Customer', id: 'LIST' }],
    }),

    getCustomer: builder.query<CustomerDetail, string>({
      query: (id) => ({ url: `/customers/${id}` }),
      transformResponse: (r: ApiSuccessResponse<CustomerDetail>) =>
        unwrapData(r),
      providesTags: (_res, _err, id) => [{ type: 'Customer', id }],
    }),

    createCustomer: builder.mutation<CustomerDetail, CreateCustomerRequest>({
      query: (body) => ({ url: '/customers', method: 'POST', body }),
      transformResponse: (r: ApiSuccessResponse<CustomerDetail>) =>
        unwrapData(r),
      invalidatesTags: [{ type: 'Customer', id: 'LIST' }],
    }),

    updateCustomer: builder.mutation<
      CustomerDetail,
      { id: string; body: UpdateCustomerRequest }
    >({
      query: ({ id, body }) => ({
        url: `/customers/${id}`,
        method: 'PATCH',
        body,
      }),
      transformResponse: (r: ApiSuccessResponse<CustomerDetail>) =>
        unwrapData(r),
      invalidatesTags: (_res, _err, { id }) => [
        { type: 'Customer', id },
        { type: 'Customer', id: 'LIST' },
      ],
    }),
  }),
});

export const {
  useGetCustomersQuery,
  useGetCustomerQuery,
  useCreateCustomerMutation,
  useUpdateCustomerMutation,
} = customersApi;
