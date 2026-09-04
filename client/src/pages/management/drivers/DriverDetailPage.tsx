import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

import { paths } from '../../../routes/paths';
import { usePermissions } from '../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../features/auth/permissions';
import {
  useGetDriverQuery,
  useGetManagementDriverCashQuery,
  useUpdateDriverMutation,
} from '../../../services/driversApi';
import {
  getApiErrorCode,
  getApiErrorMessage,
  getApiErrorStatus,
  type UnknownApiError,
} from '../../../services/apiError';

import { PageHeader } from '../../../components/data-display/PageHeader';
import { Button } from '../../../components/ui/Button';
import { StatisticCard } from '../../../components/data-display/StatisticCard';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { ConfirmationModal } from '../../../components/feedback/ConfirmationModal';
import { ActiveBadge } from '../../../components/ui/ActiveBadge';
import { formatMoney } from '../../../lib/format';
import { cn } from '../../../components/ui/cn';

import {
  CashTab,
  CurrentOrdersTab,
  DeliveryHistoryTab,
  ParcelCollectionsTab,
  SettlementsTab,
} from './driverDetailTabs';
import { DriverFormDialog } from './DriverFormDialog';

type TabId = 'current' | 'history' | 'collections' | 'cash' | 'settlements';
type DialogKind = 'deactivate' | 'reactivate' | null;

const TAB_LABEL: Record<TabId, string> = {
  current: 'Current Orders',
  history: 'Delivery History',
  collections: 'Parcel Collections',
  cash: 'Cash',
  settlements: 'Settlements',
};

