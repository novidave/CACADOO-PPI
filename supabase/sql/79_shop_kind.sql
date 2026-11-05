-- =====================================================================================================================
-- Update 79 — the kind of shop first (2026-11-05, at the owner's request; the owner's OK for the new shop type rule)
--
-- 1. shops.kind: 'goods' (every shop so far: a shop with stock — a stock file, an inventory program or Sklad) | 'food'
--    (a restaurant, a bistro, food: the menu, orders through the assistant, delivery and pickup). 'services' is allowed
--    by the check for later but not offered yet. Chosen first in "Nový obchod" (owner_save_shop, on insert only) and
--    changed later only through owner_set_shop_kind() (members; activity `shop_kind_changed`). NOTHING is deleted by a
--    change: products, files, orders and settings stay; only what Môj obchod shows and the setup steps change.
-- 2. "Nastavenie obchodu": owner_setup_steps(shop) decides every step and why it is missing (codes; the website shows
--    them in words). goods: details · hours · stock · languages · page · assistant (optional, Pro). food: details · hours
--    · menu · orders · couriers (optional) · assistant · launch. owner_skip_setup_step() skips an optional step only.
-- 3. my_shops() returns the kind (last).
--
-- Needs updates 26, 40, 43, 47, 51, 67, 68, 73–75. Run the whole file once; running it again is harmless.
-- =====================================================================================================================

-- ------------------------------------------------------------------ 1. the kind of shop

alter table public.shops add column if not exists kind text not null default 'goods';
alter table public.shops drop constraint if exists shops_kind_check;
alter table public.shops add constraint shops_kind_check check (kind in ('goods', 'food', 'services'));

-- the activity log knows the change of kind and a skipped setup step
do $$
declare
  v_def text := (select pg_get_constraintdef(c.oid) from pg_constraint c
                 where c.conrelid = 'public.shop_activity'::regclass and c.conname = 'shop_activity_action_check');
  v_add text := '';
  a text;
