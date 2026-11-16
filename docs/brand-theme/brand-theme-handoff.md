# Brand Theme (Logo + Red) — Design Handoff

Status: **design proposal, pending approval** (not an approved implementation phase).
Design source: the "Spring Delivery brand — Customer Portal + Sign in" row on the Design canvas
(artboards `Brand · Sign in`, `Brand · Overview`, `Brand · My Orders`, `Brand · Order Detail`,
`Brand · Wallet`, `Brand · Profile`).
Assets: `docs/brand-theme/assets/` (§7).

Scope: **frontend only.** It covers the Customer Portal (shell + all customer pages) and the
sign-in page. It replaces the *visual* part of `docs/customer-portal-redesign-handoff.md`
(§1 visual language, §2 component looks, §3 page layouts, §8 sign-in looks). The **behaviour**
rules of that handoff (§4 must-not-change, §5 accessibility, data sources, empty/error states)
still apply unchanged. It changes no data, API, route, permission, business rule, money value,
status wording or validation.

The canvas is a visual reference (CLAUDE.md §41/§66). Names and amounts on it are placeholders.

---

## 0. Decisions needed before implementation

| # | Decision | Why | Options |
|---|----------|-----|---------|
| B-D1 | **Which portals get the brand look.** | The design covers Customer + sign-in only. The sign-in page is shared by every role. | **A** Customer Portal + sign-in now. Management and Driver keep their current look until they are designed (recommended). **B** Apply the brand palette app-wide now. That would need Management/Driver designs first. |
| B-D2 | **Where the brand tokens live.** | Management still uses the cobalt `brand-*` tokens. | **A** Add new `sd-*` tokens and use them only in customer/auth code (recommended: zero risk to other portals). **B** Repoint the global `brand-*` tokens to red. That affects every portal, so it requires B-D1 = B. |
| B-D3 | **Fonts.** | Design uses Saira (headings, money) + Inter (body). The customer shell currently uses Plus Jakarta Sans. | **A** Saira 500–800 + Inter, scoped to the Customer shell and AuthLayout (recommended). **B** Keep Plus Jakarta Sans and swap only colours and logo. |
| B-D4 | **Hero layout.** The dark hero band with overlapping cards (and the motion) is part of this design. It is **not yet in code**: Steps 1–6 built the earlier light layout. | It changes the shell structure, not just colours. | **A** Adopt the hero band as specified (recommended; it is the approved look). **B** Colours + logo only on the current layout. |

Everything below assumes A for all four.

---

## 1. Identity

**Character:** the logo's red and black, on a charcoal hero, with steel-grey accents taken from
the logo's ring. Squarer corners echo the blocky wordmark. Red italic highlight words echo
"DELIVERY". Faint speed lines and a slowly turning ring echo the logo's motion cues.

### 1.1 Tokens (new, `sd-*`, used only in customer/auth code — B-D2 A)

| Token | Value | Use / contrast |
|---|---|---|
| `--color-sd-red` | `#D11F2A` | primary buttons, active nav item, active tabs, red balance tiles, current progress step. White text on it ≈ 5.3:1 ✓ |
| `--color-sd-red-hover` | `#B01A24` | hover / pressed of red surfaces |
| `--color-sd-red-text` | `#C41C26` | red **text** on white (links, "to collect" amounts) ≈ 5.9:1 ✓ |
| `--color-sd-red-logo` | `#EF313F` | **decoration only** (rings, speed lines, bars, red italic words on charcoal ≈ 5:1 at ≥ 24 px). Never small text on white. |
| `--color-sd-red-50` | `#FDEEEF` | soft red backgrounds (icon tiles, "Out for delivery" pill) |
| `--color-sd-red-on` | `#FFE4E6` | secondary text on red surfaces |
| `--color-sd-ink` | `#0E0F12` | primary text, done progress steps |
| `--color-sd-charcoal` | `#121418` | hero band + header, sign-in brand panel |
| `--color-sd-charcoal-raised` | `#262A31` | avatar circle on charcoal |
| `--color-sd-on-dark` | `#B4BAC2` | secondary text on charcoal ≈ 9:1 ✓ |
| `--color-sd-on-dark-strong` | `#E4E7EB` | chips and buttons on charcoal |
| `--color-sd-steel` | `#46535F` | neutral icon colour (payout icon), reversal badge text |
| `--color-sd-steel-light` | `#CFD8DC` | orbit ring highlight, "pending delivery" bar on dark |
| `--color-sd-page` | `#F4F5F7` | page background |
| `--color-sd-line` / `-subtle` | `#E6E8EB` / `#F0F1F3` | card borders / row separators |
| `--color-sd-sunken` | `#F7F8F9` | amount strips, instruction boxes, row hover |
| `--color-sd-text-2` / `-muted` | `#4A5059` / `#5A6069` | secondary / muted text (AA on white) |