export default function DriverDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [sp, setSp] = useSearchParams();
  const permissions = usePermissions();

  const query = useGetDriverQuery(id ?? '', { skip: !id });
  const driver = query.data;

  const canManage = permissions.includes(PERMISSIONS.DRIVERS_MANAGE);
  const canViewOrders = permissions.includes(PERMISSIONS.ORDERS_READ);
  // drivers.read — matches the backend gate on GET /drivers/:id/parcel-
  // collection-history (Phase 11.17.6, task §27). Always true once this
  // page itself has loaded (Driver Detail requires drivers.read), kept
  // explicit for consistency with the other tab gates below.
  const canViewCollections = permissions.includes(PERMISSIONS.DRIVERS_READ);
  const canViewCash = permissions.includes(PERMISSIONS.FINANCE_READ);
  const canViewSettlements = permissions.includes(PERMISSIONS.SETTLEMENTS_READ);

  const visibleTabs = useMemo<TabId[]>(() => {
    const tabs: TabId[] = [];
    if (canViewOrders) tabs.push('current', 'history');
    if (canViewCollections) tabs.push('collections');
    if (canViewCash) tabs.push('cash');
    if (canViewSettlements) tabs.push('settlements');
    return tabs;
  }, [canViewOrders, canViewCollections, canViewCash, canViewSettlements]);

  const requestedTab = sp.get('tab');
  const activeTab: TabId =
    requestedTab && (visibleTabs as string[]).includes(requestedTab)
      ? (requestedTab as TabId)
      : (visibleTabs[0] ?? 'current');

  useEffect(() => {
    if (requestedTab && requestedTab !== activeTab && visibleTabs.length > 0) {
      const next = new URLSearchParams(sp);
      next.set('tab', activeTab);
      setSp(next, { replace: true });
    }
  }, [requestedTab, activeTab, visibleTabs.length, sp, setSp]);

  const selectTab = (tab: TabId) => {
    const next = new URLSearchParams(sp);
    next.set('tab', tab);
    for (const k of [
      'currentPage',
      'historyPage',
      'collectionsPage',
      'cashPage',
      'settlementsPage',
    ])
      next.delete(k);
    setSp(next);
  };

  const [dialog, setDialog] = useState<DialogKind>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [updateDriver, { isLoading: updating }] = useUpdateDriverMutation();

  const cash = useGetManagementDriverCashQuery(id ?? '', {
    skip: !id || !canViewCash,
  });

  /* ------------------------------ error states --------------------------- */

  if (!id || query.isError || (query.isSuccess && !driver)) {
    const status = getApiErrorStatus(query.error);
    const code = getApiErrorCode(query.error);
    const notFound = !id || status === 404 || code === 'NOT_FOUND';
    return (
      <div className="mx-auto max-w-2xl">
        <BackLink />
        <ErrorState
          className="py-16"
          title={notFound ? 'Driver not found' : 'Could not load this driver'}
          message={
            notFound
              ? 'This driver does not exist or the reference is not valid.'
              : getApiErrorMessage(query.error as UnknownApiError)
          }
          onRetry={notFound ? undefined : () => void query.refetch()}
          action={
            <Link
              to={paths.management.drivers}
              className="inline-flex h-8 items-center rounded-control border border-line bg-card px-3 text-xs font-medium text-ink-secondary hover:bg-sunken"
            >
              Back to drivers
            </Link>
          }
        />
      </div>
    );
  }

  if (query.isLoading || !driver) {
    return (
      <div className="space-y-5">
        <BackLink />
        <PageHeader title="Driver" size="lg" />
        <LoadingState className="py-16" label="Loading driver…" />
      </div>
    );
  }

  /* -------------------------------- ready -------------------------------- */

  const setActive = (isActive: boolean, message: string) =>
    void (async () => {
      setActionError(null);
      try {
        await updateDriver({ id: driver.id, body: { isActive } }).unwrap();
        setDialog(null);
        setActionNotice(message);
      } catch (e) {
        setActionError(getApiErrorMessage(e as UnknownApiError));
        setDialog(null);
      }
    })();

  const headerActions = canManage ? (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" onClick={() => setEditOpen(true)}>
        Edit
      </Button>
      {driver.isActive ? (
        <Button
          variant="ghost"
          onClick={() => setDialog('deactivate')}
          className="text-danger-700 hover:bg-danger-50"
        >
          Deactivate
        </Button>
      ) : (
        <Button variant="ghost" onClick={() => setDialog('reactivate')}>
          Reactivate
        </Button>
      )}
    </div>
  ) : undefined;

  const s = driver.operationalSummary;

  return (
    <div className="space-y-5 pb-6">
      <BackLink />

      <PageHeader
        size="lg"
        title={`${driver.user.firstName} ${driver.user.lastName}`}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <ActiveBadge isActive={driver.isActive} />
            <span className="text-ink-muted">{driver.driverNumber}</span>
            {driver.user.phone && (
              <>
                <span className="text-ink-subtle" aria-hidden="true">
                  ·
                </span>
                <span className="text-ink-muted">{driver.user.phone}</span>
              </>
            )}
            <span className="text-ink-subtle" aria-hidden="true">
              ·
            </span>
            <span className="text-ink-muted">{driver.user.email}</span>
          </span>
        }
        actions={headerActions}
      />

      {actionNotice && (
        <div
          role="status"
          className="flex items-start justify-between gap-3 rounded-card border border-line bg-card px-4 py-2.5 text-sm text-ink-secondary"
        >
          <span>{actionNotice}</span>
          <button
            type="button"
            onClick={() => setActionNotice(null)}
            className="text-xs font-medium text-ink-muted hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}
      {actionError && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-card border border-danger-200 bg-danger-50 px-4 py-2.5 text-sm text-danger-700"
        >
          <span>{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="text-xs font-medium hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {!driver.user.isActive && (
        <div className="rounded-card border border-warning-200 bg-warning-50 px-4 py-2.5 text-sm text-ink-secondary">
          The linked login account is inactive — this driver cannot sign in to
          the Driver Portal.
        </div>
      )}
      {!driver.isActive && s.activeOrders > 0 && (
        <div className="rounded-card border border-warning-200 bg-warning-50 px-4 py-2.5 text-sm text-ink-secondary">
          This inactive driver still has {s.activeOrders} active assigned{' '}
          {s.activeOrders === 1 ? 'order' : 'orders'}. Reassign them from the
          order pages when ready — they are not moved automatically.
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatisticCard
          label="Assigned orders"
          value={String(s.activeOrders)}
          supportingText="Active work currently held"
        />
        <StatisticCard
          label="Out for delivery"
          value={String(s.outForDelivery)}
        />
        <StatisticCard
          label="Delivered today"
          value={String(s.completedToday)}
          supportingText="Attributed to this driver"
        />
        {canViewCash && (
          <StatisticCard
            label="Cash held"
            value={
              cash.isError
                ? '—'
                : cash.data
                  ? formatMoney(cash.data.currentBalance)
                  : '…'
            }
            supportingText="Not yet settled"
          />
        )}
      </div>

      {/* tab bar */}
      {visibleTabs.length > 0 ? (
        <>
          <div className="border-b border-line">
            <div
              role="tablist"
              aria-label="Driver sections"
              className="-mb-px flex gap-1 overflow-x-auto"
            >
              {visibleTabs.map((tab) => {
                const active = tab === activeTab;
                return (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    id={`tab-${tab}`}
                    aria-selected={active}
                    aria-controls={`tabpanel-${tab}`}
                    onClick={() => selectTab(tab)}
                    className={cn(
                      'shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                      active
                        ? 'border-brand-600 text-brand-700'
                        : 'border-transparent text-ink-muted hover:text-ink',
                    )}
                  >
                    {TAB_LABEL[tab]}
                  </button>
                );
              })}
            </div>
          </div>

          <div
            role="tabpanel"
            id={`tabpanel-${activeTab}`}
            aria-labelledby={`tab-${activeTab}`}
          >
            {activeTab === 'current' && canViewOrders && (
              <CurrentOrdersTab driverId={driver.id} />
            )}
            {activeTab === 'history' && canViewOrders && (
              <DeliveryHistoryTab driverId={driver.id} />
            )}
            {activeTab === 'collections' && canViewCollections && (
              <ParcelCollectionsTab driverId={driver.id} />
            )}
            {activeTab === 'cash' && canViewCash && (
              <CashTab
                driverId={driver.id}
                driverLabel={`${driver.user.firstName} ${driver.user.lastName} · ${driver.driverNumber}`}
              />
            )}
            {activeTab === 'settlements' && canViewSettlements && (
              <SettlementsTab driverId={driver.id} />
            )}
          </div>
        </>
      ) : (
        <div className="rounded-card border border-line bg-card p-6 text-sm text-ink-muted">
          You do not have access to this driver's operational or financial
          detail.
        </div>
      )}

      {/* dialogs */}
      <DriverFormDialog
        open={editOpen}
        mode="edit"
        driver={driver}
        onClose={() => setEditOpen(false)}
        onCreated={() => setEditOpen(false)}
        onSaved={() => {
          setEditOpen(false);
          setActionNotice('Driver updated.');
        }}
      />
      <ConfirmationModal
        open={dialog === 'deactivate'}
        title="Deactivate driver?"
        description={
          <p>
            <span className="font-medium">
              {driver.user.firstName} {driver.user.lastName}
            </span>{' '}
            will remain in delivery history but cannot normally receive new
            assignments while inactive. Any cash they hold, and their login, are
            unchanged.
          </p>
        }
        confirmLabel="Deactivate"
        confirmVariant="danger"
        confirmLoading={updating}
        onConfirm={() => setActive(false, 'Driver deactivated.')}
        onCancel={() => setDialog(null)}
      />
      <ConfirmationModal
        open={dialog === 'reactivate'}
        title="Reactivate driver?"
        description={
          <p>
            <span className="font-medium">
              {driver.user.firstName} {driver.user.lastName}
            </span>{' '}
            will be able to receive new assignments again.
          </p>
        }
        confirmLabel="Reactivate"
        confirmLoading={updating}
        onConfirm={() => setActive(true, 'Driver reactivated.')}
        onCancel={() => setDialog(null)}
      />
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to={paths.management.drivers}
      className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Back to drivers
    </Link>
  );
}
