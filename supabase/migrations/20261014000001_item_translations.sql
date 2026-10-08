-- PPI · 17 · Item names in three languages, search across languages, AI search limits.
--  - shop_items gets the detected language of its name, its Slovak, Hungarian and English
--    names (made by the stock-pull function in the background, or corrected by the owner)
--    and the original name the translation was made from
--  - every search (website, shop pages, dashboard, API, MCP) looks at the original name
--    plus all three translations, word by word: "white paint", "fehér festék" and
--    "biela farba" all find "Farba fas. biela 5L"
--  - search_stock, shop_stock and owner_items also return the translations
--  - ai_search_hit(): the AI search on the main page, 10 per minute per caller and a
--    daily total for the whole site

alter table public.shop_items
  add column if not exists name_lang text check (name_lang is null or name_lang ~ '^[a-z]{2}$'),
  add column if not exists name_i18n jsonb check (name_i18n is null or jsonb_typeof(name_i18n) = 'object'),
  add column if not exists translated_name_source text,
  add column if not exists name_i18n_by_owner boolean not null default false;

comment on column public.shop_items.name_lang is 'Language of the name as the shop wrote it (ISO 639-1), detected with the translation.';
comment on column public.shop_items.name_i18n is 'The name in plain Slovak, Hungarian and English: {"sk","hu","en"}.';
comment on column public.shop_items.translated_name_source is 'The original name the translation was made from; a different name is translated again.';
comment on column public.shop_items.name_i18n_by_owner is 'The owner corrected the translation: it is never overwritten.';

-- The searchable names of an item: original + Slovak + Hungarian + English, without
-- accents and in lower case. Indexed below, so every name search can use the index.
create or replace function public.item_names_text(p_name text, p_i18n jsonb)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select public.search_text(
    coalesce(p_name, '') || ' ' || coalesce(p_i18n ->> 'sk', '') || ' ' ||
    coalesce(p_i18n ->> 'hu', '') || ' ' || coalesce(p_i18n ->> 'en', '')
  )
$$;

-- Every word of the query appears in the text (any order, also inside longer words):
-- "biela farba" matches "fasadna farba biela 5 l", "festek" matches "homlokzatfestek".
-- p_text must already be search_text() output.
create or replace function public.matches_all_words(p_text text, p_query text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(bool_and(
    p_text like '%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%'
  ), true)
  from unnest(regexp_split_to_array(public.search_text(p_query), '\s+')) as w
  where w <> ''
$$;

drop index if exists public.shop_items_name_search_idx;
create index if not exists shop_items_names_search_idx
  on public.shop_items using gin (public.item_names_text(name, name_i18n) extensions.gin_trgm_ops);

-- public_stock: as before, plus the name's language and translations (new columns go last).
create or replace view public.public_stock
with (security_invoker = false)
as
select
  si.id                                   as item_id,
  si.name                                 as item_name,
  coalesce(si.ean, p.ean)                 as ean,
  coalesce(si.brand, p.brand)             as brand,
  p.category                              as category,
  sh.id                                   as shop_id,
  sh.slug                                 as shop_slug,
  sh.name                                 as shop_name,
  sh.address                              as shop_address,
  sh.city                                 as shop_city,
  sh.location                             as shop_location,
  extensions.st_y(sh.location::extensions.geometry) as shop_lat,
  extensions.st_x(sh.location::extensions.geometry) as shop_lng,
  inv.price                               as price,
  inv.currency                            as currency,
  case
    when sh.visibility_mode = 'exact' and f.state <> 'stale' then inv.quantity
  end                                     as quantity,
  public.availability_label(sh.visibility_mode, inv.quantity, sh.low_stock_threshold, f.state)
                                          as availability,
  coalesce(
    public.availability_label(sh.visibility_mode, inv.quantity, sh.low_stock_threshold, f.state)
      in ('in_stock_count', 'in_stock', 'low_stock', 'available'),
    false
  )                                       as is_available,
  f.state                                 as freshness_state,
  f.age_minutes                           as freshness_age_minutes,
  ss.latest_file_time                     as latest_file_time,
  coalesce(inv.source_updated_at, inv.received_at) as updated_at,
  sh.country                              as shop_country,
  sh.timezone                             as shop_timezone,
  si.name_lang                            as item_name_lang,
  si.name_i18n                            as item_name_i18n
from public.shop_items si
join public.shops sh       on sh.id = si.shop_id and sh.is_active
join public.inventory inv  on inv.shop_item_id = si.id
left join public.products p      on p.id = si.product_id
left join public.sync_sources ss on ss.shop_id = sh.id
cross join lateral (
  select public.freshness_label(ss.latest_file_time)       as state,
         public.freshness_age_minutes(ss.latest_file_time) as age_minutes
) f
where si.is_public;

-- search_stock: every word of the query must appear in the item's names (original and
-- translations), brand or EAN, or in the shop's name, street or town. Candidates come
-- from the trigram indexes (longest word); the result also carries the translations,
-- so the function is replaced. It only ever returns rows of public_stock.
drop function if exists public.search_stock(text, double precision, double precision, double precision, boolean);

