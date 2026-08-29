import { type ReactNode, useId } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { Card } from '../../../components/ui/Card';
import { Badge } from '../../../components/ui/Badge';
import {
  DataTable,
  type DataTableColumn,
} from '../../../components/data-display/DataTable';
import { Pagination } from '../../../components/data-display/Pagination';
import { StatisticCard } from '../../../components/data-display/StatisticCard';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { EmptyState } from '../../../components/feedback/EmptyState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { StatusBadge } from '../../../components/orders/StatusBadge';
import { paths } from '../../../routes/paths';
import {
  formatDate,
  formatDateTime,
  formatMoney,
  humanizeToken,
} from '../../../lib/format';
import { getApiErrorMessage, type UnknownApiError } from '../../../services/apiError';
import {
  useGetDriverCurrentOrdersQuery,
  useGetDriverDeliveryHistoryQuery,
  useGetManagementDriverCashQuery,
  useGetManagementDriverCashTransactionsQuery,
} from '../../../services/driversApi';
import { useGetSettlementsQuery } from '../../../services/settlementsApi';
import type {
  DriverDeliveryHistoryRow,
  ManagementDriverCashTransactionEntry,
  OrderSummary,
  SettlementSummary,
} from '../../../services/domain.types';

const DASH = '—';
const PAGE_SIZE = 20;

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
    <section
      aria-labelledby={headingId}
      className="rounded-card border border-line bg-card p-4 shadow-card sm:p-5"
    >
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

/* --------------------------- Current Orders tab -------------------------- */

const currentOrderColumns: DataTableColumn<OrderSummary>[] = [
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
  { id: 'receiver', header: 'Receiver', cell: (o) => o.receiverName },
  {
    id: 'area',
    header: 'Area',
    cell: (o) => o.receiverArea || DASH,
    hideBelow: 'lg',
  },
  {
    id: 'collect',
    header: 'To collect',
    align: 'right',
    cell: (o) => (
      <span className="font-medium tabular-nums">
        {formatMoney(o.amountToCollect)}
      </span>
    ),
  },
  {
    id: 'status',
    header: 'Status',
    cell: (o) => <StatusBadge status={o.status} />,
  },
  {
    id: 'assigned',
    header: 'Assigned',
    hideBelow: 'lg',
    cell: (o) => formatDateTime(o.assignedAt),
  },
  {
    id: 'created',
    header: 'Created',
    hideBelow: 'xl',
    cell: (o) => formatDate(o.createdAt),
  },
];

