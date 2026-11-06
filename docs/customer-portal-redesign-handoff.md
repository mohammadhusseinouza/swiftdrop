# Customer Portal Redesign — Design Handoff

Status: **design proposal, pending approval** (not an approved implementation phase).
Design source: the "Customer Portal Redesign" Design canvas (artboards `Overview`, `My Orders`,
`Order Detail`, `Wallet · Activity · Payouts`, `Profile`).
Scope: **frontend only** — `client/src/layouts/CustomerLayout.tsx`, `client/src/pages/customer/*`,
`client/src/components/customer/*`. No backend, API, schema or business-rule change is required.

The canvas is a visual reference (CLAUDE.md §41/§66). Sample names, amounts and order numbers on
it are placeholders; every value on screen must come from the existing Customer APIs, unchanged.

---

## 0. Decisions needed before implementation

| # | Decision | Why | Options |
|---|----------|-----|---------|
| D1 | **Navigation items.** The design shows 4 items (Overview · Orders · Wallet · Profile) with Transactions and Payouts as tabs inside Wallet. `page_structure.md` §32 lists 6 items. | Direct conflict with the approved page structure (CLAUDE.md §2: stop and flag). | **A** keep the 6 approved items in the same pill nav (no doc change; fits at desktop, scrolls on phone). **B** adopt 4 items + Wallet tabs and update `page_structure.md` §32 first. Routes stay identical either way. |
| D2 | **Font.** Design uses Plus Jakarta Sans; the app theme declares Inter. | Global font change affects all portals. | **A** scope Plus Jakarta Sans to the Customer shell only (recommended). **B** keep Inter (design still works; slightly less character). |
| D3 | **"Last payout" on the balance card.** Not part of the dashboard DTO. | Needs a second query on Overview. | **A** read page 1 of `/customer/me/payouts?limit=1` (no backend change). **B** omit the line. |

Everything below assumes D1 = A-or-B (both specified), D2 = A, D3 = A.

---

## 1. Visual language

"Midnight & Cobalt": calm light canvas, white panels with hairline borders (no heavy shadows),
one dark "chrome" panel per page for the headline money figure, cobalt as the single accent,
large tight-tracked numerals, generous spacing.

### 1.1 Tokens — reuse the existing theme

All design colours map to tokens that already exist in `client/src/index.css`. Do **not**
hard-code the canvas hexes.

| Design value | Use token | Role |
|---|---|---|
| `#F3F4F8` | `canvas` | page background |
| `#FFFFFF` | `card` | panels |
| `#E7E9F0` | `line` | panel borders, dividers |
| `#F0F1F5` | `line-subtle` | row separators inside panels |
| `#F7F8FA` | `sunken` | inset blocks (amount strip, instructions) |
| `#0F1422` | `ink` | primary text, dark buttons, completed progress |
| `#4A5163` | `ink-secondary` | secondary text, inactive nav |
| `#5E6577` | `ink-muted` | labels, meta (AA-checked) |
| `#0E1524` | `chrome` | dark balance / amount panels |
| `#A9B1C2`, `#8E97AA` | `chrome-ink` (+ new `chrome-ink-soft`, see below) | text on dark panels |
| `#2B49E5` | `brand-600` | accent: active stage, links, logo tile |
| `#EEF1FE` | `brand-50` | accent soft fills |
| `#15803D` / `#EAF7EF` | `success-700` / `success-50` | credits, delivered, paid |
| `#B45309` / `#FEF6E7` / `#F3DDAE` | `warning-700` / `warning-50` / `warning-200` | under-review notices |

New tokens (additive only, in `@theme`):

```css
--font-customer: 'Plus Jakarta Sans', 'Inter', system-ui, sans-serif; /* D2-A */
--color-warning-800: #7a3e07;   /* body text inside warning banners (AA on warning-50) */
--color-chrome-ink-soft: #8e97aa; /* tertiary text on chrome panels */
--radius-panel: 1.375rem;       /* 22px — all customer panels */
--radius-hero: 1.625rem;        /* 26px — dark balance panels */
```

Pills / segmented controls use `rounded-full`. Controls use the existing `rounded-control`
(10px) or 11–12px where noted.

Font loading (D2-A): add Plus Jakarta Sans 400/500/600/700 (`@fontsource/plus-jakarta-sans` or a
Google Fonts `<link>` in `index.html`) and apply `font-[--font-customer]` (or a `font-customer`
utility) on the `CustomerLayout` root only.

