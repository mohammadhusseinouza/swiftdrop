import type { OrderDetail } from '../services/domain.types';
import { formatMoney } from './format';
import { moneyIsPositive } from './money';
import {
  getOrderStatusPresentation,
  getPaymentTypePresentation,
} from '../components/orders/orderStatus';
import { escapeHtml, printHtmlDocument } from './printHtmlDocument';

/**
 * A5 Order Summary / Package Label — print-preview architecture.
 *
 * Renders a small, self-contained HTML document (its own `<html>`, inline
 * `<style>` with `@page { size: A5 portrait; margin: 0 }`, fully isolated
 * from the app's own Tailwind styles) into a hidden same-origin iframe, then
 * calls that iframe's own `print()`. This is NOT a screenshot of the Order
 * Detail page and NOT a downloaded file — clicking "Print A5" opens the
 * browser's native print preview directly, with the current app page left in
 * place underneath it. An iframe (not `window.open`) is used specifically
 * because it is not subject to popup-blocker heuristics, so this remains
 * reliable even when the label has to be fetched first (Orders table entry
 * point) and `print()` therefore fires slightly after the click event.
 *
 * Every monetary/business value is read as-is from the existing `OrderDetail`
 * contract (`order.financial`, `order.receiver`, `order.package`, payment
 * methods) — nothing here recalculates or re-derives a financial figure.
 * This is an operational package label, not an invoice: it deliberately
 * excludes wallet, driver-cash, settlement, and financial-transaction detail.
 */

/** Base name used for the print document's `<title>` (the browser's default "Save as PDF" filename). */
export function getOrderLabelDocumentName(orderNumber: string): string {
  const safe = orderNumber.trim().replace(/[^A-Za-z0-9._-]+/g, '-');
  return `SpringDelivery-${safe || 'order'}`;
}

/** Renders Code128 as an inline, viewBox-scaled SVG string — crisp at any print DPI, no image-load wait. */
async function buildBarcodeSvg(trackingCode: string): Promise<string> {
  const { default: JsBarcode } = await import('jsbarcode');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  JsBarcode(svg, trackingCode, {
    format: 'CODE128',
    width: 2,
    height: 130,
    margin: 0,
    displayValue: false,
    background: 'transparent',
    lineColor: '#000000',
  });
  const w = svg.getAttribute('width') ?? '300';
  const h = svg.getAttribute('height') ?? '130';
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('preserveAspectRatio', 'none');
  return svg.outerHTML;
}

function row(label: string, value: string): string {
  return `<div class="row"><span class="row-label">${escapeHtml(label)}</span><span class="row-value">${escapeHtml(value)}</span></div>`;
}

const LABEL_CSS = `
  @page { size: A5 portrait; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: 148mm; height: 210mm; }
  body {
    font-family: Helvetica, Arial, sans-serif;
    color: #111;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .label {
    width: 148mm;
    height: 210mm;
    padding: 7mm;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .header { display: flex; justify-content: space-between; align-items: baseline; }
  .brand { font-size: 14pt; font-weight: 800; letter-spacing: 0.5px; }
  .status { font-size: 9.5pt; font-weight: 700; text-transform: uppercase; color: #333; }
  .header-sub {
    display: flex; justify-content: space-between; align-items: baseline;
    margin-top: 1.2mm; padding-bottom: 2mm; border-bottom: 0.8pt solid #111;
  }
  .order-no { font-size: 14pt; font-weight: 800; }
  .tracking-inline { font-size: 8.5pt; font-family: 'Courier New', monospace; color: #444; }

  .section {
    border-top: 0.4pt solid #bbb;
    padding-top: 2.4mm;
    margin-top: 2.6mm;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .section-title {
    font-size: 8pt; font-weight: 700; letter-spacing: 0.5px;
    text-transform: uppercase; color: #555; margin-bottom: 1mm;
  }
  .line-row { display: flex; justify-content: space-between; align-items: baseline; gap: 2mm; }
  .line-row .name { font-size: 9.5pt; font-weight: 700; }
  .line-row.emphasize .name { font-size: 11.5pt; }
  .line-row .phone { font-size: 9.5pt; font-weight: 700; white-space: nowrap; }
  .alt-phone { font-size: 8.5pt; color: #444; margin-top: 0.8mm; }

  .address { font-size: 10pt; font-weight: 700; line-height: 1.4; }
  .instructions {
    font-size: 8.5pt; color: #333; margin-top: 1.2mm; font-style: italic;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }

  .row { display: flex; justify-content: space-between; font-size: 9pt; padding: 0.6mm 0; }
  .row-label { color: #555; }
  .row-value { font-weight: 700; }

  .collect-box {
    margin-top: 2mm; border: 1.2pt solid #111; border-radius: 1.5mm;
    text-align: center; padding: 2.2mm 0;
  }
  .collect-label { font-size: 8.5pt; font-weight: 800; letter-spacing: 1px; }
  .collect-amount { font-size: 19pt; font-weight: 800; margin-top: 0.6mm; }

  .package {
    font-size: 9pt; color: #333;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }

  .barcode-block { margin-top: 6mm; text-align: center; }
  .barcode-img { width: 100%; height: 18mm; margin: 0 auto; }
  .barcode-img svg { display: block; width: 100%; height: 100%; }
  .tracking-text {
    font-family: 'Courier New', monospace; font-size: 9.5pt; font-weight: 700;
    letter-spacing: 1.5px; margin-top: 1.2mm;
  }
`;

