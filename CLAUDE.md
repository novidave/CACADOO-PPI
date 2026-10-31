@AGENTS.md

# PPI — rules for Claude Code

Read `docs/PRD.md` (what to build) and `docs/ARCHITECTURE.md` (how it fits together) first.
Setup steps for humans are in `SETUP.md`.

## Hard rules

- **Never** put the Supabase service role / secret key in the web app, `.env*`, Vercel or the repo.
  Anything that needs it (stock pull, Stripe, inviting owners) is a Supabase Edge Function.
- Public pages (home, shop, item) load data in **server components** via `@/lib/supabase/server` (anonymous public
  reads through the cached `createCachedPublicClient()`, refreshed on every change — see "Speed").
  Never fetch public data in the browser: crawlers and AI assistants read only the first HTML.
- Freshness and availability labels live **in the database**
  (`freshness_label`, `availability_label`, `public_stock`, `search_stock`). Never recompute them in React.
  Visitors read stock only through `public_stock` / `search_stock`, never `inventory`.
- **One display rule, no settings.** Every shop shows the quantity exactly as in its file ("12 ks na sklade",
  "Vypredané" at 0 or less; nothing for stale shops). PPI never edits, corrects or completes shop data, and "My shop"
  has no setting that changes the uploaded data or how stock is shown (display modes and hidden items were removed by
  migration 21 — never bring them back). Translations are not shop data.
- **Private columns** = every stock-file column not in the approved mapping: only in the private `raw-files` bucket;
  never in `sample_rows`, `stock_imports`, pages, the API/MCP or the shop assistant. The AI column proposal gets names
  plus ≤ 3 values per column, and names only for `isPrivateColumn()` / `is_private_column()` columns.
- Payment never affects search ranking.
- Every database change is a new SQL file (never edit an applied one): updates 1–21 in `supabase/migrations/`; from
  update 22 on, **one numbered file per phase in `supabase/sql/`** (the history stays in the repo). Updates 22–62 were
  pasted by the owner; **from 2026-10-31 Claude applies them** (see "How changes go live" below). Never ask for or use
  the database password. `npm run test:db` applies both. Add a check to `supabase/tests/database_test.sql` for every
  rule you add.
- **Europe-wide, no home town.** Never hard-code a city, country, currency or time zone.
  **No location services**: the website never asks for or guesses the visitor's location (no device location,
  no IP lookup). Search is text only — item name (original or any translation), brand, category, code, EAN, shop name,
  street or town — and **forgiving since update 54** (below): exact hits first (code/EAN, then every word), then close
  ones (any order, typos, stems, sizes, generic words weighted less), never decided outside SQL.
- Item names (at the owner's request, 2026-10-27): the name **in the page language first** (dark), the name as the shop
  wrote it **under it** (light) — `itemNames()` (`@/lib/names`) on the shop's list, the product page, the search results
  and the chat cards; without a translation only the shop's name. The shop's text itself is never changed.
- Times stored in UTC, shown in the **shop's** time zone (`shops.timezone`) via `@/lib/format`.
  Prices via `formatPrice(value, locale, currency)` with the item's own currency.
- All visible text comes from `src/i18n/messages/{sk,hu,en}.json`; add every new key to all three (Slovak is the source;
  every other language comes from the database, update 40). `npm run test:strings` fails on text written straight into
  a page or component.

## How changes go live (the owner's working rules, 2026-10-31)

One branch, one PR, one PR at a time (in the order opened; the next one is re-checked on the new `main`). Every PR
targets `main`. Supabase project: `szhotccxyaepjhwsqdqx` (through the Supabase connector).

**Database (SQL).** Each change is still ONE numbered file in `supabase/sql/`. Claude applies it itself with
`apply_migration`, named like the file (`62_items_page_texts`), in this order:
1. `npm run test:db` passes on the branch;
2. read-only checks on the live database (does it exist already? how many rows would change?);
3. apply — **before the PR is merged**, and the change must work with the code that is live now;
4. verify (`list_tables` / a `SELECT`), then `get_advisors` (security) for new warnings;
5. note in the PR: "SQL applied: <name>, <time>".
If applying fails: stop, change nothing else, show the owner the error. Never ask for or use the database password.

**Edge Functions.** Deploy changed functions with `deploy_edge_function` after `npm run check:functions` and
`npm run test:functions` pass; keep each function's settings (Verify JWT **off** unless the PR says otherwise; every
function in `supabase/functions/` checks its callers itself). Order: SQL first, then functions, then merge. After
deploying: ACTIVE + the new version in `list_edge_functions`, no new errors in the function logs; note "Function
deployed: <name> v<version>" in the PR. On errors: redeploy the version from `main` and tell the owner.

**Merging** (while Cacaduu has no paying shops — the owner says when that changes): when every check is green, the
Vercel preview is Ready and SQL / functions are applied, Claude checks the changed pages in the preview itself, then
**squash-merges into `main` without waiting**. After merging: the production deploy is Ready, and the live pages on
cacaduu.com and davide.sk work; if production is broken, roll back in Vercel to the previous production deployment
and fix it in a new PR. Afterwards tell the owner in 2–3 lines: what changed, what to look at, the PR link.
When the owner says **"we have paying shops"**, merging goes back to waiting for "OK, merge".

**Always wait for the owner's OK** (do not apply, deploy or merge) when a change:
- deletes data (DROP, TRUNCATE, DELETE of rows, removing columns or tables, deleting files in storage),
- touches payments (Stripe), domains (Websupport / DNS), legal texts, authentication / RLS / security, or secrets,
- or changes these rules.
Then write **"Čaká na tvoje OK: <reason>"** with exactly what would happen, and stop until the owner writes "OK".

**Secrets.** Claude never sees, writes or sets secret values. A feature that needs a new secret is built so it works
without it (switched off or "nie je nastavené" until the secret exists — no errors, nothing breaks); its NAME goes in
the PR and in `TODO-OWNER.txt`; never stop for a missing secret. The owner adds values in Supabase / Vercel. At the end
of the phases: ONE list of every secret to add (name, Supabase or Vercel, where to get the value, which feature it
switches on); after "secrets done", check that each feature switched on and report.

**`TODO-OWNER.txt`** (repository root): a numbered list of everything the owner must do by hand (secrets to add,
settings to click, things to check), each with exact steps in plain words. Numbers never change; new items get the
next number; "done 4, 7" moves them to DONE with the date. Every PR adds its manual steps; the message to the owner
names only the new numbers.

**Phases.** When a phase is finished (checks green, SQL / functions applied, merged, live page checked), start the next
phase from the new `main` without waiting. Stop only when a change needs the owner's OK, something fails twice, or
all phases are done.

## Design

