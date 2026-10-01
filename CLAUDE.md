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
- Times stored in UTC, shown in Europe/Bratislava (`@/lib/format`). Prices via `formatPrice`.
- All visible text comes from `src/i18n/messages/{sk,hu,en}.json`; add every new key to all three.

## Design

Plain white background, black text, thin light-grey lines (`border-line`, `text-muted`).
**No colours**, no dark mode, no cart icons. Availability is always written out as text, emphasised in bold.
Mobile-first.

## Commands

- `npm run dev` — local site on http://localhost:3000
- `npm run lint` · `npm run typecheck` · `npm run build`
- `npm run test:db` — applies all migrations + seed to a throwaway local Postgres/PostGIS and runs the RLS and stock-logic checks
