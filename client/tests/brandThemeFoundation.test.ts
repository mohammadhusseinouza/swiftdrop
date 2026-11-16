// Brand Theme — Step B1 foundation (docs/brand-theme/brand-theme-handoff.md §1–§3, §5, §7).
// - Default variants of the extended customer components render EXACTLY as before
//   (markup compared with tests/fixtures/customer-default-variants.json, captured
//   before B1 from the pre-B1 components).
// - On-dark variants, decoration (aria-hidden, pointer-events none), reduced motion,
//   additive sd-* tokens, scoped fonts, logo assets and the hero-band shell.
// Run: npx --prefix ../server tsx --test tests/brandThemeFoundation.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import React, { type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The test runner compiles JSX in src with the classic runtime.
(globalThis as unknown as { React: typeof React }).React = React;

const { CustomerPageHeader } = await import('../src/components/customer/CustomerPageHeader');
const { BalanceHeroCard, HeroMoney, HeroTileLabel } = await import('../src/components/customer/BalanceHeroCard');
const { SegmentedTabs, SegmentedLinkTabs } = await import('../src/components/customer/SegmentedTabs');
const { StatusPill } = await import('../src/components/customer/StatusPill');
const { StageProgress } = await import('../src/components/customer/StageProgress');
const { HeroStatTile } = await import('../src/components/customer/HeroStatTile');
const { OrbitRing, RedArc, SpeedLines } = await import('../src/components/customer/HeroDecor');
const { CustomerHero } = await import('../src/components/customer/CustomerHero');
const { MemoryRouter } = await import('react-router-dom');

const h = React.createElement;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const text = (markup: string) => markup.replace(/<[^>]+>/g, '');

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

const TAB_ITEMS = [
  { value: 'a', label: 'A', count: 3 },
  { value: 'b', label: 'B', count: 0 },
  { value: 'c', label: 'C' },
] as const;

/** The exact render set the fixture was captured from (pre-B1 components). */
function renderDefaults(): Record<string, string> {
  const out: Record<string, string> = {};
  out.header = html(h(CustomerPageHeader, { eyebrow: 'Wallet', title: 'Your money', lead: 'Lead', action: h('button', null, 'x') }));
  out.headerMin = html(h(CustomerPageHeader, { title: 'T' }));
  out.balance = html(h(BalanceHeroCard, { className: 'c' }, h(HeroMoney, { value: '1234.50' })));
  out.money = html(h(HeroMoney, { value: '12.00', className: 'mt-5' }));
  out.tabs = html(h(SegmentedTabs, { items: TAB_ITEMS, value: 'a', onChange: () => {}, label: 'L', panelId: 'p' }));
  for (const s of STATUSES) {
    out[`pill:${s}`] = html(h(StatusPill, { status: s }));
    out[`stage:${s}`] = html(h(StageProgress, { status: s }));
    out[`stageL:${s}`] = html(h(StageProgress, { status: s, variant: 'labelled', reachedStage: 2 }));
  }
  return out;
}

describe('default variants are unchanged', () => {
  test('markup is identical to the pre-B1 fixture', () => {
    const fixture = JSON.parse(read('./fixtures/customer-default-variants.json')) as Record<string, string>;
    const now = renderDefaults();
    assert.deepEqual(Object.keys(now).sort(), Object.keys(fixture).sort());
    for (const key of Object.keys(fixture)) assert.equal(now[key], fixture[key], key);
  });

  test('explicit light / chrome tones equal the defaults', () => {
    assert.equal(
      html(h(CustomerPageHeader, { title: 'T', tone: 'light' })),
      html(h(CustomerPageHeader, { title: 'T' })),
    );
    assert.equal(html(h(BalanceHeroCard, { tone: 'chrome' }, 'x')), html(h(BalanceHeroCard, null, 'x')));
    assert.equal(html(h(HeroMoney, { value: '5.25', tone: 'chrome' })), html(h(HeroMoney, { value: '5.25' })));
    for (const s of STATUSES) {
      assert.equal(html(h(StatusPill, { status: s, tone: 'light' })), html(h(StatusPill, { status: s })));
      assert.equal(html(h(StageProgress, { status: s, tone: 'light' })), html(h(StageProgress, { status: s })));
    }
  });

  test('SegmentedLinkTabs default is unchanged (light tone = no tone)', () => {
    const items = [
      { to: '/customer/transactions', label: 'Transactions', current: true },
      { to: '/customer/payouts', label: 'Payouts', current: false },
    ];
    const plain = html(h(MemoryRouter, null, h(SegmentedLinkTabs, { items, label: 'Wallet history' })));
    const light = html(h(MemoryRouter, null, h(SegmentedLinkTabs, { items, label: 'Wallet history', tone: 'light' })));
    assert.equal(light, plain);
    assert.ok(plain.includes('bg-neutral-200'));
    assert.ok(!plain.includes('sd-'));
  });
});

