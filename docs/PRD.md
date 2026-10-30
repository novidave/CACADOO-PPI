# PPI — Product Requirements (as built)

Version 3.2 · status 20 October 2026 · live at <https://cacaduu.com> (brand: **Cacaduu PPI**; the Vercel address cacadooppivercel.vercel.app still answers)

This document describes **what PPI is and what it does today**. How the parts work together is in
`docs/ARCHITECTURE.md`; setup steps for people are in `SETUP.md` and `docs/SHOP_PC_SETUP.md`.
Claude Code reads this file first, so keep it true: when a feature changes, change this file in the same commit.

## 0. Status at a glance

| Area | Status |
| --- | --- |
| Public search, shop pages, item pages, map | Live |
| Slovak, Hungarian, English | Live |
| Sign-up, log-in, forgotten password, change password (e-mail + password) | Live (e-mail through Brevo SMTP) |
| Owner dashboard: create shop, details, logo, opening hours, facilities, items | Live |
| Shop page updates: no other shops on Pro product pages, shop e-mail and Facebook page, the assistant's own button label and welcome text, "My shop" as dropdowns, private folder files and the last 10 stock files there, one display rule for every shop | Built and tested; live after migration 21, the two updated functions and the merge (SETUP.md part N) |
| Stock from the shop PC: PPI app window watching the export folder | Built and tested |
| Stock by hand: "Upload file" | Live, tested by the owner |
| AI field mapping (Claude) with owner approval | Live (rule-based guess when no Anthropic key is set) |
| Item names in Slovak, Hungarian and English; search across the three languages | Built and tested; live after migration 17, the new stock function and the Anthropic key in Supabase |
| AI search on the main page (Claude Haiku) | Built and tested; switched on by the Anthropic key in Vercel |
| The main page as one AI chat (Prompt 10): "Čo dnes hľadáte?" with one centred input and example questions; thinking dots and the real steps, the answer streamed word by word, result cards from the search with freshness and status, follow-up questions, "Nový chat", "Zastaviť"; the plain search as a hidden fallback; "Len dostupné teraz" removed from the page | Built and tested against a Claude stand-in; live after the merge, no database change (SETUP.md part AD) |
| The chat finds products in layers (Prompt 11, phase A): Cacaduu first; with fewer than 3 good Cacaduu results and a town the shopper wrote, also shops of the right kind nearby (OpenStreetMap, optionally Google Places; "Môže mať", stock not verified) and offers on allowed shop websites (Claude's web search; "Z webu", price as the page shows it) with links to each shop's own search; groups "Overené v Cacaduu" / "Obchody v okolí (neoverené)" / "Na webe"; anything not about finding a product is declined; admin: switches, allowed domains, search links, calls and estimated cost per day | Built and tested against stand-ins for Claude, Nominatim, Overpass and Google; live after database update 34, the product-sources function, its secrets and the merge (SETUP.md part AE) |
| Partner feeds (Prompt 11, phase B): partner shops' product feeds (Google Merchant XML/CSV with its local inventory feed, Heureka XML, a plain CSV) read on a schedule into their own tables and shown in the chat under "Partneri" between Cacaduu and shops nearby ("Decathlon (partner) · 24,99 € · online skladom / predajňa Košice: skladom podľa partnera · údaje z 08:00"; older than 48 hours: only "údaje z <dátum>"); affiliate links marked "partnerský odkaz", never ranked higher; admin "Partnerské feedy" | Built and tested against stand-ins for the partners' servers, Claude and Storage; live after database update 35, the partner-feeds function and the merge (SETUP.md part AF) |
| Paid plan per shop (Stripe: monthly subscription, VAT invoices) | Built and tested against a Stripe stand-in; Stripe **test mode** first (SETUP.md part K) |
| AI assistant on the shop page (paid plan only, Claude Haiku) | Built and tested against a Claude stand-in; live after migration 19 (SETUP.md part L) |
| Documents and pictures for the assistant; private folders with access keys (paid plan only) | Built and tested against Claude and Storage stand-ins; live after migration 20 and two new functions (SETUP.md part M) |
| Conversation archive of the shop assistant (paid plan only): every conversation kept with its files (GPS removed) and made into a PDF; "Konverzácie asistenta" in My shop | Built and tested against Claude and Storage stand-ins; live after database update 22, the assistant-archive function and one secret (SETUP.md part O) |
| Cloud folder for the archive (paid plan only): each finished conversation's PDF and files copied into the shop's own OneDrive or Dropbox; "Cloudový priečinok" in My shop | Built and tested against OneDrive, Dropbox and Brevo stand-ins; live after database update 23, the cloud-export function, the Microsoft and Dropbox app registrations and the secrets (SETUP.md part P) |
| Access keys for shoppers (paid plan only): a valid key opens a private folder in the chat for 24 hours; its files open in a built-in viewer (pages with a watermark) or, when the owner allows, download one by one or as a ZIP; "Režim prístupu" and a key per folder in My shop; shoppers may download their own conversation as a PDF | Built and tested against Storage and Claude stand-ins; live after database update 24, three updated functions and the merge (SETUP.md part Q) |
| Booking link (every shop): "Rezervovať termín" link on the shop page, next to the e-mail and Facebook page, opening the shop's booking app; product pages of shops with a domain of their own show no other shops; quick view of the recently uploaded stock files | Built and tested; live after database update 26 and the merge (SETUP.md part S) |
| Shop status and Pro page layout: open / lunch break / closed / holiday / no hours (dots on the maps and lists, API, MCP, JSON-LD), public holidays SK/HU/CZ, the owner's special days, "Automatické štátne sviatky"; new section order; the assistant always open; no Cacaduu header on own domains | Built and tested; live after database update 27 and the merge (SETUP.md part T) |
| Page sections from PDFs (Pro): up to 10 per shop ("Novinky október", "Leták" …), shown as pages with their text, collapsed or always open, in four positions, with dates, preview and download on/off; the assistant uses them; the header picture of an own domain, the shop's name and logo back on its page | Built and tested; live after database update 28, the page-sections function, the updated shop-files function and the merge (SETUP.md part U) |
| "Zobrazenie strán" per section: a slider (one page at a time, swipe, ‹ ›, keys, "2 / 5" and dots; the default) or "Pod sebou"; a full-screen viewer with pinch / wheel zoom and swipe; "Stiahnuť PDF" as a button | Built and tested; live after database update 29 and the merge (SETUP.md part V) |
| Page sections for free shops too: the same upload and display options; limits per plan set by the admin (default free 1 section, 5 pages, 10 MB; Pro 10, 20, 10 MB); "Pre viac sekcií prejdite na Pro" at the limit; on a free page after the opening hours; Pro → free keeps every section, shows the first one | Built and tested; live after database update 30, the updated page-sections function and the merge (SETUP.md part W) |
| Own domain header as before update 28: a small clickable logo ("Logo v hlavičke webu" replaces the header picture) and SK · HU · EN; the section position "Za otváracími hodinami"; sections made of pictures (JPG, PNG, WebP; one picture = one page) | Built and tested; live after database update 31, the updated page-sections function and the merge (SETUP.md part X) |
| "Odkaz loga": where a click on the own domain's header logo leads (e.g. the shop's main website; empty = the home page) | Built and tested; live after database update 32 and the merge (SETUP.md part Y) |
| Ticks on "Vaše mimoriadne dni" (delete several at once, "Vybrať všetko"); a blue "Vybrať súbor" link instead of the browser's file box in page sections | Built and tested; live after the merge, no database change (SETUP.md part Z) |
| Assistant conversations as PDF straight to the PC: "Stiahnuť PDF" on each, ticks + "Stiahnuť vybrané"; the shopper's pictures large in the PDF | Built and tested; live after the updated assistant-archive function and the merge (SETUP.md part AA) |
| "Konverzácie do počítača": every finished conversation saved by itself as a PDF into a folder on the shop PC (Edge/Chrome, while the PPI window is open; never replaces anything) | Built and tested; live after the merge, no database change (SETUP.md part AB) |
| Own domains easy to find: "Overiť v Google Search Console" (the TXT record written into DNS for domains Cacaduu runs, shown to add by hand otherwise) and "Odoslať sitemap"; llms.txt and robots.txt per own domain (with "Kategórie tovaru"); IndexNow after every stock upload (only changed pages); search results, map pins and AI cards link to the own domain; item pages carry Product/Offer + Store JSON-LD | Built and tested; live after database update 33, the updated domains and stock-pull functions and the merge (SETUP.md part AC) |
| Own domains fully findable: "Overiť v Google Search Console" — a TXT record added to the DNS of a domain Cacaduu runs ("Odstrániť" removes only that record), or for a connected domain the **HTML značka** on its pages (recommended) or the TXT record to add by hand; **Bing Webmaster Tools** (the same meta tag, or the import from Search Console); sitemap steps for Google and Bing; llms.txt with holidays, the stock's categories and Cacaduu's API/MCP; **IndexNow on every host** (the main domain too) with only meaningful changes, once per upload and once an hour per host; the Offer keeps the price on stale pages (no availability); API/MCP `source_url` and PPI's llms.txt point to the own domain | Built and tested; live after database update 36, `INDEXNOW_KEY` (Vercel + Supabase) and `SITE_URL` (Supabase), the updated domains and stock-pull functions and the merge (SETUP.md part AG) |
| Shop blog "Novinky" (every shop; free: the newest 10 posts shown, Pro: all): posts written in Môj obchod → "Novinky / Blog" with up to 10 photos, now or scheduled; the shop's Facebook Page connected once: all past posts imported, a daily sync, and "Zverejniť aj na Facebooku?" before each post; `/blog` pages, RSS, JSON-LD, sitemap, llms.txt and IndexNow, also on own domains; privacy and data deletion pages | Built and tested against Facebook, Brevo and IndexNow stand-ins; live after database update 37, the new shop-blog function, the Meta app and the merge (SETUP.md part AI) |
| Forgiving product search: "Tovar v obchode" suggests up to 8 products while typing (from 2 letters; ↑ ↓ Enter Esc; "Zobraziť všetky výsledky") and finds them despite typos, word order, other languages, word endings and sizes ("akril paint 0.5l" → "Akrylové médium lesklé, 250 ml"); codes and EANs exact first; nothing exact → "podobné produkty"; the same rule in the main search, the API, MCP, the chat and the shop assistant ("farba v Budinciach" → only Budince) | Built and tested; live after database update 54 and the merge (SETUP.md part AW) |
| "Konverzácie" (Pro, phase 1 of the CRM work): the Asistent page in three tabs (Nastavenia · Konverzácie with the number of new ones · Súkromné priečinky); every conversation Nové / Prečítané / Archivované with a star, a private note and the marks "Bez odpovede" and "Prístupový kľúč"; filters (days, status, star, no answer, files, language) and search; ticks with bulk actions (prečítané, nové, hviezdička, archivovať, vymazať with a confirmation); suggested products linked; one conversation as PDF or TXT, a date range as CSV; keep time "Neobmedzene" (default) or 30 / 90 / 365 days; every owner action in the activity log | Built and tested (database checks, unit tests); live after database update 55 and the merge (SETUP.md part AX) |
| "Kontakty" (Pro, phase 2 of the CRM work): contacts with phone (international form, one contact per number, "overené" only after an SMS code), e-mail, address, tags and a note; conversations join a contact by the phone or by hand; a contact card with Prehľad · Konverzácie · Rezervácie · Správy; SMS and e-mail from the card with a preview first; e-mail templates with variables; every outgoing message written down | Built and tested (database checks, function and unit tests); e-mail live after database update 56, the crm-messages function and the merge (SETUP.md part AX2); SMS only written down ("test") until the SMS provider of phase 4 |
| AI access: server-rendered pages, JSON-LD, robots.txt, sitemap, llms.txt, public API, MCP server | Live; MCP verified with Claude |
| Found by web search (Google, Bing → ChatGPT, Grok, …) | Waiting: site not yet registered with Google/Bing (SETUP.md part I) |
| E-mail alerts when a shop's stock stops arriving | Not built |
| Sample shops from the build (4 shops) | Still in the database: remove before launch (SETUP.md part D) |

## 1. Product summary

PPI shows shoppers which local shops have a product in stock **right now**, at what price, and how fresh that
information is. It works anywhere in Europe: any town, country, currency and time zone; nothing is tied to one place.

Shops keep using their own stock software. That software exports a stock file (XML, CSV or Excel) every 15–30
minutes, and the file is uploaded to PPI in one of two ways: the PPI app window on the shop PC sends it every 15
minutes, or the owner uploads it by hand ("Upload file"). PPI downloads nothing itself. It reads the file, matches
its columns (proposed by AI, approved once by the owner) and publishes the stock. The time of the file is the
freshness that shoppers see.

**Goal:** a shopper searches a product, a shop name or a street and finds a shop that really has it, without a wasted
trip. Every page and answer is also readable by AI assistants and search engines directly, without Google Merchant
Center.

## 2. Users and roles

| Role | Who | Can do |
| --- | --- | --- |
| Visitor | Any shopper, no login | Search, browse shops and items, see the map, switch language |
| Shop owner | Anyone who signs up (e-mail + password) | Create up to 5 shops; edit details, logo, opening hours, facilities; send stock (folder or "Upload file"); approve the stock file's columns; choose what shoppers see; hide items; delete own shops |
| AI assistant / tool | Any program | Read the same public data through the API, the MCP server and the pages |

**Self-service:** there is no approval step by the operator and no admin area for shops or stock. The only operator page
is "Predplatné a domény" (`/[lang]/admin/domains`, own domains, update 25; only for accounts with `profiles.is_admin`); since
update 34 it also holds "Vyhľadávanie mimo Cacaduu" and the allowed web domains of the main chat's search (6.5), and
since update 35 "Partnerské feedy" (6.5b).
The operator uses the Supabase dashboard if anything else needs fixing by hand.

## 3. Scope

**Built**

- Text search across all shops: item name, brand, EAN, shop name, street or town — forgiving since update 54 (6.28)
- Shop pages and item pages with map, opening hours, "open now", facilities and freshness
- Freshness and availability rules applied in the database for every output
- Self-service accounts and the owner dashboard
- Two ways for stock to arrive, both uploads: the PPI app window (folder, every 15 minutes) and "Upload file"; and,
  since update 49, the shop's inventory program over its API (SuperFaktúra, WooCommerce, own JSON/CSV URL)
- A third way being built (Prompt 13): the **Cacaduu POS Sync Agent**, an optional desktop app (its own repository)
  that reads stock from the POS and sends it to the Cacaduu Cloud API. Phase A (update 50): pairing with a one-time
  code, device tokens, heartbeats and the device list in Môj obchod. Phase B (update 52): inventory snapshots and one
  active stock source ("Zdroj zásob"). Phase C (update 53): "Synchronizovať teraz". The contract for all three is
  docs/CONNECTOR_CLOUD_API.md
- AI-proposed column mapping, always approved by the owner
- Item names in three languages: every name is also kept in plain Slovak, Hungarian and English (made by AI in the
  background, correctable by the owner), so a search in any of the three languages finds it
- The main page is one AI chat search (Prompt 10); the plain database search is its hidden fallback and the first
  HTML of `/[lang]?q=…`
- The main chat's search in layers (Prompt 11): Cacaduu, then the partners' own product feeds, then shops nearby
  (OpenStreetMap, optionally Google Places) and offers on larger shops' websites, only when Cacaduu has too little (and,
  for shops nearby and the web, the shopper wrote a town)
- Paid plan per shop: a monthly Stripe subscription (Stripe Checkout to subscribe, the Stripe customer portal to
  cancel or change the card), invoices with VAT; one database function says whether a shop has it
- AI assistant on the shop page (the first paid feature): questions about the shop's items, prices and availability,
  shopping lists to copy or print, and photos of a device, part or model plate matched against the shop's stock
- Conversation archive for the assistant (paid plan): every conversation kept for the shop's owners with its times,
  the cards shown and the shopper's files (GPS removed), one PDF per conversation, read in "Konverzácie asistenta"
- Cloud folder (paid plan): every finished conversation (PDF + the shopper's files) copied into the shop's own OneDrive
  or Dropbox folder, connected once with the provider's own login (OAuth)
- Access keys for shoppers (paid plan): a key opens a private folder in the chat; its documents are read in a built-in
  viewer with a watermark ("Len zobraziť") or also downloaded ("Zobraziť a stiahnuť"), as the owner chooses per folder
  and per file; shoppers may download their own conversation as a PDF
- AI and machine access: JSON-LD, robots.txt, sitemap, llms.txt, public REST API with OpenAPI, MCP server
- Slovak, Hungarian and English; mobile-first; installable PPI app for the shop PC

**Decided against (on purpose)**

- Location services: the website never asks for the visitor's location and never guesses it from the IP address
  (decided 2026-10-06). Search is by text.
- Colours: plain black and white design; only exceptions are the Cacaduu PPI logo and the blue "Select picture" link
  (and, since 2026-10-14, the same blue "Vybrať súbor" link of page sections)
- An admin area for shops and stock on the website (removed 2026-10-06; the one operator page since update 25 is
  "Predplatné a domény" for own domains)
- Tunnels into the shop PC (a Cloudflare tunnel + rclone design was built on 2026-10-04 and replaced by the browser app
  on 2026-10-06). Software on the shop PC is **no longer decided against** (2026-10-27): the POS Sync Agent is an
  optional desktop app; it only makes outbound HTTPS requests, the cloud never connects to the shop PC, and the PPI app
  window and "Upload file" stay as they are
- Google Merchant Center (AI readability replaces it)

**Not built (possible later)**

- E-mail alerts when a shop's stock stops arriving during opening hours
- Online ordering, payments by shoppers, reservations, reviews, native mobile apps
- More paid features (each will check `shop_has_plan()`)
- Writing anything back to the shop's software

## 4. Principles and constraints

- **Stack:** Next.js 16 (App Router, TypeScript) on Vercel; Supabase (Postgres + PostGIS, Auth, Storage, Vault, Edge
  Functions, pg_cron). Code in GitHub; every database change is a numbered SQL file: updates 1–21 in
  `supabase/migrations/`, from update 22 on one file per phase in `supabase/sql/`, pasted by the owner.
- **Rules live in the database.** Freshness and the availability label (the quantity exactly as in the shop's file)
  are SQL functions and views, so the website, the API and the MCP server always say the same thing.
- **PPI never edits, corrects or completes shop data.** What shoppers see of the stock comes only from the shop's own
  stock software through the uploaded file; "My shop" has no setting that changes the uploaded data or how it is
  shown. Translations of item names are not shop data (6.4).
- **Private columns** are every column of the stock file that is not in the approved column mapping (purchase price,
  supplier, margin, invoice number, …): they stay only in the private raw-files bucket (7 days), are never shown
  publicly and never reach the shop assistant. For the one-time column proposal the AI gets only the column names and
  up to 3 sample values per column; columns whose name points to purchase price, supplier, margin or invoice go by
  name only.
- **Payment never affects search ranking.**
- **Only the stock-pull function writes stock**, with the service role key. That key never appears in the web app,
  Vercel or the repository. Likewise **only the stripe-webhook function writes a shop's paid state**, after checking
  Stripe's signature; Stripe keys live only in Supabase function secrets.
- **Row Level Security** on every table. Owners can only reach their own shops.
- **Public pages are rendered on the server**, so the first HTML already contains names, prices and availability
  (AI crawlers do not run JavaScript).
- **Europe-wide:** no home town, no default country, currency or time zone in the code. Times are stored in UTC and
  shown in the shop's own time zone; every price carries its own currency.
- **When PPI is not sure, it says less, never more:** stale stock is never shown as available.

## 5. Features

### 5.1 Home and search (`/[lang]`)

The main page is **one AI chat** (Prompt 10), like Perplexity or Claude: nothing else above the fold.

- **Empty page:** in the middle of the screen the small Cacaduu pin, the headline "Čo dnes hľadáte?", one large rounded
  input that grows with the text (placeholder "Napíšte, čo hľadáte a kde – napr. biela farba 15 l v Košiciach") with a
  send arrow, and three example questions that fill the input ("Kto má AdBlue v Michalovciach?", "Nabíjačka USB-C
  otvorené teraz", "Farba na plot a štetec v Košiciach"). No filters, no other search box, no "Len dostupné teraz", no
  location chip.
- **Chat:** after the first question the input sits at the bottom of the screen (above the phone's home bar,
  "Spýtajte sa ďalej…"). The shopper's question in a grey bubble on the right; the answer on the left without a border,
  **streamed word by word**, in the language of the question (an Italian question gets an Italian answer; the page's
  buttons stay in the page language). Enter sends, Shift+Enter makes a new line, Esc or "Zastaviť" stops the answer
  (and the AI call on the server). "+ Nový chat" clears everything. The conversation lives only in that browser tab;
  the server keeps none.
- **Thinking:** three dots pulsing in Cacaduu yellow next to the small pin, and a line that follows the **real** steps:
  "Rozumiem otázke…" (the question is with the AI), "Hľadám v obchodoch…" (the AI calls the search), "Overujem
  dostupnosť a otváracie hodiny…" (the results with availability and status are back), then the answer. Grey
  placeholder cards while the search runs. CSS only; with "reduce motion" the dots stand still. Screen readers hear
  the steps and the answer (`aria-live="polite"`).
- **Result cards** under the answer, built on the server from the search results only: the item name as the shop wrote
  it and its translation in the page language under it, brand, price in the item's currency, shop (link), street and
  town, the availability in bold with a freshness badge ("Aktualizované pred 8 min"; no availability for stale shops)
  and the shop's status dot with the words. Distance only when the question named a town: "2,1 km od centra Košice".
  Six cards, then "Zobraziť viac (n)"; "Ukázať na mape" opens a small map of those shops (loaded only then).
- **Follow-up questions** keep the context: "a lacnejšie?", "len tie, čo sú teraz otvorené", "a v Michalovciach?"
  (the browser sends the last three questions and answers, with the cards each answer showed, in short).
- **No location:** the website never asks for the visitor's location and never guesses it (not from the browser, not
  from the IP address). The shopper writes the town ("v Michalovciach"); the AI passes it to the search as the town.
- **Search rules** (the same `search_stock` as the API and MCP): every word must appear (any order, also inside longer
  words), ignoring accents and case ("kava" finds "Káva"), in the item's name as the shop wrote it or its Slovak,
  Hungarian or English name, the brand, the EAN barcode, or the shop's name, street and town. Every active shop is
  searched; with a town, the shops within 10 km of its centre (a town without PPI shops: all shops). Available
  first, then fresher, then by name; payment never changes the order.
- **Nothing found:** the answer says so plainly and shows what was searched ("Hľadané: …").
- **Hidden fallback:** when no answer has started within 12 seconds, the AI fails or a limit is reached, the same chat
  shows the plain database search as cards with the note "Zobrazujem jednoduché výsledky vyhľadávania." (over the
  per-minute limit also "Veľa otázok naraz – AI odpovie znova o chvíľu."). Without the Anthropic key every question
  gets the plain search.
- **Links and crawlers:** `/[lang]?q=…` still renders the plain results (item, price, shop, street, town,
  availability + freshness, status) in the first HTML, without a map, for crawlers, shared links and browsers without
  JavaScript; with JavaScript such a link starts the chat with that question. The input is a plain form (`GET
  /[lang]?q=…`), so it also works without JavaScript.
- "Opýtajte sa obchodov" and "Upozorniť ma" are not shown: they do not exist yet.

**Search in layers (Prompt 11, phase A).** The chat has one job: help a shopper find a product in a town — who has it,
where, at what price and how fresh that is. Anything else gets "Pomáham len s hľadaním produktov v obchodoch v okolí."
(in the language of the question) and no search.

- **Layer 1 – Cacaduu** (always first): the shops' own stock files, with the freshness badges and status dots above.
- **Layer 2 – partners** (phase B; only when Cacaduu gave fewer than 3 good results, skipped when no partner has rows):
  the product feeds of partner shops (6.5b), searched with the same accent-insensitive search as the shops' items. A
  card: "Decathlon (partner) · 24,99 € · online skladom / predajňa Košice: skladom podľa partnera · údaje z 08:00", then
  the product's name as the partner wrote it (link to the partner's page) and "údaje partnera, neoverené v Cacaduu".
  "online …" is the feed's own availability (skladom / vypredané / na objednávku / na predobjednávku / do N dní, or the
  partner's own word); the stores come only from the partner's local inventory feed, only those in the town the shopper
  wrote (by the store list's town, or within 20 km of the town's centre). The time is the time of the partner's data
  (when the partner's server made the feed, else when it was read; for an uploaded file, the upload) in the partner's
  time zone. **Data older than 48 hours shows no availability and no stores**, only "údaje z 12. 10. 2026", and comes
  last. An affiliate link is marked "partnerský odkaz" (`rel="sponsored"`); the order never depends on it (the AI does
  not even see it). The partner's logo is shown in grey, like the rest of the site.
- **Layer 3 – shops nearby** (only when Cacaduu and the partners together gave fewer than 3 good results — Cacaduu:
  current or recent data, not sold out, around the town; a partner: data under 48 hours and in stock in one of its
  stores in the town by the partner's word — and the shopper wrote a town): shops of the right kind around the town's centre from OpenStreetMap
  (the AI picks 1–3 kinds of shop for the product, e.g. AdBlue → čerpacie stanice, autodiely). A card: "Môže mať ·
  Turista Michalovce", the kind, street, "180 m od centra Michalovce", the opening hours from OpenStreetMap as text
  ("otvorené do 17:00 (podľa OpenStreetMap)", nothing when OpenStreetMap has none), **zásoby neoverené**, buttons
  Zavolať (only with a phone in the data) and Navigovať, the shop on OpenStreetMap, "údaje z OpenStreetMap (pred 3 h)";
  "© OpenStreetMap contributors" under the list. A shop that is already in Cacaduu is not repeated. With Google Places
  switched on, a second list from Google Maps (with "Google Maps" under it; never on the map, never seen by the AI).
- **Layer 4 – the web**: the product on the larger shops' websites the admin allowed (Decathlon, dm, Exisport,
  Intersport, Action …), searched by Claude's web search for a shopper in that town. A card: "Z webu · Decathlon", the
  page's title (link to the page), "cena podľa webu: 39,99 €" (only when the page's own text shows a price), "overte
  dostupnosť na stránke →", "zistené (práve teraz)". Never a store stock claim. Under them "Hľadať priamo v e-shope:"
  with a link to each shop's own search for the product (the admin's search address).