export function CurrentOrdersTab({ driverId }: { driverId: string }) {
  const [page, setPage] = usePageParam('currentPage');
  // Precise server-scoped current work: current_driver = this driver AND
  // status IN ORDER_ACTIVE_STATUSES. No client-side status filtering.
  const query = useGetDriverCurrentOrdersQuery({
    id: driverId,
    page,
    limit: PAGE_SIZE,
  });
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
          title="No current orders"
          description="This driver has no active assigned orders right now."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card flush>
        <DataTable
          columns={currentOrderColumns}
          rows={rows}
          getRowId={(o) => o.id}
          caption="Current driver orders"
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

/* -------------------------- Delivery History tab ------------------------ */

function outcomeTone(outcome: string): 'success' | 'danger' | 'warning' | 'neutral' {
  if (outcome === 'DELIVERED') return 'success';
  if (outcome === 'FAILED') return 'danger';
  if (outcome === 'RETURNED') return 'warning';
  return 'neutral';
}

const deliveryHistoryColumns: DataTableColumn<DriverDeliveryHistoryRow>[] = [
  {
    id: 'order',
    header: 'Order',
    cell: (r) => (
      <Link
        to={paths.management.orderDetail(r.order.id)}
        className="font-medium text-brand-600 hover:underline"
      >
        {r.order.orderNumber}
      </Link>
    ),
  },
  {
    id: 'attempt',
    header: 'Attempt',
    align: 'right',
    hideBelow: 'lg',
    cell: (r) => <span className="tabular-nums">#{r.attemptNumber}</span>,
  },
  { id: 'receiver', header: 'Receiver', hideBelow: 'md', cell: (r) => r.receiverName },
  {
    id: 'outcome',
    header: 'Outcome',
    cell: (r) => (
      <div className="flex flex-col gap-0.5">
        <Badge tone={outcomeTone(r.outcome)}>{humanizeToken(r.outcome)}</Badge>
        {r.failedReason && (
          <span className="text-xs text-ink-muted">{r.failedReason.name}</span>
        )}
      </div>
    ),
  },
  {
    id: 'orderStatus',
    header: 'Order now',
    hideBelow: 'xl',
    cell: (r) => <StatusBadge status={r.order.status} />,
  },
  {
    id: 'collected',
    header: 'Collected',
    align: 'right',
    hideBelow: 'lg',
    cell: (r) => (
      <span className="tabular-nums">
        {r.actualCollection != null
          ? formatMoney(r.actualCollection)
          : `${formatMoney(r.expectedCollection)} exp.`}
      </span>
    ),
  },
  {
    id: 'completed',
    header: 'Completed',
    cell: (r) => formatDateTime(r.completedAt ?? r.startedAt),
  },
];

export function DeliveryHistoryTab({ driverId }: { driverId: string }) {
  const [page, setPage] = usePageParam('historyPage');
  const query = useGetDriverDeliveryHistoryQuery({
    id: driverId,
    page,
    limit: PAGE_SIZE,
  });
  const rows = query.data?.items ?? [];
  const meta = query.data?.meta;

  return (
    <Section title="Delivery history">
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
          title="No delivery attempts yet"
          description="Every pickup, delivery and failed attempt this driver makes will appear here."
        />
      ) : (
        <>
          <DataTable
            columns={deliveryHistoryColumns}
            rows={rows}
            getRowId={(r) => r.attemptId}
            caption="Driver delivery attempts"
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
          <p className="mt-3 text-xs text-ink-muted">
            Attributed to this driver by delivery attempt — a later reassignment
            never moves historical credit.
          </p>
        </>
      )}
    </Section>
  );
}

/* -------------------------------- Cash tab ----------------------------- */

const cashColumns: DataTableColumn<ManagementDriverCashTransactionEntry>[] = [
  {
    id: 'type',
    header: 'Type',
    cell: (t) => (
      <div className="flex flex-col gap-0.5">
        <span className="font-medium">{humanizeToken(t.type)}</span>
        {t.order && (
          <Link
            to={paths.management.orderDetail(t.order.id)}
            className="text-xs text-brand-600 hover:underline"
          >
            {t.order.orderNumber}
          </Link>
        )}
        {t.settlement && (
          <span className="text-xs text-ink-muted">
            {t.settlement.settlementNumber}
          </span>
        )}
      </div>
    ),
  },
  {
    id: 'amount',
    header: 'Amount',
    align: 'right',
    cell: (t) => (
      <span
        className={
          t.direction === 'CREDIT'
            ? 'font-medium tabular-nums text-success-700'
            : 'font-medium tabular-nums text-danger-700'
        }
      >
        {t.direction === 'CREDIT' ? '+' : '−'}
        {formatMoney(t.amount)}
      </span>
    ),
  },
  {
    id: 'balance',
    header: 'Balance after',
    align: 'right',
    hideBelow: 'md',
    cell: (t) => (
      <span className="tabular-nums">{formatMoney(t.balanceAfter)}</span>
    ),
  },
  {
    id: 'method',
    header: 'Method',
    hideBelow: 'lg',
    cell: (t) => t.paymentMethod?.name ?? DASH,
  },
  {
    id: 'by',
    header: 'By',
    hideBelow: 'xl',
    cell: (t) =>
      t.actor ? `${t.actor.firstName} ${t.actor.lastName}` : 'System',
  },
  {
    id: 'when',
    header: 'When',
    cell: (t) => formatDateTime(t.createdAt),
  },
];

