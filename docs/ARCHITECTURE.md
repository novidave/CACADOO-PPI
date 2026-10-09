# Architecture (as built)

Status 9 October 2026. How PPI works from the shop's stock file to a shopper's screen and an AI assistant's answer:
the parts, how data flows between them, where every rule lives, how it is configured and tested, and what happens when
something breaks. What PPI does for its users is in `docs/PRD.md`.

## 1. How it works in one minute

1. A sale lowers the stock in the shop's own stock software, as it does today.
2. Every 15–30 minutes that software exports the whole stock to one file (XML, CSV or Excel).
3. The file is uploaded to PPI in one of two ways (PPI downloads nothing itself):
   - **Folder:** the PPI app window on the shop PC (Edge or Chrome) checks the export folder every 15 minutes and
     sends the newest finished file;
   - **By hand:** the owner clicks "Upload file" and picks it.
4. The Supabase Edge Function **`stock-pull`** reads the file. For a new file layout it proposes which column is which
   (Claude, or a rule-based guess); the owner approves it once on the dashboard.
5. The function writes the whole stock in one transaction and records the file's time. That time is the freshness.
   After replying it translates new or renamed item names into Slovak, Hungarian and English in the background
   (Claude Haiku), so every search finds items in all three languages.
6. The Next.js website on Vercel shows the stock on server-rendered pages, and the same data goes out through a public
   API and an MCP server. Freshness and availability rules are applied once, in the database, for all of them. On
   request, an AI search (Claude Haiku using the same search) adds an answer above the plain results.