Success, warning and danger tones stay the existing semantic tokens (`success-700` etc.).

### 1.2 Radii & elevation

- Content cards 14–16 px. Hero tiles 14 px. Nav track 10 px, nav item 7 px. Chips and badges
  5–6 px. Buttons 8–10 px.
- Cards: `border 1px sd-line` + `shadow 0 8px 24px rgba(14,15,18,0.06)`. Red tiles:
  `shadow 0 14px 30px rgba(209,31,42,0.25)`.

### 1.3 Typography (B-D3 A)

Load **Saira 500/600/700/800** and **Inter 400/500/600/700** (Google Fonts or `@fontsource`).
Apply them only on the Customer shell root and the AuthLayout root.

| Use | Spec |
|---|---|
| Eyebrow (hero) | Saira 13 px, 600, `tracking 0.16em`, uppercase, `sd-on-dark` |
| H1 (hero) | Saira 42 px (30 px < sm), 700, leading 1.02, `-0.02em`. **Highlight words** in `sd-red-logo` *italic*, e.g. "Good evening, *Nour.*" |
| Card labels | Saira 13 px, 600, `tracking 0.12–0.14em`, uppercase |
| Section titles | Saira 20–22 px, 700 |
| Money / big numbers | Saira 700, `tabular-nums`. Hero balance 44–52 px; cents at ~50% size in `sd-red-on` (on red) or `sd-on-dark` |
| Body, table text, buttons | Inter 13–15 px |
| Primary button label (sign-in) | Saira 17 px, 700, `0.02em` |

---

## 2. Logo

| Place | Asset & size |
|---|---|
| Customer header | `sd-mark.png` 40 px wide + `sd-wordmark-white.png` 30 px tall, gap 8 px, in one link to `paths.customer.dashboard` with `aria-label="Spring Delivery home"`. Wordmark `alt="Spring Delivery"`, symbol `alt=""`. Replaces the blue tile + "Spring Delivery" text. |
| Sign-in brand panel | `sd-logo-white.png` 200 px wide, `alt="Spring Delivery"`. |
| Light backgrounds (future use) | `sd-logo.png` / `sd-wordmark.png`. |

Never recolour, stretch or redraw the logo in CSS. Use the PNGs as supplied.

---

## 3. Shell & hero band (B-D4 A)

### 3.1 Structure

```
┌ CustomerHero (full-bleed, bg sd-charcoal, position:relative, overflow:hidden) ─┐
│  decor: OrbitRing, RedArc, SpeedLines (aria-hidden)                            │
│  <header>  logo · pill nav · avatar/name/number · Sign out   (1px white/8 line)│
│  <section> eyebrow · H1 · lead · actions · key figures       (padding 28/64)  │
└────────────────────────────────────────────────────────────────────────────────┘
   <main> content cards, margin-top -36px (overlap the band), padding-bottom 48px
```

- `CustomerLayout` renders the header **inside** a dark band. Each page provides its hero
  content through a `hero` slot (for example a `<CustomerHero>` component, or a route `handle`
  / context). The layout renders the band = header + page hero, then the page body with
  `-36px` overlap. Content column `max-w-[1200px] px-6` (Profile 960 px).
- Header: padding 10 px 24 px, flex-wrap. **Nav**: track `bg white/6 rounded-[10px] p-1`;
  items `h-[34px] px-4 rounded-[7px] text-sm`. Active = `bg sd-red text-white font-semibold
  aria-current="page"`. Inactive `sd-on-dark`, hover `text-white bg-white/8`. Below lg the nav
  takes its own row and scrolls sideways, keeping the active item in view (already implemented).
- Account: 36 px avatar `sd-charcoal-raised`, name 14/600 white, customer number 12 px
  `sd-on-dark`. Sign out stays inside the existing UserMenu (`tone="dark"` button). No separate
  Sign out button. Keep the existing UserMenu behaviour and errors.
- The header scrolls with the page (it lives inside the band). It is not sticky.

### 3.2 Hero decoration (all `aria-hidden`, `pointer-events:none`)

