-- PPI · 42 · Speed: the same results, faster (measured on a copy with 60 shops × 2 000 items).
--
--  - shop_items.names_search: the item's searchable names (the shop's own name + every translation, the text the
--    search compares with) kept as a stored column with its own trigram index, instead of being worked out again for
--    every row of every search (search_stock 0.8–1.5 s → a few ms; shop_stock with a word 155 ms → a few ms)
--  - search_stock starts from the matching items instead of labelling every item first; shop_stock and the owner's
--    list (owner_item_rows) use the stored column too. Rules, order and results are unchanged.
--  - owner_translations ("Jazyky a inventár → Preklady"): the item's own language was looked up with a full scan for
--    every cell (2 minutes for a shop with 2 000 items) → one join
--  - Postgres JIT compilation is switched off for the website's database and its functions: on these small queries it
--    only added 0.3–0.5 s of compiling (shop_content 430 ms → 0.3 ms)
-- Nothing here changes what anybody may read or write (RLS and grants stay). Run once in the SQL Editor (after 41).

-- ------------------------------------------------------------------ 1. the searchable names, stored and indexed

alter table public.shop_items
  add column if not exists names_search text generated always as (public.item_names_text(name, name_i18n)) stored;

create index if not exists shop_items_names_search_col_idx
  on public.shop_items using gin (names_search extensions.gin_trgm_ops);
-- The old index on the same expression is no longer used by any search.
drop index if exists public.shop_items_names_search_idx;

-- ------------------------------------------------------------------ 2. the search words, prepared once per search

-- The query's words as LIKE patterns ("%kava%", "%bio%"), exactly as matches_all_words() builds them; a text matches
-- every word when `text like all (search_patterns(q))` (no words: every text matches, as before). Prepared once per
-- search instead of once per row.
create or replace function public.search_patterns(p_query text)
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(array_agg('%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%'), '{}')
  from unnest(regexp_split_to_array(public.search_text(p_query), '\s+')) as w
  where w <> ''
$$;
grant execute on function public.search_patterns(text) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ 3. the search across all shops

