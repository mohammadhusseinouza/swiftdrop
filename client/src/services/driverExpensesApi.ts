import type { FetchBaseQueryError } from '@reduxjs/toolkit/query';
import { api } from './api';
import { cleanParams } from './queryParams';
import { unwrapData, unwrapList } from './unwrap';
import { ALL_DRIVERS_PAGE_SIZE, loadAllExpenseDrivers } from './driverExpensesPaging';
import type {
  ApiListResponse,
  ApiSuccessResponse,
  Paginated,
  PaginationParams,
} from './apiTypes';
import type {
  DailyExpenseDetail,
  DriverExpenseDriverReportRow,
  DriverExpenseReportSummary,
  DriverExpenseTrendRow,
  DriverExpenseVehicleReportRow,
  ExpenseDriverSummary,
  ExpenseProfileDetail,
  ExpenseVehicleType,
  FuelSettingsDetail,
  FuelSettingsResolution,
} from './domain.types';

/**
 * Driver Expenses (admin-only, independent module).
 * Backend: server/src/modules/driver-expenses — every route is ADMIN-only
 * server-side. Nothing here touches Finance, Driver Cash, Settlements,
 * Wallets, Payouts or Orders, so no tag of those domains is ever invalidated.
 */

export interface ListExpenseDriversParams extends PaginationParams {
  search?: string;
  isActive?: boolean;
}

export interface CreateFuelSettingsRequest {
  pricePer20Liters: string;
  motorcycleConsumptionLPer100Km: string;
  carConsumptionLPer100Km: string;
  effectiveFrom: string;
}

export interface CreateDailyExpenseRequest {
  driverId: string;
  expenseDate: string;
  distanceKm: string;
  vehicleType?: ExpenseVehicleType;
  notes?: string | null;
}

export interface UpdateDailyExpenseRequest {
  expectedUpdatedAt: string;
  distanceKm?: string;
  vehicleType?: ExpenseVehicleType;
  notes?: string | null;
}


/** Report filters — an inclusive YYYY-MM-DD range plus optional driver / saved vehicle. */
export interface DriverExpenseReportParams {
  from: string;
  to: string;
  driverId?: string;
  vehicleType?: ExpenseVehicleType;
}

export interface DriverExpenseDriverReportParams extends DriverExpenseReportParams, PaginationParams {
  sortBy?: 'name' | 'distance' | 'expense';
  sortOrder?: 'asc' | 'desc';
}

const REPORT_TAG = [{ type: 'DriverExpenseReport' as const, id: 'ALL' }];

