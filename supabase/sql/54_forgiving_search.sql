-- =====================================================================================================================
-- Update 54: forgiving product search — the shop's "Tovar v obchode" (with its dropdown) and Cacaduu's main search.
--
-- Until now every word of a search had to appear in the item (matches_all_words), so "akril paint 0.5l" found nothing
-- in a shop that sells "Akrylové médium lesklé, 250 ml". Now one rule, in SQL, for every place that searches:
--   1. exact, as before (every word somewhere in the names, brand, EAN — and, across shops, the shop's name and town);
--      the EAN or the shop's own code typed exactly comes first of all;
--   2. forgiving, always ranked, never requiring every word: any word order; every stored language of the item's name
--      (name_i18n), its brand, category, code and EAN; accents and case ignored; per word an exact word, a prefix, or a
--      typo (edit distance ≤ 1, ≤ 2 for 7+ letters; trigram word similarity finds the candidates); simple stems
--      ("akril", "akryl", "akrylové", "acrylic" → akril); sizes read from the search and the names ("0.5l" = "0,5 l"
--      = "500 ml" = "5 dl"; the same size ranks higher, a different size never excludes); generic words ("farba",
--      "paint", "festék", "náter") count less than specific ones;
--   3. nothing at all → the most similar names ("podobné"), never an empty box for a real shop.
-- Claude's words for a search (query_expansion(), update 40) are added by the website when the search found too
-- little (once, cached 30 days). Ranking never uses a plan, a payment or anything private: only public_stock's data.
-- Paste this whole file into the Supabase SQL Editor once; safe to run again.
-- =====================================================================================================================

create extension if not exists fuzzystrmatch with schema extensions;

-- ------------------------------------------------------------------ 1. words, stems and sizes

-- One word → its stem: one common Slovak/Czech/Hungarian/English ending cut (the stem keeps at least 4 letters), then
-- c/k, y/i, w/v, ph/f spelled alike ("akrylové", "akrylový", "acrylic", "akril" → akril). Numbers and codes stay.
create or replace function public.search_stem(p_word text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  with b as (select public.search_text(p_word) as v),
  cut as (
    select coalesce((
      select left(b.v, length(b.v) - length(s))
      from unnest(array['ovanie', 'ovych', 'oveho', 'ovemu', 'ovymi', 'ovej', 'ovou', 'ovom', 'iach',
                        'ove', 'ova', 'ovy', 'ovi', 'ovu', 'eho', 'emu', 'ych', 'ich', 'ymi', 'imi', 'ami', 'ach', 'och',
                        'ies', 'es', 'ic', 'ik', 'ek', 'ok', 'ka', 'ky', 'ki', 'ke', 'ku', 'ny', 'na', 'ne', 'ni', 'nu',
                        'a', 'e', 'i', 'o', 'u', 'y', 's']) as s
      where right(b.v, length(s)) = s and length(b.v) - length(s) >= 4
      order by length(s) desc
      limit 1), b.v) as v
    from b
  )
  select case when b.v ~ '^[0-9]' then b.v
              else translate(replace(replace(cut.v, 'ph', 'f'), 'ck', 'k'), 'cyqw', 'kikv') end
  from b, cut
$$;

-- A size in the text as "<dimension>:<amount in the base unit>": ml (l, dl, cl, ml), g (kg, g), mm (m, cm, mm), ks.
-- "0.5l", "0,5 l", "500 ml" and "5 dl" are all "ml:500".
create or replace function public.search_sizes(p_text text)
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(array_agg(distinct
    case u
      when 'l' then 'ml:' when 'dl' then 'ml:' when 'cl' then 'ml:' when 'ml' then 'ml:'
      when 'kg' then 'g:' when 'g' then 'g:'
      when 'm' then 'mm:' when 'cm' then 'mm:' when 'mm' then 'mm:'
      else 'ks:'
    end ||
    trim(trailing '.' from trim(trailing '0' from to_char(round(n * case u
      when 'l' then 1000 when 'dl' then 100 when 'cl' then 10 when 'kg' then 1000
      when 'm' then 1000 when 'cm' then 10 else 1 end, 2), 'FM9999999990.00'))))
    filter (where n > 0), '{}')
  from (
    select replace(m[1], ',', '.')::numeric as n, m[2] as u
    from regexp_matches(public.search_text(p_text), '(\d+(?:[.,]\d+)?)\s*(ml|cl|dl|l|kg|g|mm|cm|m|ks)(?![a-z0-9])', 'g') as m
  ) s
$$;

-- The text without its sizes (the words of a search are matched apart from its sizes).
create or replace function public.search_without_sizes(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select regexp_replace(public.search_text(p_text), '(\d+(?:[.,]\d+)?)\s*(ml|cl|dl|l|kg|g|mm|cm|m|ks)(?![a-z0-9])', ' ', 'g')
$$;

-- The distinct stems of a text (letters and digits; single letters dropped, single digits kept).
create or replace function public.search_tokens(p_text text)
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(array_agg(distinct public.search_stem(t)), '{}')
  from unnest(regexp_split_to_array(regexp_replace(public.search_text(p_text), '[^a-z0-9]+', ' ', 'g'), ' ')) as t
  where t <> '' and (length(t) > 1 or t ~ '^[0-9]$')
$$;

-- The same stems as one text " akril medium lesk 250 " (what the trigram index searches).
create or replace function public.search_stems_text(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select ' ' || coalesce((select string_agg(t, ' ' order by t) from unnest(public.search_tokens(p_text)) as t), '') || ' '
$$;

-- Words that say little about which product is meant (paint, colour, coating …): they count a third.
create or replace function public.search_generic(p_stem text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_stem in (select public.search_stem(w) from unnest(array['farba', 'farby', 'farieb', 'farbu', 'paint', 'paints',
    'festék', 'festékek', 'náter', 'nátery', 'barva', 'barvy', 'farbe', 'farben', 'color', 'colour', 'produkt',
    'tovar']) as w)
$$;

-- How well one search stem matches an item's stems: 1 the same word, 0.85 the word's beginning, 0.8 the item's word
-- is the beginning of the search word, 0.6 a typo (edit distance ≤ 1, ≤ 2 for 7+ letters), 0.5 a typo in a prefix.
create or replace function public.search_word_match(p_word text, p_tokens text[])
returns real
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(max(case
    when t = p_word then 1.0
    when length(p_word) >= 3 and left(t, length(p_word)) = p_word then 0.85
    when length(t) >= 4 and left(p_word, length(t)) = t then 0.8
    when p_word ~ '^[0-9]' or t ~ '^[0-9]' then 0
    when length(p_word) >= 4 and abs(length(t) - length(p_word)) <= 2
         and extensions.levenshtein(p_word, t) <= case when length(p_word) >= 7 then 2 else 1 end then 0.6
    when length(p_word) >= 5 and length(t) > length(p_word)
         and extensions.levenshtein(p_word, left(t, length(p_word))) <= 1 then 0.5
    else 0 end), 0)::real
  from unnest(p_tokens) as t
$$;

-- ------------------------------------------------------------------ 2. what an item can be found by

-- Every item's stems (names in every language, brand, category, code, EAN) and sizes, kept by the database itself.
-- Made again on every run of this file, so they always follow the rules above.
alter table public.shop_items drop column if exists search_stems;
alter table public.shop_items drop column if exists search_sizes;
alter table public.shop_items add column search_stems text
  generated always as (public.search_stems_text(
    public.item_names_text(name, name_i18n) || ' ' || coalesce(brand, '') || ' ' || coalesce(category, '') || ' ' ||
    coalesce(source_code, '') || ' ' || coalesce(ean, ''))) stored;
alter table public.shop_items add column search_sizes text[]
  generated always as (public.search_sizes(name)) stored;
create index if not exists shop_items_search_stems_idx on public.shop_items using gin (search_stems extensions.gin_trgm_ops);
create index if not exists shop_items_search_sizes_idx on public.shop_items using gin (search_sizes);

-- Every shop's name, address and town as the search compares them (the exact step: "farba Budince").
alter table public.shops drop column if exists search_words;
alter table public.shops add column search_words text
  generated always as (public.search_text(name || ' ' || coalesce(address, '') || ' ' || coalesce(city, ''))) stored;

-- The words of a search: its stems (sizes apart), each with its weight (a third for generic words) and the word as
-- typed, plus its sizes. Used once per search.
drop function if exists public.search_query(text);
create or replace function public.search_query(p_q text)
returns table (stems text[], weights real[], typed text[], sizes text[], specific boolean, starts text[])
language sql
immutable
parallel safe
set search_path = ''
as $$
  with w as (
    select distinct on (public.search_stem(t)) public.search_stem(t) as stem, t as typed
    from unnest(regexp_split_to_array(regexp_replace(public.search_without_sizes(p_q), '[^a-z0-9]+', ' ', 'g'), ' ')) as t
    where t <> '' and (length(t) > 1 or t ~ '^[0-9]$')
    order by public.search_stem(t), t
  ),
  w8 as (select * from w order by length(w.stem) desc, w.stem limit 8)
  select
    coalesce(array_agg(w.stem order by w.stem), '{}'),
    coalesce(array_agg(case when public.search_generic(w.stem) then 0.34 else 1 end::real order by w.stem), '{}'),
    coalesce(array_agg(w.typed order by w.stem), '{}'),
    public.search_sizes(p_q),
    coalesce(bool_or(not public.search_generic(w.stem)), false),
    -- "% akr%": an item's word must begin like one of the search's words (first 3 letters) to be looked at closer
    coalesce(array_agg('% ' || left(w.stem, 3) || '%'), '{}')
  from w8 as w
$$;

-- One item against a search: the share of the search's weight it matches (0..1), whether a specific word matched,
-- the size bonus and the search words it matched (for highlighting).
create or replace function public.search_score(p_tokens text[], p_sizes text[], p_stems text[], p_weights real[],
                                               p_qsizes text[])
returns table (coverage real, specific_hit boolean, size_hit boolean, matched text[])
language sql
immutable
parallel safe
set search_path = ''
as $$
  with m as (
    select s.stem, s.weight, public.search_word_match(s.stem, p_tokens) as hit
    from unnest(p_stems, p_weights) as s(stem, weight)
  )
  select
    coalesce(sum(m.weight * m.hit) / nullif(sum(m.weight), 0), 0)::real,
    coalesce(bool_or(m.hit > 0 and m.weight >= 1), false),
    coalesce(p_sizes && p_qsizes, false),
    coalesce(array_agg(m.stem) filter (where m.hit > 0), '{}')
  from m
$$;

-- The fast check of one search stem against an item's stems text (no SET clause, so the planner inlines it): 1 the
-- same word, 0.85 a word that starts with it, 0.6 a close word by trigram word similarity (typos). The precise rule
-- above (search_word_match: the item's shorter words, edit distance) refines the best few hundred rows only.
create or replace function public.search_quick_match(p_word text, p_stems text)
returns real
language sql
immutable
parallel safe
as $$
  select case
    when p_stems like '% ' || p_word || ' %' then 1.0
    when length(p_word) >= 3 and p_stems like '% ' || p_word || '%' then 0.85
    when p_word ~ '^[0-9]' then 0.0
    -- a typo rarely changes the first two letters: only then the (slower) trigram similarity
    when length(p_word) >= 4 and p_stems like '% ' || left(p_word, 2) || '%'
         and extensions.word_similarity(p_word, p_stems) >= 0.5 then 0.6
    else 0.0
  end::real
$$;

-- The fast check for a whole search (its first 8 words), one value per word, as one expression the planner inlines.
create or replace function public.search_quick_hits(p_stems text, p_words text[])
returns real[]
language sql
immutable
parallel safe
as $$
  select array[
    case when p_words[1] is null then 0 else public.search_quick_match(p_words[1], p_stems) end,
    case when p_words[2] is null then 0 else public.search_quick_match(p_words[2], p_stems) end,
    case when p_words[3] is null then 0 else public.search_quick_match(p_words[3], p_stems) end,
    case when p_words[4] is null then 0 else public.search_quick_match(p_words[4], p_stems) end,
    case when p_words[5] is null then 0 else public.search_quick_match(p_words[5], p_stems) end,
    case when p_words[6] is null then 0 else public.search_quick_match(p_words[6], p_stems) end,
    case when p_words[7] is null then 0 else public.search_quick_match(p_words[7], p_stems) end,
    case when p_words[8] is null then 0 else public.search_quick_match(p_words[8], p_stems) end]::real[]
$$;

-- From those values: the share of the search's weight matched, and whether a specific (not generic) word matched.
create or replace function public.search_quick_cov(p_hits real[], p_weights real[])
returns real
language sql
immutable
parallel safe
as $$
  select (coalesce(p_hits[1] * p_weights[1], 0) + coalesce(p_hits[2] * p_weights[2], 0) + coalesce(p_hits[3] * p_weights[3], 0) + coalesce(p_hits[4] * p_weights[4], 0) + coalesce(p_hits[5] * p_weights[5], 0) + coalesce(p_hits[6] * p_weights[6], 0) + coalesce(p_hits[7] * p_weights[7], 0) + coalesce(p_hits[8] * p_weights[8], 0))
         / nullif(coalesce(p_weights[1], 0) + coalesce(p_weights[2], 0) + coalesce(p_weights[3], 0) + coalesce(p_weights[4], 0) + coalesce(p_weights[5], 0) + coalesce(p_weights[6], 0) + coalesce(p_weights[7], 0) + coalesce(p_weights[8], 0), 0)
$$;

create or replace function public.search_quick_spec(p_hits real[], p_weights real[])
returns boolean
language sql
immutable
parallel safe
as $$
  select coalesce((p_hits[1] > 0 and p_weights[1] >= 1) or (p_hits[2] > 0 and p_weights[2] >= 1) or (p_hits[3] > 0 and p_weights[3] >= 1) or (p_hits[4] > 0 and p_weights[4] >= 1) or (p_hits[5] > 0 and p_weights[5] >= 1) or (p_hits[6] > 0 and p_weights[6] >= 1) or (p_hits[7] > 0 and p_weights[7] >= 1) or (p_hits[8] > 0 and p_weights[8] >= 1), false)
$$;

-- How many specific words of the search the item missed. A forgiving match may miss none, or one of three or more
-- ("white chocolate" never finds a white paint; a long search may miss one of its words).
create or replace function public.search_quick_missing(p_hits real[], p_weights real[])
returns integer
language sql
immutable
parallel safe
as $$
  select (case when p_weights[1] >= 1 and coalesce(p_hits[1], 0) = 0 then 1 else 0 end
        + case when p_weights[2] >= 1 and coalesce(p_hits[2], 0) = 0 then 1 else 0 end
        + case when p_weights[3] >= 1 and coalesce(p_hits[3], 0) = 0 then 1 else 0 end
        + case when p_weights[4] >= 1 and coalesce(p_hits[4], 0) = 0 then 1 else 0 end
        + case when p_weights[5] >= 1 and coalesce(p_hits[5], 0) = 0 then 1 else 0 end
        + case when p_weights[6] >= 1 and coalesce(p_hits[6], 0) = 0 then 1 else 0 end
        + case when p_weights[7] >= 1 and coalesce(p_hits[7], 0) = 0 then 1 else 0 end
        + case when p_weights[8] >= 1 and coalesce(p_hits[8], 0) = 0 then 1 else 0 end)
$$;

-- The same rule as one test: a row may count as a forgiving match.
create or replace function public.search_quick_ok(p_hits real[], p_weights real[])
returns boolean
language sql
immutable
parallel safe
as $$
  select public.search_quick_missing(p_hits, p_weights)
         <= case when (select count(*) from unnest(p_weights[1:8]) w where w >= 1) >= 3 then 1 else 0 end
$$;

-- ------------------------------------------------------------------ 3. one shop: "Tovar v obchode", its dropdown, the
--                                                                       shop assistant's search_items

-- kind: 'exact' (every word, as before; a typed EAN or code comes first), 'match' (forgiving), 'similar' (nothing
-- matched: the closest names). total_count = how many 'exact' + 'match' rows there are (or the 'similar' ones).
create or replace function public.shop_item_search(p_slug text, p_q text, p_limit integer default 8,
                                                   p_offset integer default 0)
returns table (item_id uuid, item_name text, ean text, brand text, category text, price numeric, currency text,
               quantity numeric, availability text, is_available boolean, freshness_state text,
               freshness_age_minutes integer, latest_file_time timestamptz, updated_at timestamptz,
               item_name_lang text, item_name_i18n jsonb, score real, kind text, matched text[], total_count bigint)
language sql
stable
security definer
set search_path = ''
set jit = off
as $$
  with q as materialized (
    select sq.*, nullif(trim(coalesce(p_q, '')), '') as raw, public.search_patterns(p_q) as patterns,
           public.search_text(p_q) as norm
    from public.search_query(left(coalesce(p_q, ''), 200)) sq
  ),
  items as materialized (
    select si.id, si.search_stems, si.search_sizes, si.names_search, si.source_code,
           coalesce(si.ean, p.ean) as ean, coalesce(si.brand, p.brand) as brand
    from public.shops sh
    join public.shop_items si on si.shop_id = sh.id
    left join public.products p on p.id = si.product_id
    where sh.slug = p_slug and sh.is_active
  ),
  -- every item of the shop, the fast check
  quick as (
    select i.*, w.cov, w.spec, coalesce(i.search_sizes && q.sizes, false) as size_hit,
      (i.ean = q.raw or lower(i.source_code) = lower(q.raw)) as code_hit,
      (i.names_search like all (q.patterns)
       or (i.names_search || ' ' || lower(coalesce(i.brand, '') || ' ' || coalesce(i.ean, '') || ' ' ||
           coalesce(i.source_code, ''))) like all (q.patterns)) as all_words
    from items i
    cross join q
    cross join lateral (
      select coalesce(public.search_quick_cov(z.hits, q.weights), 0)::real as cov,
             coalesce(public.search_quick_spec(z.hits, q.weights), false)
               and coalesce(public.search_quick_ok(z.hits, q.weights), false) as spec
      from (select case when i.search_stems like any (q.starts)  -- a word that begins like one of the search's
                        then public.search_quick_hits(i.search_stems, q.stems) end as hits) z) w
    where q.raw is not null
  ),
  hits as (
    select h.* from quick h, q
    where h.code_hit or h.all_words or (h.cov > 0 and (h.spec or not q.specific))
       -- only a size ("500 ml"): the items of that size
       or (cardinality(q.stems) = 0 and h.size_hit)
  ),
  -- the best rows, refined with the precise rule (the item's shorter words, typos by edit distance)
  best as (
    select h.*, p.cov2, p.matched,
      (case when h.code_hit then 100 else 0 end + case when h.all_words then 10 else 0 end + p.cov2
       + case when h.size_hit then 0.25 else 0 end)::real as score_,
      case when h.code_hit or h.all_words then 'exact' else 'match' end as kind_
    from (select * from hits
          order by code_hit desc, all_words desc, cov desc
          limit greatest(coalesce(p_offset, 0), 0) + least(greatest(coalesce(p_limit, 8), 1), 100) + 40) h
    cross join q
    cross join lateral (
      select coalesce(sum(x.weight * x.hit) / nullif(sum(x.weight), 0), 0)::real as cov2,
             coalesce(array_agg(x.stem) filter (where x.hit > 0), '{}') as matched
      from (select u.stem, u.weight,
                   (select case when m >= 0.85 then m
                                else greatest(m, public.search_word_match(u.stem, string_to_array(trim(h.search_stems), ' ')))
                           end
                    from (select public.search_quick_match(u.stem, h.search_stems) as m) mm) as hit
            from unnest(q.stems, q.weights) as u(stem, weight)) x) p
  ),
  -- nothing matched: the closest names
  near_names as (
    select i.id, extensions.word_similarity(q.norm, i.names_search)::real as score_
    from items i, q
    where q.raw is not null and not exists (select 1 from hits)
      and extensions.word_similarity(q.norm, i.names_search) > 0.15
    order by 2 desc
    limit 50
  ),
  rows_ as (
    select b.id, b.score_, b.kind_, b.matched from best b
    union all
    select n.id, n.score_, 'similar', '{}'::text[] from near_names n
  )
  select ps.item_id, ps.item_name, ps.ean, ps.brand, ps.category, ps.price, ps.currency, ps.quantity, ps.availability,
         ps.is_available, ps.freshness_state, ps.freshness_age_minutes, ps.latest_file_time, ps.updated_at,
         ps.item_name_lang, ps.item_name_i18n,
         (r.score_ + case when ps.is_available then 0.05 else 0 end)::real, r.kind_, r.matched,
         coalesce(nullif((select count(*) from hits), 0), (select count(*) from near_names)) as total_count
  from rows_ r
  -- one row at a time by its id (offset 0 keeps the planner from reading the whole view)
  cross join lateral (select * from public.public_stock x where x.item_id = r.id offset 0) ps
  order by 17 desc, ps.is_available desc, ps.item_name, ps.item_id
  limit least(greatest(coalesce(p_limit, 8), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0)
$$;
revoke execute on function public.shop_item_search(text, text, integer, integer) from public;
grant execute on function public.shop_item_search(text, text, integer, integer) to anon, authenticated, service_role;

-- The shop's list ("Tovar v obchode", the public API's items, the shop assistant): without words as before (by
-- name); with words the forgiving search's order (the closest names when nothing matched). Same output as before.
create or replace function public.shop_stock(p_slug text, q text default null, p_limit integer default 50,
                                             p_offset integer default 0)
returns table (item_id uuid, item_name text, ean text, brand text, price numeric, currency text, quantity numeric,
               availability text, is_available boolean, freshness_state text, freshness_age_minutes integer,
               latest_file_time timestamptz, updated_at timestamptz, total_count bigint, item_name_lang text,
               item_name_i18n jsonb)
language sql
stable
set search_path = ''
as $$
  (select ps.item_id, ps.item_name, ps.ean, ps.brand, ps.price, ps.currency, ps.quantity, ps.availability,
         ps.is_available, ps.freshness_state, ps.freshness_age_minutes, ps.latest_file_time, ps.updated_at,
         count(*) over () as total_count, ps.item_name_lang, ps.item_name_i18n
  from public.public_stock ps
  where ps.shop_slug = shop_stock.p_slug and nullif(trim(coalesce(shop_stock.q, '')), '') is null
  order by ps.item_name, ps.item_id
  limit least(greatest(coalesce(shop_stock.p_limit, 50), 1), 100)
  offset greatest(coalesce(shop_stock.p_offset, 0), 0))
  union all
  (select s.item_id, s.item_name, s.ean, s.brand, s.price, s.currency, s.quantity, s.availability, s.is_available,
          s.freshness_state, s.freshness_age_minutes, s.latest_file_time, s.updated_at, s.total_count,
          s.item_name_lang, s.item_name_i18n
   from public.shop_item_search(shop_stock.p_slug, shop_stock.q, shop_stock.p_limit, shop_stock.p_offset) s
   where nullif(trim(coalesce(shop_stock.q, '')), '') is not null)
$$;

-- ------------------------------------------------------------------ 4. every shop: the main search, API and MCP

-- The exact search of update 42 (every word in the names, brand, EAN or the shop's name/address/town), kept as it was.
create or replace function public.search_stock_exact(q text default null, lat double precision default null,
                                                     lng double precision default null,
                                                     radius_km double precision default 10,
                                                     only_available boolean default false)
returns table (item_id uuid, item_name text, ean text, brand text, shop_id uuid, shop_slug text, shop_name text,
               shop_address text, shop_city text, shop_country text, shop_timezone text, shop_lat double precision,
               shop_lng double precision, price numeric, currency text, quantity numeric, availability text,
               is_available boolean, freshness_state text, freshness_age_minutes integer, latest_file_time timestamptz,
               updated_at timestamptz, distance_km double precision, item_name_lang text, item_name_i18n jsonb)
language sql
stable
security definer
set search_path = ''
set jit = off
as $$
  with term as materialized (
    select
      case
        when search_stock_exact.lat between -90 and 90 and search_stock_exact.lng between -180 and 180
        then extensions.st_setsrid(
               extensions.st_makepoint(search_stock_exact.lng, search_stock_exact.lat), 4326
             )::extensions.geography
      end as here,
      least(greatest(coalesce(search_stock_exact.radius_km, 10), 0.1), 500) * 1000 as radius_m,
      nullif(trim(coalesce(search_stock_exact.q, '')), '') as raw_q,
      public.search_patterns(search_stock_exact.q) as patterns
  ),
  word as (
    select '%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%' as pattern
    from term t, unnest(regexp_split_to_array(public.search_text(t.raw_q), '\s+')) as w
    where w <> ''
    order by length(w) desc
    limit 1
  ),
  -- Items that can match: the longest word in the names, the brand, the shop's name/address/town or the EAN.
  candidate as (
    select si.id from public.shop_items si, word
    where si.names_search like word.pattern
    union
    select si.id from public.shop_items si, word
    where public.search_text(si.brand) like word.pattern
    union
    select si.id from public.shop_items si
    join public.products p on p.id = si.product_id, word
    where public.search_text(p.brand) like word.pattern
    union
    select si.id from public.shop_items si
    join public.shops sh on sh.id = si.shop_id, word
    where public.search_text(coalesce(sh.name, '') || ' ' || coalesce(sh.address, '') || ' ' || coalesce(sh.city, ''))
          like word.pattern
    union
    select si.id from public.shop_items si
    left join public.products p on p.id = si.product_id, word
    where coalesce(si.ean, p.ean) like word.pattern
    union
    select si.id from public.shop_items si, term t
    where si.ean = t.raw_q
  ),
  -- The shop's name, address and town as the search compares them: once per shop, not once per item.
  shop_text as (
    select sh.id, public.search_text(sh.name || ' ' || coalesce(sh.address, '') || ' ' || coalesce(sh.city, '')) as words
    from public.shops sh
  ),
  -- No words: every item (the nearby list). Words: only the candidates, each word must match the item's names,
  -- brand, EAN or its shop's name/address/town (when the names alone have every word, nothing more is computed).
  found as (
    select ps.*
    from public.public_stock ps, term t
    where t.raw_q is null
    union all
    select ps.*
    from candidate c
    join public.shop_items si on si.id = c.id
    join public.public_stock ps on ps.item_id = c.id
    join shop_text st on st.id = ps.shop_id
    cross join term t
    where t.raw_q is not null
      and (
        ps.ean = t.raw_q
        or case
             when si.names_search like all (t.patterns) then true
             else (si.names_search || ' ' ||
                   public.search_text(coalesce(ps.brand, '') || ' ' || coalesce(ps.ean, '')) || ' ' || st.words)
                  like all (t.patterns)
           end
      )
  ),
  matched as (
    select
      f.*,
      case when t.here is not null
        then round((extensions.st_distance(f.shop_location, t.here) / 1000)::numeric, 2)::double precision
      end as distance_km
    from found f
    cross join term t
    where (t.here is null or extensions.st_dwithin(f.shop_location, t.here, t.radius_m))
      and (not coalesce(search_stock_exact.only_available, false) or f.is_available)
  )
  select
    m.item_id, m.item_name, m.ean, m.brand,
    m.shop_id, m.shop_slug, m.shop_name, m.shop_address, m.shop_city,
    m.shop_country, m.shop_timezone, m.shop_lat, m.shop_lng,
    m.price, m.currency, m.quantity, m.availability, m.is_available,
    m.freshness_state, m.freshness_age_minutes, m.latest_file_time, m.updated_at,
    m.distance_km, m.item_name_lang, m.item_name_i18n
  from matched m
  order by
    m.is_available desc,
    case m.freshness_state when 'current' then 0 when 'recent' then 1 else 2 end,
    m.distance_km nulls last,
    m.item_name
  limit 50
$$;
revoke execute on function public.search_stock_exact(text, double precision, double precision, double precision, boolean)
  from public, anon, authenticated;

-- Across shops: the exact rows first (as before), then the forgiving ones; within the same score: in stock with current
-- data, then fresher data, then nearer (only when the shopper named a place). Never a plan or a payment.
create or replace function public.item_search(p_q text, p_lat double precision default null,
                                              p_lng double precision default null, p_radius_km double precision default 10,
                                              p_only_available boolean default false, p_limit integer default 50)
returns table (item_id uuid, item_name text, ean text, brand text, category text, shop_id uuid, shop_slug text,
               shop_name text, shop_address text, shop_city text, shop_country text, shop_timezone text,
               shop_lat double precision, shop_lng double precision, price numeric, currency text, quantity numeric,
               availability text, is_available boolean, freshness_state text, freshness_age_minutes integer,
               latest_file_time timestamptz, updated_at timestamptz, distance_km double precision,
               item_name_lang text, item_name_i18n jsonb, score real, kind text, matched text[])
language sql
stable
security definer
set search_path = ''
set jit = off
set pg_trgm.word_similarity_threshold = 0.5
as $$
  with q as materialized (
    select sq.*, nullif(trim(coalesce(p_q, '')), '') as raw, public.search_patterns(p_q) as patterns,
      case when p_lat between -90 and 90 and p_lng between -180 and 180
        then extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography end as here,
      least(greatest(coalesce(p_radius_km, 10), 0.1), 500) * 1000 as radius_m
    from public.search_query(left(coalesce(p_q, ''), 200)) sq
  ),
  -- the words that pick candidates: the specific ones (all of them when the search has only generic words)
  pick as (
    select u.stem from q, unnest(q.stems, q.weights) as u(stem, weight) where u.weight >= 1 or not q.specific
  ),
  -- the longest typed word, as the exact search of update 42 picked its candidates (also inside other words)
  longest as (
    select '%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%' as pattern
    from q, unnest(regexp_split_to_array(public.search_text(q.raw), '\s+')) as w
    where w <> '' order by length(w) desc limit 1
  ),
  shop_t as materialized (
    select sh.id, sh.search_words as words
    from public.shops sh, q
    where sh.is_active and (q.here is null or extensions.st_dwithin(sh.location, q.here, q.radius_m))
  ),
  -- forgiving candidates: items with a word that begins like a search word …
  prefix_candidate as (
    select x.id from (
      select si.id from public.shop_items si, pick
      where si.search_stems like '% ' || left(pick.stem, greatest(3, length(pick.stem) - 2)) || '%'
      union
      select si.id from public.shop_items si, q where cardinality(q.stems) = 0 and si.search_sizes && q.sizes
    ) x
    limit 3000  -- a very common word: the first 3 000 are enough to rank
  ),
  -- … and, only when those are few (a typo), items with a close word by trigram similarity
  fuzzy_candidate as (
    select id from prefix_candidate
    union
    select si.id from public.shop_items si, pick
    where length(pick.stem) >= 4 and pick.stem operator(extensions.<%) si.search_stems
      and (select count(*) from prefix_candidate) < 300
  ),
  -- the exact search's candidates are always kept
  candidate as (
    select id from fuzzy_candidate
    union
    select si.id from public.shop_items si, longest where si.names_search like longest.pattern
    union
    select si.id from public.shop_items si join shop_t st on st.id = si.shop_id, longest
    where st.words like longest.pattern
    union
    select si.id from public.shop_items si, q where si.ean = q.raw
    union
    select si.id from public.products p join public.shop_items si on si.product_id = p.id, q where p.ean = q.raw
  ),
  quick as (
    select si.id, si.search_stems as stems, si.search_sizes, w.cov, w.spec,
      coalesce(si.search_sizes && q.sizes, false) as size_hit,
      (coalesce(si.ean, si.p_ean) = q.raw) as code_hit,
      (si.names_search like all (q.patterns)
       or (si.names_search || ' ' || lower(coalesce(si.brand, si.p_brand, '') || ' ' || coalesce(si.ean, si.p_ean, ''))
           || ' ' || si.shop_words) like all (q.patterns)) as all_words
    from candidate c
    cross join q
    -- one item at a time by its id, with its shop's words (offset 0 keeps the planner from reading whole tables)
    cross join lateral (
      select x.*, sh.search_words as shop_words, p.brand as p_brand, p.ean as p_ean
      from public.shop_items x
      join public.shops sh on sh.id = x.shop_id and sh.is_active
      left join public.products p on p.id = x.product_id
      where x.id = c.id and (q.here is null or extensions.st_dwithin(sh.location, q.here, q.radius_m))
      offset 0) si
    cross join lateral (
      select coalesce(public.search_quick_cov(z.hits, q.weights), 0)::real as cov,
             coalesce(public.search_quick_spec(z.hits, q.weights), false)
               and coalesce(public.search_quick_ok(z.hits, q.weights), false) as spec
      from (select case when si.search_stems like any (q.starts)
                        then public.search_quick_hits(si.search_stems, q.stems) end as hits) z) w
    where q.raw is not null
  ),
  hits as (
    select h.* from quick h, q
    where h.code_hit or h.all_words or (h.cov > 0 and (h.spec or not q.specific))
       or (cardinality(q.stems) = 0 and h.size_hit)
    order by h.code_hit desc, h.all_words desc, h.cov desc
    limit 100
  ),
  best as (
    select h.id, p.matched,
      (case when h.code_hit then 100 else 0 end + case when h.all_words then 10 else 0 end + p.cov2
       + case when h.size_hit then 0.25 else 0 end)::real as score_,
      case when h.code_hit or h.all_words then 'exact' else 'match' end as kind_
    from hits h
    cross join q
    cross join lateral (
      select coalesce(sum(x.weight * x.hit) / nullif(sum(x.weight), 0), 0)::real as cov2,
             coalesce(array_agg(x.stem) filter (where x.hit > 0), '{}') as matched
      from (select u.stem, u.weight,
                   (select case when m >= 0.85 then m
                                else greatest(m, public.search_word_match(u.stem, string_to_array(trim(h.stems), ' ')))
                           end
                    from (select public.search_quick_match(u.stem, h.stems) as m) mm) as hit
            from unnest(q.stems, q.weights) as u(stem, weight)) x) p
  )
  select ps.item_id, ps.item_name, ps.ean, ps.brand, ps.category, ps.shop_id, ps.shop_slug, ps.shop_name,
         ps.shop_address, ps.shop_city, ps.shop_country, ps.shop_timezone, ps.shop_lat, ps.shop_lng, ps.price,
         ps.currency, ps.quantity, ps.availability, ps.is_available, ps.freshness_state, ps.freshness_age_minutes,
         ps.latest_file_time, ps.updated_at,
         case when q.here is not null
           then round((extensions.st_distance(ps.shop_location, q.here) / 1000)::numeric, 2)::double precision end,
         ps.item_name_lang, ps.item_name_i18n, b.score_, b.kind_, b.matched
  from best b
  cross join lateral (select * from public.public_stock x where x.item_id = b.id offset 0) ps
  cross join q
  where not coalesce(p_only_available, false) or ps.is_available
  order by b.score_ desc,
    (ps.is_available and ps.freshness_state in ('current', 'recent')) desc,
    case ps.freshness_state when 'current' then 0 when 'recent' then 1 else 2 end,
    24 nulls last,
    ps.item_name, ps.item_id
  limit least(greatest(coalesce(p_limit, 50), 1), 100)
$$;
revoke execute on function public.item_search(text, double precision, double precision, double precision, boolean, integer)
  from public;
grant execute on function public.item_search(text, double precision, double precision, double precision, boolean, integer)
  to anon, authenticated, service_role;

-- search_stock() (the website's plain results, the public API, MCP, the chat's tool) keeps its output: without words
-- every item nearby as before; with words the order of item_search().
create or replace function public.search_stock(q text default null, lat double precision default null,
                                               lng double precision default null, radius_km double precision default 10,
                                               only_available boolean default false)
returns table (item_id uuid, item_name text, ean text, brand text, shop_id uuid, shop_slug text, shop_name text,
               shop_address text, shop_city text, shop_country text, shop_timezone text, shop_lat double precision,
               shop_lng double precision, price numeric, currency text, quantity numeric, availability text,
               is_available boolean, freshness_state text, freshness_age_minutes integer, latest_file_time timestamptz,
               updated_at timestamptz, distance_km double precision, item_name_lang text, item_name_i18n jsonb)
language sql
stable
security definer
set search_path = ''
set jit = off
as $$
  (select e.* from public.search_stock_exact(null, search_stock.lat, search_stock.lng, search_stock.radius_km,
                                             search_stock.only_available) e
   where nullif(trim(coalesce(search_stock.q, '')), '') is null)
  union all
  (select s.item_id, s.item_name, s.ean, s.brand, s.shop_id, s.shop_slug, s.shop_name, s.shop_address, s.shop_city,
          s.shop_country, s.shop_timezone, s.shop_lat, s.shop_lng, s.price, s.currency, s.quantity, s.availability,
          s.is_available, s.freshness_state, s.freshness_age_minutes, s.latest_file_time, s.updated_at, s.distance_km,
          s.item_name_lang, s.item_name_i18n
   from public.item_search(search_stock.q, search_stock.lat, search_stock.lng, search_stock.radius_km,
                           search_stock.only_available, 50) s
   where nullif(trim(coalesce(search_stock.q, '')), '') is not null)
$$;
revoke execute on function public.search_stock(text, double precision, double precision, double precision, boolean) from public;
grant execute on function public.search_stock(text, double precision, double precision, double precision, boolean)
  to anon, authenticated, service_role;
