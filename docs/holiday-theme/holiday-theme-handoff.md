# Holiday Theme — Design Handoff

Status: **design proposal, pending approval** (not an approved implementation phase).
Design source: the "Spring Delivery — Holiday edition" row on the Design canvas (artboards
`Holiday · Sign in`, `Holiday · Overview`, `Holiday · My Orders`, `Holiday · Order Detail`,
`Holiday · Wallet`, `Holiday · Profile`).
Assets: `docs/holiday-theme/assets/` (see §6).

Scope: **frontend only, purely decorative.** It covers the Customer Portal shell, its six pages,
and the sign-in page. It changes colours, decoration, the logo image and a few headlines. It
changes **no** data, API, route, permission, business rule, money value, status wording or
validation. Management and Driver portals are not affected.

The canvas is a visual reference (CLAUDE.md §41/§66). Names, amounts and order numbers on it
are placeholders.

---

## 0. Decisions needed before implementation

| # | Decision | Why | Options |
|---|----------|-----|---------|
| H-D1 | **Base identity.** The holiday theme sits on top of the Spring Delivery *brand* look from the canvas row "Spring Delivery brand": logo images, brand red, Saira headings, charcoal hero. That brand look is **not yet in code**. The code today follows the earlier "Midnight & Cobalt" handoff. | The holiday theme reuses the brand logo, red and type. | **A** implement the brand identity first, then the holiday theme as a seasonal overlay (recommended; a separate brand handoff is needed). **B** implement the holiday theme directly on today's look, swapping only the logo, colours and decoration listed here. |
| H-D2 | **How the theme is switched on.** | Seasonal UI must turn off cleanly. | **A** build/env flag `VITE_SEASONAL_THEME=holiday` (recommended: simple, no backend). **B** flag plus an automatic date window (for example 1 Dec – 6 Jan) evaluated on the client. **C** an Admin setting. That needs a backend setting and is out of this frontend-only scope. |
| H-D3 | **Holiday script font** (Mountains of Christmas) for the "Happy holidays" eyebrow. | It adds a webfont download (one weight). | **A** use it (as designed). **B** keep Saira for the eyebrow too. |

Everything below assumes H-D1 = A, H-D2 = A, H-D3 = A.

---

## 1. Principles

- **Overlay, not a fork.** Implement as a theme layer: one `data-theme="holiday"` attribute on
  the Customer shell root and on the `AuthLayout` root, plus decoration components that render
  **only** when the theme is active. When the flag is off, the output is identical to the
  non-holiday build.
- **Decoration is never content.** Every decorative element is `aria-hidden="true"`,
  `pointer-events: none`, and outside the tab order. No information is shown only in a
  decoration.
- **Motion is optional.** All motion is CSS `transform`/`opacity` keyframes. Under
  `prefers-reduced-motion: reduce`, all animation stops and the snow is hidden.
- **No business wording changes.** Status labels, money labels, review/withdraw rules and
  empty/error copy are untouched. Only the headlines listed in §5 change.

---

## 2. Tokens (additive, holiday scope only)

Define under `[data-theme="holiday"]` (or as `holiday-*` utilities). Do not change base tokens.

| Token | Value | Use |
|---|---|---|
| `--holiday-pine` | `#0F2A20` | hero / sign-in panel background (replaces charcoal) |
| `--holiday-pine-raised` | `#1C3D30` | avatar circle on the hero |
| `--holiday-on-pine` | `#B9C9C0` | secondary text on pine (≈ 9:1) |
| `--holiday-on-pine-strong` | `#E6EEE9` | chip text on pine |
| `--holiday-gold` | `#F5C542` | "Happy holidays" eyebrow + star icon, orbit-ring highlight, lights (≈ 9:1 on pine) |
| `--holiday-gold-deep` | `#D4AF37` | ornament caps |
| `--holiday-green` | `#166534` | positive states in holiday: "Delivered", "Added", "Completed", "Done" (≈ 7:1 on white) |
| `--holiday-green-50` | `#E7F3EC` | soft background for the green states |
| `--holiday-bauble-green` | `#1E7A4C` | ornament colour (decor only) |
| `--holiday-page` | `#F5F6F4` | page background; also the snow-bank fill |
| brand red (existing in brand theme) | `#D11F2A` / text `#C41C26` / logo red `#EF313F` | unchanged |

