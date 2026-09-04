import {
  ORDER_STATUSES,
  ORDER_TYPES,
  PAYMENT_TYPES,
} from '../../../components/orders/orderStatus';
import {
  PARCEL_COLLECTION_STATUSES,
  PARCEL_INTAKE_METHODS,
} from '../../../components/orders/parcelCollection';
import type {
  ListOrdersParams,
  OrderSortBy,
  OrderSortOrder,
} from '../../../services/ordersApi';
import type {
  ParcelCollectionStatus,
  ParcelIntakeMethod,
  WorkflowQueue,
} from '../../../services/domain.types';
import type { SortState } from '../../../components/data-display/DataTable';

/**
 * URL search params ARE the source of truth for the Orders list state
 * (search / filters / sort / page). This module parses `URLSearchParams` into a
 * typed model and serializes it back — with typed whitelists for every enum so
 * a hand-edited URL can never crash React or build a malformed backend request.
 *
 * The backend `ListOrdersQuerySchema` (Phase 6.3 + its correction) accepts:
 *   search, page, status, orderType, paymentType, paymentMethodId,
 *   deliveryStatus, financialStatus, customerId, driverId, areaId,
 *   assignmentStatus, needsFinancialReview, createdFrom, createdTo,
 *   sortBy, sortOrder.
 *
 * Dates are bare YYYY-MM-DD — the backend interprets `createdTo` as the WHOLE
 * UTC day (`created_at < next-day 00:00Z`); no client end-of-day math.
 *
 * Sort: when `sortBy` is empty the backend default (createdAt DESC, id DESC
 * tiebreaker) applies and no sort params are written to the URL. A custom sort
 * writes both `sortBy` and `sortOrder`.
 */

