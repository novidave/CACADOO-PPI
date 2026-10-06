# PPI — Product Requirements

Version 1.1 · MVP web app for finding in-stock products in local shops, built for the whole European market (first pilot shops: Michalovce, Slovakia). Nothing in the product is tied to one town, country, currency or time zone.

**How to use this:** save this document in the code repository as `docs/PRD.md` and give it to Claude Code together with the phase prompts in Build blueprint (Claude Code), one phase at a time. Check each phase before starting the next.

## 1. Product summary

PPI shows shoppers which local shops have a product in stock right now, how much it costs and how fresh that information is. Shop stock arrives automatically: the shop's own software exports a file to a folder, the PPI app window on the shop PC (Edge or Chrome) uploads the newest file every 15 minutes, and a Supabase Edge Function, with AI-assisted field mapping, reads that file and writes the stock into Supabase. The web app only reads stock. It never writes inventory.

**Goal of the MVP:** a shopper anywhere in Europe searches a product and finds a nearby shop that really has it, with no wasted trip. Every page and every answer must also be readable by AI assistants and search engines directly, without Google Merchant Center.

## 2. Users and roles

| Role | Who | Can do |
| --- | --- | --- |
| Visitor | Any shopper, no login | Search, browse shops and products, see map, switch language |
| Shop owner | Signs up by themselves (e-mail + password) | Create and edit own shops (up to 5), connect the export folder, approve the stock-file columns, choose stock visibility, hide items, delete own shop |

Self-service: owners sign up, create their shop and connect their stock without any help. There is no admin area on the website; the operator uses the Supabase dashboard if ever needed.

## 3. Scope

**In the MVP**

- Product search by text (item, brand, EAN, shop name, street, town) across all shops, with a map of the results
- Shop pages and product pages
- Freshness labels on all stock
- Self-service sign-up and shop owner dashboard (no admin area on the website)
- Slovak (default), Hungarian and English
- Mobile-first design

**Not in the MVP**

- Online ordering, payments, reservations or pickup
- Reviews or ratings
- Shop self-signup
- Writing anything back to the shop's software
- Google Merchant Center (deliberately not used; AI readability replaces it)
- Native mobile apps

## 4. Technical constraints

- Stack: Next.js (App Router, TypeScript) hosted on Vercel, with the Supabase project as the backend. Built with Claude Code; every database change is a migration in the repository.
- Enable the PostGIS extension. Store shop locations as `geography(Point, 4326)`.
- All stock and sync data is written by the stock-pull Edge Function using the service role key (the shop PC only uploads the file to it; `upload_check_in()` records when the PPI window was last active). The frontend must never contain or use the service role key.
- Put freshness and availability logic in the database (a view and SQL functions), not in React, so the website and any future integration show the same result.
- Row Level Security on every table. Public pages must load their data on the server (Next.js server components), never in the browser, so the first HTML already contains names, prices and availability.
- No built-in home town and no location services: the website never uses the visitor's device location or an IP lookup. Search is by text across every shop.
- Times stored in UTC. Every shop has an IANA time zone (`shops.timezone`, e.g. `Europe/Vienna`); opening hours and "last confirmed at" times use the shop's time zone.
- Every price carries its own currency (EUR, HUF, CZK, PLN, CHF, …), written the visitor's way with local symbols: `12,90 €` (sk), `1890 Ft` (hu), `€12.90` (en).
- Languages: SK, HU, EN to start; adding a language is one text file. Browsers asking for a language PPI does not have yet get English.

## 5. Data model

| Table | Columns | Notes |
| --- | --- | --- |
| `shops` | `id` uuid, `slug` text unique, `name` text, `ico` text, `address` text, `city` text, `country` text (ISO code, e.g. `SK`), `timezone` text (IANA, default `UTC`), `location` geography point, `phone` text, `website` text, `opening_hours` jsonb, `visibility_mode` text (`exact` \| `in_stock` \| `yes_no`), `low_stock_threshold` int default 3, `logo_url` text, `is_active` bool, `created_at` | Public read when `is_active` |
| `shop_members` | `shop_id`, `user_id`, `role` (`owner`) | Links logins to shops |
| `products` | `id`, `ean` text, `brand` text, `name` text, `category` text | One row per real product, matched by EAN |
| `shop_items` | `id`, `shop_id`, `source_code` text, `product_id` nullable, `name` text, `ean` text, `is_public` bool default true, `updated_at` | Unique on (`shop_id`, `source_code`) |
| `inventory` | `shop_item_id` primary key, `quantity` numeric, `price` numeric, `currency` text default 'EUR', `source_updated_at` timestamptz, `received_at` timestamptz | One current row per item; written only by the stock-pull function |
| `sync_sources` | `id`, `shop_id`, `file_format` text, `field_mapping` jsonb, `mapping_status` (`proposed` \| `confirmed`), `file_url` text, `latest_file_time` timestamptz, `last_checked_at` timestamptz, `last_error` text | Admin only |
| `profiles` | `user_id`, `display_name`, `language` (`sk` \| `hu` \| `en`), `is_admin` bool | `is_admin` only settable by admin |