begin
  if v_def is null then return; end if;
  foreach a in array array['shop_kind_changed', 'setup_step_skipped'] loop
    if position('''' || a || '''' in v_def) = 0 then v_add := v_add || '''' || a || '''::text, '; end if;
  end loop;
  if v_add <> '' then
    alter table public.shop_activity drop constraint shop_activity_action_check;
    execute 'alter table public.shop_activity add constraint shop_activity_action_check ' || replace(v_def, 'ARRAY[', 'ARRAY[' || v_add);
  end if;
end;
$$;

/** The optional setup steps the owner skipped ("Preskočiť"); only the functions below write it. */
create table if not exists public.shop_setup (
  shop_id     uuid primary key references public.shops (id) on delete cascade,
  skipped     text[] not null default '{}',
  updated_at  timestamptz not null default now()
);
alter table public.shop_setup enable row level security;
revoke all on public.shop_setup from public, anon, authenticated;
grant all on public.shop_setup to service_role;

-- owner_save_shop: as in update 26, plus the kind of a NEW shop ('goods' when not given; a later change of kind goes
-- only through owner_set_shop_kind, so it is always logged).
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
  v_kind text := coalesce(nullif(p ->> 'kind', ''), 'goods');
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
  if v_kind not in ('goods', 'food') then
    raise exception 'kind' using errcode = '22023';
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
      opening_hours, is_active, has_toilet, has_douchette, has_card_terminal, kind
    ) values (
      v_slug, v_name, nullif(p ->> 'ico', ''), nullif(p ->> 'address', ''),
      nullif(p ->> 'city', ''), nullif(upper(p ->> 'country'), ''),
      coalesce(nullif(p ->> 'timezone', ''), 'UTC'),
      v_location, nullif(p ->> 'phone', ''), nullif(p ->> 'website', ''), v_email, v_facebook, v_booking,
      coalesce(p -> 'opening_hours', '{}'::jsonb), coalesce((p ->> 'is_active')::boolean, true),
      coalesce((p ->> 'has_toilet')::boolean, false), coalesce((p ->> 'has_douchette')::boolean, false),
      coalesce((p ->> 'has_card_terminal')::boolean, false), v_kind
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

/**
 * "Typ obchodu": the owner changes the kind of the shop. Members only; 'goods' or 'food' ('services' is not offered
 * yet). Nothing is deleted — only what Môj obchod shows and the setup steps change. Returns the kind; a real change is
 * written to the activity log (from → to).
 */
create or replace function public.owner_set_shop_kind(p_shop_id uuid, p_kind text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old text;
begin
  if auth.uid() is null or p_shop_id is null or not public.is_shop_member(p_shop_id) then
    raise exception 'not_member' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('goods', 'food') then
    raise exception 'kind' using errcode = '22023';
  end if;
  select kind into v_old from public.shops where id = p_shop_id for update;
  if v_old = p_kind then return p_kind; end if;
  update public.shops set kind = p_kind where id = p_shop_id;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'shop_kind_changed', jsonb_build_object('from', v_old, 'to', p_kind));
  return p_kind;
end;
$$;
revoke execute on function public.owner_set_shop_kind(uuid, text) from public, anon;
grant execute on function public.owner_set_shop_kind(uuid, text) to authenticated;

-- my_shops: as in update 51, plus the kind of shop (last).
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
  booking_url text,
  company_name text,
  dic text,
  zip text,
  contact_buttons jsonb,
  kind text
)
language sql
stable
security definer
set search_path = ''
set jit = off
as $$
  select sh.id, sh.slug, sh.name, sh.ico, sh.address, sh.city, sh.country, sh.timezone,
         extensions.st_y(sh.location::extensions.geometry), extensions.st_x(sh.location::extensions.geometry),
         sh.phone, sh.website, sh.opening_hours, sh.logo_url,
         sh.is_active, sh.has_toilet, sh.has_douchette, sh.has_card_terminal,
         ss.field_mapping, ss.mapping_status, ss.sample_rows, ss.latest_file_time, ss.last_error,
         public.freshness_label(ss.latest_file_time), ss.folder_seen_at, ss.last_file_name,
         sh.email, sh.facebook_url, sh.assistant_label, sh.assistant_welcome, ss.file_columns, sh.booking_url,
         co.company_name, co.dic, co.zip, sh.contact_buttons, sh.kind
  from public.shops sh
  join public.shop_members m on m.shop_id = sh.id and m.user_id = auth.uid()
  left join public.sync_sources ss on ss.shop_id = sh.id
  left join public.shop_company co on co.shop_id = sh.id
  order by sh.name
$$;
revoke execute on function public.my_shops() from public, anon;
grant execute on function public.my_shops() to authenticated;

-- ------------------------------------------------------------------ 2. "Nastavenie obchodu"

