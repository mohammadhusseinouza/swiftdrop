import { api } from './api';
import { unwrapData } from './unwrap';
import type { ApiSuccessResponse } from './apiTypes';
import type { CustomerProfile } from './domain.types';

/**
 * Customer Portal — Profile (Phase 13.7). Backend:
 * GET /api/v1/customer/me/profile — self-scoped (Customer resolved from the
 * authenticated identity, never a client-supplied id), READ-ONLY, no params.
 *
 * Injected into the ONE shared `api` slice — no second `createApi`, no Redux
 * slice mirroring this server data. Read-only phase: `providesTags` only, no
 * mutation endpoint, no cross-domain invalidation.
 */
export const customerProfileApi = api.injectEndpoints({
  endpoints: (builder) => ({
    getCustomerProfile: builder.query<CustomerProfile, void>({
      query: () => ({ url: '/customer/me/profile' }),
      transformResponse: (r: ApiSuccessResponse<CustomerProfile>) => unwrapData(r),
      providesTags: [{ type: 'CustomerProfile', id: 'ME' }],
    }),
  }),
});

export const { useGetCustomerProfileQuery } = customerProfileApi;
