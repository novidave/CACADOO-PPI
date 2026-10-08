# PPI — Product Requirements (as built)

Version 2.0 · status 8 October 2026 · live at <https://cacadooppivercel.vercel.app> (brand: **Cacadoo PPI**)

This document describes **what PPI is and what it does today**. How the parts work together is in
`docs/ARCHITECTURE.md`; setup steps for people are in `SETUP.md` and `docs/SHOP_PC_SETUP.md`.
Claude Code reads this file first, so keep it true: when a feature changes, change this file in the same commit.

## 0. Status at a glance

| Area | Status |
| --- | --- |
| Public search, shop pages, item pages, map | Live |
| Slovak, Hungarian, English | Live |
| Sign-up, log-in, forgotten password, change password (e-mail + password) | Live (e-mail through Brevo SMTP) |
| Owner dashboard: create shop, details, logo, opening hours, facilities, visibility, items | Live |
| Stock from the shop PC: PPI app window watching the export folder | Built and tested |
| Stock by hand: "Upload file" | Live, tested by the owner |
| Stock from a cloud **file** link (OneDrive, Google Drive, Google Sheets, Dropbox) | Live, tested by the owner with OneDrive |
| Stock from a cloud **folder** link | Built; the first OneDrive folder test did not work, so file links are the recommended way |
| AI field mapping (Claude) with owner approval | Live (rule-based guess when no Anthropic key is set) |
| AI access: server-rendered pages, JSON-LD, robots.txt, sitemap, llms.txt, public API, MCP server | Live; MCP verified with Claude |
| Found by web search (Google, Bing → ChatGPT, Grok, …) | Waiting: site not yet registered with Google/Bing (SETUP.md part I) |
| E-mail alerts when a shop's stock stops arriving | Not built |
| Sample shops from the build (4 shops) | Still in the database: remove before launch (SETUP.md part D) |

## 1. Product summary

PPI shows shoppers which local shops have a product in stock **right now**, at what price, and how fresh that
information is. It works anywhere in Europe: any town, country, currency and time zone; nothing is tied to one place.

Shops keep using their own stock software. That software exports a stock file (XML, CSV or Excel) every 15–30
minutes, and the file reaches PPI in one of three ways: the PPI app window on the shop PC sends it, the owner uploads
it by hand, or PPI downloads it from a cloud link. PPI reads the file, matches its columns (proposed by AI, approved
once by the owner) and publishes the stock. The time of the file is the freshness that shoppers see.

**Goal:** a shopper searches a product, a shop name or a street and finds a shop that really has it, without a wasted
trip. Every page and answer is also readable by AI assistants and search engines directly, without Google Merchant
Center.

## 2. Users and roles

| Role | Who | Can do |
| --- | --- | --- |
| Visitor | Any shopper, no login | Search, browse shops and items, see the map, switch language |
| Shop owner | Anyone who signs up (e-mail + password) | Create up to 5 shops; edit details, logo, opening hours, facilities; send stock (folder, file upload, cloud link); approve the stock file's columns; choose what shoppers see; hide items; delete own shops |
| AI assistant / tool | Any program | Read the same public data through the API, the MCP server and the pages |

**Self-service:** there is no admin area on the website and no approval step by the operator. The operator
uses the Supabase dashboard if something ever needs fixing by hand.

## 3. Scope

**Built**

- Text search across all shops: item name, brand, EAN, shop name, street or town
- Shop pages and item pages with map, opening hours, "open now", facilities and freshness
- Freshness and availability rules applied in the database for every output
- Self-service accounts and the owner dashboard
- Three ways for stock to arrive: PPI app window (folder), "Upload file", cloud link
- AI-proposed column mapping, always approved by the owner
- AI and machine access: JSON-LD, robots.txt, sitemap, llms.txt, public REST API with OpenAPI, MCP server
- Slovak, Hungarian and English; mobile-first; installable PPI app for the shop PC

**Decided against (on purpose)**

- Location services: the website never asks for the visitor's location and never guesses it from the IP address
  (decided 2026-10-06). Search is by text.
- Colours: plain black and white design; only exceptions are the Cacadoo PPI logo and the blue "Select picture" link
- An admin area on the website (removed 2026-10-06)
- Software or tunnels on the shop PC (a Cloudflare tunnel + rclone design was built on 2026-10-04 and replaced by the
  browser app on 2026-10-06)
