import {
  getApiErrorCode,
  getApiErrorDetails,
  getApiErrorMessage,
  getApiErrorStatus,
  isTransportError,
  type UnknownApiError,
} from '../../../services/apiError';

/**
 * FR.9 — submission rules for `POST /driver-settlements`, kept pure so the
 * idempotency, error and cache behavior are testable without React.
 */

/* ------------------------------ idempotency ------------------------------ */

/**
 * One key per intended settlement. The key is bound to the exact request body
 * it was first sent with:
 *   - same body          → same key (a retry; the server replays, never re-executes)
 *   - success            → cleared (the next settlement is a new intent)
 *   - definitive failure → kept; a changed body gets a NEW key (same key +
 *                          different body is an idempotency conflict)
 *   - ambiguous failure  → kept and LOCKED to that body: the first attempt may
 *                          have committed, so a different body is refused until
 *                          the dialog is closed (never a second settlement).
 */
export interface IdempotencyState {
  key: string | null;
  body: string | null;
  ambiguous: boolean;
}

export const INITIAL_IDEMPOTENCY_STATE: IdempotencyState = { key: null, body: null, ambiguous: false };

export type KeyResolution =
  | { ok: true; key: string; state: IdempotencyState }
  | { ok: false; reason: 'AMBIGUOUS_PENDING' };

export function resolveIdempotencyKey(
  state: IdempotencyState,
  body: string,
  generate: () => string,
): KeyResolution {
  if (state.key !== null && state.body === body) return { ok: true, key: state.key, state };
  if (state.ambiguous) return { ok: false, reason: 'AMBIGUOUS_PENDING' };
  const key = generate();
  return { ok: true, key, state: { key, body, ambiguous: false } };
}

export function afterSuccess(): IdempotencyState {
  return INITIAL_IDEMPOTENCY_STATE;
}

/**
 * Ambiguity is sticky until success or the dialog closes: the server checks
 * the driver and payment method BEFORE its replay lookup, so a later
 * definitive failure does not prove the ambiguous attempt never committed.
 */
export function afterFailure(state: IdempotencyState, ambiguous: boolean): IdempotencyState {
  return { ...state, ambiguous: state.ambiguous || ambiguous };
}

export function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h
    .slice(6, 8)
    .join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
}

/* ------------------------------ error kinds ------------------------------ */

export type SettlementErrorKind =
  | { kind: 'TRANSPORT' }
  | { kind: 'TRANSACTION_TIMEOUT' }
  | { kind: 'PERMISSION' }
  | { kind: 'ALLOCATION_INVALID'; releaseId: string | null; problem: string }
  | { kind: 'UNATTRIBUTED_EXCEEDS_BALANCE'; unattributedBalance: string | null }
  | { kind: 'ALLOCATION_CONTRACT_REQUIRED' }
  | { kind: 'INSUFFICIENT_CASH' }
  | { kind: 'STALE_COLLECTION' }
  | { kind: 'IDEMPOTENCY_CONFLICT' }
  | { kind: 'NOT_FOUND' }
  | { kind: 'VALIDATION'; message: string }
  | { kind: 'SERVER' }
  | { kind: 'OTHER'; message: string };

function detailsRecord(error: UnknownApiError): Record<string, unknown> | null {
  const d = getApiErrorDetails(error);
  return d && typeof d === 'object' ? (d as Record<string, unknown>) : null;
}

