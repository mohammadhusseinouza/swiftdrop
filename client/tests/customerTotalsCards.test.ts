// Pure-logic test for the Management Customers page summary cards. Same
// lightweight approach as orderDetailActions.test.ts (Node's built-in
// runner, outside src/). Run:
//   npx --prefix ../server tsx --test tests/customerTotalsCards.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCustomerTotalsCards } from '../src/pages/management/customers/customerTotalsCards';

const WALLET = { availableBalance: '1234567.5', pendingAmount: '155.00' };
const ORDERS = { activeOrders: 42, deliveredOrders: 1003 };

function values(cards: ReturnType<typeof buildCustomerTotalsCards>) {
  return Object.fromEntries(cards.map((c) => [c.key, c.value]));
}

describe('Customers page totals cards', () => {
  test('renders the four Customer Detail cards in order with API values', () => {
    const cards = buildCustomerTotalsCards({
      showFinancial: true,
      showOrders: true,
      wallet: { data: WALLET, isError: false },
      orders: { data: ORDERS, isError: false },
    });
    assert.deepEqual(
      cards.map((c) => c.label),
      ['Available wallet', 'Pending amount', 'Active orders', 'Delivered orders'],
    );
    assert.deepEqual(values(cards), {
      availableWallet: '$1,234,567.50',
      pendingAmount: '$155.00',
      activeOrders: '42',
      deliveredOrders: '1003',
    });
  });

  test('loading -> "…" and failed -> "—" per half, independently', () => {
    const cards = buildCustomerTotalsCards({
      showFinancial: true,
      showOrders: true,
      wallet: { isError: true },
      orders: { isError: false },
    });
    assert.deepEqual(values(cards), {
      availableWallet: '—',
      pendingAmount: '—',
      activeOrders: '…',
      deliveredOrders: '…',
    });
  });

  test('without wallets.read the money cards are omitted', () => {
    const cards = buildCustomerTotalsCards({
      showFinancial: false,
      showOrders: true,
      wallet: { data: WALLET, isError: false },
      orders: { data: ORDERS, isError: false },
    });
    assert.deepEqual(cards.map((c) => c.key), ['activeOrders', 'deliveredOrders']);
  });

  test('without orders.read the order cards are omitted', () => {
    const cards = buildCustomerTotalsCards({
      showFinancial: true,
      showOrders: false,
      wallet: { data: WALLET, isError: false },
      orders: { data: ORDERS, isError: false },
    });
    assert.deepEqual(cards.map((c) => c.key), ['availableWallet', 'pendingAmount']);
  });

  test('summary is mounted without list state, so table filters cannot feed it', () => {
    const page = readFileSync(
      new URL('../src/pages/management/customers/CustomersListPage.tsx', import.meta.url),
      'utf8',
    );
    assert.match(page, /<CustomerTotalsSummary \/>/);
    const summary = readFileSync(
      new URL('../src/pages/management/customers/CustomerTotalsSummary.tsx', import.meta.url),
      'utf8',
    );
    assert.match(summary, /export function CustomerTotalsSummary\(\)/);
    assert.match(summary, /useGetWalletTotalsQuery\(undefined/);
    assert.match(summary, /useGetCustomerOrderTotalsQuery\(undefined/);
  });
});
