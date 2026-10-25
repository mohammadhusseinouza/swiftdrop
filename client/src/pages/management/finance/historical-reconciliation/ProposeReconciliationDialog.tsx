import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

import { Button } from '../../../../components/ui/Button';
import { SelectField, TextAreaField, TextField } from '../../../../components/forms/Field';
import type { UnknownApiError } from '../../../../services/apiError';
import type { ReconciliationDetail } from '../../../../services/historicalReconciliation.types';
import { useGetLedgerIncidentsQuery } from '../../../../services/historicalReconciliationApi';
import {
  INITIAL_IDEMPOTENCY_STATE,
  afterFailure,
  afterSuccess,
  generateIdempotencyKey,
  resolveIdempotencyKey,
  type IdempotencyState,
} from '../../settlements/settlementSubmission';
import {
  EMPTY_PROPOSAL_FORM,
  EVIDENCE_ONLY_NOTICE,
  RECONCILIATION_REASON_MIN_LENGTH,
  buildProposalBody,
  classifyWorkflowError,
  validateProposal,
  workflowErrorMessage,
  type ProposalErrors,
  type ProposalForm,
} from './historicalReconciliationModel';
import { DialogMessage, ReconciliationDialogShell } from './ReconciliationDialogShell';

/**
 * FR.12A.6 — ADMIN proposal. The operator names only the surviving anchor
 * row, the surviving collection-difference audit, an optional settlement, a
 * reason and the incident. The server derives the missing amount, the
 * driver, the order, the gap and the fingerprint, validates them (V1–V7) and
 * refuses anything else — its evidence errors are shown as returned.
 */