| Element | Spec |
|---|---|
| OrbitRing | 680 px circle at right -180 / top -260. `border 2px rgba(207,216,220,0.10)`, `border-top-color rgba(207,216,220,0.35)`. Rotates 360° in 60 s, linear, infinite. |
| RedArc | 440 px circle at right -60 / top -140. `border 2px rgba(239,49,63,0.4)`, left and top sides transparent. Static. |
| SpeedLines | Overview, Wallet and sign-in only. Hidden below `md` (they would sit behind the nav on phones). 3–4 bars, 3 px tall (4 px on sign-in), widths 90–260 px, `linear-gradient(90deg, transparent, #EF313F)`, right-aligned at right 32 / top 96 (sign-in: left 0 / bottom 64). They slide in from +60 px with a fade, 1.1 s, staggered 0.12 s. |

### 3.3 On-dark component variants (extend the Step 1 components; do not fork them)

- **CustomerPageHeader** → `tone="dark"`: eyebrow / H1 (with optional `highlight` slot rendered
  red italic) / lead in the hero colours.
- **Hero tiles**: `HeroStatTile` translucent (`bg white/5 border white/8 rounded-[14px]
  p-[18px_20px]`), and `BalanceHeroCard` becomes the **red tile** (`bg sd-red`, red shadow,
  label `sd-red-on`, `HeroMoney` white with cents `sd-red-on`).
- **SegmentedTabs** `tone="dark"`: track `bg white/8 rounded-[10px]`; active `bg sd-red
  text-white`; inactive `sd-on-dark`; count chip active `bg black/22`, inactive `bg white/12`.
- **StatusPill** on dark: brand-tone statuses solid `sd-red` with a white pulsing dot (see §5);
  neutral tones `bg white/10 text-sd-on-dark-strong`.
- **StageProgress** colours: done `sd-ink` (on white) / `white` (on dark); current `sd-red`
  (white bg) / `sd-red-logo` (dark bg); upcoming `sd-line` / `white/16`; delivered `success-700`.
  Bars `rounded-[2px]`.

---

## 4. Pages

Data sources, empty/error states, URL behaviour and rules are exactly as already implemented
(Steps 2–6). Only the layout and look change.

