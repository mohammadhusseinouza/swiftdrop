// Driver Expenses (admin frontend) — pure-logic + wiring tests. Same
// lightweight approach as the other client tests (Node's built-in runner,
// outside src/; no DOM). Run:
//   npx --prefix ../server tsx --test tests/driverExpenses.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  formatExactDecimal,
  parseExactDecimal,
  roundExactToFixed,
  sumExactStrings,
} from '../src/lib/exactDecimal';
import {
  buildCreateRequest,
  buildGridRows,
  buildUpdateRequest,
  checkDistance,
  computeDayTotals,
  describeDriverExpenseError,
  filterGridRows,
  isValidCalendarDate,
  previewEstimatedExpense,
  shiftDate,
  todayUtc,
} from '../src/pages/management/driver-expenses/dailyExpenseGrid';
import { fuelSettingsFormSchema, previewFuelSettings } from '../src/pages/management/driver-expenses/fuelSettingsForm';
import { displayKm, displayMoney, displayRate } from '../src/pages/management/driver-expenses/driverExpenseFormat';
import { hasAnyDrafts, parseTab, resolveSelectedDate } from '../src/pages/management/driver-expenses/driverExpensesParams';
import { loadAllExpenseDrivers } from '../src/services/driverExpensesPaging';
import {
  buildManagementNavigation,
  getActiveManagementNavId,
  isNavItemVisible,
} from '../src/features/navigation/managementNavigation';
import { getManagementRouteTitle } from '../src/features/navigation/routeTitle';
import { decideRole } from '../src/routes/guards/decisions';
import type {
  DailyExpenseDetail,
  ExpenseDriverSummary,
  FuelSettingsDetail,
} from '../src/services/domain.types';

/* -------------------------------- fixtures -------------------------------- */

const V1: FuelSettingsDetail = {
  id: 'fs-1',
  effectiveFrom: '2026-10-01',
  pricePer20Liters: '25.5',
  motorcycleConsumptionLPer100Km: '3.4',
  carConsumptionLPer100Km: '8.75',
  pricePerLiter: '1.275',
  motorcycleCostPerKm: '0.04335',
  carCostPerKm: '0.1115625',
  createdAt: '2026-10-01T08:00:00.000Z',
};
const V2: FuelSettingsDetail = { ...V1, id: 'fs-2', effectiveFrom: '2026-10-10', pricePer20Liters: '30', carConsumptionLPer100Km: '9', carCostPerKm: '0.135' };

function driver(id: string, name: string, extra: Partial<ExpenseDriverSummary> = {}): ExpenseDriverSummary {
  return { driverId: id, displayName: name, isActive: true, profileConfigured: true, defaultVehicleType: 'MOTORCYCLE', ...extra };
}

function record(driverId: string, extra: Partial<DailyExpenseDetail> = {}): DailyExpenseDetail {
  return {
    id: `rec-${driverId}`,
    driverId,
    driverName: `Name ${driverId}`,
    expenseDate: '2026-10-05',
    vehicleType: 'MOTORCYCLE',
    distanceKm: '37.25',
    fuelSettingsId: 'fs-1',
    fuelSettingsEffectiveFrom: '2026-10-01',
    pricePer20LitersSnapshot: '25.5',
    consumptionLPer100KmSnapshot: '3.4',
    pricePerLiter: '1.275',
    costPerKm: '0.04335',
    estimatedExpense: '1.6147875',
    notes: null,
    createdAt: '2026-10-05T10:00:00.000Z',
    updatedAt: '2026-10-05T10:00:00.000Z',
    ...extra,
  };
}

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

/* ---------------------------- exact decimals ---------------------------- */