`opening_hours` format: `{"mon":[["08:00","17:00"]],"tue":[...],...,"sun":[]}`. Multiple ranges per day allowed for lunch breaks.

## 6. Business rules

### Freshness

Freshness comes from the shop's `sync_sources.latest_file_time`, not from individual rows.

| Age of latest file | State | Shown to visitors |
| --- | --- | --- |
| under 30 min | `current` | Stock as below, plus "Updated X min ago" |
| 30 min – 24 h | `recent` | Stock as below, plus "Last confirmed today at 14:05" (or "yesterday at") |
| over 24 h, or no file ever | `stale` | No stock status. Text: "Stock information not currently available" |

Create a SQL function `freshness_state(shop_id)` returning `current`, `recent` or `stale`, and the age in minutes.

### Availability shown per shop's visibility mode

| `visibility_mode` | quantity > threshold | 0 < quantity ≤ threshold | quantity ≤ 0 |
| --- | --- | --- | --- |
| `exact` | "12 in stock" | "2 in stock" | "Out of stock" |
| `in_stock` | "In stock" | "Low stock" | "Out of stock" |
| `yes_no` | "Available" | "Available" | "Not available" |

If freshness is `stale`, availability is never shown, whatever the quantity.

Exact quantities must never reach the browser for shops not in `exact` mode. Compute the label in the database.

### Public view

Create a view `public_stock` that joins `shop_items` (only `is_public`), `inventory`, `shops` (only `is_active`) and the freshness state, and returns: item id, item name, EAN, brand, shop id, shop slug, shop name, shop location, price, availability label key, freshness state, freshness age, `latest_file_time`. It never returns raw quantity unless the shop uses `exact` mode.

### Search

Create an RPC `search_stock(q text, lat float, lng float, radius_km float, only_available bool)` (`lat`/`lng` optional: without them every shop is searched and distance is empty):

- Matches `q` against item name, brand and EAN, case- and accent-insensitive (use `unaccent`), so "kava" finds "káva"
- Returns rows from `public_stock` within the radius, with distance in km
- Sort: available first, then fresher, then nearer
- `only_available` true hides out-of-stock and stale rows
- Limit 50

### Open now

A shop is "Open now" if the current time in the shop's own time zone falls in today's ranges in `opening_hours`. Show "Opens at 08:00" or "Closes at 17:00" where helpful.

## 7. Security (Row Level Security)

| Table | Visitor | Shop owner | Admin |
| --- | --- | --- | --- |
| `shops` | read active | read and update own (not `slug`, `ico`, `is_active`) | all |
| `shop_members` | none | read own | all |
| `products` | read | read | all |
| `shop_items` | read public items of active shops | read own; update only `is_public` | all |
| `inventory` | none directly (use `public_stock`) | read own | read |
| `sync_sources` | none | read own `latest_file_time` and `last_error` only (via a function) | all |
| `profiles` | none | read and update own, except `is_admin` | all |

No client can insert or update `inventory` or `sync_sources`; only the service role (the stock-pull function) can.

## 8. Pages and requirements

### 8.1 Home and search (`/`)

- Search box at the top, map below, results list beside it on desktop or below it on mobile
- No location: every shop is searched; the text matches item name, brand, EAN, shop name, street or town
- Filter: "Only available now"
- Each result: item name, shop name, street and town, price, availability label, freshness text, "Open now" badge
- Map pins per shop; tapping a pin highlights that shop's results
- Empty state: "No shop has this right now"

Acceptance:

- [ ] Searching "kava" returns items named "Káva"
- [ ] A shop with a 25-hour-old file shows no availability, only the unavailable text
- [ ] Results load in under 2 seconds on mobile with 5,000 items

### 8.2 Shop page (`/shops/:slug`)

- Name, logo, address, phone, website, map pin, opening hours for the week, "Open now"
- Freshness banner: "Stock updated 8 min ago" or the unavailable text
- Searchable, paginated list of the shop's public items with price and availability
- "Get directions" link opening Google Maps with the shop's coordinates
- Page title and meta description in the current language; JSON-LD for `LocalBusiness`

### 8.3 Item page (`/items/:id`)

- Item name, brand, EAN, price, availability, freshness, shop card with directions
- "Also available at": other shops with the same EAN, nearest first
- JSON-LD `Product` with `Offer` (price, currency, availability), only when freshness is not `stale`

### 8.4 Login (`/login`)

- E-mail + password via Supabase Auth: `/signup` (confirmation e-mail), `/login`, `/forgot` (reset link by e-mail) and `/password` (change password, also the landing page of the reset link)
- After login: `/dashboard`

### 8.5 Shop owner dashboard (`/dashboard`)

- Sync status card: latest file time, freshness state as text (Current / Recent / Stale), last error in plain words
- Shop details form: phone, website, opening hours editor (per day, multiple ranges, closed toggle), logo upload to Supabase Storage
- Visibility mode selector with a live preview of how an item will look to shoppers
- Low stock threshold (number, 1–50)
- Facilities for customers (tick boxes): customer toilet, douchette (bidet shower), card terminal. Shown on the shop page (toilet and douchette under the stock line, card payment under the opening hours) and in its JSON-LD (`amenityFeature`, `paymentAccepted`). Set by the owner.
- Items table: name, code, price, stock label, public toggle; search and pagination

