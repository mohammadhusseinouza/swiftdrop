import {
  ORDER_STATUSES,
  ORDER_TYPES,
} from '../../../components/orders/orderStatus';
import {
  PARCEL_COLLECTION_STATUSES,
  PARCEL_INTAKE_METHODS,
} from '../../../components/orders/parcelCollection';
import type {
  ParcelCollectionStatus,
  ParcelIntakeMethod,
} from '../../../services/domain.types';

/**
 * URL state for the single Reports route. `report` picks the group;
 * `from`/`to` are shared across all four. Every other param is report-specific
 * and is dropped when the group changes (see `switchReportParams`).
 *
 * Only parameters the matching backend endpoint actually accepts are ever
 * written — see server/src/modules/reports/report.schema.ts:
 *   orders    : from,to,groupBy,bucket,customerId,driverId,areaId,status,orderType
 *   drivers   : from,to,driverId,isActive
 *   customers : from,to,customerId,isActive,areaId
 *   finance   : from,to,groupBy   (day|week|month|category)
 * Dates are whole UTC calendar days; there is no pagination and no sort.
 */

export const REPORT_GROUPS = [
  'orders',
  'drivers',
  'customers',
  'financial',
] as const;
export type ReportGroup = (typeof REPORT_GROUPS)[number];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ORDER_REPORT_GROUP_BY = [
  'date',
  'customer',
  'driver',
  'area',
  'status',
  'type',
  'outcome',
] as const;
export type OrderReportGroupByOpt = (typeof ORDER_REPORT_GROUP_BY)[number];

export const ORDER_REPORT_BUCKET = ['day', 'week', 'month'] as const;
export const FINANCE_REPORT_GROUP_BY = [
  'month',
  'week',
  'day',
  'category',
] as const;

export function parseReportGroup(sp: URLSearchParams): ReportGroup {
  const r = sp.get('report');
  return (REPORT_GROUPS as readonly string[]).includes(r ?? '')
    ? (r as ReportGroup)
    : 'orders';
}

export function parseDateRange(sp: URLSearchParams): { from: string; to: string } {
  return {
    from: DATE_RE.test(sp.get('from') ?? '') ? (sp.get('from') as string) : '',
    to: DATE_RE.test(sp.get('to') ?? '') ? (sp.get('to') as string) : '',
  };
}

const pickEnum = (
  sp: URLSearchParams,
  key: string,
  allowed: readonly string[],
): string => {
  const v = sp.get(key);
  return v && allowed.includes(v) ? v : '';
};
const pickUuid = (sp: URLSearchParams, key: string): string => {
  const v = sp.get(key) ?? '';
  return UUID_RE.test(v) ? v : '';
};
const pickBool = (sp: URLSearchParams, key: string): '' | 'true' | 'false' => {
  const v = sp.get(key);
  return v === 'true' || v === 'false' ? v : '';
};

export interface OrdersReportState {
  groupBy: OrderReportGroupByOpt;
  bucket: (typeof ORDER_REPORT_BUCKET)[number];
  status: string;
  orderType: string;
  areaId: string;
  customerId: string;
  driverId: string;
  parcelIntakeMethod: '' | ParcelIntakeMethod;
  parcelCollectionStatus: '' | ParcelCollectionStatus;
  parcelCollectionDriverId: string;
}
export function parseOrdersReportState(sp: URLSearchParams): OrdersReportState {
  const groupBy = (pickEnum(sp, 'groupBy', ORDER_REPORT_GROUP_BY) ||
    'date') as OrderReportGroupByOpt;
  const bucket = (pickEnum(sp, 'bucket', ORDER_REPORT_BUCKET) ||
    'day') as (typeof ORDER_REPORT_BUCKET)[number];
  return {
    groupBy,
    bucket,
    status: pickEnum(sp, 'status', ORDER_STATUSES),
    orderType: pickEnum(sp, 'orderType', ORDER_TYPES),
    areaId: pickUuid(sp, 'areaId'),
    customerId: pickUuid(sp, 'customerId'),
    driverId: pickUuid(sp, 'driverId'),
    parcelIntakeMethod: pickEnum(sp, 'parcelIntakeMethod', PARCEL_INTAKE_METHODS) as
      | ''
      | ParcelIntakeMethod,
    parcelCollectionStatus: pickEnum(
      sp,
      'parcelCollectionStatus',
      PARCEL_COLLECTION_STATUSES,
    ) as '' | ParcelCollectionStatus,
    parcelCollectionDriverId: pickUuid(sp, 'parcelCollectionDriverId'),
  };
}

export interface DriversReportState {
  driverId: string;
  isActive: '' | 'true' | 'false';
}
export function parseDriversReportState(sp: URLSearchParams): DriversReportState {
  return { driverId: pickUuid(sp, 'driverId'), isActive: pickBool(sp, 'isActive') };
}

export interface CustomersReportState {
  customerId: string;
  isActive: '' | 'true' | 'false';
  areaId: string;
}
export function parseCustomersReportState(
  sp: URLSearchParams,
): CustomersReportState {
  return {
    customerId: pickUuid(sp, 'customerId'),
    isActive: pickBool(sp, 'isActive'),
    areaId: pickUuid(sp, 'areaId'),
  };
}

export function parseFinancialReportGroupBy(
  sp: URLSearchParams,
): (typeof FINANCE_REPORT_GROUP_BY)[number] {
  return (pickEnum(sp, 'groupBy', FINANCE_REPORT_GROUP_BY) ||
    'month') as (typeof FINANCE_REPORT_GROUP_BY)[number];
}

/** Switch report group: keep `report` + shared date range, drop everything else. */
export function switchReportParams(
  sp: URLSearchParams,
  group: ReportGroup,
): URLSearchParams {
  const next = new URLSearchParams();
  next.set('report', group);
  const { from, to } = parseDateRange(sp);
  if (from) next.set('from', from);
  if (to) next.set('to', to);
  return next;
}

/** Merge a patch into the current params (used within one report group). */
export function patchReportParams(
  sp: URLSearchParams,
  patch: Record<string, string | undefined>,
): URLSearchParams {
  const next = new URLSearchParams(sp);
  for (const [k, v] of Object.entries(patch)) {
    if (v) next.set(k, v);
    else next.delete(k);
  }
  return next;
}
