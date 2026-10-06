# PPI — setup guide (copy & paste)

This guide connects the code in this repository to **your** Supabase project and **your** Vercel project.
Do the steps in order. It takes about 15 minutes. You only copy two values from Supabase; nothing secret.

> **Never copy the `service_role` key** (Supabase calls it "secret" in some screens) anywhere:
> not into Vercel, not into a file, not into chat. The web app does not need it.

---

## Part A — Supabase: create the database

### A1. Open the SQL Editor

Supabase dashboard → your project → left menu **SQL Editor** → **+ New query** (a blank page opens).

### A2. Run the 5 migration files, one at a time, in this order

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
npx supabase migration repair --status applied 20261001000001 20261001000002 20261001000003 20261001000004 20261001000005 20261003000001 20261004000001 20261005000001 20261006000001 20261007000001 20261008000001 20261009000001 20261010000001 20261011000001
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

## Part G — Automatic stock pull (phase 6)

The `stock-pull` function fetches each shop's stock file every 15 minutes, proposes a field mapping for a new
file layout (you approve it once), and updates the stock. Steps, once:

### G1. Database update

Run file 11 (or the `PPI_update_7_stock_pull.sql` file) in the SQL Editor.

### G2. Secrets for the function

Supabase → **Edge Functions** → **Secrets** (or *Manage secrets*) → add:

| Name | Value |
|---|---|
| `PPI_CRON_SECRET` | a long random text you make up (40+ letters and digits, e.g. from your password manager). Keep a copy for G4. |
| `ANTHROPIC_API_KEY` | *optional* — an API key from console.anthropic.com. With it, Claude proposes the field mappings; without it, a simple rule-based guess is proposed. You approve either way. |

### G3. Deploy the function

1. Supabase → **Edge Functions** → **Deploy a new function** → **Via Editor** → name **`stock-pull`**.
2. Paste the whole file `supabase/functions/stock-pull/index.ts` → **Deploy function**.
3. Open the function → **Details** (or Settings) → switch **off** "Verify JWT" / "Enforce JWT verification" → **Save**.
   (The function checks its callers itself: the schedule's secret, or the shop owner's login for uploads.)

### G4. Run it every 15 minutes

SQL Editor → paste, **replace the two values in CAPITALS**, Run:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('https://YOUR-PROJECT-ID.supabase.co', 'ppi_project_url');
select vault.create_secret('THE-SAME-TEXT-AS-PPI_CRON_SECRET', 'ppi_cron_secret');

select cron.schedule('ppi-stock-pull', '*/15 * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_project_url') || '/functions/v1/stock-pull',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-ppi-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  )
$$);
```

To stop it later: `select cron.unschedule('ppi-stock-pull');`

### G5. Test

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
