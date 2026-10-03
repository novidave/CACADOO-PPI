# PPI

Find which nearby shops have a product in stock right now, at what price, and how fresh that information is. Built for the whole European market: any town, currency, time zone and language.

- **Setup (Supabase + Vercel, copy & paste):** [SETUP.md](SETUP.md)
- **Product requirements:** [docs/PRD.md](docs/PRD.md)
- **Architecture:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Stack

Next.js 16 (App Router, TypeScript, Tailwind) on Vercel · Supabase (Postgres + PostGIS, Auth, Storage, Edge Functions).

## Layout

```
src/app/[lang]/        pages, one copy per language: /sk /hu /en
src/proxy.ts           sends / to the visitor's language and remembers it
src/i18n/messages/     all texts in sk.json, hu.json, en.json
src/lib/supabase/      Supabase clients (server, browser, session refresh)
src/lib/format.ts      prices in any currency (12,90 € / 1890 Ft / €12.90), times in the shop's time zone
src/lib/location.ts    visitor location: device → approximate IP city → unknown (search all shops)
supabase/migrations/   every database change, applied in file-name order
supabase/seed.sql      test shops and items (not for production)
supabase/tests/        database checks: npm run test:db
```

## Local development

```bash
cp .env.example .env.local   # fill in the Supabase URL and anon key
npm install
npm run dev                  # http://localhost:3000
```

Checks: `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test:db` (needs a local Postgres with PostGIS).
