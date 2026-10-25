// FR.11B — Admin activation presentation rules, settings tab visibility and
// the ambiguous-failure rule for settlement submissions. Run:
//   npx --prefix ../server tsx --test tests/fr11bReadiness.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  FinancialReleaseActivationState,
  GateResult,
  ReadinessReport,
} from '../src/services/financialReleaseAdminApi';
import {
  CLIENT_FINANCIAL_RELEASE_CONTRACT,
  READINESS_MAX_AGE_MS,
  activationAvailability,
  classifyActivationError,
  deactivationAvailability,
  deployedClientContract,
  gateDisplayStatus,
} from '../src/pages/management/settings/financialReleaseActivation';
import { parseSettingsTab, visibleSettingsTabs } from '../src/pages/management/settings/settingsTabs';
import {
  INITIAL_IDEMPOTENCY_STATE,
  afterFailure,
  classifySettlementError,
  isAmbiguousSettlementFailure,
  resolveIdempotencyKey,
  settlementErrorMessage,
} from '../src/pages/management/settlements/settlementSubmission';

const NOW = Date.parse('2026-10-18T12:00:00Z');

function gate(id: GateResult['id'], passed: boolean, detail = passed ? 'ok' : 'failing', extra: Partial<GateResult> = {}): GateResult {
  return { id, title: `Gate ${id}`, passed, detail, affectedCount: passed ? 0 : 1, findings: [], ...extra };
}

function report(failing: GateResult['id'][] = [], evaluatedAt = new Date(NOW - 1000).toISOString()): ReadinessReport {
  const ids: GateResult['id'][] = ['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'];
  const gates = ids.map((id) =>
    id === 'G7'
      ? gate(id, !failing.includes(id), undefined, {
          findings: [{ entityType: 'CLIENT_BUILD', entityId: 'https://client.example/version.json', detail: 'financialReleaseContract=FR.11' }],
        })
      : gate(id, !failing.includes(id)),
  );
  return { evaluatedAt, ready: failing.length === 0, failedGates: failing, gates, historicalFindings: [] };
}

const state = (over: Partial<FinancialReleaseActivationState> = {}): FinancialReleaseActivationState => ({
  enabled: false,
  environmentAuthorized: true,
  serverContractVersion: CLIENT_FINANCIAL_RELEASE_CONTRACT,
  settingUpdatedAt: null,
  ...over,
});

const opts = { readinessFetching: false, readinessError: false, now: NOW };

function apiError(status: number, code: string, message: string, details?: unknown) {
  return { status, data: { success: false, error: { code, message, ...(details ? { details } : {}) } } };
}

describe('1. activation availability (UX only — the server re-checks every gate)', () => {
  test('available only when authorized, fresh and every gate passes', () => {
    assert.deepEqual(activationAvailability(state(), report(), opts), { kind: 'AVAILABLE' });
  });
  test('hidden when already enabled or the state is unknown', () => {
    assert.equal(activationAvailability(state({ enabled: true }), report(), opts).kind, 'HIDDEN');
    assert.equal(activationAvailability(undefined, report(), opts).kind, 'HIDDEN');
  });
  test('not authorized: blocked with one G0 explanation (not repeated per gate)', () => {
    const a = activationAvailability(state({ environmentAuthorized: false }), report(['G0']), opts);
    assert.equal(a.kind, 'BLOCKED');
    if (a.kind !== 'BLOCKED') return;
    assert.equal(a.reasons.length, 1);
    assert.match(a.reasons[0], /not authorized/);
  });
  test('every failing gate is listed', () => {
    const a = activationAvailability(state(), report(['G2', 'G6']), opts);
    assert.equal(a.kind, 'BLOCKED');
    if (a.kind !== 'BLOCKED') return;
    assert.ok(a.reasons.some((r) => r.startsWith('G2')));
    assert.ok(a.reasons.some((r) => r.startsWith('G6')));
  });
  test('stale, loading or failed readiness blocks activation', () => {
    const old = report([], new Date(NOW - READINESS_MAX_AGE_MS - 1).toISOString());
    assert.equal(activationAvailability(state(), old, opts).kind, 'BLOCKED');
    assert.equal(activationAvailability(state(), undefined, opts).kind, 'BLOCKED');
    assert.equal(activationAvailability(state(), report(), { ...opts, readinessFetching: true }).kind, 'BLOCKED');
    assert.equal(activationAvailability(state(), undefined, { ...opts, readinessError: true }).kind, 'BLOCKED');
  });
  test('a client/server contract mismatch blocks activation', () => {
    const a = activationAvailability(state({ serverContractVersion: 'FR.12' }), report(), opts);
    assert.equal(a.kind, 'BLOCKED');
    if (a.kind === 'BLOCKED') assert.match(a.reasons.join(' '), /reload the application/);
  });
  test('deactivation is offered whenever the feature is on, never gated', () => {
    assert.equal(deactivationAvailability(state({ enabled: true })).kind, 'AVAILABLE');
    assert.equal(deactivationAvailability(state({ enabled: false })).kind, 'HIDDEN');
  });
});

