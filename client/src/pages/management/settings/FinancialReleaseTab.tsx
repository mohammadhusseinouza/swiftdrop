import { useId, useState } from 'react';
import { RefreshCw } from 'lucide-react';

import { Card } from '../../../components/ui/Card';
import { Badge, type BadgeTone } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { StaleDataNotice } from '../../../components/feedback/StaleDataNotice';
import { ConfirmationModal } from '../../../components/feedback/ConfirmationModal';
import { formatDateTime } from '../../../lib/format';
import { getApiErrorMessage, type UnknownApiError } from '../../../services/apiError';
import {
  useActivateFinancialReleaseMutation,
  useDeactivateFinancialReleaseMutation,
  useGetFinancialReleaseActivationQuery,
  useGetFinancialReleaseReadinessQuery,
  useGetFinancialReleaseReconciliationQuery,
  useProbeDatabaseLatencyMutation,
  type GateResult,
  type ReadinessReport,
} from '../../../services/financialReleaseAdminApi';
import {
  CLIENT_FINANCIAL_RELEASE_CONTRACT,
  GATE_EXPLANATIONS,
  activationAvailability,
  classifyActivationError,
  deactivationAvailability,
  deployedClientContract,
  gateDisplayStatus,
  type GateDisplayStatus,
} from './financialReleaseActivation';

/**
 * FR.11B — Admin-only control of settlement-based financial release.
 * Rendered only for the ADMIN role (SettingsPage); every endpoint is
 * ADMIN-only server-side and the server re-evaluates all gates when asked to
 * activate. Nothing on this screen changes balances.
 */
