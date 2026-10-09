-- PPI · 21 · Shop page and Môj obchod updates.
--  1. One stock display rule for every shop, decided only by the shop's own file: the
--     quantity exactly as in the file ("12 ks na sklade"), sold out at 0 or less, nothing
--     while the data is stale. The old display settings are DROPPED, not pinned:
--     shops.visibility_mode, shops.low_stock_threshold and shop_items.is_public, with
--     everything that set them (availability_preview(), the owners' item update path and
--     the legacy admin_shops() / admin_save_shop()). Every item of the file is public.
--  2. shops.email and shops.facebook_url (checked here), for the shop page and its JSON-LD.
--  3. The shop assistant's button label and welcome message (paid plan): plain text only,
--     cleaned here whoever writes them.
--  4. stock_imports: the last 10 received stock files of each shop, for its owners only.
--  5. Private columns (every column not in the approved mapping) are never stored outside
--     the raw-files bucket: sync_sources keeps the file's column names (file_columns) and
--     sample values only of the mapped columns (before approval: of columns whose names do
--     not point to purchase prices, suppliers, margins or invoices, 3 rows at most).
-- Safe to run again.

-- ------------------------------------------------------------------ helpers

/** Plain text: no HTML, no links or e-mail addresses, no control characters, one line, at most p_max characters. */
create or replace function public.plain_text(p_value text, p_max integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(left(btrim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(coalesce(p_value, ''), '<[^>]*>', ' ', 'g'),
            '[^[:space:]<>]+@[^[:space:]<>]+', ' ', 'g'),
          '((https?|ftp)://|www\.|mailto:)[^[:space:]]*', ' ', 'gi'),
        '\m[[:alnum:]_-]+(\.[[:alnum:]_-]+)*\.[a-z]{2,24}\M(/[^[:space:]]*)?', ' ', 'gi'),
      '[[:space:][:cntrl:]]+', ' ', 'g')
  ), greatest(coalesce(p_max, 0), 0)), '')
$$;

