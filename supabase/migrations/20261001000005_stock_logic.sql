-- PPI · 5/5 · Freshness, availability, public_stock view and search
-- (docs/PRD.md section 6). All visibility rules live here, so the website,
-- the public API and the MCP server show exactly the same thing.

-- Freshness from the shop's latest file time:
--   under 30 min -> current, 30 min to 24 h -> recent, older or never -> stale.
create or replace function public.freshness_label(file_time timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when file_time is null or file_time < now() - interval '24 hours' then 'stale'
    when file_time >= now() - interval '30 minutes' then 'current'
    else 'recent'
  end
$$;

create or replace function public.freshness_age_minutes(file_time timestamptz)
returns integer
language sql
stable
set search_path = ''
as $$
  select case
    when file_time is null then null
    else greatest(0, floor(extract(epoch from now() - file_time) / 60))::integer
  end
$$;

-- freshness_state(shop_id): always returns exactly one row.
create or replace function public.freshness_state(p_shop_id uuid)
returns table (state text, age_minutes integer, latest_file_time timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select public.freshness_label(s.latest_file_time),
         public.freshness_age_minutes(s.latest_file_time),
         s.latest_file_time
  from (select p_shop_id as shop_id) x
  left join public.sync_sources s on s.shop_id = x.shop_id
$$;

-- Availability label key per visibility mode. NULL when stale: no stock shown.
--   exact:    in_stock_count | out_of_stock
--   in_stock: in_stock | low_stock | out_of_stock
--   yes_no:   available | not_available
create or replace function public.availability_label(
  mode text, quantity numeric, threshold integer, freshness text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when freshness is null or freshness = 'stale' then null
    when mode = 'exact' then
      case when quantity > 0 then 'in_stock_count' else 'out_of_stock' end
    when mode = 'yes_no' then
      case when quantity > 0 then 'available' else 'not_available' end
    else
      case
        when quantity > threshold then 'in_stock'
        when quantity > 0 then 'low_stock'
        else 'out_of_stock'
      end
  end
$$;

-- The one public read path for stock. Runs with the view owner's rights
-- (security_invoker off) so visitors never need direct access to inventory;
-- it filters to public items of active shops itself and only exposes the raw
-- quantity for shops in 'exact' mode that are not stale.
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
  coalesce(inv.source_updated_at, inv.received_at) as updated_at
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

grant select on public.public_stock to anon, authenticated;

-- search_stock: accent-insensitive search ("kava" finds "Káva") within a
-- radius, sorted available first, then fresher, then nearer. Max 50 rows.
create or replace function public.search_stock(
  q text default null,
  lat double precision default 48.755,
  lng double precision default 21.918,
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
  with params as (
    select
      extensions.st_setsrid(
        extensions.st_makepoint(
          coalesce(search_stock.lng, 21.918),
          coalesce(search_stock.lat, 48.755)
        ), 4326
      )::extensions.geography as here,
      least(greatest(coalesce(search_stock.radius_km, 10), 0.1), 100) * 1000 as radius_m,
      nullif(trim(coalesce(search_stock.q, '')), '') as raw_q
  ),
  term as (
    select here, radius_m, raw_q,
           '%' || replace(replace(replace(public.search_text(raw_q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
             as pattern
    from params
  )
  select
    ps.item_id, ps.item_name, ps.ean, ps.brand,
    ps.shop_id, ps.shop_slug, ps.shop_name, ps.shop_address, ps.shop_city,
    ps.shop_lat, ps.shop_lng,
    ps.price, ps.currency, ps.quantity, ps.availability, ps.is_available,
    ps.freshness_state, ps.freshness_age_minutes, ps.latest_file_time, ps.updated_at,
    round((extensions.st_distance(ps.shop_location, t.here) / 1000)::numeric, 2)::double precision
      as distance_km
  from public.public_stock ps
  cross join term t
  where extensions.st_dwithin(ps.shop_location, t.here, t.radius_m)
    and (
      t.raw_q is null
      or public.search_text(ps.item_name) like t.pattern
      or public.search_text(ps.brand) like t.pattern
      or ps.ean = t.raw_q
    )
    and (not coalesce(search_stock.only_available, false) or ps.is_available)
  order by
    ps.is_available desc,
    case ps.freshness_state when 'current' then 0 when 'recent' then 1 else 2 end,
    extensions.st_distance(ps.shop_location, t.here),
    ps.item_name
  limit 50
$$;

grant execute on function public.search_stock(text, double precision, double precision, double precision, boolean)
  to anon, authenticated;

-- Sync status for a shop owner's dashboard: only latest file time and last error.
create or replace function public.my_sync_status(p_shop_id uuid)
returns table (
  latest_file_time timestamptz,
  last_checked_at timestamptz,
  last_error text,
  freshness_state text,
  freshness_age_minutes integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (public.is_shop_member(p_shop_id) or public.is_admin()) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;

  return query
    select s.latest_file_time, s.last_checked_at, s.last_error,
           public.freshness_label(s.latest_file_time),
           public.freshness_age_minutes(s.latest_file_time)
    from (select p_shop_id as shop_id) x
    left join public.sync_sources s on s.shop_id = x.shop_id;
end;
$$;

revoke execute on function public.my_sync_status(uuid) from public, anon;
grant execute on function public.my_sync_status(uuid) to authenticated;