describe('exact decimals', () => {
  test('formula preview matches the backend exactly (no float drift)', () => {
    assert.equal(previewEstimatedExpense('37.25', '25.50', '3.40'), '1.6147875');
    assert.equal(previewEstimatedExpense('120.40', '25.50', '8.75'), '13.432125');
    assert.equal(previewEstimatedExpense('999999.99', '25.50', '8.75'), '111562.498884375');
    assert.equal(previewEstimatedExpense('0', '25.50', '8.75'), '0');
    // 0.1 + 0.2-style float traps cannot occur.
    assert.equal(formatExactDecimal(sumExactStrings(['0.1', '0.2'])!), '0.3');
  });

  test('display rounding is half-up to 2 decimals (formatMoney alone would truncate)', () => {
    assert.equal(displayMoney('1.6147875'), '$1.61');
    assert.equal(displayMoney('1.615'), '$1.62');
    assert.equal(displayMoney('13.432125'), '$13.43');
    assert.equal(displayMoney('0'), '$0.00');
    assert.equal(displayMoney('1234567.995'), '$1,234,568.00');
    assert.equal(displayMoney(null), '—');
    assert.equal(roundExactToFixed(parseExactDecimal('-1.005')!, 2), '-1.01');
    assert.equal(displayRate('0.1115625'), '$0.1116');
    assert.equal(displayKm('1234.5'), '1,234.5 km');
  });
});

/* -------------------------------- dates -------------------------------- */

describe('UTC date handling', () => {
  test("today is the UTC calendar date, whatever the browser's timezone", () => {
    assert.equal(todayUtc(new Date('2026-10-11T23:30:00-05:00')), '2026-10-12');
    assert.equal(todayUtc(new Date('2026-10-12T00:30:00+03:00')), '2026-10-11');
  });

  test('day navigation shifts in UTC across month, year and leap boundaries', () => {
    assert.equal(shiftDate('2026-10-31', 1), '2026-11-01');
    assert.equal(shiftDate('2027-01-01', -1), '2026-12-31');
    assert.equal(shiftDate('2028-02-28', 1), '2028-02-29');
    assert.equal(shiftDate('2026-03-29', 1), '2026-03-30'); // EU DST change day
  });

  test('selected date: invalid / impossible / future values fall back to today', () => {
    assert.equal(resolveSelectedDate('2026-10-05', '2026-10-11'), '2026-10-05');
    assert.equal(resolveSelectedDate('2026-10-11', '2026-10-11'), '2026-10-11');
    assert.equal(resolveSelectedDate('2026-10-12', '2026-10-11'), '2026-10-11');
    assert.equal(resolveSelectedDate('2026-02-30', '2026-10-11'), '2026-10-11');
    assert.equal(resolveSelectedDate('yesterday', '2026-10-11'), '2026-10-11');
    assert.equal(resolveSelectedDate(null, '2026-10-11'), '2026-10-11');
    assert.equal(isValidCalendarDate('2028-02-29'), true);
    assert.equal(isValidCalendarDate('2027-02-29'), false);
  });

  test('tab param', () => {
    assert.equal(parseTab(null), 'daily');
    assert.equal(parseTab('drivers'), 'drivers');
    assert.equal(parseTab('fuel'), 'fuel');
    assert.equal(parseTab('reports'), 'reports'); // Phase 5 tab
    assert.equal(parseTab('unknown'), 'daily');
  });
});

/* ------------------------------- distance ------------------------------- */

describe('distance input', () => {
  test('mirrors the backend rule: >= 0, <= 2 decimals, <= 999999.99', () => {
    assert.deepEqual(checkDistance(''), { kind: 'empty' });
    assert.deepEqual(checkDistance('  '), { kind: 'empty' });
    assert.deepEqual(checkDistance('0'), { kind: 'valid', value: '0' });
    assert.deepEqual(checkDistance('0.00'), { kind: 'valid', value: '0' });
    assert.deepEqual(checkDistance(' 12.50 '), { kind: 'valid', value: '12.5' });
    assert.deepEqual(checkDistance('999999.99'), { kind: 'valid', value: '999999.99' });
    // Trailing zeros do not count as decimals (same as the backend's decimal.js).
    assert.deepEqual(checkDistance('37.250'), { kind: 'valid', value: '37.25' });
    assert.deepEqual(checkDistance('999999.990'), { kind: 'valid', value: '999999.99' });
    for (const bad of ['-1', '1.234', '1.2340', '1e3', 'abc', '1,5', '1000000', '1000000.00', '999999.991']) {
      assert.equal(checkDistance(bad).kind, 'invalid', bad);
    }
  });
});

/* --------------------------------- grid --------------------------------- */