export function classifySettlementError(error: UnknownApiError): SettlementErrorKind {
  if (isTransportError(error)) return { kind: 'TRANSPORT' };
  const status = getApiErrorStatus(error);
  const code = getApiErrorCode(error);
  const message = getApiErrorMessage(error);
  const details = detailsRecord(error);
  const reason = typeof details?.reason === 'string' ? details.reason : null;

  // FR.11B — the server's transaction outlived its timeout (503); whether it
  // committed is unknown, so it is retried only with the SAME key and body.
  if (status === 503 && reason === 'TRANSACTION_TIMEOUT') return { kind: 'TRANSACTION_TIMEOUT' };
  if (status === 403 || code === 'FORBIDDEN') return { kind: 'PERMISSION' };
  if (reason === 'ALLOCATION_INVALID') {
    return {
      kind: 'ALLOCATION_INVALID',
      releaseId: typeof details?.releaseId === 'string' ? details.releaseId : null,
      problem: typeof details?.problem === 'string' ? details.problem : message,
    };
  }
  if (reason === 'UNATTRIBUTED_EXCEEDS_BALANCE') {
    return {
      kind: 'UNATTRIBUTED_EXCEEDS_BALANCE',
      unattributedBalance: typeof details?.unattributedBalance === 'string' ? details.unattributedBalance : null,
    };
  }
  if (reason === 'ALLOCATION_CONTRACT_REQUIRED') return { kind: 'ALLOCATION_CONTRACT_REQUIRED' };
  if (status === 409 || code === 'CONFLICT') {
    return /idempotency/i.test(message) ? { kind: 'IDEMPOTENCY_CONFLICT' } : { kind: 'STALE_COLLECTION' };
  }
  if (status === 404 || code === 'NOT_FOUND') return { kind: 'NOT_FOUND' };
  if (status === 400 && /insufficient driver cash/i.test(message)) return { kind: 'INSUFFICIENT_CASH' };
  if (status === 400 || status === 422 || code === 'VALIDATION_ERROR') return { kind: 'VALIDATION', message };
  if (typeof status === 'number' && status >= 500) return { kind: 'SERVER' };
  return { kind: 'OTHER', message };
}

/**
 * FR.11B — failures whose outcome the client cannot know: the request may
 * have committed (a 5xx can follow a commit, e.g. a failed response read).
 * The key stays bound and LOCKED to the same body, so a retry replays instead
 * of creating a second settlement. Never mint a new key for these.
 */
export function isAmbiguousSettlementFailure(error: SettlementErrorKind): boolean {
  return error.kind === 'TRANSPORT' || error.kind === 'TRANSACTION_TIMEOUT' || error.kind === 'SERVER';
}

/** Kinds after which the outstanding collections / cash position must be refetched. */
export function needsPositionRefresh(error: SettlementErrorKind): boolean {
  return (
    error.kind === 'ALLOCATION_INVALID' ||
    error.kind === 'UNATTRIBUTED_EXCEEDS_BALANCE' ||
    error.kind === 'ALLOCATION_CONTRACT_REQUIRED' ||
    error.kind === 'INSUFFICIENT_CASH' ||
    error.kind === 'STALE_COLLECTION' ||
    error.kind === 'IDEMPOTENCY_CONFLICT' ||
    error.kind === 'NOT_FOUND'
  );
}

export function settlementErrorMessage(error: SettlementErrorKind): string {
  switch (error.kind) {
    case 'TRANSPORT':
      return 'We could not confirm whether the settlement was processed. Retry the same settlement — the server will not process it twice.';
    case 'TRANSACTION_TIMEOUT':
      return 'The settlement took too long to confirm. Retry the same settlement — the server will not process it twice — or close and check the settlement history.';
    case 'PERMISSION':
      return 'You do not have permission to process settlements.';
    case 'ALLOCATION_INVALID':
      return `A selected collection can no longer take this amount (${error.problem}). The collections were refreshed — review your selection.`;
    case 'UNATTRIBUTED_EXCEEDS_BALANCE':
      return error.unattributedBalance !== null
        ? `The unattributed amount exceeds the driver's unattributed cash (${error.unattributedBalance}). Unattributed cash cannot be taken from money reserved for collections.`
        : "The unattributed amount exceeds the driver's unattributed cash.";
    case 'ALLOCATION_CONTRACT_REQUIRED':
      return "This driver's cash must be settled with explicit collection allocations. Select collections or enter an explained unattributed amount.";
    case 'INSUFFICIENT_CASH':
      return 'The driver no longer holds enough cash for this settlement. The cash position was refreshed.';
    case 'STALE_COLLECTION':
      return 'A collection was changed by another request. The collections were refreshed — review your selection and try again.';
    case 'IDEMPOTENCY_CONFLICT':
      return 'This settlement request was already used for a different settlement. Check the settlement history before trying again.';
    case 'NOT_FOUND':
      return 'The driver or a collection could not be found. The data was refreshed.';
    case 'VALIDATION':
      return error.message;
    case 'SERVER':
      return 'The server reported an error, so the outcome could not be confirmed. Retry the same settlement — it will not be processed twice — or close and check the settlement history.';
    case 'OTHER':
      return error.message;
  }
}
