-- PPI · 8 · Owner dashboard and admin area.

-- Sample rows of the shop's latest file, shown next to the AI-proposed field
-- mapping on the admin screen. Written by the stock-pull function (phase 6).
alter table public.sync_sources add column if not exists sample_rows jsonb;

-- The sync columns guarded so far stay guarded; sample_rows is sync output too.
create or replace function public.guard_sync_source_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_client_request() then
    if tg_op = 'INSERT' then
      new.latest_file_time := null;
      new.last_checked_at := null;
      new.last_error := null;
      new.sample_rows := null;
    elsif new.latest_file_time is distinct from old.latest_file_time
       or new.last_checked_at is distinct from old.last_checked_at
       or new.last_error is distinct from old.last_error
       or new.sample_rows is distinct from old.sample_rows then
      raise exception 'Sync results are written only by the stock-pull function'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- Owner dashboard: the shop's items (public or hidden) with the label shoppers
-- would see. Runs with the caller's rights, so RLS limits it to own shops.
create or replace function public.owner_items(
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
  total_count bigint
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
    count(*) over ()
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
      or public.search_text(si.name) like
           '%' || replace(replace(replace(public.search_text(trim(owner_items.q)), '\', '\\'), '%', '\%'), '_', '\_') || '%'
      or si.source_code = trim(owner_items.q)
      or si.ean = trim(owner_items.q)
    )
  order by si.name, si.id
  limit least(greatest(coalesce(owner_items.p_limit, 50), 1), 100)
  offset greatest(coalesce(owner_items.p_offset, 0), 0)
$$;

grant execute on function public.owner_items(uuid, text, integer, integer) to authenticated;
revoke execute on function public.owner_items(uuid, text, integer, integer) from anon;

-- Admin: every shop with its sync status in one list.
create or replace function public.admin_shops()
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
  owner_count bigint
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
      (select count(*) from public.shop_members m where m.shop_id = sh.id)
    from public.shops sh
    left join public.sync_sources ss on ss.shop_id = sh.id
    order by sh.name;
end;
$$;

revoke execute on function public.admin_shops() from public, anon;
grant execute on function public.admin_shops() to authenticated;

-- Admin: create or edit a shop in one call (location from lat/lng).
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
      opening_hours, visibility_mode, low_stock_threshold, is_active
    ) values (
      p ->> 'slug', p ->> 'name', nullif(p ->> 'ico', ''), nullif(p ->> 'address', ''),
      nullif(p ->> 'city', ''), nullif(upper(p ->> 'country'), ''), coalesce(nullif(p ->> 'timezone', ''), 'UTC'),
      v_location, nullif(p ->> 'phone', ''), nullif(p ->> 'website', ''),
      coalesce(p -> 'opening_hours', '{}'::jsonb), coalesce(nullif(p ->> 'visibility_mode', ''), 'in_stock'),
      coalesce(nullif(p ->> 'low_stock_threshold', '')::integer, 3), coalesce((p ->> 'is_active')::boolean, false)
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
      is_active = coalesce((p ->> 'is_active')::boolean, false)
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

-- Admin: owners of a shop with their e-mail (auth.users is not readable otherwise).
create or replace function public.admin_shop_owners(p_shop_id uuid)
returns table (user_id uuid, email text, added_at timestamptz)
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
    select m.user_id, u.email::text, m.created_at
    from public.shop_members m
    join auth.users u on u.id = m.user_id
    where m.shop_id = p_shop_id
    order by m.created_at;
end;
$$;

revoke execute on function public.admin_shop_owners(uuid) from public, anon;
grant execute on function public.admin_shop_owners(uuid) to authenticated;

-- For the invite-owner Edge Function only: find an existing login by e-mail.
create or replace function public.user_id_by_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id from auth.users u where lower(u.email) = lower(trim(p_email)) limit 1
$$;

revoke execute on function public.user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.user_id_by_email(text) to service_role;

-- Shop logos in Supabase Storage: anyone may view, members (and admin) may
-- upload into their shop's folder "<shop id>/...". Skipped where Storage is absent.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'storage' and c.relname = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('logos', 'logos', true, 1048576, array['image/png', 'image/jpeg', 'image/webp'])
    on conflict (id) do nothing;

    execute 'drop policy if exists "logos: members upload" on storage.objects';
    execute 'drop policy if exists "logos: members update" on storage.objects';
    execute 'drop policy if exists "logos: members delete" on storage.objects';
    execute $p$
      create policy "logos: members upload" on storage.objects for insert to authenticated
      with check (
        bucket_id = 'logos'
        and (public.is_admin() or public.is_shop_member(((storage.foldername(name))[1])::uuid))
      )$p$;
    execute $p$
      create policy "logos: members update" on storage.objects for update to authenticated
      using (
        bucket_id = 'logos'
        and (public.is_admin() or public.is_shop_member(((storage.foldername(name))[1])::uuid))
      )$p$;
    execute $p$
      create policy "logos: members delete" on storage.objects for delete to authenticated
      using (
        bucket_id = 'logos'
        and (public.is_admin() or public.is_shop_member(((storage.foldername(name))[1])::uuid))
      )$p$;
  end if;
end;
$$;

-- Dashboard preview: the label shoppers would see in each visibility mode for a
-- plentiful, a low and a zero stock, computed by the same availability_label().
create or replace function public.availability_preview(p_threshold integer)
returns table (mode text, quantity numeric, label text)
language sql
immutable
set search_path = ''
as $$
  select m.mode, qty.quantity,
         public.availability_label(m.mode, qty.quantity, least(greatest(p_threshold, 1), 50), 'current')
  from (values ('exact', 1), ('in_stock', 2), ('yes_no', 3)) as m(mode, ord)
  cross join lateral (
    values (greatest(least(greatest(p_threshold, 1), 50) + 5, 12)::numeric, 1),
           (least(greatest(p_threshold, 1), 50)::numeric, 2),
           (0::numeric, 3)
  ) as qty(quantity, ord)
  order by m.ord, qty.ord
$$;

grant execute on function public.availability_preview(integer) to authenticated;
