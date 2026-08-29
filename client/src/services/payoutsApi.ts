import { api } from './api';
import { cleanParams } from './queryParams';
import { unwrapData, unwrapList } from './unwrap';
import type {
  ApiListResponse,
  ApiSuccessResponse,
  Paginated,
  PaginationParams,
} from './apiTypes';
import type { PayoutSummary } from './domain.types';

/**
 * Customer Payouts (Phase 8.5). Backend: server/src/modules/payouts.
 *
 * LEDGER SEPARATION: a payout changes the Customer Wallet (a debit) and the
 * Company Finance view — it NEVER changes Driver Cash. `DriverCash` and
 * `Settlement` are deliberately absent from the invalidation set.
 *
 * IDEMPOTENCY (Phase 8.9): `POST /payouts` requires an `Idempotency-Key`
 * HTTP header. The mutation takes ONE explicit `idempotencyKey` alongside the
 * body; it is set as the header verbatim and is stable for a single user
 * intent. The `baseQueryWithReauth` retry after a token refresh replays the
 * exact same `FetchArgs`, so the same key is preserved on retry. The UUID is
 * created by the caller (Phase 11.9, when the user confirms a payout) — never
 * regenerated here or in the base query. The key is never cached or logged.
 */

export interface ListPayoutsParams extends PaginationParams {
  search?: string;
  customerId?: string;
  status?: 'COMPLETED' | 'REVERSED' | 'CANCELLED';
  paymentMethodId?: string;
}

export interface CreatePayoutRequest {
  customerId: string;
  amount: string;
  paymentMethodId: string;
  notes?: string;
}

export const payoutsApi = api.injectEndpoints({
  endpoints: (builder) => ({
    getPayouts: builder.query<
      Paginated<PayoutSummary>,
      ListPayoutsParams | void
    >({
      query: (params) => ({
        url: '/payouts',
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (r: ApiListResponse<PayoutSummary>) => unwrapList(r),
      providesTags: [{ type: 'Payout', id: 'LIST' }],
    }),

    createPayout: builder.mutation<
      PayoutSummary,
      { body: CreatePayoutRequest; idempotencyKey: string }
    >({
      query: ({ body, idempotencyKey }) => ({
        url: '/payouts',
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
      transformResponse: (r: ApiSuccessResponse<PayoutSummary>) => unwrapData(r),
      invalidatesTags: (_res, _err, { body }) => [
        { type: 'Payout', id: 'LIST' },
        { type: 'Wallet', id: body.customerId },
        { type: 'Wallet', id: 'LIST' },
        { type: 'WalletTransaction', id: 'LIST' },
        { type: 'Finance', id: 'SUMMARY' },
        { type: 'Finance', id: 'TRANSACTIONS' },
        { type: 'Dashboard', id: 'ROOT' },
        { type: 'Report', id: 'LIST' },
      ],
    }),
  }),
});

export const { useGetPayoutsQuery, useCreatePayoutMutation } = payoutsApi;
