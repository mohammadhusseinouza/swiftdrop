import { useId, useState } from 'react';

import { cn } from '../../../components/ui/cn';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { OrderTypeBadge } from '../../../components/orders/OrderTypeBadge';
import { Pagination } from '../../../components/data-display/Pagination';
import { isMoneyInputText } from '../../../components/forms/MoneyInput';
import { formatDate, formatMoney } from '../../../lib/format';
import type {
  DriverOutstandingCollections,
  OutstandingCollection,
} from '../../../services/settlementsApi';

import {
  MAX_ALLOCATIONS_PER_SETTLEMENT,
  allocationRowStatus,
  clearSelections,
  deselectCollection,
  isSelectable,
  preselectOldestFirst,
  selectCollection,
  setAllocationAmount,
  setFullOutstanding,
  type AllocationDraft,
} from './settlementAllocation';
import { ALLOCATION_ROW_STATUS, reviewStatusLabel } from './settlementPresentation';

/**
 * FR.9 — outstanding settlement-mode collections of the selected driver and
 * the explicit per-collection allocation amounts (page_structure §16.1).
 * Finance selects rows; "Preselect oldest first" only fills the form. The
 * list is server-paginated (oldest first); selections persist across pages
 * because each one keeps the row it was chosen from.
 */
export interface OutstandingCollectionsPanelProps {
  position: DriverOutstandingCollections;
  page: number;
  totalPages: number;
  total: number;
  onPageChange: (page: number) => void;
  fetching: boolean;
  draft: AllocationDraft;
  onDraftChange: (draft: AllocationDraft) => void;
  rowErrors: Record<string, string>;
  isDesktop: boolean;
  disabled?: boolean;
}

