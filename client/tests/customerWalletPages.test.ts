// Customer Portal Redesign Step 5 — Wallet / Transactions / Payouts:
// layout-only pending bar, description fallback + balance-after line, filter
// URL behaviour, payout status wording, latest-payout chip and guardrails.
// Pure logic + source checks, Node's built-in runner. Run:
//   npx --prefix ../server tsx --test tests/customerWalletPages.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  getPendingBarWeights,
  getTransactionDescription,
} from '../src/components/customer/customerWalletPresentation';
import { getPayoutStatusLabel } from '../src/components/customer/customerPayoutPresentation';
import { getLatestPayoutChipText } from '../src/components/customer/customerOverviewPresentation';
import { pendingBreakdown } from '../src/components/finance/financialRelease';
import type { CustomerPayoutSummary } from '../src/services/domain.types';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('pending bar weights (layout only)', () => {
  const b = (d: string | null, s: string | null) => ({
    hasBreakdown: d !== null && s !== null,
    pendingDelivery: d,
    pendingSettlement: s,
  });

  test('proportional weights for two readable amounts', () => {
    assert.deepEqual(getPendingBarWeights(b('650.00', '0.00')), { delivery: 650, settlement: 0 });
    assert.deepEqual(getPendingBarWeights(b('70', '50.50')), { delivery: 70, settlement: 50.5 });
  });

  test('hidden when both zero, unreadable, negative or missing', () => {
    assert.equal(getPendingBarWeights(b('0.00', '0')), null);
    assert.equal(getPendingBarWeights(b('abc', '10.00')), null);
    assert.equal(getPendingBarWeights(b('', '10.00')), null);
    assert.equal(getPendingBarWeights(b('-5.00', '10.00')), null);
    assert.equal(getPendingBarWeights(b('10.00', '-1')), null);
    assert.equal(getPendingBarWeights(b(null, '10.00')), null);
    assert.equal(getPendingBarWeights({ hasBreakdown: false, pendingDelivery: '1', pendingSettlement: '1' }), null);
  });

  test('works on the real pendingBreakdown() output; total is never recomputed', () => {
    const bd = pendingBreakdown({
      pendingAmount: '650.00',
      pendingDeliveryAmount: '650.00',
      pendingSettlementAmount: '0.00',
      underReviewOrderCount: 1,
    });
    assert.equal(bd.totalPending, '650.00');
    assert.deepEqual(getPendingBarWeights(bd), { delivery: 650, settlement: 0 });
  });

  test('Number() on money appears only inside the bar helper', () => {
    const wallet = strip(read('../src/pages/customer/CustomerWalletLayout.tsx'));
    assert.ok(!/Number\(|parseFloat|toFixed/.test(wallet));
    assert.ok(wallet.includes('getPendingBarWeights(breakdown)'));
    assert.ok(wallet.includes('<div className="flex h-2.5 gap-1" aria-hidden="true">'));
    assert.ok(wallet.includes('formatMoney(breakdown.totalPending'));
  });
});

describe('transactions table', () => {
  test('description = reference label, fallback type label', () => {
    assert.equal(getTransactionDescription({ type: 'ORDER_CREDIT', reference: { label: 'PH141-VIS-01' } }), 'PH141-VIS-01');
    assert.equal(getTransactionDescription({ type: 'REVERSAL', reference: null }), 'Reversal');
    assert.equal(getTransactionDescription({ type: 'ADJUSTMENT', reference: { label: '  ' } }), 'Adjustment');
    assert.equal(getTransactionDescription({ type: 'SOMETHING', reference: null }), 'Transaction');
  });

  const page = strip(read('../src/pages/customer/CustomerTransactionsPage.tsx'));

  test('balance-after second line and direction word come from the shared row view', () => {
    assert.ok(page.includes('{view.balanceAfter}'));
    assert.ok(page.includes('{view.directionWord && <p className="text-xs text-ink-muted">{view.directionWord}</p>}'));
    assert.ok(page.includes('view.amountClass'));
    assert.ok(!page.includes('dir.amountClass'), 'debits are ink, not red');
  });

  test('filter URL behaviour unchanged (All drops type, change resets page)', () => {
    assert.ok(page.includes("if (id === 'all') next.delete('type');"));
    assert.ok(page.includes("else next.set('type', id);"));
    assert.ok(page.includes("next.delete('page');"));
    for (const v of ["'all'", "'order_credit'", "'payout'", "'adjustment'", "'reversal'"]) {
      assert.ok(page.includes(`value: ${v}`), v);
    }
    assert.ok(page.includes('<FilterChips'));
  });

  test('table is scrollable at phone width', () => {
    assert.ok(page.includes('overflow-x-auto'));
    assert.ok(page.includes('min-w-[640px]'));
  });
});

describe('payouts', () => {
  test('status wording: Completed, never Paid', () => {
    assert.equal(getPayoutStatusLabel('COMPLETED'), 'Completed');
    assert.equal(getPayoutStatusLabel('REVERSED'), 'Reversed');
    assert.equal(getPayoutStatusLabel('CANCELLED'), 'Cancelled');
    const page = strip(read('../src/pages/customer/CustomerPayoutsPage.tsx'));
    assert.ok(!/\bPaid\b/.test(page));
    assert.ok(page.includes('getPayoutStatusLabel(payout.status)'));
    assert.ok(!/reference/i.test(page));
  });

  test('latest payout chip uses the shared status rule', () => {
    const p: CustomerPayoutSummary = {
      id: 'p',
      payoutNumber: 'PAY-1',
      amount: '40',
      paymentMethod: { name: 'Cash' },
      status: 'COMPLETED',
      createdAt: '2026-09-07T12:00:00.000Z',
    };
    assert.equal(getLatestPayoutChipText(undefined), null);
    const done = getLatestPayoutChipText(p)!;
    assert.match(done, /^Latest payout · \$40\.00 on .+2026$/);
    assert.ok(getLatestPayoutChipText({ ...p, status: 'REVERSED' })!.endsWith(' · Reversed'));
  });
});

describe('Step 5 guardrails', () => {
  for (const file of ['CustomerWalletLayout.tsx', 'CustomerWalletPage.tsx', 'CustomerTransactionsPage.tsx', 'CustomerPayoutsPage.tsx']) {
    test(`${file}: no withdraw / request-payout control, driver cash or company revenue`, () => {
      const code = strip(read(`../src/pages/customer/${file}`));
      assert.ok(!/withdraw(?!able)|request payout|requestPayout|driver|revenue|underReviewCollectionAmount/i.test(code));
      assert.ok(!/<button[^>]*>\s*(Withdraw|Request)/i.test(code));
    });
  }

  test('wallet under-review is a count only; PendingBreakdownCard no longer used here', () => {
    const code = strip(read('../src/pages/customer/CustomerWalletLayout.tsx'));
    assert.ok(code.includes('{reviewCount > 0 && ('));
    assert.ok(!code.includes('PendingBreakdownCard'));
    const mgmt = read('../src/pages/management/wallets/WalletDetailPage.tsx');
    assert.ok(mgmt.includes('PendingBreakdownCard'), 'Management keeps the shared card');
  });
});
