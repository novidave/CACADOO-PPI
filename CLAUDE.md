@AGENTS.md

# PPI — rules for Claude Code

Read `docs/PRD.md` (what to build) and `docs/ARCHITECTURE.md` (how it fits together) first.
Setup steps for humans are in `SETUP.md`.

## Hard rules

- **Never** put the Supabase service role / secret key in the web app, `.env*`, Vercel or the repo.
  Anything that needs it (stock pull, Stripe, inviting owners) is a Supabase Edge Function.
- Public pages (home, shop, item) load data in **server components** via `@/lib/supabase/server`.
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
- All visible text comes from `src/i18n/messages/{sk,hu,en}.json`; add every new key to all three.

## Design

Plain white background, black text, thin light-grey lines (`border-line`, `text-muted`).
**No colours** (only exceptions, at the owner's request: the Cacadoo PPI logo in the header, `public/brand/cacadoo-ppi.png`,
and the blue "Select picture" link for shop logos), no dark mode, no cart icons. Availability is always written out as text, emphasised in bold.
Mobile-first. Map: `@/components/ShopMap` (MapLibre + OpenFreeMap "positron", no API key), black dot pins;
always an extra — every page must work and show its data without it.

## Commands

- `npm run dev` — local site on http://localhost:3000
- `npm run lint` · `npm run typecheck` · `npm run build`
- `npm run test:db` — applies all migrations + seed to a throwaway local Postgres/PostGIS and runs the RLS and stock-logic checks
- `npm run check:functions` — type-checks the Supabase Edge Functions (Deno) in `supabase/functions/`
- `npm run test:functions` — unit tests of the Edge Functions (Deno): stock-pull file reading and mapping, Stripe
  checkout and webhook

## AI access

`src/lib/publicApi.ts` is the single source for the public API (`/api/v1/*`, OpenAPI at `/api/openapi.json`)
and the MCP server (`/mcp`, stateless Streamable HTTP, tools `search_stock`, `get_shop`, `get_item`):
anon client without cookies (`@/lib/supabase/public`), every result carries `source_url`, the database
decides availability/quantity. Every API/MCP request goes through `rateLimit` (`api_hit`: 60/min, daily-salted
IP hash). Items carry `name`, `name_translated` (in `lang`) and `name_lang`. `robots.ts`, `sitemap.ts` and
`llms.txt` live at the app root.

## AI search

