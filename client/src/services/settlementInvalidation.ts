import type { ApiTagType } from './api';

/**
 * FR.9 — cache tags a confirmed Driver Settlement makes stale. Pure (no RTK
 * import) so it is unit-testable; used by settlementsApi.createSettlement.
 */

export interface SettlementAffected {
  /** Customers whose collections were allocated (their wallets may be released into). */
  customerIds: string[];
  /** Orders whose collections were allocated (financial status may change). */
  orderIds: string[];
}

type Tag = { type: ApiTagType; id: string };

/**
 * Tags a confirmed settlement makes stale. Driver cash / outstanding
 * collections and the finance/dashboard/report summaries always; wallets,
 * customers and orders only for allocated collections (a legacy or
 * unattributed-only settlement never changes a customer wallet).
 */
export function settlementInvalidationTags(
  driverId: string,
  affected: SettlementAffected,
  settlementId?: string,
): Tag[] {
  const tags: Tag[] = [
    { type: 'Settlement', id: 'LIST' },
    { type: 'DriverCash', id: driverId },
    { type: 'DriverCash', id: 'SUMMARIES' },
    { type: 'DriverCash', id: 'ME' },
    { type: 'Finance', id: 'SUMMARY' },
    { type: 'Finance', id: 'TRANSACTIONS' },
    { type: 'Dashboard', id: 'ROOT' },
    { type: 'Report', id: 'LIST' },
  ];
  if (settlementId) tags.push({ type: 'Settlement', id: settlementId });
  const customers = [...new Set(affected.customerIds)];
  const orders = [...new Set(affected.orderIds)];
  if (customers.length > 0 || orders.length > 0) {
    tags.push({ type: 'Wallet', id: 'LIST' }, { type: 'WalletTransaction', id: 'LIST' }, { type: 'Order', id: 'LIST' });
    for (const id of customers) tags.push({ type: 'Wallet', id }, { type: 'Customer', id });
    for (const id of orders) tags.push({ type: 'Order', id });
  }
  return tags;
}

/**
 * FR.10 — extra tags for a collection-difference resolution, from the
 * returned order: that customer's wallet / customer view (pending settlement
 * may become available) and the delivery driver's cash tag (the planned split
 * shown in outstanding collections changes). Nothing on failure.
 */
export function resolutionInvalidationTags(
  res: { customer: { id: string }; currentDriver: { id: string } | null } | undefined,
): Tag[] {
  if (!res) return [];
  const tags: Tag[] = [
    { type: 'Wallet', id: res.customer.id },
    { type: 'Customer', id: res.customer.id },
  ];
  if (res.currentDriver) tags.push({ type: 'DriverCash', id: res.currentDriver.id });
  return tags;
}

/* ------------------- FR.10.2 dedicated correction tags -------------------- */

const SUMMARY_TAGS: Tag[] = [
  { type: 'Finance', id: 'SUMMARY' },
  { type: 'Finance', id: 'TRANSACTIONS' },
  { type: 'Dashboard', id: 'ROOT' },
  { type: 'Report', id: 'LIST' },
];

/**
 * Collection void: the collection leaves driver cash (outstanding collections,
 * cash summaries), the order's financial status changes and the customer's
 * pending settlement drops. Wallet balances are not posted to.
 */
export function collectionVoidInvalidationTags(ctx: { orderId: string; driverId: string | null; customerId: string }): Tag[] {
  return [
    { type: 'Order', id: ctx.orderId },
    { type: 'Order', id: 'LIST' },
    ...(ctx.driverId ? [{ type: 'DriverCash' as const, id: ctx.driverId }] : []),
    { type: 'DriverCash', id: 'SUMMARIES' },
    { type: 'DriverCash', id: 'ME' },
    { type: 'Wallet', id: ctx.customerId },
    { type: 'Wallet', id: 'LIST' },
    { type: 'Customer', id: ctx.customerId },
    ...SUMMARY_TAGS,
  ];
}

/**
 * Release reversal: wallet + company reversal rows; the order, the customer
 * wallet and every settlement that allocated to this collection (their
 * detail shows the collection's release status) become stale.
 */
export function releaseReversalInvalidationTags(ctx: { orderId: string; customerId: string; settlementIds: string[] }): Tag[] {
  return [
    { type: 'Order', id: ctx.orderId },
    { type: 'Order', id: 'LIST' },
    { type: 'Wallet', id: ctx.customerId },
    { type: 'Wallet', id: 'LIST' },
    { type: 'WalletTransaction', id: 'LIST' },
    { type: 'Customer', id: ctx.customerId },
    { type: 'Settlement', id: 'LIST' },
    ...[...new Set(ctx.settlementIds)].map((id) => ({ type: 'Settlement' as const, id })),
    ...SUMMARY_TAGS,
  ];
}

/**
 * Settlement reversal: driver cash is credited back; the affected collections
 * (outstanding lists, their orders' release panels) change. No wallet or
 * company revenue is posted.
 */
export function settlementReversalInvalidationTags(ctx: { settlementId: string; driverId: string; orderIds: string[] }): Tag[] {
  return [
    { type: 'Settlement', id: ctx.settlementId },
    { type: 'Settlement', id: 'LIST' },
    { type: 'DriverCash', id: ctx.driverId },
    { type: 'DriverCash', id: 'SUMMARIES' },
    { type: 'DriverCash', id: 'ME' },
    ...[...new Set(ctx.orderIds)].map((id) => ({ type: 'Order' as const, id })),
    ...SUMMARY_TAGS,
  ];
}