export function OutstandingCollectionsPanel({
  position,
  page,
  totalPages,
  total,
  onPageChange,
  fetching,
  draft,
  onDraftChange,
  rowErrors,
  isDesktop,
  disabled,
}: OutstandingCollectionsPanelProps) {
  const preselectId = useId();
  const [upTo, setUpTo] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const items = position.items;
  const selectedCount = Object.keys(draft.selections).length;
  const onOtherPages = Object.keys(draft.selections).filter(
    (id) => !items.some((i) => i.releaseId === id),
  ).length;

  const toggle = (item: OutstandingCollection, checked: boolean) => {
    setNotice(null);
    if (!checked) {
      onDraftChange(deselectCollection(draft, item.releaseId));
      return;
    }
    const result = selectCollection(draft, item);
    if (result.ok) onDraftChange(result.draft);
    else
      setNotice(
        result.reason === 'LIMIT_REACHED'
          ? `At most ${MAX_ALLOCATIONS_PER_SETTLEMENT} collections can be allocated in one settlement.`
          : 'This collection cannot be selected.',
      );
  };

  const preselect = () => {
    const next = preselectOldestFirst(draft, items, upTo);
    if (!next) {
      setNotice('Enter a valid amount to preselect up to, or leave it blank to preselect every collection on this page.');
      return;
    }
    setNotice(null);
    onDraftChange(next);
  };

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-1 gap-2 rounded-control border border-line-subtle bg-sunken px-3 py-2.5 text-sm sm:grid-cols-3">
        <PositionFigure label="Current cash held" value={position.cashBalance} emphasis />
        <PositionFigure
          label="Attributed (collections)"
          value={position.attributedOutstanding}
          hint="Reserved for the orders below"
        />
        <PositionFigure
          label="Unattributed"
          value={position.unattributedBalance}
          hint="Legacy collections, adjustments, corrections"
        />
      </dl>

      {items.length === 0 && total === 0 ? (
        <p className="rounded-control border border-line-subtle bg-sunken px-3 py-2 text-sm text-ink-muted">
          This driver has no outstanding settlement-mode collections. Only
          unattributed cash can be settled.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <label htmlFor={preselectId} className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
              Preselect oldest first up to
              <span className="relative">
                <span aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-ink-muted">$</span>
                <input
                  id={preselectId}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="All"
                  value={upTo}
                  disabled={disabled}
                  onChange={(e) => {
                    if (isMoneyInputText(e.target.value)) setUpTo(e.target.value.trim());
                  }}
                  className="h-9 w-32 rounded-control border border-line bg-card pl-6 pr-2 text-sm text-ink"
                />
              </span>
            </label>
            <Button type="button" variant="secondary" size="sm" onClick={preselect} disabled={disabled}>
              Preselect
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setNotice(null);
                onDraftChange(clearSelections(draft));
              }}
              disabled={disabled || selectedCount === 0}
            >
              Clear selection
            </Button>
            <p className="ml-auto text-xs text-ink-muted" aria-live="polite">
              {selectedCount} of {MAX_ALLOCATIONS_PER_SETTLEMENT} collections selected
              {onOtherPages > 0 ? ` (${onOtherPages} on other pages)` : ''}
              {fetching ? ' · refreshing…' : ''}
            </p>
          </div>
          <p className="text-xs text-ink-muted">
            Preselection only fills the form. Nothing is allocated until you
            confirm the settlement.
          </p>

          {notice && (
            <p role="alert" className="rounded-control border border-warning-200 bg-warning-50 px-3 py-2 text-xs text-warning-700">
              {notice}
            </p>
          )}

          {isDesktop ? (
            <div className="overflow-x-auto rounded-control border border-line">
              <table className="w-full text-sm">
                <caption className="sr-only">Outstanding collections</caption>
                <thead className="bg-sunken text-left text-xs text-ink-muted">
                  <tr>
                    <th scope="col" className="w-10 px-3 py-2"><span className="sr-only">Select</span></th>
                    <th scope="col" className="px-3 py-2">Order</th>
                    <th scope="col" className="px-3 py-2">Customer</th>
                    <th scope="col" className="px-3 py-2 text-right">Collection</th>
                    <th scope="col" className="px-3 py-2 text-right">Settled before</th>
                    <th scope="col" className="px-3 py-2 text-right">Outstanding</th>
                    <th scope="col" className="px-3 py-2">Allocate</th>
                    <th scope="col" className="px-3 py-2">Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-subtle">
                  {items.map((item) => (
                    <CollectionRow
                      key={item.releaseId}
                      layout="row"
                      item={item}
                      draft={draft}
                      error={rowErrors[item.releaseId]}
                      disabled={disabled}
                      onToggle={toggle}
                      onDraftChange={onDraftChange}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <ul className="space-y-2">
              {items.map((item) => (
                <li key={item.releaseId}>
                  <CollectionRow
                    layout="card"
                    item={item}
                    draft={draft}
                    error={rowErrors[item.releaseId]}
                    disabled={disabled}
                    onToggle={toggle}
                    onDraftChange={onDraftChange}
                  />
                </li>
              ))}
            </ul>
          )}

          {totalPages > 1 && (
            <Pagination page={page} totalPages={totalPages} total={total} onPageChange={onPageChange} />
          )}
        </>
      )}
    </div>
  );
}

function PositionFigure({
  label,
  value,
  hint,
  emphasis,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className={cn('tabular-nums', emphasis ? 'font-semibold text-ink' : 'font-medium text-ink-secondary')}>
        {formatMoney(value)}
      </dd>
      {hint && <dd className="text-[11px] text-ink-subtle">{hint}</dd>}
    </div>
  );
}