export function FinancialReleaseTab() {
  const state = useGetFinancialReleaseActivationQuery();
  const readiness = useGetFinancialReleaseReadinessQuery(undefined, { refetchOnMountOrArgChange: true });
  const [activate, activateState] = useActivateFinancialReleaseMutation();
  const [deactivate, deactivateState] = useDeactivateFinancialReleaseMutation();
  const [confirming, setConfirming] = useState<'activate' | 'deactivate' | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [outcome, setOutcome] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);
  const [serverGates, setServerGates] = useState<GateResult[] | null>(null);
  const ackId = useId();

  if (state.isLoading) return <LoadingState className="py-16" label="Loading financial release status…" />;
  if (!state.data) {
    return (
      <ErrorState
        className="py-16"
        title="Could not load financial release status"
        message={getApiErrorMessage(state.error as UnknownApiError)}
        onRetry={() => void state.refetch()}
      />
    );
  }

  const s = state.data;
  const report = readiness.data;
  const activation = activationAvailability(s, report, {
    readinessFetching: readiness.isFetching,
    readinessError: readiness.isError && !report,
    now: Date.now(),
  });
  const deactivation = deactivationAvailability(s);
  const deployedClient = deployedClientContract(report);

  const closeConfirm = () => {
    setConfirming(null);
    setAcknowledged(false);
  };

  const runChange = async (kind: 'activate' | 'deactivate') => {
    setOutcome(null);
    setServerGates(null);
    try {
      const result = kind === 'activate' ? await activate().unwrap() : await deactivate().unwrap();
      setOutcome({
        tone: 'success',
        text: result.changed
          ? kind === 'activate'
            ? 'Settlement-based financial release is now ENABLED. The activation was audited.'
            : 'Settlement-based financial release is now DISABLED. Future deliveries are released immediately; existing settlement-mode orders are still processed normally. The deactivation was audited.'
          : `Nothing changed — the feature was already ${result.state.enabled ? 'enabled' : 'disabled'}.`,
      });
    } catch (e) {
      const err = classifyActivationError(e as UnknownApiError);
      if (err.kind === 'GATES_FAILED' && err.gates) setServerGates(err.gates);
      setOutcome({ tone: err.kind === 'UNCONFIRMED' ? 'warning' : 'danger', text: err.message });
      void state.refetch();
    } finally {
      closeConfirm();
      void readiness.refetch();
    }
  };

  return (
    <div className="space-y-4">
      {state.isError && <StaleDataNotice onRetry={() => void state.refetch()} />}

      <Card className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 className="text-base font-semibold text-ink">Settlement-based financial release</h2>
            <p className="max-w-2xl text-sm text-ink-muted">
              When enabled, cash collected by drivers is credited to customer wallets and company revenue only when the
              driver&rsquo;s settlement fully covers that collection. Changing this setting affects future deliveries
              only and never changes existing balances.
            </p>
          </div>
          <Badge tone={s.enabled ? 'success' : 'neutral'} dot>
            {s.enabled ? 'Enabled' : 'Disabled'}
          </Badge>
        </div>

        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <StatusRow label="Feature state" value={s.enabled ? 'Enabled' : 'Disabled'} />
          <StatusRow
            label="Environment authorization (G0)"
            value={s.environmentAuthorized ? 'Authorized for cutover' : 'Not authorized'}
            hint="Set in the server environment by an authorized operator. Its value is never shown here."
          />
          <StatusRow label="Server contract" value={s.serverContractVersion} />
          <StatusRow
            label="This browser’s client contract"
            value={CLIENT_FINANCIAL_RELEASE_CONTRACT}
            hint={s.serverContractVersion === CLIENT_FINANCIAL_RELEASE_CONTRACT ? 'Compatible with the server' : 'Not compatible — reload the application'}
          />
          <StatusRow
            label="Deployed client contract (G7)"
            value={deployedClient ?? (report ? 'Not detected' : '…')}
            hint={deployedClient === s.serverContractVersion ? 'Compatible with the server' : 'The deployed client must declare the server’s contract'}
          />
          <StatusRow label="Setting last changed" value={s.settingUpdatedAt ? formatDateTime(s.settingUpdatedAt) : '—'} />
        </dl>

        {outcome && (
          <div
            role={outcome.tone === 'success' ? 'status' : 'alert'}
            className={
              'rounded-control border px-3 py-2 text-sm ' +
              (outcome.tone === 'success'
                ? 'border-success-200 bg-success-50 text-success-700'
                : outcome.tone === 'warning'
                  ? 'border-warning-200 bg-warning-50 text-warning-700'
                  : 'border-danger-200 bg-danger-50 text-danger-700')
            }
          >
            {outcome.text}
          </div>
        )}

        <div className="flex flex-wrap items-start gap-3 border-t border-line pt-4">
          {activation.kind !== 'HIDDEN' && (
            <div className="min-w-0 flex-1 space-y-2">
              <Button disabled={activation.kind === 'BLOCKED'} onClick={() => setConfirming('activate')}>
                Activate settlement-based release
              </Button>
              {activation.kind === 'BLOCKED' && (
                <div className="text-sm text-ink-secondary">
                  <p className="font-medium text-ink">Activation is unavailable:</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {activation.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {deactivation.kind === 'AVAILABLE' && (
            <div className="min-w-0 flex-1 space-y-1">
              <Button variant="danger" onClick={() => setConfirming('deactivate')}>
                Deactivate settlement-based release
              </Button>
              <p className="text-sm text-ink-muted">Always allowed. Existing settlement-mode orders keep being processed.</p>
            </div>
          )}
        </div>
      </Card>

      <ReadinessCard
        report={report}
        serverGates={serverGates}
        loading={readiness.isLoading}
        fetching={readiness.isFetching}
        error={readiness.isError ? getApiErrorMessage(readiness.error as UnknownApiError) : null}
        onRefresh={() => {
          setServerGates(null);
          void readiness.refetch();
        }}
      />

      <ReconciliationCard />

      <HistoricalCard report={report} />

      <LatencyCard />

      <ConfirmationModal
        open={confirming === 'activate'}
        title="Activate settlement-based financial release?"
        confirmLabel="Activate"
        confirmLoading={activateState.isLoading}
        confirmDisabled={!acknowledged || activateState.isLoading}
        onCancel={closeConfirm}
        onConfirm={() => void runChange('activate')}
        description={
          <div className="space-y-3 text-sm text-ink-secondary">
            <ul className="list-disc space-y-1 pl-5">
              <li>From now on, cash deliveries credit customer wallets and company revenue only once settled.</li>
              <li>Settlements must allocate cash to specific collections.</li>
              <li>The server re-checks every readiness gate before changing anything; any failure refuses activation.</li>
              <li>Deactivation is always possible later and affects future deliveries only.</li>
            </ul>
            <label htmlFor={ackId} className="flex items-start gap-2 text-ink">
              <input
                id={ackId}
                type="checkbox"
                className="mt-0.5 size-4"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span>I confirm the production cutover for this environment was authorized and I reviewed the readiness report.</span>
            </label>
          </div>
        }
      />
      <ConfirmationModal
        open={confirming === 'deactivate'}
        title="Deactivate settlement-based financial release?"
        confirmLabel="Deactivate"
        confirmVariant="danger"
        confirmLoading={deactivateState.isLoading}
        onCancel={closeConfirm}
        onConfirm={() => void runChange('deactivate')}
        description={
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink-secondary">
            <li>Future deliveries are released immediately at delivery (legacy behaviour).</li>
            <li>Orders already awaiting settlement keep their mode and are settled, resolved and corrected as before.</li>
            <li>No balance changes. The change is audited.</li>
          </ul>
        }
      />
    </div>
  );
}

function StatusRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-ink-muted">{label}</dt>
      <dd className="font-medium text-ink">{value}</dd>
      {hint && <dd className="text-xs text-ink-muted">{hint}</dd>}
    </div>
  );
}

const GATE_TONE: Record<GateDisplayStatus, BadgeTone> = { PASSED: 'success', FAILED: 'danger', NOT_EVALUATED: 'neutral' };
const GATE_LABEL: Record<GateDisplayStatus, string> = { PASSED: 'Passed', FAILED: 'Failed', NOT_EVALUATED: 'Not evaluated' };

function ReadinessCard({
  report,
  serverGates,
  loading,
  fetching,
  error,
  onRefresh,
}: {
  report: ReadinessReport | undefined;
  serverGates: GateResult[] | null;
  loading: boolean;
  fetching: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const gates = serverGates ?? report?.gates ?? [];
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-ink">Readiness gates</h2>
          <p className="text-sm text-ink-muted">
            {serverGates
              ? 'Result of the server’s own evaluation when activation was requested.'
              : report
                ? `Dry run evaluated ${formatDateTime(report.evaluatedAt)}. Read-only — nothing was changed.`
                : 'A read-only dry run of every activation gate.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {report && !serverGates && (
            <Badge tone={report.ready ? 'success' : 'danger'}>{report.ready ? 'All gates pass' : `${report.failedGates.length} gate(s) failing`}</Badge>
          )}
          <Button variant="secondary" size="sm" icon={<RefreshCw />} loading={fetching} onClick={onRefresh}>
            Run readiness check
          </Button>
        </div>
      </div>
      {loading ? (
        <LoadingState className="py-8" label="Evaluating readiness gates…" />
      ) : error && gates.length === 0 ? (
        <ErrorState className="py-8" title="Could not evaluate readiness" message={error} onRetry={onRefresh} />
      ) : (
        <>
          {error && <StaleDataNotice message="Could not re-run the readiness check — showing the last result." onRetry={onRefresh} />}
          <ul className="divide-y divide-line-subtle rounded-control border border-line-subtle">
            {gates.map((g) => (
              <GateRow key={g.id} gate={g} />
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function GateRow({ gate }: { gate: GateResult }) {
  const status = gateDisplayStatus(gate);
  const explanation = GATE_EXPLANATIONS[gate.id];
  return (
    <li className="space-y-1 px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium text-ink">
          <span className="tabular-nums">{gate.id}</span> · {gate.title}
        </p>
        <Badge tone={GATE_TONE[status]}>{GATE_LABEL[status]}</Badge>
      </div>
      <p className="text-sm text-ink-secondary">{gate.detail}</p>
      <p className="text-xs text-ink-muted">Checks: {explanation.checks}</p>
      {status === 'FAILED' && <p className="text-xs text-ink-secondary">To resolve: {explanation.resolve}</p>}
      {gate.findings.length > 0 && status !== 'PASSED' && (
        <details className="text-xs text-ink-secondary">
          <summary className="cursor-pointer font-medium text-ink">
            {gate.affectedCount} affected record{gate.affectedCount === 1 ? '' : 's'} — show sample
          </summary>
          <ul className="mt-1 space-y-0.5 pl-4">
            {gate.findings.map((f) => (
              <li key={`${f.entityType}:${f.entityId}`} className="break-all">
                {f.entityType} <code>{f.entityId}</code> — {f.detail}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

function ReconciliationCard() {
  const rec = useGetFinancialReleaseReconciliationQuery(undefined, { refetchOnMountOrArgChange: true });
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-ink">Financial reconciliation</h2>
          <p className="text-sm text-ink-muted">Read-only. Invariant failures block activation (gate G6); nothing is repaired automatically.</p>
        </div>
        {rec.data && (
          <Badge tone={rec.data.summary.invariantChecksFailed === 0 ? 'success' : 'danger'}>
            {rec.data.summary.invariantChecksFailed === 0 ? 'R1–R13 pass' : `${rec.data.summary.invariantChecksFailed} invariant(s) failing`}
          </Badge>
        )}
      </div>
      {rec.isLoading ? (
        <LoadingState className="py-6" label="Running reconciliation…" />
      ) : !rec.data ? (
        <ErrorState className="py-6" title="Could not run reconciliation" message={getApiErrorMessage(rec.error as UnknownApiError)} onRetry={() => void rec.refetch()} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-sm">
            <caption className="sr-only">Reconciliation checks</caption>
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-muted">
                <th scope="col" className="py-2 pr-3 font-medium">Check</th>
                <th scope="col" className="py-2 pr-3 font-medium">Kind</th>
                <th scope="col" className="py-2 pr-3 font-medium">Status</th>
                <th scope="col" className="py-2 text-right font-medium">Affected</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-subtle">
              {rec.data.checks.map((c) => (
                <tr key={c.id}>
                  <td className="py-2 pr-3 text-ink">
                    <span className="font-medium tabular-nums">{c.id}</span> · {c.title}
                  </td>
                  <td className="py-2 pr-3 text-ink-secondary">{c.kind === 'INVARIANT' ? 'Invariant' : c.kind === 'HISTORICAL' ? 'Historical' : 'Informational'}</td>
                  <td className="py-2 pr-3">
                    <Badge tone={c.status === 'PASS' ? 'success' : c.status === 'INFO' ? 'neutral' : c.kind === 'INVARIANT' ? 'danger' : 'warning'}>
                      {c.status === 'PASS' ? 'Pass' : c.status === 'INFO' ? 'Info' : c.kind === 'INVARIANT' ? 'Fail' : 'Review'}
                    </Badge>
                  </td>
                  <td className="py-2 text-right tabular-nums text-ink">{c.affectedCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function HistoricalCard({ report }: { report: ReadinessReport | undefined }) {
  const findings = report?.historicalFindings ?? [];
  if (findings.length === 0 || findings.every((f) => f.affectedCount === 0)) return null;
  return (
    <Card className="space-y-2">
      <h2 className="text-base font-semibold text-ink">Historical findings</h2>
      <p className="text-sm text-ink-muted">
        Legacy records outside the R1–R13 invariants. They are always reported and never hidden, deleted or rewritten. They do
        not block activation; review them separately.
      </p>
      <ul className="space-y-1 text-sm">
        {findings.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-ink">
              <span className="font-medium">{f.id}</span> · {f.title}
            </span>
            <Badge tone={f.affectedCount ? 'warning' : 'success'}>{f.affectedCount} record(s)</Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const VERDICT_TEXT = {
  LIMIT_CONFIRMED: 'The current limit of 20 allocations per settlement is supported at this latency.',
  REDUCE_LIMIT: 'Lower the allocation limit before activation (code change and regression required).',
  DO_NOT_ACTIVATE: 'Database latency is too high for settlement-based release — do not activate.',
} as const;

function LatencyCard() {
  const [probe, probeState] = useProbeDatabaseLatencyMutation();
  const r = probeState.data;
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-ink">Database latency</h2>
          <p className="max-w-2xl text-sm text-ink-muted">
            Measures round trips from this server to the database (200 read-only <code>SELECT 1</code> samples, alone and inside
            read-only transactions). It decides the settlement allocation limit. It writes nothing.
          </p>
        </div>
        <Button variant="secondary" size="sm" loading={probeState.isLoading} onClick={() => void probe({ samples: 200 })}>
          Measure latency
        </Button>
      </div>
      {probeState.isError && (
        <p role="alert" className="text-sm text-danger-700">
          {getApiErrorMessage(probeState.error as UnknownApiError)}
        </p>
      )}
      {r && (
        <div className="space-y-2 text-sm">
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-3">
            <StatusRow label="p95 alone / in transaction" value={`${r.singleStatement.p95Ms} ms / ${r.inTransaction ? `${r.inTransaction.p95Ms} ms` : '—'}`} />
            <StatusRow label="p50 · p99 · max (in transaction)" value={r.inTransaction ? `${r.inTransaction.p50Ms} · ${r.inTransaction.p99Ms} · ${r.inTransaction.maxMs} ms` : '—'} />
            <StatusRow label="Recommended allocation limit" value={`${r.recommendedMaxAllocations} (current ${r.currentMaxAllocations})`} />
          </dl>
          {r.inTransactionError && <p className="text-danger-700">{r.inTransactionError}</p>}
          <p className={r.verdict === 'LIMIT_CONFIRMED' ? 'text-success-700' : 'text-danger-700'}>{VERDICT_TEXT[r.verdict]}</p>
          <p className="text-xs text-ink-muted">
            Measured {formatDateTime(r.measuredAt)}. Model: {r.model}.
          </p>
        </div>
      )}
    </Card>
  );
}