Contrast rules: white text only on `#D11F2A` or darker. `#EF313F` is decoration only (lights,
bars, rings). Gold `#F5C542` is used for text only on pine.

---

## 3. Decoration components (new, `components/seasonal/`)

All render nothing unless the holiday theme is active.

| Component | Spec |
|---|---|
| `HolidaySnow` | Absolute layer over the hero (`inset:0; overflow:hidden`). 16 `<i>` flakes, 3–6 px white circles, opacity .4–.75, `left` spread 3%→95%. Keyframe `translate(0,-10px) → translate(40px, heroHeight+40px)`, linear, infinite. Durations 9–20 s, negative delays, so it is already snowing on load. Hidden under reduced motion. |
| `HolidayLights` | A light string just under the header (`top:100%` of the header), full width, `border-top: 1.5px solid rgba(255,255,255,.18)`. 24 bulbs (8×11 px ovals) cycle red `#EF313F`, gold `#F5C542` and white, each with a matching 10 px glow. Twinkle: opacity 1 → .3 → 1, 2.4 s, offsets 0 / .8 / 1.6 s by colour. On sign-in it runs along the top edge of the pine panel. |
| `HolidayOrnaments` | 4 baubles hanging from the light string at the right edge of the hero (right 28 / 76 / 124 / 176 px; strings 18–64 px). Bauble 22 px circle (26 px on sign-in) with a gold cap, an inset shade and a white shine dot. Colours red, gold, off-white `#F4F4F0`, green `#1E7A4C`. Swing ±7°, 3.6 s, staggered. Keep them clear of hero content; hide below `md`. |
| `SnowBank` | SVG at the bottom of the hero (`viewBox 0 0 1440 80`, `preserveAspectRatio="none"`, height 70 px). Two wavy paths: back path white at 35% opacity, front path filled `--holiday-page`, so the hero melts into the page under the overlapping cards. Sign-in: front path white 92%. |
| `.candy-cane` utility | `position:relative; overflow:hidden;` plus a `::before` 5 px top band: `repeating-linear-gradient(135deg, #D11F2A 0 10px, #FFFFFF 10px 20px)`. Order cards use a 4 px band. |
| Hero ring | The existing slow-rotating orbit ring gets `border-top-color: rgba(245,197,66,.55)` (gold) on pine. The red arc is unchanged. |
| Snowflake watermark | 8-arm stroke snowflake, white at 18% opacity, partly off the bottom-right corner of the red balance cards (Overview tile, Wallet card, Order Detail amount box). Decorative, behind text, never under text. |

Small festive icons (inline lucide-style SVG, `aria-hidden`), added next to existing titles
without changing the titles:

- gift box on the "Active orders" card
- pine tree before "Orders in motion" and "Journey"
- bauble before "Wallet activity"
- gold star before the hero eyebrows
- gold star badge on the Profile initials tile

---

## 4. Logo

| Place | Asset |
|---|---|
| Header (all customer pages) | symbol `sd-mark.png` (no hat), 40 px wide, plus `sd-wordmark-white-xmas.png` at **44 px tall with `margin-top:-14px`** so the wordmark baseline matches the non-holiday header and the hat peeks above. `alt="Spring Delivery"` on the wordmark, `alt=""` on the symbol. |
| Sign-in brand panel | `sd-logo-white-xmas.png`, 200 px wide. `alt="Spring Delivery"`. |

The Santa hat sits on the **"S" of SPRING** in the wordmark, not on the round symbol. Use the
provided images. Do not draw the hat in CSS over the brand logo. When the theme is off, use the
non-holiday files (`sd-wordmark-white.png`, `sd-logo-white.png`).

---

## 5. Page-by-page changes (everything else = base theme)

