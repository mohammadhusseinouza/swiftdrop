import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, NotebookPen, RotateCcw, Save } from 'lucide-react';

import {
  useCreateDailyExpenseMutation,
  useGetAllExpenseDriversQuery,
  useGetDailyExpensesForDateQuery,
  useGetEffectiveFuelSettingsQuery,
  useUpdateDailyExpenseMutation,
} from '../../../services/driverExpensesApi';
import type { ExpenseVehicleType } from '../../../services/domain.types';
import { getApiErrorMessage, type UnknownApiError } from '../../../services/apiError';
import { MD_QUERY, useMediaQuery } from '../../../lib/useMediaQuery';

import { Card } from '../../../components/ui/Card';
import { Badge, type BadgeTone } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { cn } from '../../../components/ui/cn';
import { SearchInput } from '../../../components/filters/SearchInput';
import { StatisticCard } from '../../../components/data-display/StatisticCard';
import { DataTable, type DataTableColumn } from '../../../components/data-display/DataTable';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { EmptyState } from '../../../components/feedback/EmptyState';

import {
  applyDraftChange,
  buildCreateRequest,
  buildGridRows,
  pruneCleanDrafts,
  removeDraft,
  buildUpdateRequest,
  computeDayTotals,
  describeDriverExpenseError,
  filterGridRows,
  shiftDate,
  type DriverExpenseErrorView,
  type GridRow,
  type PreviewUnavailable,
  type DraftsByDate,
  type RowDraft,
} from './dailyExpenseGrid';
import {
  VEHICLE_LABEL,
  VEHICLE_OPTIONS,
  displayCalendarDate,
  displayKm,
  displayMoney,
  displayRate,
} from './driverExpenseFormat';

export type { DraftsByDate };

interface RowFeedback {
  saving?: boolean;
  error?: DriverExpenseErrorView;
  notice?: string;
}

const UNAVAILABLE_HINT: Record<PreviewUnavailable, string> = {
  EMPTY: '',
  INVALID_DISTANCE: 'Fix the distance',
  NO_VEHICLE: 'Select a vehicle',
  NO_SETTINGS: 'No fuel settings for this date',
  SETTINGS_MISMATCH: 'Calculated on save',
};

const STATUS_BADGE: Record<GridRow['status'], { tone: BadgeTone; label: string }> = {
  'not-recorded': { tone: 'neutral', label: 'Not recorded' },
  'saved-zero': { tone: 'info', label: 'Saved · 0 km' },
  saved: { tone: 'success', label: 'Saved' },
  unsaved: { tone: 'warning', label: 'Unsaved changes' },
};

export interface DailyExpensesTabProps {
  date: string;
  today: string;
  onDateChange: (date: string) => void;
  drafts: DraftsByDate;
  onDraftsChange: (update: (prev: DraftsByDate) => DraftsByDate) => void;
}

/**
 * Daily Expenses tab — one row per driver for the selected date. Saved
 * entries come from the server (by-date); unsaved edits are drafts owned by
 * the page (so tab switches, date changes and searching never lose them).
 * Nothing is written by visiting: only an explicit Save POSTs (new) or
 * PATCHes (correction, with the compare-and-update guard).
 */
