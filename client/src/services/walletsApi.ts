import { api } from './api';
import { cleanParams } from './queryParams';
import { unwrapData, unwrapList } from './unwrap';
import type {
  ApiListResponse,
  ApiSuccessResponse,
  Paginated,
  PaginationParams,
} from './apiTypes';
import type {
  LedgerCorrectionResult,
  WalletCustomerSummary,
  WalletDetail,
  WalletSummary,
  WalletTransactionEntry,
} from './domain.types';

/**
 * Customer Wallet ledger (Phase 8.2) + authorized corrections (Phase 8.8).
 * Backend: server/src/modules/wallets (+ /wallet-transactions).
 *
 * LEDGER SEPARATION: a wallet adjustment / reversal changes the Customer
 * Wallet and the Company Finance view — it NEVER touches Driver Cash, so
 * `DriverCash` is deliberately absent from the invalidation set.
 */

export interface ListWalletsParams extends PaginationParams {
  search?: string;
}

export interface ListWalletTransactionsParams extends PaginationParams {
  type?: 'ORDER_CREDIT' | 'PAYOUT' | 'ADJUSTMENT' | 'REVERSAL';
}

export interface AdjustWalletRequest {
  direction: 'CREDIT' | 'DEBIT';
  amount: string;
  reason: string;
}

const WALLET_CORRECTION_INVALIDATION = [
  { type: 'Wallet', id: 'LIST' },
  { type: 'WalletTransaction', id: 'LIST' },
  { type: 'Finance', id: 'SUMMARY' },
  { type: 'Finance', id: 'TRANSACTIONS' },
  { type: 'Dashboard', id: 'ROOT' },
  { type: 'Report', id: 'LIST' },
] as const;

export const walletsApi = api.injectEndpoints({
  endpoints: (builder) => ({
    getWallets: builder.query<
      Paginated<WalletSummary>,
      ListWalletsParams | void
    >({
      query: (params) => ({
        url: '/wallets',
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (r: ApiListResponse<WalletSummary>) => unwrapList(r),
      providesTags: [{ type: 'Wallet', id: 'LIST' }],
    }),

    getWallet: builder.query<WalletDetail, string>({
      query: (customerId) => ({ url: `/wallets/${customerId}` }),
      transformResponse: (r: ApiSuccessResponse<WalletDetail>) => unwrapData(r),
      providesTags: (_res, _err, customerId) => [
        { type: 'Wallet', id: customerId },
      ],
    }),

    /**
     * Batched balance + pending for a page of Customers (wallets.read). The
     * `wallets.read`-gated financial source for the Management Customer List —
     * one request per page, never per row.
     */
    getWalletCustomerSummaries: builder.query<
      WalletCustomerSummary[],
      { customerIds: string[] }
    >({
      query: ({ customerIds }) => ({
        url: '/wallets/customer-summaries',
        params: { customerIds: customerIds.join(',') },
      }),
      transformResponse: (r: ApiSuccessResponse<WalletCustomerSummary[]>) =>
        unwrapData(r),
      providesTags: [{ type: 'Wallet', id: 'LIST' }],
    }),

    getWalletTransactions: builder.query<
      Paginated<WalletTransactionEntry>,
      { customerId: string; params?: ListWalletTransactionsParams }
    >({
      query: ({ customerId, params }) => ({
        url: `/wallets/${customerId}/transactions`,
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (r: ApiListResponse<WalletTransactionEntry>) =>
        unwrapList(r),
      providesTags: [{ type: 'WalletTransaction', id: 'LIST' }],
    }),

    adjustWallet: builder.mutation<
      LedgerCorrectionResult,
      { customerId: string; body: AdjustWalletRequest }
    >({
      query: ({ customerId, body }) => ({
        url: `/wallets/${customerId}/adjust`,
        method: 'POST',
        body,
      }),
      transformResponse: (r: ApiSuccessResponse<LedgerCorrectionResult>) =>
        unwrapData(r),
      invalidatesTags: (_res, _err, { customerId }) => [
        { type: 'Wallet', id: customerId },
        { type: 'Customer', id: customerId },
        ...WALLET_CORRECTION_INVALIDATION,
      ],
    }),

    /**
     * POST /wallet-transactions/:id/reverse. Server body is only `{ reason }`;
     * `customerId` / `orderId` / `payoutLinked` are optional cache-invalidation
     * hints the UI row already holds (CLAUDE.md §22). A PAYOUT reversal here
     * also flips the payout's status to REVERSED server-side, hence `Payout`.
     */
    reverseWalletTransaction: builder.mutation<
      LedgerCorrectionResult,
      {
        transactionId: string;
        reason: string;
        customerId?: string;
        orderId?: string;
        payoutLinked?: boolean;
      }
    >({
      query: ({ transactionId, reason }) => ({
        url: `/wallet-transactions/${transactionId}/reverse`,
        method: 'POST',
        body: { reason },
      }),
      transformResponse: (r: ApiSuccessResponse<LedgerCorrectionResult>) =>
        unwrapData(r),
      invalidatesTags: (_res, _err, { customerId, orderId, payoutLinked }) => [
        ...(customerId
          ? [
              { type: 'Wallet' as const, id: customerId },
              { type: 'Customer' as const, id: customerId },
            ]
          : []),
        ...(orderId ? [{ type: 'Order' as const, id: orderId }] : []),
        ...(payoutLinked ? [{ type: 'Payout' as const, id: 'LIST' }] : []),
        ...WALLET_CORRECTION_INVALIDATION,
      ],
    }),
  }),
});

export const {
  useGetWalletsQuery,
  useGetWalletQuery,
  useGetWalletCustomerSummariesQuery,
  useGetWalletTransactionsQuery,
  useAdjustWalletMutation,
  useReverseWalletTransactionMutation,
} = walletsApi;