describe('daily grid', () => {
  test('one row per driver, joined by id (not name); empty distance when not recorded', () => {
    const drivers = [driver('a', 'Sam'), driver('b', 'Sam'), driver('c', 'Lee')];
    const rows = buildGridRows({ drivers, records: [record('b')], drafts: {}, settings: V1 });
    assert.deepEqual(rows.map((r) => r.driverId), ['a', 'b', 'c']);
    assert.equal(rows[0].record, null);
    assert.equal(rows[0].values.distance, '', 'not recorded -> empty, never 0');
    assert.equal(rows[0].status, 'not-recorded');
    assert.equal(rows[1].record?.id, 'rec-b');
    assert.equal(rows[1].status, 'saved');
  });

  test('distinguishes not recorded / saved 0 km / saved / unsaved', () => {
    const rows = buildGridRows({
      drivers: [driver('a', 'A'), driver('b', 'B'), driver('c', 'C'), driver('d', 'D')],
      records: [record('b', { distanceKm: '0', estimatedExpense: '0' }), record('c'), record('d')],
      drafts: { d: { distance: '40' } },
      settings: V1,
    });
    assert.deepEqual(rows.map((r) => r.status), ['not-recorded', 'saved-zero', 'saved', 'unsaved']);
    assert.equal(rows[1].values.distance, '0');
  });

  test('a draft equal to the saved values is not dirty', () => {
    const [row] = buildGridRows({
      drivers: [driver('a', 'A')],
      records: [record('a')],
      drafts: { a: { distance: '37.250', vehicleType: 'MOTORCYCLE', notes: '  ' } },
      settings: V1,
    });
    assert.equal(row.dirty, false);
    assert.equal(row.status, 'saved');
  });

  test('vehicle defaults from the profile; an override applies to the row only', () => {
    const drivers = [driver('a', 'A', { defaultVehicleType: 'CAR' })];
    const [byDefault] = buildGridRows({ drivers, records: [], drafts: { a: { distance: '10' } }, settings: V1 });
    assert.equal(byDefault.values.vehicleType, 'CAR');
    assert.equal(byDefault.preview.costPerKm, '0.1115625');
    assert.equal(byDefault.preview.estimatedExpense, '1.115625');
    const [overridden] = buildGridRows({ drivers, records: [], drafts: { a: { distance: '10', vehicleType: 'MOTORCYCLE' } }, settings: V1 });
    assert.equal(overridden.values.vehicleType, 'MOTORCYCLE');
    assert.equal(overridden.preview.estimatedExpense, '0.4335');
    assert.equal(drivers[0].defaultVehicleType, 'CAR', 'the profile itself is untouched');
  });

  test('missing default vehicle: no preview, not saveable until a vehicle is chosen', () => {
    const drivers = [driver('a', 'A', { defaultVehicleType: null, profileConfigured: false })];
    const [row] = buildGridRows({ drivers, records: [], drafts: { a: { distance: '10' } }, settings: V1 });
    assert.equal(row.preview.unavailable, 'NO_VEHICLE');
    assert.equal(row.saveable, false);
    assert.equal(buildCreateRequest(row, '2026-10-05'), null);
  });

  test('no fuel settings for the date: new rows cannot be previewed or saved', () => {
    const [row] = buildGridRows({ drivers: [driver('a', 'A')], records: [], drafts: { a: { distance: '10' } }, settings: null });
    assert.equal(row.preview.unavailable, 'NO_SETTINGS');
    assert.equal(row.saveable, false);
  });

  test('a saved record keeps its own snapshots even if other settings are loaded', () => {
    // Settings shown for the date differ from the record's snapshot: the
    // record's own (historical) values win; nothing is re-priced.
    const [row] = buildGridRows({ drivers: [driver('a', 'A')], records: [record('a')], drafts: {}, settings: V2 });
    assert.equal(row.preview.costPerKm, '0.04335');
    assert.equal(row.preview.estimatedExpense, '1.6147875');
    assert.equal(row.preview.isSavedValue, true);
  });

  test('a distance correction previews with the record snapshot price, not new settings', () => {
    const [row] = buildGridRows({ drivers: [driver('a', 'A')], records: [record('a')], drafts: { a: { distance: '50' } }, settings: V2 });
    assert.equal(row.preview.estimatedExpense, '2.1675'); // 50 * 25.5 * 3.4 * 0.0005
    assert.equal(row.preview.isSavedValue, false);
  });

  test('vehicle correction with a different settings version: no misleading preview, server calculates', () => {
    const [row] = buildGridRows({ drivers: [driver('a', 'A')], records: [record('a')], drafts: { a: { vehicleType: 'CAR' } }, settings: V2 });
    assert.equal(row.preview.unavailable, 'SETTINGS_MISMATCH');
    assert.equal(row.saveable, true);
    const [same] = buildGridRows({ drivers: [driver('a', 'A')], records: [record('a')], drafts: { a: { vehicleType: 'CAR' } }, settings: V1 });
    assert.equal(same.preview.estimatedExpense, '4.155703125'); // 37.25 * 25.5 * 8.75 * 0.0005
  });

  test('inactive drivers: hidden by default unless they have a record or a draft', () => {
    const drivers = [driver('a', 'A'), driver('b', 'B', { isActive: false }), driver('c', 'C', { isActive: false }), driver('d', 'D', { isActive: false })];
    const rows = buildGridRows({ drivers, records: [record('c')], drafts: { d: { notes: 'x' } }, settings: V1 });
    assert.deepEqual(rows.map((r) => r.driverId), ['a', 'c', 'd']);
    const all = buildGridRows({ drivers, records: [], drafts: {}, settings: V1, includeInactive: true });
    assert.equal(all.length, 4);
  });

  test('a record whose driver is not in the list is still shown', () => {
    const rows = buildGridRows({ drivers: [driver('a', 'A')], records: [record('zz')], drafts: {}, settings: V1 });
    assert.deepEqual(rows.map((r) => r.driverId), ['a', 'zz']);
    assert.equal(rows[1].displayName, 'Name zz');
  });

  test('filtering never drops drafts (drafts live outside the rows)', () => {
    const drafts = { a: { distance: '10' }, b: { distance: '20' } };
    const rows = buildGridRows({ drivers: [driver('a', 'Alpha'), driver('b', 'Bravo')], records: [], drafts, settings: V1 });
    assert.deepEqual(filterGridRows(rows, 'alp').map((r) => r.driverId), ['a']);
    assert.deepEqual(Object.keys(drafts), ['a', 'b']);
    assert.equal(filterGridRows(rows, '').length, 2);
    assert.equal(hasAnyDrafts({ '2026-10-05': drafts }), true);
    assert.equal(hasAnyDrafts({ '2026-10-05': {} }), false);
  });

  test('day totals are exact sums of saved entries only', () => {
    const totals = computeDayTotals([
      record('a'),
      record('b', { distanceKm: '120.4', estimatedExpense: '13.432125' }),
      record('c', { distanceKm: '0', estimatedExpense: '0' }),
    ]);
    assert.deepEqual(totals, { entries: 3, distanceKm: '157.65', estimatedExpense: '15.0469125' });
    assert.deepEqual(computeDayTotals([]), { entries: 0, distanceKm: '0', estimatedExpense: '0' });
  });
});

