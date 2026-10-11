import { useCallback, useEffect, useState } from 'react';
import { useBlocker, useSearchParams } from 'react-router-dom';

import { PageHeader } from '../../../components/data-display/PageHeader';
import { ConfirmationModal } from '../../../components/feedback/ConfirmationModal';
import { cn } from '../../../components/ui/cn';

import { DailyExpensesTab, type DraftsByDate } from './DailyExpensesTab';
import { DriversTab } from './DriversTab';
import { FuelSettingsTab } from './FuelSettingsTab';
import { ReportsTab } from './ReportsTab';
import { defaultReportFilters, type ReportFiltersState } from './reportPeriods';
import { todayUtc } from './dailyExpenseGrid';
import {
  DRIVER_EXPENSES_TABS,
  hasAnyDrafts,
  parseTab,
  resolveSelectedDate,
  type DriverExpensesTabId,
} from './driverExpensesParams';

/**
 * Driver Expenses — ADMIN-only Management page (route guarded by
 * RequireRole; every endpoint is ADMIN-only server-side).
 *
 * An independent module: ESTIMATED fuel expenses per driver per day. It never
 * reads or writes finance, driver cash, settlements, wallets, payouts, orders
 * or the Driver Portal — the only existing data it shows is driver identity.
 *
 * Unsaved daily-entry drafts are owned HERE (keyed by date, then driver id)
 * so switching tabs, dates or filters never discards them; leaving the page
 * with drafts asks for confirmation.
 */
export default function DriverExpensesPage() {
  const [sp, setSp] = useSearchParams();
  const today = todayUtc();
  const tab = parseTab(sp.get('tab'));
  const date = resolveSelectedDate(sp.get('date'), today);

  const [drafts, setDrafts] = useState<DraftsByDate>({});
  // Report filters live here too, so they survive switching tabs.
  const [reportFilters, setReportFilters] = useState<ReportFiltersState>(() => defaultReportFilters(today));
  const unsaved = hasAnyDrafts(drafts);

  const patchParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(sp);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      setSp(next, { replace: true });
    },
    [sp, setSp],
  );

  const selectTab = (id: DriverExpensesTabId) => patchParams({ tab: id === 'daily' ? null : id });
  const selectDate = (d: string) => patchParams({ date: resolveSelectedDate(d, today) === today ? null : d });

  // Leaving the page (not switching tabs/dates) with unsaved entries.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => unsaved && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (!unsaved) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [unsaved]);

  return (
    <div className="space-y-4 sm:space-y-5">
      <PageHeader size="lg" title="Driver Expenses" description="Manage daily fuel expenses and vehicle configurations." />

      <div className="border-b border-line">
        <div role="tablist" aria-label="Driver Expenses sections" className="-mb-px flex gap-1 overflow-x-auto">
          {DRIVER_EXPENSES_TABS.map((t) => {
            const active = t.id === tab;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={active}
                aria-controls={`tabpanel-${t.id}`}
                onClick={() => selectTab(t.id)}
                className={cn(
                  'min-h-11 shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                  active ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-muted hover:text-ink',
                )}
              >
                {t.label}
                {t.id === 'daily' && unsaved && (
                  <span className="ms-1.5 inline-block size-2 rounded-full bg-warning-700" aria-label="unsaved changes" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'daily' && (
          <DailyExpensesTab date={date} today={today} onDateChange={selectDate} drafts={drafts} onDraftsChange={setDrafts} />
        )}
        {tab === 'drivers' && <DriversTab />}
        {tab === 'fuel' && <FuelSettingsTab />}
        {tab === 'reports' && <ReportsTab today={today} filters={reportFilters} onFiltersChange={setReportFilters} />}
      </div>

      <ConfirmationModal
        open={blocker.state === 'blocked'}
        title="Leave with unsaved entries?"
        description="Some daily expense entries have not been saved. Leaving this page discards them."
        confirmLabel="Discard and leave"
        confirmVariant="danger"
        cancelLabel="Stay on page"
        onConfirm={() => blocker.proceed?.()}
        onCancel={() => blocker.reset?.()}
      />
    </div>
  );
}
