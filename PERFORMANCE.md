# Performance

How fast Cacaduu PPI must be, how it stays that way, and how to measure it. Set up in the speed and fixes pass
(22 October 2026, database update 42). Nothing here changes what a page shows — only how fast it gets there.

## Targets (phone: Moto G, slow 4G)

| Metric | Target | Checked by |
| --- | --- | --- |
| LCP | < 2.0 s | Lighthouse CI (median of 3 runs) |
| INP | < 150 ms | Vercel Speed Insights (real visitors) |
| CLS | < 0.05 | Lighthouse CI |
| TTFB | < 600 ms | Lighthouse CI, Speed Insights |
| Lighthouse performance | ≥ 90 | Lighthouse CI |
| First-load JavaScript (public pages) | < 150 kB gzip | Lighthouse CI (`resource-summary:script:size`) |
| Tap feedback | < 100 ms | `npm run test:e2e` (the chat question shows at once) |

`lighthouserc.cjs` holds the budget; `.github/workflows/performance.yml` runs it and the phone e2e on every Vercel
preview and fails the check when a page goes over. Shop and item pages only **warn** on LCP (see "Known limits").

## Rules that keep it fast

1. **Public data is read on the server and cached** — `createCachedPublicClient()` (`src/lib/supabase/public.ts`):
   only the RPCs in `CACHED_RPCS` and plain table reads, 60 s, tags `public` + `shop:<slug>`. Never cache anything
   with a login, a rate limit or the AI.
2. **Every visible change refreshes the cache at once** — `refreshShop(slug)` / `refreshAll()` (`src/lib/publicCache.ts`)
   in the server action that saved it; stock uploads call `/api/revalidate` (`REVALIDATE_SECRET`). A new public read
   needs both: the RPC in `CACHED_RPCS` **and** a refresh where it changes.
3. **Read in parallel** — one `Promise.all` per page; no `await` in a loop.
4. **Heavy code after the page** — the map (`ShopMap` → `ShopMapCanvas`), the shop assistant (`ShopAssistant` →
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

<!-- TABLE -->

## Known limits

- Lighthouse's slow-4G simulation varies ±0.3 s between runs; the budget uses the median of 3.
- **Shop pages** stay around 2.1–2.6 s LCP in the simulation (≈ 0.9–1.1 s in a real throttled phone browser): the page
  sends its whole content (details, hours, slider data, items) in the first HTML for search engines and AI assistants,
  and Lighthouse counts parsing it. Fonts without preload would bring it under 2 s but make the text jump (CLS 0.17), so
  they stay preloaded.
- The map's code (MapLibre, ~280 kB gzip) loads after the page on shop and item pages; it is not part of the first
  JavaScript but shows in Lighthouse's total.
- Owner pages (Môj obchod, admin) are not under the public 150 kB budget (forms, editors); they load in 0.9–1.7 s.
