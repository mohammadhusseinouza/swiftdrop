// Driver Expenses — Phase 5 (Reports tab + unsaved-counter refinement).
// Pure-logic + wiring tests, Node's built-in runner (no DOM). Run:
//   npx --prefix ../server tsx --test tests/driverExpensesReports.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MAX_TREND_RANGE_DAYS,
  REPORT_PERIODS,
  defaultReportFilters,
  monthRange,
  rangeDays,
  resolveReportRange,
  toReportParams,
  weekRange,
  type ReportFiltersState,
} from '../src/pages/management/driver-expenses/reportPeriods';
import {
  applyDraftChange,
  buildGridRows,
  pruneCleanDrafts,
  type DraftBaseline,
  type DraftsByDate,
} from '../src/pages/management/driver-expenses/dailyExpenseGrid';
import { DRIVER_EXPENSES_TABS, hasAnyDrafts, parseTab } from '../src/pages/management/driver-expenses/driverExpensesParams';
import { displayKm, displayMoney, displayRate } from '../src/pages/management/driver-expenses/driverExpenseFormat';
import type { DailyExpenseDetail, ExpenseDriverSummary } from '../src/services/domain.types';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

/* ------------------------------ tab + URL ------------------------------ */

describe('Reports tab', () => {
  test('is the fourth tab and selectable via ?tab=reports', () => {
    assert.deepEqual(DRIVER_EXPENSES_TABS.map((t) => t.id), ['daily', 'drivers', 'fuel', 'reports']);
    assert.equal(DRIVER_EXPENSES_TABS[3].label, 'Reports');
    assert.equal(parseTab('reports'), 'reports');
    assert.equal(parseTab('daily'), 'daily');
    assert.equal(parseTab('nope'), 'daily');
  });

  test('filters and drafts are owned by the page, so switching tabs keeps both', () => {
    const page = read('../src/pages/management/driver-expenses/DriverExpensesPage.tsx');
    assert.match(page, /const \[reportFilters, setReportFilters\] = useState<ReportFiltersState>/);
    assert.match(page, /<ReportsTab today=\{today\} filters=\{reportFilters\} onFiltersChange=\{setReportFilters\} \/>/);
    assert.match(page, /const \[drafts, setDrafts\] = useState<DraftsByDate>/);
  });
});

/* -------------------------------- periods -------------------------------- */

describe('report periods (UTC calendar dates)', () => {
  test('This Week is Monday through Sunday', () => {
    assert.deepEqual(weekRange('2026-10-12'), { from: '2026-10-12', to: '2026-10-18' }); // Monday
    assert.deepEqual(weekRange('2026-10-14'), { from: '2026-10-12', to: '2026-10-18' }); // Wednesday
    assert.deepEqual(weekRange('2026-10-18'), { from: '2026-10-12', to: '2026-10-18' }); // Sunday
    assert.deepEqual(weekRange('2026-12-31'), { from: '2026-12-28', to: '2027-01-03' }); // across years
    assert.deepEqual(weekRange('2026-03-01'), { from: '2026-02-23', to: '2026-03-01' }); // across months
  });

  test('This Month is the first through the last calendar day', () => {
    assert.deepEqual(monthRange('2026-10-11'), { from: '2026-10-01', to: '2026-10-31' });
    assert.deepEqual(monthRange('2028-02-10'), { from: '2028-02-01', to: '2028-02-29' }); // leap year
    assert.deepEqual(monthRange('2027-02-10'), { from: '2027-02-01', to: '2027-02-28' });
    assert.deepEqual(monthRange('2026-12-31'), { from: '2026-12-01', to: '2026-12-31' });
  });

  test('Today, presets and custom ranges resolve; invalid custom ranges are rejected', () => {
    const base: ReportFiltersState = defaultReportFilters('2026-10-11');
    assert.equal(base.period, 'week');
    assert.deepEqual(REPORT_PERIODS.map((p) => p.id), ['today', 'week', 'month', 'custom']);
    assert.deepEqual(resolveReportRange({ ...base, period: 'today' }, '2026-10-11'), { ok: true, from: '2026-10-11', to: '2026-10-11' });
    assert.deepEqual(resolveReportRange({ ...base, period: 'month' }, '2026-10-11'), { ok: true, from: '2026-10-01', to: '2026-10-31' });
    const custom = { ...base, period: 'custom' as const };
    assert.deepEqual(resolveReportRange({ ...custom, customFrom: '2026-01-01', customTo: '2026-03-31' }, '2026-10-11'), {
      ok: true,
      from: '2026-01-01',
      to: '2026-03-31',
    });
    for (const [from, to] of [
      ['2026-03-01', '2026-02-01'],
      ['2026-02-30', '2026-03-01'],
      ['', '2026-03-01'],
      ['2026/01/01', '2026-03-01'],
    ]) {
      assert.equal(resolveReportRange({ ...custom, customFrom: from, customTo: to }, '2026-10-11').ok, false, `${from}..${to}`);
    }
    assert.equal(rangeDays('2026-01-01', '2026-01-01'), 1);
    assert.equal(rangeDays('2028-01-01', '2028-12-31'), 366);
  });

  test('params carry only the filters that are set', () => {
    const range = { from: '2026-10-01', to: '2026-10-31' };
    assert.deepEqual(toReportParams(range, { driverId: '', vehicleType: '' }), range);
    assert.deepEqual(toReportParams(range, { driverId: 'drv-1', vehicleType: 'CAR' }), { ...range, driverId: 'drv-1', vehicleType: 'CAR' });
  });

  test('the trend range limit matches the backend', () => {
    const server = readFileSync(new URL('../../server/src/modules/driver-expenses/report.schema.ts', import.meta.url), 'utf8');
    assert.match(server, new RegExp(`MAX_TREND_RANGE_DAYS = ${MAX_TREND_RANGE_DAYS};`));
  });
});

