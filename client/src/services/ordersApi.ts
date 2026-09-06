import { api } from './api';
import { cleanParams } from './queryParams';
import { unwrapData, unwrapList, unwrapObjectWithMeta } from './unwrap';
import type {
  ApiListResponse,
  ApiObjectWithMeta,
  ApiSuccessResponse,
  Paginated,
  PaginationParams,
} from './apiTypes';
import type {
  BulkAssignResult,
  DriverCashOverview,
  DriverFailedCollectionReasonSummary,
  DriverFailedDeliveryReasonSummary,
  DriverHistoryJobType,
  DriverHistoryResult,
  DriverJobDetail,
  DriverJobSummary,
  DriverJobType,
  DriverOrderDetail,
  DriverParcelCollectionResult,
  DriverOrderSummary,
  DriverWorkHistoryItem,
  OrderDetail,
  OrderHistoryResponse,
  OrderSummary,
  OrderTimelineEvent,
  ParcelCollectionStatus,
  ParcelIntakeMethod,
  WorkflowQueue,
} from './domain.types';

/**
 * Orders (Phase 6) + Driver self-service order workflow (Phase 7 / 8.1).
 * All backend routes verified against server/src/modules/{orders,driver-orders,
 * driver-cash}.
 *
 * Invalidation respects the Phase 8 ledger model:
 *   - a successful delivery touches Order + DriverCash + (DELIVERY_ONLY) Wallet
 *     + Finance + Dashboard + Report
 *   - resolve-collection-difference is a cross-ledger Finance action (Wallet
 *     and/or Company revenue) — never Driver Cash
 *   - failed delivery creates NO financial credit (requirements §19)
 */

/* ------------------------------- args ------------------------------- */

/** Backend `OrderSortBySchema` allowlist (server/src/modules/orders/order.schema.ts). */
export type OrderSortBy =
  | 'createdAt'
  | 'orderNumber'
  | 'status'
  | 'orderAmount'
  | 'deliveryFee'
  | 'amountToCollect'
  | 'deliveredAt';

export type OrderSortOrder = 'asc' | 'desc';

export interface ListOrdersParams extends PaginationParams {
  search?: string;
  status?: string;
  orderType?: string;
  paymentType?: string;
  /** Matches an Order whose prepaid OR collection payment method is this id. */
  paymentMethodId?: string;
  /** DELIVERED -> status === DELIVERED; UNDELIVERED -> status !== DELIVERED. */
  deliveryStatus?: 'DELIVERED' | 'UNDELIVERED';
  financialStatus?: string;
  customerId?: string;
  driverId?: string;
  areaId?: string;
  needsFinancialReview?: boolean;
  assignmentStatus?: 'ASSIGNED' | 'UNASSIGNED';
  /** Parcel Intake / Collection filters (Phase 11.17.6) — independent of OrderType. */
  parcelIntakeMethod?: ParcelIntakeMethod;
  parcelCollectionStatus?: ParcelCollectionStatus;
  /** CURRENT collection work only — never "ever had a collection assignment". */
  parcelCollectionDriverId?: string;
  /** Operational queue (Phase 11.17.6) — see order-workflow-queue.ts for the exact predicate. */
  workflowQueue?: WorkflowQueue;
  /** Bare YYYY-MM-DD -> whole UTC day; the backend applies the boundaries. */
  createdFrom?: string;
  createdTo?: string;
  sortBy?: OrderSortBy;
  sortOrder?: OrderSortOrder;
}

export interface CreateOrderRequest {
  customerId: string;
  orderType: string;
  paymentType: string;
  receiverName: string;
  receiverPhone: string;
  receiverAltPhone?: string;
  receiverAreaId: string;
  receiverAddress: string;
  receiverBuildingFloor?: string;
  receiverMapLink?: string;
  receiverInstructions?: string;
  description: string;
  packageCount?: number;
  quantity?: number;
  /**
   * Sent as a plain decimal string (e.g. "1.25"); the backend coerces it
   * (`z.coerce.number()` on a NUMERIC(10,3) column). A number is still
   * accepted for backward compatibility.
   */
  weightKg?: number | string;
  packageNotes?: string;
  orderAmount: string;
  deliveryFee: string;
  prepaidOrderAmount?: string;
  prepaidDeliveryFee?: string;
  prepaidPaymentMethodId?: string | null;
  collectionPaymentMethodId?: string | null;

