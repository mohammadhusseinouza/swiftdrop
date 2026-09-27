import { type ReactNode, useId, useState } from 'react';
import { Printer } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';

import { Card } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { DateRangeFilter } from '../../../components/filters/DateRangeFilter';
import { Badge } from '../../../components/ui/Badge';
import {
  DataTable,
  type DataTableColumn,
} from '../../../components/data-display/DataTable';
import { Pagination } from '../../../components/data-display/Pagination';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { EmptyState } from '../../../components/feedback/EmptyState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { StatusBadge } from '../../../components/orders/StatusBadge';
import { OrderTypeBadge } from '../../../components/orders/OrderTypeBadge';
import { paths } from '../../../routes/paths';
import {
  formatDate,
  formatDateTime,
  formatMoney,
  humanizeToken,
} from '../../../lib/format';
import { getApiErrorMessage, type UnknownApiError } from '../../../services/apiError';
import {
  useGetOrdersQuery,
  useLazyGetOrdersQuery,
} from '../../../services/ordersApi';
import { printCustomerOrdersInvoice } from '../../../lib/customerOrdersInvoicePrint';
import {
  useGetWalletQuery,
  useGetWalletTransactionsQuery,
} from '../../../services/walletsApi';
import { useGetPayoutsQuery } from '../../../services/payoutsApi';
import { useGetAuditLogsQuery } from '../../../services/auditApi';
import type {
  AuditLogEntry,
  CustomerDetail,
  OrderSummary,
  PayoutSummary,
  WalletTransactionEntry,
} from '../../../services/domain.types';

const DASH = '—';
const PAGE_SIZE = 20;

/* --------------------------- shared primitives --------------------------- */

