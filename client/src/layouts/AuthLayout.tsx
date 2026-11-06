import { Outlet } from 'react-router-dom';
import { LayoutDashboard, Package, Truck, User, type LucideIcon } from 'lucide-react';

/**
 * Routing boundary for unauthenticated / auth pages (Phase 10.2), redesigned
 * as the two-panel sign-in surface (Customer Portal Redesign handoff §8.1,
 * decision D4-A: Plus Jakarta Sans via `font-customer` on this root too).
 *
 * The page is shared by EVERY role, so the brand panel is role-neutral and
 * purely decorative: its chips are labels (never links, never a role picker —
 * the backend decides the portal), its rings are aria-hidden, and its headline
 * is an h2 so the form keeps the page's h1. Below `md` the brand panel is a
 * compact strip (logo + headline) above the form. No application chrome.
 */
const ROLE_LABELS: ReadonlyArray<{ label: string; icon: LucideIcon }> = [
  { label: 'Management', icon: LayoutDashboard },
  { label: 'Drivers', icon: Truck },
  { label: 'Customers', icon: User },
];

export default function AuthLayout() {
  return (
    <div className="flex min-h-screen flex-wrap content-start bg-canvas font-customer text-ink md:flex-nowrap md:content-stretch">
      <section
        aria-label="Spring Delivery"
        className="relative isolate flex flex-[1_1_100%] flex-col overflow-hidden bg-chrome px-6 py-8 text-white md:flex-[1_1_520px] md:px-14 md:py-12"
      >
        <div className="pointer-events-none absolute -right-40 -bottom-40 -z-10 size-[30rem]" aria-hidden="true">
          <span className="absolute inset-0 rounded-full border border-white/7" />
          <span className="absolute inset-14 rounded-full border border-white/7" />
          <span className="absolute inset-28 rounded-full border border-white/7" />
          <span className="absolute inset-[10.5rem] rounded-full border border-brand-600 opacity-60" />
        </div>

        <div className="flex items-center gap-3">
          <span
            className="flex size-10 items-center justify-center rounded-[12px] bg-brand-600 text-white"
            aria-hidden="true"
          >
            <Package className="size-5" strokeWidth={2} />
          </span>
          <span className="text-lg font-bold tracking-[-0.01em]">Spring Delivery</span>
        </div>

        <div className="mt-6 md:my-auto md:py-12">
          <p className="mb-4 hidden text-xs font-bold uppercase tracking-[0.12em] text-chrome-ink md:block">
            Delivery management
          </p>
          <h2 className="max-w-[34rem] text-[2rem] leading-[1.06] font-bold tracking-[-0.04em] md:text-5xl">
            Every parcel,
            <br />
            accounted for.
          </h2>
          <p className="mt-5 hidden max-w-[26rem] text-base text-chrome-ink md:block">
            One sign-in for the whole team. Management, drivers and customers each land in their own portal.
          </p>
        </div>

        <ul className="hidden flex-wrap gap-2 md:flex">
          {ROLE_LABELS.map(({ label, icon: Icon }) => (
            <li
              key={label}
              className="inline-flex h-[34px] items-center gap-2 rounded-full bg-white/7 px-3.5 text-[0.8125rem] font-semibold text-white"
            >
              <Icon className="size-3.5 text-chrome-ink" aria-hidden="true" />
              {label}
            </li>
          ))}
        </ul>
      </section>

      <main className="flex flex-[1_1_100%] items-start justify-center px-6 py-10 md:flex-[1_1_480px] md:items-center md:py-12">
        <Outlet />
      </main>
    </div>
  );
}