/* ------------------------------- requests ------------------------------- */

describe('save requests', () => {
  test('new record -> POST body with explicit vehicle, normalized distance, trimmed notes', () => {
    const [row] = buildGridRows({
      drivers: [driver('a', 'A')],
      records: [],
      drafts: { a: { distance: '012.50', notes: '  morning route ' } },
      settings: V1,
    });
    assert.deepEqual(buildCreateRequest(row, '2026-10-05'), {
      driverId: 'a',
      expenseDate: '2026-10-05',
      distanceKm: '12.5',
      vehicleType: 'MOTORCYCLE',
      notes: 'morning route',
    });
    assert.equal(buildUpdateRequest(row), null, 'never PATCH a row without a record');
  });

  test('zero-distance entry is saveable and distinct from empty', () => {
    const [zero] = buildGridRows({ drivers: [driver('a', 'A')], records: [], drafts: { a: { distance: '0' } }, settings: V1 });
    assert.equal(zero.saveable, true);
    assert.equal(buildCreateRequest(zero, '2026-10-05')?.distanceKm, '0');
    const [empty] = buildGridRows({ drivers: [driver('a', 'A')], records: [], drafts: { a: { distance: '' } }, settings: V1 });
    assert.equal(empty.saveable, false);
  });

  test('correction -> PATCH with expectedUpdatedAt and only the changed fields', () => {
    const rec = record('a', { notes: 'old' });
    const [row] = buildGridRows({ drivers: [driver('a', 'A')], records: [rec], drafts: { a: { distance: '40', notes: '' } }, settings: V1 });
    assert.equal(buildCreateRequest(row, '2026-10-05'), null, 'never POST over an existing record');
    assert.deepEqual(buildUpdateRequest(row), { expectedUpdatedAt: rec.updatedAt, distanceKm: '40', notes: null });
    const [vehicleOnly] = buildGridRows({ drivers: [driver('a', 'A')], records: [rec], drafts: { a: { vehicleType: 'CAR' } }, settings: V1 });
    assert.deepEqual(buildUpdateRequest(vehicleOnly), { expectedUpdatedAt: rec.updatedAt, vehicleType: 'CAR' });
  });

  test('invalid distance is never sent', () => {
    const [row] = buildGridRows({ drivers: [driver('a', 'A')], records: [record('a')], drafts: { a: { distance: '1.234' } }, settings: V1 });
    assert.equal(row.saveable, false);
    assert.equal(buildUpdateRequest(row), null);
  });
});