interface InfoRow {
  label: ReactNode;
  value: ReactNode;
  wide?: boolean;
}
function InfoGrid({ rows }: { rows: InfoRow[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {rows.map((row, i) => (
        <div key={i} className={row.wide ? 'min-w-0 sm:col-span-2' : 'min-w-0'}>
          <dt className="text-xs text-ink-muted">{row.label}</dt>
          <dd className="mt-0.5 break-words text-sm text-ink">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="rounded-card border border-line bg-card p-4 shadow-card sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <h3 id={headingId} className="text-sm font-semibold text-ink">
          {title}
        </h3>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

const orText = (v: string | null | undefined): ReactNode =>
  v && v.trim() !== '' ? v : DASH;

function usePageParam(key: string): [number, (page: number) => void] {
  const [sp, setSp] = useSearchParams();
  const raw = Number(sp.get(key));
  const page = Number.isInteger(raw) && raw >= 1 ? raw : 1;
  const setPage = (next: number) => {
    const nextSp = new URLSearchParams(sp);
    if (next > 1) nextSp.set(key, String(next));
    else nextSp.delete(key);
    setSp(nextSp, { replace: true });
  };
  return [page, setPage];
}

/* ------------------------------ Overview tab ---------------------------- */

export function OverviewTab({
  customer,
  canViewOrders,
  canViewWallet,
  canViewPayouts,
}: {
  customer: CustomerDetail;
  canViewOrders: boolean;
  canViewWallet: boolean;
  canViewPayouts: boolean;
}) {
  const recentOrders = useGetOrdersQuery(
    { customerId: customer.id, limit: 5 },
    { skip: !canViewOrders },
  );
  const wallet = useGetWalletQuery(customer.id, { skip: !canViewWallet });
  const recentPayouts = useGetPayoutsQuery(
    { customerId: customer.id, limit: 5 },
    { skip: !canViewPayouts },
  );

  return (
    <div className="space-y-5">
      <Section title="Customer information">
        <InfoGrid
          rows={[
            { label: 'Customer number', value: customer.customerNumber },
            { label: 'Name', value: customer.name },
            {
              label: 'Status',
              value: (
                <Badge tone={customer.isActive ? 'success' : 'neutral'} dot>
                  {customer.isActive ? 'Active' : 'Inactive'}
                </Badge>
              ),
            },
            {
              label: 'Portal account',
              value: customer.hasPortalAccount ? 'Linked' : 'Not linked',
            },
            { label: 'Created', value: formatDateTime(customer.createdAt) },
            { label: 'Last updated', value: formatDateTime(customer.updatedAt) },
          ]}
        />
      </Section>

      <Section title="Contact & address">
        <InfoGrid
          rows={[
            {
              label: 'Primary phone',
              value: customer.primaryPhone ? (
                <a
                  href={`tel:${customer.primaryPhone}`}
                  className="text-brand-600 hover:underline"
                >
                  {customer.primaryPhone}
                </a>
              ) : (
                DASH
              ),
            },
            {
              label: 'Secondary phone',
              value: customer.secondaryPhone ? (
                <a
                  href={`tel:${customer.secondaryPhone}`}
                  className="text-brand-600 hover:underline"
                >
                  {customer.secondaryPhone}
                </a>
              ) : (
                DASH
              ),
            },
            {
              label: 'Email',
              value: customer.email ? (
                <a
                  href={`mailto:${customer.email}`}
                  className="text-brand-600 hover:underline"
                >
                  {customer.email}
                </a>
              ) : (
                DASH
              ),
            },
            { label: 'Default area', value: customer.area?.name ?? DASH },
            {
              label: 'Default address',
              value: orText(customer.defaultAddress),
              wide: true,
            },
            { label: 'Notes', value: orText(customer.notes), wide: true },
          ]}
        />
      </Section>

      {canViewOrders && (
        <Section
          title="Recent orders"
          action={
            <Link
              to={`${paths.management.orders}?customerId=${customer.id}`}
              className="text-xs font-medium text-brand-600 hover:underline"
            >
              View all
            </Link>
          }
        >
          <CompactOrders query={recentOrders} />
        </Section>
      )}

      {canViewWallet && (
        <Section
          title="Wallet summary"
          action={
            <Link
              to={paths.management.walletDetail(customer.id)}
              className="text-xs font-medium text-brand-600 hover:underline"
            >
              View wallet
            </Link>
          }
        >
          {wallet.isLoading ? (
            <LoadingState variant="inline" />
          ) : wallet.isError ? (
            <ErrorState
              className="py-4"
              message={getApiErrorMessage(wallet.error as UnknownApiError)}
              onRetry={() => void wallet.refetch()}
            />
          ) : wallet.data ? (
            <InfoGrid
              rows={[
                {
                  label: 'Available balance',
                  value: (
                    <span className="text-base font-semibold tabular-nums">
                      {formatMoney(wallet.data.wallet.availableBalance)}
                    </span>
                  ),
                },
                {
                  label: 'Pending amount',
                  value: (
                    <span className="tabular-nums">
                      {formatMoney(wallet.data.wallet.pendingAmount)}
                    </span>
                  ),
                },
              ]}
            />
          ) : null}
        </Section>
      )}

      {canViewPayouts && (
        <Section title="Recent payouts">
          <CompactPayouts query={recentPayouts} />
        </Section>
      )}
    </div>
  );
}

/* ------------------------------ Orders tab ---------------------------- */

const customerOrderColumns: DataTableColumn<OrderSummary>[] = [
  {
    id: 'order',
    header: 'Order',
    cell: (o) => (
      <Link
        to={paths.management.orderDetail(o.id)}
        className="font-medium text-brand-600 hover:underline"
      >
        {o.orderNumber}
      </Link>
    ),
  },
  { id: 'receiver', header: 'Receiver', cell: (o: OrderSummary) => o.receiverName },
  {
    id: 'area',
    header: 'Area',
    cell: (o: OrderSummary) => o.receiverArea || DASH,
    hideBelow: 'lg' as const,
  },
  {
    id: 'type',
    header: 'Type',
    cell: (o: OrderSummary) => <OrderTypeBadge orderType={o.orderType} />,
    hideBelow: 'md' as const,
  },
  {
    id: 'collect',
    header: 'To collect',
    align: 'right' as const,
    cell: (o: OrderSummary) => (
      <span className="font-medium tabular-nums">
        {formatMoney(o.amountToCollect)}
      </span>
    ),
  },
  {
    id: 'driver',
    header: 'Driver',
    hideBelow: 'lg' as const,
    cell: (o: OrderSummary) =>
      o.currentDriver
        ? `${o.currentDriver.user.firstName} ${o.currentDriver.user.lastName}`
        : 'Unassigned',
  },
  {
    id: 'status',
    header: 'Status',
    cell: (o: OrderSummary) => <StatusBadge status={o.status} />,
  },
  {
    id: 'created',
    header: 'Created',
    hideBelow: 'md' as const,
    cell: (o: OrderSummary) => formatDate(o.createdAt),
  },
];

/* ------------------------- Customer Orders Invoice ------------------- */

const INVOICE_PAGE_SIZE = 100; // GET /orders maximum page size

function toYmd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Local calendar day -> exact instant. The invoice lists each order's LOCAL
 * created date, so the interval uses local-day boundaries (both inclusive:
 * from 00:00:00.000 to 23:59:59.999) — sent as full ISO instants, which the
 * backend applies as `gte` / `lte`.
 */
function localDayBoundary(ymd: string, end: boolean): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const date = end
    ? new Date(y, m - 1, d, 23, 59, 59, 999)
    : new Date(y, m - 1, d, 0, 0, 0, 0);
  return date.toISOString();
}

/**
 * Orders tab toolbar: From / To + "Print A5 Invoice". Read-only — it fetches
 * EVERY page of `GET /orders` for this customer and interval (not just the
 * table's visible page) and opens the A5 landscape print preview in place.
 */
function CustomerOrdersInvoiceControls({ customer }: { customer: CustomerDetail }) {
  const today = new Date();
  const [range, setRange] = useState(() => ({
    from: toYmd(new Date(today.getFullYear(), today.getMonth(), 1)),
    to: toYmd(today),
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchOrders] = useLazyGetOrdersQuery();

  const rangeError =
    !range.from || !range.to
      ? 'Select both a start and an end date.'
      : range.from > range.to
        ? 'The start date must be on or before the end date.'
        : null;

  const handlePrint = async () => {
    if (rangeError || busy) return;
    setBusy(true);
    setError(null);
    try {
      const base = {
        customerId: customer.id,
        createdFrom: localDayBoundary(range.from, false),
        createdTo: localDayBoundary(range.to, true),
        sortBy: 'createdAt' as const,
        sortOrder: 'asc' as const,
        limit: INVOICE_PAGE_SIZE,
      };
      const orders: OrderSummary[] = [];
      let page = 1;
      let total = 0;
      for (;;) {
        const res = await fetchOrders({ ...base, page }).unwrap();
        if (page === 1) total = res.meta.total;
        else if (res.meta.total !== total) {
          throw new Error(
            'Orders changed while the invoice was being prepared. Please try again.',
          );
        }
        orders.push(...res.items);
        if (page >= res.meta.totalPages || res.items.length === 0) break;
        page += 1;
      }
      if (orders.length !== total) {
        throw new Error(
          'Not every matching order could be loaded. Please try again.',
        );
      }
      printCustomerOrdersInvoice({
        customer: {
          name: customer.name,
          customerNumber: customer.customerNumber,
          primaryPhone: customer.primaryPhone,
        },
        from: range.from,
        to: range.to,
        orders,
      });
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : getApiErrorMessage(e as UnknownApiError),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <DateRangeFilter
          value={range}
          onChange={(next) => {
            setError(null);
            setRange(next);
          }}
          disabled={busy}
          fromLabel="From date"
          toLabel="To date"
        />
        <Button
          icon={<Printer />}
          loading={busy}
          disabled={busy || rangeError !== null}
          onClick={() => void handlePrint()}
        >
          Print A5 Invoice
        </Button>
      </div>
      {(error || (rangeError && range.from && range.to)) && (
        <p role="alert" className="mt-2 text-sm text-danger-700">
          {error ?? rangeError}
        </p>
      )}
    </Card>
  );
}

export function OrdersTab({ customer }: { customer: CustomerDetail }) {
  return (
    <div className="space-y-4">
      <CustomerOrdersInvoiceControls customer={customer} />
      <CustomerOrdersTable customerId={customer.id} />
    </div>
  );
}

function CustomerOrdersTable({ customerId }: { customerId: string }) {
  const [page, setPage] = usePageParam('ordersPage');
  const query = useGetOrdersQuery({ customerId, page, limit: PAGE_SIZE });
  const rows = query.data?.items ?? [];
  const meta = query.data?.meta;

  if (query.isLoading) {
    return (
      <Card flush>
        <LoadingState className="py-12" />
      </Card>
    );
  }
  if (query.isError) {
    return (
      <Card flush>
        <ErrorState
          className="py-12"
          message={getApiErrorMessage(query.error as UnknownApiError)}
          onRetry={() => void query.refetch()}
        />
      </Card>
    );
  }
  if (rows.length === 0) {
    return (
      <Card flush>
        <EmptyState
          className="py-12"
          title="No orders for this customer yet"
          description="Orders created for this customer will appear here."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card flush>
        <DataTable
          columns={customerOrderColumns}
          rows={rows}
          getRowId={(o) => o.id}
          caption="Customer orders"
        />
      </Card>
      {meta && meta.totalPages > 1 && (
        <Pagination
          page={page}
          totalPages={meta.totalPages}
          total={meta.total}
          onPageChange={setPage}
        />
      )}
    </div>
  );
}

/* ------------------------------ Wallet tab ---------------------------- */

const walletTxColumns: DataTableColumn<WalletTransactionEntry>[] = [
  {
    id: 'date',
    header: 'Date',
    cell: (t) => formatDateTime(t.createdAt),
  },
  {
    id: 'type',
    header: 'Type',
    cell: (t: WalletTransactionEntry) => (
      <Badge tone="neutral">{humanizeToken(t.type)}</Badge>
    ),
  },
  {
    id: 'credit',
    header: 'Credit',
    align: 'right' as const,
    cell: (t: WalletTransactionEntry) =>
      t.credit === '0' ? DASH : formatMoney(t.credit),
  },
  {
    id: 'debit',
    header: 'Debit',
    align: 'right' as const,
    cell: (t: WalletTransactionEntry) =>
      t.debit === '0' ? DASH : formatMoney(t.debit),
  },
  {
    id: 'balance',
    header: 'Balance after',
    align: 'right' as const,
    cell: (t: WalletTransactionEntry) => (
      <span className="tabular-nums">{formatMoney(t.balanceAfter)}</span>
    ),
    hideBelow: 'md' as const,
  },
  {
    id: 'order',
    header: 'Order',
    hideBelow: 'lg' as const,
    cell: (t: WalletTransactionEntry) =>
      t.order ? (
        <Link
          to={paths.management.orderDetail(t.order.id)}
          className="text-brand-600 hover:underline"
        >
          {t.order.orderNumber}
        </Link>
      ) : (
        DASH
      ),
  },
  {
    id: 'method',
    header: 'Method',
    hideBelow: 'xl' as const,
    cell: (t: WalletTransactionEntry) => t.paymentMethod?.name ?? DASH,
  },
  {
    id: 'notes',
    header: 'Notes',
    hideBelow: 'xl' as const,
    cell: (t: WalletTransactionEntry) => orText(t.notes),
  },
];

export function WalletTab({ customerId }: { customerId: string }) {
  const [page, setPage] = usePageParam('walletPage');
  const wallet = useGetWalletQuery(customerId);
  const txns = useGetWalletTransactionsQuery({
    customerId,
    params: { page, limit: PAGE_SIZE },
  });
  const rows = txns.data?.items ?? [];
  const meta = txns.data?.meta;

  return (
    <div className="space-y-5">
      <Section title="Balance">
        {wallet.isLoading ? (
          <LoadingState variant="inline" />
        ) : wallet.isError ? (
          <ErrorState
            className="py-4"
            message={getApiErrorMessage(wallet.error as UnknownApiError)}
            onRetry={() => void wallet.refetch()}
          />
        ) : wallet.data ? (
          <InfoGrid
            rows={[
              {
                label: 'Available balance',
                value: (
                  <span className="text-lg font-semibold tabular-nums">
                    {formatMoney(wallet.data.wallet.availableBalance)}
                  </span>
                ),
              },
              {
                label: 'Pending amount',
                value: (
                  <span className="tabular-nums">
                    {formatMoney(wallet.data.wallet.pendingAmount)}
                  </span>
                ),
              },
            ]}
          />
        ) : null}
        <p className="mt-3 text-xs text-ink-muted">
          Pending is derived server-side from qualifying active delivery-only
          orders and is not withdrawable. Read-only snapshot — wallet
          adjustments, reversals and payouts are handled in Finance / Payouts.
        </p>
      </Section>

      <Section title="Recent transactions">
        {txns.isLoading ? (
          <LoadingState className="py-8" />
        ) : txns.isError ? (
          <ErrorState
            className="py-8"
            message={getApiErrorMessage(txns.error as UnknownApiError)}
            onRetry={() => void txns.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            className="py-8"
            title="No wallet transactions yet"
            description="Order credits, payouts and adjustments will appear here."
          />
        ) : (
          <>
            <DataTable
              columns={walletTxColumns}
              rows={rows}
              getRowId={(t) => t.id}
              caption="Wallet transactions"
            />
            {meta && meta.totalPages > 1 && (
              <Pagination
                className="mt-4"
                page={page}
                totalPages={meta.totalPages}
                total={meta.total}
                onPageChange={setPage}
              />
            )}
          </>
        )}
      </Section>
    </div>
  );
}

/* ------------------------------ Payouts tab ---------------------------- */

const PAYOUT_STATUS_TONE: Record<string, 'success' | 'warning' | 'neutral'> = {
  COMPLETED: 'success',
  REVERSED: 'warning',
  CANCELLED: 'neutral',
};

const payoutColumns: DataTableColumn<PayoutSummary>[] = [
  {
    id: 'date',
    header: 'Date',
    cell: (p) => formatDateTime(p.createdAt),
  },
  {
    id: 'number',
    header: 'Payout',
    cell: (p: PayoutSummary) => p.payoutNumber,
    hideBelow: 'lg' as const,
  },
  {
    id: 'amount',
    header: 'Amount',
    align: 'right' as const,
    cell: (p: PayoutSummary) => (
      <span className="font-medium tabular-nums">{formatMoney(p.amount)}</span>
    ),
  },
  {
    id: 'method',
    header: 'Method',
    cell: (p: PayoutSummary) => p.paymentMethod.name,
    hideBelow: 'md' as const,
  },
  {
    id: 'status',
    header: 'Status',
    cell: (p: PayoutSummary) => (
      <Badge tone={PAYOUT_STATUS_TONE[p.status] ?? 'neutral'}>
        {humanizeToken(p.status)}
      </Badge>
    ),
  },
  {
    id: 'by',
    header: 'Processed by',
    hideBelow: 'xl' as const,
    cell: (p: PayoutSummary) =>
      `${p.processedBy.firstName} ${p.processedBy.lastName}`,
  },
];

export function PayoutsTab({ customerId }: { customerId: string }) {
  const [page, setPage] = usePageParam('payoutsPage');
  const query = useGetPayoutsQuery({ customerId, page, limit: PAGE_SIZE });
  const rows = query.data?.items ?? [];
  const meta = query.data?.meta;

  if (query.isLoading) {
    return (
      <Card flush>
        <LoadingState className="py-12" />
      </Card>
    );
  }
  if (query.isError) {
    return (
      <Card flush>
        <ErrorState
          className="py-12"
          message={getApiErrorMessage(query.error as UnknownApiError)}
          onRetry={() => void query.refetch()}
        />
      </Card>
    );
  }
  if (rows.length === 0) {
    return (
      <Card flush>
        <EmptyState
          className="py-12"
          title="No payouts for this customer yet"
          description="Completed customer payouts will appear here."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card flush>
        <DataTable
          columns={payoutColumns}
          rows={rows}
          getRowId={(p) => p.id}
          caption="Customer payouts"
        />
      </Card>
      {meta && meta.totalPages > 1 && (
        <Pagination
          page={page}
          totalPages={meta.totalPages}
          total={meta.total}
          onPageChange={setPage}
        />
      )}
    </div>
  );
}

/* ------------------------------ Activity tab ---------------------------- */

const AUDIT_ACTION_LABEL: Record<string, string> = {
  CUSTOMER_CREATED: 'Customer created',
  CUSTOMER_UPDATED: 'Customer updated',
  CUSTOMER_DEACTIVATED: 'Customer deactivated',
  CUSTOMER_REACTIVATED: 'Customer reactivated',
};

function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABEL[action] ?? humanizeToken(action);
}

/** Compact, readable diff of an audit entry's simple previous/new value maps. */
function auditChanges(entry: AuditLogEntry): { field: string; from?: string; to?: string }[] {
  const prev = (entry.previousValues ?? {}) as Record<string, unknown>;
  const next = (entry.newValues ?? {}) as Record<string, unknown>;
  if (typeof prev !== 'object' || typeof next !== 'object') return [];
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  const fmt = (v: unknown): string | undefined => {
    if (v === undefined) return undefined;
    if (v === null) return '—';
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (typeof v === 'object') return undefined;
    return String(v);
  };
  return [...keys].map((k) => ({
    field: humanizeToken(k),
    from: fmt(prev[k]),
    to: fmt(next[k]),
  }));
}

export function ActivityTab({ customerId }: { customerId: string }) {
  const [page, setPage] = usePageParam('activityPage');
  const query = useGetAuditLogsQuery({
    entityType: 'CUSTOMER',
    entityId: customerId,
    page,
    limit: PAGE_SIZE,
  });
  const rows: AuditLogEntry[] = query.data?.items ?? [];
  const meta = query.data?.meta;

  return (
    <Section title="Activity">
      <p className="mb-4 text-xs text-ink-muted">
        Audit trail of changes to this customer record (audit access only).
      </p>
      {query.isLoading ? (
        <LoadingState className="py-8" />
      ) : query.isError ? (
        <ErrorState
          className="py-8"
          message={getApiErrorMessage(query.error as UnknownApiError)}
          onRetry={() => void query.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          className="py-8"
          title="No recorded activity yet"
          description="Create / update / deactivate events for this customer appear here."
        />
      ) : (
        <>
          <ol className="divide-y divide-line-subtle">
            {rows.map((entry) => {
              const changes = auditChanges(entry).filter(
                (c) => c.from !== undefined || c.to !== undefined,
              );
              return (
                <li key={entry.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <p className="text-sm font-medium text-ink">
                      {auditActionLabel(entry.action)}
                    </p>
                    <span className="text-xs text-ink-muted">
                      {formatDateTime(entry.createdAt)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-subtle">
                    {entry.actor
                      ? `by ${entry.actor.firstName} ${entry.actor.lastName}`
                      : 'by the system'}
                  </p>
                  {changes.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5 text-xs text-ink-muted">
                      {changes.map((c, i) => (
                        <li key={i}>
                          <span className="text-ink-secondary">{c.field}:</span>{' '}
                          {c.from !== undefined && (
                            <span className="line-through">{c.from}</span>
                          )}
                          {c.from !== undefined && c.to !== undefined && ' → '}
                          {c.to !== undefined && <span>{c.to}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
          {meta && meta.totalPages > 1 && (
            <Pagination
              className="mt-4"
              page={page}
              totalPages={meta.totalPages}
              total={meta.total}
              onPageChange={setPage}
            />
          )}
        </>
      )}
    </Section>
  );
}

/* --------------------- compact lists (Overview) --------------------- */

function CompactOrders({
  query,
}: {
  query: ReturnType<typeof useGetOrdersQuery>;
}) {
  if (query.isLoading) return <LoadingState className="py-6" />;
  if (query.isError)
    return (
      <ErrorState
        className="py-6"
        message={getApiErrorMessage(query.error as UnknownApiError)}
        onRetry={() => void query.refetch()}
      />
    );
  const rows: OrderSummary[] = query.data?.items ?? [];
  if (rows.length === 0)
    return (
      <p className="py-4 text-sm text-ink-muted">No orders for this customer yet.</p>
    );
  return (
    <ul className="divide-y divide-line-subtle">
      {rows.map((o) => (
        <li key={o.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
          <div className="min-w-0">
            <Link
              to={paths.management.orderDetail(o.id)}
              className="text-sm font-medium text-brand-600 hover:underline"
            >
              {o.orderNumber}
            </Link>
            <p className="truncate text-xs text-ink-muted">
              {o.receiverName} · {formatDate(o.createdAt)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-sm tabular-nums text-ink-secondary">
              {formatMoney(o.amountToCollect)}
            </span>
            <StatusBadge status={o.status} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function CompactPayouts({
  query,
}: {
  query: ReturnType<typeof useGetPayoutsQuery>;
}) {
  if (query.isLoading) return <LoadingState className="py-6" />;
  if (query.isError)
    return (
      <ErrorState
        className="py-6"
        message={getApiErrorMessage(query.error as UnknownApiError)}
        onRetry={() => void query.refetch()}
      />
    );
  const rows: PayoutSummary[] = query.data?.items ?? [];
  if (rows.length === 0)
    return <p className="py-4 text-sm text-ink-muted">No payouts yet.</p>;
  return (
    <ul className="divide-y divide-line-subtle">
      {rows.map((p) => (
        <li key={p.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{formatMoney(p.amount)}</p>
            <p className="truncate text-xs text-ink-muted">
              {p.payoutNumber} · {formatDate(p.createdAt)}
            </p>
          </div>
          <Badge tone={PAYOUT_STATUS_TONE[p.status] ?? 'neutral'}>
            {humanizeToken(p.status)}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