### 4.1 Overview — `/customer/dashboard`
- **Hero:** eyebrow date; H1 "Good evening, *{firstName}.*" (fallback "Welcome back."); lead;
  white "View all orders →" button (`bg white text-sd-ink`, hover `#EFF1F3`).
  Key-figure grid `repeat(auto-fit,minmax(210px,1fr)) gap-3`: **red tile** Available balance
  (+ "Ready for payout" chip only when positive, + "Paid out to you by Spring Delivery. No
  request needed.") · translucent tiles Pending delivery · Pending settlement · Latest payout
  (status-word rule unchanged; hidden when none).
- **Body (overlapping):** row `minmax(260px,1fr)`: Active orders link card (icon tile
  `sd-red-50`/`sd-red`) · Delivered orders link card (success) · under-review notice (count
  only). Then "Orders in motion" (3fr) + "Wallet activity" (2fr) panels. Row hover
  `sd-sunken`. Debit icon `bg #EEF0F2 text-sd-steel`.

### 4.2 My Orders — `/customer/orders`
- **Hero:** eyebrow "My orders"; H1 "Every parcel, *at a glance.*"; lead "{active} on the way ·
  {delivered} delivered" (dashboard counts; omit the line when counts are not loaded). Dark
  SegmentedTabs on the right.
- **Body:** card grid as now. Cards: receiver Saira 20; type chip `bg #F0F1F3`; amount strip
  `sd-sunken`; **To collect in `sd-red-text`**; "View order" outline, hover border `sd-red`
  text `sd-red-text`. Pagination: Next = `bg sd-red`.

### 4.3 Order Detail — `/customer/orders/:id`
- **Hero:** "‹ All orders" (`sd-on-dark`); status pill + type chip; H1 order number Saira 44;
  tracking mono chip on `white/8` with the copy button (behaviour unchanged); "Created …"; on the
  right the **red "Amount to collect" box**. Below it, the 4-step bar on dark (§3.3).
- **Body:** Journey (3fr) with server stages; the current node has a red pulsing dot; done chips
  `#F0F1F3`. Right column: Delivering to (pin/phone icons `sd-red`), Payment (Amount to collect
  Saira 20 `sd-red-text`), Package.

### 4.4 Wallet — `/customer/wallet` (tabs: Overview · Transactions · Payouts)
- **Hero:** eyebrow "Wallet"; H1 "Your money, *clearly accounted.*". Two panels: **red card**
  Available balance (52 px) + chip "Latest payout · $X on {date}" on `white/18`; translucent
  Pending card with total, a bar (pending delivery `sd-steel-light`, pending settlement
  `sd-red-logo`, layout-only rule unchanged) and the legend.
- **Body:** under-review notice (count only); "About these amounts" definitions.
- **Transactions / Payouts** follow the code as implemented (D1-B, commit 7f797d2): they are
  **tabs inside the Wallet page** (`SegmentedLinkTabs`), not separate pages. The one Wallet hero
  above serves all three tabs. In the body, the tab bar uses the light variant with the active
  tab `bg sd-red text-white`, as on the canvas. Filter chips: active `bg sd-ink`;
  payout badge `sd-red-50`/`sd-red-text`; reversal `#EEF0F2`/`#3A4048`. Amounts in Saira.
  Payout cards keep "Completed" wording.

### 4.5 Profile — `/customer/profile`
- **Hero (960 px):** 76 px **red initials tile** (`rounded-[18px]`, red shadow, Saira 30);
  eyebrow "Profile"; H1 name; "Customer number **X**"; helper copy on the right.
- **Body:** Contact and Default pickup details panels as now.

---

## 5. Motion

| Effect | Spec |
|---|---|
| Stagger fade-up | Hero children, key-figure tiles, body cards and list rows: `translateY(14px)→0` + fade, 0.7 s `cubic-bezier(.22,.8,.24,1)`, delays 0.06 s apart (cap 0.36 s). |
| Bars grow | Progress bars and the pending bar: `scaleX(0→1)` from the left, 1 s, 0.35 s delay. |
| Orbit ring | 60 s linear rotation. |
| Speed lines | §3.2. |
| Live pulse | Current-stage dot and "Out for delivery" pill dot: expanding red ring, 2 s, infinite. |
| Hover | Cards rise 3 px + shadow `0 16px 32px rgba(14,15,18,0.10)`; list rows tint `sd-sunken`; buttons/links colour transition 0.2 s; press `scale(.98)`. |
| Reduced motion | Every animation and transition is off (`prefers-reduced-motion: reduce`). |

Use CSS keyframes and transitions only (transform/opacity). No JS animation loops.

---

## 6. Sign-in — `/auth/login` (all roles)

- **Brand panel (left, `sd-charcoal`):** OrbitRing (760 px) + RedArc (520 px) at bottom-right;
  SpeedLines bottom-left; `sd-logo-white.png` 200 px; eyebrow "Delivery management"; H2
  "Every parcel, *accounted for.*" (Saira 46, second part red italic); lead; three label chips
  (Management / Drivers / Customers, `bg white/7 border white/8 rounded-lg`). Below md: compact
  as in the earlier §8.1 rule (logo + headline only).
- **Form (right):** H1 "Welcome back" Saira 36; fields 50 px `rounded-[10px]`; focus `2px
  sd-red`; invalid border + message `#B01A24`; form error `bg #FDF0F0 border #F6D3D5 text
  #B01A24`; **primary button `bg sd-red` → hover `sd-red-hover` + red shadow**, Saira 17/700.
- Behaviour exactly as today (useLogin, redirect, generic error wording, validation messages).

---

## 7. Assets (`docs/brand-theme/assets/`)

| File | Size | Use |
|---|---|---|
| `sd-mark.png` | 264×256 | round S symbol |
| `sd-wordmark-white.png` | 441×160 | header wordmark on charcoal |
| `sd-wordmark.png` | 441×160 | wordmark on light backgrounds |
| `sd-logo-white.png` | 512×560 | full logo on charcoal (sign-in) |
| `sd-logo.png` | 512×560 | full logo on light backgrounds |

Transparent PNGs produced from the supplied logo PDF. Move them to `client/src/assets/brand/`.

---

## 8. Must not change

All rules of `customer-portal-redesign-handoff.md` §4 still apply: read-only portal, self-scoped
`/customer/me/*`, no driver identity, under-review count only, money via `formatMoney`,
canonical status wording, no withdraw or payout-request control. With B-D1 A, Management and
Driver are visually unchanged.

## 9. Suggested implementation order (one session each, review between)

1. **B1 Foundation:** `sd-*` tokens, Saira + Inter (scoped), assets, the hero-band shell
   (header in band + hero slot + overlap), decor components, on-dark variants, motion utilities.
   No page restyle yet, except that every page renders without breaking in the new shell.
2. **B2:** Overview + My Orders.
3. **B3:** Order Detail + Wallet / Transactions / Payouts + Profile.
4. **B4:** Sign-in + full regression (visual 390 / 768 / 1280, keyboard, reduced motion; the
   Management/Driver portals unchanged).

The holiday theme (`docs/holiday-theme/holiday-theme-handoff.md`) is an optional overlay on top
of this brand theme. Implement it only after B4.