describe('on-dark variants', () => {
  test('CustomerPageHeader dark: hero colours, Saira, red italic highlight', () => {
    const m = html(h(CustomerPageHeader, { tone: 'dark', eyebrow: 'Wallet', title: 'Good evening,', highlight: 'Nour.', lead: 'Lead' }));
    assert.match(m, /<h1 class="[^"]*font-sd-display[^"]*text-white/);
    assert.match(m, /<em class="italic text-sd-red-logo">Nour\.<\/em>/);
    assert.match(m, /<p class="[^"]*tracking-\[0\.16em\][^"]*text-sd-on-dark">Wallet<\/p>/);
    assert.ok(m.includes('text-sd-on-dark">Lead'));
    assert.equal(text(m), 'WalletGood evening, Nour.Lead');
  });

  test('BalanceHeroCard red: sd-red tile with red shadow and no rings', () => {
    const m = html(h(BalanceHeroCard, { tone: 'red' }, h(HeroMoney, { value: '1234.50', tone: 'red' })));
    assert.ok(m.includes('bg-sd-red') && m.includes('shadow-sd-red') && m.includes('rounded-[14px]'));
    assert.ok(!m.includes('bg-chrome') && !m.includes('aria-hidden'));
    assert.match(m, /<span class="[^"]*text-sd-red-on">\.50<\/span>/);
  });

  test('HeroMoney brand tones keep the exact formatted amount (no arithmetic)', () => {
    for (const tone of ['chrome', 'red', 'dark'] as const) {
      assert.equal(text(html(h(HeroMoney, { value: '1234.50', tone }))), text(html(h(HeroMoney, { value: '1234.50' }))));
    }
    assert.ok(html(h(HeroMoney, { value: '9.10', tone: 'dark' })).includes('text-sd-on-dark">.10'));
  });

  test('HeroStatTile is translucent; HeroTileLabel tones', () => {
    const m = html(h(HeroStatTile, { label: 'Pending delivery' }, '$1.00'));
    for (const c of ['bg-white/5', 'border-white/8', 'rounded-[14px]', 'px-5', 'py-[18px]']) assert.ok(m.includes(c), c);
    assert.ok(m.includes('Pending delivery'));
    assert.ok(html(h(HeroTileLabel, null, 'Available')).includes('text-sd-red-on'));
    assert.ok(html(h(HeroTileLabel, { tone: 'dark' }, 'Pending')).includes('text-sd-on-dark'));
  });

  test('SegmentedTabs dark: red active tab, same tab semantics and counts', () => {
    const light = html(h(SegmentedTabs, { items: TAB_ITEMS, value: 'a', onChange: () => {}, label: 'L', panelId: 'p' }));
    const dark = html(h(SegmentedTabs, { items: TAB_ITEMS, value: 'a', onChange: () => {}, label: 'L', panelId: 'p', tone: 'dark' }));
    assert.ok(dark.includes('bg-white/8') && dark.includes('rounded-[10px]'));
    assert.match(dark, /aria-selected="true"[^>]*class="[^"]*bg-sd-red font-semibold text-white/);
    assert.match(dark, /aria-selected="false"[^>]*class="[^"]*text-sd-on-dark/);
    assert.ok(dark.includes('bg-black/22') && dark.includes('bg-white/12'));
    // Same roles / aria / text as the light control.
    const attrs = (m: string) => (m.match(/(role|aria-[a-z]+|tabindex)="[^"]*"/g) ?? []).join(' ');
    assert.equal(attrs(dark), attrs(light));
    assert.equal(text(dark), text(light));
  });

  test('SegmentedLinkTabs dark keeps aria-current link semantics', () => {
    const items = [
      { to: '/customer/transactions', label: 'Transactions', current: true },
      { to: '/customer/payouts', label: 'Payouts', current: false },
    ];
    const m = html(h(MemoryRouter, null, h(SegmentedLinkTabs, { items, label: 'Wallet history', tone: 'dark' })));
    assert.match(m, /aria-current="page"[^>]*class="[^"]*bg-sd-red/);
    assert.ok(m.includes('<nav aria-label="Wallet history"'));
  });

  test('StatusPill dark: brand tone solid red with pulsing dot; neutral translucent; same wording', () => {
    for (const s of STATUSES) {
      const dark = html(h(StatusPill, { status: s, tone: 'dark' }));
      const light = html(h(StatusPill, { status: s }));
      assert.equal(text(dark), text(light), s);
      if (light.includes('bg-brand-50')) {
        assert.ok(dark.includes('bg-sd-red text-white') && dark.includes('sd-pulse'), s);
      } else {
        assert.ok(!dark.includes('sd-pulse'), s);
      }
      if (light.includes('bg-canvas')) assert.ok(dark.includes('bg-white/10 text-sd-on-dark-strong'), s);
    }
    assert.ok(html(h(StatusPill, { status: 'OUT_FOR_DELIVERY', tone: 'dark' })).includes('sd-pulse'));
  });

  test('StageProgress dark: done white, current sd-red-logo, upcoming white/16, delivered success; same text', () => {
    const at = (status: string) => html(h(StageProgress, { status, tone: 'dark' }));
    const segments = (m: string) => [...m.matchAll(/<span class="h-1\.5 rounded-\[2px\] ([^"]+)"/g)].map((x) => x[1]);
    assert.deepEqual(segments(at('OUT_FOR_DELIVERY')), ['bg-white', 'bg-white', 'bg-sd-red-logo', 'bg-white/16']);
    assert.deepEqual(segments(at('RECEIVED')), ['bg-sd-red-logo', 'bg-white/16', 'bg-white/16', 'bg-white/16']);
    assert.deepEqual(segments(at('DELIVERED')), Array(4).fill('bg-success-700'));
    assert.deepEqual(segments(at('CANCELLED')), Array(4).fill('bg-white/16'));
    assert.ok(at('OUT_FOR_DELIVERY').includes('sd-grow'));
    for (const s of STATUSES) {
      for (const variant of ['compact', 'labelled'] as const) {
        assert.equal(
          text(html(h(StageProgress, { status: s, variant, tone: 'dark' }))),
          text(html(h(StageProgress, { status: s, variant }))),
          `${s} ${variant}`,
        );
      }
    }
  });
});