- **Order and groups:** Overené v Cacaduu (current, then recent, then stale) → Partneri (fresh first) → Obchody v okolí
  (neoverené) → Na webe. The thinking line follows the real steps ("Hľadám v obchodoch…", "Hľadám u partnerov…",
  "Hľadám obchody v okolí…", "Hľadám na webe…"). Only Cacaduu shops go on "Ukázať na mape".
- **No town** in the question and too little in Cacaduu: the answer shows what Cacaduu has and asks "V ktorom meste
  hľadáte?"; the follow-up ("v Michalovciach") searches nearby and on the web for the same product.
- **Nothing anywhere:** the answer says so and shows what was searched. "Opýtajte sa obchodov" / "Upozorniť ma" do not
  exist yet. When the day's limit of outside searches is used up: "Prehľadali sme len ponuky v Cacaduu."
- A link "Súkromie a zdroje" under the outside results leads to the list of services on the privacy page.

### 5.2 Shop page (`/[lang]/shops/{slug}`)

- **Order** (Prompt 9A, details under the name at the owner's request; the same on the shop's own domain): 1) name
  (+ logo) with the **shop details** right under it, as before (address, facilities, card payment, then directions,
  phone, website, e-mail, Facebook, booking link); 2) the map with the shop's status dot (no legend); 3) **opening
  hours**: the status line ("Otvorené · zatvára o 17:00", "Obedňajšia prestávka · otvára
  o 12:30", "Zatvorené · otvára zajtra o 8:00", "Štátny sviatok – overte otváracie hodiny", with a small "sviatok" /
  "mimoriadne" label for special hours), the week with today in bold, breaks in the day's row ("8:00–12:00,
  12:30–17:00"), then the holidays and special days of the next 14 days; 4) the **AI assistant**, shown directly and
  always open (paid plan); 5) **"Mám prístupový kľúč"** as a closed dropdown under it (paid plan); 6) the items, with
  the stock freshness line. The shop's **page sections** (6.14) sit where the owner put them: after the details,
  after the map, after the opening hours (between the hours and the assistant; update 31), before the items or at the
  end. Shops without the plan: the same without the assistant and the key; their page sections (update 30) sit
  directly after the opening hours, before the items.