function buildDocument(order: OrderDetail, barcodeSvg: string): string {
  const f = order.financial;
  const statusLabel = getOrderStatusPresentation(order.status).label;
  const paymentTypeLabel = getPaymentTypePresentation(order.paymentType).label;

  // "Core delivery address" — never truncated, only wrapped.
  const addressLines = [
    order.receiver.area,
    order.receiver.address,
    order.receiver.buildingFloor,
  ]
    .filter((v): v is string => Boolean(v && v.trim()))
    .map(escapeHtml)
    .join('<br />');

  const paidRows =
    (moneyIsPositive(f.prepaidOrderAmount)
      ? row('Order paid', formatMoney(f.prepaidOrderAmount))
      : '') +
    (moneyIsPositive(f.prepaidDeliveryFee)
      ? row('Delivery paid', formatMoney(f.prepaidDeliveryFee))
      : '');

  // Counts come first so they're never lost to the clamp below if the
  // (lower-priority, free-text) description happens to be long.
  const packageBits = [
    `Packages: ${order.package.packageCount}`,
    order.package.quantity != null ? `Qty: ${order.package.quantity}` : '',
    order.package.description ? `Item: ${order.package.description}` : '',
  ]
    .filter(Boolean)
    .join('   ·   ');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(getOrderLabelDocumentName(order.orderNumber))}</title>
<style>${LABEL_CSS}</style>
</head>
<body>
<div class="label">
  <div class="header">
    <div class="brand">Spring Delivery</div>
    <div class="status">${escapeHtml(statusLabel)}</div>
  </div>
  <div class="header-sub">
    <div class="order-no">#${escapeHtml(order.orderNumber)}</div>
    <div class="tracking-inline">Tracking: ${escapeHtml(order.trackingCode)}</div>
  </div>

  <div class="section">
    <div class="section-title">From / Customer</div>
    <div class="line-row">
      <span class="name">${escapeHtml(order.customer.name)}</span>
      ${order.customer.primaryPhone ? `<span class="phone">${escapeHtml(order.customer.primaryPhone)}</span>` : ''}
    </div>
  </div>

  <div class="section">
    <div class="section-title">Receiver</div>
    <div class="line-row emphasize">
      <span class="name">${escapeHtml(order.receiver.name)}</span>
      <span class="phone">${escapeHtml(order.receiver.phone)}</span>
    </div>
    ${order.receiver.altPhone ? `<div class="alt-phone">Alt: ${escapeHtml(order.receiver.altPhone)}</div>` : ''}
  </div>

  <div class="section">
    <div class="section-title">Delivery Address</div>
    <div class="address">${addressLines}</div>
    ${order.receiver.instructions ? `<div class="instructions">${escapeHtml(order.receiver.instructions)}</div>` : ''}
  </div>

  <div class="section">
    <div class="section-title">Order / Payment</div>
    ${row('Order amount', formatMoney(f.orderAmount))}
    ${row('Delivery fee', formatMoney(f.deliveryFee))}
    ${paidRows}
    ${row('Payment', paymentTypeLabel)}
    ${order.collectionPaymentMethod ? row('Delivery payment method', order.collectionPaymentMethod.name) : ''}
    <div class="collect-box">
      <div class="collect-label">AMOUNT TO COLLECT</div>
      <div class="collect-amount">${formatMoney(f.amountToCollect)}</div>
    </div>
  </div>

  ${packageBits ? `<div class="section package">${escapeHtml(packageBits)}</div>` : ''}

  <div class="barcode-block">
    <div class="barcode-img">${barcodeSvg}</div>
    <div class="tracking-text">${escapeHtml(order.trackingCode)}</div>
  </div>
</div>
</body>
</html>`;
}

/**
 * Builds the A5 label for `order` and opens the browser's print preview for
 * it. Resolves once `window.print()` has been invoked (the dialog itself is
 * modal browser UI, not something this promise waits on).
 */
export async function printOrderLabel(order: OrderDetail): Promise<void> {
  const barcodeSvg = await buildBarcodeSvg(order.trackingCode);
  const html = buildDocument(order, barcodeSvg);

  printHtmlDocument(html);
}
