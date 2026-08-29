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
  AreaSummary,
  FailedDeliveryReasonSummary,
  PaymentMethodSummary,
  SystemSettingSummary,
} from './domain.types';

/**
 * Reference data + system settings. Backend:
 *   /api/v1/settings/areas                    (paginated list, CRUD)          — server/src/modules/reference-data
 *   /api/v1/settings/payment-methods          (plain-array list, CRUD)
 *   /api/v1/settings/failed-delivery-reasons  (plain-array list, CRUD)
 *   /api/v1/system-settings                   (plain-array list, get/:key, patch/:key) — server/src/modules/settings
 *
 * Reads are `settings.read`; mutations are `settings.manage`. All of these
 * share the `Settings` tag with a sub-id, so a mutation invalidates only its
 * own catalog (plus the shared `LIST` id used by the Create Order pages that
 * read active areas / payment methods).
 */

export interface ListAreasParams extends PaginationParams {
  search?: string;
  isActive?: boolean;
}
export interface ReferenceListParams {
  search?: string;
  isActive?: boolean;
}

export interface CreateAreaRequest {
  name: string;
  sortOrder?: number;
}
export interface UpdateAreaRequest {
  name?: string;
  sortOrder?: number;
  isActive?: boolean;
}
export interface CreatePaymentMethodRequest {
  code: string;
  name: string;
  sortOrder?: number;
}
export interface UpdatePaymentMethodRequest {
  name?: string;
  sortOrder?: number;
  isActive?: boolean;
}
export interface CreateFailedDeliveryReasonRequest {
  name: string;
  requiresNotes?: boolean;
  sortOrder?: number;
}
export interface UpdateFailedDeliveryReasonRequest {
  name?: string;
  requiresNotes?: boolean;
  sortOrder?: number;
  isActive?: boolean;
}
export interface UpdateSystemSettingRequest {
  value?: unknown;
  description?: string | null;
}

const settingsTag = (id: string) => ({ type: 'Settings' as const, id });

