# PPI — setup guide (copy & paste)

This guide connects the code in this repository to **your** Supabase project and **your** Vercel project.
Do the steps in order. It takes about 15 minutes. You only copy two values from Supabase; nothing secret.

> **Never copy the `service_role` key** (Supabase calls it "secret" in some screens) anywhere:
> not into Vercel, not into a file, not into chat. The web app does not need it.

---

## Part A — Supabase: create the database

### A1. Open the SQL Editor

Supabase dashboard → your project → left menu **SQL Editor** → **+ New query** (a blank page opens).

### A2. Run the migration files, one at a time, in this order

For **each** file below:

1. Open the file on GitHub (repository `novidave/cacadoo-ppi`, branch `claude/wonderful-tesla-41hwmj`, or `main` once merged).
2. Click the **Copy raw file** button (two-squares icon, top right of the file).
3. In the Supabase SQL Editor, select everything in the query box (Ctrl+A / Cmd+A), paste (Ctrl+V / Cmd+V).
4. Click **Run** (bottom right, or Ctrl+Enter).
5. You should see **"Success. No rows returned"**. Then do the next file in a new query.

| # | File | What it does |
|---|------|--------------|
| 1 | `supabase/migrations/20261001000001_extensions.sql` | Turns on PostGIS (map), unaccent and pg_trgm (search) |
| 2 | `supabase/migrations/20261001000002_tables.sql` | Creates the 8 tables |
| 3 | `supabase/migrations/20261001000003_auth_helpers.sql` | Login profiles, admin/owner checks, protection rules |
| 4 | `supabase/migrations/20261001000004_rls.sql` | Row Level Security: who may see and change what |
| 5 | `supabase/migrations/20261001000005_stock_logic.sql` | Freshness, availability labels, `public_stock` view, `search_stock` search |
| 6 | `supabase/migrations/20261003000001_europe_wide.sql` | Europe-wide: shop country + time zone, search with or without a location |
| 7 | `supabase/migrations/20261004000001_public_pages.sql` | Shop and item pages: `public_shops` view, `shop_stock` item list |
| 8 | `supabase/migrations/20261005000001_dashboard_admin.sql` | Owner dashboard + admin: item list, admin functions, logo storage |
| 9 | `supabase/migrations/20261006000001_amenities.sql` | Shop facilities: customer toilet, douchette, card terminal |
| 10 | `supabase/migrations/20261007000001_ai_access.sql` | AI access: API/MCP rate limit + usage log, town lookup |
| 11 | `supabase/migrations/20261008000001_stock_pull.sql` | Stock pull: apply a stock file, file-access credentials in Vault, raw-file storage |
| 12 | `supabase/migrations/20261009000001_folder_upload.sql` | Folder upload: shop PC check-in, last uploaded file |
| 13 | `supabase/migrations/20261010000001_self_service.sql` | Self-service: owners create shops and approve their file's columns |
| 14 | `supabase/migrations/20261011000001_search_shop_name.sql` | Search also by shop name, street and town |
| 15 | `supabase/migrations/20261012000001_cloud_link.sql` | Cloud file links (taken out again by file 16) |
| 16 | `supabase/migrations/20261013000001_remove_cloud_link.sql` | Upload only: removes the cloud file links and stops the old 15-minute download schedule |
| 17 | `supabase/migrations/20261014000001_item_translations.sql` | Item names in Slovak, Hungarian and English, search across languages, AI search limits |
| 18 | `supabase/migrations/20261015000001_subscriptions.sql` | Paid plan per shop (Stripe): subscriptions, `shop_has_plan` |
| 19 | `supabase/migrations/20261016000001_shop_assistant.sql` | AI assistant on the shop page: message limits |
| 20 | `supabase/migrations/20261017000001_shop_documents.sql` | Documents and pictures for the assistant: folders, access keys, private file storage |
| 21 | `supabase/migrations/20261018000001_shop_page_updates.sql` | One display rule for every shop (quantity as in the file), shop e-mail and Facebook page, the assistant's own texts, stock file reports, private columns |

> **Already ran some files earlier?** Run only the newer ones, in order. Re-run the test data (A3) after file 6.

**If something goes wrong**

- *"extension … permission denied"* in file 1: go to **Database → Extensions**, switch on `postgis`, `unaccent` and `pg_trgm`, then run file 1 again.
- *"relation … already exists"*: that file was already run. Go on with the next one.
- Any other red error: stop, copy the error text and send it to Claude Code. Do not run the next file.

### A3. Add test data

Same way, copy and run **`supabase/seed.sql`**. It creates 4 test shops in two countries with 19 items:

| Test shop | Stock file age | What the site must show |
|-----------|----------------|-------------------------|
| Potraviny Centrum | 10 min | "14 ks na sklade" / "Vypredané" + "Aktualizované pred 10 min" |
| Drogéria Kostolné | 3 hours | Exact count, e.g. "5 ks na sklade" + "Naposledy potvrdené dnes o …" |
| Železiarstvo Východ | 25 hours | **No stock status**, only "Informácia o zásobe momentálne nie je dostupná" |
| Kisbolt Budapest (HU, forints) | 5 min | Prices like **1890 Ft**, times in Budapest time |

The ages are counted from the moment you run the file. Run it again any time to reset them.
**Before launch**, delete the test shops (Part D).

### A4. Check the database works

In a new SQL Editor query, paste and run:

```sql
select item_name, shop_name, availability, freshness_state
from search_stock('kava');
```

Expected: **4 rows** — three "Káva …" items and "Kávovar prekvapkávací". The Kávovar row has an empty
`availability` and `stale` freshness. If you see that, the database is done.

### A5. Copy the two public values

Supabase → **Project Settings** (gear icon, bottom left):

| Copy this | Where in Supabase | You will paste it as |
|-----------|-------------------|----------------------|
| **Project URL** (looks like `https://abcdefgh.supabase.co`) | **Data API** (or **API**) page | `NEXT_PUBLIC_SUPABASE_URL` |
| **anon public** key (long text starting `eyJ…`), or the **publishable** key (`sb_publishable_…`) | **API Keys** page | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |

Keep this tab open for Part B.

### A6. Login links (needed from phase 4, set it now)

Supabase → **Authentication** → **URL Configuration**:

- **Site URL**: the site's main address, `https://cacaduu.com` (before the own domain: the Vercel production address
  `https://cacadooppivercel.vercel.app`, from Part B)
- **Redirect URLs** → **Add URL**, add each of these:
  - `http://localhost:3000/**`
  - `https://cacaduu.com/**` (the main domain)
  - `https://cacadooppivercel.vercel.app/**` (your real Vercel address, until it redirects to cacaduu.com)
  - `https://*-YOUR-VERCEL-TEAM.vercel.app/**` (so preview links can log in too; copy the team part from any preview URL)

---

## Part B — Vercel: publish the website

### B1. Add the environment variables

Vercel → your project → **Settings** → **Environment Variables**. Add these three
(for each: type the **Key**, paste the **Value**, leave all environments ticked — Production, Preview, Development — then **Save**):

| Key | Value |
|-----|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | the Project URL from A5 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the anon / publishable key from A5 |
| `NEXT_PUBLIC_SITE_URL` | the main address `https://cacaduu.com` (no `/` at the end; before the own domain the Vercel address) |

If you connected Supabase through Vercel's **Integrations / Marketplace**, the first two may already exist —
check the names match exactly. Do **not** add `SUPABASE_SERVICE_ROLE_KEY`; if the integration added it, delete it.

### B2. Check the build settings

Vercel → **Settings** → **Build and Deployment**: Framework Preset **Next.js**, Root Directory **empty**.
Leave everything else on default.

### B3. Deploy

Environment variables only apply to new deployments:

- Vercel → **Deployments** → newest deployment of branch `claude/wonderful-tesla-41hwmj` → **⋯** → **Redeploy**.
- That gives a **preview link**. Production (`main`) is updated when the branch is merged into `main` on GitHub
  (open a pull request and merge it once the checks below pass).

### B4. Check the website

Open the preview link and check:

- [ ] The address changes to `/sk` and the page is plain white with "PPI" and **SK · HU · EN** at the top.
- [ ] Below the search box: **"Približná poloha: <your city>"** (or "Poloha neznáma – hľadá sa vo všetkých obchodoch") and a **Použiť … polohu** link.
- [ ] Search **kava** → 4 results; "Káva mletá 250 g" says **2 ks na sklade · Aktualizované pred 10 min**.
  The test shops are in Michalovce and Budapest, and the site now searches around **your** location.
  If you are elsewhere, test with this address, which pretends you are in Michalovce:
  `/sk?q=kava&lat=48.755&lng=21.918`
- [ ] "Kávovar prekvapkávací" shows only **Informácia o zásobe momentálne nie je dostupná**.
- [ ] Tick **Len dostupné teraz** and search again → Kávovar disappears.
- [ ] Click **EN** → same results in English, prices like **€4.49**. Click **HU** → Hungarian.
- [ ] Search **xyz** → "Žiadny obchod … to teraz nemá."
- [ ] Open `/hu?q=kave&lat=47.498&lng=19.04` (pretends you are in Budapest) → **Kávé őrölt 250 g · 1890 Ft · Kisbolt Budapest · 1,6 km**.
- [ ] Tap **Použiť moju polohu** on your phone and allow it → results show distances from where you are.
- [ ] Results show a **black-and-white map** with a black dot per shop (beside the list on a computer, above it on a phone). Tapping a dot marks that shop's results.
- [ ] Each result shows **Otvorené / Zatvorené** with the next opening or closing time.
- [ ] Tap a shop name → **shop page**: address, opening hours for the week, "Navigovať" (opens Google Maps), map, searchable item list.
- [ ] Tap an item → **item page**: price, stock, shop card, and **Dostupné aj v** (Zubná pasta → Kisbolt Budapest in Ft).
- [ ] AI check: right-click a shop page → **View page source** → search `application/ld+json` → you see the shop's address and opening hours. On the Kávovar item page (stale) the same block has **no** `offers` (no price/availability).

If the page says *"Databáza ešte nie je pripojená"*, the variables from B1 are missing or misspelled, or you did not redeploy.

---

## Part C — (optional, recommended later) Supabase CLI instead of copy-paste

Copy-paste is fine to start. When you have a second (test) Supabase project, use the CLI so both stay identical.
On your computer, in a clone of this repository:

```bash
npx supabase login                       # opens the browser once
npx supabase link --project-ref YOUR-PROJECT-REF   # the "abcdefgh" part of your Project URL
npx supabase db push                     # applies any migrations not yet applied
```

If you already applied the migrations by copy-paste, tell the CLI once that they are done:

```bash
npx supabase migration repair --status applied 20261001000001 20261001000002 20261001000003 20261001000004 20261001000005 20261003000001 20261004000001 20261005000001 20261006000001 20261007000001 20261008000001 20261009000001 20261010000001 20261011000001 20261012000001 20261013000001 20261014000001 20261015000001 20261016000001
```

---

## Part E — Self-service sign-up and login (shop owners only)

Shop owners sign up, create their shop and connect their stock **by themselves**. There is no admin area for shops on
the website (the only operator page is "Predplatné a domény" for own domains, Part R); if you ever need to look at or
fix something, use the Supabase dashboard (Table Editor / SQL Editor).

### E1. Allow sign-ups with a password (once)

Supabase → **Authentication** → **Sign In / Providers** → **Email**:

- **Enable Email provider**: on
- **Allow new users to sign up**: **on**
- **Confirm email**: **on** (new owners must click the link in their e-mail)
- **Minimum password length**: `8`
- **Save**

### E2. E-mail server (SMTP) — required for sign-up and "forgot password"

Supabase's built-in e-mail **only delivers to members of your Supabase team**, a few per hour. Shop owners would
never get their confirmation or password-reset e-mail. Connect a real e-mail service.
Example with **Brevo** (free: 300 e-mails/day, no own domain needed):

1. Create a free account at brevo.com.
2. Brevo → **Senders, Domains & Dedicated IPs** → **Senders** → **Add a sender**: your e-mail
   (e.g. your Gmail) → confirm the code Brevo e-mails you.
3. Brevo → **SMTP & API** → **SMTP** tab → **Generate a new SMTP key** → copy it (shown once).
   On the same page note the **Login** (looks like `xxxxxx@smtp-brevo.com`).
4. Supabase → **Authentication** → **Emails** → **SMTP Settings** → **Enable custom SMTP**:

| Field | Value |
|---|---|
| Sender email | the sender you confirmed in step 2 |
| Sender name | `PPI` |
| Host | `smtp-relay.brevo.com` |
| Port | `587` |
| Username | the Brevo SMTP **Login** from step 3 |
| Password | the Brevo **SMTP key** from step 3 |

5. **Save**. Keep the SMTP key only in Supabase and your password manager.
6. Supabase → **Authentication** → **Rate Limits** → **Rate limit for sending emails**: raise it to e.g. `100` per hour.

E-mails from a Gmail address sent through Brevo may land in spam at first; once PPI has its own domain,
add that domain in Brevo (Senders, Domains → Domains) and send from e.g. `info@yourdomain`.

### E3. E-mail templates (recommended, after E2)

With Supabase's default templates the links work only in the **same browser** where the owner signed up or asked
for a new password. These two templates make them work on any device (e.g. opened on the phone).
Supabase → **Authentication** → **Emails** → **Templates**: delete the body and paste:

**Confirm signup** — body:

```html
<h2>PPI</h2>
<p>Potvrďte svoj e-mail / Erősítse meg e-mail-címét / Confirm your e-mail:</p>
<p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/dashboard">Potvrdiť / Megerősítés / Confirm</a></p>
```

**Reset Password** — body:

```html
<h2>PPI</h2>
<p>Nové heslo / Új jelszó / New password:</p>
<p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/password">Nastaviť nové heslo / Új jelszó beállítása / Set a new password</a></p>
<p>Ak ste o to nežiadali, tento e-mail ignorujte.</p>
```

Check **Authentication → URL Configuration → Site URL** is `https://cacaduu.com` (A6).

### E4. Check

- [ ] `/sk/signup` → e-mail you can read + password twice → "Takmer hotovo…" → open the e-mail → you land in **Môj obchod**.
- [ ] "Pridajte svoj obchod": name, town, country, time zone, click the map → **Vytvoriť obchod** → "Obchod je vytvorený".
- [ ] **Zobraziť stránku obchodu** shows the shop's public page.
- [ ] **Odhlásiť sa** → `/sk/login` with the password → back in **Môj obchod**.
- [ ] `/sk/forgot` → e-mail → open the link → **Zmena hesla** → new password → log in with it.
- [ ] A second account cannot see or change the first account's shop.

Accounts created earlier (e.g. your own from the old magic-link login) have no password yet: use **Zabudli ste heslo?** once.

---

## Part F — AI access (phase 5)

Nothing to configure: no keys, no accounts. After the database update (file 10) and the merge, check:

- [ ] `https://cacaduu.com/robots.txt` — allows all crawlers incl. GPTBot, ClaudeBot, PerplexityBot; blocks the login-only pages.
- [ ] `https://cacaduu.com/sitemap.xml` — every active shop and item (refreshed hourly).
- [ ] `https://cacaduu.com/llms.txt` — plain-text guide for AI, lists the shops.
- [ ] `https://cacaduu.com/api/v1/search?q=kava&near=Michalovce` — JSON results with price, availability, freshness and `source_url`.
- [ ] `https://cacaduu.com/api/openapi.json` — the API description.

**Connect an AI assistant to PPI (MCP):**

- **Claude** (claude.ai): **Settings → Connectors → Add custom connector** → name `PPI`, URL
  `https://cacaduu.com/mcp` → **Add**. In a new chat, ask:
  *"Using PPI, who has coffee (káva) in Michalovce right now, and when was it last updated?"*
- **ChatGPT**: in **Settings → Apps & Connectors** (developer mode may need to be switched on under
  **Advanced**) → **Create** → MCP server URL `https://cacaduu.com/mcp`, no authentication.
- Other MCP tools (Cursor, VS Code, Claude Desktop…): add a remote / Streamable HTTP server with the same URL.

The API and MCP server are read-only, need no login and allow 60 requests per minute per caller.
Each request is logged in `api_usage` with only a daily-changing hash of the caller's IP (no IP address stored).

---

## Part G — Stock function and AI field mapping (phase 6)

The `stock-pull` function receives each shop's stock file (uploaded by the PPI app window on the shop PC or with
"Upload file"), proposes a field mapping for a new file layout (the shop owner approves it once), and updates the
stock. It downloads nothing and runs on no schedule. Steps, once:

### G1. Database update

Run file 11 (or the `PPI_update_7_stock_pull.sql` file) in the SQL Editor.

### G2. Secret for the function (optional)

Supabase → **Edge Functions** → **Secrets** (or *Manage secrets*) → add:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | *optional* — an API key from console.anthropic.com. With it, Claude proposes the field mappings and translates item names into Slovak, Hungarian and English; without it, a simple rule-based guess is proposed and names stay untranslated. The shop owner approves the columns either way. |

### G3. Deploy the function