describe('hero decoration', () => {
  const decor = {
    OrbitRing: html(h(OrbitRing)),
    RedArc: html(h(RedArc)),
    SpeedLines: html(h(SpeedLines)),
    SpeedLinesSignin: html(h(SpeedLines, { variant: 'signin' })),
  };

  for (const [name, m] of Object.entries(decor)) {
    test(`${name} is aria-hidden, pointer-events none, text-free`, () => {
      assert.match(m, /^<span aria-hidden="true"[^>]*class="[^"]*pointer-events-none/);
      assert.equal(text(m), '');
    });
  }

  test('spec details: orbit turns, arc is static, 3–4 speed lines 90–260 px staggered 0.12 s', () => {
    assert.ok(decor.OrbitRing.includes('sd-orbit') && decor.OrbitRing.includes('size-[680px]'));
    assert.ok(!/sd-(orbit|rise|grow|speed)/.test(decor.RedArc), 'RedArc is static');
    assert.ok(decor.RedArc.includes('size-[440px]') && decor.RedArc.includes('border-l-transparent'));
    const widths = [...decor.SpeedLines.matchAll(/width:(\d+)px/g)].map((x) => Number(x[1]));
    assert.ok(widths.length >= 3 && widths.length <= 4);
    assert.ok(widths.every((w) => w >= 90 && w <= 260));
    assert.deepEqual([...decor.SpeedLines.matchAll(/animation-delay:([\d.]+)s/g)].map((x) => Number(x[1])), widths.map((_, i) => +(i * 0.12).toFixed(2)));
    assert.ok(decor.SpeedLines.includes('h-[3px]') && decor.SpeedLinesSignin.includes('h-1'));
  });

  test('CustomerHero renders in place outside the shell', () => {
    assert.ok(html(h(CustomerHero, null, h('p', null, 'hi'))).includes('<p>hi</p>'));
  });
});

