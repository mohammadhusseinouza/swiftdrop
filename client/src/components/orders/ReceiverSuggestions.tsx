import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { UseFormRegisterReturn } from 'react-hook-form';
import { History } from 'lucide-react';

import { useDebouncedValue } from '../../lib/useDebouncedValue';
import { useGetCustomerReceiversQuery } from '../../services/customersApi';
import type { CustomerReceiverSuggestion } from '../../services/domain.types';
import { cn } from '../ui/cn';
import {
  RECEIVER_FIELDS,
  fieldsStillFromSuggestion,
  shortAddress,
  suggestionToReceiverValues,
  type ReceiverField,
  type ReceiverFormValues,
} from './receiverMemory';

const SUGGESTION_LIMIT = 8;

type SearchField = Extract<ReceiverField, 'receiverName' | 'receiverPhone'>;

export interface UseReceiverMemoryOptions {
  /** The order's currently selected customer ('' when none). */
  customerId: string;
  /** Watched values of the two searchable inputs. */
  name: string;
  phone: string;
  getValue: (field: ReceiverField) => string;
  setValue: (field: ReceiverField, value: string) => void;
  /** Turns the lookup off entirely (e.g. a closed dialog). */
  disabled?: boolean;
}

/**
 * Customer Receiver Memory autocomplete for the Receiver section of Create /
 * Edit Order. Typing in the receiver name or primary phone searches the
 * SELECTED customer's saved receivers on the server (debounced, bounded);
 * choosing one prefills the form. Nothing is saved from here — the backend
 * saves / refreshes the receiver inside the order create / edit transaction.
 */
export function useReceiverMemory({
  customerId,
  name,
  phone,
  getValue,
  setValue,
  disabled = false,
}: UseReceiverMemoryOptions) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [activeField, setActiveField] = useState<SearchField>('receiverName');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [selected, setSelected] = useState<CustomerReceiverSuggestion | null>(null);
  const appliedRef = useRef<Partial<ReceiverFormValues> | null>(null);

  const term = (activeField === 'receiverPhone' ? phone : name).trim();
  const debouncedTerm = useDebouncedValue(term, 300);
  const enabled = !disabled && open && customerId !== '';
  const receivers = useGetCustomerReceiversQuery(
    { customerId, search: debouncedTerm || undefined, limit: SUGGESTION_LIMIT },
    { skip: !enabled },
  );
  // `currentData` belongs to the CURRENT arguments only, so results fetched for
  // a previous customer (or an older term) are never shown while a new
  // request is in flight.
  const suggestions = enabled ? (receivers.currentData ?? []) : [];
  const visible = enabled && suggestions.length > 0;

  const readValues = (): ReceiverFormValues =>
    Object.fromEntries(RECEIVER_FIELDS.map((f) => [f, getValue(f)])) as ReceiverFormValues;

  const forget = () => {
    appliedRef.current = null;
    setSelected(null);
    setActiveIndex(-1);
  };

  // Customer changed: drop the selected saved-receiver identity and clear the
  // fields it filled that were not edited since.
  const previousCustomer = useRef(customerId);
  useEffect(() => {
    if (previousCustomer.current === customerId) return;
    previousCustomer.current = customerId;
    const applied = appliedRef.current;
    if (applied) {
      for (const field of fieldsStillFromSuggestion(applied, readValues())) setValue(field, '');
    }
    forget();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  const choose = (receiver: CustomerReceiverSuggestion) => {
    const values = suggestionToReceiverValues(receiver);
    for (const [field, value] of Object.entries(values) as [ReceiverField, string][]) {
      setValue(field, value);
    }
    appliedRef.current = values;
    setSelected(receiver);
    setOpen(false);
    setActiveIndex(-1);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && visible) {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!customerId) return;
      e.preventDefault();
      if (!open) setOpen(true);
      if (suggestions.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((i) => (i + step + suggestions.length) % suggestions.length);
      return;
    }
    if (e.key === 'Enter' && visible && activeIndex >= 0 && suggestions[activeIndex]) {
      e.preventDefault();
      choose(suggestions[activeIndex]);
    }
  };

  /**
   * Props for the receiver name / primary phone input, merged with its RHF
   * registration. A registration's own onKeyDown (the phone input filter) runs
   * first; a key it blocks never reaches the suggestion navigation.
   */
  const bind = (
    field: SearchField,
    registration: UseFormRegisterReturn & {
      onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
    },
  ) => ({
    ...registration,
    role: 'combobox' as const,
    'aria-autocomplete': 'list' as const,
    'aria-expanded': visible && activeField === field,
    'aria-controls': listId,
    'aria-activedescendant':
      visible && activeField === field && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined,
    onFocus: () => {
      setActiveField(field);
      setActiveIndex(-1);
      setOpen(true);
    },
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      void registration.onChange(e);
      setActiveField(field);
      setActiveIndex(-1);
      setOpen(true);
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
      void registration.onBlur(e);
      setOpen(false);
    },
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      registration.onKeyDown?.(e);
      if (!e.defaultPrevented) onKeyDown(e);
    },
  });

  return {
    bind,
    /** Clears the remembered selection (e.g. when a dialog is re-seeded). */
    reset: forget,
    list: { id: listId, visible, suggestions, activeIndex, choose },
    selected,
  };
}

export type ReceiverMemory = ReturnType<typeof useReceiverMemory>;

/** Compact suggestion dropdown — rendered inside a `relative` wrapper under the name / phone inputs. */
export function ReceiverSuggestionList({ memory }: { memory: ReceiverMemory }) {
  const { id, visible, suggestions, activeIndex, choose } = memory.list;
  if (!visible) return null;
  return (
    <ul
      id={id}
      role="listbox"
      aria-label="Saved receivers for this customer"
      className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-control border border-line bg-card py-1 shadow-card"
    >
      <li role="presentation" className="px-3 pb-1 pt-0.5 text-[0.6875rem] font-medium text-ink-subtle">
        Saved receivers
      </li>
      {suggestions.map((r, index) => (
        <li
          key={r.id}
          id={`${id}-${index}`}
          role="option"
          aria-selected={index === activeIndex}
          // Keep focus in the input so choosing never fires a blur first.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => choose(r)}
          className={cn(
            'cursor-pointer px-3 py-1.5 text-sm',
            index === activeIndex ? 'bg-brand-50' : 'hover:bg-sunken',
          )}
        >
          <span className="block truncate">
            <span className="font-medium text-ink">{r.name}</span>
            <span className="text-ink-muted"> · {r.phone}</span>
          </span>
          <span className="block truncate text-xs text-ink-muted">
            {r.area ? (
              <>
                {r.area.name}
                {!r.area.isActive && ' (inactive)'}
                {' · '}
              </>
            ) : null}
            {shortAddress(r.address)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Confirms a prefill and flags a saved area that cannot be reused. */
export function ReceiverMemoryNote({ memory }: { memory: ReceiverMemory }) {
  const receiver = memory.selected;
  if (!receiver) return null;
  const inactiveArea = receiver.area && !receiver.area.isActive ? receiver.area.name : null;
  return (
    <p className="flex items-start gap-1.5 text-xs text-ink-muted">
      <History className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span>
        Filled from a saved receiver — every field stays editable.
        {inactiveArea && (
          <span className="text-danger-700">
            {' '}
            The saved area “{inactiveArea}” is inactive, so select an area.
          </span>
        )}
        {!receiver.area && ' No saved area — select an area.'}
      </span>
    </p>
  );
}
