import { api } from './api';
import { cleanParams } from './queryParams';
import { unwrapData, unwrapList } from './unwrap';
import type {
  ApiListResponse,
  ApiObjectWithMeta,
  ApiSuccessResponse,
  Paginated,
  PaginationParams,
} from './apiTypes';
import type { SettlementCorrectionEntry, SettlementSummary } from './domain.types';
import {
  settlementInvalidationTags,
  settlementReversalInvalidationTags,
  type SettlementAffected,
} from './settlementInvalidation';

/**
 * Driver Settlements (Phase 8.6). Backend: server/src/modules/settlements
 * (mounted at /driver-settlements).
 *
 * LEDGER SEPARATION: a settlement reduces Driver Cash and never DEBITS a
 * Customer Wallet. Under settlement-based release (FR.4) an allocation that
 * fully settles a collection RELEASES that order's already-earned wallet
 * credit / company revenue, so an allocation-format settlement also
 * invalidates the affected wallets, customers and orders
 * (`settlementInvalidationTags`). A legacy or unattributed-only settlement
 * never touches a wallet.
 *
 * IDEMPOTENCY (Phase 8.9): `POST /driver-settlements` requires an
 * `Idempotency-Key` header — one explicit caller-supplied stable key, set
 * verbatim as the header, preserved across a reauth retry, never regenerated,
 * never cached/logged (see settlementSubmission.ts for the key rules).
 */

export interface ListSettlementsParams extends PaginationParams {
  search?: string;
  driverId?: string;
  paymentMethodId?: string;
}

export interface SettlementAllocationRequest {
  releaseId: string;
  amount: string;
}

/**
 * Two formats (contract §5.2): allocation format (`allocations` present, may
 * be empty; amountReceived = Σ allocations + unattributedAmount exactly) and
 * the legacy format (`allocations` omitted).
 */
export interface CreateSettlementRequest {
  driverId: string;
  amountReceived: string;
  paymentMethodId: string;
  notes?: string;
  allocations?: SettlementAllocationRequest[];
  unattributedAmount?: string;
  unattributedReason?: string;
}

export type CollectionSettlementState = 'UNSETTLED' | 'PARTIALLY_SETTLED' | 'FULLY_SETTLED';

/** One outstanding settlement-mode collection (FR.7 + FR.9 planned split). */
export interface OutstandingCollection {
  releaseId: string;
  order: { id: string; orderNumber: string };
  customer: { id: string; customerNumber: string; name: string };
  orderType: string;
  deliveredAt: string;
  collectionAmount: string;
  allocatedAmount: string;
  outstandingAmount: string;
  settlementState: CollectionSettlementState;
  reviewStatus: string;
  releaseStatus: string;
  /** The approved split a release posts; all null while the difference awaits review. */
  plannedCustomerWalletAmount: string | null;
  plannedCompanyProductAmount: string | null;
  plannedCompanyFeeAmount: string | null;
}

export interface DriverOutstandingCollections {
  driverId: string;
  cashBalance: string;
  attributedOutstanding: string;
  unattributedBalance: string;
  outstandingCollectionCount: number;
  items: OutstandingCollection[];
}

export interface OutstandingCollectionsParams {
  driverId: string;
  page?: number;
  limit?: number;
}

export interface SettlementAllocationDetail {
  id: string;
  releaseId: string;
  order: { id: string; orderNumber: string };
  customer: { id: string; customerNumber: string; name: string };
  orderType: string;
  amount: string;
  status: 'ACTIVE' | 'REVERSED';
  reversedByCorrectionId: string | null;
  releasedByThisSettlement: boolean;
  /** CURRENT state of the collection (later settlements may have changed it). */
  collection: {
    collectionAmount: string;
    allocatedAmount: string;
    outstandingAmount: string;
    settlementState: CollectionSettlementState;
    releaseStatus: string;
    reviewStatus: string;
  };
}

