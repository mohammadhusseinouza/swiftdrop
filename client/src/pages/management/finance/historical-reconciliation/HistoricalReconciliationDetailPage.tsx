import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

import { useCurrentUser } from '../../../../features/auth/usePermissions';
import { paths } from '../../../../routes/paths';
import { formatDateTime, formatMoney } from '../../../../lib/format';
import { getApiErrorMessage, getApiErrorStatus, type UnknownApiError } from '../../../../services/apiError';
import { useDecideReconciliationMutation, useGetReconciliationQuery } from '../../../../services/historicalReconciliationApi';
import { useGetOwnershipSummaryQuery } from '../../../../services/historicalOwnershipApi';
import { liabilityResolutionPresentation } from './ownership/ownershipModel';

import { PageHeader } from '../../../../components/data-display/PageHeader';
import { StatisticCard } from '../../../../components/data-display/StatisticCard';
import { Badge } from '../../../../components/ui/Badge';
import { Button } from '../../../../components/ui/Button';
import { Card } from '../../../../components/ui/Card';
import { ErrorState } from '../../../../components/feedback/ErrorState';
import { LoadingState } from '../../../../components/feedback/LoadingState';
import { StaleDataNotice } from '../../../../components/feedback/StaleDataNotice';

import {
  ACTION_LABELS,
  EVIDENCE_ONLY_NOTICE,
  availableActions,
  evidencePresentation,
  ownershipPresentation,
  statusPresentation,
  type ReconciliationAction,
} from './historicalReconciliationModel';
import { ReconciliationEvidencePanel } from './ReconciliationEvidencePanel';
import { ApproveReconciliationDialog } from './ApproveReconciliationDialog';
import { ReconciliationDecisionDialog } from './ReconciliationDecisionDialog';

function BackLink() {
  return (
    <Link to={paths.management.historicalReconciliations} className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
      <ArrowLeft className="size-4" aria-hidden="true" /> Historical reconciliations
    </Link>
  );
}

/**
 * FR.12A.6 — one historical reconciliation: evidence, validation, the
 * account's raw discrepancy / approved explanation / residual, ownership
 * (always unresolved) and the append-only decision history. Actions are
 * offered by role, status and independence; the backend decides.
 */
