/**
 * Shared hidden-iframe print mechanism for the A5 print documents (order
 * label, customer payout receipt).
 *
 * The caller supplies a complete, self-contained HTML document (its own
 * `<html>` and inline `<style>`), so it is fully isolated from the app's
 * Tailwind styles. It is written into a hidden same-origin iframe and that
 * iframe's own `print()` is called — the browser's native print preview opens
 * over the current page, which stays in place. An iframe (not `window.open`)
 * is used because it is not subject to popup-blocker heuristics, so printing
 * stays reliable even when `print()` fires after an awaited request rather
 * than directly inside the click handler.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Opens the browser's print preview for `html`. Returns once `print()` has
 * been invoked (the dialog itself is modal browser UI, not something this
 * waits on). Throws if the print frame could not be prepared.
 */
export function printHtmlDocument(html: string): void {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.style.visibility = 'hidden';
  document.body.appendChild(iframe);

  const cleanup = () => {
    iframe.parentNode?.removeChild(iframe);
  };

  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) {
    cleanup();
    throw new Error('Could not prepare the print preview.');
  }

  doc.open();
  doc.write(html);
  doc.close();

  // `afterprint` fires once the browser's print dialog closes (print or
  // cancel) — that is when it is safe to discard the iframe. Some older
  // WebKit builds do not reliably fire it for iframe-hosted documents, so a
  // bounded fallback timer guarantees cleanup regardless.
  win.addEventListener('afterprint', cleanup, { once: true });
  setTimeout(cleanup, 60_000);

  try {
    win.focus();
    win.print();
  } catch (e) {
    cleanup();
    throw e;
  }
}
