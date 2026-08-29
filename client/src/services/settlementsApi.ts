import { api } from './api';
import { cleanParams } from './queryParams';
import { unwrapData, unwrapList } from './unwrap';
import type {
  ApiListResponse,
  ApiSuccessResponse,
  Paginated,
  PaginationParams,
} from './apiTypes';
import type { SettlementSummary } from './domain.types';

/**
 * Driver Settlements (Phase 8.6). Backend: server/src/modules/settlements
 * (mounted at /driver-settlements).
 *
 * LEDGER SEPARATION: a settlement reduces Driver Cash and updates the Company
 * Finance view — it NEVER changes the Customer Wallet. `Wallet` /
 * `WalletTransaction` are deliberately absent from the invalidation set.
 *
 * IDEMPOTENCY (Phase 8.9): `POST /driver-settlements` requires an
 * `Idempotency-Key` header. Same contract as payouts — one explicit
 * caller-supplied stable key, set verbatim as the header, preserved across a
 * reauth retry, never regenerated, never cached/logged.
 */

export interface ListSettlementsParams extends PaginationParams {
  search?: string;
  driverId?: string;
  paymentMethodId?: string;
}

export interface CreateSettlementRequest {
  driverId: string;
  amountReceived: string;
  paymentMethodId: string;
  notes?: string;
}

export const settlementsApi = api.injectEndpoints({
  endpoints: (builder) => ({
    getSettlements: builder.query<
      Paginated<SettlementSummary>,
      ListSettlementsParams | void
    >({
      query: (params) => ({
        url: '/driver-settlements',
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (r: ApiListResponse<SettlementSummary>) =>
        unwrapList(r),
      providesTags: [{ type: 'Settlement', id: 'LIST' }],
    }),

    createSettlement: builder.mutation<
      SettlementSummary,
      { body: CreateSettlementRequest; idempotencyKey: string }
    >({
      query: ({ body, idempotencyKey }) => ({
        url: '/driver-settlements',
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
      transformResponse: (r: ApiSuccessResponse<SettlementSummary>) =>
        unwrapData(r),
      invalidatesTags: [
        { type: 'Settlement', id: 'LIST' },
        { type: 'DriverCash', id: 'ME' },
        { type: 'Finance', id: 'SUMMARY' },
        { type: 'Finance', id: 'TRANSACTIONS' },
        { type: 'Dashboard', id: 'ROOT' },
        { type: 'Report', id: 'LIST' },
      ],
    }),
  }),
});

export const { useGetSettlementsQuery, useCreateSettlementMutation } =
  settlementsApi;