- **On the shop's own domain** there is no Cacaduu header: the shop's own header is as before update 28 — a **small
  logo at the top left that leads to the shop's home page** (its "Logo v hlavičke webu", update 31; without one the
  shop's logo; without a logo its name), or to the address the owner set as "Odkaz loga" (update 32, e.g. the shop's
  main website; same window), and the SK · HU · EN switch on the right, a thin line under it (the header
  picture of update 28 is no longer shown); the shop's name and logo are on the page itself, above its details, as
  on the Cacaduu address ("/" is the shop's language, "/hu", "/en"; an item page keeps the item).
- **"Novinky"** (update 37): a link in the details row to the shop's blog (6.15), only when it has at least one
  visible post and the slider (6.16) has no "Všetky novinky" link.
- **"Obsah stránky"** (update 38): one slider of blog posts, PDFs and pictures right after the opening hours, before
  the assistant (a free page: before "Tovar v obchode"), on the Cacaduu address and the own domain (6.16). It replaces
  the page sections of updates 28–31 and any separate "Novinky" preview.
- Name, logo, address, phone, website, the shop's e-mail (mailto) and Facebook page (new tab) as small black icons
  with text, "Get directions" (Google Maps with the shop's coordinates), map pin.
- **Booking link** (update 26, every shop, optional): "Rezervovať termín" in the same row and style as the e-mail
  and Facebook page (small black calendar icon + underlined text); it opens the shop's page in its booking app
  (Reservio, Bookio, Calendly, its own booking page …) in a new tab (`rel="noopener"`). PPI only links to it; booking
  happens in that app.
- Opening hours for the week in the shop's time zone, with the live status (6.6): the browser recomputes it right after
  the page loads and every minute while it is open (no server polling).
- Facilities: customer toilet, bidet shower ("Bidetová sprška"; the field is still called has_douchette), card payment.
- Stock freshness line, then the shop's public items: searchable in all three languages, 50 per page, name +
  translation, price and availability.
- JSON-LD `Store` (address, geo, opening hours, phone, `email`, `sameAs` = website and Facebook page, logo,
  `paymentAccepted`, `amenityFeature`, and with a booking link `potentialAction` = `ReserveAction` → the link;
  `specialOpeningHoursSpecification` for the next 60 days: the owner's special days and the days shops must close by
  law — public days off where shops may open are left out, their hours are not known).
- **AI assistant** (only when the shop has the paid plan and the Anthropic key is set in Vercel): shown directly under
  the opening hours, always open (no dropdown), titled "Ask the shop's assistant" in the page language — or the
  owner's own label and welcome message (plain text, shown as written; empty = the default texts). The conversation
  scrolls in its own area (at most about half the screen on a phone), so the rest of the page stays reachable. The shopper can ask about the shop's
  items, prices and availability; ask for a shopping list for a job (shown as a list with quantity, price and each
  item's availability, with "Copy list" and "Print list"); or add a photo of a device, part, model plate or serial
  number — the assistant says what it read, searches the shop and says plainly whether the shop has a match, is not
  sure (and asks), or has none. Every answer shows the items it is about as cards linking to their item pages. The
  rest of the page is server-rendered without it.
- With the shop's **documents** (6.9) the assistant also answers from the shop's catalogues, manuals, price lists and
  projects, in the shopper's language, naming the source under the answer ("From: Katalóg 2026, page 4", with "Open
  PDF" when the owner allows downloads), and shows fitting pictures of the shop ("From: Projekty 2025, page 3"). A price
  from a document is shown apart from the shop's price ("Price in “Trade price list 2026”, page 2: 18,40 €"). When
  neither the stock nor the documents answer, it says so and shows "Call the shop" with the phone number. When the
  shop has a booking link and the shopper wants an appointment, it points to the "Rezervovať termín" link (it never
  promises a date or time).
- **"Mám prístupový kľúč"** (a closed dropdown under the assistant; open while a folder is unlocked), or a message
  that is nothing but a valid key: opens the shop's private folders named by the key for 24 hours on this browser, or
  until "Znova zamknúť" or the page is left ("Prístup k priečinku <name> odomknutý", "Znova zamknúť"). A wrong key says "Nesprávny kľúč". The key is never
  part of the conversation and never reaches the AI. Then the folder's files are listed with **Otvoriť** (the viewer)
  and, when the owner allows, **Stiahnuť** and **Stiahnuť celý priečinok (ZIP)** (6.12).
- **"Stiahnuť túto konverzáciu (PDF)"** (archive on, unless the owner turned it off): the shopper's own conversation
  so far, labelled in the page's language, without the owner's Slovak versions; made on request, never stored.
- **Files and the archive** (6.10): "Add photo or PDF" takes up to 4 files per message and 10 per conversation (JPG,
  PNG, WebP, HEIC, PDF, 10 MB each). One line under the welcome text says "Konverzácia a nahrané súbory sa ukladajú pre
  obchod <name>. Viac" (→ `/[lang]/sukromie-asistent`, a draft text for now). The shopper can **"Vymazať moju
  konverzáciu"**; "New conversation", leaving the page or 30 minutes without a message ends the conversation.

### 5.3 Item page (`/[lang]/items/{id}`)

- Item name as the shop wrote it, its name in the page language under it, brand, EAN, price, availability with
  freshness, shop card with directions and the shop's status (dot + words). The page title carries both names. The
  map's pins show each shop's status (tooltip in words).
- "Also available at": the same product (EAN) in other shops, nearest to this shop first (or "We did not find this
  product in other shops."). **Not on product pages of shops with the paid plan or a domain of their own** (being set
  up or live; `shop_stands_alone()`, update 26 — before it the plan alone): no block, no text, no other shops on the map
  or in the JSON-LD; the shop's own assistant never names other shops either. The same on the shop's own domain. Shops
  without the plan and the main search work as before.
- JSON-LD `Product` (translation as `alternateName`) with an `Offer` (price, currency, availability) only when the
  shop is not stale.

### 5.4 Languages

- Every page exists in Slovak (`/sk`), Hungarian (`/hu`) and English (`/en`), with a SK · HU · EN switch in the header.
- Without a language in the address, PPI uses the remembered choice, then the browser's language, then English.

### 5.5 Accounts

- **Sign up** (`/signup`): e-mail, password (at least 8 characters), password again. Supabase sends a confirmation
  e-mail; the link logs the owner in and opens "My shop".
- **Log in** (`/login`) with e-mail and password. Clear messages for a wrong password or an unconfirmed e-mail.
- **Forgot password** (`/forgot`): a reset link by e-mail (same answer whether the address exists or not); the link opens
  **Change password** (`/password`), which is also in the account menu.
- The account menu: My shop · AI Assistant · Export folder · Subscription and domain · Password · Sign out (the shop
  pages keep the shop that is open). "My shop" holds the stock-file columns, details, logo, items, the plan and
  deleting the shop; **AI Assistant** (`/[lang]/dashboard/assistant`) holds Shop assistant, Assistant conversations,
  Cloud folder and Documents for the assistant; **Export folder** (`/[lang]/sync`, also the shop PC's window) holds
  the export folder, Files in private folders and Recently uploaded files. Old links to a moved section open it on its
  new page.

### 5.6 Owner dashboard — "My shop" (`/[lang]/dashboard`)

- **Add your shop** (shown when the account has none, or via "+ Add another shop"): name, street, town, country (two
  letters), time zone, phone, company ID, website, location on the map, opening hours (several ranges per day),
  facilities, contact e-mail and Facebook page (optional; only facebook.com / fb.com links), booking link (optional,
  "Odkaz na rezervácie": the shop's page in a booking app; https only, a bare address gets https://), "Visible to shoppers"
  (ticked by default). The page address is made from name and town and made unique.
  At most 5 shops per account. After creating: three next steps are shown.
- Every main section is a **dropdown** with its heading and a one-line summary while closed ("Last upload: today
  14:20 · 152 products", "Approved – new files are applied automatically.", "Button: “…”", …). On a phone only the
  first section starts open, on a computer all of them; what the owner opens or closes is remembered on that device.
  The section a form was sent from opens with its message.
- **Export folder** section (page Export folder):
  - status: latest file time, Current/Recent/Stale, "PPI window on the shop PC last active", last file received, last
    error;
  - **Connect folder** (Edge/Chrome) and **Upload file** (any browser), with the result of each send;
  - the rules for the stock software's export (below) and a link to the full-screen `/sync` page.
- **Files in private folders** (page Export folder; owner only): every PDF and picture of the shop's private folders with its name,
  upload date, folder and "Access key: on/off" (on = a valid key opens that folder), **Open** (a 10-minute link, new
  tab) and **Delete** (as in Documents for the assistant).
- **Konverzácie do počítača** (page Export folder; paid plan; since 2026-10-14): the owner picks a folder on the shop PC
  once (Edge or Chrome on a computer, like the export folder; remembered in that browser; "Povoliť ukladanie do
  priečinka" when the browser asks again after a restart). While the page is open, every 5 minutes each finished
  conversation of the shop's assistant is saved there as its PDF (with the shopper's pictures):
  `<YYYY-MM>/<YYYY-MM-DD_HH-MM_id>.pdf`. From the moment the folder is chosen (looking back 45 minutes, so a
  conversation going on then is saved however it ends); **Uložiť aj staršie konverzácie** saves every one still kept.
  **Nothing in the folder is ever replaced or deleted** (a file of the same name stays as it is); what was saved is
  remembered in the browser, so a PDF the owner moves away is not saved again. One window per shop saves (a second one
  waits). Shown: the folder, how many were saved on this computer, last and next check, the result ("Uložené nové
  konverzácie: n." / "Žiadne nové konverzácie." / the PDF still being made / an error, tried again). **Zmeniť
  priečinok**, **Prestať ukladať** (forgets the folder; the files stay). Firefox and Safari get a message pointing to
  "Stiahnuť PDF".
- **Recently uploaded files** (page Export folder): a card per received stock file, the last 10 (swipe on a phone, arrows on a computer):
  file name, date and time, products imported, rows skipped, status (OK / errors / waiting for column approval) and
  the first 5 rows exactly as in the file — approved columns only, never a private column (no preview before the
  columns are approved). A tap on a card (or "Rýchly náhľad") opens the **quick view**: the file's full import report
  (received, file time, rows in the file, imported, set to sold out, skipped, error, the 5-row preview) as a
  slideshow over the 10 files, newest first — "Súbor 3 z 10", "← Novší" / "Starší →", the ← → keys or a swipe on a
  phone, Esc or "Zavrieť" closes it (full screen on a phone).
- **Stock file columns:** after the first file, one drop-down per field (item code, name, EAN, brand, quantity, price,
  currency) listing every column name of the file, pre-filled with the proposal, next to the file's first rows (before
  approval 3 rows without the columns whose name points to purchase price, supplier, margin or invoice; after it only
  the approved columns). Code, name, quantity and price are required. **Approve columns** → from then on every new
  file is applied automatically. A note says that the columns not chosen stay private.
- **Shop details:** everything from "Add your shop", editable. Opening hours: several ranges per day; **"+ Obedňajšia
  prestávka"** (from–to) splits the day's range in two (no new data field); a closing time before the opening time
  ("22:00–2:00") runs past midnight and belongs to the day it starts.
- **Sviatky a mimoriadne zatvorenie** (every shop; database update 27): the switch **"Automatické štátne sviatky"** (on
  by default; "Zapnuté: na štátne sviatky sa pri obchode zobrazí sviatok alebo zatvorené podľa zákona. Vypnuté: platia
  vaše bežné otváracie hodiny aj počas sviatkov (napr. lekáreň, čerpacia stanica, obchod, ktorý má otvorené vždy).");
  add a date or a date range (≤ 62 days) as "Zatvorené celý deň" or other hours (a break allowed) with an optional
  note (≤ 100, plain text), change and delete (past dates disappear after 7 days); **ticks** on "Vaše mimoriadne dni"
  for deleting several at once: a click anywhere on a day's line ticks it, "Vybrať všetko", "Vymazať vybrané (n)"
  (off until a day is ticked; asks "Vymazať vybrané mimoriadne dni (n)?" first; "Vybrané mimoriadne dni sú vymazané.";
  nothing ticked → "Vyberte aspoň jeden deň."); the country's public holidays of
  the next 60 days (hidden when the switch is off) with one button each: "Otvorené ako zvyčajne" (that weekday's
  regular hours), "Zatvorené", "Iné hodiny" (the form with that date).
- **Logo v hlavičke webu** (Pro or a domain of its own; update 31, replaces "Obrázok v hlavičke webu"): the small
  logo at the top left of the shop's own domain, a link to its home page. The section explains which pictures are
  fine: PNG or WebP with a transparent background (JPG too), a wide or square logo, at least 120 px high. The browser
  makes it at most 120 px high and 600 px wide (transparency kept; WebP, PNG where the browser cannot write WebP; the
  picture's own data does not survive), the server checks it again (sharp), it is stored in the shop's folder of the
  public `logos` bucket and shown 40 px high (36 px on a phone). A preview shows it as in the header; "Odstrániť logo"
  removes it and its file, and the shop's logo is used again.
  **Odkaz loga** (update 32, same plan rule): where a click on the logo leads — any https address of a real host
  (≤ 500 characters, e.g. the shop's main website or e-shop), typed with or without https:// (http becomes https),
  opened in the same window; empty = the website's home page (the default). The section says where the logo leads
  now ("Logo vedie na: …" / "Logo vedie na úvodnú stránku webu."), and the closed section's line adds "odkaz: …".
  "Späť na úvodnú stránku" is always there while a link is set, also after Pro ended (then without the field). It
  applies to whatever the header shows (the header logo, the shop's logo or its name); the shop's name on an item
  page still leads to the shop's home page. A wrong address is refused ("Odkaz nie je platný …") and the old one stays.
- **Obsah stránky** (update 38, its own page in Môj obchod; it replaces "Sekcie stránky (PDF)"): the shop page's one
  slider of blog posts, PDFs and pictures and the library of the shop's files — see 6.16.
- **Logo:** blue "Select picture" link; the picture is shrunk in the browser (512 px, WebP) and uploaded at once,
  with a small PNG copy (256 px) for the conversation PDFs.
- **Items:** name (and its translation), code, price, quantity, what shoppers see ("12 in stock" / "Out of stock",
  exactly as in the file); search, 50 per page. **Correct the translation** per item (Slovak, Hungarian, English): a corrected item is never translated by
  machine again ("Translate automatically" hands it back); a note appears when the shop renames a corrected item.
- **Shop assistant** (page AI Assistant; paid plan): the button label (up to 40 characters) and the welcome message shown when the
  assistant opens (up to 300). Plain text only: HTML, links and e-mail addresses are removed (the owner is told);
  empty = the default texts in the page language. Without the plan the section only says it is part of the plan.
- **Konverzácie asistenta** (page AI Assistant, tab "Konverzácie" since update 55, 6.30; paid plan; owners only; see
  6.10): how long conversations are kept ("Neobmedzene" — the default since update 55 — or 30, 90 or 365 days); search words (any message or its Slovak version) and a date range (in the shop's time zone);
  the list, newest first: date and time, the shopper's language, number of messages, a paperclip with the number of
  files, the first question; 20 per page. **Open** shows the whole conversation: every message with its time and
  "Zákazník"/"Asistent", the Slovak version in grey under a foreign message, the item cards as the shopper saw them
  (name, price, availability, "Údaje k <time>"), the shopper's photos (shown in the browser, larger in a new tab) and
  files ("Zobraziť", a 10-minute link). **Stiahnuť PDF** (since 2026-10-14) on every finished conversation, in the list and
  on its page, saves its PDF (with the shopper's pictures) straight to the PC under its own name; ticks with **Vybrať
  všetko** and **Stiahnuť vybrané (n)** download each ticked conversation as its own PDF, one after another (no ZIP;
  "Hotovo – PDF sú v priečinku Stiahnuté súbory.", or how many have no PDF yet); a running conversation has no tick
  and no button yet. **Delete** (with a confirmation tick) removes the
  conversation, its files and its PDF.
- **Plan:** current plan (Free or Pro), the subscription's state (Active, Trial, Payment failed, Cancelled, …) and
  "Renews on" or "Ends on" with the date in the shop's time zone. **Upgrade** opens the Stripe payment page; **Manage
  subscription** opens the Stripe customer portal (cancel, change card, invoices). After paying, the owner comes back to
  this section with a thank-you note. A hint asks for the company ID in Shop details first, so it is on the first invoice.
- **Documents for the assistant** (page AI Assistant; paid plan; see 6.9): before the first upload a tick box ("Public folder: anyone can
  see it. Private folder: anyone with a key can see it, and keys can be passed on. No personal data, and no photos of
  people without their consent."); what is used of the shop's limits; one box **Upload files** for PDFs and
  pictures together (JPEG/PNG/WebP; up to 20 at once, chosen with the blue "Choose files" link or dropped; optional
  name — several files get it with a number —, description, folder; PDFs read in the browser with progress "File 2 of
  5 … Reading page 12 of 80…"; a file that fails is listed, the others still go). **Folders:** the Public folder and up to 19 private ones (create, rename, delete when empty).
  **Documents:** name, description, folder, pages, language, uploaded date, status (Processing / Ready / Error), the two
  switches "Assistant may use it" and "Shoppers may download it" (off by default), the pictures taken out of the PDF,
  Delete. **Pictures:** thumbnail, title, description, "Assistant may show it", and what the AI saw in it — the owner
  may correct that description (then it is theirs). **Access keys:** label, folders, optional expiry date, created,
  expires, last used, times used, Active / Expired / Revoked, **Revoke**; a new key is shown once, with **Copy**.
  Without the plan, documents already uploaded can still be deleted. Update 24 (6.12): each private folder shows its
  counts (unlocks, openings, downloads), **Režim prístupu** (Len zobraziť / Zobraziť a stiahnuť, with the note that
  view-only cannot stop screenshots) and its own key (**Nastaviť kľúč** / **Zmeniť kľúč**, shown once); each document
  and picture in a private folder has **Prístup s kľúčom** (Podľa priečinka / Len zobraziť / Aj stiahnuť) and each PDF
  "Zobrazenie pre zákazníkov: pripravené", or **Pripraviť na zobrazenie** for one uploaded before. "Konverzácie
  asistenta" has the switch "Zákazníci si môžu stiahnuť svoju konverzáciu (PDF)".
- **Delete shop** (with a confirmation tick). Refused while the shop's paid plan still renews (cancel it first) and
  while the shop has documents or pictures (delete them first).
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
- Every result carries `source_url` (the PPI page to cite), `name` (as the shop wrote it), `name_translated` (in the
  requested `lang`), `name_lang`, price, currency, availability text, freshness and the shop's address, coordinates and
  time zone, the quantity exactly as in the shop's file; no availability for stale shops. Each result's shop and
  `get_shop` carry the shop's **status** (`state` open / break / closed / holiday / no_hours, `text` in the requested
  language, `label`, `next_change`), the same as on the page. `get_shop` also gives the shop's e-mail, Facebook page
  and booking link. Search works across
  Slovak, Hungarian and English as on the website.
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

The file time is the file's own "last modified" time on the shop PC (with "Upload file": that of the picked file),
never later than "now". Sending the same file again, or an older one, does not make the stock fresher.

### 6.2 Availability (one rule for every shop)

| Quantity in the shop's file | Shown (sk / hu / en) |
| --- | --- |
| more than 0 | "12 ks na sklade" / "12 db raktáron" / "12 in stock" (the number exactly as in the file) |
| 0 or less (also: item missing from the file) | "Vypredané" / "Elfogyott" / "Out of stock" |

The label is computed in the database (`availability_label(quantity, freshness)`); a stale shop shows no availability
and no quantity (6.1). There is no setting for it: how stock is shown is decided only by the shop's own stock software
through the file. Every item of an active shop is shown; inactive shops are never shown. (Until migration 21 shops could
choose "exact number / in stock–low stock / available" and hide items; migration 21 removed those columns.)

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
- Items are linked across shops by EAN ("also available at"; not on product pages of shops with the paid plan).
- Every received file gets an **import report** (`stock_imports`, owner only, the last 10 per shop): file name, file
  time, received, status (`ok`, `errors` = unreadable rows or not applied, `waiting` = columns wait for approval),
  rows, imported, set to 0, skipped, error, and the first 5 rows of the approved columns exactly as in the file.

### 6.4 Item names in three languages

- After a stock file has been applied, the stock function translates, in the background, every item of that shop whose
  name has no translation yet or has changed: Claude Haiku, about 200 names per request, giving the language of the
  original and the name in plain Slovak, Hungarian and English. Shop abbreviations are written out ("Farba fas. biela
  5L" → "Fasádna farba biela 5 l" / "Homlokzatfesték fehér 5 l" / "White facade paint 5 l"); brand, sizes, model and
  part numbers stay as they are.
- It never delays or blocks the stock: the stock is saved first. If the translation fails, the names stay untranslated
  and the next file tries again. Up to 1,200 names per file; the rest follow with the next files.
- An owner's correction is never overwritten, not even when the shop renames the item.
- Without the Anthropic key in Supabase, nothing is translated and the search works on the original names.

### 6.5 AI search (the main page's chat)

- The model comes from `AI_MODEL` (default Claude Haiku); the Anthropic key is only on the server.
- The AI may only use one tool: the same `search_stock` as the API and MCP, with the town the shopper wrote as `near`
  (never a location from the device or the IP address). It searches several times when useful (names and synonyms in
  Slovak, Hungarian and English, short forms used in shop systems, related products: "leaking pipe" → sealing tape,
  silicone, pipe clamp). It states only what the searches returned and picks the items to show; the **cards are built
  on the server from the search results alone** — an item the AI names that no search returned is dropped — so
  invented items, prices or shops cannot appear, and stale shops show no availability. Product, brand and shop names
  are data, never instructions (the system prompt says so). Purchase prices are never shown (the search has none).
- Original names first, the translation under them; the answer and its translations in the language of the question.
- At most 10 AI searches per minute per caller (hashed IP, as for the API) and `AI_DAILY_LIMIT` per day for the whole
  site (default 500). Over a limit, after 12 seconds without an answer, or on any error, the plain database search
  answers in the same chat ("Zobrazujem jednoduché výsledky vyhľadávania."). A logged-in shop owner also sees the
  reason (to test it), and every reason is written to the Vercel log as `ai-search: …`.
- "Zastaviť" / Esc stops the AI call on the server too. The server keeps no conversation and logs no question.
- Crawlers are kept away from it (robots.txt); the main page itself loads no map and no heavy script.

### 6.5a Outside sources (Prompt 11, phase A)

- **Only through the product-sources Edge Function.** The website asks it with `EXTERNAL_SEARCH_SECRET`; it keeps the
  caches, the daily limit, the switches and the outside keys. Only the product and the town go out — nothing about the
  visitor; distances are from the town's centre. No scraping of any website or internal API: only OpenStreetMap
  (Nominatim, Overpass API), Google Places (API, optional) and Claude's web search.
- **The server decides the order**, not the AI: shops nearby and the web are refused unless Cacaduu was searched first in
  that question, while it has fewer than 3 good results, and with a town the shopper wrote (the town must appear in the
  shopper's own words, bent or not: "v Michalovciach" = Michalovce). Each is asked at most once per question.
- **OpenStreetMap:** a town is geocoded with Nominatim once and kept for good (a town not found: asked again after 30
  days); shops come from the Overpass API by shop type within 7 km of the centre, kept 24 hours per town and kind; at
  most one Nominatim request per second for the whole site; every request carries a User-Agent with `ADMIN_EMAIL` (no
  contact address: OpenStreetMap is not asked); short timeouts. Opening hours read with the opening_hours library in the
  town's own time zone (looked up from the town's centre).
- **Google Places** (optional): only when `GOOGLE_PLACES_ENABLED=true`, `GOOGLE_PLACES_API_KEY` is set and the admin's
  switch is on. Nearby Search (New) with a field mask of only the fields shown (id, name, address, location, Google Maps
  link); Google's results only in their own list with Google's attribution, never on our map and never sent to the AI;
  nothing of Google is stored (not even place ids).
- **Web:** Claude's web search (`web_search_20250305`, the model from `AI_MODEL`) with `allowed_domains` = the admin's
  enabled domains, `max_uses` 3 and `user_location` = the town and its country; the cards are the pages it found and
  cited on those domains (checked again on our side), with their title and link (the citation); a price only from the
  cited text of the page. Web results are not stored anywhere; they live only in the chat in the browser.
- **Cards only from the tool results** (as in Prompt 10): the AI's refs only choose and order them. Text from shops,
  maps and web pages is data, never instructions (the system prompts say so; the web search's own text is never shown).
- **Cost and limits:** `EXTERNAL_SEARCH_DAILY_LIMIT` (default 300) counts every outside call of the day together; over
  it, shops nearby and the web are skipped (even what is cached) and the answer says only Cacaduu was searched. Every
  call is counted per day, layer and service with its estimated cost (web search $10 per 1,000 searches plus the
  model's tokens; Google per the admin's price per call), shown to the admin. A layer runs only when its environment
  switch (`WEB_SEARCH_ENABLED`, `GOOGLE_PLACES_ENABLED`) and the admin's switch are both on. The per-visitor limits of
  the AI search stay. Ranking never depends on payment or affiliate commission.
- **Admin** ("Predplatné a domény" → "Vyhľadávanie mimo Cacaduu"): a switch per layer next to the environment's state,
  the estimated prices, the allowed web domains (ASCII only, no wildcard) with their search addresses (https on the
  shop's own host, `{query}` once), today's calls and the calls and cost per day and layer. Every read and write is
  checked by `is_admin()` in the database.

### 6.5b Partner feeds (Prompt 11, phase B)

- **Admin "Partnerské feedy"** (on "Predplatné a domény"): add a partner with its name, logo (PNG/JPG/WebP ≤ 1 MB, stored
  as a small WebP, shown in grey), the feed — an https address or a file the admin uploads (it goes from the browser
  straight to private storage) —, its format (Google Merchant XML, Google Merchant CSV/TSV, Heureka XML, own CSV with
  columns by name), an optional local inventory feed (Google's format: store_code, id, availability, quantity; address
  or file), how often it is read (every hour, 6 hours, **daily by default**, weekly), the time zone its times are shown
  in, the currency (required for Heureka, whose feed names none), affiliate yes/no, on/off, and the store list with
  addresses when the partner gives one ("kód;názov;adresa;mesto;PSČ;krajina;šírka;dĺžka", a wrong line is named).
  Per partner: counts (products, how many with data under 48 hours, stores, store stock rows), the time of the data,
  the next import, the last imports with their reason when one failed, "Importovať teraz" (reads everything again).
- **Import** (Edge Function partner-feeds, pg_cron every 5 minutes): the feed is streamed — gzip unpacked on the way —
  into parts of 4 MB in private storage, then read one part per call (an Edge Function has 2 seconds of CPU), each call
  starting the next. A feed over `PARTNER_FEED_MAX_MB` (default 50, at most 500) **stops with "too_big"**: nothing is
  imported and nothing is cut; the admin sees why and what to do. A partner's server that answers "not modified" (304)
  changes nothing. A readable feed replaces that partner's rows (items it no longer has are removed); a feed with no
  readable rows, or more unreadable rows than readable ones, leaves the earlier data. Failures are tried again within
  the hour (too big: at the partner's next turn); an import stuck 30 times is given up.
- **As the partner sent it:** names, prices, availability words, links — never corrected, translated or completed; a
  row the database cannot hold as sent is counted unreadable, never cut. Columns of an own CSV outside the known names
  are never stored. Stock per store comes only from the local inventory feed.
- **Never mixed with the shops' data:** own tables, never in `public_stock`, `search_stock`, the public API, MCP, the
  plain search, shop or item pages; only in the main chat, under "Partneri".
- **Safety:** feed addresses only https of a real host name (no IP addresses, no local names, no user:password), each
  forward checked the same way, at most 5; addresses may hold a partner's token and are never logged.

### 6.6 Status: open / lunch break / closed / holiday / no hours

One function (`src/lib/hours.ts`, `shopStatus()`) for the server render, the browser's minute refresh, the API and MCP,
in the shop's own time zone. The first rule that applies wins:

1. **Special hours the owner set for that date**: green / blue / red from those hours, with a small "sviatok" (on a
   holiday) or "mimoriadne" label; "Zatvorené celý deň" = red.
2. Only with "Automatické štátne sviatky" on — **a day shops must close by law** (SK: 1.1, Good Friday, Easter Sunday,
   24.12 from 12:00, 25.12, 26.12): red "Zatvorené – štátny sviatok" (from the closing time when it starts at noon;
   before it, the regular hours with "sviatok").
3. Only with the switch on — **a public day off**: yellow "Štátny sviatok – overte otváracie hodiny".
4. **The regular hours**: green inside a range; blue in a gap of under 3 hours between two ranges of the day
   ("Obedňajšia prestávka · otvára o 12:30"); red before the first range, after the last, in a gap of 3 hours or more
   or on a closed day ("Zatvorené · otvára zajtra o 8:00"). A range past midnight belongs to the day it starts.
5. **No opening hours at all**: grey "Otváracie hodiny neuvedené".

Colours (the only colour on the site besides the logo, always with the words): green #1E9E5A open, blue #2F6FED lunch
break, red #D64545 closed, yellow #F2B705 public holiday, grey #9AA5B1 no hours; dots have a white outline and a thin
dark ring. Public holidays come only from `public_holidays` (SK, HU, CZ 2026–2027 from the date-holidays library via
`scripts/holidays.mjs`, corrected for the law; the admin's rows win). Slovakia 2026: days off 1.1, 6.1, 3.4, 6.4, 1.5,
5.7, 29.8, 1.11, 24.12, 25.12, 26.12 — 8.5 and 15.9 are not days off in 2026 only, 1.9 and 17.11 no longer; 2027:
8.5 and 15.9 are days off again (unless the law changes again). Hungary and Czechia: the library's public holidays,
all as days off (shops-closed rules there depend on the shop's size and type; the admin adds them per date).

### 6.7 Paid plan

- One monthly subscription per shop (price `STRIPE_PRICE_PRO` in Stripe); one Stripe customer per shop, made before its
  first payment page. Stripe **test mode** first: no real money until the secrets are switched to live ones.
- **`shop_has_plan(shop)` is the only answer** to "has this shop paid?": the subscription is `active` or `trialing` and
  `current_period_end` has not passed. Payment failed (`past_due`, `unpaid`), paused, cancelled or never paid → no.
  Every paid feature will ask this one function; nothing else decides it.
- Only the shop's owners can open Stripe for it. A shop whose subscription is still live gets the customer portal,
  never a second payment page.
- The payment page collects what the invoice needs: the company name (required), the billing address, the VAT number
  (optional; Stripe checks its format) and the company ID (optional, pre-filled from Shop details). Stripe Tax adds VAT
  automatically. The company ID from Shop details is on the first invoice; one typed or changed on the payment page is
  on the invoices from the next one on.
- Cancelling in the portal ends the plan at the end of the paid period ("Ends on …"); until then the shop keeps it.
- A shop whose plan still renews cannot be deleted (it would keep being charged); once cancelled it can.

### 6.8 Shop assistant

- A paid feature: shown and answered only while `shop_has_plan(shop)` is true; the database checks it again for every
  message (`shop_chat_hit()`).
- Claude (`AI_MODEL`, default Claude Haiku `claude-haiku-5-5`) with tools bound to this shop on the server: search
  this shop's items (`shop_stock`), one item's details (`public_stock` of this shop) and, when the shop has documents,
  search them (`search_shop_docs`, 6.9). It cannot see other shops and never names them. Cards and the shopping list are built only from what those tools returned (anything else is dropped), with
  availability, quantities and freshness from the database: a stale shop shows no availability.
- Photos and PDFs: the AI gets each photo shrunk in the browser to at most 1568 px (JPEG) and each PDF's text (its
  first 5 pages, read in the browser), once, with that message only. The files themselves are kept only in the shop's
  conversation archive (6.10). The answer always says what was read; "match found" needs an item from the shop to show,
  otherwise it becomes "not sure" and the assistant asks. A HEIC photo the browser cannot read is stored, and the AI is
  told it could not see it.
- Every answer also gives the shopper's language and, for the archive, the message and the answer in Slovak.
- An access key pasted into the chat is replaced by "[•••]" before the AI or the archive sees it.
- Limits: 20 messages an hour per shopper (hashed IP, logged in `api_usage` as `shop-chat`), and a monthly cap per shop
  (`CHAT_MONTHLY_LIMIT_PER_SHOP`, default 1,000; 0 switches the assistants off). Only the last 8 messages of a
  conversation are sent along, each up to 1,500 characters. Over a limit the shopper is told in the chat.
- A logged-in owner who tests it sees the reason of a failure (for example Claude's error); shoppers see a plain message.

### 6.9 Documents and pictures for the assistant

- A paid feature: uploads, the assistant's use and shoppers' files all need `shop_has_plan(shop)` (and an active shop).
- **Never products.** Documents and pictures are information for the assistant, never product listings and never proof
  of stock: items, prices and availability come only from the stock file. A document price is always labelled with its
  document and page and shown apart from the shop's price; it is shown only if the excerpt really contains it.
- **PPI never edits the owner's files and never translates or stores them translated.** The PDF is stored as uploaded;
  its text is kept as written (only line ends and spaces tidied), page by page, in excerpts of up to about 800 words;
  the owner's own pictures are only made smaller (at most 1568 px, WebP). The only thing the owner corrects is the
  AI-written description of a picture.
- Reading a PDF happens in the owner's browser (pdf.js): the text of each page; the pictures in it (at least 200 px,
  each picture once; a page whose pictures cannot be taken out is kept as one picture); pages without text (scans) are
  rendered and the AI writes out their text as written. The AI (`AI_MODEL`, default Claude Haiku) describes each
  picture once, briefly and factually (what is shown, visible text, model and part numbers).
- Limits per shop (Supabase secrets): `SHOP_DOCS_MAX_FILES` 30 documents, `SHOP_DOCS_MAX_PAGES` 500 pages,
  `SHOP_DOCS_MAX_PICTURES` 300 pictures (own and from PDFs); a PDF up to 20 MB, a picture up to 10 MB before shrinking;
  at most 100 pictures taken from one PDF; 20 folders, 100 active keys.
- **Folders.** Each shop has one Public folder (anyone may ask about it) and private folders. A private folder is
  opened only by an access key: random, 20 characters (`XXXX-XXXX-XXXX-XXXX-XXXX`, no look-alike letters), shown once,
  stored only as a SHA-256 hash, for one or several folders, optionally expiring, revocable at once. A key opens its
  folders for 12 hours (a session token, stored as a hash, kept in a signed HttpOnly cookie for that one shop);
  revoking or expiry closes them at once; "Lock again" deletes the session. At most 5 wrong keys per caller per shop in
  15 minutes.
- **The database decides who sees what** (`search_shop_docs()`, `shop_file_path()`): the shop's Public folder plus the
  folders of a valid session of that shop, only documents with "Assistant may use it", only pictures with "Assistant
  may show it", only files the owner lets shoppers download. Nobody can ask for a folder by its id.
- Private content never appears in pages, JSON-LD, the sitemap, llms.txt, the public API, MCP or the main-page AI
  search; documents appear only in the shop assistant.
- The assistant searches documents in their language and answers in the shopper's; text from documents is treated as
  information, never as instructions. With a shopper's photo it looks in the stock first and may mention similar
  pictures of the shop separately.
- Deleting a document deletes its file, its pictures and all its text; deleting a picture its file and description.
- Database update 24 (6.12): a key opens its folders for 24 hours (not 12), and the chat box locks them when it closes;
  a private folder's files open for shoppers through the viewer and its access mode, not through "Shoppers may
  download it" (that switch now applies to the Public folder only).

### 6.10 Conversation archive (paid plan)

- **What is kept:** every conversation with a shop's assistant while the archive is on: the shop, the conversation's
  id, start and end, the page language and the shopper's language, every message (who, text, time), the Slovak
  version of each message in another language, the item cards with each answer as they were at that moment (name,
  price, availability text in Slovak, the time of the shop's stock data, quantity and note for shopping lists) and the
  files the shopper sent.
- **Files:** JPG, PNG, WebP, HEIC and PDF, by their real content (not their name), 10 MB each, 10 per conversation,
  stored in the private bucket `shop-assistant-uploads/<shop>/<conversation>/files/`. GPS and other place data are
  removed before storing (EXIF GPS emptied, XMP places blanked or dropped, IPTC dropped); the picture itself is not
  changed. Pictures also get a small preview (800 px JPEG, made in the browser) for the owner and the PDF. A file
  taken back before sending is deleted at once.
- **End:** 30 minutes without a message (ended at the last message), or the shopper closes the box, starts a new
  conversation or leaves the page. A message after the end starts a new conversation. Conversations without any
  message are forgotten with their files.
- **PDF per conversation**, made on the server when it ends (tried 3 times): `<YYYY-MM-DD>_<HH-MM>_<short id>.pdf`
  (start time in the shop's time zone, first 8 characters of the id) with the shop's logo and name, date and times,
  the shopper's language, every message with its time and "Zákazník"/"Asistent", foreign messages with a smaller grey
  Slovak version, each answer's cards as a table (Tovar, Cena, Dostupnosť, Údaje k), the shopper's photos large where
  they were sent (across the text width, at most about half a page high, never enlarged; since 2026-10-14 — earlier
  PDFs keep their small thumbnails) with their names, other files listed, and on every page "Vytvorené Cacaduu PPI · konverzácia <id> · strana X/Y". The font
  (DejaVu Sans) covers every Central European letter, Greek and Cyrillic; anything else (emoji) shows as "?". Kept in
  the same private folder; the owner takes it home with "Stiahnuť PDF" or through the cloud folder (6.11).
- **Who sees it:** only the shop's owners (RLS), in "Konverzácie asistenta"; never shoppers, other shops, pages, the
  API, MCP or the AI search. Conversation tokens are kept as hashes; access keys never reach a conversation.
- **Keep time:** "Neobmedzene" (kept until the owner deletes them; the default since update 55) or 30, 90 or 365 days
  after the last message (the owner chooses); only for a shop that chose a limit, a nightly job deletes older
  conversations with their files and PDF. The owner can delete one at any time. Copies already in the shop's cloud
  folder (6.11) stay there: PPI never deletes anything in it.
- **The shopper's right to delete:** "Vymazať moju konverzáciu" while the box is open deletes the conversation, its
  files and PDF at once. If it was already copied to the shop's cloud folder, only a line without any content stays in
  the owner's list ("Zákazník požiadal o vymazanie" + the cloud folder) so the owner can delete it there; "Odstrániť
  zo zoznamu" removes the line. Later the shopper asks the shop.
- **Jobs:** pg_cron calls the assistant-archive function every 5 minutes (end idle conversations, make missing PDFs,
  forget empty ones) and once a day at 03:17 UTC (keep time), with a Vault secret.

### 6.11 Cloud folder for the archive (paid plan, database update 23)

- **Where:** Môj obchod → "Cloudový priečinok" (paid plan; shown to a shop without the plan only while a cloud is still
  connected, so it can be disconnected). One cloud per shop: **Microsoft OneDrive** (Microsoft Graph) or **Dropbox**,
  behind one export adapter (connect, list and make folders, upload without replacing, renew tokens, revoke). Google
  Drive is not offered.
- **Connecting:** "Pripojiť OneDrive" / "Pripojiť Dropbox" opens the provider's own consent page (OAuth 2.0 with PKCE,
  a single-use state for 10 minutes). Permissions: OneDrive `Files.ReadWrite` + `offline_access` (Microsoft has no
  narrower permission that can create a folder of the owner's choice; app-folder access would force `/Apps/…`); Dropbox
  `files.content.write`, `files.metadata.read` (to see what is already there) and `account_info.read`, offline access.
  The page says so before connecting. The tokens are encrypted (AES-GCM, key from `EXPORT_TOKEN_ENCRYPTION_KEY`), kept
  only in the database, read only by the cloud-export function, renewed automatically; "Odpojiť" deletes them (Dropbox's
  token is also revoked; for Microsoft the page says where to remove the app).
- **Target folder:** default `/Cacaduu/<shop name>`; the owner types another path or browses the cloud's folders and
  makes a new one ("Prehľadávať priečinky", "Nový priečinok", "Ukladať sem"). A missing folder is made. A pasted share
  link (1drv.ms, onedrive.live.com, SharePoint, dropbox.com/scl…) is refused with an explanation that share links
  usually cannot be written to, and the OAuth buttons are offered instead.
- **What is saved, and when:** when a conversation has ended and its PDF is ready, the archive asks cloud-export to copy
  it at once (a job every 5 minutes catches anything missed): `<target>/<YYYY-MM>/<YYYY-MM-DD_HH-MM_id>/konverzacia.pdf`
  and `…/subory/<the shopper's files>` (the stored files: GPS already removed; names made safe for both clouds). Month,
  day and time in the shop's time zone, the first 8 characters of the conversation id.
- **Never duplicate, never overwrite, never delete:** every copied file is noted, so a retry continues where it
  stopped; a file of the same name that is already there with the same size and content is not sent again; a different
  one gets " (2)", " (3)"… Uploads use OneDrive's `conflictBehavior=fail` and Dropbox's `mode: add` without autorename;
  PPI sends no delete, move or replace to a cloud.
- **Status per conversation** in "Konverzácie asistenta" (list and detail): "Cloud: čaká", "Uložené v cloude" (with the
  folder) or "Cloud: chyba – <reason>", with "Uložiť znova" (checks the cloud again: files still there are not sent
  twice, missing ones are sent again, into the folder chosen now). Failed copies are tried again after 5 minutes,
  doubling up to every 6 hours, 20 times; a busy cloud's Retry-After is respected.
- **"Uložiť staršie konverzácie":** one-time copy of the archive's conversations of a chosen period (days in the shop's
  time zone) that are not in the cloud yet; the page says how many will be copied.
- **Expired connection** (password changed, app removed, refresh token too old): the connection is marked expired,
  copies wait (nothing is lost; they stay in the archive) and the page shows "Pripojenie k cloudu vypršalo – pripojte
  ho znova" with "Pripojiť znova", which keeps the folder and copies everything that waited. When copies have failed
  for 24 hours, the shop's owners get one e-mail (Brevo) with that subject and a link back to the page; the next
  e-mail only after a new failure following a success.
- **Never in the cloud:** purchase prices, suppliers, margins, invoice numbers, access keys or other shops' data (the
  PDF and the files are exactly the archive's).

### 6.12 Access keys: viewing and downloading for shoppers (paid plan, database update 24)

- **Key check, on the server only** (the AI never checks keys): "Mám prístupový kľúč" opens a key field; a chat message
  that is nothing but a key (`XXXX-XXXX-XXXX-XXXX-XXXX`, with or without dashes) is taken as a key too, never sent to
  the AI and never kept in the conversation. The database finds the key by its SHA-256 (a timing difference could at
  most tell something about a hash, never the key); 5 wrong keys per caller and shop in 15 minutes, then 15 minutes
  locked ("Príliš veľa nesprávnych kľúčov…"). Wrong → "Nesprávny kľúč"; nothing of the folder reaches the AI or the
  browser.
- **A valid key** unlocks this browser's chat session for that folder (several folders for a key made under
  "Prístupové kľúče") for 24 hours, or until the chat box closes or the page is left: "Prístup k priečinku <name>
  odomknutý". For this session only, the assistant may search the folder's documents and gets the system line "This
  customer has verified access to the folder <name>; you may use its documents in your answers."
- **Režim prístupu** per private folder (Môj obchod → Dokumenty pre asistenta → Priečinky): "Len zobraziť" (default) or
  "Zobraziť a stiahnuť"; every document and picture can override it ("Podľa priečinka" / "Len zobraziť" / "Aj
  stiahnuť"). The setup text says that view-only cannot stop screenshots.
- **Viewing (both modes):** after unlocking, the folder's files are listed in the chat with "Otvoriť": PDFs and
  pictures open in a built-in viewer over the page. A PDF is shown page by page as pictures (made in the owner's
  browser at upload; never the original file), each with a light watermark "<shop name> · VIP · <date>" drawn into
  the picture on the server (date in the shop's time zone), served inline from a signed address that lasts 10 minutes
  and works only in that browser session. View-only shows no download button and blocks right-click saving in the
  viewer. PDFs uploaded before update 24 need "Pripraviť na zobrazenie" once (the owner's browser makes the pages).
- **Downloading ("Zobraziť a stiahnuť" or a file set to "Aj stiahnuť"):** "Stiahnuť" per downloadable file (the
  original, from a 10-minute address) and "Stiahnuť celý priečinok (ZIP)" with only the downloadable files (a
  single-use address for 10 minutes; at most 100 MB, stored without compression). At most 20 downloads per unlocked
  session (a ZIP counts as one): "Dosiahli ste limit 20 stiahnutí pre toto odomknutie."
- **The folder's own key:** "Nastaviť kľúč" / "Zmeniť kľúč" per private folder; shown once with "Kopírovať", stored only
  as a hash; changing it stops the old key at once, also for anyone who opened the folder with it. Keys for partners
  (several folders, expiry date) stay under "Prístupové kľúče".
- **Counts per folder** for the owner: unlocks, openings ("Otvoriť") and downloads — no shopper data.
- **"Stiahnuť túto konverzáciu (PDF)"** for every shopper (no key needed), for their own conversation only: on by default,
  the owner turns it off in "Konverzácie asistenta".
- **Never:** keys or private documents in logs, analytics, other sessions, public pages, JSON-LD, the sitemap, search,
  the API or MCP; files of one shop through another shop's session (every check is per shop in the database).

### 6.13 Own domain (Pro, database update 25)

A shop with Pro gets its page on its own domain (e.g. `davide.sk`): bought through PPI (13) or one it already has (14).
Page: **Môj obchod → Predplatné a doména** (`/[lang]/dashboard/plan`: the plan, then "Vlastná doména").

- **13 · Buy a domain (search on websupport.sk, paste, one payment).**
  1. Box "1. Nájdite si doménu": three numbered steps, "Doménu na Websupporte NEKUPUJTE – kúpu za vás urobíme my.",
     the note "Prečo doménu vkladáte sem?", button "Vyhľadať doménu na Websupport.sk" (new tab, `rel="noopener"`,
     address from the admin's settings, default `https://www.websupport.sk`), "Doménu registruje Websupport" + a place
     for Websupport's logo.
  2. The pasted name is cleaned as typed (`https://www.Davide.sk/` → `davide.sk`, shown as "Overíme: davide.sk");
     no TLD → "Zadajte celý názov aj s koncovkou, napr. davide.sk"; accents → written without them; a TLD not in the
     price table → "Túto koncovku zatiaľ nepredávame". Availability from Websupport (`POST /v1/order/sk/validate/domain`):
     "✅ davide.sk je voľná · 12,90 € / rok (Pro predplatné vrátane domény)" / "❌ Táto doména je už obsadená – vyberte
     inú na Websupport.sk". The price comes only from the admin's price table (never hard-coded, never Websupport's
     partner price), is frozen on the order when shown, and **the price shown is the price charged**. "Cena domény je
     rovnaká ako na Websupport.sk" only while the admin's switch is on.
  3. The owner's details (the domain is registered **in the shop's name**: company, contact person, address, country,
     IČO, DIČ/IČ DPH, e-mail, phone; `shop_legal` + the shop's profile): only the missing ones are asked, nothing is
     invented. A Slovak IČO must pass its check digit (mod 11) before anything is paid ("IČO nie je platné…"). If
     Websupport still refuses a detail after the payment, the registration waits (no retries counted, nothing
     refunded), the shop gets one e-mail "Opravte údaje majiteľa domény …" and the page shows the refused fields with
     a form; "Uložiť a pokračovať v registrácii" continues at once.
  4. Summary + one tick for the terms (`/podmienky`, `/podmienky-domeny`: Websupport is the registrar, the shop is the
     domain's owner). On Pro with a saved card: **"Zaplatiť 12,90 €" with one click** (a Stripe invoice paid with that
     card; 3-D Secure → Stripe's invoice page). On Pro without a saved card: Stripe Checkout (card, Apple Pay, Google
     Pay). Without Pro: Pro + the domain in one Checkout ("Pro predplatné + doména dnes spolu: …"). Always a Stripe
     invoice. If Stripe refuses, the page shows Stripe's reason ("Platbu sa nepodarilo otvoriť: …") and step 4 is back
     for another try; a Stripe page left unpaid shows "Platba za … ešte nie je dokončená" with "Pokračovať v platbe" and
     "Zrušiť objednávku a vybrať inú doménu" (never stuck on "Čakáme na potvrdenie platby").
  5. After the payment (the webhook, or at once for one click): Zaplatené → Registrujem doménu → Nastavujem stránku →
     Zabezpečujem (HTTPS) → Hotovo on the page. Live: "Vaša stránka beží na davide.sk", a 5-second countdown, then
     `https://davide.sk` opens in the same tab; buttons "Otvoriť stránku" and "Vložiť do Google profilu". One e-mail
     "Vaša stránka beží na davide.sk" (link, Google button + 3 steps, the domain's expiry, link to the page, the
     invoice) — sent once, also when the page was closed. The shop never sees DNS for a bought domain.
  6. Taken between the check and our order: the domain part is refunded automatically (Pro stays), an e-mail and a
     message on the page; any other registration failure after 12 tries: refund + the admin is flagged.
- **14 · Connect a domain the shop already has** (Pro only): "Už mám vlastnú doménu" → the domain (bare + www) is added
  to the Vercel project → the page shows exactly the records Vercel asks for (A `@`, CNAME `www`, TXT `_vercel` when
  Vercel needs proof) with "Kopírovať" and "Neodstraňujte existujúce MX záznamy, inak prestane fungovať e-mail." →
  "Skontrolovať" (at most every 30 seconds) and automatic checks (every 10 minutes for 2 hours, then every 3 hours, for
  7 days) → Čaká na DNS → Overené → Zabezpečujem → Beží, then the same countdown and e-mail as above. A reminder e-mail
  with the records after 24 hours; after 7 days without records it stops ("Neoverená do 7 dní", start again any time).
  A domain that is in PPI's own Websupport account gets its records written automatically. "Odpojiť doménu" (with a
  tick) removes it.
- **Registrar (Websupport) in the shop's name.** Every order is placed only after Stripe confirmed the payment, with a
  Websupport domain profile holding the shop's company details (the shop is the registrant and legal owner; never
  Cacaduu), paid from PPI's prepaid Websupport credit. Low credit → the order waits ("Registrujem doménu"), the admin
  gets "Dobite kredit na Websupport", and it continues by itself. DNS: only the website records Vercel asks for are
  added or replaced; MX, SPF, DKIM, DMARC and every other record are never touched. A repeated Stripe event never
  orders twice; every step is written to the order's log. `REGISTRAR_MODE=test` (the default): Websupport orders are
  dry runs, nothing is paid from the credit, and the website goes on the admin's **test domain**.
- **The shop's own domain serves its Pro page directly** (no redirect): `/` in the shop's language (SK → sk, HU → hu,
  else en), `/hu`, `/en`, items at `/{lang}/items/{id}`, its own `sitemap.xml`, `robots.txt`, `llms.txt` and IndexNow
  key file (update 33, below); `www` → 308 to the bare
  domain; anything else (login, other shops) → PPI's own address; an unknown host → "Táto doména zatiaľ nie je
  pripojená". Canonical = the own domain; the Cacaduu shop and item pages point their canonical there, and the main
  sitemap leaves them out. JSON-LD stays honest (the shop's own data); Pro product pages show no other shops (6.7).
- **Easy to find (update 33).** Under the live domain on "Predplatné a doména", the box **"Aby vás našli Google a AI
  asistenti"**:
  - **"Overiť v Google Search Console"**: three steps (open Search Console → Pridať vlastníctvo → Doména → the domain;
    copy the TXT value "google-site-verification=…"; click Overiť), a field for the value (since update 36 only the
    whole value "google-site-verification=…", quotes allowed; the token alone, an HTML tag or any other text is refused:
    "Toto nie je hodnota TXT zo Search Console …").
    A domain whose DNS Cacaduu runs (bought here, or an own domain in PPI's Websupport account): **"Zapísať do DNS"**
    adds one TXT record at the domain itself through the Websupport DNS API — **only added**: no record is ever
    replaced or removed (MX, SPF, DKIM, DMARC and every other TXT stay), the same value is never added twice, at most
    5 Google values per domain ("Doména už má 5 overovacích záznamov Google …"), at most once in 10 seconds ("Chvíľu
    počkajte …"); "Záznam TXT je zapísaný v DNS domény … V Search Console kliknite na Overiť". An own domain elsewhere:
    **"Zobraziť záznam"** shows the record to add (TXT · `@` or the subdomain's name · the value, "Kopírovať") with
    "Existujúce záznamy nemeňte ani nemažte (najmä MX, SPF, DKIM a DMARC) …". The value and how it was handled stay on
    the order (`google_verification`, `_state` added|manual), every try in its log.
  - **"Odoslať sitemap: https://<doména>/sitemap.xml"**: Súbory Sitemap → "sitemap.xml" → Odoslať, the address with
    "Kopírovať".
  - **AI asistenti**: links to the domain's `llms.txt` and `robots.txt` and **"Kategórie tovaru (do llms.txt)"**
    (the owner's own words, comma separated, at most 12, each at most 40 characters, plain text; empty = none;
    `owner_set_categories()`). PPI never invents categories: without them llms.txt says "Not listed by the shop.".
  - **IndexNow**: "Po každom nahratí skladu oznámime vyhľadávačom Bing, Seznam, Yandex a ďalším, ktoré produkty sa
    zmenili …" and the last ping ("Naposledy oznámené …: n stránok." / the search engine's answer when it refused).
- **robots.txt of an own domain**: every search engine and the AI crawlers by name (GPTBot, OAI-SearchBot,
  ChatGPT-User, ClaudeBot, Claude-User, Claude-SearchBot, PerplexityBot, Perplexity-User, Google-Extended,
  Applebot-Extended, CCBot) may read the public pages; never `/api/` (the assistant, private folders, access keys and
  their files), `/auth/`, Môj obchod and the other login pages; the sitemap and llms.txt on the domain.
- **llms.txt of an own domain** (English, the shop's data as written): name, address, place, contact links, opening
  hours in the shop's time zone and the special days of the next 14 days, "Kategórie tovaru", the brands most often in
  the stock file and the number of items, the sitemap and the page addresses, and "How to read the stock" in the page's
  own words ("12 ks na sklade", "Vypredané", "Aktualizované pred 8 min", "Informácia o zásobe momentálne nie je
  dostupná" = never say it is in stock). Nothing of private folders, keys or the assistant.
- **IndexNow** (Bing, Seznam, Yandex, Naver… share one endpoint): after each stock upload that the database applied,
  in the background, **one request at most per upload** (`indexnow_claim()`), with **only the changed pages** on the
  own domain: the shop's home page (three languages) and every item whose quantity, price, currency, name, EAN or brand
  changed in that upload (each language; ≤ 10 000 addresses). An upload that changed nothing sends nothing. Only for a
  live own domain of a shop with the plan. One random key for PPI, served on every own domain as `/<key>.txt`.
- **Item pages on the own domain**: canonical = the own domain (also on the Cacaduu address); JSON-LD `@graph` of a
  Product (name, brand, GTIN, the address on the domain) with an **Offer** (price, currency, InStock / OutOfStock,
  `seller` and `availableAtOrFrom` = the shop) **only while the stock data is not stale** — exactly when the page shows
  the quantity — and the shop as a **Store** (a LocalBusiness: address, place, opening hours, special days, contact
  links, facilities; the same node as on the shop page).
- **Main Cacaduu search** (results, map pins, the AI search cards) and the "Dostupné aj v" list link a shop with a
  live own domain straight to it (its item `https://<doména>/<lang>/items/<id>` and its home page); other shops stay on
  PPI's pages. Payment never affects the order of the results.
- **Fully findable (update 36, Prompt 12).** What changed and was added on top of update 33:
  - **Search Console on a domain Cacaduu runs**: Cacaduu keeps the id of the TXT record it added
    (`google_txt_record_id`); the same value already in the DNS → nothing is added ("Táto hodnota už v DNS domény …
    je — nič sme nepridali."; state `present`). **"Odstrániť"** forgets the value and removes from the DNS **only the
    record Cacaduu added** (its id and still its value; a record someone changed is left alone) — never a record that
    was there before, never SPF, MX, DKIM, DMARC or anything else ("Záznam, ktorý pridal Cacaduu, je odstránený z
    DNS. Ostatné záznamy sme nezmenili."). A new value replaces only Cacaduu's own earlier record (the new one first).
  - **Search Console on a connected domain**: **a) "HTML značka (odporúčané)"** — property type "Predpona webovej
    adresy" `https://<doména>/`; the owner pastes Google's whole meta tag (or its content); Cacaduu adds
    `<meta name="google-site-verification" content="…">` to the shop's pages **on that domain only**; **b) "Záznam
    TXT"** — the record with "Kopírovať" next to its name and its value.
  - **"Overiť v Bing Webmaster Tools"** (every own domain): "Najjednoduchšie: … Importovať …" (Bing takes over a site
    verified in Search Console, with its sitemap), else the same meta tag method with `msvalidate.01`. The meta tag
    values (`domain_site_verifications`, one row per domain) only through `owner_set_site_verification()` (the
    shop's owners, a live domain, the format of that kind — anything else "Toto nie je značka …"); "Odstrániť
    značku". The pages read them through `site_verification_meta(slug)` (live domain + plan) and only on the request
    host that is that domain.
  - **"Odoslať sitemap: https://<doména>/sitemap.xml"** now with the steps for Google Search Console and Bing
    Webmaster Tools.
  - **llms.txt of an own domain** also says whether the shop follows public holidays ("the shop follows them — on
    those days the hours above may not apply" / "keeps its regular hours"), the item categories its pages show (only
    data that exists; never invented), and **"Machine access"**: Cacaduu's MCP server (`get_shop` with this shop's
    slug), REST API and OpenAPI, whose `source_url` points back to the domain.
  - **IndexNow on every host** (replaces update 33's per-domain ping): one key `INDEXNOW_KEY` (public by design; the
    same value in Vercel and as a Supabase secret), served as `https://<host>/<key>.txt` on the main Cacaduu domain
    and on every live own domain. After stock-pull applied a file, in the background (never delays the stock): only
    **meaningful changes** — a new item, a price or currency change, in stock ↔ sold out (a removed item becomes sold
    out); not 12 → 11 pieces (`inventory.indexnow_at`, set by the trigger). The item pages go to their **canonical
    host** (the shop's live own domain, else the main Cacaduu host from `SITE_URL`), each in sk/hu/en, ≤ 10 000
    addresses per request, one host per request, **at most once per upload and once an hour per host**; what
    changed in between goes with the next ping; a refused or failed ping is sent again with the next one (only an
    accepted answer moves on). Every ping is logged (`indexnow_pings`: host, number of addresses, answer); the owner
    sees the last one. Never private content (only item pages).
  - **Item JSON-LD**: the **Offer** follows the visible page — the price and currency whenever the page shows a price,
    the **availability only while the data is fresh** (none when stale); no price → no Offer (never invented).
    `hreflang` sk/hu/en + `x-default` (the domain's own language) on the own domain's shop and item pages.
  - **Every link to a shop with a live own domain points there**: besides the search results and the AI cards, the
    public API's and MCP's **`source_url`** (items and shops) and PPI's own **llms.txt** shop list; PPI's sitemap
    leaves those pages out.
- **Renewal and cancellation.** 30 days before expiry the renewal is charged to the saved card (a Stripe invoice); only
  after it is paid does Websupport renew from PPI's credit. E-mails 30 and 7 days before expiry; a failed renewal: a
  reminder every week with the payment link, then at expiry the domain lapses and the page is back on its Cacaduu
  address. Pro cancelled: the domain keeps working until the period ends; then the website goes back, the domain stays
  the shop's and the **transfer (auth) code** is shown on the page and e-mailed ("Prevod domény k inému
  registrátorovi") — PPI never holds a domain back. A connected domain is removed from Vercel when Pro ends.
- **Admin page "Predplatné a domény"** (`/[lang]/admin/domains`, only for `profiles.is_admin`): every shop with plan,
  status, next payment, domain (bought/connected, test), step, last error, expiry, Stripe (paid/refunded + invoice),
  Websupport order ID, live e-mail sent yes/no; search and filters; per row "Zopakovať krok", "Skontrolovať DNS",
  "Znova poslať e-mail", "Vyriešené", "Kód na prevod" (+ "Uložiť kód" by hand); Websupport credit with "Overiť kredit"
  and the low-credit limit; settings (search address, test domain, switch "Cena domény = cenník Websupport");
  the price table per TLD (domain price and renewal price in EUR, VAT included yes/no, order, active); counts of
  domains (bought/connected/live) with the partner levels 30+/50+/100+.
- **E-mails (Slovak, Brevo API):** to the shop — live, taken/failed (with the refund), DNS reminder after 24 hours,
  7-day stop, renewal notices 30/7 days, failed renewal, Pro ended (auth code); to `ADMIN_EMAIL` — low credit, failed
  registration, DNS stuck over 48 hours, an auth code Websupport did not give. Without `BREVO_API_KEY` /
  `ALERT_EMAIL_FROM` nothing is sent, the log says so, and the flow goes on.
- Payment never affects search ranking.

### 6.14 Page sections from PDFs (database updates 28–30; every shop since update 30)

> Since update 38 these sections are the files of "Obsah stránky" (6.16): they are shown only as slides of the one
> slider; positions, separate section blocks and the preview page are gone. The upload, cleaning, storage and download
> rules below still apply.

A shop puts its own PDFs on its page: news, a leaflet, a menu, "About us" (Pro only until update 30; now free shops
too, with smaller limits). **Môj obchod → Sekcie stránky (PDF)**:

- The file is chosen with a blue, underlined **"Vybrať súbor"** link (as the shop logo's "Vybrať obrázok"; the
  browser's own "Choose file / No file chosen" box is hidden); the chosen files' names appear next to it, and sending
  without one says "Najprv vyberte PDF alebo obrázky." (the same in "Nahradiť súbory").
- **Pictures are fine too** (update 31): instead of one PDF the owner may choose pictures (JPG, PNG, WebP; several at
  once, not mixed with a PDF). Each picture becomes one page, in the order of the file names; the plan's pages are the
  number of pictures, its MB apply to each picture. The browser draws every picture as the page pictures (800 and
  1600 px, on white; the photo's place data does not survive) — the originals are not kept, there is no PDF, so
  "Stiahnuť PDF" is never shown for such a section. The AI writes out each picture's text (as written) for "Zobraziť
  text", screen readers and search engines. The form says so: "Obrázky sú v poriadku: namiesto PDF môžete nahrať aj
  fotky alebo obrázky (JPG, PNG, WebP) – každý obrázok bude jedna strana, v poradí podľa názvu súboru. Text z
  obrázkov prečíta AI pre vyhľadávače a čítačky obrazovky. Stiahnuť sa dá len PDF." A section's PDF can be replaced
  by pictures and back ("Nahradiť súbory").
- **"Pridať sekciu"**: title (≤ 80, plain text), one PDF or pictures, **Zobrazenie** "Rozbaľovacie – zatvorené" (default) or "Vždy
  otvorené", **Zobrazenie strán** "Slider" (default) or "Pod sebou" (update 29; also under **Upraviť**), **Pozícia**
  after the shop details (default) / after the map / **after the opening hours** ("Za otváracími hodinami", between
  the hours and the assistant; update 31) / before the items / at the end, **"Povoliť
  stiahnutie PDF"** (default off), optional **visible from / until** (the shop's own days). The form shows the
  recommended format with the plan's numbers: "Odporúčame A4 na výšku (210 × 297 mm), písmo min. 11 pt, obrázky min.
  150 dpi, najviac {pages} strán, max {mb} MB. Pre čítanie na mobile je ideálna 1 strana = 1 téma. Na šírku (A4
  landscape) je možné, ale na mobile bude text menší."
- **Limits per plan** (update 30), the admin's settings on "Predplatné a domény" → **Limity sekcií (PDF)** (never in
  the code; the database checks them): sections per shop, pages per PDF, MB per PDF. Defaults: **free 1 section, 5
  pages, 10 MB; Pro 10 sections, 20 pages, 10 MB** (the admin may set 0–50 sections, 1–50 pages, 1–20 MB). At the
  plan's number of sections the form is replaced by the link **"Pre viac sekcií prejdite na Pro"** (to "Predplatné a
  doména"; no error); a free shop's PDF over its pages gets "PDF môže mať najviac 5 strán. Pre viac strán prejdite na
  Pro." (pages are counted in the browser before the section is made; the server checks again).
- **Free shops** (update 30) have the same upload, pictures, "Zobrazenie", "Zobrazenie strán", download and dates as
  Pro; they choose no position: their sections sit directly **after "Otváracie hodiny", before "Položky v tomto
  obchode"** (a free page has no assistant). They have no shop assistant, so the text serves the page only (accessible
  "Zobraziť text", search engines); the main-page AI search uses only stock, never shop texts.
- **Pro → free:** every section is kept; the page shows only the **first one in the owner's order** that can be shown
  (published, not hidden, inside its dates), the rest are hidden (row: "Skryté – bezplatný profil zobrazuje najviac 1
  (prvé v poradí). Pre viac sekcií prejdite na Pro.") until Pro returns or sections are deleted or hidden; the shown
  one keeps its pages. The same rule with Pro's number if the admin lowers it.
- Up to the plan's number of sections per shop; **drag to reorder** within a position (or ↑ ↓); **Upraviť**; **Nahradiť PDF**
  (the section, its settings and order stay; visitors see the old PDF until the new one is ready); **Skryť /
  Zobraziť**; **Vymazať** (every file and the text). **Náhľad** before publishing (only the owner sees it), then
  **Zverejniť**. Each row says its state: Nezverejnené, Zverejnené, Skryté, Zobrazí sa od …, Skončené, Bez PDF, Chyba.
- **Limits:** PDF only, the plan's MB and pages (above); checked in the browser and again on the server (the file's
  first bytes, the page count, the database); a password-protected or encrypted PDF is refused with a clear message.
- **Cleaning:** the `page-sections` function cleans every PDF with pdf-lib: JavaScript, open and automatic actions,
  launch and other unsafe actions, links to programs, embedded and attached files, media and XFA scripts are removed
  (and every object nothing refers to any more). A PDF that cannot be cleaned is refused. Only the cleaned file is
  stored, in the private bucket `shop-sections`; the owner is told when something was removed.
- **Page pictures:** drawn once in the owner's browser with pdf.js, every page 800 and 1600 px wide, WebP quality
  0.8 (JPEG where the browser cannot write WebP); the server checks each picture's type by its bytes, its size and its
  width.
- **Text:** page by page as written (never translated, corrected or invented); a page without a text layer is written
  out by the AI (`AI_MODEL`) from its picture, as for the assistant's documents.
- **Visibility (one rule, in the database):** published, not hidden, inside its dates, and among the first N such
  sections of the shop in the owner's order (N = the plan's number; update 30 — before it: the shop has Pro). Only then
  are its page pictures in the public bucket `shop-sections-public`; previews, hidden, expired, not-yet-visible and
  over-the-number sections stay private (the owner sees them through 10-minute addresses). Publishing copies the
  pictures there; hiding, the end date, going over the number and deleting remove them; an owner's change moves the
  pictures of the whole shop at once (one section's change can show another). An hourly job applies the dates and the
  plan.
- **On the page:** each section in its position as a titled dropdown or an open block, also on the own domain. Pages
  are pictures in a column ≤ 760 px (the full width minus 16 px margins on a phone), served with srcset 800 / 1600 px
  (no image optimisation). **"Zobrazenie strán"** (update 29):
  - **Slider** (default): one page at a time at the full content width; swipe left / right on a touch screen, ‹ ›
    buttons ("Predchádzajúca strana", "Ďalšia strana") and the ← → keys on a computer; "2 / 5" plus a dot per page
    ("Prejsť na stranu n"). The box has one height for every page (the tallest page's proportions, at most 80 % of
    the screen height; each page fits inside), so nothing jumps. The current and the next page load (once the slider
    is near the screen or its dropdown is opened), the others only when they are next; a `<noscript>` copy keeps every
    page visible without JavaScript.
  - **Pod sebou**: the pages one under another, own proportions, 12 px apart, "Strana n / m", the first page of an open
    section at once, the rest lazily.
  - A section with **one page** shows just the page (no arrows, dots or counter), whatever the setting.
  - A tap / click on a page opens the **full-screen viewer** at that page: the 1600 px picture, swipe or ‹ › / ← → through
    the section's pages, pinch, the mouse wheel, + / − or a double tap to zoom, a finger or the mouse moves a zoomed
    page, "Strana n / m", **Zavrieť** or Esc.
  The raw PDF is never loaded in the page. Under each section a collapsed **"Zobraziť text"** holds the text in the HTML
  (screen readers, search engines, AI crawlers; visible to anyone who opens it). **"Stiahnuť PDF"** (a button) only
  when allowed: the cleaned PDF through shop-files, a 10-minute signed address.
- **The assistant** (paid plan) uses the text of shown sections as public documents and names them ("Zdroj: Novinky
  október, strana 2"); hidden, expired or deleted sections leave the assistant at the same moment as the page; a shop
  without the plan gives the assistant nothing (it has none).
- **Performance:** Lighthouse mobile performance of the shop page with sections stays within 5 points of the same page
  without them (measured on the same production build; numbers in the pull request). The first open section right
  under the shop's details asks for its first page first (`fetchpriority=high`); an open slider loads its second page
  once it is near the screen.

### 6.15 Shop blog "Novinky" and the shop's Facebook Page (database update 37)

Every shop can keep a blog of its own news: written in Cacaduu, or brought over from its Facebook Page; posts written in
Cacaduu can also go to the Page. Shop profile content, never stock. **Texts are shown exactly as written** (paragraphs,
links, #hashtags and emoji stay; PPI never edits, corrects or translates a post; only the labels around it follow the
page language).

- **On the shop's page:** a **"Novinky"** link in the details row (next to e-mail, Facebook and the booking link), only
  when the shop has at least one visible post. **`/[lang]/shops/<slug>/blog`**: 12 posts per page, newest first (date,
  title, the first photo small, the beginning of the text, "Čítať ďalej"), "Novšie" / "Staršie" and "Strana n z m"; an
  empty blog says "Obchod zatiaľ nemá žiadne novinky." **`/[lang]/shops/<slug>/blog/<post>`**: the title, "Zverejnené
  <date>" (+ "upravené <date>"), the text as written (web addresses clickable, new tab), the photos (the
  first large, the others in a grid; WebP 800 / 1600 px straight from storage through next/image's own loader, no image
  optimisation), a tap opens the **full-screen viewer** (the page sections' `SectionZoom`: swipe, ← →, pinch, Esc), a
  Facebook video as its picture with "Video na Facebooku" (opens Facebook), shared links and events as "Odkaz" /
  "Udalosť", and for an imported post **"Pôvodný príspevok na Facebooku"** (a plain link, new tab). "← Všetky
  novinky", "← Späť na obchod". Server-rendered; no JavaScript needed except for the viewer.
- **On the shop's own domain** (Pro): `/blog`, `/blog/<post>` (and `/hu/blog`, `/en/blog` …) with the own domain's
  header; the canonical address is always the own domain (the Cacaduu addresses stay readable and point there, as the
  shop page does).
- **Free vs Pro:** the newest **10** visible posts on a free shop's page (the admin's setting "Novinky / Blog" on
  "Predplatné a domény": 0–10 000; Pro: empty = unlimited); older posts stay stored and come back with Pro or a higher
  limit. Môj obchod says "Free: na webe sa zobrazuje 10 najnovších článkov. S predplatným Pro všetky." and marks the
  rest "Nezobrazuje sa (Free ukazuje 10 najnovších)".
- **Môj obchod → "Novinky / Blog"** (its own page in the menu, `/dashboard/blog`): the list of posts with the status
  (**Publikované**, **Naplánované**, **Skryté**, Koncept, Čaká na schválenie), the source (Cacaduu / Facebook), where it
  went (**Web + Facebook** / **Len web**; "Na Facebooku ✓", "Na Facebook pôjde <date>", "Na Facebook sa nepodarilo
  zverejniť", "Zmazané na Facebooku"), the photo count; **Upraviť**, **Skryť / Zobraziť**, **Vymazať** (with its photos;
  a Facebook copy stays on Facebook), **Zobraziť na webe**. **"Nový článok"**: title (≤ 200), text (as written), up to
  **10 photos** (JPG, PNG, WebP; "Vybrať fotky"; drawn in the owner's browser to 1600 and 800 px WebP — JPEG where the
  browser cannot write WebP — never enlarged, without place data; reorder and remove), **Kedy**: "Hneď" or "Naplánovať
  na" (a date and time in the shop's time zone, at most a year ahead), then **"Zverejniť"** / **"Naplánovať"** or "Uložiť
  koncept". Editing a published post: "Uložiť zmeny" with the note **"Zmena sa prejaví len na webe, nie na Facebooku."**
  An imported post: only its title can be changed ("Príspevok z Facebooku: text a fotky sú z Facebooku a menia sa
  tam.").
- **The question before publishing** (a modal dialog, asked every time; the last answer is pre-selected and focused;
  focus stays inside; Esc = back): with Facebook connected **"Zverejniť aj na Facebooku?"** with a preview of the post as
  the Page will show it (the Page's name and picture, the text, up to 4 photos with "+N" on the last, the last line
  **"Čítať na webe: <the post's address>"**) → "Áno, zverejniť na webe aj na Facebooku" · "Len na web" · "Späť na úpravy".
  Not connected: "Facebook nie je pripojený." → "Pripojiť Facebook stránku" (after the login it comes back to the same
  post with the dialog open) · "Len na web" · "Späť". Expired: "Pripojenie k Facebooku vypršalo." → "Pripojiť znova" ·
  "Len na web" · "Späť". A scheduled post says "Na Facebook pôjde v čase zverejnenia: <date>." and its choice can be
  changed in the list until its time ("Zmeniť na „Len web“"). Results: **"Zverejnené na webe ✓"**, **"Zverejnené na
  Facebooku ✓"** ("Otvoriť na Facebooku"), "Naplánované na <date> ✓", or the error with **"Skúsiť znova na Facebook"**
  (the web post stays either way). Without Facebook set up on Cacaduu (no `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET`) there
  is no dialog and no Facebook button anywhere: "Zverejniť" publishes to the web.
- **Facebook Page** (on the same page; only when Facebook is set up): **"Pripojiť Facebook stránku"** → Facebook Login
  for Business (only `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`; `pages_manage_metadata` only if
  the app's configuration asks for it, for the webhook) → **pick one Page** of the person's Pages ("Osobné profily
  Facebook nepodporuje – len Facebook stránky (Pages)."; no Page → that message) → "Pripojená stránka: <name>". The
  Page's token is stored **only encrypted** and only the server uses it; **"Odpojiť"** deletes it (imported posts stay).
  **"Stiahnuť všetky príspevky"** brings every past post in the background, 25 at a time ("Sťahujem príspevky… zatiaľ
  n", then "Stiahnuté: n nových príspevkov."); after that a **daily sync** (and a sync within minutes when the app's
  webhook reports a change) brings new posts, edits (text, photos, links; the owner's own title stays) and hides
  posts deleted on Facebook ("Zmazané na Facebooku"). "Posledná synchronizácia … · Ďalšia …". **Imported posts**: the
  title is the text's first sentence, at most 70 characters, cut at a word ("…"), else the date; text and links as
  written; photos (up to 100 of an album) copied as WebP 1600 / 800 px; a video as its picture + link; shared links and
  events as links; never comments, reactions, likes or anybody's name. **"Publikovať importované príspevky
  automaticky"** (default) or **"Schvaľovať pred zverejnením"** (they wait as "Čaká na schválenie" → "Zverejniť"). A post
  that came from Cacaduu is never imported back; nothing is imported twice.
- **Publishing to Facebook** as the Page: the text, up to 10 photos and the line "Čítať na webe: <address>" (the
  own domain when live); Facebook's post id is kept (never sent twice; a try that got no answer for 10 minutes is
  marked failed with "Skontrolujte stránku…", never repeated by itself). Scheduled posts go when their time comes (the
  5-minute job).
- **Expired connection** (the person removed the app, changed the password, lost the Page role …): the page and the
  dialog say "Pripojenie k Facebooku vypršalo – pripojte znova", nothing goes to Facebook, and the owners get **one
  e-mail** "Pripojenie k Facebooku vypršalo – pripojte znova" (Brevo); connecting again clears it.
- **Readable for Google and AI:** every page server-rendered with title, description, canonical + hreflang (sk, hu, en,
  x-default), Open Graph `article` (the first photo); JSON-LD **`BlogPosting`** (headline, text, dates, images, the shop
  as `LocalBusiness` author and publisher) + **`BreadcrumbList`** (shop → Novinky → post), the list page as `Blog`;
  posts in the sitemaps (Cacaduu's, or the own domain's); an **RSS feed** `…/blog/rss.xml` (`<link rel="alternate">` on
  the blog pages); the newest 5 posts under "Latest news" in the own domain's **llms.txt**; **IndexNow** for new,
  changed and hidden posts (sk/hu/en addresses on their canonical host, with the stock's limit of once an hour per
  host); the Pro **shop assistant** can search the visible posts (`search_shop_news`) and names them as sources.
- **No Facebook SDK, pixel, plugin or embedded Facebook widget** on any public page: Facebook pictures are copied into
  Cacaduu's storage, links to Facebook are plain links. The privacy page **`/[lang]/sukromie`** (a draft with TODO lines)
  says what is done with Facebook data, and **`/[lang]/sukromie/vymazanie-udajov`** says how to delete it (Odpojiť,
  Vymazať, Business Integrations) — the addresses the Meta app asks for.

### 6.16 "Obsah stránky": one slider of posts, PDFs and pictures (database update 38)

**Môj obchod → Asistent** (Part A; since update 55 three tabs, 6.30) has four sections, each exactly once and in this order: **Nastavenia asistenta**
(button text, welcome), **Konverzácie asistenta** (list, search, and the cloud folder they are copied to with its
settings and statuses), **Súkromné priečinky** (documents, folders, access keys, "Len zobraziť" / "Zobraziť a
stiahnuť"), **Posledné nahrané súbory** (the last 10 stock files). Nothing of these is on another page any more; old
addresses (`/sync?at=imports|private`, `/dashboard?at=cloud|conversations|docs`, `?at=sections`,
`/dashboard/sections/<id>`) lead to the section's page with their query. A free shop sees "Dostupné v Pro" where it has
nothing yet; what it already has (e.g. conversations from its Pro time, the stock file reports) stays reachable.

**The slider (Part B).** One per shop page, after "Otváracie hodiny", before the AI assistant (a free page: before
"Tovar v obchode"), on the Cacaduu address and the own domain.
- Title set by the owner (default "Novinky a ponuky", shown as written); "Zobraziť názov sekcie" on/off (off: the
  title only for screen readers); "Zobrazenie": "Vždy otvorené" (default) or "Rozbaľovacie" (a closed dropdown whose
  pictures load only when opened).
- At most 10 slides (the admin's number per plan). Swipe, ‹ › and the ← → keys, counter "3 / 10" + dots; since
  update 44 every slide has **the same frame** ("Pomer strán slidera": 4:5 recommended and default, 1:1, 16:9; at most
  80 % of the screen high) filled by its picture (cropped, never stretched; "Výrez" hore / stred / dole per picture or
  PDF), a fixed caption (title 2 lines + "…", date or page count, one action bottom-left) — the slider never changes
  height and the arrows, ▶, counter and dots stay in place; only the current and the next slide load their picture, the
  others are lazy; `prefers-reduced-motion` = no animation. "Všetky novinky" → `/blog` when the shop has posts.
- Slides: **Automatický článok** and **Pripnutý článok** = a card (photo, date, title, first two lines, "Čítať");
  **PDF** = its first page, title and page count; a tap opens the full-screen viewer, per PDF "Slider" (page by page)
  or "Pod sebou" (all pages); optional "Stiahnuť PDF"; **Obrázok** = full-screen zoom, optional title, optional
  "Stiahnuť".
- Rules (decided only in SQL): a pinned post is never repeated in an automatic slot; automatic slots take the newest
  visible posts (a new post or a Facebook import moves in by itself); fewer posts than automatic slots → fewer slides,
  never a blank one; hidden, deleted, expired or not-yet-visible files drop out and the rest keep their order. Plan
  limits are the admin's settings ("Limity obsahu stránky"): Free at most 5 slides with at most 1 PDF, Pro at most 10;
  after a downgrade every setting is kept and only the first slides within the free limit are shown.
- **Editor** (Môj obchod → **Obsah stránky**): the title and display; counters "Automatické články", "PDF",
  "Pripnuté články", "Obrázky" within the plan's total with "Zostáva X slotov"; for each slot the PDF, pinned post or
  picture from the library; drag and drop (or ↑ ↓) of all slots, "Dať automatické články k sebe"; each slot says what
  it shows now or why it is not shown; "Pomer strán slidera" and "Výrez" per file (update 44); a live preview on a
  phone and, under it, on a computer (both at their real width, scaled to fit, never cut) before "Uložiť".
- **Knižnica súborov**: upload, "Upraviť" (title, alt text, viewer, download, visible from/until), "Skryť"/"Zobraziť",
  "Nahradiť", "Vymazať" (every file in both buckets). Free 10 files, Pro 30 (admin's settings).
- **PDF uploads**: at most 10 MB and 20 pages (free 5; the admin's numbers); the real type is checked; JavaScript,
  actions and embedded files are removed; an encrypted PDF is refused with a clear message; every page drawn once to
  WebP 800/1600 (q 0.8) in the owner's browser; visitors never load the PDF; downloads only through a 10-minute signed
  address and only when allowed. Hint: "Odporúčame A4 na výšku (210 × 297 mm) alebo štvorec, písmo min. 11 pt, obrázky
  min. 150 dpi, max 10 MB."
- **Picture uploads**: JPG, PNG, WebP, HEIC/HEIF, at most 10 MB; upright from the camera's EXIF, every EXIF and GPS
  removed; under 600 px wide refused ("Nahrajte aspoň 800 px na šírku"); over 4000 px made smaller; WebP 800/1600 that
  keep PNG transparency; never cropped, stretched or enlarged when stored (the slider's frame shows it cropped, the
  viewer whole). Hint: "Na mobil je najlepší obrázok na výšku 1080 × 1350
  px (4:5). …" Optional alt text; when empty the AI writes one from the picture (never inventing prices or offers).
- Text is extracted once (screen readers through the slide's description, the full-screen viewer, search engines and
  the Pro assistant's knowledge; no visible "Zobraziť text" since update 44); nothing is invented or changed. Originals stay in the private bucket; the pictures of shown slides are in the
  public bucket only while shown.
- Migration: SQL 38 turns every shop's sections into its library and its slider (the old page order, then three
  automatic posts); a section of one picture becomes a picture.

### 6.17 Videos in the blog and the slider (database update 39)

- **A video uploaded to the shop's Facebook Page** (also a reel): imported as its picture with a link; it is never
  copied and never played on Cacaduu (no Facebook player on our pages). The blog post shows the picture with ▶ and
  "Video na Facebooku", which opens it on Facebook.
- **A YouTube video shared on the Page**: its link card stays, and the post also gets the video's picture from YouTube
  (stored in Cacaduu like a photo; shares imported before update 39 get it automatically). On the blog post the picture
  has a ▶ and the video **plays right there after a tap** (from youtube-nocookie.com; nothing loads from YouTube before
  the tap); the link card is not repeated.
- **The slider**: a post with a video shows a ▶ on its picture (or "▶ Video" without a picture). Where it leads is the
  owner's choice in Obsah stránky → **"Tlačidlo ▶ pri videách otvorí"**: *Článok na Cacaduu* (default; the article,
  scrolled to the video — a YouTube video plays there) or *Príspevok na Facebooku* (the post on Facebook in a new tab;
  on a phone with the Facebook app the phone opens it in the app). A post that is not on Facebook always opens the
  article. The title and "Čítať" always open the article. The live preview follows the choice before saving.
- The blog list shows ▶ on video posts. Black and white like the rest (no colours).

### 6.18 Every language (database update 40)

- **Languages:** the 25 EU languages, Norwegian, Icelandic, Serbian (Latin and Cyrillic), Bosnian, Albanian,
  Macedonian, Turkish, Russian, Catalan, Basque, Galician, Welsh, Luxembourgish (Russian and the regional ones off by
  default), and in "Ďalšie jazyky" Chinese (Simplified on, Traditional off) and Vietnamese. The admin switches each on
  or off and decides which are translated in advance for search engines.
- **The picker** replaces SK · HU · EN on Cacaduu and on a shop's own domain: "Odporúčané" (the shop's preferred
  languages; SK, HU, EN, CS, UK, PL, DE on Cacaduu), "Všetky jazyky" (each in its own name, with a search that also
  knows the English, Slovak and Hungarian names), "Ďalšie jazyky". Keyboard and screen readers; a bottom sheet on a
  phone. First visit: the shop's language on its own domain; on Cacaduu the browser's language if it is on, else
  Slovak. The choice is remembered. Dates, numbers and prices follow the language (Intl).
- **Interface texts:** Slovak is the source; Hungarian and English are written by hand; every other language is
  generated by Claude in "Admin → Preklady → Preložiť chýbajúce texty", stored, and editable there (search, edit,
  "Skontrolované"). A missing text shows English, then Slovak — never a technical name. Legal pages say "Strojový
  preklad – záväzná je slovenská verzia" until checked.
- **Shop content in the visitor's language:** product names, descriptions and categories, the assistant's button and
  welcome, notes on special days, the slider's titles and picture descriptions, news posts. The shop's original never
  changes; a translation is stored apart and labelled. The shop's preferred languages are translated in advance; any
  other on the first visit (the page shows the original and "Prekladáme…" meanwhile). Claude's translations carry
  "Preložené automaticky" and "Zobraziť originál". A changed original makes its translation "Zastaraný" and it is made
  again. Brands, codes, EAN, prices, quantities, units, addresses, e-mails, phone numbers and colour codes are never
  translated. The assistant and the AI search answer in the shopper's language; every search looks at every
  translation (also a Chinese search, through Claude's words for it, and in the MCP `search_stock`).
- **Product descriptions:** "Vygenerovať popis" (one product or up to 20 at once) writes a "Návrh popisu" in the shop's
  language only from the shop's own data — nothing invented. The owner edits it → "Uložiť a zverejniť", or "Zahodiť";
  "Zverejniť vygenerované popisy automaticky" (off by default). It is "Popis (Cacaduu)", apart from the shop's own
  description, which wins when there is one unless the owner chooses otherwise. Approved descriptions are translated.
- **Translations per product:** a "Preklady" tab with chips "Od obchodu", "AI", "Upravené ručne", "Zastaraný",
  "Chýba", "Neprekladať"; Zobraziť / Upraviť / Preložiť znova (old and new side by side) / Zmazať ("preložiť znova pri
  ďalšej návšteve" or "neprekladať tento produkt do tohto jazyka"); "+ Pridať preklad". The shop's and the owner's own
  translations are never overwritten (Claude only suggests). The same for the shop's texts and posts on "Môj obchod →
  Jazyky a inventár", with filters, ticks for many, a progress bar and "Späť" for 30 seconds.
- **The shop's languages** (Môj obchod → Jazyky a inventár → Jazyky): Hlavný jazyk obchodu, Jazyky inventára,
  Preferované jazyky stránky (Free: 2, Pro: 6 besides the main one; the admin's numbers), Predvolený jazyk na vlastnej
  doméne — each with a help text and an example.
- **Two-language stock files:** a text column per language in the file (e.g. "Názov HU"), proposed from the column
  names and approved by the owner; or a second file in another language, matched by Kód, then EAN (summary: matched,
  unmatched, differences). The shop's own texts are "Od obchodu" and never changed. Quantity and price only from the
  main file. Every file shows a preview first, with its encoding (UTF-8, Windows-1250, Windows-1258 for Vietnamese,
  GB18030 for Chinese …).
- **Cost:** a monthly budget for the AI (`TRANSLATION_MONTHLY_BUDGET_EUR`) with one e-mail at 80 %; translations stop
  at 100 % until the next month (pages show the originals).

### 6.23 The shop assistant's texts and the GDPR link (27 October 2026, database update 46)

- The assistant's button label and welcome text are translated with the page automatically, as a preset of every
  translation run: into every pre-translated language (sk, hu, en by default), the shop's preferred languages, the
  languages visitors asked for and also the shop's own language, from whatever language the owner wrote them in. The
  owner's original stays as written; the owner's own translations are never overwritten. No "Preložené automaticky"
  note for these two texts.
- The small print of the assistant (the conversation and files are stored for the shop + "Viac", the file limits and
  GPS removal, "Odpovede píše AI; ceny a zásoby sú priamo z obchodu") is hidden behind a blue "GDPR" link in the right
  corner of the assistant's heading and opens under the heading when tapped.

### 6.24 The company in "Môj obchod" (27 October 2026, database update 47)

- The shop's details show, right under the street: PSČ, "Obchodné meno firmy", IČO and DIČ (all optional). No IČ DPH.
- Kept in its own table that only the shop's owners can read; an empty field clears the value; an invalid DIČ or PSČ
  is refused with a clear message.
- **Shown on the shop page** (update 48, at the owner's request): the address line gets the PSČ before the town, and
  under it "Obchodné meno · IČO … · DIČ …" (only what the owner filled in), on the Cacaduu address and the own domain;
  the JSON-LD gets postalCode, legalName and taxID. Visitors read it through one database function, never the table.
  Not in the API/MCP or the assistant.

## 7. Data model (after database update 40)

| Table | Main columns | Notes |
| --- | --- | --- |
| `shops` | `id`, `slug` (unique), `name`, `ico`, `address`, `city`, `country` (ISO 2 letters), `timezone` (IANA), `location` (PostGIS point), `phone`, `website`, `opening_hours` (jsonb), `email`, `facebook_url` (facebook.com / fb.com), `booking_url` (https, ≤ 500, update 26), `site_logo_url` / `site_logo_width` / `site_logo_height` (the own domain's header logo in the shop's `logos` folder, update 31; only `owner_set_site_logo()`), `site_logo_link` (where the logo leads: https of a real host, ≤ 500; NULL = the home page; update 32, only `owner_set_site_logo_link()`), `product_categories` ("Kategórie tovaru" for the own domain's llms.txt: ≤ 12, each ≤ 40, plain text; update 33, only `owner_set_categories()`), `header_url` / `header_small_url` / `header_width` / `header_height` (the header picture of update 28; no longer shown since update 31), `auto_holidays` (default true, update 27; only `owner_set_auto_holidays()`), `assistant_label` (≤ 40), `assistant_welcome` (≤ 300, plain text, paid plan), `logo_url`, `is_active`, `has_toilet`, `has_douchette`, `has_card_terminal`, `created_at` | Visitors see only active shops. The display columns `visibility_mode` and `low_stock_threshold` were dropped by migration 21 |
| `languages` · `ui_translations` · `content_translations` · `item_descriptions` · `shop_language_settings` · `translation_limits` · `translation_usage` · `translation_requests` · `query_translations` | the website's languages; interface texts per language (`ai`/`manual`, checked, Slovak source hash); the shops' content per (kind, ref, language) with status `shop`/`ai`/`manual`/`none` and the original's hash; "Popis (Cacaduu)" (draft, text, which one is shown); the shop's main / inventory / preferred / own-domain languages; per-plan preferred languages; AI cost per month; languages visitors asked for; search words per search | Update 40. RLS on all; owners read their own; written only through `owner_*` / `admin_*` functions and the translate function (service role); visitors read only `site_languages()`, `ui_messages()`, `shop_languages()`, `shop_translations()`, `item_texts()` |
| `public_holidays` | `country`, `date`, `name_sk/hu/en`, `kind` (`day_off`, `shops_closed`, `removed` = an admin row taking a date away), `closed_from`, `source` (`library`/`admin`) | Update 27. Everyone reads; only the service role and the admin's functions write; an admin row always wins over the library's |
| `shop_special_hours` | `shop_id`, `date`, `closed`, `ranges` (1–4, a break allowed, past midnight allowed), `note` (≤ 100, plain text) | Update 27. Read with the shop; written only through `owner_save_special_hours()` / `owner_delete_special_hours()` |
| `shop_page_sections` | `id`, `shop_id`, `title` (≤ 80), `display` (`collapsed`/`open`), `position` (`after_details`/`after_map`/`after_hours` (update 31)/`before_items`/`end`), `sort`, `allow_download`, `visible_from`, `visible_until`, `hidden`, `published`, `version` (live PDF), `pdf_path`, `pdf_bytes`, `pages` (≤ 20), `lang`, `upload_version` / `upload_*` (a new PDF being made ready), `upload_error`, `public_version` (whose pictures are public), `page_layout` (`slider`/`stacked`, default `slider`, update 29); `pages` ≤ 50 since update 30, `source` (`pdf`/`pictures`, update 31; pictures: no `pdf_path`) and `upload_source` | Update 28. At most the plan's number per shop (`section_limits`, update 30). Owners read their own; written only through `owner_*` functions and the page-sections function; visitors only through `shop_sections()` |
| `shop_section_pages` | `section_id`, `shop_id`, `version`, `page`, `width`, `height`, `ext` (`webp`/`jpg`), `small_bytes`, `large_bytes`, `text` (as written, ≤ 20 000), `text_done`, `needs_ai`, `ai_attempts`, `lang`, `search` | Update 28. One row per page; the assistant searches the text of shown sections |
| `section_limits` | `plan` (`free`/`pro`), `max_sections` (0–50), `max_pages` (1–50), `max_mb` (1–20), `updated_at` | Update 30. Defaults free 1 / 5 / 10, Pro 10 / 20 / 10. Signed-in users read; only `admin_save_section_limits()` (is_admin) writes |
| `shop_members` | `shop_id`, `user_id`, `role` (`owner`) | Which account owns which shop |
| `products` | `id`, `ean` (unique), `name`, `brand`, `category` | One per real product, shared by shops |
| `shop_items` | `id`, `shop_id`, `source_code` (the shop's item code), `name`, `ean`, `brand`, `product_id`, `updated_at`, `name_lang`, `name_i18n` (`{"sk","hu","en"}`), `translated_name_source`, `name_i18n_by_owner`, `changed_at` (update 33: when name, EAN or brand last changed; a trigger) | Unique per shop + code; names searchable through one trigram index over the original and the three translations. Every item of an active shop is public (`is_public` dropped by migration 21) |
| `inventory` | `shop_item_id`, `quantity`, `price`, `currency`, `source_updated_at`, `received_at`, `changed_at` (update 33: when quantity, price or currency last really changed; a trigger), `indexnow_at` (update 36: when it last changed in a way a search result shows — new, price/currency, in stock ↔ sold out; a trigger) | Written only by the stock-pull function |
| `sync_sources` | `shop_id` (unique), `file_format`, `field_mapping` (jsonb), `mapping_status` (`proposed`/`confirmed`), `sample_rows` (never private columns: 3 rows without purchase price / supplier / margin / invoice columns before approval, only the approved columns after), `file_columns` (every column name of the latest file), `latest_file_time`, `last_checked_at`, `last_error`, `folder_seen_at`, `last_file_name` | One per shop: how its stock file is read and the latest upload. A leftover `file_url` column is unused |
| `stock_imports` | `shop_id`, `file_name`, `file_time`, `received_at`, `status` (`ok`/`errors`/`waiting`), `total_rows`, `imported`, `zeroed`, `skipped`, `error`, `columns`, `preview` | Import report per received file, the last 10 per shop; written only by stock-pull (`record_stock_import()`), read only by the shop's owners; the preview holds only approved columns |
| `profiles` | `user_id`, `display_name`, `language`, `is_admin` | One per account, created automatically |
| `api_usage` | `ip_hash`, `endpoint`, `created_at` | API/MCP, AI search (`ai-search`) and shop assistant (`shop-chat`) rate limit log; no IP addresses; older than 30 days removed |
| `search_layers` | `layer` (`osm`/`google_places`/`web`), `enabled`, `cost_per_call_usd`, `input_usd_per_mtok`, `output_usd_per_mtok` | Update 34. The admin's switch and estimated prices per outside layer; only `admin_save_search_layer()` (is_admin) writes; no grant for visitors or owners |
| `web_search_domains` | `domain` (ASCII, optional path, no wildcard), `label`, `search_url` (https on that host with `{query}` once), `enabled`, `sort_order` | Update 34. The web search's allowed domains and the deep links; ≤ 50; only the admin (`admin_save_web_domain()`, `admin_delete_web_domain()`) |
| `external_search_usage` | `day` (UTC), `layer` (`geocode`/`osm`/`google_places`/`web`), `service`, `calls`, `cost_usd` | Update 34. Every outside call, counted before it goes out (`external_search_claim()`, the daily limit), its cost added after (`external_search_cost()`); the admin reads it through `admin_search_settings()` |
| `town_geocodes` | `key` (the town without accents), `query`, `name`, `lat`, `lng`, `country_code`, `found`, `fetched_at` | Update 34. Nominatim's answer, kept for good (not found: asked again after 30 days); only the function |
| `osm_shop_cache` | `town_key`, `category`, `radius_m`, `results` (the shops' names, kinds, addresses, phone, opening hours, distance), `fetched_at` | Update 34. Overpass's answer per town and kind, used for 24 hours, cleared after 7 days (`osm_cache_put()`); only the function |
| `external_throttle` | `service`, `next_at` | Update 34. One Nominatim request per second for the whole site (`external_slot()`) |
| `subscriptions` | `shop_id` (key: one row per shop), `stripe_customer_id`, `stripe_subscription_id`, `status` (`none` = customer only, else Stripe's status), `plan`, `current_period_end`, `cancel_at`, `updated_at` | Paid plan; written only by the Stripe functions (service role), read by the shop's owners |
| `shop_chat_usage` | `shop_id`, `month`, `messages` | Shop assistant messages per shop per calendar month (UTC), for the monthly cap; no client access |
| `shop_folders` | `id`, `shop_id`, `name`, `is_public`; update 24: `access_mode` (`view`/`download`), `unlocks`, `views`, `downloads` | One Public folder per shop (made automatically) and private folders |
| `shop_documents` | `id`, `shop_id`, `folder_id`, `name`, `description`, `storage_path`, `bytes`, `pages`, `lang`, `status` (`uploading`/`processing`/`ready`/`error`), `assistant_enabled`, `downloadable` (Public folder), `extracted`; update 24: `access` (null = as the folder, `view`, `download`) | PDFs; owners read their own, change them through `owner_*` functions |
| `shop_pictures` | `id`, `shop_id`, `folder_id`, `document_id`, `page`, `kind` (`picture`/`scan`), `title`, `caption`, `description`, `description_by_owner`, `show`, `status` | Own pictures, pictures from PDFs, scanned pages (never shown) |
| `shop_document_chunks` | `shop_id`, `folder_id`, `document_id`, `picture_id`, `page`, `type` (`text`/`picture`), `text`, `lang`, `search` (full text) | Excerpts as written and picture descriptions; trigram and full-text indexes; read only through `search_shop_docs()` |
| `folder_keys` | `id`, `shop_id`, `label`, `key_hash`, `folder_ids`, `expires_at`, `revoked_at`, `last_used_at`, `use_count`, `folder_key` (update 24: the folder's own key) | Access keys (hash only; owners never read the hash) |
| `folder_sessions` | `token_hash`, `shop_id`, `key_id`, `folder_ids`, `expires_at`, `downloads` (update 24) | Opened folders, 24 hours (update 24), at most 20 downloads; no client access |
| `shop_document_pages` | `document_id`, `page`, `shop_id`, `storage_path`, `bytes`, `width`, `height`, `uploaded` | Update 24: each PDF page as a picture for the viewer; owners read whether they are uploaded |
| `folder_zip_tickets` | `ticket_hash`, `shop_id`, `folder_id`, `session_hash`, `expires_at`, `used_at` | Update 24: single-use ZIP addresses for 10 minutes; no client access |
| `assistant_conversations` | `id`, `shop_id`, `token_hash`, `page_lang`, `shopper_lang`, `started_at`, `last_message_at`, `ended_at`, `end_reason` (`closed`/`idle`/`new`), `message_count`, `attachment_count` (≤ 10), `first_question`, `pdf_status` (`none`/`ready`/`failed`), `pdf_path`, `pdf_name`, `pdf_error`, `pdf_attempts`, `pdf_next_try`; update 23: `export_status` (`none`/`pending`/`running`/`done`/`failed`), `export_error`, `export_attempts`, `export_next_try`, `export_started_at`, `exported_at`, `export_path`, `export_provider`, `shopper_deleted_at` | One per conversation (update 22); written only by assistant-archive and cloud-export; owners read (never the token hash or paths). `shopper_deleted_at`: a line without content left after the shopper deleted a copied conversation |
| `assistant_messages` | `conversation_id`, `shop_id`, `role` (`shopper`/`assistant`), `body`, `body_owner` (Slovak version), `lang`, `cards` (jsonb: name, price, availability, data_time, quantity, note), `attachment_ids`, `created_at` | Every message; owners read |
| `assistant_attachments` | `id`, `conversation_id`, `shop_id`, `name`, `kind` (`jpeg`/`png`/`webp`/`heic`/`pdf`), `bytes`, `storage_path`, `preview_path` | The shopper's files; owners read name, kind and size only |
| `shop_assistant_settings` | `shop_id`, `retention_days` (30/90/365, default 90), `shopper_pdf` (update 24, default on) | Keep time and the shopper's own PDF; owners set them through `owner_set_assistant_retention()` / `owner_set_shopper_pdf()` |
| `cloud_connections` | `shop_id` (key: one per shop), `provider` (`onedrive`/`dropbox`), `account_name`, `account_email`, `folder_path`, `access_token_enc`, `refresh_token_enc`, `access_expires_at`, `scope`, `site_url`, `status` (`ok`/`expired`/`error`), `last_error`, `connected_by`, `connected_at`, `last_success_at`, `failing_since`, `alert_sent_at` | The shop's cloud (update 23); written only by cloud-export; owners read everything except the tokens |
| `cloud_oauth_states` | `state_hash`, `shop_id`, `provider`, `user_id`, `verifier`, `folder_path`, `return_url`, `expires_at` | One OAuth round trip (SHA-256 of the state, 10 minutes, single use); no client access |
| `cloud_export_items` | `conversation_id`, `shop_id`, `item_key` (`pdf` or the attachment id), `remote_path`, `remote_id`, `bytes`, `uploaded_at` | What was copied (unique per conversation and item); owners read |
| `domain_settings` | one row: `search_url` (https), `same_price_as_registrar`, `low_credit_eur`, `test_domain`, `credit_eur`, `credit_checked_at`, `credit_alert_at`, `indexnow_key` (update 33: random; no longer used since update 36 — the key is `INDEXNOW_KEY`) | Update 25; only the admin (owners read the search address and the switch through `domain_shop_settings()`) |
| `domain_prices` | `tld` (key), `price_cents`, `renewal_cents`, `vat_included`, `currency` (EUR), `sort_order`, `active` | The admin's price table; everyone reads active rows |
| `shop_legal` | `shop_id` (key), `company_name`, `contact_name`, `street`, `city`, `zip`, `country`, `ico`, `dic`, `ic_dph`, `email`, `phone` | The domain owner's details; members and the admin read, owners write through `owner_save_legal()` |
| `domain_orders` | `shop_id`, `kind` (`bought`/`connected`), `hostname`, `site_host`, `www`, `status` (quoted → checkout → paid → registering → configuring → securing → live; waiting_dns → verified; taken, failed, dns_timeout, lapsed, ended, canceled), the frozen price, Stripe session/invoice/payment/refund, Websupport profile/order/service, `test_mode`, `waiting_credit`, `dns_records`, checks, tries, `live_at`, `live_email_at`, `expires_at`, renewal state and notices, `auth_code`, `last_error`, `needs_admin`, `log`; update 33: `google_verification` (`google-site-verification=…`), `google_verification_state` (added/manual; update 36: present), `google_verification_at`, `indexnow_upload_at` (the upload last announced), `indexnow_at`, `indexnow_urls`, `indexnow_result`; update 36: `google_txt_record_id` (the record Cacaduu added, only with added) | One open domain per shop and per host; members and the admin read; only the domains and Stripe functions write |
| `domain_site_verifications` | `order_id` (key), `shop_id`, `google_meta` (Google's token), `bing_meta` (Bing's hex code), `updated_at` | Update 36; RLS: the shop's members read; written only through `owner_set_site_verification()` |
| `indexnow_hosts` | `host` (key), `sent_upto` + `sent_upto_id` (what was sent and accepted), `last_ping_at`, `last_status`, `last_result`, `last_urls` | Update 36; RLS on, service role only (stock-pull through `indexnow_claim_host()` / `indexnow_done()`) |
| `indexnow_pings` | `host`, `kind` (main/site), `urls`, `status`, `result`, `upto`, `sent_at` (the last 100 per host) | Update 36; RLS on, service role only |
| `shop_page_content` (update 38) | `shop_id` (key), `title` (≤ 80, NULL = "Novinky a ponuky"), `show_title`, `display` (open/collapsed) | RLS: members read; written only by `owner_save_content()` |
| `shop_page_content.video_target` (update 39) | `post` (default) / `facebook`: where the slider's ▶ of video posts leads | Only through `owner_save_content(…, p_video_target)` |
| `shop_content_slots` (update 38) | `shop_id`, `position` (0–99), `kind` (auto_post/pinned_post/pdf/picture), `item_id` → `shop_page_sections`, `post_id` → `blog_posts` | RLS: members read; written only by `owner_save_content()` / `owner_save_item()`; what is shown: `content_slots_shown()` |
| `shop_page_sections` (update 38 additions) | `kind` (pdf/picture), `show_title`, `file_name`, `alt`, `alt_ai`, `original_path`, `original_bytes` | The library of "Obsah stránky"; `section_limits` gains `max_slides`, `max_pdf_slides`, `max_items` |
| `partners` (update 35) | `name`, `logo_path`, `feed_url` or `feed_file_path` (+ `feed_file_at`), `feed_format` (google_xml/google_csv/heureka_xml/csv), `inventory_url` or `inventory_file_path`, `inventory_format` (google_local_xml/google_local_csv), `currency`, `timezone`, `schedule` (hourly/6h/daily/weekly), `affiliate`, `enabled`, `next_run_at`, `force_next` | Admin only through `admin_*` functions; nobody else reads it |
| `partner_stores` (update 35) | `partner_id`, `store_code`, `name`, `address`, `city`, `postal_code`, `country`, `lat`, `lng` | The partner's store list as the admin typed it |
| `partner_products` (update 35) | `partner_id`, `item_id`, `title`, `brand`, `gtin`, `mpn`, `category`, `price`, `sale_price` (+ `sale_from`/`sale_to`), `currency`, `availability` (as written) + `availability_state` + `availability_days`, `link`, `image_link`, `search_blob` (generated, trigram index), `import_id`, `updated_at` (the time of the data), `changed_at` | The feeds' rows as sent; visitors read only through `search_partner_products()` |
| `partner_store_stock` (update 35) | `partner_id`, `item_id`, `store_code`, `availability` + `availability_state`, `quantity`, `import_id`, `updated_at` | Only from the local inventory feed |
| `partner_imports` (update 35) | `partner_id`, `kind` (products/inventory), `source`, `status` (download → parse → done / unchanged / error), `error` + `error_detail`, `feed_time`, `source_modified`, `etag`, `bytes`, `parts`, `part_index`, `carry`, `encoding`, `header`, `rows_read`/`rows_bad`/`rows_kept`, lock and tries | One running import per partner and kind; the last 10 kept |
| `blog_posts` (update 37) | `shop_id`, `slug` (unique per shop), `title` (≤ 200), `body` (as written, ≤ 70 000), `source` (cacaduu/facebook), `status` (draft/published/hidden/pending), `publish_at`, `edited_at`, `fb_choice` (web/web_fb), `fb_status` (waiting/posting/posted/failed), `fb_error`, `fb_tries`, `fb_post_id` (unique per shop), `fb_permalink`, `fb_updated_at`, `fb_deleted_at`, `title_by_owner`, `links` (shared links, events, videos), `search` (generated), `indexnow_at` / `indexnow_sent_at` | Owners read their own (`owner_blog_*`), change them only through `owner_blog_*` functions; visitors only through `shop_blog()` / `shop_blog_post()` (the visibility rule); the shop-blog function (service role) imports and publishes |
| `blog_photos` (update 37) | `post_id`, `shop_id`, `position`, `kind` (photo/video), `link_url`, `status` (uploading/pending/ready/failed), `path_large` / `path_small` (random names, 1600 / 800 px WebP or JPEG), `width`, `height`, `fb_media_id`, `source_url` (Facebook's picture, until copied), `attempts`, `last_error` | ≤ 10 per Cacaduu post, ≤ 100 per imported post; written only by the function |
| `blog_limits` (update 37) | `plan` (free/pro), `max_posts` (0–10 000; null = all) | Defaults free 10, Pro unlimited; only `admin_save_blog_limits()` (is_admin) writes |
| `shop_blog_settings` (update 37) | `shop_id`, `auto_publish` (imported posts at once, default on), `last_choice` (web/web_fb: the dialog's pre-selected answer) | Through `owner_blog_settings()` / the publish functions |
| `facebook_connections` (update 37) | `shop_id` (one Page per shop), `page_id`, `page_name`, `page_picture`, `page_token_enc` (AES-GCM, never readable by owners), `scopes`, `status` (ok/expired), `site_url`, `last_error`, the import's state (`import_state`, `import_cursor`, `import_count`, `import_error`, `import_lease_at` …), `last_sync_at`, `next_sync_at`, `failing_since`, `alert_sent_at`, `connected_by`, `connected_at` | Owners read every column except the token (column grant); only the function writes; "Odpojiť" deletes the row |
| `facebook_oauth_states`, `facebook_pending_pages` (update 37) | the login's state (SHA-256, 10 minutes, single use, the return address); the Pages to choose from (encrypted, 10 minutes) | No client access |

`opening_hours`: `{"mon":[["08:00","12:00"],["13:00","17:00"]], …, "sun":[]}`.
Storage: bucket `logos` (public, 1 MB, PNG/JPEG/WebP, folder per shop), `raw-files` (private, last raw files kept
7 days for troubleshooting) and `shop-docs` (private, 20 MB, PDF/WebP/JPEG/PNG, folder per shop: the shop's owners
may only add files they registered; only the service role reads or deletes) and `shop-assistant-uploads` (private,
10 MB, JPEG/PNG/WebP/HEIC/PDF, `<shop>/<conversation>/`: no policies, only the assistant-archive function).
Update 28: `shop-sections` (private, 10 MB, PDF/WebP/JPEG: the cleaned PDFs and every page picture,
`<shop>/<section>/v<version>/`) and `shop-sections-public` (public, 5 MB, WebP/JPEG: copies of the pictures of shown
sections only); no policies, only the page-sections function writes either.
Update 35: `partner-feeds` (private: the admin uploads feed files into `<partner>/`; the partner-feeds function keeps an
import's parts in `imports/<import>/` until it ends) and `partner-logos` (public, 1 MB, PNG/JPEG/WebP; the admin writes).
A WebP logo has a PNG copy next to it (`logo-<time>.png`) for the conversation PDFs.
Update 37: `blog-photos` (public, 5 MB, WebP/JPEG: `<shop>/<post>/<random>-1600|800.webp|jpg`; no policies, only the
shop-blog function writes; a photo's files are deleted before its row).

## 8. Security and privacy

| Data | Visitor | Shop owner | Stock-pull function |
| --- | --- | --- | --- |
| Shops | active shops (public fields, incl. e-mail, Facebook page, booking link and the assistant texts) | own shops: details through `owner_save_shop()`, the assistant texts through `owner_set_assistant_texts()` (paid plan), logo directly (never the page address); delete through `owner_delete_shop()` | read |
| Items (names, codes, EAN, translations) | items of active shops | own items: read, correct the translation (`owner_set_item_translation()`); no way to hide an item | write (stock and machine translations) |
| Stock (quantity, price) | only through `public_stock` / `search_stock` / `shop_stock`: the quantity as in the file and its label, nothing for stale shops | own stock (`owner_items()`) | write |
| Import reports (`stock_imports`) | none | own shops' reports (read) | writes them (`record_stock_import()`, keeps the last 10) |
| Stock source (`sync_sources`) | none | own shop through `my_shops()`, `owner_set_mapping()`, `upload_check_in()` | read and write |
| Accounts (`profiles`) | none | own profile | — |
| Paid plan (`subscriptions`) | none (only yes/no through `shop_has_plan()`) | own shops' row (read) | the Stripe functions write it: stripe-checkout links the customer, stripe-webhook the subscription |
| Documents, pictures, folders | only through the assistant: excerpts of the Public folder and of folders opened by a valid key (`search_shop_docs()`), files through shop-files | own: read; change through `owner_*` functions; upload through doc-ingest | doc-ingest writes (service role); shop-files signs 10-minute file addresses |
| Access keys and sessions | open with a key (`unlock_shop_folders()`), lock again; the open folders' file list (`shop_folder_files()`); viewing, downloads and ZIP only through shop-files (`shop_view_file()`, `shop_download_file()`, `shop_zip_ticket()`, service role) | own keys (never the hash): create, revoke, the folder's own key (`owner_set_folder_key()`); access mode and per-file access (`owner_set_folder_access()`, `owner_set_file_access()`); counts | — |
| Assistant conversations, files, PDFs | their own open conversation only through its token (website → assistant-archive): add files, delete it | own shops: read (RLS), keep time, delete; files through 10-minute links | assistant-archive writes everything (service role); the jobs prove themselves with a Vault secret |
| Cloud connection and copies | none | own shops: read the connection (never the tokens) and the copies; connect, choose the folder, retry, copy older ones, disconnect only through cloud-export with their own login (membership and plan checked there and in `owner_cloud_retry()` / `owner_cloud_backfill()`) | cloud-export writes (service role); the tokens are encrypted before they reach the database |

- Owners never write stock themselves; the function does, after checking the uploader is that shop's owner.
- The function downloads nothing: it only receives files uploaded with the shop owner's login.
- Stripe: the website holds no Stripe key. The stripe-checkout function answers only a shop's owners (their own login);
  the stripe-webhook function accepts only events signed with the endpoint's secret and at most 5 minutes old, and
  fetches the subscription from Stripe itself rather than trusting the event's copy. Card details never touch PPI.
- The API, the AI search and the shop assistant store no IP addresses: only a hash with a salt that changes daily.
- The shop assistant's conversations are kept only in the shop's archive (6.10): written only by the assistant-archive
  function (the website proves itself with `ASSISTANT_ARCHIVE_SECRET`, the shopper's browser with the conversation's
  token, kept as a hash), read only by the shop's owners, deleted after the shop's keep time. GPS and place data are
  removed from photos before storing. Nothing of a conversation, a file, a token or a key is logged.
- Cloud folder (6.11): OAuth with PKCE and a single-use state (kept as a hash); the cloud tokens are encrypted with
  AES-GCM (`EXPORT_TOKEN_ENCRYPTION_KEY`, bound to the shop and the token's use) before they are stored, never shown to
  owners, never logged; "Odpojiť" deletes them. The archive asks cloud-export to copy with the service role key; the
  job proves itself with the Vault secret. PPI never deletes, moves or replaces anything in a shop's cloud.
- Access keys and session tokens are stored only as hashes; the key goes only to the database, never to the AI or into
  the conversation; the session token stays in an HttpOnly cookie signed with `SESSION_COOKIE_SECRET` and sent only to
  that shop's `/api/shops/<slug>/` addresses. Shop files are only reachable through 10-minute signed addresses that the
  shop-files function issues after the database said yes.
- Viewer pages (update 24) are served by the website with the watermark drawn in, only for a signed address (HMAC with
  `SESSION_COOKIE_SECRET`, 10 minutes, bound to the session token's hash) together with the session cookie; the
  database checks the folder again for every page. Downloads are 10-minute storage addresses with
  Content-Disposition: attachment; the ZIP is a single-use ticket kept as a hash. The ZIP and the counts never hold
  more than the database allows.
- The Anthropic key is a server setting (Supabase function secret, Vercel variable), never in the browser; the AI
  search endpoint answers only the PPI website (no CORS).
- Legacy: the remaining `admin_*` database functions from the old admin area still exist in the database but nothing
  on the website uses them; `is_admin` is used again since update 25, only for "Predplatné a domény" and the domain
  functions (`admin_shops()` and `admin_save_shop()` were dropped by migration
  21 with the display columns they set).

**Shop blog and Facebook (update 37).** The Facebook Page token is encrypted with AES-GCM (`FB_TOKEN_ENCRYPTION_KEY`,
bound to the shop and the Page) before it is stored, used only by the shop-blog function, never shown to owners or
logged; "Odpojiť" deletes it. The login uses a random single-use state (kept as SHA-256, 10 minutes) and comes back
only to the function's own address and then to a `…/dashboard/blog` address saved with the state; every Graph call
carries `appsecret_proof`; the webhook accepts only bodies signed with the app secret. Only the permissions the blog
needs are asked for; comments, reactions, likes and other people's names are never requested or stored. Pictures are
downloaded only from Facebook's own picture hosts. Public pages load nothing from Facebook (no SDK, pixel, plugin or
embedded post); visitors read posts only through the database's visibility rule. The privacy page and the data
deletion page are drafts (TODO lines) until the legal text is final.

**Partner feeds (update 35).** Nothing about visitors goes to partners: their feeds are read on our server, and a
partner's page opens only when the shopper clicks its link. The new tables have RLS on and no grant for visitors or
owners; visitors read partner rows only through `search_partner_products()` (data under 48 hours with availability,
older without), the admin manages partners only through `admin_*` functions (`is_admin()`), the partner-feeds function
writes with the service role. Feed addresses are https of a real host only and never logged. Affiliate links are marked
and never change the order.

**Outside sources (update 34).** The main chat's search sends only the product and the town to OpenStreetMap
(Nominatim, Overpass API), Google Places (when switched on) and Anthropic (Claude and its web search) — never anything
about the visitor, never a location. The new tables have RLS on and no grant for visitors or owners; the product-sources
function (service role) reads and writes them, the admin only through `admin_*` functions. Nothing from Google and no
web result is stored; OpenStreetMap answers are kept as caches. The website reaches the function only with
`EXTERNAL_SEARCH_SECRET` (server-only, Vercel Sensitive + Supabase secret). The privacy page lists the services (a TODO
line until the legal text is final).

## 9. Design

- Plain white background, black text, thin light-grey lines; mobile-first. No colours, no dark mode, no cart icons.
- Font: **Quicksand** on every page of the website (PPI's pages, Môj obchod, the admin page and the shops' own domains;
  also the map's tooltips), served from the site itself. Codes such as DNS records and keys stay monospace; the
  conversation PDFs keep their embedded font (DejaVu Sans).
  Exceptions at the owner's request: the Cacaduu PPI logo in the header, the blue "Select picture" link for logos and
  the same blue "Vybrať súbor" link of page sections, and (Prompt 10) the **thinking dots of the main page's chat in
  Cacaduu yellow #FFC531**, next to the small Cacaduu pin, only while the AI works (still with "reduce motion").
- Availability always written out as text, in bold, always next to its freshness.
- Translated names in grey under the shop's own name. The main page's chat: the shopper's question in a light-grey
  bubble on the right, the answer on the left without a border, cards with thin grey lines; the input large and rounded.
- Map: OpenFreeMap "positron" (free, no key), black dot pins; never required for the page to work.
- Shop blog (update 37): black and white like the rest; photos with a thin grey line; the Facebook preview in the
  publish dialog is a plain sketch (no Facebook colours or logo); no Facebook SDK, pixel, plugin or embedded widget on
  any page.
- **Status dots** (Prompt 9A, at the owner's request): green #1E9E5A open,
  blue #2F6FED lunch break, red #D64545 closed, yellow #F2B705 public holiday, grey #9AA5B1 no hours; always shown
  together with the status in words, never colour alone (on the page next to the shop; on a map pin in its tooltip
  and label — no legend under the maps, at the owner's request); on maps a white outline and a thin dark ring.
- On a shop's own domain: no Cacaduu header; the shop's small logo at the top left (a link home; its colours are the
  shop's own logo) and SK · HU · EN on the right, a thin line under them (update 31); the shop's name and logo on the
  page above its details.
- Language switch SK · HU · EN in the header; "For shops" link to the login.
- App icon: black "PPI" letters on white.

## 10. Key texts

| Key | SK | HU | EN |
| --- | --- | --- | --- |
| in\_stock\_count | {n} ks na sklade | {n} db raktáron | {n} in stock |
| out\_of\_stock | Vypredané | Elfogyott | Out of stock |
| chat.title (default button) | Opýtajte sa asistenta obchodu | Kérdezze az üzlet asszisztensét | Ask the shop's assistant |
| imports.title | Posledné nahrané súbory | Legutóbb feltöltött fájlok | Recently uploaded files |
| chat.privacy\_notice | Konverzácia a nahrané súbory sa ukladajú pre obchod {shop}. | A beszélgetést és a feltöltött fájlokat a(z) {shop} üzlet számára tároljuk. | The conversation and uploaded files are stored for the shop {shop}. |
| conversations.title | Konverzácie asistenta | Az asszisztens beszélgetései | Assistant conversations |
| stale | Informácia o zásobe momentálne nie je dostupná | A készletinformáció jelenleg nem elérhető | Stock information not currently available |

All texts are in `src/i18n/messages/{sk,hu,en}.json`. A native speaker should check Slovak and Hungarian before launch.

## 11. Known limits and open points

- **Freshness needs the shop PC.** The stock software must keep exporting and the PPI window must stay open (or the
  owner uploads by hand); otherwise the shop goes `recent` and after 24 hours `stale`. No alert e-mail is sent yet.
- **Anyone can sign up and add shops** (5 per account); there is no review. Watch for fake shops.
- **Not yet found by web search** until the site is registered with Bing and Google (SETUP.md part I); Claude finds
  shops at once through the MCP connector.
- **Translations and AI answers are machine-made.** The cards come from the database, but the AI's short answer and
  the translations can be wrong; owners can correct translations. The first translation of each shop's names happens
  with its next new stock file.
- **The four sample shops** from the build are still live (their names have no translations).
- The site's main domain is `cacaduu.com` (since 20 October 2026: `NEXT_PUBLIC_SITE_URL`); `cacadooppivercel.vercel.app` still
  answers and points search engines to it with its canonical links (shops can have their own domains: 6.13).
- **Paid plan in test mode.** Stripe runs with test keys (test cards only) until it is switched to live; the shop
  assistant, its texts, its documents and hiding other shops on product pages are the features that check
  `shop_has_plan()` so far (other shops are also hidden while a domain of the shop's own is being set up or live). If Stripe cannot reach the webhook, the plan
  shows late (Stripe retries for up to three days) and, past the paid period, counts as not paid until the event arrives.
- **AI limits can be used up by others.** The AI search's daily total and the shop assistant's monthly cap are counted
  by database functions that the website calls with the public key; someone calling them directly could use up a
  limit (it costs nothing, the feature just pauses until the next day or month). A secret shared by Vercel and
  Supabase would close this.
- **Conversation archive:** WebP logos uploaded before 10 October 2026 have no PNG copy: their PDFs show no logo until
  the logo is uploaded again. Chrome and Edge cannot read HEIC photos: they are stored but have no preview and the AI
  does not see them (Safari makes a preview). The owner reads conversations on the website; the PDF itself reaches the
  owner through the cloud folder (6.11). A shopper can delete a conversation only while the chat box is open. The
  privacy page (`/sukromie-asistent`) has a draft text. Tested so far only against Claude and Storage stand-ins.
- **Access keys (update 24):** "Len zobraziť" cannot stop screenshots or photos of the screen (the watermark shows
  where a copy came from). PDFs uploaded before update 24 show "pripravuje sa" for shoppers until the owner clicks
  "Pripraviť na zobrazenie". A ZIP holds at most 100 MB (bigger folders: file by file). The shopper's own conversation
  PDF shows the item cards' availability in Slovak (as kept in the archive). Tested so far only against Storage and
  Claude stand-ins.
- **Cloud folder:** tested so far only against OneDrive, Dropbox and Brevo stand-ins. OneDrive asks for access to all of
  the owner's files (Microsoft has no narrower permission for a folder of the owner's choice); PPI works only in the
  chosen folder. The Microsoft app's client secret expires (at most after 24 months): it must be renewed in Azure and
  in Supabase before then, or every OneDrive copy fails. Files up to 150 MB (Dropbox) and 250 MB (OneDrive) are sent in
  one piece; the archive's files are at most 10 MB. The failure e-mail needs `BREVO_API_KEY` and `ALERT_EMAIL_FROM`;
  without them copies still work and the page shows the problem. Disconnecting OneDrive deletes PPI's tokens but
  Microsoft keeps the app's permission until the owner removes it in their Microsoft account.
- **Own domains (update 25):** built and tested only against Websupport, Vercel, Stripe and Brevo stand-ins. The
  Websupport field names (domain profile, order, credit, auth code) follow its public REST documentation, which could
  not be opened from the build machine: the test-mode dry run (SETUP.md part R) must show the order accepted with the
  shop's profile before `REGISTRAR_MODE=live`. In test mode every bought domain goes on the one test domain, so only one
  test website at a time. If Websupport does not return the auth code through the API, the admin is e-mailed and saves
  it by hand. The main sitemap is rebuilt hourly, so a newly connected shop leaves it within the hour.
- **The assistant can be wrong.** It reads photos and writes answers by machine; the cards, prices and availability
  come from the database, and it says when it is not sure, but a shopper should check the item page.
- **Documents: machine reading.** Scanned pages are read by AI and can contain reading mistakes; picture descriptions
  are AI-written (the owner can correct them); a PDF whose text is stored as outlines (no text layer, no images) gives
  the assistant nothing. Answers in other languages are the AI's translation of the shop's documents. Tested so far
  only against a Claude stand-in: try it with real documents before telling shops about it.
- **Keys can be passed on.** Whoever has a key can open its folders until it expires or is revoked; the owner sees how
  often and when each key was last used.
- **Reading PDFs needs the owner's browser to stay on the page** until the upload and the AI's look at the pictures
  are done; anything left over continues the next time the owner opens the dashboard, and an upload left unfinished
  for an hour shows as an error to delete and upload again.
- The wrong-key counter is kept like the other limits (the website calls it with the public key).
- **Partner feeds (update 35).** A partner's whole feed must fit `PARTNER_FEED_MAX_MB` (at most 500 MB) — a large
  chain's full Google feed can be several hundred MB unpacked: ask the partner for a feed of the products and regions
  that matter, or raise the limit (the parts take that much Supabase storage while an import runs; the free plan has
  1 GB in all). Storage's own file limit (50 MB on the free plan) also caps a file the admin uploads; an address has
  no such cap. Store stock needs the partner's local inventory feed in Google's format (Heureka's availability feed is
  not read). A store is matched to the shopper's town by the store list's town or, with coordinates, by the town's
  centre when Cacaduu or OpenStreetMap already knows it. The partner layer is in the main chat only (not in the public
  API, MCP or the plain search).
- **Shop blog and Facebook (update 37).** Built and tested only against stand-ins for Facebook's Graph API, Brevo and
  IndexNow: try it with a real Page (davide.sk) before telling shops. Until Meta approves the app (App Review of
  `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` and business verification), only people with a role
  in the Meta app can connect a Page. Facebook sends no webhook for the posts of a Page without `pages_manage_metadata`
  (then the daily sync brings the changes). A post edited on Facebook after it went there from Cacaduu stays as on the
  web (Cacaduu's post is the original); an edit in Cacaduu does not change the Facebook copy. A post deleted on Facebook
  is hidden on the web within a day (with the webhook within minutes). Long Facebook videos are shown only as their
  picture with a link. The Graph API version (v23.0) must be moved on when Meta ends it (about two years). The privacy
  and data deletion pages have TODO lines for the legal text.
- **Outside sources (update 34).** The deep links need the admin's search addresses (none are set for the five domains
  of the brief: their search pages could not be checked from here). OpenStreetMap is only as complete as its volunteers
  made it: a town may show few shops, or ones that have closed. The web search runs on the model in `AI_MODEL`; the
  Anthropic organisation must allow web search (Claude Console) and its allowed domains must include the admin's
  domains, otherwise the web layer quietly finds nothing. "Good result" also needs the item not to be sold out (a sold-out
  item does not answer "who has it"). The opening_hours library is LGPL-3.0 and runs only on the server.

## 12. Launch checklist

- [ ] Remove the sample shops (SETUP.md part D)
- [ ] "Reset password" e-mail template pasted (SETUP.md E3) — confirmation template done
- [ ] Own domain connected; Supabase Site URL and redirect URLs updated to it
- [ ] Site registered with Bing Webmaster Tools and Google Search Console, sitemap submitted
- [ ] Row Level Security reviewed by a developer, not only by the AI that wrote it
- [ ] Texts checked by native speakers (SK, HU)
- [ ] `AI_DAILY_LIMIT` chosen in Vercel (default 500 AI searches a day)
- [ ] Stripe switched to live: live product and price, Stripe Tax registrations, customer portal, webhook endpoint,
      and the three Stripe secrets replaced with live values (SETUP.md part K5)
- [ ] Price, terms and what Pro includes published for shop owners
- [ ] `CHAT_MONTHLY_LIMIT_PER_SHOP` chosen in Vercel (default 1,000 assistant messages per shop a month)
- [ ] `SESSION_COOKIE_SECRET` set in Vercel (access keys for private folders); shop limits chosen in Supabase
      (`SHOP_DOCS_MAX_FILES`, `SHOP_DOCS_MAX_PAGES`, `SHOP_DOCS_MAX_PICTURES`)
- [ ] Privacy page and terms (shop data, cookies, e-mail); final text of `/sukromie-asistent` (the assistant archive)
- [ ] `ASSISTANT_ARCHIVE_SECRET` set in Vercel and Supabase; pg_cron jobs `ppi-assistant-tick` and
      `ppi-assistant-retention` succeed (SETUP.md part O)
- [ ] Access keys: database update 24 and the three updated functions; every older PDF in a private folder prepared
      for viewing ("Pripraviť na zobrazenie"); `SESSION_COOKIE_SECRET` set (SETUP.md part Q)
- [ ] Cloud folder: Microsoft and Dropbox apps registered (Dropbox app in production status for more than 50 users),
      their secrets, `EXPORT_TOKEN_ENCRYPTION_KEY`, `BREVO_API_KEY`, `ALERT_EMAIL_FROM` set in Supabase; job
      `ppi-cloud-export-tick` succeeds; a reminder for the Microsoft client secret's expiry date (SETUP.md part P)
- [ ] Own domains: database update 25, the `domains` function and the updated Stripe functions; `invoice.paid` added to
      the Stripe webhook; Websupport, Vercel and domain secrets set; price table and test domain filled in; a test-mode
      purchase and a connected domain reached "Beží"; then `REGISTRAR_MODE=live` and enough Websupport credit (SETUP.md
      part R)
- [ ] Booking link and other shops hidden with a domain: database update 26 pasted (SETUP.md part S)
- [ ] Shop status: database update 27 pasted; the Slovak, Hungarian and Czech holidays checked against official sources
      before each new year (`node scripts/holidays.mjs <year>`; changes as admin rows in "Sviatky") (SETUP.md part T)
- [ ] Page sections: database update 28 pasted; the page-sections function deployed and shop-files updated; the hourly
      job `ppi-sections-hourly` succeeds (SETUP.md part U)
- [ ] Every public page checked with JavaScript turned off
- [x] Service role key only in Supabase function secrets
- [x] Stale shops show no stock on every page, in the API and in MCP
- [ ] `ADMIN_EMAIL` set in Supabase (OpenStreetMap needs a contact); `EXTERNAL_SEARCH_DAILY_LIMIT` chosen; the web domains
      and their search addresses checked on the admin page; Google Places only after reading Google's terms
- [ ] Privacy page: the legal text for the outside services replaces the TODO line
- [ ] Partner feeds: database update 35 pasted, the partner-feeds function deployed (Verify JWT off),
      `PARTNER_FEED_MAX_MB` chosen; each partner's feed imported once by hand ("Importovať teraz") and its counts
      checked; the job `ppi-partner-feeds-tick` succeeds; affiliate partners named in the terms (SETUP.md part AF)
- [ ] Shop blog: database update 37 pasted, the shop-blog function deployed (Verify JWT off) with `FACEBOOK_APP_ID`,
      `FACEBOOK_APP_SECRET`, `FB_TOKEN_ENCRYPTION_KEY`; the Meta app's Facebook Login for Business, redirect URI, privacy
      and data deletion addresses, webhook; App Review and business verification passed; the job `ppi-blog-tick`
      succeeds; the final text of `/sukromie` and `/sukromie/vymazanie-udajov` (SETUP.md part AI)

- [ ] "Obsah stránky": database update 38 pasted, the page-sections and shop-files functions redeployed; every shop's
      old sections checked in its slider; the admin's "Limity obsahu stránky" checked (SETUP.md part AJ)

- [ ] Videos: database update 39 pasted, the shop-blog function redeployed; a Facebook video and a YouTube share on the
      Page imported; the choice "Tlačidlo ▶ pri videách otvorí" checked on the shop page (SETUP.md part AK)

## 13. History

| Date | Milestone |
| --- | --- |
| 2026-10-01 | Phase 1–2: Next.js foundation, Supabase database, rules in SQL, automatic checks |
| 2026-10-03 | Europe-wide (no home town, any currency/time zone); phase 3 public pages + map + JSON-LD; phase 4 login, owner dashboard, admin area |
| 2026-10-04 | Shop facilities; phase 5 AI access (robots, sitemap, llms.txt, API, MCP); phase 6 automatic stock pull with AI mapping; shop PC tunnel installer (later replaced) |
| 2026-10-06 | Shop PC as a browser app instead of a tunnel; self-service sign-up with passwords; admin area removed; no location services, text search incl. shop name/street/town; logo upload fixes; Cacaduu PPI logo; search-engine verification tags |
| 2026-10-07 | "Upload file" button |
| 2026-10-08 | This as-built PRD and architecture document |
| 2026-10-08 | Cloud links (built 2026-10-07) removed: stock arrives only by upload — the PPI app window and "Upload file" |
| 2026-10-08 | Item names in Slovak, Hungarian and English with search across languages; AI search on the main page |
| 2026-10-08 | Paid plan per shop with Stripe (test mode): Checkout, customer portal, webhook, VAT invoices, `shop_has_plan()` |
| 2026-10-08 | AI assistant on the shop page for shops with the paid plan: questions, shopping lists, photos of parts |
| 2026-10-09 | Documents and pictures for the assistant: PDFs read in the owner's browser, AI picture descriptions, Public and private folders with access keys, sources and document prices in answers |
| 2026-10-09 | Shop page updates: no other shops on Pro product pages, shop e-mail and Facebook, the assistant's own texts, "My shop" as dropdowns, one display rule |
| 2026-10-10 | Conversation archive of the shop assistant: conversations, files (GPS removed) and a PDF per conversation; "Konverzácie asistenta" for owners; keep time 30/90/365 days |
| 2026-10-10 | Cloud folder: each finished conversation (PDF + files) copied into the shop's OneDrive or Dropbox; status per conversation, "Uložiť znova", older conversations, e-mail after 24 hours of failures |
| 2026-10-10 | Access keys for shoppers: unlock in the chat (also by typing the key), viewer with watermarked pages, "Len zobraziť" / "Zobraziť a stiahnuť" per folder and file, downloads and ZIP (20 per session), a key per folder, counts; the shopper's own conversation PDF |
| 2026-10-11 | Own domains for Pro shops: buy one through PPI (search on websupport.sk, paste, pay once; registered in the shop's name at Websupport) or connect one the shop already has; the shop page served on its own domain; renewals, transfer code, admin page "Predplatné a domény" |
| 2026-10-11 | Booking link on the shop page ("Rezervovať termín", every shop); no other shops on product pages of shops with a domain of their own; quick view (slideshow) of the recently uploaded stock files |
| 2026-10-13 | Pro page layout and shop status: open / lunch break / closed / holiday / no hours with coloured dots on maps, lists, the shop page, API, MCP and JSON-LD; public holidays (SK, HU, CZ) and the owner's special days; "Automatické štátne sviatky"; new section order (details under the name), the assistant always open, "Mám prístupový kľúč" as a dropdown; no Cacaduu header on own domains |
| 2026-10-13 | Page sections from PDFs (Pro): up to 10 per shop, cleaned on the server, pages as 800/1600 px pictures with their text, collapsed or always open in four positions, dates, preview, download on/off, the assistant names them; public pictures only while shown (hourly job); own domains get the shop's header picture, the name and logo back on the page |
| 2026-10-13 | Page sections: "Zobrazenie strán" (slider or one under another), full-screen viewer; page sections for free shops too (limits per plan set by the admin, "Pre viac sekcií prejdite na Pro", after the opening hours on a free page, Pro → free shows the first one) |
| 2026-10-14 | Own domain header back to a small clickable logo ("Logo v hlavičke webu" replaces the header picture) with SK · HU · EN; the section position "Za otváracími hodinami"; page sections made of pictures (JPG, PNG, WebP) |
| 2026-10-14 | "Odkaz loga": the own domain's header logo can lead to another address (e.g. the shop's main website) instead of the home page |
| 2026-10-14 | Ticks on "Vaše mimoriadne dni" to delete several days at once ("Vybrať všetko", "Vymazať vybrané"); page sections choose their file with a blue "Vybrať súbor" link |
| 2026-10-14 | Assistant conversations: "Stiahnuť PDF" and "Stiahnuť vybrané" (each its own PDF, straight to the PC); the shopper's pictures large in the PDF |
| 2026-10-14 | "Konverzácie do počítača": each finished conversation saved by itself as a PDF into a folder on the shop PC (Edge/Chrome, while the PPI window is open) |
| 2026-10-14 | Own domains easy to find: "Overiť v Google Search Console" (TXT record into DNS only by adding, or shown to add), "Odoslať sitemap", llms.txt and robots.txt per own domain with "Kategórie tovaru", IndexNow once per upload with only the changed pages, Product/Offer + Store JSON-LD on own-domain item pages, search results linking to the own domain |
| 2026-10-14 | The main page as one AI chat: "Čo dnes hľadáte?", example questions, thinking dots in Cacaduu yellow with the real steps, the answer streamed word by word, result cards with freshness, status and distance from the named town, follow-ups, "Nový chat", "Zastaviť"; the plain search as a hidden fallback; "Len dostupné teraz" removed from the page (the API and MCP keep `only_available`) |
| 2026-10-15 | The chat finds products in layers: Cacaduu first, then shops nearby (OpenStreetMap, optionally Google Places) and offers on allowed shop websites (Claude's web search) with deep links, only when Cacaduu has fewer than 3 good results and the shopper wrote a town; other questions declined; admin switches, allowed domains, calls and cost per day |
| 2026-10-15 | Partner feeds: partners' product feeds (Google Merchant XML/CSV + local inventory, Heureka XML, own CSV) read on a schedule in parts, shown in the chat under "Partneri" between Cacaduu and shops nearby; 48-hour rule; affiliate links marked, never ranked; admin "Partnerské feedy" |
| 2026-10-15 | Own domains fully findable: "Odstrániť" removes only the TXT record Cacaduu added, the same value is never added twice; the Google "HTML značka" for connected domains (recommended) next to the TXT record; Bing Webmaster Tools (meta tag or import); sitemap steps for Google and Bing; llms.txt with holidays, the stock's categories and Cacaduu's API/MCP; IndexNow on every host with one `INDEXNOW_KEY`, only meaningful changes, once per upload and once an hour per host, logged; the Offer keeps the price on stale pages; `x-default` hreflang; API/MCP `source_url` and PPI's llms.txt point to the own domain |
| 2026-10-20 | Shop blog "Novinky": posts written in Cacaduu (photos, scheduling) or imported from the shop's Facebook Page (all past posts, a daily sync, edits and deletions followed), published to the Page on request ("Zverejniť aj na Facebooku?"); `/blog` pages with JSON-LD, RSS, sitemap, llms.txt and IndexNow on Cacaduu and own domains; free shops show the newest 10; privacy and Facebook data deletion pages |
| 2026-10-20 | Môj obchod → Asistent with its four sections once each; "Obsah stránky": one slider on the shop page with automatic and pinned blog posts, PDFs and pictures in the owner's order (counters per plan, drag and drop, live preview, library with HEIC/PNG/JPEG/WebP pictures and cleaned PDFs); the page sections of updates 28–31 migrated into it |
| 2026-10-21 | Videos: ▶ on video posts in the slider (to the article or the post on Facebook, the owner's choice), YouTube shares keep YouTube's picture and play on the blog post after a tap (youtube-nocookie), Facebook videos open on Facebook |
| 2026-10-22 | Speed and fixes pass: cached public pages refreshed on every change, faster search and owner lists (update 42), map/assistant/language list after the page, tap feedback, no layout jumps in Môj obchod, server error list for the admin, Speed Insights, phone e2e and a performance budget on every preview |


### 6.19 The "Tovar" list in Môj obchod (database update 41)

- Under Môj obchod → Jazyky a inventár → Tovar: one short line "Množstvá zobrazujeme presne podľa vášho skladového
  súboru. Názvy a popisy prekladáme automaticky; vaše úpravy prekladov neprepisujeme." + "Viac" (the longer text).
- Above the list: "Posledný súbor: <date and time in the shop's time zone> · aktuálny / starší / zastaraný"
  (+ "Nahrať nový súbor" when out of date); "Zatiaľ ste nenahrali žiadny súbor so zásobami." without a file.
- Filters with their numbers: Všetko / Na sklade / Vypredané (by the quantity in the file) / Bez popisu (no description
  on the product page) / Chýba preklad (the name or the shown description has no current translation in a language the
  shop's texts are translated into; an outdated machine translation counts, "Neprekladať" does not).
- Per product: the name as written, its translation in the page language, small notes "Bez popisu" / "Chýba preklad",
  and **one** link "Popis a preklady" to the product's page (tabs Popis and Preklady — every correction is made there).
- Column "Čo vidí zákazník": exactly the shopper's text ("22 ks na sklade", "Vypredané"); when the data is older than
  24 hours, grey "Skryté – údaje sú staršie ako 24 h · Nahrať nový súbor". Never "–".

### 6.20 "Začať sklad odznova" (database update 43)

- **Where:** Môj obchod → Priečinok s exportom. "Posledné nahrané súbory" (the last 10 stock files) lives there again
  with **"Vymazať všetky nahrané súbory"**; at the bottom, collapsed on every device, **"Nebezpečná zóna – sklad"**.
- **"Vymazať všetky nahrané súbory"** (dialog: "Vymažú sa všetky nahrané súbory (X). Sklad na stránke zostane, kým
  nenahráte nový súbor." → Vymazať / Zrušiť): the list, the last file's name, the mapping's example rows and the raw
  files in Storage go; the stock stays and its freshness runs out as usual (hidden after 24 h). Everywhere the last file
  is shown it says "Žiadny nahraný súbor · nahrajte nový" until a new file comes. Not restorable (the backup covers the
  data). Private-folder files and the assistant's documents are never touched.
- **Option A "Odstrániť produkty, ktoré nie sú v poslednom súbore"** (recommended first): only the products that are
  sold out because the latest file did not list them (not those the file lists with 0); the list and the count before
  confirming. They return with their translations if a later file lists the same code.
- **Option B "Vymazať celý sklad a začať odznova"**: every product, quantity and price of the shop and every uploaded
  file. Choices: "Zachovať preklady a popisy pre produkty, ktoré sa vrátia s rovnakým kódom" (on), "Zrušiť aj nastavenie
  stĺpcov (mapovanie)" (off). The shop's name is typed to confirm. Until the next file the shop page says "Sortiment sa
  práve aktualizuje." and Môj obchod shows "Nahrajte nový skladový súbor"; sitemaps, search, API/MCP and llms.txt follow
  at once.
- **Safety:** before A or B a backup CSV of the whole stock (code, name, EAN, brand, category, description, quantity,
  price, currency, file time, the Cacaduu description and every translation — never purchase prices or suppliers) is
  downloaded and kept 30 days under "Zálohy" (not an uploaded file: "Vymazať všetky nahrané súbory" keeps it). Removed
  products wait 30 days in a trash; "Obnoviť sklad" brings back the newest removal exactly, unless a newer stock file was
  applied since (then it says so). At most 3 removals per shop and day. Every action is in "Posledné akcie".
- **Not built:** customer alerts ("Upozorniť ma") and the Pomocník do not exist yet, so there is no "zrušiť upozornenia"
  choice; the activity log and `owner_inventory_state()` hold what a future Pomocník needs ("Vymazal sa mi sklad?").

### 6.21 "Priečinok s exportom": review after an upload, translations folder on the shop PC (database update 45)

**Page order** of Priečinok s exportom: 1. Priečinok so skladom (read only) · 2. Po nahratí súboru · 3. Preklady v
priečinku · 4. Posledné nahrané súbory (+ "Vymazať všetky nahrané súbory") · (Pro: conversations to the PC) · 5.
Nebezpečná zóna – sklad. The shop's languages, the stock file's columns and the stock files in other languages moved
here from "Jazyky a inventár" (old addresses forwarded).

- **"Nový súbor – skontrolujte"** appears only when something waits for a decision:
  - a **new column** of the stock file: a free field or **"Súkromné – nezobrazovať"** (the default; nothing is approved
    by itself — until then the column is private, never read or shown);
  - **"Nové produkty: X · zmenené: Y"** (name, description or category differ from what the owner last saw): the
    languages they are translated into (the shop's preferred languages, at most the plan's number: free 2, Pro 6) and
    **"☐ Vygenerovať popisy"** (drafts for these products only, from the shop's own data);
  - **"☐ Zapamätať a už sa nepýtať"**: later new products are handled the same way by the shop PC's window; new
    columns are always asked about.
- **Translations folder** (Edge/Chrome on the shop PC): "Vybrať priečinok pre preklady" (never the stock folder).
  Cacaduu writes `sklad.<main>.xlsx` (the approved columns as the stock file names them + "Popis" + "Stav popisu") and
  `sklad.<lang>.xlsx` per language (Kód, Pôvodný názov, Názov, Popis, Kategória, Stav); every column is text, the header
  bold, frozen and filtered, a "Návod" sheet explains it. **Never private data** (only approved columns exist in PPI).
- **Reading the owner's edits** on every check (every 15 minutes, when the window opens, "Skontrolovať teraz"): files
  whose time or contents changed, untouched for 60 s (open in Excel → "… je otvorený v Exceli", read later). Rows by Kód,
  then EAN. A changed translation → the owner's own ("upravené ručne", never overwritten); a changed main "Popis" → the
  owner's published description (its machine translations are made again). Changes in read-only columns, empty cells,
  unknown or extra rows change nothing (listed). One result line per file; every applied file in the activity log.
- **Order:** read the edits → the stock file (from the stock folder) → write the files again (only when something
  changed; through a temporary file that replaces the old one; a file open in Excel waits — "Naposledy zapísané …",
  "Zapísať teraz"). Cacaduu only writes, reads or deletes files it created itself.
- **Any browser:** "Stiahnuť preklady (.xlsx, ZIP)" and "Nahrať upravený súbor" (the same rules).
- **Danger zone B** ("Vymazať celý sklad") also deletes the translation files Cacaduu created (ticked by default; done by
  the shop PC's window). Its backup CSV already contains the descriptions and the translations. There are no customer
  alerts yet, so nothing to cancel there.

### 6.22 Product display (27 October 2026)

- **Names:** in every product list (shop page, search results, chat cards) and on the product page the name in the
  page language comes first (dark) and the shop's own name under it (light); without a translation only the shop's name.
- **Stock dot before every price:** green = in stock, red = sold out, yellow = no information (the shop's data are stale).
  Always next to the availability in words.
- **Product page:** no "Preložené automaticky · Zobraziť originál" line; the names and the data in one frame with bullet points (price
  with the dot, Dostupnosť, Značka, EAN, Kategória), the description under a thin line in the same frame.

### 6.23 "Pripojiť skladový program (API)" (database update 49)

- On "Priečinok s exportom", first: the shop connects its inventory program with a key that only reads. Built:
  SuperFaktúra, WooCommerce, "Vlastné API (JSON/CSV URL s API kľúčom)"; Shoptet and Dotykačka "Pripravujeme" (their
  documentation could not be checked yet). Each program has a hint where to make the key.
- Pro by default (every 15 min); the admin may allow Free with its own slower interval (default 24 h). SuperFaktúra at
  most once an hour (its daily limit).
- The key goes from the browser straight to Cacaduu's function, is tested, stored only encrypted, never shown again
  ("••••1234" + date). "Otestovať pripojenie", "Zmeniť kľúč", "Odpojiť" (deletes it at once).
- First a preview (first rows, number of products, the fields) → "Schváliť a spustiť". Changed fields → asked again.
  Nothing is published before the approval.
- One source at a time: while connected, the folder and the upload say "Sklad sa aktualizuje cez <program>".
- A run applies only a complete list; a partial, empty or failed answer never changes the stock. No quantities →
  "Údaje o množstve tento program neposiela": names and prices only if the owner agrees, never an availability.
- The card: program, connected since, last success ("X produktov, Y zmien"), next sync, the last error in plain
  Slovak, "Synchronizovať teraz" (4× an hour). Invalid key → "Kľúč neplatný" and one e-mail after 24 h.
- Purchase prices, suppliers and margins are never asked for; if a program sends them they are dropped first.

### 6.24 POS Sync Agent: pairing and devices (database update 50, Prompt 13 phase A)

- Môj obchod → Priečinok s exportom → **"Prepojenie s pokladňou (POS agent)"**: "Pridať POS agenta" shows a one-time
  code (8 characters without look-alikes, valid 10 minutes, shown once) and three steps; the owner types it into the
  desktop app and the computer appears in the list.
- The list: name (Premenovať), agent version and system, POS source label, last online, last sync, paired, the last
  error as plain text, **Odpojiť** (at once). The state comes from the heartbeat times, never a stored flag: Online
  (a heartbeat in the last 3 minutes), Offline, Chyba (the agent's last read failed), Ešte nesynchronizované (online,
  no snapshot applied yet), Synchronizuje (while it answers "Synchronizovať teraz", 6.27). The list refreshes itself every 30 seconds while the page is open.
- Each computer has its own token for this one shop, stored by Cacaduu only as a hash; Cacaduu never asks for POS
  passwords or settings. Wrong codes are limited (5 per 15 minutes per caller).
- Stock from the agent: phase B (6.26). Sync Now: phase C (6.27).

### 6.25 Contact buttons on the shop page (database update 51, 28 October 2026)

- Under "Vybavenie" the shop's contacts are buttons in two columns, in this order: Facebook · Rezervovať termín / Web ·
  e-mail / Navigovať · phone. A button whose link or value is empty is not shown; the rest move up.
- **Press and hold** (1.2 s): a quick tap does nothing. While held: "Držte stlačené" and a bar filling from the left;
  letting go early or sliding off empties it and nothing happens. When full: the link opens (Facebook, web, booking and
  directions in a new tab on a computer and in the same tab on a phone — the back button returns —, e-mail → mail app,
  phone → call), the button says Otvorené / Rezervácie otvorené / Navigujem /
  Volám with an orange check, then goes back after ~2 s. Screen readers hear "<button>: <result>".
- Navigovať leads to the shop's map position (exact); a shop without one is navigated to its written address.
- Each button has its own colour (Facebook blue, booking orange, web purple, e-mail teal, navigation amber, phone
  green), pale background and border, no shadows; the label is never cut or wrapped (a long one gets a smaller size).
- Môj obchod → "Údaje obchodu": "Tlačidlo na stránke: Krátke / Dlhé" next to each contact field. Short = one column,
  long = the whole row; defaults: e-mail long, the rest short. Saved with the shop's details; the page shows it at once.
- Without JavaScript the page shows the same contacts as plain links.

### 6.26 POS Sync Agent: inventory snapshots and one stock source (database update 52, Prompt 13 phase B)

- Môj obchod → Priečinok s exportom starts with **"Zdroj zásob"**: *Súbory – priečinok so skladom alebo ručné nahratie*
  (default) or *POS agent – aplikácia na počítači pri pokladni* (only with a paired, not disconnected agent). One source
  at a time, so two sources never overwrite each other. A connected inventory program (update 49) always wins and is
  only named there. While the POS agent is the source, the folder window and "Nahrať súbor" say that the stock comes
  from the POS agent and refuse files; switching back to files is one click.
- The agent sends the shop's **whole** stock (a snapshot: code, name, EAN, brand, price, currency, quantity) as a
  gzipped file straight to private storage, then asks Cacaduu to check it. Cacaduu never asks for POS passwords; any
  field outside the list (purchase price, supplier, margin, …) is dropped and never stored.
- Checks: the announced count and SHA-256 must match the file; > 5 % invalid rows → the whole snapshot is refused and
  the old stock stays; ≤ 5 % → those rows are skipped and listed, and those products keep their previous stock. A
  product missing from a snapshot is set to 0, as with files. Older than the last applied snapshot → refused. At most
  one full snapshot per 5 minutes per shop.
- **Never automatic:** a snapshot with 0 products, or fewer than half of the last applied count, waits as "Čaká na vaše
  rozhodnutie" ("Nový stav má výrazne menej produktov (1 namiesto 3). Môže ísť o chybu pri čítaní pokladne.") with
  **"Áno, použiť tento stav"** / **"Zahodiť"**.
- While the source is still "Súbory", snapshots are checked and listed as "Skontrolované, nepoužité – zdroj zásob nie je
  POS agent" (a safe test before switching).
- Unchanged stock: the agent only confirms the same content hash; the freshness time moves forward, nothing else.
- "Posledné stavy skladu z POS agenta" (last 10): state, time of the POS read, the computer, counts (products, written,
  set to 0, skipped) and the reason of a refusal in plain words. Each applied snapshot is also a "Posledné nahrané
  súbory" report ("POS agent · <computer>") and refreshes the public pages at once (and IndexNow).
- Sync Now: phase C (6.27). Tested with the test stand-in (`scripts/connector-test-agent.mjs snapshot` / `confirm`),
  not yet with the real desktop agent.

### 6.27 POS Sync Agent: "Synchronizovať teraz" (database update 53, Prompt 13 phase C)

- Môj obchod → Priečinok s exportom → "Prepojenie s pokladňou (POS agent)" → box **"Synchronizovať teraz"** (shown when
  an agent is paired). The button works only while "Zdroj zásob" is the POS agent; otherwise the box says so.
- Pressing it asks the agent to read the till now. The cloud never connects to the shop's computer: the agent sees the
  request the next time it checks in (it checks every minute, every 15 s while a request waits) — "POS agent prečíta
  pokladňu hneď, ako sa nabudúce ozve – zvyčajne do minúty."
- "Posledná požiadavka" shows what happened, refreshed every 5 s while it waits: Čaká na agenta… → "<počítač> číta
  pokladňu…" → **Hotovo – nový stav skladu prijatý** / **Hotovo – sklad sa nezmenil** / **Nepodarilo sa: <the
  agent's reason>** / "Nepodarilo sa – agent neodpovedal ani na tretí pokus." / **"Agent je offline – zapnite počítač s
  POS agentom."** (nobody picked it up within 10 minutes). The device list shows "Synchronizuje" meanwhile.
- One request at a time (pressing again while it waits changes nothing); at most 4 an hour per shop ("Najviac 4
  synchronizácie za hodinu – skúste neskôr.").
- The answer is an ordinary snapshot (6.26: every check, the held rule and the stock source still apply) or "unchanged";
  it may come sooner than the usual one snapshot per 5 minutes.
- Only two kinds of request exist (read the stock, ping); the cloud never sends programs, file paths or POS settings.
- Tested with the test stand-in (`scripts/connector-test-agent.mjs sync`), not yet with the real desktop agent.

### 6.28 Forgiving product search and the "Tovar v obchode" dropdown (database update 54)

(Since 29 October 2026 the shop page's dropdown is replaced by the live search of "Produkty", 6.29; the search rule
below is unchanged.)

- **Shop page, "Tovar v obchode":** the field "Hľadať v tomto obchode…". From 2 letters, a moment after the last key,
  a list under the field (full width on a phone) shows up to 8 products: the name in the page language with the shop's
  name under it, the price with the stock dot, the availability in bold and the category; the searched words are in
  bold. ↑ ↓ choose, Enter opens the chosen product, Enter on the field (or "Zobraziť všetky výsledky (N)") filters the
  whole list — "Výsledky pre „…“ (N)" with "Zrušiť". Esc closes the list. Only the newest answer is ever shown. Without
  JavaScript the field is a plain form that reloads the page with the results.
- **What it finds:** exact matches first (the shop's code or the EAN typed exactly, then every word), then close ones:
  any word order; every language the item's name is known in (Slovak, Hungarian, English, …); accents and capitals
  ignored; typos ("akrylvé farby", "mercedez 775"); word endings ("akrylové" = "akryl" = "acrylic"); sizes ("0,5 l" =
  "500 ml" — the same size ranks higher, another size is still shown); general words such as "farba", "paint",
  "festék" count less than the product's own words. Every product word must match (one may be missing from a long
  search), so "white chocolate" never shows a white paint. Nothing close → "Nenašli sme presnú zhodu – podobné
  produkty:" with the most similar names. A search that still finds little is tried once more in Claude's words
  (cached 30 days).
- **Main search, API, MCP, the chat and the shop assistant use the same rule.** A town written in the search ("farba
  v Budinciach") limits the results to that town's shops; the visitor's location is never used. Order: how well the
  product matches, then in stock with current data, then fresher, then nearer (only when a place was given) —
  **a paid plan never changes the order.**
- Speed: suggestions in under 150 ms for a shop with 5 000 products, the main search under 300 ms for 100 000.
- At most 120 suggestions a minute per visitor (then a short pause).

### 6.29 Shop page "Produkty / Zoznam" and the stock sentence only on product pages (29 October 2026)

- **The stock sentence** ("12 ks na sklade", "Vypredané", "Informácia o zásobe momentálne nie je dostupná") is shown
  only on a product's own page. Every list of products — the shop page, the main page's results and chat cards, the
  product page's other shops, the shop assistant's cards and its copied list — shows only the stock dot (green in
  stock, red sold out, yellow no information or old data; a solid fill with a darker ring); screen readers hear the
  status from the dot ("na sklade", "vypredané", "zásoba neznáma"). The line about how fresh the shop's whole file is
  stays above the shop's products.
- **Two tabs** replace "Tovar v obchode": "Produkty" and "Zoznam" (the visitor's shopping list; its counter shows the
  pieces on the list). Keyboard: they are a radio group. Without JavaScript only Produkty shows, with the plain form.
- **Produkty:** "Hľadať v tomto obchode" filters the list while typing (the forgiving search of 6.28: accents, case,
  word order, several words, typos), the found words highlighted, × or Esc clears, "Nájdené: N produktov" or "Pre „…“
  sme nič nenašli". Each row: the name (a link to the product), the stock dot and the price as in the shop's file.
  Tapping the dot puts one piece on the list (a small blue ball jumps to the Zoznam tab; a counter on the dot, "9+"
  above nine).
- **Zoznam:** each product with quantity × price and − / quantity / + (a bin at one); swiping a row left or right
  removes it; "Spolu"; "Zoznam je prázdny". **"Kopírovať zoznam"** copies plain text with the shop's name and
  address (the address is not shown on the page), one line per product and the total; if the browser does not allow
  copying, the text is shown selected to copy by hand.
- The list is kept only in this browser, per shop (it survives a reload); nothing is sent to Cacaduu or the shop, and
  no shop data are changed. Changes are announced to screen readers in Slovak; with "reduce motion" nothing moves.
- Colours of this section (blue, orange, the yellow highlight) are an exception to "no colours", at the owner's
  request.

### 6.30 "Konverzácie" for Pro shops (database update 55, phase 1 of the CRM work, 30 October 2026)

- **Môj obchod → Asistent** has three tabs (plain links, they work without JavaScript; old addresses still open the
  right one): **Nastavenia** (button text, welcome), **Konverzácie** (with the number of new conversations on the tab)
  and **Súkromné priečinky**. Only the open tab's data are loaded.
- **Every conversation is kept** (messages with their times, the shopper's language, the products the assistant
  suggested, the shopper's files) with: a status **Nové / Prečítané / Archivované** (a new message makes it "Nové"
  again; opening it marks it read), a **star**, the owner's **private note** (≤ 2000 characters, never shown to the
  shopper) and two marks: **"Bez odpovede"** (the assistant could not answer and pointed to the shop) and
  **"Prístupový kľúč"** (the shopper had folders open with an access key). Conversations from before the update count
  as read and their marks are "unknown".
- **List:** newest first, 20 per page; search words (any message, its Slovak version, the note; accents ignored), days
  Od / Do (the shop's time zone), status (default "Nové a prečítané"; also Archivované or Všetky), "Len s
  hviezdičkou", "Len bez odpovede", "Len so súbormi", language. Each row: date, status in words (new ones in bold),
  language, messages, files, the marks, "Navrhnuté produkty: N", ☆/★, "Stiahnuť PDF".
- **Bulk actions** on the ticked rows: Označiť ako prečítané / nové, hviezdička on / off, Archivovať (Vrátiť z
  archívu in the archive), **Vymazať vybrané** only after "Áno, vymazať vybrané konverzácie aj so súbormi a PDF" (at
  most 100 at once). "Stiahnuť vybrané" downloads the ticked ones as PDFs.
- **Detail:** read-only transcript with times, the Slovak version, the shopper's pictures inline (files through
  10-minute links), the product cards (a link to the product while it is still offered, "už nie je v ponuke"
  otherwise), "Asistent nevedel odpovedať" under such an answer; status, marks, Označiť ako nové / hviezdička /
  archivovať, the private note, **Stiahnuť PDF** (once finished) and **Stiahnuť TXT**; delete with a confirmation.
- **Export:** one conversation as PDF or TXT; a date range as **CSV** for Excel (UTF-8, ";", one row per message: the
  conversation, start, status, star, marks, language, time, who, text, Slovak version, files, products; at most
  50 000 rows; a cell that a spreadsheet would run as a formula is written as text).
- **Keep time:** "Neobmedzene" (default; shops still on the old default of 90 days get it) or 30 / 90 / 365 days.
- **Log:** keep time, marks (not the automatic "read" when opening), notes, deletions and exports go into the shop's
  activity log (`shop_activity`). Only the shop's members see or change anything (RLS and the owner functions);
  visitors never.

### 6.31 "Kontakty" for Pro shops (database update 56, phase 2 of the CRM work, 30 October 2026)

- **Môj obchod → Kontakty** (a new menu page): the shop's contacts, last changed first, with a search (name, phone,
  e-mail, address, tags, note; a number also as typed with spaces), a tag filter, "Nový kontakt", and a second tab
  **"E-mailové šablóny"**.
- **A contact:** name, **phone** (typed in any common way, kept in international form with the shop's country code —
  "0905 123 456" in a Slovak shop is "+421905123456"; one contact per number), e-mail, address, tags (comma separated),
  a private note. **"overené"** only when the customer confirmed the number with an SMS code (the booking, phase 3); a
  changed number is no longer "overené". At least a name, a phone or an e-mail.
- **Conversations and bookings join a contact by the phone** (a conversation with the customer's number — from a booking
  or a number left in the chat, phases 3 and 5 — joins the contact with that number), or the owner assigns one on the
  conversation's page ("Priradiť ku kontaktu", "Nový kontakt z tejto konverzácie").
- **Contact card tabs:** Prehľad (the details to edit, delete with a confirmation — conversations and the log stay),
  Konverzácie, Rezervácie (filled in phase 3), Správy.
- **Správy:** SMS or e-mail; an e-mail template copies its subject and text in to edit; the variables {{name}},
  {{first_name}}, {{shop}}, {{shop_phone}}, {{shop_email}}, {{shop_address}}, {{shop_web}}; the SMS length in parts
  (accents make an SMS shorter: 70 characters instead of 160). **"Náhľad" shows the message exactly as it will go**
  (variables filled in); only then "Odoslať". E-mails go out with the shop's name and replies come to the shop's e-mail.
  **SMS are only written down ("test – neodoslané") until the SMS provider and the monthly quotas of phase 4.** At most
  100 messages of each kind per shop and day.
- **Every outgoing message is written down** (to whom, the text as sent, sent / not sent / test, who sent it) and shown
  under "Odoslané správy". Saving, deleting, assigning and sending also go into the shop's activity log.
- Only the shop's owners see or change anything (RLS, owner functions); without the Pro plan the contacts stay readable,
  changes and messages are refused.
