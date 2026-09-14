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
  CustomerWalletSummary,
  CustomerWalletTransactionFilter,
  CustomerWalletTransactionSummary,
} from './domain.types';

export interface ListCustomerWalletTransactionsParams extends PaginationParams {
  type?: CustomerWalletTransactionFilter;
}

/**
 * Customer Portal — Wallet summary (Phase 13.4). Backend:
 * GET /api/v1/customer/me/wallet — self-scoped (Customer from the
 * authenticated identity, never a client id), read-only, no params.
 * `availableBalance` / `pendingAmount` come from the same authoritative
 * backend helper the Dashboard uses.
 *
 * Injected into the ONE shared `api` slice. No second `createApi`, no Redux
 * slice for this server data.
 */
export const customerWalletApi = api.injectEndpoints({
  endpoints: (builder) => ({
    getCustomerWallet: builder.query<CustomerWalletSummary, void>({
      query: () => ({ url: '/customer/me/wallet' }),
      transformResponse: (r: ApiSuccessResponse<CustomerWalletSummary>) =>
        unwrapData(r),
      providesTags: [{ type: 'CustomerWallet', id: 'ME' }],
    }),

    // GET /api/v1/customer/me/wallet/transactions (Phase 13.5) — the
    // authenticated Customer's own append-only wallet ledger, server-
    // paginated, with an all/order_credit/payout/adjustment/reversal filter.
    getCustomerWalletTransactions: builder.query<
      Paginated<CustomerWalletTransactionSummary>,
      ListCustomerWalletTransactionsParams | void
    >({
      query: (params) => ({
        url: '/customer/me/wallet/transactions',
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (r: ApiListResponse<CustomerWalletTransactionSummary>) =>
        unwrapList(r),
      providesTags: [{ type: 'CustomerWalletTransaction', id: 'LIST' }],
    }),
  }),
});

export const { useGetCustomerWalletQuery, useGetCustomerWalletTransactionsQuery } =
  customerWalletApi;
