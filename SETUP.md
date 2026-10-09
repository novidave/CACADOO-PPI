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

> **Already ran some files earlier?** Run only the newer ones, in order. Re-run the test data (A3) after file 6.

**If something goes wrong**

- *"extension … permission denied"* in file 1: go to **Database → Extensions**, switch on `postgis`, `unaccent` and `pg_trgm`, then run file 1 again.
- *"relation … already exists"*: that file was already run. Go on with the next one.
- Any other red error: stop, copy the error text and send it to Claude Code. Do not run the next file.

### A3. Add test data

Same way, copy and run **`supabase/seed.sql`**. It creates 4 test shops in two countries with 19 items:

| Test shop | Stock file age | What the site must show |
|-----------|----------------|-------------------------|
| Potraviny Centrum | 10 min | "Na sklade" / "Málo na sklade" + "Aktualizované pred 10 min" |
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

- **Site URL**: your Vercel production address, e.g. `https://cacadooppivercel.vercel.app` (you get it in Part B)
- **Redirect URLs** → **Add URL**, add each of these:
  - `http://localhost:3000/**`
  - `https://cacadooppivercel.vercel.app/**` (your real Vercel address)
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
| `NEXT_PUBLIC_SITE_URL` | your Vercel address, e.g. `https://cacadooppivercel.vercel.app` (no `/` at the end) |

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
- [ ] Search **kava** → 4 results; "Káva mletá 250 g" says **Málo na sklade · Aktualizované pred 10 min**.
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

Shop owners sign up, create their shop and connect their stock **by themselves**. There is no admin area on the
website; if you ever need to look at or fix something, use the Supabase dashboard (Table Editor / SQL Editor).

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

Check **Authentication → URL Configuration → Site URL** is `https://cacadooppivercel.vercel.app` (A6).

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

- [ ] `https://cacadooppivercel.vercel.app/robots.txt` — allows all crawlers incl. GPTBot, ClaudeBot, PerplexityBot; blocks the login-only pages.
- [ ] `https://cacadooppivercel.vercel.app/sitemap.xml` — every active shop and item (refreshed hourly).
- [ ] `https://cacadooppivercel.vercel.app/llms.txt` — plain-text guide for AI, lists the shops.
- [ ] `https://cacadooppivercel.vercel.app/api/v1/search?q=kava&near=Michalovce` — JSON results with price, availability, freshness and `source_url`.
- [ ] `https://cacadooppivercel.vercel.app/api/openapi.json` — the API description.

**Connect an AI assistant to PPI (MCP):**

- **Claude** (claude.ai): **Settings → Connectors → Add custom connector** → name `PPI`, URL
  `https://cacadooppivercel.vercel.app/mcp` → **Add**. In a new chat, ask:
  *"Using PPI, who has coffee (káva) in Michalovce right now, and when was it last updated?"*
- **ChatGPT**: in **Settings → Apps & Connectors** (developer mode may need to be switched on under
  **Advanced**) → **Create** → MCP server URL `https://cacadooppivercel.vercel.app/mcp`, no authentication.
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
   `https://cacadooppivercel.vercel.app` → method **HTML Meta Tag** → copy only the `content="…"` value.
   Vercel → Project → **Settings → Environment Variables** → add `BING_SITE_VERIFICATION` = that value
   (Production) → **Redeploy** → back in Bing → **Verify** → **Sitemaps** → submit
   `https://cacadooppivercel.vercel.app/sitemap.xml`.
2. **Google**: search.google.com/search-console → **Add property** → **URL prefix**
   `https://cacadooppivercel.vercel.app` → **HTML tag** → copy the `content="…"` value → Vercel variable
   `GOOGLE_SITE_VERIFICATION` → **Redeploy** → **Verify** → **Sitemaps** → submit `sitemap.xml`.

Indexing takes days to a few weeks. Until then an assistant finds a shop when you give it the page address
(e.g. `https://cacadooppivercel.vercel.app/sk/shops/<shop>`), and Claude finds everything at once through the
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
   site, default 500) for Production → **Redeploy**. The "Hľadať s AI" button appears only when the key is set.
5. **Check:** search "white paint" on `/en` for an item named in Slovak (after its translation); click
   **Hľadať s AI** on `/sk` with a question such as "čo potrebujem na tečúcu rúru" — an answer box appears above the
   results within a few seconds. No box: log in (Môj obchod) and try again — a note says why (only logged-in owners
   see it); or Vercel → **Logs** → search `ai-search`.

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