Acceptance:

- [ ] Owner of shop A cannot see or change anything of shop B
- [ ] Switching to `yes_no` immediately hides exact numbers on public pages

### 8.6 Self-service (no admin area)

- A logged-in user without a shop sees the "Add your shop" form: name, address, town, country, time zone, location on a map, phone, website, opening hours, facilities, "Visible to shoppers". The page address (slug) is made from name and town.
- Export folder section on the dashboard: rules for the stock software's export and the folder connection itself (same as `/sync`).
- Stock file columns: after the first file, the AI-proposed mapping is shown as one drop-down per field next to the file's first rows; the owner approves it (`mapping_status` = `confirmed`).
- Delete shop (with a confirmation tick).

### 8.7 AI and machine access

Any AI assistant or search engine must be able to read PPI's stock directly.

**Server-rendered pages**

- Home, shop and item pages load their data on the server (Next.js server components). With JavaScript turned off, each page still shows item names, prices, availability and "updated at".
- Every shop page has JSON-LD `LocalBusiness` (address, geo, opening hours); every item page has `Product` with `Offer` (price, currency, availability). Leave availability out when the shop is stale.
- Canonical URL, title and description in the page's language.

**Discovery files**

- `/robots.txt`: allow all crawlers, including GPTBot, ClaudeBot and PerplexityBot; disallow the login-only pages.
- `/sitemap.xml`: every active shop and public item page, `lastmod` set to the shop's latest file time.
- `/llms.txt`: plain text on what PPI is, what data it holds, how fresh it is, and links to the API docs and MCP server.

**Public read API** (server routes or Supabase Edge Functions; no login)

- `GET /api/v1/search?q=&lat=&lng=&radius_km=&only_available=`: same results as `search_stock`
- `GET /api/v1/shops` and `GET /api/v1/shops/{slug}`: shop details and freshness
- `GET /api/v1/shops/{slug}/items?page=`: public items
- `GET /api/openapi.json`: OpenAPI description of the above
- JSON only, open CORS, 60 requests per minute per IP, each request logged to `api_usage` (hashed IP, endpoint, time)
- Every item returned includes price, currency, availability, freshness state, `updated_at`, shop name, address and coordinates, and `source_url` (the PPI page) so assistants can cite it
- Never return exact quantity for shops not in `exact` mode; never return availability for stale shops

**MCP server** at `/mcp` (Streamable HTTP, read-only, no login)

- Tools: `search_stock(query, near, radius_km)`, `get_shop(slug)`, `get_item(id)`
- Same data and rules as the API; results include source URLs
- `near` accepts a town name or coordinates; without it, every shop is searched

Acceptance:

- [ ] `curl -A "GPTBot" https://<domain>/shops/<slug>` returns HTML containing item names and prices
- [ ] A stale shop's page, API response and MCP result contain no availability
- [ ] An AI assistant connected to `/mcp` answers "who has X in <town>?" with the right shop and update time

## 9. Design

- Mobile-first; most visitors are on phones
- Map: light-grey street map (OpenFreeMap "positron" tiles: free, no API key, commercial use allowed) with black dot pins; the visitor's position is a hollow ring
- Clean, local and trustworthy; avoid e-commerce look (no cart icons)
- Plain white background with black text and thin light-grey lines. No brand colours, no coloured status badges, no dark mode (decided 2026-10-01; replaces the earlier blue/green/amber palette)
- Availability always written out as text (e.g. "Low stock"), emphasised with bold weight, never with colour
- Freshness text always next to any availability label
- Language switch in the header: SK · HU · EN; remember the choice

## 10. Texts (Slovak default)

| Key | SK | HU | EN |
| --- | --- | --- | --- |
| in\_stock | Na sklade | Raktáron | In stock |
| low\_stock | Málo na sklade | Kevés raktáron | Low stock |
| out\_of\_stock | Vypredané | Elfogyott | Out of stock |
| available | Dostupné | Elérhető | Available |
| not\_available | Nedostupné | Nem elérhető | Not available |
| updated\_ago | Aktualizované pred {n} min | {n} perce frissítve | Updated {n} min ago |
| stale | Informácia o zásobe momentálne nie je dostupná | A készletinformáció jelenleg nem elérhető | Stock information not currently available |
| open\_now | Otvorené | Nyitva | Open now |

Have a native speaker check the Hungarian and Slovak texts before launch.

## 11. Build order

Build in the phases of Build blueprint (Claude Code): foundation, database, public pages, login and dashboard, AI access, stock pull, then the shop PC setup. Each phase ends with its own checks; do not start the next until they pass.

## 12. Launch checklist

- [ ] Row Level Security reviewed by a developer, not only by the AI that wrote it
- [ ] Service role key only in Supabase function secrets, never in the web app or the repository
- [ ] Test data removed; every public page checked with JavaScript turned off
- [ ] Stale shops show no stock on every page
- [ ] Texts checked by native speakers
- [ ] Custom domain connected
- [ ] Privacy page and terms page (shop data use, cookies)
