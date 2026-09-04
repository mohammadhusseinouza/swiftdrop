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
  EmployeeDetail,
  EmployeeRoleOption,
  EmployeeSummary,
} from './domain.types';

/**
 * Employee Management (Phase 11.14). Backend: server/src/modules/employees.
 * Reads require `employees.read`, mutations `employees.manage` (ADMIN only in
 * the live catalog). An Employee is a User + Employee(employee_number) pair
 * with a MANAGEMENT role; permissions are inherited through the role — there
 * is NO per-user override model.
 *
 * PASSWORD: only ever travels as `user.password` in a create mutation body.
 * It is never in a response, never cached, never in Redux, never logged.
 */

export interface ListEmployeesParams extends PaginationParams {
  search?: string;
  roleId?: string;
  isActive?: boolean;
}

export interface CreateEmployeeRequest {
  employeeNumber: string;
  roleId: string;
  user: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    phone?: string;
  };
}

export interface UpdateEmployeeRequest {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string | null;
  roleId?: string;
  isActive?: boolean;
}

export const employeesApi = api.injectEndpoints({
  endpoints: (builder) => ({
    getEmployees: builder.query<
      Paginated<EmployeeSummary>,
      ListEmployeesParams | void
    >({
      query: (params) => ({
        url: '/employees',
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (r: ApiListResponse<EmployeeSummary>) => unwrapList(r),
      providesTags: [{ type: 'Employee', id: 'LIST' }],
    }),

    getEmployee: builder.query<EmployeeDetail, string>({
      query: (id) => ({ url: `/employees/${id}` }),
      transformResponse: (r: ApiSuccessResponse<EmployeeDetail>) => unwrapData(r),
      providesTags: (_res, _err, id) => [{ type: 'Employee', id }],
    }),

    /** The three assignable management roles + their inherited permissions. */
    getEmployeeRoles: builder.query<EmployeeRoleOption[], void>({
      query: () => ({ url: '/employees/roles' }),
      transformResponse: (r: ApiSuccessResponse<EmployeeRoleOption[]>) =>
        unwrapData(r),
      providesTags: [{ type: 'Role', id: 'LIST' }],
    }),

    createEmployee: builder.mutation<EmployeeDetail, CreateEmployeeRequest>({
      query: (body) => ({ url: '/employees', method: 'POST', body }),
      transformResponse: (r: ApiSuccessResponse<EmployeeDetail>) =>
        unwrapData(r),
      invalidatesTags: [{ type: 'Employee', id: 'LIST' }],
    }),

    /**
     * `selfUserId` (optional) — when the row being edited is the current
     * user's own account, pass their user id so a successful edit also
     * refetches `/auth/me` (role / name / status can change the hydrated
     * identity). Cache hint only — not sent to the server.
     */
    updateEmployee: builder.mutation<
      EmployeeDetail,
      { id: string; body: UpdateEmployeeRequest; selfUserId?: string }
    >({
      query: ({ id, body }) => ({
        url: `/employees/${id}`,
        method: 'PATCH',
        body,
      }),
      transformResponse: (r: ApiSuccessResponse<EmployeeDetail>) =>
        unwrapData(r),
      invalidatesTags: (res, _err, { id, selfUserId }) => [
        { type: 'Employee', id },
        { type: 'Employee', id: 'LIST' },
        ...(res && selfUserId && res.userId === selfUserId
          ? [{ type: 'Auth' as const, id: 'ME' }]
          : []),
      ],
    }),
  }),
});

export const {
  useGetEmployeesQuery,
  useGetEmployeeQuery,
  useGetEmployeeRolesQuery,
  useCreateEmployeeMutation,
  useUpdateEmployeeMutation,
} = employeesApi;