- Google Merchant Center (AI readability replaces it)

**Not built (possible later)**

- E-mail alerts when a shop's stock stops arriving during opening hours
- Online ordering, payments, reservations, reviews, native mobile apps
- Writing anything back to the shop's software

## 4. Principles and constraints

- **Stack:** Next.js 16 (App Router, TypeScript) on Vercel; Supabase (Postgres + PostGIS, Auth, Storage, Vault, Edge
  Functions, pg_cron). Code in GitHub; every database change is a numbered migration in `supabase/migrations/`.
- **Rules live in the database.** Freshness, availability labels and hiding exact quantities are SQL functions and
  views, so the website, the API and the MCP server always say the same thing.
- **Only the stock-pull function writes stock**, with the service role key. That key never appears in the web app,
  Vercel or the repository.
- **Row Level Security** on every table. Owners can only reach their own shops.
- **Public pages are rendered on the server**, so the first HTML already contains names, prices and availability
  (AI crawlers do not run JavaScript).
- **Europe-wide:** no home town, no default country, currency or time zone in the code. Times are stored in UTC and
  shown in the shop's own time zone; every price carries its own currency.
- **When PPI is not sure, it says less, never more:** stale stock is never shown as available.

## 5. Features

### 5.1 Home and search (`/[lang]`)

- One search box. The text is matched, ignoring accents and case ("kava" finds "Káva"), against the item name, brand,
  EAN barcode, the shop's name, street and town. Searching "Budince" lists the items of shops in Budince.
- Every active shop is searched; there is no radius and no distance.
- Filter: "Only available now".
- Up to 50 results: available first, then fresher, then by name. Each result shows item name, price, shop name, street
  and town, the availability text with its freshness ("In stock · updated 8 min ago") and "Open now"/"Closed".
- A map shows the shops of the results (black dots); it is an extra: the page works without it.
- No results: "No shop has this right now".

### 5.2 Shop page (`/[lang]/shops/{slug}`)