| Page | Holiday changes |
|---|---|
| **All customer pages** | Hero background `--holiday-pine`; header without bottom border (the light string replaces it). Inactive nav text `--holiday-on-pine`; active nav item stays brand red. Add `HolidaySnow`, `HolidayLights`, `HolidayOrnaments`, `SnowBank`, gold orbit ring. Positive-state greens use `--holiday-green` / `--holiday-green-50`. Done-state progress segments use pine `#0F2A20` instead of ink. |
| **Sign-in** | Pine brand panel with lights on top, snow, ornaments, snow bank and the holiday logo. Eyebrow "Happy holidays" in the holiday script (gold, 28 px). Headline: "Every parcel, **home for the holidays.**" (second line red italic). Form side unchanged. |
| **Overview** | Eyebrow "Happy holidays" (script, gold, 26 px) with star. H1 "Season's greetings, **{firstName}.**" (fallback "Season's greetings."). Snowflake watermark on the balance tile. Gift icon on Active orders. Candy-cane band on "Orders in motion" and "Wallet activity". |
| **My Orders** | Eyebrow "My orders" with gold star. H1 "Every parcel, **wrapped and on its way.**". 4 px candy-cane band on every order card. |
| **Order Detail** | Snowflake watermark on the "Amount to collect" box. Tree icon on "Journey". Candy-cane band on Journey and Payment panels. Done-stage chips use holiday green. |
| **Wallet** | Eyebrow "Wallet" with gold star. Snowflake watermark on the balance card. Candy-cane band on the history panel. "Completed" payout chip and order-credit badges use holiday green. |
| **Profile** | Eyebrow "Happy holidays" (script). Gold star badge on the initials tile. Candy-cane band on both panels. |

Headline strings are presentation copy. Keep them in one `holidayCopy` object, so turning the
theme off restores the normal headlines exactly.

---

## 6. Assets (in `docs/holiday-theme/assets/`)

| File | Size | Use |
|---|---|---|
| `sd-mark.png` | 264×256 | round S symbol (all themes) |
| `sd-wordmark.png` / `sd-wordmark-white.png` | 441×160 | "SPRING DELIVERY" wordmark, dark / light backgrounds |
| `sd-logo.png` / `sd-logo-white.png` | 512×560 | stacked full logo, light / dark backgrounds |
| `sd-wordmark-white-xmas.png` | 441×237 | wordmark with the Santa hat on the S (holiday header) |
| `sd-logo-white-xmas.png` | 512×560 | full logo with the hat on the S (holiday sign-in) |

These were produced from the supplied logo PDF. They are transparent PNGs. Move them to
`client/src/assets/brand/` (or `client/public/brand/`) during implementation. If a vector logo
becomes available, regenerate them from it.

---

## 7. Behaviour & rules that must not change

- No data, API, route, guard, permission or business-rule change.
- No status, money, review or payout wording change. No withdraw / payout-request control.
- Under-review stays a count only. No driver identity. Money only via `formatMoney`.
- Base (non-holiday) output must be byte-for-byte identical in behaviour when the flag is off.

## 8. Accessibility & performance

- All decoration is `aria-hidden`, `pointer-events:none` and not focusable. Images keep their
  alt text.
- Reduced motion: every animation stops and `HolidaySnow` is not rendered.
- Contrast: every text/background pair in §2 meets AA. Gold text appears only on pine.
- Cost: CSS animations only (transform/opacity). At most 16 flakes, 24 bulbs and 4 ornaments
  per page. No JS animation loops, no canvas, no extra network requests other than the one
  webfont weight (H-D3).

## 9. Suggested implementation order (one session each, review between)

1. **H1:** theme flag + `data-theme` plumbing + holiday tokens + assets + the five decoration
   components (with unit tests for "renders nothing when off" and reduced motion).
2. **H2:** apply to the Customer shell and the six pages (logo swap, hero, greens, candy-cane,
   icons, `holidayCopy`).
3. **H3:** sign-in page + full regression (flag on/off), visual check at 390 / 768 / 1280 px,
   and the existing client tests unchanged.
