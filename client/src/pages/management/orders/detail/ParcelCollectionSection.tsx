import { useEffect, useState } from 'react';

import { usePermissions } from '../../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../../features/auth/permissions';
import { useDebouncedValue } from '../../../../lib/useDebouncedValue';
import { formatDateTime } from '../../../../lib/format';
import {
  getApiErrorCode,
  getApiErrorMessage,
  getApiErrorStatus,
  isTransportError,
  type UnknownApiError,
} from '../../../../services/apiError';
import {
  useGetParcelCollectionQuery,
  useAssignParcelCollectionDriverMutation,
  useReassignParcelCollectionDriverMutation,
  useRescheduleParcelCollectionMutation,
  useReceiveParcelAtCompanyMutation,
} from '../../../../services/parcelCollectionApi';
import { useGetDriversQuery } from '../../../../services/driversApi';
import type {
  OrderDetail,
  ParcelCollectionAssignmentEntry,
  ParcelCollectionAttemptEntry,
  ParcelCollectionDetail,
} from '../../../../services/domain.types';

import { Badge } from '../../../../components/ui/Badge';
import { Button } from '../../../../components/ui/Button';
import { EmptyState } from '../../../../components/feedback/EmptyState';
import { LoadingState } from '../../../../components/feedback/LoadingState';
import { ErrorState } from '../../../../components/feedback/ErrorState';
import { ConfirmationModal } from '../../../../components/feedback/ConfirmationModal';
import { ServerSearchSelect } from '../../../../components/forms/ServerSearchSelect';
import {
  getParcelAttemptOutcomePresentation,
  getParcelCollectionStatusPresentation,
  getParcelEndReasonLabel,
  getParcelIntakeMethodLabel,
} from '../../../../components/orders/parcelCollection';
import { Section, DetailList, type DetailRow } from './sections';

const DASH = '—';

/** Order statuses in which NO parcel-collection action should be offered. */
const TERMINAL_ORDER_STATUSES = new Set([
  'DELIVERED',
  'CANCELLED',
  'RETURNED_TO_COMPANY',
  'RETURNED_TO_CUSTOMER',
]);

type Dialog = 'assign' | 'reassign' | 'reschedule' | 'receive' | null;

function describeError(err: UnknownApiError): { message: string; stale: boolean } {
  if (isTransportError(err)) {
    return { message: 'Unable to reach the server. Please try again.', stale: false };
  }
  const status = getApiErrorStatus(err);
  const code = getApiErrorCode(err);
  if (status === 409 || code === 'CONFLICT') {
    return {
      message:
        'The collection state changed while you were viewing it. The latest details have been reloaded — review them and try again.',
      stale: true,
    };
  }
  if (typeof status === 'number' && status >= 500) {
    return { message: 'Something went wrong on the server. Please try again.', stale: false };
  }
  return { message: getApiErrorMessage(err), stale: false };
}