- Name, logo, address, phone, website, "Get directions" (Google Maps with the shop's coordinates), map pin.
- Opening hours for the week in the shop's time zone, "Open now / Closes at / Opens at".
- Facilities: customer toilet, douchette (bidet shower), card payment.
- Stock freshness line, then the shop's public items: searchable, 50 per page, price and availability.
- JSON-LD `Store` (address, geo, opening hours, phone, logo, `paymentAccepted`, `amenityFeature`).

### 5.3 Item page (`/[lang]/items/{id}`)

- Item name, brand, EAN, price, availability with freshness, shop card with directions and "open now".
- "Also available at": the same product (EAN) in other shops, nearest to this shop first.
- JSON-LD `Product` with an `Offer` (price, currency, availability) only when the shop is not stale.

### 5.4 Languages

- Every page exists in Slovak (`/sk`), Hungarian (`/hu`) and English (`/en`), with a SK · HU · EN switch in the header.
- Without a language in the address, PPI uses the remembered choice, then the browser's language, then English.

### 5.5 Accounts

- **Sign up** (`/signup`): e-mail, password (at least 8 characters), password again. Supabase sends a confirmation
  e-mail; the link logs the owner in and opens "My shop".
- **Log in** (`/login`) with e-mail and password. Clear messages for a wrong password or an unconfirmed e-mail.
- **Forgot password** (`/forgot`): a reset link by e-mail (same answer whether the address exists or not); the link opens
  **Change password** (`/password`), which is also in the account menu.
- The account menu: My shop · Export folder · Password · Sign out.

### 5.6 Owner dashboard — "My shop" (`/[lang]/dashboard`)

- **Add your shop** (shown when the account has none, or via "+ Add another shop"): name, street, town, country (two
  letters), time zone, phone, company ID, website, location on the map, opening hours (several ranges per day),
  facilities, "Visible to shoppers" (ticked by default). The page address is made from name and town and made unique.
  At most 5 shops per account. After creating: three next steps are shown.
- **Export folder** section:
  - status: latest file time, Current/Recent/Stale, "PPI window on the shop PC last active", last file received, last
    error (common problems explained in the owner's language);
  - **Connect folder** (Edge/Chrome) and **Upload file** (any browser), with the result of each send;
  - **Cloud file link**: paste a share link to the file (or folder) → "Save and download now", "Download now",
    "Remove link";
  - the rules for the stock software's export (below) and a link to the full-screen `/sync` page.
- **Stock file columns:** after the first file, one drop-down per field (item code, name, EAN, brand, quantity, price,
  currency) pre-filled with the proposal, next to the file's first rows. Code, name, quantity and price are required.
  **Approve columns** → from then on every new file is applied automatically.
- **Shop details:** everything from "Add your shop", editable.
- **Logo:** blue "Select picture" link; the picture is shrunk in the browser (512 px, WebP) and uploaded at once.
- **What shoppers see:** exact number / In stock–Low stock–Out of stock / Available–Not available, the "low stock"
  threshold (1–50) and a live preview table.
- **Items:** name, code, price, quantity, what shoppers see; search, 50 per page; Hide/Show per item.
- **Delete shop** (with a confirmation tick).
- Every form returns to its own section and shows its result there; buttons show "Saving…/Uploading…" while working.

**Rules for the export (shown to owners):** a folder only for this; XML, CSV (UTF-8 or Windows-1250, `;` or `,`) or
Excel `.xlsx` (not the old `.xls`); columns item code, name, quantity, selling price incl. VAT, EAN and brand if
available; all items in one file, always the same name, overwritten each time (an item missing from the file counts as
sold out); every 15–30 minutes during opening hours plus once at night; only public data.

### 5.7 PPI app on the shop PC (`/[lang]/sync`)

- The same website, installable as an app from Edge or Chrome ("Install PPI as an app"); it opens on this page. Steps
  to start it with Windows are shown on the page (startup folder) and in `docs/SHOP_PC_SETUP.md`.
- **Connect folder:** the owner picks the export folder once; the browser remembers it. While the page is open
  (minimised is fine) it checks the folder every 15 minutes and sends the newest stock file when it is new, finished
  (untouched for 60 seconds) and unchanged while being read.
- After a restart the browser may ask once more for permission ("Allow on every visit" stops that).
- Firefox and Safari cannot read a folder: they get a message, and the "Upload file" button still works.
- One window per shop does the work; a second window waits and takes over when the first closes.

### 5.8 AI and machine access

- **Pages:** server-rendered; with JavaScript off every page still shows names, prices, availability and update time.
  Canonical URL, title and description per language; JSON-LD as above.
- **`/robots.txt`:** all crawlers allowed, AI crawlers named explicitly (GPTBot, ClaudeBot, PerplexityBot, …); the
  login-only pages are disallowed.
- **`/sitemap.xml`:** home, every active shop and public item (with the other languages), `lastmod` = the shop's latest
  file time; rebuilt at most hourly.
- **`/llms.txt`:** what PPI is, the data rules, how to use the API and MCP server, and the list of shops.
- **Public REST API** (no login, JSON, open CORS, 60 requests per minute per caller):
  `GET /api/v1/search?q=&near=&lat=&lng=&radius_km=&only_available=&lang=`, `GET /api/v1/shops`,
  `GET /api/v1/shops/{slug}`, `GET /api/v1/shops/{slug}/items?page=&q=`, `GET /api/v1/items/{id}`,
  OpenAPI at `GET /api/openapi.json`.
- **MCP server** at `/mcp` (Streamable HTTP, read-only, no login) with tools `search_stock(query, near, radius_km,
  only_available, lang)`, `get_shop(slug)`, `get_item(id)`. Anyone can add it to Claude as a custom connector.
- The API and MCP accept an optional `near` (a town where PPI has shops, or "lat,lng") typed by the caller; the
  website itself never uses a location.
- Every result carries `source_url` (the PPI page to cite), price, currency, availability text, freshness and the
  shop's address and coordinates. Exact quantities only for shops that publish them; no availability for stale shops.
- Search-engine ownership tags (`GOOGLE_SITE_VERIFICATION`, `BING_SITE_VERIFICATION`) can be set in Vercel so the
  sitemap can be submitted (SETUP.md part I).

## 6. Business rules

### 6.1 Freshness

Freshness comes from the time of the shop's latest applied stock file (`sync_sources.latest_file_time`).

| Age of the latest file | State | Shown |
| --- | --- | --- |
| under 30 minutes | `current` | availability + "Updated X min ago" |
| 30 minutes – 24 hours | `recent` | availability + "Last confirmed today/yesterday at 14:05" |
| over 24 hours, or never | `stale` | **no availability**, only "Stock information not currently available" |

The file time is the file's own time: the "last modified" time on the shop PC, the `Last-Modified` header of a
download, or the cloud file's change time — never later than "now". Sending the same file again does not make it
fresher. A cloud file without a date counts as new only when its content changed.

### 6.2 Availability (per shop's choice)

| What shoppers see (`visibility_mode`) | quantity > threshold | 0 < quantity ≤ threshold | quantity ≤ 0 |
| --- | --- | --- | --- |
| Exact number (`exact`) | "12 in stock" | "2 in stock" | "Out of stock" |
| In stock / Low stock (`in_stock`, default) | "In stock" | "Low stock" | "Out of stock" |
| Available / Not available (`yes_no`) | "Available" | "Available" | "Not available" |

The label is computed in the database. Raw quantities leave the database only for `exact` shops that are not stale.
Hidden items (owner's choice) and inactive shops are never shown.

### 6.3 Stock files

- One file is the **whole** stock: every item in it is updated; items of the shop missing from it are set to 0.
- The file is applied in one transaction: shoppers see either the old or the new stock, never half.
- A file's layout is matched by a column mapping. The first file, or a file whose layout changed, gets a proposal
  (Claude, or a rule-based guess) that waits for the owner's approval; nothing is applied until it is approved.
- If more than 5 % of a file's rows cannot be read with the approved mapping, the previous stock is kept and a new
  proposal waits for approval.
- Accepted: XML (the largest repeated element is the item list), CSV/TXT (`;` `,` tab or `|`, quoted fields, UTF-8 or
  Windows-1250), Excel `.xlsx` (first sheet). Numbers in any European or English format ("1 234,50 €", "1,234.50").
  Up to 50 MB. When the file has no currency column, the shop's country decides (HU → HUF, CZ → CZK, PL → PLN,
  CH → CHF, …), otherwise EUR.
- Items are linked across shops by EAN ("also available at").

### 6.4 Open now

Open if the current time in the shop's own time zone falls inside today's ranges; otherwise "Opens at …"
(today, tomorrow or the next opening day).

## 7. Data model (after migration 15)

| Table | Main columns | Notes |
| --- | --- | --- |
| `shops` | `id`, `slug` (unique), `name`, `ico`, `address`, `city`, `country` (ISO 2 letters), `timezone` (IANA), `location` (PostGIS point), `phone`, `website`, `opening_hours` (jsonb), `visibility_mode`, `low_stock_threshold` (1–50, default 3), `logo_url`, `is_active`, `has_toilet`, `has_douchette`, `has_card_terminal`, `created_at` | Visitors see only active shops |
| `shop_members` | `shop_id`, `user_id`, `role` (`owner`) | Which account owns which shop |
| `products` | `id`, `ean` (unique), `name`, `brand`, `category` | One per real product, shared by shops |
| `shop_items` | `id`, `shop_id`, `source_code` (the shop's item code), `name`, `ean`, `brand`, `product_id`, `is_public`, `updated_at` | Unique per shop + code |
| `inventory` | `shop_item_id`, `quantity`, `price`, `currency`, `source_updated_at`, `received_at` | Written only by the stock-pull function |
| `sync_sources` | `shop_id` (unique), `file_format`, `field_mapping` (jsonb), `mapping_status` (`proposed`/`confirmed`), `sample_rows`, `file_url` (cloud link), `latest_file_time`, `last_checked_at`, `last_error`, `folder_seen_at`, `last_file_name`, `last_file_hash` | One per shop: where stock comes from and how it is read |
| `profiles` | `user_id`, `display_name`, `language`, `is_admin` | One per account, created automatically |
| `api_usage` | `ip_hash`, `endpoint`, `created_at` | API/MCP rate limit log; no IP addresses; older than 30 days removed |

`opening_hours`: `{"mon":[["08:00","12:00"],["13:00","17:00"]], …, "sun":[]}`.
Storage: bucket `logos` (public, 1 MB, PNG/JPEG/WebP, folder per shop) and `raw-files` (private, last raw files kept
7 days for troubleshooting).

## 8. Security and privacy

| Data | Visitor | Shop owner | Stock-pull function |
| --- | --- | --- | --- |
| Shops | active shops (public fields) | own shops: details through `owner_save_shop()`, visibility and logo directly (never the page address); delete through `owner_delete_shop()` | read |
| Items (names, codes, EAN) | public items of active shops | own items: read, hide/show only | write |
| Stock (quantity, price) | only through `public_stock` / `search_stock` / `shop_stock`: labels, never hidden items, raw quantity only for `exact` shops | own stock (`owner_items()`) | write |
| Stock source (`sync_sources`) | none | own shop through `my_shops()`, `owner_set_mapping()`, `owner_set_file_url()`, `upload_check_in()` | read and write |
| Accounts (`profiles`) | none | own profile | — |

- Owners never write stock themselves; the function does, after checking the uploader is that shop's owner.
- The function downloads cloud links only from public `https://` addresses (never localhost, IP addresses or internal
  names).
- The API stores no IP addresses: only a hash with a salt that changes daily.
- Legacy: the `is_admin` flag and the `admin_*` database functions from the old admin area still exist in the database
  but nothing on the website uses them.

## 9. Design

- Plain white background, black text, thin light-grey lines; mobile-first. No colours, no dark mode, no cart icons.
  Exceptions at the owner's request: the Cacadoo PPI logo in the header and the blue "Select picture" link for logos.
- Availability always written out as text, in bold, always next to its freshness.
- Map: OpenFreeMap "positron" (free, no key), black dot pins; never required for the page to work.
- Language switch SK · HU · EN in the header; "For shops" link to the login.
- App icon: black "PPI" letters on white.

## 10. Key texts

| Key | SK | HU | EN |
| --- | --- | --- | --- |
| in\_stock | Na sklade | Raktáron | In stock |
| low\_stock | Málo na sklade | Kevés raktáron | Low stock |
| out\_of\_stock | Vypredané | Elfogyott | Out of stock |
| available | Dostupné | Elérhető | Available |
| not\_available | Nedostupné | Nem elérhető | Not available |
| stale | Informácia o zásobe momentálne nie je dostupná | A készletinformáció jelenleg nem elérhető | Stock information not currently available |

All texts are in `src/i18n/messages/{sk,hu,en}.json`. A native speaker should check Slovak and Hungarian before launch.

## 11. Known limits and open points

- **Freshness needs a running export.** If the shop PC is off or the PPI window is closed (folder way), or the cloud
  file stops changing (cloud way), the shop goes `recent` and after 24 hours `stale`. No alert e-mail is sent yet.
- **Cloud folder links:** a OneDrive folder was not read in the first real test; file links work. Google Drive folders
  also need the optional `GOOGLE_API_KEY`.
- **Anyone can sign up and add shops** (5 per account); there is no review. Watch for fake shops.
- **Not yet found by web search** until the site is registered with Bing and Google (SETUP.md part I); Claude finds
  shops at once through the MCP connector.
- **The four sample shops** from the build are still live.
- The site runs on `cacadooppivercel.vercel.app`; an own domain is still to come.

## 12. Launch checklist

- [ ] Remove the sample shops (SETUP.md part D)
- [ ] "Reset password" e-mail template pasted (SETUP.md E3) — confirmation template done
- [ ] Own domain connected; Supabase Site URL and redirect URLs updated to it
- [ ] Site registered with Bing Webmaster Tools and Google Search Console, sitemap submitted
- [ ] Row Level Security reviewed by a developer, not only by the AI that wrote it
- [ ] Texts checked by native speakers (SK, HU)
- [ ] Privacy page and terms (shop data, cookies, e-mail)
- [ ] Every public page checked with JavaScript turned off
- [x] Service role key only in Supabase function secrets
- [x] Stale shops show no stock on every page, in the API and in MCP

## 13. History

| Date | Milestone |
| --- | --- |
| 2026-10-01 | Phase 1–2: Next.js foundation, Supabase database, rules in SQL, automatic checks |
| 2026-10-03 | Europe-wide (no home town, any currency/time zone); phase 3 public pages + map + JSON-LD; phase 4 login, owner dashboard, admin area |
| 2026-10-04 | Shop facilities; phase 5 AI access (robots, sitemap, llms.txt, API, MCP); phase 6 automatic stock pull with AI mapping; shop PC tunnel installer (later replaced) |
| 2026-10-06 | Shop PC as a browser app instead of a tunnel; self-service sign-up with passwords; admin area removed; no location services, text search incl. shop name/street/town; logo upload fixes; Cacadoo PPI logo; search-engine verification tags |
| 2026-10-07 | "Upload file" button; cloud file and folder links (OneDrive, Google Drive, Dropbox) |
| 2026-10-08 | This as-built PRD and architecture document |
