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
  update 22 on, **one file per phase in `supabase/sql/`** that the owner pastes into the SQL Editor (never run
  migrations, never ask for the database password). `npm run test:db` applies both.
  Add a check to `supabase/tests/database_test.sql` for every rule you add.
- **Europe-wide, no home town.** Never hard-code a city, country, currency or time zone.
  **No location services**: the website never asks for or guesses the visitor's location (no device location,
  no IP lookup). Search is text only — item name (original or its sk/hu/en translation), brand, EAN, shop name, street
  or town — across all shops; every word must match (`matches_all_words`, `item_names_text` + trigram index).
- Show the item name as the shop wrote it, plus `translatedName()` (`@/lib/names`) in the page language under it.
- Times stored in UTC, shown in the **shop's** time zone (`shops.timezone`) via `@/lib/format`.
  Prices via `formatPrice(value, locale, currency)` with the item's own currency.
- All visible text comes from `src/i18n/messages/{sk,hu,en}.json`; add every new key to all three (Slovak is the source;
  every other language comes from the database, update 40). `npm run test:strings` fails on text written straight into
  a page or component.

## Design

Plain white background, black text, thin light-grey lines (`border-line`, `text-muted`). **Font: Quicksand everywhere**
on the website (at the owner's request, 2026-10-20): `src/app/fonts.ts` (`next/font/google`, latin + latin-ext,
self-hosted at build — no browser request to Google), its variable on `<html>` in both root layouts, used by `body`,
`--font-sans` and MapLibre's map/tooltips in `globals.css`; code-like values (DNS records, keys) keep `font-mono`. The
conversation PDFs and the viewer's watermark keep DejaVu Sans (embedded).
**No colours** (only exceptions, at the owner's request: the Cacaduu PPI logo in the header, `public/brand/cacaduu-ppi.svg`
(cacaduu.com, since 2026-10-20; browser and app icons `src/app/favicon.ico`, `icon.svg`, `apple-icon.png`, `public/icons/`),
the main page chat's small pin `public/brand/cacaduu-pin.svg` and its **thinking dots in Cacaduu yellow #FFC531** (Prompt 10),
the blue "Select picture" link for shop logos and the same blue "Vybrať súbor" link of page sections (`SectionUploader`) and "Vybrať súbory" of the private folders (`DocUpload`), and the shop **status dots** — open #1E9E5A, break #2F6FED, closed
#D64545, holiday #F2B705, no hours #9AA5B1, white outline + thin dark ring, **always next to the status in words**, never
colour alone), no dark mode, no cart icons. Availability is always written out as text, emphasised in bold.
Mobile-first. Map: `@/components/ShopMap` (MapLibre + OpenFreeMap "positron", no API key), pins in the status colour
with the status in words in each pin's tooltip (no legend under the map, at the owner's request); always an extra — every page must work and show its data without it.

## Commands

- `npm run dev` — local site on http://localhost:3000
- `npm run lint` · `npm run typecheck` · `npm run build`
- `npm run test:db` — applies all migrations + seed to a throwaway local Postgres/PostGIS and runs the RLS and stock-logic checks
- `npm run test:status` — unit tests of `shopStatus()` in `src/lib/hours.ts` (Deno): breaks, past midnight, holidays,
  special days, DST
- `npm run test:site` — unit tests (Deno) of the own domain's robots.txt / llms.txt, the item JSON-LD and the search
  links (`src/lib/findable_test.ts`)
- `npm run test:chat` — unit tests (Deno) of the main page chat's protocol: streamed answer, refs, history, NDJSON, the
  layers' rules (town from the shopper's words, good results, OpenStreetMap hours, partner card texts and the 48-hour
  rule) (`src/lib/chat_test.ts`)
- `npm run test:blog` — unit tests (Deno) of the shop blog (`src/lib/blog_test.ts`): addresses on Cacaduu and own
  domains, the text as written, the Facebook message, BlogPosting/BreadcrumbList JSON-LD, RSS, scheduling time zones
- `npm run test:i18n` — unit tests (Deno) of the languages (update 40): the list, the browser's language, the picker's
  search and links, the fallback of interface texts, the same keys and placeholders in sk/hu/en
