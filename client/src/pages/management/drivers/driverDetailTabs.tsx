import { type ReactNode, useCallback, useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { Card } from '../../../components/ui/Card';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
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
import { useHasPermission } from '../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../features/auth/permissions';
import {
  useGetDriverCurrentOrdersQuery,
  useGetDriverDeliveryHistoryQuery,
  useGetDriverParcelCollectionHistoryQuery,
  useGetManagementDriverCashQuery,
  useGetManagementDriverCashTransactionsQuery,
} from '../../../services/driversApi';
import { useGetSettlementsQuery } from '../../../services/settlementsApi';
import {
  useAdjustDriverCashMutation,
  useReverseDriverCashTransactionMutation,
} from '../../../services/financeApi';
import type {
  DriverDeliveryHistoryRow,
  DriverParcelCollectionHistoryRow,
  ManagementDriverCashTransactionEntry,
  OrderSummary,
  SettlementSummary,
} from '../../../services/domain.types';
import {
  getParcelCollectionStatusPresentation,
  getParcelEndReasonLabel,
} from '../../../components/orders/parcelCollection';
import { LedgerAdjustDialog } from '../../../components/finance/LedgerAdjustDialog';
import { LedgerReverseDialog } from '../../../components/finance/LedgerReverseDialog';
import {
  LEDGER_LABEL,
  isReversibleType,
  ledgerTypeLabel,
} from '../../../components/finance/ledgerCorrection';

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

/* --------------------------- Parcel Collections tab --------------------- */

const parcelCollectionHistoryColumns: DataTableColumn<DriverParcelCollectionHistoryRow>[] = [
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
    id: 'status',
    header: 'Current status',
    cell: (r) => {
      const p = getParcelCollectionStatusPresentation(r.parcelCollectionStatus);
      return <Badge tone={p.tone}>{p.label}</Badge>;
    },
  },
  {
    id: 'assigned',
    header: 'Assigned',
    hideBelow: 'lg',
    cell: (r) => formatDateTime(r.assignedAt),
  },
  {
    id: 'ended',
    header: 'Ended',
    hideBelow: 'lg',
    cell: (r) => (r.endedAt ? formatDateTime(r.endedAt) : '—'),
  },
  {
    id: 'outcome',
    header: 'Outcome / end reason',
    cell: (r) =>
      r.isCurrent ? (
        <Badge tone="info">Current</Badge>
      ) : (
        <span className="text-ink-secondary">{getParcelEndReasonLabel(r.endReason)}</span>
      ),
  },
];

export function ParcelCollectionsTab({ driverId }: { driverId: string }) {
  const [page, setPage] = usePageParam('collectionsPage');
  const query = useGetDriverParcelCollectionHistoryQuery({
    id: driverId,
    page,
    limit: PAGE_SIZE,
  });
  const rows = query.data?.items ?? [];
  const meta = query.data?.meta;

  return (
    <Section title="Parcel collection history">
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
          title="No parcel collection jobs yet"
          description="Collection assignments — assigned, reassigned, failed, or received at company — will appear here."
        />
      ) : (
        <>
          <DataTable
            columns={parcelCollectionHistoryColumns}
            rows={rows}
            getRowId={(r) => r.assignmentId}
            caption="Driver parcel collection assignments"
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
            One row per Collection assignment — the same order can appear more
            than once if this driver was assigned across separate attempts.
            Separate from Delivery metrics/history above; financially neutral
            (Parcel Collection never affects driver cash).
          </p>
        </>
      )}
    </Section>
  );
}

/* -------------------------------- Cash tab ----------------------------- */

