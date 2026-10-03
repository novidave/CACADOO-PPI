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
npx supabase migration repair --status applied 20261001000001 20261001000002 20261001000003 20261001000004 20261001000005 20261003000001 20261004000001 20261005000001
```

---

## Part E — Login, owner dashboard and admin (phase 4)

### E1. Your admin account (once)

1. Supabase → **Authentication** → **Users** → **Add user** → **Create new user**.
2. Enter **your e-mail**, any long password (you will never use it), tick **Auto Confirm User** → **Create user**.
3. SQL Editor → run (with your e-mail):

```sql
update public.profiles set is_admin = true
where user_id = (select id from auth.users where email = 'YOUR-EMAIL@example.com');
```

Expected: `UPDATE 1`. If it says `UPDATE 0`, the e-mail is spelled differently than in step 2.

### E2. E-mail server (SMTP) — needed before inviting real shop owners

Supabase's built-in e-mail **only delivers to members of your Supabase team**, a few per hour, and does not let
you edit the e-mail templates. Your own login works with it; shop owners need a real e-mail service.
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

E-mails from a Gmail address sent through Brevo may land in spam at first; once PPI has its own domain,
add that domain in Brevo (Senders, Domains → Domains) and send from e.g. `info@yourdomain`.

### E3. E-mail templates (optional, after E2)

**Login and invitations already work with Supabase's default templates.** One limit: with the default
login e-mail, the link must be opened in the **same browser** where the login was requested.
To make login links work on any device, after E2 change two templates in
Supabase → **Authentication** → **Emails** → **Templates**: delete the body and paste:

**Magic Link** — body:

```html
<h2>PPI</h2>
<p>Prihlásenie do PPI / Bejelentkezés a PPI-be / Log in to PPI:</p>
<p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/dashboard">Prihlásiť sa / Belépés / Log in</a></p>
<p>Ak ste o prihlásenie nežiadali, tento e-mail ignorujte.</p>
```

**Invite user** — body:

```html
<h2>PPI</h2>
<p>Boli ste pozvaný ako majiteľ obchodu v PPI. / Meghívást kapott üzlettulajdonosként a PPI-be. / You have been invited as a shop owner on PPI.</p>
<p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite&next=/dashboard">Prijať pozvánku / Meghívás elfogadása / Accept invitation</a></p>
```

Check **Authentication → URL Configuration → Site URL** is `https://cacadooppivercel.vercel.app` (A6).

### E4. Deploy the "invite-owner" function (once)

Inviting an owner needs Supabase's secret key, so it runs inside Supabase, not on the website.

1. Supabase → **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Function name: **`invite-owner`** (exactly).
3. Delete the example code, paste the whole file `supabase/functions/invite-owner/index.ts` from GitHub.
4. **Deploy function**. Nothing else to configure: Supabase gives the function its keys itself.

### E5. Check

- [ ] `/sk/login` → enter your e-mail → "…poslali sme naň prihlasovací odkaz" → open the e-mail → you land in **Správa** (admin).
- [ ] **+ Nový obchod**: fill name, slug, city, country, time zone, click the map, add opening hours, tick **Aktívny** → **Uložiť** → the shop has a public page.
- [ ] On that shop: **Majitelia** → invite an e-mail you can read → "Pozvánka odoslaná" → open the invite e-mail → you land in **Môj obchod** for that shop.
- [ ] As the owner: hide an item → it disappears from the public shop page; switch "Čo uvidia zákazníci" → the preview and the public page change.
- [ ] As the owner, open `/sk/admin` → you are sent back to **Môj obchod**.
- [ ] **Odhlásiť sa** → `/sk/dashboard` asks you to log in again.

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
| 4. Login, owner dashboard, admin | ✅ done |
| 5. AI access — robots.txt, sitemap, llms.txt, public API, MCP server | next |
| 6. Stock pull Edge Function + AI field mapping | |
| 7. Shop PC setup (rclone + cloudflared) | |
