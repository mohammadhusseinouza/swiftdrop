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
  DriverDeliveryHistoryRow,
  DriverDetail,
  DriverSummary,
  ManagementDriverCashDetail,
  ManagementDriverCashSummary,
  ManagementDriverCashTransactionEntry,
  OrderSummary,
} from './domain.types';

/**
 * Drivers (Phase 5.2 + Phase 11.7 correction). Backend: server/src/modules/drivers.
 * `create`/`update` are gated by `drivers.manage` (ADMIN only); list/detail and
 * the driver-scoped current-orders / delivery-history by `drivers.read` /
 * `orders.read`. The Management Driver Cash endpoints live under `/finance` and
 * are `finance.read` — drivers.read is never a bypass around finance perms.
 */

export interface ListDriversParams extends PaginationParams {
  search?: string;
  isActive?: boolean;
}

/** New-login mode — creates a fresh DRIVER-role login + driver atomically. */
export interface CreateDriverNewLoginRequest {
  driverNumber: string;
  user: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    phone?: string;
  };
}
/** Legacy mode — links an existing DRIVER-role user. */
export interface CreateDriverLinkRequest {
  driverNumber: string;
  userId: string;
}
export type CreateDriverRequest =
  | CreateDriverNewLoginRequest
  | CreateDriverLinkRequest;

export interface UpdateDriverRequest {
  isActive?: boolean;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string | null;
}

export interface DriverWorkListParams extends PaginationParams {
  id: string;
}

export const driversApi = api.injectEndpoints({
  endpoints: (builder) => ({
    getDrivers: builder.query<
      Paginated<DriverSummary>,
      ListDriversParams | void
    >({
      query: (params) => ({
        url: '/drivers',
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (r: ApiListResponse<DriverSummary>) => unwrapList(r),
      providesTags: [{ type: 'Driver', id: 'LIST' }],
    }),

    getDriver: builder.query<DriverDetail, string>({
      query: (id) => ({ url: `/drivers/${id}` }),
      transformResponse: (r: ApiSuccessResponse<DriverDetail>) => unwrapData(r),
      providesTags: (_res, _err, id) => [{ type: 'Driver', id }],
    }),

    createDriver: builder.mutation<DriverDetail, CreateDriverRequest>({
      query: (body) => ({ url: '/drivers', method: 'POST', body }),
      transformResponse: (r: ApiSuccessResponse<DriverDetail>) => unwrapData(r),
      invalidatesTags: [{ type: 'Driver', id: 'LIST' }],
    }),

    updateDriver: builder.mutation<
      DriverDetail,
      { id: string; body: UpdateDriverRequest }
    >({
      query: ({ id, body }) => ({ url: `/drivers/${id}`, method: 'PATCH', body }),
      transformResponse: (r: ApiSuccessResponse<DriverDetail>) => unwrapData(r),
      invalidatesTags: (_res, _err, { id }) => [
        { type: 'Driver', id },
        { type: 'Driver', id: 'LIST' },
      ],
    }),

    /** Driver-scoped CURRENT active work (orders.read). */
    getDriverCurrentOrders: builder.query<
      Paginated<OrderSummary>,
      DriverWorkListParams
    >({
      query: ({ id, ...params }) => ({
        url: `/drivers/${id}/current-orders`,
        params: cleanParams({ ...params }),
      }),
      transformResponse: (r: ApiListResponse<OrderSummary>) => unwrapList(r),
      providesTags: (_res, _err, { id }) => [
        { type: 'Order', id: 'LIST' },
        { type: 'Driver', id },
      ],
    }),

    /** Driver-scoped HISTORICAL delivery work (orders.read). */
    getDriverDeliveryHistory: builder.query<
      Paginated<DriverDeliveryHistoryRow>,
      DriverWorkListParams
    >({
      query: ({ id, ...params }) => ({
        url: `/drivers/${id}/delivery-history`,
        params: cleanParams({ ...params }),
      }),
      transformResponse: (r: ApiListResponse<DriverDeliveryHistoryRow>) =>
        unwrapList(r),
      providesTags: [{ type: 'Order', id: 'LIST' }],
    }),

    /** Management Driver Cash balance (finance.read). */
    getManagementDriverCash: builder.query<ManagementDriverCashDetail, string>({
      query: (driverId) => ({ url: `/finance/driver-cash/${driverId}` }),
      transformResponse: (r: ApiSuccessResponse<ManagementDriverCashDetail>) =>
        unwrapData(r),
      providesTags: (_res, _err, driverId) => [
        { type: 'DriverCash', id: driverId },
      ],
    }),

    /** Management Driver Cash ledger (finance.read), server-paginated. */
    getManagementDriverCashTransactions: builder.query<
      Paginated<ManagementDriverCashTransactionEntry>,
      DriverWorkListParams
    >({
      query: ({ id, ...params }) => ({
        url: `/finance/driver-cash/${id}/transactions`,
        params: cleanParams({ ...params }),
      }),
      transformResponse: (
        r: ApiListResponse<ManagementDriverCashTransactionEntry>,
      ) => unwrapList(r),
      providesTags: (_res, _err, { id }) => [{ type: 'DriverCash', id }],
    }),

    /** Batched Cash-Held for a page of the Driver List (finance.read). */
    getDriverCashSummaries: builder.query<
      ManagementDriverCashSummary[],
      string[]
    >({
      query: (driverIds) => ({
        url: '/finance/driver-cash/summaries',
        params: { driverIds: driverIds.join(',') },
      }),
      transformResponse: (r: ApiSuccessResponse<ManagementDriverCashSummary[]>) =>
        unwrapData(r),
      providesTags: [{ type: 'DriverCash', id: 'SUMMARIES' }],
    }),
  }),
});

export const {
  useGetDriversQuery,
  useGetDriverQuery,
  useCreateDriverMutation,
  useUpdateDriverMutation,
  useGetDriverCurrentOrdersQuery,
  useGetDriverDeliveryHistoryQuery,
  useGetManagementDriverCashQuery,
  useGetManagementDriverCashTransactionsQuery,
  useGetDriverCashSummariesQuery,
} = driversApi;
