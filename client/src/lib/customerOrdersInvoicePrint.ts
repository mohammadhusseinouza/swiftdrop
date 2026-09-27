import type { OrderSummary } from '../services/domain.types';
import { formatDate, formatDateTime, formatMoney } from './format';
import { formatCents, parseMoneyToCents } from './money';
import { escapeHtml, printHtmlDocument } from './printHtmlDocument';

/**
 * A5 LANDSCAPE Customer Orders Invoice — a statement of every Order created
 * for one Customer within a date interval.
 *
 * Read-only: built from `OrderSummary` rows the caller already fetched with
 * `GET /orders` (every page), printed through the shared hidden-iframe
 * `printHtmlDocument`. It creates no payout, payment, wallet transaction or
 * any other record.
 *
 * Scope: CANCELLED orders are excluded (`getInvoiceableOrders`) — from the
 * rows, the order count and every total alike. All other statuses are kept.
 * Nothing about the underlying orders is changed.
 *
 * Money: each row shows the Order's persisted `orderAmount` and `deliveryFee`;
 * "Total" is Order Price + Delivery Fee (NOT the amount actually collected and
 * NOT a wallet figure). Every sum is exact integer-cent BigInt arithmetic —
 * never floating point. An unparseable amount aborts the print instead of
 * producing a wrong total.
 *
 * Pagination: the orders table may continue across A5 landscape pages. Its
 * header row repeats on every page, rows never split, and the totals block is
 * printed once, after the final row, and is kept together. Because
 * `@page { margin: 0 }`, top/bottom page margins come from a spacer
 * `<thead>`/`<tfoot>` on an outer layout table, which Chromium repeats on
 * every printed page.
 */

export interface CustomerOrdersInvoiceCustomer {
  name: string;
  customerNumber: string;
  primaryPhone: string | null;
}

export interface CustomerOrdersInvoiceInput {
  customer: CustomerOrdersInvoiceCustomer;
  /** Inclusive interval as selected, `YYYY-MM-DD`. */
  from: string;
  to: string;
  /** ALL fetched orders (every page), in print order. CANCELLED ones are dropped here. */
  orders: OrderSummary[];
}

export interface CustomerOrdersInvoiceTotals {
  orderCount: number;
  totalOrderPrices: string;
  totalDeliveryFees: string;
  grandTotal: string;
}

export interface CustomerOrdersInvoiceRow {
  order: OrderSummary;
  /** orderAmount + deliveryFee, exact decimal string. */
  total: string;
}

function toCents(value: string, what: string, orderNumber: string): bigint {
  const cents = parseMoneyToCents(value);
  if (cents === null) {
    throw new Error(
      `Order ${orderNumber} has an unreadable ${what} (${value}); the invoice was not printed.`,
    );
  }
  return cents;
}

/** Orders that belong on the invoice: every status except CANCELLED. */
export function getInvoiceableOrders(orders: OrderSummary[]): OrderSummary[] {
  return orders.filter((o) => o.status !== 'CANCELLED');
}

/** Exact per-row totals and grand totals (integer cents, no floating point). */
export function computeCustomerOrdersInvoice(orders: OrderSummary[]): {
  rows: CustomerOrdersInvoiceRow[];
  totals: CustomerOrdersInvoiceTotals;
} {
  let orderSum = 0n;
  let feeSum = 0n;
  const rows = orders.map((order) => {
    const amount = toCents(order.orderAmount, 'order price', order.orderNumber);
    const fee = toCents(order.deliveryFee, 'delivery fee', order.orderNumber);
    orderSum += amount;
    feeSum += fee;
    return { order, total: formatCents(amount + fee) };
  });
  return {
    rows,
    totals: {
      orderCount: orders.length,
      totalOrderPrices: formatCents(orderSum),
      totalDeliveryFees: formatCents(feeSum),
      grandTotal: formatCents(orderSum + feeSum),
    },
  };
}

