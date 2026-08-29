import { api } from './api';
import { cleanParams } from './queryParams';
import { unwrapData, unwrapList } from './unwrap';
import type {
  ApiListResponse,
  ApiSuccessResponse,
  Paginated,
  PaginationParams,
} from './apiTypes';
import type { DriverDetail, DriverSummary } from './domain.types';

/**
 * Drivers (Phase 5.2). Backend: server/src/modules/drivers.
 * `create`/`update` are gated by `drivers.manage`; list/detail by `drivers.read`.
 * A driver mutation invalidates only Driver caches — assignment views refetch
 * on their own assignment mutations.
 */

export interface ListDriversParams extends PaginationParams {
  search?: string;
  isActive?: boolean;
}

export interface CreateDriverRequest {
  driverNumber: string;
  userId: string;
}

export interface UpdateDriverRequest {
  isActive?: boolean;
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
  }),
});

export const {
  useGetDriversQuery,
  useGetDriverQuery,
  useCreateDriverMutation,
  useUpdateDriverMutation,
} = driversApi;
