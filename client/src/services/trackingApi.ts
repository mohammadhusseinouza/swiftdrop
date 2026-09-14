import { api } from './api';
import { unwrapData } from './unwrap';
import type { ApiSuccessResponse } from './apiTypes';
import type { PublicTrackingDetail } from './domain.types';

/**
 * Public Tracking (Phase 14.1). Backend: GET /api/v1/track/:trackingCode —
 * UNAUTHENTICATED, read-only, no permission required (requirements.md §36).
 *
 * Injected into the ONE shared `api` slice — no second `createApi`, no Redux
 * slice mirroring this server data. No cache tags: the page issues at most
 * one lookup per submitted code and there is no mutation anywhere in this
 * phase to invalidate against, so a tag would only add coupling.
 */
export const trackingApi = api.injectEndpoints({
  endpoints: (builder) => ({
    getPublicTracking: builder.query<PublicTrackingDetail, string>({
      query: (trackingCode) => ({ url: `/track/${encodeURIComponent(trackingCode)}` }),
      transformResponse: (r: ApiSuccessResponse<PublicTrackingDetail>) =>
        unwrapData(r),
    }),
  }),
});

export const { useGetPublicTrackingQuery } = trackingApi;