/* ------------------------------- display -------------------------------- */

describe('report value display', () => {
  test('exact strings, money half-up to cents, per-km at 4 dp, em dash for no average', () => {
    assert.equal(displayMoney('4.6624'), '$4.66');
    assert.equal(displayMoney('0.9999'), '$1.00');
    assert.equal(displayMoney('0'), '$0.00');
    assert.equal(displayRate('0.0571512626'), '$0.0572');
    assert.equal(displayRate(null), '—');
    assert.equal(displayKm('81.58'), '81.58 km');
    assert.equal(displayKm('0'), '0 km');
  });
});

/* ------------------------------- wiring -------------------------------- */

describe('reports wiring', () => {
  const api = read('../src/services/driverExpensesApi.ts');
  const tab = read('../src/pages/management/driver-expenses/ReportsTab.tsx');

  test('uses the four report endpoints with server-side filters, sort and pagination', () => {
    for (const ep of ['summary', 'by-driver', 'by-vehicle', 'daily-trend']) {
      assert.match(api, new RegExp(`url: '/driver-expenses/reports/${ep}', params: cleanParams\\(\\{ \\.\\.\\.params \\}\\)`));
    }
    assert.match(tab, /sortBy: sort\.columnId as DriverSortBy,\s*sortOrder: sort\.direction,\s*page,\s*limit: DRIVER_PAGE_SIZE/);
  });

  test('every section shares one filter; invalid ranges and over-long trends make no request', () => {
    assert.match(tab, /const skip = !params;/);
    assert.match(tab, /useGetDriverExpenseReportSummaryQuery\(params \?\? \{ from: today, to: today \}, \{ skip \}\)/);
    assert.match(tab, /useGetDriverExpenseReportByVehicleQuery\(params \?\? \{ from: today, to: today \}, \{ skip \}\)/);
    assert.match(tab, /\{ skip: skip \|\| trendTooLong \}/);
    assert.match(tab, /useEffect\(\(\) => setPage\(1\), \[paramsKey, sort\.columnId, sort\.direction\]\)/, 'filter/sort change resets to page 1');
  });

  test('reports refresh when an entry is created or corrected, or a default vehicle changes', () => {
    assert.ok((api.match(/\.\.\.REPORT_TAG/g) ?? []).length >= 3);
    assert.match(api, /providesTags: REPORT_TAG/);
  });

  test('loading, empty, error and mobile layouts exist', () => {
    assert.match(tab, /<LoadingState/);
    assert.match(tab, /<EmptyState className="py-10" icon=\{<ChartColumn \/>\} title="No entries in this period"/);
    assert.match(tab, /<ErrorState/);
    assert.match(tab, /isDesktop \?/);
    assert.match(tab, /grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5/);
  });

  test('amounts are labelled as estimates, never payments', () => {
    assert.match(tab, /not payments or reimbursements/);
    assert.match(tab, /Estimate, not a payment/);
  });
});

/* --------------------- unsaved-changes counter fix --------------------- */

function driver(id: string, extra: Partial<ExpenseDriverSummary> = {}): ExpenseDriverSummary {
  return { driverId: id, displayName: id, isActive: true, profileConfigured: true, defaultVehicleType: 'MOTORCYCLE', ...extra };
}

