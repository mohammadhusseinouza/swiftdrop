import { api } from './api';
import { cleanParams } from './queryParams';
import { unwrapList } from './unwrap';
import type {
  ApiListResponse,
  Paginated,
  PaginationParams,
} from './apiTypes';
import type { AuditLogEntry } from './domain.types';

/**
 * Audit Search (Phase 9.4). Backend: GET /api/v1/audit-logs — search-only,
 * `audit.read`-gated, no mutations (audit history is append-only, written
 * only from inside the transactions it documents). Follows the same shared
 * foundation as every other module.
 */

export interface ListAuditLogsParams extends PaginationParams {
  actorId?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  from?: string;
  to?: string;
}

export const auditApi = api.injectEndpoints({
  endpoints: (builder) => ({
    getAuditLogs: builder.query<
      Paginated<AuditLogEntry>,
      ListAuditLogsParams | void
    >({
      query: (params) => ({
        url: '/audit-logs',
        params: cleanParams({ ...(params ?? {}) }),
      }),
      transformResponse: (r: ApiListResponse<AuditLogEntry>) => unwrapList(r),
      providesTags: [{ type: 'AuditLog', id: 'LIST' }],
    }),
  }),
});

export const { useGetAuditLogsQuery } = auditApi;