function buildCashColumns(
  renderActions?: (t: ManagementDriverCashTransactionEntry) => ReactNode,
): DataTableColumn<ManagementDriverCashTransactionEntry>[] {
  const cols: DataTableColumn<ManagementDriverCashTransactionEntry>[] = [
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
  if (renderActions) {
    cols.push({
      id: 'actions',
      header: '',
      align: 'right',
      cell: (t) => renderActions(t),
    });
  }
  return cols;
}

export function CashTab({
  driverId,
  driverLabel,
}: {
  driverId: string;
  driverLabel?: string;
}) {
  const [page, setPage] = usePageParam('cashPage');
  const canAdjustCash = useHasPermission(PERMISSIONS.FINANCE_ADJUST);

  const balance = useGetManagementDriverCashQuery(driverId);
  const txns = useGetManagementDriverCashTransactionsQuery({
    id: driverId,
    page,
    limit: PAGE_SIZE,
  });
  const rows = txns.data?.items ?? [];
  const meta = txns.data?.meta;

  const [adjustOpen, setAdjustOpen] = useState(false);
  const [reverseTarget, setReverseTarget] =
    useState<ManagementDriverCashTransactionEntry | null>(null);
  const [adjustCash, adjustCashState] = useAdjustDriverCashMutation();
  const [reverseCash, reverseCashState] =
    useReverseDriverCashTransactionMutation();

  const refetchCash = useCallback(() => {
    void balance.refetch();
    void txns.refetch();
  }, [balance, txns]);

  const columns = buildCashColumns(
    canAdjustCash
      ? (t) =>
          isReversibleType(t.type) ? (
            <button
              type="button"
              onClick={() => setReverseTarget(t)}
              className="rounded-control px-2 py-1 text-xs font-medium text-danger-700 hover:bg-danger-50"
            >
              Reverse
            </button>
          ) : null
      : undefined,
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <StatisticCard
          className="flex-1"
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
        {canAdjustCash && (
          <Button
            variant="secondary"
            onClick={() => setAdjustOpen(true)}
            disabled={!balance.data}
          >
            Adjust driver cash
          </Button>
        )}
      </div>

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
              columns={columns}
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
          Append-only. Adjustments and reversals post a new row — existing rows
          are never edited. A settlement is reversed here (its historical record
          is preserved). A held-cash split by company vs. customer money is not
          shown — the ledger does not assign settled cash to ownership buckets.
        </p>
      </Section>

      {canAdjustCash && (
        <LedgerAdjustDialog
          open={adjustOpen}
          ledger="DRIVER_CASH"
          entityLabel={driverLabel ?? 'Driver cash'}
          currentBalance={balance.data?.currentBalance ?? null}
          submitting={adjustCashState.isLoading}
          onRefetch={refetchCash}
          onClose={() => setAdjustOpen(false)}
          onSubmit={(body) => adjustCash({ driverId, body }).unwrap()}
        />
      )}

      {reverseTarget && (
        <LedgerReverseDialog
          open
          submitting={reverseCashState.isLoading}
          onRefetch={refetchCash}
          onClose={() => setReverseTarget(null)}
          onSubmit={(reason) =>
            reverseCash({
              transactionId: reverseTarget.id,
              reason,
              driverId,
              orderId: reverseTarget.order?.id,
              settlementLinked: !!reverseTarget.settlement,
            }).unwrap()
          }
          original={{
            ledgerLabel: LEDGER_LABEL.DRIVER_CASH,
            typeLabel: ledgerTypeLabel(reverseTarget.type),
            amount: reverseTarget.amount,
            direction: reverseTarget.direction,
            date: reverseTarget.createdAt,
            reference:
              reverseTarget.order?.orderNumber ??
              reverseTarget.settlement?.settlementNumber ??
              null,
            effectNote: reverseTarget.settlement
              ? 'Driver cash is restored. The settlement’s historical record is preserved. Customer wallet and company revenue are unaffected.'
              : 'Only this driver’s cash balance changes. Customer wallet, company revenue and the order are unaffected.',
          }}
        />
      )}
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

  const canCreateSettlement = useHasPermission(PERMISSIONS.SETTLEMENTS_CREATE);
  // Both entries land on the scoped Driver Settlements list (filtered to this
  // driver; the Process Settlement dialog there preselects them). The label
  // just reflects what the user can do once there.
  const scopedSettlementsPath = `${paths.management.driverSettlements}?driverId=${driverId}`;

  return (
    <Section
      title="Settlement history"
      action={
        <Link
          to={scopedSettlementsPath}
          className="text-xs font-medium text-brand-600 hover:underline"
        >
          {canCreateSettlement ? 'Process settlement' : 'View all settlements'}
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