/* --------------------------------- errors --------------------------------- */

function apiError(status: number | string, reason?: string, extra: Record<string, unknown> = {}) {
  return {
    status,
    data: { success: false, error: { code: 'X', message: `server ${status}`, details: reason ? { reason, ...extra } : undefined } },
  };
}

describe('error mapping', () => {
  test('domain reasons', () => {
    const kinds = [
      ['STALE_DAILY_EXPENSE', 'stale'],
      ['DUPLICATE_DAILY_EXPENSE', 'duplicate'],
      ['FUEL_SETTINGS_NOT_CONFIGURED', 'no-settings'],
      ['VEHICLE_TYPE_NOT_CONFIGURED', 'no-vehicle'],
      ['FUTURE_EXPENSE_DATE', 'future-date'],
      ['DUPLICATE_EFFECTIVE_DATE', 'conflict'],
      ['RETROACTIVE_CONFLICT', 'conflict'],
    ] as const;
    for (const [reason, kind] of kinds) {
      assert.equal(describeDriverExpenseError(apiError(409, reason) as never).kind, kind, reason);
    }
    assert.match(describeDriverExpenseError(apiError(409, 'STALE_DAILY_EXPENSE') as never).message, /values are kept/);
    assert.match(describeDriverExpenseError(apiError(409, 'DUPLICATE_DAILY_EXPENSE') as never).message, /Nothing was overwritten/);
    assert.match(
      describeDriverExpenseError(apiError(409, 'RETROACTIVE_CONFLICT', { earliestAffectedExpenseDate: '2026-10-03' }) as never).message,
      /2026-10-03/,
    );
  });

  test('HTTP statuses and network failures', () => {
    assert.equal(describeDriverExpenseError(apiError(400) as never).kind, 'validation');
    assert.equal(describeDriverExpenseError(apiError(401) as never).kind, 'auth');
    assert.equal(describeDriverExpenseError(apiError(403) as never).kind, 'forbidden');
    assert.equal(describeDriverExpenseError(apiError(404) as never).kind, 'not-found');
    assert.equal(describeDriverExpenseError({ status: 'FETCH_ERROR', error: 'x' } as never).kind, 'network');
    assert.equal(describeDriverExpenseError(apiError(500) as never).kind, 'network');
  });
});

/* ------------------------------ fuel settings ------------------------------ */