create or replace function public.search_stock(
  q text default null,
  lat double precision default null,
  lng double precision default null,
  radius_km double precision default 10,
  only_available boolean default false
)
returns table (
  item_id uuid, item_name text, ean text, brand text, shop_id uuid, shop_slug text, shop_name text, shop_address text,
  shop_city text, shop_country text, shop_timezone text, shop_lat double precision, shop_lng double precision,
  price numeric, currency text, quantity numeric, availability text, is_available boolean, freshness_state text,
  freshness_age_minutes integer, latest_file_time timestamptz, updated_at timestamptz, distance_km double precision,
  item_name_lang text, item_name_i18n jsonb
)
language sql
stable
security definer
set search_path = ''
set jit = off
as $$
  with term as materialized (
    select
      case
        when search_stock.lat between -90 and 90 and search_stock.lng between -180 and 180
        then extensions.st_setsrid(
               extensions.st_makepoint(search_stock.lng, search_stock.lat), 4326
             )::extensions.geography
      end as here,
      least(greatest(coalesce(search_stock.radius_km, 10), 0.1), 500) * 1000 as radius_m,
      nullif(trim(coalesce(search_stock.q, '')), '') as raw_q,
      public.search_patterns(search_stock.q) as patterns
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
      and (not coalesce(search_stock.only_available, false) or f.is_available)
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

-- ------------------------------------------------------------------ 4. one shop's items (shop page, API, assistant)

create or replace function public.shop_stock(p_slug text, q text default null, p_limit integer default 50, p_offset integer default 0)
returns table (
  item_id uuid, item_name text, ean text, brand text, price numeric, currency text, quantity numeric, availability text,
  is_available boolean, freshness_state text, freshness_age_minutes integer, latest_file_time timestamptz,
  updated_at timestamptz, total_count bigint, item_name_lang text, item_name_i18n jsonb
)
language sql
stable
set search_path = ''
as $$
  -- The words' patterns once (materialized: never rebuilt per row).
  with w as materialized (select public.search_patterns(shop_stock.q) as patterns)
  select
    ps.item_id, ps.item_name, ps.ean, ps.brand,
    ps.price, ps.currency, ps.quantity, ps.availability, ps.is_available,
    ps.freshness_state, ps.freshness_age_minutes, ps.latest_file_time, ps.updated_at,
    count(*) over () as total_count,
    ps.item_name_lang, ps.item_name_i18n
  from public.public_stock ps
  join public.shop_items si on si.id = ps.item_id
  cross join w
  where ps.shop_slug = shop_stock.p_slug
    and (
      nullif(trim(coalesce(shop_stock.q, '')), '') is null
      or ps.ean = trim(shop_stock.q)
      or case
           when si.names_search like all (w.patterns) then true
           else (si.names_search || ' ' || public.search_text(coalesce(ps.brand, '') || ' ' || coalesce(ps.ean, '')))
                like all (w.patterns)
         end
    )
  order by ps.item_name, ps.item_id
  limit least(greatest(coalesce(shop_stock.p_limit, 50), 1), 100)
  offset greatest(coalesce(shop_stock.p_offset, 0), 0)
$$;

-- ------------------------------------------------------------------ 5. the owner's item list (update 41) with the column

create or replace function public.owner_item_rows(p_shop_id uuid, p_q text default null)
returns table (
  item_id uuid,
  source_code text,
  item_name text,
  ean text,
  price numeric,
  currency text,
  quantity numeric,
  availability text,
  updated_at timestamptz,
  name_lang text,
  name_i18n jsonb,
  name_i18n_by_owner boolean,
  translated_name_source text,
  has_description boolean,
  missing_translation boolean
)
language plpgsql
stable
security definer
set search_path = ''
set jit = off
as $$
#variable_conflict use_column
declare
  v_state text;
  v_name_langs text[];
  v_desc_langs text[];
  v_patterns text[] := public.search_patterns(p_q);
begin
  if not (public.is_shop_member(p_shop_id) or public.is_admin()) then
    return;
  end if;
  select f.state into v_state from public.freshness_state(p_shop_id) f;
  v_name_langs := public.shop_target_langs(p_shop_id, 'item_name');
  v_desc_langs := public.shop_target_langs(p_shop_id, 'item_description');
  return query
    select
      si.id, si.source_code, si.name, si.ean,
      inv.price, coalesce(inv.currency, 'EUR'), inv.quantity,
      public.availability_label(inv.quantity, v_state),
      coalesce(inv.source_updated_at, inv.received_at, si.updated_at),
      si.name_lang, si.name_i18n, si.name_i18n_by_owner, si.translated_name_source,
      d.text is not null,
      exists (
        select 1 from unnest(v_name_langs) l(lang)
        left join public.content_translations c
          on c.shop_id = p_shop_id and c.kind = 'item_name' and c.ref = si.id::text and c.lang = l.lang
        where l.lang <> coalesce(si.name_lang, '')
          and (c.shop_id is null or public.translation_state(c.status, c.source_hash, si.name) = 'stale')
      ) or (d.text is not null and exists (
        select 1 from unnest(v_desc_langs) l(lang)
        left join public.content_translations c
          on c.shop_id = p_shop_id and c.kind = 'item_description' and c.ref = si.id::text and c.lang = l.lang
        where c.shop_id is null or public.translation_state(c.status, c.source_hash, d.text) = 'stale'
      ))
    from public.shop_items si
    left join public.inventory inv on inv.shop_item_id = si.id
    left join lateral public.item_description_shown(si.id) d on true
    where si.shop_id = p_shop_id
      and (
        nullif(trim(coalesce(p_q, '')), '') is null
        or si.source_code = trim(p_q)
        or si.ean = trim(p_q)
        or si.names_search like all (v_patterns)
      );
end;
$$;
revoke execute on function public.owner_item_rows(uuid, text) from public, anon, authenticated;

-- ------------------------------------------------------------------ 6. "Preklady": the item's own language in one join

create or replace function public.owner_translations(
  p_shop_id uuid, p_lang text default null, p_kind text default null, p_state text default null,
  p_q text default null, p_ref text default null, p_page integer default 1, p_per_page integer default 50
)
returns table (kind text, ref text, lang text, source text, text text, state text, updated_at timestamptz, total bigint)
language plpgsql
stable
security definer
set search_path = ''
set jit = off
as $$
declare
  v_langs text[];
  v_main text;
  v_patterns text[] := public.search_patterns(p_q);
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  v_main := public.shop_main_lang(p_shop_id);
  select coalesce(array_agg(distinct x), '{}') into v_langs from (
    select unnest(public.shop_preferred_langs(p_shop_id)) as x
    union select unnest(ls.inventory_langs) from public.shop_language_settings ls where ls.shop_id = p_shop_id
    union select r.lang from public.translation_requests r where r.shop_id = p_shop_id
    union select c.lang from public.content_translations c where c.shop_id = p_shop_id
    union select unnest(array['sk', 'hu', 'en'])
  ) t where x <> v_main and public.valid_lang(x);
  return query
    with names as (
      select si.id::text as ref, si.name_lang from public.shop_items si where si.shop_id = p_shop_id
    ),
    cells as (
      select src.kind, src.ref, l.lang, src.source, c.text, c.updated_at,
             case when c.shop_id is null then 'missing' else public.translation_state(c.status, c.source_hash, src.source) end as state
      from public.translation_sources(p_shop_id) src
      cross join unnest(v_langs) as l(lang)
      left join names n on src.kind = 'item_name' and n.ref = src.ref
      left join public.content_translations c on c.shop_id = p_shop_id and c.kind = src.kind and c.ref = src.ref and c.lang = l.lang
      where (p_lang is null or l.lang = p_lang)
        and (p_ref is null or src.ref = p_ref)
        and (p_kind is null
             or (p_kind = 'items' and src.kind like 'item_%')
             or (p_kind = 'blog' and src.kind like 'blog_%')
             or (p_kind = 'texts' and src.kind not like 'item_%' and src.kind not like 'blog_%')
             or src.kind = p_kind)
        and (p_q is null or public.search_text(src.source) like all (v_patterns))
        and (src.kind <> 'item_name' or l.lang <> coalesce(n.name_lang, ''))
    )
    select x.kind, x.ref, x.lang, x.source, x.text, x.state, x.updated_at, count(*) over ()
    from cells x
    where p_state is null or x.state = p_state
    order by x.kind, left(x.source, 80), x.ref, x.lang
    limit least(greatest(coalesce(p_per_page, 50), 1), 200) offset (greatest(coalesce(p_page, 1), 1) - 1) * least(greatest(coalesce(p_per_page, 50), 1), 200);
end;
$$;

-- ------------------------------------------------------------------ 7. no JIT compiling for the website's queries

-- For the whole database (new connections); some hosted databases do not allow it, then the functions below still
-- carry it themselves.
do $$
begin
  execute format('alter database %I set jit = off', current_database());
exception when others then
  raise notice 'jit: could not change the database setting (%); the functions below carry jit = off themselves', sqlerrm;
end $$;

-- The functions the pages call most (a function's own setting wins over the database's).
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.proname in (
        'shop_content', 'content_slots_shown', 'owner_content', 'owner_items', 'owner_item_counts',
        'translation_sources', 'shop_translations', 'shop_blog', 'shop_blog_post', 'shop_blog_count', 'blog_index',
        'blog_visible_posts', 'my_shops', 'live_shop_sites', 'shop_calendar', 'shop_site', 'shop_languages',
        'search_shop_docs', 'search_shop_blog', 'search_partner_products', 'translation_work', 'owner_language_settings'
      )
  loop
    execute format('alter function %s set jit = off', f);
  end loop;
end $$;

-- =====================================================================================================================
-- Server errors of the last days (performance pass): "Chyby za posledných 7 dní" on the admin page.
-- Only what went wrong and where (the route's file path, e.g. /[lang]/shops/[slug]) — never the visitor's address,
-- query, IP, e-mail, cookies or other personal data; the message is cleaned here once more. The website writes with the
-- anon key through log_server_error() (no table grants); the same error within 10 minutes only counts up; at most
-- 2000 new rows an hour; rows older than 30 days go away. Only the admin reads (admin_server_errors(), is_admin()).
-- =====================================================================================================================
create table if not exists public.server_errors (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('render', 'route', 'action', 'proxy', 'other')),
  route text not null check (char_length(route) <= 200),
  message text not null check (char_length(message) <= 500),
  digest text check (char_length(digest) <= 64),
  hits integer not null default 1,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now()
);
create index if not exists server_errors_last_idx on public.server_errors (last_at desc);
create index if not exists server_errors_same_idx on public.server_errors (route, kind, md5(message), last_at desc);
alter table public.server_errors enable row level security;
revoke all on public.server_errors from anon, authenticated;

-- E-mail addresses, long numbers, ids, keys and URL queries out of a message (the website cleans it first, too).
create or replace function public.clean_error_text(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select left(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(coalesce(p_text, ''), '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[e-mail]', 'g'),
          '\?[^\s"'')]*', '?…', 'g'),
        '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '[id]', 'g'),
      '[A-Za-z0-9_\-]{24,}|\d{6,}', '[…]', 'g'),
    500)
