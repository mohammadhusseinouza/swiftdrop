// Customer Portal Redesign Step 2 — Overview: optional `limit` on the customer
// list requests + the Overview presentation helpers. Pure logic, Node's
// built-in runner. Run:
//   npx --prefix ../server tsx --test tests/customerOverview.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  customerOrdersRequest,
  customerPayoutsRequest,
  customerWalletTransactionsRequest,
} from '../src/services/customerPortalQueryArgs';
import {
  getGreeting,
  getLastPayoutPresentation,
  getOverviewTitle,
  isReadyForPayout,
} from '../src/components/customer/customerOverviewPresentation';
import type { CustomerPayoutSummary } from '../src/services/domain.types';

describe('customer list requests — optional limit', () => {
  test('existing callers are unchanged (no limit key unless passed)', () => {
    assert.deepEqual(customerOrdersRequest(undefined), { url: '/customer/me/orders', params: {} });
    assert.deepEqual(customerOrdersRequest({ page: 2, view: 'delivered' }), {
      url: '/customer/me/orders',
      params: { page: 2, view: 'delivered' },
    });
    assert.deepEqual(customerWalletTransactionsRequest({ page: 1, type: 'payout' }), {
      url: '/customer/me/wallet/transactions',
      params: { page: 1, type: 'payout' },
    });
    assert.deepEqual(customerPayoutsRequest({ page: 3 }), {
      url: '/customer/me/payouts',
      params: { page: 3 },
    });
  });

  test('limit is forwarded when passed', () => {
    assert.deepEqual(customerOrdersRequest({ view: 'active', page: 1, limit: 4 }).params, {
      page: 1,
      limit: 4,
      view: 'active',
    });
    assert.deepEqual(customerWalletTransactionsRequest({ page: 1, limit: 5 }).params, { page: 1, limit: 5 });
    assert.deepEqual(customerPayoutsRequest({ page: 1, limit: 1 }).params, { page: 1, limit: 1 });
  });

  test('requests stay self-scoped (no customer id)', () => {
    for (const r of [
      customerOrdersRequest({ page: 1, limit: 4 }),
      customerWalletTransactionsRequest({ page: 1, limit: 5 }),
      customerPayoutsRequest({ page: 1, limit: 1 }),
    ]) {
      assert.match(r.url, /^\/customer\/me\//);
      assert.ok(!Object.keys(r.params).some((k) => /customer/i.test(k)));
    }
  });

  test('the three endpoints build their requests through the shared builders', () => {
    for (const [file, fn] of [
      ['customerOrdersApi.ts', 'customerOrdersRequest'],
      ['customerWalletApi.ts', 'customerWalletTransactionsRequest'],
      ['customerPayoutsApi.ts', 'customerPayoutsRequest'],
    ]) {
      const src = readFileSync(new URL(`../src/services/${file}`, import.meta.url), 'utf8');
      assert.ok(src.includes(`query: (params) => ${fn}(params)`), file);
    }
  });
});

describe('Overview presentation', () => {
  test('greeting by local hour', () => {
    assert.equal(getGreeting(new Date(2026, 10, 6, 8)), 'Good morning');
    assert.equal(getGreeting(new Date(2026, 10, 6, 13)), 'Good afternoon');
    assert.equal(getGreeting(new Date(2026, 10, 6, 20)), 'Good evening');
  });

  test('title uses the first name token, falls back when blank', () => {
    const evening = new Date(2026, 10, 6, 20);
    assert.equal(getOverviewTitle('Nour Haddad', evening), 'Good evening, Nour.');
    assert.equal(getOverviewTitle('  Acme   Trading ', evening), 'Good evening, Acme.');
    assert.equal(getOverviewTitle('', evening), 'Welcome back.');
    assert.equal(getOverviewTitle('   ', evening), 'Welcome back.');
    assert.equal(getOverviewTitle(undefined, evening), 'Welcome back.');
  });

  test('"Ready for payout" only for a strictly positive balance (exact cents, no float)', () => {
    assert.equal(isReadyForPayout('0.01'), true);
    assert.equal(isReadyForPayout('1250'), true);
    assert.equal(isReadyForPayout('12345678901234.55'), true);
    assert.equal(isReadyForPayout('0'), false);
    assert.equal(isReadyForPayout('0.00'), false);
    assert.equal(isReadyForPayout('-5.00'), false);
    assert.equal(isReadyForPayout(''), false);
    assert.equal(isReadyForPayout('abc'), false);
    assert.equal(isReadyForPayout(null), false);
    assert.equal(isReadyForPayout(undefined), false);
  });

  test('last payout: hidden when none, status shown when not completed', () => {
    assert.equal(getLastPayoutPresentation(undefined), null);
    const base: CustomerPayoutSummary = {
      id: 'p1',
      payoutNumber: 'PO-1',
      amount: '1500.5',
      paymentMethod: { name: 'Bank transfer' },
      status: 'COMPLETED',
      createdAt: '2026-11-02T10:00:00.000Z',
    };
    const done = getLastPayoutPresentation(base)!;
    assert.equal(done.amount, '$1,500.50');
    assert.ok(done.detail.endsWith(' · Bank transfer'));
    assert.ok(!done.detail.includes('Completed'));

    const reversed = getLastPayoutPresentation({ ...base, status: 'REVERSED' })!;
    assert.ok(reversed.detail.endsWith(' · Reversed'));
  });
});

describe('Overview page guardrails', () => {
  const page = readFileSync(new URL('../src/pages/customer/CustomerDashboardPage.tsx', import.meta.url), 'utf8');

  test('uses the agreed limits', () => {
    assert.ok(page.includes("{ view: 'active', page: 1, limit: 4 }"));
    assert.ok(page.includes('{ page: 1, limit: 5 }'));
    assert.ok(page.includes('{ page: 1, limit: 1 }'));
  });

  test('no money arithmetic, no withdraw / request-payout control, no driver identity', () => {
    assert.ok(!/parseFloat|Number\(|toFixed/.test(page));
    assert.ok(!/withdraw/i.test(page.replace(/\/\*[\s\S]*?\*\//g, '')));
    assert.ok(!/request payout/i.test(page.replace(/\/\*[\s\S]*?\*\//g, '')));
    assert.ok(!/driver/i.test(page.replace(/\/\*[\s\S]*?\*\//g, '')));
  });
});
