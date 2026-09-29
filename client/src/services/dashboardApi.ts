import type { FetchBaseQueryError } from '@reduxjs/toolkit/query';

import { api } from './api';
import { unwrapData, unwrapList } from './unwrap';
import type { ApiListResponse, ApiSuccessResponse } from './apiTypes';
import type { DashboardSummary, OrderSummary } from './domain.types';
import {
  getUtcDay,
  scanDeliveredPage,
  summarizeDeliveredOrders,
  type DailyDeliverySummary,
} from '../lib/dailyDeliverySummary';

/** Orders list max page size (server ListOrdersQuerySchema: limit <= 100). */
const DELIVERED_PAGE_SIZE = 100;
/** Safety cap: 50 x 100 = 5,000 deliveries in one day before we refuse to guess. */
const DELIVERED_MAX_PAGES = 50;

function customError(message: string): { error: FetchBaseQueryError } {
  return { error: { status: 'CUSTOM_ERROR', error: message } };
}

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

    /**
     * Finalize Day summary (display-only) for one UTC day (YYYY-MM-DD).
     *
     * GET /dashboard only exposes the delivered-today COUNT, so this reads the
     * existing Orders list (`orders.read`) sorted by deliveredAt DESC and pages
     * until it passes the day's start — only today's deliveries are fetched,
     * never the whole table. Rows are de-duplicated by id in case a delivery
     * lands mid-scan and shifts the offsets. Read-only: no mutation of any kind.
     */
    getDailyDeliverySummary: builder.query<DailyDeliverySummary, string>({
      async queryFn(date, _api, _extra, baseQuery) {
        const day = getUtcDay(new Date(`${date}T00:00:00.000Z`));
        const delivered = new Map<string, OrderSummary>();

        for (let page = 1; page <= DELIVERED_MAX_PAGES; page++) {
          const result = await baseQuery({
            url: '/orders',
            params: {
              page,
              limit: DELIVERED_PAGE_SIZE,
              sortBy: 'deliveredAt',
              sortOrder: 'desc',
            },
          });
          if (result.error) return { error: result.error };

          const { items, meta } = unwrapList(
            result.data as ApiListResponse<OrderSummary>,
          );
          const scan = scanDeliveredPage(items, day);
          for (const row of scan.inDay) delivered.set(row.id, row);

          if (
            scan.reachedEnd ||
            items.length < DELIVERED_PAGE_SIZE ||
            page >= meta.totalPages
          ) {
            const summary = summarizeDeliveredOrders(day.date, [
              ...delivered.values(),
            ]);
            return summary
              ? { data: summary }
              : customError('An order amount could not be read.');
          }
        }
        return customError(
          'Too many deliveries today to summarise here — use Reports instead.',
        );
      },
      providesTags: [
        { type: 'Order', id: 'LIST' },
        { type: 'Dashboard', id: 'ROOT' },
      ],
    }),
  }),
});

export const { useGetDashboardQuery, useGetDailyDeliverySummaryQuery } =
  dashboardApi;
