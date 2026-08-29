import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft } from 'lucide-react';

import { paths } from '../../../../routes/paths';
import { usePermissions } from '../../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../../features/auth/permissions';
import {
  useGetOrderQuery,
  useAssignOrderMutation,
  useCancelOrderMutation,
  useReadyOrderMutation,
  useReassignOrderMutation,
  useRescheduleOrderMutation,
} from '../../../../services/ordersApi';
import {
  getApiErrorCode,
  getApiErrorMessage,
  getApiErrorStatus,
  isTransportError,
  type UnknownApiError,
} from '../../../../services/apiError';
import { formatDateTime, formatMoney } from '../../../../lib/format';

import { PageHeader } from '../../../../components/data-display/PageHeader';
import { Button } from '../../../../components/ui/Button';
import { StatusBadge } from '../../../../components/orders/StatusBadge';
import { OrderTypeBadge } from '../../../../components/orders/OrderTypeBadge';
import { LoadingState } from '../../../../components/feedback/LoadingState';
import { ErrorState } from '../../../../components/feedback/ErrorState';

import { getOrderDetailActions } from './orderDetailActions';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { DriverDialog } from './DriverDialog';
import { ReasonDialog } from './ReasonDialog';
import { EditOrderDialog } from './EditOrderDialog';
import {
  AssignmentHistorySection,
  CustomerSection,
  DeliveryAttemptsSection,
  DeliverySection,
  FinancialSection,
  OrderSummarySection,
  PackageSection,
  ReceiverSection,
  TimelineSection,
} from './sections';

type DialogKind = 'assign' | 'reassign' | 'reschedule' | 'cancel' | 'edit' | null;

interface CreatedNavState {
  justCreated?: boolean;
  assigned?: boolean;
  orderNumber?: string;
}

function describeActionError(err: UnknownApiError): {
  message: string;
  stale: boolean;
} {
  if (isTransportError(err)) {
    return {
      message: 'Unable to reach the server. Please try again.',
      stale: false,
    };
  }
  const status = getApiErrorStatus(err);
  const code = getApiErrorCode(err);
  if (status === 409 || code === 'CONFLICT') {
    return {
      message:
        'This order changed while you were viewing it. The latest details have been reloaded — review them and try again.',
      stale: true,
    };
  }
  if (typeof status === 'number' && status >= 500) {
    return {
      message: 'Something went wrong on the server. Please try again.',
      stale: false,
    };
  }
  return { message: getApiErrorMessage(err), stale: false };
}