export interface SettlementCorrectionSummary {
  id: string;
  correctionType: string;
  amount: string;
  reason: string;
  cashTransactionId: string;
  createdBy: { id: string; firstName: string; lastName: string };
  createdAt: string;
}

export interface SettlementDetail extends SettlementSummary {
  format: 'LEGACY' | 'ALLOCATION';
  allocations: SettlementAllocationDetail[];
  releasedOrders: {
    releaseId: string;
    order: { id: string; orderNumber: string };
    releasedAt: string | null;
  }[];
  collectionsFullySettled: number;
  collectionsPartiallySettled: number;
  corrections: SettlementCorrectionSummary[];
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

    /** GET /driver-settlements/:id (FR.7, settlements.read). */
    getSettlement: builder.query<SettlementDetail, string>({
      query: (id) => ({ url: `/driver-settlements/${id}` }),
      transformResponse: (r: ApiSuccessResponse<SettlementDetail>) =>
        unwrapData(r),
      providesTags: (_res, _err, id) => [{ type: 'Settlement', id }],
    }),

    /**
     * GET /finance/driver-cash/:driverId/outstanding-collections (FR.7,
     * finance.read). Server-paginated, oldest first; the cash position
     * (balance / attributed / unattributed) comes from the same snapshot.
     * Tagged with the driver's cash tag: every settlement, adjustment and
     * reversal for that driver already invalidates it.
     */
    getOutstandingCollections: builder.query<
      DriverOutstandingCollections & { meta: Paginated<unknown>['meta'] },
      OutstandingCollectionsParams
    >({
      query: ({ driverId, ...params }) => ({
        url: `/finance/driver-cash/${driverId}/outstanding-collections`,
        params: cleanParams({ ...params }),
      }),
      transformResponse: (r: ApiObjectWithMeta<DriverOutstandingCollections>) => ({
        ...r.data,
        meta: r.meta,
      }),
      providesTags: (_res, _err, { driverId }) => [
        { type: 'DriverCash', id: driverId },
      ],
    }),

    createSettlement: builder.mutation<
      SettlementSummary,
      {
        body: CreateSettlementRequest;
        idempotencyKey: string;
        /** Not sent — the customers/orders whose collections were allocated. */
        affected?: SettlementAffected;
      }
    >({
      query: ({ body, idempotencyKey }) => ({
        url: '/driver-settlements',
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
      transformResponse: (r: ApiSuccessResponse<SettlementSummary>) =>
        unwrapData(r),
      // Invalidated on failure too (as before FR.9): a transport failure may
      // have committed, and a conflict means the cash position moved.
      invalidatesTags: (res, _err, { body, affected }) =>
        settlementInvalidationTags(
          body.driverId,
          affected ?? { customerIds: [], orderIds: [] },
          res?.id,
        ),
    }),

    /**
     * FR.10.2 — POST /driver-settlements/:id/reverse (finance.adjust,
     * Idempotency-Key required). Deterministic server key: a retry with the
     * same reason returns the recorded reversal; a different reason is a 409.
     */
    reverseSettlement: builder.mutation<
      SettlementCorrectionEntry,
      {
        settlementId: string;
        reason: string;
        idempotencyKey: string;
        /** cache-invalidation hints only — not sent */
        ctx: { driverId: string; orderIds: string[] };
      }
    >({
      query: ({ settlementId, reason, idempotencyKey }) => ({
        url: `/driver-settlements/${settlementId}/reverse`,
        method: 'POST',
        body: { reason },
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
      transformResponse: (r: ApiSuccessResponse<SettlementCorrectionEntry>) => unwrapData(r),
      invalidatesTags: (_res, _err, { settlementId, ctx }) =>
        settlementReversalInvalidationTags({ settlementId, driverId: ctx.driverId, orderIds: ctx.orderIds }),
    }),
  }),
});

export const {
  useGetSettlementsQuery,
  useGetSettlementQuery,
  useGetOutstandingCollectionsQuery,
  useCreateSettlementMutation,
  useReverseSettlementMutation,
} = settlementsApi;