describe('fuel settings form', () => {
  const valid = { pricePer20Liters: '25.50', motorcycleConsumptionLPer100Km: '3.40', carConsumptionLPer100Km: '8.75', effectiveFrom: '2026-12-01' };

  test('accepts valid input, including future effective dates', () => {
    assert.equal(fuelSettingsFormSchema.safeParse(valid).success, true);
    assert.equal(fuelSettingsFormSchema.safeParse({ ...valid, pricePer20Liters: '25.500' }).success, true);
  });

  test('rejects non-positive, malformed, over-precise and over-range values', () => {
    for (const [field, value] of [
      ['pricePer20Liters', '0'],
      ['pricePer20Liters', '0.00'],
      ['pricePer20Liters', '-1'],
      ['pricePer20Liters', '1.234'],
      ['pricePer20Liters', '1000000000000'],
      ['pricePer20Liters', ''],
      ['motorcycleConsumptionLPer100Km', '0'],
      ['carConsumptionLPer100Km', '10000'],
      ['carConsumptionLPer100Km', 'abc'],
      ['effectiveFrom', '2026-02-30'],
    ] as const) {
      assert.equal(fuelSettingsFormSchema.safeParse({ ...valid, [field]: value }).success, false, `${field}=${value}`);
    }
  });

  test('live preview is exact', () => {
    assert.deepEqual(previewFuelSettings(valid), {
      pricePerLiter: '1.275',
      motorcycleCostPerKm: '0.04335',
      carCostPerKm: '0.1115625',
    });
    assert.deepEqual(previewFuelSettings({ ...valid, pricePer20Liters: 'x' }), {
      pricePerLiter: null,
      motorcycleCostPerKm: null,
      carCostPerKm: null,
    });
  });
});

/* ----------------------------- driver paging ----------------------------- */

describe('all-drivers paging for the daily grid', () => {
  const makeDrivers = (n: number, offset = 0) =>
    Array.from({ length: n }, (_, i) => driver(`d${i + offset}`, `Driver ${i + offset}`));

  test('loads every page so no driver is omitted beyond the first page', async () => {
    const all = makeDrivers(250);
    const requested: number[] = [];
    const result = await loadAllExpenseDrivers(async (page) => {
      requested.push(page);
      return { items: all.slice((page - 1) * 100, page * 100), totalPages: 3 };
    });
    assert.deepEqual(requested, [1, 2, 3]);
    assert.ok('data' in result);
    assert.equal(result.data.length, 250);
  });

  test('de-duplicates by id if rows shift between pages', async () => {
    const result = await loadAllExpenseDrivers(async (page) =>
      page === 1 ? { items: makeDrivers(100), totalPages: 2 } : { items: makeDrivers(5, 98), totalPages: 2 },
    );
    assert.ok('data' in result);
    assert.equal(result.data.length, 103);
  });

  test('any page error fails the whole load (never a silently partial grid)', async () => {
    const result = await loadAllExpenseDrivers(async (page) =>
      page === 1 ? { items: makeDrivers(100), totalPages: 3 } : { error: { status: 500 } },
    );
    assert.deepEqual(result, { error: { status: 500 } });
  });

  test('bounded: a broken totalPages can never loop forever', async () => {
    const result = await loadAllExpenseDrivers(async () => ({ items: makeDrivers(10), totalPages: 999 }), 10, 5);
    assert.ok('error' in result);
  });
});

/* -------------------------- access + navigation -------------------------- */

