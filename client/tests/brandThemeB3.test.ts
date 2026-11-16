// Brand Theme — Step B3: Order Detail, Wallet (+ Transactions / Payouts tabs), Profile
// (docs/brand-theme/brand-theme-handoff.md §4.3–§4.5, §5).
// - Titles moved into the hero band (Order Detail, Wallet, Profile).
// - The live pulse appears only on the in-progress state (StatusPill "Out for
//   delivery" on dark; the CURRENT journey node).
// - Profile initials fallback (generic icon, never "?" letters).
// - New opt-in variants keep their defaults and the canonical wording.
// Run: npx --prefix ../server tsx --test tests/brandThemeB3.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React, { type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The test runner compiles JSX in src with the classic runtime.
(globalThis as unknown as { React: typeof React }).React = React;

const { StatusPill } = await import('../src/components/customer/StatusPill');
const { CustomerJourney } = await import('../src/components/customer/CustomerJourney');
const { SegmentedLinkTabs } = await import('../src/components/customer/SegmentedTabs');
const { FilterChips } = await import('../src/components/customer/FilterChips');
const { DetailPanel } = await import('../src/components/customer/DetailPanel');
const { BrandBadge } = await import('../src/components/customer/BrandBadge');
const { getProfileInitials } = await import('../src/components/customer/customerProfilePresentation');
const { getPayoutStatusLabel, getPayoutStatusTone } = await import(
  '../src/components/customer/customerPayoutPresentation'
);
const { getWalletTransactionTypeTone } = await import('../src/components/customer/customerWalletPresentation');
const { MemoryRouter } = await import('react-router-dom');

const h = React.createElement;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const text = (markup: string) => markup.replace(/<[^>]+>/g, '');
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const page = (name: string) => strip(read(`../src/pages/customer/${name}.tsx`));

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

/** The JSX between `<CustomerHero…>` and `</CustomerHero>` (every occurrence). */
function heroBlocks(src: string): string[] {
  return [...src.matchAll(/<CustomerHero[^>]*>([\s\S]*?)<\/CustomerHero>/g)].map((m) => m[1]);
}

