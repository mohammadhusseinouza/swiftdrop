import { useId, useState, type ReactNode } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { cn } from '../../../components/ui/cn';
import { DateRangeFilter } from '../../../components/filters/DateRangeFilter';
import { useDebouncedValue } from '../../../lib/useDebouncedValue';
import { useGetCustomersQuery, useGetCustomerQuery } from '../../../services/customersApi';
import { useGetDriversQuery, useGetDriverQuery } from '../../../services/driversApi';
import { useGetAreasQuery, useGetPaymentMethodsQuery } from '../../../services/settingsApi';
import {
  ORDER_STATUSES,
  ORDER_TYPES,
  PAYMENT_TYPES,
  getOrderStatusPresentation,
  getOrderTypeLabel,
  getPaymentTypePresentation,
} from '../../../components/orders/orderStatus';
import { ServerSearchSelect } from '../../../components/forms/ServerSearchSelect';
import type { OrdersListState } from './ordersListParams';

interface OrdersFilterBarProps {
  state: OrdersListState;
  onPatch: (patch: Partial<OrdersListState>) => void;
  onClear: () => void;
  hasActive: boolean;
}

const fieldBase =
  'h-9 w-full rounded-control border px-2 text-sm disabled:opacity-50';

/** Select styling — a filled brand tint signals an active (non-default) value. */
const fieldCls = (active: boolean) =>
  cn(
    fieldBase,
    active
      ? 'border-brand-600 bg-brand-50 text-brand-700'
      : 'border-line bg-card text-ink',
  );

function Labeled({
  label,
  children,
  /** Width utility for the field wrapper (default full-width; primary row narrows it). */
  width = 'w-full',
}: {
  label: string;
  children: ReactNode;
  width?: string;
}) {
  return (
    <label
      className={cn(
        'flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-muted',
        width,
      )}
    >
      {label}
      {children}
    </label>
  );
}

