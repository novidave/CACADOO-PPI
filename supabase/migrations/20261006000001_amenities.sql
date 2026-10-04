-- PPI · 9 · Shop amenities: customer toilet, douchette, card terminal.
-- Set by the shop owner (dashboard) or the admin; shown on the public shop page.

alter table public.shops
  add column if not exists has_toilet boolean not null default false,
  add column if not exists has_douchette boolean not null default false,
  add column if not exists has_card_terminal boolean not null default false;

-- public_shops gains the three amenities (new columns go last).
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
  ss.latest_file_time,
  sh.has_toilet,
  sh.has_douchette,
  sh.has_card_terminal
from public.shops sh
left join public.sync_sources ss on ss.shop_id = sh.id
where sh.is_active;

grant select on public.public_shops to anon, authenticated;

-- admin_shops: the result gains columns, so it is replaced rather than altered.
drop function if exists public.admin_shops();

create function public.admin_shops()
returns table (
  id uuid,
  slug text,
  name text,
  ico text,
  address text,
  city text,
  country text,
  timezone text,
  lat double precision,
  lng double precision,
  phone text,
  website text,
  opening_hours jsonb,
  visibility_mode text,
  low_stock_threshold integer,
  logo_url text,
  is_active boolean,
  created_at timestamptz,
  file_format text,
  file_url text,
  field_mapping jsonb,
  mapping_status text,
  sample_rows jsonb,
  latest_file_time timestamptz,
  last_checked_at timestamptz,
  last_error text,
  freshness_state text,
  freshness_age_minutes integer,
  item_count bigint,
  owner_count bigint,
  has_toilet boolean,
  has_douchette boolean,
  has_card_terminal boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  return query
    select
      sh.id, sh.slug, sh.name, sh.ico, sh.address, sh.city, sh.country, sh.timezone,
      extensions.st_y(sh.location::extensions.geometry),
      extensions.st_x(sh.location::extensions.geometry),
      sh.phone, sh.website, sh.opening_hours, sh.visibility_mode, sh.low_stock_threshold,
      sh.logo_url, sh.is_active, sh.created_at,
      ss.file_format, ss.file_url, ss.field_mapping, ss.mapping_status, ss.sample_rows,
      ss.latest_file_time, ss.last_checked_at, ss.last_error,
      public.freshness_label(ss.latest_file_time),
      public.freshness_age_minutes(ss.latest_file_time),
      (select count(*) from public.shop_items si where si.shop_id = sh.id),
      (select count(*) from public.shop_members m where m.shop_id = sh.id),
      sh.has_toilet, sh.has_douchette, sh.has_card_terminal
    from public.shops sh
    left join public.sync_sources ss on ss.shop_id = sh.id
    order by sh.name;
end;
$$;

revoke execute on function public.admin_shops() from public, anon;
grant execute on function public.admin_shops() to authenticated;

-- admin_save_shop also saves the amenities.
create or replace function public.admin_save_shop(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_lat double precision := nullif(p ->> 'lat', '')::double precision;
  v_lng double precision := nullif(p ->> 'lng', '')::double precision;
  v_location extensions.geography;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if v_lat is not null and v_lng is not null then
    if v_lat not between -90 and 90 or v_lng not between -180 and 180 then
      raise exception 'Invalid coordinates' using errcode = '22023';
    end if;
    v_location := extensions.st_setsrid(extensions.st_makepoint(v_lng, v_lat), 4326)::extensions.geography;
  end if;

  if v_id is null then
    insert into public.shops (
      slug, name, ico, address, city, country, timezone, location, phone, website,
      opening_hours, visibility_mode, low_stock_threshold, is_active,
      has_toilet, has_douchette, has_card_terminal
    ) values (
      p ->> 'slug', p ->> 'name', nullif(p ->> 'ico', ''), nullif(p ->> 'address', ''),
      nullif(p ->> 'city', ''), nullif(upper(p ->> 'country'), ''), coalesce(nullif(p ->> 'timezone', ''), 'UTC'),
      v_location, nullif(p ->> 'phone', ''), nullif(p ->> 'website', ''),
      coalesce(p -> 'opening_hours', '{}'::jsonb), coalesce(nullif(p ->> 'visibility_mode', ''), 'in_stock'),
      coalesce(nullif(p ->> 'low_stock_threshold', '')::integer, 3), coalesce((p ->> 'is_active')::boolean, false),
      coalesce((p ->> 'has_toilet')::boolean, false), coalesce((p ->> 'has_douchette')::boolean, false),
      coalesce((p ->> 'has_card_terminal')::boolean, false)
    )
    returning id into v_id;
    insert into public.sync_sources (shop_id) values (v_id);
  else
    update public.shops set
      slug = p ->> 'slug',
      name = p ->> 'name',
      ico = nullif(p ->> 'ico', ''),
      address = nullif(p ->> 'address', ''),
      city = nullif(p ->> 'city', ''),
      country = nullif(upper(p ->> 'country'), ''),
      timezone = coalesce(nullif(p ->> 'timezone', ''), 'UTC'),
      location = v_location,
      phone = nullif(p ->> 'phone', ''),
      website = nullif(p ->> 'website', ''),
      opening_hours = coalesce(p -> 'opening_hours', '{}'::jsonb),
      visibility_mode = coalesce(nullif(p ->> 'visibility_mode', ''), 'in_stock'),
      low_stock_threshold = coalesce(nullif(p ->> 'low_stock_threshold', '')::integer, 3),
      is_active = coalesce((p ->> 'is_active')::boolean, false),
      has_toilet = coalesce((p ->> 'has_toilet')::boolean, false),
      has_douchette = coalesce((p ->> 'has_douchette')::boolean, false),
      has_card_terminal = coalesce((p ->> 'has_card_terminal')::boolean, false)
    where id = v_id;
    if not found then
      raise exception 'Shop not found' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
end;
$$;

revoke execute on function public.admin_save_shop(jsonb) from public, anon;
grant execute on function public.admin_save_shop(jsonb) to authenticated;
