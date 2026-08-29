import { api } from './api';
import { unwrapData } from './unwrap';
import type { ApiSuccessResponse } from './apiTypes';
import type { DashboardSummary } from './domain.types';

/**
 * Management Dashboard (Phase 9.1). Backend: GET /api/v1/dashboard —
 * a single unfiltered read summary, no query params by design. `finance` and
 * some driver-cash figures are null for a caller without `finance.read`.
 */
export const dashboardApi = api.injectEndpoints({
  endpoints: (builder) => ({
    getDashboard: builder.query<DashboardSummary, void>({
      query: () => ({ url: '/dashboard' }),
      transformResponse: (r: ApiSuccessResponse<DashboardSummary>) =>
        unwrapData(r),
      providesTags: [{ type: 'Dashboard', id: 'ROOT' }],
    }),
  }),
});

export const { useGetDashboardQuery } = dashboardApi;