1. Supabase → **Edge Functions** → **Deploy a new function** → **Via Editor** → name **`stock-pull`**.
2. Paste the whole file `supabase/functions/stock-pull/index.ts` → **Deploy function**.
3. Open the function → **Details** (or Settings) → switch **off** "Verify JWT" / "Enforce JWT verification" → **Save**.
   (The function checks its callers itself: only the shop owner's login is accepted.)

### G4. Test

Test it as a shop owner: Part H, step 5.

---

## Part H — Self-service and the shop PC (phase 7)

1. **Database:** SQL Editor → run file 12 (`supabase/migrations/20261009000001_folder_upload.sql`) if not done yet,
   then file 13 (`supabase/migrations/20261010000001_self_service.sql`) and file 14
   (`supabase/migrations/20261011000001_search_shop_name.sql`).
2. **Function:** Supabase → **Edge Functions** → `stock-pull` → **Code** → replace everything with the new
   `supabase/functions/stock-pull/index.ts` (GitHub → the file → **Copy raw file**) → **Deploy**. Keep **Verify JWT** off.
3. **Old function:** Edge Functions → `invite-owner` → delete it (owners sign up themselves now).
4. **Sign-up and e-mail:** Part E (E1–E3).
5. **Try it as a shop owner** (on your own Windows PC, in Edge or Chrome): sign up → create a test shop →
   in **Priečinok s exportom** connect a folder with the sample file `/samples/stock-sample.csv` saved as `stock.csv` →
   after a minute "Súbor prijatý" → **Môj obchod → Stĺpce súboru so zásobami** → **Schváliť stĺpce** → "Zásoby odoslané".

What a shop owner does is written for them on the dashboard; the longer guide is `docs/SHOP_PC_SETUP.md`.

---

## Part I — Get found by search engines and AI assistants (Grok, ChatGPT, Perplexity…)

AI assistants answer from web search. A new site on `*.vercel.app` is not in their search index yet, so they
cannot find a new shop by name until it is indexed. Tell the search engines about PPI once:

1. **Bing** (used by ChatGPT, Copilot and others): bing.com/webmasters → sign in → **Add site**
   `https://cacaduu.com` → method **HTML Meta Tag** → copy only the `content="…"` value.
   Vercel → Project → **Settings → Environment Variables** → add `BING_SITE_VERIFICATION` = that value
   (Production) → **Redeploy** → back in Bing → **Verify** → **Sitemaps** → submit
   `https://cacaduu.com/sitemap.xml`.
2. **Google**: search.google.com/search-console → **Add property** → **URL prefix**
   `https://cacaduu.com` → **HTML tag** → copy the `content="…"` value → Vercel variable
   `GOOGLE_SITE_VERIFICATION` → **Redeploy** → **Verify** → **Sitemaps** → submit `sitemap.xml`.

Indexing takes days to a few weeks. Until then an assistant finds a shop when you give it the page address
(e.g. `https://cacaduu.com/sk/shops/<shop>`), and Claude finds everything at once through the
MCP connector (Part F). A short own domain (e.g. ppi.sk) instead of `*.vercel.app` helps too.

---

## Part J — Item names in three languages and AI search (8 October 2026)

1. **Function first:** Supabase → **Edge Functions** → `stock-pull` → **Code** → replace everything with the new
   `supabase/functions/stock-pull/index.ts` → **Deploy**. Keep **Verify JWT** off.
2. **Database:** SQL Editor → run file 17 (`supabase/migrations/20261014000001_item_translations.sql`) →
   "Success. No rows returned".
3. **Translations:** Supabase → **Edge Functions** → **Secrets**: `ANTHROPIC_API_KEY` must be there (part G2). Each
   shop's names are translated with its next new stock file; to start at once, send a file with **Nahrať súbor**.
4. **AI search:** Vercel → Project → **Settings → Environment Variables** → add `ANTHROPIC_API_KEY` (an Anthropic key;
   a separate key from the Supabase one is fine) and, optionally, `AI_DAILY_LIMIT` (AI searches per day for the whole
   site, default 500) for Production → **Redeploy**. Without the key the main page's chat answers with the plain
   search (Part AD).
5. **Check:** search "white paint" on `/en` for an item named in Slovak (after its translation); ask on `/sk` a
   question such as "čo potrebujem na tečúcu rúru" — an answer appears within a few seconds (Part AD). "Zobrazujem
   jednoduché výsledky vyhľadávania." instead: log in (Môj obchod) and try again — a note says why (only logged-in
   owners see it); or Vercel → **Logs** → search `ai-search`.

Never put the Anthropic key in a `NEXT_PUBLIC_…` variable or in the repository.

---

## Part K — Paid plan with Stripe, test mode first (8 October 2026)

One monthly subscription per shop. Stripe's keys live only in Supabase (function secrets); Vercel needs nothing new.
You need a Stripe account and your Supabase project's **Reference ID** (Supabase → Project Settings → General; it is the
`xxxx` in `https://xxxx.supabase.co`). Menu names in Stripe change now and then: if one is not where it says, type it
into the search box at the top of the Stripe Dashboard.

### K1. Supabase: database and the two functions

1. SQL Editor → run file 18 (`supabase/migrations/20261015000001_subscriptions.sql`) → "Success. No rows returned"
   (a notice "policy … does not exist, skipping" on the first run is normal). Safe to run again.
2. Edge Functions → **Deploy a new function** → **Via Editor** → name **`stripe-checkout`** → paste the whole
   `supabase/functions/stripe-checkout/index.ts` → **Deploy** → open the function → switch **off** "Verify JWT" → Save.
3. The same for **`stripe-webhook`** with `supabase/functions/stripe-webhook/index.ts` → "Verify JWT" **off** (Stripe
   signs its calls instead of logging in).

### K2. Stripe, in test mode

Switch the Stripe Dashboard to **test mode** (the "Test mode" switch, or a Sandbox). Keys in test mode start with
`sk_test_`; nothing is charged.

1. **Product and price:** Product catalog → **Add product** → name "PPI Pro" → **Recurring**, **Monthly**, the price in
   EUR → "Include tax in price": **No** (VAT is added on top; choose Yes if your price already includes VAT) → Save →
   open the price → copy its ID (`price_…`).
2. **Stripe Tax:** Tax (or Settings → Tax) → set up: your business address (origin), default product tax code
   "Software as a service (SaaS) – business use", default tax behaviour as in step 1 → **Registrations** → add your
   country's VAT registration. Stripe adds VAT only where you are registered; ask your accountant about other EU
   countries (OSS).
3. **Invoice details:** Settings → Business: company name and address. Settings → Billing → **Invoice template**: your
   VAT ID (IČ DPH) and company ID (IČO), so they are on every invoice. Settings → Billing → **Subscriptions and
   emails**: "Email finalized invoices to customers" on.
4. **Customer portal:** Settings → Billing → **Customer portal**: invoice history on; customer information (name,
   billing address, tax ID) on; payment methods on; **cancel subscriptions** on, "at the end of the billing period" →
   **Save** (without saving once, "Manage subscription" shows a Stripe error).
5. **Webhook:** Developers → **Webhooks** → **Add endpoint** (newer dashboards: Add destination → Webhook endpoint) →
   URL `https://<Reference ID>.supabase.co/functions/v1/stripe-webhook` → events `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`,
   `customer.subscription.paused`, `customer.subscription.resumed` → create → **Signing secret** → Reveal → copy
   (`whsec_…`).
6. **API key:** Developers → **API keys** → Secret key → Reveal → copy (`sk_test_…`).

### K3. Supabase: the three Stripe secrets

Edge Functions → **Secrets** → add:

| Name | Value |
| --- | --- |
| `STRIPE_SECRET_KEY` | the secret key from K2.6 (`sk_test_…`) |
| `STRIPE_PRICE_PRO` | the price ID from K2.1 (`price_…`) |
| `STRIPE_WEBHOOK_SECRET` | the signing secret from K2.5 (`whsec_…`) |

Never put them in Vercel, the repository or a chat.

### K4. Publish and test

1. GitHub → merge the pull request; Vercel publishes the website.
2. Log in → **Môj obchod** → section **Plán**: "Aktuálny plán: Zadarmo". Fill in the IČO under **Údaje obchodu** first
   (then it is on the first invoice too) → **Prejsť na Pro**.
3. On Stripe's test page: card `4242 4242 4242 4242`, any future date, any CVC; company name, address, VAT number
   (optional), IČO (pre-filled) → subscribe.
4. Back on the dashboard: "Ďakujeme! Tento obchod má teraz plán Pro." and "Obnoví sa <date>". If it still says
   Zadarmo, wait a few seconds and reload.
5. Stripe → Customers: the customer with the company name; its invoice with VAT and the IČO. Stripe → Webhooks → the
   endpoint: deliveries answered with 200.
6. **Spravovať predplatné** → Stripe's portal → cancel → back on the dashboard: "Skončí <date>".
7. If something fails, the Plan section says why ("Stripe sa nepodarilo otvoriť: …"); Supabase → Edge Functions →
   `stripe-webhook` / `stripe-checkout` → Logs show each call.

### K5. Later: switch to live

Repeat K2 in live mode (product and price, Stripe Tax, invoice details, portal, webhook endpoint — the live endpoint
has its own `whsec_…`), then replace the three secrets with the live values. Test subscriptions do not carry over.

---

## Part L — AI assistant on the shop page (8 October 2026)

A paid feature: it appears on a shop's page only while the shop has the paid plan (Part K).

1. **Database:** SQL Editor → run file 19 (`supabase/migrations/20261016000001_shop_assistant.sql`) → "Success. No rows
   returned". Safe to run again.
2. **Vercel** (Settings → Environment Variables, Production): `ANTHROPIC_API_KEY` must be there (Part J) and the
   Anthropic account must have credit (console.anthropic.com → Billing). Optional: `CHAT_MONTHLY_LIMIT_PER_SHOP`
   (assistant messages per shop per month, default 1000; `0` switches the assistants off) → **Redeploy**.
3. **Test:** give a shop the paid plan (Part K4), open its public page → "Opýtajte sa asistenta obchodu" → ask about an
   item; ask for a shopping list ("Kopírovať zoznam", "Vytlačiť zoznam"); add a photo of a product label → it says what
   it read and whether the shop has it. A shop without the plan shows no assistant.
4. If it does not answer: log in (Môj obchod) and ask again — the chat shows the reason (only to logged-in owners);
   or Vercel → **Logs** → search `shop-chat`.

---

## Part M — Documents and pictures for the assistant (9 October 2026)

A paid feature (Part K): shop owners upload PDFs and pictures that their shop's assistant (Part L) uses to answer;
private folders open only with an access key. Needs Parts J, K and L first.

1. **Database:** SQL Editor → run file 20 (`supabase/migrations/20261017000001_shop_documents.sql`) → "Success. No rows
   returned" (notices "… does not exist, skipping" on the first run are normal). Safe to run again. It also creates the
   private storage bucket `shop-docs` (Storage → you see it there).
2. **Two new Edge Functions**, each: Edge Functions → **Deploy a new function** → **Via Editor** → type the name →
   in the editor **delete the example code** that is already there and paste the whole file → **Deploy** → open the
   function → switch **off** "Verify JWT" → Save.
   - **`doc-ingest`** ← `supabase/functions/doc-ingest/index.ts`
   - **`shop-files`** ← `supabase/functions/shop-files/index.ts`
3. **Supabase secrets** (Edge Functions → Secrets): `ANTHROPIC_API_KEY` is already there (Part G/J). Optional:
   `AI_MODEL` (default `claude-haiku-5-5`), `SHOP_DOCS_MAX_FILES` (30), `SHOP_DOCS_MAX_PAGES` (500),
   `SHOP_DOCS_MAX_PICTURES` (300) — limits per shop.
4. **Vercel** (Settings → Environment Variables, Production): add **`SESSION_COOKIE_SECRET`** = at least 32 random
   letters and digits (let your password manager generate 40 characters; keep it there; never paste it into a chat).
   Optional: `AI_MODEL` (same default). → **Redeploy**.
5. **Test** (a shop with the paid plan, logged in, Edge or Chrome):
   - Môj obchod → **Dokumenty pre asistenta** → tick the box → Súhlasím.
   - Create a private folder (e.g. "Veľkoobchod"). Upload a catalogue PDF into **Verejný** and a price list into the
     private folder. The status goes "Číta sa strana …" → "AI si prezerá obrázky…" → **Pripravené**.
   - Add a picture; open "Zmeniť alebo opraviť popis" and correct what the AI wrote.
   - Create a key for the private folder → **Kopírovať**. (It is shown only once.)
   - Open the shop page in a private/incognito window → the assistant → ask something the catalogue answers, e.g. in
     Italian → the answer is in Italian with "Zdroj: <catalogue>, strana …".
   - Ask about the price list → nothing from it. Click "Mám prístupový kľúč", paste the key → "Otvorené: Veľkoobchod" →
     ask again → the price list is now the source; "Znova zamknúť" closes it.
   - Delete a test document on the dashboard → it disappears with its pictures (Storage → shop-docs: its files are gone).
6. If something does not work: Supabase → Edge Functions → `doc-ingest` → **Logs** (lines start with `doc-ingest:`);
   Vercel → Logs → search `shop-chat` or `folder-key`.

---

## Part N — Shop page updates and "Môj obchod" as dropdowns (9 October 2026)

What changes: product pages of Pro shops no longer show other shops; shops get an e-mail and a Facebook link; Pro
shops can write the assistant's button text and welcome message; "Môj obchod" sections fold open and closed; under
"Export folder" you see the files of your private folders and the last 10 stock files; and **every shop shows the
quantity exactly as in its file** ("12 ks na sklade", "Vypredané" at 0) — the "What shoppers see" settings and the
Hide/Show buttons are gone. No new secrets or variables.

Do steps 1–3 **right after each other** (about 5 minutes): between step 1 and step 3 the old "Môj obchod" page shows a
database error; the public pages keep working.

1. **Database:** SQL Editor → run file 21 (`supabase/migrations/20261018000001_shop_page_updates.sql`) → "Success. No
   rows returned" (notices "… does not exist, skipping" are normal). Safe to run again.
2. **Two Edge Functions, new code** (the same way as before: open the function → Code → select all → paste the whole
   file → **Deploy**; "Verify JWT" stays **off**):
   - **`stock-pull`** ← `supabase/functions/stock-pull/index.ts`
   - **`doc-ingest`** ← `supabase/functions/doc-ingest/index.ts`
3. **Merge the pull request** on GitHub → Vercel deploys by itself (nothing to set in Vercel).
4. **Test:**
   - A product page of a Pro shop whose product other shops also have → no "Dostupné aj v" and no "V iných obchodoch
     sme tento výrobok nenašli."; the same product in a shop without the plan still shows "Dostupné aj v".
   - Môj obchod → **Údaje obchodu** → E-mail and Stránka na Facebooku (e.g. `facebook.com/vasobchod`) → Uložiť → the
     shop page shows both next to "Web"; a link that is not facebook.com / fb.com is refused.
   - Môj obchod → **Asistent obchodu** (Pro): type a button text and a welcome message → Uložiť → on the shop page the
     button has your text and the message shows when it opens. Clear both → the default text again.
   - "Môj obchod" on a phone: only "Priečinok s exportom" is open; open "Tovar", reload → it stays open.
   - "Upload file" (or wait for the PPI window) → **Posledné nahrané súbory** shows a card: file, time, imported,
     skipped, status OK; tap it → the full report. Columns you did not approve (e.g. purchase price) never appear.
   - **Súbory v súkromných priečinkoch:** your private PDFs and pictures with folder and "Prístupový kľúč:
     zapnutý/vypnutý"; **Otvoriť** opens the file in a new tab.
5. If something does not work: Supabase → Edge Functions → `stock-pull` or `doc-ingest` → **Logs**; Vercel → Logs.

---

## Part O — Assistant conversations: archive, files and a PDF per conversation (10 October 2026)

A paid feature (Part K) for shops with the assistant (Part L): every conversation is kept for the shop's owners with
its times, the item cards shown and the files the shopper sent (GPS removed), and becomes one PDF when it ends. Owners
read them in **Môj obchod → Konverzácie asistenta**. Do the steps in this order.

1. **Extensions:** Supabase → Database → **Extensions** → make sure **pg_cron** and **pg_net** are switched on (they
   probably are from Part G).
2. **Your project address in Vault** (once; safe to repeat): SQL Editor → paste, put your own address (the same as
   `NEXT_PUBLIC_SUPABASE_URL` in Vercel, e.g. `https://abcdefgh.supabase.co`) in both places → Run:

   ```sql
   do $$ begin
     if exists (select 1 from vault.secrets where name = 'ppi_project_url') then
       perform vault.update_secret((select id from vault.secrets where name = 'ppi_project_url'),
                                   'https://YOUR-PROJECT-ID.supabase.co');
     else
       perform vault.create_secret('https://YOUR-PROJECT-ID.supabase.co', 'ppi_project_url');
     end if;
   end $$;
   ```

3. **Database:** SQL Editor → paste the whole file `supabase/sql/22_assistant_archive.sql` → Run → "Success. No rows
   returned" (notices "… does not exist, skipping" are normal; a notice about pg_cron or `ppi_project_url` means step
   1 or 2 is missing — fix it and run the file again). Safe to run again. Check:
   `select jobname, schedule from cron.job where jobname like 'ppi-assistant%';` → 2 rows, and Storage shows the
   private bucket **shop-assistant-uploads**.
4. **New Edge Function `assistant-archive`:** Edge Functions → **Deploy a new function** → **Via Editor** → name
   `assistant-archive` → delete the example code → paste the whole file `supabase/functions/assistant-archive/index.ts`
   → **Deploy** → open the function → switch **off** "Verify JWT" → Save.
5. **One new secret, the same value in two places:** let your password manager make 40 random letters and digits
   (keep it there; never paste it into a chat).
   - Supabase → Edge Functions → **Secrets** → `ASSISTANT_ARCHIVE_SECRET` = that value.
   - Vercel → Settings → Environment Variables → `ASSISTANT_ARCHIVE_SECRET` = the same value, Production, tick
     **Sensitive**.
6. **Merge the pull request** on GitHub → Vercel deploys with the new variable (if you set it after the deployment:
   Deployments → … → **Redeploy**).
7. **Logo for the PDFs:** Môj obchod → **Logo** → upload the logo once more (from now on a PNG copy is saved next to it;
   PDFs cannot show WebP).
