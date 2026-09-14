import { api } from './api';
import { unwrapData, unwrapList } from './unwrap';
import { cleanParams } from './queryParams';
import type {
  ApiListResponse,
  ApiSuccessResponse,
  Paginated,
  PaginationParams,
} from './apiTypes';
import type {
  CustomerOrderDetail,
  CustomerOrderSummary,
  CustomerOrderView,
} from './domain.types';

export interface ListCustomerOrdersParams extends PaginationParams {
  view?: CustomerOrderView;
}

/**
 * Customer Portal — My Orders (Phase 13.2). Backend:
 * GET /api/v1/customer/me/orders — self-scoped (Customer resolved from the
 * authenticated identity, never a client id), read-only, server-paginated,
 * with an `all | active | delivered` view filter.
 *
 * Injected into the ONE shared `api` slice. No second `createApi`, no Redux
 * slice mirroring this server data.
 */
export const customerOrdersApi = api.injectEndpoints({
  endpoints: (builder) => ({
    getCustomerOrders: builder.query<
      Paginated<CustomerOrderSummary>,
      ListCustomerOrdersParams | void
    >({
      query: (params) => ({
        url: '/customer/me/orders',
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (r: ApiListResponse<CustomerOrderSummary>) =>
        unwrapList(r),
      // Read-only phase — the figures change only from Management-side
      // mutations; the list re-fetches on normal entry / refetch. No broad
      // cross-domain invalidation (task §36).
      providesTags: [{ type: 'CustomerOrder', id: 'LIST' }],
    }),

    // GET /api/v1/customer/me/orders/:id (Phase 13.3) — Customer Order Detail
    // + embedded Customer-safe tracking progress. ONE request per page: the
    // backend returns the Order snapshot and the tracking timeline together
    // (no separate /tracking call, no per-event fetch).
    getCustomerOrderDetail: builder.query<CustomerOrderDetail, string>({
      query: (id) => ({ url: `/customer/me/orders/${id}` }),
      transformResponse: (r: ApiSuccessResponse<CustomerOrderDetail>) =>
        unwrapData(r),
      providesTags: (_res, _err, id) => [{ type: 'CustomerOrder', id }],
    }),
  }),
});

export const { useGetCustomerOrdersQuery, useGetCustomerOrderDetailQuery } =
  customerOrdersApi;
