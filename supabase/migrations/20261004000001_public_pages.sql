-- PPI · 7 · Data for the public shop and item pages.

-- Active shops with what a visitor may see: contact details, opening hours,
-- coordinates and freshness. Never ico, visibility settings or sync details.
create or replace view public.public_shops
with (security_invoker = false)
as
select
  sh.id,
  sh.slug,
  sh.name,
  sh.address,
  sh.city,
  sh.country,
  sh.timezone,
  sh.phone,
  sh.website,
  sh.logo_url,
  sh.opening_hours,
  extensions.st_y(sh.location::extensions.geometry) as lat,
  extensions.st_x(sh.location::extensions.geometry) as lng,
  public.freshness_label(ss.latest_file_time)       as freshness_state,
  public.freshness_age_minutes(ss.latest_file_time) as freshness_age_minutes,
  ss.latest_file_time
from public.shops sh
left join public.sync_sources ss on ss.shop_id = sh.id
where sh.is_active;

grant select on public.public_shops to anon, authenticated;

-- One shop's public items for its page: accent-insensitive filter, paged,
-- with the total count for the pager. Same labels and rules as public_stock.
create or replace function public.shop_stock(
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
  total_count bigint
)
language sql
stable
set search_path = ''
as $$
  select
    ps.item_id, ps.item_name, ps.ean, ps.brand,
    ps.price, ps.currency, ps.quantity, ps.availability, ps.is_available,
    ps.freshness_state, ps.freshness_age_minutes, ps.latest_file_time, ps.updated_at,
    count(*) over () as total_count
  from public.public_stock ps
  where ps.shop_slug = shop_stock.p_slug
    and (
      nullif(trim(coalesce(shop_stock.q, '')), '') is null
      or public.search_text(ps.item_name) like
           '%' || replace(replace(replace(public.search_text(trim(shop_stock.q)), '\', '\\'), '%', '\%'), '_', '\_') || '%'
      or public.search_text(ps.brand) like
           '%' || replace(replace(replace(public.search_text(trim(shop_stock.q)), '\', '\\'), '%', '\%'), '_', '\_') || '%'
      or ps.ean = trim(shop_stock.q)
    )
  order by ps.item_name, ps.item_id
  limit least(greatest(coalesce(shop_stock.p_limit, 50), 1), 100)
  offset greatest(coalesce(shop_stock.p_offset, 0), 0)
$$;

grant execute on function public.shop_stock(text, text, integer, integer) to anon, authenticated;
