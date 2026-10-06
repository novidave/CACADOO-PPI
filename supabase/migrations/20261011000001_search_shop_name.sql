-- PPI · 14 · Search by text only: item name, brand, EAN, shop name, street or town
-- ("Cacadoo" or "Budince" lists that shop's items). The website no longer sends a
-- location. Same function as before (same inputs and result), three more matches.

create or replace function public.search_stock(
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
        or public.search_text(ps.shop_name) like
             '%' || replace(replace(replace(public.search_text(t.raw_q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        or public.search_text(ps.shop_address) like
             '%' || replace(replace(replace(public.search_text(t.raw_q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        or public.search_text(ps.shop_city) like
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