### 1.2 Type scale

| Use | Size / weight / tracking |
|---|---|
| Eyebrow (above H1, card labels) | 12px, 700, `tracking-[0.12em]`, uppercase, `ink-muted` |
| Page H1 | 42px (`text-[2.625rem]`), 700, `-0.035em`, leading 1.08 — 30px under `sm` |
| Page lead | 16px, `ink-secondary` |
| Panel title | 18px, 700, `-0.02em` |
| Section label inside detail panels | 13px, 700, `tracking-[0.1em]`, uppercase, `ink-muted` |
| Hero money | 60–64px, 700, `-0.04em`, `tabular-nums`; cents rendered at ~45% size in `chrome-ink` |
| Stat number | 44px, 700, `-0.04em` |
| Row primary / secondary | 14–15px 600–700 / 12–13px `ink-muted` |

All money uses `tabular-nums`. Money strings come from `formatMoney()` — never parse to float to
split dollars/cents; split the formatted string at the last `.` for display only.

### 1.3 Spacing & layout

- Content column: `max-w-[1200px] mx-auto px-6`, page padding `pt-11 pb-18` (Profile: `max-w-[960px]`).
- Vertical rhythm between page sections: 28px (`gap-7`). Gaps between panels: 20–24px.
- Panels: `bg-card border border-line rounded-panel`, padding 26–32px. **No `shadow-card`** on
  customer panels (borders only); the only shadow is the active nav/segment pill.
- Responsive: rows are `flex flex-wrap` with `flex-basis` minimums (e.g. hero `flex-[2_1_560px]`,
  side `flex-[1_1_300px]`), so they stack below ~900px without breakpoints.

---

## 2. Shared components (new, in `components/customer/`)

| Component | Notes |
|---|---|
| `CustomerShell` (rewrite of `CustomerLayout`) | White header, 1px bottom `line`. Left: logo tile (36px, `rounded-[11px]`, `bg-brand-600`, white `Package` icon) + "Spring Delivery" 16/700. Centre-left: **pill nav** in a `bg-canvas rounded-full p-1` track; items `h-9 px-[18px] rounded-full text-sm`; active = `bg-card font-semibold text-ink` + `shadow-[0_1px_2px_rgba(15,20,34,.08),0_0_0_1px_rgba(15,20,34,.04)]`, `aria-current="page"`. Right: initials avatar (38px, `bg-brand-50 text-brand-700`), name + customer number, then the existing `UserMenu` sign-out behaviour (keep its error handling). Header is `sticky top-0`. Under `sm` the nav track becomes a full-width horizontally scrolling row. With D1-B, Wallet is active for `/customer/wallet`, `/transactions` and `/payouts`. |
| `CustomerPageHeader` | Eyebrow + H1 + lead + optional right-aligned action; `flex flex-wrap items-end justify-between`. |
| `BalanceHeroCard` | `bg-chrome text-white rounded-hero p-8`. Decorative concentric rings: three absolutely positioned bordered circles (`border-white/7`, innermost `border-brand-600 opacity-55`), `aria-hidden`. No gradients. |
| `StageProgress` | 4 equal segments (`h-1.5 rounded-full gap-1`), optional labels under each. Filled segments: `ink`; when current stage is Out for Delivery: `brand-600`; when Delivered: `success-700`; unfilled: `line`. Current label bold. State must also be readable as text (stage label next to the bar). |
| `StatusPill` | `h-[26px] px-2.5 rounded-full text-xs font-bold` with a 6px dot. Tones per §3.2. Wording from the existing Customer-safe mapping (`getCustomerStatusPresentation`). |
| `SegmentedTabs` | Track `bg-[#E9EBF1]` (or `bg-neutral-200`) `rounded-[14px] p-1`; tab `h-10 rounded-[11px]`; active white + shadow; optional count chip (active: `bg-ink text-white`, inactive: `bg-line-strong text-ink-secondary`). `role="tablist"`/`role="tab"`/`aria-selected`. |
| `FilterChips` | `h-[34px] rounded-full border`; on = `bg-ink text-white border-ink`, off = `bg-card border-line text-ink-secondary`; `aria-pressed`. |
| `ReviewNotice` | `bg-warning-50 border border-warning-200 rounded-2xl`, 34px icon tile `bg-[#FBE7C2] text-warning-700` with `TriangleAlert`, text `text-warning-800`, `role="status"`. |
| `DetailPanel` | white panel with the uppercase section label. |