describe('motion utilities + reduced motion', () => {
  const css = read('../src/index.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const reduceStart = css.indexOf('@media (prefers-reduced-motion: reduce)');
  const reduce = css.slice(reduceStart);
  const before = css.slice(0, reduceStart);

  test('every sd-* rule that animates or transitions is switched off under reduced motion', () => {
    assert.ok(reduceStart > 0);
    const rules = [...before.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, sel, body]) => /\.sd-/.test(sel) && /\b(animation|transition)\s*:/.test(body))
      .map(([, sel]) => sel.trim());
    assert.ok(rules.length >= 8, rules.join(' | '));
    const off = reduce.match(/([^{}]+)\{\s*animation: none !important;\s*transition: none !important;\s*\}/);
    assert.ok(off, 'reduce block disables animation + transition');
    const offSelectors = off[1].split(',').map((s) => s.trim());
    for (const sel of rules) {
      const target = sel === '.sd-pulse::after' ? sel : sel.replace(/:(hover|active)$/, '');
      assert.ok(offSelectors.includes(target), `not disabled under reduced motion: ${sel}`);
    }
  });

  test('the named effects exist (stagger, grow, pulse, lift, row hover, orbit, speed lines)', () => {
    for (const cls of ['.sd-rise', '.sd-stagger', '.sd-grow', '.sd-pulse', '.sd-lift', '.sd-row', '.sd-orbit', '.sd-speed-line', '.sd-press']) {
      assert.ok(before.includes(`${cls} `) || before.includes(`${cls}:`) || before.includes(`${cls}::`), cls);
    }
    assert.match(before, /\.sd-stagger > :nth-child\(n \+ 7\) \{ animation-delay: 360ms; \}/);
    assert.ok(before.includes('animation: sd-orbit 60s linear infinite'));
    assert.ok(before.includes('animation: sd-pulse 2s ease-out infinite'));
    assert.ok(reduce.includes('.sd-lift:hover'));
  });
});

describe('tokens, fonts, assets', () => {
  const css = read('../src/index.css');

  test('sd-* tokens from §1.1 exist with the specified values', () => {
    const expected: Record<string, string> = {
      'sd-red': '#d11f2a', 'sd-red-hover': '#b01a24', 'sd-red-text': '#c41c26', 'sd-red-logo': '#ef313f',
      'sd-red-50': '#fdeeef', 'sd-red-on': '#ffe4e6', 'sd-ink': '#0e0f12', 'sd-charcoal': '#121418',
      'sd-charcoal-raised': '#262a31', 'sd-on-dark': '#b4bac2', 'sd-on-dark-strong': '#e4e7eb',
      'sd-steel': '#46535f', 'sd-steel-light': '#cfd8dc', 'sd-page': '#f4f5f7', 'sd-line': '#e6e8eb',
      'sd-line-subtle': '#f0f1f3', 'sd-sunken': '#f7f8f9', 'sd-text-2': '#4a5059', 'sd-text-muted': '#5a6069',
    };
    for (const [name, value] of Object.entries(expected)) {
      assert.ok(css.includes(`--color-${name}: ${value};`), name);
    }
  });

  test('existing global tokens are untouched (B-D2 A)', () => {
    for (const line of [
      '--color-brand-600: #2b49e5;', '--color-brand-50: #eef1fe;', '--color-brand-700: #2138be;',
      '--color-chrome: #0e1524;', '--color-canvas: #f5f6f8;', '--color-ink: #101319;',
      "--font-customer: 'Plus Jakarta Sans', 'Inter', system-ui, sans-serif;",
    ]) assert.ok(css.includes(line), line);
    assert.match(css, /--font-sans:\s*'Inter', system-ui/);
  });

  test('fonts: Saira 500–800 + Inter, loaded only by the brand shell', () => {
    const fonts = read('../src/components/customer/brandFonts.ts');
    for (const w of ['500', '600', '700', '800']) assert.ok(fonts.includes(`@fontsource/saira/${w}.css`), w);
    assert.ok(fonts.includes('@fontsource-variable/inter/wght.css'));
    assert.ok(css.includes("--font-sd-display: 'Saira'") && css.includes("'Inter Variable'"));
    const shell = strip(read('../src/layouts/CustomerLayout.tsx'));
    assert.ok(shell.includes("import '../components/customer/brandFonts';"));
    assert.ok(shell.includes('font-sd-body'));
    // B4: AuthLayout (sign-in) is the second brand root and loads the fonts too.
    const auth = strip(read('../src/layouts/AuthLayout.tsx'));
    assert.ok(auth.includes("import '../components/customer/brandFonts';") && auth.includes('font-sd-body'));
    for (const other of ['ManagementLayout', 'DriverLayout', 'PublicLayout']) {
      const src = read(`../src/layouts/${other}.tsx`);
      assert.ok(!src.includes('brandFonts') && !/\bsd-/.test(src), other);
    }
    assert.ok(!read('../src/main.tsx').includes('fontsource'));
  });

  test('logo assets are present in client/src/assets/brand', () => {
    for (const f of ['sd-logo.png', 'sd-logo-white.png', 'sd-mark.png', 'sd-wordmark.png', 'sd-wordmark-white.png']) {
      assert.ok(existsSync(new URL(`../src/assets/brand/${f}`, import.meta.url)), f);
    }
  });
});

