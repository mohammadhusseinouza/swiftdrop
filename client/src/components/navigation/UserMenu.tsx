import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, LogOut } from 'lucide-react';
import { cn } from '../ui/cn';
import { getInitials } from '../../lib/initials';

/**
 * PRESENTATIONAL user menu for the Management navbar. The shell wires
 * `onSignOut` to Phase 10.5's `useLogout()` and passes its pending/error state.
 * No Redux, no API, no logout logic here. No portal switcher, no Profile link
 * (no such route), no notifications.
 */
export interface UserMenuProps {
  name: string;
  email: string;
  roleName: string;
  onSignOut: () => void;
  signingOut?: boolean;
  signOutError?: string | null;
}

export function UserMenu({
  name,
  email,
  roleName,
  onSignOut,
  signingOut = false,
  signOutError = null,
}: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const signOutRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;

    // Move focus into the menu.
    signOutRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        className="flex items-center gap-2 rounded-control py-1 pr-1.5 pl-1 text-sm hover:bg-neutral-50"
      >
        <span
          className="flex size-8 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700"
          aria-hidden="true"
        >
          {getInitials(name)}
        </span>
        <span className="hidden max-w-[10rem] truncate font-medium text-ink sm:block">
          {name}
        </span>
        <ChevronDown className="size-4 text-ink-subtle" aria-hidden="true" />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Account"
          className={cn(
            'absolute right-0 z-30 mt-1 w-64 rounded-card border border-line',
            'bg-card p-1 shadow-overlay',
          )}
        >
          <div className="px-3 py-2">
            <p className="truncate text-sm font-medium text-ink">{name}</p>
            <p className="truncate text-xs text-ink-muted">{email}</p>
            <p className="mt-0.5 text-xs text-ink-subtle">{roleName}</p>
          </div>

          <div className="my-1 border-t border-line-subtle" />

          <button
            ref={signOutRef}
            type="button"
            role="menuitem"
            onClick={onSignOut}
            disabled={signingOut}
            className={cn(
              'flex w-full items-center gap-2 rounded-control px-3 py-2 text-left text-sm',
              'text-ink-secondary hover:bg-neutral-50 disabled:opacity-50',
            )}
          >
            <LogOut className="size-4" aria-hidden="true" />
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>

          {signOutError && (
            <p role="alert" className="px-3 py-1.5 text-xs text-danger-700">
              {signOutError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