Icons: keep `lucide-react` (`Package`, `Truck`, `Check`, `ArrowDownLeft`, `ArrowUpRight`,
`MapPin`, `Calendar`, `Phone`, `Copy`, `ChevronLeft/Right`, `TriangleAlert`). Stroke 2, 14–18px.

Existing `StatisticCard`, `PageHeader`, `Badge`, `Card` stay unchanged for the other portals.

---

## 3. Pages

All loading / error / empty states keep their current behaviour (`LoadingState`, `ErrorState`
with retry, `EmptyState` with the existing copy), rendered inside a `rounded-panel` white panel.

### 3.1 Overview — `/customer/dashboard` (artboard "Overview")

Data: `useGetCustomerDashboardQuery()`; plus `useGetCustomerOrdersQuery({ view: 'active', page: 1, limit: 4 })`,
`useGetCustomerWalletTransactionsQuery({ page: 1, limit: 5 })`, `useGetCustomerPayoutsQuery({ page: 1, limit: 1 })` (D3).
The server already accepts `limit` (max 100) on all three; add `limit?: number` to the client
param types only.

1. **Header** — eyebrow: today's date (`formatDate`, weekday + day + month); H1: time-of-day
   greeting + `customer.name` first token ("Good evening, Nour."); fall back to "Welcome back."
   when name is blank. Action: dark button "View all orders →" → `paths.customer.orders`.
2. **Balance hero** (left, `flex-[2_1_560px]`): eyebrow "Available balance"; chip "Ready for
   payout" with green dot — show only when `availableWalletBalance > 0` (compare via Decimal /
   string helper, not float); hero money; copy "Spring Delivery arranges and sends your payouts.
   There is nothing you need to request." Divider `white/10`, then 3 mini-stats:
   Pending delivery (`pendingDeliveryAmount`), Pending settlement (`pendingSettlementAmount`),
   Latest payout (D3: newest payout from page 1 — amount + date + method; when its status is not
   COMPLETED append the status word, e.g. "· Reversed"; hide the column when there is no payout).
   The payouts endpoint deliberately has no status filter, so never label it "paid".
   **No Withdraw / Request Payout control** (V1 rule).
3. **Stat cards** (right column, stacked): Active orders (`activeOrders`, `Truck` on `brand-50`),
   Delivered orders (`deliveredOrders`, `Check` on `success-50`). Whole card is a link to
   Orders (`?view=active` / `?view=delivered`).
4. **ReviewNotice** — only when `underReviewOrderCount > 0`; keep the existing pluralised copy.
   It is a COUNT only, never an amount.
5. **Orders in motion** (`flex-[3_1_580px]`): rows link to order detail; receiver name (15/700),
   `orderNumber · receiverArea`, `StageProgress` (no labels) + stage text, `amountToCollect` +
   "to collect". Empty: "No active orders." Header link "View all".
6. **Wallet activity** (`flex-[2_1_340px]`): icon tile (CREDIT: `ArrowDownLeft` on `success-50`;
   DEBIT: `ArrowUpRight` on `brand-50`; NONE: neutral), type label
   (`getWalletTransactionTypeLabel`), `reference.label · date`, signed amount + direction word
   from `getDirectionPresentation` (credit green, debit `ink`, not red — debits are normal
   payouts). Header link "Open wallet".

### 3.2 My Orders — `/customer/orders` (artboard "My Orders")

Data: unchanged `useGetCustomerOrdersQuery({ page, view })`; `view`/`page` stay in the URL.

- Header: eyebrow "My orders", H1 "Every parcel, at a glance.", lead. Right: `SegmentedTabs`
  All / Active / Delivered. Counts: Active = `activeOrders`, Delivered = `deliveredOrders`
  (from `useGetCustomerOrderTotalsQuery` or the cached dashboard query); All = `meta.total` when the All tab is loaded, otherwise
  no chip. Never compute counts from the current page.
