-- PPI · 6 · Europe-wide: no built-in home town.
-- Shops get a country and their own time zone; search works with or without
-- the visitor's location (no location = search every shop, no distance).

alter table public.shops alter column city drop default;
alter table public.shops alter column city drop not null;

-- ISO 3166-1 alpha-2, e.g. SK, HU, AT, DE.
alter table public.shops
  add column country text check (country is null or country ~ '^[A-Z]{2}$');

-- IANA time zone of the shop, e.g. Europe/Vienna. Used for opening hours and
-- for showing "last confirmed at 14:05" in the shop's local time.
alter table public.shops
  add column timezone text not null default 'UTC';

-- Reject unknown time zone names. (A trigger, because CHECK constraints
-- cannot look up pg_timezone_names.)
create or replace function public.guard_shop_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'Unknown time zone: %', new.timezone using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger shops_guard_timezone
  before insert or update of timezone on public.shops
  for each row execute function public.guard_shop_timezone();

revoke execute on function public.guard_shop_timezone() from public, anon, authenticated;

-- public_stock: same rules as before, plus country and time zone (new columns go last).
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
  sh.timezone                             as shop_timezone
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

-- search_stock: the result gains country/time zone and distance may be NULL,
-- so the function is replaced rather than altered.
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
  distance_km double precision
)
language sql
stable
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
        or public.search_text(ps.item_name) like
             '%' || replace(replace(replace(public.search_text(t.raw_q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        or public.search_text(ps.brand) like
             '%' || replace(replace(replace(public.search_text(t.raw_q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        or ps.ean = t.raw_q
      )
      and (not coalesce(search_stock.only_available, false) or ps.is_available)
  )
  select
    m.item_id, m.item_name, m.ean, m.brand,
    m.shop_id, m.shop_slug, m.shop_name, m.shop_address, m.shop_city,
    m.shop_country, m.shop_timezone, m.shop_lat, m.shop_lng,
    m.price, m.currency, m.quantity, m.availability, m.is_available,
    m.freshness_state, m.freshness_age_minutes, m.latest_file_time, m.updated_at,
    m.distance_km
  from matched m
  order by
    m.is_available desc,
    case m.freshness_state when 'current' then 0 when 'recent' then 1 else 2 end,
    m.distance_km nulls last,
    m.item_name
  limit 50
$$;

grant execute on function public.search_stock(text, double precision, double precision, double precision, boolean)
  to anon, authenticated;