export const settingsApi = api.injectEndpoints({
  endpoints: (builder) => ({
    /* ------------------------------ Areas ------------------------------ */
    getAreas: builder.query<Paginated<AreaSummary>, ListAreasParams | void>({
      query: (params) => ({
        url: '/settings/areas',
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (r: ApiListResponse<AreaSummary>) => unwrapList(r),
      providesTags: [settingsTag('AREAS'), settingsTag('LIST')],
    }),
    getArea: builder.query<AreaSummary, string>({
      query: (id) => ({ url: `/settings/areas/${id}` }),
      transformResponse: (r: ApiSuccessResponse<AreaSummary>) => unwrapData(r),
      providesTags: [settingsTag('AREAS')],
    }),
    createArea: builder.mutation<AreaSummary, CreateAreaRequest>({
      query: (body) => ({ url: '/settings/areas', method: 'POST', body }),
      transformResponse: (r: ApiSuccessResponse<AreaSummary>) => unwrapData(r),
      invalidatesTags: [settingsTag('AREAS'), settingsTag('LIST')],
    }),
    updateArea: builder.mutation<
      AreaSummary,
      { id: string; body: UpdateAreaRequest }
    >({
      query: ({ id, body }) => ({
        url: `/settings/areas/${id}`,
        method: 'PATCH',
        body,
      }),
      transformResponse: (r: ApiSuccessResponse<AreaSummary>) => unwrapData(r),
      invalidatesTags: [settingsTag('AREAS'), settingsTag('LIST')],
    }),

    /* ------------------------- Payment methods ------------------------- */
    getPaymentMethods: builder.query<
      PaymentMethodSummary[],
      ReferenceListParams | void
    >({
      query: (params) => ({
        url: '/settings/payment-methods',
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (r: ApiSuccessResponse<PaymentMethodSummary[]>) =>
        unwrapData(r),
      providesTags: [settingsTag('PAYMENT_METHODS'), settingsTag('LIST')],
    }),
    getPaymentMethod: builder.query<PaymentMethodSummary, string>({
      query: (id) => ({ url: `/settings/payment-methods/${id}` }),
      transformResponse: (r: ApiSuccessResponse<PaymentMethodSummary>) =>
        unwrapData(r),
      providesTags: [settingsTag('PAYMENT_METHODS')],
    }),
    createPaymentMethod: builder.mutation<
      PaymentMethodSummary,
      CreatePaymentMethodRequest
    >({
      query: (body) => ({
        url: '/settings/payment-methods',
        method: 'POST',
        body,
      }),
      transformResponse: (r: ApiSuccessResponse<PaymentMethodSummary>) =>
        unwrapData(r),
      invalidatesTags: [settingsTag('PAYMENT_METHODS'), settingsTag('LIST')],
    }),
    updatePaymentMethod: builder.mutation<
      PaymentMethodSummary,
      { id: string; body: UpdatePaymentMethodRequest }
    >({
      query: ({ id, body }) => ({
        url: `/settings/payment-methods/${id}`,
        method: 'PATCH',
        body,
      }),
      transformResponse: (r: ApiSuccessResponse<PaymentMethodSummary>) =>
        unwrapData(r),
      invalidatesTags: [settingsTag('PAYMENT_METHODS'), settingsTag('LIST')],
    }),

    /* --------------------- Failed delivery reasons --------------------- */
    getFailedDeliveryReasons: builder.query<
      FailedDeliveryReasonSummary[],
      ReferenceListParams | void
    >({
      query: (params) => ({
        url: '/settings/failed-delivery-reasons',
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (
        r: ApiSuccessResponse<FailedDeliveryReasonSummary[]>,
      ) => unwrapData(r),
      providesTags: [settingsTag('FAILED_DELIVERY_REASONS'), settingsTag('LIST')],
    }),
    getFailedDeliveryReason: builder.query<FailedDeliveryReasonSummary, string>({
      query: (id) => ({ url: `/settings/failed-delivery-reasons/${id}` }),
      transformResponse: (r: ApiSuccessResponse<FailedDeliveryReasonSummary>) =>
        unwrapData(r),
      providesTags: [settingsTag('FAILED_DELIVERY_REASONS')],
    }),
    createFailedDeliveryReason: builder.mutation<
      FailedDeliveryReasonSummary,
      CreateFailedDeliveryReasonRequest
    >({
      query: (body) => ({
        url: '/settings/failed-delivery-reasons',
        method: 'POST',
        body,
      }),
      transformResponse: (r: ApiSuccessResponse<FailedDeliveryReasonSummary>) =>
        unwrapData(r),
      invalidatesTags: [
        settingsTag('FAILED_DELIVERY_REASONS'),
        settingsTag('LIST'),
      ],
    }),
    updateFailedDeliveryReason: builder.mutation<
      FailedDeliveryReasonSummary,
      { id: string; body: UpdateFailedDeliveryReasonRequest }
    >({
      query: ({ id, body }) => ({
        url: `/settings/failed-delivery-reasons/${id}`,
        method: 'PATCH',
        body,
      }),
      transformResponse: (r: ApiSuccessResponse<FailedDeliveryReasonSummary>) =>
        unwrapData(r),
      invalidatesTags: [
        settingsTag('FAILED_DELIVERY_REASONS'),
        settingsTag('LIST'),
      ],
    }),

    /* -------------------------- System settings ------------------------ */
    getSystemSettings: builder.query<SystemSettingSummary[], void>({
      query: () => ({ url: '/system-settings' }),
      transformResponse: (r: ApiSuccessResponse<SystemSettingSummary[]>) =>
        unwrapData(r),
      providesTags: [settingsTag('SYSTEM')],
    }),
    getSystemSetting: builder.query<SystemSettingSummary, string>({
      query: (key) => ({ url: `/system-settings/${encodeURIComponent(key)}` }),
      transformResponse: (r: ApiSuccessResponse<SystemSettingSummary>) =>
        unwrapData(r),
      providesTags: [settingsTag('SYSTEM')],
    }),
    updateSystemSetting: builder.mutation<
      SystemSettingSummary,
      { key: string; body: UpdateSystemSettingRequest }
    >({
      query: ({ key, body }) => ({
        url: `/system-settings/${encodeURIComponent(key)}`,
        method: 'PATCH',
        body,
      }),
      transformResponse: (r: ApiSuccessResponse<SystemSettingSummary>) =>
        unwrapData(r),
      invalidatesTags: [settingsTag('SYSTEM')],
    }),
  }),
});

export const {
  useGetAreasQuery,
  useGetAreaQuery,
  useCreateAreaMutation,
  useUpdateAreaMutation,
  useGetPaymentMethodsQuery,
  useGetPaymentMethodQuery,
  useCreatePaymentMethodMutation,
  useUpdatePaymentMethodMutation,
  useGetFailedDeliveryReasonsQuery,
  useGetFailedDeliveryReasonQuery,
  useCreateFailedDeliveryReasonMutation,
  useUpdateFailedDeliveryReasonMutation,
  useGetSystemSettingsQuery,
  useGetSystemSettingQuery,
  useUpdateSystemSettingMutation,
} = settingsApi;