/** The optional steps per kind (only these can be skipped). */
create or replace function public.setup_optional_steps(p_kind text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_kind when 'food' then array['couriers'] else array['assistant'] end
$$;
revoke execute on function public.setup_optional_steps(text) from public;
grant execute on function public.setup_optional_steps(text) to authenticated, service_role;

/**
 * The setup steps of a shop, in their order, each {key, done, optional, skipped, missing: [codes]}; `finished` when
 * every step is done or (optional and) skipped. Members only. Missing codes (the website says them in words):
 * address · city · country · contact · hours · stock · columns · languages · logo · plan · welcome · menu · menu_pdf ·
 * no_kind · zones · iban · couriers · enabled.
 */
create or replace function public.owner_setup_steps(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  sh public.shops;
  ss public.sync_sources;
  fs public.food_settings;
  v_skipped text[];
  v_plan boolean;
  v_source text;
  v_steps jsonb := '[]'::jsonb;
  v_miss text[];
  v_done integer := 0;
  v_total integer := 0;
  v_open integer := 0;
  v_optional text[];
  k text;
  -- (key, missing) of each step in order
  v_list jsonb := '[]'::jsonb;
  st jsonb;
begin
  if auth.uid() is null or p_shop_id is null or not public.is_shop_member(p_shop_id) then
    raise exception 'not_member' using errcode = '42501';
  end if;
  select * into sh from public.shops where id = p_shop_id;
  select * into ss from public.sync_sources where shop_id = p_shop_id;
  select * into fs from public.food_settings where shop_id = p_shop_id;
  v_skipped := coalesce((select skipped from public.shop_setup where shop_id = p_shop_id), '{}');
  v_plan := public.shop_has_plan(p_shop_id);
  v_optional := public.setup_optional_steps(sh.kind);

  -- Údaje obchodu: the address the page and the map show, a way to reach the shop
  v_miss := array_remove(array[
    case when nullif(btrim(coalesce(sh.address, '')), '') is null then 'address' end,
    case when nullif(btrim(coalesce(sh.city, '')), '') is null then 'city' end,
    case when sh.country is null then 'country' end,
    case when nullif(btrim(coalesce(sh.phone, '')), '') is null and sh.email is null then 'contact' end], null);
  v_list := v_list || jsonb_build_object('key', 'details', 'missing', to_jsonb(v_miss));

  -- Otváracie hodiny: at least one day with a time
  v_list := v_list || jsonb_build_object('key', 'hours', 'missing', to_jsonb(case when exists (
    select 1 from jsonb_each(coalesce(sh.opening_hours, '{}'::jsonb)) e
    where jsonb_typeof(e.value) = 'array' and jsonb_array_length(e.value) > 0) then '{}'::text[] else array['hours'] end));

  if sh.kind = 'food' then
    -- Menu: Sklad products with a sale price (the only price source of the orders)
    v_list := v_list || jsonb_build_object('key', 'menu', 'missing', to_jsonb(case when exists (
      select 1 from public.sklad_items i where i.shop_id = p_shop_id and i.sale_price is not null)
      then '{}'::text[] else array['menu'] end));

    -- Objednávky: pickup or delivery, zones for a delivery, the IBAN for the QR payment, the plan
    v_miss := array_remove(array[
      case when not v_plan then 'plan' end,
      case when not coalesce(fs.pickup_on, true) and not coalesce(fs.delivery_on, false) then 'no_kind' end,
      case when coalesce(fs.delivery_on, false)
             and not exists (select 1 from public.food_zones z where z.shop_id = p_shop_id) then 'zones' end,
      case when coalesce(fs.pay_qr, true)
             and not exists (select 1 from public.sklad_settings st where st.shop_id = p_shop_id and st.iban is not null)
           then 'iban' end], null);
    v_list := v_list || jsonb_build_object('key', 'orders', 'missing', to_jsonb(v_miss));

    -- Kuriéri (optional): an active courier
    v_list := v_list || jsonb_build_object('key', 'couriers', 'missing', to_jsonb(case when exists (
      select 1 from public.food_couriers c where c.shop_id = p_shop_id and c.active)
      then '{}'::text[] else array['couriers'] end));

    -- AI asistent: the plan, the welcome text, the menu (PDF) in the Public folder for the allergens
    v_miss := array_remove(array[
      case when not v_plan then 'plan' end,
      case when sh.assistant_welcome is null then 'welcome' end,
      case when not exists (select 1 from public.shop_documents d join public.shop_folders f on f.id = d.folder_id and f.is_public
                            where d.shop_id = p_shop_id and d.status = 'ready' and d.assistant_enabled) then 'menu_pdf' end], null);
    v_list := v_list || jsonb_build_object('key', 'assistant', 'missing', to_jsonb(v_miss));

    -- Náhľad a spustenie: "Prijímať objednávky"
    v_list := v_list || jsonb_build_object('key', 'launch', 'missing', to_jsonb(case when coalesce(fs.enabled, false)
      then '{}'::text[] else array['enabled'] end));
  else
    -- Zdroj zásob: a program, the POS agent, Sklad, or a stock file whose columns are approved
    v_source := public.stock_source_of(p_shop_id);
    v_list := v_list || jsonb_build_object('key', 'stock', 'missing', to_jsonb(case
      when v_source <> 'file' then '{}'::text[]
      when ss.latest_file_time is null and ss.mapping_status is distinct from 'proposed' then array['stock']
      when ss.mapping_status is distinct from 'confirmed' then array['columns']
      else '{}'::text[] end));

    -- Jazyky: saved once (the languages the page is translated into)
    v_list := v_list || jsonb_build_object('key', 'languages', 'missing', to_jsonb(case when exists (
      select 1 from public.shop_language_settings ls where ls.shop_id = p_shop_id) then '{}'::text[] else array['languages'] end));

    -- Stránka obchodu: the logo
    v_list := v_list || jsonb_build_object('key', 'page', 'missing', to_jsonb(case when sh.logo_url is not null
      then '{}'::text[] else array['logo'] end));

    -- AI asistent (Pro, optional): the plan and the welcome text
    v_miss := array_remove(array[
      case when not v_plan then 'plan' end,
      case when sh.assistant_welcome is null then 'welcome' end], null);
    v_list := v_list || jsonb_build_object('key', 'assistant', 'missing', to_jsonb(v_miss));
  end if;

  for st in select * from jsonb_array_elements(v_list) loop
    k := st ->> 'key';
    v_total := v_total + 1;
    if jsonb_array_length(st -> 'missing') = 0 then v_done := v_done + 1;
    elsif not (k = any(v_optional) and k = any(v_skipped)) then v_open := v_open + 1;
    end if;
    v_steps := v_steps || jsonb_build_object(
      'key', k,
      'done', jsonb_array_length(st -> 'missing') = 0,
      'optional', k = any(v_optional),
      'skipped', k = any(v_optional) and k = any(v_skipped),
      'missing', st -> 'missing');
  end loop;
  return jsonb_build_object('kind', sh.kind, 'steps', v_steps, 'done', v_done, 'total', v_total, 'finished', v_open = 0);
end;
$$;
revoke execute on function public.owner_setup_steps(uuid) from public, anon;
grant execute on function public.owner_setup_steps(uuid) to authenticated;

/** "Preskočiť" / "Zobraziť znova": only an optional step of the shop's kind. Returns the skipped steps. */
create or replace function public.owner_skip_setup_step(p_shop_id uuid, p_step text, p_skip boolean)
returns text[]
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_out text[];
begin
  if auth.uid() is null or p_shop_id is null or not public.is_shop_member(p_shop_id) then
    raise exception 'not_member' using errcode = '42501';
  end if;
  select kind into v_kind from public.shops where id = p_shop_id;
  if p_step is null or not (p_step = any(public.setup_optional_steps(v_kind))) then
    raise exception 'not_optional' using errcode = '22023';
  end if;
  insert into public.shop_setup (shop_id, skipped)
  values (p_shop_id, case when coalesce(p_skip, true) then array[p_step] else '{}' end)
  on conflict (shop_id) do update
    set skipped = case when coalesce(p_skip, true)
                       then (select array_agg(distinct s order by s) from unnest(public.shop_setup.skipped || p_step) s)
                       else array_remove(public.shop_setup.skipped, p_step) end,
        updated_at = now()
  returning skipped into v_out;
  if coalesce(p_skip, true) then
    insert into public.shop_activity (shop_id, actor, action, details)
    values (p_shop_id, auth.uid(), 'setup_step_skipped', jsonb_build_object('step', p_step));
  end if;
  return coalesce(v_out, '{}');
end;
$$;
revoke execute on function public.owner_skip_setup_step(uuid, text, boolean) from public, anon;
grant execute on function public.owner_skip_setup_step(uuid, text, boolean) to authenticated;

notify pgrst, 'reload schema';