describe('2. gate presentation', () => {
  test('deployed client contract is read from G7', () => {
    assert.equal(deployedClientContract(report()), 'FR.11');
    assert.equal(deployedClientContract(undefined), null);
  });
  test('gates skipped after a schema failure are shown as not evaluated', () => {
    assert.equal(gateDisplayStatus(gate('G2', false, 'Not evaluated — schema readiness (G1) failed')), 'NOT_EVALUATED');
    assert.equal(gateDisplayStatus(gate('G2', false)), 'FAILED');
    assert.equal(gateDisplayStatus(gate('G2', true)), 'PASSED');
  });
});

describe('3. activation errors', () => {
  test('409 ACTIVATION_GATE_FAILED carries the server’s own gate evaluation', () => {
    const k = classifyActivationError(
      apiError(409, 'CONFLICT', 'gates failed', { reason: 'ACTIVATION_GATE_FAILED', failedGates: ['G2'], gates: [gate('G2', false)] }),
    );
    assert.equal(k.kind, 'GATES_FAILED');
    if (k.kind === 'GATES_FAILED') {
      assert.deepEqual(k.failedGates, ['G2']);
      assert.equal(k.gates?.length, 1);
      assert.match(k.message, /Nothing was changed/);
    }
  });
  test('G0-only refusal (no gate list) is still a gate failure', () => {
    const k = classifyActivationError(apiError(409, 'CONFLICT', 'not authorized', { reason: 'ACTIVATION_GATE_FAILED', failedGates: ['G0'] }));
    assert.equal(k.kind, 'GATES_FAILED');
    if (k.kind === 'GATES_FAILED') assert.equal(k.gates, null);
  });
  test('5xx and transport failures are unconfirmed; 403 is a permission error', () => {
    assert.equal(classifyActivationError(apiError(500, 'INTERNAL_ERROR', 'x')).kind, 'UNCONFIRMED');
    assert.equal(classifyActivationError(apiError(503, 'SERVICE_UNAVAILABLE', 'x', { reason: 'TRANSACTION_TIMEOUT' })).kind, 'UNCONFIRMED');
    assert.equal(classifyActivationError({ status: 'FETCH_ERROR', error: 'TypeError: Failed to fetch' }).kind, 'UNCONFIRMED');
    assert.equal(classifyActivationError(apiError(403, 'FORBIDDEN', 'no')).kind, 'PERMISSION');
  });
});

describe('4. Financial Release tab visibility (UX only — the backend gates by role)', () => {
  test('only ADMIN sees the tab', () => {
    assert.ok(visibleSettingsTabs('ADMIN').some((t) => t.id === 'financial-release'));
    for (const role of ['FINANCE', 'DISPATCHER', null]) {
      assert.ok(!visibleSettingsTabs(role).some((t) => t.id === 'financial-release'));
    }
  });
  test('a deep link to the tab falls back to General for non-admins', () => {
    assert.equal(parseSettingsTab('financial-release', 'ADMIN'), 'financial-release');
    assert.equal(parseSettingsTab('financial-release', 'FINANCE'), 'general');
    assert.equal(parseSettingsTab('financial-release'), 'general');
    assert.equal(parseSettingsTab('areas', 'FINANCE'), 'areas');
  });
});

describe('5. settlement submission: unknown outcomes keep the same key (FR.11B)', () => {
  const gen = (() => {
    let n = 0;
    return () => `key-${++n}`;
  })();
  test('a 503 TRANSACTION_TIMEOUT is its own kind and is ambiguous', () => {
    const k = classifySettlementError(apiError(503, 'SERVICE_UNAVAILABLE', 'timed out', { reason: 'TRANSACTION_TIMEOUT', retrySameRequest: true }));
    assert.equal(k.kind, 'TRANSACTION_TIMEOUT');
    assert.equal(isAmbiguousSettlementFailure(k), true);
    assert.match(settlementErrorMessage(k), /same settlement/);
  });
  test('any 5xx is ambiguous: it may have committed', () => {
    const k = classifySettlementError(apiError(500, 'INTERNAL_ERROR', 'x'));
    assert.equal(k.kind, 'SERVER');
    assert.equal(isAmbiguousSettlementFailure(k), true);
    assert.match(settlementErrorMessage(k), /could not be confirmed/);
  });
  test('transport failures stay ambiguous; definitive failures are not', () => {
    assert.equal(isAmbiguousSettlementFailure(classifySettlementError({ status: 'FETCH_ERROR', error: 'x' })), true);
    for (const e of [
      apiError(400, 'VALIDATION_ERROR', 'bad'),
      apiError(403, 'FORBIDDEN', 'no'),
      apiError(404, 'NOT_FOUND', 'Driver not found'),
      apiError(409, 'CONFLICT', 'A collection was changed by another request — please retry'),
    ]) {
      assert.equal(isAmbiguousSettlementFailure(classifySettlementError(e)), false, JSON.stringify(e));
    }
  });
  test('after a 5xx a changed body is refused and the same body reuses the key', () => {
    const first = resolveIdempotencyKey(INITIAL_IDEMPOTENCY_STATE, 'body-A', gen);
    assert.ok(first.ok);
    const failed = afterFailure(first.state, isAmbiguousSettlementFailure(classifySettlementError(apiError(500, 'INTERNAL_ERROR', 'x'))));
    assert.deepEqual(resolveIdempotencyKey(failed, 'body-B', gen), { ok: false, reason: 'AMBIGUOUS_PENDING' });
    const retry = resolveIdempotencyKey(failed, 'body-A', gen);
    assert.ok(retry.ok && retry.key === first.key);
  });
});