Main page only, on request ("Search with AI" → `?ai=1`), as an extra layer above the server-rendered plain results:
`@/components/AiSearch` → `POST /api/ai-search` → `@/lib/aiSearch` (Claude Haiku, one strict tool `search_stock` from
`publicApi.ts`, no location, structured final answer; cards only from the tool results). `ai_search_hit()`: 10 per
minute per caller, `AI_DAILY_LIMIT` per day. `ANTHROPIC_API_KEY` is a server env variable (never `NEXT_PUBLIC`); without
it, over a limit or on any error the layer disappears silently for shoppers; a logged-in owner sees the reason instead
(`search.ai_unavailable`), and every reason is logged as `ai-search: …` (Vercel logs).

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
(collapsed box; the page stays server-rendered without it) → `POST /api/shops/[slug]/chat` → `@/lib/shopChat` (Claude
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

Owners upload PDFs and pictures (dashboard `ShopDocuments` → `@/components/DocUpload`): **never products** (items,
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
Cacadoo PPI · konverzácia <id> · strana X/Y"). Keep time 30/90/365 days (default 90), daily job. "Konverzácie asistenta"
(dashboard `Conversations.tsx`, page `dashboard/conversations/[id]`) is view only: no download buttons. Logos get a PNG
twin (`logo-<time>.png`) for the PDFs. Never put purchase prices, suppliers, margins, invoice numbers, access keys or
other shops' data into conversations, PDFs or exports. No local/PC folder sync or polling for exports: the cloud
folder (below) is a push from our server when a conversation ends.

## Cloud folder (paid, update 23)

`supabase/sql/23_cloud_export.sql` + `supabase/functions/cloud-export` (one file, Verify JWT off) + dashboard
`CloudFolder.tsx` / `cloudActions.ts` / `@/components/CloudFolderPicker`. One export **adapter** (OneDrive via Microsoft
Graph, Dropbox; no Google Drive): OAuth code + PKCE, state SHA-256 single use 10 min, redirect
`…/functions/v1/cloud-export/oauth/<provider>`; scopes OneDrive `offline_access Files.ReadWrite`, Dropbox
`files.metadata.read files.content.write account_info.read` offline. Tokens **only encrypted** (AES-GCM,
`EXPORT_TOKEN_ENCRYPTION_KEY`, bound to shop/provider/kind) in `cloud_connections` (owners have no grant on the token
columns), renewed automatically; "Odpojiť" deletes them. Default target `/Cacadoo/<shop name>`; share links refused
with an explanation. After `assistant_pdf_done` queues it, assistant-archive calls `export` (service role key) →
`<target>/<YYYY-MM>/<YYYY-MM-DD_HH-MM_id>/konverzacia.pdf` + `…/subory/`; job `ppi-cloud-export-tick` every 5 min.
**Never overwrite or delete in the shop's cloud** (OneDrive `conflictBehavior=fail`, Dropbox `mode: add`; same file →
not sent again, different → " (2)"); `cloud_export_items` notes what was copied. Status per conversation (Čaká /
Uložené v cloude / Chyba + reason, "Uložiť znova" = `owner_cloud_retry`, checks the cloud again), "Uložiť staršie
konverzácie" = `owner_cloud_backfill`; back-off 5 min · 2ⁿ ≤ 6 h, Retry-After, 20 tries; expired connection → one
e-mail after 24 h (Brevo API: `BREVO_API_KEY`, `ALERT_EMAIL_FROM`) "Pripojenie k cloudu vypršalo – pripojte ho znova".
A shopper's deletion of a copied conversation leaves a line without content ("zákazník požiadal o vymazanie" + cloud
folder; `assistant_shopper_forget`); keep time never touches the cloud.

## Shop page and My shop (migration 21)

- Product pages of shops with `shop_has_plan(shop)` show no other shops: no "Also available at" block or "not found
  elsewhere" text, no other pins, nothing in the JSON-LD (the item page skips `getOtherOffers`). Free shops and the
  main search keep it. The shop assistant never names other shops.
- Shop e-mail and Facebook page (`shops.email`, `facebook_url`; validated in `owner_save_shop()` and by checks:
  facebook.com / fb.com only) next to the website on the shop page (`@/components/ContactLinks`, mailto; Facebook in a
  new tab, `rel="noopener"`), in the JSON-LD (`email`, `sameAs`) and in the API's shop.
- Assistant button label (≤ 40) and welcome text (≤ 300), paid plan: `owner_set_assistant_texts()`; the database keeps
  plain text only (`plain_text()`: no HTML, links or e-mail addresses); empty = NULL = the i18n default (`chat.title`,
  `chat.intro`) in the page language; shown as written (`ShopChat` `buttonLabel` / `welcome`).
- Dashboard sections are `@/components/DashboardSection` dropdowns (heading + summary line; phone: only the first open;
  remembered per device in `localStorage` `ppi.dashboard.open`; `?at=`/`#` opens one). Under "Export folder": files in
  private folders (`PrivateFiles`, data from `loadShopDocs()`, Open via `/api/owner/files/{kind}/{id}` → `doc-ingest`
  `open_file`, delete via `deleteDocOrPicture`) and "Recently uploaded files" (`@/components/RecentImports`, the last 10
  `stock_imports` rows).

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

Self-service, shop owners only — **no admin area on the website**. E-mail + password: `/signup` (anyone; Supabase
sends a confirmation e-mail), `/login`, `/forgot` (reset e-mail → `/auth/confirm` → `/[lang]/password`). `/auth/confirm`
handles `token_hash` (templates in SETUP.md E3), `code` (default templates) and `#access_token` (→ `/[lang]/login/finish`).
Owners create/edit shops via `owner_save_shop()`, read them via `my_shops()`, approve columns via `owner_set_mapping()`,
delete via `owner_delete_shop()`. Every server action re-checks the session via `@/lib/auth`; RLS and those functions
are the real boundary. Anything needing the service role key goes in `supabase/functions/`.