export default function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const permissions = usePermissions();

  const query = useGetOrderQuery(id ?? '', { skip: !id });
  const order = query.data;

  const [dialog, setDialog] = useState<DialogKind>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const navState = location.state as CreatedNavState | null;
  const [showCreatedBanner, setShowCreatedBanner] = useState(
    Boolean(navState?.justCreated),
  );

  const [ready, readyState] = useReadyOrderMutation();
  const [assign, assignState] = useAssignOrderMutation();
  const [reassign, reassignState] = useReassignOrderMutation();
  const [reschedule, rescheduleState] = useRescheduleOrderMutation();
  const [cancel, cancelState] = useCancelOrderMutation();

  const busy =
    readyState.isLoading ||
    assignState.isLoading ||
    reassignState.isLoading ||
    rescheduleState.isLoading ||
    cancelState.isLoading;

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const openDialog = (kind: Exclude<DialogKind, null>) => {
    setDialogError(null);
    setActionError(null);
    setDialog(kind);
  };
  const closeDialog = () => setDialog(null);

  const handleStale = () => {
    void query.refetch();
  };

  const runAction = async (
    fn: () => Promise<unknown>,
    successMessage: string,
    fromDialog: boolean,
  ) => {
    try {
      await fn();
      setActionNotice(successMessage);
      setActionError(null);
      setDialog(null);
    } catch (e) {
      const { message, stale } = describeActionError(e as UnknownApiError);
      if (fromDialog) setDialogError(message);
      else setActionError(message);
      if (stale) {
        handleStale();
        if (fromDialog) setDialog(null);
      }
    }
  };

  const copyTrackingCode = async () => {
    if (!order) return;
    try {
      await navigator.clipboard.writeText(order.trackingCode);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setActionError('Could not copy the tracking code to the clipboard.');
    }
  };

  const scrollToHistory = () => {
    document
      .getElementById('order-history')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  /* ----------------------------- loading / error --------------------------- */

  if (!id || query.isError || (query.isSuccess && !order)) {
    const status = getApiErrorStatus(query.error);
    const code = getApiErrorCode(query.error);
    const notFound = !id || status === 404 || code === 'NOT_FOUND';
    const badRequest = status === 400;
    return (
      <div className="mx-auto max-w-2xl">
        <BackLink />
        <ErrorState
          className="py-16"
          title={notFound ? 'Order not found' : 'Could not load this order'}
          message={
            notFound
              ? 'This order does not exist or may have been removed.'
              : badRequest
                ? 'That order reference is not valid.'
                : getApiErrorMessage(query.error as UnknownApiError)
          }
          onRetry={notFound ? undefined : () => void query.refetch()}
          action={
            <Link
              to={paths.management.orders}
              className="inline-flex h-8 items-center rounded-control border border-line bg-card px-3 text-xs font-medium text-ink-secondary hover:bg-sunken"
            >
              Back to orders
            </Link>
          }
        />
      </div>
    );
  }

  if (query.isLoading || !order) {
    return (
      <div className="space-y-5">
        <BackLink />
        <PageHeader title="Order" size="lg" />
        <LoadingState className="py-16" label="Loading order…" />
      </div>
    );
  }

  /* -------------------------------- ready --------------------------------- */

  const actions = getOrderDetailActions(order, permissions);
  const canViewCustomer = permissions.includes(PERMISSIONS.CUSTOMERS_READ);
  const canViewWallet = permissions.includes(PERMISSIONS.WALLETS_READ);
  const canViewDriver = permissions.includes(PERMISSIONS.DRIVERS_READ);

  const currentAssignment =
    order.assignmentHistory.find((a) => a.isCurrent) ?? null;
  const currentDriverLabel = currentAssignment
    ? `${currentAssignment.driver.driverNumber} · ${currentAssignment.driver.user.firstName} ${currentAssignment.driver.user.lastName}`
    : (order.currentDriver?.driverNumber ?? null);

  const reviewRequired =
    order.financial.needsFinancialReview ||
    order.financialStatus === 'REVIEW_REQUIRED';

  /* --------------------------- action bar assembly ------------------------ */

  let primaryAction: ReactNode = null;
  if (actions.canMarkReady) {
    primaryAction = (
      <Button
        onClick={() =>
          void runAction(
            () => ready(order.id).unwrap(),
            'Order marked ready for pickup.',
            false,
          )
        }
        loading={readyState.isLoading}
        disabled={busy}
      >
        Mark ready
      </Button>
    );
  } else if (actions.canAssign) {
    primaryAction = (
      <Button onClick={() => openDialog('assign')} disabled={busy}>
        Assign driver
      </Button>
    );
  } else if (actions.canReassign) {
    primaryAction = (
      <Button onClick={() => openDialog('reassign')} disabled={busy}>
        Reassign driver
      </Button>
    );
  }

  const menuItems: ActionMenuItem[] = [];
  if (actions.canReschedule) {
    menuItems.push({
      key: 'reschedule',
      label: 'Reschedule',
      onSelect: () => openDialog('reschedule'),
    });
  }
  menuItems.push({
    key: 'copy-code',
    label: copied ? 'Tracking code copied' : 'Copy tracking code',
    onSelect: () => void copyTrackingCode(),
  });
  menuItems.push({
    key: 'copy-link',
    label: 'Copy tracking link',
    disabled: true,
    hint: 'Available once public tracking ships (Phase 14).',
    onSelect: () => {},
  });
  menuItems.push({
    key: 'history',
    label: 'View history',
    onSelect: scrollToHistory,
  });
  if (actions.canCancel) {
    menuItems.push({
      key: 'cancel',
      label: 'Cancel order',
      danger: true,
      onSelect: () => openDialog('cancel'),
    });
  }

  const actionBar = (
    <div className="flex flex-wrap items-center gap-2">
      {query.isFetching && !query.isLoading && (
        <LoadingState variant="inline" label="Refreshing…" />
      )}
      {primaryAction}
      {actions.canEdit && (
        <Button
          variant="secondary"
          onClick={() => openDialog('edit')}
          disabled={busy}
        >
          Edit
        </Button>
      )}
      <ActionMenu items={menuItems} disabled={busy} />
    </div>
  );

  return (
    <div className="space-y-5 pb-6">
      <BackLink />

      {showCreatedBanner && (
        <div className="flex items-start justify-between gap-3 rounded-card border border-success-200 bg-success-50 px-4 py-3 text-sm">
          <p className="text-success-700">
            Order created successfully
            {navState?.assigned ? ' and assigned to a driver' : ''}.
          </p>
          <button
            type="button"
            onClick={() => setShowCreatedBanner(false)}
            className="text-xs font-medium text-success-700 hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      <PageHeader
        size="lg"
        title={order.orderNumber}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <StatusBadge status={order.status} />
            <OrderTypeBadge orderType={order.orderType} />
            <span className="text-ink-muted">Tracking {order.trackingCode}</span>
            <span className="text-ink-subtle" aria-hidden="true">
              ·
            </span>
            <span className="text-ink-muted">
              Created {formatDateTime(order.createdAt)}
            </span>
          </span>
        }
        actions={actionBar}
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

      {reviewRequired && (
        <div
          role="alert"
          className="rounded-card border border-danger-200 bg-danger-50 p-4"
        >
          <p className="flex items-center gap-2 text-sm font-semibold text-danger-700">
            <AlertTriangle className="size-4" aria-hidden="true" />
            Financial review required
          </p>
          <p className="mt-1 text-sm text-ink-secondary">
            The amount collected on delivery differs from what was expected. An
            authorised Finance user must resolve how the difference splits
            between the customer wallet and company revenue — it is not decided
            here.
          </p>
          <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-ink-muted">Expected</dt>
              <dd className="text-ink">
                {formatMoney(order.financial.amountToCollect)}
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted">Actual collected</dt>
              <dd className="text-ink">
                {formatMoney(order.financial.actualAmountCollected)}
              </dd>
            </div>
            {order.financial.collectionDifferenceReason && (
              <div className="sm:col-span-3">
                <dt className="text-ink-muted">Reason given</dt>
                <dd className="text-ink">
                  {order.financial.collectionDifferenceReason}
                </dd>
              </div>
            )}
          </dl>
        </div>
      )}

      <div className="space-y-5 lg:grid lg:grid-cols-3 lg:items-start lg:gap-5 lg:space-y-0">
        <aside className="space-y-5 lg:col-start-3 lg:row-start-1">
          <CustomerSection
            order={order}
            canViewCustomer={canViewCustomer}
            canViewWallet={canViewWallet}
          />
          <FinancialSection order={order} />
        </aside>

        <div className="space-y-5 lg:col-span-2 lg:col-start-1 lg:row-start-1">
          <OrderSummarySection order={order} />
          <ReceiverSection order={order} />
          <PackageSection order={order} />
          <DeliverySection order={order} canViewDriver={canViewDriver} />
          <AssignmentHistorySection order={order} />
          <DeliveryAttemptsSection order={order} />
          <TimelineSection order={order} />
        </div>
      </div>

      {/* -------------------------------- dialogs ---------------------------- */}

      <DriverDialog
        open={dialog === 'assign'}
        mode="assign"
        loading={assignState.isLoading}
        error={dialogError}
        onCancel={closeDialog}
        onConfirm={(driverId) =>
          void runAction(
            () => assign({ id: order.id, driverId }).unwrap(),
            'Driver assigned.',
            true,
          )
        }
      />

      <DriverDialog
        open={dialog === 'reassign'}
        mode="reassign"
        currentDriverId={order.currentDriver?.id ?? null}
        currentDriverLabel={currentDriverLabel}
        loading={reassignState.isLoading}
        error={dialogError}
        onCancel={closeDialog}
        onConfirm={(driverId, reason) =>
          void runAction(
            () =>
              reassign({
                id: order.id,
                driverId,
                reason: reason ?? '',
              }).unwrap(),
            'Driver reassigned.',
            true,
          )
        }
      />

      <ReasonDialog
        open={dialog === 'reschedule'}
        title="Reschedule delivery"
        description={
          <p>
            Moves this failed delivery back into the workflow (
            <span className="font-medium">Failed delivery → Rescheduled</span>).
            The current driver assignment is kept.
          </p>
        }
        confirmLabel="Reschedule"
        loading={rescheduleState.isLoading}
        error={dialogError}
        onCancel={closeDialog}
        onConfirm={(reason, notes) =>
          void runAction(
            () =>
              reschedule({ id: order.id, reason, notes }).unwrap(),
            'Order rescheduled.',
            true,
          )
        }
      />

      <ReasonDialog
        open={dialog === 'cancel'}
        title="Cancel order"
        description={
          <p>
            The order and its full history are kept — only its status changes to{' '}
            <span className="font-medium">Cancelled</span>. This cannot be undone
            from here.
          </p>
        }
        confirmLabel="Cancel order"
        confirmVariant="danger"
        loading={cancelState.isLoading}
        error={dialogError}
        onCancel={closeDialog}
        onConfirm={(reason, notes) =>
          void runAction(
            () => cancel({ id: order.id, reason, notes }).unwrap(),
            'Order cancelled.',
            true,
          )
        }
      />

      <EditOrderDialog
        open={dialog === 'edit'}
        order={order}
        onClose={closeDialog}
        onSaved={() => {
          setDialog(null);
          setActionNotice('Order updated.');
        }}
        onStale={handleStale}
      />
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to={paths.management.orders}
      className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Back to orders
    </Link>
  );
}
