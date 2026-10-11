import type {
  DailyExpenseDetail,
  ExpenseDriverSummary,
  ExpenseVehicleType,
  FuelSettingsDetail,
} from '../../../services/domain.types';
import {
  getApiErrorDetails,
  getApiErrorMessage,
  getApiErrorStatus,
  type UnknownApiError,
} from '../../../services/apiError';
import {
  formatExactDecimal,
  multiplyExact,
  parseExactDecimal,
  sumExactStrings,
} from '../../../lib/exactDecimal';
import type {
  CreateDailyExpenseRequest,
  UpdateDailyExpenseRequest,
} from '../../../services/driverExpensesApi';

/**
 * Driver Expenses — Daily Expenses grid, PURE logic (no React, no I/O).
 *
 * The grid shows one row per driver for a selected date: every driver from
 * the all-drivers query, joined BY DRIVER ID with the date's recorded entries
 * (the server returns saved entries only — nothing is invented here). Unsaved
 * edits live in a separate `drafts` map, so filtering/searching or changing
 * dates never loses them.
 *
 * Previews mirror the backend formula with exact decimals:
 *   estimated = distance * (price per 20 L / 20) * (consumption / 100)
 *             = distance * price * consumption * 0.0005
 * The server recalculates and is authoritative for every saved figure.
 */

/* --------------------------------- dates --------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Today's UTC business date (backend convention), YYYY-MM-DD. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function isValidCalendarDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

/** Shift a YYYY-MM-DD date by whole days in UTC (never local time). */
export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** YYYY-MM-DD strings compare correctly as text. */
export function isAfterDate(date: string, other: string): boolean {
  return date > other;
}

/* -------------------------------- distance -------------------------------- */

export const DISTANCE_MAX = '999999.99';
const DISTANCE_RE = /^\d+(?:\.\d+)?$/;

/**
 * Significant decimal places, ignoring trailing zeros — the backend counts
 * them the same way (decimal.js), so "37.250" is a valid 2-decimal value.
 */
export function significantDecimals(value: string): number {
  const frac = value.trim().split('.')[1] ?? '';
  return frac.replace(/0+$/, '').length;
}

export type DistanceCheck =
  | { kind: 'empty' }
  | { kind: 'valid'; value: string }
  | { kind: 'invalid'; message: string };

/** Mirrors the backend's NUMERIC(8,2) >= 0 rule. Returns the normalized value. */
export function checkDistance(input: string): DistanceCheck {
  const raw = input.trim();
  if (raw === '') return { kind: 'empty' };
  if (!DISTANCE_RE.test(raw) || significantDecimals(raw) > 2) {
    return { kind: 'invalid', message: 'Enter kilometers as a number with up to 2 decimals.' };
  }
  const parsed = parseExactDecimal(raw);
  const max = parseExactDecimal(DISTANCE_MAX);
  if (!parsed || !max) return { kind: 'invalid', message: 'Enter a valid distance.' };
  // Compare at a common scale (exact, no floats).
  const scale = Math.max(parsed.scale, max.scale);
  if (parsed.mantissa * 10n ** BigInt(scale - parsed.scale) > max.mantissa * 10n ** BigInt(scale - max.scale)) {
    return { kind: 'invalid', message: 'Distance exceeds 999,999.99 km.' };
  }
  return { kind: 'valid', value: formatExactDecimal(parsed) };
}

function sameDecimal(a: string, b: string): boolean {
  const x = parseExactDecimal(a);
  const y = parseExactDecimal(b);
  if (!x || !y) return a === b;
  const scale = Math.max(x.scale, y.scale);
  return x.mantissa * 10n ** BigInt(scale - x.scale) === y.mantissa * 10n ** BigInt(scale - y.scale);
}

/* --------------------------------- grid --------------------------------- */

/** Only the fields the administrator has touched for this driver + date. */
export interface RowDraft {
  distance?: string;
  vehicleType?: ExpenseVehicleType;
  notes?: string;
}

export type RowStatus = 'not-recorded' | 'saved-zero' | 'saved' | 'unsaved';

export type PreviewUnavailable =
  | 'EMPTY'
  | 'INVALID_DISTANCE'
  | 'NO_VEHICLE'
  | 'NO_SETTINGS'
  | 'SETTINGS_MISMATCH';

export interface RowPreview {
  /** Exact cost per km for the row's vehicle, or null when unknown. */
  costPerKm: string | null;
  /** Exact estimated expense; the saved value when the row is unchanged. */
  estimatedExpense: string | null;
  /** True when estimatedExpense is the server's saved value. */
  isSavedValue: boolean;
  unavailable?: PreviewUnavailable;
}

