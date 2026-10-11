import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Fuel, Plus } from 'lucide-react';

import {
  useCreateFuelSettingsMutation,
  useGetCurrentFuelSettingsQuery,
  useGetFuelSettingsHistoryQuery,
} from '../../../services/driverExpensesApi';
import type { FuelSettingsDetail } from '../../../services/domain.types';
import { getApiErrorMessage, type UnknownApiError } from '../../../services/apiError';
import { formatDateTime } from '../../../lib/format';

import { Card } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { TextField } from '../../../components/forms/Field';
import { DataTable, type DataTableColumn } from '../../../components/data-display/DataTable';
import { Pagination } from '../../../components/data-display/Pagination';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { EmptyState } from '../../../components/feedback/EmptyState';

import { describeDriverExpenseError, todayUtc } from './dailyExpenseGrid';
import { fuelSettingsFormSchema, previewFuelSettings, type FuelSettingsFormValues } from './fuelSettingsForm';
import { displayCalendarDate, displayConsumption, displayMoney, displayRate } from './driverExpenseFormat';

const HISTORY_LIMIT = 10;

/**
 * Fuel Settings tab — the version effective today, a "create new version"
 * form with an exact live preview, and the append-only history (future
 * versions included). No edit/delete: existing versions are immutable.
 */