export default function HistoricalReconciliationDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const user = useCurrentUser();
  const query = useGetReconciliationQuery(id, { skip: !id });
  const ownershipSummary = useGetOwnershipSummaryQuery();
  const [decide] = useDecideReconciliationMutation();
  const [open, setOpen] = useState<ReconciliationAction | null>(null);
  const d = query.data;

  if (!id || (query.isError && !d)) {
    const notFound = !id || getApiErrorStatus(query.error) === 404 || getApiErrorStatus(query.error) === 400;
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <BackLink />
        <ErrorState
          className="py-16"
          title={notFound ? 'Historical reconciliation not found' : 'Could not load this historical reconciliation'}
          message={notFound ? 'It does not exist or the reference is not valid.' : getApiErrorMessage(query.error as UnknownApiError)}
          onRetry={notFound ? undefined : () => void query.refetch()}
        />
      </div>
    );
  }
  if (query.isLoading || !d) {
    return (
      <div className="space-y-5">
        <BackLink />
        <LoadingState className="py-16" label="Loading historical reconciliation…" />
      </div>
    );
  }

  const status = statusPresentation(d.status);
  const ownership = ownershipPresentation(d.ownership.status);
  const liabilityResolution = liabilityResolutionPresentation(d.evidence.deletedOrderReference, ownershipSummary.data?.dispositions);
  const evidence = evidencePresentation(d);
  const actions = availableActions(d, user ? { id: user.id, roleCode: user.role.code } : null);
  const refresh = () => void query.refetch();

  return (
    <div className="space-y-5 pb-6">
      <BackLink />
      {query.isError && <StaleDataNotice onRetry={refresh} />}

      <PageHeader
        size="lg"
        eyebrow={`Incident ${d.incident.incidentNumber}`}
        title={`Historical reconciliation · ${formatMoney(d.evidence.amount)}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={status.tone}>{status.label}</Badge>
            <Badge tone={ownership.tone}>{ownership.label}</Badge>
            <Badge tone={liabilityResolution.tone}>{liabilityResolution.label}</Badge>
            <Badge tone={evidence.tone}>{evidence.label}</Badge>
          </span>
        }
        actions={
          actions.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {actions.map((a) => (
                <Button
                  key={a.action}
                  variant={a.action === 'approve' ? 'primary' : a.action === 'revoke' ? 'danger' : 'secondary'}
                  disabled={a.kind === 'BLOCKED'}
                  title={a.kind === 'BLOCKED' ? a.reason : undefined}
                  onClick={() => setOpen(a.action)}
                >
                  {ACTION_LABELS[a.action]}
                </Button>
              ))}
            </div>
          ) : undefined
        }
      />

      {actions.some((a) => a.kind === 'BLOCKED') && (
        <ul className="space-y-1 text-sm text-ink-muted">
          {actions.map((a) => (a.kind === 'BLOCKED' ? <li key={a.action}>{ACTION_LABELS[a.action]}: {a.reason}</li> : null))}
        </ul>
      )}

      <div className="space-y-2">
        <p className="rounded-card border border-line bg-sunken px-4 py-2.5 text-sm text-ink-secondary">
          <strong className="font-semibold text-ink">{status.label}.</strong> {status.description} {EVIDENCE_ONLY_NOTICE}
        </p>
        <p className="rounded-card border border-warning-200 bg-warning-50 px-4 py-2.5 text-sm text-warning-700">
          <strong className="font-semibold">{ownership.label}.</strong> {ownership.description}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatisticCard label="Raw ledger discrepancy" value={formatMoney(d.account.rawDiscrepancy)} supportingText={`Stored ${formatMoney(d.account.storedBalance)} − ledger net ${formatMoney(d.account.rawLedgerNet)}`} />
        <StatisticCard label="Approved explanation" value={formatMoney(d.account.approvedHistoricalAmount)} supportingText={d.contributes ? 'Includes this reconciliation' : 'This reconciliation contributes nothing'} />
        <StatisticCard label="Unexplained residual" value={formatMoney(d.account.unexplainedResidual)} supportingText="Must be zero for G3 / R1" />
        <StatisticCard label="Invalid approvals (account)" value={String(d.account.invalidApprovedCount)} supportingText="Each one blocks G3 / R1" />
      </div>

      <Card className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">Proposal</h2>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-ink-muted">Proposed by</dt>
            <dd>{`${d.proposedBy.firstName} ${d.proposedBy.lastName}`} · {formatDateTime(d.proposedAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">Incident</dt>
            <dd>{d.incident.incidentNumber} · {d.incident.cause}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs text-ink-muted">Reason</dt>
            <dd className="whitespace-pre-line">{d.reason}</dd>
          </div>
          {d.supersedesReconciliationId && (
            <div className="sm:col-span-2">
              <dt className="text-xs text-ink-muted">Supersedes</dt>
              <dd>
                <Link to={paths.management.historicalReconciliationDetail(d.supersedesReconciliationId)} className="text-brand-600 hover:underline">
                  the earlier, ended reconciliation of the same evidence
                </Link>
              </dd>
            </div>
          )}
        </dl>
      </Card>

      <ReconciliationEvidencePanel detail={d} />

      <section aria-labelledby="history-heading" className="space-y-2">
        <h2 id="history-heading" className="text-base font-semibold text-ink">
          Decision history <span className="font-normal text-ink-muted">(append-only)</span>
        </h2>
        <Card flush>
          {d.decisions.length === 0 ? (
            <p className="px-4 py-6 text-sm text-ink-muted">No decision yet — awaiting an independent Finance review.</p>
          ) : (
            <ol className="divide-y divide-line-subtle">
              {d.decisions.map((x) => (
                <li key={x.id} className="space-y-1 px-4 py-3 text-sm">
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge tone={x.decision === 'APPROVED' ? 'success' : x.decision === 'REVOKED' ? 'danger' : 'neutral'}>{x.decision}</Badge>
                    <span className="font-medium text-ink">{`${x.decidedBy.firstName} ${x.decidedBy.lastName}`}</span>
                    <span className="text-ink-muted">{formatDateTime(x.decidedAt)}</span>
                  </p>
                  {x.reason && <p className="whitespace-pre-line text-ink-secondary">{x.reason}</p>}
                  {x.revokesDecisionId && <p className="text-xs text-ink-muted">Revokes the approval above; it remains in this history.</p>}
                </li>
              ))}
            </ol>
          )}
        </Card>
      </section>

      <ApproveReconciliationDialog
        open={open === 'approve'}
        latest={d}
        onClose={() => setOpen(null)}
        onRefresh={refresh}
        onSubmit={(evidenceDigest, idempotencyKey) => decide({ id: d.reconciliationId, action: 'approve', body: { evidenceDigest }, idempotencyKey }).unwrap()}
      />
      {(open === 'reject' || open === 'withdraw' || open === 'revoke') && (
        <ReconciliationDecisionDialog
          open
          action={open}
          detail={d}
          onClose={() => setOpen(null)}
          onRefresh={refresh}
          onSubmit={(reason, idempotencyKey) => decide({ id: d.reconciliationId, action: open, body: { reason }, idempotencyKey }).unwrap()}
        />
      )}
    </div>
  );
}
