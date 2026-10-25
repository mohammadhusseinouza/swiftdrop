import {
  getApiErrorCode,
  getApiErrorDetails,
  getApiErrorMessage,
  getApiErrorStatus,
  isTransportError,
  type UnknownApiError,
} from '../../../services/apiError';
import type {
  FinancialReleaseActivationState,
  GateId,
  GateResult,
  ReadinessReport,
} from '../../../services/financialReleaseAdminApi';

/**
 * FR.11B — presentation rules for the Admin "Financial Release" settings tab.
 * UX only: the backend re-evaluates every gate inside the activation
 * transaction and refuses activation on any failure.
 */

/** The financial-release contract this client build implements (client/public/version.json). */
export const CLIENT_FINANCIAL_RELEASE_CONTRACT = 'FR.11';

/** A readiness report older than this must be re-run before activating. */
export const READINESS_MAX_AGE_MS = 5 * 60 * 1000;

export interface GateExplanation {
  checks: string;
  resolve: string;
}

export const GATE_EXPLANATIONS: Record<GateId, GateExplanation> = {
  G0: {
    checks: 'The server environment explicitly authorizes the production cutover.',
    resolve:
      'Set only by an authorized operator in the server environment for an approved cutover. It cannot be changed from this screen, and its value is never shown.',
  },
  G1: {
    checks: 'Every database object settlement-based release depends on exists.',
    resolve: 'Apply the financial-release database migration through the approved deployment.',
  },
  G2: {
    checks: 'No driver holds unattributed (legacy, adjustment or correction) cash.',
    resolve: 'Settle every listed driver’s cash to zero through normal driver settlements.',
  },
  G3: {
    checks: 'Every driver cash balance equals its ledger.',
    resolve: 'Investigate the listed accounts. Never edit ledger rows; use authorized corrections only.',
  },
  G4: {
    checks: 'Every customer wallet balance equals its ledger.',
    resolve: 'Investigate the listed wallets. Never edit ledger rows; use authorized corrections only.',
  },
  G5: {
    checks: 'No legacy collection difference awaits review and every settlement has its cash record.',
    resolve: 'Resolve the listed collection differences from the order page.',
  },
  G6: {
    checks: 'Every financial reconciliation invariant (R1–R13) holds.',
    resolve: 'Review the failing checks in the reconciliation status below. Nothing is repaired automatically.',
  },
  G7: {
    checks: 'The deployed client build implements the same financial-release contract as the server.',
    resolve: 'Deploy the matching client build and configure the server’s CLIENT_URL.',
  },
};

export type GateDisplayStatus = 'PASSED' | 'FAILED' | 'NOT_EVALUATED';

export function gateDisplayStatus(gate: GateResult): GateDisplayStatus {
  if (gate.passed) return 'PASSED';
  return /^Not evaluated/.test(gate.detail) ? 'NOT_EVALUATED' : 'FAILED';
}

export type ActionAvailability = { kind: 'AVAILABLE' } | { kind: 'BLOCKED'; reasons: string[] } | { kind: 'HIDDEN' };

/**
 * Activation is offered only when the server reports the environment as
 * authorized and a fresh readiness report passes every gate.
 */
export function activationAvailability(
  state: FinancialReleaseActivationState | undefined,
  readiness: ReadinessReport | undefined,
  opts: { readinessFetching: boolean; readinessError: boolean; now: number },
): ActionAvailability {
  if (!state || state.enabled) return { kind: 'HIDDEN' };
  const reasons: string[] = [];
  if (!state.environmentAuthorized) reasons.push('This environment is not authorized for the cutover (gate G0).');
  if (opts.readinessError) reasons.push('The readiness report could not be loaded.');
  else if (opts.readinessFetching || !readiness) reasons.push('The readiness report is being evaluated.');
  else {
    for (const g of readiness.gates) {
      // G0 is already explained by the environment-authorization line above.
      if (!g.passed && !(g.id === 'G0' && !state.environmentAuthorized)) reasons.push(`${g.id} ${g.title}: ${g.detail}`);
    }
    if (opts.now - Date.parse(readiness.evaluatedAt) > READINESS_MAX_AGE_MS) {
      reasons.push('The readiness report is more than 5 minutes old — run it again.');
    }
  }
  if (state.serverContractVersion !== CLIENT_FINANCIAL_RELEASE_CONTRACT) {
    reasons.push(
      `This browser runs client contract ${CLIENT_FINANCIAL_RELEASE_CONTRACT}, the server implements ${state.serverContractVersion} — reload the application.`,
    );
  }
  return reasons.length === 0 ? { kind: 'AVAILABLE' } : { kind: 'BLOCKED', reasons };
}

/** Deactivation is always allowed while the feature is on. */
export function deactivationAvailability(state: FinancialReleaseActivationState | undefined): ActionAvailability {
  return state?.enabled ? { kind: 'AVAILABLE' } : { kind: 'HIDDEN' };
}

/** The deployed client contract reported by gate G7 (`financialReleaseContract=FR.11`). */
export function deployedClientContract(readiness: ReadinessReport | undefined): string | null {
  const g7 = readiness?.gates.find((g) => g.id === 'G7');
  const finding = g7?.findings.find((f) => f.entityType === 'CLIENT_BUILD');
  const m = finding?.detail.match(/financialReleaseContract=(.+)$/);
  return m && m[1] !== 'none' ? m[1] : null;
}

export type ActivationErrorKind =
  | { kind: 'GATES_FAILED'; failedGates: string[]; gates: GateResult[] | null; message: string }
  | { kind: 'PERMISSION'; message: string }
  | { kind: 'UNCONFIRMED'; message: string }
  | { kind: 'OTHER'; message: string };

/**
 * Errors from activate / deactivate. Activation carries no money, but an
 * unconfirmed outcome still means "reload the state before acting again".
 */
export function classifyActivationError(error: UnknownApiError): ActivationErrorKind {
  const status = getApiErrorStatus(error);
  if (isTransportError(error) || (typeof status === 'number' && status >= 500)) {
    return {
      kind: 'UNCONFIRMED',
      message: 'The server did not confirm the change. The current state was reloaded — check it before trying again.',
    };
  }
  if (status === 403 || getApiErrorCode(error) === 'FORBIDDEN') {
    return { kind: 'PERMISSION', message: 'Only administrators can change financial release activation.' };
  }
  const details = getApiErrorDetails(error);
  const d = details && typeof details === 'object' ? (details as Record<string, unknown>) : null;
  if (status === 409 && d?.reason === 'ACTIVATION_GATE_FAILED') {
    const failedGates = Array.isArray(d.failedGates) ? d.failedGates.filter((g): g is string => typeof g === 'string') : [];
    const gates = Array.isArray(d.gates) ? (d.gates as GateResult[]) : null;
    return {
      kind: 'GATES_FAILED',
      failedGates,
      gates,
      message: `The server refused activation — gate${failedGates.length === 1 ? '' : 's'} ${failedGates.join(', ')} failed. Nothing was changed.`,
    };
  }
  return { kind: 'OTHER', message: getApiErrorMessage(error) };
}