Plain white background, black text, thin light-grey lines (`border-line`, `text-muted`). **Font: Quicksand everywhere**
on the website (at the owner's request, 2026-10-20): `src/app/fonts.ts` (`next/font/google`, latin + latin-ext,
self-hosted at build — no browser request to Google), its variable on `<html>` in both root layouts, used by `body`,
`--font-sans` and MapLibre's map/tooltips in `globals.css` (with its own width-matched fallback faces Arial / Liberation
Sans / Roboto, `adjustFontFallback: false`: no line re-wraps when Quicksand arrives); code-like values (DNS records, keys) keep `font-mono`. **Blog pages (2026-10-27, at the owner's request):** the
article text is **Lora Regular** 17–19 px (`lora` in `fonts.ts`, only on the blog list/post, `.ppi-blog-body`), headings
Quicksand Bold 36–48 (`.ppi-blog-h1`) / Semibold 24–30 (`.ppi-blog-h2`), navigation and buttons Quicksand Medium
14–16 (`.ppi-blog-nav`), captions Medium 13–14 (`.ppi-blog-caption`) — globals.css, sizes grow with the screen. The
conversation PDFs and the viewer's watermark keep DejaVu Sans (embedded).
**No colours** (only exceptions, at the owner's request: the Cacaduu PPI logo in the header, `public/brand/cacaduu-ppi.svg`
(cacaduu.com, since 2026-10-20; browser and app icons `src/app/favicon.ico`, `icon.svg`, `apple-icon.png`, `public/icons/`),
the **stock dot before every price** (`@/components/StockDot`, `@/lib/stockDot`: a solid fill with a darker ring of the
same hue — green #22C55E / #15803D in stock, red #EF4444 / #B91C1C sold out, yellow #F5B70A / #B7860B no
information/stale; 2026-10-27, colours 2026-10-29). **The stock sentence ("12 ks na sklade", "Vypredané", "Informácia o
zásobe momentálne nie je dostupná") only on the product page** (at the owner's request, 2026-10-29): every listing —
the shop page's products and its Zoznam, the main page's plain results and chat cards, the product page's other shops,
the shop assistant's cards and its copied list — shows only the dot, whose `label` gives screen readers the status
("na sklade" / "vypredané" / "zásoba neznáma", `stock.dot_*`; `STOCK_WORDS`); in listings `StockLine listing` shows
only how fresh the data are and nothing for stale data. The API/MCP `availability_text` and the AI's tool data keep it.
The **shop page's "Produkty / Zoznam"** colours (below), the main page chat's small pin `public/brand/cacaduu-pin.svg` and its **thinking dots in Cacaduu yellow #FFC531** (Prompt 10),
the blue "Select picture" link for shop logos and the same blue "Vybrať súbor" link of page sections (`SectionUploader`) and "Vybrať súbory" of the private folders (`DocUpload`), the blue "GDPR" link of the shop assistant (`AssistantHeading`), the **contact buttons' colours** and their orange
check (`CONTACT_COLORS` in `@/lib/contactButtons`, `@/components/CheckLoop`; pale backgrounds, no shadows; 2026-10-28),
and the shop **status dots** — open #1E9E5A, break #2F6FED, closed
#D64545, holiday #F2B705, no hours #9AA5B1, white outline + thin dark ring, **always next to the status in words**, never
colour alone), no dark mode, no cart icons. Availability is always written out as text, emphasised in bold.
**The shop page "Screen 11" (2026-10-31, at the owner's request — see below) may use colour:** Cacaduu orange #F57C20
(accents: news, assistant, access key), the contact buttons' own tints, green amenity pills (#DCF5E5 / #146C37), the
stock circles and the blue list counter; everything else on it stays black / white / grey, status dots unchanged.
Mobile-first. Map: `@/components/ShopMap` (MapLibre + OpenFreeMap **"bright" = OSM Bright**, `@/lib/mapStyle` — every
map, since 2026-10-31; no API key), pins in the status colour
with the status in words in each pin's tooltip (no legend under the map, at the owner's request; the map data's credit
OpenMapTiles/OpenStreetMap — required by their licences, never removed — stays closed behind MapLibre's small "i"
button, the text only after a tap, 2026-10-27); always an extra — every page must work and show its data without it.

## Shop page "Screen 11" (2026-10-31, at the owner's request)

Claude Design canvas "Davide shop page – iPhone 14 Plus", artboard 11; `ShopView.tsx` (Cacaduu address and own domain),
column ≤ 760 px, designed at 428 px (works at 390). Order: header (own domain: header logo, else logo 32 px + name) ·
details (logo box 46 px, name 24/500, address, company line on #FBF6EC) · `@/components/AmenityPills` (server; only
the amenities the shop has) · contact buttons · map 222 px · hours card (`ShopStatusLine pill`, `STATUS_PILLS` in
`@/lib/statusColors`; today #FFF4D6) · "Sviatky · najbližších 14 dní" card · news slider · assistant · key row ·
products. **Hold links** (`@/components/HoldLink`, rule `@/lib/holdLink`, tests `shopPage_test.ts`): a real `<a href>`
(works without JavaScript); a finger or a mouse holds 1.2 s (fill, "Držte stlačené", done label + `CheckLoop` loaded on
the first press, then opens — a finger in the same tab), a short tap only shows "Držte stlačené" (`hint`), Enter / Space
and a click without a press open at once; children `pointer-events: none` (labels change under the finger); used by
`ContactButtons` (12.5 px decided by `smallLabel()`, never measured) and "Všetky novinky". **News slider** =
`ContentSlider` in the news look: every update 38/39/44 rule stays (`shop_content()`, ratio frame + crop, only the
current ± 1 picture, `<noscript>`); no title, no arrows, no counter; swipe (scroll snap), mouse drag, ← →; gradient +
tag "Novinka"/"Ponuka" + title + white "Čítať" (chevron down, bobbing; "Zavrieť" when open) or "Zobraziť" (viewer);
date + one pill per slide (`aria-pressed`). **"Čítať" opens the post inline**: `InlineArticle` (server: meta "BLOG ·
date · n MIN ČÍTANIA" with `readingMinutes()`, title, `BlogText`, `articlePhoto()` with Ken Burns), all articles in
the HTML (`getBlogPost` per post slide), the post page stays canonical; a link to the post without JavaScript.
**Assistant**: first view = server HTML (`ShopAssistant`) + the small loader `AssistantBoot` (carries text, cursor,
key row, a tapped "Poslať"); `ShopChat` the same look (`.ppi-ai*`): GDPR pill (`<details>`), "Pridať fotku alebo súbor",
orange "Poslať" (plane, "Odoslané"), "Napíšte otázku alebo pridajte fotku". **Key row**: `@/components/KeyRow` (row) +
`@/components/KeyForm` (150 px "Otvoriť", `KeyVortex`: rings while checking, head + crest + badge on success; part of
the assistant's code). Shop page first-load JS 148.9 kB (budget 150). e2e: `public.spec.ts` (slider, pills, Čítať,
key vortex, no sideways scroll, OSM Bright), `contacts.spec.ts`.

## Commands

- `npm run dev` — local site on http://localhost:3000
- `npm run lint` · `npm run typecheck` · `npm run build`
- `npm run test:db` — applies all migrations + seed to a throwaway local Postgres/PostGIS and runs the RLS and stock-logic checks
- `npm run test:status` — unit tests of `shopStatus()` in `src/lib/hours.ts` (Deno): breaks, past midnight, holidays,
  special days, DST
- `npm run test:site` — unit tests (Deno) of the own domain's robots.txt / llms.txt, the item JSON-LD and the search
  links (`src/lib/findable_test.ts`), the contact buttons and the shop page's hold links and stock circle
  (`contactButtons_test.ts`, `shopPage_test.ts`)
- `npm run test:chat` — unit tests (Deno) of the main page chat's protocol: streamed answer, refs, history, NDJSON, the
  layers' rules (town from the shopper's words, good results, OpenStreetMap hours, partner card texts and the 48-hour
  rule) (`src/lib/chat_test.ts`)
- `npm run test:blog` — unit tests (Deno) of the shop blog (`src/lib/blog_test.ts`): addresses on Cacaduu and own
  domains, the text as written, the Facebook message, BlogPosting/BreadcrumbList JSON-LD, RSS, scheduling time zones
- `npm run test:i18n` — unit tests (Deno) of the languages (update 40): the list, the browser's language, the picker's
  search and links, the fallback of interface texts, the same keys and placeholders in sk/hu/en
- `npm run test:strings` — fails on a visible text written into a `.tsx` file instead of the message files
- `npm run test:export` — unit tests (Deno) of the translations folder's files (`src/lib/exportFiles_test.ts`): the
  built-in .xlsx writer/reader (also files as Excel saves them), the files' columns, the owner's edits read back
  (empty cells, read-only columns, unknown rows, Kód then EAN)
- `npm run test:conversations` — unit tests (Deno) of the owner's conversation exports (`src/lib/conversationExport_test.ts`):
  times in the shop's time zone, CSV cells (quotes, ";", new lines, formulas written as text), BOM + CRLF, TXT lines
- `npm run test:crm` — unit tests (Deno) of "Kontakty" (`src/lib/crm_test.ts`): SMS parts (GSM-7 160/153, Unicode
  70/67), tags from one field, refusals as texts
- `npm run test:list` — unit tests (Deno) of the shop page's Zoznam (`src/lib/shoppingList_test.ts`): add / set / remove,
  "9+", totals in cents per currency, Slovak plurals, the copied text, broken stored lists, blocked storage
- `npm run test:search` — unit tests (Deno) of the forgiving search's word rules (`src/lib/searchWords_test.ts`): the
  same stems as `search_stem()`, accents, typo and prefix marks for highlighting
- `npm run test:mcp` — unit tests (Deno) of the owner MCP's shared rules (`src/lib/ownerMcpRules_test.ts`): scopes, the
  OAuth metadata, the 401 header, bearer tokens, the authorization request, the error texts for the AI
- `npm run test:connector` — the POS agent contract (`src/lib/connectorContract_test.ts`): the OpenAPI file has exactly
  the connector function's routes, the written contract names every path, the client calls every path
- `npm run test:items` — unit tests (Deno) of Môj obchod's "Tovar" list (`src/lib/ownerItems_test.ts`): each state of
  "Čo vidí zákazník" (stale → hidden with the reason, sold out, in stock), the filters and the last file's status line
  (also "Žiadny nahraný súbor" after the files were deleted), and the inventory reset's helpers (update 43)
- `npm run test:e2e` — Playwright on a phone (Pixel 7) against `E2E_BASE_URL` (default http://localhost:3000): AI
  search → shop → product, the shop page, blog post, language switch; upload + columns and Produkty search only with
  an owner login and `E2E_OWNER_SHOP` (a shop made for testing)
- `npm run test:content` — unit tests (Deno) of "Obsah stránky" (`src/lib/content_test.ts`): the slide rule
  (pinned never repeated, fewer posts, hidden files, plan limits), counters, srcset, excerpts and where Môj obchod's
  sections live (old addresses forwarded)
- `npm run check:functions` — type-checks the Supabase Edge Functions (Deno) in `supabase/functions/`
- `npm run test:functions` — unit tests of the Edge Functions (Deno): stock-pull file reading and mapping, Stripe
  checkout and webhook, page-sections PDF cleaning and limits, partner-feeds formats, parts and size limit
  — and `paste_safe_test.ts`: the owner pastes every `index.ts` into the Supabase editor, so write invisible or special
  characters (U+FFFF, BOM, no-break space, zero-width) as `\u…` escapes, never literally.

## AI access

`src/lib/publicApi.ts` is the single source for the public API (`/api/v1/*`, OpenAPI at `/api/openapi.json`)
and the MCP server (`/mcp`, stateless Streamable HTTP, tools `search_stock`, `get_shop`, `get_item`):
anon client without cookies (`@/lib/supabase/public`), every result carries `source_url`, the database
decides availability/quantity. Every API/MCP request goes through `rateLimit` (`api_hit`: 60/min, daily-salted
IP hash). Items carry `name`, `name_translated` (in `lang`) and `name_lang`. `robots.ts`, `sitemap.ts` and
`llms.txt` live at the app root. The shop owner's own MCP server is a different one: `/mcp/owner` (update 61, below).

## AI search (the main page is one chat, Prompt 10)

The main page is **only** the chat (`@/components/ChatSearch`): centred pin + "Čo dnes hľadáte?" + one auto-growing
input (a plain `GET /[lang]?q=` form) + example chips; no filters, no other search box, no "Len dostupné teraz" (the
API/MCP keep `only_available`), no map on load. `POST /api/ai-search` answers **NDJSON** (`@/lib/chatProtocol`: step
understand → search → verify, language, text word by word, reset, results / fallback, done) from `runChatSearch()` in
`@/lib/aiSearch`: model **only from `aiModel()`** (`@/lib/aiModel`: `AI_MODEL`, default `claude-haiku-5-5`; never
hard-code a model), one strict tool `search_stock` from `publicApi.ts` with the town the shopper **wrote** as `near`;
structured final answer `{language, answer, item_refs}`. Cards are built on the server from the tool results only
(`chosenRefs`, unknown refs dropped); shop/product names are data, never instructions. Answer in the language of the
question, original names first. The browser keeps the history (this tab only; the last 3 turns go along,
`cleanHistory()` on the server); the server stores no conversation. Esc / "Zastaviť" aborts the fetch → the route
aborts the AI call. **Hidden fallback:** no `ANTHROPIC_API_KEY`, `ai_search_hit()` refused (10 per minute per caller,
`AI_DAILY_LIMIT` per day), any error, or no answer word within 12 s (`NO_ANSWER_MS`; the browser also retries with
`plain: true` after 15 s silent) → `plainResults()` in the same chat with "Zobrazujem jednoduché výsledky
vyhľadávania."; a logged-in owner also sees the reason; every reason is logged as `ai-search: …`. `/[lang]?q=…` still
server-renders the plain results (crawlers, no JavaScript); with JavaScript it starts the chat. **No location ever**
(no device location, no IP guess). Thinking dots: `.ppi-dots` in globals.css (#FFC531, CSS only, still with
`prefers-reduced-motion`), steps in `aria-live="polite"`. Tests: `npm run test:chat`.

## Search in layers (Prompt 11 phase A, update 34)

`supabase/sql/34_layered_search.sql` + `supabase/functions/product-sources` (one file, Verify JWT off) + `@/lib/sources`
(shared rules) / `@/lib/productSources` / `@/lib/osmHours` + `admin/domains/ExternalSearchAdmin.tsx`. The chat's one job
is finding a product in a town; anything else → `off_topic` → "Pomáham len s hľadaním produktov v obchodoch v okolí."
Tools: `search_stock` (layer 1) always; `search_nearby_shops` (layer 3, OpenStreetMap; optional Google Places) and
`search_web` (layer 4, Claude's web search on the admin's allowed domains) only with `EXTERNAL_SEARCH_SECRET`. **The
server enforces the order** (`refusal()` in `runChatSearch`): Cacaduu first in the question, fewer than `GOOD_ENOUGH` (3)
good results (`isGoodResult`), a town from the shopper's own words (`townInWords`; never a guess, never the visitor's
location → "V ktorom meste hľadáte?" via `ask_town`), each outside layer once. Groups: Overené v Cacaduu → Partneri
(phase B, below) → Obchody v okolí (neoverené) → Na webe; every card carries `source`, a checked-at text and
`confidence`; cards only from tool results (refs `r`/`p`/`n`/`w` only choose). **Never** present layer 3/4 as stock, never scrape (only
Nominatim, Overpass, Google Places API, web search), never put Google content in a model request, on our map or in the
database, never store web results. product-sources: `x-ppi-sources` secret; daily limit (`EXTERNAL_SEARCH_DAILY_LIMIT`,
`external_search_claim` before every outside call, skipped as a whole — cache too — once reached); a layer runs only if
its env switch (`WEB_SEARCH_ENABLED`, `GOOGLE_PLACES_ENABLED`) and the admin's `search_layers` switch are on; Nominatim
once per town (`town_geocodes`), 1/s (`external_slot`), User-Agent + `ADMIN_EMAIL`; Overpass cached 24 h per town and
kind; "© OpenStreetMap contributors" / "Google Maps" with their lists; Google field mask = only the fields shown; web:
`web_search_20250305`, `max_uses` 3, `allowed_domains`, `user_location` = town + country, price only from cited text,
deep links `{query}` URL-encoded, new tab `rel="noopener noreferrer"`. Only the product and the town go out (privacy
page lists the services). Admin texts `admin_search`; every admin read/write via `admin_*` SQL (`is_admin()`).

## Partner feeds (Prompt 11 phase B, update 35)

`supabase/sql/35_partner_feeds.sql` + `supabase/functions/partner-feeds` (one file, Verify JWT off) + `@/lib/partnerSearch`
/ `@/lib/partners` (card texts) + `admin/domains/PartnerFeedsAdmin.tsx` / `partnerActions.ts` + `@/components/PartnerFileUpload`.
Layer 2 of the chat: tool `search_partners` {query, town} only when `partner_layer_ready()` (no partner with rows → the
layer is skipped); refused before Cacaduu or with 3+ good Cacaduu results; a town not in the shopper's words is dropped.
Shops nearby and the web need the partners searched first (or in the same turn) and fewer than 3 good results of
Cacaduu + partners (`isGoodPartner`: under 48 h and in stock in a store in the town). **Partner rows are never mixed with
shop data**: own tables (`partners`, `partner_stores`, `partner_products`, `partner_store_stock`, `partner_imports`; RLS,
no grants), read only through `search_partner_products()` (same `search_text` / `matches_all_words` search); never in
`public_stock`, `search_stock`, pages, API or MCP. Shown **as the partner sent it** (never edited; a row over the limits
is unreadable, never cut; own-CSV columns outside the known names never stored); stock per store **only from the local
inventory feed**. The database decides freshness: older than 48 h → no availability and no stores, only "údaje z
<dátum>". Card: "Decathlon (partner) · 24,99 € · online skladom / predajňa Košice: skladom podľa partnera · údaje z
08:00" (`search.partner_*`), affiliate → "partnerský odkaz" + `rel="sponsored"`; **ranking never uses the affiliate flag
and the AI never sees it**; logo in grey. Import: pg_cron `ppi-partner-feeds-tick` (5 min) → download streamed (gzip
unpacked) into 4 MB parts in private `partner-feeds` (`imports/<import>/`), over `PARTNER_FEED_MAX_MB` (default 50, ≤ 500)
→ `too_big`, nothing changed, never cut; one part per call (2 s CPU), `carry` across parts, the function chains itself
(`work`, service key); finish replaces that partner's rows; 304 / same uploaded file → unchanged. Feed URLs: https of a
real host only, forwards checked, never logged. Admin uploads go browser → storage (policy: admin + name pattern).
Admin texts `admin_partners`.

## Forgiving product search (update 54)

`supabase/sql/54_forgiving_search.sql` + `@/lib/searchWords` (the stem rule mirrored for highlighting only;
`searchWords_test.ts`, `npm run test:search`) + `@/components/ShopProducts` (the shop page's live search, below) + `/api/shops/[slug]/search` + `@/lib/data`
`searchShopItems()`. **One rule in SQL for every place that searches:** `shop_item_search(slug, q, limit, offset)` (one
shop: "Produkty" on the shop page, the assistant's `search_items`; `shop_stock` with words returns its rows) and
`item_search(q, lat, lng, radius, only_available, limit)` (all shops: `search_stock` with words returns its rows → page,
API, MCP, the chat's tool and the plain fallback; `search_stock(null, …)` = the old nearby list, `search_stock_exact`
not callable by visitors). Per word: same word 1, beginning 0.85, typo 0.6 (trigram finds, edit distance decides);
`search_stem()` (endings cut, c/k y/i w/v ph/f alike), `search_sizes()` ("0,5 l" = "500 ml"; same size +, never
excludes), `search_generic()` (farba/paint/festék… weigh ⅓, no typo check in the fast pass); every specific word must
hit (one may miss of 3+): "white chocolate" never finds a white paint. `kind` exact (code/EAN +100, every word +10) /
match / similar (nothing matched: closest names, "Nenašli sme presnú zhodu – podobné produkty:"). Across shops the
shop's words (`shops.search_stems`) count, so "farba v Budinciach" = only Budince; a typed town is never a location.
Order: score, then in stock + current, freshness, distance only with a point, name — **never a plan or payment**.
Stored columns `shop_items.search_stems` / `search_sizes` (+ trigram/GIN index), `shops.search_words` / `search_stems`
are dropped and made again on every run of the file. Speed: < 150 ms for a 5 000-item shop, < 300 ms for 100 000 items
(cheap pass without typos over ≤ 3 000 candidates, full check on the best 600, precise re-score on the top 100,
`public_stock` last by id). Claude's words (`query_expansion()`) only when fewer than 3 rows (`FEW_RESULTS`) or nothing
matched in a shop (4+ letters). The shop page's search filters the rows live (below; `rateLimit` 120/min per caller);
without JavaScript the plain GET form `?q=#items`. e2e `e2e/shop-search.spec.ts`.

## Shop page "Produkty / Zoznam" (2026-10-29, at the owner's request)

`@/components/ShopProducts` (first load) + `@/components/ShopList` (the Zoznam tab, loaded when opened or after the
first add) + `@/lib/shopProductsEngine` (the list's store, the movements and the live search, loaded right after the
page appears) + `@/lib/shoppingList` (rules + store, `shoppingList_test.ts`, `npm run test:list`) + `@/lib/listMotion` +
`@/lib/shopRows` (rows written on the server: names, price, dot state, search marks) + `.ppi-list*` in globals.css.
Replaces "Tovar v obchode" (heading kept for screen readers; the "Zásoby: …" line about the whole file stays above).
**Tabs** "Produkty" / "Zoznam" = real radio inputs, visually hidden (`sr-only`); #EEF1F5 box, active white, bold,
#1D4ED8, soft shadow, scale 0.95 → 1.05 → 1 on change; the Zoznam counter (pieces, "99+") on the icon's corner, the
icon keeps room for it (never over the label); switching tabs never moves the page and is never endless: below the tabs
there is exactly one screen of room (`calc(100lvh - …)`, measured before the switch) — scrolled to the end, the tabs
touch the top of the screen on a phone, a notebook or a PC; without JavaScript the tabs are hidden (`<noscript>` style) and only
Produkty shows. **Produkty:** "Hľadať v tomto obchode" with one border (on the wrapper; the input reset, 16 px so
iPhone does not zoom) filters live through `/api/shops/[slug]/search` (200 ms, only the newest answer, `replaceState`
`?q=`, the rows keep their height while searching), marks #FEF3C7 (cut on the server), × and Esc clear, "Nájdené: N
produktov" (Intl plurals: 1 produkt, 2–4 produkty, 5+ produktov), "Pre „…“ sme nič nenašli" (+ the similar note).
Row: name 15 px / 500 (link to the product; the shop's own name under a translation), the dot as a **reset button**
(32 × 32, 20 px circle, `aria-label` "Pridať do zoznamu: <name>, <status>"), the price as in the file; **no stock
sentence**. A tap adds one piece: a 12 px #2563EB ball arcs to the Zoznam icon (~820 ms, one bounce), the icon wiggles,
the counters pop (18 px #2563EB, white 10 px bold, 1.5 px white ring, "9+" on the dot). **Zoznam:** name, quantity ×
price, stepper − / qty / + (minus #EA580C on #FFF1E6, a bin at 1); swipe left or right (pointer events, `touch-action:
pan-y`, never from a button; past 35 % solid #F97316 with white bins, before #FFEDD5) → slides out and closes, shorter
springs back; removal: a #F97316 ball from the icon to the row, the icon shakes, the counter dips with an orange flash,
hidden at 0; "Spolu" per currency; "Zoznam je prázdny". **"Kopírovať zoznam"** (48 px, #EFF5FF / #BFD5FB / #1D4ED8):
"Nákupný zoznam – <shop>", its address (never shown in this section), "2× <name> – 19,80 €" (the shop's own name in
brackets after a translation), "Spolu: …"; `navigator.clipboard` → `execCommand` → the text selected in a read-only
box; success = solid blue, drawn check, "Skopírované" 2.2 s. **State:** localStorage `ppi.list.<shop id>` (try/catch:
blocked storage keeps the list for the visit), names and prices as shown when added; never sent anywhere; no shop data
changed. `aria-live` announcements (`shop.said_*`); `prefers-reduced-motion`: no balls or bounces, instant counters.
First-load JS: the shop page stays < 150 kB (its status line is `ShopStatusLine` → `LiveStatusLazy`: the hours rule
loads after the page appears). e2e `e2e/shop-list.spec.ts` (Pixel 7 + an iPhone-sized project).

## Paid plan (Stripe)

One monthly subscription per shop; test mode first. `public.subscriptions` (one row per shop, owners read their own) is
written only by the service role: `supabase/functions/stripe-checkout` (owner's JWT → `is_shop_member`; makes the shop's
Stripe customer once → `link_stripe_customer()`; returns the Checkout URL, or the customer-portal URL when the shop's
subscription is live) and `supabase/functions/stripe-webhook` (verifies the Stripe signature, fetches the subscription
fresh, `apply_stripe_subscription()`). **Every paid feature checks only `shop_has_plan(shop)`** (active or trialing and
not past `current_period_end`); never decide it in React. `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_PRICE_PRO` are function secrets; the website has no Stripe key and reaches Stripe only through the dashboard
server action `openBilling` → stripe-checkout. Checkout: automatic tax, business name (required), VAT number (tax ID
collection), company ID (custom field, pre-filled from `shops.ico`, copied to the customer's invoices). A shop whose
plan still renews cannot be deleted (`owner_delete_shop`).

## Shop assistant (paid)

Shop page only, only when `shop_has_plan(shop)` is true and `ANTHROPIC_API_KEY` is set: `@/components/ShopChat`
(always open since update 27; the page stays server-rendered without it) → `POST /api/shops/[slug]/chat` → `@/lib/shopChat` (Claude
`AI_MODEL`, default Haiku `claude-haiku-5-5`; strict tools bound to that shop on the server: `search_items` →
`shop_item_search` (update 54; each row's match exact/close/similar), `get_item` → `public_stock` filtered by the shop, and `search_shop_docs` when the shop has documents;
never other shops; structured answer: answer, item_refs, shopping_list, photo read/match, sources, pictures,
document_prices, call_shop). Cards, the list, sources and pictures only from tool results; a document price only if
the excerpt contains it; availability from the database. Every message passes
`shop_chat_hit()` (plan, 20/hour per caller in `api_usage`, `CHAT_MONTHLY_LIMIT_PER_SHOP` per shop and month in
`shop_chat_usage`). Files (≤ 4 per message): the AI gets photos shrunk in the browser (≤1568 px JPEG) and PDFs as the
text of their first 5 pages (read in the browser), once; the files themselves are stored only through the archive
(below), never logged; "found" without an item becomes "unsure". Every answer also returns `language`, `message_sk`,
`answer_sk` for the archive. Access keys pasted into the chat become "[•••]" (`hideAccessKeys`). History: last 8
messages, text only.

## Documents for the assistant (paid)

Owners upload PDFs and pictures (dashboard `ShopDocuments` → `@/components/DocUpload`: one box for both, up to 20
files at once, chosen or dropped; each file goes its own way, a failed one is listed and the rest still go): **never products** (items,
prices, stock only from the stock file) and **never edited or translated** by PPI (text as written; the only thing the
owner corrects is the AI's picture description, `description_by_owner`). PDFs are read **in the owner's browser**
(`@/lib/pdfRead`, pdf.js legacy build, assets from `scripts/copy-pdfjs-assets.mjs`) because Edge Functions have 2 s
CPU; `supabase/functions/doc-ingest` (owner's JWT, actions register_document / document_uploaded / text /
register_pictures / pictures_uploaded / document_done / work / links / delete) stores excerpts (`chunkPages`, one page
apart, ≤ ~800 words, `detectLang`) and lets Claude (`AI_MODEL`) describe pictures and write out scanned pages. Limits:
`SHOP_DOCS_MAX_FILES`/`_PAGES`/`_PICTURES` (Supabase secrets). Private bucket `shop-docs` (owners only insert
registered files; service role reads/deletes). Visibility is decided only in SQL: `search_shop_docs(slug, q, token)`
(Public folder + folders of a valid session; never accepts folder ids), `shop_file_path()` for `shop-files` (10-minute
signed URLs). Access keys: `owner_create_folder_key()` (shown once, SHA-256 only), `unlock_shop_folders()` (5 wrong per
caller/shop/15 min) → session token in a signed HttpOnly cookie per shop (`@/lib/docsAccess`, `SESSION_COOKIE_SECRET`,
path `/api/shops/<slug>/`, routes `access` and `files`); the key and token never reach the AI. Private content never in
pages, JSON-LD, sitemap, llms.txt, public API, MCP or the main-page AI search.

## Assistant archive (paid, update 22)

`supabase/sql/22_assistant_archive.sql` + `supabase/functions/assistant-archive` (one file, Verify JWT off) +
`@/lib/assistantArchive`. Every conversation is kept for the shop's owners: `assistant_conversations` / `_messages`
(`body_owner` = Slovak version, `cards` as seen: name, price, Slovak availability, `data_time`) / `_attachments` /
`shop_assistant_settings` (RLS: members read; only the service role writes). Only the function writes: the website with
`ASSISTANT_ARCHIVE_SECRET` (Vercel Sensitive + Supabase secret; never `NEXT_PUBLIC`) — start, record (only into that
shop's open conversation), end, delete, discard; the shopper's browser uploads straight to the function with the
conversation's token (kept as SHA-256): real type by content (JPEG/PNG/WebP/HEIC/PDF), 10 MB, 10 per conversation,
**GPS and place data removed before storing**, private bucket `shop-assistant-uploads/<shop>/<conversation>/`; owners
(their JWT + RLS) get 10-minute links and delete. Ends after 30 minutes idle (pg_cron tick every 5 minutes, Vault
`ppi_project_url` + `ppi_assistant_cron`) or when the shopper closes the box / starts a new one / leaves the page;
then one PDF (pdf-lib + DejaVu Sans subset in the file: `<YYYY-MM-DD>_<HH-MM>_<short id>.pdf`, footer "Vytvorené
Cacaduu PPI · konverzácia <id> · strana X/Y"). Keep time "Neobmedzene" (null, the default since update 55) or
30/90/365 days; the nightly job deletes only for shops that chose a limit. "Konverzácie asistenta"
(dashboard `Conversations.tsx`, page `dashboard/conversations/[id]`): read, delete and, since 2026-10-14, **"Stiahnuť
PDF"** (finished conversations only; `owner_pdfs` in the function, RLS decides; `/api/owner/conversations/[id]/pdf`) and
ticks + "Stiahnuť vybrané" (`ConversationDownloadBar`, each conversation its own PDF, no ZIP); the PDF shows the
shopper's pictures large. Logos get a PNG
twin (`logo-<time>.png`) for the PDFs. Never put purchase prices, suppliers, margins, invoice numbers, access keys or
other shops' data into conversations, PDFs or exports. "Konverzácie do počítača" (since 2026-10-14, at the owner's
request): the shop PC's `/sync` window saves each finished conversation's PDF into a folder it picked
(`@/components/ConversationFolderSync`, File System Access `readwrite`, every 5 min, `<YYYY-MM>/<pdf_name>`, never
replaces or deletes a file, state only in that browser); the cloud folder (below) stays a push from our server.

## "Konverzácie" (paid, update 55, CRM phase 1)

`supabase/sql/55_conversations.sql` + `dashboard/Conversations.tsx` / `conversationActions.ts` / `conversations/[id]` +
`@/lib/conversationExport` + `/api/owner/conversations/[id]/txt` and `/export`. The Asistent page is **three tabs**
(plain links from `?at=`: assistant · conversations (+ cloud) · docs; the "Konverzácie" tab shows the number of new
ones, `owner_conversations_new()`); only the open tab loads its data; old addresses keep working (`dashboardPages`).
Every conversation: `status` new|read|archived (a new message → new; opening → read via
`owner_conversations_mark(…, 'read', p_log => false)`), `starred`, `owner_note` (private, ≤ 2000), `unanswered`
(the assistant's `call_shop`), `access_key_used` (a non-public document in the exchange), `item_ids` (cards' `item_id`,
only this shop's items), `search_doc` (never granted to owners). **Only the owner_* functions read the list and write**
(`owner_conversations` with filters q/days/status/star/no answer/files/language, `_mark`, `_note`, `_log`, `_export`);
deletions stay in assistant-archive `owner_delete` and are logged with `owner_conversations_log`. Every owner action
goes to `shop_activity` (`conversation_retention`, `conversations_marked`, `conversation_note`, `conversations_deleted`,
`conversations_exported`). Exports: PDF (as before), TXT per conversation, CSV per date range (BOM, ";", formula
guard, ≤ 50 000 rows, shop's time zone). Before update 55 the list falls back to `owner_assistant_conversations`.

## "Kontakty" (paid, update 56, CRM phase 2)

`supabase/sql/56_contacts.sql` + `supabase/functions/crm-messages` (one file, Verify JWT off) + `dashboard/contacts`
(`page.tsx` list + "E-mailové šablóny", `[id]/page.tsx` tabs Prehľad · Konverzácie · Rezervácie · Správy, `actions.ts`,
`parts.tsx`) + `@/components/MessageComposer` + `@/lib/crm` (`crm_test.ts`). `shop_contacts` (name, `phone` **E.164 only,
one per shop and number** — `crm_phone(raw, shops.country)`: "00"/"+" international, trunk 0 (HU "06"; IT/SM/VA keep the
0) + `crm_calling_code()`; `phone_verified_at` **set only by the system** (the booking's SMS code, phase 3), a changed
number loses it; email, address, tags ≤ 20, note, source owner|chat|booking). Conversations join a contact **by the
phone** (`assistant_conversations.shopper_phone` + `contact_id`, both triggers) or by hand (`owner_link_conversation`).
`shop_email_templates` (≤ 50 per shop) with `{{name}} {{first_name}} {{shop}} {{shop_phone}} {{shop_email}}
{{shop_address}} {{shop_web}}` filled only by `crm_render()`. **Every outgoing message is written down first**
(`shop_outgoing_messages`: recipient, text as sent, status queued|sent|failed|test, who): the page's "Náhľad" =
`owner_message_preview()` (nothing written), "Odoslať" → crm-messages `send` → `owner_message_queue()` with the owner's
login (members + `shop_has_plan`, ≤ 100 per channel and shop in 24 h, SMS ≤ 480) → Brevo (sender name = the shop,
`replyTo` = the shop's e-mail, from `ALERT_EMAIL_FROM`) or the `SmsProvider` (`SMS_PROVIDER` unset/"test" = written down
as `test`, never sent; `brevo` / `twilio` since update 58, below) → `crm_message_result()` once (service role).
Owners read contacts, templates and the log (RLS); every write only through `owner_*` (activity log: `contact_saved`,
`contact_deleted`, `contact_linked`, `email_template_saved`, `email_template_deleted`, `message_sent`). Without the plan
reading stays, changes and messages are refused (`no_plan`). Never log numbers, addresses or texts.

## "Rezervácie" (paid, update 57, CRM phase 3)

`supabase/sql/57_bookings.sql` + `supabase/functions/bookings` (one file, Verify JWT off) + `@/lib/bookings` +
`/api/shops/[slug]/booking` + `@/components/BookingPanel` (in `ShopChat`) + `dashboard/bookings` (`page.tsx` Zoznam ·
Kalendár · Nastavenia, `actions.ts`). Booking happens **in the shop assistant**: tool `find_slots` only when
`shop_takes_bookings(slug)` (active, `shop_has_plan`, "Prijímať rezervácie" on — default off); the AI reads the terms
from the shop's documents first, offers times (`booking_slots` → `reply.booking`, only the tool's own slots, ≤ 8) and
**never asks for or receives personal data** — the page's own form does (name, mobile, optional e-mail / address /
note, consent + `CONSENT_VERSION`). **Free times only in SQL** (`booking_day_ranges` / `booking_free_slots`: special day
> holiday > `opening_hours`, lead, horizon, step, buffer, live bookings) minus the shop's Google freeBusy; **no overlap**
= the `exclude using gist` constraint on pending + confirmed. SMS code: 6 digits, hash only, 10 minutes, 5 tries, ≤ 3
sends, 3/phone + 5/caller per hour, 100/shop per day; the SMS log masks it "••••••"; `BOOKING_TEST_CODES=on` shows it in
the chat only while `SMS_PROVIDER` is test. Right code → `booking_confirm()` at once (**no confirmation SMS**): contact
by `crm_phone` found or made, `phone_verified_at` (the only place it is set), conversation linked, Google event
(`calendar.events.owned`, `sendUpdates=none`, no attendees). Google: OAuth PKCE, scopes **only** `calendar.freebusy` +
`calendar.events.owned`, tokens AES-GCM (`BOOKING_TOKEN_ENCRYPTION_KEY`), owners see only the status; expired →
bookings go on without it. Reminder the day before (off by default, after 09:00 shop time, no cancel link;
`ppi-bookings-tick`). Owners: `owner_save_booking_settings`, `owner_bookings`, `owner_set_booking_status` (Potvrdená /
Zrušená / Neprišiel), activity log. The website reaches the function with `ASSISTANT_ARCHIVE_SECRET` (`x-ppi-website`).
Never log phones, codes, names or tokens. Texts `chat.booking_*`, `bookings`.

## SMS quotas and the SMS provider (paid, update 58, CRM phase 4)

`supabase/sql/58_sms_quotas.sql` + the **SMS providers block** (identical in `crm-messages/index.ts`,
`bookings/index.ts` and, since update 60, `hours-sms/index.ts`, between "SMS providers (the same block…" and "end of the
SMS providers"; `sms_providers_test.ts` fails when the copies differ — edit all three) + `@/lib/smsUsage` + `@/components/SmsUsage` + `admin/domains/SmsAdmin.tsx`.
**Two monthly quotas per shop, kept apart:** `booking` (kinds booking_code + booking_reminder) and `owner` (kind owner),
limits only in `sms_quota_limits` (default 100 each; only `admin_save_sms_quotas()`, admin "SMS"). A quota counts **SMS
parts** (`crm_sms_parts()` = `smsParts()` in `@/lib/crm` = `isGsm()` in the providers: GSM-7 160/153, Unicode 70/67) of
every SMS in the log except `failed` (queued, sent and test count), in the **shop's calendar month** (`sms_month()`).
**Nothing is sent over a limit, and every SMS is written down before it leaves:** owner → `owner_message_queue()`
(`sms_quota_take()`: one advisory lock per shop and quota, raises `sms_quota`, keeps `parts`); booking → the function's
`booking_sms_claim()` (queued, code masked "••••••", `sms_quota` → the time is released, 429) → send →
`booking_sms_settle()` once. At the booking limit `shop_takes_bookings()` offers nothing, `booking_resend()` refuses
(old code kept) and `booking_reminders_due()` waits. Owners see "SMS tento mesiac" (`owner_sms_usage()`, members) on
Kontakty, the contact's Správy (owner quota) and Rezervácie → Nastavenia (booking quota) + a banner when bookings
pause. Providers by `SMS_PROVIDER`: unset/`test` (written down, never sent), `brevo` (POST
`https://api.brevo.com/v3/transactionalSMS/send`, `BREVO_API_KEY`, `type: transactional`, `unicodeEnabled` only for
non-GSM text, 402 = no credits), `twilio` (`TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` or
`TWILIO_MESSAGING_SERVICE_SID`); `SMS_SENDER` letters/digits ≤ 11 (default "Cacaduu"); a provider without its secrets
fails every SMS (never pretends). Errors keep only the provider's status/code — **never a number or text in a log**.
`BOOKING_TEST_CODES` is ignored while a real provider is set. Texts `sms_usage`, `admin_sms`.

## Unanswered questions: the shopper leaves a contact (paid, update 59, CRM phase 5)

`supabase/sql/59_unanswered.sql` + `@/components/CallbackPanel` (in `ShopChat`, after an answer with `askContact` =
the assistant's `call_shop`) + `/api/shops/[slug]/callback` + crm-messages `alerts` + `dashboard/Callbacks.tsx` /
`callbackActions.ts` + the conversation page's callback box + the menu badge (`AccountNav` `badge`). **The page's own
form, never the AI**: phone or e-mail (at least one), optional name, consent (`CALLBACK_CONSENT` in the route). Only
`shopper_leave_contact()` decides (anon, the conversation's own token, ≤ 24 h old, `shop_has_plan`; 3 per conversation,
5 per caller an hour, 100 per shop a day; returns only `{ok}`): contact by `crm_phone` else by e-mail else new (source
chat; fills only empty fields; **never "overené"**), conversation joined (`shopper_phone`, `contact_id`), `unanswered`,
status new, `callback_*` kept, one row in `shop_owner_alerts`, activity `callback_requested`, `crm_alerts_kick()` (pg_net
right away when there, else the job `ppi-crm-alerts-tick` every 5 min, Vault `ppi_crm_cron`). crm-messages `alerts`
(x-ppi-cron → `crm_cron_ok`): `crm_alerts_due()` → one Brevo e-mail per owner of the shop in the owner's
`profiles.language` (sk / hu / else en) "Nový zákazník, prosím odpovedzte – <shop>" with the unanswered question (Slovak
when archived) and the link `SITE_URL/<lang>/dashboard/conversations/<id>` — **never the shopper's number or address**
— → `crm_alert_result()` (once; back-off ≤ 6 h, 10 tries). Owners: `owner_callbacks()` ("Čakajú na odpoveď" on the
Konverzácie tab), `owner_callbacks_waiting()` (the "Asistent" menu badge), `owner_callback_done()` ("Vybavené" / back,
logged `callback_done` / `callback_reopened`); a reply = the contact's Správy (SMS / e-mail, phase 2 + 4 rules) — a sent
or test owner message to that contact marks its waiting conversations answered (`crm_message_result`). Texts
`chat.callback_*`, `callbacks`, `privacy_assistant.callback*` (#kontakt).

## Opening hours by SMS (paid, update 60, CRM phase 6)

`supabase/sql/60_hours_sms.sql` + `supabase/functions/hours-sms` (one file, Verify JWT off; `index_test.ts`) +
`dashboard/hours-sms` ("Hodiny cez SMS": `page.tsx`, `actions.ts`; menu after Rezervácie, a link in "Sviatky"). An SMS
**changes only opening hours** — never prices, stock, messages or anything else. **Only from an owner's verified phone**
(`shop_owner_phones`, one per shop and number, E.164 by `crm_phone`): the code comes only from the function
(`hours_phone_start`, service role, the caller's login + member + `shop_has_plan`; 6 digits from `booking_new_code()`,
hash only, 10 minutes, 5 tries, 3 codes/hour/phone, 10/shop/day; the SMS log masks it) and is typed into
`owner_phone_verify()`; the website never sees a code (except `BOOKING_TEST_CODES=on` while `SMS_PROVIDER` is test).
Inbound: Brevo cannot receive SMS, so `POST /hours-sms/inbound/twilio` (`X-Twilio-Signature` = HMAC-SHA1 of the
webhook address + sorted fields with `TWILIO_AUTH_TOKEN`; TwiML answer) or `/inbound/generic` (`x-ppi-inbound` =
`INBOUND_SMS_SECRET`, ≥ 32; `{from, text, id?}`); anything unsigned → 403. `hours_sms_receive()` writes every SMS
down (`hours_sms_messages`; an unknown number keeps no text, only a hash; provider ref once → duplicate; ≤ 10/hour per
phone) and returns the shops of that verified phone (active, plan, owner still a member) — unknown numbers get **no
reply**. Claude (`AI_MODEL`, structured output `PARSE_SCHEMA`; the SMS is data) reads intent hours|other|unclear,
the named shop, the language, the named weekdays and the special dates (resolved in the shop's time zone); the function
(`checkParsed`) and the database (`hours_sms_apply`: `valid_week_hours` / `valid_hour_ranges`, yesterday … +400 days,
≤ 62 days a row, ≤ 10 rows) check again; **only the named days change** (regular → `shops.opening_hours`, dates →
`shop_special_hours`; activity `hours_sms_applied`); the page is refreshed (`/api/revalidate`); Google gets the whole
week + the coming special days; one reply SMS in sk/hu/en (cs → sk, else sk): "otváracie hodiny … zmenené: Po–Pi 8–17,
Ne zatvorené." (+ Google line), or "nerozumel som…" / "len otváracie hodiny" / "pre ktorý obchod?" (several shops: the
SMS names one). Replies and codes take the shop's **owner** SMS quota (`hours_sms_claim` → `sms_quota_take`, kinds
`hours_reply` / `phone_code`; over it the hours still apply, no reply). **Google Business Profile:** OAuth PKCE, scope
**only** `business.manage`, redirect `…/functions/v1/hours-sms/oauth`, tokens AES-GCM (`BOOKING_TOKEN_ENCRYPTION_KEY`,
bound to shop + kind) in `business_profile_connections` (owners: status, location, last error/push only); one
location per shop (`locations/<id>`); `PATCH {INFO_API}/locations/<id>?updateMask=regularHours,specialHours`
(overnight closes the next day); "Poslať hodiny do Google teraz" for changes made on the website; 401 → expired;
"Odpojiť" revokes and deletes. The Business Profile APIs need Google's approval for the project. Never log numbers,
SMS texts, codes or tokens. Texts `hours_sms`.

## The owner's MCP server (paid, update 61, CRM phase 7)

`supabase/sql/61_owner_mcp.sql` + `src/app/mcp/owner/route.ts` + `@/lib/ownerMcp` (server) / `@/lib/ownerMcpRules` (shared,
`ownerMcpRules_test.ts`, `npm run test:mcp`) + `/.well-known/oauth-protected-resource[/mcp/owner]`,
`/.well-known/oauth-authorization-server`, `/api/oauth/{register,authorize,token,revoke}` + the consent page
`/[lang]/oauth/authorize` + `dashboard/ai` ("AI asistenti": address, how to connect Claude / ChatGPT / Gemini / Grok,
connected grants with "Odpojiť", personal keys via `@/components/McpKeyForm`) + crm-messages `mcp_send`. **The shopper
MCP (`/mcp`) is unchanged.** Access: OAuth 2.1 — dynamic client registration (public clients, redirect https or
http://localhost only, 10/caller/hour), code + PKCE **S256 only**, code once (a second use revokes its grant), access
1 h, refresh 60 days **rotating** (an old refresh token used again revokes the grant), RFC 9728/8414 metadata, 401 with
`WWW-Authenticate: Bearer resource_metadata=…` — or a **personal key** (`cmk_…`, 1 year, ≤ 10) for clients that only take
a bearer header. Tokens are random, returned once, kept as SHA-256 only; tables `owner_mcp_clients/_codes/_tokens/_pending`
have no grants (functions only). Scopes `shop.read` (always) · `shop.write` · `messages.send`, shops ticked on the consent
page — **Pro shops only**. **One door:** `owner_mcp_call(token, tool, args)` (anon may call it; the website holds no
secret): token → scope of the tool → the shop (in the grant, the owner still a member, `shop_has_plan`) → 120 calls/min
per grant → `mcp_act_as()` sets the request's JWT claims to the owner so **every owner_* function and its checks run as on
the website** → result `{shop, result, changed}` (changed → `refreshShop`). `owner_mcp_whoami(token)` = the route's first
check (tools listed only for the grant's scopes). Tools: list_shops, get_shop_details, get_opening_hours,
list_conversations, get_conversation, list_contacts, get_contact, list_bookings, list_email_templates, get_sms_usage,
search_stock · update_conversations, save_contact (only the given fields change), delete_contact (confirm),
set_booking_status, set_opening_hours (`mcp_set_hours`: only the named days, the 60's rules, activity `hours_changed`),
update_shop_details (name, phone, e-mail, website, Facebook, booking link only → `owner_save_shop` with the rest as is),
update_stock (one item: quantity/price, **never the currency or the freshness**; without `confirm` only before/after and
the warning that the next stock file / POS agent / inventory program overwrites it; activity `stock_edited`) ·
preview_message (exactly what would go + a confirmation id, 10 min, `owner_mcp_pending`) → send_message (crm-messages
with `x-ppi-mcp` → `owner_mcp_message_queue()`: same grant, once, refused `preview_changed` when the rendered message
differs, then `owner_message_queue` as the owner — quota, 100/day, log). Every write is in `shop_activity` as the owner
(`mcp_connected`, `mcp_disconnected`, `mcp_key_created`, `mcp_message_queued`, `hours_changed`,
`shop_details_changed`, `stock_edited` + the owner_* functions' own). The consent page is never framed (`next.config.ts` headers). Texts `owner_mcp`; login keeps a safe `next`.

## Cloud folder (paid, update 23)

`supabase/sql/23_cloud_export.sql` + `supabase/functions/cloud-export` (one file, Verify JWT off) + dashboard
`CloudFolder.tsx` / `cloudActions.ts` / `@/components/CloudFolderPicker`. One export **adapter** (OneDrive via Microsoft
Graph, Dropbox; no Google Drive): OAuth code + PKCE, state SHA-256 single use 10 min, redirect
`…/functions/v1/cloud-export/oauth/<provider>`; scopes OneDrive `offline_access Files.ReadWrite`, Dropbox
`files.metadata.read files.content.write account_info.read` offline. Tokens **only encrypted** (AES-GCM,
`EXPORT_TOKEN_ENCRYPTION_KEY`, bound to shop/provider/kind) in `cloud_connections` (owners have no grant on the token
columns), renewed automatically; "Odpojiť" deletes them. Default target `/Cacaduu/<shop name>`; share links refused
with an explanation. After `assistant_pdf_done` queues it, assistant-archive calls `export` (service role key) →
`<target>/<YYYY-MM>/<YYYY-MM-DD_HH-MM_id>/konverzacia.pdf` + `…/subory/`; job `ppi-cloud-export-tick` every 5 min.
**Never overwrite or delete in the shop's cloud** (OneDrive `conflictBehavior=fail`, Dropbox `mode: add`; same file →
not sent again, different → " (2)"); `cloud_export_items` notes what was copied. Status per conversation (Čaká /
Uložené v cloude / Chyba + reason, "Uložiť znova" = `owner_cloud_retry`, checks the cloud again), "Uložiť staršie
konverzácie" = `owner_cloud_backfill`; back-off 5 min · 2ⁿ ≤ 6 h, Retry-After, 20 tries; expired connection → one
e-mail after 24 h (Brevo API: `BREVO_API_KEY`, `ALERT_EMAIL_FROM`) "Pripojenie k cloudu vypršalo – pripojte ho znova".
A shopper's deletion of a copied conversation leaves a line without content ("zákazník požiadal o vymazanie" + cloud
folder; `assistant_shopper_forget`); keep time never touches the cloud.

## Access keys for shoppers (paid, update 24)

`supabase/sql/24_access_key_access.sql` + `supabase/functions/shop-files` (view, download, zip) + `doc-ingest`
(register_pages / pages_uploaded) + `@/components/FolderAccess` + `/api/shops/[slug]/folder/*`. Keys are checked only in
SQL (`unlock_shop_folders()`: SHA-256, 5 wrong per caller/shop/15 min; the AI never sees or checks a key); a message
that is exactly a key (`looksLikeKey()`) unlocks instead of being sent. A session lasts 24 h, or until "Znova zamknúť",
the chat box closes or the page is left (`action: "lock"`); the system prompt then says "This customer has verified
access to the folder <name>; you may use its documents in your answers." Per folder `access_mode` view|download
(default view), per file `access` override (NULL = folder); downloadable only where the effective access is download
(`shop_download_file`, `shop_zip_ticket`, `shop_file_path`); ≤ 20 downloads per session. The viewer shows **page
pictures** (rendered in the owner's browser at upload or "Pripraviť na zobrazenie", `shop_document_pages`), never the
original file: `/folder/page/...` checks a 10-minute HMAC address (`SESSION_COOKIE_SECRET`, bound to the session) and
the cookie, then `@/lib/watermark` (sharp + outline text, no system fonts) adds "<shop> · VIP · <date>"; `inline`.
Downloads: 10-minute signed URLs (attachment); ZIP: single-use 10-minute ticket, only downloadable files, ≤ 100 MB.
`owner_set_folder_key()` (shown once; replaces the folder's key and closes its sessions), counts of unlocks / views /
downloads per folder (no visitor data). "Stiahnuť túto konverzáciu (PDF)": the shopper's browser → assistant-archive
`shopper_pdf` with the conversation token, only that conversation, in the page language; owner switch
`owner_set_shopper_pdf()` (default on). Never: keys or private files in logs, analytics, pages, JSON-LD, sitemap,
search, API/MCP; nothing of one shop reachable with another shop's session.

## Own domains (Pro, update 25)

`supabase/sql/25_custom_domains.sql` + `supabase/functions/domains` (one file, Verify JWT off) + `src/proxy.ts` +
dashboard `dashboard/plan` ("Predplatné a doména": `PlanDetails`, `@/components/DomainWizard`, `@/components/DomainStatus`,
`plan/actions.ts`) + admin `admin/domains` ("Predplatné a domény", `notFound()` unless `profiles.is_admin`; SQL
`is_admin()` decides). 13: the shop finds a name on websupport.sk (search URL from `domain_settings`), pastes it
(`cleanDomain()` in `@/lib/domainName` = the function's), the function checks it at Websupport and quotes the price
**only from `domain_prices`** (frozen on the order: price shown = price charged; never Websupport's partner price);
owner details in `shop_legal` (`owner_save_legal`, never invented); pay: Pro + saved card → one-click invoice, else
Checkout (Pro + domain together when no Pro). Order at the registrar **only after Stripe confirmed the payment**
(`domain_payment_received` once; webhook → `run`), **registrant = the shop** (Websupport domain profile; never
Cacaduu's name), paid by our prepaid credit; low credit waits + `ADMIN_EMAIL`. `REGISTRAR_MODE=test` (default) = dry
runs, website on the admin's test domain. DNS: only Vercel's records (A/CNAME/TXT from the Vercel API), **never touch
MX/SPF/DKIM/DMARC/other records**. 14: own domain → Vercel → the exact records shown → checks 7 days → Beží. Registrars
behind the `Registrar` interface. Every step in `domain_orders.log`; never log keys or signatures. Live → one e-mail
(Brevo, `live_email_at`), page countdown → `https://<domain>`. Renewal charged first, then Websupport renews;
Pro ended → website back, auth code shown and e-mailed; **never hold a domain back**. `proxy.ts`: a host that is not
PPI's own → `shop_for_host` → rewrite to `/site/[lang]/[slug]` (own root layout: no Cacaduu header, `SiteLanguageSwitch` +
the shop's small header logo as a link home (update 31); + items, `/api/site/[slug]/sitemap|robots`), www →
bare; canonical = the own domain; payment never affects search ranking. `PlanDetails`/`DomainStatus` labels from the
`domains` i18n namespace; admin texts `admin_domains`.

## Own domains easy to find (Pro, updates 33 and 36)

`supabase/sql/33_domain_findable.sql` + `supabase/sql/36_domain_findability.sql` (Prompt 12). "Aby vás našli Google a AI
asistenti" on `dashboard/plan` (`FindableSection`, live orders only; hidden before update 33). **"Overiť v Google Search
Console"** → domains action `google_verify` (owner, live; only `google-site-verification=<token>`): on a zone we run
(`registrar_service_id`) it **only adds** one TXT `@` through `registrar.addRecord`, keeps its id
(`google_txt_record_id`), never twice; the same value already there → `present`, nothing added; ≤ 5 Google values.
**"Odstrániť"** = action `google_remove`: deletes **only the record Cacaduu added** (stored id **and** still the stored
value); never SPF/MX/DKIM/DMARC, a `present` or `manual` record or any other. A connected domain: a) **"HTML značka"
(recommended)** — `owner_set_site_verification()` (owner, live, format checked) into `domain_site_verifications`; the
own domain's root layout adds `<meta name="google-site-verification">` / `<meta name="msvalidate.01">` (Bing) only on
that domain (`site_verification_meta()` + `verificationMetadata()`); b) the TXT record to add by hand (`recordName()` =
`manualRecordName()`, copy buttons). Bing Webmaster Tools: the same meta tag or the import from Search Console; sitemap
steps for Google and Bing. Per own domain (`src/proxy.ts` → `/api/site/[slug]/robots|llms|indexnow/[key]`, only while
`shop_site()`): robots.txt from `@/lib/siteFiles` (`AI_BOTS` shared with `app/robots.ts`; never `/api/`, `/auth/`, login
pages; the Sitemap line), llms.txt (English, the shop's data as written, `shop_llms_facts()`: the owner's "Kategórie
tovaru" `shops.product_categories` only through `owner_set_categories()` — never invented —, the stock file's brands,
the items' categories, whether holidays apply; the page's own stock words; Cacaduu's MCP/API with the slug). **IndexNow
(update 36):** one key **`INDEXNOW_KEY`** (public; Vercel + Supabase secret), every host serves `/<key>.txt` (main host:
`/api/indexnow/[key]`). stock-pull after `updated`, in the background, `pingIndexNow()` → `indexnow_claim_host()` (the
shop's live own domain, else the main host from `SITE_URL`; **at most once per upload and once an hour per host**; only
items whose `inventory.indexnow_at` — trigger: new, price/currency, in stock ↔ sold out; never 12 → 11 — is after the
host's cursor) → one POST to api.indexnow.org (`{host, key, keyLocation, urlList}`, each item in sk/hu/en, ≤ 10 000,
canonical URLs only) → `indexnow_done()` (logged in `indexnow_pings`; only a 2xx moves on, so failures go with the next
ping); never log the key, never delay or undo the stock. Item pages: `@/lib/jsonLd` `itemJsonLd` (`@graph`: Product +
Offer — price whenever the page shows one, `availability` only when not stale — + the shop's Store, `storeJsonLd`
shared with the shop page), canonical + hreflang (+ `x-default`) on the own domain. Main search rows, map pins, AI cards,
other offers, the API/MCP `source_url` (`canonicalItemUrl()` / `canonicalShopUrl()`) and PPI's llms.txt link a shop
with a live own domain there (`loadLiveSites()` / `getLiveSites()` → `shopHref()` / `itemHref()` in `@/lib/customDomain`);
PPI's sitemap leaves those pages out.

## Shop page and My shop (migration 21, update 26)

- Product pages of shops with the plan or a domain of their own (being set up or live) show no other shops: no "Also
  available at" block or "not found elsewhere" text, no other pins, nothing in the JSON-LD (the item page skips
  `getOtherOffers`). Only SQL decides: `shop_stands_alone(shop)` (`shopStandsAlone()`; before update 26 it falls back
  to `shop_has_plan`). Free shops and the main search keep it. The shop assistant never names other shops.
- Shop e-mail and Facebook page (`shops.email`, `facebook_url`; validated in `owner_save_shop()` and by checks:
  facebook.com / fb.com only) as contact buttons on the shop page (update 51, below: mailto; Facebook in a
  new tab, `noopener`), in the JSON-LD (`email`, `sameAs`) and in the API's shop.
- Booking link, every shop (`supabase/sql/26_booking_link.sql`, `shops.booking_url`: https of a real host, ≤ 500;
  `clean_contact('booking', …)` in `owner_save_shop()`, error `booking`; kept when the form does not send it): the shop
  page's "Rezervovať termín" contact button (update 51, new tab, `noopener`), JSON-LD `potentialAction` `ReserveAction`, the API/MCP shop (`booking_url`), llms.txt, and one line
  in the shop assistant's prompt (points to that link; never promises a time). PPI only links; nothing is booked here.
  Reads of `public_shops` fall back without `booking_url` on 42703 (`@/lib/missingColumn`).
- Assistant button label (≤ 40) and welcome text (≤ 300), paid plan: `owner_set_assistant_texts()`; the database keeps
  plain text only (`plain_text()`: no HTML, links or e-mail addresses); empty = NULL = the i18n default (`chat.title`,
  `chat.intro`) in the page language; shown as written (`ShopChat` `buttonLabel` / `welcome`). **Update 46
  (`supabase/sql/46_assistant_texts.sql`):** both are a preset of every translation run (`preset_translation_kind()`):
  kept in every pre-translated language (`languages.indexed`), the shop's preferred and asked-for languages **and the
  shop's own language** (the owner may write them in any language; source_lang `auto` → the translate function lets
  Claude see the language); the page shows them like its own texts (`PRESET_KINDS` in `@/lib/contentTranslations`, no
  "Preložené automaticky" note). The small print (what is stored for the shop + "Viac", file limits, "Odpovede píše
  AI") sits behind the blue "GDPR" link in the assistant heading's right corner (`@/components/AssistantHeading`,
  `<details>`, closed by default).
- The shop's company in Môj obchod's details (update 47, `supabase/sql/47_shop_company.sql`, at the owner's request):
  under the street the PSČ, then "Obchodné meno firmy", IČO (`shops.ico`, as before) and DIČ — no IČ DPH. PSČ, company
  name and DIČ live in `shop_company` (RLS: members read; no grants to visitors — anon reads every column of `shops`, so
  never put owner-only data there), written only by `owner_save_company()` (plain text, empty clears, bad DIČ/PSČ →
  `dic`/`zip`), read through `my_shops()`. **Shown on the shop page since update 48** (`supabase/sql/48_shop_company_public.sql`,
  at the owner's request): visitors read only `shop_company_details(slug)` (active shops; company name, IČO, DIČ, PSČ;
  never the table) → `shopCompany()`; the address line "Ulica, PSČ Mesto" and under it "Firma · IČO … · DIČ …"
  (`data-shop-company`, Cacaduu address and own domain); JSON-LD `postalCode`, `legalName`, `taxID` (DIČ). Not in the
  API/MCP or the assistant.
- Môj obchod is five pages (menu: Môj obchod · Obsah stránky · Novinky / Blog · Asistent · Kontakty (update 56) · Priečinok s exportom ·
  Predplatné a doména · Heslo; the menu keeps `?shop=`): `/dashboard` (details, logo, header logo, plan,
  delete), `/dashboard/content` "Obsah stránky" (update 38, below), `/dashboard/blog`, `/dashboard/assistant`
  "Asistent" (update 38: **three sections, each once, in this order** — since update 55 **three tabs** — "Nastavenia
  asistenta", "Konverzácie asistenta" with the cloud folder as its part `#cloud`, "Súkromné priečinky" = `ShopDocuments` (documents, folders, access keys,
  "Len zobraziť" / "Zobraziť a stiahnuť"); "Posledné nahrané súbory" = `@/components/RecentImports` moved to `/sync` in
  update 43; a free shop sees
  `ProOnly` "Dostupné v Pro" where it has nothing yet, what it has stays reachable) and `/sync` "Priečinok s exportom"
  (export folder + `FolderSync`, update 45's "Po nahratí súboru" and "Preklady v priečinku", "Posledné nahrané súbory",
  conversations to the PC, "Nebezpečná zóna – sklad"). **Which page holds a section: only `@/lib/dashboardPages`**
  (`sectionUrl(lang, at, query)` for every form's way back; `movedFrom()` / `forwardUrl()` forward old addresses with
  their query, old names merged: `private` → `docs`, `sections` → `content`; `/dashboard/sections/[id]` → the library).
  Never put a section on two pages. Shared messages/switcher/form parts: `dashboard/shared.tsx`. Sections are
  `@/components/DashboardSection` dropdowns (heading + summary line; phone: only the first open; remembered per device
  in `localStorage` `ppi.dashboard.open`; `?at=`/`#` opens one). `RecentImports`: the last 10 `stock_imports` rows as
  cards; a tap opens the quick view (a `<dialog>` slideshow of the full reports, "Súbor n z 10", Novší/Starší, ← → keys,
  swipe, Esc).

## Contact buttons on the shop page (update 51)

`supabase/sql/51_contact_buttons.sql` + `@/lib/contactButtons` (order, colours, links, widths; `contactButtons_test.ts`
in `npm run test:site`) + `@/components/ContactButtons` / `CheckLoop` + `.ppi-cb*` in globals.css. Under the amenities
("Bidetová sprška" — the column stays `has_douchette`), two columns (gap 12 px): Facebook · Rezervovať termín / Web ·
e-mail / Navigovať · phone; an empty link or value hides its button. **Press and hold 1.2 s** (since Screen 11 real
links via `HoldLink`; Enter / Space open at once): a tap only shows "Držte stlačené", early release / sliding off /
blur cancels; done → the action (new tab,
`mailto:`, `tel:`; **a finger hold loads the link in the same tab at completion** — a new tab is a pop-up that phones allow only inside a gesture, and a long press has none; touchstart is `preventDefault`ed, so no phone long-press menu; `pageshow` from the back-forward cache resets the button), "Otvorené"-style label with the
check, back after 2.3 s, announced in an `aria-live` region; `prefers-reduced-motion` respected; `touch-action: none`,
`-webkit-touch-callout: none`, no selection, no shadows; labels never cut or wrapped (12.5 px when too wide).
Navigovať = Google Maps directions to the shop's lat,lng, else to its written address. Short / long per button: only
`owner_set_contact_buttons()` (Môj obchod "Údaje obchodu", "Krátke / Dlhé" next to each field; defaults e-mail long,
the rest short; `shops.contact_buttons` keeps only differences), read by `shop_contact_buttons(slug)` (cached, refreshed
on save). Page layout, never shop data. `<noscript>` shows plain links. e2e `e2e/contacts.spec.ts`. Texts
`contact_buttons`.

## Shop status and Pro page layout (update 27)

`supabase/sql/27_shop_status.sql`. **One function decides the status**: `shopStatus()` in `@/lib/hours` (open / break /
closed / holiday / no hours, text and next change, in the shop's time zone; past-midnight ranges; a gap under 3 h between two
ranges of a day = break). Every place uses it: shop page (map pin, status line, `@/components/ShopStatus` `LiveStatus`
refreshed every minute in the browser), search map + result list, item page, API/MCP (`status` {state, text, label,
next_change} on every shop), JSON-LD `specialOpeningHoursSpecification`. Input = `opening_hours` + `shop_calendar()`
(`@/lib/shopCalendar`; before update 27 it is empty and the regular hours apply). Special day (`shop_special_hours`,
`owner_save_special_hours()` / `owner_delete_special_hours()`; "Vaše mimoriadne dni" has ticks + `@/components/BulkSelectBar`
→ `deleteSpecialDays`, the same function per day) wins over a holiday, a holiday over the regular hours.
`public_holidays` (SK, HU, CZ; rows from `scripts/holidays.mjs` with date-holidays, `source` library|admin, admin wins,
`admin_save_holiday()` on the admin page); `kind` day_off (yellow all day: "Štátny sviatok – overte otváracie hodiny")
or shops_closed (closed by law, red "Zatvorené – štátny sviatok"; `closed_from` e.g. 24.12 12:00); `shops.auto_holidays` (`owner_set_auto_holidays()`, default on)
— off = regular hours every day. Shop page order: name + logo with the details right under it, map, opening hours (today
highlighted, status line, special days next 14 days), assistant (always open, own scroll), "Mám prístupový kľúč" (collapsed), items. On an own domain
the page is under `src/app/site/[lang]/[slug]/` with its own root layout (no Cacaduu header; the shop's small logo as a
link home + SK · HU · EN, update 31; the name and logo on the page itself, above the details). These are shop profile
data, never stock.

## Page sections from PDFs or pictures and the own domain's header logo (update 28; every shop since 30; 31)

**Since update 38 the sections are the files of "Obsah stránky" (below): the positions, `shop_sections()`, the
section blocks, `PageSectionsPanel`, `SectionOrder`, `PageSections`, `SectionSlider`, `sectionLimits` and the preview
page are gone; the upload pipeline, cleaning, buckets, sync and download below still apply.**
`supabase/sql/28_pdf_sections.sql` + `supabase/functions/page-sections` (one file, Verify JWT off) + shop-files
`section_pdf` + `sectionActions.ts` + `@/components/SectionUploader`, `SectionZoom` + `@/lib/sections`. ≤ 10 sections per shop; PDF only, ≤ 10 MB, ≤ 20 pages,
encrypted refused. The owner's browser draws every page (pdf.js `sectionPage()`: 800 and 1600 px wide, WebP 0.8, JPEG
fallback) and reads its text; the function checks the real type, **cleans with pdf-lib** (JavaScript, open/automatic
actions, Launch and other unsafe actions, links to programs, embedded/attached files, media, XFA, unreachable objects;
refused if anything is left) and stores **only the cleaned file** (private `shop-sections`); page pictures checked by
their bytes (WebP/JPEG, exact width, ≤ 5 MB); text as written (never translated or corrected; pages without text →
`AI_MODEL`). **Visibility is decided only in SQL**: `section_visible()` (published, not hidden, inside its dates in the
shop's day, `shop_has_plan`) and `section_shown()` (+ pictures public) for the page (`shop_sections()`), the assistant
(`search_shop_docs` / `shop_docs_list`, source = the title) and the download (`shop_section_pdf` → shop-files, 10-minute
signed URL, only with `allow_download`). Page pictures are in the public bucket `shop-sections-public` **only while
shown** (`sections_to_sync()`; the function's `sync` after owner actions + hourly job `ppi-sections-hourly`); previews,
hidden, expired, not-yet-visible and plan-ended sections stay private (the owner's preview: 10-minute signed URLs). Pro
ended → hidden, never deleted. Visitors: four positions (after_details, after_map, before_items, end), `<details>` or an
open block, `<img srcset 800w/1600w>` straight from storage (never image optimisation, never the raw PDF), ≤ 760 px,
12 px gap, page counter, `SectionZoom`, the text in the HTML under "Zobraziť text". Deleting removes every file in both
buckets first; `owner_delete_shop` refuses while sections exist. Lighthouse mobile within 5 points with and without
sections. **Own-domain header (update 31, `supabase/sql/31_site_logo_pictures.sql`), as before update 28:** a small
logo at the top left as a link home + SK · HU · EN on the right (`src/app/site/[lang]/[slug]/layout.tsx`): the header
logo `shops.site_logo_*` only through `owner_set_site_logo()` (plan or own domain; `site-logo-<ms>.webp|png` in the
shop's `logos` folder; made ≤ 120 px high / 600 px wide in the browser by `@/components/SiteLogoInput`, checked with
sharp in `uploadSiteLogo`; dashboard "Logo v hlavičke webu" = `SiteLogoPanel`, with the hint which pictures are fine),
read by `shop_site_logo()`; without it the shop's logo, without that the name. **"Odkaz loga" (update 32,
`supabase/sql/32_site_logo_link.sql`):** `shops.site_logo_link` (https of a real host, ≤ 500; NULL = the home page) only
through `owner_set_site_logo_link()` (same plan rule; going home is always allowed), returned by `shop_site_logo()`
(`link`); the header logo (or the name) is then a plain `<a rel="noopener">` in the same window; `SiteLogoPanel` field +
`saveSiteLogoLink` / `resetSiteLogoLink`. The header picture of update 28
(`shops.header_*`) is no longer shown or offered. Sections: position `after_hours` ("Za otváracími hodinami", between
the hours and the assistant; a free shop's sections sit there); **pictures are fine** — `source` pdf|pictures, one
picture (JPG/PNG/WebP) = one page, drawn 800/1600 px in the browser (`picturePage()`), no original and no PDF kept,
the AI writes out their text, the function's `pictures` action within the plan's limits, "Stiahnuť PDF" only for a PDF.
"Zobrazenie strán" (update 29, `supabase/sql/29_section_slider.sql`, `page_layout` slider|stacked, default slider; only
through `owner_save_section(…, p_page_layout)`): slider = `@/components/SectionSlider` (scroll-snap, ‹ › with labels,
← →, "n / m" + dots, one box height = tallest page, ≤ 80vh; only the current page ± 1 gets an `<img>`, `<noscript>` for
the rest); Pod sebou = one under another, 12 px, lazy; one page = just the page; `SectionZoom` = full-screen viewer
(pinch / wheel / + − zoom, swipe, ← →, Esc) for both; "Stiahnuť PDF" a button.
**Free shops too (update 30, `supabase/sql/30_free_sections.sql`):** limits per plan are the admin's settings, never in
the code: `section_limits` (free / pro: sections, pages, MB; defaults 1/5/10 and 10/20/10; only
`admin_save_section_limits()`, admin page "Limity sekcií (PDF)") → `section_limits_for(shop)`, `owner_section_limits()`,
`owner_section` (the function's `limitsOf()`, caps 50 pages / 20 MB). Visible = published, not hidden, in its dates and
among the plan's first N in the owner's order (`section_visible()`; Pro → free keeps all, shows the first). Free:
no position choice, `shop_sections()` gives `before_items` (= right after the opening hours on a free page); at the
number "Pre viac sekcií prejdite na Pro" (no error); the assistant only with the plan (`section_for_assistant()`).
Owner actions sync the whole shop's pictures (`sections_to_sync(p_section_id, p_shop_id)`).

## Shop blog "Novinky" and the Facebook Page (update 37)

`supabase/sql/37_shop_blog.sql` + `supabase/functions/shop-blog` (one file, Verify JWT off) + `@/lib/blog` /
`@/lib/blogFormat` (shared with the tests) / `@/lib/blogFeed` / `@/lib/blogPhotos` + pages
`shops/[slug]/blog` (+ `[post]`, `rss.xml`) and `site/[lang]/[slug]/blog` + dashboard `dashboard/blog` ("Novinky / Blog",
its own menu page; `[id]` = `@/components/BlogEditor` + `PublishDialog`) + admin `BlogAdmin.tsx`. Every shop; shop
profile content, never stock. **Posts are shown exactly as written** (never edited, corrected or translated; the
owner may only retitle an imported post, `title_by_owner`). **One visibility rule in SQL**: `blog_visible_posts()`
(published, its time came, active shop, the newest `blog_limits.max_posts` — free 10, Pro null = all; admin only via
`admin_save_blog_limits()`); visitors read only `shop_blog` / `shop_blog_post` / `shop_blog_count` / `blog_index` /
`search_shop_blog`; owners write only through `owner_blog_*`; the function (service role) imports, stores photos and
publishes. Pages are server components with canonical on the live own domain, hreflang + x-default, OG `article`,
JSON-LD `BlogPosting` (shop = `LocalBusiness` author/publisher) + `BreadcrumbList`, RSS `…/blog/rss.xml` (own domain:
`/blog/rss.xml` → `api/site/[slug]/blog-rss`), sitemaps, llms.txt "Latest news" (5), IndexNow (`blog_indexnow_claim`,
shares `indexnow_hosts`); "Novinky" link on the shop page only with ≥ 1 visible post; the Pro assistant's
`search_shop_news`. Photos: owners' drawn in the browser (`drawBlogPhoto`: 1600 + 800 px WebP 0.82 / JPEG, never
enlarged), Facebook's converted in the function (jsquash WASM, one size per call, only from Facebook's picture hosts);
public bucket `blog-photos`, random names, no policies; `@/components/BlogPhoto` = next/image with its own loader (≤ 800
→ the 800 file), never image optimisation; the viewer is `SectionZoom`. **Facebook** (only with `FACEBOOK_APP_ID` +
`FACEBOOK_APP_SECRET`; else `config` → false and every Facebook button, panel and dialog is hidden, no errors):
Facebook Login for Business (`FACEBOOK_CONFIG_ID` or the scopes `pages_show_list`, `pages_read_engagement`,
`pages_manage_posts`; nothing more), redirect `…/functions/v1/shop-blog/oauth`, one Page per shop, the Page token
**only encrypted** (AES-GCM, `FB_TOKEN_ENCRYPTION_KEY`, bound to shop + Page; owners have no column grant; never logged;
"Odpojiť" deletes it), every call with `appsecret_proof`, Graph `v23.0`. Import ("Stiahnuť všetky príspevky", 25 per
call, chained) + daily sync (pg_cron `ppi-blog-tick` every 5 min; new, edited, deleted → hidden) + signed webhook
(`X-Hub-Signature-256`, verify token from the admin page) → `blog_import_post` (own/same/updated/new, `fb_post_id`
unique: never twice; auto-publish or "Schvaľovať pred zverejnením" → pending); title = first sentence ≤ 70 at a word.
**Never ask for or store comments, reactions, likes or other people's names** (`POST_FIELDS`). Publishing: the dialog
before every "Zverejniť"/"Naplánovať" (connected / not connected / expired; last choice pre-selected; Esc = back;
results "Zverejnené na webe ✓" / "Zverejnené na Facebooku ✓" / error + "Skúsiť znova na Facebook"); as the Page: text +
≤ 10 photos + "Čítať na webe: <canonical address>"; `blog_fb_claim` never sends twice; an edit changes only the web.
Expired token → banner + dialog + one Brevo e-mail (`facebook_alerts_due`). **No Facebook SDK, pixel, plugin or embedded
widget on any public page.** Privacy draft `/[lang]/sukromie` + `/[lang]/sukromie/vymazanie-udajov` (the Meta app's
URLs; TODO lines). Texts `blog`, `owner_blog`, `admin_blog`, `privacy`.

## "Obsah stránky": one slider of posts, PDFs and pictures (update 38)

**Its look changed on 2026-10-31 (Screen 11, above):** no title, arrows, counter or caption under the frame — the
text sits on the picture, pills choose the slide, "Čítať" opens the post inline. The rules below still apply.

`supabase/sql/38_page_content.sql` + `@/lib/pageContent` (shared rules, also the browser and `content_test.ts`) +
`@/lib/sections` (`getShopContent()`, `slideViews()`) + `@/components/ContentSlider` (visitors and the live preview) +
`@/components/ContentEditor` + `@/components/SectionUploader` + page `dashboard/content` ("Obsah stránky": the slider
and the "Knižnica súborov"). **One slider per shop page**, after the opening hours and before the assistant (a free page:
before "Tovar v obchode"), on the Cacaduu address and the own domain; no other sections, no separate "Novinky" preview
(the details' "Novinky" link only when the slider has no "Všetky novinky"). Settings `shop_page_content` (title ≤ 80 as
written, NULL = "Novinky a ponuky" from i18n; `show_title`; `display` open|collapsed); slots `shop_content_slots`
(position, kind auto_post|pinned_post|pdf|picture, `item_id` / `post_id`; RLS: members read; written only by
`owner_save_content()`); the library = `shop_page_sections` with `kind` pdf|picture. **Only SQL decides what visitors
see:** `content_slots_shown()` (a shop never arranged gets virtual slots: its old visible sections, then 3 automatic),
`section_item_ready()` (uploaded, not hidden, inside its dates), `section_visible()` = in a shown slot, `shop_content()`
(the only public read; automatic slots = the newest visible posts not pinned in a shown slot, fewer posts → fewer
slides, never an empty one; hidden/expired/deleted files drop out, the rest keep their order). `arrangeSlides()` is the
same rule for the editor's preview only. Limits are the admin's (`section_limits.max_slides` / `max_pdf_slides` /
`max_items`, defaults free 5/1/10, Pro 10/10/30, hard cap 10 slides; `admin_save_content_limits()`; admin "Limity
obsahu stránky"); a shop back on free keeps every slot and shows the first within the free numbers. Uploads: PDF as
before (≤ plan's pages/MB, real type, cleaned, encrypted refused with a clear message) + **pictures** (JPG/PNG/WebP/
HEIC/HEIF; HEIC via `heic-to`, loaded only in Môj obchod): drawn in the owner's browser (`preparePicture()` in
`@/lib/pdfRead`: upright from EXIF, every EXIF/GPS gone, < 600 px wide refused "Nahrajte aspoň 800 px na šírku", > 4000
made smaller, never enlarged, cropped or stretched, PNG transparency kept in WebP), the original kept privately
(`original_path`, the function's `original` action) for "Stiahnuť", 800/1600 WebP pages; optional alt text, else the AI
writes `alt_ai` (never invents). Slides: post card (photo, date, title, two lines, "Čítať"); PDF = first page + title +
page count, a tap opens `SectionZoom` ("Slider" page by page or "Pod sebou" all pages, per PDF); picture = zoom,
optional title, optional "Stiahnuť". Swipe, ‹ › and ← →, "3 / 10" + dots, only the current and next slide get an
`<img>` (`<noscript>` for the rest), `prefers-reduced-motion` = no smooth scroll. **Fixed frame (update 44,
`supabase/sql/44_slider_ratio.sql`):** every slide has the same frame — "Pomer strán slidera" `shop_page_content.slider_ratio`
4:5 (default, NULL) / 1:1 / 16:9, only through `owner_save_content(…, p_ratio)` (null keeps it) — as wide as the slider,
≤ 80vh high (`frameStyle()`); the picture **fills it** (`object-fit: cover`, never stretched) with the slot's "Výrez"
`shop_content_slots.crop` top / center (default, NULL) / bottom (pdf/picture slots only); the uncropped picture only in
`SectionZoom`. The slider never changes height: a fixed caption (title 2 lines + "…", meta line = date or "5 strán",
one action slot bottom-left "Čítať" / "Stiahnuť PDF" / "Stiahnuť", empty places keep their space), arrows centred on the
frame (hidden at the ends, place kept), ▶ centred, counter (tabular, fixed width) + dots on one row, "Všetky novinky" in
the title row; a post without a photo = a grey frame with its title. No visible "Zobraziť text": the text is the
slide's `aria-describedby` (sr-only) and the viewer's. Editor previews (always stacked): the phone (390 px) first, the
computer (the page's 768 px column) under it, both scaled with a CSS transform to the column, never cut or scrolled
sideways; the upload hint names the ratio's size (`ratioSize()`).
Downloads only `/api/shops/[slug]/sections/[id]/download` → shop-files (10-minute signed URL, only when allowed; the
old `/pdf` address re-exports it). Texts `content` (sk/hu/en). Tests: `npm run test:content`.

## Videos in the blog and the slider (update 39)

`supabase/sql/39_video_posts.sql` + `@/lib/video` (shared: `youtubeId()`, `videoHref()`, `videoSlide()`) +
`@/components/YouTubePlay` + shop-blog (`youtubeId`, `youtubeMedia`, `youtubePictures`). A Facebook video or reel stays
on Facebook (its picture + link, never downloaded); a **YouTube video shared on the Page** keeps its link card and also
becomes a `blog_photos` row of kind `video` with YouTube's picture (`i.ytimg.com` only, maxresdefault else hqdefault;
posts imported before got it from `blog_youtube_backfill()`). **Never embed Facebook's player** (no Facebook script on
public pages): a Facebook video opens on Facebook. A YouTube video plays on the blog post **only after a tap**
(`YouTubePlay`: the stored picture + ▶, then the youtube-nocookie player; without JavaScript a link to YouTube; nothing
from YouTube loads before the tap; the privacy page says so); its link card is not repeated. `blog_post_video(post)`
(kind youtube|facebook, youtube_id, link, the post's `facebook_url`) goes with every post in `shop_content()` /
`owner_content()`. The slider's video cards get a ▶ (black and white, `PlayMark`) that leads where the owner chose in
"Tlačidlo ▶ pri videách otvorí" (`shop_page_content.video_target`, only through `owner_save_content(…, p_video_target)`;
null keeps it): `post` (default) = the article at `#video`; `facebook` = the post on Facebook in a new tab (a phone with
the Facebook app opens it there), falling back to the article for a post that is not on Facebook. The title and "Čítať"
always lead to the article. The blog list shows ▶ on video posts. Tests: `npm run test:content`, `test:functions`.

## Every language (update 40)

`supabase/sql/40_translations.sql` + `supabase/functions/translate` (one file, Verify JWT off) + `@/i18n/languages`
(42 languages: the 25 EU ones, nb is sr sr-cyrl bs sq mk tr ru ca eu gl cy lb, zh-hans zh-hant vi; codes are URL
prefixes and Intl tags) + `@/i18n/dictionaries` + `@/lib/shopLanguages` + `@/lib/contentTranslations` +
`@/components/LanguagePicker` / `TranslationNote` / `TranslationsTable` / `LanguageFileUpload`.
- **Which languages:** only `site_languages()` (admin "Preklady": on/off, "preložený vopred"; sk always on; ru and the
  regional ones and zh-hant off by default). A switched-off language is a 404. Every page's `/[lang]` is any switched-on
  code; sk/hu/en are built, the rest on first request.
- **Interface texts:** sk/hu/en by hand in the repository; every other language in `ui_translations` (Claude via the
  admin's "Preložiť chýbajúce texty" → translate `ui`, ≤ 150 per call; the admin edits = `manual`, marks checked).
  `getDictionary()` layers SK ← EN ← own file ← database, so a missing text shows English, then Slovak, **never a key
  name**. Legal pages show "Strojový preklad – záväzná je slovenská verzia" until every legal key is checked.
- **Picker** (replaces SK·HU·EN on PPI and on own domains): "Odporúčané" (the shop's preferred languages on its own
  domain; SK HU EN CS UK PL DE on PPI), "Všetky jazyky" (own names, alphabetical, search knows English/Slovak/Hungarian
  names), "Ďalšie jazyky" (Chinese, Vietnamese); a dialog (Esc, ↑↓), a bottom sheet on phones. The choice = functional
  cookie `ppi_lang`. First visit: PPI → the browser's first switched-on language, else Slovak (`fromAcceptLanguage`);
  own domain → "/" = the shop's home language (`shop_home_lang()`: "Predvolený jazyk na vlastnej doméne", else its main
  language, else its country's). **No location ever.**
- **Fonts:** Quicksand (latin, latin-ext, vietnamese) + Noto Sans only for Cyrillic/Greek (`notoFallback`, not
  preloaded); Chinese uses the system's fonts (no CJK web font), `line-break: strict`.
- **Shop content** (`content_translations`; the original is NEVER changed): kinds item_name / item_description /
  item_category / assistant_label / assistant_welcome / special_note / content_title / section_title / section_alt /
  blog_title / blog_body; status `shop` (from the shop's file, "Od obchodu"), `ai`, `manual` ("Upravené ručne"), `none`
  ("Neprekladať"); `source_hash` = md5 of the original: a changed original makes an AI text "Zastaraný" and the job
  makes it again; shop and manual ones are never overwritten (Claude only suggests). Visitors read only
  `shop_translations()` (shown things only, never a stale text); item names also as `shop_items.name_i18n` (kept by a
  trigger; the search index covers every language). Pre-translated = the shop's main + preferred languages (plan limit
  `translation_limits`: free 2, Pro 6) + item names in sk/hu/en; any other language → `request_translation()` (anon,
  once in 10 min) → the function translates while the page shows the original + "Prekladáme…". Machine texts show
  "Preložené automaticky · Zobraziť originál" (`?original=1`) — not on the product page (removed at the owner's request,
  2026-10-27; one framed box holds the names and the data with bullet points: price with the stock dot, Dostupnosť, Značka, EAN,
  Kategória, then Popis). Never translated: brands, codes, EAN, prices,
  quantities, units, URLs, e-mails, phones, colour codes, `{placeholders}`.
- **SEO:** hreflang/sitemaps only for pre-translated languages (PPI: admin's "preložený vopred"; a shop: its indexed
  languages — shop/item/blog pages set `robots` themselves); others `noindex`.
- **Descriptions** (`item_descriptions`): "Návrh popisu" by Claude **only from the shop's own data**
  (`item_description_facts()`: name, brand, EAN, category, the shop's own description), never invented; the owner edits
  → "Uložiť a zverejniť" / "Zahodiť"; "Zverejniť vygenerované popisy automaticky" (default off); the shop's own
  description wins unless the owner picks "Popis (Cacaduu)" (`item_description_shown()`).
- **Owner screens:** Môj obchod → "Jazyky a inventár" (`/dashboard/translations`: Tovar, Texty stránky — "Preklady"
  until update 62, see below; since update 45 the
  languages, the stock file's columns and the stock files in other languages are on `/sync` — see below —, old `?at=`
  forwarded;
  **"Tovar" since update 41** (`supabase/sql/41_items_list.sql`, `@/lib/ownerItems`): one short line + "Viac", the
  status line "Posledný súbor: … · aktuálny / starší / zastaraný" (`shops.freshness_state`), filters Všetko / Na sklade /
  Vypredané / Bez popisu / Chýba preklad decided only in SQL (`owner_items(…, p_filter)`, `owner_item_counts()`; stock
  filters by the file's quantity, "Chýba preklad" = a name or shown description without a current translation in
  a preferred language since update 62 (`shop_target_langs()` before), stale AI = missing, "Neprekladať" = not), one link per product "Popis a preklady" (no
  correction dropdown — every correction on the product's "Preklady" tab), column "Čo vidí zákazník" = the database's
  label as the shopper reads it, or "Skryté – údaje sú staršie ako 24 h · Nahrať nový súbor" when stale, never "–"; with filters, ticks, progress bar, "Späť" 30 s) and a product's page `/dashboard/items/[id]`
  (tabs Popis, Preklady; Zmazať asks "preložiť znova pri ďalšej návšteve" or "neprekladať"; "Preložiť znova" shows old
  and new side by side). Every write through `owner_*` SQL; Claude only through the translate function with the
  owner's login.
- **Two-language stock files:** option A = a language per text column in the mapping (`name@hu`, proposed from the
  column names, approved by the owner); option B = a second file per language (`stock-pull?translation_lang=hu`),
  matched by Kód then EAN (`apply_shop_translations()`); quantity and price only from the main file (differences
  listed, ignored). Encodings: BOM, UTF-8, GB18030/GBK, Windows-1258, Windows-1250 (detected; the owner sees a
  preview `?preview=1` and may pick another, remembered in `sync_sources.file_encoding`). Private columns never read.
- **Search:** every translation is searchable; a search with no hit (or in Chinese) is also run with Claude's words
  for it (`query_expansion()`, cached 30 days) — website, API, MCP and the AI search (any language code).
- **Cost:** every AI call checks `translation_budget_ok(TRANSLATION_MONTHLY_BUDGET_EUR)` and adds its cost
  (`translation_spend`); one e-mail to `ADMIN_ALERT_EMAIL` at 80 %; batches of ≤ 60 texts; job every 5 min
  (`ppi-translate-tick`, Vault `ppi_translate_cron`). E-mails: the signup language is kept (`profiles.language`,
  Supabase templates read `{{ .Data.lang }}`).

## Tovar and Texty stránky (update 62)

`supabase/sql/62_items_page_texts.sql` + `@/components/ItemsBulk` + `@/lib/exportClient` + `@/components/PageTextsTable` +
`@/components/SelectSubmit`. **One place per thing** on "Jazyky a inventár": **Tovar** = the products and every
translation of them, **Texty stránky** (`texts`, was `translations` → forwarded) = the page's other texts; a product's
text never appears in Texty stránky. Per product "Preklady: X z Y jazykov" — **Y = `shop_preferred_langs()`**, done =
the name's own language or a non-stale name translation (+ the shown description's), "Neprekladať" done, stale AI
missing — and "Chýba preklad" / the "Jazyk" dropdown (`?tr=`) are decided only in SQL (`owner_items` / `owner_item_counts`
with `p_lang`). Tools: "Vygenerovať popisy (max. 20)" (ticked, else 20 without a description; translate `describe`),
ticks + bulk "Preložiť chýbajúce" / "Preložiť znova" (AI texts only) / "Zmazať preklady" (again / "Neprekladať"; update
40's delete/restore in parts of 1 000, "Späť" 30 s, progress bar) through `owner_item_translation_cells()` and the
translate function's `run` with `item_ids` (`translation_work_items()`). "Stiahnuť preklady" / "Nahrať opravené
preklady" **reuse update 45's files and reader** (`@/lib/exportClient`, the same code as `TranslationFolderSync`; never a
second exporter): files narrowed to the ticked or filtered products (`owner_item_ids()`), languages = preferred by
default, every change previewed (before → after) before `applyExportEdits`; only Názov / Popis / Kategória are read.
Texty stránky: `owner_page_texts()` — one row per original with `cells` per language, filters Jazyk / Čo
(`page_text_group()`) / Stav / words, the same actions; the assistant's texts also in the shop's own language.
Clean-up `page_text_cleanup(false|true)` (SQL Editor only; log `page_text_cleanup_log`): orphaned page-text
translations, the old label "Keresés Cacadoo Assistenssel", Cacadoo → Cacaduu in the assistant's texts — never a
product's translation, never a hidden section's. Texts `items_bulk`, `owner_tr.texts*`.

## Speed (performance pass, update 42)

`supabase/sql/42_performance.sql` + `PERFORMANCE.md` (targets, budget, how to measure). **Public reads go through
`createCachedPublicClient()`** (`@/lib/supabase/public`: only the `CACHED_RPCS` allowlist and GET `/rest/v1/` reads,
60 s, tags `public` + `shop:<slug>` or `cross`); everything else (owner, admin, rate limits, AI) stays uncached.
**Every change a visitor can see refreshes them** (`@/lib/publicCache`: `refreshShop(slug)` in each owner action's
`back()` when `ok`, `refreshAll()` for translations, blog posts and admin settings; stock-pull POSTs
`/api/revalidate` with `REVALIDATE_SECRET` after `updated` and after the translations). Search names: the stored
column `shop_items.names_search` (= `item_names_text()`) with its trigram index and `search_patterns()` (`LIKE ALL`,
same words as `matches_all_words`); hot functions `set jit = off`. Lazy on public pages: the map (`ShopMap` box →
`ShopMapCanvas` near the screen after the visitor's first scroll/touch/key, at once on a tap or `opened`), the shop assistant (`ShopAssistant` = the same first
view, `ShopChat` loads near the screen or on touch; the typed text, focus and the key dropdown go along), the language
list (`LanguagePickerDialog`), the picture viewer (`SectionZoomViewer`), Vercel Speed Insights/Analytics
(`VercelMetrics`, only on Vercel). One Quicksand declaration only (a second one loads the font twice). Môj obchod
sections open before the first paint (`DashboardSection`'s inline script); no `loading.tsx` there (it turns the pages'
`redirect()` into a client redirect) — the tapped menu link shows `useLinkStatus`. Taps: `TapFeedback` (server-action
forms: busy at once, never sent twice), pressed states and 44 px touch areas in `globals.css`. Lists that load on a
filter keep only the newest answer. The shop page's "Produkty" search (`@/components/ShopProducts`) changes the list
in place — no navigation, `replaceState`, the list keeps at least its height, Enter closes the keyboard — so the page
never moves; without JavaScript the form and the list's page links land on `#items`. Errors: `src/instrumentation.ts` → `@/lib/errorLog` (route file path + cleaned
message only, never the address, IP or personal data) → `log_server_error()` → admin "Chyby za posledných 7 dní";
Sentry too when `SENTRY_DSN` is set. Budget: `.github/workflows/performance.yml` (Lighthouse CI `lighthouserc.cjs` +
`scripts/first-load-js.mjs` + `npm run test:e2e` on every Vercel preview, throttling applied while loading); first-load JS
< 150 kB gzip on public pages. The main chat box sizes itself in CSS (`field-sizing: content`), not after hydration.

## Začať sklad odznova (update 43)

`supabase/sql/43_inventory_reset.sql` + stock-pull `?action=delete_files` + `sync/inventoryActions.ts` +
`@/components/InventoryDangerZone` + `@/lib/inventoryReset` + `@/lib/stockImports`. On "Priečinok s exportom" (`/sync`):
"Posledné nahrané súbory" (moved back from Asistent; old address forwarded) with **"Vymazať všetky nahrané súbory"**
(`owner_delete_stock_files()`: list, last file name, example rows; stock-pull deletes the raw files saved up to then —
`owner_raw_files_to_delete()` / `raw_files_deleted()`; the stock and its freshness stay; "Žiadny nahraný súbor · nahrajte
nový" wherever the last file is shown, `files_cleared`) and, `collapsed` at the bottom, "Nebezpečná zóna – sklad":
**A** remove the products missing from the last file (sold out and older than the newest `updated_at` of the shop's
items), **B** delete the whole stock + every uploaded file (typed shop name; keep translations by code — default on;
clear the mapping — default off). Only `owner_inventory_reset()` decides: membership, 3 per shop and day, a backup CSV
first (`inventory_backups`, 30 days, public fields + translations only), products into `inventory_trash` (30 days, daily
`ppi-inventory-purge`), `owner_inventory_restore()` = exactly back (same ids) unless a newer file was applied or a later
removal exists. Translations/descriptions return by code through the `shop_items_reattach_*` triggers. Every action in
`shop_activity`. Visitors: `shop_stock_resetting()` → "Sortiment sa práve aktualizuje." Never touches blog, slider,
assistant, private folders and their files, contacts, domain, subscription or opening hours. There are no customer alerts
("Upozorniť ma") and no Pomocník yet — the activity log and `owner_inventory_state()` are what they will read.

## Priečinok s exportom: review after an upload, translations folder (update 45)

`supabase/sql/45_export_translations.sql` + `/sync` page + `@/components/ExportReview` + `@/components/TranslationFolderSync`
+ `@/lib/exportFiles` / `@/lib/xlsx` (shared with `exportFiles_test.ts`) + `sync/exportActions.ts` +
`dashboard/LanguagesForm.tsx`, `Inventory.tsx` `ColumnsForm`. **Page order** (only `@/lib/dashboardPages`):
"Priečinok so skladom" (`export`, read only) · "Po nahratí súboru" (`review`: the card, "Jazyky", "Stĺpce súboru so
skladom"; old `languages`/`columns` forwarded) · "Preklady v priečinku" (`trfolder`: the folder, the ZIP/upload, "Súbory
so skladom v jazykoch"; old `files` forwarded) · "Posledné nahrané súbory" · (Pro) conversations to the PC · "Nebezpečná
zóna – sklad". **"Nový súbor – skontrolujte"** only when something waits (`owner_export_review()`): columns of the last
file neither approved nor private (`export_new_columns()`) → a free field or "Súkromné – nezobrazovať" (default; never
approved by itself; `shop_export_settings.private_columns`), new or changed products (`shop_export_marks` = md5 of name,
description, category the owner last saw; existing products were marked by the SQL) → languages = the shop's preferred
languages within `translation_limits`, "Vygenerovať popisy" (only new/changed without any description,
`export_describe_ids()`, the translate function's `describe`, 20 per call), "Zapamätať a už sa nepýtať" (`remember`:
`owner_export_auto()` on each check of the PC window; new columns are always asked). Every write via
`owner_save_export_review()` / server actions (`refreshShop`). **Translations folder** (Edge/Chrome, its own `readwrite`
handle in IndexedDB `trfolder:<shop>`, never the stock folder — `isSameEntry` refused; stock folder's watcher ignores
`sklad.<lang>.xlsx`): `sklad.<main>.xlsx` (approved columns as the file names them + "Popis" + "Stav popisu"; only Popis
editable → `item_descriptions` published, show 'cacaduu' over the shop's own, its AI translations stale) and
`sklad.<lang>.xlsx` per `owner_export_info().langs` (preferred ∪ inventory − main: Kód, Pôvodný názov, Názov, Popis,
Kategória, Stav; Názov/Popis/Kategória → `content_translations` 'manual'). **Only the approved columns** ever (rows from
`owner_export_rows()`, 1 000 per call; private columns are never stored). Every cell text ("@", also new cells), bold
frozen header + filter, a "Návod" sheet, a **very hidden `_cacaduu` sheet** with what was written (keys, headers, values,
EAN) — an edit = a non-empty cell that differs from it (empty = no change; other columns and unknown rows only listed;
rows by Kód, then EAN; columns by header) → `owner_apply_export_edits()` (matched again by Kód then EAN in SQL; the stock,
quantities, prices and names never change). **Each check** (15 min, window start, "Skontrolovať teraz", after the stock
folder sent a file — `ppi:stock-sent`): 1. a "Vymazať celý sklad" request (`delete_files_at`) → delete only Cacaduu's
files (also in folders used before) → `owner_log_export_files_deleted()`; 2. read Cacaduu's files whose mtime/size
changed, untouched ≥ 60 s, SHA-256 differs (locked by Excel → read later, never written over); 3. `owner_export_auto()`;
4. write again only when `owner_export_info().version` changed, a file is missing, an edit was applied or "Zapísať teraz":
`createWritable()` (a temporary file replacing the old one on close; locked → pending "… je otvorený v Exceli"), never a
file Cacaduu did not write ("nevytvorilo Cacaduu – nechávam ho tak"), nothing while the stock is empty. One window per
shop (Web Locks). Any browser: "Stiahnuť preklady (.xlsx, ZIP)" and "Nahrať upravený súbor" (same diff). Danger zone B
ticks "Vymazať aj súbory s prekladmi" (`owner_request_export_files_delete()`); the backup CSV of update 43 already holds
descriptions and translations. Activity log actions `export_review`, `export_edits`, `export_files_deleted`. No customer
alerts exist yet (nothing to cancel). Tests: `npm run test:export`, DB block "update 45", e2e owner test (OPFS folder).

## Pripojiť skladový program (API) (update 49)

`supabase/sql/49_inventory_api.sql` + `supabase/functions/inventory-connect` (one file, Verify JWT off) +
`@/components/InventoryConnect` + `sync/inventoryApiActions.ts` + `admin/domains/InventoryAdmin.tsx`. First section of
"Priečinok s exportom" (`api` in `@/lib/dashboardPages`). **The only place PPI pulls stock:** a read-only key, adapters
behind one interface (`testConnection`, `listProducts` → {rows, complete, total}, `capabilities`, rate limits), built
only from official docs: SuperFaktúra, WooCommerce, "Vlastné API" (https JSON/CSV); anything unverified (Shoptet,
Dotykačka) is `built = false` → "Pripravujeme". Plan rule only in SQL (`inventory_plan_settings`: Pro 15 min, Free off
unless the admin allows it; provider minimum, SuperFaktúra 60). **Key:** browser → function (owner JWT,
`is_shop_member`), tested first (a failed key is never stored), AES-GCM with `INVENTORY_TOKEN_ENCRYPTION_KEY` bound to
shop + provider in `inventory_connections.key_cipher` (no owner grant), never logged or shown again ("••••1234" + date);
"Odpojiť" deletes the row. **One source:** while connected `upload_check_in()` raises `api_connected` (stock-pull 409;
folder and uploads show "Sklad sa aktualizuje cez <program>"). **Nothing before approval:** preview (5 rows, count,
fields) → `owner_inventory_approve()`; changed fields → preview again. **Runs** (pg_cron `ppi-inventory-tick` 5 min,
`inventory_claim` skip locked): only a complete snapshot that reads with the approved fields goes through
`inventory_apply` → `apply_stock_file()`; partial / empty / older / error never zero the stock; no quantities → names
and prices only with the owner's consent, freshness never renewed (no availability); back-off 5 min · 2ⁿ ≤ 6 h,
Retry-After; invalid key → stopped, "Kľúč neplatný", one Brevo e-mail after 24 h; reports `stock_imports.source = 'api'`;
activity log. Private fields (purchase price, supplier, margin, invoice, internal) are never requested where the API
lets us choose fields and are dropped before storing otherwise. Only public https hosts, forwards checked, 20 MB.
Texts `inventory_api`, `admin_inventory`. "Synchronizovať teraz" ≤ 4/hour.

## Cacaduu Cloud Connection for the POS Sync Agent (Prompt 13; phase A = update 50, B = update 52, C = update 53)

`supabase/sql/50_connector_pairing.sql` + `supabase/functions/connector` (one file, Verify JWT off) +
`@/components/PosAgentPanel` + `sync/connectorActions.ts` + **the contract `docs/CONNECTOR_CLOUD_API.md`,
`docs/connector-openapi.json`, `docs/connector-client/`** (keep all three in step with the function's `ROUTES`:
`npm run test:connector`). The POS Sync Agent is an optional desktop app in its own repository; it only makes
outbound HTTPS requests. A THIRD way for stock to arrive (the PPI window and "Upload file" stay). The agent's "Own API"
POS source is not the Cloud Connection. Device endpoints only in the `connector` Edge Function (`/v1/...`,
`Cacaduu-Agent-Version` on every request, 426 below `CONNECTOR_MIN_AGENT_VERSION`), never Next.js routes. Pairing code:
8 characters without 0 O 1 I L, single use, 10 minutes, hash only; device token `cdt_` + 32 random bytes, returned once,
SHA-256 only, one shop per token — **the shop always comes from the token, never from the request**; rotation (old token
until the new one is used, ≤ 24 h); revoke at once. State only from heartbeat times (`connector_device_state()`), never
a stored "connected" flag. Owners act only through `owner_connector_*`; hashes are never granted.

**Phase B (update 52, `supabase/sql/52_connector_snapshots.sql`, `connector/snapshots_test.ts`,
`@/components/StockSourcePanel`):** **one active stock source** — only `stock_source_of()` decides: a connected inventory
program (api) > POS agent (owner chose it in "Zdroj zásob", `owner_set_stock_source()`, and an unrevoked device) >
files; while the agent is the source `upload_check_in()` raises `agent_connected` (stock-pull 409). Snapshot = announce
(signed upload URL to the private `connector-staging` bucket, `max_bytes` = `CONNECTOR_MAX_MB`) → the agent PUTs the
gzipped `cacaduu.inventory.v1` JSON → complete (count + SHA-256 of the uncompressed bytes must match; > 5 % bad rows →
rejected, else bad rows skipped and **their products keep their stock** (`p_keep`); fields outside the contract never
stored; the staged file deleted). Applied only through `connector_snapshot_settle()` under a per-shop lock: older
`source_time` → rejected; source not the agent → `test_ok` (checked, never applied); **0 products or fewer than half
the last applied count → `held`, never automatic** (`owner_connector_decide()`); else `connector_apply_rows()` (missing
→ 0) + a `stock_imports` report (`source = 'agent'`) + revalidate / IndexNow. `confirm` = same hash as the last
applied → only the freshness time moves forward. 1 full snapshot / 5 min / shop. Never claim POS sync works end to end
until tested with the real desktop agent.

**Phase C (update 53, `supabase/sql/53_connector_commands.sql`, `connector/commands_test.ts`):** "Synchronizovať
teraz" = `owner_connector_sync_now()` (only while `stock_source_of()` = agent; one open per shop, else the same one;
≤ 4/hour/shop) → one row in `connector_commands` (types **only** `sync_inventory` | `ping`; never code, paths or POS
settings). The agent gets pending ones in the heartbeat answer (`next_poll_seconds` 15 while one waits) or
`GET /v1/commands`; claim = one atomic UPDATE (pending → claimed, 2-minute lease; `409 already_claimed` for anyone
else); `running` renews; `connector_commands_tidy()` (run before every read/write, no cron) puts a lapsed lease back to
pending (+10 min) or `failed`/`lease_expired` after 3 attempts, and an unclaimed one past 10 minutes to `expired`.
`completed` for sync_inventory only with a snapshot of the shop applied/held after the command (its `command_id` or
none) or after `confirm` with the `command_id` (`connector_command_confirmed()`); otherwise `409 snapshot_not_applied`;
only the holder reports (`409 not_claimed`). The holder's announce skips the 5-minute snapshot limit
(`connector_command_active()`). Device state `syncing` from a live lease (`connector_device_syncing()`). Dashboard: the
"Synchronizovať teraz" box in `PosAgentPanel` (`syncNow` / `loadCommands`, 5 s refresh while open). Test stand-in:
`connector-test-agent.mjs sync`.

## Stock upload

`supabase/functions/stock-pull/index.ts` (single file, paste-deployable) only receives uploads:
`POST ?shop_id=&file_time=&file_name=[&gzip=1]` with the owner's (or legacy admin's) JWT, checked by `upload_check_in()`.
It downloads nothing and runs on no schedule (cloud links and the cron pull were removed on 2026-10-08, migration 16;
the only pull is the inventory API above), and refuses files (409 `api_connected`) while a program is connected.
A file not newer than `latest_file_time` is skipped; XML/CSV(UTF-8 or Windows-1250)/XLSX → rows; mapping proposals
(Claude with structured outputs, else `guessMapping`) are never auto-approved; `apply_stock_file()` writes a full file
in one transaction (missing items → quantity 0). >5 % unreadable rows → keep old stock, propose a new mapping.
Claude's proposal sees `columnSamples()` (names + ≤ 3 values; private-looking columns by name only); `sample_rows` holds
3 rows without private-looking columns while proposed, only the approved columns once confirmed (`trim_sample_rows`);
`file_columns` keeps every column name. Every received file gets an import report (`record_stock_import()`: status
ok/errors/waiting, counts, error, the first 5 rows of the approved columns; last 10 per shop; owners read it).
After an `updated` file, in the background (`EdgeRuntime.waitUntil`): `items_to_translate()` → Claude Haiku in batches
of 200 (structured output: lang, sk, hu, en) → `apply_item_translations()`; never touches stock, never overwrites the
owner's correction (`owner_set_item_translation()`, `name_i18n_by_owner`); failures are retried with the next file.

## Shop PC

No software on the shop PC except the PPI web app (`app/manifest.ts`, installable, starts at `/sync`). `/[lang]/sync`
→ `@/components/FolderSync` (File System Access API, Edge/Chrome only; Firefox/Safari get a message): folder handle in
IndexedDB (`@/lib/folderStore`), check every 15 min, one window per shop (Web Locks), `upload_check_in()` then POST the
newest finished file (untouched 60 s) to `stock-pull?shop_id=…` with the owner's JWT. Also "Upload file" (one file by
hand, any browser, same POST). Guide: `docs/SHOP_PC_SETUP.md`.

## Auth

Self-service, shop owners only — **no admin area on the website** except "Predplatné a domény" (`/[lang]/admin/domains`,
own domains and, since update 34, "Vyhľadávanie mimo Cacaduu", since update 35 "Partnerské feedy", since update 37 "Novinky / Blog" limits and the Meta app's addresses; only `profiles.is_admin`, checked again by `is_admin()` in SQL). E-mail + password: `/signup` (anyone; Supabase
sends a confirmation e-mail), `/login`, `/forgot` (reset e-mail → `/auth/confirm` → `/[lang]/password`). `/auth/confirm`
handles `token_hash` (templates in SETUP.md E3), `code` (default templates) and `#access_token` (→ `/[lang]/login/finish`).
Owners create/edit shops via `owner_save_shop()`, read them via `my_shops()`, approve columns via `owner_set_mapping()`,
delete via `owner_delete_shop()`. Every server action re-checks the session via `@/lib/auth`; RLS and those functions
are the real boundary. Anything needing the service role key goes in `supabase/functions/`.
