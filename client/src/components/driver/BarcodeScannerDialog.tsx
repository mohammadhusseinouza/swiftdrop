import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CheckCircle2, Keyboard, Loader2, ScanBarcode, X, XCircle } from 'lucide-react';

import { useScanPickupDriverOrderMutation } from '../../services/ordersApi';
import { Button } from '../ui/Button';
import { cn } from '../ui/cn';
import { createCode128Detector } from './barcodeDecoder';
import {
  createScanSession,
  describeCameraError,
  isCameraSupported,
  type CameraErrorView,
  type ScanSession,
  type ScanStatus,
} from './scanPickup';

type CameraState =
  | { kind: 'starting' }
  | { kind: 'scanning' }
  | { kind: 'error'; view: CameraErrorView };

/** How often a video frame is handed to the decoder. */
const DETECT_INTERVAL_MS = 200;

export interface BarcodeScannerDialogProps {
  onClose: () => void;
}

/**
 * Driver "Scan Barcode" pickup — a full-screen camera scanner opened from My
 * Jobs. Mount it only while open: every mount is a fresh scan session, and
 * unmounting always releases the camera.
 *
 * Continuous: after a confirmed pickup the camera keeps running for the next
 * package. All duplicate / overlap protection lives in `createScanSession`;
 * the backend remains the authority for ownership and the status rule.
 */
export function BarcodeScannerDialog({ onClose }: BarcodeScannerDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [scanPickup] = useScanPickupDriverOrderMutation();

  const [status, setStatus] = useState<ScanStatus>({ kind: 'ready' });
  const [pickedUpCount, setPickedUpCount] = useState(0);
  const [camera, setCamera] = useState<CameraState>({ kind: 'starting' });
  const [manualOpen, setManualOpen] = useState(false);
  const [manualValue, setManualValue] = useState('');

  const sessionRef = useRef<ScanSession | null>(null);
  sessionRef.current ??= createScanSession({
    submit: async (barcode) => {
      const order = await scanPickup({ barcode }).unwrap();
      return { orderNumber: order.orderNumber };
    },
    onChange: (next, count) => {
      setStatus(next);
      setPickedUpCount(count);
    },
    onSuccess: () => {
      try {
        navigator.vibrate?.(150);
      } catch {
        // Vibration is optional and unsupported on iOS.
      }
    },
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  // Camera + decode loop. Cleanup stops every track and the loop.
  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    const video = videoRef.current;

    const fail = (error: unknown) => {
      if (cancelled) return;
      setCamera({ kind: 'error', view: describeCameraError(error) });
      setManualOpen(true);
    };

    const start = async () => {
      if (
        !video ||
        !isCameraSupported({
          isSecureContext: window.isSecureContext,
          mediaDevices: navigator.mediaDevices,
        })
      ) {
        fail({ name: 'UnsupportedError' });
        return;
      }
      try {
        const acquired = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        if (cancelled) {
          // Closed (or StrictMode re-mounted) while permission was pending.
          acquired.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = acquired;
        video.srcObject = stream;
        await video.play();
        const detector = await createCode128Detector();
        if (cancelled) return;
        setCamera({ kind: 'scanning' });

        const tick = async () => {
          if (cancelled) return;
          if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            try {
              const codes = await detector.detect(video);
              const value = codes.find((c) => c.rawValue)?.rawValue;
              if (value && !cancelled) void sessionRef.current?.handleDetected(value);
            } catch {
              // A single undecodable frame is normal — keep scanning.
            }
          }
          if (!cancelled) timer = window.setTimeout(() => void tick(), DETECT_INTERVAL_MS);
        };
        void tick();
      } catch (error) {
        fail(error);
      }
    };

    void start();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      if (video) video.srcObject = null;
    };
  }, []);

  const submitManual = (e: FormEvent) => {
    e.preventDefault();
    void sessionRef.current?.handleManual(manualValue).then((processed) => {
      if (processed) setManualValue('');
    });
  };

  const processing = status.kind === 'processing';

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="scan-barcode-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="m-0 h-dvh max-h-none w-screen max-w-none bg-ink p-0 text-ink-inverse backdrop:bg-ink"
    >
      <div className="flex h-full flex-col">
        {/* header */}
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <h2 id="scan-barcode-title" className="text-base font-semibold">
              Scan Barcode
            </h2>
            <p className="text-xs text-chrome-ink">
              {pickedUpCount === 0
                ? 'Scan package labels to mark them picked up.'
                : `${pickedUpCount} picked up this session`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close scanner"
            className="rounded-control p-2 text-ink-inverse hover:bg-white/10"
          >
            <X className="size-6" aria-hidden="true" />
          </button>
        </div>

        {/* camera */}
        <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
          <video
            ref={videoRef}
            className={cn(
              'h-full w-full object-cover',
              camera.kind !== 'scanning' && 'opacity-0',
            )}
            playsInline
            muted
            autoPlay
            aria-hidden="true"
          />
          {camera.kind === 'scanning' && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div
                className={cn(
                  'h-[28%] w-[85%] max-w-md rounded-card border-2 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)] transition-colors',
                  status.kind === 'success'
                    ? 'border-success-200'
                    : status.kind === 'error'
                      ? 'border-danger-200'
                      : 'border-white',
                )}
              />
              <p className="absolute bottom-4 px-6 text-center text-sm text-white/90">
                Line the barcode up inside the frame
              </p>
            </div>
          )}
          {camera.kind === 'starting' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-white/90">
              <Loader2 className="size-6 animate-spin" aria-hidden="true" />
              Starting camera…
            </div>
          )}
          {camera.kind === 'error' && (
            <div
              role="alert"
              className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-sm text-white/90"
            >
              <ScanBarcode className="size-8 text-white/60" aria-hidden="true" />
              <p className="max-w-sm">{camera.view.message}</p>
            </div>
          )}
        </div>

        {/* status + manual entry */}
        <div className="space-y-3 bg-card p-4 text-ink">
          <ScanStatusPanel
            status={status}
            onRetry={() => void sessionRef.current?.retry()}
          />

          {manualOpen ? (
            <form onSubmit={submitManual} className="flex gap-2">
              <label htmlFor="scan-manual-barcode" className="sr-only">
                Barcode value
              </label>
              <input
                id="scan-manual-barcode"
                value={manualValue}
                onChange={(e) => setManualValue(e.target.value)}
                placeholder="e.g. TRK-ABC123DEF456"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                inputMode="text"
                className="h-11 min-w-0 flex-1 rounded-control border border-line bg-card px-3 font-mono text-sm text-ink"
              />
              <Button type="submit" loading={processing} className="h-11">
                Pick up
              </Button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setManualOpen(true)}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-700"
            >
              <Keyboard className="size-4" aria-hidden="true" />
              Enter barcode manually
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}

