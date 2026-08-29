/**
 * Frontend mirror of the backend's standard response envelopes.
 * Source of truth: server/src/shared/types/api-response.ts.
 *
 * These are hand-written contract types — client and server stay isolated
 * packages (no cross-imports from server/).
 */

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

/** Pagination metadata — one definition, reused by every list endpoint. */
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ApiListResponse<T> {
  success: true;
  data: T[];
  meta: PaginationMeta;
}

/** Backend list endpoint whose `data` is an object, not an array (driver cash). */
export interface ApiObjectWithMeta<T> {
  success: true;
  data: T;
  meta: PaginationMeta;
}

/** Backend standard error body. `code` matches server AppErrorCode values. */
export interface ApiErrorBody {
  code: string;
  message: string;
  /** Zod `z.treeifyError(...)` output on VALIDATION_ERROR; shape varies otherwise. */
  details?: unknown;
}

export interface ApiErrorResponse {
  success: false;
  error: ApiErrorBody;
}

/**
 * Unwrapped list result handed to components by our `transformResponse`
 * helpers: the rows plus pagination, without the `success`/envelope noise.
 */
export interface Paginated<T> {
  items: T[];
  meta: PaginationMeta;
}

/** Query args shared by every paginated list endpoint. */
export interface PaginationParams {
  page?: number;
  limit?: number;
}