export function OrdersFilterBar({
  state,
  onPatch,
  onClear,
  hasActive,
}: OrdersFilterBarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const advancedId = useId();

  const [customerTerm, setCustomerTerm] = useState('');
  const [driverTerm, setDriverTerm] = useState('');
  const debouncedCustomerTerm = useDebouncedValue(customerTerm, 300);
  const debouncedDriverTerm = useDebouncedValue(driverTerm, 300);

  const areas = useGetAreasQuery({ isActive: true, limit: 100 });
  // Bounded reference collection (plain array from the backend) — loaded whole.
  const paymentMethods = useGetPaymentMethodsQuery({ isActive: true });
  const customers = useGetCustomersQuery({
    search: debouncedCustomerTerm.trim() || undefined,
    isActive: true,
    limit: 20,
  });
  const drivers = useGetDriversQuery({
    search: debouncedDriverTerm.trim() || undefined,
    isActive: true,
    limit: 20,
  });
  const selectedCustomer = useGetCustomerQuery(state.customerId, {
    skip: !state.customerId,
  });
  const selectedDriver = useGetDriverQuery(state.driverId, {
    skip: !state.driverId,
  });

  // Secondary filters that live behind "More filters".
  const advancedActive = Boolean(
    state.paymentType ||
      state.paymentMethodId ||
      state.deliveryStatus ||
      state.assignmentStatus ||
      state.createdFrom ||
      state.createdTo,
  );

  return (
    <div role="search" className="space-y-4">
      {/* Primary operational filters — always visible, one compact row. */}
      <div className="flex flex-wrap items-end gap-2">
        <Labeled label="Status" width="w-full sm:w-44">
          <select
            className={fieldCls(state.status !== '')}
            value={state.status}
            onChange={(e) => onPatch({ status: e.target.value })}
          >
            <option value="">Any status</option>
            {ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {getOrderStatusPresentation(s).label}
              </option>
            ))}
          </select>
        </Labeled>

        <ServerSearchSelect
          label="Driver"
          anyLabel="Any driver"
          searchPlaceholder="Search drivers…"
          value={state.driverId}
          onChange={(id) => onPatch({ driverId: id })}
          searchTerm={driverTerm}
          onSearchTermChange={setDriverTerm}
          loading={drivers.isFetching}
          total={drivers.data?.meta.total}
          options={(drivers.data?.items ?? []).map((d) => ({
            id: d.id,
            label: `${d.driverNumber} · ${d.user.firstName} ${d.user.lastName}`,
          }))}
          selectedLabel={
            selectedDriver.data
              ? `${selectedDriver.data.driverNumber} · ${selectedDriver.data.user.firstName} ${selectedDriver.data.user.lastName}`
              : undefined
          }
        />

        <ServerSearchSelect
          label="Customer"
          anyLabel="Any customer"
          searchPlaceholder="Search customers…"
          value={state.customerId}
          onChange={(id) => onPatch({ customerId: id })}
          searchTerm={customerTerm}
          onSearchTermChange={setCustomerTerm}
          loading={customers.isFetching}
          total={customers.data?.meta.total}
          options={(customers.data?.items ?? []).map((c) => ({
            id: c.id,
            label: `${c.customerNumber} · ${c.name}`,
          }))}
          selectedLabel={
            selectedCustomer.data
              ? `${selectedCustomer.data.customerNumber} · ${selectedCustomer.data.name}`
              : undefined
          }
        />

        <Labeled label="Area" width="w-full sm:w-44">
          <select
            className={fieldCls(state.areaId !== '')}
            value={state.areaId}
            disabled={areas.isLoading}
            onChange={(e) => onPatch({ areaId: e.target.value })}
          >
            <option value="">
              {areas.isLoading ? 'Loading areas…' : 'Any area'}
            </option>
            {(areas.data?.items ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Labeled>

        <Labeled label="Order type" width="w-full sm:w-44">
          <select
            className={fieldCls(state.orderType !== '')}
            value={state.orderType}
            onChange={(e) => onPatch({ orderType: e.target.value })}
          >
            <option value="">Any type</option>
            {ORDER_TYPES.map((t) => (
              <option key={t} value={t}>
                {getOrderTypeLabel(t)}
              </option>
            ))}
          </select>
        </Labeled>

        <div className="flex items-center gap-2 self-end pb-px">
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            aria-controls={advancedId}
            className={cn(
              'inline-flex h-9 items-center gap-1.5 rounded-control border border-dashed px-3 text-sm transition-colors',
              moreOpen || advancedActive
                ? 'border-brand-600 text-brand-600'
                : 'border-line-strong text-ink-muted hover:border-brand-600 hover:text-brand-600',
            )}
          >
            <SlidersHorizontal className="size-4" aria-hidden="true" />
            {moreOpen ? 'Fewer filters' : 'More filters'}
            {advancedActive && !moreOpen && (
              <span
                className="size-1.5 rounded-full bg-brand-600"
                aria-hidden="true"
              />
            )}
          </button>

          {hasActive && (
            <button
              type="button"
              onClick={onClear}
              className="text-sm font-medium text-brand-600 hover:text-brand-700"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* Secondary filters — same card, revealed on demand. */}
      <div
        id={advancedId}
        hidden={!moreOpen}
        className="border-t border-line pt-4"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Labeled label="Payment type">
            <select
              className={fieldCls(state.paymentType !== '')}
              value={state.paymentType}
              onChange={(e) => onPatch({ paymentType: e.target.value })}
            >
              <option value="">Any payment type</option>
              {PAYMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {getPaymentTypePresentation(t).label}
                </option>
              ))}
            </select>
          </Labeled>

          <Labeled label="Payment method">
            <select
              className={fieldCls(state.paymentMethodId !== '')}
              value={state.paymentMethodId}
              disabled={paymentMethods.isLoading}
              title="Orders using this method for prepaid payment or collection"
              onChange={(e) => onPatch({ paymentMethodId: e.target.value })}
            >
              <option value="">
                {paymentMethods.isLoading
                  ? 'Loading methods…'
                  : 'Any payment method'}
              </option>
              {(paymentMethods.data ?? []).map((pm) => (
                <option key={pm.id} value={pm.id}>
                  {pm.name}
                </option>
              ))}
            </select>
          </Labeled>

          <Labeled label="Delivery status">
            <select
              className={fieldCls(state.deliveryStatus !== '')}
              value={state.deliveryStatus}
              onChange={(e) =>
                onPatch({
                  deliveryStatus: e.target
                    .value as OrdersListState['deliveryStatus'],
                })
              }
            >
              <option value="">Any</option>
              <option value="DELIVERED">Delivered</option>
              <option value="UNDELIVERED">Undelivered</option>
            </select>
          </Labeled>

          <Labeled label="Assignment">
            <select
              className={fieldCls(state.assignmentStatus !== '')}
              value={state.assignmentStatus}
              onChange={(e) =>
                onPatch({
                  assignmentStatus: e.target
                    .value as OrdersListState['assignmentStatus'],
                })
              }
            >
              <option value="">Any</option>
              <option value="ASSIGNED">Assigned</option>
              <option value="UNASSIGNED">Unassigned</option>
            </select>
          </Labeled>

          <DateRangeFilter
            className="sm:col-span-2 lg:col-span-2"
            fromLabel="Created from"
            toLabel="Created to"
            value={{ from: state.createdFrom, to: state.createdTo }}
            onChange={(range) =>
              onPatch({ createdFrom: range.from, createdTo: range.to })
            }
          />
        </div>
      </div>
    </div>
  );
}