function CollectionRow({
  layout,
  item,
  draft,
  error,
  disabled,
  onToggle,
  onDraftChange,
}: {
  layout: 'row' | 'card';
  item: OutstandingCollection;
  draft: AllocationDraft;
  error?: string;
  disabled?: boolean;
  onToggle: (item: OutstandingCollection, checked: boolean) => void;
  onDraftChange: (draft: AllocationDraft) => void;
}) {
  const amountId = useId();
  const errorId = useId();
  const selection = draft.selections[item.releaseId];
  const selectable = isSelectable(item);
  const review = reviewStatusLabel(item.reviewStatus);
  const status = selection ? ALLOCATION_ROW_STATUS[allocationRowStatus(selection)] : null;
  const label = `Allocate to order ${item.order.orderNumber}`;

  const checkbox = (
    <input
      type="checkbox"
      className="size-4 accent-brand-600"
      checked={!!selection}
      disabled={disabled || (!selectable && !selection)}
      aria-label={label}
      onChange={(e) => onToggle(item, e.target.checked)}
    />
  );

  const amountInput = selection ? (
    <div className="flex items-center gap-1.5">
      <span className="relative">
        <span aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-ink-muted">$</span>
        <input
          id={amountId}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          aria-label={`Amount for order ${item.order.orderNumber}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          value={selection.amount}
          disabled={disabled}
          onChange={(e) => {
            if (isMoneyInputText(e.target.value)) {
              onDraftChange(setAllocationAmount(draft, item.releaseId, e.target.value.trim()));
            }
          }}
          className={cn(
            'h-8 w-28 rounded-control border bg-card pl-5 pr-2 text-sm tabular-nums text-ink',
            error ? 'border-danger-200' : 'border-line',
          )}
        />
      </span>
      <button
        type="button"
        className="text-xs font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50"
        disabled={disabled}
        onClick={() => onDraftChange(setFullOutstanding(draft, item.releaseId))}
      >
        Full
      </button>
    </div>
  ) : null;

  const errorText = error ? (
    <p id={errorId} className="mt-1 text-xs text-danger-700">
      {error}
    </p>
  ) : null;

  const badges = (
    <span className="flex flex-wrap gap-1">
      {status && <Badge tone={status.tone}>{status.label}</Badge>}
      {review && <Badge tone={review.tone}>{review.label}</Badge>}
    </span>
  );

  if (layout === 'row') {
    return (
      <tr className={cn(selection && 'bg-brand-50/40')}>
        <td className="px-3 py-2 align-top">{checkbox}</td>
        <td className="px-3 py-2 align-top">
          <span className="block font-medium text-ink">{item.order.orderNumber}</span>
          <span className="block text-xs text-ink-muted">Delivered {formatDate(item.deliveredAt)}</span>
        </td>
        <td className="px-3 py-2 align-top">
          <span className="block text-ink">{item.customer.name}</span>
          <OrderTypeBadge orderType={item.orderType} className="mt-0.5" />
        </td>
        <td className="px-3 py-2 text-right align-top tabular-nums">{formatMoney(item.collectionAmount)}</td>
        <td className="px-3 py-2 text-right align-top tabular-nums text-ink-muted">{formatMoney(item.allocatedAmount)}</td>
        <td className="px-3 py-2 text-right align-top font-medium tabular-nums">{formatMoney(item.outstandingAmount)}</td>
        <td className="px-3 py-2 align-top">
          {amountInput}
          {errorText}
        </td>
        <td className="px-3 py-2 align-top">{badges}</td>
      </tr>
    );
  }

  return (
    <div className={cn('rounded-card border bg-card p-3', selection ? 'border-brand-200' : 'border-line')}>
      <div className="flex items-start gap-3">
        <div className="pt-0.5">{checkbox}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-medium text-ink">{item.order.orderNumber}</p>
              <p className="text-xs text-ink-muted">
                {item.customer.name} · Delivered {formatDate(item.deliveredAt)}
              </p>
            </div>
            <OrderTypeBadge orderType={item.orderType} />
          </div>
          <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
            <div>
              <dt className="text-ink-muted">Collection</dt>
              <dd className="tabular-nums text-ink">{formatMoney(item.collectionAmount)}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Settled</dt>
              <dd className="tabular-nums text-ink">{formatMoney(item.allocatedAmount)}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Outstanding</dt>
              <dd className="font-medium tabular-nums text-ink">{formatMoney(item.outstandingAmount)}</dd>
            </div>
          </dl>
          {(selection || review) && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              {amountInput}
              {badges}
            </div>
          )}
          {errorText}
        </div>
      </div>
    </div>
  );
}
