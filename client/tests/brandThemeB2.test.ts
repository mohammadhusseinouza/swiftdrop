// Brand Theme — Step B2: Overview + My Orders (docs/brand-theme/brand-theme-handoff.md
// §3.2 carry-over, §4.1, §4.2, §5).
// - Overview H1 highlight + fallback; My Orders "on the way" lead + its hiding rule.
// - Speed lines hidden below md.
// - Brand tones on white (StageProgress / StatusPill / DetailPanel / CustomerPagination)
//   keep the canonical wording; their default looks are unchanged (still covered by
//   the B1 fixture in brandThemeFoundation.test.ts).
// - Rendered CustomerOrderCard + page source guardrails.
// Run: npx --prefix ../server tsx --test tests/brandThemeB2.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React, { type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The test runner compiles JSX in src with the classic runtime.
(globalThis as unknown as { React: typeof React }).React = React;

const { getOverviewTitle, getOverviewTitleParts } = await import(
  '../src/components/customer/customerOverviewPresentation'
);
const { getCustomerOrdersHeroLead } = await import('../src/components/customer/customerOrderPresentation');
const { SpeedLines } = await import('../src/components/customer/HeroDecor');
const { StageProgress } = await import('../src/components/customer/StageProgress');
const { StatusPill } = await import('../src/components/customer/StatusPill');
const { DetailPanel } = await import('../src/components/customer/DetailPanel');
const { CustomerPagination } = await import('../src/components/customer/CustomerPagination');
const { CustomerPageHeader } = await import('../src/components/customer/CustomerPageHeader');
const { CustomerOrderCard } = await import('../src/components/customer/CustomerOrderCard');
const { MemoryRouter } = await import('react-router-dom');

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

describe('Overview H1 highlight', () => {
  const evening = new Date(2026, 10, 6, 20);

  test('first name is the highlight, with the period', () => {
    assert.deepEqual(getOverviewTitleParts('Nour Haddad', evening), { title: 'Good evening,', highlight: 'Nour.' });
    assert.deepEqual(getOverviewTitleParts('  Acme   Trading ', new Date(2026, 10, 6, 9)), {
      title: 'Good morning,',
      highlight: 'Acme.',
    });
  });

  test('fallback "Welcome back." has no highlight', () => {
    for (const name of ['', '   ', null, undefined]) {
      assert.deepEqual(getOverviewTitleParts(name, evening), { title: 'Welcome back.', highlight: null });
    }
  });

  test('the joined title is unchanged from Step 2', () => {
    assert.equal(getOverviewTitle('Nour Haddad', evening), 'Good evening, Nour.');
    assert.equal(getOverviewTitle('', evening), 'Welcome back.');
  });

  test('rendered: highlight is red italic; fallback renders no <em>', () => {
    const parts = getOverviewTitleParts('Nour', evening);
    const withName = html(h(CustomerPageHeader, { tone: 'dark', title: parts.title, highlight: parts.highlight ?? undefined }));
    assert.match(withName, /<em class="italic text-sd-red-logo">Nour\.<\/em>/);
    assert.equal(text(withName), 'Good evening, Nour.');

    const fallback = getOverviewTitleParts(undefined, evening);
    const plain = html(h(CustomerPageHeader, { tone: 'dark', title: fallback.title, highlight: fallback.highlight ?? undefined }));
    assert.ok(!plain.includes('<em'));
    assert.equal(text(plain), 'Welcome back.');
  });
});

describe('My Orders hero lead', () => {
  test('"{active} on the way · {delivered} delivered" from the summary', () => {
    assert.equal(getCustomerOrdersHeroLead({ activeOrders: 8, deliveredOrders: 3 }), '8 on the way · 3 delivered');
    assert.equal(getCustomerOrdersHeroLead({ activeOrders: 0, deliveredOrders: 0 }), '0 on the way · 0 delivered');
  });

  test('omitted while the summary is not loaded (loading / error)', () => {
    assert.equal(getCustomerOrdersHeroLead(undefined), null);
  });

  test('rendered header: no lead paragraph when null', () => {
    const lead = getCustomerOrdersHeroLead(undefined);
    const m = html(h(CustomerPageHeader, { tone: 'dark', title: 'Every parcel,', highlight: 'at a glance.', lead: lead ?? undefined }));
    assert.equal(text(m), 'Every parcel, at a glance.');
    assert.ok(!m.includes('mt-3 text-base'));
  });

  test('page wiring: dashboard summary only, highlight, brand pager', () => {
    const page = strip(read('../src/pages/customer/CustomerOrdersPage.tsx'));
    assert.ok(page.includes('getCustomerOrdersHeroLead(summary.data)'));
    assert.ok(page.includes('lead={heroLead ?? undefined}'));
    assert.ok(page.includes('title="Every parcel,"') && page.includes('highlight="at a glance."'));
    assert.ok(page.includes('tone="dark"') && page.includes('<SegmentedTabs'));
    assert.ok(/<CustomerPagination[\s\S]*tone="brand"/.test(page));
  });
});