describe('titles moved into the hero', () => {
  test('Order Detail: summary (status, type, H1, tracking, dates, amount box) + 4-step bar in the hero', () => {
    const src = page('CustomerOrderDetailPage');
    const heroes = heroBlocks(src);
    assert.equal(heroes.length, 3, 'loading, error and loaded states each render a hero');
    for (const block of heroes) assert.ok(block.includes('<BackLink />'));
    const loaded = heroes.find((b) => b.includes('<OrderHero'))!;
    assert.ok(loaded.includes('<StageProgress status={order.status} variant="labelled" tone="dark" />'));

    const orderHero = src.slice(src.indexOf('function OrderHero'), src.indexOf('function TrackingCode'));
    assert.ok(orderHero.includes('<StatusPill status={order.status} tone="dark" />'));
    assert.ok(orderHero.includes('getOrderTypeLabel(order.orderType)'));
    assert.match(orderHero, /<h1 className="[^"]*font-sd-display[^"]*sm:text-\[2\.75rem\]">\s*\{order\.orderNumber\}/);
    assert.ok(orderHero.includes('<TrackingCode code={order.trackingCode} />'));
    assert.ok(orderHero.includes('Created {formatDate(order.createdAt)}'));
    assert.ok(orderHero.includes('Delivered {formatDate(order.deliveredAt)}'));
    assert.ok(orderHero.includes('<BalanceHeroCard tone="red"'));
    assert.ok(orderHero.includes('formatMoney(order.payment.amountToCollect)'));

    assert.equal((src.match(/<h1/g) ?? []).length, 1, 'one H1, in the hero');
    assert.ok(!src.includes('SummaryPanel'));
  });

  test('Order Detail: body panels are brand cards; Amount to collect in sd-red-text', () => {
    const src = page('CustomerOrderDetailPage');
    for (const t of ['Journey', 'Delivering to', 'Payment', 'Package']) {
      assert.match(src, new RegExp(`<DetailPanel title="${t}"[^>]*tone="brand"`), t);
    }
    assert.ok(src.includes("'font-sd-display text-xl font-bold text-sd-red-text'"));
    assert.ok(!/brand-(50|600|700)|bg-chrome|chrome-ink/.test(src));
  });

  test('Order Detail: 404 / not-owned and map-link safety unchanged', () => {
    const src = page('CustomerOrderDetailPage');
    assert.ok(src.includes("getApiErrorStatus(query.error as UnknownApiError) === 404"));
    assert.ok(src.includes("notFound ? 'Order not available' : 'Something went wrong'"));
    assert.ok(src.includes("notFound ? 'This order is not available.'"));
    assert.ok(src.includes('onRetry={notFound ? undefined :'));
    assert.ok(src.includes('{isSafeHttpUrl(r.mapLink) && ('));
    assert.ok(src.includes('href={r.mapLink.trim()}'));
    assert.ok(src.includes('rel="noopener noreferrer"'));
  });

  test('Wallet: one hero for all tabs with the highlight, red balance card and translucent pending card', () => {
    const src = page('CustomerWalletLayout');
    const [hero] = heroBlocks(src);
    assert.ok(hero.includes('eyebrow="Wallet"'));
    assert.ok(hero.includes('title="Your money,"') && hero.includes('highlight="clearly accounted."'));
    assert.ok(hero.includes('<AvailablePanel data={data} />') && hero.includes('<PendingPanel breakdown={pendingBreakdown(data)} />'));
    assert.ok(src.includes('<BalanceHeroCard tone="red"'));
    assert.ok(src.includes('<HeroMoney value={data.availableBalance} tone="red" />'));
    assert.ok(src.includes('<HeroStatTile'));
    assert.ok(src.includes('bg-sd-steel-light') && src.includes('bg-sd-red-logo'));
    // The tab pages carry no hero of their own: one hero serves all three tabs.
    for (const tabPage of ['CustomerTransactionsPage', 'CustomerPayoutsPage']) {
      assert.ok(!page(tabPage).includes('<CustomerHero'), tabPage);
    }
  });

  test('Wallet: notice, red-active tabs and About in the body; latest-payout chip keeps its states', () => {
    const src = page('CustomerWalletLayout');
    const body = src.slice(src.indexOf('</CustomerHero>'));
    assert.ok(body.indexOf('<ReviewNotice>') < body.indexOf('<SegmentedLinkTabs'));
    assert.ok(body.includes('tone="brand"'));
    assert.ok(body.includes('<AboutAmounts />'));
    assert.ok(src.includes('getLatestPayoutChipText(payouts.data?.items[0])'));
    assert.ok(src.includes('Loading latest payout…') && src.includes('Latest payout unavailable.'));
  });

  test('Profile: identity in the 960 px hero; panels brand-styled', () => {
    const src = page('CustomerProfilePage');
    const [hero] = heroBlocks(src);
    assert.ok(src.includes('<CustomerHero width="narrow">'));
    assert.ok(hero.includes('<IdentityHero data={data} />'));
    const identity = src.slice(src.indexOf('function IdentityHero'), src.indexOf('function Row'));
    assert.ok(identity.includes('<h1'));
    assert.ok(identity.includes("isMissingValue(data.name) ? 'Your profile' : data.name"));
    assert.ok(identity.includes('Customer number <strong'));
    assert.ok(identity.includes('bg-sd-red') && identity.includes('shadow-sd-red') && identity.includes('rounded-[18px]'));
    assert.equal((src.match(/<h1/g) ?? []).length, 1);
    assert.ok(!src.includes('IdentityPanel'));
    assert.ok(src.includes('<DetailPanel title="Contact" tone="brand">'));
    assert.ok(src.includes('<DetailPanel title="Default pickup details" tone="brand">'));
  });
});

describe('live pulse only on the in-progress state', () => {
  test('StatusPill on dark pulses only for "Out for delivery"', () => {
    const pulsing = STATUSES.filter((s) => html(h(StatusPill, { status: s, tone: 'dark' })).includes('sd-pulse'));
    assert.deepEqual(pulsing, ['OUT_FOR_DELIVERY']);
    assert.ok(html(h(StatusPill, { status: 'OUT_FOR_DELIVERY', tone: 'dark' })).includes('bg-sd-red text-white'));
    for (const s of STATUSES) assert.ok(!html(h(StatusPill, { status: s })).includes('sd-pulse'), `light ${s}`);
  });

  const tracking = (states: Array<'done' | 'current' | 'upcoming'>) => ({
    stages: states.map((state, i) => ({ code: `S${i}`, label: `Stage ${i}`, state, occurredAt: null })),
    exception: null,
    isDelivered: false,
  });

  test('Journey: only the current node pulses, in red', () => {
    const m = html(h(CustomerJourney, { tracking: tracking(['done', 'current', 'upcoming']), status: 'OUT_FOR_DELIVERY' }));
    assert.equal((m.match(/sd-pulse/g) ?? []).length, 1);
    assert.match(m, /<span class="size-2\.5 rounded-full bg-sd-red text-sd-red sd-pulse"><\/span>/);
    assert.ok(m.includes('ring-sd-red'));
  });

  test('Journey: no pulse when nothing is in progress', () => {
    assert.ok(!html(h(CustomerJourney, { tracking: tracking(['done', 'done', 'done']), status: 'DELIVERED' })).includes('sd-pulse'));
    assert.ok(!html(h(CustomerJourney, { tracking: tracking(['upcoming', 'upcoming']), status: 'RECEIVED' })).includes('sd-pulse'));
  });

  test('Journey keeps the server stages and the state words', () => {
    const m = html(h(CustomerJourney, { tracking: tracking(['done', 'current', 'upcoming']), status: 'OUT_FOR_DELIVERY' }));
    assert.equal(text(m), 'Stage 0DoneStage 1In progressStage 2Upcoming');
  });
});

