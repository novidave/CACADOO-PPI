# Architecture and software

How PPI works from the shop's shelf to an AI assistant's answer, which software each part uses, and what happens when something breaks.

## 1. How it works in one minute

1. A sale at the shop's till lowers the stock in the shop's own software, as it does today.
2. Every 15–30 minutes that software exports a stock file into a folder on the shop PC.
3. The PPI window on that PC (the PPI website installed as an app in Edge or Chrome, started with Windows) reads only that folder and every 15 minutes uploads the newest finished file to a Supabase Edge Function.
4. The function reads the file. On a shop's first file, or when the layout changes, an AI model proposes which field is code, name, EAN, quantity and price; the shop owner approves it once in their dashboard.
5. The function saves the mapped stock to Supabase and records when the file was made. That time is the freshness.
6. The Next.js web app on Vercel shows the stock as server-rendered pages, a public API and an MCP server, so shoppers, AI crawlers and AI assistants all read the same data.

```text
SHOP PC (Windows)
  Shop software --scheduled export--> export folder, e.g. C:\Export\stock.xml
  PPI app window (Edge/Chrome, /sync) reads the folder every 15 min
                                   |  HTTPS upload, owner's login
STOCK PULL (Supabase Edge Function) v
  newer file --> AI field mapping (first file + layout changes)
             --> validate + save (upsert, freshness)
                                   |
DATABASE (Supabase)                v
  Postgres/PostGIS --> SQL functions (freshness, search)
  Auth (shop owners) | Storage (logos, raw files) | Vault (secrets)
                                   |
WEB APP (Next.js on Vercel)        v
  Server pages (HTML + JSON-LD) | Discovery files (robots, sitemap, llms.txt)
  MCP server (/mcp, read-only)  | Public API (/api/v1, OpenAPI)
                                   |
WHO READS IT                       v
  Shoppers | AI crawlers | AI assistants | Apps and tools
```

All four outputs read through the same SQL functions, so freshness and visibility rules are applied once, in the database. Shop owners sign up themselves (e-mail + password, Supabase Auth) and run their shop from the dashboard; there is no admin area on the website.

## 2. Components in detail

### 2.1 Shop PC

- **Shop's own stock software.** Set to export stock on a schedule (every 15–30 min in opening hours, plus a nightly full export). XML, CSV or Excel. Only public fields: item code, EAN, name, quantity, selling price. One file, overwritten each time, e.g. `stock.xml`, in a folder used only for this.
- **PPI window**: the `/sync` page, installed as an app (web app manifest) in **Edge or Chrome** and started with Windows from the startup folder. The owner picks the export folder once (File System Access API, read-only); the browser keeps the folder handle in IndexedDB and, with "Allow on every visit", the permission too.
- While open, it checks the folder every 15 minutes: the newest XML/CSV/TXT/XLSX file is sent when it is newer than the last applied file, untouched for 60 s and unchanged while being read (a half-written export is never sent). The same file is not sent again unless the mapping status changed (e.g. the owner approved the columns). Files are gzip-compressed.
- One window per shop (Web Locks); a second window waits and takes over when the first closes.
- Each check calls `upload_check_in()`, which records `sync_sources.folder_seen_at` ("PPI window last active" on the dashboard).
- Firefox and Safari have no folder access; the page says so. Steps for people: `docs/SHOP_PC_SETUP.md`.
- Nothing listens on the network at the shop and no router change is needed.

### 2.2 Upload and stock pull: Supabase Edge Function `stock-pull`