describe('speed lines', () => {
  test('hidden below md, shown from md (both variants)', () => {
    for (const variant of ['hero', 'signin'] as const) {
      const m = html(h(SpeedLines, { variant }));
      const root = m.match(/^<span[^>]*class="([^"]+)"/)![1].split(' ');
      assert.ok(root.includes('hidden') && root.includes('md:flex'), variant);
      assert.ok(!root.includes('flex'), `${variant}: no unconditional flex`);
    }
  });

  test('only Overview (and Wallet) ask for them', () => {
    assert.ok(strip(read('../src/pages/customer/CustomerDashboardPage.tsx')).includes('<CustomerHero speedLines>'));
    assert.ok(!strip(read('../src/pages/customer/CustomerOrdersPage.tsx')).includes('speedLines'));
  });
});

describe('brand tones on white keep the canonical wording', () => {
  test('StageProgress brand: done sd-ink, current sd-red, upcoming sd-line, delivered success', () => {
    const at = (status: string) => html(h(StageProgress, { status, tone: 'brand' }));
    const segments = (m: string) => [...m.matchAll(/<span class="h-1\.5 rounded-\[2px\] ([^"]+)"/g)].map((x) => x[1]);
    assert.deepEqual(segments(at('OUT_FOR_DELIVERY')), ['bg-sd-ink', 'bg-sd-ink', 'bg-sd-red', 'bg-sd-line']);
    assert.deepEqual(segments(at('RECEIVED')), ['bg-sd-red', 'bg-sd-line', 'bg-sd-line', 'bg-sd-line']);
    assert.deepEqual(segments(at('DELIVERED')), Array(4).fill('bg-success-700'));
    assert.deepEqual(segments(at('CANCELLED')), Array(4).fill('bg-sd-line'));
    assert.ok(at('PICKED_UP').includes('sd-grow'));
    for (const s of STATUSES) {
      for (const variant of ['compact', 'labelled'] as const) {
        assert.equal(
          text(html(h(StageProgress, { status: s, variant, tone: 'brand' }))),
          text(html(h(StageProgress, { status: s, variant }))),
          `${s} ${variant}`,
        );
      }
    }
  });

  test('StatusPill brand: red-50 + pulse only for the brand tone; same wording', () => {
    for (const s of STATUSES) {
      const brand = html(h(StatusPill, { status: s, tone: 'brand' }));
      const light = html(h(StatusPill, { status: s }));
      assert.equal(text(brand), text(light), s);
      const isBrandTone = light.includes('bg-brand-50');
      assert.equal(brand.includes('bg-sd-red-50 text-sd-red-text'), isBrandTone, s);
      assert.equal(brand.includes('sd-pulse'), isBrandTone, s);
      assert.ok(!brand.includes('brand-600') && !brand.includes('bg-canvas'), s);
    }
  });

  test('DetailPanel brand: sd card + Saira title; default unchanged', () => {
    const brand = html(h(DetailPanel, { title: 'Orders in motion', titleStyle: 'title', tone: 'brand' }, 'x'));
    assert.ok(brand.includes('border-sd-line') && brand.includes('shadow-sd-card'));
    assert.ok(brand.includes('font-sd-display text-xl font-bold text-sd-ink'));
    const plain = html(h(DetailPanel, { title: 'T', titleStyle: 'title' }, 'x'));
    assert.equal(html(h(DetailPanel, { title: 'T', titleStyle: 'title', tone: 'default' }, 'x')), plain);
    assert.ok(plain.includes('rounded-panel border border-line') && !plain.includes('sd-'));
  });

  test('CustomerPagination brand: red Next; default keeps dark Next', () => {
    const props = { page: 2, totalPages: 3, total: 41, noun: 'orders', onPageChange: () => {} };
    const brand = html(h(CustomerPagination, { ...props, tone: 'brand' }));
    assert.match(brand, /<button[^>]*class="[^"]*bg-sd-red [^"]*hover:bg-sd-red-hover[^"]*">Next/);
    assert.match(brand, /<button[^>]*class="[^"]*hover:border-sd-red hover:text-sd-red-text[^"]*"><svg[^>]*>.*?<\/svg>Previous/);
    const plain = html(h(CustomerPagination, props));
    assert.equal(html(h(CustomerPagination, { ...props, tone: 'default' })), plain);
    assert.ok(plain.includes('bg-ink px-4') && !plain.includes('sd-'));
    assert.equal(text(brand), text(plain));
  });
});

