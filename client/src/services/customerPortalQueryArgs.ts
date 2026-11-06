import { cleanParams } from './queryParams';
import type { PaginationParams } from './apiTypes';
import type { CustomerOrderView, CustomerWalletTransactionFilter } from './domain.types';

/**
 * Pure request builders for the self-scoped Customer Portal list endpoints
 * (no RTK Query / env imports, so they are unit-testable under Node).
 *
 * Every param is optional. `limit` (Customer Portal Redesign Step 2) is sent
 * only when a caller passes it — the server accepts 1–100 and applies its own
 * default otherwise — so existing callers produce exactly the same request as
 * before. No customer id is ever part of these requests.
 */

export interface ListCustomerOrdersParams extends PaginationParams {
  view?: CustomerOrderView;
}

export interface ListCustomerWalletTransactionsParams extends PaginationParams {
  type?: CustomerWalletTransactionFilter;
}

export type ListCustomerPayoutsParams = PaginationParams;

export function customerOrdersRequest(params: ListCustomerOrdersParams | void) {
  const { page, limit, view } = params ?? {};
  return { url: '/customer/me/orders', params: cleanParams({ page, limit, view }) };
}

export function customerWalletTransactionsRequest(
  params: ListCustomerWalletTransactionsParams | void,
) {
  const { page, limit, type } = params ?? {};
  return { url: '/customer/me/wallet/transactions', params: cleanParams({ page, limit, type }) };
}

export function customerPayoutsRequest(params: ListCustomerPayoutsParams | void) {
  const { page, limit } = params ?? {};
  return { url: '/customer/me/payouts', params: cleanParams({ page, limit }) };
}