- Grid: `grid-cols-[repeat(auto-fill,minmax(min(100%,520px),1fr))] gap-5`.
- **Order card** (`CustomerOrderCard` rewrite):
  - Top: receiver name (18/700) + `orderNumber · Tracking trackingCode`; right: order-type pill
    (`bg-canvas text-ink-secondary`) + `StatusPill`.
  - `StageProgress` **with** the 4 labels.
  - Amount strip (`bg-sunken rounded-[14px]`, 3 columns split by `line` dividers):
    Order amount · Delivery fee · To collect (bold).
  - Footer: `MapPin` area · `Calendar` created date (and "Delivered <date>" when `deliveredAt`) ·
    parcel intake label (`getCustomerParcelIntakeLabel`) · collection-stage `Badge` when
    `collectionStage` is present (keep existing tones) · "View order ›" outline button
    (`aria-label="View order <number>"`).
- Pagination: left "Page X of Y · N orders", right Previous (disabled style) / Next (dark).
  Reuse `Pagination` logic; restyle only.

Status → progress mapping (reuse the canonical customer mapping, page_structure §40):

| Internal status | Stage (1–4) | Pill tone |
|---|---|---|
| RECEIVED | 1 Order received | neutral (`canvas`/`ink-secondary`) |
| READY_FOR_PICKUP, ASSIGNED, PICKED_UP | 2 Ready for delivery | neutral (`canvas`/`ink`) |
| OUT_FOR_DELIVERY | 3 Out for delivery | brand (`brand-50`/`brand-600`) |
| DELIVERED | 4 Delivered | success |
| FAILED_DELIVERY, RESCHEDULED, RETURNED_*, CANCELLED | **not drawn on canvas** | tone translated from the canonical customer mapping (danger → warning; so RETURNED_* shows warning, CANCELLED neutral), with the approved customer-safe wording; progress bar frozen at the last reached stage in `line-strong`. Confirm with design before shipping. |

### 3.3 Order Detail — `/customer/orders/:id` (artboard "Order Detail")

Data: unchanged `CustomerOrderDetail`. 404 / not-owned keeps the current "Order not available" state.

- Back link "‹ All orders".
- **Summary panel**: status pill + order type pill; H1 = `orderNumber` (38px); row "Tracking
  code" + mono chip with copy button (`navigator.clipboard`, `aria-label="Copy tracking code"`,
  announce "Copied" via a polite live region) · "Created <date>" (+ "Delivered <date>").
  Right: dark mini-panel "Amount to collect" (`payment.amountToCollect`, 36px).
- **Journey** (`flex-[3_1_520px]`): render `tracking.stages` exactly as returned. Node 30px:
  done = filled `ink` + white check; current = white with `brand-600` 2px ring + 10px brand dot;
  upcoming = white with `line-strong` ring. Connector 2px: `ink` after done nodes, `line`
  otherwise. Each row: label + state chip ("Done" / "In progress" / "Upcoming" — text, not colour
  only) + `formatDateTime(occurredAt)` when present. **Do not show ETAs** ("Expected today" on the
  canvas is illustrative — no such field exists). `tracking.exception` → `ReviewNotice`-style
  warning above the list using `exception.message`. Lead sentence under the title: derive from
  status (e.g. "Your parcel is on its way." for OUT_FOR_DELIVERY) — no driver identity.
- Right column (`flex-[2_1_340px]`):
  - **Delivering to**: receiver name (20/700); `MapPin` area · address · building/floor;
    `Phone` as `tel:` link (+ alt phone); "Open in maps" link when `mapLink`; instructions in a
    `sunken` box when present.
  - **Payment**: Payment type (`getPaymentTypePresentation`), Order amount, Delivery fee,
    divider, **Amount to collect**.
  - **Package**: Contents, Pieces, Quantity (if any), Weight (if any), Parcel intake +
    collection-stage badge.

### 3.4 Wallet — `/customer/wallet` (+ `/transactions`, `/payouts`) (artboard "Wallet · Activity · Payouts")

Data: `useGetCustomerWalletQuery()`, `useGetCustomerWalletTransactionsQuery`, `useGetCustomerPayoutsQuery`.

- Header: eyebrow "Wallet", H1 "Your money, clearly accounted.", lead.
- **Available balance** (`BalanceHeroCard`, `flex-[1_1_420px]`): hero money, explainer copy,
  chip "Latest payout · $X on <date>" (D3, same status rule as §3.1; hidden when none).
