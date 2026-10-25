import { api } from './api';
import { unwrapData, unwrapList } from './unwrap';
import type { ApiListResponse, ApiSuccessResponse, Paginated } from './apiTypes';
import type {
  LedgerIncident,
  ProposeReconciliationBody,
  ReconciliationDetail,
  ReconciliationListItem,
  ReconciliationListParams,
  ReconciliationSummary,
} from './historicalReconciliation.types';
import {
  HISTORICAL_RECONCILIATION_BASE,
  decisionRequest,
  listReconciliationsRequest,
  proposeReconciliationRequest,
  reconciliationDetailRequest,
  type DecisionBody,
  type ReconciliationDecisionAction,
} from './historicalReconciliationRequests';

/**
 * FR.12A.6 — driver cash historical reconciliation (ADMIN / FINANCE by role).
 * Backend FR.12A.5: /finance/historical-reconciliations. The backend is the
 * only authority on roles, independence, evidence validity and whether
 * writes are enabled (403 HISTORICAL_RECONCILIATION_DISABLED) — nothing here
 * decides any of that.
 *
 * A decision changes NO balance and posts nothing. It changes the G3 / R1
 * explanatory amount, so the readiness / reconciliation views are refreshed
 * too ('Settings' FINANCIAL_RELEASE), and the as-of driver cash components of
 * the finance summary ('Finance').
 */

const HR = 'HistoricalReconciliation' as const;
const LIST_TAG = { type: HR, id: 'LIST' };
const FR_TAG = { type: 'Settings' as const, id: 'FINANCIAL_RELEASE' };

export interface DecisionArgs {
  id: string;
  action: ReconciliationDecisionAction;
  body: DecisionBody;
  idempotencyKey: string;
}

export const historicalReconciliationApi = api.injectEndpoints({
  endpoints: (builder) => ({
    getReconciliations: builder.query<Paginated<ReconciliationListItem>, ReconciliationListParams>({
      query: (p) => listReconciliationsRequest(p),
      transformResponse: (r: ApiListResponse<ReconciliationListItem>) => unwrapList(r),
      providesTags: (result) => [LIST_TAG, ...(result?.items ?? []).map((i) => ({ type: HR, id: i.reconciliationId }))],
    }),
    getReconciliation: builder.query<ReconciliationDetail, string>({
      query: (id) => reconciliationDetailRequest(id),
      transformResponse: (r: ApiSuccessResponse<ReconciliationDetail>) => unwrapData(r),
      providesTags: (_r, _e, id) => [{ type: HR, id }],
    }),
    getReconciliationSummary: builder.query<ReconciliationSummary, void>({
      query: () => ({ url: `${HISTORICAL_RECONCILIATION_BASE}/summary` }),
      transformResponse: (r: ApiSuccessResponse<ReconciliationSummary>) => unwrapData(r),
      providesTags: [{ type: HR, id: 'SUMMARY' }],
    }),
    getLedgerIncidents: builder.query<Paginated<LedgerIncident>, { page: number; limit: number }>({
      query: (p) => ({ url: `${HISTORICAL_RECONCILIATION_BASE}/incidents`, params: p }),
      transformResponse: (r: ApiListResponse<LedgerIncident>) => unwrapList(r),
      providesTags: [{ type: HR, id: 'INCIDENTS' }],
    }),
    proposeReconciliation: builder.mutation<ReconciliationDetail, { body: ProposeReconciliationBody; idempotencyKey: string }>({
      query: ({ body, idempotencyKey }) => proposeReconciliationRequest(body, idempotencyKey),
      transformResponse: (r: ApiSuccessResponse<ReconciliationDetail>) => unwrapData(r),
      invalidatesTags: [LIST_TAG, { type: HR, id: 'SUMMARY' }, { type: HR, id: 'INCIDENTS' }],
    }),
    decideReconciliation: builder.mutation<ReconciliationDetail, DecisionArgs>({
      query: ({ id, action, body, idempotencyKey }) => decisionRequest(id, action, body, idempotencyKey),
      transformResponse: (r: ApiSuccessResponse<ReconciliationDetail>) => unwrapData(r),
      invalidatesTags: (_r, _e, { id }) => [{ type: HR, id }, LIST_TAG, { type: HR, id: 'SUMMARY' }, { type: HR, id: 'INCIDENTS' }, FR_TAG, 'Finance'],
    }),
  }),
});

export const {
  useGetReconciliationsQuery,
  useGetReconciliationQuery,
  useGetReconciliationSummaryQuery,
  useGetLedgerIncidentsQuery,
  useProposeReconciliationMutation,
  useDecideReconciliationMutation,
} = historicalReconciliationApi;