describe('profile initials fallback', () => {
  test('initials from the name; null (generic icon) when empty', () => {
    assert.equal(getProfileInitials('Nour Haddad'), 'NH');
    for (const blank of ['', '   ', null, undefined]) assert.equal(getProfileInitials(blank), null);
  });

  test('the red tile renders the icon when there are no initials', () => {
    const identity = page('CustomerProfilePage');
    assert.ok(identity.includes('{initials ?? <UserRound'));
    assert.ok(identity.includes('aria-hidden="true"'));
  });
});

describe('brand variants', () => {
  test('SegmentedLinkTabs brand: light track, red active link; same semantics', () => {
    const items = [
      { to: '/customer/transactions', label: 'Transactions', current: true },
      { to: '/customer/payouts', label: 'Payouts', current: false },
    ];
    const m = html(h(MemoryRouter, null, h(SegmentedLinkTabs, { items, label: 'Wallet history', tone: 'brand' })));
    assert.ok(m.includes('bg-sd-line-subtle'));
    assert.match(m, /aria-current="page"[^>]*class="[^"]*bg-sd-red font-semibold text-white/);
    assert.ok(m.includes('<nav aria-label="Wallet history"'));
  });

  test('FilterChips: active sd-ink, aria-pressed kept', () => {
    const m = html(
      h(FilterChips, {
        label: 'Transaction type',
        options: [
          { value: 'all', label: 'All' },
          { value: 'payout', label: 'Payouts' },
        ],
        value: 'all',
        onChange: () => {},
      }),
    );
    assert.match(m, /aria-pressed="true"[^>]*class="[^"]*bg-sd-ink[^"]*text-white/);
    assert.match(m, /aria-pressed="false"/);
  });

  test('DetailPanel brand label heading is a Saira card label; default unchanged', () => {
    const brand = html(h(DetailPanel, { title: 'Payment', tone: 'brand' }, 'x'));
    assert.ok(brand.includes('font-sd-display text-[0.8125rem] font-semibold uppercase tracking-[0.12em]'));
    const plain = html(h(DetailPanel, { title: 'Payment' }, 'x'));
    assert.ok(plain.includes('text-[0.8125rem] font-bold uppercase tracking-[0.1em] text-ink-muted') && !plain.includes('sd-'));
  });

  test('BrandBadge: payout red-50, reversal #EEF0F2 / #3A4048; tones from the shared helpers', () => {
    // The tone helper is unchanged (PAYOUT = info); BrandBadge renders it red.
    assert.equal(getWalletTransactionTypeTone('PAYOUT'), 'info');
    assert.equal(getWalletTransactionTypeTone('REVERSAL'), 'neutral');
    const payout = html(h(BrandBadge, { tone: getWalletTransactionTypeTone('PAYOUT') }, 'Payout'));
    assert.ok(payout.includes('bg-sd-red-50 text-sd-red-text'));
    assert.ok(!payout.includes('info-'));
    assert.ok(html(h(BrandBadge, { tone: 'neutral' }, 'Reversal')).includes('bg-[#EEF0F2] text-[#3A4048]'));
  });

  test('payout cards keep "Completed" wording', () => {
    assert.equal(getPayoutStatusLabel('COMPLETED'), 'Completed');
    const m = html(h(BrandBadge, { tone: getPayoutStatusTone('COMPLETED'), dot: true }, getPayoutStatusLabel('COMPLETED')));
    assert.equal(text(m), 'Completed');
    assert.ok(page('CustomerPayoutsPage').includes('getPayoutStatusLabel(payout.status)'));
    assert.ok(!/['"]Paid['"]/.test(page('CustomerPayoutsPage')));
  });

  test('tab URL behaviour and the phone layout are unchanged', () => {
    const tx = page('CustomerTransactionsPage');
    assert.ok(tx.includes("if (id === 'all') next.delete('type');") && tx.includes("next.delete('page');"));
    assert.ok(tx.includes('sm:hidden') && tx.includes('min-w-[640px]'));
    assert.ok(page('CustomerPayoutsPage').includes("nextSp.set('page', String(next));"));
  });
});
