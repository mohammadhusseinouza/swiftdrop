// Pure-logic test for the Management Drivers page summary cards. Same
// lightweight approach as customerTotalsCards.test.ts (Node's built-in
// runner, outside src/). Run:
//   npx --prefix ../server tsx --test tests/driverTotalsCards.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildDriverTotalsCards,
  driverTotalsGridClass,
} from '../src/pages/management/drivers/driverTotalsCards';

const OPS = { activeOrders: 17, outForDelivery: 4, completedToday: 1203 };
const CASH = { currentBalance: '98765.4' };

function values(cards: ReturnType<typeof buildDriverTotalsCards>) {
  return Object.fromEntries(cards.map((c) => [c.key, c.value]));
}

describe('Drivers page totals cards', () => {
  test('renders the four Driver Detail cards in order with API values', () => {
    const cards = buildDriverTotalsCards({
      showCash: true,
      operational: { data: OPS, isError: false },
      cash: { data: CASH, isError: false },
    });
    assert.deepEqual(
      cards.map((c) => c.label),
      ['Assigned orders', 'Out for delivery', 'Delivered today', 'Cash held'],
    );
    assert.deepEqual(values(cards), {
      assignedOrders: '17',
      outForDelivery: '4',
      deliveredToday: '1203',
      cashHeld: '$98,765.40',
    });
    assert.equal(cards[0].supportingText, 'Active work currently held');
    assert.equal(cards[2].supportingText, 'Successful deliveries completed today');
    assert.equal(cards[3].supportingText, 'Not yet settled');
  });

  test('zero totals render as 0 / $0.00', () => {
    const cards = buildDriverTotalsCards({
      showCash: true,
      operational: { data: { activeOrders: 0, outForDelivery: 0, completedToday: 0 }, isError: false },
      cash: { data: { currentBalance: '0' }, isError: false },
    });
    assert.deepEqual(values(cards), {
      assignedOrders: '0',
      outForDelivery: '0',
      deliveredToday: '0',
      cashHeld: '$0.00',
    });
  });

  test('loading -> "…" and failed -> "—", each request independently', () => {
    const cards = buildDriverTotalsCards({
      showCash: true,
      operational: { isError: false },
      cash: { isError: true },
    });
    assert.deepEqual(values(cards), {
      assignedOrders: '…',
      outForDelivery: '…',
      deliveredToday: '…',
      cashHeld: '—',
    });
  });

  test('without finance.read the Cash held card is omitted', () => {
    const cards = buildDriverTotalsCards({
      showCash: false,
      operational: { data: OPS, isError: false },
      cash: { data: CASH, isError: false },
    });
    assert.deepEqual(cards.map((c) => c.key), ['assignedOrders', 'outForDelivery', 'deliveredToday']);
  });

  test('desktop grid columns follow the visible card count', () => {
    assert.match(driverTotalsGridClass(4), /lg:grid-cols-4/);
    assert.match(driverTotalsGridClass(3), /lg:grid-cols-3/);
    assert.doesNotMatch(driverTotalsGridClass(3), /lg:grid-cols-4/);
    for (const n of [3, 4]) assert.match(driverTotalsGridClass(n), /sm:grid-cols-2/);
    const withoutCash = buildDriverTotalsCards({
      showCash: false,
      operational: { isError: false },
      cash: { isError: false },
    });
    assert.match(driverTotalsGridClass(withoutCash.length), /lg:grid-cols-3/);
  });

  test('Driver Detail keeps its own Delivered today description', () => {
    const detail = readFileSync(
      new URL('../src/pages/management/drivers/DriverDetailPage.tsx', import.meta.url),
      'utf8',
    );
    assert.match(detail, /Attributed to this driver/);
  });

  test('summary is mounted without list state, so table filters cannot feed it', () => {
    const page = readFileSync(
      new URL('../src/pages/management/drivers/DriversListPage.tsx', import.meta.url),
      'utf8',
    );
    assert.match(page, /<DriverTotalsSummary \/>/);
    const summary = readFileSync(
      new URL('../src/pages/management/drivers/DriverTotalsSummary.tsx', import.meta.url),
      'utf8',
    );
    assert.match(summary, /export function DriverTotalsSummary\(\)/);
    assert.match(summary, /className=\{driverTotalsGridClass\(cards\.length\)\}/);
    assert.match(summary, /useGetDriverOperationalTotalsQuery\(\)/);
    assert.match(summary, /useGetDriverCashTotalsQuery\(undefined, \{ skip: !showCash \}\)/);
  });
});