export function CashTab({ driverId }: { driverId: string }) {
  const [page, setPage] = usePageParam('cashPage');
  const balance = useGetManagementDriverCashQuery(driverId);
  const txns = useGetManagementDriverCashTransactionsQuery({
    id: driverId,
    page,
    limit: PAGE_SIZE,
  });
  const rows = txns.data?.items ?? [];
  const meta = txns.data?.meta;

  return (
    <div className="space-y-4">
      <StatisticCard
        label="Cash held"
        value={
          balance.isError
            ? DASH
            : balance.data
              ? formatMoney(balance.data.currentBalance)
              : '…'
        }
        supportingText="Collected, not yet settled to the company"
      />

      <Section title="Cash transactions">
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
            title="No cash transactions"
            description="Collections on delivery and settlements to the company will appear here."
          />
        ) : (
          <>
            <DataTable
              columns={cashColumns}
              rows={rows}
              getRowId={(t) => t.id}
              caption="Driver cash ledger"
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
        <p className="mt-3 text-xs text-ink-muted">
          Read-only. Settlements, adjustments and reversals are handled in Driver
          Settlements / Finance. A held-cash split by company vs. customer money
          is not shown — the current ledger does not assign settled cash to
          ownership buckets, so it is not derivable without a defined allocation
          policy.
        </p>
      </Section>
    </div>
  );
}

/* ----------------------------- Settlements tab -------------------------- */

const settlementColumns: DataTableColumn<SettlementSummary>[] = [
  {
    id: 'number',
    header: 'Settlement',
    cell: (s) => s.settlementNumber,
  },
  {
    id: 'date',
    header: 'Date',
    cell: (s) => formatDateTime(s.createdAt),
  },
  {
    id: 'amount',
    header: 'Amount received',
    align: 'right',
    cell: (s) => (
      <span className="font-medium tabular-nums">
        {formatMoney(s.amountReceived)}
      </span>
    ),
  },
  {
    id: 'before',
    header: 'Balance before',
    align: 'right',
    cell: (s) => <span className="tabular-nums">{formatMoney(s.balanceBefore)}</span>,
    hideBelow: 'lg',
  },
  {
    id: 'after',
    header: 'Balance after',
    align: 'right',
    cell: (s) => <span className="tabular-nums">{formatMoney(s.balanceAfter)}</span>,
    hideBelow: 'md',
  },
  {
    id: 'method',
    header: 'Method',
    cell: (s) => s.paymentMethod.name,
    hideBelow: 'xl',
  },
  {
    id: 'by',
    header: 'Received by',
    hideBelow: 'xl',
    cell: (s) => `${s.receivedBy.firstName} ${s.receivedBy.lastName}`,
  },
];

export function SettlementsTab({ driverId }: { driverId: string }) {
  const [page, setPage] = usePageParam('settlementsPage');
  const query = useGetSettlementsQuery({ driverId, page, limit: PAGE_SIZE });
  const rows = query.data?.items ?? [];
  const meta = query.data?.meta;

  return (
    <Section
      title="Settlement history"
      action={
        <Link
          to={paths.management.driverSettlements}
          className="text-xs font-medium text-brand-600 hover:underline"
        >
          View all settlements
        </Link>
      }
    >
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
          title="No settlements yet"
          description="Cash the driver has handed over to the company will appear here."
        />
      ) : (
        <>
          <DataTable
            columns={settlementColumns}
            rows={rows}
            getRowId={(s) => s.id}
            caption="Driver settlements"
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
      {rows.length > 0 && (
        <p className="mt-3 text-xs text-ink-muted">
          Read-only. Settlement processing is handled in Driver Settlements.
        </p>
      )}
    </Section>
  );
}
