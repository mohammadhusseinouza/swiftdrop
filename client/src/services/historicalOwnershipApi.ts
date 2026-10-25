import { api } from './api';
import { unwrapData, unwrapList } from './unwrap';
import type { ApiListResponse, ApiSuccessResponse, Paginated } from './apiTypes';
import type {
  HistoricalOwnershipSummary,
  LiabilityPolicy,
  OwnershipResolutionDetail,
  OwnershipResolutionSummary,
  ProposePolicyBody,
  ProposeResolutionBody,
} from './historicalOwnership.types';
import {
  HISTORICAL_OWNERSHIP_BASE,
  policyDecisionRequest,
  proposePolicyRequest,
  proposeResolutionRequest,
  resolutionActionRequest,
  reviewLiabilityRequest,
  type PolicyAction,
  type PolicyDecisionBody,
  type ResolutionAction,
  type ResolutionActionBody,
} from './historicalOwnershipRequests';

/**
 * FR.12A.11 — historical ownership resolution / company-assumed historical
 * liability (ADMIN / FINANCE by role). Backend: /finance/historical-ownership.
 * The backend alone decides roles, independence, evidence validity and
 * whether writes are enabled (403 HISTORICAL_OWNERSHIP_DISABLED).
 *
 * No write posts money. Recording a liability changes the G5 / R14 readiness
 * and the separate historical-liability figure of the finance summary, so
 * those views are refreshed too.
 */

const HO = 'HistoricalOwnership' as const;
const SUMMARY = { type: HO, id: 'SUMMARY' };
const POLICIES = { type: HO, id: 'POLICIES' };
const RESOLUTIONS = { type: HO, id: 'RESOLUTIONS' };
const FR_TAG = { type: 'Settings' as const, id: 'FINANCIAL_RELEASE' };

export const historicalOwnershipApi = api.injectEndpoints({
  endpoints: (builder) => ({
    getOwnershipSummary: builder.query<HistoricalOwnershipSummary, void>({
      query: () => ({ url: `${HISTORICAL_OWNERSHIP_BASE}/summary` }),
      transformResponse: (r: ApiSuccessResponse<HistoricalOwnershipSummary>) => unwrapData(r),
      providesTags: [SUMMARY],
    }),
    getLiabilityPolicies: builder.query<LiabilityPolicy[], void>({
      query: () => ({ url: `${HISTORICAL_OWNERSHIP_BASE}/policies` }),
      transformResponse: (r: ApiSuccessResponse<LiabilityPolicy[]>) => unwrapData(r),
      providesTags: [POLICIES],
    }),
    getOwnershipResolutions: builder.query<Paginated<OwnershipResolutionSummary>, { page: number; limit: number }>({
      query: (params) => ({ url: `${HISTORICAL_OWNERSHIP_BASE}/resolutions`, params }),
      transformResponse: (r: ApiListResponse<OwnershipResolutionSummary>) => unwrapList(r),
      providesTags: (result) => [RESOLUTIONS, ...(result?.items ?? []).map((i) => ({ type: HO, id: i.id }))],
    }),
    getOwnershipResolution: builder.query<OwnershipResolutionDetail, string>({
      query: (id) => ({ url: `${HISTORICAL_OWNERSHIP_BASE}/resolutions/${encodeURIComponent(id)}` }),
      transformResponse: (r: ApiSuccessResponse<OwnershipResolutionDetail>) => unwrapData(r),
      providesTags: (_r, _e, id) => [{ type: HO, id }],
    }),
    proposePolicy: builder.mutation<LiabilityPolicy, { body: ProposePolicyBody; idempotencyKey: string }>({
      query: ({ body, idempotencyKey }) => proposePolicyRequest(body, idempotencyKey),
      transformResponse: (r: ApiSuccessResponse<LiabilityPolicy>) => unwrapData(r),
      invalidatesTags: [POLICIES],
    }),
    decidePolicy: builder.mutation<LiabilityPolicy, { id: string; action: PolicyAction; body: PolicyDecisionBody; idempotencyKey: string }>({
      query: ({ id, action, body, idempotencyKey }) => policyDecisionRequest(id, action, body, idempotencyKey),
      transformResponse: (r: ApiSuccessResponse<LiabilityPolicy>) => unwrapData(r),
      // A policy revocation can invalidate recorded liabilities (G5 / R14).
      invalidatesTags: [POLICIES, RESOLUTIONS, SUMMARY, FR_TAG, 'Finance'],
    }),
    proposeResolution: builder.mutation<OwnershipResolutionDetail, { body: ProposeResolutionBody; idempotencyKey: string }>({
      query: ({ body, idempotencyKey }) => proposeResolutionRequest(body, idempotencyKey),
      transformResponse: (r: ApiSuccessResponse<OwnershipResolutionDetail>) => unwrapData(r),
      invalidatesTags: [RESOLUTIONS, SUMMARY],
    }),
    actOnResolution: builder.mutation<
      OwnershipResolutionDetail,
      { id: string; action: ResolutionAction; body: ResolutionActionBody; idempotencyKey: string }
    >({
      query: ({ id, action, body, idempotencyKey }) => resolutionActionRequest(id, action, body, idempotencyKey),
      transformResponse: (r: ApiSuccessResponse<OwnershipResolutionDetail>) => unwrapData(r),
      invalidatesTags: (_r, _e, { id }) => [{ type: HO, id }, RESOLUTIONS, SUMMARY, FR_TAG, 'Finance'],
    }),
    reviewLiability: builder.mutation<OwnershipResolutionDetail, { liabilityId: string; resolutionId: string; note: string; idempotencyKey: string }>({
      query: ({ liabilityId, note, idempotencyKey }) => reviewLiabilityRequest(liabilityId, note, idempotencyKey),
      transformResponse: (r: ApiSuccessResponse<OwnershipResolutionDetail>) => unwrapData(r),
      invalidatesTags: (_r, _e, { resolutionId }) => [{ type: HO, id: resolutionId }, SUMMARY],
    }),
  }),
});

export const {
  useGetOwnershipSummaryQuery,
  useGetLiabilityPoliciesQuery,
  useGetOwnershipResolutionsQuery,
  useGetOwnershipResolutionQuery,
  useProposePolicyMutation,
  useDecidePolicyMutation,
  useProposeResolutionMutation,
  useActOnResolutionMutation,
  useReviewLiabilityMutation,
} = historicalOwnershipApi;