7. Shops can take a monthly **paid plan** (Stripe, test mode first): the dashboard's "Upgrade" goes through the Edge
   Function **`stripe-checkout`** to Stripe's payment page; Stripe tells the Edge Function **`stripe-webhook`**, which
   writes the subscription. One SQL function, `shop_has_plan()`, answers every paid feature. The first one is the
   **AI assistant on the shop page** (Claude Haiku, tools limited to that shop's stock, photos of parts welcome). It can
   also answer from the shop's own **documents and pictures**: the owner's browser reads each PDF (pdf.js), the Edge
   Function **`doc-ingest`** stores it and its text as written and lets Claude describe its pictures; private folders
   open only with an access key, and the Edge Function **`shop-files`** hands out 10-minute file addresses only for
   what the database allows.

```text
SHOP
  stock software --export--> folder
       |
       | PPI app window (/sync), every 15 min, or
       | "Upload file" in the browser
       v  HTTPS POST + owner's login
SUPABASE ---------------------------------------------------------------------------
  Edge Function stock-pull: read file -> column mapping (proposal / approved) -> check
                            -> apply_stock_file() in one transaction -> freshness
                            -> (after the reply) names to sk/hu/en: Claude Haiku -> apply_item_translations()
  Postgres + PostGIS: tables, RLS, SQL rules (freshness, availability, search in 3 languages)
  Auth (e-mail + password, SMTP via Brevo) | Storage (logos, raw files, shop-docs: private PDFs and pictures)
  Edge Functions stripe-checkout (owner's login -> Stripe page) | stripe-webhook (signed event -> subscriptions)
  Edge Functions doc-ingest (owner's login: register, text -> excerpts, Claude looks at pictures, delete)
               | shop-files (database says yes -> 10-minute signed file address)
        ^ ^
        | +--> STRIPE: Checkout, customer portal, Stripe Tax, invoices (keys only in function secrets)
                                   |
WEBSITE (Next.js 16 on Vercel)     v
  server-rendered pages + JSON-LD | owner dashboard | /sync app | robots, sitemap, llms.txt
  public API /api/v1 + OpenAPI    | MCP server /mcp | /api/ai-search (Claude Haiku + search_stock)
  /api/shops/[slug]/chat (shop assistant, paid plan: Claude Haiku + this shop's stock and allowed documents)
  /api/shops/[slug]/access (access key -> HttpOnly session cookie) | /api/shops/[slug]/files/... (-> shop-files)
                                   |
READERS                            v
  shoppers | shop owners | search engines and AI crawlers | AI assistants (MCP) | tools (API)
```

## 2. Components

### 2.1 Getting the stock file to PPI

| Way | Who starts it | How | File time used as freshness |
| --- | --- | --- | --- |
| Folder (PPI app window) | the open window, every 15 min | browser reads the folder (File System Access API), uploads the newest finished file | the file's "last modified" time on the PC |
| Upload file | the owner, by hand | file picker, same upload | the file's "last modified" time |

**PPI app window** (`src/components/FolderSync.tsx`, on `/[lang]/sync` and inside the dashboard):

- Edge/Chrome only (`showDirectoryPicker`); Firefox/Safari get a message and the "Upload file" button.
- The folder handle is stored in the browser's IndexedDB (`src/lib/folderStore.ts`), so the folder is remembered.
  After a restart the browser may need one click ("Allow access"); "Allow on every visit" makes it permanent.
- Every 15 minutes (a 20-second timer catches up after sleep or a throttled background tab):
  1. `upload_check_in(shop)` with the owner's login → records "PPI window last active", returns the shop's stock status;
  2. newest `.xml/.csv/.txt/.xlsx` in the folder (temporary `~$` files ignored);
  3. skip if written less than 60 s ago (export still running) → retry in 1 minute;
  4. skip if not newer than the last applied file, or if it is the same file already sent and the mapping status has
     not changed since (e.g. still waiting for approval) — this record is kept in IndexedDB;
  5. read it, check it did not change while reading, gzip it, POST it to `stock-pull`.
- Web Locks: one window per shop works; a second window waits and takes over when the first closes.
- Installable as an app: `src/app/manifest.ts` (start page `/sync`, standalone, `focus-existing`); icons in
  `public/icons/`. Starting with Windows is done with the Windows startup folder (steps on the page).

### 2.2 Edge Function `stock-pull` (`supabase/functions/stock-pull/index.ts`)

One file, Deno, deployed by pasting it into the Supabase editor with **Verify JWT off** (it checks callers itself).
Uses the service role key, which Supabase gives the function automatically.

**Who may call it:** only an upload — `POST ?shop_id=…&file_time=…&file_name=…[&gzip=1]` with the file as the body
and the caller's login, which must pass `upload_check_in(shop)`: owner of that shop (or the legacy admin flag). It
records "PPI window last active". A file not newer than the shop's latest applied file is answered `unchanged`. The
function never downloads anything and runs on no schedule.

**What it does with a file** (`processFile`)

1. Size check (empty, over 50 MB) and format by content (ZIP → xlsx, `<` → XML, else CSV).
2. Read rows: XML = the largest list of repeated elements (attributes and nested values flattened); CSV = separator
   guessed from the header (`;` `,` tab `|`), quotes, UTF-8 or Windows-1250; XLSX = first sheet (SheetJS).
3. Keep the raw file in the private `raw-files` bucket (files older than 7 days deleted).
4. **No approved mapping:** if a proposal already fits the columns → "waiting for approval"; otherwise propose one:
   Claude (structured output whose allowed values are the file's real column names, low effort, with server-side
   fallback) when `ANTHROPIC_API_KEY` is set, else `guessMapping()` (column-name hints in SK, CZ, HU, EN, DE). Save it
   as `proposed` with 10 sample rows and stop. **Never auto-approved.**
5. **Approved mapping:** map every row (numbers in any European format; currency from the file, else from the shop's
   country, else EUR). More than 5 % unreadable rows → keep the old stock, propose a new mapping
   (`layout_changed`).
6. `apply_stock_file(shop, rows, file_time, sample)` in one transaction: upsert products by EAN, `shop_items`,
   `inventory`; items of the shop missing from the file → quantity 0; set `latest_file_time`, clear `last_error`.

Results: `updated`, `unchanged`, `proposed`, `waiting_for_approval`, `layout_changed`, `error` (also written to
`sync_sources.last_error`).

**Item names in three languages** (after `updated`, in the background with `EdgeRuntime.waitUntil`, so the reply and
the stock never wait for it): `items_to_translate(shop)` lists names without a translation or renamed since (never the
owner's corrections; public items first; up to 1,200 per file) → batches of 200 names, 3 at a time, to Claude Haiku
(structured output: language, sk, hu, en per name; abbreviations written out, brand/sizes/model and part numbers kept;
low effort, streamed) → `apply_item_translations(shop, items)` saves them, skipping owner corrections and names that
changed meanwhile. Any failure is logged and left for the next file; without `ANTHROPIC_API_KEY` nothing is
translated.

### 2.3 Database (Supabase Postgres + PostGIS)

**Tables:** `shops`, `shop_members`, `products`, `shop_items`, `inventory`, `sync_sources`, `profiles`, `api_usage`,
`subscriptions`, `shop_chat_usage` (columns in PRD section 7).

**Rules in SQL (one place for website, API and MCP):**

| Object | Purpose |
| --- | --- |
| `freshness_label(time)`, `freshness_age_minutes(time)`, `freshness_state(shop)` | current < 30 min, recent < 24 h, stale otherwise |
| `availability_label(mode, quantity, threshold, freshness)` | label key per visibility mode; NULL when stale |
| view `public_stock` | the only public read path for stock: public items of active shops, labels, raw quantity only for `exact` shops that are not stale |
| `search_stock(q, lat, lng, radius_km, only_available)` | text search: every word of `q` must appear (`matches_all_words()`, accents/case ignored via `search_text()` = `unaccent` + lower) in the item's names (original + sk/hu/en, `item_names_text()`), brand, EAN, or the shop's name, street, town; candidates come from the trigram indexes (longest word); optional radius for API/MCP callers; available first, fresher, nearer, name; 50 rows with the translations |
| view `public_shops`, `shop_stock(slug, q, limit, offset)` | shop pages and their item lists (same word search, with translations) |
| index `shop_items_names_search_idx` | trigram index over `item_names_text(name, name_i18n)`: original name and all three translations |
| `items_to_translate(shop)`, `apply_item_translations(shop, items)` | translation queue and saving — service role only; never touch owner corrections |
| `owner_set_item_translation(item, names)` | the owner's correction (or `null` = back to automatic) |
| `ai_search_hit(ip_hash, daily_limit)` | AI search limits: 10 per minute per caller, a daily total for the site; logs in `api_usage` |
| `shop_chat_hit(ip_hash, shop, hourly_limit, monthly_limit)` | shop assistant gate for every message: `no_plan` unless `shop_has_plan()`, `caller_limit` after 20 an hour per caller (`api_usage`, `shop-chat`), `shop_limit` at the monthly cap (`shop_chat_usage`), else `ok` (counted) |
| `town_center(town)` | "near Budince" for API/MCP: middle of the active shops in that town (no outside geocoding) |
| `api_hit(ip_hash, endpoint, limit)` | rate limit (60/min) and usage log |
| `apply_stock_file(...)` | stock writing — service role only |
| `shop_has_plan(shop)` | **the** paid-plan check: subscription `active` or `trialing` and `current_period_end` not passed; callable by anyone (yes/no only) |
| `link_stripe_customer(shop, customer)`, `apply_stripe_subscription(shop, customer, subscription, status, plan, period_end, cancel_at)` | paid-plan writing — service role only (the Stripe functions); a live subscription is never replaced by an ended one |
| `my_shops()`, `owner_save_shop(p)`, `owner_set_mapping(shop, mapping)`, `owner_delete_shop(shop)`, `owner_items(...)`, `availability_preview(threshold)`, `my_sync_status(shop)`, `upload_check_in(shop)` | the owner dashboard; each checks that the caller owns the shop; `owner_delete_shop` refuses a shop whose paid plan still renews |

**Guards:** triggers stop clients from changing a shop's page address, company ID or visibility flag directly
(`guard_shop_update`; the owner functions run as the database owner and may), from writing stock results into
`sync_sources` (`guard_sync_source_write`), from setting `is_admin` (`guard_profile_update`), and from saving an unknown
time zone (`guard_shop_timezone`). A profile row is created for every new account (`handle_new_user`).

**Row Level Security** is on for every table; visitors use only the public views/functions; owners reach only shops
where they are in `shop_members`; `inventory`, stock results and `subscriptions` are written only by the service role
(owners may read their own shop's `subscriptions` row; visitors nothing).

**Storage:** `logos` (public read; members may write into their shop's folder; 1 MB; PNG/JPEG/WebP) and `raw-files`
(private, service role only).

**Vault:** not used any more; the old tunnel design kept per-shop download credentials there (`ppi_shop_<id>`).

**Legacy, kept but unused by the website and the function:** `profiles.is_admin`, the `admin_*` functions,
`user_id_by_email`, `admin_set_sync_credentials`, `sync_credentials`, and the column `sync_sources.file_url` (only the
legacy `admin_shops()` reads it). Removing them needs a new migration.

### 2.4 Accounts and e-mail (Supabase Auth)

- E-mail + password. Sign-ups allowed, e-mail confirmation on, minimum 8 characters (Supabase settings, SETUP.md E1).
- E-mails go through **Brevo SMTP** (SETUP.md E2). Brevo's "authorised IPs" blocking must be off, or Supabase gets
  `525 Unauthorized IP address`.
- Links land on `/auth/confirm`, which accepts `token_hash` (templates in SETUP.md E3, any device), `code` (default
  templates, same browser) and hands `#access_token` links to `/[lang]/login/finish`.
- Every server action re-checks the session (`src/lib/auth.ts`); the database functions and RLS are the real boundary.

### 2.5 Website (Next.js 16 on Vercel)

| Route | What |
| --- | --- |
| `/[lang]` | search (server-rendered), results, map |
| `/[lang]/shops/[slug]`, `/[lang]/items/[id]` | public pages + JSON-LD |
| `/[lang]/signup`, `/login`, `/forgot`, `/login/finish` | accounts |
| `/[lang]/dashboard`, `/sync`, `/password` | owner area (login required, not indexed) |
| `/auth/confirm`, `/auth/signout` | e-mail link landing, sign out |
| `/api/v1/*`, `/api/openapi.json`, `/mcp` | public API, OpenAPI, MCP server |
| `/api/ai-search` | AI search for the main page (POST, website only) |
| `/api/shops/[slug]/chat` | the shop assistant on a shop page (POST, website only, paid plan) |
| `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/manifest.webmanifest` | discovery files, app manifest |

- **Languages:** `src/proxy.ts` sends addresses without a language to `/sk`, `/hu` or `/en` (saved choice → browser
  language → English), remembers the choice in a cookie and refreshes the Supabase session cookie. Texts in
  `src/i18n/messages/{sk,hu,en}.json`.
- **Supabase clients:** `lib/supabase/server.ts` (pages and actions, with the visitor's cookies),
  `lib/supabase/client.ts` (browser: login finish, PPI app window), `lib/supabase/public.ts` (API, MCP, sitemap,
  llms.txt: anon, no cookies). Only the public URL and the anon/publishable key are in the website.
- **Public pages** load data in server components (`lib/data.ts`) so crawlers see everything without JavaScript.
- **Formatting** (`lib/format.ts`): prices with the item's own currency in the visitor's language; times in the shop's
  time zone. Opening hours and "open now" in `lib/hours.ts`.
- **Map** (`components/ShopMap.tsx`): MapLibre GL with OpenFreeMap "positron" tiles; its worker file is copied to
  `public/maplibre/` at build time (`scripts/copy-maplibre-worker.mjs`).
- **Owner dashboard** (`app/[lang]/(account)/dashboard`): server actions in `actions.ts` (save shop, approve columns,
  visibility, logo, item visibility, translation correction, plan, delete); each form returns to its own section with
  its message. The Plan section reads the shop's `subscriptions` row and `shop_has_plan()`; "Upgrade" and "Manage
  subscription" run `openBilling`, which calls the `stripe-checkout` function with the owner's session and redirects to
  the Stripe page it returns.
- **Names** (`lib/names.ts`): `translatedName()` picks the page-language name to show under the shop's own name when
  it reads differently — search results, shop and item pages (title and JSON-LD `alternateName`), dashboard, AI cards.

### 2.6 AI and machine access

- `src/lib/publicApi.ts` is the single source for the REST API and the MCP server: anon client, the database decides
  availability and quantities, every result has `source_url`.
- Every API/MCP request passes `rateLimit` (`lib/apiHttp.ts`): SHA-256 of IP + daily date + `API_HASH_SALT`,
  `api_hit()` allows 60 per minute; open CORS.
- MCP: `@modelcontextprotocol/sdk`, stateless Streamable HTTP with JSON responses, read-only tool annotations.
- Every item carries `name` (as the shop wrote it), `name_translated` (in `lang`) and `name_lang`; the shop carries
  its `timezone`.
- Discovery: `robots.ts` (AI crawlers named; `/api/ai-search` and `?ai=1` pages kept off), `sitemap.ts` (hourly),
  `llms.txt/route.ts`; optional search-engine verification tags from `GOOGLE_SITE_VERIFICATION` /
  `BING_SITE_VERIFICATION`.

### 2.7 AI search (`lib/aiSearch.ts`, `app/api/ai-search/route.ts`, `components/AiSearch.tsx`)

- The main page shows "Search with AI" only when `ANTHROPIC_API_KEY` is set in Vercel. It submits `?q=…&ai=1`; the
  plain results are rendered on the server as always, and the `AiSearch` component above them POSTs the question to
  `/api/ai-search` and shows "AI is searching all shops…" while it works.
- The route checks `ai_search_hit()` (10 per minute per caller, `AI_DAILY_LIMIT` per day, default 500), then runs a
  tool loop with Claude Haiku (low effort, max 2,048 tokens per turn, prompt caching): one strict tool, `search_stock`
  (query, only_available — no location), served by `publicApi.searchStock` like the API and MCP. Up to 3 turns with
  searches and 12 searches in total, 30 seconds; then the model must answer. A hard stop at 50 seconds (inside the
  route's 60) ends it with a reason rather than a timeout. The final answer is structured output:
  language, a short answer, and the refs (`r1`, `r2`, … given in the tool results) of the fitting items.
- Cards are built from the search results only (unknown refs are dropped), in the page language: name + translation,
  brand, price, shop, place, availability + freshness, link to the item page. The searched terms are shown.
- No key, over a limit, a refusal or any error → `{fallback: true}` and the AI box disappears; the plain results stay.
  For a logged-in owner the reply also carries `reason` (missing key, limit, database update 17 missing, Claude's error
  message), shown as a short note in place of the box; every reason is logged as `ai-search: …` (Vercel → Logs).
  No CORS headers: only the PPI website calls it.

### 2.8 Paid plan (`supabase/functions/stripe-checkout`, `supabase/functions/stripe-webhook`)

- **No Stripe key on the website.** Both functions are single paste-deployable files with Verify JWT off; they call the
  Stripe REST API directly (form-encoded, `Stripe-Version: 2026-09-30.endive`), no Stripe SDK. Secrets:
  `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PRO`, `STRIPE_WEBHOOK_SECRET`.
- **`stripe-checkout`** (POST `{shop_id, action: checkout|portal, lang, return_url, company_id_label}` with the owner's
  JWT): checks the login (`auth.getUser`) and `is_shop_member` with the caller's own rights, reads the shop and its
  `subscriptions` row through RLS. A live subscription (trialing, active, past_due, unpaid, paused) always gets a
  customer-portal session. Otherwise: the shop's Stripe customer (made once, idempotency key per shop and user, with
  the shop's `ico` as an invoice field, saved by `link_stripe_customer()`), then a Checkout Session: `mode=subscription`,
  `STRIPE_PRICE_PRO`, `automatic_tax`, `tax_id_collection`, required business name (`name_collection`), required
  billing address, `customer_update` name/address `auto`, a custom field `companyid` pre-filled with `ico`,
  `locale` = page language, `metadata.shop_id` on the session and the subscription, `client_reference_id` = shop.
  `return_url` must be a PPI `/{lang}/dashboard` page (https, or http on localhost); Stripe comes back with
  `?plan=done` or `?plan=canceled` at `#plan`.
- **`stripe-webhook`** (Stripe → POST): checks the `Stripe-Signature` (HMAC-SHA256 of `t.body` with
  `STRIPE_WEBHOOK_SECRET`, any `v1`, at most 5 minutes off), then for `checkout.session.completed` and
  `customer.subscription.created|updated|deleted|paused|resumed` fetches the subscription from Stripe (event order
  does not matter), finds the shop (`metadata.shop_id`, else by customer) and calls `apply_stripe_subscription()`:
  status, plan (`pro` for `STRIPE_PRICE_PRO`, else the price's lookup key or id), the period end (from the
  subscription items; older API versions: the subscription), `cancel_at` (or the period end when
  `cancel_at_period_end`). After a completed payment page the company ID typed there becomes the customer's invoice
  field. Any failure answers 500, so Stripe retries (for up to three days); unknown shops are answered 200 and ignored.
- **Invoices:** Stripe creates and e-mails them (with VAT from Stripe Tax, the company name, address, VAT number and
  the company ID field); the portal lists them.

### 2.9 Shop assistant (`lib/shopChat.ts`, `app/api/shops/[slug]/chat/route.ts`, `components/ShopChat.tsx`)

- The shop page renders `ShopChat` (a collapsed box, client component) only when `ANTHROPIC_API_KEY` is set and
  `shop_has_plan(shop)` is true; everything else on the page stays server-rendered. The browser keeps the
  conversation and sends `{lang, history (last 8, text only), message, photo?}`; a photo is shrunk to at most
  1568 px, JPEG quality 0.85, base64, and sent with that one message only (later messages carry "[photo]" and what
  was read from it).
- The route takes the shop from the address (`public_shops`, active shops only), checks the photo (JPEG, at most about
  2 MB), then `shop_chat_hit()` (plan, 20 an hour per caller, `CHAT_MONTHLY_LIMIT_PER_SHOP`, default 1,000), then runs
  Claude Haiku (`claude-haiku-5-5`, effort low — medium with a photo, 4,096 tokens per turn, prompt caching) with a
  system prompt naming the shop and two strict tools bound to it on the server: `search_items(query)` → `shop_stock`
  (15 items, refs `r1`, `r2`, …) and `get_item(ref)` → `public_stock` for this item **and** this shop. Up to 3 turns
  with tools and 10 tool calls, 25 seconds; then it must answer; a hard stop at 50 seconds (route limit 60).
- The final answer is structured output: `answer`, `item_refs`, `shopping_list` (ref, quantity, note), `photo`
  (`read`, `match`: none/found/not_found/unsure). The server keeps only refs the tools returned, builds cards and the
  list in the page language (name + translation, price, availability, freshness, link), and turns a "found" without
  any item into "unsure". Replies: `{answer, cards, list, photo}` or `{error}` (`no_plan` 403, `caller_limit` /
  `shop_limit` 429, `bad_photo` 400, `failed` 502 — with the reason for a logged-in owner, logged as `shop-chat: …`).
- "Copy list" puts the list as text on the clipboard; "Print list" marks the list and prints with a print style that
  leaves out everything else (`globals.css`).

### 2.10 Documents for the assistant (migration 20, `supabase/functions/doc-ingest`, `supabase/functions/shop-files`)

- **Why the browser reads the PDF.** Supabase Edge Functions get at most 2 seconds of CPU per request (and 150 s / 400 s
  wall clock, 256 MB): parsing a 20 MB PDF, decoding its images and rendering scanned pages does not fit. So the
  dashboard does it in the owner's browser with pdf.js (`lib/pdfRead.ts`, the "legacy" build for older browsers too;
  worker, fonts, CMaps and decoders copied to `/pdfjs/<version>/` by `scripts/copy-pdfjs-assets.mjs`), and the function
  only does light work and waits for Claude.
- **Upload of a PDF** (`components/DocUpload.tsx`): `register_document` (doc-ingest: owner's login → `is_shop_member`;
  `docs_register_document()` checks plan, accepted terms, folder and the limits `SHOP_DOCS_MAX_FILES` /
  `SHOP_DOCS_MAX_PAGES`; returns `<shop>/docs/<id>.pdf`) → the browser uploads the unchanged PDF into the private bucket
  `shop-docs` with the owner's login (storage policy: only a registered, not yet uploaded file of the owner's shop,
  `shop_docs_upload_allowed()`) → `document_uploaded` (the file is really there) → for every page: text (pieces joined
  by their position), pictures ≥ 200 px (each once, by hash; WebP ≤ 1568 px; a page whose pictures cannot be taken out
  becomes one picture), a page without text rendered as a JPEG "scan" → `text` (40 pages at a time:
  `chunkPages()` keeps each page apart, ≤ about 800 words per excerpt; `detectLang()` by common words; then
  `docs_save_text()`) and `register_pictures` / upload / `pictures_uploaded` (8 at a time; over
  `SHOP_DOCS_MAX_PICTURES` refused) → `document_done` → the browser keeps calling `work` while pictures wait.
- **`work`:** `docs_claim_work()` hands out up to 4 waiting pictures (never twice; stuck ones again after 10 minutes),
  the function downloads each and asks Claude (`AI_MODEL`, default `claude-haiku-5-5`, structured output): a picture →
  a short factual description in the document's language (or the owner's page language); a scan → its text as
  written. `docs_save_work()` stores it (never over the owner's corrected description; after 3 failures the picture
  stays without one) and rebuilds the picture's excerpt (title + the owner's caption + description,
  `docs_picture_chunk()`); `docs_finish()` marks documents ready (error if a scanned page could not be read) and
  uploads left unfinished for an hour as errors. Work left over continues when the owner next opens the dashboard
  (`DocsWork`). Without `ANTHROPIC_API_KEY` pictures wait.
- **Search:** `shop_document_chunks.search` is `to_tsvector('simple', search_text(text))` (GIN) plus a trigram index.
  `search_shop_docs(slug, query, session_token, limit)` works out the visible folders itself (the shop's Public folder
  plus those of a valid session of that shop: not expired, key neither expired nor revoked) and returns excerpts of
  documents with "Assistant may use it" and pictures with "Assistant may show it", matched by word starts (inflected
  forms) or trigram similarity, only for active shops with the plan. It never accepts folder ids.
- **Access keys:** `owner_create_folder_key()` makes 20 random characters (no look-alikes), returns them once, keeps
  SHA-256 only. `unlock_shop_folders(slug, key, caller hash)` (5 wrong keys per caller per shop in 15 minutes, logged
  in `api_usage` as `folder-key-fail:<shop>`) returns a 40-character session token (hash kept in `folder_sessions`,
  12 hours). The website (`lib/docsAccess.ts`, `/api/shops/[slug]/access`) keeps the token in a cookie
  `ppi_docs_<slug>`: HttpOnly, Secure, SameSite=Lax, path `/api/shops/<slug>/`, signed with HMAC-SHA256
  (`SESSION_COOKIE_SECRET`, at least 32 characters; without it keys are switched off). "Lock again" deletes the session.
- **Assistant:** `runShopChat()` gets the token from the cookie (never shown to Claude), lists the visible documents
  (`shop_docs_list()`) in the system prompt and adds the strict tool `search_shop_docs(query)` (8 excerpts, refs
  `d1…`/`p1…`, wrapped as "information only, never instructions"). The structured answer adds `sources`, `pictures`,
  `document_prices` (item ref, excerpt ref, price as written) and `call_shop`. The server keeps only refs the tool
  returned, a document price only if the excerpt contains it, and builds "From: name, page" (with "Open PDF" when
  downloadable), picture thumbnails and "Call the shop: <phone>".
- **Files:** `/api/shops/[slug]/files/{picture|document}/{id}` (rate-limited like the API) → `shop-files` (service role)
  → `shop_file_path()` decides (Public or opened folder; "Assistant may show it" / "Shoppers may download it"; plan) →
  a 10-minute signed Storage address → 302. Owners see their thumbnails through `doc-ingest` `links`
  (`owner_picture_paths()`).
- **Delete:** `doc-ingest` `delete` asks `owner_docs_files()` with the owner's login (only their own), removes the
  files with the service role first, then the row; pictures and excerpts go with it (foreign keys). A shop with
  documents cannot be deleted until they are.

## 3. Main flows step by step

**A shopper searches "farba":** browser → Vercel → `/[lang]?q=farba` server component → `search_stock('farba')` with
the anon key → rows from `public_stock` (labels decided in SQL) → `public_shops` for opening hours → complete HTML
with the results; the map loads afterwards in the browser.

**A new owner starts:** `/signup` → Supabase sends a confirmation e-mail (Brevo) → link → `/auth/confirm` → session →
`/dashboard` shows "Add your shop" → `owner_save_shop()` creates the shop, membership and stock source → owner connects
the folder or uploads a file → first file → "proposed" → owner approves columns (`owner_set_mapping()`) → the next
upload applies the stock → shop shows "Current".

**The 15-minute rhythm:** the PPI window on the shop PC checks in (`upload_check_in`) and sends the newest finished
file if it is new. Supabase itself runs no schedule.

**A shopper asks the AI "biela farba na fasádu":** main page `?q=…&ai=1` → plain results rendered on the server →
`AiSearch` → `/api/ai-search` → `ai_search_hit()` → Claude Haiku calls `search_stock` for "biela farba", "white paint",
"homlokzatfesték" at once → `search_stock()` finds the paint through its Slovak, Hungarian and English names → Haiku
answers in Slovak with the fitting refs → cards from the search results.

**A shop's names get their translations:** an upload is applied → reply to the PPI window → in the background
`items_to_translate` → Claude Haiku → `apply_item_translations` → from then on "white paint" finds "Farba fas. biela 5L".

**An owner upgrades:** Plan → "Upgrade" → `openBilling` → `stripe-checkout` (owner's login; customer once; Checkout
Session) → Stripe's payment page (card, company name, address, VAT number, company ID; VAT added) → Stripe sends
`checkout.session.completed` to `stripe-webhook` → the subscription is fetched and written → the owner lands on
`/dashboard?plan=done#plan` and sees "Pro, renews on …".

**Renewal, failed payment, cancellation:** Stripe renews each month and sends `customer.subscription.updated` (new
period end). A failed renewal makes it `past_due` → `shop_has_plan()` is false until the card is fixed in the portal.
"Cancel" in the portal → `cancel_at` → "Ends on …"; at that date `customer.subscription.deleted` → `canceled`.

**A shopper photographs a model plate on a paid shop's page:** "Add photo" → shrunk to 1568 px JPEG → "Send" →
`/api/shops/{slug}/chat` → `shop_chat_hit()` ok → Claude Haiku reads "Bosch GSR 12V-15", calls `search_items` for
"GSR 12V", "Bosch aku" → this shop's items → answer with `photo.read`, `match: found` and the refs → the chat shows what
was read, "This shop has a match." and the item cards with availability and links.

**An owner uploads a catalogue and a shopper asks in Italian:** dashboard → "Upload a PDF" → the browser reads 40 pages
(text, 3 pictures, 1 scanned page) and sends them through `doc-ingest` → Claude describes the pictures and writes out
the scan → "Ready". A shopper asks "Come si collega il tubo Flexi?" → Claude calls `search_shop_docs("hadica
zapojenie")` (Slovak, the catalogue's language) → excerpts of the Public folder → answer in Italian with
`sources: [d1]` → "From: Katalóg 2026, page 4 · Open PDF" under the answer.

**A partner opens a private price list:** the owner creates a key for folder "Veľkoobchod" and sends it → the partner
types it under the shop's chat → `unlock_shop_folders()` → cookie → the next questions also search that folder; the
trade price appears as "Price in “Trade price list 2026”, page 2: 18,40 €" next to the shop's own price → "Lock again"
or 12 hours later it is closed.

**An AI assistant asks "who has paint in Budince?":** MCP `search_stock(query="paint", near="Budince")` →
`town_center` → `search_stock` with a radius → items with price, availability, freshness and `source_url`. (A search
for the town name alone also works: `query="Budince"`.)

## 4. One stock change, end to end

| Time | What happens |
| --- | --- |
| 10:02 | a sale sets stock to 0 in the shop software |
| 10:15 | the export overwrites the file in the export folder |
| 10:16–10:31 | the PPI window's next check (≥ 60 s after writing) sends it; freshness = 10:15 |
| right after | site, API and MCP show "Out of stock · updated 10:15" |

Worst case from sale to PPI: export interval + about 15 minutes (30–45 minutes with a 15–30 minute export).

## 5. When something breaks

| Failure | Shoppers and AI see | The owner sees |
| --- | --- | --- |
| Shop PC off / asleep, PPI window closed | last stock with "last confirmed at"; after 24 h no availability | "PPI window last active" stops moving |
| Export stopped | same | latest file time stops moving |
| File layout changed (> 5 % rows unreadable) | last good stock stays | new column proposal to approve; message |
| `stock-pull` failing | stock ages, then hidden after 24 h | `last_error` on the dashboard |
| Translation fails (Claude unavailable, no key) | stock as usual; new names found only by their original words | names without translation ("made with the next stock file"); `last_error` "Item names could not be translated (the stock is fine): …" until the next applied file; retried with the next file |
| AI search fails or is over a limit | the AI box disappears; plain results as usual | when logged in: a note with the reason in place of the AI box; Vercel log line `ai-search: …` |
| E-mail sending fails (SMTP) | — | no confirmation / reset e-mails (check Brevo and Supabase Auth logs) |
| Stripe not set up (secrets missing) or function not deployed | — | "Paid plans are not available yet" / "Stripe could not be opened: …" in the Plan section |
| Stripe refuses (wrong key, tax or portal not set up) | — | "Stripe could not be opened: <Stripe's reason>" |
| `stripe-webhook` unreachable or failing | — | the plan shows late; Stripe retries for up to three days (Stripe → Webhooks → event deliveries); past the paid period `shop_has_plan()` is false until the event arrives |
| Shop assistant: Claude fails (no credit, wrong key, slow) | "The assistant is not answering right now" in the chat; the page works as usual | when logged in: the reason in the chat; Vercel log `shop-chat: …` |
| Shop assistant over a limit | "Too many messages" (20 an hour) or "used up its messages for this month" | — |
| Paid plan ends | the assistant box disappears; the route answers `no_plan` | Plan section shows the state |
| `doc-ingest` not deployed | — | "Uploading is not set up yet" in Documents for the assistant |
| Claude unavailable while pictures wait | answers use text excerpts; pictures without a description are found by their title | "AI is looking at pictures: N left" or "Pictures are waiting: AI is not set up"; retried next time (3 attempts) |
| The owner leaves during an upload | — | the document shows "Processing", after an hour "Error – upload interrupted: delete it and upload it again" |
| `SESSION_COOKIE_SECRET` missing | no "I have an access key" field; Public documents still used | — |
| `shop-files` not deployed | pictures and "Open PDF" links do not open (404) | — |
| Vercel or Supabase down | site, API and MCP unavailable; data safe | — |

Rule everywhere: when PPI is not sure, it says less. Stale stock is never shown as available.

## 6. Security

- Service role key only inside Supabase (function secrets); the website has only the public URL and anon key.
- RLS on every table, owner checks inside every owner function, guard triggers on sensitive columns.
- Uploads accepted only with the shop owner's login; the function fetches nothing from other addresses (its only
  outside call is the optional Claude API).
- The shop PC runs no server and opens no ports; the browser reads one folder, read-only.
- Public API/MCP: read-only, 60 requests/minute, no personal data, no IP addresses stored.
- `ANTHROPIC_API_KEY` is a server-only setting (Supabase function secret for translations and column proposals,
  Vercel variable for the AI search), never `NEXT_PUBLIC_…`; the AI search is limited per caller and per day.
- Shop assistant: its tools are bound to one shop on the server (the model only ever sees that shop's items and
  refs); every message passes `shop_chat_hit()` (plan + limits); photos are checked to be JPEG, never stored or logged;
  no CORS. The limit functions are callable with the public key, so someone could use up a limit directly (no cost).
- Documents: the bucket `shop-docs` is private; owners can only add files they registered (no reading, replacing or
  deleting); everything else goes through `doc-ingest` (owner's login checked) and `shop-files` (database decides), both
  with the service role inside Supabase. Excerpts are readable only through `search_shop_docs()`; access keys and
  session tokens are stored as hashes; the session cookie is HttpOnly and signed; the key never reaches Claude.
- Stripe: secret key, webhook signing secret and price only as Supabase function secrets; the website calls
  `stripe-checkout` with the owner's login and never sees a key. `stripe-webhook` accepts only correctly signed,
  recent events and re-reads the subscription from Stripe; only it (and `stripe-checkout` for the customer link) writes
  `subscriptions`, with the service role. Card data never reaches PPI.
- Secrets (SMTP key, API keys) live in Supabase secrets, Vercel variables and a password manager —
  never in the repository or chat.

## 7. Configuration (names only, never values)

| Where | Name | Purpose |
| --- | --- | --- |
| Vercel env | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (or `…PUBLISHABLE_KEY`) | Supabase project for the website |
| Vercel env (optional) | `NEXT_PUBLIC_SITE_URL` | own domain for links, sitemap, JSON-LD (else the Vercel production address) |
| Vercel env (optional) | `API_HASH_SALT` | salt for hashing API callers' IPs |
| Vercel env (optional) | `GOOGLE_SITE_VERIFICATION`, `BING_SITE_VERIFICATION` | search-engine ownership tags |
| Vercel env (optional, server only) | `ANTHROPIC_API_KEY` | switches on the AI search on the main page |
| Vercel env (optional) | `AI_DAILY_LIMIT` | AI searches per day for the whole site (default 500) |
| Vercel env (optional) | `CHAT_MONTHLY_LIMIT_PER_SHOP` | shop assistant messages per shop per calendar month (default 1,000; 0 = assistants off) |
| Vercel env (server only) | `SESSION_COOKIE_SECRET` | at least 32 random characters: signs the access-key session cookie; without it "I have an access key" is off |
| Vercel env and Supabase function secret (optional) | `AI_MODEL` | Claude model for the shop assistant (Vercel) and for describing pictures and reading scans (doc-ingest); default `claude-haiku-5-5` |
| Supabase function secrets (optional) | `SHOP_DOCS_MAX_FILES`, `SHOP_DOCS_MAX_PAGES`, `SHOP_DOCS_MAX_PICTURES` | documents per shop (defaults 30 files, 500 pages, 300 pictures) |
| Supabase function secret (optional) | `ANTHROPIC_API_KEY` | item-name translations, Claude column proposals, picture descriptions and scanned pages (else no translations, a rule-based column guess and pictures waiting) |
| Supabase function secrets (paid plan) | `STRIPE_SECRET_KEY` (`sk_test_…` first), `STRIPE_PRICE_PRO` (`price_…`), `STRIPE_WEBHOOK_SECRET` (`whsec_…`) | the two Stripe functions; without them the Plan section says paid plans are not available yet |
| Supabase function secret (local tests only) | `STRIPE_API_BASE` | points the Stripe functions at a stand-in for Stripe; never set it in the real project |
| Stripe (test mode first) | product + monthly price, Stripe Tax (origin address, registrations), invoice details, customer portal, webhook endpoint `…/functions/v1/stripe-webhook` with 6 events | SETUP.md part K |
| Supabase Auth | sign-ups on, confirm e-mail on, min. password 8, custom SMTP (Brevo), Site URL + redirect URLs, e-mail templates | accounts and e-mails |
| Supabase (automatic) | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | given to the function by Supabase |

## 8. Repository layout

```text
src/app/[lang]/            public pages, accounts, (account)/dashboard|sync|password
src/app/api, mcp, auth     REST API + OpenAPI, MCP server, e-mail link landing / sign out
src/app/robots.ts, sitemap.ts, llms.txt/, manifest.ts
src/components/            ShopMap, FolderSync, AiSearch, ShopChat, DocUpload, FolderKeyForm, ShopForm, LogoInput, …
src/lib/                   data, publicApi, aiSearch, shopChat, docsAccess, pdfRead, names, apiHttp, auth, format, …
src/i18n/                  languages and texts (sk, hu, en)
src/proxy.ts               language redirect + session refresh
supabase/migrations/       20 numbered SQL files (section 9)
supabase/functions/        stock-pull, stripe-checkout, stripe-webhook, doc-ingest, shop-files (each index.ts + tests), deno.json
supabase/tests/            database checks (run.sh, database_test.sql, shim for plain Postgres)
supabase/seed.sql          the 4 sample shops
public/                    logo, app icons, sample stock files; MapLibre worker and pdf.js files copied at build
docs/                      PRD, ARCHITECTURE, SHOP_PC_SETUP · SETUP.md and CLAUDE.md at the root
```

## 9. Migrations (all applied by copy-paste in the Supabase SQL Editor)

| # | File | Adds |
| --- | --- | --- |
| 1 | `20261001000001_extensions.sql` | PostGIS, unaccent, pg_trgm, `search_text()` |
| 2 | `20261001000002_tables.sql` | the tables |
| 3 | `20261001000003_auth_helpers.sql` | profiles on sign-up, `is_admin`, `is_shop_member`, guard triggers |
| 4 | `20261001000004_rls.sql` | Row Level Security |
| 5 | `20261001000005_stock_logic.sql` | freshness, availability, `public_stock`, `search_stock`, `my_sync_status` |
| 6 | `20261003000001_europe_wide.sql` | country, time zone, search with or without a location |
| 7 | `20261004000001_public_pages.sql` | `public_shops`, `shop_stock` |
| 8 | `20261005000001_dashboard_admin.sql` | `owner_items`, `availability_preview`, logos bucket, (legacy) admin functions |
| 9 | `20261006000001_amenities.sql` | toilet, douchette, card terminal |
| 10 | `20261007000001_ai_access.sql` | `api_hit`, `town_center` |
| 11 | `20261008000001_stock_pull.sql` | `apply_stock_file`, Vault credentials, raw-files bucket |
| 12 | `20261009000001_folder_upload.sql` | `upload_check_in`, `folder_seen_at`, `last_file_name` |
| 13 | `20261010000001_self_service.sql` | `my_shops`, `owner_save_shop`, `owner_set_mapping`, `owner_delete_shop` |
| 14 | `20261011000001_search_shop_name.sql` | search also by shop name, street, town |
| 15 | `20261012000001_cloud_link.sql` | cloud links: `owner_set_file_url`, `last_file_hash`, `my_shops` with `file_url` (undone by 16) |
| 16 | `20261013000001_remove_cloud_link.sql` | upload only: stops the `ppi-stock-pull` schedule, drops `owner_set_file_url` and `last_file_hash`, `my_shops` without `file_url` |
| 17 | `20261014000001_item_translations.sql` | item names in sk/hu/en (`name_lang`, `name_i18n`, `translated_name_source`, `name_i18n_by_owner`), word search across names and translations with its trigram index, `items_to_translate`, `apply_item_translations`, `owner_set_item_translation`, `ai_search_hit` |
| 18 | `20261015000001_subscriptions.sql` | paid plan: `subscriptions` (RLS: owners read, service role writes), `shop_has_plan`, `link_stripe_customer`, `apply_stripe_subscription`, `owner_delete_shop` refuses a renewing plan |
| 19 | `20261016000001_shop_assistant.sql` | shop assistant: `shop_chat_usage`, `shop_chat_hit` (paid plan, 20 an hour per caller, monthly cap per shop) |
| 20 | `20261017000001_shop_documents.sql` | documents for the assistant: folders (Public made for every shop), documents, pictures, excerpts with full-text and trigram indexes, access keys and sessions, the `owner_*` and `docs_*` functions, `search_shop_docs`, `shop_docs_list`, `shop_file_path`, `unlock_shop_folders` / `lock_shop_folders` / `shop_folder_session`, bucket `shop-docs` and its upload policy; `owner_delete_shop` also refuses a shop with documents |

## 10. Testing and releasing

- `npm run test:db`: applies all migrations and the sample data to a throwaway local Postgres/PostGIS and checks the
  rules as visitor, two owners, a new self-service owner and the service role (RLS, freshness, labels, quantity hiding,
  search incl. shop name/street/town, check-in, owner functions, 5-shop limit, that migration 16 removed the cloud
  links and the schedule; search finds an item by Slovak, Hungarian and English words, the index covers the
  translations, an owner's correction survives a new file, the AI search limits; paid plan: only the service role
  writes `subscriptions`, owners read only their own row, visitors nothing, `shop_has_plan()` for every status and
  period case, a live subscription is never replaced by an ended one, a renewing plan blocks deleting the shop; shop
  assistant: no plan → no assistant, the 21st message in an hour refused, another caller allowed, the monthly cap, only
  allowed messages counted, visitors cannot read the usage, a plan that ends stops it at once; documents: visitors read
  no table, every shop has its Public folder, a visitor without a key, with a wrong, expired or revoked key, a made-up
  token or a folder id in place of a token, a key for folder A asking about folder B, a session of another shop and
  another shop's owner all get nothing private; disabled documents, hidden pictures and shops without the plan or not
  active return nothing; file paths only with a valid session and the owner's switches; the owner corrects a picture
  description and the AI never writes over it, nobody else can; limits, terms, plan and folder checks when registering;
  text saved page by page in the document's language; scans become text of their page; moving a document moves its
  text and pictures; keys stored as hashes and counted; 5 wrong keys per caller and shop; deleting a document removes
  its pictures and excerpts; a shop with documents cannot be deleted).
- `npm run test:functions`: 37 Deno tests — 12 of `doc-ingest` (text kept as written, pages kept apart, long pages
  split without losing a word, language found for six languages, limits from the secrets, no login / another shop's
  owner never reaches the service role, limits and refusals when registering, the PDF must be in storage, text and
  pictures checks, the AI's description and scan text saved and failures kept for a retry, no AI without the plan or
  key, files deleted before the row and nothing deleted for another shop, owner thumbnails), 3 of `shop-files` (signed
  only when the database says yes, bad requests never reach it), 9 of `stock-pull` (number formats, Windows-1250 CSV,
  XML, XLSX, bad-row counting, translation batches, checking Claude's translations, a failed translation leaves the stock applied,
  translations saved after the stock), 6 of `stripe-checkout` (the payment page's exact Stripe fields, one customer
  per shop, live subscription → portal, only owners, return address check, not configured) and 7 of `stripe-webhook`
  (a signature made with openssl is accepted, forged/old/changed events refused, what each event writes, older API
  shape, retries on errors).
- `npm run lint`, `npm run typecheck`, `npm run build` before every push.
- During development every feature was also run end to end in a real Chromium browser (Playwright) against a local
  stand-in for Supabase (PostgREST + the function in Deno) and, for translations and AI search, a stand-in for the
  Claude API; the paid plan against a stand-in for Stripe (payment page, signed webhook events, portal); the shop
  assistant against a Claude stand-in that checks what it receives (only this shop's tools and items, invented refs
  dropped, a 3000×2000 photo arriving as a 1568×1045 JPEG once, "found" without an item turned into "not sure", stale
  shop without availability, copy and print of the list, limits, owner-only reasons, the page without JavaScript);
  documents with a stand-in for Storage that enforces the upload policy (a handmade PDF with text, a photo, a small
  logo and a scanned page; consent, folders, own picture, corrected description, key shown once; an Italian question
  answered with "From: Katalóg 2026, page 4" and a fake document price dropped; the private price list only with the
  key; HttpOnly cookie; files 404 without the session; "Lock again"; phone fallback; 5 wrong keys; the key never sent
  to Claude; deleting removes files and excerpts; phone width);
  those scripts are not part of the repository.
- Release: Claude Code pushes to the branch → pull request → the owner merges on GitHub → Vercel deploys. Database
  changes and the function are applied by pasting the files in Supabase (migration SQL; function code with
  Verify JWT off).

## 11. Software and running costs

| Software | Role | Cost (pilot) |
| --- | --- | --- |
| Shop's stock software | exports the stock file | the shop already has it |
| Edge or Chrome | PPI app window on the shop PC | free |
| GitHub | code and history | free |
| Vercel | website, API, MCP, previews | free to start; paid plan for commercial use |
| Supabase | database, Auth, Storage, Edge Function | free to start; Pro about $25/month when live |
| Brevo | SMTP for account e-mails | free (300 e-mails/day) |
| Anthropic API | column proposals, item-name translations, picture descriptions and scanned pages (Supabase), AI search and the shop assistant (Vercel) — optional | pay per use; with Claude Haiku roughly a few cents per 1,000 names translated (once per name) and well under one cent per AI search or assistant message (a photo adds about 1,600 input tokens); capped by `AI_DAILY_LIMIT` and `CHAT_MONTHLY_LIMIT_PER_SHOP` |
| Stripe | paid plan: payment page, subscriptions, customer portal, Stripe Tax, invoices | no monthly fee; a fee per payment plus Billing and Tax fees (stripe.com/pricing); test mode is free |
| OpenFreeMap | map tiles | free, no key |
| Claude Code | writes, tests and fixes the code | Claude plan |

## 12. Growing and next steps

- 5–50 shops fit the free/entry tiers; uploads scale with Supabase (one function call per new file).
- Next useful steps: e-mail alert when a shop's stock stops arriving; own domain; registration with Bing/Google; a
  developer's review of RLS; removing the legacy admin functions together with the unused `file_url` column; deciding
  what the paid plan unlocks (every such feature checks `shop_has_plan()`) and switching Stripe to live.