const STATUS_SET = new Set<string>(ORDER_STATUSES);
const ORDER_TYPE_SET = new Set<string>(ORDER_TYPES);
const PAYMENT_TYPE_SET = new Set<string>(PAYMENT_TYPES);
const ASSIGNMENT_SET = new Set(['ASSIGNED', 'UNASSIGNED']);
const DELIVERY_STATUS_SET = new Set(['DELIVERED', 'UNDELIVERED']);
const PARCEL_INTAKE_METHOD_SET = new Set<string>(PARCEL_INTAKE_METHODS);
const PARCEL_COLLECTION_STATUS_SET = new Set<string>(PARCEL_COLLECTION_STATUSES);
const WORKFLOW_QUEUE_SET = new Set<string>([
  'AWAITING_COLLECTION_ASSIGNMENT',
  'COLLECTION_IN_PROGRESS',
  'COLLECTION_ATTENTION',
  'AWAITING_COMPANY_RECEIPT',
  'READY_FOR_DELIVERY_ASSIGNMENT',
]);
const FINANCIAL_STATUS_SET = new Set([
  'PENDING',
  'FINALIZED',
  'REVIEW_REQUIRED',
  'NOT_APPLICABLE',
]);
const SORT_BY_SET = new Set<string>([
  'createdAt',
  'orderNumber',
  'status',
  'orderAmount',
  'deliveryFee',
  'amountToCollect',
  'deliveredAt',
]);
const SORT_ORDER_SET = new Set(['asc', 'desc']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface OrdersListState {
  search: string;
  page: number;
  status: string;
  orderType: string;
  paymentType: string;
  paymentMethodId: string;
  deliveryStatus: '' | 'DELIVERED' | 'UNDELIVERED';
  financialStatus: string;
  customerId: string;
  driverId: string;
  areaId: string;
  assignmentStatus: '' | 'ASSIGNED' | 'UNASSIGNED';
  needsFinancialReview: boolean;
  // Parcel Intake / Collection filters (Phase 11.17.6).
  parcelIntakeMethod: '' | ParcelIntakeMethod;
  parcelCollectionStatus: '' | ParcelCollectionStatus;
  parcelCollectionDriverId: string;
  workflowQueue: '' | WorkflowQueue;
  createdFrom: string;
  createdTo: string;
  sortBy: '' | OrderSortBy;
  sortOrder: '' | OrderSortOrder;
}

export const EMPTY_ORDERS_STATE: OrdersListState = {
  search: '',
  page: 1,
  status: '',
  orderType: '',
  paymentType: '',
  paymentMethodId: '',
  deliveryStatus: '',
  financialStatus: '',
  customerId: '',
  driverId: '',
  areaId: '',
  assignmentStatus: '',
  needsFinancialReview: false,
  parcelIntakeMethod: '',
  parcelCollectionStatus: '',
  parcelCollectionDriverId: '',
  workflowQueue: '',
  createdFrom: '',
  createdTo: '',
  sortBy: '',
  sortOrder: '',
};

const pick = (raw: string | null, allowed: Set<string>): string =>
  raw && allowed.has(raw) ? raw : '';

export function parseOrdersListParams(sp: URLSearchParams): OrdersListState {
  const pageRaw = Number(sp.get('page'));
  const assignment = sp.get('assignmentStatus');
  const delivery = sp.get('deliveryStatus');
  const sortByRaw = sp.get('sortBy');
  const sortOrderRaw = sp.get('sortOrder');
  const sortBy = (sortByRaw && SORT_BY_SET.has(sortByRaw) ? sortByRaw : '') as
    | ''
    | OrderSortBy;
  return {
    search: sp.get('search')?.slice(0, 200) ?? '',
    page: Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
    status: pick(sp.get('status'), STATUS_SET),
    orderType: pick(sp.get('orderType'), ORDER_TYPE_SET),
    paymentType: pick(sp.get('paymentType'), PAYMENT_TYPE_SET),
    // Opaque id — the backend validates the UUID and stays authoritative.
    paymentMethodId: sp.get('paymentMethodId') ?? '',
    deliveryStatus:
      delivery && DELIVERY_STATUS_SET.has(delivery)
        ? (delivery as 'DELIVERED' | 'UNDELIVERED')
        : '',
    financialStatus: pick(sp.get('financialStatus'), FINANCIAL_STATUS_SET),
    customerId: sp.get('customerId') ?? '',
    driverId: sp.get('driverId') ?? '',
    areaId: sp.get('areaId') ?? '',
    assignmentStatus:
      assignment && ASSIGNMENT_SET.has(assignment)
        ? (assignment as 'ASSIGNED' | 'UNASSIGNED')
        : '',
    needsFinancialReview: sp.get('needsFinancialReview') === 'true',
    parcelIntakeMethod: pick(
      sp.get('parcelIntakeMethod'),
      PARCEL_INTAKE_METHOD_SET,
    ) as '' | ParcelIntakeMethod,
    parcelCollectionStatus: pick(
      sp.get('parcelCollectionStatus'),
      PARCEL_COLLECTION_STATUS_SET,
    ) as '' | ParcelCollectionStatus,
    // Opaque id — the backend validates the UUID and stays authoritative.
    parcelCollectionDriverId: sp.get('parcelCollectionDriverId') ?? '',
    workflowQueue: pick(sp.get('workflowQueue'), WORKFLOW_QUEUE_SET) as
      | ''
      | WorkflowQueue,
    createdFrom: DATE_RE.test(sp.get('createdFrom') ?? '')
      ? (sp.get('createdFrom') as string)
      : '',
    createdTo: DATE_RE.test(sp.get('createdTo') ?? '')
      ? (sp.get('createdTo') as string)
      : '',
    sortBy,
    // sortOrder only meaningful alongside a valid sortBy.
    sortOrder: sortBy && sortOrderRaw && SORT_ORDER_SET.has(sortOrderRaw)
      ? (sortOrderRaw as OrderSortOrder)
      : sortBy
        ? 'desc'
        : '',
  };
}

/** Serialize to URLSearchParams — defaults (page 1, empty values, default sort) omitted. */
export function serializeOrdersListParams(
  state: OrdersListState,
): URLSearchParams {
  const sp = new URLSearchParams();
  if (state.search) sp.set('search', state.search);
  if (state.page > 1) sp.set('page', String(state.page));
  if (state.status) sp.set('status', state.status);
  if (state.orderType) sp.set('orderType', state.orderType);
  if (state.paymentType) sp.set('paymentType', state.paymentType);
  if (state.paymentMethodId) sp.set('paymentMethodId', state.paymentMethodId);
  if (state.deliveryStatus) sp.set('deliveryStatus', state.deliveryStatus);
  if (state.financialStatus) sp.set('financialStatus', state.financialStatus);
  if (state.customerId) sp.set('customerId', state.customerId);
  if (state.driverId) sp.set('driverId', state.driverId);
  if (state.areaId) sp.set('areaId', state.areaId);
  if (state.assignmentStatus) sp.set('assignmentStatus', state.assignmentStatus);
  if (state.needsFinancialReview) sp.set('needsFinancialReview', 'true');
  if (state.parcelIntakeMethod) sp.set('parcelIntakeMethod', state.parcelIntakeMethod);
  if (state.parcelCollectionStatus) sp.set('parcelCollectionStatus', state.parcelCollectionStatus);
  if (state.parcelCollectionDriverId) sp.set('parcelCollectionDriverId', state.parcelCollectionDriverId);
  if (state.workflowQueue) sp.set('workflowQueue', state.workflowQueue);
  if (state.createdFrom) sp.set('createdFrom', state.createdFrom);
  if (state.createdTo) sp.set('createdTo', state.createdTo);
  if (state.sortBy) {
    sp.set('sortBy', state.sortBy);
    sp.set('sortOrder', state.sortOrder || 'desc');
  }
  return sp;
}

/** RTK Query args for the current state (empty -> undefined, dropped by cleanParams). */
export function toListOrdersParams(state: OrdersListState): ListOrdersParams {
  return {
    page: state.page,
    search: state.search || undefined,
    status: state.status || undefined,
    orderType: state.orderType || undefined,
    paymentType: state.paymentType || undefined,
    paymentMethodId: state.paymentMethodId || undefined,
    deliveryStatus: state.deliveryStatus || undefined,
    financialStatus: state.financialStatus || undefined,
    customerId: state.customerId || undefined,
    driverId: state.driverId || undefined,
    areaId: state.areaId || undefined,
    assignmentStatus: state.assignmentStatus || undefined,
    needsFinancialReview: state.needsFinancialReview || undefined,
    parcelIntakeMethod: state.parcelIntakeMethod || undefined,
    parcelCollectionStatus: state.parcelCollectionStatus || undefined,
    parcelCollectionDriverId: state.parcelCollectionDriverId || undefined,
    workflowQueue: state.workflowQueue || undefined,
    createdFrom: state.createdFrom || undefined,
    createdTo: state.createdTo || undefined,
    sortBy: state.sortBy || undefined,
    sortOrder: state.sortBy ? state.sortOrder || 'desc' : undefined,
  };
}

const FILTER_KEYS: readonly (keyof OrdersListState)[] = [
  'search',
  'status',
  'orderType',
  'paymentType',
  'paymentMethodId',
  'deliveryStatus',
  'financialStatus',
  'customerId',
  'driverId',
  'areaId',
  'assignmentStatus',
  'needsFinancialReview',
  'parcelIntakeMethod',
  'parcelCollectionStatus',
  'parcelCollectionDriverId',
  'workflowQueue',
  'createdFrom',
  'createdTo',
];

/**
 * True when any SEARCH/FILTER dimension is active. Sorting and page are list
 * configuration, not filters — they never make "Clear filters" appear.
 */
export function hasActiveFilters(state: OrdersListState): boolean {
  return FILTER_KEYS.some((k) => state[k] !== '' && state[k] !== false);
}

/* --------------------------------- sort --------------------------------- */

/** DataTable column id -> backend sortBy (only these columns are sortable). */
export const COLUMN_SORT_BY: Readonly<Record<string, OrderSortBy>> = {
  order: 'orderNumber',
  status: 'status',
  orderAmount: 'orderAmount',
  deliveryFee: 'deliveryFee',
  collect: 'amountToCollect',
  created: 'createdAt',
  delivered: 'deliveredAt',
};

const SORT_BY_COLUMN: Readonly<Record<OrderSortBy, string>> = Object.fromEntries(
  Object.entries(COLUMN_SORT_BY).map(([col, by]) => [by, col]),
) as Record<OrderSortBy, string>;

/**
 * The DataTable `SortState` for the current URL state. When no custom sort is
 * set, returns the backend default (Created, descending) so the table still
 * shows the user how the list is currently ordered — without writing default
 * params to the URL.
 */
export function getSortState(state: OrdersListState): SortState {
  if (state.sortBy) {
    return {
      columnId: SORT_BY_COLUMN[state.sortBy],
      direction: state.sortOrder || 'desc',
    };
  }
  return { columnId: 'created', direction: 'desc' };
}

/** Apply a DataTable sort click: map column -> sortBy, keep direction, reset page. */
export function applySort(
  state: OrdersListState,
  next: SortState,
): OrdersListState {
  const sortBy = COLUMN_SORT_BY[next.columnId];
  if (!sortBy) return state;
  return { ...state, sortBy, sortOrder: next.direction, page: 1 };
}

/* --------------------------- quick status tabs --------------------------- */

export type QuickTabId =
  | 'all'
  | 'readyForDelivery'
  | 'awaitingCollection'
  | 'ready'
  | 'assigned'
  | 'out'
  | 'delivered'
  | 'failed';

export interface QuickTab {
  id: QuickTabId;
  label: string;
  /** The status/assignment/workflowQueue dimensions this tab sets (others are cleared). */
  status: string;
  assignmentStatus: '' | 'ASSIGNED' | 'UNASSIGNED';
  workflowQueue: '' | WorkflowQueue;
}

// Phase 11.17.6 (task §19) — the old generic "Unassigned" tab
// (assignmentStatus=UNASSIGNED alone) wrongly treated a Collection-in-
// progress order (which also has no DELIVERY driver yet) as a delivery-
// assignment problem. Replaced by two server-backed workflowQueue tabs:
// "Ready for Delivery" (the real delivery-assignment queue) and "Awaiting
// Collection" (the real collection-assignment queue) — never conflated.
export const QUICK_TABS: readonly QuickTab[] = [
  { id: 'all', label: 'All', status: '', assignmentStatus: '', workflowQueue: '' },
  {
    id: 'readyForDelivery',
    label: 'Ready for Delivery',
    status: '',
    assignmentStatus: '',
    workflowQueue: 'READY_FOR_DELIVERY_ASSIGNMENT',
  },
  {
    id: 'awaitingCollection',
    label: 'Awaiting Collection',
    status: '',
    assignmentStatus: '',
    workflowQueue: 'AWAITING_COLLECTION_ASSIGNMENT',
  },
  { id: 'ready', label: 'Ready for Pickup', status: 'READY_FOR_PICKUP', assignmentStatus: '', workflowQueue: '' },
  { id: 'assigned', label: 'Assigned', status: 'ASSIGNED', assignmentStatus: '', workflowQueue: '' },
  { id: 'out', label: 'Out for Delivery', status: 'OUT_FOR_DELIVERY', assignmentStatus: '', workflowQueue: '' },
  { id: 'delivered', label: 'Delivered', status: 'DELIVERED', assignmentStatus: '', workflowQueue: '' },
  { id: 'failed', label: 'Failed', status: 'FAILED_DELIVERY', assignmentStatus: '', workflowQueue: '' },
];

/**
 * Active tab derived purely from URL state. The quick "Delivered" tab uses the
 * precise `status=DELIVERED` (unchanged) — this is deliberately distinct from
 * the explicit "Delivery status" filter, which uses the `deliveryStatus`
 * param (DELIVERED / UNDELIVERED). Returns null when a status/queue filter is
 * active that no tab represents (e.g. RESCHEDULED, or the detailed
 * parcelCollectionStatus filter).
 */
export function getActiveQuickTab(state: OrdersListState): QuickTabId | null {
  for (const tab of QUICK_TABS) {
    if (
      tab.status === state.status &&
      tab.assignmentStatus === state.assignmentStatus &&
      tab.workflowQueue === state.workflowQueue
    ) {
      return tab.id;
    }
  }
  return null;
}

/** Apply a quick tab: set its status/assignment/workflowQueue dims, clear the others, keep the rest, reset page. */
export function applyQuickTab(
  state: OrdersListState,
  tab: QuickTab,
): OrdersListState {
  return {
    ...state,
    status: tab.status,
    assignmentStatus: tab.assignmentStatus,
    workflowQueue: tab.workflowQueue,
    page: 1,
  };
}