- **Pending panel** (white, same row): eyebrow "Pending · not yet withdrawable"; `pendingAmount`
  (44px); proportional bar (two `rounded-full` segments, `flex-grow` = the two amounts as
  numbers **for layout only**, `aria-hidden`); legend rows Pending delivery (ink swatch) /
  Pending settlement (brand swatch) with their explanations and amounts; `ReviewNotice` compact
  variant when `underReviewOrderCount > 0` ("N order(s) under review is not included…").
- **History panel**:
  - D1-B: `SegmentedTabs` Transactions / Payouts, each tab a `NavLink` to
    `/customer/transactions` and `/customer/payouts`; `/customer/wallet` shows Transactions.
    D1-A: Wallet page shows only the two balance panels + the "About these amounts"
    definitions; Transactions and Payouts pages reuse the same History panel styles as standalone pages.
  - Transactions: `FilterChips` All / Order credits / Payouts / Adjustments / Reversals (maps to
    the existing `type` filter values; keep it in the URL as today). Table in an
    `overflow-x-auto` box, `min-w-[640px]`, columns Date (120px) · Description (fr) · Type
    (150px) · Amount (150px, right). Description = `reference.label` (fallback: type label),
    second line "Balance after <balanceAfter>". Type badge tones from
    `getWalletTransactionTypeTone` (order credit success, payout brand, adjustment warning,
    reversal neutral). Amount + direction word from `getDirectionPresentation`.
    **Below `sm` (phone):** do not use the scrolling table. Render each transaction as a stacked
    row: description (+ balance-after line) on the left, signed amount + direction word on the
    right, date and type badge on a second line. The table layout applies from `sm` up.
  - Payouts: card grid `minmax(min(100%,340px),1fr)`; card: payout number, status pill
    (`getPayoutStatusLabel`/`Tone` — COMPLETED reads "Completed"; the canvas's "Paid" is
    illustrative), amount (30px), date · payment method name. No reference field exists — omit.
  - Pagination for both lists as on Orders.

### 3.5 Profile — `/customer/profile` (artboard "Profile")

Data: unchanged `CustomerProfile`. Read-only.

- Identity panel: 84px `bg-chrome` initials tile (`rounded-[26px]`), name (34px), "Customer
  number **X**", helper copy "Need to change something? Contact Spring Delivery and we will update
  your details for you."
- Two panels in `repeat(auto-fit,minmax(min(100%,380px),1fr))`: **Contact** (primary phone,
  secondary phone, email — `tel:`/`mailto:` links via the existing `PhoneValue`), **Default
  pickup details** (default area, default address). Rows are label-left / value-right split by
  `line-subtle` dividers; missing values show "—".

---

## 4. Behaviour & rules that must not change

- Read-only portal: no Withdraw, Request Payout, edit-profile or any mutation control.
- Self-scoped `/customer/me/*` endpoints only; no customer ID in any request.
- No driver identity, driver cash, company revenue, internal notes or financial-review amounts
  anywhere. Under-review is a count.
- Server money strings displayed via `formatMoney`; no client arithmetic on money except the
  layout-only pending bar proportions.
- Status wording only from the shared customer-safe mapping; collection-stage labels from the server.
- RTK Query caching unchanged; new `limit` params create separate cache entries — fine.

## 5. Accessibility

- Text contrast ≥ 4.5:1 (all mapped tokens are AA on their surfaces; `chrome-ink` on `chrome` ✓).
- Stage, direction and status are always expressed in text as well as colour.
- Nav: `<nav aria-label="Customer navigation">`, active link `aria-current="page"`.
- Tabs: `tablist`/`tab`/`aria-selected`; filter chips `aria-pressed`.
- Interactive targets ≥ 40px tall (nav 36px inside a 44px track; acceptable — or bump to `h-10`).
- Decorative rings / bars `aria-hidden`.

## 6. Not designed yet

- Phone layouts (only flex-wrap rules above); a dedicated mobile artboard is pending.
- Exception statuses on cards (see §3.2 table).
- Skeleton loading states (current spinners are kept).

## 7. Suggested implementation order (one session each, human review between)

1. Tokens + font + `CustomerShell` + shared components (§1–2).
2. Overview. 3. My Orders. 4. Order Detail. 5. Wallet / Transactions / Payouts. 6. Profile.
7. Regression: existing customer-portal tests, typecheck, build, responsive check at 390 / 768 / 1280px.
