// Customer Portal Redesign Step 3 — My Orders tab counts, shared pager state
// and CustomerOrderCard guardrails. Pure logic + source checks, Node's
// built-in runner. Run:
//   npx --prefix ../server tsx --test tests/customerOrdersPage.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getCustomerOrderTabCounts } from '../src/components/customer/customerOrderPresentation';
import { getPaginationState } from '../src/components/data-display/Pagination';

const SUMMARY = { activeOrders: 8, deliveredOrders: 3 };

describe('My Orders tab counts', () => {
  test('All = meta.total only while the All result is loaded', () => {
    assert.deepEqual(getCustomerOrderTabCounts({ view: 'all', currentTotal: 11, summary: SUMMARY }), {
      all: 11,
      active: 8,
      delivered: 3,
    });
    // All tab still fetching its own result → no chip (never a stale total).
    assert.equal(getCustomerOrderTabCounts({ view: 'all', currentTotal: undefined, summary: SUMMARY }).all, null);
    // On another tab the list total belongs to that tab → never shown as All.
    assert.equal(getCustomerOrderTabCounts({ view: 'active', currentTotal: 8, summary: SUMMARY }).all, null);
    assert.equal(getCustomerOrderTabCounts({ view: 'delivered', currentTotal: 3, summary: SUMMARY }).all, null);
  });

  test('Active / Delivered come from the server summary only', () => {
    // A list total that disagrees with the summary is ignored for these chips.
    const c = getCustomerOrderTabCounts({ view: 'active', currentTotal: 99, summary: SUMMARY });
    assert.equal(c.active, 8);
    assert.equal(c.delivered, 3);
  });

  test('no summary (loading / error) → no Active / Delivered chips', () => {
    const c = getCustomerOrderTabCounts({ view: 'all', currentTotal: 11, summary: undefined });
    assert.equal(c.active, null);
    assert.equal(c.delivered, null);
    assert.equal(c.all, 11);
  });

  test('zero counts are shown as 0, not hidden', () => {
    const c = getCustomerOrderTabCounts({
      view: 'all',
      currentTotal: 0,
      summary: { activeOrders: 0, deliveredOrders: 0 },
    });
    assert.deepEqual(c, { all: 0, active: 0, delivered: 0 });
  });
});

describe('shared pagination state', () => {
  test('prev / next bounds', () => {
    assert.deepEqual(getPaginationState(1, 3), { totalPages: 3, canPrev: false, canNext: true });
    assert.deepEqual(getPaginationState(2, 3), { totalPages: 3, canPrev: true, canNext: true });
    assert.deepEqual(getPaginationState(3, 3), { totalPages: 3, canPrev: true, canNext: false });
    assert.deepEqual(getPaginationState(1, 0), { totalPages: 1, canPrev: false, canNext: false });
  });
});

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('CustomerOrderCard', () => {
  const card = read('../src/components/customer/CustomerOrderCard.tsx');
  const code = strip(card);

  test('uses the canonical customer status components, no second mapping', () => {
    assert.ok(code.includes('<StatusPill status={order.status} />'));
    assert.ok(code.includes('<StageProgress status={order.status} variant="labelled" />'));
    assert.ok(!/getOrderStatusPresentation|'FAILED_DELIVERY'|'RESCHEDULED'|'CANCELLED'/.test(code));
  });

  test('never guesses a reached stage for exception statuses', () => {
    assert.ok(!code.includes('reachedStage'));
  });

  test('shows the three server amounts via formatMoney, no arithmetic', () => {
    for (const f of ['orderAmount', 'deliveryFee', 'amountToCollect']) {
      assert.ok(code.includes(`formatMoney(order.${f})`), f);
    }
    assert.ok(!/parseFloat|Number\(|toFixed|parseMoneyToCents/.test(code));
  });

  test('view link has an accessible name; no driver identity', () => {
    assert.ok(code.includes('aria-label={`View order ${order.orderNumber}`}'));
    assert.ok(!/driver/i.test(code));
  });
});

describe('My Orders page', () => {
  const page = strip(read('../src/pages/customer/CustomerOrdersPage.tsx'));

  test('counts come from the helper, never from the current page', () => {
    assert.ok(page.includes('getCustomerOrderTabCounts'));
    assert.ok(page.includes('query.currentData?.meta.total'));
    assert.ok(!/orders\.length\s*[,}]|\.filter\(/.test(page.replace('orders.length === 0', '')));
  });

  test('view / page stay in the URL as before', () => {
    assert.ok(page.includes("if (id === 'all') next.delete('view');"));
    assert.ok(page.includes("next.delete('page');"));
    assert.ok(page.includes("nextSp.set('page', String(next));"));
  });
});