export interface GridRow {
  driverId: string;
  displayName: string;
  isActive: boolean;
  defaultVehicleType: ExpenseVehicleType | null;
  record: DailyExpenseDetail | null;
  values: { distance: string; vehicleType: ExpenseVehicleType | null; notes: string };
  distanceCheck: DistanceCheck;
  dirty: boolean;
  /** Dirty, valid and complete — can be POSTed / PATCHed. */
  saveable: boolean;
  status: RowStatus;
  preview: RowPreview;
}

export interface BuildGridInput {
  drivers: readonly ExpenseDriverSummary[];
  records: readonly DailyExpenseDetail[];
  drafts: Readonly<Record<string, RowDraft>>;
  /** Settings effective on the selected date (null = none configured). */
  settings: FuelSettingsDetail | null;
  includeInactive?: boolean;
}

function consumptionFor(settings: FuelSettingsDetail, vehicle: ExpenseVehicleType): string {
  return vehicle === 'CAR' ? settings.carConsumptionLPer100Km : settings.motorcycleConsumptionLPer100Km;
}

function costPerKmFor(settings: FuelSettingsDetail, vehicle: ExpenseVehicleType): string {
  return vehicle === 'CAR' ? settings.carCostPerKm : settings.motorcycleCostPerKm;
}

/** distance * price per 20 L * consumption * 0.0005, exactly. */
export function previewEstimatedExpense(distance: string, pricePer20Liters: string, consumption: string): string | null {
  const d = parseExactDecimal(distance);
  const p = parseExactDecimal(pricePer20Liters);
  const c = parseExactDecimal(consumption);
  const factor = parseExactDecimal('0.0005');
  if (!d || !p || !c || !factor) return null;
  return formatExactDecimal(multiplyExact(d, p, c, factor));
}

function buildRow(
  driver: ExpenseDriverSummary,
  record: DailyExpenseDetail | null,
  draft: RowDraft | undefined,
  settings: FuelSettingsDetail | null,
): GridRow {
  const values = {
    distance: draft?.distance ?? record?.distanceKm ?? '',
    vehicleType: draft?.vehicleType ?? record?.vehicleType ?? driver.defaultVehicleType,
    notes: draft?.notes ?? record?.notes ?? '',
  };
  const distanceCheck = checkDistance(values.distance);
  const normalizedNotes = values.notes.trim() === '' ? null : values.notes.trim();

  let dirty: boolean;
  if (record) {
    dirty =
      !(distanceCheck.kind === 'valid' && sameDecimal(distanceCheck.value, record.distanceKm)) ||
      values.vehicleType !== record.vehicleType ||
      normalizedNotes !== record.notes;
  } else {
    // A new row is dirty once anything differs from its empty baseline:
    // kilometers typed, notes typed, or a non-default vehicle picked (so the
    // choice is not pruned away before the kilometers are entered).
    dirty =
      values.distance.trim() !== '' ||
      (draft?.notes !== undefined && normalizedNotes !== null) ||
      (draft?.vehicleType !== undefined && draft.vehicleType !== driver.defaultVehicleType);
  }

  const vehicleChanged = record !== null && values.vehicleType !== record.vehicleType;
  let preview: RowPreview;
  if (!values.vehicleType) {
    preview = { costPerKm: null, estimatedExpense: null, isSavedValue: false, unavailable: 'NO_VEHICLE' };
  } else if (record && !vehicleChanged) {
    // The record's own snapshots are authoritative for its date.
    const unchangedDistance = distanceCheck.kind === 'valid' && sameDecimal(distanceCheck.value, record.distanceKm);
    preview = {
      costPerKm: record.costPerKm,
      estimatedExpense:
        distanceCheck.kind === 'valid'
          ? unchangedDistance
            ? record.estimatedExpense
            : previewEstimatedExpense(distanceCheck.value, record.pricePer20LitersSnapshot, record.consumptionLPer100KmSnapshot)
          : null,
      isSavedValue: unchangedDistance,
      unavailable: distanceCheck.kind === 'invalid' ? 'INVALID_DISTANCE' : distanceCheck.kind === 'empty' ? 'EMPTY' : undefined,
    };
  } else if (!settings) {
    preview = { costPerKm: null, estimatedExpense: null, isSavedValue: false, unavailable: 'NO_SETTINGS' };
  } else if (record && settings.id !== record.fuelSettingsId) {
    // A correction keeps the record's ORIGINAL settings version; never
    // preview it with a different version's rates.
    preview = { costPerKm: null, estimatedExpense: null, isSavedValue: false, unavailable: 'SETTINGS_MISMATCH' };
  } else {
    const price = record ? record.pricePer20LitersSnapshot : settings.pricePer20Liters;
    preview = {
      costPerKm: costPerKmFor(settings, values.vehicleType),
      estimatedExpense:
        distanceCheck.kind === 'valid'
          ? previewEstimatedExpense(distanceCheck.value, price, consumptionFor(settings, values.vehicleType))
          : null,
      isSavedValue: false,
      unavailable: distanceCheck.kind === 'invalid' ? 'INVALID_DISTANCE' : distanceCheck.kind === 'empty' ? 'EMPTY' : undefined,
    };
  }

  const saveable =
    dirty &&
    distanceCheck.kind === 'valid' &&
    values.vehicleType !== null &&
    (record !== null || settings !== null);

  const status: RowStatus = dirty
    ? 'unsaved'
    : record
      ? sameDecimal(record.distanceKm, '0')
        ? 'saved-zero'
        : 'saved'
      : 'not-recorded';

  return {
    driverId: driver.driverId,
    displayName: driver.displayName,
    isActive: driver.isActive,
    defaultVehicleType: driver.defaultVehicleType,
    record,
    values,
    distanceCheck,
    dirty,
    saveable,
    status,
    preview,
  };
}

