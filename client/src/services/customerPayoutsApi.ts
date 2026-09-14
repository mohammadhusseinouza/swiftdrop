import { api } from './api';
import { unwrapList } from './unwrap';
import { cleanParams } from './queryParams';
import type { ApiListResponse, Paginated, PaginationParams } from './apiTypes';
import type { CustomerPayoutSummary } from './domain.types';

export type ListCustomerPayoutsParams = PaginationParams;

/**
 * Customer Portal — Payout History (Phase 13.6). Backend:
 * GET /api/v1/customer/me/payouts — self-scoped (Customer resolved from the
 * authenticated identity, never a client id), read-only, server-paginated,
 * newest-first. Reads the customer_payouts business record (distinct from
 * the wallet-debit ledger row at /customer/transactions).
 *
 * Injected into the ONE shared `api` slice. No second `createApi`, no Redux
 * slice mirroring this server data. Read-only phase — `providesTags` only,
 * no cross-domain invalidation.
 */
export const customerPayoutsApi = api.injectEndpoints({
  endpoints: (builder) => ({
    getCustomerPayouts: builder.query<
      Paginated<CustomerPayoutSummary>,
      ListCustomerPayoutsParams | void
    >({
      query: (params) => ({
        url: '/customer/me/payouts',
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (r: ApiListResponse<CustomerPayoutSummary>) =>
        unwrapList(r),
      providesTags: [{ type: 'CustomerPayout', id: 'LIST' }],
    }),
  }),
});

export const { useGetCustomerPayoutsQuery } = customerPayoutsApi;