8. **Test** on the Cacaduu Paint shop (Pro), the shop page in a private window:
   - Open the assistant → under the welcome text: "Konverzácia a nahrané súbory sa ukladajú pre obchod … Viac"
     ("Viac" opens the privacy page, a draft text).
   - **Pridať fotku alebo PDF** → a phone photo and a PDF → wait until "Pripravuje sa…" disappears → ask a question.
     Then write one question in Hungarian or English.
   - Close the box (−). Môj obchod → **Konverzácie asistenta** → the conversation is listed (date, language, number of
     messages, paperclip, first question) → **Otvoriť**: times, "Po slovensky: …" under the foreign messages, the cards
     table, the photo (click → full size), "Zobraziť" for the PDF.
   - Supabase → Storage → shop-assistant-uploads → (shop) → (conversation) → the PDF `2026-…_…_xxxxxxxx.pdf` →
     download: Slovak letters, the logo, the photo thumbnail, "Vytvorené Cacaduu PPI · konverzácia … · strana 1/1".
     In `files/` download the photo → its properties show no location.
   - Open the assistant again, ask something, click **Vymazať moju konverzáciu** → OK → it is not in the list.
   - **Uchovávať konverzácie** → 30 / 90 / 365 dní → Uložiť. Open a conversation → **Vymazať** (tick) → gone.
   - After 10 minutes: `select status, return_message, start_time from cron.job_run_details order by start_time desc
     limit 5;` → `succeeded`.
9. If something does not work: Supabase → Edge Functions → `assistant-archive` → **Logs** (lines start with
   `assistant-archive:`); Vercel → Logs → search `assistant-archive` or `shop-chat`. Nothing of a conversation, file or
   key is ever written to the logs.

The cloud folder (OneDrive / Dropbox) is Part P.

---

## Part P — Cloud folder: conversations into the shop's OneDrive or Dropbox (10 October 2026)

A paid feature on top of Part O: when a conversation ends and its PDF is ready, PPI copies the PDF and the shopper's
files into the shop's own OneDrive or Dropbox folder: `<folder>/<YYYY-MM>/<YYYY-MM-DD_HH-MM_id>/konverzacia.pdf` and
`…/subory/`. The owner connects the cloud once in **Môj obchod → Cloudový priečinok**. PPI never overwrites or deletes
anything there. Part O must be done first. Do the steps in this order; replace `YOUR-PROJECT-ID` with your project's
id (the part before `.supabase.co` in `NEXT_PUBLIC_SUPABASE_URL`).

1. **Database:** SQL Editor → paste the whole file `supabase/sql/23_cloud_export.sql` → Run → "Success. No rows
   returned" (notices "… does not exist, skipping" are normal; a notice about pg_cron means Part O step 1 is missing).
   Safe to run again. Check: `select jobname, schedule from cron.job where jobname = 'ppi-cloud-export-tick';` → 1 row.
2. **New Edge Function `cloud-export`:** Edge Functions → **Deploy a new function** → **Via Editor** → name
   `cloud-export` → delete the example code → paste the whole file `supabase/functions/cloud-export/index.ts` →
   **Deploy** → open the function → switch **off** "Verify JWT" → Save.
3. **Update `assistant-archive`:** Edge Functions → `assistant-archive` → **Code** → replace everything with the new
   file `supabase/functions/assistant-archive/index.ts` → **Deploy** ("Verify JWT" stays off).
4. **Microsoft app (for OneDrive):** <https://entra.microsoft.com> (or portal.azure.com → Microsoft Entra ID) →
   **App registrations** → **New registration**:
   - Name `Cacaduu PPI`; Supported account types: **Accounts in any organizational directory and personal Microsoft
     accounts**; Redirect URI: **Web** →
     `https://YOUR-PROJECT-ID.supabase.co/functions/v1/cloud-export/oauth/onedrive` → **Register**.
   - **API permissions** → Add a permission → Microsoft Graph → **Delegated** → tick `Files.ReadWrite` and
     `offline_access` → Add (the default `User.Read` can stay). No admin consent is needed.
   - **Certificates & secrets** → New client secret → description `PPI`, expiry **24 months** → Add → copy the
     **Value** at once (it is shown only now; not the "Secret ID").
   - **Overview** → copy the **Application (client) ID**.
   - Put the secret's **expiry date in your calendar**: before it, make a new secret here and replace
     `ONEDRIVE_CLIENT_SECRET` in Supabase, or every OneDrive copy stops.
   - Personal Microsoft accounts can connect at once. A shop with a **work or school** account may see "unverified"
     or need its IT admin's approval until the app has publisher verification (Branding & properties → Publisher
     verification, needs a Microsoft partner ID).
5. **Dropbox app:** <https://www.dropbox.com/developers/apps> → **Create app** → **Scoped access** → **Full Dropbox**
   → a name such as `Cacaduu PPI` → Create.
   - **Permissions** tab first: tick `files.metadata.read` and `files.content.write` (`account_info.read` is already
     on) → **Submit**.
   - **Settings** tab: OAuth 2 → Redirect URIs → add
     `https://YOUR-PROJECT-ID.supabase.co/functions/v1/cloud-export/oauth/dropbox` → Add. Copy the **App key** and
     the **App secret** (Show).
   - The app starts in "Development" status: up to 500 shops can connect; when 50 have connected, Dropbox gives two
     weeks to **Apply for production** on the same page.
6. **Supabase → Edge Functions → Secrets** → add (values from steps 4 and 5 and your password manager; never paste
   them into a chat):
   - `ONEDRIVE_CLIENT_ID`, `ONEDRIVE_CLIENT_SECRET`
   - `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`
   - `EXPORT_TOKEN_ENCRYPTION_KEY` = 48 random letters and digits from your password manager. It encrypts the shops'
     cloud tokens: keep it; changing it later means every shop must connect again.
   - `BREVO_API_KEY` = Brevo → **SMTP & API** → **API keys** → Generate a new API key (an API key `xkeysib-…`, not the
     SMTP key from Part E).
   - `ALERT_EMAIL_FROM` = a sender address verified in Brevo (Senders, domains), e.g. the one used for Part E.
   Nothing new is needed in Vercel.