export function DailyExpensesTab({ date, today, onDateChange, drafts, onDraftsChange }: DailyExpensesTabProps) {
  const isDesktop = useMediaQuery(MD_QUERY);
  const drivers = useGetAllExpenseDriversQuery();
  const records = useGetDailyExpensesForDateQuery(date);
  const effective = useGetEffectiveFuelSettingsQuery(date);
  const [createExpense] = useCreateDailyExpenseMutation();
  const [updateExpense] = useUpdateDailyExpenseMutation();

  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [openNotes, setOpenNotes] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState<Record<string, RowFeedback>>({});
  const [savingAll, setSavingAll] = useState(false);

  const dayDrafts = useMemo(() => drafts[date] ?? {}, [drafts, date]);
  const settings = effective.data?.settings ?? null;
  const settingsKnown = effective.isSuccess;

  const allRows = useMemo(
    () =>
      buildGridRows({
        drivers: drivers.data ?? [],
        records: records.data ?? [],
        drafts: dayDrafts,
        settings,
        includeInactive,
      }),
    [drivers.data, records.data, dayDrafts, settings, includeInactive],
  );
  const rows = useMemo(() => filterGridRows(allRows, search), [allRows, search]);
  const totals = useMemo(() => computeDayTotals(records.data ?? []), [records.data]);
  const saveableRows = allRows.filter((r) => r.saveable);
  const fbKey = (driverId: string) => `${date}:${driverId}`;

  // Only GENUINE differences from the saved values are kept as drafts: an
  // edit that is reverted drops the draft (and its date), so the unsaved
  // counter and the leave-page prompt never fire for no real change.
  const setDraft = (driverId: string, patch: RowDraft) => {
    const row = allRows.find((r) => r.driverId === driverId);
    if (!row) return;
    const baseline = {
      driver: {
        driverId: row.driverId,
        displayName: row.displayName,
        isActive: row.isActive,
        profileConfigured: row.defaultVehicleType !== null,
        defaultVehicleType: row.defaultVehicleType,
      },
      record: row.record,
    };
    onDraftsChange((prev) => applyDraftChange(prev, date, driverId, patch, baseline));
  };

  const clearDraft = (driverId: string) => onDraftsChange((prev) => removeDraft(prev, date, driverId));

  // When saved entries reload (e.g. "Load latest saved entry"), a draft that
  // now equals the saved values is no longer an unsaved change.
  useEffect(() => {
    onDraftsChange((prev) => pruneCleanDrafts(prev, date, allRows));
  }, [allRows, date, onDraftsChange]);

  const setRowFeedback = (driverId: string, value: RowFeedback) =>
    setFeedback((f) => ({ ...f, [fbKey(driverId)]: value }));

  /** Saves one row. Returns true on success. Never retries or overwrites. */
  const saveRow = async (row: GridRow): Promise<boolean> => {
    if (feedback[fbKey(row.driverId)]?.saving) return false;
    const create = buildCreateRequest(row, date);
    const update = buildUpdateRequest(row);
    if (!create && !update) return false;
    setRowFeedback(row.driverId, { saving: true });
    try {
      if (create) await createExpense(create).unwrap();
      else if (update && row.record) await updateExpense({ id: row.record.id, expenseDate: date, body: update }).unwrap();
      clearDraft(row.driverId);
      setRowFeedback(row.driverId, { notice: row.record ? 'Correction saved.' : 'Saved.' });
      return true;
    } catch (e) {
      const view = describeDriverExpenseError(e as UnknownApiError);
      setRowFeedback(row.driverId, { error: view });
      // Duplicate: someone else created it — load it so the admin can review
      // it next to their (kept) values. Nothing is overwritten.
      if (view.kind === 'duplicate') void records.refetch();
      return false;
    }
  };

  const saveAll = async () => {
    if (savingAll) return;
    setSavingAll(true);
    try {
      // Sequential: one request at a time, each row independently reported.
      for (const row of saveableRows) await saveRow(row);
    } finally {
      setSavingAll(false);
    }
  };

  const reloadLatest = (driverId: string) => {
    setRowFeedback(driverId, {
      notice: 'Latest saved entry loaded. Your unsaved values are still shown — save again to apply them.',
    });
    void records.refetch();
  };

  /* -------------------------------- render -------------------------------- */

  const loading = drivers.isLoading || records.isLoading || effective.isLoading;
  const loadError = drivers.isError ? drivers.error : records.isError ? records.error : effective.isError ? effective.error : null;

  const vehicleSelect = (row: GridRow) => (
    <>
      <label className="sr-only" htmlFor={`veh-${row.driverId}`}>
        Vehicle for {row.displayName}
      </label>
      <select
        id={`veh-${row.driverId}`}
        value={row.values.vehicleType ?? ''}
        onChange={(e) => setDraft(row.driverId, { vehicleType: e.target.value as ExpenseVehicleType })}
        className="h-10 w-full min-w-32 rounded-control border border-line bg-card px-2 text-sm text-ink"
      >
        {!row.values.vehicleType && <option value="">Select…</option>}
        {VEHICLE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </>
  );

  const distanceInput = (row: GridRow) => (
    <>
      <label className="sr-only" htmlFor={`km-${row.driverId}`}>
        Kilometers for {row.displayName}
      </label>
      <input
        id={`km-${row.driverId}`}
        inputMode="decimal"
        autoComplete="off"
        placeholder="—"
        value={row.values.distance}
        onChange={(e) => setDraft(row.driverId, { distance: e.target.value })}
        aria-invalid={row.distanceCheck.kind === 'invalid' || undefined}
        className={cn(
          'h-10 w-full min-w-24 rounded-control border bg-card px-3 text-right text-sm tabular-nums text-ink',
          row.distanceCheck.kind === 'invalid' ? 'border-danger-200' : 'border-line',
        )}
      />
      {row.distanceCheck.kind === 'invalid' && <p className="mt-1 text-xs text-danger-700">{row.distanceCheck.message}</p>}
    </>
  );

  const estimateCell = (row: GridRow) => {
    if (row.preview.estimatedExpense !== null) {
      return (
        <span className="tabular-nums">
          {displayMoney(row.preview.estimatedExpense)}
          {!row.preview.isSavedValue && <span className="ms-1 text-xs text-ink-muted">(preview)</span>}
        </span>
      );
    }
    const hint = row.preview.unavailable ? UNAVAILABLE_HINT[row.preview.unavailable] : '';
    return <span className="text-xs text-ink-muted">{hint || '—'}</span>;
  };

  const statusBadge = (row: GridRow) => {
    const fb = feedback[fbKey(row.driverId)];
    if (fb?.saving) return <Badge tone="brand">Saving…</Badge>;
    if (fb?.error && (fb.error.kind === 'stale' || fb.error.kind === 'duplicate')) return <Badge tone="danger">Conflict</Badge>;
    const s = STATUS_BADGE[row.status];
    return <Badge tone={s.tone}>{s.label}</Badge>;
  };

  const actions = (row: GridRow) => {
    const fb = feedback[fbKey(row.driverId)];
    const notesOpen = openNotes[row.driverId] ?? false;
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            className="h-9"
            icon={<Save />}
            disabled={!row.saveable || savingAll}
            loading={fb?.saving}
            onClick={() => void saveRow(row)}
          >
            {row.record ? 'Save correction' : 'Save'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-9"
            icon={<NotebookPen />}
            aria-expanded={notesOpen}
            onClick={() => setOpenNotes((o) => ({ ...o, [row.driverId]: !notesOpen }))}
          >
            Notes
          </Button>
          {row.dirty && (
            <Button size="sm" variant="ghost" className="h-9" onClick={() => clearDraft(row.driverId)}>
              Discard
            </Button>
          )}
        </div>
        {notesOpen && (
          <textarea
            aria-label={`Notes for ${row.displayName}`}
            value={row.values.notes}
            maxLength={1000}
            rows={2}
            onChange={(e) => setDraft(row.driverId, { notes: e.target.value })}
            className="w-full rounded-control border border-line bg-card px-2 py-1.5 text-sm text-ink"
            placeholder="Optional notes"
          />
        )}
        {fb?.error && (
          <div role="alert" className="rounded-control border border-danger-200 bg-danger-50 px-2 py-1.5 text-xs text-danger-700">
            {fb.error.message}
            {fb.error.kind === 'stale' && (
              <Button size="sm" variant="secondary" className="mt-1.5 flex" icon={<RotateCcw />} onClick={() => reloadLatest(row.driverId)}>
                Load latest saved entry
              </Button>
            )}
          </div>
        )}
        {fb?.notice && !fb.error && (
          <p role="status" className="text-xs text-success-700">
            {fb.notice}
          </p>
        )}
      </div>
    );
  };

  const driverCell = (row: GridRow) => (
    <div className="min-w-0">
      <p className="font-medium text-ink">{row.displayName}</p>
      <p className="text-xs text-ink-muted">
        {!row.isActive && 'Inactive · '}
        {row.defaultVehicleType ? `Default: ${VEHICLE_LABEL[row.defaultVehicleType]}` : 'No default vehicle'}
      </p>
    </div>
  );

  const columns: DataTableColumn<GridRow>[] = [
    { id: 'driver', header: 'Driver', cell: driverCell },
    { id: 'vehicle', header: 'Vehicle', cell: vehicleSelect, className: 'w-40' },
    { id: 'km', header: 'Distance (km)', cell: distanceInput, className: 'w-36' },
    { id: 'rate', header: 'Cost / km', align: 'right', cell: (r) => <span className="tabular-nums">{displayRate(r.preview.costPerKm)}</span> },
    { id: 'estimate', header: 'Est. fuel expense', align: 'right', cell: estimateCell },
    { id: 'status', header: 'Status', cell: statusBadge },
    { id: 'actions', header: 'Actions', cell: actions, className: 'w-64' },
  ];

  const unsavedOtherDates = Object.entries(drafts).filter(
    ([d, byDriver]) => d !== date && Object.keys(byDriver).length > 0,
  ).length;

  return (
    <div className="space-y-4">
      {/* date navigation + totals */}
      <Card className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <Button variant="secondary" size="sm" className="h-10" icon={<ChevronLeft />} onClick={() => onDateChange(shiftDate(date, -1))}>
            Previous day
          </Button>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
            Date
            <input
              type="date"
              value={date}
              max={today}
              onChange={(e) => e.target.value && onDateChange(e.target.value)}
              className="h-10 rounded-control border border-line bg-card px-2 text-sm text-ink"
            />
          </label>
          <Button
            variant="secondary"
            size="sm"
            className="h-10"
            disabled={date >= today}
            onClick={() => onDateChange(shiftDate(date, 1))}
          >
            Next day
            <ChevronRight className="size-4" aria-hidden="true" />
          </Button>
          {date !== today && (
            <Button variant="ghost" size="sm" className="h-10" onClick={() => onDateChange(today)}>
              Today
            </Button>
          )}
          <div className="ms-auto">
            <Button
              icon={<Save />}
              disabled={saveableRows.length === 0}
              loading={savingAll}
              onClick={() => void saveAll()}
              className="w-full sm:w-auto"
            >
              Save all changes{saveableRows.length > 0 ? ` (${saveableRows.length})` : ''}
            </Button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <StatisticCard label="Drivers with entries" value={records.data ? String(totals.entries) : '…'} />
          <StatisticCard label="Total distance" value={records.data ? displayKm(totals.distanceKm) : '…'} />
          <StatisticCard
            label="Estimated fuel expense"
            value={records.data ? displayMoney(totals.estimatedExpense) : '…'}
            supportingText="Saved entries only — an estimate, not a payment"
          />
        </div>

        {settingsKnown && !settings && (
          <div role="alert" className="rounded-control border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-ink-secondary">
            No fuel settings are effective on {displayCalendarDate(date)}. Configure fuel settings effective on or before this date in the
            Fuel Settings tab before recording expenses for it.
          </div>
        )}
        {settings && (
          <p className="text-xs text-ink-muted">
            Using fuel settings effective from {displayCalendarDate(settings.effectiveFrom)} ({displayMoney(settings.pricePer20Liters)} per 20
            L). Saved entries keep the settings they were recorded with.
          </p>
        )}
        {unsavedOtherDates > 0 && (
          <p className="text-xs text-warning-700">
            You also have unsaved changes on {unsavedOtherDates} other {unsavedOtherDates === 1 ? 'date' : 'dates'}.
          </p>
        )}
      </Card>

      {/* filters */}
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} onClear={() => setSearch('')} placeholder="Filter drivers…" className="min-w-0 flex-1" />
        <label className="flex items-center gap-2 text-sm text-ink-secondary">
          <input type="checkbox" className="size-4" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          Include inactive drivers
        </label>
      </div>

      {loading ? (
        <Card flush>
          <LoadingState className="py-16" label="Loading drivers and entries…" />
        </Card>
      ) : loadError ? (
        <Card flush>
          <ErrorState
            className="py-16"
            message={getApiErrorMessage(loadError as UnknownApiError)}
            onRetry={() => {
              void drivers.refetch();
              void records.refetch();
              void effective.refetch();
            }}
          />
        </Card>
      ) : rows.length === 0 ? (
        <Card flush>
          <EmptyState
            className="py-16"
            title={search ? 'No drivers match this filter' : 'No drivers to show'}
            description={search ? 'Clear the filter to see all drivers. Unsaved values are kept.' : 'Drivers are managed on the Drivers page.'}
          />
        </Card>
      ) : isDesktop ? (
        <Card flush>
          <DataTable columns={columns} rows={rows} getRowId={(r) => r.driverId} caption={`Daily fuel expenses for ${date}`} />
        </Card>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.driverId}>
              <Card className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  {driverCell(row)}
                  {statusBadge(row)}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>{vehicleSelect(row)}</div>
                  <div>{distanceInput(row)}</div>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-ink-muted">Cost / km {displayRate(row.preview.costPerKm)}</span>
                  {estimateCell(row)}
                </div>
                {actions(row)}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
