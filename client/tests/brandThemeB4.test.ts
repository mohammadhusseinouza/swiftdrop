// Brand Theme — Step B4: sign-in (docs/brand-theme/brand-theme-handoff.md §6, §2, §5)
// and the B3 carry-over (journey pulse gate).
// Run: npx --prefix ../server tsx --test tests/brandThemeB4.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React, { type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The test runner compiles JSX in src with the classic runtime.
(globalThis as unknown as { React: typeof React }).React = React;

const { CustomerJourney, isJourneyLive } = await import('../src/components/customer/CustomerJourney');
// AuthLayout imports font CSS + a PNG (Vite assets), so it is checked by source
// (like the B1 shell tests); its decoration is rendered from HeroDecor.
const { OrbitRing, RedArc, SpeedLines } = await import('../src/components/customer/HeroDecor');

const h = React.createElement;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const text = (markup: string) => markup.replace(/<[^>]+>/g, '');
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const STATUSES = [
  'RECEIVED',
  'READY_FOR_PICKUP',
  'ASSIGNED',
  'PICKED_UP',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FAILED_DELIVERY',
  'RESCHEDULED',
  'RETURNED_TO_COMPANY',
  'RETURNED_TO_CUSTOMER',
  'CANCELLED',
] as const;

const tracking = {
  stages: [
    { code: 'RECEIVED', label: 'Order Received', state: 'done' as const, occurredAt: null },
    { code: 'READY', label: 'Ready for Delivery', state: 'done' as const, occurredAt: null },
    { code: 'OUT', label: 'Out for Delivery', state: 'current' as const, occurredAt: null },
    { code: 'DELIVERED', label: 'Delivered', state: 'upcoming' as const, occurredAt: null },
  ],
  exception: null,
  isDelivered: false,
};

describe('journey pulse gate (B3 carry-over)', () => {
  test('live only for OUT_FOR_DELIVERY (canonical mapping)', () => {
    assert.deepEqual(STATUSES.filter(isJourneyLive), ['OUT_FOR_DELIVERY']);
  });

  test('exception statuses: current node keeps its red colour but does not pulse', () => {
    for (const status of ['FAILED_DELIVERY', 'RESCHEDULED', 'RETURNED_TO_COMPANY', 'RETURNED_TO_CUSTOMER', 'CANCELLED']) {
      const m = html(h(CustomerJourney, { tracking, status }));
      assert.ok(!m.includes('sd-pulse'), status);
      assert.ok(m.includes('ring-sd-red') && m.includes('size-2.5 rounded-full bg-sd-red text-sd-red'), status);
    }
  });

  test('out for delivery: exactly one pulse, on the current node', () => {
    const m = html(h(CustomerJourney, { tracking, status: 'OUT_FOR_DELIVERY' }));
    assert.equal((m.match(/sd-pulse/g) ?? []).length, 1);
    assert.match(m, /<span class="size-2\.5 rounded-full bg-sd-red text-sd-red sd-pulse"><\/span>/);
  });

  test('server stages, order and words are unchanged whatever the status', () => {
    const expected = 'Order ReceivedDoneReady for DeliveryDoneOut for DeliveryIn progressDeliveredUpcoming';
    for (const status of STATUSES) assert.equal(text(html(h(CustomerJourney, { tracking, status }))), expected, status);
  });

  test('Order Detail passes the order status', () => {
    const src = strip(read('../src/pages/customer/CustomerOrderDetailPage.tsx'));
    assert.ok(src.includes('<CustomerJourney tracking={order.tracking} status={order.status} />'));
  });
});