7. **Merge the pull request** on GitHub → Vercel deploys.
8. **Test** on the Cacaduu Paint shop (Pro):
   - Môj obchod → **Cloudový priečinok** → the folder is `/Cacaduu/Cacaduu Paint shop` → paste a OneDrive share link
     into the folder field → **Pripojiť OneDrive** → the page explains that share links cannot be written to. Put the
     path back.
   - **Pripojiť OneDrive** → sign in with Microsoft → Accept → back in Môj obchod: "Cloud je pripojený", your account,
     the folder, "Pripojené". In OneDrive on the web the folder `Cacaduu/Cacaduu Paint shop` exists.
   - **Prehľadávať priečinky** → **↑ O úroveň vyššie** → **Nový priečinok** `Test` → **Vytvoriť** → **Ukladať sem** →
     "Priečinok je uložený" (you can switch back the same way).
   - The shop page in a private window → the assistant → **Pridať fotku alebo PDF** → a photo → a question → close the
     box (−). Within a minute OneDrive shows `…/2026-10/2026-10-10_HH-MM_xxxxxxxx/konverzacia.pdf` and `subory/` with
     the photo. Môj obchod → **Konverzácie asistenta**: "Uložené v cloude" and the folder.
   - **Uložiť znova** on it → nothing new appears in OneDrive (no copies). Delete `konverzacia.pdf` in OneDrive →
     **Uložiť znova** → it is there again.
   - **Uložiť staršie konverzácie** → from a day before Part O was set up to today → "Na uloženie do cloudu čaká
     konverzácií: N" → they appear in OneDrive.
   - **Odpojiť** (tick) → "Cloud je odpojený" → **Pripojiť Dropbox** → sign in → Allow → one more conversation →
     it appears in Dropbox under `Cacaduu/Cacaduu Paint shop/…`.
   - Optional, the failure e-mail: in your Microsoft account → **Privacy → Apps and services** (or
     <https://account.live.com/consent/Manage>) → remove "Cacaduu PPI" → the next conversation shows "Cloud: chyba –
     Pripojenie k cloudu vypršalo – pripojte ho znova" and the section shows **Pripojiť znova**; after 24 hours the
     shop's owners get one e-mail with that subject. **Pripojiť znova** copies what waited.
   - After 10 minutes: `select status, return_message, start_time from cron.job_run_details order by start_time desc
     limit 5;` → `succeeded`.
9. If something does not work: Supabase → Edge Functions → `cloud-export` → **Logs** (lines start with
   `cloud-export:`; tokens, keys and file contents are never logged). "Pripojenie cloudu ešte nie je nastavené" means
   a secret from step 6 is missing; Microsoft's "redirect URI mismatch" (AADSTS50011) or Dropbox's "Invalid
   redirect_uri" means the address in step 4 or 5 differs from your project's. When Supabase refuses the call before
   the function runs, Môj obchod says which of these it is: "V Supabase nie je funkcia cloud-export" (step 2: the name
   must be exactly `cloud-export`), "… až po vypnutí „Verify JWT“" (step 2: switch it off → Save) or "Funkcia
   cloud-export sa nespustila" (paste the whole file again → Deploy; its Logs say why). "Dropbox odmietol tajný kľúč
   aplikácie" (or Microsoft) after "Allow": `DROPBOX_APP_SECRET` (or `ONEDRIVE_CLIENT_SECRET`) is not the secret of
   the same app as the key/ID — paste it again in Supabase → Secrets and connect again (no redeploy needed).
   "Dropbox aplikácii chýba povolenie": step 5 — Permissions → tick `files.metadata.read` and `files.content.write` →
   **Submit**, then connect again and Allow (Dropbox grants new permissions only on a new Allow).
   "Microsoft odmietol prihlásenie: … platformou „Web“" (log: `AADSTS9002327` or `AADSTS700025`): step 4 — the
   redirect address must be under **Web**, not "Single-page application" or "Mobile and desktop applications"
   (Authentication → remove it there → Add a platform → Web), and "Allow public client flows" = No.
   "Microsoft aplikácia nepúšťa tento typ účtu" (`AADSTS50194` / `AADSTS9002331`): step 4 — Supported account types
   must be "Accounts in any organizational directory and personal Microsoft accounts". Any other failure shows its
   code on the page ("kód AADSTS…"); the same code is in the `cloud-export` Logs. Vercel → Logs → search
   `cloud-export: Supabase refused` shows the same with the HTTP status.

---

## Part Q — Access keys: shoppers view or download a private folder (10 October 2026)

A paid feature on top of Part M (and Part O for the shopper's own PDF): a shopper who has a folder's access key opens
the folder in the shop assistant, reads its PDFs and pictures in a built-in viewer (pages as pictures with the light
watermark "<shop> · VIP · <date>") and, only where the owner allows it, downloads them. The owner sets per folder
"Režim prístupu" (Len zobraziť / Zobraziť a stiahnuť), per file an override, the folder's key, and sees counts of
unlocks, views and downloads. Parts M and O must be done first. Do the steps in this order.

1. **Database:** SQL Editor → paste the whole file `supabase/sql/24_access_key_access.sql` → Run → "Success. No rows
   returned" (notices "… does not exist, skipping" are normal). Safe to run again. Check:
   `select count(*) from public.shop_document_pages;` → 0 (the table exists).
2. **Update three Edge Functions**, each: Edge Functions → the function → **Code** → replace everything with the new
   file → **Deploy** ("Verify JWT" stays off):
   - **`shop-files`** ← `supabase/functions/shop-files/index.ts` (viewer pages, downloads, ZIP)
   - **`doc-ingest`** ← `supabase/functions/doc-ingest/index.ts` (stores the page pictures for the viewer)
   - **`assistant-archive`** ← `supabase/functions/assistant-archive/index.ts` (the shopper's own PDF)
3. **Vercel:** nothing new. `SESSION_COOKIE_SECRET` (Part M step 4) must be set: without it there is no "Mám prístupový
   kľúč" and no viewer. `ASSISTANT_ARCHIVE_SECRET` (Part O) stays as it is.
4. **Merge the pull request** on GitHub → Vercel deploys.
5. **Older private PDFs** (uploaded before this update) have no page pictures yet: Môj obchod → **Dokumenty pre
   asistenta** → each such PDF shows "Zobrazenie pre zákazníkov: chýba" → **Pripraviť na zobrazenie** (Edge or Chrome;
   keep the page open until it says "pripravené"). New uploads do this by themselves.
6. **Test** on the Cacaduu Paint shop (Pro), logged in, Edge or Chrome:
   - Môj obchod → **Dokumenty pre asistenta** → the private folder (e.g. "Veľkoobchod") → **Nastaviť kľúč** → the key
     is shown once → copy it. Under it: "Odomknutia: 0 · Zobrazenia: 0 · Stiahnutia: 0".
   - **Režim prístupu** → **Len zobraziť** → **Uložiť prístup** (the note says that view-only cannot stop screenshots).
   - The shop page in a private window → the assistant → **Mám prístupový kľúč** → type a wrong key → "Nesprávny
     kľúč." (after 5 wrong keys in 15 minutes it waits a while).
   - Paste the right key (or send it as a message) → "Prístup k priečinku Veľkoobchod odomknutý" and the folder's files
     with **Otvoriť** and no "Stiahnuť". **Otvoriť** a PDF → its pages as pictures with "Cacaduu Paint shop · VIP ·
     <date>" → **Zavrieť**. Ask about the price list → the answer uses it.
   - Back in Môj obchod → **Zobraziť a stiahnuť** → **Uložiť prístup**. Set one file to **Len zobraziť** (its own
     "Prístup s kľúčom") → **Uložiť prístup**. In the shop window close and open the assistant, enter the key again →
     now **Stiahnuť** next to the other files, none next to that one, and **Stiahnuť celý priečinok (ZIP)** → the ZIP
     has only the downloadable files. "Zostáva stiahnutí: …" counts down from 20.
   - Close the box (−) → open it again → the folder is locked (the key is needed again).
   - **Zmeniť kľúč** → OK → the old key says "Nesprávny kľúč.", the new one works. The counts went up.
   - **Stiahnuť túto konverzáciu (PDF)** in the assistant (after a question) → a PDF with only this conversation. Môj
     obchod → **Konverzácie asistenta** → untick "Zákazníci si môžu stiahnuť svoju konverzáciu (PDF)" → Uložiť →
     reload the shop page → the button is gone.
7. If something does not work: Vercel → Logs → search `folder` or `shop-chat`; Supabase → Edge Functions →
   `shop-files` / `doc-ingest` → **Logs**. "pripravuje sa na zobrazenie" next to a file means step 5 is missing for it.
   Keys and files are never written to the logs.

---

## Part R — Own domains for Pro shops: buy one through PPI or connect one (11 October 2026)

A Pro shop gets its page on its own domain: it finds a free name on websupport.sk, pastes it into **Môj obchod →
Predplatné a doména** and pays once (Stripe); PPI registers the domain **in the shop's name** at Websupport (paid from
your prepaid Websupport credit), adds it to the Vercel project and sets its DNS. Or it connects a domain it already
has. You manage everything on the new admin page **Predplatné a domény**. Parts K (Stripe), O (Vault `ppi_project_url`,
pg_cron, pg_net) and P (`BREVO_API_KEY`, `ALERT_EMAIL_FROM`) must be done first. Start in **test mode**: nothing is
bought, the website goes on your test domain. Do the steps in this order.

1. **Database:** SQL Editor → paste the whole file `supabase/sql/25_custom_domains.sql` → Run → "Success. No rows
   returned" (notices "… does not exist, skipping" are normal). Safe to run again. Check:
   `select jobname from cron.job where jobname like 'ppi-domains%';` → `ppi-domains-tick` and `ppi-domains-daily`.
2. **Your account as the admin** (only this account sees "Predplatné a domény"): SQL Editor →
   `update public.profiles set is_admin = true where user_id = (select id from auth.users where email = 'YOUR E-MAIL');`
   → "UPDATE 1".
3. **Edge Functions:**
   - **Deploy a new function** → **Via Editor** → name **`domains`** → paste the whole
     `supabase/functions/domains/index.ts` → **Deploy** → open it → switch **off** "Verify JWT" → Save.
   - **`stripe-webhook`** → Code → replace everything with `supabase/functions/stripe-webhook/index.ts` → Deploy
     ("Verify JWT" stays off).
   - **`stripe-checkout`** → Code → replace everything with `supabase/functions/stripe-checkout/index.ts` → Deploy.
4. **Stripe (test mode):**
   - Product catalog → **Add product** → name "Doména – registrácia na 1 rok" → **One-off** price (any amount, e.g.
     1 €: the real amount always comes from your price table) → tax code: ask your accountant (e.g. "General –
     Electronically Supplied Services") → Save → copy the price ID (`price_…`).
   - Developers → **Webhooks** → your `stripe-webhook` endpoint → **Add events** → **`invoice.paid`** → Save
     (one-click payments and renewals arrive with it).
5. **Websupport** (admin.websupport.sk, the account that will own the orders):
   - Account → **API / REST API** (security settings) → create an API key → copy its **identifier** and **secret**
     (the secret is shown once).
   - Your **user ID** (the number of the account; if you cannot find it, use `self`, Websupport's API name for your
     own account — step 10 shows whether it works).
   - **Test domain:** a domain in this account with Websupport's DNS and no website you need (its A `@` and CNAME `www`
     records will point to Vercel; MX and every other record stay as they are).
   - **Credit** ("Kredit", prepaid): needed only for live mode (step 12).
6. **Vercel:**
   - Account Settings → **Tokens** → Create (scope: the account or team of the PPI project; note the expiry date) → copy.
   - The PPI project → Settings → General → **Project ID** → copy.
   - Only if the project belongs to a team: Team Settings → General → **Team ID** → copy.
   - Check that `NEXT_PUBLIC_SITE_URL` is PPI's own address (it, `www.` of it and `*.vercel.app` are never taken for a
     shop's domain). Optional `PPI_MAIN_HOSTS`: more of PPI's own host names, comma-separated.
7. **Supabase → Edge Functions → Secrets** → add:

   | Name | Value |
   | --- | --- |
   | `WEBSUPPORT_API_KEY` | the API key's identifier (step 5) |
   | `WEBSUPPORT_API_SECRET` | the API key's secret (step 5) |
   | `WEBSUPPORT_USER_ID` | your Websupport user ID (step 5) |
   | `REGISTRAR_MODE` | `test` |
   | `VERCEL_API_TOKEN` | the token (step 6) |
   | `VERCEL_PROJECT_ID` | the project ID (step 6) |
   | `VERCEL_TEAM_ID` | only for a team project (step 6) |
   | `STRIPE_PRICE_DOMAIN` | the domain price ID (step 4) |
   | `ADMIN_EMAIL` | your e-mail for alerts (low credit, failed registration, DNS stuck) |

   Already there and used too: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `BREVO_API_KEY`,
   `ALERT_EMAIL_FROM`. Never put any of these in Vercel, the repository or a chat.
8. **Merge the pull request** on GitHub → Vercel deploys.
9. **Admin settings:** log in → menu **Predplatné a domény** → **Overiť kredit** (shows your Websupport credit:
   the API key works) → **Nastavenia**: the search page (default `https://www.websupport.sk`), the low-credit limit,
   **Testovacia doména** = your test domain, the switch "Cena domény = cenník Websupport" (only if your prices really
   are Websupport's) → **Uložiť nastavenia** → **Cenník domén pre obchody**: one row per TLD you sell (e.g. `sk`,
   `com`, `eu`): domain price and renewal price per year in EUR, "Vrátane DPH" ticked if the price includes VAT →
   **Pridať koncovku**. TLDs not in the table are not sold.
10. **Test 13 (buy):** a Pro shop that paid Pro with the test card `4242 4242 4242 4242` (Part K) → Môj obchod →
    **Predplatné a doména** → **Vyhľadať doménu na Websupport.sk** (new tab) → paste e.g. `https://www.Davide.sk/` →
    **Overiť** → "✅ davide.sk je voľná · … / rok (Pro predplatné vrátane domény)" → fill in what step 3 asks (the
    shop's company: it becomes the domain's owner) → tick the terms → **Zaplatiť …** (one click with the saved card) →
    the steps Zaplatené → Registrujem doménu → Nastavujem stránku → Zabezpečujem (HTTPS) → Hotovo (the 5-minute job
    moves it on; Vercel needs a few minutes for HTTPS) → "Vaša stránka beží na <test domain>" → after 5 s the shop page
    opens there; the e-mail "Vaša stránka beží na …" arrives once. **Confirm the registrant:** SQL Editor →
    `select status, registrar_order_id, last_error, log from public.domain_orders order by created_at desc limit 1;`
    → the log has "ordered · dry run …": Websupport accepted the order with the shop's own domain profile. If it
    shows "Websupport: … failed (…)" instead, **stop and send me the text** (do not go live).
11. **Test 14 (connect):** a second Pro shop → **Už mám vlastnú doménu** → a domain you control at any registrar →
    **Pripojiť doménu** → the page lists the records (A `@`, CNAME `www`, maybe TXT `_vercel`) with **Kopírovať** → add
    them at that registrar (keep the MX records) → **Skontrolovať** → Čaká na DNS → Overené → Zabezpečujem → **Beží** →
    the same e-mail. **Odpojiť doménu** removes it again.
    In test mode only one shop at a time can be on the test domain; to free it after a test:
    `update public.domain_orders set status = 'ended', ended_at = now() where test_mode and status = 'live';`
12. **Live (when the tests passed):** Websupport credit above your low-credit limit → Stripe in live mode: the domain
    product and price again and `invoice.paid` on the live webhook (with Part K5) → secrets `STRIPE_PRICE_DOMAIN` (live
    ID) and **`REGISTRAR_MODE` = `live`**. From then on every paid order buys the domain from your credit.
13. If something does not work: **Predplatné a domény** shows each shop's step, last error and actions ("Zopakovať
    krok", "Skontrolovať DNS", "Znova poslať e-mail", "Vyriešené", "Kód na prevod"); Supabase → Edge Functions →
    `domains` → Logs. Keys, signatures and tokens are never written to the logs.

---

## Part S — Booking link, product pages without other shops, quick view of stock files (11 October 2026)

Every shop (free or Pro) can add the link to its page in a booking app (Reservio, Bookio, Calendly, its own booking
page …): the shop page then shows **Rezervovať termín** next to the e-mail and Facebook page (same style) and it opens in a new tab. Product pages of a shop
with Pro **or** a domain of its own (being set up or live) show no "Dostupné aj v" block and no "V iných obchodoch sme
tento výrobok nenašli." text. "Posledné nahrané súbory" gets a quick view: a tap on a file opens its full report, and
the arrows (or a swipe) go through the last 10 files. No new secrets, no Edge Function changes. Do the steps in order.

1. **Database:** SQL Editor → paste the whole file `supabase/sql/26_booking_link.sql` → Run → "Success. No rows
   returned" (a notice "… does not exist, skipping" is normal). Safe to run again. Check:
   `select booking_url from public.public_shops limit 1;` → one row with an empty `booking_url`.
2. **Merge the pull request** on GitHub → Vercel deploys. (Merged before step 1, the website still works: no booking
   field effect and other shops hidden only for Pro until the SQL is in.)
3. **Test:**
   - Môj obchod → **Údaje obchodu** → **Odkaz na rezervácie**: type `reservio.com/vasobchod` → **Uložiť** → the field
     shows `https://reservio.com/vasobchod`. Type `javascript:alert(1)` → "Zadajte webovú adresu vašej rezervačnej
     stránky …" and nothing is saved.
   - The shop page → **Rezervovať termín** with a calendar icon in the row with the e-mail and Facebook → opens in a new
     tab. Empty the field and save → it is gone.
   - A product of the Cacaduu Paint shop (Pro) → no "Dostupné aj v" and no "V iných obchodoch sme tento výrobok
     nenašli." (also on its own domain).
   - **Priečinok s exportom** → **Posledné nahrané súbory** → tap a card (or **Rýchly náhľad**) → "Súbor 1 z 10" with
     the full report → **Starší →** / **← Novší** (or the ← → keys; swipe on a phone) → **Zavrieť** or Esc.
4. If a Pro shop's product page still shows "Dostupné aj v", check its plan in the SQL Editor:
   `select s.slug, public.shop_has_plan(s.id) as pro, public.shop_stands_alone(s.id) as alone, sub.status,
   sub.current_period_end from public.shops s left join public.subscriptions sub on sub.shop_id = s.id order by 1;`
   — `alone` must be `true` for every Pro shop and every shop with a domain.

---

## Part T — Open / break / closed / holiday status, holidays, Pro page layout (13 October 2026)

Every shop now shows a **status dot with the status in words** (Otvorené, Obedňajšia prestávka, Zatvorené, Štátny
sviatok, Otváracie hodiny neuvedené) on the shop page, the search list, the product page, the API and the MCP server;
the map pins have the same colours (the words show when you point at a pin; no legend under the map). Public
holidays of Slovakia, Hungary and Czechia (2026–2027) are in the database; each shop decides in Môj obchod →
**Sviatky a mimoriadne zatvorenie** whether they apply and can add special days (closed, or other hours). The shop page
has a new order (name and logo with the shop details under them, map, opening hours, assistant always open,
"Mám prístupový kľúč", items) and on a
shop's own domain there is no Cacaduu header — only the shop's name, logo and SK · HU · EN. No new secrets, no Edge
Function changes. Do the steps in order.

1. **Database:** SQL Editor → paste the whole file `supabase/sql/27_shop_status.sql` → Run → "Success. No rows
   returned" (a notice "… does not exist, skipping" is normal). Safe to run again. Check:
   `select country, count(*) from public.public_holidays group by 1 order by 1;` → CZ 26, HU 26, SK 26.
2. **Merge the pull request** on GitHub → Vercel deploys. (Merged before step 1, the website still works: the status
   then uses only the regular opening hours and "Sviatky a mimoriadne zatvorenie" says it needs update 27.)
3. **Test:**
   - A shop page → the dot on the map and the line under "Otváracie hodiny" (today in bold, "· dnes") say the same,
     e.g. "● Otvorené · zatvára o 17:00".
   - **Lunch break (blue)**, during today's opening hours: Môj obchod → **Údaje obchodu** → opening hours → today →
     **+ Obedňajšia prestávka** → a time around now (e.g. now − 10 min to now + 20 min) → **Pridať prestávku** →
     **Uložiť** → the shop page shows a blue dot and "Obedňajšia prestávka · otvára o …". Then set today back
     (**Odstrániť** on the second time, the first time's end back to the closing time) and save.
   - **Holiday (yellow):** Admin → **Predplatné a domény** → **Sviatky** → the shop's country → today's date, kind
     "deň pracovného pokoja – obchody môžu mať otvorené", a name → **Uložiť sviatok** → the shop page shows a yellow
     dot and "Štátny sviatok – overte otváracie hodiny". Then **Zrušiť úpravu** on that row.
   - Môj obchod → **Sviatky a mimoriadne zatvorenie** → **Pridať mimoriadny deň** (e.g. tomorrow, Zatvorené celý deň,
     note "Inventúra") → it is listed on the shop page under "Sviatky a mimoriadne dni (najbližších 14 dní)".
     **Vymazať** removes it.
   - The shop on its own domain → no Cacaduu logo or menu at the top, the shop's name and logo with SK · HU · EN.
4. Opening hours that run past midnight (e.g. a bar 18:00–02:00): enter 18:00 – 02:00; the editor explains it under
   the days.
5. **Next year's holidays** (once a year, e.g. in November): `node scripts/holidays.mjs 2028` prints the SQL rows; paste
   them into the SQL Editor (the admin's own changes always stay). If a law changes a date, change it on the admin
   page **Sviatky** instead.

---

## Part U — Page sections from PDFs (Pro) and the header picture of your own domain (13 October 2026)

A shop with Pro can put up to 10 of its own PDFs on its page ("Novinky október", "Leták", "Jedálny lístok" …): each
page is shown as a picture with its text, collapsed or always open, in one of four places, with optional dates and a
download button. Before storing, PPI removes anything dangerous from the PDF (scripts, automatic actions, attached
files). On a shop's own domain the header now has a picture the shop chooses (with SK · HU · EN), and the shop's name
and logo are back on the page above its details. No new secrets. Do the steps in order.

1. **Database:** SQL Editor → paste the whole file `supabase/sql/28_pdf_sections.sql` → Run → "Success. No rows
   returned" (notices "… does not exist, skipping" are normal). Safe to run again. Check:
   `select id, public from storage.buckets where id like 'shop-sections%';` → `shop-sections` false and
   `shop-sections-public` true; `select jobname, schedule from cron.job where jobname = 'ppi-sections-hourly';` →
   one row `7 * * * *` (if not: switch on pg_cron and pg_net in Database → Extensions and run the file again).
2. **New function:** Edge Functions → **Deploy a new function** → **Via Editor** → name `page-sections` → paste the
   whole file `supabase/functions/page-sections/index.ts` → **Deploy** → open its settings and switch **OFF "Verify
   JWT"**. It uses the secrets you already have (`ANTHROPIC_API_KEY`, optional `AI_MODEL`).
3. **Update shop-files:** Edge Functions → `shop-files` → **Code** → replace everything with the new
   `supabase/functions/shop-files/index.ts` → **Deploy** ("Verify JWT" stays off). Without it "Stiahnuť PDF" answers 404.
4. **Merge the pull request** on GitHub → Vercel deploys. (Merged before step 1 the website still works: Môj obchod
   says "Táto časť bude dostupná po aktualizácii databázy 28" and shop pages have no sections.)
5. **Test the sections** (on the Cacaduu Paint shop or another Pro shop):
   - Môj obchod → **Sekcie stránky (PDF)** → **Pridať sekciu**: title `Novinky október`, a 3-page A4 PDF, "Rozbaľovacie –
     zatvorené", "Za údajmi obchodu" → **Pridať a nahrať PDF** → wait for "Hotovo. Pozrite si náhľad a sekciu
     zverejnite." (a PDF with a password, more than 20 pages or over 10 MB is refused with a message).
   - **Náhľad** → the pages as visitors will see them (only you see this) → **Zverejniť**.
   - The shop page: "Novinky október" as a closed dropdown under the shop's details; open it → the 3 pages, "Strana 1 /
     3"; tap a page → it opens large; **Zobraziť text** shows the text.
   - **Upraviť** → "Vždy otvorené" → **Uložiť** → on the shop page the pages are shown directly.
   - **Upraviť** → "Zobrazovať do" = yesterday → **Uložiť** → the section is gone from the page (the row says
     "Skončené – zobrazovalo sa do …"). Set it empty again to bring it back.
   - Optional: "Povoliť stiahnutie PDF" → a **Stiahnuť PDF** link under the section; drag a row (or ↑ ↓) to change
     the order; **Nahradiť PDF**; **Skryť** / **Zobraziť**; **Vymazať**.
   - The shop's AI assistant: ask about something in the PDF → the answer names "Zdroj: Novinky október, strana 1".
6. **Header picture of your own domain:** Môj obchod → **Obrázok v hlavičke webu** → **Vybrať obrázok** (best 1600 ×
   400 px) → your domain (e.g. davide.sk) shows it across the top, with SK · HU · EN; the shop's name and logo are on
   the page above its details. **Odstrániť obrázok** removes it.
7. If an upload stops with "page-sections HTTP 404" the function is not deployed under that name; "HTTP 401" means
   "Verify JWT" is still on (step 2).

---

## Part V — "Zobrazenie strán": slider or one under another (13 October 2026)

Each page section can now show its pages as a **slider** (one page at a time: swipe on a phone, ‹ › or the arrow keys
on a computer, "2 / 5" and dots; the default for every section, also the existing ones) or **Pod sebou** (one under
another, as before). A tap on a page opens it full screen (pinch or the mouse wheel to zoom, swipe to the next page).
A one-page section shows just the page. "Stiahnuť PDF" is now a button. No new function or secret.

1. **Database:** SQL Editor → paste the whole file `supabase/sql/29_section_slider.sql` → Run → "Success. No rows
   returned" (notices "… already exists, skipping" / "… does not exist, skipping" are normal). Safe to run again.
   Check: `select page_layout, count(*) from public.shop_page_sections group by 1;` → every existing section
   `slider` (or no rows).
2. **Merge the pull request** on GitHub → Vercel deploys. (Merged before step 1 the website still works: every
   section is a slider and the "Zobrazenie strán" choice is not saved.)
3. **Test** (a Pro shop with a section of 2 or more pages):
   - The shop page: the section shows one page, "1 / 3" and dots; **›** or a swipe → "2 / 3"; the height stays the
     same; tap the page → it opens full screen; pinch / wheel to zoom, swipe to the next page, **Zavrieť**.
   - Môj obchod → **Sekcie stránky (PDF)** → **Upraviť** → **Zobrazenie strán: Pod sebou** → **Uložiť** → on the shop
     page the pages are one under another again.
   - A section with "Povoliť stiahnutie PDF" shows a **Stiahnuť PDF** button.

---

## Part W — Page sections for free shops too (13 October 2026)

Every shop can now add PDF sections, not only Pro: the same upload and display options. The limits per plan are your
settings on the admin page (defaults: **free 1 section, 5 pages, 10 MB; Pro 10 sections, 20 pages, 10 MB**). At the
limit the shop sees "Pre viac sekcií prejdite na Pro". On a free shop's page the section sits right after the opening
hours, before the items. A Pro shop that goes back to free keeps all its sections and shows only the first one. No new
secret. Do the steps in order.

1. **Database:** SQL Editor → paste the whole file `supabase/sql/30_free_sections.sql` → Run → "Success. No rows
   returned" (notices "… does not exist, skipping" are normal). Safe to run again. Check:
   `select * from public.section_limits order by plan;` → `free 1 5 10` and `pro 10 20 10`.
   (If you ever run file 29 again, run file 30 again after it.)
2. **Update the function:** Edge Functions → `page-sections` → **Code** → replace everything with the new
   `supabase/functions/page-sections/index.ts` → **Deploy** ("Verify JWT" stays off). Without it a free shop's upload
   stops with "Sekcie stránky sú súčasťou predplatného Pro."
3. **Merge the pull request** on GitHub → Vercel deploys. (Merged before step 1 the website still works as before:
   sections only for Pro.)
4. **Test:**
   - A free shop: Môj obchod → **Sekcie stránky (PDF)** → the same "Pridať sekciu" form, without "Pozícia" → upload a
     PDF of up to 5 pages → **Náhľad** → **Zverejniť** → on the shop page it is right after "Otváracie hodiny".
     A PDF with 6 pages says "PDF môže mať najviac 5 strán. Pre viac strán prejdite na Pro."
   - After the first section the form is replaced by **"Pre viac sekcií prejdite na Pro"**.
   - Admin: **Predplatné a domény** → **Limity sekcií (PDF)** → change a number → **Uložiť** → the shop's form follows
     at once (set it back afterwards).

---

## Part X — Own-domain header logo, "Za otváracími hodinami", pictures in page sections (14 October 2026)

- **Own domain:** the header is again as before the header picture — the shop's **small logo** at the top left (a
  link to the shop's home page) and SK · HU · EN on the right. Môj obchod → **Logo v hlavičke webu** replaces
  "Obrázok v hlavičke webu": upload a logo (PNG or WebP with a transparent background is best; JPG works too); without
  one the shop's normal logo is used. The shop's name and logo stay on the page above its details.
- **Page sections:** a new position **"Za otváracími hodinami"** (between the opening hours and the assistant), and
  **pictures are fine**: instead of a PDF the shop can upload photos or pictures (JPG, PNG, WebP) — each picture is one
  page; the AI reads their text; only a PDF can be downloaded.

No new secret. Do the steps in order.

1. **Database:** SQL Editor → paste the whole file `supabase/sql/31_site_logo_pictures.sql` → Run → "Success. No rows
   returned" (notices "… does not exist, skipping" are normal). Safe to run again. Check:
   `select column_name from information_schema.columns where table_name = 'shops' and column_name like 'site_logo%';`
   → three rows.
2. **Update the function:** Edge Functions → `page-sections` → **Code** → replace everything with the new
   `supabase/functions/page-sections/index.ts` → **Deploy** ("Verify JWT" stays off). Without it, pictures stop with
   "Obrázky bude možné nahrať po aktualizácii databázy 31."
3. **Merge the pull request** on GitHub → Vercel deploys.
4. **Test:**
   - Môj obchod → **Logo v hlavičke webu** → **Vybrať logo** → your own domain shows it small at the top left;
     click it → the shop's home page. **Odstrániť logo** → the shop's logo again.
   - Sekcie stránky → **Pridať sekciu** → Pozícia **Za otváracími hodinami** → on the shop page it is right under the
     opening hours, above the assistant.
   - Pridať sekciu with 2–3 photos (JPG/PNG) instead of a PDF → Náhľad → Zverejniť → the photos are the pages.

---

## Part Y — "Odkaz loga": where the header logo leads (14 October 2026)

- Môj obchod → **Logo v hlavičke webu** gets a field **Odkaz loga**: the address a click on the
  small logo at the top left of the shop's own domain opens (for example the shop's main website or e-shop). It opens
  in the same window. Empty = the website's home page, as until now. **Späť na úvodnú stránku** removes the link.
- Same rule as the logo: Pro or a domain of its own. Typed with or without https:// (http becomes https); wrong
  addresses are refused ("Odkaz nie je platný …") and the old one stays.

No new secret, no function to update. Do the steps in order.

1. **Database:** SQL Editor → paste the whole file `supabase/sql/32_site_logo_link.sql` → Run → "Success. No rows
   returned" (the notice "… does not exist, skipping" is normal). Safe to run again. Check:
   `select column_name from information_schema.columns where table_name = 'shops' and column_name = 'site_logo_link';`
   → one row.
2. **Merge the pull request** on GitHub → Vercel deploys. (Before step 1 the website simply shows no "Odkaz loga"
   field and the logo leads home, so the order matters only for the field.)
3. **Test:**
   - Môj obchod → **Logo v hlavičke webu** → it says "Logo vedie na úvodnú stránku webu." → type your main website
     (e.g. `www.vas-web.sk`) in **Odkaz loga** → **Uložiť odkaz** → "Odkaz loga uložený." and "Logo vedie na: …".
   - Open your own domain → click the logo at the top left → your main website opens in the same tab.
   - **Späť na úvodnú stránku** → the logo leads to the shop's home page again.

---

## Part Z — Delete several special days at once; "Vybrať súbor" in page sections (14 October 2026)

- Môj obchod → **Sviatky a mimoriadne zatvorenie** → **Vaše mimoriadne dni**: every day has a tick (a click anywhere
  on its line ticks it), **Vybrať všetko** above the list and **Vymazať vybrané (n)**, which asks once before deleting.
  Each day's own "Upraviť" / "Vymazať" stay.
- **Sekcie stránky** → Pridať sekciu / Nahradiť súbory: the file is chosen with a blue, underlined **Vybrať súbor**
  link (no more "Choose file / No file chosen" box); the chosen file names appear next to it.

No database change, no new secret, no function to update.

1. **Merge the pull request** on GitHub → Vercel deploys.
2. **Test:**
   - Vaše mimoriadne dni → tick two days → **Vymazať vybrané (2)** → OK → "Vybrané mimoriadne dni sú vymazané."
   - Sekcie stránky → Pridať sekciu → **Vybrať súbor** → pick a PDF → its name appears → Pridať a nahrať PDF.

---

## Part AA — Download assistant conversations as PDF (14 October 2026)

- AI asistent → **Konverzácie asistenta**: every finished conversation has **Stiahnuť PDF** (also on the conversation's
  own page) — the PDF goes straight to the PC (folder "Stiahnuté súbory"), under its own name, e.g.
  `2026-10-14_15-30_3f2a9c1b.pdf`. Ticks with **Vybrať všetko** and **Stiahnuť vybrané (n)** download several at once,
  each as its own PDF (the browser may ask once: "Povoliť stiahnutie viacerých súborov" → Allow).
- The shopper's pictures are now **large** in the PDF (where they were sent). Conversations that ended before the
  update keep their PDF with small pictures.

No database change, no new secret. Do the steps in order.

1. **Update the function:** Supabase → Edge Functions → `assistant-archive` → **Code** → replace everything with the
   new `supabase/functions/assistant-archive/index.ts` → **Deploy** ("Verify JWT" stays off). Without it, "Stiahnuť
   PDF" answers "Not found" and the bar says "Stiahnutie sa nepodarilo".
2. **Merge the pull request** on GitHub → Vercel deploys.
3. **Test:** AI asistent → Konverzácie asistenta → **Stiahnuť PDF** on one conversation → the PDF is in Downloads;
   tick two → **Stiahnuť vybrané (2)** → two PDFs. A new conversation with a photo → its PDF shows the photo large.

---

## Part AB — Conversations saved by themselves into a folder on the shop PC (14 October 2026)

- **Priečinok s exportom** (the page the shop PC keeps open) gets **Konverzácie do počítača** (paid plan): choose a
  folder once (Edge or Chrome on a computer); while the page is open, every finished conversation is saved there as a
  PDF (with the shopper's pictures) every 5 minutes: `2026-10/2026-10-14_15-30_3f2a9c1b.pdf`. Nothing in the folder is
  ever replaced or deleted. **Uložiť aj staršie konverzácie** saves the older ones too.

No database change, no new secret, no function to update (it uses the assistant-archive function of Part AA).

1. **Merge the pull request** on GitHub → Vercel deploys.
2. **On the shop PC** (the PPI window): **Priečinok s exportom** → **Konverzácie do počítača** → **Vybrať priečinok pre
   konverzácie** → make or choose a folder, e.g. `Dokumenty\Konverzácie PPI` → the browser asks whether PPI may save
   there → **Povoliť** (Edge/Chrome may offer "Povoliť pri každej návšteve" – choose it so it does not ask again after a
   restart).
3. **Test:** finish a conversation in the shop assistant → within 5 minutes (or **Skontrolovať teraz**) its PDF is in
   the folder, in the month's subfolder.

---

## Part AC — Shops on their own domains easy to find: Google, AI assistants, IndexNow (14 October 2026)

- **Predplatné a doména** gets, under a live own domain, **Aby vás našli Google a AI asistenti**:
  - **Overiť v Google Search Console**: the owner adds the domain in Search Console (Pridať vlastníctvo → Doména),
    copies the TXT value `google-site-verification=…` and pastes it. A domain bought through PPI (or an own domain in
    our Websupport account): **Zapísať do DNS** — Cacaduu adds that one TXT record through the Websupport DNS API and
    never changes or removes any other record (MX, SPF, DKIM, DMARC, other TXT). An own domain at another registrar:
    **Zobraziť záznam** shows the record to add there. Then **Overiť** in Search Console.
  - **Odoslať sitemap: https://<doména>/sitemap.xml** — the steps in Search Console.
  - **AI asistenti**: the domain's `llms.txt` and `robots.txt` and **Kategórie tovaru (do llms.txt)**.
  - **IndexNow**: after every stock upload Bing, Seznam, Yandex and others are told which product pages changed
    (once per upload, only the changed pages); the box shows the last time.
- Every own domain has its own `https://<doména>/llms.txt` (name, address, hours, categories, sitemap, how to read the
  stock), a `robots.txt` that lets search engines and AI crawlers read the public pages (never Môj obchod, private
  folders or access-key content) and the IndexNow key file.
- Item pages on the own domain: Product + Offer (only while the stock data is fresh) + Store (LocalBusiness) JSON-LD,
  canonical on the own domain; the main Cacaduu search, its map and the AI search link these shops to their own domain.

No new secret. Do the steps in order.

1. **Database:** SQL Editor → paste the whole file `supabase/sql/33_domain_findable.sql` → Run → "Success. No rows
   returned" (notices "… does not exist, skipping" are normal). Safe to run again; the IndexNow key is made only once.
   Check: `select indexnow_key from public.domain_settings;` → 32 letters and digits.
2. **Update two functions** (Supabase → Edge Functions → the function → **Code** → replace everything → **Deploy**;
   "Verify JWT" stays off):
   - `domains` ← `supabase/functions/domains/index.ts` (the Search Console action).
   - `stock-pull` ← `supabase/functions/stock-pull/index.ts` (the IndexNow ping after an upload).
3. **Merge the pull request** on GitHub → Vercel deploys. (Before step 1 the website shows no new box and llms.txt
   says "Not listed by the shop."; before step 2 "Zapísať do DNS" fails and nothing is sent to IndexNow.)
4. **Test** (a shop whose own domain is live):
   - `https://<doména>/robots.txt` → "User-agent: GPTBot" … and "Disallow: /api/"; `https://<doména>/llms.txt` → the
     shop's name, address and opening hours; `https://<doména>/<key from step 1>.txt` → the key.
   - Predplatné a doména → **Overiť v Google Search Console** → follow the steps → paste the value → **Zapísať do DNS**
     → "Záznam TXT je zapísaný …" → in Search Console **Overiť** (a few minutes later if it says not found). For an own
     domain elsewhere add the shown record at the registrar first. Then **Súbory Sitemap** → `sitemap.xml` →
     **Odoslať**.
   - Type a few categories → **Uložiť kategórie** → they appear in `llms.txt`.
   - Upload a stock file in which something changed → reload the page → **Naposledy oznámené …: n stránok.** (an
     answer other than 200/202 is shown there too; it is tried again with the next upload).
   - Search on PPI's main page for one of the shop's items → the result and the shop link open the own domain.
   - Optional: Bing Webmaster Tools → add the domain → it can import it from Search Console.

---

## Part AD — The main page as one AI chat (14 October 2026)

- The main page is now **one chat search**, like Perplexity or Claude: the small Cacaduu pin, **Čo dnes hľadáte?**,
  one input in the middle of the screen and three example questions. No filters, no other search box, no
  "Len dostupné teraz".
- After a question: three dots in Cacaduu yellow and the real steps ("Rozumiem otázke…" → "Hľadám v obchodoch…" →
  "Overujem dostupnosť a otváracie hodiny…"), the answer word by word, then cards from the search (original name +
  translation, price, shop, street, town, availability with its freshness, the status dot with words; "x km od centra
  Košice" when the question named a town). Follow-ups keep the context ("a v Michalovciach?"); **+ Nový chat** starts
  again; **Zastaviť** or Esc stops the answer. The website never asks for or guesses the visitor's location.
- When the AI cannot answer (no key, a limit, an error, nothing within 12 seconds) the plain search answers in the same
  chat with "Zobrazujem jednoduché výsledky vyhľadávania.". Links `/sk?q=…` still show the plain results to search
  engines and browsers without JavaScript.

**No database change, no new secret, no function to update.** `ANTHROPIC_API_KEY` and `AI_DAILY_LIMIT` in Vercel are
the ones from Part J; the optional `AI_MODEL` in Vercel (Part M) now also chooses the model of the main page's chat
(default `claude-haiku-5-5`).

1. **Merge the pull request** on GitHub → Vercel deploys.
2. **Test** on `https://cacaduu.com/sk`:
   - The page shows only the pin, "Čo dnes hľadáte?", the input and the three examples; a click on an example fills
     the input.
   - Ask **biela farba 15 l v Košiciach** → the yellow dots and the steps, the answer appears word by word, cards of
     the shops in and around Košice with "… km od centra Košice".
   - Ask **a v Michalovciach?** → the same product, now around Michalovce.
   - **Zobraziť viac** (when there are more than 6 cards), **Ukázať na mape**, **+ Nový chat**.
   - On a phone: the input stays at the bottom above the home bar, nothing scrolls sideways.
   - "Zobrazujem jednoduché výsledky vyhľadávania." on every question: log in (Môj obchod) and ask again — the reason
     is shown under the note; or Vercel → **Logs** → search `ai-search`.

---

## Part AE — The chat finds products in layers: shops nearby and the web (15 October 2026)

- The main chat now has one job — finding a product in a town — and politely declines anything else.
- It always searches **Cacaduu** first. Only when Cacaduu has fewer than 3 good results and the question names a town, it
  also shows **shops nearby** that may have it (OpenStreetMap; "Môže mať · …", "zásoby neoverené", Zavolať, Navigovať)
  and **offers on larger shops' websites** ("Z webu · Decathlon · cena podľa webu: … · overte dostupnosť na stránke →")
  with links to each shop's own search. No town → it asks "V ktorom meste hľadáte?".
- Only the product and the town go to OpenStreetMap, Google (if you switch it on) and Anthropic; nothing about the
  visitor. Nothing from Google and no web result is stored.
- Admin page "Predplatné a domény" → **Vyhľadávanie mimo Cacaduu**: a switch per source, the prices for the cost
  estimate, the allowed web domains and their search links, the calls and the estimated cost per day.

Do the steps in order.

1. **Database:** SQL Editor → paste the whole file `supabase/sql/34_layered_search.sql` → Run → "Success. No rows
   returned" (notices "… does not exist, skipping" are normal). Safe to run again.
   Check: `select layer, enabled from public.search_layers;` → osm, google_places, web.
2. **One shared secret:** make 32+ random characters (e.g. a password manager's generator, letters and digits).
   - Vercel → Project → Settings → Environment Variables → `EXTERNAL_SEARCH_SECRET` = that value, Production, tick
     **Sensitive** → Save.
   - Supabase → Edge Functions → **Secrets** → `EXTERNAL_SEARCH_SECRET` = the same value.
3. **More Supabase secrets** (Edge Functions → Secrets):
   - `WEB_SEARCH_ENABLED` = `true` (the web search; anything else = off).
   - `EXTERNAL_SEARCH_DAILY_LIMIT` = `300` (outside calls a day, all sources together; optional, 300 is the default).
   - `GOOGLE_PLACES_ENABLED` = `false` for now. Only if you want Google too: a Google Cloud project with **Places API
     (New)** enabled, an API key restricted to that API → `GOOGLE_PLACES_API_KEY` = the key and `GOOGLE_PLACES_ENABLED` =
     `true` (Google charges per request; read Google's terms first).
   - Already there and needed: `ANTHROPIC_API_KEY`, `AI_MODEL` (optional) and `ADMIN_EMAIL` (OpenStreetMap asks every app
     for a contact address; without it shops nearby are not searched).
4. **Anthropic:** Claude Console → Settings → **Capabilities** (or Privacy/Organization settings): make sure **web search**
   is allowed for your organisation. If the Console has its own list of allowed domains, it must include the domains of
   step 7.
5. **New function** `product-sources`: Supabase → Edge Functions → **Deploy a new function** → **Via Editor** → name
   `product-sources` → paste the whole file `supabase/functions/product-sources/index.ts` → **Deploy** → in its
   settings switch **OFF "Verify JWT"** (it checks the website's secret itself).
6. **Merge the pull request** on GitHub → Vercel deploys. (Before step 2 the chat searches only Cacaduu, as before.)
7. **Admin page** `https://cacaduu.com/sk/admin/domains#external-search` (your admin account):
   - **Vyhľadávanie mimo Cacaduu:** all three sources show their switch; next to each "Prostredie: zapnuté" or which
     setting is missing.
   - **Povolené webové domény a odkazy na vyhľadávanie:** Decathlon, dm, Exisport, Intersport and Action are there
     without a search link. For each: open the shop's website, search for any word, copy the address of the results page,
     put `{query}` where your word was (e.g. `https://www.decathlon.sk/search?Ntt={query}`) → paste into "Odkaz na
     vyhľadávanie" → **Uložiť**. Note: dm's Slovak e-shop may be `mojadm.sk` — add that domain too if so.
8. **Test** on `https://cacaduu.com/sk`:
   - **biela farba v Košiciach** (or anything Cacaduu has 3+ times) → only "Overené v Cacaduu".
   - **turistické topánky v Michalovciach** → "Hľadám obchody v okolí…", "Hľadám na webe…" → "Obchody v okolí
     (neoverené)" with "© OpenStreetMap contributors" and "Na webe" with "cena podľa webu" where the page shows one and
     "Hľadať priamo v e-shope:" links.
   - **turistické topánky** (no town) → "V ktorom meste hľadáte?" → **v Michalovciach** → the same with the town.
   - **Aké bude zajtra počasie?** → "Pomáham len s hľadaním produktov v obchodoch v okolí."
   - Admin page → **Denné použitie a odhad nákladov** shows the calls of the day.
   - Nothing outside appears: Vercel → Logs → search `product-sources`; Supabase → Edge Functions → product-sources →
     Logs. The admin page shows which switch is off.

## Part AF — Partner feeds: partners' products in the chat under "Partneri" (15 October 2026)

- Partner shops (e.g. a large sports chain) can send their **product feed**: Google Merchant XML or CSV/TSV (with its
  **local inventory feed** for stock per store), Heureka XML, or a plain CSV. PPI reads it on a schedule (daily by
  default) into its own tables — never mixed with the shops' stock — and shows it exactly as the partner sent it.
- In the chat, when Cacaduu has fewer than 3 good results, the partners come under **"Partneri"**, between Cacaduu and the
  shops nearby: "Decathlon (partner) · 24,99 € · online skladom / predajňa Košice: skladom podľa partnera · údaje z
  08:00". Stock in a store only when the partner's local inventory feed says so. A feed older than 48 hours shows no
  availability, only "údaje z <dátum>". Affiliate links say "partnerský odkaz" and never rank higher.
- Admin page "Predplatné a domény" → **Partnerské feedy**: add partners, their feed (address or file), format, schedule,
  affiliate yes/no, logo and store list; see the counts and the last imports; "Importovať teraz".
- **Size:** a feed is read in parts, so big feeds work, up to `PARTNER_FEED_MAX_MB` (default 50 MB, at most 500 MB,
  unpacked). A bigger feed is **not cut**: the import stops and the admin page says "Feed je väčší ako limit
  PARTNER_FEED_MAX_MB…". A large chain's full feed can be several hundred MB — ask the partner for a feed of the
  products/regions you need, or raise the limit (Supabase's free plan has 1 GB of storage; the parts sit there only
  while an import runs). A file you upload yourself is also capped by Storage's file limit (50 MB on the free plan);
  a feed address has no such cap.

Do the steps in order.

1. **Database:** SQL Editor → paste the whole file `supabase/sql/35_partner_feeds.sql` → Run → "Success. No rows
   returned" (notices "… does not exist, skipping" are normal). Safe to run again. It also creates the buckets
   `partner-feeds` (private) and `partner-logos` (public) and the job `ppi-partner-feeds-tick` (every 5 minutes; it uses
   the Vault secrets `ppi_project_url` and `ppi_assistant_cron` from part O — nothing new to add).
   Check: `select jobname, schedule from cron.job where jobname = 'ppi-partner-feeds-tick';` → one row, `3-59/5 * * * *`.
2. **New function** `partner-feeds`: Supabase → Edge Functions → **Deploy a new function** → **Via Editor** → name
   `partner-feeds` → paste the whole file `supabase/functions/partner-feeds/index.ts` → **Deploy** → in its settings
   switch **OFF "Verify JWT"** (it checks the job's secret, the admin's login and its own service key itself).
3. **Secret (optional):** Supabase → Edge Functions → **Secrets** → `PARTNER_FEED_MAX_MB` = e.g. `100` (whole MB; default
   50, at most 500). Nothing to add in Vercel.
4. **Merge the pull request** on GitHub → Vercel deploys. (With no partner the chat works exactly as before.)
5. **Admin page** `https://cacaduu.com/sk/admin/domains#partner-feeds` (your admin account):
   - The line "Funkcia partner-feeds: limit veľkosti feedu 50 MB …" shows the function answers.
   - **Pridať partnera:** name (e.g. Decathlon), format (Google Merchant XML for a Google feed), the feed address the
     partner gave you (https), the local inventory feed address if they have one (for stock per store), time zone
     (Europe/Bratislava), "Denne", tick **"Partnerské (affiliate) odkazy"** only if the links pay you a commission →
     **Pridať partnera**. The import starts at once.
   - Open the partner's row: after a minute the summary shows "N produktov … · hotovo" (or the reason, e.g. too big).
     Paste the **store list** if the partner gave you one ("kód;názov;adresa;mesto;PSČ;krajina"; the code is the
     `store_code` of their local inventory feed; the name is shown as "predajňa <name>") → **Uložiť predajne**. Upload
     the **logo** (PNG/JPG/WebP ≤ 1 MB).
   - No address, only a file? Leave the address empty, save, then use **Súbor feedu** in the partner's row.
6. **Test** on `https://cacaduu.com/sk`: ask for a product the partner's feed has and Cacaduu has few of,
   with a town where the partner has a store, e.g. **"Kde kúpim stan v Košiciach?"** → "Hľadám u partnerov…" → the group
   **Partneri** after "Overené v Cacaduu" and before "Obchody v okolí (neoverené)", with the price, "online skladom", the
   store line (only with a local inventory feed), "údaje z HH:MM" and "partnerský odkaz" on affiliate partners.
   Problems: the partner's row on the admin page shows the last imports with their reason; Supabase → Edge Functions →
   partner-feeds → Logs (feed addresses are never written there).

## Part AG — Own domains fully findable: Search Console, Bing, IndexNow on every host (15 October 2026)

- **Predplatné a doména → "Aby vás našli Google a AI asistenti"** (a live own domain):
  - **A domain Cacaduu runs** (bought here): paste the whole TXT value `google-site-verification=…` → **Zapísať do
    DNS** → Cacaduu adds one TXT record at the domain (SPF, MX, DKIM, DMARC and every other record stay as they are;
    the same value is never added twice). **Odstrániť** removes only the record Cacaduu added.
  - **An own domain connected from elsewhere**: **a) HTML značka (odporúčané)** — in Search Console choose "Predpona
    webovej adresy" `https://<doména>/`, copy Google's meta tag, paste it → **Uložiť značku** → Cacaduu puts it on the
    shop's pages on that domain → **Overiť**. **b) Záznam TXT** — the record to add at your registrar, with
    "Kopírovať".
  - **Overiť v Bing Webmaster Tools**: easiest "Importovať" from Search Console; else Bing's meta tag the same way.
  - **Odoslať sitemap**: the steps for Google and for Bing.
- **IndexNow on every host**: after a stock upload, only product pages that really changed (new or removed product,
  another price, back in stock or sold out — not 12 → 11 pieces) are announced to Bing, Seznam, Yandex and others, on
  their canonical address: the shop's own domain, or the main Cacaduu address for shops without one. At most once per
  upload and once an hour per address; what waits goes with the next one. One key for everything: `INDEXNOW_KEY`.
- **llms.txt of an own domain** also says whether the shop follows public holidays, the item categories and how AI
  assistants can read the shop through Cacaduu's API/MCP. The API's and MCP's links (`source_url`) and Cacaduu's own
  llms.txt now point to the shop's own domain.

Do the steps in order.

1. **Database:** SQL Editor → paste the whole file `supabase/sql/36_domain_findability.sql` → Run → "Success. No rows
   returned" (notices "… does not exist, skipping" are normal). Safe to run again.
   Check: `select count(*) from public.indexnow_hosts;` → 0 (the table exists).
2. **Make the IndexNow key** (it is public by design — it only proves the pings are yours): 32 letters and digits, for
   example from a terminal `openssl rand -hex 16`, or any password generator set to letters + digits, 32 long. Write
   it down; the **same value** goes into Vercel and Supabase.
3. **Vercel** → the project → Settings → Environment Variables → **`INDEXNOW_KEY`** = the key (Production; Preview too
   if you test there). Not sensitive, but "Sensitive" does no harm.
4. **Supabase** → Edge Functions → **Secrets** → add:
   - **`INDEXNOW_KEY`** = the same key.
   - **`SITE_URL`** = the website's main address with https and without a slash at the end, e.g.
     `https://cacaduu.com`. Without it, shops without an own domain
     are not announced (shops with a live own domain still are).
5. **Functions** (Supabase → Edge Functions → the function → Code → paste the whole file → Deploy; "Verify JWT" stays
   OFF):
   - `domains` ← `supabase/functions/domains/index.ts` (Odstrániť; only "google-site-verification=…" accepted).
   - `stock-pull` ← `supabase/functions/stock-pull/index.ts` (IndexNow on every host).
6. **Merge the pull request** on GitHub → Vercel deploys with `INDEXNOW_KEY`. (If you added the variable after the
   deploy started: Deployments → ⋯ → Redeploy.)
7. **Check the key files:** `https://cacaduu.com/<key>.txt` and `https://<own domain>/<key>.txt` both
   show the key. A wrong name shows "Not found".
8. **Test on a live own domain** (Predplatné a doména, the shop with the domain):
   - Bought domain: Search Console → Pridať vlastníctvo → **Doména** → the domain → copy the TXT value → paste →
     **Zapísať do DNS** → "Záznam TXT je zapísaný …" → in Search Console **Overiť** (a few minutes later if not found).
     Optional: **Odstrániť** → "Záznam, ktorý pridal Cacaduu, je odstránený z DNS …" (check at Websupport: only that
     one record is gone).
   - Connected domain: Search Console → Pridať vlastníctvo → **Predpona webovej adresy** → `https://<doména>/` →
     Ďalšie metódy overenia → **HTML značka** → copy → paste → **Uložiť značku** → open `https://<doména>/`, view the
     page source: `<meta name="google-site-verification" …>` is there → **Overiť**.
   - Bing Webmaster Tools → **Import** from Search Console (or the meta tag in "Overiť v Bing Webmaster Tools").
   - Submit `https://<doména>/sitemap.xml` in Search Console (Súbory Sitemap) and in Bing (Sitemaps).
9. **IndexNow test:** change one product's price in the shop's stock file and let the PC upload it (or "Upload file").
   On Predplatné a doména the IndexNow line shows "Naposledy oznámené …: 3 stránok." (the product in SK, HU and EN).
   Bing Webmaster Tools → IndexNow lists the addresses after a while. A second upload within the hour waits for the
   next ping. Supabase → Edge Functions → stock-pull → Logs shows "IndexNow <host>: n addresses, answer 200/202"
   (never the key).
10. **Google Rich Results Test:** https://search.google.com/test/rich-results → paste a product address on the own
    domain (`https://<doména>/sk/items/…`) → "Úryvky produktov" (Product snippets) valid. A note about a missing image
    for merchant listings is expected: PPI has no product pictures and never invents any.

The key of update 33 (`domain_settings.indexnow_key`) is no longer used; the key file now shows `INDEXNOW_KEY`.

## Part AH — cacaduu.com: the main domain and the name Cacaduu (20 October 2026)

- The site's name is now **Cacaduu PPI** everywhere: the logo, every text on the pages (SK, HU, EN), the e-mails
  ("Cacaduu PPI" as the sender's name), the conversation PDFs ("Vytvorené Cacaduu PPI …") and the programs' names
  towards OpenStreetMap and partner feeds.
- **Cloud folder:** a shop that connects OneDrive or Dropbox from now on gets the folder `/Cacaduu/<obchod>` by default.
  Shops already connected keep their folder (`/Cacadoo/…`) — nothing moves in their cloud.
- Kept as they are, because they are real names elsewhere: the GitHub repository (`novidave/cacadoo-ppi`), the Vercel
  project and its address `cacadooppivercel.vercel.app`, and one internal database function (`cacadoo_shops_near`,
  never shown to anyone).

Do the steps in order.

1. **Merge the pull request** on GitHub → Vercel deploys the new name and logo.
2. **Main domain** (once, if not done yet): Vercel → Settings → Domains: `cacaduu.com` and `www.cacaduu.com`, the www
   one set to **Redirect to cacaduu.com**. Vercel → Environment Variables: `NEXT_PUBLIC_SITE_URL` = `https://cacaduu.com`
   → **Redeploy**. Supabase → Authentication → URL Configuration: Site URL `https://cacaduu.com`, Redirect URLs +
   `https://cacaduu.com/**`. Supabase → Edge Functions → Secrets: `SITE_URL` = `https://cacaduu.com`.
3. **Functions with the new name in what they send** (Supabase → Edge Functions → the function → Code → paste the whole
   file → Deploy; "Verify JWT" stays OFF):
   - `assistant-archive` ← `supabase/functions/assistant-archive/index.ts` (the PDFs' footer and author)
   - `cloud-export` ← `supabase/functions/cloud-export/index.ts` (e-mail, the folder for new connections)
   - `domains` ← `supabase/functions/domains/index.ts` (e-mails)
   - `product-sources` ← `supabase/functions/product-sources/index.ts` (the name towards OpenStreetMap)
   - `partner-feeds` ← `supabase/functions/partner-feeds/index.ts` (the name towards partners' servers)
   - `stock-pull` changed only in comments: no need to paste it again.
4. **Optional:** if your sender address for e-mails (`ALERT_EMAIL_FROM`, Brevo) should be on the new domain, add
   cacaduu.com in Brevo (Senders & Domains) and change the secret. The OneDrive help texts now call the Microsoft app
   "Cacaduu PPI": Microsoft Entra → App registrations → your app → Branding & properties → Name → `Cacaduu PPI` (the
   name shops see when they connect; nothing else changes). The same for the Dropbox app's name if Dropbox lets you.
5. **Check:** `https://cacaduu.com/sk` shows the Cacaduu logo and "Overené v Cacaduu" under a chat answer; a new
   conversation PDF ends with "Vytvorené Cacaduu PPI".

## Part AI — Shop blog "Novinky" and the shop's Facebook Page (20 October 2026)

- Every shop gets a blog: **Môj obchod → Novinky / Blog** (its own page in the menu). "Nový článok": title, text (shown
  exactly as written), up to 10 photos, now or scheduled. The shop page shows a **"Novinky"** link as soon as there is
  one visible post; the posts are at `…/shops/<obchod>/blog` and, for a shop with its own domain, at
  `https://<doména>/blog` (with an RSS feed, sitemap, llms.txt, IndexNow and JSON-LD for Google and AI assistants).
  Free shops show their 10 newest posts, Pro shops all (the admin can change both on "Predplatné a domény").
- **Facebook Page** (once the Meta app below is set up): "Pripojiť Facebook stránku" → Facebook's login → pick the Page
  → **"Stiahnuť všetky príspevky"** brings every past post; afterwards new, edited and deleted posts follow once a day
  (within minutes with the webhook). Before each "Zverejniť" the owner is asked **"Zverejniť aj na Facebooku?"** with a
  preview; "Áno…" posts the text, the photos and "Čítať na webe: <adresa>" on the Page. Comments, reactions and other
  people's names are never read. Without the Facebook secrets the blog works and no Facebook button is shown.

Do the steps in order.

1. **Database:** SQL Editor → paste the whole file `supabase/sql/37_shop_blog.sql` → Run → "Success. No rows returned"
   (notices "… does not exist, skipping" are normal). Safe to run again. It creates the public bucket `blog-photos` and
   the job `ppi-blog-tick` (every 5 minutes; it uses the Vault secrets `ppi_project_url` and `ppi_assistant_cron` from
   part O — nothing new to add).
   Check: `select jobname, schedule from cron.job where jobname = 'ppi-blog-tick';` → one row, `3-59/5 * * * *`.
2. **New function** `shop-blog`: Supabase → Edge Functions → **Deploy a new function** → **Via Editor** → name
   `shop-blog` → paste the whole file `supabase/functions/shop-blog/index.ts` → **Deploy** → in its settings switch
   **OFF "Verify JWT"** (it checks the owners' logins, Facebook's signature, the job's secret and its own service key
   itself).
3. **Encryption key for the Page tokens:** Supabase → Edge Functions → **Secrets** → **`FB_TOKEN_ENCRYPTION_KEY`** = 48
   random characters (for example `openssl rand -base64 36` in a terminal, or a password generator). Keep it in your
   password manager; changing it later means every shop connects its Page again. (`SITE_URL`, `INDEXNOW_KEY`,
   `BREVO_API_KEY` and `ALERT_EMAIL_FROM` are already set from earlier parts.)
4. **Merge the pull request** on GitHub → Vercel deploys. Nothing to add in Vercel. The blog works now without
   Facebook: test it on a shop (Môj obchod → Novinky / Blog → Nový článok → photos → **Zverejniť** → "Zverejnené na
   webe ✓" → the "Novinky" link on the shop page).
5. **Meta app** (once, about 30 minutes; you need a personal Facebook account that is an admin of the davide.sk Page):
   1. <https://developers.facebook.com> → **My Apps** → **Create app** → use case **"Other"** → app type **"Business"** →
      name `Cacaduu PPI`, your contact e-mail, your business portfolio (Meta Business Suite; create one if asked) →
      **Create app**.
   2. **App settings → Basic:** **App domains** `cacaduu.com`; **Privacy Policy URL** `https://cacaduu.com/sk/sukromie`;
      **User data deletion** → "Data deletion instructions URL" → `https://cacaduu.com/sk/sukromie/vymazanie-udajov`;
      **Category** "Business and pages"; **App icon** 1024 × 1024 (the Cacaduu PPI logo) → **Save changes**. Copy the
      **App ID** and, after "Show", the **App secret**.
   3. **Add product → Facebook Login for Business → Set up.** In its **Settings**: Client OAuth login **Yes**, Web OAuth
      login **Yes**, Enforce HTTPS **Yes**, Use Strict Mode for redirect URIs **Yes**, **Valid OAuth Redirect URIs** =
      `https://<project>.supabase.co/functions/v1/shop-blog/oauth` (your Supabase project's address; the admin page in
      step 7 shows it exactly) → **Save changes**.
   4. **Facebook Login for Business → Configurations → Create configuration:** name `Cacaduu PPI – Novinky`, login
      variation **General**, access token **User access token**, assets **Pages**, permissions **pages_show_list**,
      **pages_read_engagement**, **pages_manage_posts** (add **pages_manage_metadata** only if you set up the webhook
      in step 6) → **Create**. Copy the **Configuration ID**.
   5. **Supabase → Edge Functions → Secrets:** **`FACEBOOK_APP_ID`** = the App ID, **`FACEBOOK_APP_SECRET`** = the App
      secret, **`FACEBOOK_CONFIG_ID`** = the Configuration ID. (Without `FACEBOOK_CONFIG_ID` the login asks for the
      three permissions by name, which also works.)
   6. **Webhook (optional, recommended):** first open the admin page (step 7) and copy the **Verify token**. Then in the
      Meta app: **Add product → Webhooks → Set up** → object **Page** → **Subscribe to this object**: Callback URL
      `https://<project>.supabase.co/functions/v1/shop-blog/webhook`, Verify token = the copied one → **Verify and
      save** → next to the field **feed** click **Subscribe**. Without the webhook the daily sync still brings every
      change (just later); Meta may also hold webhook events back until the app is Live — the sync covers that too.
   7. **Check:** `https://cacaduu.com/sk/admin/domains#blog` (your admin account) → "Facebook aplikácia: Nastavená" with
      the Redirect URI, the webhook's Callback URL and Verify token, and whether the configuration is set. "Funkcia
      shop-blog neodpovedá" = step 2 is missing.
   8. **Roles while the app is in Development mode:** App roles → Roles → add the people who will connect a Page now
      (you, the davide.sk Page admin) as **Administrator** or **Tester**; each accepts the invitation in their Facebook
      account. In Development mode only these people can connect a Page — that is enough for davide.sk.
6. **Test on davide.sk** (logged in as the shop's owner, the Facebook account from step 5.8):
   1. Môj obchod → **Novinky / Blog** → **Facebook stránka** → **Pripojiť Facebook stránku** → Facebook asks for the
      permissions → pick the davide.sk Page → **Pripojiť** → "Pripojená stránka: …". ("Osobné profily nie sú
      podporované" means the account runs no Page.)
   2. **Stiahnuť všetky príspevky** → "Sťahujem príspevky… zatiaľ n" → "Stiahnuté: n nových príspevkov." (photos keep
      arriving for a few minutes).
   3. Open `https://davide.sk/blog`: the posts, newest first, 12 per page; a post with its photos, "Pôvodný príspevok na
      Facebooku". Also `https://davide.sk/blog/rss.xml`, `https://davide.sk/sitemap.xml` (the `/blog/…` lines) and
      `https://davide.sk/llms.txt` ("## Latest news").
   4. **Nový článok** → title, text, 2 photos → **Zverejniť** → "Zverejniť aj na Facebooku?" with the preview →
      **Áno, zverejniť na webe aj na Facebooku** → "Zverejnené na webe ✓" and "Zverejnené na Facebooku ✓" → **Otvoriť
      na Facebooku**: the text, the photos and "Čítať na webe: https://davide.sk/blog/…".
   5. Edit a post on Facebook → the next day (or within minutes with the webhook) the web shows the change; delete a
      test post on Facebook → it disappears from the web ("Zmazané na Facebooku" in the list).
   6. Google's Rich Results Test (<https://search.google.com/test/rich-results>) with a post's address → "Article"
      (BlogPosting) and "Breadcrumbs" valid.
   Problems: Supabase → Edge Functions → shop-blog → Logs (tokens and post texts are never written there); the list
   shows "Na Facebook sa nepodarilo zverejniť" with Facebook's reason and **Skúsiť znova na Facebook**.
7. **Before other shops connect their Pages** (Meta's review, can take days to weeks):
   1. **Business verification:** Meta Business Suite → Settings → Security Center → **Start verification** (company
      name, address, registration number, a document).
   2. Meta app → **App Review → Permissions and Features** → request **Advanced Access** for `pages_show_list`,
      `pages_read_engagement`, `pages_manage_posts` (and `pages_manage_metadata` with the webhook). For each: what PPI
      does with it ("shows the shop's own Page posts on the shop's page"; "posts the shop's article to its own Page
      when the owner chooses 'Web + Facebook'") and a screen recording of steps 6.1–6.4.
   3. When approved: the switch at the top of the app → **App Mode: Live**.
   Until then only people with a role in the app (step 5.8) can connect a Page; everyone else's blog works without
   Facebook.
8. **Privacy texts:** `/sk/sukromie` and `/sk/sukromie/vymazanie-udajov` are drafts with "TODO" lines (operator, contact
   e-mail, retention). Replace them with the final legal text (keys `privacy.*` in `src/i18n/messages/{sk,hu,en}.json`)
   before App Review.

---

## Part AJ — Asistent page and "Obsah stránky": one slider of posts, PDFs and pictures (20 October 2026)

- **Môj obchod → Asistent** now has four sections, each only once: **Nastavenia asistenta**, **Konverzácie asistenta**
  (with the cloud folder), **Súkromné priečinky**, **Posledné nahrané súbory**. Old links (e-mails, bookmarks, the cloud
  sign-in coming back) still work: they open the section's new page.
- **Môj obchod → Obsah stránky** replaces "Sekcie stránky (PDF)": one slider on the shop page right after the opening
  hours (before the assistant; on a free page before the items), on cacaduu.com and on the own domain. It mixes
  automatic blog posts (always the newest), pinned posts, PDFs and pictures in the order the owner chooses; free shops
  up to 5 slides with 1 PDF, Pro up to 10. Every shop's existing sections are moved into its slider by the database
  update (in their old order on the page, then three automatic posts) — nothing has to be uploaded again.

Do the steps in order.

1. **Database:** SQL Editor → paste the whole file `supabase/sql/38_page_content.sql` → Run → "Success. No rows
   returned" (notices "… does not exist, skipping" are normal). Safe to run again.
   Check: `select s.slug, c.position, c.kind from shop_content_slots c join shops s on s.id = c.shop_id order by 1, 2;`
   → every shop that had sections has its rows (its sections, then `auto_post` three times).
2. **Function `page-sections`:** Supabase → Edge Functions → `page-sections` → **Code** → replace everything with the
   file `supabase/functions/page-sections/index.ts` → **Deploy** ("Verify JWT" stays OFF). No new secret.
3. **Function `shop-files`:** the same with `supabase/functions/shop-files/index.ts` → **Deploy** ("Verify JWT" stays
   OFF). (A picture's "Stiahnuť" now downloads with the picture's own extension.)
4. **Merge the pull request** on GitHub → Vercel deploys. Nothing to add in Vercel.
5. **Check on davide.sk** (log in as the shop's owner):
   - Môj obchod → **Asistent**: the four sections above, each once; **Priečinok s exportom** has only the export folder
     and "Konverzácie do počítača"; **Môj obchod** has no "Sekcie stránky (PDF)" any more.
   - Môj obchod → **Obsah stránky** → **Knižnica súborov**: the old sections are there (a single picture now shows as
     "Obrázok"). Upload a PDF and a photo from the phone (HEIC is fine) — the photo is turned upright and its location
     removed.
   - **Slider na stránke obchodu**: e.g. Automatické články 5, PDF 3 (with "Novinky október"), Pripnuté články 1,
     Obrázky 1 → choose the PDFs, the pinned post and the picture → drag the rows into your order → check the preview
     (Mobil / Počítač) → **Uložiť** → "Obsah stránky uložený."
   - The shop page (and `https://davide.sk/`): one slider after the opening hours with those 10 slides in that order,
     "1 / 10" with dots, ‹ › and swiping; a PDF opens full screen (page by page, or all pages with "Pod sebou");
     "Všetky novinky" leads to the blog.
6. **Limits** (optional): "Predplatné a domény" → **Limity obsahu stránky**: slides, of which PDFs, files in the
   library, pages per PDF and MB per file — per plan (defaults free 5 / 1 / 10 / 5 / 10, Pro 10 / 10 / 30 / 20 / 10).

## Part AK — Videos: ▶ in the slider, YouTube plays in the article (21 October 2026)

- A post with a **video** (a video or reel uploaded to the Facebook Page, or a **YouTube video shared on the Page**)
  shows a **▶** on its card in the slider and in the blog list.
- **Môj obchod → Obsah stránky → "Tlačidlo ▶ pri videách otvorí"**: *Článok na Cacaduu* (default — a YouTube video plays
  right in the article after a tap) or *Príspevok na Facebooku* (the post opens on Facebook; on a phone with the
  Facebook app it opens in the app). A post that is not on Facebook always opens the article.
- Facebook's own player is never put on your pages (no Facebook scripts): a Facebook video always plays on Facebook.

Do the steps in order.

1. **Database:** SQL Editor → paste the whole file `supabase/sql/39_video_posts.sql` → Run → "Success" (a small table
   with one number = how many older YouTube posts got their picture queued). Safe to run again.
2. **Function `shop-blog`:** Edge Functions → `shop-blog` → **Code** → replace everything with
   `supabase/functions/shop-blog/index.ts` → **Deploy** ("Verify JWT" stays OFF). No new secret.
3. **Merge the pull request** → Vercel deploys. Nothing to add in Vercel.
4. **Check on davide.sk:** post a YouTube link and a short video on the davide.sk Facebook Page (or wait for the next
   import; within minutes with the webhook) → in a few minutes the posts are in Novinky with their pictures →
   the shop page's slider shows ▶ on them → tap ▶: the article opens at the video, the YouTube video plays after a tap.
   Then Môj obchod → Obsah stránky → "Príspevok na Facebooku" → **Uložiť** → on the phone ▶ opens the post in the
   Facebook app.

## Part AL — Every language: the picker, translated shop pages, descriptions, two-language stock files (22 October 2026)

- The SK · HU · EN switch becomes a **language picker** with every EU language and more (Chinese and Vietnamese under
  "Ďalšie jazyky"), on cacaduu.com and on the shops' own domains.
- **Admin → Preklady** (menu, only for you): switch languages on/off, "Preložený vopred" (search engines), the
  interface texts per language with **"Preložiť chýbajúce texty"**, the plans' numbers and the monthly AI cost.
- **Môj obchod → Jazyky a inventár**: the shop's languages, stock files in languages (preview + encoding, a second file
  in another language) and every translation; each product has "Popis a preklady" (tabs Popis and Preklady).

Do the steps in order.

1. **Database:** SQL Editor → paste the whole file `supabase/sql/40_translations.sql` → Run → "Success". Safe to run
   again. (It moves the item names translated so far into the new table and creates the job `ppi-translate-tick`.)
2. **New function `translate`:** Edge Functions → **Deploy a new function** → **Via Editor** → name `translate` → paste
   `supabase/functions/translate/index.ts` → **Deploy** → open it → **switch OFF "Verify JWT"**.
3. **Secrets** (Edge Functions → Secrets → Add): `TRANSLATION_MONTHLY_BUDGET_EUR` = your monthly limit in euros
   (e.g. `20`) and `ADMIN_ALERT_EMAIL` = where the 80 % e-mail goes. `ANTHROPIC_API_KEY`, `BREVO_API_KEY` and
   `ALERT_EMAIL_FROM` are already there (optional `AI_MODEL`, default Claude Haiku 5.5).
4. **Function `stock-pull`:** Edge Functions → `stock-pull` → **Code** → replace everything with
   `supabase/functions/stock-pull/index.ts` → **Deploy** (encodings, preview, description/category, languages).
5. **Merge the pull request** → Vercel deploys. Nothing new in Vercel.
6. **E-mails in the signup language (Supabase → Authentication → Email Templates):** new accounts now carry
   `lang` (sk, hu, de …). In each template you can write e.g.
   `{{ if eq .Data.lang "hu" }}Magyar szöveg…{{ else if eq .Data.lang "de" }}Deutscher Text…{{ else }}Slovenský text…{{ end }}`.
   Without it the e-mails stay as they are (Slovak).
7. **Interface texts:** log in → **Preklady** (admin) → choose a language (start with Deutsch, Ελληνικά, Українська) →
   **Preložiť chýbajúce texty** → wait for "Hotovo" (about a minute per language). Read the legal texts and tick
   "Skontrolované" when they are right (until then their pages say "Strojový preklad – záväzná je slovenská verzia").
   Tick **"Preložený vopred"** in "Jazyky" for the languages search engines should find on cacaduu.com.
8. **Check on davide.sk:** Môj obchod → **Jazyky a inventár** → Preferované jazyky stránky: Deutsch, Ελληνικά,
   Українська → **Uložiť jazyky** → within 5 minutes the job translates the shop. Open davide.sk → **SK ▾** → Deutsch,
   then ελληνικά, then українська: buttons, opening hours, the slider's titles, the products (German name under the
   original), the assistant — all in that language ("Automatisch übersetzt · Original anzeigen" shows the shop's own
   words). A language you did not pick is translated on the first visit ("Prekladáme…").
9. **A description:** Môj obchod → a product → **Popis a preklady** → **Vygenerovať popis** → edit the "Návrh popisu"
   → **Uložiť a zverejniť** → it is on the product page (and in German a few minutes later).
10. **Delete and make again:** the same product → **Preklady** → Jazyk: Deutsch → at the name **Zmazať** → "preložiť
    znova pri ďalšej návšteve" → **Zmazať** ("Späť" for 30 s) → **Preložiť znova** → compare → **Použiť nový**.
11. **SK + HU files:** Jazyky a inventár → Jazyky inventára: Magyar → Uložiť; then **Súbory so skladom v jazykoch** →
    Súbor: hlavný → `public/samples/stock-sample-sk.csv` (or your own file) → preview → **Nahrať**; then Súbor: Magyar →
    `public/samples/stock-sample-hu.csv` → preview (the encoding is shown) → **Nahrať** → summary: spárované /
    nespárované / rozdiely. In **Preklady** (Jazyk: Magyar, Stav: Od obchodu) the Hungarian names are marked
    **"Od obchodu"**. A file with a column per language: `public/samples/stock-sample-2lang.csv` (approve the proposed
    "Názov HU" → Názov tovaru · Magyar in Môj obchod → columns).

## Part AM — A tidier "Tovar" list: one link per product, filters, what the shopper sees (22 October 2026)

- **Môj obchod → Jazyky a inventár → Tovar**: one short line instead of the two explanations ("Viac" opens the rest);
  above the list "Posledný súbor: <dátum a čas> · aktuálny / starší / zastaraný"; the filters **Všetko / Na sklade /
  Vypredané / Bez popisu / Chýba preklad** with their numbers; per product one link **"Popis a preklady"** (the old
  "Upraviť preklad" dropdown is gone — corrections are made on the product's "Preklady" tab); the column **"Čo vidí
  zákazník"** shows the shopper's exact text ("22 ks na sklade", "Vypredané") or, when the last file is older than
  24 hours, "Skryté – údaje sú staršie ako 24 h · Nahrať nový súbor".

1. **Database:** SQL Editor → paste the whole file `supabase/sql/41_items_list.sql` → Run → "Success". Safe to run
   again. Nothing else to set (no secrets, no functions). Until you run it, the list works without the filters.
2. **Other languages:** Admin → Preklady → **"Preložiť chýbajúce texty"** for each switched-on language other than
   SK/HU/EN (the new texts show in English there until then).
3. **Check:** Môj obchod → Jazyky a inventár → Tovar → tap each filter: the number on it = the rows listed; "Čo vidí
   zákazník" says the same as your shop page.

## Part AN — Speed, quicker taps and an error list (22 October 2026)

Nothing changes in what the pages show. Pages load faster (search, the shop page, Môj obchod lists), the map, the
shop assistant and the language list load after the page, taps answer at once, and server errors are listed for the
admin under **"Chyby za posledných 7 dní"** (no visitor data). Details and numbers: `PERFORMANCE.md`.

1. **Database:** SQL Editor → paste the whole file `supabase/sql/42_performance.sql` → Run → "Success". Safe to run
   again. It adds a stored search column with its index (can take a minute on a big catalogue), faster search and
   owner-list functions, the error list, and switches off JIT for the website's queries (if the editor says JIT could
   not be changed for the whole database, that is fine — the functions carry it themselves).
2. **New secret `REVALIDATE_SECRET`** (any random text of at least 16 characters, e.g. from a password manager):
   - Vercel → Project → Settings → Environment Variables → add `REVALIDATE_SECRET` (Production + Preview, Sensitive).
   - Supabase → Edge Functions → Secrets → add the same `REVALIDATE_SECRET`. `SITE_URL` must already be there
     (https address of the website).
   - Supabase → Edge Functions → **stock-pull** → paste the new `supabase/functions/stock-pull/index.ts` → Deploy
     (after an upload it tells the website to show the new stock at once; without the secret pages refresh within 60 s).
3. **Region:** `vercel.json` now runs the website's functions in Frankfurt (`fra1`). Check Supabase → Project Settings
   → General → Region: if it is not Frankfurt (eu-central-1), change `regions` in `vercel.json` to the nearest Vercel
   region (e.g. `dub1` for Ireland, `arn1` for Stockholm, `cdg1` for Paris) before merging.
4. **Speed Insights and Web Analytics:** Vercel → Project → Speed Insights → Enable; Analytics → Enable. Both are
   cookie-free; the privacy page already says so.
5. **Optional — Sentry:** to get server errors in Sentry as well, add `SENTRY_DSN` (Vercel environment variable).
   Without it the admin list still works.
6. **Performance check on every preview (GitHub Actions):** it runs by itself when Vercel reports a preview. Repository
   → Settings → Secrets and variables → Actions: if previews are protected, add the secret
   `VERCEL_AUTOMATION_BYPASS_SECRET` (Vercel → Project → Settings → Deployment Protection → Protection Bypass for
   Automation); add the variables `LHCI_SHOP` (a shop slug with stock) and `LHCI_ITEM` (one of its item ids).
7. **Check:** open a shop page on a phone — the map box shows at once, the map follows; Môj obchod → Jazyky a inventár →
   Tovar answers quickly; Admin → Predplatné a domény → "Chyby za posledných 7 dní" shows "Žiadne chyby…" or a list.

## Part AO — "Začať sklad odznova": delete uploaded files, remove missing products, reset and restore the stock (23 October 2026)

Môj obchod → **Priečinok s exportom** now holds "Posledné nahrané súbory" again (with **"Vymazať všetky nahrané
súbory"**) and, collapsed at the bottom, **"Nebezpečná zóna – sklad"**: remove the products missing from the last file,
delete the whole stock and start again, "Obnoviť sklad" (30 days), "Zálohy" (backup CSVs, 30 days) and "Posledné akcie".
Blog, slider, assistant, private folders, contacts, domain, subscription and opening hours are never touched.

1. **Database:** SQL Editor → paste the whole file `supabase/sql/43_inventory_reset.sql` → Run → "Success". Safe to run
   again. If it says "pg_cron is not on", switch on pg_cron (Database → Extensions) and run it once more (the daily job
   `ppi-inventory-purge` empties the 30-day trash and old backups).
2. **stock-pull:** Supabase → Edge Functions → **stock-pull** → paste the new `supabase/functions/stock-pull/index.ts` →
   Deploy ("Verify JWT" stays off). It now deletes a shop's uploaded raw files from Storage when its owner deletes them;
   until it is deployed the files disappear from the list at once and from Storage with the shop's next upload.
3. **Check on Davide Paint shop** (in this order):
   - Priečinok s exportom → Posledné nahrané súbory → "Vymazať všetky nahrané súbory" → the dialog counts the files →
     "Vymazať": the list says "Žiadny nahraný súbor · nahrajte nový", the products stay on the shop page.
   - Nebezpečná zóna – sklad → "Odstrániť chýbajúce produkty": the list shows what is missing from the last file →
     confirm: a backup CSV downloads, only those products are gone.
   - "Vymazať celý sklad" → type the shop's name → "Vymazať sklad": the CSV downloads, the shop page says
     "Sortiment sa práve aktualizuje.", Môj obchod asks for a new stock file.
   - "Obnoviť sklad" → everything is back as it was (products, quantities, prices, translations, descriptions).
   - Delete the whole stock again → upload a new file with the same codes → the translations and descriptions return.
   - At most 3 removals a day per shop; "Obnoviť sklad" is refused (with the reason) after a newer file was applied.

## Part AP — The slider's fixed frame: "Pomer strán slidera" and "Výrez" (27 October 2026)

Every slide of "Obsah stránky" now has the same frame (4:5 unless the shop picks 1:1 or 16:9), filled by its picture;
the buttons, counter and dots never move. Môj obchod shows the computer preview under the phone preview.
"Zobraziť text" is gone (the text stays for screen readers and in the viewer).

1. **Database:** SQL Editor → paste the whole file `supabase/sql/44_slider_ratio.sql` → Run → "Success". Safe to run
   again. Nothing else to deploy (no Edge Function changed, no new secrets).
2. **Check on davide.sk** (Davide Paint shop): every slide has the same 4:5 frame and the slider does not change
   height when you swipe; tap a picture or PDF → it opens whole (not cropped). Môj obchod → Obsah stránky: "Pomer strán
   slidera" and "Výrez" per picture/PDF change the previews at once; the computer preview is under the phone preview;
   "Uložiť" keeps them.

## Part AQ — "Priečinok s exportom": check after an upload, translations in a folder on the shop PC (27 October 2026)

1. **Database:** SQL Editor → paste the whole file `supabase/sql/45_export_translations.sql` → Run → "Success". Safe to
   run again. No Edge Function to deploy, no new secrets.
2. **On the shop PC (Edge or Chrome), Davide Paint shop → Priečinok s exportom:**
   - The order is: Priečinok so skladom · Po nahratí súboru · Preklady v priečinku · Posledné nahrané súbory ·
     Nebezpečná zóna. The languages and the columns are now under "Po nahratí súboru" (old links still work).
   - After the next stock file, "Nový súbor – skontrolujte" asks about new columns (leave a purchase price as
     "Súkromné – nezobrazovať") and new products (languages, "Vygenerovať popisy", "Zapamätať a už sa nepýtať").
   - "Preklady v priečinku" → **Vybrať priečinok pre preklady** → a new empty folder, e.g. `C:\Cacaduu-preklady`
     (not the export folder) → allow editing. `sklad.sk.xlsx`, `sklad.hu.xlsx`, … appear within a minute.
   - Open `sklad.hu.xlsx` in Excel, change a "Názov", save and close. Within 15 minutes (or **Skontrolovať teraz**
     after a minute) the line says "uložené zmeny: 1" and the shop page shows the new Hungarian name. Change "Popis" in
     `sklad.sk.xlsx` the same way → it is the product's description.
   - Leave a file open in Excel and click **Zapísať teraz** → "… je otvorený v Exceli"; close it → written.
   - Then "Vymazať všetky nahrané súbory", danger zone A and B (B with "Vymazať aj súbory s prekladmi" → the files
     disappear from the folder) and "Obnoviť sklad" as in Part AO.

## Part AR — "Pripojiť skladový program (API)": the stock straight from the shop's program (27 October 2026)

1. **Database:** switch on `pg_cron` and `pg_net` (Database → Extensions; already on from earlier parts), then SQL
   Editor → paste the whole file `supabase/sql/49_inventory_api.sql` → Run → "Success". Safe to run again. It adds the
   job `ppi-inventory-tick` (every 5 minutes) and its Vault secret `ppi_inventory_cron` by itself.
2. **Secret** (Edge Functions → Secrets → Add): `INVENTORY_TOKEN_ENCRYPTION_KEY` = a long random text, e.g. the output
   of `openssl rand -base64 48`. Keep it: changing it makes every stored key unreadable (the shops then see
   "Kľúč neplatný" and enter their key again). `BREVO_API_KEY` and `ALERT_EMAIL_FROM` are already there (cloud folder);
   `SITE_URL`, `REVALIDATE_SECRET` and `INDEXNOW_KEY` too (optional here: the page refreshes within a minute anyway).
   Never put this key in Vercel or `.env*`.
3. **Edge Function:** Edge Functions → Deploy a new function → name **`inventory-connect`** → paste the whole file
   `supabase/functions/inventory-connect/index.ts` → Deploy. Then its **Settings → Verify JWT: off** (the function checks
   the owner's login and the cron secret itself).
4. **Admin** (`/sk/admin/domains#inventory`, "Skladové programy (API)"): Pro every 15 minutes (default); Free is off —
   tick "Povoliť aj bez Pro" to allow it with its own interval (default 24 h). SuperFaktúra, WooCommerce and "Vlastné API"
   are on; Shoptet and Dotykačka say "Pripravujeme".
5. **Try it — Davide Paint shop → Priečinok s exportom → "Pripojiť skladový program (API)":**
   - Pick your program and follow the hint (WooCommerce: a key with "Čítať / Read"; SuperFaktúra: Nástroje → API).
     For a quick test use **Vlastné API** with any https address that returns your product list as JSON or CSV.
   - A wrong key → "Kľúč neplatný", nothing is stored. A good key → the preview (first rows, number of products, the
     fields). Check the fields ("Kód tovaru", "Názov", "Predajná cena", "Množstvo") → **Schváliť a spustiť**.
   - Within 5 minutes (or **Synchronizovať teraz**, at most 4× an hour) "Posledná úspešná synchronizácia" shows
     "X produktov, Y zmien"; then every 15 minutes. The folder and the upload now say "Sklad sa aktualizuje cez …".
   - **Odpojiť** deletes the key at once; the folder and the upload work again; the products stay.

## Part AS — POS Sync Agent, phase A: pairing and heartbeats (27 October 2026)

1. **Database:** SQL Editor → paste the whole file `supabase/sql/50_connector_pairing.sql` → Run → "Success". Safe to run
   again.
2. **Secrets** (Edge Functions → Secrets), all optional:
   - `CONNECTOR_MIN_AGENT_VERSION` — e.g. `1.0.0`; older agents get "update required" (default `0.0.0` = all allowed).
   - `CONNECTOR_API_BASE_URL` — only when the API moves (e.g. `https://api.cacaduu.com`); default
     `https://<project-ref>.supabase.co/functions/v1/connector`.
   - `API_HASH_SALT` — the same value as in Vercel (it salts the hashed caller IPs for the wrong-code limit).
   - `CONNECTOR_MAX_MB` is used from phase B on.
3. **Edge Function:** Edge Functions → Deploy a new function → name **`connector`** → paste
   `supabase/functions/connector/index.ts` → Deploy → its **Settings → Verify JWT: off**.
4. **Try it** (Davide Paint shop → Priečinok s exportom → "Prepojenie s pokladňou (POS agent)"):
   - **Pridať POS agenta** → a code like `K7QM-4WXP` (10 minutes).
   - On any computer with Node 18+:
     `node scripts/connector-test-agent.mjs pair --url https://<project-ref>.supabase.co/functions/v1/connector --code K7QM-4WXP --token-file agent.json`
     then `node scripts/connector-test-agent.mjs heartbeat --token-file agent.json --count 3 --every 60`.
   - Reload the page: "Online · Ešte nesynchronizované". Stop the script: after 3 minutes "Offline".
   - **Odpojiť** → the next heartbeat says 401. Delete `agent.json` afterwards (the real agent keeps its token in the
     system's secure storage).

## Part AT — Contact buttons on the shop page (28 October 2026)

1. **Database:** SQL Editor → paste the whole file `supabase/sql/51_contact_buttons.sql` → Run → "Success". Safe to run
   again. Every existing shop keeps the defaults (e-mail long, the rest short); nothing else changes.
2. No secrets, no Edge Function.
3. **Try it:** Davide Paint shop → Môj obchod → "Údaje obchodu": next to the phone, website, e-mail, Facebook, booking
   link and the map position there is "Tlačidlo na stránke: Krátke / Dlhé". Pick "Dlhé" for the phone → Uložiť → the
   shop page shows the phone across both columns at once (no redeploy).
4. On the phone (iPhone Safari): a quick tap on a contact button does nothing; hold it ~1 second → "Držte stlačené" with
   a filling bar → it opens (Facebook / web / booking / directions in the same tab — back returns to the shop —, e-mail
   in the mail app, phone → call; on a computer the links open in a new tab).
   Letting go early or sliding the finger off cancels. No menu or text selection appears while holding.

## Part AU — POS Sync Agent, phase B: stock snapshots and "Zdroj zásob" (28 October 2026)

1. **Database:** SQL Editor → paste the whole file `supabase/sql/52_connector_snapshots.sql` → Run → "Success". Safe to
   run again. It makes the private bucket `connector-staging`; every shop's stock source stays "Súbory".
2. **Secrets** (Edge Functions → Secrets): nothing new is needed. Supabase secrets are shared by every function, so
   `connector` already reads `SITE_URL`, `REVALIDATE_SECRET` and `INDEXNOW_KEY` (set in Parts AG and AQ) and refreshes
   the pages after an applied snapshot. Only if you want a different size limit: `CONNECTOR_MAX_MB` (the largest
   gzipped snapshot, default 20).
3. **Edge Functions** (paste the whole file → Deploy; Verify JWT stays as it was):
   - `connector` ← `supabase/functions/connector/index.ts`
   - `stock-pull` ← `supabase/functions/stock-pull/index.ts` (refuses files while the POS agent is the source)
   - `inventory-connect` ← `supabase/functions/inventory-connect/index.ts` (new message "agent")
4. **Try it** with the test stand-in (an agent paired as in Part AS, `agent.json`):
   - `node scripts/connector-test-agent.mjs snapshot --token-file agent.json --generate 25` → "test_ok": checked, not
     used, listed under "Posledné stavy skladu z POS agenta".
   - Priečinok s exportom → **Zdroj zásob** → "POS agent" → Uložiť. Wait 5 minutes (one snapshot per 5 minutes), run the
     same command again → "applied"; the shop page shows the 25 test products.
   - `node scripts/connector-test-agent.mjs confirm --token-file agent.json` → "confirmed" (only the time moves).
   - After 5 minutes `… snapshot --token-file agent.json --generate 5` → "held": the dashboard asks "Áno, použiť tento
     stav" / "Zahodiť".
   - **Zdroj zásob → Súbory** → Uložiť to go back; then upload the real file (it replaces the test products).
   - A CSV of your own: `--csv stock.csv` with the header `source_code;name;ean;brand;price;currency;quantity`.

## Part AV — POS Sync Agent, phase C: "Synchronizovať teraz" (29 October 2026)

1. **Database:** SQL Editor → paste the whole file `supabase/sql/53_connector_commands.sql` → Run → "Success". Safe to
   run again. (Update 52 must be in first.)
2. **Edge Function:** `connector` ← paste `supabase/functions/connector/index.ts` → Deploy (Verify JWT stays off). No new
   secrets.
3. **Try it** with the test stand-in (`agent.json` from Part AS; the shop's "Zdroj zásob" = POS agent, Part AU):
   - Priečinok s exportom → "Prepojenie s pokladňou (POS agent)" → **Synchronizovať teraz** → "Čaká na agenta…".
   - `node scripts/connector-test-agent.mjs sync --token-file agent.json --generate 25` → it picks the request up,
     sends a snapshot and reports it; the page shows "Hotovo – nový stav skladu prijatý".
   - Again with `--unchanged 1` → "Hotovo – sklad sa nezmenil"; with `--fail "POS nie je dostupný"` → "Nepodarilo sa: …".
   - Press it and run nothing: after 10 minutes "Agent je offline – zapnite počítač s POS agentom".
   - A 5th press within an hour → "Najviac 4 synchronizácie za hodinu".

## Part D — later, before launch

**Remove the test data:**

```sql
delete from public.shops
where slug in ('potraviny-centrum', 'drogeria-kostolne', 'zeleziarstvo-vychod', 'kisbolt-budapest');
```

---

## What is built so far

| Phase | Status |
|-------|--------|
| 1. Foundation — Next.js 16, Supabase connection, SK/HU/EN, plain white layout | ✅ done |
| 2. Database — tables, RLS, freshness, availability, `public_stock`, `search_stock`, test data, automatic checks | ✅ done |
| 2b. Europe-wide — no home town, any currency and time zone, device / IP / no location | ✅ done |
| 3. Public pages — map, shop pages, item pages, "open now", JSON-LD | ✅ done |
| 4. Login and owner dashboard | ✅ done |
| 5. AI access — robots.txt, sitemap, llms.txt, public API, MCP server | ✅ done |
| 6. Stock pull Edge Function + AI field mapping | ✅ done |
| 7. Self-service: sign-up with password, password reset, owners create shops, export folder on the dashboard, column approval; no admin area | ✅ built — set up Part E and H |
| 8. Item names in Slovak, Hungarian and English (search across languages, owner corrections); AI search on the main page | ✅ built — set up Part J |
| 9. Paid plan per shop with Stripe (Checkout, customer portal, webhook, VAT invoices, `shop_has_plan`) | ✅ built (test mode) — set up Part K |
| 10. AI assistant on the shop page (paid plan): questions, shopping lists, photos of parts | ✅ built — set up Part L |
| 11. Documents and pictures for the assistant (paid plan): PDFs, AI picture descriptions, private folders with access keys | ✅ built — set up Part M |
| 12. Shop page updates: no other shops on Pro product pages, shop e-mail and Facebook, the assistant's own texts, "Môj obchod" as dropdowns with private files and the last 10 stock files, one display rule (quantity as in the file) | ✅ built — set up Part N |
| 13. Assistant conversations (paid plan): archive with files (GPS removed), a PDF per conversation, "Konverzácie asistenta", keep time 30/90/365 days | ✅ built — set up Part O |
| 14. Cloud folder (paid plan): each finished conversation (PDF + files) copied into the shop's OneDrive or Dropbox; status per conversation, "Uložiť znova", older conversations, e-mail after 24 hours of failures | ✅ built — set up Part P |
| 15. Access keys for shoppers (paid plan): "Mám prístupový kľúč" in the assistant, folder files in a watermarked viewer, "Len zobraziť" / "Zobraziť a stiahnuť" per folder and file, ZIP, folder key and counts, the shopper's own conversation PDF | ✅ built — set up Part Q |
| 16. Own domains (Pro): buy one through PPI (search on websupport.sk, paste, pay once; registered in the shop's name at Websupport) or connect one; the shop page on its own domain; renewals, transfer code; admin page "Predplatné a domény" | ✅ built (test mode) — set up Part R |
| 17. Booking link on the shop page (every shop); no other shops on product pages of shops with a domain of their own; quick view of the recently uploaded stock files | ✅ built — set up Part S |
| 18. Open / lunch break / closed / holiday status (dots + words) everywhere, public holidays SK/HU/CZ, special days, "+ Obedňajšia prestávka"; Pro shop page order, assistant always open, no Cacaduu header on own domains | ✅ built — set up Part T |
| 19. Page sections from PDFs (Pro): up to 10 per shop, cleaned on the server, pages with their text, collapsed or always open in four places, dates, preview, download on/off, the assistant names them; the header picture of an own domain, the name and logo back on the page | ✅ built — set up Part U |
| 20. "Zobrazenie strán" per section: slider (swipe, ‹ ›, keys, "2 / 5" + dots, no jumping, current + next page loaded) or "Pod sebou"; full-screen viewer with zoom and swipe; "Stiahnuť PDF" button | ✅ built — set up Part V |
| 21. Page sections for free shops: limits per plan set by the admin (free 1 / 5 pages / 10 MB, Pro 10 / 20 / 10 MB), "Pre viac sekcií prejdite na Pro", after the opening hours on free pages, Pro → free shows the first one | ✅ built — set up Part W |
| 22. Own domain header: small clickable logo ("Logo v hlavičke webu") + SK · HU · EN; section position "Za otváracími hodinami"; page sections from pictures (JPG, PNG, WebP) | ✅ built — set up Part X |
| 23. "Odkaz loga": the own domain's header logo can lead to another address (e.g. the shop's main website) | ✅ built — set up Part Y |
| 24. Ticks on "Vaše mimoriadne dni" (delete several at once); blue "Vybrať súbor" link in page sections | ✅ built — set up Part Z |
| 25. Assistant conversations as PDF straight to the PC ("Stiahnuť PDF", "Stiahnuť vybrané"); pictures large in the PDF | ✅ built — set up Part AA |
| 26. "Konverzácie do počítača": finished conversations saved by themselves as PDFs into a folder on the shop PC | ✅ built — set up Part AB |
| 27. Own domains easy to find: "Overiť v Google Search Console" (TXT record into DNS, only added), "Odoslať sitemap", llms.txt and robots.txt per domain with "Kategórie tovaru", IndexNow after each upload (only changed pages), Product/Offer + Store JSON-LD, search results linking to the own domain | ✅ built — set up Part AC |
| 28. The main page as one AI chat: "Čo dnes hľadáte?", example questions, thinking dots and the real steps, the answer streamed, result cards with freshness, status and distance from the named town, follow-ups, "Nový chat", "Zastaviť"; the plain search as a hidden fallback | ✅ built — set up Part AD |
| 29. The chat finds products in layers: Cacaduu, then shops nearby (OpenStreetMap, optional Google Places) and offers on allowed shop websites (web search), only with too little in Cacaduu and a town; admin switches, domains, search links, usage and cost | ✅ built — set up Part AE |
| 30. Partner feeds: partners' product feeds (Google Merchant XML/CSV + local inventory, Heureka XML, own CSV) read on a schedule, shown in the chat under "Partneri" between Cacaduu and shops nearby; 48-hour rule; affiliate links marked, never ranked; admin "Partnerské feedy" | ✅ built — set up Part AF |
| 31. Own domains fully findable: "Odstrániť" removes only Cacaduu's TXT record; the Google HTML tag for connected domains; Bing Webmaster Tools; sitemap steps for Google and Bing; llms.txt with holidays and API/MCP; IndexNow on every host (one `INDEXNOW_KEY`, only real changes, once an hour per address); API/MCP links and Cacaduu's llms.txt point to the own domain | ✅ built — set up Part AG |
| 32. Quicksand font; the Cacaduu PPI logo and icons; the name Cacaduu everywhere; cacaduu.com as the main domain | ✅ built — set up Part AH |
| 33. Shop blog "Novinky": posts with photos written in Môj obchod (now or scheduled), the shop's Facebook Page connected once (all past posts imported, a daily sync, "Zverejniť aj na Facebooku?" before each post), `/blog` pages with RSS, sitemap, llms.txt, IndexNow and JSON-LD on Cacaduu and own domains; free shops show the 10 newest; privacy and data deletion pages | ✅ built — set up Part AI |
| 34. Every language: a language picker (all EU languages and more, Chinese and Vietnamese), interface texts per language, the shops' pages translated (original always kept, "Preložené automaticky"), product descriptions from the shop's own data, translations per product, the shop's languages, two-language stock files with encoding preview | ✅ built — set up Part AL |
