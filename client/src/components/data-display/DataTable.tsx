import type { ReactNode } from 'react';
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '../ui/cn';
import { LoadingState } from '../feedback/LoadingState';

export type SortDirection = 'asc' | 'desc';
export interface SortState {
  columnId: string;
  direction: SortDirection;
}

export interface DataTableColumn<T> {
  id: string;
  header: ReactNode;
  /** Cell renderer for a row. */
  cell: (row: T) => ReactNode;
  /** Enables the sort affordance in the header (parent owns the actual sort). */
  sortable?: boolean;
  align?: 'left' | 'right' | 'center';
  /** Extra classes for both the header cell and body cells. */
  className?: string;
  /** Hide below this Tailwind breakpoint (e.g. 'md' -> hidden until md). */
  hideBelow?: 'sm' | 'md' | 'lg' | 'xl';
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  caption?: string;
  onRowClick?: (row: T) => void;

  /** Controlled sort — DataTable NEVER sorts data itself. */
  sort?: SortState | null;
  onSortChange?: (next: SortState) => void;

  /** Controlled selection (optional). DataTable never filters/paginates data. */
  selectedIds?: readonly string[];
  onSelectionChange?: (ids: string[]) => void;

  loading?: boolean;
  /** Rendered when `rows` is empty and not loading. */
  emptyState?: ReactNode;
  className?: string;
}

const ALIGN: Record<NonNullable<DataTableColumn<unknown>['align']>, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};
const HIDE_BELOW: Record<NonNullable<DataTableColumn<unknown>['hideBelow']>, string> =
  {
    sm: 'hidden sm:table-cell',
    md: 'hidden md:table-cell',
    lg: 'hidden lg:table-cell',
    xl: 'hidden xl:table-cell',
  };

/**
 * Strongly-typed presentational table. The PARENT owns page / sort / filters /
 * query args — this component only renders the rows it is given and reports
 * sort/selection intent. Scrolls horizontally inside its own container on
 * narrow screens; never hides columns without an explicit `hideBelow`.
 */
export function DataTable<T>({
  columns,
  rows,
  getRowId,
  caption,
  onRowClick,
  sort,
  onSortChange,
  selectedIds,
  onSelectionChange,
  loading = false,
  emptyState,
  className,
}: DataTableProps<T>) {
  const selectable = Boolean(selectedIds && onSelectionChange);
  const selected = new Set(selectedIds ?? []);
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(getRowId(r)));

  const toggleAll = () => {
    if (!onSelectionChange) return;
    onSelectionChange(allSelected ? [] : rows.map(getRowId));
  };
  const toggleOne = (id: string) => {
    if (!onSelectionChange) return;
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectionChange([...next]);
  };

  const handleSort = (col: DataTableColumn<T>) => {
    if (!col.sortable || !onSortChange) return;
    const direction: SortDirection =
      sort?.columnId === col.id && sort.direction === 'asc' ? 'desc' : 'asc';
    onSortChange({ columnId: col.id, direction });
  };

  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full min-w-[40rem] border-collapse text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-line text-left text-xs font-semibold uppercase tracking-wide text-ink-muted">
            {selectable && (
              <th scope="col" className="w-10 px-3 py-2.5">
                <input
                  type="checkbox"
                  aria-label="Select all rows"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="size-4 rounded border-line"
                />
              </th>
            )}
            {columns.map((col) => {
              const active = sort?.columnId === col.id;
              return (
                <th
                  key={col.id}
                  scope="col"
                  aria-sort={
                    col.sortable
                      ? active
                        ? sort?.direction === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                      : undefined
                  }
                  className={cn(
                    'px-3 py-2.5 font-semibold',
                    col.align && ALIGN[col.align],
                    col.hideBelow && HIDE_BELOW[col.hideBelow],
                    col.className,
                  )}
                >
                  {col.sortable && onSortChange ? (
                    <button
                      type="button"
                      onClick={() => handleSort(col)}
                      className="inline-flex items-center gap-1 hover:text-ink"
                    >
                      {col.header}
                      {active ? (
                        sort?.direction === 'asc' ? (
                          <ChevronUp className="size-3.5" aria-hidden="true" />
                        ) : (
                          <ChevronDown className="size-3.5" aria-hidden="true" />
                        )
                      ) : (
                        <ChevronsUpDown
                          className="size-3.5 opacity-50"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={columns.length + (selectable ? 1 : 0)}>
                <LoadingState />
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length + (selectable ? 1 : 0)}>
                {emptyState ?? (
                  <p className="py-12 text-center text-sm text-ink-muted">
                    No results.
                  </p>
                )}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const id = getRowId(row);
              return (
                <tr
                  key={id}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    'border-b border-line-subtle last:border-0',
                    onRowClick && 'cursor-pointer hover:bg-sunken',
                    selected.has(id) && 'bg-brand-50/50',
                  )}
                >
                  {selectable && (
                    <td className="w-10 px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select row ${id}`}
                        checked={selected.has(id)}
                        onChange={() => toggleOne(id)}
                        className="size-4 rounded border-line"
                      />
                    </td>
                  )}
                  {columns.map((col) => (
                    <td
                      key={col.id}
                      className={cn(
                        'px-3 py-3 text-ink-secondary',
                        col.align && ALIGN[col.align],
                        col.hideBelow && HIDE_BELOW[col.hideBelow],
                        col.className,
                      )}
                    >
                      {col.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