function record(driverId: string): DailyExpenseDetail {
  return {
    id: `rec-${driverId}`,
    driverId,
    driverName: driverId,
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
    notes: 'n',
    createdAt: '2026-10-05T10:00:00.000Z',
    updatedAt: '2026-10-05T10:00:00.000Z',
  };
}

describe('unsaved-changes counter only counts genuine changes', () => {
  const D1 = '2026-10-05';
  const saved: DraftBaseline = { driver: driver('a'), record: record('a') };
  const fresh: DraftBaseline = { driver: driver('b'), record: null };

  test('changing then restoring a saved value removes the draft and the date', () => {
    let drafts: DraftsByDate = {};
    drafts = applyDraftChange(drafts, D1, 'a', { distance: '40' }, saved);
    assert.equal(hasAnyDrafts(drafts), true);
    drafts = applyDraftChange(drafts, D1, 'a', { distance: '37.250' }, saved); // same value, different text
    assert.deepEqual(drafts, {});
    assert.equal(hasAnyDrafts(drafts), false, 'no leave prompt for no real change');
  });

  test('reverting vehicle and notes too', () => {
    let drafts: DraftsByDate = {};
    drafts = applyDraftChange(drafts, D1, 'a', { vehicleType: 'CAR' }, saved);
    drafts = applyDraftChange(drafts, D1, 'a', { notes: 'changed' }, saved);
    assert.ok(drafts[D1]?.a);
    drafts = applyDraftChange(drafts, D1, 'a', { vehicleType: 'MOTORCYCLE' }, saved);
    assert.ok(drafts[D1]?.a, 'notes still differ -> still unsaved');
    drafts = applyDraftChange(drafts, D1, 'a', { notes: ' n ' }, saved);
    assert.deepEqual(drafts, {});
  });

  test('a new row typed then cleared is not an unsaved change', () => {
    let drafts = applyDraftChange({}, D1, 'b', { distance: '12' }, fresh);
    assert.ok(drafts[D1]?.b);
    drafts = applyDraftChange(drafts, D1, 'b', { distance: '' }, fresh);
    assert.deepEqual(drafts, {});
  });

  test("picking a non-default vehicle before kilometers is kept (genuine), the default is not", () => {
    const kept = applyDraftChange({}, D1, 'b', { vehicleType: 'CAR' }, fresh);
    assert.deepEqual(kept, { [D1]: { b: { vehicleType: 'CAR' } } });
    assert.deepEqual(applyDraftChange(kept, D1, 'b', { vehicleType: 'MOTORCYCLE' }, fresh), {});
  });

  test('genuine changes on other dates and drivers are never touched', () => {
    let drafts: DraftsByDate = { '2026-10-04': { x: { distance: '5' } } };
    drafts = applyDraftChange(drafts, D1, 'a', { distance: '40' }, saved);
    drafts = applyDraftChange(drafts, D1, 'b', { distance: '9' }, fresh);
    drafts = applyDraftChange(drafts, D1, 'a', { distance: '37.25' }, saved);
    assert.deepEqual(drafts, { '2026-10-04': { x: { distance: '5' } }, [D1]: { b: { distance: '9' } } });
  });

  test('after the latest saved entries reload, drafts that now match are pruned', () => {
    const drafts: DraftsByDate = { [D1]: { a: { distance: '37.25' }, b: { distance: '3' } } };
    const rows = buildGridRows({ drivers: [driver('a'), driver('b')], records: [record('a')], drafts: drafts[D1], settings: null });
    const pruned = pruneCleanDrafts(drafts, D1, rows);
    assert.deepEqual(pruned, { [D1]: { b: { distance: '3' } } });
    // Nothing to prune -> same object (no state update / render loop).
    assert.equal(pruneCleanDrafts(pruned, D1, buildGridRows({ drivers: [driver('b')], records: [], drafts: pruned[D1], settings: null })), pruned);
  });

  test('the Daily tab wires edits through applyDraftChange and prunes on reload', () => {
    const daily = read('../src/pages/management/driver-expenses/DailyExpensesTab.tsx');
    assert.match(daily, /onDraftsChange\(\(prev\) => applyDraftChange\(prev, date, driverId, patch, baseline\)\)/);
    assert.match(daily, /onDraftsChange\(\(prev\) => pruneCleanDrafts\(prev, date, allRows\)\)/);
    // Stale / duplicate handling is unchanged.
    assert.match(daily, /if \(view\.kind === 'duplicate'\) void records\.refetch\(\);/);
    assert.match(daily, /Load latest saved entry/);
  });
});
