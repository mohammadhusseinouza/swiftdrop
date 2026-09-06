import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, MapPin, Package, Phone, Wallet } from 'lucide-react';

import { paths } from '../../routes/paths';
import {
  useDeliverDriverOrderMutation,
  useFailDriverOrderMutation,
  useGetDriverJobDetailQuery,
  useMarkParcelCollectedMutation,
  usePickupDriverOrderMutation,
  useReportParcelCollectionFailedMutation,
  useStartDriverOrderDeliveryMutation,
} from '../../services/ordersApi';
import {
  getApiErrorCode,
  getApiErrorMessage,
  getApiErrorStatus,
  isTransportError,
  type UnknownApiError,
} from '../../services/apiError';
import { formatDateTime, formatMoney, isZeroMoney } from '../../lib/format';

import { PageHeader } from '../../components/data-display/PageHeader';
import { LoadingState } from '../../components/feedback/LoadingState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { ConfirmationModal } from '../../components/feedback/ConfirmationModal';
import { Card } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { StatusBadge } from '../../components/orders/StatusBadge';
import { PaymentTypeBadge } from '../../components/orders/PaymentTypeBadge';
import { getCollectionJobStatusPresentation, COLLECTION_CUSTODY_NOTE } from '../../components/driver/driverJobStatus';
import { parseDriverJobTypeParam } from '../../components/driver/driverJobRoute';
import { DriverFailedCollectionDialog } from '../../components/driver/DriverFailedCollectionDialog';
import { DriverFailedDeliveryDialog } from '../../components/driver/DriverFailedDeliveryDialog';
import { DriverDeliverDialog } from '../../components/driver/DriverDeliverDialog';
import type { CollectionDriverJobDetail, DeliveryDriverJobDetail } from '../../services/domain.types';

/**
 * Phase 12.2 (read-only detail) + Phase 12.3 (Collection actions) + Phase
 * 12.4 (Delivery actions).
 *
 * Collection and Delivery action wiring are exclusively gated on
 * `job.jobType` — the discriminated union makes rendering the wrong job
 * type's action impossible.
 */

type DialogKind =
  | 'markCollected'
  | 'reportCollectionFailed'
  | 'pickup'
  | 'startDelivery'
  | 'reportDeliveryFailed'
  | 'deliver'
  | null;

function describeDriverActionError(err: UnknownApiError): { message: string; stale: boolean } {
  if (isTransportError(err)) {
    return { message: 'Unable to reach the server. Please try again.', stale: false };
  }
  const status = getApiErrorStatus(err);
  const code = getApiErrorCode(err);
  if (status === 409 || code === 'CONFLICT') {
    return {
      message: 'This job changed while you were viewing it. The latest details have been reloaded.',
      stale: true,
    };
  }
  if (status === 404 || code === 'NOT_FOUND') {
    return {
      message: 'This job is no longer available — it may have been reassigned or already actioned.',
      stale: true,
    };
  }
  if (typeof status === 'number' && status >= 500) {
    return { message: 'Something went wrong on the server. Please try again.', stale: false };
  }
  return { message: getApiErrorMessage(err), stale: false };
}