export const driverExpensesApi = api.injectEndpoints({
  endpoints: (builder) => ({
    /* ----------------------------- fuel settings ----------------------------- */
    getCurrentFuelSettings: builder.query<FuelSettingsResolution, void>({
      query: () => ({ url: '/driver-expenses/fuel-settings/current' }),
      transformResponse: (r: ApiSuccessResponse<FuelSettingsResolution>) => unwrapData(r),
      providesTags: [{ type: 'FuelSettings', id: 'CURRENT' }],
    }),

    /** The version effective on a YYYY-MM-DD date (never "today's" price). */
    getEffectiveFuelSettings: builder.query<FuelSettingsResolution, string>({
      query: (date) => ({ url: '/driver-expenses/fuel-settings/effective', params: { date } }),
      transformResponse: (r: ApiSuccessResponse<FuelSettingsResolution>) => unwrapData(r),
      providesTags: (_res, _err, date) => [{ type: 'FuelSettings', id: `EFFECTIVE:${date}` }],
    }),

    getFuelSettingsHistory: builder.query<Paginated<FuelSettingsDetail>, PaginationParams | void>({
      query: (params) => ({ url: '/driver-expenses/fuel-settings', params: cleanParams({ ...(params ?? {}) }) }),
      transformResponse: (r: ApiListResponse<FuelSettingsDetail>) => unwrapList(r),
      providesTags: [{ type: 'FuelSettings', id: 'LIST' }],
    }),

    /** Append-only: a new version may change how any date resolves. */
    createFuelSettings: builder.mutation<FuelSettingsDetail, CreateFuelSettingsRequest>({
      query: (body) => ({ url: '/driver-expenses/fuel-settings', method: 'POST', body }),
      transformResponse: (r: ApiSuccessResponse<FuelSettingsDetail>) => unwrapData(r),
      invalidatesTags: ['FuelSettings'],
    }),

    /* ------------------------- drivers + profiles ------------------------- */
    getExpenseDrivers: builder.query<Paginated<ExpenseDriverSummary>, ListExpenseDriversParams | void>({
      query: (params) => ({ url: '/driver-expenses/drivers', params: cleanParams({ ...(params ?? {}) }) }),
      transformResponse: (r: ApiListResponse<ExpenseDriverSummary>) => unwrapList(r),
      providesTags: [{ type: 'ExpenseDriver', id: 'LIST' }],
    }),

    /**
     * EVERY driver (all pages) for the daily-entry grid, so no driver is ever
     * silently omitted beyond the first page. De-duplicated by id in case the
     * set shifts mid-scan.
     */
    getAllExpenseDrivers: builder.query<ExpenseDriverSummary[], void>({
      async queryFn(_arg, _api, _extra, baseQuery) {
        const result = await loadAllExpenseDrivers(async (page) => {
          const res = await baseQuery({
            url: '/driver-expenses/drivers',
            params: { page, limit: ALL_DRIVERS_PAGE_SIZE },
          });
          if (res.error) return { error: res.error };
          const { items, meta } = unwrapList(res.data as ApiListResponse<ExpenseDriverSummary>);
          return { items, totalPages: meta.totalPages };
        });
        return 'error' in result
          ? { error: result.error as FetchBaseQueryError }
          : { data: result.data };
      },
      providesTags: [{ type: 'ExpenseDriver', id: 'ALL' }],
    }),

    /** Default vehicle only — never touches recorded daily expenses. */
    upsertExpenseProfile: builder.mutation<
      ExpenseProfileDetail,
      { driverId: string; defaultVehicleType: ExpenseVehicleType }
    >({
      query: ({ driverId, defaultVehicleType }) => ({
        url: `/driver-expenses/drivers/${driverId}/profile`,
        method: 'PUT',
        body: { defaultVehicleType },
      }),
      transformResponse: (r: ApiSuccessResponse<ExpenseProfileDetail>) => unwrapData(r),
      // Reports show the current default as context only.
      invalidatesTags: ['ExpenseDriver', ...REPORT_TAG],
    }),

    /* ---------------------------- daily expenses ---------------------------- */
    /** Every RECORDED entry for one date (no rows are invented). */
    getDailyExpensesForDate: builder.query<DailyExpenseDetail[], string>({
      query: (date) => ({ url: `/driver-expenses/daily-expenses/by-date/${date}` }),
      transformResponse: (r: ApiSuccessResponse<DailyExpenseDetail[]>) => unwrapData(r),
      providesTags: (_res, _err, date) => [{ type: 'DailyExpense', id: `DATE:${date}` }],
    }),

    createDailyExpense: builder.mutation<DailyExpenseDetail, CreateDailyExpenseRequest>({
      query: (body) => ({ url: '/driver-expenses/daily-expenses', method: 'POST', body }),
      transformResponse: (r: ApiSuccessResponse<DailyExpenseDetail>) => unwrapData(r),
      // A recorded day also makes earlier-dated settings retroactive, so the
      // fuel settings views may be stale too.
      invalidatesTags: (_res, _err, body) => [
        { type: 'DailyExpense', id: `DATE:${body.expenseDate}` },
        { type: 'FuelSettings', id: 'LIST' },
        ...REPORT_TAG,
      ],
    }),

    updateDailyExpense: builder.mutation<
      DailyExpenseDetail,
      { id: string; expenseDate: string; body: UpdateDailyExpenseRequest }
    >({
      query: ({ id, body }) => ({ url: `/driver-expenses/daily-expenses/${id}`, method: 'PATCH', body }),
      transformResponse: (r: ApiSuccessResponse<DailyExpenseDetail>) => unwrapData(r),
      invalidatesTags: (_res, _err, { expenseDate }) => [{ type: 'DailyExpense', id: `DATE:${expenseDate}` }, ...REPORT_TAG],
    }),

    /* -------------------------------- reports -------------------------------- */
    // Read-only aggregates of the saved daily records (server-side filtering,
    // sorting and pagination over the complete set). Refreshed whenever an
    // entry is created or corrected.
    getDriverExpenseReportSummary: builder.query<DriverExpenseReportSummary, DriverExpenseReportParams>({
      query: (params) => ({ url: '/driver-expenses/reports/summary', params: cleanParams({ ...params }) }),
      transformResponse: (r: ApiSuccessResponse<DriverExpenseReportSummary>) => unwrapData(r),
      providesTags: REPORT_TAG,
    }),

    getDriverExpenseReportByDriver: builder.query<Paginated<DriverExpenseDriverReportRow>, DriverExpenseDriverReportParams>({
      query: (params) => ({ url: '/driver-expenses/reports/by-driver', params: cleanParams({ ...params }) }),
      transformResponse: (r: ApiListResponse<DriverExpenseDriverReportRow>) => unwrapList(r),
      providesTags: REPORT_TAG,
    }),

    getDriverExpenseReportByVehicle: builder.query<DriverExpenseVehicleReportRow[], DriverExpenseReportParams>({
      query: (params) => ({ url: '/driver-expenses/reports/by-vehicle', params: cleanParams({ ...params }) }),
      transformResponse: (r: ApiSuccessResponse<DriverExpenseVehicleReportRow[]>) => unwrapData(r),
      providesTags: REPORT_TAG,
    }),

    getDriverExpenseDailyTrend: builder.query<DriverExpenseTrendRow[], DriverExpenseReportParams>({
      query: (params) => ({ url: '/driver-expenses/reports/daily-trend', params: cleanParams({ ...params }) }),
      transformResponse: (r: ApiSuccessResponse<DriverExpenseTrendRow[]>) => unwrapData(r),
      providesTags: REPORT_TAG,
    }),
  }),
});

export const {
  useGetCurrentFuelSettingsQuery,
  useGetEffectiveFuelSettingsQuery,
  useGetFuelSettingsHistoryQuery,
  useCreateFuelSettingsMutation,
  useGetExpenseDriversQuery,
  useGetAllExpenseDriversQuery,
  useUpsertExpenseProfileMutation,
  useGetDailyExpensesForDateQuery,
  useCreateDailyExpenseMutation,
  useUpdateDailyExpenseMutation,
  useGetDriverExpenseReportSummaryQuery,
  useGetDriverExpenseReportByDriverQuery,
  useGetDriverExpenseReportByVehicleQuery,
  useGetDriverExpenseDailyTrendQuery,
} = driverExpensesApi;
