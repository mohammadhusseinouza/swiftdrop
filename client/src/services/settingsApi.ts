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
  FailedCollectionReasonSummary,
  FailedDeliveryReasonSummary,
  PaymentMethodSummary,
  RoleConfigResponse,
  RoleConfigSummary,
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
export interface CreateFailedCollectionReasonRequest {
  name: string;
  requiresNotes?: boolean;
  sortOrder?: number;
}
export interface UpdateFailedCollectionReasonRequest {
  name?: string;
  requiresNotes?: boolean;
  sortOrder?: number;
  isActive?: boolean;
}
export interface UpdateSystemSettingRequest {
  value?: unknown;
  description?: string | null;
}
export interface UpdateRolePermissionsRequest {
  roleId: string;
  permissionCodes: string[];
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

    /* -------------------- Failed collection reasons ------------------- */
    /**
     * A SEPARATE catalog from failed-delivery reasons (Phase 11.17) — never
     * merged. Management endpoint (settings.read / settings.manage); the
     * Driver Portal uses its own narrow endpoint, not this one.
     */
    getFailedCollectionReasons: builder.query<
      FailedCollectionReasonSummary[],
      ReferenceListParams | void
    >({
      query: (params) => ({
        url: '/settings/failed-collection-reasons',
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (
        r: ApiSuccessResponse<FailedCollectionReasonSummary[]>,
      ) => unwrapData(r),
      providesTags: [
        settingsTag('FAILED_COLLECTION_REASONS'),
        settingsTag('LIST'),
      ],
    }),
    getFailedCollectionReason: builder.query<
      FailedCollectionReasonSummary,
      string
    >({
      query: (id) => ({ url: `/settings/failed-collection-reasons/${id}` }),
      transformResponse: (r: ApiSuccessResponse<FailedCollectionReasonSummary>) =>
        unwrapData(r),
      providesTags: [settingsTag('FAILED_COLLECTION_REASONS')],
    }),
    createFailedCollectionReason: builder.mutation<
      FailedCollectionReasonSummary,
      CreateFailedCollectionReasonRequest
    >({
      query: (body) => ({
        url: '/settings/failed-collection-reasons',
        method: 'POST',
        body,
      }),
      transformResponse: (r: ApiSuccessResponse<FailedCollectionReasonSummary>) =>
        unwrapData(r),
      invalidatesTags: [
        settingsTag('FAILED_COLLECTION_REASONS'),
        settingsTag('LIST'),
      ],
    }),
    updateFailedCollectionReason: builder.mutation<
      FailedCollectionReasonSummary,
      { id: string; body: UpdateFailedCollectionReasonRequest }
    >({
      query: ({ id, body }) => ({
        url: `/settings/failed-collection-reasons/${id}`,
        method: 'PATCH',
        body,
      }),
      transformResponse: (r: ApiSuccessResponse<FailedCollectionReasonSummary>) =>
        unwrapData(r),
      invalidatesTags: [
        settingsTag('FAILED_COLLECTION_REASONS'),
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

    /* --------------------- Role → Permission config ------------------- */
    /**
     * Settings-authorized (settings.read) — deliberately NOT the
     * employees.read `/employees/roles`, which DISPATCHER / FINANCE cannot
     * call. Returns the three management roles, the full permission catalog,
     * and the management-role assignment policy.
     */
    getRoleConfig: builder.query<RoleConfigResponse, void>({
      query: () => ({ url: '/settings/roles' }),
      transformResponse: (r: ApiSuccessResponse<RoleConfigResponse>) =>
        unwrapData(r),
      providesTags: [{ type: 'Role', id: 'CONFIG' }],
    }),
    updateRolePermissions: builder.mutation<
      RoleConfigSummary,
      UpdateRolePermissionsRequest
    >({
      query: ({ roleId, permissionCodes }) => ({
        url: `/settings/roles/${roleId}/permissions`,
        method: 'PUT',
        body: { permissionCodes },
      }),
      transformResponse: (r: ApiSuccessResponse<RoleConfigSummary>) =>
        unwrapData(r),
      // Role matrix changed -> refresh the config view, the Employees role
      // list (permission counts), and the current user's own hydrated
      // permissions in case their role was the one edited (§34).
      invalidatesTags: [
        { type: 'Role', id: 'CONFIG' },
        { type: 'Role', id: 'LIST' },
        { type: 'Auth', id: 'ME' },
      ],
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
  useGetFailedCollectionReasonsQuery,
  useGetFailedCollectionReasonQuery,
  useCreateFailedCollectionReasonMutation,
  useUpdateFailedCollectionReasonMutation,
  useGetSystemSettingsQuery,
  useGetSystemSettingQuery,
  useUpdateSystemSettingMutation,
  useGetRoleConfigQuery,
  useUpdateRolePermissionsMutation,
} = settingsApi;
