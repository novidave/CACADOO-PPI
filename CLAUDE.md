@AGENTS.md

# PPI — rules for Claude Code

Read `docs/PRD.md` (what to build) and `docs/ARCHITECTURE.md` (how it fits together) first.
Setup steps for humans are in `SETUP.md`.

## Hard rules

- **Never** put the Supabase service role / secret key in the web app, `.env*`, Vercel or the repo.
  Anything that needs it (stock pull, inviting owners) is a Supabase Edge Function.
- Public pages (home, shop, item) load data in **server components** via `@/lib/supabase/server`.
  Never fetch public data in the browser: crawlers and AI assistants read only the first HTML.
- Freshness, availability labels and quantity hiding live **in the database**
  (`freshness_label`, `availability_label`, `public_stock`, `search_stock`). Never recompute them in React.
  Visitors read stock only through `public_stock` / `search_stock`, never `inventory`.
- Every database change is a new file in `supabase/migrations/` (never edit an applied one).
  Add a check to `supabase/tests/database_test.sql` for every rule you add.
- **Europe-wide, no home town.** Never hard-code a city, country, currency or time zone.
  **No location services**: the website never asks for or guesses the visitor's location (no device location,
  no IP lookup). Search is text only — item name, brand, EAN, shop name, street or town — across all shops.
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
- `npm run test:functions` — unit tests of the stock-pull file reading and mapping (Deno)

## AI access

`src/lib/publicApi.ts` is the single source for the public API (`/api/v1/*`, OpenAPI at `/api/openapi.json`)
and the MCP server (`/mcp`, stateless Streamable HTTP, tools `search_stock`, `get_shop`, `get_item`):
anon client without cookies (`@/lib/supabase/public`), every result carries `source_url`, the database
decides availability/quantity. Every API/MCP request goes through `rateLimit` (`api_hit`: 60/min, daily-salted
IP hash). `robots.ts`, `sitemap.ts` and `llms.txt` live at the app root.

## Stock upload

`supabase/functions/stock-pull/index.ts` (single file, paste-deployable) only receives uploads:
`POST ?shop_id=&file_time=&file_name=[&gzip=1]` with the owner's (or legacy admin's) JWT, checked by `upload_check_in()`.
It downloads nothing and runs on no schedule (cloud links and the cron pull were removed on 2026-10-08, migration 16).
A file not newer than `latest_file_time` is skipped; XML/CSV(UTF-8 or Windows-1250)/XLSX → rows; mapping proposals
(Claude with structured outputs, else `guessMapping`) are never auto-approved; `apply_stock_file()` writes a full file
in one transaction (missing items → quantity 0). >5 % unreadable rows → keep old stock, propose a new mapping.

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