export function ParcelCollectionSection({ order }: { order: OrderDetail }) {
  const permissions = usePermissions();
  const canAssign = permissions.includes(PERMISSIONS.ORDERS_ASSIGN);
  const canChangeStatus = permissions.includes(PERMISSIONS.ORDERS_CHANGE_STATUS);
  const canRead = permissions.includes(PERMISSIONS.ORDERS_READ);

  const query = useGetParcelCollectionQuery(order.id, { skip: !canRead });
  const detail = query.data;

  const [dialog, setDialog] = useState<Dialog>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [assign, assignState] = useAssignParcelCollectionDriverMutation();
  const [reassign, reassignState] = useReassignParcelCollectionDriverMutation();
  const [reschedule, rescheduleState] = useRescheduleParcelCollectionMutation();
  const [receive, receiveState] = useReceiveParcelAtCompanyMutation();
  const busy =
    assignState.isLoading ||
    reassignState.isLoading ||
    rescheduleState.isLoading ||
    receiveState.isLoading;

  const open = (kind: Exclude<Dialog, null>) => {
    setDialogError(null);
    setNotice(null);
    setDialog(kind);
  };

  const runAction = async (fn: () => Promise<unknown>, successMessage: string) => {
    setDialogError(null);
    try {
      await fn();
      setNotice(successMessage);
      setDialog(null);
    } catch (e) {
      const { message, stale } = describeError(e as UnknownApiError);
      setDialogError(message);
      if (stale) {
        void query.refetch();
        setDialog(null);
      }
    }
  };

  if (!canRead) return null;

  if (query.isLoading) {
    return (
      <Section title="Parcel Intake & Collection">
        <LoadingState className="py-8" label="Loading collection details…" />
      </Section>
    );
  }
  if (query.isError || !detail) {
    return (
      <Section title="Parcel Intake & Collection">
        <ErrorState
          className="py-8"
          message={getApiErrorMessage(query.error as UnknownApiError)}
          onRetry={() => void query.refetch()}
        />
      </Section>
    );
  }

  const orderTerminal = TERMINAL_ORDER_STATUSES.has(order.status);
  const { status } = detail;

  const actions = {
    assign:
      canAssign &&
      !orderTerminal &&
      (status === 'AWAITING_ASSIGNMENT' || status === 'RESCHEDULED'),
    reassign: canAssign && !orderTerminal && status === 'ASSIGNED',
    reschedule: canChangeStatus && !orderTerminal && status === 'FAILED',
    receive:
      canChangeStatus && !orderTerminal && status === 'COLLECTED_FROM_SENDER',
  };

  const statusPresentation = getParcelCollectionStatusPresentation(status);
  const alreadyAtCompany = detail.intakeMethod === 'ALREADY_AT_COMPANY';

  return (
    <Section
      title="Parcel Intake & Collection"
      id="parcel-collection"
      action={
        query.isFetching && !query.isLoading ? (
          <LoadingState variant="inline" label="Refreshing…" />
        ) : undefined
      }
    >
      {notice && (
        <div
          role="status"
          className="mb-4 flex items-start justify-between gap-3 rounded-control border border-line bg-card px-3 py-2 text-sm text-ink-secondary"
        >
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-xs font-medium text-ink-muted hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      <DetailList
        rows={[
          {
            label: 'Intake method',
            value: (
              <Badge tone="neutral">
                {getParcelIntakeMethodLabel(detail.intakeMethod)}
              </Badge>
            ),
          },
          {
            label: 'Collection status',
            value: (
              <Badge tone={statusPresentation.tone} dot>
                {statusPresentation.label}
              </Badge>
            ),
          },
        ]}
      />

      {alreadyAtCompany ? (
        <p className="mt-4 rounded-control border border-line-subtle bg-sunken px-3 py-2 text-sm text-ink-muted">
          The parcel was already at the company when this order was created.
          There is no driver-collection workflow for this order.
          {detail.receivedAtCompanyAt && (
            <>
              {' '}Recorded {formatDateTime(detail.receivedAtCompanyAt)}
              {detail.receivedAtCompanyBy
                ? ` by ${detail.receivedAtCompanyBy.firstName} ${detail.receivedAtCompanyBy.lastName}`
                : ''}
              .
            </>
          )}
        </p>
      ) : (
        <div className="mt-4 space-y-5">
          <CollectionSnapshot detail={detail} />
          <CurrentCollectionDriver detail={detail} />

          {status === 'COLLECTED_FROM_SENDER' && (
            <p className="rounded-control border border-info-200 bg-info-50 px-3 py-2 text-sm text-info-700">
              The collection driver currently has the parcel in transit to the
              company. Confirm it has been received at the company to make this
              order eligible for delivery assignment.
            </p>
          )}
          {status === 'RECEIVED_AT_COMPANY' && (
            <p className="rounded-control border border-success-200 bg-success-50 px-3 py-2 text-sm text-success-700">
              Received at the company
              {detail.receivedAtCompanyAt
                ? ` on ${formatDateTime(detail.receivedAtCompanyAt)}`
                : ''}
              {detail.receivedAtCompanyBy
                ? ` by ${detail.receivedAtCompanyBy.firstName} ${detail.receivedAtCompanyBy.lastName}`
                : ''}
              . A delivery driver can now be assigned.
            </p>
          )}

          <FailedAttemptCallout detail={detail} />

          {(actions.assign ||
            actions.reassign ||
            actions.reschedule ||
            actions.receive) && (
            <div className="flex flex-wrap gap-2">
              {actions.assign && (
                <Button onClick={() => open('assign')} disabled={busy}>
                  Assign collection driver
                </Button>
              )}
              {actions.reassign && (
                <Button
                  variant="secondary"
                  onClick={() => open('reassign')}
                  disabled={busy}
                >
                  Reassign collection driver
                </Button>
              )}
              {actions.receive && (
                <Button onClick={() => open('receive')} disabled={busy}>
                  Confirm received at company
                </Button>
              )}
              {actions.reschedule && (
                <Button
                  variant="secondary"
                  onClick={() => open('reschedule')}
                  disabled={busy}
                >
                  Reschedule collection
                </Button>
              )}
            </div>
          )}

          <CollectionAssignmentHistory rows={detail.assignments} />
          <CollectionAttemptHistory rows={detail.attempts} />
        </div>
      )}

      {/* -------------------------- dialogs -------------------------- */}
      <CollectionDriverDialog
        open={dialog === 'assign'}
        mode="assign"
        loading={assignState.isLoading}
        error={dialogError}
        onCancel={() => setDialog(null)}
        onConfirm={(driverId) =>
          void runAction(
            () => assign({ orderId: order.id, driverId }).unwrap(),
            'Collection driver assigned.',
          )
        }
      />
      <CollectionDriverDialog
        open={dialog === 'reassign'}
        mode="reassign"
        currentDriverId={detail.currentCollectionDriver?.id ?? null}
        currentDriverLabel={
          detail.currentCollectionDriver
            ? `${detail.currentCollectionDriver.driverNumber} · ${detail.currentCollectionDriver.user.firstName} ${detail.currentCollectionDriver.user.lastName}`
            : null
        }
        loading={reassignState.isLoading}
        error={dialogError}
        onCancel={() => setDialog(null)}
        onConfirm={(driverId) =>
          void runAction(
            () => reassign({ orderId: order.id, driverId }).unwrap(),
            'Collection driver reassigned.',
          )
        }
      />
      <ConfirmationModal
        open={dialog === 'receive'}
        title="Confirm received at company"
        description={
          <div className="space-y-2">
            <p>
              This confirms the collection driver has physically handed the
              parcel over to the company. The order then becomes eligible for
              delivery assignment.
            </p>
            {dialogError && (
              <p role="alert" className="text-xs text-danger-700">
                {dialogError}
              </p>
            )}
          </div>
        }
        confirmLabel="Confirm receipt"
        confirmLoading={receiveState.isLoading}
        onConfirm={() =>
          void runAction(
            () => receive({ orderId: order.id }).unwrap(),
            'Parcel received at the company.',
          )
        }
        onCancel={() => setDialog(null)}
      />
      <ConfirmationModal
        open={dialog === 'reschedule'}
        title="Reschedule collection"
        description={
          <div className="space-y-2">
            <p>
              Approves another collection attempt (
              <span className="font-medium">Collection Failed → Rescheduled</span>
              ). A collection driver can then be assigned. There is no scheduled
              date in V1.
            </p>
            {dialogError && (
              <p role="alert" className="text-xs text-danger-700">
                {dialogError}
              </p>
            )}
          </div>
        }
        confirmLabel="Reschedule"
        confirmLoading={rescheduleState.isLoading}
        onConfirm={() =>
          void runAction(
            () => reschedule({ orderId: order.id }).unwrap(),
            'Collection approved for another attempt.',
          )
        }
        onCancel={() => setDialog(null)}
      />
    </Section>
  );
}

/* --------------------------- sub-components --------------------------- */

function CollectionSnapshot({ detail }: { detail: ParcelCollectionDetail }) {
  const s = detail.collectionSnapshot;
  const rows: DetailRow[] = [
    { label: 'Collection contact', value: s.contactName || DASH },
    {
      label: 'Phone',
      value: s.phone ? (
        <a href={`tel:${s.phone}`} className="text-brand-600 hover:underline">
          {s.phone}
        </a>
      ) : (
        DASH
      ),
    },
  ];
  if (s.altPhone) {
    rows.push({
      label: 'Alternative phone',
      value: (
        <a href={`tel:${s.altPhone}`} className="text-brand-600 hover:underline">
          {s.altPhone}
        </a>
      ),
    });
  }
  rows.push(
    { label: 'Area', value: s.area || DASH },
    { label: 'Collection address', value: s.address || DASH, wide: true },
  );
  if (s.notes) rows.push({ label: 'Notes', value: s.notes, wide: true });

  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
        Collection snapshot
      </h3>
      <p className="mt-1 mb-3 text-xs text-ink-muted">
        Taken from the customer when the order was created — later customer edits
        do not change it.
      </p>
      <DetailList rows={rows} />
    </div>
  );
}

function CurrentCollectionDriver({ detail }: { detail: ParcelCollectionDetail }) {
  const d = detail.currentCollectionDriver;
  if (!d) {
    return (
      <DetailList
        rows={[
          {
            label: 'Collection driver',
            value: <span className="text-ink-subtle">None assigned</span>,
          },
        ]}
      />
    );
  }
  const rows: DetailRow[] = [
    {
      label: 'Collection driver',
      value: (
        <span className="font-medium">
          {d.driverNumber} · {d.user.firstName} {d.user.lastName}
        </span>
      ),
    },
  ];
  if (d.user.phone) {
    rows.push({
      label: 'Driver phone',
      value: (
        <a href={`tel:${d.user.phone}`} className="text-brand-600 hover:underline">
          {d.user.phone}
        </a>
      ),
    });
  }
  return <DetailList rows={rows} />;
}

function FailedAttemptCallout({ detail }: { detail: ParcelCollectionDetail }) {
  if (detail.status !== 'FAILED') return null;
  const last = [...detail.attempts]
    .reverse()
    .find((a) => a.outcome === 'FAILED');
  if (!last) return null;
  return (
    <div className="rounded-control border border-danger-200 bg-danger-50 px-3 py-2 text-sm">
      <p className="font-medium text-danger-700">
        Collection attempt #{last.attemptNumber} failed
      </p>
      <dl className="mt-1 grid grid-cols-1 gap-x-6 gap-y-0.5 text-xs text-ink-secondary sm:grid-cols-2">
        {last.failedReason && (
          <div className="sm:col-span-2">Reason: {last.failedReason.name}</div>
        )}
        {last.notes && <div className="sm:col-span-2">Notes: {last.notes}</div>}
        <div>
          Driver: {last.driver.driverNumber} · {last.driver.user.firstName}{' '}
          {last.driver.user.lastName}
        </div>
        <div>When: {formatDateTime(last.completedAt)}</div>
      </dl>
    </div>
  );
}

function CollectionAssignmentHistory({
  rows,
}: {
  rows: ParcelCollectionAssignmentEntry[];
}) {
  // Backend oldest-first; show newest-first without mutating the cache.
  const list = [...rows].reverse();
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
        Collection assignment history
      </h3>
      {list.length === 0 ? (
        <EmptyState
          className="py-6"
          title="No collection assignments yet"
          description="This order has never had a collection driver assigned."
        />
      ) : (
        <ul className="mt-2 divide-y divide-line-subtle">
          {list.map((a) => (
            <li key={a.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-ink">
                  {a.driver.driverNumber} · {a.driver.user.firstName}{' '}
                  {a.driver.user.lastName}
                </p>
                <Badge tone={a.isCurrent ? 'success' : 'neutral'}>
                  {a.isCurrent ? 'Current' : 'Historical'}
                </Badge>
              </div>
              <dl className="mt-1 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-ink-muted sm:grid-cols-2">
                <div>
                  Assigned {formatDateTime(a.assignedAt)} by{' '}
                  {a.assignedBy.firstName} {a.assignedBy.lastName}
                </div>
                <div>
                  {a.endedAt
                    ? `Ended ${formatDateTime(a.endedAt)}`
                    : 'Active — driver holds custody'}
                </div>
                {a.endReason && (
                  <div className="sm:col-span-2">
                    Reason: {getParcelEndReasonLabel(a.endReason)}
                  </div>
                )}
              </dl>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CollectionAttemptHistory({
  rows,
}: {
  rows: ParcelCollectionAttemptEntry[];
}) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
        Collection attempts
      </h3>
      {rows.length === 0 ? (
        <EmptyState
          className="py-6"
          title="No collection attempts yet"
          description="Attempts appear once the collection driver records an outcome."
        />
      ) : (
        <ul className="mt-2 space-y-3">
          {rows.map((att) => {
            const outcome = getParcelAttemptOutcomePresentation(att.outcome);
            return (
              <li
                key={att.id}
                className="rounded-control border border-line-subtle bg-sunken p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-ink">
                    Attempt #{att.attemptNumber}
                  </p>
                  <Badge tone={outcome.tone}>{outcome.label}</Badge>
                </div>
                <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
                  <div>
                    <span className="text-ink-muted">Driver: </span>
                    <span className="text-ink">
                      {att.driver.driverNumber} · {att.driver.user.firstName}{' '}
                      {att.driver.user.lastName}
                    </span>
                  </div>
                  {/* startedAt is null in V1 — never rendered as a date. */}
                  <div>
                    <span className="text-ink-muted">Completed: </span>
                    <span className="text-ink">
                      {formatDateTime(att.completedAt)}
                    </span>
                  </div>
                  {att.failedReason && (
                    <div>
                      <span className="text-ink-muted">Failed reason: </span>
                      <span className="text-ink">{att.failedReason.name}</span>
                    </div>
                  )}
                  {att.notes && (
                    <div className="sm:col-span-2">
                      <span className="text-ink-muted">Notes: </span>
                      <span className="text-ink">{att.notes}</span>
                    </div>
                  )}
                </dl>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* --------------------------- driver dialog --------------------------- */

interface CollectionDriverDialogProps {
  open: boolean;
  mode: 'assign' | 'reassign';
  currentDriverId?: string | null;
  currentDriverLabel?: string | null;
  loading?: boolean;
  error?: string | null;
  onConfirm: (driverId: string) => void;
  onCancel: () => void;
}

/**
 * Collection-driver picker for POST /orders/:id/parcel-collection/{assign,reassign}.
 * Both endpoints take only { driverId } — reassign has no reason field. The
 * backend re-validates driver eligibility, collection state and
 * "new driver must differ" (reassign).
 */
function CollectionDriverDialog({
  open,
  mode,
  currentDriverId = null,
  currentDriverLabel = null,
  loading = false,
  error = null,
  onConfirm,
  onCancel,
}: CollectionDriverDialogProps) {
  const [driverId, setDriverId] = useState('');
  const [term, setTerm] = useState('');
  const debouncedTerm = useDebouncedValue(term, 300);
  const drivers = useGetDriversQuery(
    { search: debouncedTerm.trim() || undefined, isActive: true, limit: 20 },
    { skip: !open },
  );

  useEffect(() => {
    if (!open) {
      setDriverId('');
      setTerm('');
    }
  }, [open]);

  const isReassign = mode === 'reassign';
  const sameDriver = isReassign && driverId !== '' && driverId === currentDriverId;
  const canConfirm = driverId !== '' && !sameDriver;

  return (
    <ConfirmationModal
      open={open}
      title={isReassign ? 'Reassign collection driver' : 'Assign collection driver'}
      confirmLabel={isReassign ? 'Reassign' : 'Assign'}
      confirmLoading={loading}
      confirmDisabled={!canConfirm}
      onConfirm={() => onConfirm(driverId)}
      onCancel={onCancel}
      description={
        <div className="space-y-3">
          <p className="text-sm text-ink-secondary">
            The collection driver brings the parcel from the sender to the
            company.
          </p>
          {isReassign && (
            <p className="text-sm text-ink-secondary">
              Current collection driver:{' '}
              <span className="font-medium text-ink">
                {currentDriverLabel ?? '—'}
              </span>
            </p>
          )}
          <ServerSearchSelect
            label={isReassign ? 'New collection driver' : 'Collection driver'}
            variant="field"
            required
            anyLabel="Select a driver…"
            searchPlaceholder="Search active drivers…"
            value={driverId}
            onChange={setDriverId}
            searchTerm={term}
            onSearchTermChange={setTerm}
            loading={drivers.isFetching}
            total={drivers.data?.meta.total}
            options={(drivers.data?.items ?? []).map((d) => ({
              id: d.id,
              label: `${d.driverNumber} · ${d.user.firstName} ${d.user.lastName}${
                d.user.phone ? ` · ${d.user.phone}` : ''
              }`,
            }))}
            error={
              sameDriver
                ? 'Choose a driver other than the current one.'
                : undefined
            }
          />
          {error && (
            <p role="alert" className="text-xs text-danger-700">
              {error}
            </p>
          )}
        </div>
      }
    />
  );
}