  /* ---- Parcel Intake (Phase 11.17.4 backend / 11.17.5 frontend) ---- */
  /**
   * The frontend now ALWAYS sends this (the backend's omitted →
   * ALREADY_AT_COMPANY compatibility is for older clients only).
   */
  parcelIntakeMethod: 'ALREADY_AT_COMPANY' | 'DRIVER_COLLECTION';
  /**
   * DRIVER_COLLECTION only — a DISTINCT field from any delivery driver.
   * Assigning here also requires `orders.assign`. Omitted → the order enters
   * "Awaiting Collection Assignment".
   */
  parcelCollectionDriverId?: string | null;
  /**
   * ALREADY_AT_COMPANY only ("Create & Assign Delivery"). The backend rejects
   * it for DRIVER_COLLECTION — the parcel has not reached the company yet.
   */
  deliveryDriverId?: string | null;
  /** DRIVER_COLLECTION collection snapshot overrides (else derived from the customer). */
  parcelCollectionContactName?: string;
  parcelCollectionPhone?: string;
  parcelCollectionAltPhone?: string;
  parcelCollectionAreaId?: string;
  parcelCollectionAddress?: string;
  parcelCollectionNotes?: string;
}

/**
 * PATCH /api/v1/orders/:id body — mirrors `OrderUpdateSchema`
 * (server/src/modules/orders/order.schema.ts). Every field is optional (a
 * PATCH is partial); an omitted field is left unchanged. `null` explicitly
 * CLEARS a nullable field. `orderType` / status / driver / server-owned totals
 * are intentionally absent — they are never editable through this endpoint.
 */
export interface UpdateOrderRequest {
  customerId?: string;
  paymentType?: string;
  receiverName?: string;
  receiverPhone?: string;
  receiverAltPhone?: string | null;
  receiverAreaId?: string;
  receiverAddress?: string;
  receiverBuildingFloor?: string | null;
  receiverMapLink?: string | null;
  receiverInstructions?: string | null;
  description?: string;
  packageCount?: number;
  quantity?: number | null;
  /** Decimal string (kept as text end-to-end), a number, or null to clear. */
  weightKg?: number | string | null;
  packageNotes?: string | null;
  orderAmount?: string;
  deliveryFee?: string;
  prepaidOrderAmount?: string;
  prepaidDeliveryFee?: string;
  prepaidPaymentMethodId?: string | null;
  collectionPaymentMethodId?: string | null;
}

export interface ResolveCollectionDifferenceRequest {
  customerWalletCredit: string;
  companyProductRevenue: string;
  companyDeliveryFeeRevenue: string;
  resolutionNotes: string;
}

export interface ListDriverOrdersParams extends PaginationParams {
  search?: string;
  status?: string;
}

export interface DeliverDriverOrderRequest {
  actualAmountCollected: string;
  collectionDifferenceReason?: string;
}

export interface FailDriverOrderRequest {
  failedReasonId: string;
  notes?: string;
}

export interface ListDriverJobsParams extends PaginationParams {
  /** Omitted = All (both Collection and Delivery) — matches the approved quick-filter set. */
  jobType?: DriverJobType;
}

export interface ListDriverHistoryParams extends PaginationParams {
  /** Omitted = both COMPLETED and FAILED. */
  result?: DriverHistoryResult;
  /** Omitted = All (both Collection and Delivery). */
  jobType?: DriverHistoryJobType;
}

/** POST /driver/orders/:id/parcel-collection/failed body — mirrors FailParcelCollectionSchema. */
export interface FailParcelCollectionRequest {
  failedCollectionReasonId: string;
  notes?: string;
}

/* --------------------- shared invalidation sets --------------------- */

const FINANCIAL_VIEWS = [
  { type: 'Finance', id: 'SUMMARY' },
  { type: 'Finance', id: 'TRANSACTIONS' },
  { type: 'Dashboard', id: 'ROOT' },
  { type: 'Report', id: 'LIST' },
] as const;

/**
 * Shared invalidation for the two Driver Collection Actions (Phase 12.3).
 * Both mutations change the same underlying orders.parcel_collection_status
 * / current_parcel_collection_driver_id fields Management's own
 * parcelCollectionApi.ts mutations change — reusing the identical
 * Order/ParcelCollection/Driver/Dashboard tag set keeps a Management view
 * open in the same browser session correctly fresh too, exactly as safe as
 * any other mutation on this shared `api` tag system. Deliberately NO
 * Finance/Wallet/DriverCash/Report tag — Parcel Collection is financially
 * neutral (never creates a ledger row), so there is nothing there to refresh.
 */
