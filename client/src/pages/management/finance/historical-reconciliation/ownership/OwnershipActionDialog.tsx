import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from '../../../../../components/ui/Button';
import { SelectField, TextAreaField, TextField } from '../../../../../components/forms/Field';
import { formatMoney } from '../../../../../lib/format';
import type { UnknownApiError } from '../../../../../services/apiError';
import type {
  LiabilityPolicy,
  OwnershipEvidenceInput,
  OwnershipResolutionDetail,
  ProposePolicyBody,
  UnresolvedOwnershipCandidate,
} from '../../../../../services/historicalOwnership.types';
import {
  useActOnResolutionMutation,
  useDecidePolicyMutation,
  useProposePolicyMutation,
  useProposeResolutionMutation,
  useReviewLiabilityMutation,
} from '../../../../../services/historicalOwnershipApi';
import {
  INITIAL_IDEMPOTENCY_STATE,
  afterFailure,
  afterSuccess,
  generateIdempotencyKey,
  resolveIdempotencyKey,
  type IdempotencyState,
} from '../../../settlements/settlementSubmission';
import { DialogMessage, ReconciliationDialogShell } from '../ReconciliationDialogShell';
import {
  EVIDENCE_KIND_OPTIONS,
  G5_NOTICE,
  NO_POSTING_NOTICE,
  RATIONALE_MIN_LENGTH,
  classifyOwnershipError,
  evidenceErrors,
  ownershipErrorMessage,
  policyFormErrors,
  reasonError,
  requiresRefresh,
  shortId,
  type PolicyUiAction,
} from './ownershipModel';

export type OwnershipDialogSpec =
  | { kind: 'policy-propose' }
  | { kind: 'policy-decide'; action: PolicyUiAction; policy: LiabilityPolicy }
  | { kind: 'resolution-propose'; candidate: UnresolvedOwnershipCandidate; policies: LiabilityPolicy[] }
  | { kind: 'resolution-act'; action: 'approve' | 'reject' | 'withdraw' | 'revoke' | 'record-liability'; detail: OwnershipResolutionDetail }
  | { kind: 'review'; detail: OwnershipResolutionDetail };

const TITLES: Record<string, string> = {
  'policy-propose': 'Propose a liability policy version',
  'policy-approve': 'Approve liability policy',
  'policy-reject': 'Reject liability policy',
  'policy-withdraw': 'Withdraw liability policy',
  'policy-revoke': 'Revoke liability policy',
  'resolution-propose': 'Propose company-assumed liability',
  'resolution-approve': 'Approve ownership resolution',
  'resolution-reject': 'Reject ownership resolution',
  'resolution-withdraw': 'Withdraw ownership resolution',
  'resolution-revoke': 'Revoke ownership resolution',
  'resolution-record-liability': 'Record historical liability',
  review: 'Record a periodic liability review',
};

function titleOf(spec: OwnershipDialogSpec): string {
  if (spec.kind === 'policy-decide') return TITLES[`policy-${spec.action}`];
  if (spec.kind === 'resolution-act') return TITLES[`resolution-${spec.action}`];
  return TITLES[spec.kind];
}

const EMPTY_POLICY: ProposePolicyBody = {
  policyCode: 'COMPANY_ASSUMED_HISTORICAL_LIABILITY',
  title: '',
  summary: '',
  documentSha256: '',
  documentReference: '',
  reviewIntervalDays: null,
  unclaimedFundsHandling: '',
  unclaimedReviewAfterDays: null,
};
const EMPTY_EVIDENCE: OwnershipEvidenceInput = { kind: 'INVESTIGATION_REPORT', documentSha256: '', reference: '', description: '' };

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="divide-y divide-line-subtle rounded-control border border-line-subtle text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 px-3 py-2">
          <dt className="text-ink-muted">{k}</dt>
          <dd className="break-all text-right font-medium tabular-nums text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const optionalInt = (v: string): number | null => (v.trim() === '' ? null : Number(v));

/**
 * FR.12A.11 — every historical ownership write: form → explicit
 * confirmation → server result. Never optimistic. One Idempotency-Key per
 * intended request; after an ambiguous failure only the unchanged request
 * may be retried. Approvals and recording submit the fingerprint of the
 * record displayed when the dialog opened — never one fetched later.
 */