export function ProposeReconciliationDialog({
  open,
  onSubmit,
  onCreated,
  onClose,
}: {
  open: boolean;
  onSubmit: (body: ReturnType<typeof buildProposalBody>, idempotencyKey: string) => Promise<ReconciliationDetail>;
  onCreated: (detail: ReconciliationDetail) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<ProposalForm>(EMPTY_PROPOSAL_FORM);
  const [errors, setErrors] = useState<ProposalErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [ambiguous, setAmbiguous] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const idemRef = useRef<IdempotencyState>(INITIAL_IDEMPOTENCY_STATE);
  const submittingRef = useRef(false);
  const incidents = useGetLedgerIncidentsQuery({ page: 1, limit: 100 }, { skip: !open });

  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setForm(EMPTY_PROPOSAL_FORM);
      setErrors({});
      setMessage(null);
      setAmbiguous(false);
      idemRef.current = INITIAL_IDEMPOTENCY_STATE;
    }
    wasOpen.current = open;
  }, [open]);

  const set = <K extends keyof ProposalForm>(key: K, value: ProposalForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const locked = ambiguous || submitting;

  const submit = async () => {
    if (submittingRef.current) return;
    const found = validateProposal(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const body = buildProposalBody(form);
    const resolution = resolveIdempotencyKey(idemRef.current, JSON.stringify(body), generateIdempotencyKey);
    if (!resolution.ok) {
      setMessage('An earlier attempt may already have been recorded. Retry it unchanged, or close and check the list.');
      return;
    }
    idemRef.current = resolution.state;
    submittingRef.current = true;
    setSubmitting(true);
    setMessage(null);
    try {
      const created = await onSubmit(body, resolution.key);
      idemRef.current = afterSuccess();
      onCreated(created);
    } catch (e) {
      const kind = classifyWorkflowError(e as UnknownApiError);
      idemRef.current = afterFailure(idemRef.current, kind.kind === 'AMBIGUOUS');
      setAmbiguous(idemRef.current.ambiguous);
      setMessage(workflowErrorMessage(kind));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <ReconciliationDialogShell open={open} busy={submitting} wide onClose={onClose} title="Propose historical reconciliation">
      <form
        noValidate
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <DialogMessage tone="info">
          {EVIDENCE_ONLY_NOTICE} The server derives every amount, the driver and the fingerprint from the records you cite. An independent Finance reviewer
          must approve it before it explains anything.
        </DialogMessage>
        {message && <DialogMessage tone={ambiguous ? 'warning' : 'danger'}>{message}</DialogMessage>}

        <fieldset disabled={locked} className="space-y-3">
          <legend className="text-sm font-semibold text-ink">Evidence records</legend>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <TextField
              label="Anchor ledger row"
              required
              placeholder="UUID of the first surviving driver cash row after the gap"
              value={form.anchorTransactionId}
              onChange={(e) => set('anchorTransactionId', e.target.value)}
              error={errors.anchorTransactionId}
            />
            <TextField
              label="Surviving audit record"
              required
              placeholder="UUID of the COLLECTION_DIFFERENCE_RECORDED audit"
              value={form.sourceAuditLogId}
              onChange={(e) => set('sourceAuditLogId', e.target.value)}
              error={errors.sourceAuditLogId}
            />
            <TextField
              label="Related settlement (optional)"
              placeholder="Only if the anchor row is not the settlement's own cash row"
              value={form.relatedSettlementId}
              onChange={(e) => set('relatedSettlementId', e.target.value)}
              error={errors.relatedSettlementId}
            />
          </div>
        </fieldset>

        <fieldset disabled={locked} className="space-y-3">
          <legend className="text-sm font-semibold text-ink">Incident</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            {(['new', 'existing'] as const).map((mode) => (
              <label key={mode} className="flex items-center gap-2">
                <input type="radio" name="incident-mode" checked={form.incidentMode === mode} onChange={() => set('incidentMode', mode)} />
                {mode === 'new' ? 'Record a new incident' : 'Use an existing incident'}
              </label>
            ))}
          </div>
          {form.incidentMode === 'existing' ? (
            <SelectField
              label="Incident"
              required
              placeholder={incidents.isLoading ? 'Loading incidents…' : 'Choose an incident'}
              value={form.incidentId}
              onChange={(e) => set('incidentId', e.target.value)}
              options={(incidents.data?.items ?? []).map((i) => ({ value: i.id, label: `${i.incidentNumber} — ${i.summary.slice(0, 60)}` }))}
              error={errors.incidentId}
            />
          ) : (
            <div className="space-y-3">
              <TextAreaField
                label="Summary"
                required
                rows={2}
                hint="What happened — at least 20 characters. Do not include customer or receiver details."
                value={form.summary}
                onChange={(e) => set('summary', e.target.value)}
                error={errors.summary}
              />
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <TextField label="Discovered" required type="datetime-local" value={form.discoveredAt} onChange={(e) => set('discoveredAt', e.target.value)} error={errors.discoveredAt} />
                <TextField label="Occurred not before" type="datetime-local" value={form.occurredNotBefore} onChange={(e) => set('occurredNotBefore', e.target.value)} error={errors.occurredNotBefore} />
                <TextField label="Occurred not after" type="datetime-local" value={form.occurredNotAfter} onChange={(e) => set('occurredNotAfter', e.target.value)} error={errors.occurredNotAfter} />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium text-ink">Missing records (table → count or &quot;unknown&quot;)</p>
                {form.missingRecords.map((r, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <input
                      aria-label={`Table ${i + 1}`}
                      className="h-10 min-w-0 flex-1 rounded-control border border-line bg-card px-3 text-sm"
                      value={r.table}
                      onChange={(e) => set('missingRecords', form.missingRecords.map((x, j) => (j === i ? { ...x, table: e.target.value } : x)))}
                    />
                    <input
                      aria-label={`Count ${i + 1}`}
                      className="h-10 w-28 rounded-control border border-line bg-card px-3 text-sm"
                      value={r.value}
                      onChange={(e) => set('missingRecords', form.missingRecords.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      icon={<Trash2 />}
                      aria-label={`Remove row ${i + 1}`}
                      onClick={() => set('missingRecords', form.missingRecords.filter((_, j) => j !== i))}
                    />
                  </div>
                ))}
                <Button type="button" variant="secondary" size="sm" icon={<Plus />} onClick={() => set('missingRecords', [...form.missingRecords, { table: '', value: 'unknown' }])}>
                  Add table
                </Button>
                {errors.missingRecords && <p className="text-xs text-danger-700">{errors.missingRecords}</p>}
              </div>
              <TextAreaField
                label="Remaining uncertainties"
                required
                rows={2}
                value={form.remainingUncertainties}
                onChange={(e) => set('remainingUncertainties', e.target.value)}
                error={errors.remainingUncertainties}
              />
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <TextAreaField
                  label="Investigation queries"
                  rows={2}
                  hint="Query ids, e.g. I1, I2, I10 (comma or line separated)."
                  value={form.evidenceQueries}
                  onChange={(e) => set('evidenceQueries', e.target.value)}
                />
                <TextAreaField
                  label="Investigation notes"
                  rows={2}
                  hint="Run times, result digests, reviewer. No customer details."
                  value={form.evidenceNotes}
                  onChange={(e) => set('evidenceNotes', e.target.value)}
                />
              </div>
            </div>
          )}
        </fieldset>

        <fieldset disabled={locked}>
          <TextAreaField
            label="Reason"
            required
            rows={3}
            hint={`Why this reconciliation is proposed — at least ${RECONCILIATION_REASON_MIN_LENGTH} characters. Recorded in the audit log.`}
            value={form.reason}
            onChange={(e) => set('reason', e.target.value)}
            error={errors.reason}
          />
        </fieldset>

        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            {ambiguous ? 'Close and check the list' : 'Cancel'}
          </Button>
          <Button type="submit" loading={submitting} disabled={submitting}>
            {ambiguous ? 'Retry the same proposal' : 'Submit proposal'}
          </Button>
        </div>
      </form>
    </ReconciliationDialogShell>
  );
}