describe('administrator-only access', () => {
  const ALL_MANAGEMENT_PERMISSIONS = [
    'dashboard.read', 'orders.read', 'customers.read', 'drivers.read', 'wallets.read', 'payouts.read',
    'settlements.read', 'finance.read', 'reports.read', 'employees.read', 'audit.read', 'settings.read',
  ];
  const ids = (role: string) =>
    buildManagementNavigation(ALL_MANAGEMENT_PERMISSIONS, role).flatMap((g) => g.items.map((i) => i.id));

  test('ADMIN sees Driver Expenses under Administration', () => {
    const admin = buildManagementNavigation(ALL_MANAGEMENT_PERMISSIONS, 'ADMIN');
    const administration = admin.find((g) => g.id === 'administration');
    assert.ok(administration?.items.some((i) => i.id === 'driver-expenses' && i.to === '/management/driver-expenses'));
  });

  test('DISPATCHER / FINANCE never see it, even holding every permission', () => {
    for (const role of ['DISPATCHER', 'FINANCE', 'DRIVER', 'CUSTOMER']) {
      assert.ok(!ids(role).includes('driver-expenses'), role);
    }
    assert.ok(!buildManagementNavigation(ALL_MANAGEMENT_PERMISSIONS).flatMap((g) => g.items).some((i) => i.id === 'driver-expenses'));
  });

  test('existing permission-based items are unaffected by the role filter', () => {
    assert.deepEqual(
      ids('FINANCE').filter((id) => id !== 'driver-expenses'),
      ids('ADMIN').filter((id) => id !== 'driver-expenses'),
    );
    assert.equal(isNavItemVisible({ id: 'x', label: 'x', to: '/x', icon: (() => null) as never }, ['a'], 'ADMIN'), false);
  });

  test('route guard decision, active nav item and title', () => {
    assert.deepEqual(decideRole('ADMIN', ['ADMIN']), { kind: 'allow' });
    for (const role of ['DISPATCHER', 'FINANCE', '', null, undefined]) {
      assert.deepEqual(decideRole(role, ['ADMIN']), { kind: 'unauthorized' }, String(role));
    }
    assert.equal(getActiveManagementNavId('/management/driver-expenses'), 'driver-expenses');
    assert.equal(getManagementRouteTitle('/management/driver-expenses'), 'Driver Expenses');
  });

  test('the route is wrapped in RequireRole ADMIN', () => {
    const tree = read('../src/routes/routeTree.tsx');
    assert.match(
      tree,
      /path: 'driver-expenses',\s*element: <RequireRole roles=\{\['ADMIN'\]\} \/>,\s*children: \[\{ index: true, element: <DriverExpensesPage \/> \}\]/,
    );
  });
});

/* ------------------------------- wiring ------------------------------- */

describe('wiring and isolation', () => {
  const api = read('../src/services/driverExpensesApi.ts');

  test('uses the Phase 2/3 endpoints with the right methods', () => {
    for (const pattern of [
      /url: '\/driver-expenses\/fuel-settings\/current'/,
      /url: '\/driver-expenses\/fuel-settings\/effective', params: \{ date \}/,
      /url: '\/driver-expenses\/fuel-settings', method: 'POST'/,
      /url: `\/driver-expenses\/drivers\/\$\{driverId\}\/profile`,\s*method: 'PUT'/,
      /url: `\/driver-expenses\/daily-expenses\/by-date\/\$\{date\}`/,
      /url: '\/driver-expenses\/daily-expenses', method: 'POST'/,
      /url: `\/driver-expenses\/daily-expenses\/\$\{id\}`, method: 'PATCH'/,
    ]) {
      assert.match(api, pattern);
    }
  });

  test('never touches finance, driver cash, wallets, settlements, payouts or orders', () => {
    for (const forbidden of ["'Finance'", "'DriverCash'", "'Wallet'", "'Settlement'", "'Payout'", "'Order'", '/finance', '/wallets', '/orders']) {
      assert.ok(!api.includes(forbidden), forbidden);
    }
    const page = ['DailyExpensesTab', 'DriversTab', 'FuelSettingsTab', 'DriverExpensesPage']
      .map((f) => read(`../src/pages/management/driver-expenses/${f}.tsx`))
      .join('\n');
    for (const forbidden of ['ordersApi', 'financeApi', 'walletsApi', 'settlementsApi', 'payoutsApi', 'driversApi']) {
      assert.ok(!page.includes(forbidden), forbidden);
    }
  });

  test('nothing is saved on page visit; unsaved changes are guarded; dates cannot go future', () => {
    const daily = read('../src/pages/management/driver-expenses/DailyExpensesTab.tsx');
    assert.match(daily, /max=\{today\}/);
    assert.match(daily, /disabled=\{date >= today\}/);
    assert.doesNotMatch(daily, /useEffect\([^)]*create/);
    const page = read('../src/pages/management/driver-expenses/DriverExpensesPage.tsx');
    assert.match(page, /useBlocker\(/);
    assert.match(page, /beforeunload/);
    assert.match(page, /const \[drafts, setDrafts\] = useState<DraftsByDate>/, 'drafts owned by the page, survive tab switches');
  });

  test('mobile: each tab has a card layout below the md breakpoint', () => {
    for (const f of ['DailyExpensesTab', 'DriversTab']) {
      const src = read(`../src/pages/management/driver-expenses/${f}.tsx`);
      assert.match(src, /isDesktop \?/);
      assert.match(src, /<ul className="space-y-2">/);
    }
  });
});