- `npm run test:strings` — fails on a visible text written into a `.tsx` file instead of the message files
- `npm run test:items` — unit tests (Deno) of Môj obchod's "Tovar" list (`src/lib/ownerItems_test.ts`): each state of
  "Čo vidí zákazník" (stale → hidden with the reason, sold out, in stock), the filters and the last file's status line
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
`llms.txt` live at the app root.

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
`shop_stock`, `get_item` → `public_stock` filtered by the shop, and `search_shop_docs` when the shop has documents;
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
Cacaduu PPI · konverzácia <id> · strana X/Y"). Keep time 30/90/365 days (default 90), daily job. "Konverzácie asistenta"
(dashboard `Conversations.tsx`, page `dashboard/conversations/[id]`): read, delete and, since 2026-10-14, **"Stiahnuť
PDF"** (finished conversations only; `owner_pdfs` in the function, RLS decides; `/api/owner/conversations/[id]/pdf`) and
ticks + "Stiahnuť vybrané" (`ConversationDownloadBar`, each conversation its own PDF, no ZIP); the PDF shows the
shopper's pictures large. Logos get a PNG
twin (`logo-<time>.png`) for the PDFs. Never put purchase prices, suppliers, margins, invoice numbers, access keys or
other shops' data into conversations, PDFs or exports. "Konverzácie do počítača" (since 2026-10-14, at the owner's
request): the shop PC's `/sync` window saves each finished conversation's PDF into a folder it picked
(`@/components/ConversationFolderSync`, File System Access `readwrite`, every 5 min, `<YYYY-MM>/<pdf_name>`, never
replaces or deletes a file, state only in that browser); the cloud folder (below) stays a push from our server.

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
  facebook.com / fb.com only) next to the website on the shop page (`@/components/ContactLinks`, mailto; Facebook in a
  new tab, `rel="noopener"`), in the JSON-LD (`email`, `sameAs`) and in the API's shop.
- Booking link, every shop (`supabase/sql/26_booking_link.sql`, `shops.booking_url`: https of a real host, ≤ 500;
  `clean_contact('booking', …)` in `owner_save_shop()`, error `booking`; kept when the form does not send it): the shop
  page's "Rezervovať termín" link in the contact row, same style as e-mail/Facebook (`@/components/ContactLinks`,
  calendar icon, new tab, `rel="noopener"`), JSON-LD `potentialAction` `ReserveAction`, the API/MCP shop (`booking_url`), llms.txt, and one line
  in the shop assistant's prompt (points to that link; never promises a time). PPI only links; nothing is booked here.
  Reads of `public_shops` fall back without `booking_url` on 42703 (`@/lib/missingColumn`).
- Assistant button label (≤ 40) and welcome text (≤ 300), paid plan: `owner_set_assistant_texts()`; the database keeps
  plain text only (`plain_text()`: no HTML, links or e-mail addresses); empty = NULL = the i18n default (`chat.title`,
  `chat.intro`) in the page language; shown as written (`ShopChat` `buttonLabel` / `welcome`).
- Môj obchod is five pages (menu: Môj obchod · Obsah stránky · Novinky / Blog · Asistent · Priečinok s exportom ·
  Predplatné a doména · Heslo; the menu keeps `?shop=`): `/dashboard` (details, logo, header logo, plan,
  delete), `/dashboard/content` "Obsah stránky" (update 38, below), `/dashboard/blog`, `/dashboard/assistant`
  "Asistent" (update 38: **four sections, each once, in this order** — "Nastavenia asistenta", "Konverzácie asistenta"
  with the cloud folder as its part `#cloud`, "Súkromné priečinky" = `ShopDocuments` (documents, folders, access keys,
  "Len zobraziť" / "Zobraziť a stiahnuť"), "Posledné nahrané súbory" = `@/components/RecentImports`; a free shop sees
  `ProOnly` "Dostupné v Pro" where it has nothing yet, what it has stays reachable) and `/sync` "Priečinok s exportom"
  (export folder + `FolderSync`, conversations to the PC). **Which page holds a section: only `@/lib/dashboardPages`**
  (`sectionUrl(lang, at, query)` for every form's way back; `movedFrom()` / `forwardUrl()` forward old addresses with
  their query, old names merged: `private` → `docs`, `sections` → `content`; `/dashboard/sections/[id]` → the library).
  Never put a section on two pages. Shared messages/switcher/form parts: `dashboard/shared.tsx`. Sections are
  `@/components/DashboardSection` dropdowns (heading + summary line; phone: only the first open; remembered per device
  in `localStorage` `ppi.dashboard.open`; `?at=`/`#` opens one). `RecentImports`: the last 10 `stock_imports` rows as
  cards; a tap opens the quick view (a `<dialog>` slideshow of the full reports, "Súbor n z 10", Novší/Starší, ← → keys,
  swipe, Esc).

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
optional title, optional "Stiahnuť". Swipe, ‹ › and ← →, "3 / 10" + dots, height of the current slide ≤ 80vh, only the
current and next slide get an `<img>` (`<noscript>` for the rest), `prefers-reduced-motion` = no smooth scroll.
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
  "Preložené automaticky · Zobraziť originál" (`?original=1`). Never translated: brands, codes, EAN, prices,
  quantities, units, URLs, e-mails, phones, colour codes, `{placeholders}`.
