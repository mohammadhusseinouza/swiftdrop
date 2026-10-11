import {
  getApiErrorDetails,
  getApiErrorMessage,
  getApiErrorStatus,
  type UnknownApiError,
} from '../../services/apiError';

/**
 * Driver "Scan Barcode" pickup — pure session logic (no React, no camera), so
 * duplicate-scan prevention, continuous scanning and error mapping are unit
 * testable under Node.
 *
 * The printed order label's Code128 barcode encodes the order's tracking code
 * verbatim (lib/orderLabelPrint.ts). The client only shape-checks the value;
 * the backend (`POST /driver/orders/scan-pickup`) resolves it within the
 * driver's own current orders and runs the existing pickup transition. A
 * success is shown ONLY after the backend confirms it.
 */

/** Same shape the server accepts: 1–100 printable, non-space ASCII chars. */
const BARCODE_PATTERN = /^[!-~]{1,100}$/;

export function normalizeScannedValue(raw: string): string | null {
  const value = raw.trim();
  return BARCODE_PATTERN.test(value) ? value : null;
}

export type ScanStatus =
  | { kind: 'ready' }
  | { kind: 'processing'; barcode: string }
  | { kind: 'success'; barcode: string; orderNumber: string }
  | { kind: 'error'; barcode: string | null; message: string; retryable: boolean };

export interface ScanPickupErrorView {
  message: string;
  retryable: boolean;
}

/** Maps a failed scan-pickup request to driver-facing feedback. */
export function describeScanPickupError(error: UnknownApiError): ScanPickupErrorView {
  const status = getApiErrorStatus(error);
  if (status === 404) return { message: 'Order not found', retryable: false };
  if (status === 400) return { message: 'Invalid barcode', retryable: false };
  if (status === 409) {
    const details = getApiErrorDetails(error) as { reason?: unknown } | undefined;
    return {
      message: getApiErrorMessage(error),
      // Only a lost race is worth retrying; already-picked-up / cancelled /
      // invalid-status answers will not change on retry.
      retryable: details?.reason === 'ORDER_CHANGED',
    };
  }
  if (status === 401) {
    return { message: 'Your session has expired. Please sign in again.', retryable: false };
  }
  if (status === 403) {
    return { message: 'You are not allowed to pick up orders.', retryable: false };
  }
  return {
    message: 'Network or server error. Check your connection and try again.',
    retryable: true,
  };
}

export interface ScanSessionOptions {
  /** Performs the backend pickup; resolves only on a confirmed transition. */
  submit: (barcode: string) => Promise<{ orderNumber: string }>;
  onChange: (status: ScanStatus, pickedUpCount: number) => void;
  /** Fired once per confirmed pickup (e.g. vibration). */
  onSuccess?: () => void;
  now?: () => number;
  /** Camera re-detections of the SAME failed code are ignored for this long. */
  repeatCooldownMs?: number;
}

export interface ScanSession {
  /** A camera detection. Ignored while busy, for codes already picked up in
   * this session, and for a just-failed code within the cooldown. */
  handleDetected(raw: string): Promise<boolean>;
  /** Manual entry — explicit intent, so no cooldown (still never overlaps). */
  handleManual(raw: string): Promise<boolean>;
  /** Re-submits the last failed code when that failure is retryable. */
  retry(): Promise<boolean>;
  getStatus(): ScanStatus;
  getPickedUpCount(): number;
}

export function createScanSession(options: ScanSessionOptions): ScanSession {
  const now = options.now ?? (() => Date.now());
  const cooldown = options.repeatCooldownMs ?? 3000;

  let status: ScanStatus = { kind: 'ready' };
  let busy = false;
  let pickedUpCount = 0;
  const pickedUp = new Set<string>();
  let lastFailure: { barcode: string; at: number } | null = null;

  const set = (next: ScanStatus) => {
    status = next;
    options.onChange(status, pickedUpCount);
  };

  async function process(barcode: string): Promise<boolean> {
    // The single in-flight guard: at most one request per session at a time,
    // whatever the camera keeps reporting.
    if (busy) return false;
    busy = true;
    set({ kind: 'processing', barcode });
    try {
      const result = await options.submit(barcode);
      pickedUp.add(barcode);
      pickedUpCount += 1;
      lastFailure = null;
      set({ kind: 'success', barcode, orderNumber: result.orderNumber });
      options.onSuccess?.();
    } catch (error) {
      lastFailure = { barcode, at: now() };
      const view = describeScanPickupError(error as UnknownApiError);
      set({ kind: 'error', barcode, ...view });
    } finally {
      busy = false;
    }
    return true;
  }

  return {
    async handleDetected(raw) {
      if (busy) return false;
      const barcode = normalizeScannedValue(raw);
      if (!barcode) {
        set({ kind: 'error', barcode: null, message: 'Invalid barcode', retryable: false });
        return false;
      }
      if (pickedUp.has(barcode)) return false;
      if (lastFailure && lastFailure.barcode === barcode && now() - lastFailure.at < cooldown) {
        return false;
      }
      return process(barcode);
    },

    async handleManual(raw) {
      if (busy) return false;
      if (raw.trim() === '') {
        set({ kind: 'error', barcode: null, message: 'Enter the barcode value.', retryable: false });
        return false;
      }
      const barcode = normalizeScannedValue(raw);
      if (!barcode) {
        set({ kind: 'error', barcode: null, message: 'Invalid barcode', retryable: false });
        return false;
      }
      return process(barcode);
    },

    async retry() {
      if (status.kind !== 'error' || !status.retryable || !status.barcode) return false;
      return process(status.barcode);
    },

    getStatus: () => status,
    getPickedUpCount: () => pickedUpCount,
  };
}

export type CameraProblem = 'denied' | 'no-camera' | 'busy' | 'unsupported' | 'unknown';

export interface CameraErrorView {
  problem: CameraProblem;
  message: string;
}

/** Camera access needs a secure context (HTTPS) and `getUserMedia`. */
export function isCameraSupported(env: {
  isSecureContext?: boolean;
  mediaDevices?: { getUserMedia?: unknown } | undefined;
}): boolean {
  return env.isSecureContext === true && typeof env.mediaDevices?.getUserMedia === 'function';
}

/** Maps a `getUserMedia` / decoder start-up failure to driver guidance. */
export function describeCameraError(error: unknown): CameraErrorView {
  const name = (error as { name?: unknown } | null)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return {
        problem: 'denied',
        message:
          'Camera access was denied. Allow camera access for this site in your browser settings, or enter the barcode below.',
      };
    case 'NotFoundError':
    case 'OverconstrainedError':
    case 'DevicesNotFoundError':
      return {
        problem: 'no-camera',
        message: 'No camera was found on this device. Enter the barcode below.',
      };
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return {
        problem: 'busy',
        message:
          'The camera is in use by another app or could not start. Close other camera apps and try again, or enter the barcode below.',
      };
    case 'UnsupportedError':
      return {
        problem: 'unsupported',
        message:
          'Camera scanning is not supported in this browser. Enter the barcode below.',
      };
    default:
      return {
        problem: 'unknown',
        message: 'The camera could not be started. Enter the barcode below.',
      };
  }
}
