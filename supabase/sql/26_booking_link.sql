-- PPI · 26 · Booking link and product pages without other shops. Paste the whole file into the Supabase SQL Editor and Run.
--  Needs updates 21 and 25. Every shop may add the link to its page in a booking app
--  (Reservio, Bookio, Calendly, its own booking page …): the shop page then shows a
--  "Rezervovať termín" button that opens it in a new tab. Only an https:// address is kept
--  (http:// and a bare address become https://); nothing else of the shop changes.
--  Product pages of a shop with the paid plan or a domain of its own (being set up or live)
--  show no other shops: shop_stands_alone() decides it for the website.
-- Safe to run again.

-- ------------------------------------------------------------------ booking link

alter table public.shops add column if not exists booking_url text;

alter table public.shops drop constraint if exists shops_booking_url_check;
alter table public.shops add constraint shops_booking_url_check check (
  booking_url is null or (length(booking_url) <= 500
    and booking_url ~* '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.([a-z]{2,63}|xn--[a-z0-9-]{1,59})(:[0-9]{1,5})?([/?#][^[:space:]<>"]*)?$'));

-- owner_save_shop: as in update 21, plus the booking link (kept as it is when the form does not send it).
create or replace function public.owner_save_shop(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_name text := left(trim(coalesce(p ->> 'name', '')), 200);
  v_lat double precision := nullif(p ->> 'lat', '')::double precision;
  v_lng double precision := nullif(p ->> 'lng', '')::double precision;
  v_email text := public.clean_contact('email', p ->> 'email');
  v_facebook text := public.clean_contact('facebook', p ->> 'facebook_url');
  v_booking text := public.clean_contact('booking', p ->> 'booking_url');
  v_location extensions.geography;
  v_base text;
  v_slug text;
  v_n integer := 1;
begin
  if v_user is null then
    raise exception 'Please log in' using errcode = '42501';
  end if;
  if v_name = '' then
    raise exception 'The shop needs a name' using errcode = '22023';
  end if;
  if v_lat is not null and v_lng is not null then
    if v_lat not between -90 and 90 or v_lng not between -180 and 180 then
      raise exception 'Invalid coordinates' using errcode = '22023';
    end if;
    v_location := extensions.st_setsrid(extensions.st_makepoint(v_lng, v_lat), 4326)::extensions.geography;
  end if;
  if v_email is not null and not (length(v_email) <= 254
       and v_email ~* '^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}$') then
    raise exception 'email' using errcode = '22023';
  end if;
  if v_facebook is not null and not (length(v_facebook) <= 300
       and v_facebook ~* '^https://([a-z0-9-]+\.)?(facebook\.com|fb\.com)/[^[:space:]<>"]+$') then
    raise exception 'facebook' using errcode = '22023';
  end if;
  if v_booking is not null and not (length(v_booking) <= 500
       and v_booking ~* '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.([a-z]{2,63}|xn--[a-z0-9-]{1,59})(:[0-9]{1,5})?([/?#][^[:space:]<>"]*)?$') then
    raise exception 'booking' using errcode = '22023';
  end if;

  if v_id is null then
    if (select count(*) from public.shop_members where user_id = v_user) >= 5 then
      raise exception 'An account can have at most 5 shops' using errcode = '54000';
    end if;
    v_base := trim(both '-' from regexp_replace(lower(coalesce(p ->> 'slug_base', '')), '[^a-z0-9]+', '-', 'g'));
    v_base := left(coalesce(nullif(v_base, ''), 'shop'), 60);
    v_base := trim(both '-' from v_base);
    v_slug := v_base;
    while exists (select 1 from public.shops where slug = v_slug) loop
      v_n := v_n + 1;
      v_slug := v_base || '-' || v_n;
    end loop;

    insert into public.shops (
      slug, name, ico, address, city, country, timezone, location, phone, website, email, facebook_url, booking_url,
      opening_hours, is_active, has_toilet, has_douchette, has_card_terminal
    ) values (
      v_slug, v_name, nullif(p ->> 'ico', ''), nullif(p ->> 'address', ''),
      nullif(p ->> 'city', ''), nullif(upper(p ->> 'country'), ''),
      coalesce(nullif(p ->> 'timezone', ''), 'UTC'),
      v_location, nullif(p ->> 'phone', ''), nullif(p ->> 'website', ''), v_email, v_facebook, v_booking,
      coalesce(p -> 'opening_hours', '{}'::jsonb), coalesce((p ->> 'is_active')::boolean, true),
      coalesce((p ->> 'has_toilet')::boolean, false), coalesce((p ->> 'has_douchette')::boolean, false),
      coalesce((p ->> 'has_card_terminal')::boolean, false)
    )
    returning id into v_id;
    insert into public.shop_members (shop_id, user_id) values (v_id, v_user);
    insert into public.sync_sources (shop_id) values (v_id);
  else
    if not public.is_shop_member(v_id) then
      raise exception 'Not your shop' using errcode = '42501';
    end if;
    update public.shops set
      name = v_name,
      ico = nullif(p ->> 'ico', ''),
      address = nullif(p ->> 'address', ''),
      city = nullif(p ->> 'city', ''),
      country = nullif(upper(p ->> 'country'), ''),
      timezone = coalesce(nullif(p ->> 'timezone', ''), 'UTC'),
      location = v_location,
      phone = nullif(p ->> 'phone', ''),
      website = nullif(p ->> 'website', ''),
      email = v_email,
      facebook_url = v_facebook,
      booking_url = case when p ? 'booking_url' then v_booking else booking_url end,
      opening_hours = coalesce(p -> 'opening_hours', '{}'::jsonb),
      is_active = coalesce((p ->> 'is_active')::boolean, false),
      has_toilet = coalesce((p ->> 'has_toilet')::boolean, false),
      has_douchette = coalesce((p ->> 'has_douchette')::boolean, false),
      has_card_terminal = coalesce((p ->> 'has_card_terminal')::boolean, false)
    where id = v_id;
  end if;
  return v_id;
end;
$$;
revoke execute on function public.owner_save_shop(jsonb) from public, anon;
grant execute on function public.owner_save_shop(jsonb) to authenticated;

-- public_shops: as in update 21, plus the booking link (last).
create or replace view public.public_shops as
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
  public.freshness_label(ss.latest_file_time) as freshness_state,
  public.freshness_age_minutes(ss.latest_file_time) as freshness_age_minutes,
  ss.latest_file_time,
  sh.has_toilet,
  sh.has_douchette,
  sh.has_card_terminal,
  sh.email,
  sh.facebook_url,
  sh.assistant_label,
  sh.assistant_welcome,
  sh.booking_url
from public.shops sh
left join public.sync_sources ss on ss.shop_id = sh.id
where sh.is_active;
grant select on public.public_shops to anon, authenticated;

-- my_shops: as in update 21, plus the booking link (last).
drop function if exists public.my_shops();
create function public.my_shops()
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
  logo_url text,
  is_active boolean,
  has_toilet boolean,
  has_douchette boolean,
  has_card_terminal boolean,
  field_mapping jsonb,
  mapping_status text,
  sample_rows jsonb,
  latest_file_time timestamptz,
  last_error text,
  freshness_state text,
  folder_seen_at timestamptz,
  last_file_name text,
  email text,
  facebook_url text,
  assistant_label text,
  assistant_welcome text,
  file_columns text[],
  booking_url text
)
language sql
stable
security definer
set search_path = ''
as $$
  select sh.id, sh.slug, sh.name, sh.ico, sh.address, sh.city, sh.country, sh.timezone,
         extensions.st_y(sh.location::extensions.geometry), extensions.st_x(sh.location::extensions.geometry),
         sh.phone, sh.website, sh.opening_hours, sh.logo_url,
         sh.is_active, sh.has_toilet, sh.has_douchette, sh.has_card_terminal,
         ss.field_mapping, ss.mapping_status, ss.sample_rows, ss.latest_file_time, ss.last_error,
         public.freshness_label(ss.latest_file_time), ss.folder_seen_at, ss.last_file_name,
         sh.email, sh.facebook_url, sh.assistant_label, sh.assistant_welcome, ss.file_columns, sh.booking_url
  from public.shops sh
  join public.shop_members m on m.shop_id = sh.id and m.user_id = auth.uid()
  left join public.sync_sources ss on ss.shop_id = sh.id
  order by sh.name
$$;
revoke execute on function public.my_shops() from public, anon;
grant execute on function public.my_shops() to authenticated;

-- ------------------------------------------------------------------ product pages without other shops

/**
 * Whether the shop's product pages stand alone (no "Dostupné aj v" list, no "not found
 * elsewhere" text, no other shops on the map or in the JSON-LD): the shop has the paid plan,
 * or a domain of its own is being set up or is live. Free shops and the main search keep
 * the other shops. Payment never changes search ranking.
 */
create or replace function public.shop_stands_alone(p_shop_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.shop_has_plan(p_shop_id)
      or exists (select 1 from public.domain_orders o
                 where o.shop_id = p_shop_id
                   and o.status in ('paid', 'registering', 'configuring', 'securing', 'waiting_dns', 'verified', 'live'))
$$;
revoke execute on function public.shop_stands_alone(uuid) from public;
grant execute on function public.shop_stands_alone(uuid) to anon, authenticated, service_role;