- **SEO:** hreflang/sitemaps only for pre-translated languages (PPI: admin's "preložený vopred"; a shop: its indexed
  languages — shop/item/blog pages set `robots` themselves); others `noindex`.
- **Descriptions** (`item_descriptions`): "Návrh popisu" by Claude **only from the shop's own data**
  (`item_description_facts()`: name, brand, EAN, category, the shop's own description), never invented; the owner edits
  → "Uložiť a zverejniť" / "Zahodiť"; "Zverejniť vygenerované popisy automaticky" (default off); the shop's own
  description wins unless the owner picks "Popis (Cacaduu)" (`item_description_shown()`).
- **Owner screens:** Môj obchod → "Jazyky a inventár" (`/dashboard/translations`: Jazyky, Stĺpce súboru so skladom,
  Súbory so skladom v jazykoch, Tovar, Preklady; columns and items moved here from `/dashboard`, old `?at=` forwarded;
  **"Tovar" since update 41** (`supabase/sql/41_items_list.sql`, `@/lib/ownerItems`): one short line + "Viac", the
  status line "Posledný súbor: … · aktuálny / starší / zastaraný" (`shops.freshness_state`), filters Všetko / Na sklade /
  Vypredané / Bez popisu / Chýba preklad decided only in SQL (`owner_items(…, p_filter)`, `owner_item_counts()`; stock
  filters by the file's quantity, "Chýba preklad" = a name or shown description without a current translation in
  `shop_target_langs()`, stale AI = missing, "Neprekladať" = not), one link per product "Popis a preklady" (no
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

## Speed (performance pass, update 42)

`supabase/sql/42_performance.sql` + `PERFORMANCE.md` (targets, budget, how to measure). **Public reads go through
`createCachedPublicClient()`** (`@/lib/supabase/public`: only the `CACHED_RPCS` allowlist and GET `/rest/v1/` reads,
60 s, tags `public` + `shop:<slug>` or `cross`); everything else (owner, admin, rate limits, AI) stays uncached.
**Every change a visitor can see refreshes them** (`@/lib/publicCache`: `refreshShop(slug)` in each owner action's
`back()` when `ok`, `refreshAll()` for translations, blog posts and admin settings; stock-pull POSTs
`/api/revalidate` with `REVALIDATE_SECRET` after `updated` and after the translations). Search names: the stored
column `shop_items.names_search` (= `item_names_text()`) with its trigram index and `search_patterns()` (`LIKE ALL`,
same words as `matches_all_words`); hot functions `set jit = off`. Lazy on public pages: the map (`ShopMap` box →
`ShopMapCanvas` near the screen after the load event, or on tap), the shop assistant (`ShopAssistant` = the same first
view, `ShopChat` loads near the screen or on touch; the typed text, focus and the key dropdown go along), the language
list (`LanguagePickerDialog`), the picture viewer (`SectionZoomViewer`), Vercel Speed Insights/Analytics
(`VercelMetrics`, only on Vercel). One Quicksand declaration only (a second one loads the font twice). Môj obchod
sections open before the first paint (`DashboardSection`'s inline script); no `loading.tsx` there (it turns the pages'
`redirect()` into a client redirect) — the tapped menu link shows `useLinkStatus`. Taps: `TapFeedback` (server-action
forms: busy at once, never sent twice), pressed states and 44 px touch areas in `globals.css`. Lists that load on a
filter keep only the newest answer. Errors: `src/instrumentation.ts` → `@/lib/errorLog` (route file path + cleaned
message only, never the address, IP or personal data) → `log_server_error()` → admin "Chyby za posledných 7 dní";
Sentry too when `SENTRY_DSN` is set. Budget: `.github/workflows/performance.yml` (Lighthouse CI `lighthouserc.cjs` +
`npm run test:e2e` on every Vercel preview); first-load JS < 150 kB gzip on public pages.

## Stock upload

`supabase/functions/stock-pull/index.ts` (single file, paste-deployable) only receives uploads:
`POST ?shop_id=&file_time=&file_name=[&gzip=1]` with the owner's (or legacy admin's) JWT, checked by `upload_check_in()`.
It downloads nothing and runs on no schedule (cloud links and the cron pull were removed on 2026-10-08, migration 16).
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