/**
 * One row per driver. Active drivers always appear; an inactive driver
 * appears when requested, or whenever it has a record or an unsaved draft
 * for the date (so nothing recorded or typed is ever hidden).
 */
export function buildGridRows(input: BuildGridInput): GridRow[] {
  const recordByDriver = new Map(input.records.map((r) => [r.driverId, r]));
  const rows: GridRow[] = [];
  const seen = new Set<string>();

  for (const driver of input.drivers) {
    seen.add(driver.driverId);
    const record = recordByDriver.get(driver.driverId) ?? null;
    const draft = input.drafts[driver.driverId];
    if (!driver.isActive && !input.includeInactive && !record && !draft) continue;
    rows.push(buildRow(driver, record, draft, input.settings));
  }
  // A record whose driver is missing from the driver list is still shown.
  for (const record of input.records) {
    if (seen.has(record.driverId)) continue;
    rows.push(
      buildRow(
        {
          driverId: record.driverId,
          displayName: record.driverName,
          isActive: false,
          profileConfigured: false,
          defaultVehicleType: null,
        },
        record,
        input.drafts[record.driverId],
        input.settings,
      ),
    );
  }
  return rows;
}

/* ---------------------------- draft bookkeeping ---------------------------- */

export type DraftsByDate = Record<string, Record<string, RowDraft>>;

export interface DraftBaseline {
  driver: ExpenseDriverSummary;
  record: DailyExpenseDetail | null;
}

/** Does this draft differ from the saved (or empty) baseline? Settings-independent. */
export function isDraftDirty(draft: RowDraft, baseline: DraftBaseline): boolean {
  return buildRow(baseline.driver, baseline.record, draft, null).dirty;
}

function withoutDraft(drafts: DraftsByDate, date: string, driverId: string): DraftsByDate {
  const { [driverId]: _removed, ...rest } = drafts[date] ?? {};
  if (Object.keys(rest).length > 0) return { ...drafts, [date]: rest };
  const { [date]: _emptyDate, ...otherDates } = drafts;
  return otherDates;
}

/**
 * Applies an edit to one driver's draft. If the result no longer differs from
 * the saved values (the admin reverted it), the draft is dropped — and the
 * date too once it has no drafts left — so "unsaved changes" only ever counts
 * genuine changes.
 */
export function applyDraftChange(
  drafts: DraftsByDate,
  date: string,
  driverId: string,
  patch: RowDraft,
  baseline: DraftBaseline,
): DraftsByDate {
  const next = { ...(drafts[date]?.[driverId] ?? {}), ...patch };
  if (!isDraftDirty(next, baseline)) return withoutDraft(drafts, date, driverId);
  return { ...drafts, [date]: { ...(drafts[date] ?? {}), [driverId]: next } };
}

export function removeDraft(drafts: DraftsByDate, date: string, driverId: string): DraftsByDate {
  return withoutDraft(drafts, date, driverId);
}

/**
 * Drops drafts on `date` that no longer differ from the rows' saved values
 * (e.g. after the latest entries were reloaded). Returns the same object when
 * nothing changes, so callers can skip a state update.
 */
export function pruneCleanDrafts(drafts: DraftsByDate, date: string, rows: readonly GridRow[]): DraftsByDate {
  const day = drafts[date];
  if (!day) return drafts;
  let next = drafts;
  for (const row of rows) {
    if (day[row.driverId] && !row.dirty) next = withoutDraft(next, date, row.driverId);
  }
  return next;
}

export function filterGridRows(rows: readonly GridRow[], search: string): GridRow[] {
  const q = search.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((r) => r.displayName.toLowerCase().includes(q));
}

/* --------------------------------- totals --------------------------------- */

export interface DayTotals {
  entries: number;
  distanceKm: string;
  estimatedExpense: string;
}

