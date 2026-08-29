import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

import { paths } from '../../../routes/paths';
import { usePermissions } from '../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../features/auth/permissions';
import {
  useGetCustomerQuery,
  useUpdateCustomerMutation,
} from '../../../services/customersApi';
import { useGetWalletQuery } from '../../../services/walletsApi';
import {
  getApiErrorCode,
  getApiErrorMessage,
  getApiErrorStatus,
  type UnknownApiError,
} from '../../../services/apiError';
import { formatMoney } from '../../../lib/format';

import { PageHeader } from '../../../components/data-display/PageHeader';
import { Button } from '../../../components/ui/Button';
import { StatisticCard } from '../../../components/data-display/StatisticCard';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { ConfirmationModal } from '../../../components/feedback/ConfirmationModal';
import { cn } from '../../../components/ui/cn';

import { ActiveBadge } from '../../../components/ui/ActiveBadge';
import { CustomerFormDialog } from './CustomerFormDialog';
import {
  OverviewTab,
  OrdersTab,
  WalletTab,
  PayoutsTab,
  ActivityTab,
} from './customerDetailTabs';

type TabId = 'overview' | 'orders' | 'wallet' | 'payouts' | 'activity';
type DialogKind = 'edit' | 'deactivate' | 'reactivate' | null;