$$;

create or replace function public.log_server_error(p_kind text, p_route text, p_message text, p_digest text default null)
returns void
language plpgsql
security definer
set search_path = ''
set jit = off
as $$
declare
  v_kind text := case when p_kind in ('render', 'route', 'action', 'proxy') then p_kind else 'other' end;
  v_route text := left(regexp_replace(coalesce(nullif(p_route, ''), '?'), '\?.*$', ''), 200);
  v_message text := public.clean_error_text(coalesce(nullif(p_message, ''), 'error'));
  v_digest text := nullif(left(regexp_replace(coalesce(p_digest, ''), '[^A-Za-z0-9_-]', '', 'g'), 64), '');
  v_id bigint;
begin
  update public.server_errors
     set hits = hits + 1, last_at = now(), digest = coalesce(v_digest, digest)
   where id = (select e.id from public.server_errors e
                where e.route = v_route and e.kind = v_kind and md5(e.message) = md5(v_message)
                  and e.last_at > now() - interval '10 minutes'
                order by e.last_at desc limit 1)
  returning id into v_id;
  if v_id is not null then return; end if;
  if (select count(*) from public.server_errors where first_at > now() - interval '1 hour') >= 2000 then return; end if;
  insert into public.server_errors (kind, route, message, digest) values (v_kind, v_route, v_message, v_digest);
  delete from public.server_errors where last_at < now() - interval '30 days';
end;
$$;
revoke all on function public.log_server_error(text, text, text, text) from public;
grant execute on function public.log_server_error(text, text, text, text) to anon, authenticated, service_role;

create or replace function public.admin_server_errors(p_days integer default 7)
returns table (kind text, route text, message text, digest text, hits bigint, first_at timestamptz, last_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
set jit = off
as $$
begin
  if not public.is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    select e.kind, e.route, e.message, max(e.digest), sum(e.hits)::bigint, min(e.first_at), max(e.last_at)
    from public.server_errors e
    where e.last_at > now() - make_interval(days => least(greatest(coalesce(p_days, 7), 1), 30))
    group by e.kind, e.route, e.message
    order by max(e.last_at) desc
    limit 200;
end;
$$;
revoke all on function public.admin_server_errors(integer) from public;
grant execute on function public.admin_server_errors(integer) to authenticated;
