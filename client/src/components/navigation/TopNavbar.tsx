import type { ReactNode } from 'react';
import { Menu } from 'lucide-react';
import { cn } from '../ui/cn';

/**
 * PRESENTATIONAL top bar. No navigation logic, no logout, no user fetch, no
 * notification business logic. Phase 11.2 composes the real Management navbar.
 */
export interface TopNavbarProps {
  /** Current page / context label. */
  title?: ReactNode;
  /** Sidebar/drawer toggle handler. When omitted the toggle button is hidden. */
  onToggleSidebar?: () => void;
  /** Right-aligned action slot (user menu, etc. — supplied by the shell). */
  actions?: ReactNode;
  className?: string;
}

export function TopNavbar({
  title,
  onToggleSidebar,
  actions,
  className,
}: TopNavbarProps) {
  return (
    <header
      className={cn(
        'flex h-15 shrink-0 items-center gap-3 border-b border-line bg-card px-4',
        className,
      )}
    >
      {onToggleSidebar && (
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label="Toggle navigation"
          className="rounded-control p-2 text-ink-muted hover:bg-neutral-50"
        >
          <Menu className="size-5" aria-hidden="true" />
        </button>
      )}
      <div className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
        {title}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