export function OwnershipActionDialog({ spec, onClose, onDone }: { spec: OwnershipDialogSpec | null; onClose: () => void; onDone?: () => void }) {
  const open = spec !== null;
  const [proposePolicy] = useProposePolicyMutation();
  const [decidePolicy] = useDecidePolicyMutation();
  const [proposeResolution] = useProposeResolutionMutation();
  const [actOnResolution] = useActOnResolutionMutation();
  const [reviewLiability] = useReviewLiabilityMutation();

  const [step, setStep] = useState<'form' | 'done' | 'stopped'>('form');
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [policy, setPolicy] = useState<ProposePolicyBody>(EMPTY_POLICY);
  const [policyId, setPolicyId] = useState('');
  const [evidence, setEvidence] = useState<OwnershipEvidenceInput[]>([EMPTY_EVIDENCE]);
  const [rationale, setRationale] = useState('');
  const [touched, setTouched] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const idemRef = useRef<IdempotencyState>(INITIAL_IDEMPOTENCY_STATE);
  const submittingRef = useRef(false);
  // The fingerprint displayed when the dialog opened (approve / record).
  const reviewedDigest = useRef<string | null>(null);

  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setStep('form');
      setReason('');
      setAcknowledged(false);
      setPolicy(EMPTY_POLICY);
      setPolicyId(spec?.kind === 'resolution-propose' ? (spec.policies[0]?.id ?? '') : '');
      setEvidence([EMPTY_EVIDENCE]);
      setRationale('');
      setTouched(false);
      setMessage(null);
      idemRef.current = INITIAL_IDEMPOTENCY_STATE;
      reviewedDigest.current =
        spec?.kind === 'resolution-act' ? spec.detail.resolutionDigest : spec?.kind === 'policy-decide' ? spec.policy.policyDigest : null;
    }
    wasOpen.current = open;
  }, [open, spec]);

  if (!spec) return null;

  const needsReason =
    (spec.kind === 'policy-decide' && spec.action !== 'approve') ||
    (spec.kind === 'resolution-act' && ['reject', 'withdraw', 'revoke'].includes(spec.action)) ||
    spec.kind === 'review';
  const needsDigest = (spec.kind === 'policy-decide' && spec.action === 'approve') || (spec.kind === 'resolution-act' && (spec.action === 'approve' || spec.action === 'record-liability'));

  const formError = (): string | null => {
    if (needsReason) return reasonError(reason);
    if (needsDigest && !acknowledged) return 'Confirm that you reviewed this exact record.';
    if (spec.kind === 'policy-propose') return policyFormErrors(policy);
    if (spec.kind === 'resolution-propose') {
      if (!policyId) return 'Select an approved policy version.';
      if (rationale.trim().length < RATIONALE_MIN_LENGTH) return `The rationale must be at least ${RATIONALE_MIN_LENGTH} characters.`;
      return evidenceErrors(evidence);
    }
    return null;
  };
  const error = touched ? formError() : null;

  const request = (): { fingerprint: string; send: (key: string) => Promise<unknown> } => {
    const r = reason.trim();
    switch (spec.kind) {
      case 'policy-propose': {
        const body: ProposePolicyBody = {
          ...policy,
          title: policy.title.trim(),
          summary: policy.summary.trim(),
          documentSha256: policy.documentSha256.trim(),
          documentReference: policy.documentReference.trim(),
          unclaimedFundsHandling: policy.unclaimedFundsHandling.trim(),
        };
        return { fingerprint: JSON.stringify(body), send: (key) => proposePolicy({ body, idempotencyKey: key }).unwrap() };
      }
      case 'policy-decide': {
        const body = spec.action === 'approve' ? { policyDigest: reviewedDigest.current ?? '' } : { reason: r };
        return {
          fingerprint: JSON.stringify({ a: spec.action, body }),
          send: (key) => decidePolicy({ id: spec.policy.id, action: spec.action, body, idempotencyKey: key }).unwrap(),
        };
      }
      case 'resolution-propose': {
        const c = spec.candidate;
        const body = {
          incidentId: c.incidentId ?? '',
          policyId,
          sourceAuditLogId: c.sourceAuditLogId ?? '',
          ledgerReconciliationId: c.approvedLedgerReconciliationId ?? '',
          evidence: evidence.map((e) => ({ ...e, documentSha256: e.documentSha256.trim(), reference: e.reference.trim(), description: e.description.trim() })),
          rationale: rationale.trim(),
        };
        return { fingerprint: JSON.stringify(body), send: (key) => proposeResolution({ body, idempotencyKey: key }).unwrap() };
      }
      case 'resolution-act': {
        const body = spec.action === 'approve' || spec.action === 'record-liability' ? { resolutionDigest: reviewedDigest.current ?? '' } : { reason: r };
        return {
          fingerprint: JSON.stringify({ a: spec.action, body }),
          send: (key) => actOnResolution({ id: spec.detail.id, action: spec.action, body, idempotencyKey: key }).unwrap(),
        };
      }
      case 'review': {
        const liability = spec.detail.liability;
        return {
          fingerprint: JSON.stringify({ note: r }),
          send: (key) => reviewLiability({ liabilityId: liability?.id ?? '', resolutionId: spec.detail.id, note: r, idempotencyKey: key }).unwrap(),
        };
      }
    }
  };

  const submit = async () => {
    setTouched(true);
    if (formError() || submittingRef.current) return;
    const { fingerprint, send } = request();
    const resolution = resolveIdempotencyKey(idemRef.current, fingerprint, generateIdempotencyKey);
    if (!resolution.ok) {
      setMessage('An earlier attempt may already have been recorded. Retry it unchanged, or close and check the record.');
      return;
    }
    idemRef.current = resolution.state;
    submittingRef.current = true;
    setSubmitting(true);
    setMessage(null);
    try {
      await send(resolution.key);
      idemRef.current = afterSuccess();
      setStep('done');
      onDone?.();
    } catch (e) {
      const kind = classifyOwnershipError(e as UnknownApiError);
      idemRef.current = afterFailure(idemRef.current, kind.kind === 'AMBIGUOUS');
      setMessage(ownershipErrorMessage(kind));
      // A validation error is fixable in place; an ambiguous one may only be
      // retried unchanged. Anything else ends this attempt (the views refetch
      // through the mutation's invalidation; a stale record needs a new review).
      if (requiresRefresh(kind)) onDone?.();
      if (kind.kind !== 'VALIDATION' && kind.kind !== 'AMBIGUOUS') setStep('stopped');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const facts: [string, ReactNode][] =
    spec.kind === 'resolution-act' || spec.kind === 'review'
      ? [
          ['Incident', spec.detail.incidentNumber],
          ['Deleted order reference', shortId(spec.detail.deletedOrderReference)],
          ['Collected (held as liability)', formatMoney(spec.detail.heldCollectionAmount)],
          ['Tracked shortfall (not recognized)', formatMoney(spec.detail.trackedShortfallAmount)],
          ['Policy', `${spec.detail.policy.policyCode} v${spec.detail.policy.version}`],
          ['Resolution fingerprint', <code key="d" className="text-xs">{spec.detail.resolutionDigest}</code>],
        ]
      : spec.kind === 'policy-decide'
        ? [
            ['Policy', `${spec.policy.policyCode} v${spec.policy.version}`],
            ['Title', spec.policy.title],
            ['Document SHA-256', <code key="s" className="text-xs">{spec.policy.documentSha256}</code>],
            ['Review interval', spec.policy.reviewIntervalDays ? `${spec.policy.reviewIntervalDays} days` : 'None configured'],
            ['Policy fingerprint', <code key="d" className="text-xs">{spec.policy.policyDigest}</code>],
          ]
        : spec.kind === 'resolution-propose'
          ? [
              ['Deleted order reference', shortId(spec.candidate.deletedOrderReference)],
              ['Recorded expected / actual', `${formatMoney(spec.candidate.expectedAmount ?? '0')} / ${formatMoney(spec.candidate.actualAmount ?? '0')}`],
              ['Approved ledger reconciliation', spec.candidate.approvedLedgerReconciliationId ? shortId(spec.candidate.approvedLedgerReconciliationId) : 'None'],
              ['Incident', spec.candidate.incidentNumber ?? '—'],
            ]
          : [];

  const busy = submitting;
  return (
    <ReconciliationDialogShell open={open} title={titleOf(spec)} busy={busy} wide={spec.kind === 'resolution-propose' || spec.kind === 'policy-propose'} onClose={onClose}>
      {step === 'done' ? (
        <>
          <DialogMessage tone="success">Recorded. The server confirmed the change.</DialogMessage>
          <div className="flex justify-end">
            <Button onClick={onClose}>Close</Button>
          </div>
        </>
      ) : (
        <>
          {facts.length > 0 && <Facts rows={facts} />}
          {(spec.kind === 'resolution-propose' || (spec.kind === 'resolution-act' && spec.action === 'record-liability')) && (
            <DialogMessage tone="info">{NO_POSTING_NOTICE}</DialogMessage>
          )}
          {spec.kind === 'resolution-act' && spec.action === 'approve' && <DialogMessage tone="info">{G5_NOTICE}</DialogMessage>}

          {spec.kind === 'policy-propose' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField label="Policy code" value={policy.policyCode} onChange={(e) => setPolicy({ ...policy, policyCode: e.target.value.toUpperCase() })} />
              <TextField label="Title" value={policy.title} onChange={(e) => setPolicy({ ...policy, title: e.target.value })} />
              <div className="sm:col-span-2">
                <TextAreaField label="Summary" rows={3} value={policy.summary} onChange={(e) => setPolicy({ ...policy, summary: e.target.value })} />
              </div>
              <TextField
                label="Approved policy document SHA-256"
                hint="64 lowercase hex characters of the signed Finance policy document"
                value={policy.documentSha256}
                onChange={(e) => setPolicy({ ...policy, documentSha256: e.target.value.toLowerCase() })}
              />
              <TextField label="Document reference" hint="Where the document is stored (outside SwiftDrop)" value={policy.documentReference} onChange={(e) => setPolicy({ ...policy, documentReference: e.target.value })} />
              <TextField
                label="Periodic review interval (days, optional)"
                inputMode="numeric"
                value={policy.reviewIntervalDays?.toString() ?? ''}
                onChange={(e) => setPolicy({ ...policy, reviewIntervalDays: optionalInt(e.target.value) })}
              />
              <TextField
                label="Unclaimed-funds review after (days, optional)"
                hint="No legal expiry is assumed; leave empty unless Finance configured one"
                inputMode="numeric"
                value={policy.unclaimedReviewAfterDays?.toString() ?? ''}
                onChange={(e) => setPolicy({ ...policy, unclaimedReviewAfterDays: optionalInt(e.target.value) })}
              />
              <div className="sm:col-span-2">
                <TextAreaField
                  label="Unclaimed-funds handling"
                  rows={2}
                  value={policy.unclaimedFundsHandling}
                  onChange={(e) => setPolicy({ ...policy, unclaimedFundsHandling: e.target.value })}
                />
              </div>
            </div>
          )}

          {spec.kind === 'resolution-propose' && (
            <div className="space-y-3">
              <SelectField
                label="Approved policy version"
                value={policyId}
                onChange={(e) => setPolicyId(e.target.value)}
                options={spec.policies.map((p) => ({ value: p.id, label: `${p.policyCode} v${p.version} — ${p.title}` }))}
              />
              <TextAreaField
                label="Rationale"
                hint="Why Finance assumes this obligation. Do not include customer personal data."
                rows={3}
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
              />
              <fieldset className="space-y-3">
                <legend className="text-sm font-medium text-ink-secondary">Evidence documents (fingerprints only)</legend>
                {evidence.map((e, i) => (
                  <div key={i} className="grid gap-2 rounded-control border border-line-subtle p-3 sm:grid-cols-2">
                    <SelectField
                      label={`Kind ${i + 1}`}
                      value={e.kind}
                      onChange={(ev) => setEvidence(evidence.map((x, j) => (j === i ? { ...x, kind: ev.target.value as OwnershipEvidenceInput['kind'] } : x)))}
                      options={EVIDENCE_KIND_OPTIONS}
                    />
                    <TextField
                      label="SHA-256"
                      value={e.documentSha256}
                      onChange={(ev) => setEvidence(evidence.map((x, j) => (j === i ? { ...x, documentSha256: ev.target.value.toLowerCase() } : x)))}
                    />
                    <TextField label="Reference" value={e.reference} onChange={(ev) => setEvidence(evidence.map((x, j) => (j === i ? { ...x, reference: ev.target.value } : x)))} />
                    <TextField label="Description" value={e.description} onChange={(ev) => setEvidence(evidence.map((x, j) => (j === i ? { ...x, description: ev.target.value } : x)))} />
                    {evidence.length > 1 && (
                      <div className="sm:col-span-2">
                        <Button variant="ghost" size="sm" onClick={() => setEvidence(evidence.filter((_, j) => j !== i))}>
                          Remove document
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
                {evidence.length < 20 && (
                  <Button variant="secondary" size="sm" onClick={() => setEvidence([...evidence, EMPTY_EVIDENCE])}>
                    Add evidence document
                  </Button>
                )}
              </fieldset>
            </div>
          )}

          {needsReason && (
            <TextAreaField label={spec.kind === 'review' ? 'Review note' : 'Reason'} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          )}

          {needsDigest && (
            <label className="flex items-start gap-2 text-sm text-ink">
              <input type="checkbox" className="mt-1" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
              <span>
                {spec.kind === 'resolution-act' && spec.action === 'record-liability'
                  ? 'I confirm this exact approved resolution and that recording creates a liability only — no credit, payout, settlement or revenue.'
                  : 'I reviewed this exact record and its fingerprint shown above.'}
              </span>
            </label>
          )}

          {error && <DialogMessage tone="warning">{error}</DialogMessage>}
          {message && <DialogMessage tone={step === 'stopped' ? 'danger' : 'warning'}>{message}</DialogMessage>}

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              {step === 'stopped' ? 'Close' : 'Cancel'}
            </Button>
            {step !== 'stopped' && (
              <Button onClick={() => void submit()} loading={busy} variant={spec.kind === 'resolution-act' && spec.action === 'revoke' ? 'danger' : 'primary'}>
                {titleOf(spec)}
              </Button>
            )}
          </div>
        </>
      )}
    </ReconciliationDialogShell>
  );
}