/** Displays a `YYYY-MM-DD` calendar date without any timezone shift. */
function formatCalendarDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function getCustomerOrdersInvoiceDocumentName(
  customerNumber: string,
  from: string,
  to: string,
): string {
  const safe = customerNumber.trim().replace(/[^A-Za-z0-9._-]+/g, '-');
  return `SpringCargo-Orders-${safe || 'customer'}-${from}_${to}`;
}

// Same mark as the app's sidebar brand icon (lucide "truck").
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>`;

const INVOICE_CSS = `
  @page { size: A5 landscape; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body {
    width: 210mm;
    padding: 0 9mm;
    font-family: Helvetica, Arial, sans-serif;
    color: #111;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* Outer layout table: the spacer thead/tfoot repeat on every printed page,
     giving each page a top/bottom margin despite @page margin: 0. */
  table.layout { width: 100%; border-collapse: collapse; }
  table.layout > thead > tr > td, table.layout > tfoot > tr > td { padding: 0; }
  .page-space-top { height: 7mm; }
  .page-space-bottom { height: 7mm; }
  table.layout > tbody > tr > td { padding: 0; }

  .header {
    display: flex; justify-content: space-between; align-items: flex-start; gap: 6mm;
    padding-bottom: 2.5mm; border-bottom: 1pt solid #111;
  }
  .brand { display: flex; align-items: center; gap: 2mm; }
  .logo { width: 7mm; height: 7mm; }
  .logo svg { display: block; width: 100%; height: 100%; }
  .brand-name { font-size: 14pt; font-weight: 800; letter-spacing: 0.3px; }
  .doc-title { font-size: 11pt; font-weight: 800; letter-spacing: 0.8px; text-align: right; }
  .doc-generated { font-size: 7.5pt; color: #444; text-align: right; margin-top: 1mm; }

  .meta {
    display: flex; justify-content: space-between; gap: 6mm;
    margin: 2.5mm 0 3mm;
  }
  .meta-block { min-width: 0; }
  .meta-label { font-size: 7pt; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; color: #444; }
  .meta-value { font-size: 9.5pt; font-weight: 700; margin-top: 0.6mm; overflow-wrap: anywhere; }
  .meta-sub { font-size: 8.5pt; color: #222; margin-top: 0.4mm; }
  .meta-block.right { text-align: right; flex-shrink: 0; }

  table.orders { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
  table.orders thead { display: table-header-group; }
  table.orders th {
    text-align: left; font-size: 7.5pt; font-weight: 800; letter-spacing: 0.4px;
    text-transform: uppercase; padding: 1.6mm 2mm;
    border: 0.8pt solid #111; background: #ececec;
  }
  table.orders td {
    padding: 1.3mm 2mm; border: 0.5pt solid #777; vertical-align: top;
  }
  table.orders tr { break-inside: avoid; page-break-inside: avoid; }
  table.orders .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  table.orders .nowrap { white-space: nowrap; }
  table.orders .receiver { overflow-wrap: anywhere; }
  table.orders td.total { font-weight: 700; }
  table.orders tbody tr:nth-child(even) td { background: #f6f6f6; }
  .col-order { width: 21%; }
  .col-date { width: 12%; }
  .col-receiver { width: 31%; }
  .col-money { width: 12%; }

  .empty { padding: 6mm 2mm; text-align: center; font-size: 9pt; color: #444; border: 0.5pt solid #777; }

  .summary {
    margin-top: 3mm; margin-left: auto; width: 88mm;
    break-inside: avoid; page-break-inside: avoid;
    border: 1pt solid #111;
  }
  .summary-row {
    display: flex; justify-content: space-between; gap: 4mm;
    padding: 1.4mm 2.5mm; font-size: 9pt; border-bottom: 0.5pt solid #999;
  }
  .summary-row .label { color: #222; }
  .summary-row .value { font-weight: 700; font-variant-numeric: tabular-nums; }
  .summary-row.grand {
    border-bottom: 0; background: #111; color: #fff; font-size: 11pt; font-weight: 800;
    padding: 2mm 2.5mm;
  }
  .summary-row.grand .label { color: #fff; }
  .summary-note { font-size: 7pt; color: #444; margin-top: 1.5mm; text-align: right; }
`;

export function buildCustomerOrdersInvoiceHtml(
  input: CustomerOrdersInvoiceInput,
  generatedAt: Date = new Date(),
): string {
  const { customer, from, to } = input;
  const { rows, totals } = computeCustomerOrdersInvoice(
    getInvoiceableOrders(input.orders),
  );
  const interval = `${formatCalendarDate(from)} – ${formatCalendarDate(to)}`;

  const body =
    rows.length === 0
      ? `<tr><td colspan="6" class="empty">No orders (excluding cancelled) for this customer in the selected period.</td></tr>`
      : rows
          .map(
            ({ order, total }) => `<tr>
  <td class="nowrap">${escapeHtml(order.orderNumber)}</td>
  <td class="nowrap">${escapeHtml(formatDate(order.createdAt))}</td>
  <td class="receiver">${escapeHtml(order.receiverName)}</td>
  <td class="num">${escapeHtml(formatMoney(order.orderAmount))}</td>
  <td class="num">${escapeHtml(formatMoney(order.deliveryFee))}</td>
  <td class="num total">${escapeHtml(formatMoney(total))}</td>
</tr>`,
          )
          .join('\n');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(getCustomerOrdersInvoiceDocumentName(customer.customerNumber, from, to))}</title>
<style>${INVOICE_CSS}</style>
</head>
<body>
<table class="layout">
  <thead><tr><td><div class="page-space-top"></div></td></tr></thead>
  <tfoot><tr><td><div class="page-space-bottom"></div></td></tr></tfoot>
  <tbody><tr><td>
    <div class="header">
      <div class="brand">
        <div class="logo">${LOGO_SVG}</div>
        <div class="brand-name">Spring Cargo</div>
      </div>
      <div>
        <div class="doc-title">CUSTOMER ORDERS INVOICE</div>
        <div class="doc-generated">Generated ${escapeHtml(formatDateTime(generatedAt.toISOString()))}</div>
      </div>
    </div>

    <div class="meta">
      <div class="meta-block">
        <div class="meta-label">Customer</div>
        <div class="meta-value">${escapeHtml(customer.name)}</div>
        <div class="meta-sub">${escapeHtml(customer.customerNumber)}${customer.primaryPhone ? ` &nbsp;·&nbsp; ${escapeHtml(customer.primaryPhone)}` : ''}</div>
      </div>
      <div class="meta-block right">
        <div class="meta-label">Period</div>
        <div class="meta-value">${escapeHtml(interval)}</div>
        <div class="meta-sub">${totals.orderCount} ${totals.orderCount === 1 ? 'order' : 'orders'} (excl. cancelled) &nbsp;·&nbsp; USD</div>
      </div>
    </div>

    <table class="orders">
      <colgroup>
        <col class="col-order" /><col class="col-date" /><col class="col-receiver" />
        <col class="col-money" /><col class="col-money" /><col class="col-money" />
      </colgroup>
      <thead>
        <tr>
          <th>Order #</th>
          <th>Date</th>
          <th>Receiver</th>
          <th class="num">Order Price</th>
          <th class="num">Delivery Fee</th>
          <th class="num">Total</th>
        </tr>
      </thead>
      <tbody>
${body}
      </tbody>
    </table>

    <div class="summary">
      <div class="summary-row"><span class="label">Total Order Prices</span><span class="value">${escapeHtml(formatMoney(totals.totalOrderPrices))}</span></div>
      <div class="summary-row"><span class="label">Total Delivery Fees</span><span class="value">${escapeHtml(formatMoney(totals.totalDeliveryFees))}</span></div>
      <div class="summary-row grand"><span class="label">Grand Total (USD)</span><span class="value">${escapeHtml(formatMoney(totals.grandTotal))}</span></div>
    </div>
    <div class="summary-note">Totals represent order values and delivery fees, not payments collected or outstanding balances.</div>
  </td></tr></tbody>
</table>
</body>
</html>`;
}

/** Opens the A5 landscape print preview. Throws if it cannot be prepared. */
export function printCustomerOrdersInvoice(input: CustomerOrdersInvoiceInput): void {
  printHtmlDocument(buildCustomerOrdersInvoiceHtml(input));
}
