import type {
  ApiListResponse,
  ApiObjectWithMeta,
  ApiSuccessResponse,
  Paginated,
} from './apiTypes';

/** `{ success, data }` -> `data`. */
export function unwrapData<T>(response: ApiSuccessResponse<T>): T {
  return response.data;
}

/** `{ success, data: [], meta }` -> `{ items, meta }`. */
export function unwrapList<T>(response: ApiListResponse<T>): Paginated<T> {
  return { items: response.data, meta: response.meta };
}

/** `{ success, data: {...}, meta }` -> `{ data, meta }` (driver-cash shape). */
export function unwrapObjectWithMeta<T>(
  response: ApiObjectWithMeta<T>,
): { data: T; meta: Paginated<T>['meta'] } {
  return { data: response.data, meta: response.meta };
}
