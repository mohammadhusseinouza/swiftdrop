import { api } from './api';
import { unwrapData } from './unwrap';
import type { ApiSuccessResponse } from './apiTypes';
import type { CustomerDashboardSummary } from './domain.types';

/**
 * Customer Portal — Dashboard (Phase 13.1). Backend:
 * GET /api/v1/customer/me/dashboard — self-scoped (Customer resolved from the
 * authenticated identity, never a client-supplied id), read-only, no params.
 *
 * Injected into the ONE shared `api` slice — no second `createApi`, no Redux
 * slice mirroring this server data.
 */
export const customerDashboardApi = api.injectEndpoints({
  endpoints: (builder) => ({
    getCustomerDashboard: builder.query<CustomerDashboardSummary, void>({
      query: () => ({ url: '/customer/me/dashboard' }),
      transformResponse: (r: ApiSuccessResponse<CustomerDashboardSummary>) =>
        unwrapData(r),
      // Wallet / order mutations that change these figures are all
      // Management-side; the Customer Dashboard re-fetches authoritative state
      // on normal entry / refetch rather than via broad cross-domain
      // invalidation (task §37).
      providesTags: [{ type: 'CustomerDashboard', id: 'ME' }],
    }),
  }),
});

export const { useGetCustomerDashboardQuery } = customerDashboardApi;
