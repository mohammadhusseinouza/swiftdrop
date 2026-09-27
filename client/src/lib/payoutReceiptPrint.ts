import type { PayoutSummary } from '../services/domain.types';
import { formatDateTime, formatMoney, humanizeToken } from './format';
import { escapeHtml, printHtmlDocument } from './printHtmlDocument';

/**
 * A5 Customer Payout Receipt — the printed record of money Spring Cargo paid
 * to a Customer from their wallet.
 *
 * Built ONLY from a persisted `PayoutSummary` returned by the backend (the
 * `POST /payouts` success response, or a `GET /payouts` row when reprinting)
 * — never from form values. Every figure is the backend's own decimal string,
 * formatted for display with `formatMoney`; nothing is recalculated. Balance
 * before/after come from the payout's persisted wallet ledger row; if the API
 * could not supply them they print as "Not available" rather than being
 * derived.
 *
 * Printing is read-only: it performs no request and cannot create, repeat or
 * reverse a payout. Uses the same hidden-iframe mechanism as the A5 order
 * label (`printHtmlDocument`).
 */

export interface PayoutReceiptOptions {
  /** Marks the document as a copy printed after the original payout. */
  reprint?: boolean;
}

/** Base name for the print document's `<title>` (the browser's default "Save as PDF" filename). */
export function getPayoutReceiptDocumentName(payoutNumber: string): string {
  const safe = payoutNumber.trim().replace(/[^A-Za-z0-9._-]+/g, '-');
  return `SpringCargo-Payout-${safe || 'receipt'}`;
}

