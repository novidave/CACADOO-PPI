# Performance

How fast Cacaduu PPI must be, how it stays that way, and how to measure it. Set up in the speed and fixes pass
(22 October 2026, database update 42). Nothing here changes what a page shows — only how fast it gets there.

## Targets (phone: Moto G, slow 4G)

| Metric | Target | Checked by |
| --- | --- | --- |
| LCP | < 2.0 s | Lighthouse CI (median of 3 runs, throttling applied while loading) |
| INP | < 150 ms | Vercel Speed Insights (real visitors) |
| CLS | < 0.05 | Lighthouse CI |
| TTFB | < 600 ms | Lighthouse CI, Speed Insights |
| Lighthouse performance | ≥ 90 | Lighthouse CI |
| First-load JavaScript (public pages) | < 150 kB gzip | `scripts/first-load-js.mjs` (the first HTML's scripts); Lighthouse CI checks the total incl. Vercel's metrics (< 170 KiB) |
| Tap feedback | < 100 ms | `npm run test:e2e` (the chat question shows at once) |

`lighthouserc.cjs` holds the budget; `.github/workflows/performance.yml` runs it and the phone e2e on every Vercel
preview and fails the check when a page goes over. Shop and item pages only **warn** on LCP, the search page on LCP
and score (see "Known limits"). The checks send `x-vercel-skip-toolbar: 1` (and the bypass header) only to the site
under test: the Vercel toolbar exists only on previews and is not part of the site.

## Rules that keep it fast

1. **Public data is read on the server and cached** — `createCachedPublicClient()` (`src/lib/supabase/public.ts`):
   only the RPCs in `CACHED_RPCS` and plain table reads, 60 s, tags `public` + `shop:<slug>`. Never cache anything
   with a login, a rate limit or the AI.
2. **Every visible change refreshes the cache at once** — `refreshShop(slug)` / `refreshAll()` (`src/lib/publicCache.ts`)
   in the server action that saved it; stock uploads call `/api/revalidate` (`REVALIDATE_SECRET`). A new public read
   needs both: the RPC in `CACHED_RPCS` **and** a refresh where it changes.
3. **Read in parallel** — one `Promise.all` per page; no `await` in a loop.
4. **Heavy code after the page** — the map (`ShopMap` → `ShopMapCanvas`; it starts only after the visitor's first
   scroll, touch or key — MapLibre blocks a slow phone for most of a second — or at once on a tap), the shop assistant (`ShopAssistant` →
   `ShopChat`), the language list, the picture viewer, Speed Insights/Analytics. Keep the same box size before and after
   (no layout shift). New heavy parts follow the same pattern: a light first view + `import()` when near the screen
   or touched.
5. **One font declaration** (`src/app/fonts.ts`); extra scripts (Cyrillic, Greek, Vietnamese) come by unicode-range,
   not preloaded.
6. **No third-party scripts** on public pages before the visitor taps something (YouTube only after ▶; no Facebook
   script ever).
7. **Database:** search through the stored `names_search` column and `search_patterns()`; select only the columns a
   page shows; paginate long lists; `set jit = off` on functions the pages call; a new slow query gets an index in the
   phase's SQL file (with `EXPLAIN ANALYZE` on a big catalogue before and after).
8. **Taps answer at once:** server-action forms get `TapFeedback` (busy, not sent twice); lists that load on a filter
   keep only the newest answer; tap areas ≥ 44 px on touch screens.
9. **No `loading.tsx` in Môj obchod** — it turns a page's `redirect()` into a client redirect (old addresses must
   answer 307); the menu shows `useLinkStatus` instead.

## How to measure

- **Every preview:** the "Performance" check on the pull request (Lighthouse report link in its log).
- **Real visitors:** Vercel → Speed Insights (LCP, INP, CLS per page) and Analytics.
- **By hand:** `npx @lhci/cli@0.15.1 autorun --config=lighthouserc.cjs` with `LHCI_BASE_URL=<address>`;
  `E2E_BASE_URL=<address> npm run test:e2e`.
- **Bundle:** `npx next experimental-analyze` (interactive report of every chunk).
- **Errors:** Admin → Predplatné a domény → "Chyby za posledných 7 dní" (or Sentry with `SENTRY_DSN`).

## Before / after (22 October 2026, local production build)

### Public pages, phone (Lighthouse: before = 1 run, after = median of 3)

