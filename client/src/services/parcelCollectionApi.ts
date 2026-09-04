import { api } from './api';
import { unwrapData } from './unwrap';
import type { ApiSuccessResponse } from './apiTypes';
import type { ParcelCollectionDetail } from './domain.types';

/**
 * Parcel Collection domain (Phase 11.17.3 backend; 11.17.5 Management UI;
 * 11.17.6 cache-invalidation correction).
 * Backend: server/src/modules/parcel-collection — mounted at /api/v1/orders.
 *
 *   GET   /orders/:id/parcel-collection                 orders.read
 *   POST  /orders/:id/parcel-collection/assign          orders.assign
 *   POST  /orders/:id/parcel-collection/reassign        orders.assign
 *   POST  /orders/:id/parcel-collection/reschedule      orders.change_status
 *   POST  /orders/:id/parcel-collection/receive-at-company  orders.change_status
 *
 * Parcel Collection is financially neutral in V1 — no Wallet / Driver Cash /
 * Company Finance invalidation here. It DOES gate final Delivery assignment
 * and now feeds Dashboard operational counts, Orders List workflow queues,
 * and Driver Detail Collection history (Phase 11.17.6) — so every mutation
 * additionally refreshes Dashboard + the Order-list workflow queues +
 * per-driver Collection history, alongside the existing Order/Driver-list
 * refresh. Never Finance/Wallet/DriverCash/Report (Report stays
 * Orders-List-adjacent but date-range aggregate reads are refreshed on next
 * natural refetch — not tagged here, matching the read-heavy report
 * convention elsewhere in this codebase).
 */

const invalidateForOrder = (orderId: string) =>
  [
    { type: 'ParcelCollection' as const, id: orderId },
    { type: 'ParcelCollection' as const, id: 'LIST' },
    { type: 'Order' as const, id: orderId },
    { type: 'Order' as const, id: 'LIST' },
    { type: 'Driver' as const, id: 'LIST' },
    { type: 'Dashboard' as const, id: 'ROOT' },
  ] as const;

export const parcelCollectionApi = api.injectEndpoints({
  endpoints: (builder) => ({
    getParcelCollection: builder.query<ParcelCollectionDetail, string>({
      query: (orderId) => ({ url: `/orders/${orderId}/parcel-collection` }),
      transformResponse: (r: ApiSuccessResponse<ParcelCollectionDetail>) =>
        unwrapData(r),
      providesTags: (_res, _err, orderId) => [
        { type: 'ParcelCollection', id: orderId },
      ],
    }),

    assignParcelCollectionDriver: builder.mutation<
      ParcelCollectionDetail,
      { orderId: string; driverId: string }
    >({
      query: ({ orderId, driverId }) => ({
        url: `/orders/${orderId}/parcel-collection/assign`,
        method: 'POST',
        body: { driverId },
      }),
      transformResponse: (r: ApiSuccessResponse<ParcelCollectionDetail>) =>
        unwrapData(r),
      invalidatesTags: (_res, _err, { orderId }) => invalidateForOrder(orderId),
    }),

    reassignParcelCollectionDriver: builder.mutation<
      ParcelCollectionDetail,
      { orderId: string; driverId: string }
    >({
      query: ({ orderId, driverId }) => ({
        url: `/orders/${orderId}/parcel-collection/reassign`,
        method: 'POST',
        body: { driverId },
      }),
      transformResponse: (r: ApiSuccessResponse<ParcelCollectionDetail>) =>
        unwrapData(r),
      invalidatesTags: (_res, _err, { orderId }) => invalidateForOrder(orderId),
    }),

    rescheduleParcelCollection: builder.mutation<
      ParcelCollectionDetail,
      { orderId: string }
    >({
      query: ({ orderId }) => ({
        url: `/orders/${orderId}/parcel-collection/reschedule`,
        method: 'POST',
      }),
      transformResponse: (r: ApiSuccessResponse<ParcelCollectionDetail>) =>
        unwrapData(r),
      invalidatesTags: (_res, _err, { orderId }) => invalidateForOrder(orderId),
    }),

    receiveParcelAtCompany: builder.mutation<
      ParcelCollectionDetail,
      { orderId: string }
    >({
      query: ({ orderId }) => ({
        url: `/orders/${orderId}/parcel-collection/receive-at-company`,
        method: 'POST',
      }),
      transformResponse: (r: ApiSuccessResponse<ParcelCollectionDetail>) =>
        unwrapData(r),
      invalidatesTags: (_res, _err, { orderId }) => invalidateForOrder(orderId),
    }),
  }),
});

export const {
  useGetParcelCollectionQuery,
  useAssignParcelCollectionDriverMutation,
  useReassignParcelCollectionDriverMutation,
  useRescheduleParcelCollectionMutation,
  useReceiveParcelAtCompanyMutation,
} = parcelCollectionApi;