// Same mark as the app's sidebar brand icon (lucide "truck"), inlined so the
// isolated print document needs no image load.
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>`;

const NOT_AVAILABLE = 'Not available';

function row(label: string, value: string, className = ''): string {
  return `<div class="row ${className}"><span class="row-label">${escapeHtml(label)}</span><span class="row-value">${escapeHtml(value)}</span></div>`;
}

const RECEIPT_CSS = `
  @page { size: A5 portrait; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: 148mm; height: 210mm; }
  body {
    font-family: Helvetica, Arial, sans-serif;
    color: #111;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .page {
    width: 148mm;
    height: 210mm;
    padding: 8mm 10mm 7mm;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .header {
    display: flex; justify-content: space-between; align-items: flex-start; gap: 4mm;
    padding-bottom: 3mm; border-bottom: 1pt solid #111;
  }
  .brand { display: flex; align-items: center; gap: 2mm; }
  .logo { width: 8mm; height: 8mm; }
  .logo svg { display: block; width: 100%; height: 100%; }
  .brand-name { font-size: 15pt; font-weight: 800; letter-spacing: 0.3px; }
  .doc-meta { text-align: right; }
  .doc-title { font-size: 10pt; font-weight: 800; letter-spacing: 0.8px; }
  .doc-no { font-size: 9.5pt; font-family: 'Courier New', monospace; font-weight: 700; margin-top: 1mm; }
  .copy-tag {
    display: inline-block; margin-top: 1.2mm; padding: 0.4mm 1.6mm;
    border: 0.8pt solid #111; font-size: 7pt; font-weight: 800; letter-spacing: 0.8px;
  }

  .section {
    margin-top: 3mm;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .section-title {
    font-size: 7.5pt; font-weight: 700; letter-spacing: 0.6px;
    text-transform: uppercase; color: #444;
    padding-bottom: 1mm; margin-bottom: 1.2mm; border-bottom: 0.4pt solid #bbb;
  }
  .customer-name {
    font-size: 12pt; font-weight: 800; line-height: 1.25;
    overflow-wrap: anywhere;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
  }

  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 4mm; font-size: 9.5pt; padding: 0.55mm 0; }
  .row-label { color: #444; flex-shrink: 0; }
  .row-value { font-weight: 700; text-align: right; overflow-wrap: anywhere; min-width: 0; }
  .row.total { border-top: 0.8pt solid #111; margin-top: 0.8mm; padding-top: 1.4mm; font-size: 10.5pt; }

  .amount-box {
    margin-top: 3mm; border: 1.4pt solid #111; border-radius: 1.5mm;
    text-align: center; padding: 2.4mm 2mm;
  }
  .amount-label { font-size: 8.5pt; font-weight: 800; letter-spacing: 1px; }
  .amount-value { font-size: 20pt; font-weight: 800; margin-top: 0.8mm; overflow-wrap: anywhere; }

  .notes {
    font-size: 9pt; line-height: 1.35; color: #222; white-space: pre-wrap;
    overflow-wrap: anywhere;
    display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
  }

  .signatures {
    margin-top: auto; padding-top: 4mm;
    display: flex; gap: 8mm;
    break-inside: avoid; page-break-inside: avoid;
  }
  .sig { flex: 1; }
  .sig-space { height: 18mm; border-bottom: 0.8pt solid #111; }
  .sig-label { font-size: 8.5pt; font-weight: 700; margin-top: 1.2mm; }
  .sig-sub { font-size: 7.5pt; color: #444; margin-top: 0.6mm; }

  .footer {
    margin-top: 3mm; padding-top: 1.5mm; border-top: 0.4pt solid #bbb;
    display: flex; justify-content: space-between; gap: 4mm;
    font-size: 7pt; color: #444;
  }
`;

export function buildPayoutReceiptHtml(
  p: PayoutSummary,
  options: PayoutReceiptOptions = {},
): string {
  const processedBy =
    `${p.processedBy.firstName} ${p.processedBy.lastName}`.trim() || '—';
  const amount = formatMoney(p.amount);
  const notes = p.notes?.trim() ?? '';
  const isCompleted = p.status === 'COMPLETED';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(getPayoutReceiptDocumentName(p.payoutNumber))}</title>
<style>${RECEIPT_CSS}</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="brand">
      <div class="logo">${LOGO_SVG}</div>
      <div class="brand-name">Spring Cargo</div>
    </div>
    <div class="doc-meta">
      <div class="doc-title">CUSTOMER PAYOUT RECEIPT</div>
      <div class="doc-no">No. ${escapeHtml(p.payoutNumber)}</div>
      ${options.reprint ? '<div class="copy-tag">COPY</div>' : ''}
    </div>
  </div>

  <div class="section">
    <div class="section-title">Customer</div>
    <div class="customer-name">${escapeHtml(p.customer.name)}</div>
    ${row('Customer number', p.customer.customerNumber)}
    ${row('Phone', p.customer.primaryPhone || '—')}
  </div>

  <div class="amount-box">
    <div class="amount-label">AMOUNT PAID TO CUSTOMER</div>
    <div class="amount-value">${escapeHtml(amount)}</div>
  </div>

  <div class="section">
    <div class="section-title">Payout details</div>
    ${row('Date & time', formatDateTime(p.createdAt))}
    ${row('Payment method', p.paymentMethod.name)}
    ${row('Currency', 'USD')}
    ${row('Processed by', processedBy)}
    ${isCompleted ? '' : row('Status', humanizeToken(p.status))}
  </div>

  <div class="section">
    <div class="section-title">Wallet summary</div>
    ${row('Balance before payout', formatMoney(p.balanceBefore, { fallback: NOT_AVAILABLE }))}
    ${row('Payout amount', `− ${amount}`)}
    ${row('Remaining balance after payout', formatMoney(p.balanceAfter, { fallback: NOT_AVAILABLE }), 'total')}
  </div>

  ${
    notes
      ? `<div class="section">
    <div class="section-title">Notes</div>
    <div class="notes">${escapeHtml(notes)}</div>
  </div>`
      : ''
  }

  <div class="signatures">
    <div class="sig">
      <div class="sig-space"></div>
      <div class="sig-label">Customer Signature</div>
      <div class="sig-sub">Name / Date</div>
    </div>
    <div class="sig">
      <div class="sig-space"></div>
      <div class="sig-label">Authorized Employee Signature</div>
      <div class="sig-sub">Name / Date</div>
    </div>
  </div>

  <div class="footer">
    <span>The customer confirms receipt of the amount above.</span>
    <span>Printed ${escapeHtml(formatDateTime(new Date().toISOString()))}</span>
  </div>
</div>
</body>
</html>`;
}

/**
 * Opens the browser's A5 print preview for a persisted payout. Throws if the
 * print frame could not be prepared — callers show a non-blocking error and
 * offer a retry; the payout itself is unaffected either way.
 */
export function printPayoutReceipt(
  payout: PayoutSummary,
  options: PayoutReceiptOptions = {},
): void {
  printHtmlDocument(buildPayoutReceiptHtml(payout, options));
}