| Page | Score | LCP (s) | CLS | TBT (ms) | TTFB (ms) | First-load JS (kB gzip) |
| --- | --- | --- | --- | --- | --- | --- |
| Main page (AI chat) | 99 → **99** | 2.05 → **2.20** | 0.004 → **0.004** | 92 → 52 | 24 → 17 | 152 → **145** |
| Search results | 94 → **99** | 2.71 → **1.98** | 0.002 → **0.002** | 157 → 93 | 79 → 38 | 152 → **145** |
| Shop page | 92 → **92** | 3.02 → **2.52** | 0 → **0** | 179 → 248 | 485 → 49 | 155 → **146** |
| Product page | 96 → **96** | 2.27 → **1.93** | 0 → **0** | 171 → 200 | 63 → 29 | 152 → **141** |
| Blog list | 97 → **97** | 2.64 → **2.57** | 0 → **0** | 59 → 71 | 72 → 58 | 151 → **144** |

Shop and product pages on the own domain behave like the Cacaduu ones (TTFB 412 → 62 ms on the shop page). The map's code (≈ 280 kB gzip) loads after the page and is not counted as first-load JS.

### Môj obchod and admin (Lighthouse, warm browser cache, 1 run each)

| Page | Phone score | Phone LCP (s) | Desktop score | Desktop CLS |
| --- | --- | --- | --- | --- |
| Môj obchod → Tovar | 87 → **99** | 3.82 → **0.99** | 100 → **100** | 0.004 → **0** |
| Obsah stránky | 100 → **100** | 1.50 → **0.94** | 100 → **100** | 0 → **0** |
| Upload (/sync) | 96 → **99** | 1.23 → **0.73** | 100 → **100** | 0.01 → **0.01** |
| Asistent | 99 → **100** | 1.21 → **0.97** | 99 → **100** | 0.075 → **0** |
| Môj obchod | 96 → **95** | 1.31 → **0.98** | 76 → **100** | 0.771 → **0** |
| Admin | 97 → **100** | 1.38 → **1.00** | 100 → **100** | 0 → **0** |

### Database (60 shops × 2 000 items, 190 000 translations; `EXPLAIN ANALYZE`)

| Query | Before | After |
| --- | --- | --- |
| `search_stock('kava')` (all shops) | 0.8–1.5 s | ~0.25 s |
| `shop_stock` with a word | 155 ms | 18 ms |
| `owner_translations` (Preklady) | 2 min | 59 ms |
| `shop_content` (slider) | 430 ms | 5 ms |
| `owner_items` / `owner_item_counts` (Tovar) | — | 60–80 ms |

Same result sets before and after (41 of 41 search queries compared row by row).

## Known limits

- Lighthouse's slow-4G simulation varies ±0.3 s between runs; the budget uses the median of 3.
- **Search page with JavaScript:** its largest element is the AI answer, which streams for several seconds by design,
  so its LCP measures how fast the AI answers, not the page (the plain results without JavaScript are in the first
  HTML). Layout shift there is checked strictly: placeholder cards show only until the answer's first word.
- **Not yet under 2.0 s in the simulation:** the main page (2.0–2.2 s), the blog list (2.0–2.6 s) and the shop page
  (2.1–2.6 s); the budget check flags them. Their LCP is a heading or a line of text, so it is the fonts and the
  page's own size, not a picture. Real throttled phone browser: 0.8–1.1 s.
- **Lighthouse CI applies the throttling while loading** (`throttlingMethod: "devtools"`). Lighthouse's default
  simulation added every async script's download to the LCP even when the largest element paints with the first frame
  (main page: observed 0.14 s, simulated 2.0–2.5 s) and it hid the map's real main-thread work.
- **Main page:** the chat box sizes itself in CSS (`field-sizing: content`), so its placeholder — the page's largest
  element on phones — is final in the first HTML instead of growing after JavaScript.
- **Shop pages** stay around 2.1–2.6 s LCP in the simulation (≈ 0.9–1.1 s in a real throttled phone browser): the page
  sends its whole content (details, hours, slider data, items) in the first HTML for search engines and AI assistants,
  and Lighthouse counts parsing it. Fonts without preload would bring it under 2 s but make the text jump (CLS 0.17), so
  they stay preloaded.
- The map's code (MapLibre, ~280 kB gzip) loads after the page on shop and item pages; it is not part of the first
  JavaScript but shows in Lighthouse's total.
- Owner pages (Môj obchod, admin) are not under the public 150 kB budget (forms, editors); they load in 0.9–1.7 s.
