-- PPI · 13 · Self-service: shop owners sign up, create and run their own shops,
-- and approve their own stock-file columns. No admin step on the website.

-- The shops of the logged-in owner, with the fields the dashboard needs
-- (coordinates as numbers, stock-file status and the column mapping).
create or replace function public.my_shops()
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
  last_file_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select sh.id, sh.slug, sh.name, sh.ico, sh.address, sh.city, sh.country, sh.timezone,
         extensions.st_y(sh.location::extensions.geometry), extensions.st_x(sh.location::extensions.geometry),
         sh.phone, sh.website, sh.opening_hours, sh.visibility_mode, sh.low_stock_threshold, sh.logo_url,
         sh.is_active, sh.has_toilet, sh.has_douchette, sh.has_card_terminal,
         ss.field_mapping, ss.mapping_status, ss.sample_rows, ss.latest_file_time, ss.last_error,
         public.freshness_label(ss.latest_file_time), ss.folder_seen_at, ss.last_file_name
  from public.shops sh
  join public.shop_members m on m.shop_id = sh.id and m.user_id = auth.uid()
  left join public.sync_sources ss on ss.shop_id = sh.id
  order by sh.name
$$;

revoke execute on function public.my_shops() from public, anon;
grant execute on function public.my_shops() to authenticated;

-- Create a shop (p.id empty) or update one of your own shops.
-- A new shop gets a unique page address made from p.slug_base, the creator as
-- its owner and an empty stock source. At most 5 shops per account.
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
      slug, name, ico, address, city, country, timezone, location, phone, website,
      opening_hours, visibility_mode, low_stock_threshold, is_active,
      has_toilet, has_douchette, has_card_terminal
    ) values (
      v_slug, v_name, nullif(p ->> 'ico', ''), nullif(p ->> 'address', ''),
      nullif(p ->> 'city', ''), nullif(upper(p ->> 'country'), ''),
      coalesce(nullif(p ->> 'timezone', ''), 'UTC'),
      v_location, nullif(p ->> 'phone', ''), nullif(p ->> 'website', ''),
      coalesce(p -> 'opening_hours', '{}'::jsonb), coalesce(nullif(p ->> 'visibility_mode', ''), 'in_stock'),
      coalesce(nullif(p ->> 'low_stock_threshold', '')::integer, 3), coalesce((p ->> 'is_active')::boolean, true),
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

-- The owner approves which column of the stock file is which. The next file the
-- shop PC sends is then applied (the PPI window re-sends the current file itself).
-- p_mapping: {"source_code": "...", "name": "...", "ean": ..., "brand": ..., "quantity": "...", "price": "...", "currency": ...}
create or replace function public.owner_set_mapping(p_shop_id uuid, p_mapping jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_clean jsonb := '{}'::jsonb;
  v_field text;
  v_value text;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if jsonb_typeof(p_mapping) is distinct from 'object' then
    raise exception 'The mapping must be an object' using errcode = '22023';
  end if;
  foreach v_field in array array['source_code', 'name', 'ean', 'brand', 'quantity', 'price', 'currency'] loop
    v_value := nullif(left(trim(coalesce(p_mapping ->> v_field, '')), 200), '');
    v_clean := v_clean || jsonb_build_object(v_field, v_value);
  end loop;
  if v_clean ->> 'source_code' is null or v_clean ->> 'name' is null
     or v_clean ->> 'quantity' is null or v_clean ->> 'price' is null then
    raise exception 'Item code, name, quantity and price must each be a column of the file' using errcode = '22023';
  end if;

  update public.sync_sources
  set field_mapping = v_clean, mapping_status = 'confirmed', last_error = null
  where shop_id = p_shop_id;
  if not found then
    raise exception 'The shop has no stock file yet' using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function public.owner_set_mapping(uuid, jsonb) from public, anon;
grant execute on function public.owner_set_mapping(uuid, jsonb) to authenticated;

-- The owner deletes one of their shops (items, stock and stock source go with it).
create or replace function public.owner_delete_shop(p_shop_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  delete from public.shops where id = p_shop_id;
end;
$$;

revoke execute on function public.owner_delete_shop(uuid) from public, anon;
grant execute on function public.owner_delete_shop(uuid) to authenticated;
