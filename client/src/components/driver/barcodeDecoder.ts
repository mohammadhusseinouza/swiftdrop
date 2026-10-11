/**
 * Code128 decoder for the Driver "Scan Barcode" pickup.
 *
 * 1. Native `BarcodeDetector` when the browser supports `code_128` (Chrome /
 *    Edge on Android) — zero extra download.
 * 2. Otherwise (iOS Safari, Firefox, desktop Safari) the `barcode-detector`
 *    ponyfill — the same API, backed by ZXing-C++ compiled to WebAssembly.
 *    It is dynamically imported, so it never enters the main bundle, and its
 *    .wasm is served from our own origin (Vite asset) instead of the library's
 *    default jsDelivr CDN, so production does not depend on a third party.
 *
 * Only `code_128` is requested — the format lib/orderLabelPrint.ts prints.
 */

export interface DetectedCode {
  rawValue: string;
}

export interface Code128Detector {
  detect(source: HTMLVideoElement): Promise<DetectedCode[]>;
}

interface NativeBarcodeDetectorCtor {
  new (options: { formats: string[] }): Code128Detector;
  getSupportedFormats?: () => Promise<string[]>;
}

async function nativeDetector(): Promise<Code128Detector | null> {
  const Native = (globalThis as { BarcodeDetector?: NativeBarcodeDetectorCtor }).BarcodeDetector;
  if (!Native) return null;
  try {
    const formats = (await Native.getSupportedFormats?.()) ?? [];
    return formats.includes('code_128') ? new Native({ formats: ['code_128'] }) : null;
  } catch {
    return null;
  }
}

let fallbackPromise: Promise<Code128Detector> | null = null;

function fallbackDetector(): Promise<Code128Detector> {
  fallbackPromise ??= (async () => {
    const [{ BarcodeDetector, prepareZXingModule }, { default: wasmUrl }] = await Promise.all([
      import('barcode-detector/ponyfill'),
      import('zxing-wasm/reader/zxing_reader.wasm?url'),
    ]);
    // Instantiate now so a failed .wasm load surfaces at scanner start-up
    // (and falls back to manual entry) rather than on every frame.
    await prepareZXingModule({
      overrides: {
        locateFile: (path: string, prefix: string) =>
          path.endsWith('.wasm') ? wasmUrl : prefix + path,
      },
      fireImmediately: true,
    });
    return new BarcodeDetector({ formats: ['code_128'] });
  })();
  // A failed load (offline, blocked asset) must not be cached forever.
  fallbackPromise.catch(() => {
    fallbackPromise = null;
  });
  return fallbackPromise;
}

export async function createCode128Detector(): Promise<Code128Detector> {
  return (await nativeDetector()) ?? fallbackDetector();
}
