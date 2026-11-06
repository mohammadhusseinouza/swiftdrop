// Customer Portal Redesign — Wallet tabs (handoff §3.4, decision D1-B):
// 4-item nav with Wallet current on /wallet, /transactions and /payouts;
// Transactions / Payouts tabs inside one Wallet layout; routes unchanged.
// Run: npx --prefix ../server tsx --test tests/customerWalletTabs.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CUSTOMER_NAV_ITEMS, isCustomerNavItemActive } from '../src/components/customer/customerNavigation';
import { getWalletHistoryTab } from '../src/components/customer/customerWalletPresentation';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const activeIds = (path: string) => CUSTOMER_NAV_ITEMS.filter((i) => isCustomerNavItemActive(i, path)).map((i) => i.id);

describe('customer nav (D1-B)', () => {
  test('four items, in order, Transactions and Payouts removed', () => {
    assert.deepEqual(CUSTOMER_NAV_ITEMS.map((i) => i.label), ['Dashboard', 'My Orders', 'Wallet', 'Profile']);
  });

  test('exactly one item is current per route; Wallet covers all three wallet routes', () => {
    assert.deepEqual(activeIds('/customer/dashboard'), ['dashboard']);
    assert.deepEqual(activeIds('/customer/orders'), ['orders']);
    assert.deepEqual(activeIds('/customer/orders/abc-123'), ['orders']);
    assert.deepEqual(activeIds('/customer/wallet'), ['wallet']);
    assert.deepEqual(activeIds('/customer/transactions'), ['wallet']);
    assert.deepEqual(activeIds('/customer/transactions/'), ['wallet']);
    assert.deepEqual(activeIds('/customer/payouts'), ['wallet']);
    assert.deepEqual(activeIds('/customer/profile'), ['profile']);
  });

  test('no false prefix matches', () => {
    assert.deepEqual(activeIds('/customer/ordersX'), []);
    assert.deepEqual(activeIds('/customer/walletish'), []);
  });

  test('shell uses the shared nav model and sets aria-current itself', () => {
    const shell = strip(read('../src/layouts/CustomerLayout.tsx'));
    assert.ok(shell.includes('CUSTOMER_NAV_ITEMS.map('));
    assert.ok(shell.includes("aria-current={active ? 'page' : undefined}"));
    assert.ok(!shell.includes('NavLink'));
  });
});

describe('wallet history tabs', () => {
  test('route → tab', () => {
    assert.equal(getWalletHistoryTab('/customer/wallet'), 'transactions');
    assert.equal(getWalletHistoryTab('/customer/transactions'), 'transactions');
    assert.equal(getWalletHistoryTab('/customer/payouts'), 'payouts');
    assert.equal(getWalletHistoryTab('/customer/payouts/'), 'payouts');
  });

  test('layout renders the balance panels, link tabs and the outlet', () => {
    const layout = strip(read('../src/pages/customer/CustomerWalletLayout.tsx'));
    assert.ok(layout.includes('<SegmentedLinkTabs'));
    assert.ok(layout.includes("{ to: paths.customer.transactions, label: 'Transactions', current: tab === 'transactions' }"));
    assert.ok(layout.includes("{ to: paths.customer.payouts, label: 'Payouts', current: tab === 'payouts' }"));
    assert.ok(layout.includes('<Outlet />'));
    assert.ok(layout.includes('<AvailablePanel data={data} />'));
    assert.ok(layout.includes('<PendingPanel breakdown={pendingBreakdown(data)} />'));
  });

  test('link tabs use link semantics (nav + aria-current), not tab roles', () => {
    const src = strip(read('../src/components/customer/SegmentedTabs.tsx'));
    const links = src.slice(src.indexOf('export function SegmentedLinkTabs'));
    assert.ok(links.includes('<nav aria-label={label}'));
    assert.ok(links.includes("aria-current={item.current ? 'page' : undefined}"));
    assert.ok(!links.includes('role="tab'));
  });

  test('routes unchanged; wallet / transactions / payouts sit under the layout', () => {
    const tree = strip(read('../src/routes/routeTree.tsx'));
    const block = tree.slice(tree.indexOf('element: <CustomerWalletLayout />'));
    for (const r of ["{ path: 'wallet', element: <CustomerWalletPage /> }",
      "{ path: 'transactions', element: <CustomerTransactionsPage /> }",
      "{ path: 'payouts', element: <CustomerPayoutsPage /> }"]) {
      assert.ok(block.includes(r), r);
    }
  });

  test('/customer/wallet shows the same Transactions view (one implementation)', () => {
    const wallet = strip(read('../src/pages/customer/CustomerWalletPage.tsx'));
    assert.ok(wallet.includes("export { default } from './CustomerTransactionsPage';"));
  });

  test('tab content has no page header of its own', () => {
    for (const f of ['CustomerTransactionsPage.tsx', 'CustomerPayoutsPage.tsx']) {
      assert.ok(!strip(read(`../src/pages/customer/${f}`)).includes('CustomerPageHeader'), f);
    }
  });
});
