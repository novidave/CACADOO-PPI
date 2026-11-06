-- Update 87: Donáška without zones, the zone the customer picks (2026-11-06, at the owner's request).
--
-- 1. Donáška needs only its switch (food_settings.delivery_on); zones are optional. food_state.delivery = delivery_on
--    (no longer "on + a zone"), with zones_count and zone_list = [{id, label, kind, value, km, fee_cents, min_cents}]
--    in the owner's order — label = the zone's own customer name (food_zones.label, ≤ 40), else its town, else its
--    postcode(s), else "do <n> km"; never the shop's coordinates.
-- 2. No zones: a delivery goes through with fee 0 and no minimum (no zone question, no geocoding).
-- 3. Zones: food_quote(…, p_zone) — the zone the customer picked is required (zone_required), must be one of the shop's
--    (zone_unknown) and must fit the address (zone_mismatch; never another zone's fee): a town zone = the address's town
--    (food_town_of = townOf on the website: the last comma part without its postcode, or the address ends with the
--    town; accents and case ignored), a postcode zone = one of its postcodes in the address, a kilometre zone = the
--    address's place (the website geocodes the town once) within the radius. Its fee and minimum apply.
--    A caller that sends no zone at all (the website and the bookings function before this update) keeps the old rule
--    (the first zone that fits), so the live site works while the new code goes out.
-- 4. food_order_create(…, p_zone) quotes again with the same zone and keeps zone_id + the zone's label on the order
--    (the feed, the order page, the courier app and the owner's e-mail show it).
-- 5. Owners: food_zones.label ("Názov pre zákazníka") through owner_food_save_zone(…, p_label), the order through
--    owner_food_order_zones(); "Nastavenie obchodu" no longer asks for zones.

-- the activity log: the zones' new order
do $$
declare
  v_def text := (select pg_get_constraintdef(c.oid) from pg_constraint c
                 where c.conrelid = 'public.shop_activity'::regclass and c.conname = 'shop_activity_action_check');
begin
  if v_def is not null and position('''food_zones_ordered''' in v_def) = 0 then
    alter table public.shop_activity drop constraint shop_activity_action_check;
    execute 'alter table public.shop_activity add constraint shop_activity_action_check '
            || replace(v_def, 'ARRAY[', 'ARRAY[''food_zones_ordered''::text, ');
  end if;
end;
$$;

alter table public.food_zones add column if not exists label text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'food_zones_label_check') then
    alter table public.food_zones add constraint food_zones_label_check
      check (label is null or char_length(label) between 1 and 40);
  end if;
end $$;

/** The words of a text without accents and case ("Veľké Kapušany" → "velke kapusany"). */
create or replace function public.food_words(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(regexp_replace(public.search_text(coalesce(p, '')), '[^a-z0-9]+', ' ', 'g'))
$$;

/**
 * The town of a typed address (= townOf in @/lib/foodRules): the last comma part (the only part without a comma)
 * without a postcode before or after it ("Okružná 14, 071 01 Michalovce" → "Michalovce"); null when none.
 */
create or replace function public.food_town_of(p_address text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_parts text[] := array(select btrim(x) from regexp_split_to_table(coalesce(p_address, ''), ',') x where btrim(x) <> '');
  v_last text;
begin
  if coalesce(array_length(v_parts, 1), 0) = 0 then return null; end if;
  v_last := v_parts[array_length(v_parts, 1)];
  v_last := regexp_replace(v_last, '^\s*([0-9]{3}\s?[0-9]{2}|[0-9]{4})\s*', '');
  v_last := btrim(regexp_replace(v_last, '\s*([0-9]{3}\s?[0-9]{2}|[0-9]{4})\s*$', ''));
  if char_length(v_last) >= 2 and v_last ~ '[[:alpha:]]' then return left(v_last, 100); end if;
  return null;
end;
$$;

/** A town zone: the address's town is the zone's town, or the address ends with it (a postcode after it ignored). */
create or replace function public.food_town_fits(p_address text, p_town text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_town text := public.food_words(p_town);
  v_words text := btrim(regexp_replace(public.food_words(p_address), '(\s[0-9]+)+$', ''));
begin
  if v_town = '' or v_town !~ '[a-z]' then return false; end if;
  return public.food_words(public.food_town_of(p_address)) = v_town
      or v_words = v_town or right(v_words, char_length(v_town) + 1) = ' ' || v_town;
end;
$$;

/** A postcode zone: one of its postcodes ("071 01", "07101; 07102") appears in the address (spaces ignored). */
create or replace function public.food_postcode_fits(p_address text, p_codes text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select exists (
    select 1 from regexp_split_to_table(coalesce(p_codes, ''), '[,;]+') c
    where regexp_replace(c, '\s', '', 'g') <> ''
      and position(upper(regexp_replace(c, '\s', '', 'g')) in upper(regexp_replace(coalesce(p_address, ''), '\s', '', 'g'))) > 0)
$$;

/** The zone's name for the customer: its own label, else its town, else its postcode(s), else "do <n> km". */
create or replace function public.food_zone_label(z public.food_zones)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(nullif(btrim(coalesce(z.label, '')), ''),
                  case when z.kind = 'radius_km' then 'do ' || replace(btrim(z.value), '.', ',') || ' km' else btrim(z.value) end)
$$;

/** Does the address fit THIS zone (the one the customer picked)? */
create or replace function public.food_zone_fits(z public.food_zones, p_address text, p_lat double precision, p_lng double precision)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_loc extensions.geography;
begin
  if z.kind = 'town' then return public.food_town_fits(p_address, z.value); end if;
  if z.kind = 'postcode' then return public.food_postcode_fits(p_address, z.value); end if;
  v_loc := (select s.location from public.shops s where s.id = z.shop_id);
  return p_lat is not null and p_lng is not null and v_loc is not null
     and p_lat between -90 and 90 and p_lng between -180 and 180
     and extensions.st_distance(v_loc, extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography)
         <= replace(z.value, ',', '.')::numeric * 1000;
end;
$$;
revoke execute on function public.food_zone_fits(public.food_zones, text, double precision, double precision) from public, anon, authenticated;
grant execute on function public.food_zone_fits(public.food_zones, text, double precision, double precision) to service_role;

/** The zones as the customer's panel shows them, in the owner's order (no coordinates, no internal names). */
create or replace function public.food_zone_list(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', z.id, 'label', public.food_zone_label(z), 'own_label', nullif(btrim(coalesce(z.label, '')), '') is not null,
           'kind', z.kind,
           'value', case when z.kind in ('town', 'postcode') then btrim(z.value) end,
           'km', case when z.kind = 'radius_km' then replace(btrim(z.value), ',', '.')::numeric end,
           'fee_cents', z.fee_cents, 'min_cents', z.minimum_cents) order by z.sort, z.created_at), '[]'::jsonb)
  from public.food_zones z where z.shop_id = p_shop_id
$$;
revoke execute on function public.food_zone_list(uuid) from public, anon, authenticated;
grant execute on function public.food_zone_list(uuid) to service_role;

/** As update 85; Donáška = its switch alone (zones optional), with zones_count and the customer's zone_list. */
create or replace function public.food_state(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shop public.shops%rowtype;
  v public.food_settings;
  v_open jsonb;
  v_times jsonb;
  v_list jsonb;
begin
  select * into v_shop from public.shops where slug = p_slug and is_active;
  if not found then return jsonb_build_object('enabled', false); end if;
  select * into v from public.food_settings where shop_id = v_shop.id;
  if v.shop_id is null or not v.enabled or not public.shop_has_plan(v_shop.id) then
    return jsonb_build_object('enabled', false);
  end if;
  v_open := public.food_open_state(v_shop.id);
  v_times := public.food_times(v_shop.id);
  v_list := public.food_zone_list(v_shop.id);
  return jsonb_build_object(
    'enabled', true, 'accepting', (v_open ->> 'accepting')::boolean, 'reason', v_open ->> 'reason',
    'last_order_at', v_open -> 'last_order_at', 'timezone', v_open ->> 'timezone',
    'pickup', v.pickup_on, 'prep_minutes', v.prep_minutes,
    'delivery', v.delivery_on,
    'delivery_minutes', v.delivery_minutes,
    'delay_minutes', v.delay_minutes,
    'ready_pickup_min', (v_times ->> 'ready_pickup_min')::integer,
    'ready_delivery_min', (v_times ->> 'ready_delivery_min')::integer,
    'long_delay', (v_times ->> 'long_delay')::boolean,
    'payments', v.payments_on,
    'pay', jsonb_build_object(
      'qr', v.payments_on and v.pay_qr and exists (select 1 from public.sklad_settings st where st.shop_id = v_shop.id and st.iban is not null),
      'cash', v.payments_on and v.pay_cash, 'card', v.payments_on and v.pay_card),
    -- the customer's names only (update 85's list kept for callers from before; the internal names never leave)
    'zones', coalesce((select jsonb_agg(jsonb_build_object('name', l ->> 'label', 'fee_cents', (l ->> 'fee_cents')::integer,
                                                           'minimum_cents', (l ->> 'min_cents')::integer))
                       from jsonb_array_elements(v_list) l), '[]'::jsonb),
    'zones_count', jsonb_array_length(v_list),
    'zone_list', v_list,
    'pay_note', v.pay_note,
    'phone', v_shop.phone);
end;
$$;
revoke execute on function public.food_state(text) from public;
grant execute on function public.food_state(text) to anon, authenticated, service_role;

/**
 * THE price rule (update 73/81), with the zone the customer picked (update 87). p_zone: a zone id, or null = none picked
 * (refused while the shop has zones: zone_required); left out = a caller from before update 87 (the first zone that
 * fits). Delivery without zones: fee 0, no minimum. Problems as before + zone_required · zone_unknown · zone_mismatch.
 */
drop function if exists public.food_quote(text, jsonb, text, text, double precision, double precision);
create or replace function public.food_quote(p_slug text, p_lines jsonb, p_kind text, p_address text default null,
                                             p_lat double precision default null, p_lng double precision default null,
                                             p_zone uuid default '00000000-0000-0000-0000-000000000000')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shop public.shops%rowtype;
  v public.food_settings;
  v_open jsonb;
  v_line jsonb;
  v_item jsonb;
  v_extra jsonb;
  v_x text;
  v_qty integer;
  v_extras jsonb;
  v_extras_cents integer;
  v_lines jsonb := '[]'::jsonb;
  v_refused jsonb := '[]'::jsonb;
  v_sub integer := 0;
  v_fee integer := 0;
  v_min integer := 0;
  z public.food_zones;
  v_problem text;
  v_n integer := 0;
  v_zones integer;
begin
  select * into v_shop from public.shops where slug = p_slug and is_active;
  if not found then raise exception 'not_available' using errcode = 'P0001'; end if;
  select * into v from public.food_settings where shop_id = v_shop.id;
  if v.shop_id is null or not v.enabled or not public.shop_has_plan(v_shop.id) then
    raise exception 'not_available' using errcode = 'P0001';
  end if;
  if p_kind is null or p_kind not in ('pickup', 'delivery') then raise exception 'kind' using errcode = '22023'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 30 then
    raise exception 'lines' using errcode = '22023';
  end if;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_line) <> 'object' or coalesce(v_line ->> 'item_id', '') !~* '^[0-9a-f-]{36}$' then
      raise exception 'lines' using errcode = '22023';
    end if;
    v_qty := case when coalesce(v_line ->> 'qty', '1') ~ '^[0-9]{1,3}$' then coalesce(v_line ->> 'qty', '1')::integer else 0 end;
    if v_qty not between 1 and 50 then raise exception 'qty' using errcode = '22023'; end if;
    v_item := public.food_item(v_shop.id, (v_line ->> 'item_id')::uuid);
    if v_item is null or (v_item ->> 'sold_out')::boolean then
      v_refused := v_refused || jsonb_build_object('item_id', v_line ->> 'item_id', 'name', v_item ->> 'name',
                                                   'reason', case when v_item is null then 'not_found' else 'sold_out' end);
      continue;
    end if;
    v_extras := '[]'::jsonb;
    v_extras_cents := 0;
    if jsonb_typeof(v_line -> 'extras') = 'array' then
      if jsonb_array_length(v_line -> 'extras') > 10 then raise exception 'extras' using errcode = '22023'; end if;
      for v_x in select * from jsonb_array_elements_text(v_line -> 'extras') loop
        if v_x !~* '^[0-9a-f-]{36}$' then raise exception 'extras' using errcode = '22023'; end if;
        v_extra := public.food_item(v_shop.id, v_x::uuid);
        if v_extra is null or (v_extra ->> 'sold_out')::boolean then
          v_refused := v_refused || jsonb_build_object('item_id', v_x, 'name', v_extra ->> 'name', 'extra_of', v_line ->> 'item_id',
                                                       'reason', case when v_extra is null then 'not_found' else 'sold_out' end);
          continue;
        end if;
        v_extras := v_extras || jsonb_build_object('item_id', v_x, 'name', v_extra ->> 'name',
                                                   'unit_cents', (v_extra ->> 'price_cents')::integer);
        v_extras_cents := v_extras_cents + (v_extra ->> 'price_cents')::integer;
      end loop;
    end if;
    v_n := v_n + 1;
    v_lines := v_lines || jsonb_build_object(
      'position', v_n, 'item_id', v_item ->> 'item_id', 'name', v_item ->> 'name', 'qty', v_qty,
      'base_cents', (v_item ->> 'price_cents')::integer, 'extras', v_extras, 'extras_cents', v_extras_cents,
      'unit_cents', (v_item ->> 'price_cents')::integer + v_extras_cents,
      'line_cents', ((v_item ->> 'price_cents')::integer + v_extras_cents) * v_qty);
    v_sub := v_sub + ((v_item ->> 'price_cents')::integer + v_extras_cents) * v_qty;
  end loop;

  v_zones := (select count(*) from public.food_zones fz where fz.shop_id = v_shop.id);
  if p_kind = 'pickup' and not v.pickup_on or p_kind = 'delivery' and not v.delivery_on then
    v_problem := 'kind_off';
  elsif p_kind = 'delivery' then
    if nullif(btrim(coalesce(p_address, '')), '') is null then
      v_problem := 'no_address';
    elsif v_zones = 0 then
      -- no zones: delivery anywhere, no fee, no minimum
      null;
    elsif p_zone = '00000000-0000-0000-0000-000000000000'::uuid then
      -- a caller from before update 87 (no zone sent): the first zone that fits, as before
      z := public.food_zone_for(v_shop.id, p_address, p_lat, p_lng);
      if z.id is null then v_problem := 'outside_zone'; end if;
    elsif p_zone is null then
      v_problem := 'zone_required';
    else
      select * into z from public.food_zones fz where fz.id = p_zone and fz.shop_id = v_shop.id;
      if z.id is null then
        v_problem := 'zone_unknown';
      elsif not public.food_zone_fits(z, p_address, p_lat, p_lng) then
        -- never another zone's fee: the customer picks again or corrects the address
        v_problem := 'zone_mismatch';
      end if;
    end if;
    if z.id is not null then
      v_fee := z.fee_cents;
      v_min := z.minimum_cents;
    end if;
  end if;
  if v_problem is null and jsonb_array_length(v_refused) > 0 then v_problem := 'sold_out'; end if;
  if v_problem is null and v_n = 0 then v_problem := 'empty'; end if;
  if v_problem is null and v_sub < v_min then v_problem := 'below_minimum'; end if;
  v_open := public.food_open_state(v_shop.id);
  if v_problem is null and not (v_open ->> 'accepting')::boolean then v_problem := 'not_accepting'; end if;
  return jsonb_build_object(
    'ok', true, 'orderable', v_problem is null, 'problem', v_problem, 'state', v_open,
    'kind', p_kind, 'lines', v_lines, 'refused', v_refused,
    'zone', case when z.id is null then null else jsonb_build_object('id', z.id, 'name', public.food_zone_label(z),
                                                                      'label', public.food_zone_label(z), 'kind', z.kind,
                                                                      'fee_cents', z.fee_cents, 'minimum_cents', z.minimum_cents) end,
    'zones_count', v_zones,
    'subtotal_cents', v_sub, 'delivery_cents', v_fee, 'minimum_cents', v_min, 'total_cents', v_sub + v_fee,
    'currency', 'EUR',
    'ready_minutes', (case when p_kind = 'delivery' then v.delivery_minutes else v.prep_minutes end) + v.delay_minutes,
    'delay_minutes', v.delay_minutes);
end;
$$;
revoke execute on function public.food_quote(text, jsonb, text, text, double precision, double precision, uuid) from public;
grant execute on function public.food_quote(text, jsonb, text, text, double precision, double precision, uuid) to anon, authenticated, service_role;

/**
 * As update 85, with the zone the customer picked (update 87): quoted again with the same zone (checked, never trusted
 * alone); the order keeps zone_id and the zone's label.
 */
drop function if exists public.food_order_create(uuid, text, uuid, jsonb, text, text, text, text, double precision, double precision, uuid, text, text);
create or replace function public.food_order_create(
  p_code_id uuid, p_code text, p_order_id uuid, p_lines jsonb, p_kind text, p_pay_method text,
  p_address text default null, p_note text default null, p_lat double precision default null, p_lng double precision default null,
  p_conversation_id uuid default null, p_conversation_token text default null, p_lang text default null,
  p_zone uuid default '00000000-0000-0000-0000-000000000000'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.sms_codes%rowtype;
  v_shop public.shops%rowtype;
  v public.food_settings;
  v_check jsonb;
  v_quote jsonb;
  v_day date;
  v_seq integer;
  v_line jsonb;
  v_extras_text text;
  v_address text := nullif(left(btrim(coalesce(p_address, '')), 300), '');
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 300), '');
begin
  if p_order_id is null then raise exception 'bad_request' using errcode = '22023'; end if;
  -- a retry of an order already placed (a double tap, a lost answer)
  if exists (select 1 from public.food_orders o where o.id = p_order_id) then
    if not exists (select 1 from public.food_orders o join public.sms_codes s on s.shop_id = o.shop_id
                   where o.id = p_order_id and s.id = p_code_id) then
      raise exception 'conflict' using errcode = '23505';
    end if;
    return jsonb_build_object('ok', true, 'duplicate', true, 'order', public.food_order_public_json(p_order_id));
  end if;
  select * into c from public.sms_codes where id = p_code_id for update;
  if not found or c.purpose <> 'order' then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select * into v_shop from public.shops where id = c.shop_id;
  v := public.food_setup(v_shop.id);
  -- update 85: the customer never chooses how to pay; the owner or the courier marks it at the handover
  -- the price rule before the code is spent (a refusal leaves the code to try again with another cart)
  -- update 87: the zone the customer picked is checked again by the price rule (never trusted alone)
  v_quote := public.food_quote(v_shop.slug, p_lines, p_kind, v_address, p_lat, p_lng, p_zone);
  if not (v_quote ->> 'orderable')::boolean then
    raise exception '%', coalesce(v_quote ->> 'problem', 'not_orderable') using errcode = 'P0001';
  end if;
  v_check := public.sms_code_verify(p_code_id, p_code, p_conversation_id, p_conversation_token);
  if not (v_check ->> 'ok')::boolean then return v_check; end if;

  -- the number of the shop's day
  v_day := (now() at time zone coalesce(v_shop.timezone, 'UTC'))::date;
  update public.food_settings
  set order_seq = case when order_day = v_day then order_seq + 1 else 1 end, order_day = v_day
  where shop_id = v_shop.id
  returning order_seq into v_seq;

  insert into public.food_orders (id, shop_id, number, order_day, kind, pay_method, contact_id, conversation_id, name, phone,
                                  address, note, lat, lng, zone_id, zone_name, ready_by, subtotal_cents, delivery_cents,
                                  total_cents, vs, lang)
  values (p_order_id, v_shop.id, v_seq, v_day, p_kind, null, (v_check ->> 'contact_id')::uuid, c.conversation_id,
          c.name, c.phone, case when p_kind = 'delivery' then v_address end, v_note,
          case when p_kind = 'delivery' then p_lat end, case when p_kind = 'delivery' then p_lng end,
          (v_quote -> 'zone' ->> 'id')::uuid, left(v_quote -> 'zone' ->> 'label', 80),
          now() + make_interval(mins => (v_quote ->> 'ready_minutes')::integer),
          (v_quote ->> 'subtotal_cents')::integer, (v_quote ->> 'delivery_cents')::integer, (v_quote ->> 'total_cents')::integer,
          public.sklad_next_vs(v_shop.id), left(p_lang, 12));

  for v_line in select * from jsonb_array_elements(v_quote -> 'lines') loop
    select string_agg('+ ' || (x ->> 'name'), ', ') into v_extras_text from jsonb_array_elements(v_line -> 'extras') x;
    insert into public.food_order_lines (order_id, position, shop_item_id, name, base_cents, qty, extras, extras_text,
                                         extras_cents, line_cents)
    values (p_order_id, (v_line ->> 'position')::integer, (v_line ->> 'item_id')::uuid, left(v_line ->> 'name', 300),
            (v_line ->> 'base_cents')::integer, (v_line ->> 'qty')::integer, v_line -> 'extras', left(v_extras_text, 500),
            (v_line ->> 'extras_cents')::integer, (v_line ->> 'line_cents')::integer);
  end loop;

  insert into public.food_order_events (order_id, shop_id, actor, kind, from_status, to_status)
  values (p_order_id, v_shop.id, 'customer', 'status', null, 'new');
  if v.alert_email then
    insert into public.food_order_alerts (order_id, shop_id, channel) values (p_order_id, v_shop.id, 'email');
  end if;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (v_shop.id, null, 'food_order_placed',
          jsonb_build_object('order', p_order_id, 'number', v_seq, 'kind', p_kind, 'total_cents', (v_quote ->> 'total_cents')::integer));
  return jsonb_build_object('ok', true, 'duplicate', false, 'order', public.food_order_public_json(p_order_id));
end;
$$;
revoke execute on function public.food_order_create(uuid, text, uuid, jsonb, text, text, text, text, double precision, double precision, uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.food_order_create(uuid, text, uuid, jsonb, text, text, text, text, double precision, double precision, uuid, text, text, uuid)
  to service_role;

/**
 * "+ Pridať zónu" / editing one (update 73) + "Názov pre zákazníka" (update 87): p_label null = unchanged (a caller
 * from before), '' = none, else plain text ≤ 40 (label).
 */
drop function if exists public.owner_food_save_zone(uuid, uuid, text, text, text, integer, integer, integer);
create or replace function public.owner_food_save_zone(p_shop_id uuid, p_id uuid, p_name text, p_kind text, p_value text,
                                                       p_fee_cents integer, p_minimum_cents integer, p_sort integer default null,
                                                       p_label text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_label text := case when p_label is null then null else public.plain_text(p_label, 100) end;
begin
  perform public.food_owner_write(p_shop_id);
  if nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'name' using errcode = '22023'; end if;
  if p_kind is null or p_kind not in ('town', 'postcode', 'radius_km') then raise exception 'kind' using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_value, '')), '') is null then raise exception 'value' using errcode = '22023'; end if;
  if p_kind = 'radius_km' and not (btrim(p_value) ~ '^[0-9]+([.,][0-9]+)?$' and replace(btrim(p_value), ',', '.')::numeric between 0.1 and 200) then
    raise exception 'value' using errcode = '22023';
  end if;
  if p_fee_cents is null or p_fee_cents not between 0 and 100000 or p_minimum_cents is null or p_minimum_cents not between 0 and 1000000 then
    raise exception 'amount' using errcode = '22023';
  end if;
  if char_length(coalesce(v_label, '')) > 40 then raise exception 'label' using errcode = '22023'; end if;
  if p_id is null then
    if (select count(*) from public.food_zones where shop_id = p_shop_id) >= 30 then raise exception 'too_many' using errcode = '54000'; end if;
    insert into public.food_zones (shop_id, name, kind, value, fee_cents, minimum_cents, sort, label)
    values (p_shop_id, left(btrim(p_name), 80), p_kind, left(btrim(p_value), 80), p_fee_cents, p_minimum_cents,
            coalesce(p_sort, (select coalesce(max(sort), 0) + 1 from public.food_zones where shop_id = p_shop_id)), v_label)
    returning id into v_id;
  else
    update public.food_zones
    set name = left(btrim(p_name), 80), kind = p_kind, value = left(btrim(p_value), 80), fee_cents = p_fee_cents,
        minimum_cents = p_minimum_cents, sort = coalesce(p_sort, sort),
        label = case when p_label is null then label else v_label end
    where id = p_id and shop_id = p_shop_id
    returning id into v_id;
    if v_id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  end if;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'food_zone_saved', jsonb_build_object('zone', v_id, 'kind', p_kind));
  return v_id;