describe('sign-in brand panel', () => {
  const layout = strip(read('../src/layouts/AuthLayout.tsx'));
  const panel = layout.slice(layout.indexOf('<section'), layout.indexOf('</section>'));

  test('logo: sd-logo-white.png with alt "Spring Delivery", 200 px from md', () => {
    assert.ok(layout.includes("import sdLogoWhite from '../assets/brand/sd-logo-white.png';"));
    assert.match(panel, /<img\s+src=\{sdLogoWhite\}\s+alt="Spring Delivery"[\s\S]*?md:w-\[200px\]/);
    assert.ok(!layout.includes('Package'), 'old blue tile icon removed');
  });

  test('decoration is the shared aria-hidden HeroDecor, at the sign-in placement', () => {
    assert.ok(panel.includes('<OrbitRing className="-right-[300px] -bottom-[360px] size-[760px]" />'));
    assert.ok(panel.includes('<RedArc className="-right-[140px] -bottom-[220px] size-[520px]" />'));
    assert.ok(panel.includes('<SpeedLines variant="signin" className="bottom-[150px] left-0" />'));
    for (const m of [
      html(h(OrbitRing, { className: '-right-[300px] -bottom-[360px] size-[760px]' })),
      html(h(RedArc, { className: '-right-[140px] -bottom-[220px] size-[520px]' })),
      html(h(SpeedLines, { variant: 'signin' })),
    ]) {
      assert.match(m, /^<span aria-hidden="true"[^>]*class="[^"]*pointer-events-none/);
      assert.equal(text(m), '');
    }
    const speed = html(h(SpeedLines, { variant: 'signin' })).match(/^<span[^>]*class="([^"]+)"/)![1].split(' ');
    assert.ok(speed.includes('hidden') && speed.includes('md:flex'), 'speed lines hidden below md');
  });

  test('headline is an h2 with "accounted for." in red italic; no h1 in the layout', () => {
    assert.match(panel, /<h2 className="[^"]*font-sd-display[^"]*">\s*Every parcel,\s*<br \/>\s*<em className="italic text-sd-red-logo">accounted for\.<\/em>\s*<\/h2>/);
    assert.ok(!layout.includes('<h1'));
  });

  test('compact below md: eyebrow, lead and chips hidden; logo + headline remain', () => {
    assert.match(panel, /<p className="[^"]*\bhidden\b[^"]*md:block">\s*Delivery management/);
    assert.match(panel, /<p className="[^"]*\bhidden\b[^"]*md:block">\s*One sign-in/);
    assert.match(panel, /<ul className="[^"]*\bhidden\b[^"]*md:flex">/);
  });

  test('chips are labels, not links or buttons; section keeps its accessible name', () => {
    assert.ok(layout.includes('<section\n        aria-label="Spring Delivery"'));
    assert.ok(panel.includes('<li') && !/<a |<Link|<button|onClick|href=/.test(layout));
    for (const label of ['Management', 'Drivers', 'Customers']) assert.ok(layout.includes(`label: '${label}'`), label);
  });

  test('brand fonts on the AuthLayout root, charcoal panel', () => {
    assert.ok(layout.includes("import '../components/customer/brandFonts';"));
    assert.match(layout, /<div className="[^"]*font-sd-body/);
    assert.ok(panel.includes('bg-sd-charcoal'));
  });
});

describe('sign-in form', () => {
  const page = strip(read('../src/pages/auth/LoginPage.tsx'));

  test('error wording is unchanged and generic', () => {
    const messages = [
      'Invalid email or password.',
      'Unable to sign in right now. Please try again.',
      'Please check the details you entered and try again.',
      'Something went wrong while signing in. Please try again.',
    ];
    for (const msg of messages) assert.equal(page.split(`'${msg}'`).length - 1, 1, msg);
    assert.ok(page.includes("if (code === 'INVALID_CREDENTIALS' || status === 401) {"));
  });

  test('H1 Saira 36, red primary button, brand fields', () => {
    assert.match(page, /<h1 className="font-sd-display text-\[2\.25rem\][^"]*">\s*Welcome back\s*<\/h1>/);
    assert.ok(page.includes('variant="brand"') && page.includes('size="brand"'));
    assert.ok(page.includes('h-[50px] w-full rounded-[10px]'));
    assert.ok(!/variant="ink"/.test(page));
  });

  test('shared Button: brand variant / size are additive and Saira 17/700', () => {
    const btn = read('../src/components/ui/Button.tsx');
    assert.ok(btn.includes("brand: 'h-[52px] px-5 gap-2 rounded-[10px] font-sd-display text-[1.0625rem] font-bold tracking-[0.02em]',"));
    assert.ok(btn.includes("ink: 'bg-ink text-white hover:bg-chrome disabled:bg-ink/60',"));
    assert.ok(btn.includes("lg: 'h-[52px] px-5 text-[0.9375rem] gap-2 rounded-xl font-semibold',"));
  });
});

describe('sign-in focus (regression fix)', () => {
  const css = read('../src/index.css').replace(/\/\*[\s\S]*?\*\//g, '');

  test('scoped red focus rule beats the unlayered global cobalt rule, keeps the 10px corners', () => {
    assert.match(
      css,
      /\.sd-focus-red :where\(a, button, input, select, textarea, \[tabindex\]\):focus-visible \{\s*outline-color: var\(--color-sd-red\);\s*outline-offset: 1px;\s*border-radius: revert-layer;\s*\}/,
    );
    assert.ok(strip(read('../src/layouts/AuthLayout.tsx')).includes('<main className="sd-focus-red '));
  });

  test('the global focus rule itself is unchanged', () => {
    assert.match(css, /:where\(a, button, input, select, textarea, \[tabindex\]\):focus-visible \{\s*outline: 2px solid var\(--color-brand-600\);/);
  });
});