const TAB_LABEL: Record<TabId, string> = {
  overview: 'Overview',
  orders: 'Orders',
  wallet: 'Wallet',
  payouts: 'Payouts',
  activity: 'Activity',
};

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [sp, setSp] = useSearchParams();
  const permissions = usePermissions();

  const query = useGetCustomerQuery(id ?? '', { skip: !id });
  const customer = query.data;

  const canEdit = permissions.includes(PERMISSIONS.CUSTOMERS_UPDATE);
  const canCreateOrder = permissions.includes(PERMISSIONS.ORDERS_CREATE);
  const canViewOrders = permissions.includes(PERMISSIONS.ORDERS_READ);
  const canViewWallet = permissions.includes(PERMISSIONS.WALLETS_READ);
  const canViewPayouts = permissions.includes(PERMISSIONS.PAYOUTS_READ);
  const canViewAudit = permissions.includes(PERMISSIONS.AUDIT_READ);

  const visibleTabs = useMemo<TabId[]>(() => {
    const tabs: TabId[] = ['overview'];
    if (canViewOrders) tabs.push('orders');
    if (canViewWallet) tabs.push('wallet');
    if (canViewPayouts) tabs.push('payouts');
    // Activity: real CUSTOMER audit events now exist (Phase 11.6 correction).
    // audit.read only (ADMIN) — never Dispatcher/Finance.
    if (canViewAudit) tabs.push('activity');
    return tabs;
  }, [canViewOrders, canViewWallet, canViewPayouts, canViewAudit]);

  const requestedTab = sp.get('tab');
  const activeTab: TabId =
    requestedTab && (visibleTabs as string[]).includes(requestedTab)
      ? (requestedTab as TabId)
      : 'overview';

  // Normalise an invalid / unauthorized ?tab in the URL to the first permitted
  // tab so a hand-edited URL can never land on a hidden tab.
  useEffect(() => {
    if (requestedTab && requestedTab !== activeTab) {
      const next = new URLSearchParams(sp);
      next.set('tab', activeTab);
      setSp(next, { replace: true });
    }
  }, [requestedTab, activeTab, sp, setSp]);

  const selectTab = (tab: TabId) => {
    const next = new URLSearchParams(sp);
    if (tab === 'overview') next.delete('tab');
    else next.set('tab', tab);
    // A tab change drops the previous tab's pagination params.
    next.delete('ordersPage');
    next.delete('walletPage');
    next.delete('payoutsPage');
    next.delete('activityPage');
    setSp(next);
  };

  const [dialog, setDialog] = useState<DialogKind>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [updateCustomer, { isLoading: updating }] = useUpdateCustomerMutation();

  /* summary data — order counts come from the authoritative
     CustomerDetail.orderSummary (server DB counts); wallet from the
     wallets.read-gated endpoint. */
  const wallet = useGetWalletQuery(id ?? '', {
    skip: !id || !canViewWallet,
  });

  /* ------------------------------ error states --------------------------- */

  if (!id || query.isError || (query.isSuccess && !customer)) {
    const status = getApiErrorStatus(query.error);
    const code = getApiErrorCode(query.error);
    const notFound = !id || status === 404 || code === 'NOT_FOUND';
    return (
      <div className="mx-auto max-w-2xl">
        <BackLink />
        <ErrorState
          className="py-16"
          title={notFound ? 'Customer not found' : 'Could not load this customer'}
          message={
            notFound
              ? 'This customer does not exist or the reference is not valid.'
              : getApiErrorMessage(query.error as UnknownApiError)
          }
          onRetry={notFound ? undefined : () => void query.refetch()}
          action={
            <Link
              to={paths.management.customers}
              className="inline-flex h-8 items-center rounded-control border border-line bg-card px-3 text-xs font-medium text-ink-secondary hover:bg-sunken"
            >
              Back to customers
            </Link>
          }
        />
      </div>
    );
  }

  if (query.isLoading || !customer) {
    return (
      <div className="space-y-5">
        <BackLink />
        <PageHeader title="Customer" size="lg" />
        <LoadingState className="py-16" label="Loading customer…" />
      </div>
    );
  }

  /* -------------------------------- ready -------------------------------- */

  const runIsActive = (isActive: boolean, message: string) =>
    void (async () => {
      setActionError(null);
      try {
        await updateCustomer({ id: customer.id, body: { isActive } }).unwrap();
        setDialog(null);
        setActionNotice(message);
      } catch (e) {
        setActionError(getApiErrorMessage(e as UnknownApiError));
        setDialog(null);
      }
    })();

  const headerActions = (
    <div className="flex flex-wrap items-center gap-2">
      {canEdit && (
        <Button variant="secondary" onClick={() => setDialog('edit')}>
          Edit customer
        </Button>
      )}
      {canCreateOrder && (
        <Link
          to={`${paths.management.orderNew}?customerId=${customer.id}`}
          className="inline-flex h-10 items-center gap-2 rounded-control bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
        >
          Create order
        </Link>
      )}
      {canEdit &&
        (customer.isActive ? (
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
        ))}
    </div>
  );

  const showFinancialCards = canViewWallet;
  const showOrderCards = canViewOrders;

  return (
    <div className="space-y-5 pb-6">
      <BackLink />

      <PageHeader
        size="lg"
        title={customer.name}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <ActiveBadge isActive={customer.isActive} />
            <span className="text-ink-muted">{customer.customerNumber}</span>
            <span className="text-ink-subtle" aria-hidden="true">
              ·
            </span>
            <span className="text-ink-muted">{customer.primaryPhone}</span>
            {customer.area && (
              <>
                <span className="text-ink-subtle" aria-hidden="true">
                  ·
                </span>
                <span className="text-ink-muted">{customer.area.name}</span>
              </>
            )}
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

      {(showFinancialCards || showOrderCards) && (
        <div
          className={cn(
            'grid gap-3 sm:grid-cols-2',
            showFinancialCards && showOrderCards
              ? 'lg:grid-cols-4'
              : 'lg:grid-cols-2',
          )}
        >
          {showFinancialCards && (
            <>
              <StatisticCard
                label="Available wallet"
                value={
                  wallet.data
                    ? formatMoney(wallet.data.wallet.availableBalance)
                    : wallet.isError
                      ? '—'
                      : '…'
                }
              />
              <StatisticCard
                label="Pending amount"
                value={
                  wallet.data
                    ? formatMoney(wallet.data.wallet.pendingAmount)
                    : wallet.isError
                      ? '—'
                      : '…'
                }
                supportingText="Qualifying active delivery-only orders"
              />
            </>
          )}
          {showOrderCards && (
            <>
              <StatisticCard
                label="Active orders"
                value={String(customer.orderSummary.activeOrders)}
                supportingText="Not yet in a terminal state"
              />
              <StatisticCard
                label="Delivered orders"
                value={String(customer.orderSummary.deliveredOrders)}
              />
            </>
          )}
        </div>
      )}

      {/* tab bar */}
      <div className="border-b border-line">
        <div role="tablist" aria-label="Customer sections" className="-mb-px flex gap-1 overflow-x-auto">
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
        {activeTab === 'overview' && (
          <OverviewTab
            customer={customer}
            canViewOrders={canViewOrders}
            canViewWallet={canViewWallet}
            canViewPayouts={canViewPayouts}
          />
        )}
        {activeTab === 'orders' && canViewOrders && (
          <OrdersTab customerId={customer.id} />
        )}
        {activeTab === 'wallet' && canViewWallet && (
          <WalletTab customerId={customer.id} />
        )}
        {activeTab === 'payouts' && canViewPayouts && (
          <PayoutsTab customerId={customer.id} />
        )}
        {activeTab === 'activity' && canViewAudit && (
          <ActivityTab customerId={customer.id} />
        )}
      </div>

      {/* dialogs */}
      <CustomerFormDialog
        open={dialog === 'edit'}
        mode="edit"
        customer={customer}
        onClose={() => setDialog(null)}
        onCreated={() => setDialog(null)}
        onSaved={() => {
          setDialog(null);
          setActionNotice('Customer updated.');
        }}
      />

      <ConfirmationModal
        open={dialog === 'deactivate'}
        title="Deactivate customer?"
        description={
          <p>
            <span className="font-medium">{customer.name}</span> will remain in
            history and all existing orders are unaffected, but the customer
            cannot normally be used for new orders while inactive.
          </p>
        }
        confirmLabel="Deactivate"
        confirmVariant="danger"
        confirmLoading={updating}
        onConfirm={() => runIsActive(false, 'Customer deactivated.')}
        onCancel={() => setDialog(null)}
      />

      <ConfirmationModal
        open={dialog === 'reactivate'}
        title="Reactivate customer?"
        description={
          <p>
            <span className="font-medium">{customer.name}</span> will be able to
            receive new orders again.
          </p>
        }
        confirmLabel="Reactivate"
        confirmLoading={updating}
        onConfirm={() => runIsActive(true, 'Customer reactivated.')}
        onCancel={() => setDialog(null)}
      />
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to={paths.management.customers}
      className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Back to customers
    </Link>
  );
}