end;
$$;
revoke execute on function public.owner_food_save_zone(uuid, uuid, text, text, text, integer, integer, integer, text) from public, anon;
grant execute on function public.owner_food_save_zone(uuid, uuid, text, text, text, integer, integer, integer, text) to authenticated;

/** ▲ ▼: the zones in the given order (ids of this shop only; the rest keep their place after them). */
create or replace function public.owner_food_order_zones(p_shop_id uuid, p_ids uuid[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.food_owner_write(p_shop_id);
  if p_ids is null or cardinality(p_ids) > 30 then raise exception 'zones' using errcode = '22023'; end if;
  update public.food_zones z set sort = x.n
  from unnest(p_ids) with ordinality as x(id, n)
  where z.id = x.id and z.shop_id = p_shop_id;
  update public.food_zones z set sort = cardinality(p_ids) + 1 + r.n
  from (select id, row_number() over (order by sort, created_at) n from public.food_zones
        where shop_id = p_shop_id and not (id = any (p_ids))) r
  where z.id = r.id;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'food_zones_ordered', jsonb_build_object('zones', cardinality(p_ids)));
  return public.food_zone_list(p_shop_id);
end;
$$;
revoke execute on function public.owner_food_order_zones(uuid, uuid[]) from public, anon;
grant execute on function public.owner_food_order_zones(uuid, uuid[]) to authenticated;

/** As update 80, without "zones" in the food shop's "orders" step (Donáška needs only its switch, update 87). */
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

  v_miss := array_remove(array[
    case when nullif(btrim(coalesce(sh.address, '')), '') is null then 'address' end,
    case when nullif(btrim(coalesce(sh.city, '')), '') is null then 'city' end,
    case when sh.country is null then 'country' end,
    case when nullif(btrim(coalesce(sh.phone, '')), '') is null and sh.email is null then 'contact' end], null);
  v_list := v_list || jsonb_build_object('key', 'details', 'missing', to_jsonb(v_miss));

  v_list := v_list || jsonb_build_object('key', 'hours', 'missing', to_jsonb(case when exists (
    select 1 from jsonb_each(coalesce(sh.opening_hours, '{}'::jsonb)) e
    where jsonb_typeof(e.value) = 'array' and jsonb_array_length(e.value) > 0) then '{}'::text[] else array['hours'] end));

  if sh.kind = 'food' then
    -- Menu (update 80): a menu dish with a price
    v_list := v_list || jsonb_build_object('key', 'menu', 'missing', to_jsonb(case when public.menu_has_dishes(p_shop_id)
      then '{}'::text[] else array['menu'] end));

    v_miss := array_remove(array[
      case when not v_plan then 'plan' end,
      case when not coalesce(fs.pickup_on, true) and not coalesce(fs.delivery_on, false) then 'no_kind' end,
      case when coalesce(fs.pay_qr, true)
             and not exists (select 1 from public.sklad_settings st where st.shop_id = p_shop_id and st.iban is not null)
           then 'iban' end], null);
    v_list := v_list || jsonb_build_object('key', 'orders', 'missing', to_jsonb(v_miss));

    v_list := v_list || jsonb_build_object('key', 'couriers', 'missing', to_jsonb(case when exists (
      select 1 from public.food_couriers c where c.shop_id = p_shop_id and c.active)
      then '{}'::text[] else array['couriers'] end));

    v_miss := array_remove(array[
      case when not v_plan then 'plan' end,
      case when sh.assistant_welcome is null then 'welcome' end,
      case when not exists (select 1 from public.shop_documents d join public.shop_folders f on f.id = d.folder_id and f.is_public
                            where d.shop_id = p_shop_id and d.status = 'ready' and d.assistant_enabled) then 'menu_pdf' end], null);
    v_list := v_list || jsonb_build_object('key', 'assistant', 'missing', to_jsonb(v_miss));

    v_list := v_list || jsonb_build_object('key', 'launch', 'missing', to_jsonb(case when coalesce(fs.enabled, false)
      then '{}'::text[] else array['enabled'] end));
  else
    v_source := public.stock_source_of(p_shop_id);
    v_list := v_list || jsonb_build_object('key', 'stock', 'missing', to_jsonb(case
      when v_source <> 'file' then '{}'::text[]
      when ss.latest_file_time is null and ss.mapping_status is distinct from 'proposed' then array['stock']
      when ss.mapping_status is distinct from 'confirmed' then array['columns']
      else '{}'::text[] end));

    v_list := v_list || jsonb_build_object('key', 'languages', 'missing', to_jsonb(case when exists (
      select 1 from public.shop_language_settings ls where ls.shop_id = p_shop_id) then '{}'::text[] else array['languages'] end));

    v_list := v_list || jsonb_build_object('key', 'page', 'missing', to_jsonb(case when sh.logo_url is not null
      then '{}'::text[] else array['logo'] end));

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

/** As update 74, and the zone's label of a delivery (the owner's e-mail names it). */
drop function if exists public.food_alerts_due(integer);
create or replace function public.food_alerts_due(p_limit integer default 20)
returns table (id uuid, shop_id uuid, shop_name text, order_id uuid, number integer, kind text, pay_method text,
               total_cents integer, created_at timestamptz, ready_by timestamptz, timezone text, items text,
               recipients jsonb, zone text)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, s.id, s.name, o.id, o.number, o.kind, o.pay_method, o.total_cents, o.created_at, o.ready_by,
         coalesce(s.timezone, 'UTC'), public.food_order_items_text(o.id, 600),
         case when cs.alert_email is not null
              then jsonb_build_array(jsonb_build_object('email', cs.alert_email,
                     'lang', coalesce((select p.language from public.shop_members sm join public.profiles p on p.user_id = sm.user_id
                                       where sm.shop_id = s.id order by sm.created_at limit 1), 'sk')))
              else coalesce((select jsonb_agg(jsonb_build_object('email', u.email, 'lang', coalesce(p.language, 'sk')))
                             from public.shop_members sm
                             join auth.users u on u.id = sm.user_id
                             left join public.profiles p on p.user_id = sm.user_id
                             where sm.shop_id = s.id and u.email is not null), '[]'::jsonb) end,
         case when o.kind = 'delivery' then o.zone_name end
  from public.food_order_alerts a
  join public.food_orders o on o.id = a.order_id
  join public.shops s on s.id = a.shop_id
  left join public.crm_settings cs on cs.shop_id = a.shop_id
  where a.sent_at is null and a.next_try_at <= now() and a.attempts < 10 and a.channel = 'email'
    and a.created_at > now() - interval '24 hours'
  order by a.created_at
  limit least(greatest(coalesce(p_limit, 20), 1), 100)
$$;
revoke execute on function public.food_alerts_due(integer) from public, anon, authenticated;
grant execute on function public.food_alerts_due(integer) to service_role;
