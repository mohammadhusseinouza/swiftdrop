import { Outlet } from 'react-router-dom';
import { LayoutDashboard, Truck, User, type LucideIcon } from 'lucide-react';

import { OrbitRing, RedArc, SpeedLines } from '../components/customer/HeroDecor';
import '../components/customer/brandFonts';
import sdLogoWhite from '../assets/brand/sd-logo-white.png';

/**
 * Routing boundary for unauthenticated / auth pages (Phase 10.2), styled as
 * the brand two-panel sign-in surface (docs/brand-theme/brand-theme-handoff.md
 * §6; behaviour per docs/customer-portal-redesign-handoff.md §8). The brand
 * fonts (Saira + Inter) are loaded and applied on this root only (B-D3 A).
 *
 * The page is shared by EVERY role, so the brand panel is role-neutral and
 * purely decorative: its chips are labels (never links, never a role picker —
 * the backend decides the portal), its ring / arc / speed lines are
 * aria-hidden, and its headline is an h2 so the form keeps the page's h1.
 * Below `md` the brand panel is a compact strip (logo + headline only) above
 * the form. No application chrome.
 */
const ROLE_LABELS: ReadonlyArray<{ label: string; icon: LucideIcon }> = [
  { label: 'Management', icon: LayoutDashboard },
  { label: 'Drivers', icon: Truck },
  { label: 'Customers', icon: User },
];

export default function AuthLayout() {
  return (
    <div className="flex min-h-screen flex-wrap content-start bg-sd-page font-sd-body text-sd-ink md:flex-nowrap md:content-stretch">
      <section
        aria-label="Spring Delivery"
        className="relative isolate flex flex-[1_1_100%] flex-col overflow-hidden bg-sd-charcoal px-6 py-8 text-white md:flex-[1_1_520px] md:px-14 md:py-12"
      >
        <OrbitRing className="-right-[300px] -bottom-[360px] size-[760px]" />
        <RedArc className="-right-[140px] -bottom-[220px] size-[520px]" />
        {/* Raised above the role chips (§3.2 places them at bottom 64, where the chips sit; 150 px clears two chip rows at md). */}
        <SpeedLines variant="signin" className="bottom-[150px] left-0" />

        <img
          src={sdLogoWhite}
          alt="Spring Delivery"
          width={200}
          height={219}
          className="sd-rise h-auto w-[104px] md:w-[200px]"
        />

        <div className="mt-6 md:my-auto md:py-12">
          <p className="sd-rise mb-4 hidden font-sd-display text-[0.8125rem] font-semibold uppercase tracking-[0.16em] text-sd-on-dark [--sd-i:1] md:block">
            Delivery management
          </p>
          <h2 className="sd-rise max-w-[34rem] font-sd-display text-[2rem] leading-[1.04] font-bold tracking-[-0.02em] [--sd-i:2] md:text-[2.875rem]">
            Every parcel,
            <br />
            <em className="italic text-sd-red-logo">accounted for.</em>
          </h2>
          <p className="sd-rise mt-5 hidden max-w-[26rem] text-base text-sd-on-dark [--sd-i:3] md:block">
            One sign-in for the whole team. Management, drivers and customers each land in their own portal.
          </p>
        </div>

        <ul className="sd-rise hidden flex-wrap gap-2 [--sd-i:4] md:flex">
          {ROLE_LABELS.map(({ label, icon: Icon }) => (
            <li
              key={label}
              className="inline-flex h-[34px] items-center gap-2 rounded-lg border border-white/8 bg-white/7 px-3.5 text-[0.8125rem] font-semibold text-sd-on-dark-strong"
            >
              <Icon className="size-3.5 text-sd-on-dark" aria-hidden="true" />
              {label}
            </li>
          ))}
        </ul>
      </section>

      <main className="sd-focus-red flex flex-[1_1_100%] items-start justify-center px-6 py-10 md:flex-[1_1_480px] md:items-center md:py-12">
        <Outlet />
      </main>
    </div>
  );
}
