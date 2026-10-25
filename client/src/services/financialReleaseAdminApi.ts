import { api } from './api';
import { unwrapData } from './unwrap';
import type { ApiSuccessResponse } from './apiTypes';

/**
 * FR.11B — settlement-based financial release activation (ADMIN role only).
 * Backend: server/src/modules/financial-release/financial-release-activation.*
 *   GET  /admin/financial-release             state
 *   GET  /admin/financial-release/readiness   dry-run gate report (G0–G7)
 *   POST /admin/financial-release/activate    gates re-evaluated server-side
 *   POST /admin/financial-release/deactivate  always allowed
 *   GET  /admin/financial-release/latency-probe
 * plus the read-only reconciliation report (finance.read).
 * The backend is the only gatekeeper; nothing here decides activation.
 */

export type GateId = 'G0' | 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7';

export interface GateFinding {
  entityType: string;
  entityId: string;
  detail: string;
}

export interface GateResult {
  id: GateId;
  title: string;
  passed: boolean;
  detail: string;
  affectedCount: number;
  findings: GateFinding[];
}

export interface ReadinessReport {
  evaluatedAt: string;
  ready: boolean;
  failedGates: GateId[];
  gates: GateResult[];
  historicalFindings: { id: string; title: string; affectedCount: number }[];
  /** FR.12A.10 — deleted orders G5 treats as resolved by a recorded historical liability. */
  historicalDispositions?: {
    deletedOrderReference: string;
    resolutionId: string;
    liabilityId: string;
    outcome: 'COMPANY_ASSUMED_LIABILITY';
    recognizedAmount: string;
    outstandingAmount: string;
    trackedShortfallAmount: string;
    policyCode: string;
    policyVersion: number;
  }[];
}

export interface FinancialReleaseActivationState {
  enabled: boolean;
  environmentAuthorized: boolean;
  serverContractVersion: string;
  settingUpdatedAt: string | null;
}

export interface ActivationChangeResult {
  changed: boolean;
  state: FinancialReleaseActivationState;
  readiness: ReadinessReport | null;
}

export interface ReconciliationCheck {
  id: string;
  title: string;
  kind: 'INVARIANT' | 'HISTORICAL' | 'INFORMATIONAL';
  status: 'PASS' | 'FAIL' | 'INFO';
  blocksActivation: boolean;
  affectedCount: number;
  financialReleaseViolationCount: number;
  historicalAnomalyCount: number;
}

export interface ReconciliationReport {
  generatedAt: string;
  summary: {
    checksRun: number;
    invariantChecksFailed: number;
    financialReleaseViolations: number;
    historicalAnomalies: number;
    activationBlocked: boolean;
  };
  checks: ReconciliationCheck[];
}

export interface LatencyStats {
  samples: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
}

export interface LatencyProbeReport {
  measuredAt: string;
  singleStatement: LatencyStats;
  inTransaction: LatencyStats | null;
  inTransactionError: string | null;
  decisionP95Ms: number;
  recommendedMaxAllocations: number;
  currentMaxAllocations: number;
  verdict: 'LIMIT_CONFIRMED' | 'REDUCE_LIMIT' | 'DO_NOT_ACTIVATE';
  model: string;
}

const FR_TAG = { type: 'Settings' as const, id: 'FINANCIAL_RELEASE' };

export const financialReleaseAdminApi = api.injectEndpoints({
  endpoints: (builder) => ({
    getFinancialReleaseActivation: builder.query<FinancialReleaseActivationState, void>({
      query: () => ({ url: '/admin/financial-release' }),
      transformResponse: (r: ApiSuccessResponse<FinancialReleaseActivationState>) => unwrapData(r),
      providesTags: [FR_TAG],
    }),
    getFinancialReleaseReadiness: builder.query<ReadinessReport, void>({
      query: () => ({ url: '/admin/financial-release/readiness' }),
      transformResponse: (r: ApiSuccessResponse<ReadinessReport>) => unwrapData(r),
      providesTags: [FR_TAG],
      keepUnusedDataFor: 0,
    }),
    getFinancialReleaseReconciliation: builder.query<ReconciliationReport, void>({
      query: () => ({ url: '/finance/reconciliation/financial-release' }),
      transformResponse: (r: ApiSuccessResponse<ReconciliationReport>) => unwrapData(r),
      providesTags: [FR_TAG],
      keepUnusedDataFor: 0,
    }),
    probeDatabaseLatency: builder.mutation<LatencyProbeReport, { samples?: number } | void>({
      // A read-only measurement, modelled as a mutation so it only runs on demand.
      query: (arg) => ({ url: '/admin/financial-release/latency-probe', params: arg?.samples ? { samples: arg.samples } : undefined }),
      transformResponse: (r: ApiSuccessResponse<LatencyProbeReport>) => unwrapData(r),
    }),
    activateFinancialRelease: builder.mutation<ActivationChangeResult, void>({
      query: () => ({ url: '/admin/financial-release/activate', method: 'POST', body: {} }),
      transformResponse: (r: ApiSuccessResponse<ActivationChangeResult>) => unwrapData(r),
      // Activation changes no balances — only the setting and its readiness view.
      invalidatesTags: [FR_TAG, { type: 'Settings', id: 'SYSTEM' }],
    }),
    deactivateFinancialRelease: builder.mutation<ActivationChangeResult, void>({
      query: () => ({ url: '/admin/financial-release/deactivate', method: 'POST', body: {} }),
      transformResponse: (r: ApiSuccessResponse<ActivationChangeResult>) => unwrapData(r),
      invalidatesTags: [FR_TAG, { type: 'Settings', id: 'SYSTEM' }],
    }),
  }),
});

export const {
  useGetFinancialReleaseActivationQuery,
  useGetFinancialReleaseReadinessQuery,
  useGetFinancialReleaseReconciliationQuery,
  useProbeDatabaseLatencyMutation,
  useActivateFinancialReleaseMutation,
  useDeactivateFinancialReleaseMutation,
} = financialReleaseAdminApi;