describe('CustomerOrderCard (rendered)', () => {
  const order = {
    id: 'o1',
    orderNumber: 'ORD-1001',
    trackingCode: 'TRK1001',
    orderType: 'DELIVERY_ONLY',
    status: 'OUT_FOR_DELIVERY',
    createdAt: '2026-11-02T10:00:00.000Z',
    deliveredAt: null,
    receiverName: 'Rami Khoury',
    receiverArea: 'Hamra',
    orderAmount: '120',
    deliveryFee: '5.5',
    amountToCollect: '125.5',
    parcelIntakeMethod: 'ALREADY_AT_COMPANY',
    collectionStage: null,
  } as const;
  const m = html(h(MemoryRouter, null, h(CustomerOrderCard, { order })));

  test('receiver in Saira 20, type chip, brand pill + red current stage', () => {
    assert.match(m, /<h2 class="[^"]*font-sd-display text-xl[^"]*">Rami Khoury<\/h2>/);
    assert.ok(m.includes('bg-sd-line-subtle'));
    assert.ok(m.includes('bg-sd-red-50 text-sd-red-text'));
    assert.ok(m.includes('h-1.5 rounded-[2px] bg-sd-red"'));
  });

  test('amount strip: To collect in sd-red-text; amounts via formatMoney', () => {
    assert.ok(m.includes('bg-sd-sunken'));
    assert.match(m, /To collect<\/dt><dd class="[^"]*text-sd-red-text">\$125\.50<\/dd>/);
    assert.ok(text(m).includes('$120.00') && text(m).includes('$5.50'));
  });

  test('View order: outline with red hover, accessible name kept', () => {
    assert.match(m, /<a [^>]*class="[^"]*border-sd-line[^"]*hover:border-sd-red hover:text-sd-red-text[^"]*"[^>]*aria-label="View order ORD-1001"/);
  });
});

describe('Overview page (source guardrails)', () => {
  const page = strip(read('../src/pages/customer/CustomerDashboardPage.tsx'));

  test('hero: highlight from the helper, red balance tile, three translucent tiles', () => {
    assert.ok(page.includes('getOverviewTitleParts(data?.customer.name, now)'));
    assert.ok(page.includes('highlight={heading.highlight ?? undefined}'));
    assert.ok(page.includes('<BalanceHeroCard tone="red">'));
    assert.ok(page.includes('<HeroMoney value={data.availableWalletBalance} tone="red" />'));
    assert.ok(page.includes('<HeroStatTile label="Pending delivery">'));
    assert.ok(page.includes('<HeroStatTile label="Pending settlement">'));
    assert.ok(page.includes('<HeroStatTile label="Latest payout">'));
    assert.ok(page.includes('grid-cols-[repeat(auto-fit,minmax(min(100%,210px),1fr))]'));
  });

  test('"Ready for payout" stays behind the exact-cents rule; latest payout hides when none', () => {
    assert.match(page, /isReadyForPayout\(data\.availableWalletBalance\) && \(/);
    assert.ok(page.includes('if (!payouts.isLoading && !payouts.isError && lastPayout === null) return null;'));
  });

  test('body: link cards with red / success tiles, review notice is a count, brand panels', () => {
    assert.ok(page.includes('iconClass="bg-sd-red-50 text-sd-red"'));
    assert.ok(page.includes('iconClass="bg-success-50 text-success-700"'));
    assert.ok(page.includes('data.underReviewOrderCount > 0'));
    assert.equal((page.match(/tone="brand"/g) ?? []).length >= 3, true);
    assert.ok(page.includes("'bg-[#EEF0F2] text-sd-steel'"));
    assert.ok(page.includes('sd-row') && page.includes('sd-stagger'));
  });

  test('state copy unchanged', () => {
    for (const copy of [
      'Loading your balance…',
      'Loading active orders…',
      'No active orders.',
      'Loading wallet activity…',
      'No wallet transactions yet.',
    ]) {
      assert.ok(page.includes(copy), copy);
    }
  });

  test('no cobalt / chrome leftovers on the page', () => {
    assert.ok(!/brand-(50|600|700)|chrome-ink|bg-chrome/.test(page));
  });
});
