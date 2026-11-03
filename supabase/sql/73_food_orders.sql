-- =====================================================================================================================
-- Update 73 — "Objednávky jedla" phase F1: the data and the rules (Prompt 15, 2026-11-03)
--
-- Food orders in the shop assistant, paid only on receipt (PAY by square QR, cash, or card on the shop's own terminal —
-- Cacaduu records how it was paid and processes nothing). Every rule lives here; the website, the shop assistant, the
-- owner's screens and (phase F4) the courier app only call these functions:
--   * food_settings / food_zones: the owner's switches (default off), pickup and delivery, zones (town, postcode or
--     kilometres) with a fee and a minimum, the payment methods, the last order before closing, "Odpísať zo skladu po
--     doručení", the alerts; the Objednávky tab and the assistant's tools exist only while enabled + shop_has_plan.
--   * ONE price rule: food_quote() — Sklad's sale price (with VAT, EUR) of every line and extra, sold out (Sklad stock
--     ≤ 0) refused, the zone, its fee and minimum, the total in cents. The AI and the browser never set a price.
--   * ONE time rule: food_open_state() — the opening hours (booking_day_ranges: special day > holiday > regular hours),
--     the last-order cutoff, paused, the order SMS quota.
--   * The order SMS code is a sms_codes row of purpose 'order' (update 63's limits: 6 digits, hash only, 10 minutes, 5
--     tries, 3/number/hour, 10/caller/hour) and takes the new monthly quota 'order' (sms_quota_limits, default 100).
--     food_order_create(code, the order's own UUID, …) checks the code and places the order in ONE transaction: the
--     contact found by the number or made (phone_verified_at), the conversation linked, the order + lines (names and
--     prices as sold) + its first event + the owner's alert; the same UUID again = the same order.
--   * Status steps only through food_order_step() (owner_food_order_status(), the courier's in F4): allowed steps only,
--     every step (and every payment mark) in the append-only food_order_events, each step's own UUID once.
--     Delivered / picked up need a payment mark first; with "Odpísať zo skladu" and an active Sklad they take the lines
--     off the stock: one 'sale' movement per line and extra, id md5(order ':' line …) — once, never twice.
-- Tables: RLS, no grants (service role only); owners only through owner_food_* (members; writes also shop_has_plan).
-- Needs updates 56–58, 63, 67–68. Safe to run twice.
-- =====================================================================================================================

-- ------------------------------------------------------------------ 0. the activity log, SMS kinds, the 'order' quota

do $$
declare
  v_def text := (select pg_get_constraintdef(c.oid) from pg_constraint c
                 where c.conrelid = 'public.shop_activity'::regclass and c.conname = 'shop_activity_action_check');
  v_add text := '';
  a text;
begin
  if v_def is null then return; end if;
  foreach a in array array['food_settings_saved', 'food_zone_saved', 'food_zone_deleted', 'food_order_placed',
                           'food_order_status', 'food_order_paid', 'food_paused', 'food_resumed'] loop
    if position('''' || a || '''' in v_def) = 0 then v_add := v_add || '''' || a || '''::text, '; end if;
  end loop;
  if v_add <> '' then
    alter table public.shop_activity drop constraint shop_activity_action_check;
    execute 'alter table public.shop_activity add constraint shop_activity_action_check ' || replace(v_def, 'ARRAY[', 'ARRAY[' || v_add);
  end if;
end;
$$;

alter table public.sms_codes drop constraint if exists sms_codes_purpose_check;
alter table public.sms_codes add constraint sms_codes_purpose_check check (purpose in ('contact', 'booking', 'delete_all', 'order'));

do $$
declare
  v_def text := (select pg_get_constraintdef(c.oid) from pg_constraint c
                 where c.conrelid = 'public.shop_outgoing_messages'::regclass and c.conname = 'shop_outgoing_messages_kind_check');
begin
  if v_def is not null and position('''order_code''' in v_def) = 0 then
    alter table public.shop_outgoing_messages drop constraint shop_outgoing_messages_kind_check;
    execute 'alter table public.shop_outgoing_messages add constraint shop_outgoing_messages_kind_check '
            || replace(v_def, 'ARRAY[', 'ARRAY[''order_code''::text, ');
  end if;
end;
$$;

alter table public.sms_quota_limits drop constraint if exists sms_quota_limits_quota_check;
alter table public.sms_quota_limits add constraint sms_quota_limits_quota_check check (quota in ('booking', 'owner', 'order'));
insert into public.sms_quota_limits (quota, monthly) values ('order', 100) on conflict (quota) do nothing;

/** Which quota an SMS kind belongs to (update 58's rule + the order codes of update 73). */
create or replace function public.sms_quota_of(p_kind text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_kind in ('booking_code', 'booking_reminder') then 'booking'
              when p_kind = 'order_code' then 'order'
              else 'owner' end
$$;
revoke execute on function public.sms_quota_of(text) from public, anon, authenticated;
grant execute on function public.sms_quota_of(text) to service_role;

/** The shop's quotas this month (for the owner's pages): booking, owner and, since update 73, order. */
create or replace function public.sms_quota_state(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'booking', jsonb_build_object('used', public.sms_quota_used(p_shop_id, 'booking'), 'limit', public.sms_quota_limit('booking')),
    'owner', jsonb_build_object('used', public.sms_quota_used(p_shop_id, 'owner'), 'limit', public.sms_quota_limit('owner')),
    'order', jsonb_build_object('used', public.sms_quota_used(p_shop_id, 'order'), 'limit', public.sms_quota_limit('order')),
    'month_start', mo.starts_at, 'resets_at', mo.resets_at)
  from public.sms_month(p_shop_id) mo
$$;
revoke execute on function public.sms_quota_state(uuid) from public, anon, authenticated;
grant execute on function public.sms_quota_state(uuid) to service_role;

/** The admin's limit of one quota ("SMS" in the admin page; the order quota is new in update 73). */
create or replace function public.admin_save_sms_quota(p_quota text, p_monthly integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'Admins only' using errcode = '42501'; end if;
  if p_quota is null or p_quota not in ('booking', 'owner', 'order') or p_monthly is null or p_monthly not between 0 and 100000 then
    raise exception 'limits' using errcode = '22023';
  end if;
  insert into public.sms_quota_limits (quota, monthly) values (p_quota, p_monthly)
  on conflict (quota) do update set monthly = excluded.monthly, updated_at = now();
end;
$$;
revoke execute on function public.admin_save_sms_quota(text, integer) from public, anon;
grant execute on function public.admin_save_sms_quota(text, integer) to authenticated;

-- ------------------------------------------------------------------ 1. tables

create table if not exists public.food_settings (
  shop_id             uuid primary key references public.shops (id) on delete cascade,
  enabled             boolean not null default false,
  paused              boolean not null default false,
  paused_at           timestamptz,
  pickup_on           boolean not null default true,
  prep_minutes        integer not null default 20 check (prep_minutes between 5 and 240),
  delivery_on         boolean not null default false,
  delivery_minutes    integer not null default 45 check (delivery_minutes between 10 and 300),
  pay_qr              boolean not null default true,
  pay_cash            boolean not null default true,
  pay_card            boolean not null default false,
  last_order_minutes  integer not null default 30 check (last_order_minutes between 0 and 240),
  deduct_on_delivery  boolean not null default true,
  alert_sound         boolean not null default true,
  alert_email         boolean not null default true,
  alert_telegram      boolean not null default true,
  sms_on_the_way      boolean not null default false,
  assign_mode         text not null default 'manual' check (assign_mode in ('manual', 'auto')),
  -- the order numbers of the shop's day (1, 2, 3 … from midnight in the shop's time zone)
  order_day           date,
  order_seq           integer not null default 0,
  updated_at          timestamptz not null default now(),
  check (pay_qr or pay_cash or pay_card)
);

create table if not exists public.food_zones (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references public.shops (id) on delete cascade,
  name           text not null check (char_length(btrim(name)) between 1 and 80),
  kind           text not null check (kind in ('town', 'postcode', 'radius_km')),
  value          text not null check (char_length(btrim(value)) between 1 and 80),
  fee_cents      integer not null default 0 check (fee_cents between 0 and 100000),
  minimum_cents  integer not null default 0 check (minimum_cents between 0 and 1000000),
  sort           integer not null default 0,
  created_at     timestamptz not null default now(),
  check (kind <> 'radius_km' or (value ~ '^[0-9]+([.,][0-9]+)?$'
                                 and replace(value, ',', '.')::numeric > 0 and replace(value, ',', '.')::numeric <= 200))
);
create index if not exists food_zones_shop_idx on public.food_zones (shop_id, sort, created_at);

create table if not exists public.food_orders (
  id               uuid primary key,
  shop_id          uuid not null references public.shops (id) on delete cascade,
  number           integer not null check (number > 0),
  order_day        date not null,
  kind             text not null check (kind in ('pickup', 'delivery')),
  status           text not null default 'new'
                   check (status in ('new', 'preparing', 'on_the_way', 'ready', 'delivered', 'picked_up', 'cancelled')),
  pay_method       text not null check (pay_method in ('qr', 'cash', 'card')),
  paid_at          timestamptz,
  paid_by          uuid references auth.users (id) on delete set null,
  paid_by_courier  uuid,
  -- "Zákazník dal": kept only to show the change to give
  cash_given_cents integer check (cash_given_cents is null or cash_given_cents between 0 and 10000000),
  contact_id       uuid references public.shop_contacts (id) on delete set null,
  conversation_id  uuid references public.assistant_conversations (id) on delete set null,
  -- the customer's details from the page's own form (never the AI); "Vymazať moje údaje" clears them
  name             text check (name is null or char_length(name) <= 80),
  phone            text check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$'),
  address          text check (address is null or char_length(address) <= 300),
  note             text check (note is null or char_length(note) <= 300),
  lat              double precision,
  lng              double precision,
  zone_id          uuid references public.food_zones (id) on delete set null,
  zone_name        text check (zone_name is null or char_length(zone_name) <= 80),
  ready_by         timestamptz not null,
  courier_id       uuid,
  subtotal_cents   integer not null check (subtotal_cents between 0 and 100000000),
  delivery_cents   integer not null default 0 check (delivery_cents between 0 and 100000),
  total_cents      integer not null check (total_cents between 0 and 100000000),
  currency         text not null default 'EUR' check (currency = 'EUR'),
  vs               text not null check (vs ~ '^[0-9]{10}$'),
  lang             text check (lang is null or char_length(lang) <= 12),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  delivered_at     timestamptz,
  cancelled_at     timestamptz,
  cancel_reason    text check (cancel_reason is null or char_length(cancel_reason) <= 200),
  stock_taken_at   timestamptz,
  unique (shop_id, order_day, number),
  check (kind = 'delivery' or (address is null and delivery_cents = 0)),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  check (status not in ('delivered', 'picked_up') or paid_at is not null)
);
create index if not exists food_orders_shop_idx on public.food_orders (shop_id, created_at desc);
create index if not exists food_orders_open_idx on public.food_orders (shop_id, status)
  where status in ('new', 'preparing', 'on_the_way', 'ready');
create index if not exists food_orders_phone_idx on public.food_orders (shop_id, phone) where phone is not null;

create table if not exists public.food_order_lines (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.food_orders (id) on delete cascade,
  position      integer not null,
  shop_item_id  uuid not null,
  -- as sold: the name and the price the customer saw (Sklad's sale price at that moment, cents with VAT)
  name          text not null check (char_length(name) between 1 and 300),
  base_cents    integer not null check (base_cents between 0 and 10000000),
  qty           integer not null check (qty between 1 and 50),
  -- [{item_id, name, unit_cents}] — each extra is a Sklad product too, priced the same way
  extras        jsonb not null default '[]'::jsonb check (jsonb_typeof(extras) = 'array'),
  extras_text   text check (extras_text is null or char_length(extras_text) <= 500),
  extras_cents  integer not null default 0 check (extras_cents between 0 and 10000000),
  line_cents    integer not null check (line_cents between 0 and 100000000),
  unique (order_id, position)
);
create index if not exists food_order_lines_order_idx on public.food_order_lines (order_id, position);

create table if not exists public.food_order_events (
  id          bigserial primary key,
  order_id    uuid not null references public.food_orders (id) on delete cascade,
  shop_id     uuid not null references public.shops (id) on delete cascade,
  -- the step's own UUID (a retry from a weak signal is the same step)
  step_id     uuid unique,
  actor       text not null check (actor in ('customer', 'owner', 'courier', 'system')),
  actor_id    uuid,
  kind        text not null default 'status' check (kind in ('status', 'paid', 'assigned', 'problem')),
  from_status text,
  to_status   text,
  detail      text check (detail is null or char_length(detail) <= 200),
  created_at  timestamptz not null default now()
);
create index if not exists food_order_events_order_idx on public.food_order_events (order_id, id);

-- the owner's alerts of a new order (sent by phase F3's job; never the customer's number or address)
create table if not exists public.food_order_alerts (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.food_orders (id) on delete cascade,
  shop_id      uuid not null references public.shops (id) on delete cascade,
  channel      text not null check (channel in ('email')),
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  attempts     integer not null default 0,
  last_error   text check (last_error is null or char_length(last_error) <= 200),
  next_try_at  timestamptz not null default now(),
  unique (order_id, channel)
);
create index if not exists food_order_alerts_due_idx on public.food_order_alerts (next_try_at) where sent_at is null;

do $$
declare t text;
begin
  foreach t in array array['food_settings', 'food_zones', 'food_orders', 'food_order_lines', 'food_order_events',
                           'food_order_alerts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;
grant usage, select on sequence public.food_order_events_id_seq to service_role;

-- the audit log is append-only (a whole order or shop may still go, by cascade)
create or replace function public.food_order_events_frozen()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then raise exception 'food_order_events are append-only' using errcode = '42501'; end if;
  if tg_op = 'DELETE' and exists (select 1 from public.food_orders o where o.id = old.order_id) then
    raise exception 'food_order_events are append-only' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
drop trigger if exists food_order_events_frozen on public.food_order_events;
create trigger food_order_events_frozen before update or delete on public.food_order_events
  for each row execute function public.food_order_events_frozen();

-- ------------------------------------------------------------------ 2. the rules

/** The shop's settings row (made once, all off). */
create or replace function public.food_setup(p_shop_id uuid)
returns public.food_settings
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.food_settings;
begin
  insert into public.food_settings (shop_id) values (p_shop_id) on conflict (shop_id) do nothing;
  select * into v from public.food_settings where shop_id = p_shop_id;
  return v;
end;
$$;
revoke execute on function public.food_setup(uuid) from public, anon, authenticated;
grant execute on function public.food_setup(uuid) to service_role;

/**
 * Whether the shop takes food orders right now and why not. reason: off (not switched on or no plan) · paused ·
 * sms_quota (the month's order SMS used up) · closed (outside the opening hours) · cutoff (the last order before
 * closing has passed). closes_at / last_order_at = today's open range in which "now" falls.
 */
create or replace function public.food_open_state(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.food_settings;
  v_shop public.shops%rowtype;
  v_today date;
  v_end timestamptz;
  v_last timestamptz;
  v_reason text;
begin
  select * into v_shop from public.shops where id = p_shop_id;
  select * into v from public.food_settings where shop_id = p_shop_id;
  if v_shop.id is null or not v_shop.is_active or v.shop_id is null or not v.enabled or not public.shop_has_plan(p_shop_id) then
    return jsonb_build_object('accepting', false, 'reason', 'off');
  end if;
  v_today := (now() at time zone coalesce(v_shop.timezone, 'UTC'))::date;
  select r.range_end into v_end
  from public.booking_day_ranges(p_shop_id, v_today) r
  where now() >= r.range_start and now() < r.range_end
  order by r.range_end desc
  limit 1;
  if v_end is not null then v_last := v_end - make_interval(mins => v.last_order_minutes); end if;
  v_reason := case
    when v.paused then 'paused'
    when public.sms_quota_left(p_shop_id, 'order') < 1 then 'sms_quota'
    when v_end is null then 'closed'
    when now() >= v_last then 'cutoff'
  end;
  return jsonb_build_object('accepting', v_reason is null, 'reason', v_reason, 'closes_at', v_end, 'last_order_at', v_last,
                            'timezone', coalesce(v_shop.timezone, 'UTC'));
end;
$$;
revoke execute on function public.food_open_state(uuid) from public, anon, authenticated;
grant execute on function public.food_open_state(uuid) to service_role;

/** What the shop page and the assistant may show: on or off, why, pickup/delivery, the payment methods, the times. */
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
begin
  select * into v_shop from public.shops where slug = p_slug and is_active;
  if not found then return jsonb_build_object('enabled', false); end if;
  select * into v from public.food_settings where shop_id = v_shop.id;
  if v.shop_id is null or not v.enabled or not public.shop_has_plan(v_shop.id) then
    return jsonb_build_object('enabled', false);
  end if;
  v_open := public.food_open_state(v_shop.id);
  return jsonb_build_object(
    'enabled', true, 'accepting', (v_open ->> 'accepting')::boolean, 'reason', v_open ->> 'reason',
    'last_order_at', v_open -> 'last_order_at', 'timezone', v_open ->> 'timezone',
    'pickup', v.pickup_on, 'prep_minutes', v.prep_minutes,
    'delivery', v.delivery_on and exists (select 1 from public.food_zones z where z.shop_id = v_shop.id),
    'delivery_minutes', v.delivery_minutes,
    'pay', jsonb_build_object('qr', v.pay_qr and exists (select 1 from public.sklad_settings st where st.shop_id = v_shop.id and st.iban is not null),
                              'cash', v.pay_cash, 'card', v.pay_card),
    'zones', coalesce((select jsonb_agg(jsonb_build_object('name', z.name, 'fee_cents', z.fee_cents, 'minimum_cents', z.minimum_cents)
                                        order by z.sort, z.created_at)
                       from public.food_zones z where z.shop_id = v_shop.id), '[]'::jsonb),
    'phone', v_shop.phone);
end;
$$;
revoke execute on function public.food_state(text) from public;
grant execute on function public.food_state(text) to anon, authenticated, service_role;

/** One Sklad product as the menu has it: its name, Sklad's sale price in cents (with VAT) and whether it is sold out. */
create or replace function public.food_item(p_shop_id uuid, p_item_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('item_id', si.id, 'name', si.name, 'category', si.category,
                            'price_cents', round(i.sale_price * 100)::integer,
                            'sold_out', coalesce(t.qty, 0) <= 0)
  from public.sklad_items i
  join public.shop_items si on si.id = i.shop_item_id
  left join public.sklad_stock_total t on t.shop_item_id = i.shop_item_id
  where i.shop_id = p_shop_id and i.shop_item_id = p_item_id and i.sale_price is not null
$$;
revoke execute on function public.food_item(uuid, uuid) from public, anon, authenticated;
grant execute on function public.food_item(uuid, uuid) to service_role;

/**
 * The menu for the assistant's food_menu tool: Sklad products with a sale price (sizes are separate products), sold
 * out marked, optionally narrowed by words (the shop's own search rule). Only while the shop has food ordering on.
 */
create or replace function public.food_menu(p_slug text, p_q text default null, p_limit integer default 60)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shop public.shops%rowtype;
  v_q text := nullif(btrim(coalesce(p_q, '')), '');
begin
  select * into v_shop from public.shops where slug = p_slug and is_active;
  if not found or not ((public.food_state(p_slug) ->> 'enabled')::boolean) then
    return jsonb_build_object('enabled', false, 'items', '[]'::jsonb);
  end if;
  return jsonb_build_object('enabled', true, 'items', coalesce((
    select jsonb_agg(x.j order by x.cat nulls last, x.name)
    from (
      select public.food_item(v_shop.id, i.shop_item_id) j, si.category cat, si.name
      from public.sklad_items i
      join public.shop_items si on si.id = i.shop_item_id
      where i.shop_id = v_shop.id and i.sale_price is not null
        and (v_q is null or public.search_text(si.name || ' ' || coalesce(si.category, '')) like
             all (array(select '%' || w || '%' from regexp_split_to_table(public.search_text(v_q), '\s+') w where w <> '')))
      order by si.category nulls last, si.name
      limit least(greatest(coalesce(p_limit, 60), 1), 200)
    ) x), '[]'::jsonb));
end;
$$;
revoke execute on function public.food_menu(text, text, integer) from public;
grant execute on function public.food_menu(text, text, integer) to anon, authenticated, service_role;

/** The delivery zone of an address: the first of the owner's order that matches (town, postcode or kilometres). */
create or replace function public.food_zone_for(p_shop_id uuid, p_address text, p_lat double precision, p_lng double precision)
returns public.food_zones
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  z public.food_zones;
  v_words text := ' ' || regexp_replace(public.search_text(coalesce(p_address, '')), '[^a-z0-9]+', ' ', 'g') || ' ';
  v_digits text := regexp_replace(coalesce(p_address, ''), '\s', '', 'g');
  v_loc extensions.geography := (select s.location from public.shops s where s.id = p_shop_id);
begin
  for z in select * from public.food_zones where shop_id = p_shop_id order by sort, created_at loop
    if z.kind = 'town' then
      if v_words like '% ' || btrim(regexp_replace(public.search_text(z.value), '[^a-z0-9]+', ' ', 'g')) || ' %' then return z; end if;
    elsif z.kind = 'postcode' then
      if position(regexp_replace(z.value, '\s', '', 'g') in v_digits) > 0 then return z; end if;
    elsif z.kind = 'radius_km' then
      if p_lat is not null and p_lng is not null and v_loc is not null
         and p_lat between -90 and 90 and p_lng between -180 and 180
         and extensions.st_distance(v_loc, extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography)
             <= replace(z.value, ',', '.')::numeric * 1000 then
        return z;
      end if;
    end if;
  end loop;
  return null;
end;
$$;
revoke execute on function public.food_zone_for(uuid, text, double precision, double precision) from public, anon, authenticated;
grant execute on function public.food_zone_for(uuid, text, double precision, double precision) to service_role;

/**
 * THE price rule. Lines [{item_id, qty, extras: [item_id …]}] (≤ 30 lines, qty 1–50, ≤ 10 extras) → every line with
 * Sklad's sale price (cents, with VAT) and its extras the same way; a sold-out or unknown product (or extra) refused;
 * pickup or delivery (on in the settings); for delivery the address's zone, its fee and its minimum; the total.
 * {ok, orderable, lines, refused, kind, zone, subtotal_cents, delivery_cents, total_cents, minimum_cents, problem}
 * problem: empty · kind_off · no_address · outside_zone · below_minimum · sold_out · not_accepting (and the state).
 */
create or replace function public.food_quote(p_slug text, p_lines jsonb, p_kind text, p_address text default null,
                                             p_lat double precision default null, p_lng double precision default null)
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

  if p_kind = 'pickup' and not v.pickup_on or p_kind = 'delivery' and not v.delivery_on then
    v_problem := 'kind_off';
  elsif p_kind = 'delivery' then
    if nullif(btrim(coalesce(p_address, '')), '') is null then
      v_problem := 'no_address';
    else
      z := public.food_zone_for(v_shop.id, p_address, p_lat, p_lng);
      if z.id is null then
        v_problem := 'outside_zone';
      else
        v_fee := z.fee_cents;
        v_min := z.minimum_cents;
      end if;
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
    'zone', case when z.id is null then null else jsonb_build_object('id', z.id, 'name', z.name, 'fee_cents', z.fee_cents,
                                                                      'minimum_cents', z.minimum_cents) end,
    'subtotal_cents', v_sub, 'delivery_cents', v_fee, 'minimum_cents', v_min, 'total_cents', v_sub + v_fee,
    'currency', 'EUR',
    'ready_minutes', case when p_kind = 'delivery' then v.delivery_minutes else v.prep_minutes end);
end;
$$;
revoke execute on function public.food_quote(text, jsonb, text, text, double precision, double precision) from public;
grant execute on function public.food_quote(text, jsonb, text, text, double precision, double precision) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ 3. the order SMS code (update 63's codes + 'order')

/**
 * As update 63, and purpose 'order' (a conversation of the shop with its token required; only while the shop takes
 * food orders; takes the 'order' quota). Refusals (raised): not_available, purpose, phone, name, conversation,
 * too_many, sms_quota. Service role only (the bookings function).
 */
create or replace function public.sms_code_start(
  p_slug text, p_purpose text, p_phone text, p_name text, p_caller_hash text,
  p_conversation_id uuid default null, p_conversation_token text default null, p_consent_version text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop public.shops%rowtype;
  v_phone text;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_hash text;
  v_conv uuid;
  v_code text := public.booking_new_code();
  v_id uuid := gen_random_uuid();
  v_quota text := case when p_purpose = 'order' then 'order' else 'booking' end;
begin
  select * into v_shop from public.shops where slug = p_slug and is_active;
  if not found or not public.shop_has_plan(v_shop.id) then raise exception 'not_available' using errcode = 'P0001'; end if;
  if p_purpose is null or p_purpose not in ('contact', 'booking', 'delete_all', 'order') then raise exception 'purpose' using errcode = '22023'; end if;
  if p_purpose = 'order' and not coalesce((public.food_open_state(v_shop.id) ->> 'accepting')::boolean, false)
     and public.food_open_state(v_shop.id) ->> 'reason' <> 'sms_quota' then
    raise exception 'not_available' using errcode = 'P0001';
  end if;
  v_phone := public.crm_phone(p_phone, v_shop.country);
  if v_phone is null then raise exception 'phone' using errcode = '22023'; end if;
  if v_name is not null and char_length(v_name) > 80 then raise exception 'name' using errcode = '22023'; end if;
  if p_purpose in ('contact', 'order') and v_name is null then raise exception 'name' using errcode = '22023'; end if;
  if p_caller_hash is null or length(p_caller_hash) < 16 then raise exception 'Invalid caller hash' using errcode = '22023'; end if;
  if p_conversation_id is not null then
    select c.id into v_conv from public.assistant_conversations c
    where c.id = p_conversation_id and c.shop_id = v_shop.id and c.token_hash = public.assistant_token_hash(p_conversation_token);
  end if;
  if p_purpose in ('contact', 'booking', 'order') and v_conv is null then raise exception 'conversation' using errcode = '22023'; end if;
  v_hash := public.booking_hash(v_phone);
  perform pg_advisory_xact_lock(hashtextextended('ppi-sms-code:' || v_hash, 0));
  if (select count(*) from public.sms_codes where phone_hash = v_hash and created_at > now() - interval '1 hour') >= 3
     or (select count(*) from public.sms_codes where caller_hash = p_caller_hash and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'too_many' using errcode = '54000';
  end if;
  if public.sms_quota_left(v_shop.id, v_quota) < 1 then raise exception 'sms_quota' using errcode = '54000'; end if;
  insert into public.sms_codes (id, shop_id, purpose, phone_hash, phone, name, code_hash, caller_hash, conversation_id,
                                consent_version, expires_at)
  values (v_id, v_shop.id, p_purpose, v_hash, v_phone, v_name, public.booking_hash(v_id::text || ':' || v_code), p_caller_hash,
          v_conv, left(p_consent_version, 40), now() + interval '10 minutes');
  return jsonb_build_object('id', v_id, 'code', v_code, 'phone', v_phone, 'shop_id', v_shop.id, 'shop_name', v_shop.name,
                            'purpose', p_purpose, 'expires_at', now() + interval '10 minutes');
end;
$$;
revoke execute on function public.sms_code_start(text, text, text, text, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.sms_code_start(text, text, text, text, text, uuid, text, text) to service_role;

/** As update 63: the code's SMS into the message log (masked), its parts of the quota — 'order' for an order code. */
create or replace function public.sms_code_claim(p_code_id uuid, p_body text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.sms_codes%rowtype;
  v_parts integer := public.crm_sms_parts(left(p_body, 480));
  v_id uuid;
begin
  select * into v from public.sms_codes where id = p_code_id;
  if not found or v.phone is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform public.sms_quota_take(v.shop_id, case when v.purpose = 'order' then 'order' else 'booking' end, v_parts);
  insert into public.shop_outgoing_messages (shop_id, contact_id, channel, recipient, body, status, kind, parts)
  values (v.shop_id, (select id from public.shop_contacts where shop_id = v.shop_id and phone = v.phone), 'sms', v.phone,
          regexp_replace(left(p_body, 480), '\d{6}', '••••••', 'g'), 'queued',
          case when v.purpose = 'order' then 'order_code' else 'sms_code' end, v_parts)
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.sms_code_claim(uuid, text) from public, anon, authenticated;
grant execute on function public.sms_code_claim(uuid, text) to service_role;

/**
 * As update 63; an 'order' code behaves like a 'contact' one (the contact found by the number or made, checked now,
 * the conversation linked). It is only ever checked inside food_order_create(), so a refusal there undoes it.
 */
create or replace function public.sms_code_verify(p_code_id uuid, p_code text, p_conversation_id uuid default null,
                                                  p_conversation_token text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.sms_codes%rowtype;
  v_contact uuid;
begin
  select * into v from public.sms_codes where id = p_code_id for update;
  if not found or v.used_at is not null or v.verified_at is not null or v.code_hash is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if p_conversation_id is not null and v.conversation_id is not null and (
       p_conversation_id <> v.conversation_id
       or not exists (select 1 from public.assistant_conversations c where c.id = p_conversation_id
                      and c.token_hash = public.assistant_token_hash(p_conversation_token))) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if v.attempts >= 5 then return jsonb_build_object('ok', false, 'reason', 'too_many_attempts'); end if;
  if public.booking_hash(v.id::text || ':' || btrim(coalesce(p_code, ''))) is distinct from v.code_hash then
    update public.sms_codes set attempts = attempts + 1 where id = p_code_id returning * into v;
    if v.attempts >= 5 then return jsonb_build_object('ok', false, 'reason', 'too_many_attempts'); end if;
    return jsonb_build_object('ok', false, 'reason', 'wrong_code', 'attempts_left', 5 - v.attempts);
  end if;
  update public.sms_codes set verified_at = now(), code_hash = null where id = p_code_id;
  if v.purpose in ('contact', 'booking', 'order') then
    select id into v_contact from public.shop_contacts where shop_id = v.shop_id and phone = v.phone for update;
    if v_contact is null then
      insert into public.shop_contacts (shop_id, name, phone, phone_verified_at, source, last_contact_at)
      values (v.shop_id, v.name, v.phone, now(), 'chat', now())
      returning id into v_contact;
    else
      update public.shop_contacts
      set phone_verified_at = now(), name = coalesce(name, v.name), last_contact_at = now(), updated_at = now()
      where id = v_contact;
    end if;
    if v.conversation_id is not null then
      update public.assistant_conversations
      set contact_id = v_contact, shopper_phone = v.phone, contact_verified_at = now(),
          contact_consent_version = coalesce(v.consent_version, contact_consent_version)
      where id = v.conversation_id;
    end if;
    update public.sms_codes set used_at = now(), phone = null, name = null where id = p_code_id;
    return jsonb_build_object('ok', true, 'purpose', v.purpose, 'contact_id', v_contact);
  end if;
  return jsonb_build_object('ok', true, 'purpose', v.purpose);
end;
$$;
revoke execute on function public.sms_code_verify(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.sms_code_verify(uuid, text, uuid, text) to service_role;

-- ------------------------------------------------------------------ 4. the order

/** An order as the owner's screens show it (lines, events, the payment data for the QR). */
create or replace function public.food_order_json(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', o.id, 'number', o.number, 'order_day', o.order_day, 'kind', o.kind, 'status', o.status,
    'pay_method', o.pay_method, 'paid_at', o.paid_at, 'cash_given_cents', o.cash_given_cents,
    'change_cents', case when o.cash_given_cents is not null then greatest(o.cash_given_cents - o.total_cents, 0) end,
    'name', o.name, 'phone', o.phone, 'address', o.address, 'note', o.note, 'lat', o.lat, 'lng', o.lng,
    'zone_name', o.zone_name, 'ready_by', o.ready_by, 'courier_id', o.courier_id,
    'subtotal_cents', o.subtotal_cents, 'delivery_cents', o.delivery_cents, 'total_cents', o.total_cents,
    'currency', o.currency, 'vs', o.vs, 'created_at', o.created_at, 'delivered_at', o.delivered_at,
    'cancelled_at', o.cancelled_at, 'cancel_reason', o.cancel_reason, 'stock_taken', o.stock_taken_at is not null,
    'contact_id', o.contact_id, 'conversation_id', o.conversation_id, 'verified', o.contact_id is not null or o.phone is not null,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'item_id', l.shop_item_id, 'name', l.name, 'qty', l.qty,
                                                           'base_cents', l.base_cents, 'extras', l.extras,
                                                           'extras_text', l.extras_text, 'extras_cents', l.extras_cents,
                                                           'line_cents', l.line_cents) order by l.position)
                       from public.food_order_lines l where l.order_id = o.id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('actor', e.actor, 'kind', e.kind, 'from', e.from_status,
                                                            'to', e.to_status, 'detail', e.detail, 'at', e.created_at) order by e.id)
                        from public.food_order_events e where e.order_id = o.id), '[]'::jsonb),
    'timezone', coalesce(sh.timezone, 'UTC'), 'shop_name', sh.name,
    'payee', coalesce(st.payee, left(sh.name, 70)), 'iban', st.iban, 'bic', st.bic)
  from public.food_orders o
  join public.shops sh on sh.id = o.shop_id
  left join public.sklad_settings st on st.shop_id = o.shop_id
  where o.id = p_id
$$;
revoke execute on function public.food_order_json(uuid) from public, anon, authenticated;
grant execute on function public.food_order_json(uuid) to service_role;

/** What the customer's page shows after placing the order (no events, no payment data). */
create or replace function public.food_order_public_json(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', o.id, 'number', o.number, 'kind', o.kind, 'status', o.status, 'pay_method', o.pay_method,
                            'total_cents', o.total_cents, 'ready_by', o.ready_by, 'address', o.address,
                            'timezone', coalesce(sh.timezone, 'UTC'))
  from public.food_orders o join public.shops sh on sh.id = o.shop_id
  where o.id = p_id
$$;
revoke execute on function public.food_order_public_json(uuid) from public, anon, authenticated;
grant execute on function public.food_order_public_json(uuid) to service_role;

/**
 * "Objednať": the code typed into the page's own field and the order's own UUID (made when the cart was shown). In ONE
 * transaction: the code checked (wrong → {ok:false, reason, attempts_left}, nothing placed), the price rule run again
 * (food_quote; not orderable → raised, the code stays unused), the contact found or made, the conversation linked,
 * the order (number of the shop's day, its own variable symbol) + lines as sold + its first event + the owner's alert.
 * The same UUID again → the same order (duplicate: true). Service role only (the bookings function).
 */
create or replace function public.food_order_create(
  p_code_id uuid, p_code text, p_order_id uuid, p_lines jsonb, p_kind text, p_pay_method text,
  p_address text default null, p_note text default null, p_lat double precision default null, p_lng double precision default null,
  p_conversation_id uuid default null, p_conversation_token text default null, p_lang text default null
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
  if p_pay_method is null or p_pay_method not in ('qr', 'cash', 'card') then raise exception 'pay_method' using errcode = '22023'; end if;
  -- the price rule before the code is spent (a refusal leaves the code to try again with another cart)
  v_quote := public.food_quote(v_shop.slug, p_lines, p_kind, v_address, p_lat, p_lng);
  if not (v_quote ->> 'orderable')::boolean then
    raise exception '%', coalesce(v_quote ->> 'problem', 'not_orderable') using errcode = 'P0001';
  end if;
  v := public.food_setup(v_shop.id);
  if p_pay_method = 'qr' and not (v.pay_qr and exists (select 1 from public.sklad_settings st where st.shop_id = v_shop.id and st.iban is not null))
     or p_pay_method = 'cash' and not v.pay_cash or p_pay_method = 'card' and not v.pay_card then
    raise exception 'pay_method' using errcode = '22023';
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
  values (p_order_id, v_shop.id, v_seq, v_day, p_kind, p_pay_method, (v_check ->> 'contact_id')::uuid, c.conversation_id,
          c.name, c.phone, case when p_kind = 'delivery' then v_address end, v_note,
          case when p_kind = 'delivery' then p_lat end, case when p_kind = 'delivery' then p_lng end,
          (v_quote -> 'zone' ->> 'id')::uuid, v_quote -> 'zone' ->> 'name',
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
revoke execute on function public.food_order_create(uuid, text, uuid, jsonb, text, text, text, text, double precision, double precision, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.food_order_create(uuid, text, uuid, jsonb, text, text, text, text, double precision, double precision, uuid, text, text)
  to service_role;

/** The stock rows of an order: each line and each extra with its own movement id (md5 of the order, line, extra n). */
create or replace function public.food_stock_rows(p_order_id uuid, p_shop_id uuid)
returns table (id uuid, item uuid, qty numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.item, r.qty
  from (
    select md5(p_order_id::text || ':' || l.id::text)::uuid id, l.shop_item_id item, l.qty::numeric qty
    from public.food_order_lines l where l.order_id = p_order_id
    union all
    select md5(p_order_id::text || ':' || l.id::text || ':' || x.n::text)::uuid, (x.e ->> 'item_id')::uuid, l.qty::numeric
    from public.food_order_lines l, jsonb_array_elements(l.extras) with ordinality x(e, n)
    where l.order_id = p_order_id
  ) r
  where exists (select 1 from public.sklad_items i where i.shop_item_id = r.item and i.shop_id = p_shop_id)
$$;
revoke execute on function public.food_stock_rows(uuid, uuid) from public, anon, authenticated;
grant execute on function public.food_stock_rows(uuid, uuid) to service_role;

/**
 * Takes a delivered / picked-up order off the stock: one 'sale' movement per line and per extra at the shop's sales
 * place, ids md5(order ':' line) and md5(order ':' line ':' extra n) — so never twice — then the public side. Only with
 * "Odpísať zo skladu po doručení" and while Sklad is the shop's stock source.
 */
create or replace function public.food_take_stock(p_order_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  o public.food_orders;
  v_ids uuid[];
  v_loc uuid;
begin
  select * into o from public.food_orders where id = p_order_id for update;
  if o.id is null or o.stock_taken_at is not null then return false; end if;
  if not coalesce((select deduct_on_delivery from public.food_settings where shop_id = o.shop_id), false)
     or public.stock_source_of(o.shop_id) <> 'sklad' then
    return false;
  end if;
  v_loc := public.sklad_default_location(o.shop_id, false);
  if v_loc is null then return false; end if;
  select array_agg(distinct r.item order by r.item) into v_ids from public.food_stock_rows(o.id, o.shop_id) r;
  perform pg_advisory_xact_lock(hashtextextended('sklad:' || x::text, 0)) from unnest(coalesce(v_ids, '{}')) x order by x;
  insert into public.sklad_movements (id, shop_id, shop_item_id, location_id, kind, qty, ref, device_label, created_by, client_at)
  select r.id, o.shop_id, r.item, v_loc, 'sale', -r.qty, left('Objednávka ' || o.number || ' · ' || to_char(o.order_day, 'DD.MM.'), 80),
         'Objednávky jedla', auth.uid(), now()
  from public.food_stock_rows(o.id, o.shop_id) r
  on conflict (id) do nothing;
  update public.food_orders set stock_taken_at = now() where id = o.id;
  if v_ids is not null then perform public.sklad_apply(o.shop_id, v_ids); end if;
  return true;
end;
$$;
revoke execute on function public.food_take_stock(uuid) from public, anon, authenticated;
grant execute on function public.food_take_stock(uuid) to service_role;

/** The allowed steps: new → preparing / ready / on_the_way / cancelled; preparing → ready / on_the_way / cancelled; … */
create or replace function public.food_step_allowed(p_kind text, p_from text, p_to text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_to = 'cancelled' then p_from in ('new', 'preparing', 'ready', 'on_the_way')
    when p_kind = 'delivery' then (p_from, p_to) in (('new', 'preparing'), ('new', 'on_the_way'), ('preparing', 'on_the_way'),
                                                     ('on_the_way', 'delivered'))
    else (p_from, p_to) in (('new', 'preparing'), ('new', 'ready'), ('preparing', 'ready'), ('ready', 'picked_up'))
  end
$$;
revoke execute on function public.food_step_allowed(text, text, text) from public, anon, authenticated;
grant execute on function public.food_step_allowed(text, text, text) to service_role;

/**
 * ONE door for every change of an order (owner, courier, system): optionally a payment mark first (once: the method,
 * the time, who; cash: what the customer gave, at least the total), then a status step (allowed steps only; delivered /
 * picked up need the payment mark; they take the stock once). Every change is a line in food_order_events with the
 * step's own UUID: the same UUID again changes nothing. Refusals (raised): not_found, step, not_paid, already_paid,
 * pay_method, cash. Service role only (owner_food_order_status / the courier's function call it).
 */
create or replace function public.food_order_step(
  p_order_id uuid, p_to text, p_actor text, p_actor_id uuid, p_step_id uuid,
  p_pay_method text default null, p_cash_given_cents integer default null, p_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  o public.food_orders;
  v public.food_settings;
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 200), '');
begin
  if p_step_id is not null and exists (select 1 from public.food_order_events e where e.step_id = p_step_id) then
    if not exists (select 1 from public.food_order_events e where e.step_id = p_step_id and e.order_id = p_order_id) then
      raise exception 'conflict' using errcode = '23505';
    end if;
    return public.food_order_json(p_order_id) || jsonb_build_object('duplicate', true);
  end if;
  select * into o from public.food_orders where id = p_order_id for update;
  if o.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  select * into v from public.food_settings where shop_id = o.shop_id;

  if p_pay_method is not null then
    if o.paid_at is not null then
      if o.pay_method <> p_pay_method then raise exception 'already_paid' using errcode = 'P0001'; end if;
    else
      if p_pay_method not in ('qr', 'cash', 'card') or p_pay_method = 'card' and not v.pay_card
         or p_pay_method = 'cash' and not v.pay_cash or p_pay_method = 'qr' and not v.pay_qr then
        raise exception 'pay_method' using errcode = '22023';
      end if;
      if p_pay_method = 'cash' and p_cash_given_cents is not null and p_cash_given_cents < o.total_cents then
        raise exception 'cash' using errcode = '22023';
      end if;
      if o.status = 'cancelled' then raise exception 'step' using errcode = 'P0001'; end if;
      update public.food_orders
      set pay_method = p_pay_method, paid_at = now(),
          paid_by = case when p_actor = 'owner' then p_actor_id end,
          paid_by_courier = case when p_actor = 'courier' then p_actor_id end,
          cash_given_cents = case when p_pay_method = 'cash' then p_cash_given_cents end, updated_at = now()
      where id = o.id
      returning * into o;
      insert into public.food_order_events (order_id, shop_id, step_id, actor, actor_id, kind, from_status, to_status, detail)
      values (o.id, o.shop_id, case when p_to is null then p_step_id end, p_actor, p_actor_id, 'paid', o.status, o.status, p_pay_method);
      insert into public.shop_activity (shop_id, actor, action, details)
      values (o.shop_id, case when p_actor = 'owner' then p_actor_id end, 'food_order_paid',
              jsonb_build_object('order', o.id, 'number', o.number, 'method', p_pay_method, 'by', p_actor));
    end if;
  end if;

  if p_to is not null and p_to <> o.status then
    if not public.food_step_allowed(o.kind, o.status, p_to) then raise exception 'step' using errcode = 'P0001'; end if;
    if p_to in ('delivered', 'picked_up') and o.paid_at is null then raise exception 'not_paid' using errcode = 'P0001'; end if;
    insert into public.food_order_events (order_id, shop_id, step_id, actor, actor_id, kind, from_status, to_status, detail)
    values (o.id, o.shop_id, p_step_id, p_actor, p_actor_id, 'status', o.status, p_to, v_reason);
    update public.food_orders
    set status = p_to, updated_at = now(),
        delivered_at = case when p_to in ('delivered', 'picked_up') then now() else delivered_at end,
        cancelled_at = case when p_to = 'cancelled' then now() else cancelled_at end,
        cancel_reason = case when p_to = 'cancelled' then v_reason else cancel_reason end
    where id = o.id;
    insert into public.shop_activity (shop_id, actor, action, details)
    values (o.shop_id, case when p_actor = 'owner' then p_actor_id end, 'food_order_status',
            jsonb_build_object('order', o.id, 'number', o.number, 'from', o.status, 'to', p_to, 'by', p_actor));
    if p_to in ('delivered', 'picked_up') then perform public.food_take_stock(o.id); end if;
  end if;
  return public.food_order_json(o.id) || jsonb_build_object('duplicate', false);
end;
$$;
revoke execute on function public.food_order_step(uuid, text, text, uuid, uuid, text, integer, text) from public, anon, authenticated;
grant execute on function public.food_order_step(uuid, text, text, uuid, uuid, text, integer, text) to service_role;

-- ------------------------------------------------------------------ 5. the owner's side (members; writes also the plan)

create or replace function public.food_owner_write(p_shop_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.sklad_member(p_shop_id);
  if not public.shop_has_plan(p_shop_id) then raise exception 'no_plan' using errcode = 'P0001'; end if;
end;
$$;
revoke execute on function public.food_owner_write(uuid) from public, anon, authenticated;

/** "Nastavenia objednávok": the switches, the zones, the menu's sources (Sklad products, products without a price). */
create or replace function public.owner_food_settings(p_shop_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.food_settings;
begin
  perform public.sklad_member(p_shop_id);
  v := public.food_setup(p_shop_id);
  return to_jsonb(v) - 'order_day' - 'order_seq' || jsonb_build_object(
    'has_plan', public.shop_has_plan(p_shop_id),
    'state', public.food_open_state(p_shop_id),
    'zones', coalesce((select jsonb_agg(to_jsonb(z) - 'shop_id' order by z.sort, z.created_at)
                       from public.food_zones z where z.shop_id = p_shop_id), '[]'::jsonb),
    'sklad_source', public.stock_source_of(p_shop_id) = 'sklad',
    'menu_items', (select count(*) from public.sklad_items i where i.shop_id = p_shop_id and i.sale_price is not null),
    'menu_categories', coalesce((select jsonb_agg(distinct si.category) from public.sklad_items i
                                 join public.shop_items si on si.id = i.shop_item_id
                                 where i.shop_id = p_shop_id and i.sale_price is not null and si.category is not null), '[]'::jsonb),
    'iban_set', exists (select 1 from public.sklad_settings st where st.shop_id = p_shop_id and st.iban is not null),
    'sms', public.sms_quota_state(p_shop_id));
end;
$$;
revoke execute on function public.owner_food_settings(uuid) from public, anon;
grant execute on function public.owner_food_settings(uuid) to authenticated;

/** "Uložiť": only the fields given change; at least one payment method stays on. */
create or replace function public.owner_food_save_settings(p_shop_id uuid, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.food_settings;
  b text;
  n text;
begin
  perform public.food_owner_write(p_shop_id);
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'bad_request' using errcode = '22023'; end if;
  v := public.food_setup(p_shop_id);
  foreach b in array array['enabled', 'pickup_on', 'delivery_on', 'pay_qr', 'pay_cash', 'pay_card', 'deduct_on_delivery',
                           'alert_sound', 'alert_email', 'alert_telegram', 'sms_on_the_way'] loop
    if p ? b and jsonb_typeof(p -> b) <> 'boolean' then raise exception '%', b using errcode = '22023'; end if;
  end loop;
  foreach n in array array['prep_minutes', 'delivery_minutes', 'last_order_minutes'] loop
    if p ? n and (jsonb_typeof(p -> n) <> 'number' or (p ->> n)::numeric <> floor((p ->> n)::numeric)) then
      raise exception '%', n using errcode = '22023';
    end if;
  end loop;
  if p ? 'assign_mode' and coalesce(p ->> 'assign_mode', '') not in ('manual', 'auto') then
    raise exception 'assign_mode' using errcode = '22023';
  end if;
  begin
    update public.food_settings set
      enabled = coalesce((p ->> 'enabled')::boolean, enabled),
      pickup_on = coalesce((p ->> 'pickup_on')::boolean, pickup_on),
      prep_minutes = coalesce((p ->> 'prep_minutes')::integer, prep_minutes),
      delivery_on = coalesce((p ->> 'delivery_on')::boolean, delivery_on),
      delivery_minutes = coalesce((p ->> 'delivery_minutes')::integer, delivery_minutes),
      pay_qr = coalesce((p ->> 'pay_qr')::boolean, pay_qr),
      pay_cash = coalesce((p ->> 'pay_cash')::boolean, pay_cash),
      pay_card = coalesce((p ->> 'pay_card')::boolean, pay_card),
      last_order_minutes = coalesce((p ->> 'last_order_minutes')::integer, last_order_minutes),
      deduct_on_delivery = coalesce((p ->> 'deduct_on_delivery')::boolean, deduct_on_delivery),
      alert_sound = coalesce((p ->> 'alert_sound')::boolean, alert_sound),
      alert_email = coalesce((p ->> 'alert_email')::boolean, alert_email),
      alert_telegram = coalesce((p ->> 'alert_telegram')::boolean, alert_telegram),
      sms_on_the_way = coalesce((p ->> 'sms_on_the_way')::boolean, sms_on_the_way),
      assign_mode = coalesce(p ->> 'assign_mode', assign_mode),
      updated_at = now()
    where shop_id = p_shop_id
    returning * into v;
  exception when check_violation then
    raise exception 'settings' using errcode = '22023';
  end;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'food_settings_saved', jsonb_build_object('enabled', v.enabled));
  return public.owner_food_settings(p_shop_id);
end;
$$;
revoke execute on function public.owner_food_save_settings(uuid, jsonb) from public, anon;
grant execute on function public.owner_food_save_settings(uuid, jsonb) to authenticated;

/** "Pozastaviť objednávky" / "Spustiť": the assistant and the page stop offering orders at once (orders placed stay). */
create or replace function public.owner_food_pause(p_shop_id uuid, p_paused boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.food_owner_write(p_shop_id);
  perform public.food_setup(p_shop_id);
  update public.food_settings
  set paused = coalesce(p_paused, false), paused_at = case when coalesce(p_paused, false) then now() end, updated_at = now()
  where shop_id = p_shop_id;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), case when coalesce(p_paused, false) then 'food_paused' else 'food_resumed' end, '{}'::jsonb);
  return public.food_open_state(p_shop_id);
end;
$$;
revoke execute on function public.owner_food_pause(uuid, boolean) from public, anon;
grant execute on function public.owner_food_pause(uuid, boolean) to authenticated;

/** "+ Pridať zónu" / editing one: town (a word in the address), postcode, or kilometres from the shop. */
create or replace function public.owner_food_save_zone(p_shop_id uuid, p_id uuid, p_name text, p_kind text, p_value text,
                                                       p_fee_cents integer, p_minimum_cents integer, p_sort integer default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
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
  if p_id is null then
    if (select count(*) from public.food_zones where shop_id = p_shop_id) >= 30 then raise exception 'too_many' using errcode = '54000'; end if;
    insert into public.food_zones (shop_id, name, kind, value, fee_cents, minimum_cents, sort)
    values (p_shop_id, left(btrim(p_name), 80), p_kind, left(btrim(p_value), 80), p_fee_cents, p_minimum_cents,
            coalesce(p_sort, (select coalesce(max(sort), 0) + 1 from public.food_zones where shop_id = p_shop_id)))
    returning id into v_id;
  else
    update public.food_zones
    set name = left(btrim(p_name), 80), kind = p_kind, value = left(btrim(p_value), 80), fee_cents = p_fee_cents,
        minimum_cents = p_minimum_cents, sort = coalesce(p_sort, sort)
    where id = p_id and shop_id = p_shop_id
    returning id into v_id;
    if v_id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  end if;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'food_zone_saved', jsonb_build_object('zone', v_id, 'kind', p_kind));
  return v_id;
end;
$$;
revoke execute on function public.owner_food_save_zone(uuid, uuid, text, text, text, integer, integer, integer) from public, anon;
grant execute on function public.owner_food_save_zone(uuid, uuid, text, text, text, integer, integer, integer) to authenticated;

create or replace function public.owner_food_delete_zone(p_shop_id uuid, p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.food_owner_write(p_shop_id);
  delete from public.food_zones where id = p_id and shop_id = p_shop_id;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'food_zone_deleted', jsonb_build_object('zone', p_id));
end;
$$;
revoke execute on function public.owner_food_delete_zone(uuid, uuid) from public, anon;
grant execute on function public.owner_food_delete_zone(uuid, uuid) to authenticated;

/** The Objednávky tab's badge: orders still new. */
create or replace function public.owner_food_new_count(p_shop_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.sklad_member(p_shop_id);
  return (select count(*) from public.food_orders where shop_id = p_shop_id and status = 'new')::integer;
end;
$$;
revoke execute on function public.owner_food_new_count(uuid) from public, anon;
grant execute on function public.owner_food_new_count(uuid) to authenticated;

/**
 * The Objednávky tab and the kitchen board: the orders of a filter (new · preparing · on_the_way (with ready pickups)
 * · done (today's delivered / picked up / cancelled) · open (everything not finished)), the counts, today's totals by
 * payment method, and the state (accepting / paused / why not).
 */
create or replace function public.owner_food_orders(p_shop_id uuid, p_filter text default 'open', p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text := coalesce((select timezone from public.shops where id = p_shop_id), 'UTC');
  v_today date := (now() at time zone v_tz)::date;
  v_from timestamptz := v_today::timestamp at time zone v_tz;
begin
  perform public.sklad_member(p_shop_id);
  if coalesce(p_filter, '') not in ('new', 'preparing', 'on_the_way', 'done', 'open') then
    raise exception 'filter' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'orders', coalesce((
      select jsonb_agg(x.j order by x.created_at desc)
      from (
        select public.food_order_json(o.id) - 'events' - 'iban' - 'bic' - 'payee' j, o.created_at
        from public.food_orders o
        where o.shop_id = p_shop_id and case p_filter
          when 'new' then o.status = 'new'
          when 'preparing' then o.status = 'preparing'
          when 'on_the_way' then o.status in ('on_the_way', 'ready')
          when 'done' then o.status in ('delivered', 'picked_up', 'cancelled') and o.created_at >= v_from
          else o.status in ('new', 'preparing', 'on_the_way', 'ready') end
        order by o.created_at desc
        limit least(greatest(coalesce(p_limit, 100), 1), 300)
      ) x), '[]'::jsonb),
    'counts', jsonb_build_object(
      'new', (select count(*) from public.food_orders where shop_id = p_shop_id and status = 'new'),
      'preparing', (select count(*) from public.food_orders where shop_id = p_shop_id and status = 'preparing'),
      'on_the_way', (select count(*) from public.food_orders where shop_id = p_shop_id and status in ('on_the_way', 'ready')),
      'done', (select count(*) from public.food_orders where shop_id = p_shop_id and status in ('delivered', 'picked_up')
               and created_at >= v_from)),
    'totals', (select jsonb_build_object(
                 'count', count(*), 'total_cents', coalesce(sum(total_cents), 0),
                 'qr_cents', coalesce(sum(total_cents) filter (where pay_method = 'qr'), 0),
                 'cash_cents', coalesce(sum(total_cents) filter (where pay_method = 'cash'), 0),
                 'card_cents', coalesce(sum(total_cents) filter (where pay_method = 'card'), 0),
                 'qr', count(*) filter (where pay_method = 'qr'), 'cash', count(*) filter (where pay_method = 'cash'),
                 'card', count(*) filter (where pay_method = 'card'))
               from public.food_orders where shop_id = p_shop_id and status in ('delivered', 'picked_up') and created_at >= v_from),
    'state', public.food_open_state(p_shop_id),
    'settings', (select jsonb_build_object('enabled', s.enabled, 'paused', s.paused, 'pickup_on', s.pickup_on,
                                           'prep_minutes', s.prep_minutes, 'delivery_on', s.delivery_on,
                                           'delivery_minutes', s.delivery_minutes, 'alert_sound', s.alert_sound,
                                           'sms_on_the_way', s.sms_on_the_way)
                 from public.food_settings s where s.shop_id = p_shop_id),
    'timezone', v_tz);
end;
$$;
revoke execute on function public.owner_food_orders(uuid, text, integer) from public, anon;
grant execute on function public.owner_food_orders(uuid, text, integer) to authenticated;

/** One order (its detail page). */
create or replace function public.owner_food_order(p_shop_id uuid, p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.sklad_member(p_shop_id);
  if not exists (select 1 from public.food_orders where id = p_order_id and shop_id = p_shop_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return public.food_order_json(p_order_id) || jsonb_build_object(
    'sms_on_the_way', coalesce((select sms_on_the_way from public.food_settings where shop_id = p_shop_id), false),
    'sms', public.sms_quota_state(p_shop_id));
end;
$$;
revoke execute on function public.owner_food_order(uuid, uuid) from public, anon;
grant execute on function public.owner_food_order(uuid, uuid) to authenticated;

/** "Do prípravy", "Na ceste", "Pripravené na odber", "Doručené", "Zrušiť" and the payment marks, by the owner. */
create or replace function public.owner_food_order_status(p_shop_id uuid, p_order_id uuid, p_to text, p_step_id uuid,
                                                          p_pay_method text default null, p_cash_given_cents integer default null,
                                                          p_reason text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.food_owner_write(p_shop_id);
  if not exists (select 1 from public.food_orders where id = p_order_id and shop_id = p_shop_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_to is not null and p_to not in ('preparing', 'on_the_way', 'ready', 'delivered', 'picked_up', 'cancelled') then
    raise exception 'step' using errcode = 'P0001';
  end if;
  return public.food_order_step(p_order_id, p_to, 'owner', auth.uid(), p_step_id, p_pay_method, p_cash_given_cents, p_reason);
end;
$$;
revoke execute on function public.owner_food_order_status(uuid, uuid, text, uuid, text, integer, text) from public, anon;
grant execute on function public.owner_food_order_status(uuid, uuid, text, uuid, text, integer, text) to authenticated;

-- ------------------------------------------------------------------ 6. "Vymazať moje údaje" also forgets the orders

/**
 * As update 63, and the shop's food orders of that number lose their personal fields (name, phone, address, note,
 * the place, the contact and the conversation); the order rows, their lines and totals stay for the shop's accounts.
 */
create or replace function public.shopper_forget_all_finish(p_code_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.sms_codes%rowtype;
  v_contact uuid;
  v_booking record;
  v_cancelled integer := 0;
  v_had boolean := false;
begin
  select * into v from public.sms_codes where id = p_code_id for update;
  if not found or v.purpose <> 'delete_all' or v.verified_at is null or v.used_at is not null
     or v.verified_at < now() - interval '15 minutes' or v.phone is null then
    raise exception 'not_verified' using errcode = 'P0001';
  end if;
  select id into v_contact from public.shop_contacts where shop_id = v.shop_id and phone = v.phone;
  v_had := v_contact is not null or exists (select 1 from public.shop_bookings where shop_id = v.shop_id and phone = v.phone)
           or exists (select 1 from public.assistant_conversations where shop_id = v.shop_id and shopper_phone = v.phone)
           or exists (select 1 from public.food_orders where shop_id = v.shop_id and phone = v.phone);
  for v_booking in
    select b.id from public.shop_bookings b
    where b.shop_id = v.shop_id and (b.phone = v.phone or (v_contact is not null and b.contact_id = v_contact))
      and b.status = 'confirmed' and b.starts_at > now()
  loop
    if public.booking_cancel(v_booking.id, 'shopper', null, false) then v_cancelled := v_cancelled + 1; end if;
  end loop;
  -- the audit log (booking_events) holds no personal data: its lines stay as they are
  update public.shop_bookings
  set name = '—', phone = null, email = null, address = null, note = null, contact_id = null, conversation_id = null,
      lang = null, caller_hash = null
  where shop_id = v.shop_id and (phone = v.phone or (v_contact is not null and contact_id = v_contact));
  -- update 73: the orders stay for the shop's accounts, without the person
  update public.food_orders
  set name = null, phone = null, address = null, note = null, lat = null, lng = null, contact_id = null,
      conversation_id = null, lang = null, updated_at = now()
  where shop_id = v.shop_id and (phone = v.phone or (v_contact is not null and contact_id = v_contact));
  update public.shop_outgoing_messages
  set recipient = '—', body = '—', subject = null, contact_id = null
  where shop_id = v.shop_id and (recipient = v.phone or (v_contact is not null and contact_id = v_contact));
  update public.assistant_conversations
  set contact_id = null, shopper_phone = null, callback_name = null, callback_email = null, owner_note = null,
      contact_verified_at = null
  where shop_id = v.shop_id and (shopper_phone = v.phone or (v_contact is not null and contact_id = v_contact));
  if v_contact is not null then
    delete from public.shop_contacts where id = v_contact;
  end if;
  delete from public.sms_codes where phone_hash = v.phone_hash and id <> p_code_id;
  update public.sms_codes set used_at = now(), phone = null, name = null where id = p_code_id;
  if v_had then
    insert into public.shop_owner_alerts (shop_id, kind) values (v.shop_id, 'forget_all');
    insert into public.shop_activity (shop_id, actor, action, details)
    values (v.shop_id, null, 'shopper_forgot_all', jsonb_build_object('bookings_cancelled', v_cancelled));
    perform public.crm_alerts_kick();
  end if;
  return jsonb_build_object('ok', true, 'bookings_cancelled', v_cancelled, 'had_data', v_had);
end;
$$;
revoke execute on function public.shopper_forget_all_finish(uuid) from public, anon, authenticated;
grant execute on function public.shopper_forget_all_finish(uuid) to service_role;
