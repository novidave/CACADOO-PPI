# Architecture (as built)

Status 8 October 2026. How PPI works from the shop's stock file to a shopper's screen and an AI assistant's answer:
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
  Auth (e-mail + password, SMTP via Brevo) | Storage (logos, raw files)
                                   |
WEBSITE (Next.js 16 on Vercel)     v
  server-rendered pages + JSON-LD | owner dashboard | /sync app | robots, sitemap, llms.txt
  public API /api/v1 + OpenAPI    | MCP server /mcp | /api/ai-search (Claude Haiku + search_stock)
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

**Tables:** `shops`, `shop_members`, `products`, `shop_items`, `inventory`, `sync_sources`, `profiles`, `api_usage`
(columns in PRD section 7).

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
| `town_center(town)` | "near Budince" for API/MCP: middle of the active shops in that town (no outside geocoding) |
| `api_hit(ip_hash, endpoint, limit)` | rate limit (60/min) and usage log |
| `apply_stock_file(...)` | stock writing — service role only |
| `my_shops()`, `owner_save_shop(p)`, `owner_set_mapping(shop, mapping)`, `owner_delete_shop(shop)`, `owner_items(...)`, `availability_preview(threshold)`, `my_sync_status(shop)`, `upload_check_in(shop)` | the owner dashboard; each checks that the caller owns the shop |

**Guards:** triggers stop clients from changing a shop's page address, company ID or visibility flag directly
(`guard_shop_update`; the owner functions run as the database owner and may), from writing stock results into
`sync_sources` (`guard_sync_source_write`), from setting `is_admin` (`guard_profile_update`), and from saving an unknown
time zone (`guard_shop_timezone`). A profile row is created for every new account (`handle_new_user`).

**Row Level Security** is on for every table; visitors use only the public views/functions; owners reach only shops
where they are in `shop_members`; `inventory` and stock results are written only by the service role.

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
  visibility, logo, item visibility, translation correction, delete); each form returns to its own section with its
  message.
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
  searches and 12 searches in total, 30 seconds; then the model must answer. The final answer is structured output:
  language, a short answer, and the refs (`r1`, `r2`, … given in the tool results) of the fitting items.
- Cards are built from the search results only (unknown refs are dropped), in the page language: name + translation,
  brand, price, shop, place, availability + freshness, link to the item page. The searched terms are shown.
- No key, over a limit, a refusal or any error → `{fallback: true}` and the AI box disappears; the plain results stay.
  No CORS headers: only the PPI website calls it.

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
| Translation fails (Claude unavailable, no key) | stock as usual; new names found only by their original words | names without translation ("made with the next stock file"); retried with the next file |
| AI search fails or is over a limit | the AI box disappears; plain results as usual | — |
| E-mail sending fails (SMTP) | — | no confirmation / reset e-mails (check Brevo and Supabase Auth logs) |
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
| Supabase function secret (optional) | `ANTHROPIC_API_KEY` | item-name translations and Claude column proposals (else no translations and a rule-based column guess) |
| Supabase Auth | sign-ups on, confirm e-mail on, min. password 8, custom SMTP (Brevo), Site URL + redirect URLs, e-mail templates | accounts and e-mails |
| Supabase (automatic) | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | given to the function by Supabase |

## 8. Repository layout

```text
src/app/[lang]/            public pages, accounts, (account)/dashboard|sync|password
src/app/api, mcp, auth     REST API + OpenAPI, MCP server, e-mail link landing / sign out
src/app/robots.ts, sitemap.ts, llms.txt/, manifest.ts
src/components/            ShopMap, FolderSync, AiSearch, ShopForm, LogoInput, InstallApp, StockLine, OpenStatus, …
src/lib/                   data, publicApi, aiSearch, names, apiHttp, auth, format, hours, folderStore, supabase/*
src/i18n/                  languages and texts (sk, hu, en)
src/proxy.ts               language redirect + session refresh
supabase/migrations/       17 numbered SQL files (section 9)
supabase/functions/        stock-pull (index.ts + tests), deno.json
supabase/tests/            database checks (run.sh, database_test.sql, shim for plain Postgres)
supabase/seed.sql          the 4 sample shops
public/                    logo, app icons, sample stock files, MapLibre worker
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

## 10. Testing and releasing

- `npm run test:db`: applies all migrations and the sample data to a throwaway local Postgres/PostGIS and checks the
  rules as visitor, two owners, a new self-service owner and the service role (RLS, freshness, labels, quantity hiding,
  search incl. shop name/street/town, check-in, owner functions, 5-shop limit, that migration 16 removed the cloud
  links and the schedule; search finds an item by Slovak, Hungarian and English words, the index covers the
  translations, an owner's correction survives a new file, the AI search limits).
- `npm run test:functions`: 9 Deno tests of `stock-pull` (number formats, Windows-1250 CSV, XML, XLSX, bad-row
  counting, translation batches, checking Claude's translations, a failed translation leaves the stock applied,
  translations saved after the stock).
- `npm run lint`, `npm run typecheck`, `npm run build` before every push.
- During development every feature was also run end to end in a real Chromium browser (Playwright) against a local
  stand-in for Supabase (PostgREST + the function in Deno) and, for translations and AI search, a stand-in for the
  Claude API; those scripts are not part of the repository.
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
| Anthropic API | column proposals, item-name translations (Supabase) and AI search (Vercel) — optional | pay per use; with Claude Haiku roughly a few cents per 1,000 names translated (once per name) and well under one cent per AI search; capped by `AI_DAILY_LIMIT` |
| OpenFreeMap | map tiles | free, no key |
| Claude Code | writes, tests and fixes the code | Claude plan |

## 12. Growing and next steps

- 5–50 shops fit the free/entry tiers; uploads scale with Supabase (one function call per new file).
- Next useful steps: e-mail alert when a shop's stock stops arriving; own domain; registration with Bing/Google; a
  developer's review of RLS; removing the legacy admin functions together with the unused `file_url` column.