describe('hero-band shell', () => {
  const shell = strip(read('../src/layouts/CustomerLayout.tsx'));

  test('logo link replaces the blue tile + text', () => {
    assert.ok(shell.includes('aria-label="Spring Delivery home"'));
    assert.ok(shell.includes('to={paths.customer.dashboard}'));
    assert.ok(shell.includes('src={sdMark} alt=""'));
    assert.ok(shell.includes('alt="Spring Delivery"'));
    assert.ok(!shell.includes('Package') && !shell.includes('bg-brand-600'));
  });

  test('header lives in the charcoal band; red active nav; decor; overlap', () => {
    assert.ok(shell.includes('bg-sd-charcoal'));
    assert.ok(shell.includes("'bg-sd-red font-semibold text-white'"));
    assert.ok(shell.includes('<OrbitRing />') && shell.includes('<RedArc />') && shell.includes('<SpeedLines />'));
    assert.ok(shell.includes('-mt-9'));
    assert.ok(shell.includes('CustomerHeroContext.Provider'));
  });

  test('behaviour kept: nav model, aria-current, scroll-into-view fix, UserMenu sign-out', () => {
    assert.ok(shell.includes('<nav') && shell.includes('aria-label="Customer navigation"'));
    assert.ok(shell.includes('CUSTOMER_NAV_ITEMS.map('));
    assert.ok(shell.includes("aria-current={active ? 'page' : undefined}"));
    assert.ok(shell.includes('revealActive') && shell.includes("window.addEventListener('resize', revealActive)"));
    assert.ok(shell.includes('onSignOut={handleSignOut}') && shell.includes('signOutError={signOutError}'));
    assert.ok(shell.includes("'Unable to sign out. Please try again.'"));
    assert.ok(shell.includes('<Outlet />'));
  });

  test('every customer page renders hero content (no page left without a title area)', () => {
    for (const page of ['CustomerDashboardPage', 'CustomerOrdersPage', 'CustomerWalletLayout', 'CustomerOrderDetailPage', 'CustomerProfilePage']) {
      assert.ok(strip(read(`../src/pages/customer/${page}.tsx`)).includes('<CustomerHero'), page);
    }
  });

  test('UserMenu: dark tone is opt-in; other portals keep the default trigger', () => {
    assert.ok(shell.includes('tone="dark"'));
    for (const other of ['ManagementLayout', 'DriverLayout']) {
      assert.ok(!/<UserMenu[^>]*tone=/s.test(read(`../src/layouts/${other}.tsx`)), other);
    }
  });
});
