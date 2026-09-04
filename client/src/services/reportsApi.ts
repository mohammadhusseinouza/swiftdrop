import { api } from './api';
import { cleanParams } from './queryParams';
import { unwrapData } from './unwrap';
import type { ApiSuccessResponse } from './apiTypes';
import type {
  CustomerReportDto,
  DriverReportDto,
  FinanceReportDto,
  OrderReportDto,
  ParcelCollectionStatus,
  ParcelIntakeMethod,
} from './domain.types';

/**
 * Reports (Phase 9.3). Backend: server/src/modules/reports — four aggregate
 * read endpoints, all `reports.read`-gated. No mutations.
 */

interface DateRangeParams {
  from?: string;
  to?: string;
}

export interface OrderReportParams extends DateRangeParams {
  groupBy?:
    | 'date'
    | 'customer'
    | 'driver'
    | 'area'
    | 'status'
    | 'type'
    | 'outcome';
  bucket?: 'day' | 'week' | 'month';
  customerId?: string;
  driverId?: string;
  areaId?: string;
  status?: string;
  orderType?: string;
  /** Parcel Intake / Collection filters (Phase 11.17.6), independent of OrderType. */
  parcelIntakeMethod?: ParcelIntakeMethod;
  parcelCollectionStatus?: ParcelCollectionStatus;
  /** CURRENT collection work only. */
  parcelCollectionDriverId?: string;
}
export interface DriverReportParams extends DateRangeParams {
  driverId?: string;
  isActive?: boolean;
}
export interface CustomerReportParams extends DateRangeParams {
  customerId?: string;
  isActive?: boolean;
  areaId?: string;
}
export interface FinanceReportParams extends DateRangeParams {
  groupBy?: 'day' | 'week' | 'month' | 'category';
}

export const reportsApi = api.injectEndpoints({
  endpoints: (builder) => ({
    getOrderReport: builder.query<OrderReportDto, OrderReportParams | void>({
      query: (params) => ({
        url: '/reports/orders',
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (r: ApiSuccessResponse<OrderReportDto>) =>
        unwrapData(r),
      providesTags: [{ type: 'Report', id: 'LIST' }],
    }),

    getDriverReport: builder.query<DriverReportDto, DriverReportParams | void>({
      query: (params) => ({
        url: '/reports/drivers',
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (r: ApiSuccessResponse<DriverReportDto>) =>
        unwrapData(r),
      providesTags: [{ type: 'Report', id: 'LIST' }],
    }),

    getCustomerReport: builder.query<
      CustomerReportDto,
      CustomerReportParams | void
    >({
      query: (params) => ({
        url: '/reports/customers',
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (r: ApiSuccessResponse<CustomerReportDto>) =>
        unwrapData(r),
      providesTags: [{ type: 'Report', id: 'LIST' }],
    }),

    getFinanceReport: builder.query<
      FinanceReportDto,
      FinanceReportParams | void
    >({
      query: (params) => ({
        url: '/reports/finance',
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (r: ApiSuccessResponse<FinanceReportDto>) =>
        unwrapData(r),
      providesTags: [{ type: 'Report', id: 'LIST' }],
    }),
  }),
});

export const {
  useGetOrderReportQuery,
  useGetDriverReportQuery,
  useGetCustomerReportQuery,
  useGetFinanceReportQuery,
} = reportsApi;