function ScanStatusPanel({
  status,
  onRetry,
}: {
  status: ScanStatus;
  onRetry: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex min-h-12 items-center gap-2.5 rounded-control border px-3 py-2 text-sm',
        status.kind === 'success' && 'border-success-200 bg-success-50 text-success-700',
        status.kind === 'error' && 'border-danger-200 bg-danger-50 text-danger-700',
        (status.kind === 'ready' || status.kind === 'processing') &&
          'border-line bg-sunken text-ink-secondary',
      )}
    >
      {status.kind === 'ready' && <span>Ready — point the camera at a package label.</span>}
      {status.kind === 'processing' && (
        <>
          <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
          <span className="min-w-0">
            Picking up <span className="font-mono">{status.barcode}</span>…
          </span>
        </>
      )}
      {status.kind === 'success' && (
        <>
          <CheckCircle2 className="size-5 shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            <span className="font-semibold">{status.orderNumber}</span> picked up. Ready for
            the next package.
          </span>
        </>
      )}
      {status.kind === 'error' && (
        <>
          <XCircle className="size-5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            {status.message}
            {status.barcode && (
              <span className="block font-mono text-xs opacity-80">{status.barcode}</span>
            )}
          </span>
          {status.retryable && (
            <Button size="sm" variant="secondary" onClick={onRetry}>
              Retry
            </Button>
          )}
        </>
      )}
    </div>
  );
}