export function FuelSettingsTab() {
  const current = useGetCurrentFuelSettingsQuery();
  const [page, setPage] = useState(1);
  const history = useGetFuelSettingsHistoryQuery({ page, limit: HISTORY_LIMIT });

  return (
    <div className="space-y-4">
      <CurrentSettingsCard query={current} />
      <CreateFuelSettingsForm onCreated={() => setPage(1)} />

      <Card flush>
        <div className="border-b border-line px-4 py-3 sm:px-5">
          <h2 className="text-sm font-semibold text-ink">Settings history</h2>
          <p className="text-xs text-ink-muted">
            Each daily expense uses the version effective on its date. Versions are never edited.
          </p>
        </div>
        {history.isLoading ? (
          <LoadingState className="py-12" label="Loading history…" />
        ) : history.isError ? (
          <ErrorState
            className="py-12"
            message={getApiErrorMessage(history.error as UnknownApiError)}
            onRetry={() => void history.refetch()}
          />
        ) : (history.data?.items.length ?? 0) === 0 ? (
          <EmptyState className="py-12" title="No fuel settings yet" description="Create the first version above." />
        ) : (
          <>
            <DataTable
              columns={historyColumns(todayUtc())}
              rows={history.data?.items ?? []}
              getRowId={(r) => r.id}
              caption="Fuel settings history"
            />
            {history.data && history.data.meta.totalPages > 1 && (
              <div className="border-t border-line px-4 py-3">
                <Pagination
                  page={history.data.meta.page}
                  totalPages={history.data.meta.totalPages}
                  total={history.data.meta.total}
                  onPageChange={setPage}
                />
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

function historyColumns(today: string): DataTableColumn<FuelSettingsDetail>[] {
  return [
    {
      id: 'effectiveFrom',
      header: 'Effective date',
      cell: (r) => (
        <span className="whitespace-nowrap">
          {displayCalendarDate(r.effectiveFrom)}
          {r.effectiveFrom > today && (
            <span className="ms-2 rounded-badge bg-info-50 px-1.5 py-0.5 text-xs text-info-700">Upcoming</span>
          )}
        </span>
      ),
    },
    { id: 'price', header: 'Price / 20 L', align: 'right', cell: (r) => displayMoney(r.pricePer20Liters) },
    { id: 'perLiter', header: 'Price / L', align: 'right', cell: (r) => displayRate(r.pricePerLiter) },
    {
      id: 'moto',
      header: 'Motorcycle',
      cell: (r) => (
        <span className="whitespace-nowrap text-xs">
          {displayConsumption(r.motorcycleConsumptionLPer100Km)}
          <span className="block text-ink-muted">{displayRate(r.motorcycleCostPerKm)}/km</span>
        </span>
      ),
    },
    {
      id: 'car',
      header: 'Car',
      cell: (r) => (
        <span className="whitespace-nowrap text-xs">
          {displayConsumption(r.carConsumptionLPer100Km)}
          <span className="block text-ink-muted">{displayRate(r.carCostPerKm)}/km</span>
        </span>
      ),
    },
    { id: 'created', header: 'Created', hideBelow: 'md', cell: (r) => formatDateTime(r.createdAt) },
  ];
}

function CurrentSettingsCard({ query }: { query: ReturnType<typeof useGetCurrentFuelSettingsQuery> }) {
  if (query.isLoading) {
    return (
      <Card>
        <LoadingState className="py-6" label="Loading current settings…" />
      </Card>
    );
  }
  if (query.isError || !query.data) {
    return (
      <Card>
        <ErrorState
          className="py-6"
          message={getApiErrorMessage(query.error as UnknownApiError)}
          onRetry={() => void query.refetch()}
        />
      </Card>
    );
  }
  const s = query.data.settings;
  if (!s) {
    return (
      <Card>
        <EmptyState
          className="py-6"
          icon={<Fuel />}
          title="Fuel settings are not configured"
          description={`No settings are effective today (${displayCalendarDate(query.data.date)}). Create a version below before recording daily expenses.`}
        />
      </Card>
    );
  }
  const items: Array<[string, string]> = [
    ['Price for 20 liters', displayMoney(s.pricePer20Liters)],
    ['Price per liter', displayRate(s.pricePerLiter)],
    ['Motorcycle consumption', displayConsumption(s.motorcycleConsumptionLPer100Km)],
    ['Motorcycle cost per km', displayRate(s.motorcycleCostPerKm)],
    ['Car consumption', displayConsumption(s.carConsumptionLPer100Km)],
    ['Car cost per km', displayRate(s.carCostPerKm)],
  ];
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">Current settings</h2>
        <p className="text-xs text-ink-muted">Effective from {displayCalendarDate(s.effectiveFrom)}</p>
      </div>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(([label, value]) => (
          <div key={label} className="rounded-control bg-sunken px-3 py-2">
            <dt className="text-xs text-ink-muted">{label}</dt>
            <dd className="mt-0.5 text-sm font-semibold text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function CreateFuelSettingsForm({ onCreated }: { onCreated: () => void }) {
  const [createSettings, { isLoading }] = useCreateFuelSettingsMutation();
  const [serverError, setServerError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors },
  } = useForm<FuelSettingsFormValues>({
    resolver: zodResolver(fuelSettingsFormSchema),
    defaultValues: {
      pricePer20Liters: '',
      motorcycleConsumptionLPer100Km: '',
      carConsumptionLPer100Km: '',
      effectiveFrom: todayUtc(),
    },
  });

  const preview = previewFuelSettings({
    pricePer20Liters: watch('pricePer20Liters') ?? '',
    motorcycleConsumptionLPer100Km: watch('motorcycleConsumptionLPer100Km') ?? '',
    carConsumptionLPer100Km: watch('carConsumptionLPer100Km') ?? '',
  });

  const submit = handleSubmit(async (values) => {
    if (isLoading) return;
    setServerError(null);
    setNotice(null);
    try {
      const created = await createSettings(values).unwrap();
      setNotice(`Fuel settings effective from ${displayCalendarDate(created.effectiveFrom)} were created.`);
      reset({ pricePer20Liters: '', motorcycleConsumptionLPer100Km: '', carConsumptionLPer100Km: '', effectiveFrom: todayUtc() });
      onCreated();
    } catch (e) {
      setServerError(describeDriverExpenseError(e as UnknownApiError).message);
    }
  });

  return (
    <Card>
      <h2 className="text-sm font-semibold text-ink">Create a new version</h2>
      <p className="mb-4 text-xs text-ink-muted">
        A new version applies from its effective date onward (future dates allowed). Earlier days keep the version they were recorded with.
      </p>
      <form onSubmit={submit} noValidate className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TextField
            label="Price for 20 liters"
            inputMode="decimal"
            placeholder="e.g. 25.50"
            error={errors.pricePer20Liters?.message}
            {...register('pricePer20Liters')}
          />
          <TextField
            label="Motorcycle L/100 km"
            inputMode="decimal"
            placeholder="e.g. 3.40"
            error={errors.motorcycleConsumptionLPer100Km?.message}
            {...register('motorcycleConsumptionLPer100Km')}
          />
          <TextField
            label="Car L/100 km"
            inputMode="decimal"
            placeholder="e.g. 8.75"
            error={errors.carConsumptionLPer100Km?.message}
            {...register('carConsumptionLPer100Km')}
          />
          <TextField label="Effective date" type="date" error={errors.effectiveFrom?.message} {...register('effectiveFrom')} />
        </div>

        <div className="grid grid-cols-1 gap-2 rounded-control border border-line bg-sunken px-3 py-2 text-xs text-ink-secondary sm:grid-cols-3">
          <span>
            Price per liter: <strong className="text-ink">{displayRate(preview.pricePerLiter)}</strong>
          </span>
          <span>
            Motorcycle cost/km: <strong className="text-ink">{displayRate(preview.motorcycleCostPerKm)}</strong>
          </span>
          <span>
            Car cost/km: <strong className="text-ink">{displayRate(preview.carCostPerKm)}</strong>
          </span>
        </div>

        {serverError && (
          <p role="alert" className="rounded-control border border-danger-200 bg-danger-50 px-3 py-2 text-sm text-danger-700">
            {serverError}
          </p>
        )}
        {notice && (
          <p role="status" className="rounded-control border border-success-200 bg-success-50 px-3 py-2 text-sm text-success-700">
            {notice}
          </p>
        )}

        <div className="flex justify-end">
          <Button type="submit" icon={<Plus />} loading={isLoading} className="w-full sm:w-auto">
            Create version
          </Button>
        </div>
      </form>
    </Card>
  );
}
