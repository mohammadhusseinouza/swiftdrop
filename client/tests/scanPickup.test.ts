// Driver "Scan Barcode" pickup — pure session logic + wiring checks. Same
// lightweight approach as the other client tests (Node's built-in runner,
// outside src/; no DOM / camera). Run:
//   npx --prefix ../server tsx --test tests/scanPickup.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createScanSession,
  describeCameraError,
  describeScanPickupError,
  isCameraSupported,
  normalizeScannedValue,
  type ScanStatus,
} from '../src/components/driver/scanPickup';

function apiError(status: number | string, body?: { code: string; message: string; details?: unknown }) {
  return body
    ? { status, data: { success: false, error: body } }
    : { status, error: 'TypeError: Failed to fetch' };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(submitImpl: (barcode: string) => Promise<{ orderNumber: string }>) {
  let clock = 0;
  const calls: string[] = [];
  const statuses: ScanStatus[] = [];
  let vibrations = 0;
  const session = createScanSession({
    submit: (b) => {
      calls.push(b);
      return submitImpl(b);
    },
    onChange: (s) => statuses.push(s),
    onSuccess: () => {
      vibrations += 1;
    },
    now: () => clock,
    repeatCooldownMs: 3000,
  });
  return {
    session,
    calls,
    statuses,
    get vibrations() {
      return vibrations;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const NOT_FOUND = apiError(404, { code: 'NOT_FOUND', message: 'Order not found' });
const ALREADY = apiError(409, {
  code: 'CONFLICT',
  message: 'Order already picked up',
  details: { reason: 'ALREADY_PICKED_UP', status: 'PICKED_UP' },
});

describe('normalizeScannedValue', () => {
  test('trims and accepts the label value (tracking code)', () => {
    assert.equal(normalizeScannedValue('  TRK-ABC123DEF456\n'), 'TRK-ABC123DEF456');
  });
  test('rejects empty, internal spaces, control/non-ASCII and over-long values', () => {
    for (const bad of ['', '   ', 'TRK 1', 'TRK-\u0001', 'طرد', 'x'.repeat(101)]) {
      assert.equal(normalizeScannedValue(bad), null, JSON.stringify(bad));
    }
  });
});

describe('describeScanPickupError', () => {
  test('404 -> Order not found (no detail about other drivers)', () => {
    assert.deepEqual(describeScanPickupError(NOT_FOUND as never), {
      message: 'Order not found',
      retryable: false,
    });
  });
  test('400 -> Invalid barcode', () => {
    const e = apiError(400, { code: 'VALIDATION_ERROR', message: 'Validation failed' });
    assert.equal(describeScanPickupError(e as never).message, 'Invalid barcode');
  });
  test('409 uses the server reason message; only ORDER_CHANGED is retryable', () => {
    assert.deepEqual(describeScanPickupError(ALREADY as never), {
      message: 'Order already picked up',
      retryable: false,
    });
    const cancelled = apiError(409, {
      code: 'CONFLICT',
      message: 'Order is cancelled',
      details: { reason: 'ORDER_CANCELLED' },
    });
    assert.equal(describeScanPickupError(cancelled as never).retryable, false);
    const changed = apiError(409, {
      code: 'CONFLICT',
      message: 'Order was changed by another request — please retry',
      details: { reason: 'ORDER_CHANGED' },
    });
    assert.equal(describeScanPickupError(changed as never).retryable, true);
  });
  test('network / server errors are retryable', () => {
    for (const e of [apiError('FETCH_ERROR'), apiError(500, { code: 'INTERNAL_ERROR', message: 'x' })]) {
      const view = describeScanPickupError(e as never);
      assert.equal(view.retryable, true);
      assert.match(view.message, /Network or server error/);
    }
  });
});

describe('scan session', () => {
  test('successful detection -> processing -> success, vibrates, then ready for the next package', async () => {
    const h = harness(async (b) => ({ orderNumber: `ORD-${b}` }));
    assert.equal(await h.session.handleDetected('TRK-1'), true);
    assert.deepEqual(
      h.statuses.map((s) => s.kind),
      ['processing', 'success'],
    );
    assert.equal(h.vibrations, 1);
    assert.equal(h.session.getPickedUpCount(), 1);

    // Continuous scanning: a different package in the same session.
    assert.equal(await h.session.handleDetected('TRK-2'), true);
    assert.deepEqual(h.calls, ['TRK-1', 'TRK-2']);
    assert.equal(h.session.getPickedUpCount(), 2);
    const last = h.session.getStatus();
    assert.equal(last.kind, 'success');
    assert.equal(last.kind === 'success' && last.orderNumber, 'ORD-TRK-2');
  });

  test('repeated detections while a request is in flight never overlap', async () => {
    const d = deferred<{ orderNumber: string }>();
    const h = harness(() => d.promise);
    const first = h.session.handleDetected('TRK-1');
    // Camera keeps reporting frames (same and other codes) during the request.
    assert.equal(await h.session.handleDetected('TRK-1'), false);
    assert.equal(await h.session.handleDetected('TRK-2'), false);
    assert.equal(await h.session.handleManual('TRK-3'), false);
    assert.deepEqual(h.calls, ['TRK-1']);
    d.resolve({ orderNumber: 'ORD-1' });
    assert.equal(await first, true);
  });

  test('a code already picked up this session is never re-submitted by the camera', async () => {
    const h = harness(async () => ({ orderNumber: 'ORD-1' }));
    await h.session.handleDetected('TRK-1');
    h.advance(60_000);
    assert.equal(await h.session.handleDetected('TRK-1'), false);
    assert.deepEqual(h.calls, ['TRK-1']);
  });

  test('success is shown only after the backend confirms', async () => {
    const d = deferred<{ orderNumber: string }>();
    const h = harness(() => d.promise);
    const p = h.session.handleDetected('TRK-1');
    assert.equal(h.session.getStatus().kind, 'processing');
    assert.equal(h.vibrations, 0);
    d.resolve({ orderNumber: 'ORD-1' });
    await p;
    assert.equal(h.session.getStatus().kind, 'success');
  });

  test('a failed code is not re-submitted by the camera until the cooldown passes', async () => {
    const h = harness(async () => {
      throw NOT_FOUND;
    });
    await h.session.handleDetected('TRK-X');
    const status = h.session.getStatus();
    assert.equal(status.kind, 'error');
    assert.equal(status.kind === 'error' && status.message, 'Order not found');
    assert.equal(h.vibrations, 0);

    h.advance(2999);
    assert.equal(await h.session.handleDetected('TRK-X'), false);
    h.advance(1);
    assert.equal(await h.session.handleDetected('TRK-X'), true);
    assert.deepEqual(h.calls, ['TRK-X', 'TRK-X']);
  });

  test('already-picked-up response is shown and not retryable', async () => {
    const h = harness(async () => {
      throw ALREADY;
    });
    await h.session.handleDetected('TRK-1');
    const s = h.session.getStatus();
    assert.equal(s.kind === 'error' && s.message, 'Order already picked up');
    assert.equal(await h.session.retry(), false);
    assert.equal(h.session.getPickedUpCount(), 0);
  });

  test('network error -> retry re-submits the same code', async () => {
    let attempt = 0;
    const h = harness(async () => {
      attempt += 1;
      if (attempt === 1) throw apiError('FETCH_ERROR');
      return { orderNumber: 'ORD-1' };
    });
    await h.session.handleDetected('TRK-1');
    const s = h.session.getStatus();
    assert.equal(s.kind === 'error' && s.retryable, true);
    assert.equal(await h.session.retry(), true);
    assert.equal(h.session.getStatus().kind, 'success');
    assert.deepEqual(h.calls, ['TRK-1', 'TRK-1']);
  });

  test('invalid barcode never reaches the backend', async () => {
    const h = harness(async () => ({ orderNumber: 'x' }));
    assert.equal(await h.session.handleDetected('not a code'), false);
    const s = h.session.getStatus();
    assert.equal(s.kind === 'error' && s.message, 'Invalid barcode');
    assert.deepEqual(h.calls, []);
  });

  test('manual entry submits immediately (no cooldown) and validates input', async () => {
    let attempt = 0;
    const h = harness(async () => {
      attempt += 1;
      if (attempt === 1) throw NOT_FOUND;
      return { orderNumber: 'ORD-9' };
    });
    assert.equal(await h.session.handleManual('   '), false);
    const empty = h.session.getStatus();
    assert.equal(empty.kind === 'error' && empty.message, 'Enter the barcode value.');

    assert.equal(await h.session.handleManual(' TRK-9 '), true);
    assert.equal(await h.session.handleManual('TRK-9'), true); // within cooldown: still allowed
    assert.deepEqual(h.calls, ['TRK-9', 'TRK-9']);
    assert.equal(h.session.getStatus().kind, 'success');
  });
});

describe('camera support and errors', () => {
  test('requires a secure context and getUserMedia', () => {
    const gum = { getUserMedia: () => undefined };
    assert.equal(isCameraSupported({ isSecureContext: true, mediaDevices: gum }), true);
    assert.equal(isCameraSupported({ isSecureContext: false, mediaDevices: gum }), false);
    assert.equal(isCameraSupported({ isSecureContext: true, mediaDevices: undefined }), false);
    assert.equal(isCameraSupported({ isSecureContext: true, mediaDevices: {} }), false);
  });

  test('maps getUserMedia failures, always pointing to manual entry', () => {
    const cases: Array<[string, string]> = [
      ['NotAllowedError', 'denied'],
      ['SecurityError', 'denied'],
      ['NotFoundError', 'no-camera'],
      ['OverconstrainedError', 'no-camera'],
      ['NotReadableError', 'busy'],
      ['UnsupportedError', 'unsupported'],
      ['SomethingElse', 'unknown'],
    ];
    for (const [name, problem] of cases) {
      const view = describeCameraError({ name });
      assert.equal(view.problem, problem, name);
      assert.match(view.message, /enter the barcode/i, name);
    }
    assert.equal(describeCameraError(null).problem, 'unknown');
  });
});

describe('wiring', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

  test('My Jobs has a standalone Scan Barcode button above the list, scanner mounted only when open', () => {
    const page = read('../src/pages/driver/MyJobsPage.tsx');
    assert.match(page, /Scan Barcode/);
    assert.match(page, /\{scannerOpen && <BarcodeScannerDialog onClose=/);
    assert.ok(page.indexOf('Scan Barcode') < page.indexOf('<DriverJobCard'), 'button renders before the job cards');
    const card = read('../src/components/driver/DriverJobCard.tsx');
    assert.doesNotMatch(card, /BarcodeScanner|Scan Barcode/, 'not inside an order card');
  });

  test('scanner prefers the rear camera, is iOS-inline, and stops the camera on close', () => {
    const dialog = read('../src/components/driver/BarcodeScannerDialog.tsx');
    assert.match(dialog, /facingMode: \{ ideal: 'environment' \}/);
    assert.match(dialog, /playsInline/);
    assert.match(dialog, /muted/);
    assert.match(dialog, /getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/);
    assert.match(dialog, /Enter barcode manually/);
    assert.match(dialog, /aria-label="Close scanner"/);
  });

  test('decoder asks for code_128 only and self-hosts the wasm fallback', () => {
    const decoder = read('../src/components/driver/barcodeDecoder.ts');
    assert.match(decoder, /formats: \['code_128'\]/);
    assert.match(decoder, /import\('barcode-detector\/ponyfill'\)/);
    assert.match(decoder, /zxing_reader\.wasm\?url/);
  });

  test('mutation hits scan-pickup and refreshes the driver job list', () => {
    const api = read('../src/services/ordersApi.ts');
    const block = api.slice(api.indexOf('scanPickupDriverOrder:'), api.indexOf('startDriverOrderDelivery:'));
    assert.match(block, /url: '\/driver\/orders\/scan-pickup', method: 'POST'/);
    assert.match(block, /type: 'DriverJob', id: 'LIST'/);
    assert.match(block, /type: 'DriverOrder', id: 'LIST'/);
  });

  test('the barcode the scanner decodes is the one the label prints (tracking code, CODE128)', () => {
    const label = read('../src/lib/orderLabelPrint.ts');
    assert.match(label, /JsBarcode\(svg, trackingCode, \{\s*format: 'CODE128'/);
    assert.match(label, /buildBarcodeSvg\(order\.trackingCode\)/);
  });
});