**Upload** (`POST /functions/v1/stock-pull?shop_id=…&file_time=…&file_name=…`, body = the file, `gzip=1` when compressed), called by the PPI window with the owner's own login: `upload_check_in()` checks that the caller is the shop's owner. `file_time` (the file's own time, never later than now) becomes the freshness.

**Pull** (optional, for a file published on the internet): every 15 minutes (scheduled inside Supabase) for each shop with a `file_url`, with optional access headers from Supabase Vault; skipped if `Last-Modified` is not newer than `latest_file_time`.

Then, for both:

1. Read XML, CSV or Excel into rows.
2. No confirmed mapping yet: send 20 sample rows to the AI model, save the proposal as `proposed`, stop.
3. Confirmed mapping: apply it to every row.
4. Check rows (price is a number, quantity present). If more than 5% fail, ask the AI for a new proposal, keep the old stock.
5. Upsert into `shop_items` and `inventory` in one transaction (items missing from the file → 0); set `latest_file_time`; clear `last_error`; keep the raw file in Storage for 7 days.

**Every hour:** a freshness watch emails the shop and you when no new file arrived for over 1 hour during opening hours (not built yet).

**On errors:** the function writes `last_error` for that shop.

The AI model (called from the function) only proposes mappings, so it runs once per shop plus whenever a file layout changes.

### 2.4 Database: Supabase

- **Postgres with PostGIS**: tables `shops`, `shop_members`, `products`, `shop_items`, `inventory`, `sync_sources`, `api_usage`, `profiles` (fields in docs/PRD.md, section 5).
- **SQL functions**: `freshness_state(shop_id)`, view `public_stock`, RPC `search_stock(...)`. They decide availability labels, hide exact quantities when the shop chose so, and hide all availability for stale shops.
- **Row Level Security** on every table: visitors read only public data, owners only their own shops.
- **Auth**: e-mail + password with self-service sign-up, confirmation and password-reset e-mails (custom SMTP).
- **Storage**: shop logos; the last raw export file per shop, kept 7 days for troubleshooting.
- **Vault**: optional access headers for shops pulled from a file address, readable only by the stock-pull function.
- **Scheduled jobs**: the 15-minute stock pull and the hourly freshness watch.
- The **service role key** exists only in Supabase function secrets, never in the web app or the repository.

### 2.5 Web app: Next.js on Vercel

- Built with **Claude Code** as a Next.js app (App Router, TypeScript). The code lives in a private GitHub repository; Vercel publishes every change, with a preview link first.
- **Server-rendered**: all public data is loaded on the server, because AI crawlers read only raw HTML and don't run JavaScript ([Vercel](https://vercel.com/blog/the-rise-of-the-ai-crawler)).
- **Public pages**: search with map, shop pages, item pages, each with JSON-LD (`LocalBusiness`, `Product` + `Offer`).
- **Discovery files**: `robots.txt` allowing AI bots, `sitemap.xml` with each shop's latest file time as `lastmod`, `llms.txt`.
- **Public read API** `/api/v1/...` with an OpenAPI file, and an **MCP server** at `/mcp` with tools `search_stock`, `get_shop`, `get_item`. Both read-only, rate-limited, logged to `api_usage`.
- **Owner dashboard** (self-service): create shops, details, opening hours, export folder (rules + connection), column approval (proposed mapping next to sample rows), visibility mode, items, delete shop. No admin area.
- Served on your own domain through Vercel.

## 3. One stock change, end to end

| Time | What happens |
| --- | --- |
| 10:02 | A customer buys the last drill; the till lowers stock to 0 in the shop's software |
| 10:15 | The scheduled export overwrites `stock.xml` in the preset folder |
| 10:16–10:31 | The PPI window's next check sees the finished newer file and uploads it; the function maps it with the saved mapping and saves it; freshness = 10:15 |
| Right after | Item page, API and MCP all show "Out of stock · updated 10:15" |
| Later | AI crawlers pick up the new page on their next visit; assistants using MCP get it immediately |

Worst-case delay from sale to PPI: export interval + 15 minutes, so about 30–45 minutes with a 15–30 minute export.

## 4. When something breaks

| Failure | What shoppers and AI see | What you see |
| --- | --- | --- |
| Shop PC off or offline, or the PPI window closed | Stock stays up with "last confirmed at"; hidden after 24 h | Red row after 1 h in opening hours; "PPI window last active" stops moving |
| Export stopped in the shop's software | Same as above | Same, and file time stops moving |
| File layout changed | Last good stock stays | The owner sees a new proposal to approve in the dashboard |
| AI unsure about a field | Nothing changes until you decide | Field marked null in the proposal |
| Stock-pull function failing | Stock ages normally, then hides after 24 h | `last_error` on the owner's dashboard |
| Vercel down | Site, API and MCP unavailable; stock data is safe | Uptime monitor alert |
| Supabase down | Site and API unavailable | Uptime monitor alert |

The rule everywhere: when PPI isn't sure, it says less, never more. Stale stock is never shown as available.

## 5. Security

- Shop PC: nothing listens on the network; the browser reads one folder, read-only, and uploads only to PPI over HTTPS.
- Uploads: only with the login of the shop's owner, checked by `upload_check_in()`.
- Supabase: Row Level Security on all tables; service key only in Supabase function secrets; exact quantities never leave the database for shops that hide them.
- Public API and MCP: read-only, rate-limited, no personal data.
- Credentials (API keys, secrets) kept in Supabase Vault and function secrets, Vercel environment variables and a password manager, never in documents, chat or the repository.

## 6. Software you need

| Software | What it does in PPI | Runs where | Cost (pilot) | Set up by |
| --- | --- | --- | --- | --- |
| Shop's stock software | Exports stock on a schedule | Shop PC | Shop already pays | Shop or its software reseller |
| Microsoft Edge or Google Chrome | Runs the PPI app window that uploads the export | Shop PC | Free (Edge comes with Windows) | You, on site |
| Claude Code | Writes, tests and fixes all the code | Cloud or your computer | Included in a Claude plan with Claude Code | You |
| GitHub | Private repository with every version of the code | Cloud | Free | You |
| Next.js | Framework for pages, API and MCP server | Inside the app | Free (open source) | Claude Code |
| Vercel | Hosts the web app, preview links, your domain | Cloud | Free to start; paid plan if needed for commercial use | You |
| Supabase | Database, PostGIS, Auth, Storage, Vault, Edge Functions, schedules | Cloud | Free to start; Pro $25/month once live | You, with Claude Code |
| AI model API (Anthropic or OpenAI) | Proposes field mappings | Cloud | Pay per use; small | You |
| Email sending (SMTP) | Login links and alerts | Cloud | Free tiers exist; check limits | You |
| Uptime monitor | Pings site and API, alerts when down | Cloud | Free tiers exist | You |
| Password manager | Stores all tokens and passwords | Your devices | Free or low cost | You |
| Windows test PC | Rehearse the shop setup before visiting shops | Your desk | You likely have one | You |

Pilot running cost: your Claude plan plus roughly €30–60 a month once live (Supabase Pro, a Vercel paid plan if your use needs it, domain) and small AI usage. No Lovable or n8n subscriptions. Check current prices before committing.

## 7. Environments, backups and monitoring

- **Test first**: run the whole chain against your own Windows PC with a sample file before any shop.
- **Supabase**: one project for live, a second free project for testing; migrations in GitHub keep both identical.
- **Vercel**: every change gets a preview link; publish to live only when a phase passes its checks.
- **Backups**: GitHub keeps every version of the code; check the backup schedule of your Supabase plan.
- **Monitoring**: admin page red rows, function error emails, an uptime monitor on the home page and `/api/v1/search`.

## 8. Growing from 5 to 50 shops

- 5 shops: everything fits on free or entry tiers.
- 50 shops: 50 small downloads every 15 minutes is light work; the function processes shops in small batches; move to Supabase Pro.
- Beyond that: the stock pull can move to a dedicated worker service, without changing shops' setup or the web app.