export default function DriverJobDetailPage() {
  const { jobType: rawJobType, orderId } = useParams<{ jobType: string; orderId: string }>();
  const jobType = parseDriverJobTypeParam(rawJobType);
  const navigate = useNavigate();

  const query = useGetDriverJobDetailQuery(
    { jobType: jobType ?? 'COLLECTION', orderId: orderId ?? '' },
    { skip: !jobType || !orderId },
  );
  const job = query.data;

  const [dialog, setDialog] = useState<DialogKind>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const [markCollected, markCollectedState] = useMarkParcelCollectedMutation();
  const [reportCollectionFailed, reportCollectionFailedState] = useReportParcelCollectionFailedMutation();
  const [pickup, pickupState] = usePickupDriverOrderMutation();
  const [startDelivery, startDeliveryState] = useStartDriverOrderDeliveryMutation();
  const [failDelivery, failDeliveryState] = useFailDriverOrderMutation();
  const [deliver, deliverState] = useDeliverDriverOrderMutation();

  const busy =
    markCollectedState.isLoading ||
    reportCollectionFailedState.isLoading ||
    pickupState.isLoading ||
    startDeliveryState.isLoading ||
    failDeliveryState.isLoading ||
    deliverState.isLoading;

  const openDialog = (kind: Exclude<DialogKind, null>) => {
    setDialogError(null);
    setDialog(kind);
  };
  const closeDialog = () => setDialog(null);

  /* ------------------------------- Collection ------------------------------ */

  const handleMarkCollected = async () => {
    if (!orderId) return;
    try {
      await markCollected(orderId).unwrap();
      // The DriverJob tag invalidation refetches this exact query, so `job`
      // updates to COLLECTED_FROM_SENDER on its own — stay on this page
      // (task §7/§36), never navigate away.
      setActionNotice('Parcel marked as collected.');
      setDialog(null);
    } catch (e) {
      const { message, stale } = describeDriverActionError(e as UnknownApiError);
      setDialogError(message);
      if (stale) {
        void query.refetch();
        setDialog(null);
      }
    }
  };

  const handleReportCollectionFailed = async (failedCollectionReasonId: string, notes: string | undefined) => {
    if (!orderId) return;
    try {
      await reportCollectionFailed({ orderId, body: { failedCollectionReasonId, notes } }).unwrap();
      // The job is no longer current — leave the detail page entirely
      // rather than show a stale ASSIGNED/action view.
      navigate(paths.driver.jobs, { state: { notice: 'Collection reported as failed.' } });
    } catch (e) {
      const { message, stale } = describeDriverActionError(e as UnknownApiError);
      setDialogError(message);
      if (stale) void query.refetch();
    }
  };

  /* --------------------------------- Delivery ------------------------------- */

  const handlePickup = async () => {
    if (!orderId) return;
    try {
      await pickup(orderId).unwrap();
      setActionNotice('Order picked up from the company.');
      setDialog(null);
    } catch (e) {
      const { message, stale } = describeDriverActionError(e as UnknownApiError);
      setDialogError(message);
      if (stale) {
        void query.refetch();
        setDialog(null);
      }
    }
  };

  const handleStartDelivery = async () => {
    if (!orderId) return;
    try {
      await startDelivery(orderId).unwrap();
      setActionNotice('Delivery started.');
      setDialog(null);
    } catch (e) {
      const { message, stale } = describeDriverActionError(e as UnknownApiError);
      setDialogError(message);
      if (stale) {
        void query.refetch();
        setDialog(null);
      }
    }
  };

  const handleReportDeliveryFailed = async (failedReasonId: string, notes: string | undefined) => {
    if (!orderId) return;
    try {
      await failDelivery({ id: orderId, body: { failedReasonId, notes } }).unwrap();
      // FAILED_DELIVERY is deliberately excluded from "current" Delivery
      // jobs (Phase 12.1) — there is no Driver-actionable next step until
      // Management reschedules it. Leave the detail page.
      navigate(paths.driver.jobs, { state: { notice: 'Delivery failure reported.' } });
    } catch (e) {
      const { message, stale } = describeDriverActionError(e as UnknownApiError);
      setDialogError(message);
      if (stale) void query.refetch();
    }
  };

  const handleDeliver = async (actualAmountCollected: string, collectionDifferenceReason: string | undefined) => {
    if (!orderId) return;
    try {
      await deliver({ id: orderId, body: { actualAmountCollected, collectionDifferenceReason } }).unwrap();
      navigate(paths.driver.jobs, { state: { notice: 'Delivery completed.' } });
    } catch (e) {
      const { message, stale } = describeDriverActionError(e as UnknownApiError);
      setDialogError(message);
      if (stale) void query.refetch();
    }
  };

  // Invalid route (unrecognized jobType segment, or no orderId at all) is a
  // route-safe Not Found — never sent to the backend (task §41).
  const routeInvalid = !jobType || !orderId;

  if (routeInvalid || query.isError) {
    const status = getApiErrorStatus(query.error);
    const code = getApiErrorCode(query.error);
    const notFound = routeInvalid || status === 404 || code === 'NOT_FOUND';
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorState
          className="py-16"
          title={notFound ? 'This job is no longer available.' : 'Could not load this job'}
          message={
            notFound
              ? 'It may have been completed, reassigned, or the link is no longer valid.'
              : getApiErrorMessage(query.error as UnknownApiError)
          }
          onRetry={notFound ? undefined : () => void query.refetch()}
          action={
            <Link
              to={paths.driver.jobs}
              className="inline-flex h-8 items-center rounded-control border border-line bg-card px-3 text-xs font-medium text-ink-secondary hover:bg-sunken"
            >
              Back to My Jobs
            </Link>
          }
        />
      </div>
    );
  }

  if (query.isLoading || !job) {
    return (
      <div className="space-y-4">
        <BackLink />
        <LoadingState className="py-16" label="Loading job…" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <BackLink />

      <PageHeader
        size="lg"
        eyebrow={job.jobType === 'COLLECTION' ? 'Collection · Sender → Company' : 'Delivery · Company → Receiver'}
        title={job.orderNumber}
        actions={
          job.jobType === 'COLLECTION' ? (
            <CollectionStatusBadge status={job.status} />
          ) : (
            <StatusBadge status={job.status} />
          )
        }
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

      {job.jobType === 'COLLECTION' ? (
        <CollectionDetail
          job={job}
          busy={busy}
          onMarkCollectedClick={() => openDialog('markCollected')}
          onReportFailedClick={() => openDialog('reportCollectionFailed')}
        />
      ) : (
        <DeliveryDetail
          job={job}
          busy={busy}
          onPickupClick={() => openDialog('pickup')}
          onStartDeliveryClick={() => openDialog('startDelivery')}
          onDeliverClick={() => openDialog('deliver')}
          onReportFailedClick={() => openDialog('reportDeliveryFailed')}
        />
      )}

      {job.jobType === 'COLLECTION' && (
        <>
          <ConfirmationModal
            open={dialog === 'markCollected'}
            title="Mark parcel as collected?"
            description="Confirm that you have collected the parcel from the sender."
            confirmLabel="Mark collected"
            confirmLoading={markCollectedState.isLoading}
            onConfirm={() => void handleMarkCollected()}
            onCancel={closeDialog}
          />

          <DriverFailedCollectionDialog
            open={dialog === 'reportCollectionFailed'}
            loading={reportCollectionFailedState.isLoading}
            error={dialogError}
            onConfirm={(reasonId, notes) => void handleReportCollectionFailed(reasonId, notes)}
            onCancel={closeDialog}
          />
        </>
      )}

      {job.jobType === 'DELIVERY' && (
        <>
          <ConfirmationModal
            open={dialog === 'pickup'}
            title="Pick up this order?"
            description="Confirm that you have received the parcel from the company and are taking responsibility for delivery."
            confirmLabel="Pick up"
            confirmLoading={pickupState.isLoading}
            onConfirm={() => void handlePickup()}
            onCancel={closeDialog}
          />

          <ConfirmationModal
            open={dialog === 'startDelivery'}
            title="Start delivery?"
            description="Confirm that you are leaving the company to deliver this order to the receiver."
            confirmLabel="Start delivery"
            confirmLoading={startDeliveryState.isLoading}
            onConfirm={() => void handleStartDelivery()}
            onCancel={closeDialog}
          />

          <DriverFailedDeliveryDialog
            open={dialog === 'reportDeliveryFailed'}
            loading={failDeliveryState.isLoading}
            error={dialogError}
            onConfirm={(reasonId, notes) => void handleReportDeliveryFailed(reasonId, notes)}
            onCancel={closeDialog}
          />

          <DriverDeliverDialog
            open={dialog === 'deliver'}
            amountToCollect={job.collection.amountToCollect}
            paymentMethodName={job.collection.paymentMethod?.name ?? null}
            loading={deliverState.isLoading}
            error={dialogError}
            onConfirm={(actual, reason) => void handleDeliver(actual, reason)}
            onCancel={closeDialog}
          />
        </>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to={paths.driver.jobs}
      className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Back to My Jobs
    </Link>
  );
}

function CollectionStatusBadge({ status }: { status: string }) {
  const { label, tone } = getCollectionJobStatusPresentation(status);
  return (
    <Badge tone={tone} dot>
      {label}
    </Badge>
  );
}

function Section({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <Card flush className="p-4 sm:p-5">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
        {icon}
        {title}
      </h2>
      <div className="mt-3 space-y-2 text-sm text-ink-secondary">{children}</div>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium text-ink-subtle">{label}</p>
      <div className="text-sm text-ink">{children}</div>
    </div>
  );
}

function PhoneLink({ phone }: { phone: string }) {
  return (
    <a href={`tel:${phone}`} className="inline-flex items-center gap-1.5 hover:underline" aria-label={`Call ${phone}`}>
      <Phone className="size-3.5 shrink-0" aria-hidden="true" />
      {phone}
    </a>
  );
}

interface CollectionDetailProps {
  job: CollectionDriverJobDetail;
  busy: boolean;
  onMarkCollectedClick: () => void;
  onReportFailedClick: () => void;
}

function CollectionDetail({ job, busy, onMarkCollectedClick, onReportFailedClick }: CollectionDetailProps) {
  return (
    <div className="space-y-3">
      {job.status === 'COLLECTED_FROM_SENDER' && (
        <Card className="border-brand-100 bg-brand-50">
          <p className="text-sm font-semibold text-brand-700">Parcel Collected</p>
          <p className="mt-0.5 text-sm text-brand-700">{COLLECTION_CUSTODY_NOTE}</p>
          <p className="mt-1 text-xs text-brand-700/80">
            The parcel remains assigned to you until it is received at the company.
          </p>
        </Card>
      )}

      <Section title="Collection Contact">
        <Field label="Name">{job.contact.name ?? '—'}</Field>
        {job.contact.phone && (
          <Field label="Phone">
            <PhoneLink phone={job.contact.phone} />
          </Field>
        )}
        {job.contact.altPhone && (
          <Field label="Alt. phone">
            <PhoneLink phone={job.contact.altPhone} />
          </Field>
        )}
      </Section>

      <Section title="Collection Location" icon={<MapPin className="size-4" aria-hidden="true" />}>
        <Field label="Area">{job.contact.area ?? '—'}</Field>
        <Field label="Address">{job.contact.address ?? '—'}</Field>
        {job.contact.notes && <Field label="Notes">{job.contact.notes}</Field>}
      </Section>

      <Section title="Package / Order Information" icon={<Package className="size-4" aria-hidden="true" />}>
        <Field label="Description">{job.package.description}</Field>
        <div className="flex flex-wrap gap-4">
          <Field label="Packages">{job.package.packageCount}</Field>
          {job.package.quantity != null && <Field label="Quantity">{job.package.quantity}</Field>}
          {job.package.weightKg && <Field label="Weight">{job.package.weightKg} kg</Field>}
        </div>
        {job.package.notes && <Field label="Notes">{job.package.notes}</Field>}
      </Section>

      <Section title="Assignment">
        <Field label="Assigned">{formatDateTime(job.assignedAt)}</Field>
      </Section>

      {job.status === 'ASSIGNED' && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button className="flex-1" disabled={busy} onClick={onMarkCollectedClick}>
            Mark Collected
          </Button>
          <Button variant="secondary" className="flex-1" disabled={busy} onClick={onReportFailedClick}>
            Report Collection Failed
          </Button>
        </div>
      )}
    </div>
  );
}

interface DeliveryDetailProps {
  job: DeliveryDriverJobDetail;
  busy: boolean;
  onPickupClick: () => void;
  onStartDeliveryClick: () => void;
  onDeliverClick: () => void;
  onReportFailedClick: () => void;
}

function DeliveryDetail({
  job,
  busy,
  onPickupClick,
  onStartDeliveryClick,
  onDeliverClick,
  onReportFailedClick,
}: DeliveryDetailProps) {
  const zero = isZeroMoney(job.collection.amountToCollect);
  return (
    <div className="space-y-3">
      <Section title="Receiver">
        <Field label="Name">{job.receiver.name}</Field>
        <Field label="Phone">
          <PhoneLink phone={job.receiver.phone} />
        </Field>
        {job.receiver.altPhone && (
          <Field label="Alt. phone">
            <PhoneLink phone={job.receiver.altPhone} />
          </Field>
        )}
      </Section>

      <Section title="Delivery Location" icon={<MapPin className="size-4" aria-hidden="true" />}>
        <Field label="Area">{job.receiver.area}</Field>
        <Field label="Address">{job.receiver.address}</Field>
        {job.receiver.buildingFloor && <Field label="Building / Floor">{job.receiver.buildingFloor}</Field>}
        {job.receiver.instructions && <Field label="Delivery instructions">{job.receiver.instructions}</Field>}
      </Section>

      <Section title="Package / Order Information" icon={<Package className="size-4" aria-hidden="true" />}>
        <Field label="Description">{job.package.description}</Field>
        <div className="flex flex-wrap gap-4">
          <Field label="Packages">{job.package.packageCount}</Field>
          {job.package.quantity != null && <Field label="Quantity">{job.package.quantity}</Field>}
          {job.package.weightKg && <Field label="Weight">{job.package.weightKg} kg</Field>}
        </div>
        {job.package.notes && <Field label="Notes">{job.package.notes}</Field>}
      </Section>

      <Section title="Payment" icon={<Wallet className="size-4" aria-hidden="true" />}>
        <div className="flex flex-wrap items-center gap-2">
          <PaymentTypeBadge paymentType={job.paymentType} />
          {job.collection.paymentMethod && <Badge tone="neutral">{job.collection.paymentMethod.name}</Badge>}
        </div>
        <div className="flex items-center justify-between border-t border-line-subtle pt-2">
          <span className="text-xs font-medium text-ink-subtle">Amount to collect</span>
          {zero ? (
            <span className="text-sm font-medium text-ink-muted">No collection required</span>
          ) : (
            <span className="text-base font-semibold tabular-nums text-ink">
              {formatMoney(job.collection.amountToCollect)}
            </span>
          )}
        </div>
      </Section>

      <Section title="Assignment">
        <Field label="Assigned">{formatDateTime(job.timestamps.assignedAt)}</Field>
      </Section>

      {job.status === 'ASSIGNED' && (
        <Button className="w-full" disabled={busy} onClick={onPickupClick}>
          Pick Up From Company
        </Button>
      )}

      {(job.status === 'PICKED_UP' || job.status === 'RESCHEDULED') && (
        <Button className="w-full" disabled={busy} onClick={onStartDeliveryClick}>
          Start Delivery
        </Button>
      )}

      {job.status === 'OUT_FOR_DELIVERY' && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button className="flex-1" disabled={busy} onClick={onDeliverClick}>
            Mark Delivered
          </Button>
          <Button variant="secondary" className="flex-1" disabled={busy} onClick={onReportFailedClick}>
            Report Delivery Failed
          </Button>
        </div>
      )}
    </div>
  );
}
