-- PPI · 1/5 · Extensions
-- PostGIS for shop locations, unaccent + pg_trgm for accent-insensitive search.
-- Supabase keeps extensions in the "extensions" schema.

create schema if not exists extensions;

create extension if not exists postgis  with schema extensions;
create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm  with schema extensions;

-- unaccent() is not IMMUTABLE, so it cannot be used in an index directly.
-- This wrapper pins the dictionary so it can be indexed: "Káva" -> "kava".
create or replace function public.search_text(value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select lower(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(value, '')))
$$;