/** A column whose name points to purchase prices, suppliers, margins or invoices. */
create or replace function public.is_private_column(p_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select public.search_text(coalesce(p_name, '')) ~
    '(nakup|purchase|cost|beszerz|dodavatel|supplier|vendor|lieferant|szallit|marz|margin|arres|haszon|zisk|profit|faktur|invoice|rechnung|szamla|\mnc\M)'
$$;

/** The file columns an approved (or proposed) mapping uses, in field order. */
create or replace function public.mapped_columns(p_mapping jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(x.col order by x.ord), '{}'::text[])
  from (
    select distinct on (e.value) e.value as col,
           coalesce(array_position(array['source_code', 'name', 'ean', 'brand', 'quantity', 'price', 'currency',
                                         'description'], e.key), 100) as ord
    from jsonb_each_text(case when jsonb_typeof(p_mapping) = 'object' then p_mapping else '{}'::jsonb end) e
    where nullif(btrim(e.value), '') is not null
    order by e.value, 2
  ) x
$$;

/** One file row with only the given columns. */
create or replace function public.keep_columns(p_row jsonb, p_columns text[])
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
  from jsonb_each(case when jsonb_typeof(p_row) = 'object' then p_row else '{}'::jsonb end) e
  where e.key = any (coalesce(p_columns, '{}'::text[]))
$$;

revoke execute on function public.plain_text(text, integer) from public;
grant execute on function public.plain_text(text, integer) to anon, authenticated, service_role;
revoke execute on function public.is_private_column(text) from public;
grant execute on function public.is_private_column(text) to authenticated, service_role;
revoke execute on function public.mapped_columns(jsonb) from public;
grant execute on function public.mapped_columns(jsonb) to authenticated, service_role;
revoke execute on function public.keep_columns(jsonb, text[]) from public;
grant execute on function public.keep_columns(jsonb, text[]) to authenticated, service_role;

-- ------------------------------------------------------------------ 1. one stock display rule

-- The quantity exactly as in the shop's file: more than 0 = "<n> ks na sklade", otherwise
-- sold out; nothing while the data is stale.
create or replace function public.availability_label(p_quantity numeric, p_freshness text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_freshness is null or p_freshness = 'stale' then null
    when p_quantity > 0 then 'in_stock_count'
    else 'out_of_stock'
  end
$$;
grant execute on function public.availability_label(numeric, text) to anon, authenticated, service_role;

-- public_stock: same columns as before; every item of an active shop, the quantity as in
-- the file unless the data is stale.
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
  case when f.state <> 'stale' then inv.quantity end as quantity,
  public.availability_label(inv.quantity, f.state) as availability,
  coalesce(public.availability_label(inv.quantity, f.state) = 'in_stock_count', false) as is_available,
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
) f;

-- owner_items: the dashboard item list, now without the hide/show flag.
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
    public.availability_label(inv.quantity, f.state),
    coalesce(inv.source_updated_at, inv.received_at, si.updated_at),
    count(*) over (),
    si.name_lang, si.name_i18n, si.name_i18n_by_owner, si.translated_name_source
  from public.shop_items si
  left join public.inventory inv on inv.shop_item_id = si.id
  cross join f
  where si.shop_id = owner_items.p_shop_id
    -- Items of active shops are readable by everyone under RLS, so the dashboard list
    -- must check membership itself.
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
grant execute on function public.owner_items(uuid, text, integer, integer) to authenticated, service_role;

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
  order by si.name, si.id
  limit least(greatest(coalesce(items_to_translate.p_limit, 1000), 1), 5000)
$$;

-- Read access to items no longer depends on a hide flag; owners never write items.
drop policy if exists "shop_items: visitors read public items of active shops" on public.shop_items;
drop policy if exists "shop_items: users read public, own or all if admin" on public.shop_items;
drop policy if exists "shop_items: owner or admin update" on public.shop_items;
drop policy if exists "shop_items: visitors read items of active shops" on public.shop_items;
drop policy if exists "shop_items: users read items of active shops, own or all if admin" on public.shop_items;
create policy "shop_items: visitors read items of active shops" on public.shop_items
  for select to anon
  using (exists (select 1 from public.shops s where s.id = shop_id and s.is_active));
create policy "shop_items: users read items of active shops, own or all if admin" on public.shop_items
  for select to authenticated
  using (exists (select 1 from public.shops s where s.id = shop_id and s.is_active)
         or public.is_shop_member(shop_id) or public.is_admin());

drop function if exists public.availability_preview(integer);
drop function if exists public.availability_label(text, numeric, integer, text);
drop function if exists public.admin_shops();
drop function if exists public.admin_save_shop(jsonb);

alter table public.shops drop column if exists visibility_mode;
alter table public.shops drop column if exists low_stock_threshold;
alter table public.shop_items drop column if exists is_public;

-- ------------------------------------------------------------------ 2. and 3. shop profile

alter table public.shops add column if not exists email text;
alter table public.shops add column if not exists facebook_url text;
alter table public.shops add column if not exists assistant_label text;
alter table public.shops add column if not exists assistant_welcome text;

alter table public.shops drop constraint if exists shops_email_check;
alter table public.shops add constraint shops_email_check check (
  email is null or (length(email) <= 254 and email ~* '^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}$'));
alter table public.shops drop constraint if exists shops_facebook_url_check;
alter table public.shops add constraint shops_facebook_url_check check (
  facebook_url is null or (length(facebook_url) <= 300
    and facebook_url ~* '^https://([a-z0-9-]+\.)?(facebook\.com|fb\.com)/[^[:space:]<>"]+$'));
alter table public.shops drop constraint if exists shops_assistant_texts_check;
alter table public.shops add constraint shops_assistant_texts_check check (
  (assistant_label is null or length(assistant_label) <= 40)
  and (assistant_welcome is null or length(assistant_welcome) <= 300));

/**
 * The assistant's label and welcome message are plain text whoever writes them, and only a
 * shop with the paid plan changes them (the owner function checks it too).
 */
create or replace function public.guard_shop_assistant_texts()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.assistant_label := public.plain_text(new.assistant_label, 40);
  new.assistant_welcome := public.plain_text(new.assistant_welcome, 300);
  if tg_op = 'UPDATE' and public.is_client_request()
     and (new.assistant_label is distinct from old.assistant_label
          or new.assistant_welcome is distinct from old.assistant_welcome)
     and not public.shop_has_plan(new.id) then
    raise exception 'The assistant texts are part of the paid plan' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists shops_assistant_texts on public.shops;
create trigger shops_assistant_texts before insert or update of assistant_label, assistant_welcome on public.shops
  for each row execute function public.guard_shop_assistant_texts();

/** E-mail as typed (trimmed, lower case) and a Facebook page link with https://. */
create or replace function public.clean_contact(p_kind text, p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when nullif(btrim(coalesce(p_value, '')), '') is null then null
    when p_kind = 'email' then lower(btrim(p_value))
    else regexp_replace(regexp_replace(btrim(p_value), '^http://', 'https://', 'i'), '^(?!https?://)', 'https://')
  end
$$;
revoke execute on function public.clean_contact(text, text) from public;
grant execute on function public.clean_contact(text, text) to authenticated, service_role;

-- owner_save_shop: as before, without the display settings, with e-mail and Facebook page.
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
      slug, name, ico, address, city, country, timezone, location, phone, website, email, facebook_url,
      opening_hours, is_active, has_toilet, has_douchette, has_card_terminal
    ) values (
      v_slug, v_name, nullif(p ->> 'ico', ''), nullif(p ->> 'address', ''),
      nullif(p ->> 'city', ''), nullif(upper(p ->> 'country'), ''),
      coalesce(nullif(p ->> 'timezone', ''), 'UTC'),
      v_location, nullif(p ->> 'phone', ''), nullif(p ->> 'website', ''), v_email, v_facebook,
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

/** The assistant's button label and welcome message (paid plan); empty = the default text. */
create or replace function public.owner_set_assistant_texts(p_shop_id uuid, p_label text, p_welcome text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_label text;
  v_welcome text;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if not public.shop_has_plan(p_shop_id) then
    raise exception 'no_plan' using errcode = 'P0001';
  end if;
  update public.shops
  set assistant_label = p_label, assistant_welcome = p_welcome
  where id = p_shop_id
  returning assistant_label, assistant_welcome into v_label, v_welcome;
  return jsonb_build_object('label', v_label, 'welcome', v_welcome);
end;
$$;
revoke execute on function public.owner_set_assistant_texts(uuid, text, text) from public, anon;
grant execute on function public.owner_set_assistant_texts(uuid, text, text) to authenticated;

-- public_shops: as before plus the contact links and the assistant texts (new columns last).
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
  sh.assistant_welcome
from public.shops sh
left join public.sync_sources ss on ss.shop_id = sh.id
where sh.is_active;
grant select on public.public_shops to anon, authenticated;

-- ------------------------------------------------------------------ 5. private columns

alter table public.sync_sources add column if not exists file_columns text[];

/**
 * sample_rows never hold private columns: once the mapping is approved only its columns
 * (5 rows); before that 3 rows without the columns whose names point to purchase prices,
 * suppliers, margins or invoices.
 */
create or replace function public.trim_sample_rows()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_cols text[];
begin
  if new.sample_rows is null or jsonb_typeof(new.sample_rows) <> 'array' then
    return new;
  end if;
  if new.mapping_status = 'confirmed' and new.field_mapping is not null then
    v_cols := public.mapped_columns(new.field_mapping);
    new.sample_rows := (
      select coalesce(jsonb_agg(public.keep_columns(r.value, v_cols) order by r.ord), '[]'::jsonb)
      from jsonb_array_elements(new.sample_rows) with ordinality r(value, ord)
      where r.ord <= 5);
  else
    new.sample_rows := (
      select coalesce(jsonb_agg(
               (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
                from jsonb_each(case when jsonb_typeof(r.value) = 'object' then r.value else '{}'::jsonb end) e
                where not public.is_private_column(e.key))
               order by r.ord), '[]'::jsonb)
      from jsonb_array_elements(new.sample_rows) with ordinality r(value, ord)
      where r.ord <= 3);
  end if;
  return new;
end;
$$;
drop trigger if exists sync_sources_trim_samples on public.sync_sources;
create trigger sync_sources_trim_samples
  before insert or update of sample_rows, field_mapping, mapping_status on public.sync_sources
  for each row execute function public.trim_sample_rows();

-- Sync output, like the sample rows: written only by stock-pull.
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
      new.file_columns := null;
    elsif new.latest_file_time is distinct from old.latest_file_time
       or new.last_checked_at is distinct from old.last_checked_at
       or new.last_error is distinct from old.last_error
       or new.sample_rows is distinct from old.sample_rows
       or new.file_columns is distinct from old.file_columns then
      raise exception 'Sync results are written only by the stock-pull function'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- Existing samples: the column names stay, private values go.
update public.sync_sources s
set file_columns = coalesce(s.file_columns, (
      select array_agg(distinct k.key order by k.key)
      from jsonb_array_elements(s.sample_rows) r, jsonb_object_keys(r) k(key)
      where jsonb_typeof(r) = 'object'))
where s.sample_rows is not null and jsonb_typeof(s.sample_rows) = 'array';
update public.sync_sources set sample_rows = sample_rows where sample_rows is not null;

-- my_shops: as before, without the display settings; with the contact links, the assistant
-- texts and the file's column names.
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
  file_columns text[]
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
         sh.email, sh.facebook_url, sh.assistant_label, sh.assistant_welcome, ss.file_columns
  from public.shops sh
  join public.shop_members m on m.shop_id = sh.id and m.user_id = auth.uid()
  left join public.sync_sources ss on ss.shop_id = sh.id
  order by sh.name
$$;
revoke execute on function public.my_shops() from public, anon;
grant execute on function public.my_shops() to authenticated;

-- ------------------------------------------------------------------ 4. stock_imports

create table if not exists public.stock_imports (
  id          bigint generated always as identity primary key,
  shop_id     uuid not null references public.shops (id) on delete cascade,
  file_name   text,
  file_time   timestamptz,
  received_at timestamptz not null default now(),
  -- ok: applied without unreadable rows; errors: applied with unreadable rows, or not
  -- applied; waiting: the file's columns wait for the owner's approval
  status      text not null check (status in ('ok', 'errors', 'waiting')),
  total_rows  integer not null default 0 check (total_rows >= 0),
  imported    integer not null default 0 check (imported >= 0),
  zeroed      integer not null default 0 check (zeroed >= 0),
  skipped     integer not null default 0 check (skipped >= 0),
  error       text check (error is null or length(error) <= 500),
  -- the mapped columns of the preview, in field order; never a private column
  columns     text[] not null default '{}',
  -- the first 5 rows of those columns, exactly as in the file
  preview     jsonb not null default '[]'::jsonb
);
create index if not exists stock_imports_shop_idx on public.stock_imports (shop_id, received_at desc);

alter table public.stock_imports enable row level security;
revoke all on public.stock_imports from public, anon, authenticated;
grant select on public.stock_imports to authenticated;
grant all on public.stock_imports to service_role;
drop policy if exists "stock_imports: members read" on public.stock_imports;
create policy "stock_imports: members read" on public.stock_imports
  for select to authenticated using (public.is_shop_member(shop_id));

/**
 * stock-pull's report of one received file. The preview keeps only the columns of the
 * shop's approved mapping, at most 5 rows (until the owner approves the columns every
 * column counts as private: no preview); only the last 10 reports of a shop are kept.
 */
create or replace function public.record_stock_import(
  p_shop_id uuid,
  p_file_name text,
  p_file_time timestamptz,
  p_status text,
  p_total integer,
  p_imported integer,
  p_zeroed integer,
  p_skipped integer,
  p_error text,
  p_rows jsonb
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cols text[];
  v_id bigint;
begin
  if p_status is null or p_status not in ('ok', 'errors', 'waiting') then
    raise exception 'Unknown import status' using errcode = '22023';
  end if;
  select public.mapped_columns(s.field_mapping) into v_cols
  from public.sync_sources s
  where s.shop_id = p_shop_id and s.mapping_status = 'confirmed';
  v_cols := coalesce(v_cols, '{}'::text[]);
  insert into public.stock_imports (shop_id, file_name, file_time, status, total_rows, imported, zeroed, skipped,
                                    error, columns, preview)
  values (
    p_shop_id, left(p_file_name, 200), p_file_time, p_status,
    greatest(coalesce(p_total, 0), 0), greatest(coalesce(p_imported, 0), 0),
    greatest(coalesce(p_zeroed, 0), 0), greatest(coalesce(p_skipped, 0), 0),
    left(p_error, 500), v_cols,
    (select coalesce(jsonb_agg(public.keep_columns(r.value, v_cols) order by r.ord), '[]'::jsonb)
     from jsonb_array_elements(case when jsonb_typeof(p_rows) = 'array' then p_rows else '[]'::jsonb end)
          with ordinality r(value, ord)
     where r.ord <= 5 and cardinality(v_cols) > 0))
  returning id into v_id;
  delete from public.stock_imports
  where shop_id = p_shop_id
    and id not in (select i.id from public.stock_imports i where i.shop_id = p_shop_id
                   order by i.received_at desc, i.id desc limit 10);
  return v_id;
end;
$$;
revoke execute on function public.record_stock_import(uuid, text, timestamptz, text, integer, integer, integer, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_stock_import(uuid, text, timestamptz, text, integer, integer, integer, integer, text, jsonb)
  to service_role;