const COLLECTION_JOB_INVALIDATION = (orderId: string) =>
  [
    { type: 'DriverJob' as const, id: `COLLECTION:${orderId}` },
    { type: 'DriverJob' as const, id: 'LIST' },
    // A failed collection becomes Driver history immediately (a successful
    // collection does not — custody is kept until Management confirms
    // company receipt). Refreshing the LIST tag on both is harmless and
    // keeps the Phase 12.5 Failed page fresh.
    { type: 'DriverHistory' as const, id: 'LIST' },
    { type: 'ParcelCollection' as const, id: orderId },
    { type: 'ParcelCollection' as const, id: 'LIST' },
    { type: 'Order' as const, id: orderId },
    { type: 'Order' as const, id: 'LIST' },
    { type: 'Driver' as const, id: 'LIST' },
    { type: 'Dashboard' as const, id: 'ROOT' },
  ] as const;

export const ordersApi = api.injectEndpoints({
  endpoints: (builder) => ({
    /* ===================== Management: Orders ===================== */

    getOrders: builder.query<Paginated<OrderSummary>, ListOrdersParams | void>({
      query: (params) => ({
        url: '/orders',
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (r: ApiListResponse<OrderSummary>) => unwrapList(r),
      providesTags: [{ type: 'Order', id: 'LIST' }],
    }),

    getOrder: builder.query<OrderDetail, string>({
      query: (id) => ({ url: `/orders/${id}` }),
      transformResponse: (r: ApiSuccessResponse<OrderDetail>) => unwrapData(r),
      providesTags: (_res, _err, id) => [{ type: 'Order', id }],
    }),

    getOrderHistory: builder.query<OrderHistoryResponse, string>({
      query: (id) => ({ url: `/orders/${id}/history` }),
      transformResponse: (r: ApiSuccessResponse<OrderHistoryResponse>) =>
        unwrapData(r),
      // Shares the per-order tag: any status/assignment mutation refetches it.
      providesTags: (_res, _err, id) => [{ type: 'Order', id }],
    }),

    /** Unified operational timeline (Phase 11.17.6) — Collection + Delivery events, oldest-first. */
    getOrderTimeline: builder.query<OrderTimelineEvent[], string>({
      query: (id) => ({ url: `/orders/${id}/timeline` }),
      transformResponse: (r: ApiSuccessResponse<OrderTimelineEvent[]>) =>
        unwrapData(r),
      // Shares the per-order tag AND the ParcelCollection tag — a Collection
      // mutation (assign/reassign/reschedule/receive) must refetch this too.
      providesTags: (_res, _err, id) => [
        { type: 'Order', id },
        { type: 'ParcelCollection', id },
      ],
    }),

    createOrder: builder.mutation<OrderDetail, CreateOrderRequest>({
      query: (body) => ({ url: '/orders', method: 'POST', body }),
      transformResponse: (r: ApiSuccessResponse<OrderDetail>) => unwrapData(r),
      // The create is atomic: it can also assign a collection driver
      // (DRIVER_COLLECTION) or a delivery driver (ALREADY_AT_COMPANY), so the
      // Drivers list may be stale too.
      invalidatesTags: [
        { type: 'Order', id: 'LIST' },
        { type: 'Driver', id: 'LIST' },
        { type: 'DriverOrder', id: 'LIST' },
        { type: 'Dashboard', id: 'ROOT' },
        { type: 'Report', id: 'LIST' },
      ],
    }),

    updateOrder: builder.mutation<
      OrderDetail,
      { id: string; body: UpdateOrderRequest }
    >({
      query: ({ id, body }) => ({ url: `/orders/${id}`, method: 'PATCH', body }),
      transformResponse: (r: ApiSuccessResponse<OrderDetail>) => unwrapData(r),
      invalidatesTags: (_res, _err, { id }) => [
        { type: 'Order', id },
        { type: 'Order', id: 'LIST' },
        { type: 'Dashboard', id: 'ROOT' },
        { type: 'Report', id: 'LIST' },
      ],
    }),

    assignOrder: builder.mutation<
      OrderDetail,
      { id: string; driverId: string }
    >({
      query: ({ id, driverId }) => ({
        url: `/orders/${id}/assign`,
        method: 'POST',
        body: { driverId },
      }),
      transformResponse: (r: ApiSuccessResponse<OrderDetail>) => unwrapData(r),
      invalidatesTags: (_res, _err, { id }) => [
        { type: 'Order', id },
        { type: 'Order', id: 'LIST' },
        { type: 'Driver', id: 'LIST' },
        { type: 'DriverOrder', id: 'LIST' },
        { type: 'Dashboard', id: 'ROOT' },
        { type: 'Report', id: 'LIST' },
      ],
    }),

    reassignOrder: builder.mutation<
      OrderDetail,
      { id: string; driverId: string; reason: string }
    >({
      query: ({ id, driverId, reason }) => ({
        url: `/orders/${id}/reassign`,
        method: 'POST',
        body: { driverId, reason },
      }),
      transformResponse: (r: ApiSuccessResponse<OrderDetail>) => unwrapData(r),
      invalidatesTags: (_res, _err, { id }) => [
        { type: 'Order', id },
        { type: 'Order', id: 'LIST' },
        { type: 'Driver', id: 'LIST' },
        { type: 'DriverOrder', id: 'LIST' },
        { type: 'Dashboard', id: 'ROOT' },
        { type: 'Report', id: 'LIST' },
      ],
    }),

    bulkAssignOrders: builder.mutation<
      BulkAssignResult,
      { orderIds: string[]; driverId: string }
    >({
      query: (body) => ({ url: '/orders/bulk-assign', method: 'POST', body }),
      transformResponse: (r: ApiSuccessResponse<BulkAssignResult>) =>
        unwrapData(r),
      invalidatesTags: [
        { type: 'Order', id: 'LIST' },
        { type: 'Driver', id: 'LIST' },
        { type: 'DriverOrder', id: 'LIST' },
        { type: 'Dashboard', id: 'ROOT' },
        { type: 'Report', id: 'LIST' },
      ],
    }),

    readyOrder: builder.mutation<OrderDetail, string>({
      query: (id) => ({ url: `/orders/${id}/ready`, method: 'POST' }),
      transformResponse: (r: ApiSuccessResponse<OrderDetail>) => unwrapData(r),
      invalidatesTags: (_res, _err, id) => [
        { type: 'Order', id },
        { type: 'Order', id: 'LIST' },
        { type: 'Dashboard', id: 'ROOT' },
      ],
    }),

    rescheduleOrder: builder.mutation<
      OrderDetail,
      { id: string; reason: string; notes?: string }
    >({
      query: ({ id, ...body }) => ({
        url: `/orders/${id}/reschedule`,
        method: 'POST',
        body,
      }),
      transformResponse: (r: ApiSuccessResponse<OrderDetail>) => unwrapData(r),
      invalidatesTags: (_res, _err, { id }) => [
        { type: 'Order', id },
        { type: 'Order', id: 'LIST' },
        { type: 'Dashboard', id: 'ROOT' },
        { type: 'Report', id: 'LIST' },
      ],
    }),

    cancelOrder: builder.mutation<
      OrderDetail,
      { id: string; reason: string; notes?: string }
    >({
      query: ({ id, ...body }) => ({
        url: `/orders/${id}/cancel`,
        method: 'POST',
        body,
      }),
      transformResponse: (r: ApiSuccessResponse<OrderDetail>) => unwrapData(r),
      // Cancelling from parcel_collection_status = ASSIGNED closes the open
      // collection assignment (end_reason ORDER_CANCELLED) in the same
      // transaction — refresh the Parcel Collection view.
      invalidatesTags: (_res, _err, { id }) => [
        { type: 'Order', id },
        { type: 'Order', id: 'LIST' },
        { type: 'ParcelCollection', id },
        { type: 'Driver', id: 'LIST' },
        { type: 'Dashboard', id: 'ROOT' },
        { type: 'Report', id: 'LIST' },
      ],
    }),

    // Phase 8.7 cross-ledger Finance action — can create Customer Wallet
    // liability and/or Company revenue. Never touches Driver Cash.
    resolveCollectionDifference: builder.mutation<
      OrderDetail,
      { id: string; body: ResolveCollectionDifferenceRequest }
    >({
      query: ({ id, body }) => ({
        url: `/orders/${id}/resolve-collection-difference`,
        method: 'POST',
        body,
      }),
      transformResponse: (r: ApiSuccessResponse<OrderDetail>) => unwrapData(r),
      invalidatesTags: (_res, _err, { id }) => [
        { type: 'Order', id },
        { type: 'Order', id: 'LIST' },
        { type: 'Wallet', id: 'LIST' },
        { type: 'WalletTransaction', id: 'LIST' },
        ...FINANCIAL_VIEWS,
      ],
    }),

    /* =============== Driver "My Jobs" (Phase 12.1, read-only) =============== */

    getDriverJobs: builder.query<
      Paginated<DriverJobSummary>,
      ListDriverJobsParams | void
    >({
      query: (params) => ({
        url: '/driver/jobs',
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (r: ApiListResponse<DriverJobSummary>) =>
        unwrapList(r),
      providesTags: [{ type: 'DriverJob', id: 'LIST' }],
    }),

    // GET /api/v1/driver/jobs/:jobType/:orderId (Phase 12.2 "Job Detail").
    // jobType arrives here already lowercase (the URL/route convention) and
    // the backend maps it back to COLLECTION/DELIVERY — see
    // driverJobRoute.ts's toDriverJobRouteSegment for the single place the
    // frontend does the reverse mapping when building a link.
    getDriverJobDetail: builder.query<
      DriverJobDetail,
      { jobType: DriverJobType; orderId: string }
    >({
      query: ({ jobType, orderId }) => ({
        url: `/driver/jobs/${jobType.toLowerCase()}/${orderId}`,
      }),
      transformResponse: (r: ApiSuccessResponse<DriverJobDetail>) =>
        unwrapData(r),
      providesTags: (_res, _err, { jobType, orderId }) => [
        { type: 'DriverJob', id: `${jobType}:${orderId}` },
      ],
    }),

    /* ========= Driver Work History (Phase 12.5, read-only) ========= */
    // GET /api/v1/driver/history — the authenticated Driver's own historical
    // COLLECTION + DELIVERY work, one chronological (occurredAt DESC) list,
    // server-paginated. driver.orders.read_own, own-Driver scoped (no
    // client driverId). Backing "Completed" and "Failed / Returned".
    getDriverWorkHistory: builder.query<
      Paginated<DriverWorkHistoryItem>,
      ListDriverHistoryParams | void
    >({
      query: (params) => ({
        url: '/driver/history',
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (r: ApiListResponse<DriverWorkHistoryItem>) =>
        unwrapList(r),
      providesTags: [{ type: 'DriverHistory', id: 'LIST' }],
    }),

    /* ============== Driver Collection Actions (Phase 12.3) ============== */
    // Backend: server/src/modules/parcel-collection — the existing Phase
    // 11.17.3 Driver own-job routes (mounted at /api/v1/driver), unchanged.
    // Financially neutral — no Wallet/DriverCash/Finance tag anywhere below.

    // GET /api/v1/driver/failed-collection-reasons — driver.orders.read_own,
    // NOT /settings/failed-collection-reasons (that needs settings.read,
    // which the Driver role must never hold). Reuses the Management
    // Settings page's own 'FAILED_COLLECTION_REASONS' tag id so an edit
    // made there also invalidates this cached list.
    getDriverFailedCollectionReasons: builder.query<
      DriverFailedCollectionReasonSummary[],
      void
    >({
      query: () => ({ url: '/driver/failed-collection-reasons' }),
      transformResponse: (r: ApiSuccessResponse<DriverFailedCollectionReasonSummary[]>) =>
        unwrapData(r),
      providesTags: [{ type: 'Settings', id: 'FAILED_COLLECTION_REASONS' }],
    }),

    // POST /api/v1/driver/orders/:id/parcel-collection/collected
    // ASSIGNED -> COLLECTED_FROM_SENDER. The job stays current (custody kept)
    // — invalidate rather than remove it from every list/detail view it
    // appears in.
    markParcelCollected: builder.mutation<DriverParcelCollectionResult, string>({
      query: (orderId) => ({
        url: `/driver/orders/${orderId}/parcel-collection/collected`,
        method: 'POST',
      }),
      transformResponse: (r: ApiSuccessResponse<DriverParcelCollectionResult>) =>
        unwrapData(r),
      invalidatesTags: (_res, _err, orderId) => COLLECTION_JOB_INVALIDATION(orderId),
    }),

    // POST /api/v1/driver/orders/:id/parcel-collection/failed
    // ASSIGNED -> FAILED. The job is no longer current for this Driver —
    // same invalidation set; My Jobs/Job Detail both correctly stop
    // returning it once the tagged queries refetch.
    reportParcelCollectionFailed: builder.mutation<
      DriverParcelCollectionResult,
      { orderId: string; body: FailParcelCollectionRequest }
    >({
      query: ({ orderId, body }) => ({
        url: `/driver/orders/${orderId}/parcel-collection/failed`,
        method: 'POST',
        body,
      }),
      transformResponse: (r: ApiSuccessResponse<DriverParcelCollectionResult>) =>
        unwrapData(r),
      invalidatesTags: (_res, _err, { orderId }) => COLLECTION_JOB_INVALIDATION(orderId),
    }),

    /* ================= Driver Delivery Actions (Phase 12.4) ================= */

    // GET /api/v1/driver/failed-delivery-reasons — resolves the Phase
    // 12.1/12.2/12.3-documented blocker. driver.orders.read_own, NOT
    // /settings/failed-delivery-reasons (settings.read). Reuses the
    // Management Settings page's own 'FAILED_DELIVERY_REASONS' tag id so an
    // edit made there also invalidates this cached list.
    getDriverFailedDeliveryReasons: builder.query<
      DriverFailedDeliveryReasonSummary[],
      void
    >({
      query: () => ({ url: '/driver/failed-delivery-reasons' }),
      transformResponse: (r: ApiSuccessResponse<DriverFailedDeliveryReasonSummary[]>) =>
        unwrapData(r),
      providesTags: [{ type: 'Settings', id: 'FAILED_DELIVERY_REASONS' }],
    }),

    /* ================= Driver self-service (Phase 7) ================= */

    getDriverOrders: builder.query<
      Paginated<DriverOrderSummary>,
      ListDriverOrdersParams | void
    >({
      query: (params) => ({
        url: '/driver/me/orders',
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (r: ApiListResponse<DriverOrderSummary>) =>
        unwrapList(r),
      providesTags: [{ type: 'DriverOrder', id: 'LIST' }],
    }),

    getDriverOrder: builder.query<DriverOrderDetail, string>({
      query: (id) => ({ url: `/driver/me/orders/${id}` }),
      transformResponse: (r: ApiSuccessResponse<DriverOrderDetail>) =>
        unwrapData(r),
      providesTags: (_res, _err, id) => [{ type: 'DriverOrder', id }],
    }),

    getDriverCash: builder.query<
      { data: DriverCashOverview; meta: Paginated<never>['meta'] },
      { page?: number; limit?: number; type?: string } | void
    >({
      query: (params) => ({
        url: '/driver/me/cash',
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (r: ApiObjectWithMeta<DriverCashOverview>) =>
        unwrapObjectWithMeta(r),
      providesTags: [{ type: 'DriverCash', id: 'ME' }],
    }),

    // Phase 12.4 — reused unchanged from Phase 7 (identical endpoint, no
    // duplicate query logic). `invalidatesTags` now ALSO covers the Phase
    // 12.1/12.2 DriverJob tag family so the new My Jobs / Job Detail views
    // refresh correctly too — Phase 7's own DriverOrder-tagged views
    // (pre-Phase-12 placeholders) keep working exactly as before.
    pickupDriverOrder: builder.mutation<DriverOrderDetail, string>({
      query: (id) => ({ url: `/driver/orders/${id}/pickup`, method: 'POST' }),
      transformResponse: (r: ApiSuccessResponse<DriverOrderDetail>) =>
        unwrapData(r),
      invalidatesTags: (_res, _err, id) => [
        { type: 'DriverOrder', id },
        { type: 'DriverOrder', id: 'LIST' },
        { type: 'DriverJob', id: `DELIVERY:${id}` },
        { type: 'DriverJob', id: 'LIST' },
        { type: 'Order', id },
        { type: 'Order', id: 'LIST' },
        { type: 'Dashboard', id: 'ROOT' },
      ],
    }),

    startDriverOrderDelivery: builder.mutation<DriverOrderDetail, string>({
      query: (id) => ({
        url: `/driver/orders/${id}/start-delivery`,
        method: 'POST',
      }),
      transformResponse: (r: ApiSuccessResponse<DriverOrderDetail>) =>
        unwrapData(r),
      invalidatesTags: (_res, _err, id) => [
        { type: 'DriverOrder', id },
        { type: 'DriverOrder', id: 'LIST' },
        { type: 'DriverJob', id: `DELIVERY:${id}` },
        { type: 'DriverJob', id: 'LIST' },
        { type: 'Order', id },
        { type: 'Order', id: 'LIST' },
        { type: 'Dashboard', id: 'ROOT' },
      ],
    }),

    failDriverOrder: builder.mutation<
      DriverOrderDetail,
      { id: string; body: FailDriverOrderRequest }
    >({
      query: ({ id, body }) => ({
        url: `/driver/orders/${id}/fail`,
        method: 'POST',
        body,
      }),
      transformResponse: (r: ApiSuccessResponse<DriverOrderDetail>) =>
        unwrapData(r),
      // No financial credit on failure (requirements §19).
      invalidatesTags: (_res, _err, { id }) => [
        { type: 'DriverOrder', id },
        { type: 'DriverOrder', id: 'LIST' },
        { type: 'DriverJob', id: `DELIVERY:${id}` },
        { type: 'DriverJob', id: 'LIST' },
        // The failed attempt is now Driver history (Phase 12.5 Failed page).
        { type: 'DriverHistory', id: 'LIST' },
        { type: 'Order', id },
        { type: 'Order', id: 'LIST' },
        { type: 'Dashboard', id: 'ROOT' },
        { type: 'Report', id: 'LIST' },
      ],
    }),

    deliverDriverOrder: builder.mutation<
      DriverOrderDetail,
      { id: string; body: DeliverDriverOrderRequest }
    >({
      query: ({ id, body }) => ({
        url: `/driver/orders/${id}/deliver`,
        method: 'POST',
        body,
      }),
      transformResponse: (r: ApiSuccessResponse<DriverOrderDetail>) =>
        unwrapData(r),
      // Delivery: Driver Cash always; Customer Wallet for DELIVERY_ONLY;
      // Company delivery-fee revenue; plus Dashboard/Reports. Never a
      // Settlement (that is a separate cash-handover action). Financial tag
      // invalidation is identical to Phase 7/8 — this Driver action can
      // finalize real ledger rows, so Finance/Dashboard/Report must refresh
      // exactly as they already did before Phase 12 existed.
      invalidatesTags: (_res, _err, { id }) => [
        { type: 'DriverOrder', id },
        { type: 'DriverOrder', id: 'LIST' },
        { type: 'DriverJob', id: `DELIVERY:${id}` },
        { type: 'DriverJob', id: 'LIST' },
        // The successful (or failed-difference) attempt is now Driver
        // history (Phase 12.5 Completed page).
        { type: 'DriverHistory', id: 'LIST' },
        { type: 'Order', id },
        { type: 'Order', id: 'LIST' },
        { type: 'DriverCash', id: 'ME' },
        { type: 'Wallet', id: 'LIST' },
        { type: 'WalletTransaction', id: 'LIST' },
        ...FINANCIAL_VIEWS,
      ],
    }),
  }),
});

export const {
  useGetOrdersQuery,
  useGetOrderQuery,
  useGetOrderHistoryQuery,
  useGetOrderTimelineQuery,
  useCreateOrderMutation,
  useUpdateOrderMutation,
  useAssignOrderMutation,
  useReassignOrderMutation,
  useBulkAssignOrdersMutation,
  useReadyOrderMutation,
  useRescheduleOrderMutation,
  useCancelOrderMutation,
  useResolveCollectionDifferenceMutation,
  useGetDriverJobsQuery,
  useGetDriverJobDetailQuery,
  useGetDriverWorkHistoryQuery,
  useGetDriverFailedCollectionReasonsQuery,
  useGetDriverFailedDeliveryReasonsQuery,
  useMarkParcelCollectedMutation,
  useReportParcelCollectionFailedMutation,
  useGetDriverOrdersQuery,
  useGetDriverOrderQuery,
  useGetDriverCashQuery,
  usePickupDriverOrderMutation,
  useStartDriverOrderDeliveryMutation,
  useFailDriverOrderMutation,
  useDeliverDriverOrderMutation,
} = ordersApi;