/** Saved entries only (the date's complete server list). Exact sums. */
export function computeDayTotals(records: readonly DailyExpenseDetail[]): DayTotals {
  const distance = sumExactStrings(records.map((r) => r.distanceKm));
  const expense = sumExactStrings(records.map((r) => r.estimatedExpense));
  return {
    entries: records.length,
    distanceKm: distance ? formatExactDecimal(distance) : '0',
    estimatedExpense: expense ? formatExactDecimal(expense) : '0',
  };
}

/* ------------------------------- requests -------------------------------- */

/** POST body for a new record. The vehicle shown is sent explicitly. */
export function buildCreateRequest(row: GridRow, expenseDate: string): CreateDailyExpenseRequest | null {
  if (row.record || !row.saveable || row.distanceCheck.kind !== 'valid' || !row.values.vehicleType) return null;
  const notes = row.values.notes.trim();
  return {
    driverId: row.driverId,
    expenseDate,
    distanceKm: row.distanceCheck.value,
    vehicleType: row.values.vehicleType,
    ...(notes ? { notes } : {}),
  };
}

/** PATCH body: only changed fields + the compare-and-update guard. */
export function buildUpdateRequest(row: GridRow): UpdateDailyExpenseRequest | null {
  const record = row.record;
  if (!record || !row.saveable || row.distanceCheck.kind !== 'valid' || !row.values.vehicleType) return null;
  const body: UpdateDailyExpenseRequest = { expectedUpdatedAt: record.updatedAt };
  if (!sameDecimal(row.distanceCheck.value, record.distanceKm)) body.distanceKm = row.distanceCheck.value;
  if (row.values.vehicleType !== record.vehicleType) body.vehicleType = row.values.vehicleType;
  const notes = row.values.notes.trim() === '' ? null : row.values.notes.trim();
  if (notes !== record.notes) body.notes = notes;
  return body;
}

/* --------------------------------- errors --------------------------------- */

export type DriverExpenseErrorKind =
  | 'stale'
  | 'duplicate'
  | 'no-settings'
  | 'no-vehicle'
  | 'future-date'
  | 'validation'
  | 'auth'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'network';

export interface DriverExpenseErrorView {
  kind: DriverExpenseErrorKind;
  message: string;
  reason?: string;
}

function reasonOf(error: UnknownApiError): string | undefined {
  const details = getApiErrorDetails(error) as { reason?: unknown } | undefined;
  return typeof details?.reason === 'string' ? details.reason : undefined;
}

export function describeDriverExpenseError(error: UnknownApiError): DriverExpenseErrorView {
  const status = getApiErrorStatus(error);
  const reason = reasonOf(error);
  switch (reason) {
    case 'STALE_DAILY_EXPENSE':
      return {
        kind: 'stale',
        reason,
        message:
          'This entry was changed by someone else after you loaded it. Your values are kept — review the latest saved entry, then save again if needed.',
      };
    case 'DUPLICATE_DAILY_EXPENSE':
      return {
        kind: 'duplicate',
        reason,
        message:
          'An entry already exists for this driver on this date. Nothing was overwritten — review the saved entry; your values are kept.',
      };
    case 'FUEL_SETTINGS_NOT_CONFIGURED':
      return {
        kind: 'no-settings',
        reason,
        message: 'No fuel settings are effective on this date. Configure fuel settings effective on or before it first.',
      };
    case 'VEHICLE_TYPE_NOT_CONFIGURED':
      return { kind: 'no-vehicle', reason, message: 'Select a vehicle type for this driver.' };
    case 'FUTURE_EXPENSE_DATE':
      return { kind: 'future-date', reason, message: 'Expenses cannot be recorded for a future date.' };
    case 'DUPLICATE_EFFECTIVE_DATE':
      return {
        kind: 'conflict',
        reason,
        message: 'Fuel settings already exist for this effective date. Existing settings cannot be changed — choose another date.',
      };
    case 'RETROACTIVE_CONFLICT': {
      const d = getApiErrorDetails(error) as { earliestAffectedExpenseDate?: unknown } | undefined;
      const when = typeof d?.earliestAffectedExpenseDate === 'string' ? ` (from ${d.earliestAffectedExpenseDate})` : '';
      return {
        kind: 'conflict',
        reason,
        message: `Daily expenses were already recorded on or after this date with earlier settings${when}. Choose an effective date after the last recorded entry.`,
      };
    }
  }
  if (status === 400) return { kind: 'validation', message: getApiErrorMessage(error) };
  if (status === 401) return { kind: 'auth', message: 'Your session has expired. Please sign in again.' };
  if (status === 403) return { kind: 'forbidden', message: 'Only administrators can manage driver expenses.' };
  if (status === 404) return { kind: 'not-found', message: getApiErrorMessage(error) };
  if (status === 409) return { kind: 'conflict', message: getApiErrorMessage(error) };
  return { kind: 'network', message: 'Network or server error. Check your connection and try again.' };
}