create function public.search_stock(
  q text default null,
  lat double precision default null,
  lng double precision default null,
  radius_km double precision default 10,
  only_available boolean default false
)
returns table (
  item_id uuid,
  item_name text,
  ean text,
  brand text,
  shop_id uuid,
  shop_slug text,
  shop_name text,
  shop_address text,
  shop_city text,
  shop_country text,
  shop_timezone text,
  shop_lat double precision,
  shop_lng double precision,
  price numeric,
  currency text,
  quantity numeric,
  availability text,
  is_available boolean,
  freshness_state text,
  freshness_age_minutes integer,
  latest_file_time timestamptz,
  updated_at timestamptz,
  distance_km double precision,
  item_name_lang text,
  item_name_i18n jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  with term as (
    select
      case
        when search_stock.lat between -90 and 90 and search_stock.lng between -180 and 180
        then extensions.st_setsrid(
               extensions.st_makepoint(search_stock.lng, search_stock.lat), 4326
             )::extensions.geography
      end as here,
      least(greatest(coalesce(search_stock.radius_km, 10), 0.1), 500) * 1000 as radius_m,
      nullif(trim(coalesce(search_stock.q, '')), '') as raw_q
  ),
  word as (
    select '%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%' as pattern
    from term t, unnest(regexp_split_to_array(public.search_text(t.raw_q), '\s+')) as w
    where w <> ''
    order by length(w) desc
    limit 1
  ),
  candidate as (
    select si.id from public.shop_items si, word
    where public.item_names_text(si.name, si.name_i18n) like word.pattern
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
  matched as (
    select
      ps.*,
      case when t.here is not null
        then round((extensions.st_distance(ps.shop_location, t.here) / 1000)::numeric, 2)::double precision
      end as distance_km
    from public.public_stock ps
    cross join term t
    where (t.here is null or extensions.st_dwithin(ps.shop_location, t.here, t.radius_m))
      and (
        t.raw_q is null
        or (
          ps.item_id in (select c.id from candidate c)
          and (
            ps.ean = t.raw_q
            or public.matches_all_words(
                 public.item_names_text(ps.item_name, ps.item_name_i18n) || ' ' ||
                 public.search_text(
                   coalesce(ps.brand, '') || ' ' || coalesce(ps.ean, '') || ' ' || ps.shop_name || ' ' ||
                   coalesce(ps.shop_address, '') || ' ' || coalesce(ps.shop_city, '')
                 ),
                 t.raw_q
               )
          )
        )
      )
      and (not coalesce(search_stock.only_available, false) or ps.is_available)
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

revoke execute on function public.search_stock(text, double precision, double precision, double precision, boolean) from public;
grant execute on function public.search_stock(text, double precision, double precision, double precision, boolean)
  to anon, authenticated, service_role;

-- shop_stock: a shop's public items; the search also covers the translations.
drop function if exists public.shop_stock(text, text, integer, integer);

create function public.shop_stock(
  p_slug text,
  q text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  item_id uuid,
  item_name text,
  ean text,
  brand text,
  price numeric,
  currency text,
  quantity numeric,
  availability text,
  is_available boolean,
  freshness_state text,
  freshness_age_minutes integer,
  latest_file_time timestamptz,
  updated_at timestamptz,
  total_count bigint,
  item_name_lang text,
  item_name_i18n jsonb
)
language sql
stable
set search_path = ''
as $$
  select
    ps.item_id, ps.item_name, ps.ean, ps.brand,
    ps.price, ps.currency, ps.quantity, ps.availability, ps.is_available,
    ps.freshness_state, ps.freshness_age_minutes, ps.latest_file_time, ps.updated_at,
    count(*) over () as total_count,
    ps.item_name_lang, ps.item_name_i18n
  from public.public_stock ps
  where ps.shop_slug = shop_stock.p_slug
    and (
      nullif(trim(coalesce(shop_stock.q, '')), '') is null
      or ps.ean = trim(shop_stock.q)
      or public.matches_all_words(
           public.item_names_text(ps.item_name, ps.item_name_i18n) || ' ' ||
           public.search_text(coalesce(ps.brand, '') || ' ' || coalesce(ps.ean, '')),
           shop_stock.q
         )
    )
  order by ps.item_name, ps.item_id
  limit least(greatest(coalesce(shop_stock.p_limit, 50), 1), 100)
  offset greatest(coalesce(shop_stock.p_offset, 0), 0)
$$;

grant execute on function public.shop_stock(text, text, integer, integer) to anon, authenticated, service_role;

-- owner_items: the dashboard item list, now with the translations and whether the
-- owner corrected them; the search covers the translations too.
drop function if exists public.owner_items(uuid, text, integer, integer);

create function public.owner_items(
  p_shop_id uuid,
  q text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  item_id uuid,
  source_code text,
  item_name text,
  ean text,
  price numeric,
  currency text,
  quantity numeric,
  availability text,
  is_public boolean,
  updated_at timestamptz,
  total_count bigint,
  name_lang text,
  name_i18n jsonb,
  name_i18n_by_owner boolean,
  translated_name_source text
)
language sql
stable
set search_path = ''
as $$
  with f as (select state from public.freshness_state(owner_items.p_shop_id))
  select
    si.id, si.source_code, si.name, si.ean,
    inv.price, coalesce(inv.currency, 'EUR'), inv.quantity,
    public.availability_label(sh.visibility_mode, inv.quantity, sh.low_stock_threshold, f.state),
    si.is_public,
    coalesce(inv.source_updated_at, inv.received_at, si.updated_at),
    count(*) over (),
    si.name_lang, si.name_i18n, si.name_i18n_by_owner, si.translated_name_source
  from public.shop_items si
  join public.shops sh on sh.id = si.shop_id
  left join public.inventory inv on inv.shop_item_id = si.id
  cross join f
  where si.shop_id = owner_items.p_shop_id
    -- Public items of active shops are readable by everyone under RLS, so the
    -- dashboard list must check membership itself.
    and (public.is_shop_member(owner_items.p_shop_id) or public.is_admin())
    and (
      nullif(trim(coalesce(owner_items.q, '')), '') is null
      or si.source_code = trim(owner_items.q)
      or si.ean = trim(owner_items.q)
      or public.matches_all_words(public.item_names_text(si.name, si.name_i18n), owner_items.q)
    )
  order by si.name, si.id
  limit least(greatest(coalesce(owner_items.p_limit, 50), 1), 100)
  offset greatest(coalesce(owner_items.p_offset, 0), 0)
$$;

revoke execute on function public.owner_items(uuid, text, integer, integer) from public, anon;
grant execute on function public.owner_items(uuid, text, integer, integer) to authenticated;

-- For the stock-pull function: a shop's items whose name has no translation yet or has
-- changed since; never the ones the owner corrected. Public items first.
create or replace function public.items_to_translate(p_shop_id uuid, p_limit integer default 1000)
returns table (item_id uuid, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select si.id, si.name
  from public.shop_items si
  where si.shop_id = items_to_translate.p_shop_id
    and not si.name_i18n_by_owner
    and (si.name_i18n is null or si.translated_name_source is distinct from si.name)
  order by si.is_public desc, si.name, si.id
  limit least(greatest(coalesce(items_to_translate.p_limit, 1000), 1), 5000)
$$;

revoke execute on function public.items_to_translate(uuid, integer) from public, anon, authenticated;
grant execute on function public.items_to_translate(uuid, integer) to service_role;

-- For the stock-pull function: save machine translations.
-- p_items: [{"item_id","source","lang","sk","hu","en"}, ...] where source is the name
-- that was translated. Skipped: items the owner corrected, items renamed in the meantime
-- (the next file translates them again) and incomplete translations. Returns how many
-- items were saved. Stock is never touched.
create or replace function public.apply_item_translations(p_shop_id uuid, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_saved integer;
begin
  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'p_items must be a JSON array' using errcode = '22023';
  end if;

  update public.shop_items si
  set name_lang = case when lower(trim(t.lang)) ~ '^[a-z]{2}$' then lower(trim(t.lang)) end,
      name_i18n = jsonb_build_object('sk', left(trim(t.sk), 300), 'hu', left(trim(t.hu), 300), 'en', left(trim(t.en), 300)),
      translated_name_source = t.source
  from jsonb_to_recordset(p_items) as t(item_id uuid, source text, lang text, sk text, hu text, en text)
  where si.id = t.item_id
    and si.shop_id = apply_item_translations.p_shop_id
    and not si.name_i18n_by_owner
    and si.name = t.source
    and nullif(trim(t.sk), '') is not null
    and nullif(trim(t.hu), '') is not null
    and nullif(trim(t.en), '') is not null;
  get diagnostics v_saved = row_count;
  return v_saved;
end;
$$;

revoke execute on function public.apply_item_translations(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.apply_item_translations(uuid, jsonb) to service_role;

-- The owner corrects an item's translations in My shop → Items. A corrected item is
-- never translated by machine again. p_names = null hands it back to the automatic
-- translation (done again with the next stock file).
create or replace function public.owner_set_item_translation(p_item_id uuid, p_names jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
  v_sk text := nullif(trim(p_names ->> 'sk'), '');
  v_hu text := nullif(trim(p_names ->> 'hu'), '');
  v_en text := nullif(trim(p_names ->> 'en'), '');
begin
  select si.shop_id into v_shop from public.shop_items si where si.id = p_item_id;
  if v_shop is null or not public.is_shop_member(v_shop) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;

  if p_names is null then
    update public.shop_items
    set name_i18n_by_owner = false, translated_name_source = null
    where id = p_item_id;
    return;
  end if;

  if jsonb_typeof(p_names) is distinct from 'object'
     or coalesce(v_sk, v_hu, v_en) is null
     or greatest(length(v_sk), length(v_hu), length(v_en)) > 300 then
    raise exception 'Give at least one translation of up to 300 characters' using errcode = '22023';
  end if;

  update public.shop_items
  set name_i18n = jsonb_strip_nulls(jsonb_build_object('sk', v_sk, 'hu', v_hu, 'en', v_en)),
      name_i18n_by_owner = true,
      translated_name_source = name
  where id = p_item_id;
end;
$$;

revoke execute on function public.owner_set_item_translation(uuid, jsonb) from public, anon;
grant execute on function public.owner_set_item_translation(uuid, jsonb) to authenticated;

-- AI search on the main page: at most 10 per minute per caller (hashed IP, as api_hit)
-- and p_daily_limit for the whole site per day (UTC). Logs an allowed call in api_usage
-- and says whether it may run; a refused call is not logged.
create index if not exists api_usage_ai_search_idx
  on public.api_usage (created_at) where endpoint = 'ai-search';

create or replace function public.ai_search_hit(p_ip_hash text, p_daily_limit integer default 500)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_ip_hash is null or length(p_ip_hash) < 16 or length(p_ip_hash) > 128 then
    raise exception 'Invalid caller hash' using errcode = '22023';
  end if;

  if (select count(*) from public.api_usage
      where ip_hash = p_ip_hash and endpoint = 'ai-search' and created_at > now() - interval '1 minute') >= 10 then
    return false;
  end if;
  if (select count(*) from public.api_usage
      where endpoint = 'ai-search' and created_at >= date_trunc('day', now())) >= greatest(coalesce(p_daily_limit, 500), 0) then
    return false;
  end if;

  insert into public.api_usage (ip_hash, endpoint) values (p_ip_hash, 'ai-search');
  return true;
end;
$$;

revoke execute on function public.ai_search_hit(text, integer) from public;
grant execute on function public.ai_search_hit(text, integer) to anon, authenticated;
