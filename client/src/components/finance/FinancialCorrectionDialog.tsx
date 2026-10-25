import { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, X } from 'lucide-react';

import { cn } from '../ui/cn';
import { Button } from '../ui/Button';
import { TextAreaField } from '../forms/Field';
import { formatMoney } from '../../lib/format';
import type { UnknownApiError } from '../../services/apiError';
import {
  INITIAL_IDEMPOTENCY_STATE,
  afterFailure,
  afterSuccess,
  generateIdempotencyKey,
  resolveIdempotencyKey,
  type IdempotencyState,
} from '../../pages/management/settlements/settlementSubmission';
import {
  CORRECTION_REASON_MIN_LENGTH,
  classifyCorrectionError,
  reasonError,
  type ConsequenceRow,
} from './correctionActions';

/**
 * FR.10.2 — confirmation dialog for the dedicated financial corrections
 * (collection void, release reversal, settlement reversal). Reason → explicit
 * confirmation of the exact consequences → server confirmation. Never
 * optimistic: success only after the backend answers 2xx.
 *
 * IDEMPOTENCY: one key per intended correction, bound to the reason
 * (settlementSubmission rules). A transport failure locks the reason and only
 * allows retrying the SAME request (the server replays it, never applies it
 * twice). Each FR.6 endpoint also has a deterministic server key.
 */
export interface FinancialCorrectionDialogProps {
  open: boolean;
  title: string;
  intro: string;
  rows: ConsequenceRow[];
  /** Money row labels whose value is a 2-decimal amount (formatted as money). */
  moneyLabels?: string[];
  consequences: string[];
  warnings?: string[];
  /** Extra content, e.g. the affected allocations of a settlement reversal. */
  details?: React.ReactNode;
  confirmLabel: string;
  successMessage: string;
  onSubmit: (reason: string, idempotencyKey: string) => Promise<unknown>;
  onClose: () => void;
}

type Step = 'form' | 'confirm' | 'done' | 'stopped';

export function FinancialCorrectionDialog({
  open,
  title,
  intro,
  rows,
  moneyLabels = [],
  consequences,
  warnings = [],
  details,
  confirmLabel,
  successMessage,
  onSubmit,
  onClose,
}: FinancialCorrectionDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [step, setStep] = useState<Step>('form');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [ambiguous, setAmbiguous] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const idemRef = useRef<IdempotencyState>(INITIAL_IDEMPOTENCY_STATE);
  const submittingRef = useRef(false);

  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setStep('form');
      setReason('');
      setTouched(false);
      setMessage(null);
      setAmbiguous(false);
      idemRef.current = INITIAL_IDEMPOTENCY_STATE;
      submittingRef.current = false;
    }
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  const error = touched ? reasonError(reason) : null;

  const run = async () => {
    if (submittingRef.current) return;
    const trimmed = reason.trim();
    const resolution = resolveIdempotencyKey(idemRef.current, JSON.stringify({ reason: trimmed }), generateIdempotencyKey);
    if (!resolution.ok) {
      setMessage('An earlier attempt may already have been recorded. Retry it unchanged, or close and check the record.');
      return;
    }
    idemRef.current = resolution.state;
    submittingRef.current = true;
    setSubmitting(true);
    setMessage(null);
    try {
      await onSubmit(trimmed, resolution.key);
      idemRef.current = afterSuccess();
      setAmbiguous(false);
      setStep('done');
    } catch (e) {
      const kind = classifyCorrectionError(e as UnknownApiError);
      idemRef.current = afterFailure(idemRef.current, kind.kind === 'TRANSPORT');
      setAmbiguous(idemRef.current.ambiguous);
      setMessage(kind.message);
      if (kind.kind === 'VALIDATION') setStep('form');
      else if (kind.kind !== 'TRANSPORT') setStep('stopped');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const summary = (
    <dl className="divide-y divide-line-subtle rounded-control border border-line-subtle">
      {rows.map((r) => (
        <div key={r.label} className="flex justify-between gap-4 px-3 py-2 text-sm">
          <dt className="text-ink-muted">{r.label}</dt>
          <dd className={cn('text-right font-medium text-ink', moneyLabels.includes(r.label) && 'tabular-nums')}>
            {moneyLabels.includes(r.label) ? formatMoney(r.value) : r.value}
          </dd>
        </div>
      ))}
    </dl>
  );

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!submitting) onClose();
      }}
      className="m-auto w-[calc(100vw-2rem)] max-w-xl rounded-card border border-line bg-card p-0 text-ink shadow-overlay backdrop:bg-ink/40 max-h-[calc(100vh-3rem)]"
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 id={titleId} className="text-base font-semibold text-ink">
          {step === 'done' ? 'Correction recorded' : step === 'confirm' ? `Confirm: ${title}` : title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          aria-label="Close"
          className="rounded-control p-1 text-ink-muted hover:bg-neutral-50 hover:text-ink disabled:opacity-50"
        >
          <X className="size-5" aria-hidden="true" />
        </button>
      </div>

      <div className="max-h-[calc(100vh-11rem)] space-y-4 overflow-y-auto p-5">
        {message && (
          <div
            role="alert"
            className={cn(
              'rounded-control border px-3 py-2 text-sm',
              ambiguous ? 'border-warning-200 bg-warning-50 text-warning-700' : 'border-danger-200 bg-danger-50 text-danger-700',
            )}
          >
            {message}
          </div>
        )}

        {step === 'form' && (
          <form
            noValidate
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              setTouched(true);
              if (!reasonError(reason)) setStep('confirm');
            }}
          >
            <p className="text-sm text-ink-secondary">{intro}</p>
            {summary}
            {details}
            <TextAreaField
              label="Reason"
              required
              rows={3}
              hint={`Required — at least ${CORRECTION_REASON_MIN_LENGTH} characters. Recorded in the correction history and the audit log.`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => setTouched(true)}
              error={error ?? undefined}
            />
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit">Review correction</Button>
            </div>
          </form>
        )}

        {step === 'confirm' && (
          <div className="space-y-4">
            {summary}
            {details}
            <div className="rounded-control border border-line-subtle bg-sunken px-3 py-2 text-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">Reason</p>
              <p className="mt-1 whitespace-pre-line text-ink">{reason.trim()}</p>
            </div>
            <div>
              <p className="text-sm font-semibold text-ink">This will:</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink-secondary">
                {consequences.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
            {warnings.length > 0 && (
              <ul className="space-y-1 rounded-control border border-warning-200 bg-warning-50 px-3 py-2 text-xs text-warning-700">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              {ambiguous ? (
                <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
                  Close and check the record
                </Button>
              ) : (
                <Button type="button" variant="secondary" icon={<ArrowLeft />} onClick={() => setStep('form')} disabled={submitting}>
                  Back
                </Button>
              )}
              <Button type="button" variant="danger" loading={submitting} disabled={submitting} onClick={() => void run()}>
                {ambiguous ? 'Retry correction' : confirmLabel}
              </Button>
            </div>
          </div>
        )}

        {step === 'stopped' && (
          <div className="flex justify-end">
            <Button type="button" onClick={onClose}>
              Close
            </Button>
          </div>
        )}

        {step === 'done' && (
          <div className="space-y-4">
            <div role="status" className="rounded-control border border-success-200 bg-success-50 px-4 py-3 text-sm text-success-700">
              {successMessage}
            </div>
            <div className="flex justify-end">
              <Button type="button" onClick={onClose}>
                Done
              </Button>
            </div>
          </div>
        )}
      </div>
    </dialog>
  );
}
