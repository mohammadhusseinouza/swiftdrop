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
  FinanceSummaryDto,
  FinanceTransactionEntry,
  LedgerCorrectionResult,
  LedgerName,
} from './domain.types';

/**
 * Finance Summary + Transactions (Phase 9.2) and Driver-Cash / Company
 * corrections (Phase 8.8). Backend: server/src/modules/finance.
 * All reads require `finance.read`; all corrections require `finance.adjust`.
 *
 * LEDGER SEPARATION in invalidation:
 *   - driver-cash adjust/reverse  -> DriverCash + Finance views (NOT Wallet)
 *   - company adjust/reverse      -> Finance views only (NOT Wallet, NOT DriverCash)
 */

export interface FinanceSummaryParams {
  from?: string;
  to?: string;
}

export interface FinanceTransactionsParams extends PaginationParams {
  from?: string;
  to?: string;
  ledger?: LedgerName;
  type?: string;
}

export interface LedgerCorrectionRequest {
  direction: 'CREDIT' | 'DEBIT';
  amount: string;
  reason: string;
}

const FINANCE_VIEWS = [
  { type: 'Finance', id: 'SUMMARY' },
  { type: 'Finance', id: 'TRANSACTIONS' },
  { type: 'Dashboard', id: 'ROOT' },
  { type: 'Report', id: 'LIST' },
] as const;

export const financeApi = api.injectEndpoints({
  endpoints: (builder) => ({
    getFinanceSummary: builder.query<
      FinanceSummaryDto,
      FinanceSummaryParams | void
    >({
      query: (params) => ({
        url: '/finance/summary',
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (r: ApiSuccessResponse<FinanceSummaryDto>) =>
        unwrapData(r),
      providesTags: [{ type: 'Finance', id: 'SUMMARY' }],
    }),

    getFinanceTransactions: builder.query<
      Paginated<FinanceTransactionEntry>,
      FinanceTransactionsParams | void
    >({
      query: (params) => ({
        url: '/finance/transactions',
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (r: ApiListResponse<FinanceTransactionEntry>) =>
        unwrapList(r),
      providesTags: [{ type: 'Finance', id: 'TRANSACTIONS' }],
    }),

    adjustDriverCash: builder.mutation<
      LedgerCorrectionResult,
      { driverId: string; body: LedgerCorrectionRequest }
    >({
      query: ({ driverId, body }) => ({
        url: `/finance/driver-cash/${driverId}/adjust`,
        method: 'POST',
        body,
      }),
      transformResponse: (r: ApiSuccessResponse<LedgerCorrectionResult>) =>
        unwrapData(r),
      invalidatesTags: [{ type: 'DriverCash', id: 'ME' }, ...FINANCE_VIEWS],
    }),

    reverseDriverCashTransaction: builder.mutation<
      LedgerCorrectionResult,
      { transactionId: string; reason: string }
    >({
      query: ({ transactionId, reason }) => ({
        url: `/finance/driver-cash-transactions/${transactionId}/reverse`,
        method: 'POST',
        body: { reason },
      }),
      transformResponse: (r: ApiSuccessResponse<LedgerCorrectionResult>) =>
        unwrapData(r),
      invalidatesTags: [{ type: 'DriverCash', id: 'ME' }, ...FINANCE_VIEWS],
    }),

    adjustCompanyFinance: builder.mutation<
      LedgerCorrectionResult,
      LedgerCorrectionRequest
    >({
      query: (body) => ({ url: '/finance/company/adjust', method: 'POST', body }),
      transformResponse: (r: ApiSuccessResponse<LedgerCorrectionResult>) =>
        unwrapData(r),
      invalidatesTags: [...FINANCE_VIEWS],
    }),

    reverseCompanyTransaction: builder.mutation<
      LedgerCorrectionResult,
      { transactionId: string; reason: string }
    >({
      query: ({ transactionId, reason }) => ({
        url: `/finance/company-transactions/${transactionId}/reverse`,
        method: 'POST',
        body: { reason },
      }),
      transformResponse: (r: ApiSuccessResponse<LedgerCorrectionResult>) =>
        unwrapData(r),
      invalidatesTags: [...FINANCE_VIEWS],
    }),
  }),
});

export const {
  useGetFinanceSummaryQuery,
  useGetFinanceTransactionsQuery,
  useAdjustDriverCashMutation,
  useReverseDriverCashTransactionMutation,
  useAdjustCompanyFinanceMutation,
  useReverseCompanyTransactionMutation,
} = financeApi;
