-- =====================================================================================================================
-- Update 81 — "Objednávky jedla": the order feed, the times for the assistant and the parts a shop uses (2026-11-05)
--
-- The feed of Objednávky jedla: orders as cards, a finished one swiped away (grey at the bottom), the times above it
-- (preparation, delivery, a delay) that the shop assistant uses too, and a shop that wants only the feed switches the
-- rest off. Every F1–F4 rule (updates 73–75) stays; this file only adds:
--   * food_settings: delay_minutes (0–120) + delay_set_at, delay_reset close | midnight | never, warn_long_delay,
--     courier_app ("Aplikácia kuriéra"; until the owner chooses, on while the shop has a courier), payments_on ("Platby v Cacaduu"),
--     qr_terminal ("QR terminál"), feed_order newest | oldest. "Donáška" = delivery_on, "Pokladňa" =
--     deduct_on_delivery (as before). Only owner_food_save_settings writes them, only the fields it is given (the delay
--     also through owner_food_set_delay, the bar above the feed; activity food_delay). Switched off = not used, nothing
--     deleted: the pay_* switches, the couriers and their logins stay as they are.
--   * ONE time rule: food_times() — pickup in prep + delay, delivery in the estimate + delay, long_delay (≥ 30 min and
--     the warning on); food_state() (the page and the assistant) carries it, food_quote()'s ready_minutes includes the
--     delay, so food_order_create() sets ready_by with the delay of that moment.
--   * Without "Platby v Cacaduu": food_state offers no payment method, an order has no pay method (pay_method null),
--     no payment marks (refused), and picked up / delivered need none; the couriers' payment marks are off too.
--   * Without the courier app: no new assignment (owner_food_assign refuses one, the automatic one does not run);
--     couriers keep their logins and their own deliveries.
--   * The feed's two actions: food_order_finish() — ONE transaction that skips the steps in between (pickup →
--     picked_up; delivery → delivered, or → on_the_way with the courier app, a courier assigned); with payments a
--     payment mark first (given now or already there); the stock as today (Pokladňa + Sklad), once — and
--     food_order_reopen() — back to the state before, only on the shop's same day; stock taken comes back as one
--     opposite Oprava per line ("Vrátené – objednávka č. n"), once; the payment mark stays. Stock movement ids carry
--     the order's reopen count, so a later finish takes the stock again, once. Each step's UUID once, activity log,
--     owner_* wrappers (members + shop_has_plan).
--   * The delay goes back to 0 by itself (food_delay_tick, pg_cron every 5 minutes, SQL only): at the shop's closing
--     (the end of the open range in which it was set, else the next one) or at the shop's midnight, in its time zone.
--   * owner_food_feed(): the feed's active cards, today's finished ones, the older ones on request.
--   * The owner MCP (update 80's door kept as owner_mcp_call_80): set_food_delay, finish_food_order and
--     reopen_food_order (shop.write; before → after until confirm: true) — the Telegram bot's "Meškanie" button uses
--     set_food_delay through the same door and its "Potvrdiť".
-- Needs updates 57, 61, 66–68, 73–75, 80. Safe to run twice; nothing is deleted (one table rule is relaxed: a picked
-- up / delivered order needs a payment mark only while the shop takes payments — food_order_step / food_order_finish
-- decide it).
-- =====================================================================================================================

-- ------------------------------------------------------------------ 0. the activity log, the new settings

do $$
declare
  v_def text := (select pg_get_constraintdef(c.oid) from pg_constraint c
                 where c.conrelid = 'public.shop_activity'::regclass and c.conname = 'shop_activity_action_check');
  v_add text := '';
  a text;
begin
  if v_def is null then return; end if;
  foreach a in array array['food_delay', 'food_order_finished', 'food_order_reopened'] loop
    if position('''' || a || '''' in v_def) = 0 then v_add := v_add || '''' || a || '''::text, '; end if;
  end loop;
  if v_add <> '' then
    alter table public.shop_activity drop constraint shop_activity_action_check;
    execute 'alter table public.shop_activity add constraint shop_activity_action_check ' || replace(v_def, 'ARRAY[', 'ARRAY[' || v_add);
  end if;
end;
$$;

alter table public.food_settings add column if not exists delay_minutes integer not null default 0
  check (delay_minutes between 0 and 120);
alter table public.food_settings add column if not exists delay_set_at timestamptz;
alter table public.food_settings add column if not exists delay_reset text not null default 'close'
  check (delay_reset in ('close', 'midnight', 'never'));
alter table public.food_settings add column if not exists warn_long_delay boolean not null default true;
alter table public.food_settings add column if not exists payments_on boolean not null default true;
alter table public.food_settings add column if not exists qr_terminal boolean not null default true;
alter table public.food_settings add column if not exists feed_order text not null default 'newest'
  check (feed_order in ('newest', 'oldest'));
-- "Aplikácia kuriéra": null = not chosen yet = on while the shop has an active courier (so a shop that adds its first
-- courier gets the app at once, as before this update); true / false = the owner's own choice
alter table public.food_settings add column if not exists courier_app boolean;

-- the order's reopen count (part of its stock movement ids); an order without payments has no pay method
alter table public.food_orders add column if not exists reopens integer not null default 0 check (reopens between 0 and 1000);
alter table public.food_orders alter column pay_method drop not null;
-- "picked up / delivered need a payment mark" is decided by food_order_step / food_order_finish (only with payments)
do $$
declare
  c record;
begin
  for c in select con.conname from pg_constraint con
           where con.conrelid = 'public.food_orders'::regclass and con.contype = 'c'
             and pg_get_constraintdef(con.oid) like '%paid_at IS NOT NULL%' loop
    execute format('alter table public.food_orders drop constraint %I', c.conname);
  end loop;
end;
$$;

-- ------------------------------------------------------------------ 1. the parts a shop uses, the times

/**
 * The parts switched on (what is actually used): delivery = "Donáška"; courier_app needs delivery (not chosen yet = on
 * while the shop has an active courier); payments = "Platby v Cacaduu"; register = "Pokladňa" (deduct_on_delivery);
 * qr_terminal needs payments; on = how many of the five.
 */
create or replace function public.food_parts(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('delivery', x.delivery, 'courier_app', x.courier_app, 'payments', x.payments,
                            'register', x.register, 'qr_terminal', x.qr_terminal,
                            'on', x.delivery::int + x.courier_app::int + x.payments::int + x.register::int + x.qr_terminal::int)
  from (
    select coalesce(s.delivery_on, false) delivery,
           coalesce(s.delivery_on, false)
             and coalesce(s.courier_app, exists (select 1 from public.food_couriers c where c.shop_id = p_shop_id and c.active)) courier_app,
           coalesce(s.payments_on, true) payments,
           coalesce(s.deduct_on_delivery, true) register,
           coalesce(s.qr_terminal and s.payments_on, false) qr_terminal
    from (select 1) one
    left join public.food_settings s on s.shop_id = p_shop_id
  ) x
$$;
revoke execute on function public.food_parts(uuid) from public, anon, authenticated;
grant execute on function public.food_parts(uuid) to service_role;

/**
 * ONE time rule (the feed's box, the shop page, the assistant, the order): pickup in prep + delay, delivery in the
 * estimate + delay; long_delay = a delay of 30 minutes or more while "Meškanie nad 30 min povie asistent" is on.
 */
create or replace function public.food_times(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'prep_minutes', coalesce(s.prep_minutes, 20), 'delivery_minutes', coalesce(s.delivery_minutes, 45),
    'delay_minutes', coalesce(s.delay_minutes, 0), 'delay_reset', coalesce(s.delay_reset, 'close'),
    'warn_long_delay', coalesce(s.warn_long_delay, true),
    'ready_pickup_min', coalesce(s.prep_minutes, 20) + coalesce(s.delay_minutes, 0),
    'ready_delivery_min', coalesce(s.delivery_minutes, 45) + coalesce(s.delay_minutes, 0),
    'long_delay', coalesce(s.delay_minutes, 0) >= 30 and coalesce(s.warn_long_delay, true))
  from (select 1) one
  left join public.food_settings s on s.shop_id = p_shop_id
$$;
revoke execute on function public.food_times(uuid) from public, anon, authenticated;
grant execute on function public.food_times(uuid) to service_role;

/** As update 73, and the times with the delay, long_delay, and no payment methods without "Platby v Cacaduu". */
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
begin
  select * into v_shop from public.shops where slug = p_slug and is_active;
  if not found then return jsonb_build_object('enabled', false); end if;
  select * into v from public.food_settings where shop_id = v_shop.id;
  if v.shop_id is null or not v.enabled or not public.shop_has_plan(v_shop.id) then
    return jsonb_build_object('enabled', false);
  end if;
  v_open := public.food_open_state(v_shop.id);
  v_times := public.food_times(v_shop.id);
  return jsonb_build_object(
    'enabled', true, 'accepting', (v_open ->> 'accepting')::boolean, 'reason', v_open ->> 'reason',
    'last_order_at', v_open -> 'last_order_at', 'timezone', v_open ->> 'timezone',
    'pickup', v.pickup_on, 'prep_minutes', v.prep_minutes,
    'delivery', v.delivery_on and exists (select 1 from public.food_zones z where z.shop_id = v_shop.id),
    'delivery_minutes', v.delivery_minutes,
    'delay_minutes', v.delay_minutes,
    'ready_pickup_min', (v_times ->> 'ready_pickup_min')::integer,
    'ready_delivery_min', (v_times ->> 'ready_delivery_min')::integer,
    'long_delay', (v_times ->> 'long_delay')::boolean,
    'payments', v.payments_on,
    'pay', jsonb_build_object(
      'qr', v.payments_on and v.pay_qr and exists (select 1 from public.sklad_settings st where st.shop_id = v_shop.id and st.iban is not null),
      'cash', v.payments_on and v.pay_cash, 'card', v.payments_on and v.pay_card),
    'zones', coalesce((select jsonb_agg(jsonb_build_object('name', z.name, 'fee_cents', z.fee_cents, 'minimum_cents', z.minimum_cents)
                                        order by z.sort, z.created_at)
                       from public.food_zones z where z.shop_id = v_shop.id), '[]'::jsonb),
    'phone', v_shop.phone);
end;
$$;
revoke execute on function public.food_state(text) from public;
grant execute on function public.food_state(text) to anon, authenticated, service_role;

/** As update 73; ready_minutes now includes the delay (pickup: prep + delay, delivery: the estimate + delay). */
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
    'ready_minutes', (case when p_kind = 'delivery' then v.delivery_minutes else v.prep_minutes end) + v.delay_minutes,
    'delay_minutes', v.delay_minutes);
end;
$$;
revoke execute on function public.food_quote(text, jsonb, text, text, double precision, double precision) from public;
grant execute on function public.food_quote(text, jsonb, text, text, double precision, double precision) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ 2. placing an order: the delay, no pay method

/**
 * As update 73 (the code + the order in one transaction, the same UUID again = the same order); ready_by = now + the
 * kind's time + the delay of this moment (food_quote's ready_minutes); without "Platby v Cacaduu" the order has no
 * pay method (whatever was sent), with it the method is required and must be on, as before.
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
  v_pay text;
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
  if v.payments_on then
    if p_pay_method is null or p_pay_method not in ('qr', 'cash', 'card') then raise exception 'pay_method' using errcode = '22023'; end if;
    v_pay := p_pay_method;
  end if;
  -- the price rule before the code is spent (a refusal leaves the code to try again with another cart)
  v_quote := public.food_quote(v_shop.slug, p_lines, p_kind, v_address, p_lat, p_lng);
  if not (v_quote ->> 'orderable')::boolean then
    raise exception '%', coalesce(v_quote ->> 'problem', 'not_orderable') using errcode = 'P0001';
  end if;
  if v_pay = 'qr' and not (v.pay_qr and exists (select 1 from public.sklad_settings st where st.shop_id = v_shop.id and st.iban is not null))
     or v_pay = 'cash' and not v.pay_cash or v_pay = 'card' and not v.pay_card then
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
  values (p_order_id, v_shop.id, v_seq, v_day, p_kind, v_pay, (v_check ->> 'contact_id')::uuid, c.conversation_id,
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

-- ------------------------------------------------------------------ 3. steps, stock, payments, couriers

/**
 * As update 73, and the order's reopen count in the ids: the first time md5(order ':' line) (as before), after the
 * n-th "Vrátiť" md5(order ':' line ':r' n) — so a finish after a reopen takes the stock again, once.
 */
create or replace function public.food_stock_rows(p_order_id uuid, p_shop_id uuid)
returns table (id uuid, item uuid, qty numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with o as (select coalesce((select reopens from public.food_orders where id = p_order_id), 0) n)
  select r.id, r.item, r.qty
  from (
    select md5(p_order_id::text || ':' || l.id::text || case when o.n > 0 then ':r' || o.n::text else '' end)::uuid id,
           l.shop_item_id item, l.qty::numeric qty
    from public.food_order_lines l, o where l.order_id = p_order_id
    union all
    select md5(p_order_id::text || ':' || l.id::text || ':' || x.n::text || case when o.n > 0 then ':r' || o.n::text else '' end)::uuid,
           (x.e ->> 'item_id')::uuid, l.qty::numeric
    from public.food_order_lines l, o, jsonb_array_elements(l.extras) with ordinality x(e, n)
    where l.order_id = p_order_id
  ) r
  where exists (select 1 from public.sklad_items i where i.shop_item_id = r.item and i.shop_id = p_shop_id)
$$;
revoke execute on function public.food_stock_rows(uuid, uuid) from public, anon, authenticated;
grant execute on function public.food_stock_rows(uuid, uuid) to service_role;

/**
 * As update 73 (ONE door for every step: allowed steps, each step's UUID once, a payment mark once, stock once), and
 * without "Platby v Cacaduu": no payment marks (pay_method), and picked up / delivered need none.
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
    if not coalesce(v.payments_on, true) then raise exception 'pay_method' using errcode = '22023'; end if;
    if o.paid_at is not null then
      if o.pay_method is distinct from p_pay_method then raise exception 'already_paid' using errcode = 'P0001'; end if;
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
    if p_to in ('delivered', 'picked_up') and o.paid_at is null and coalesce(v.payments_on, true) then
      raise exception 'not_paid' using errcode = 'P0001';
    end if;
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

/** As update 75; without "Platby v Cacaduu" the couriers mark no payment. */
create or replace function public.food_courier_perms(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'qr', coalesce(s.payments_on and s.pay_qr and s.courier_can_qr, false),
    'cash', coalesce(s.payments_on and s.pay_cash and s.courier_can_cash, false),
    'card', coalesce(s.payments_on and s.pay_card and s.courier_has_card, false))
  from (select 1) one
  left join public.food_settings s on s.shop_id = p_shop_id
$$;
revoke execute on function public.food_courier_perms(uuid) from public, anon, authenticated;

/** As update 75 ("Prideliť kuriérovi"); without the courier app no new assignment (taking one away still works). */
create or replace function public.owner_food_assign(p_shop_id uuid, p_order_id uuid, p_courier_id uuid, p_step_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  o public.food_orders;
  c public.food_couriers;
begin
  perform public.food_owner_write(p_shop_id);
  if p_step_id is not null and exists (select 1 from public.food_order_events e where e.step_id = p_step_id) then
    return public.food_order_json(p_order_id) || jsonb_build_object('duplicate', true);
  end if;
  select * into o from public.food_orders where id = p_order_id and shop_id = p_shop_id for update;
  if o.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if o.kind <> 'delivery' or o.status not in ('new', 'preparing', 'on_the_way') then raise exception 'step' using errcode = 'P0001'; end if;
  if p_courier_id is not null then
    if not (public.food_parts(p_shop_id) ->> 'courier_app')::boolean then raise exception 'courier_app' using errcode = 'P0001'; end if;
    select * into c from public.food_couriers where id = p_courier_id and shop_id = p_shop_id and active;
    if c.id is null then raise exception 'courier' using errcode = '22023'; end if;
  end if;
  if o.courier_id is not distinct from p_courier_id then
    return public.food_order_json(o.id) || jsonb_build_object('duplicate', false);
  end if;
  update public.food_orders set courier_id = p_courier_id, updated_at = now() where id = o.id;
  insert into public.food_order_events (order_id, shop_id, step_id, actor, actor_id, kind, from_status, to_status, detail)
  values (o.id, o.shop_id, p_step_id, 'owner', auth.uid(), 'assigned', o.status, o.status, left(c.name, 60));
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'food_order_assigned',
          jsonb_build_object('order', o.id, 'number', o.number, 'courier', p_courier_id));
  return public.food_order_json(o.id) || jsonb_build_object('duplicate', false);
end;
$$;
revoke execute on function public.owner_food_assign(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.owner_food_assign(uuid, uuid, uuid, uuid) to authenticated;

/** As update 75 ("Voľný kuriér automaticky"), and only while the courier app is on. */
create or replace function public.food_orders_auto_assign()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_courier public.food_couriers;
begin
  if new.kind <> 'delivery'
     or coalesce((select assign_mode from public.food_settings where shop_id = new.shop_id), 'manual') <> 'auto'
     or not (public.food_parts(new.shop_id) ->> 'courier_app')::boolean
     or exists (select 1 from public.food_orders o where o.id = new.id and (o.courier_id is not null or o.status <> 'new')) then
    return null;
  end if;
  select c.* into v_courier
  from public.food_couriers c
  where c.shop_id = new.shop_id and c.active
    and exists (select 1 from public.food_courier_sessions s where s.courier_id = c.id and s.ended_at is null
                and s.expires_at > now())
  order by (select count(*) from public.food_orders o where o.courier_id = c.id and o.status in ('new', 'preparing', 'on_the_way')),
           (select max(e.created_at) from public.food_order_events e
            join public.food_orders o on o.id = e.order_id
            where o.courier_id = c.id and e.kind = 'assigned') nulls first,
           c.name
  limit 1;
  if v_courier.id is null then return null; end if;
  update public.food_orders set courier_id = v_courier.id where id = new.id;
  insert into public.food_order_events (order_id, shop_id, actor, kind, from_status, to_status, detail)
  values (new.id, new.shop_id, 'system', 'assigned', new.status, new.status, left(v_courier.name, 60));
  return null;
end;
$$;
revoke execute on function public.food_orders_auto_assign() from public, anon, authenticated;

-- ------------------------------------------------------------------ 4. the feed's two actions: finish and reopen

/** Where "Vybavené" takes an order: pickup → picked_up; delivery → delivered, or on_the_way with the courier app. */
create or replace function public.food_finish_target(p_kind text, p_courier_app boolean)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_kind = 'pickup' then 'picked_up' when coalesce(p_courier_app, false) then 'on_the_way' else 'delivered' end
$$;
revoke execute on function public.food_finish_target(text, boolean) from public, anon, authenticated;
grant execute on function public.food_finish_target(text, boolean) to service_role;

/**
 * "Vybavené" (a swipe, the button, the MCP): ONE transaction that skips the steps in between — pickup → picked_up,
 * delivery → delivered (or → on_the_way with the courier app; a courier must be assigned). With "Platby v Cacaduu"
 * picked up / delivered need a payment mark: given here (the methods that are on; cash: what the customer gave, at
 * least the total) or already there; without it no mark is taken. The stock as every finish (Pokladňa + Sklad), once.
 * The step's UUID once (a retry is the same step). Refusals (raised): not_found, step, courier, not_paid,
 * already_paid, pay_method, cash, conflict. Service role only (owner_food_order_finish, the owner MCP).
 */
create or replace function public.food_order_finish(
  p_order_id uuid, p_step_id uuid, p_actor text, p_actor_id uuid,
  p_pay_method text default null, p_cash_given_cents integer default null
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
  v_to text;
begin
  if p_step_id is null then raise exception 'step' using errcode = '22023'; end if;
  if exists (select 1 from public.food_order_events e where e.step_id = p_step_id) then
    if not exists (select 1 from public.food_order_events e where e.step_id = p_step_id and e.order_id = p_order_id) then
      raise exception 'conflict' using errcode = '23505';
    end if;
    return public.food_order_json(p_order_id) || jsonb_build_object('duplicate', true);
  end if;
  select * into o from public.food_orders where id = p_order_id for update;
  if o.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  select * into v from public.food_settings where shop_id = o.shop_id;
  v_to := public.food_finish_target(o.kind, (public.food_parts(o.shop_id) ->> 'courier_app')::boolean);
  if o.status not in ('new', 'preparing', 'ready', 'on_the_way') or o.status = v_to then
    raise exception 'step' using errcode = 'P0001';
  end if;
  if v_to = 'on_the_way' and o.courier_id is null then raise exception 'courier' using errcode = 'P0001'; end if;

  -- the payment mark first (food_order_step's own rules), or the one already there
  if p_pay_method is not null then
    perform public.food_order_step(o.id, null, p_actor, p_actor_id, null, p_pay_method, p_cash_given_cents, null);
    select * into o from public.food_orders where id = p_order_id;
  elsif v_to <> 'on_the_way' and o.paid_at is null and coalesce(v.payments_on, true) then
    raise exception 'not_paid' using errcode = 'P0001';
  end if;

  insert into public.food_order_events (order_id, shop_id, step_id, actor, actor_id, kind, from_status, to_status, detail)
  values (o.id, o.shop_id, p_step_id, p_actor, p_actor_id, 'status', o.status, v_to, 'finish');
  update public.food_orders
  set status = v_to, updated_at = now(),
      delivered_at = case when v_to in ('delivered', 'picked_up') then now() else delivered_at end
  where id = o.id;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (o.shop_id, case when p_actor = 'owner' then p_actor_id end, 'food_order_finished',
          jsonb_build_object('order', o.id, 'number', o.number, 'from', o.status, 'to', v_to, 'by', p_actor));
  if v_to in ('delivered', 'picked_up') then perform public.food_take_stock(o.id); end if;
  return public.food_order_json(o.id) || jsonb_build_object('duplicate', false, 'finished', v_to);
end;
$$;
revoke execute on function public.food_order_finish(uuid, uuid, text, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.food_order_finish(uuid, uuid, text, uuid, text, integer) to service_role;

/**
 * "Vrátiť" / "Späť": a picked up, delivered or on-the-way order back to the state before it (the last status step's
 * own "from"), only on the shop's same day. Stock it took comes back as one opposite Oprava per line and extra
 * ("Vrátené – objednávka č. n"; ids md5('back:' sale movement id) — once), and the order's reopen count moves on, so a
 * later finish takes the stock again, once. The payment mark stays. The step's UUID once. Refusals (raised):
 * not_found, step, too_late, conflict. Service role only (owner_food_order_reopen, the owner MCP).
 */
create or replace function public.food_order_reopen(p_order_id uuid, p_step_id uuid, p_actor text, p_actor_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  o public.food_orders;
  v_tz text;
  v_at timestamptz;
  v_back text;
  v_ids uuid[];
  v_returned boolean := false;
begin
  if p_step_id is null then raise exception 'step' using errcode = '22023'; end if;
  if exists (select 1 from public.food_order_events e where e.step_id = p_step_id) then
    if not exists (select 1 from public.food_order_events e where e.step_id = p_step_id and e.order_id = p_order_id) then
      raise exception 'conflict' using errcode = '23505';
    end if;
    return public.food_order_json(p_order_id) || jsonb_build_object('duplicate', true);
  end if;
  select * into o from public.food_orders where id = p_order_id for update;
  if o.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if o.status not in ('picked_up', 'delivered', 'on_the_way') then raise exception 'step' using errcode = 'P0001'; end if;
  v_tz := coalesce((select timezone from public.shops where id = o.shop_id), 'UTC');
  select e.created_at, e.from_status into v_at, v_back
  from public.food_order_events e
  where e.order_id = o.id and e.kind = 'status' and e.to_status = o.status
  order by e.id desc limit 1;
  v_at := coalesce(v_at, o.delivered_at, o.updated_at);
  if (v_at at time zone v_tz)::date <> (now() at time zone v_tz)::date then raise exception 'too_late' using errcode = 'P0001'; end if;
  if v_back is null or v_back not in ('new', 'preparing', 'ready', 'on_the_way') or v_back = o.status then
    v_back := 'new';
  end if;

  -- the stock it took comes back (the sale movements of this round, each once)
  if o.stock_taken_at is not null then
    select array_agg(distinct m.shop_item_id order by m.shop_item_id) into v_ids
    from public.sklad_movements m
    where m.id in (select r.id from public.food_stock_rows(o.id, o.shop_id) r) and m.kind = 'sale';
    perform pg_advisory_xact_lock(hashtextextended('sklad:' || x::text, 0)) from unnest(coalesce(v_ids, '{}')) x order by x;
    insert into public.sklad_movements (id, shop_id, shop_item_id, location_id, kind, qty, reason, ref, device_label, created_by, client_at)
    select md5('back:' || m.id::text)::uuid, m.shop_id, m.shop_item_id, m.location_id, 'correction', -m.qty,
           left('Vrátené – objednávka č. ' || o.number, 200), m.ref, 'Objednávky jedla', auth.uid(), now()
    from public.sklad_movements m
    where m.id in (select r.id from public.food_stock_rows(o.id, o.shop_id) r) and m.kind = 'sale'
    on conflict (id) do nothing;
    if v_ids is not null then perform public.sklad_apply(o.shop_id, v_ids); end if;
    v_returned := true;
  end if;

  insert into public.food_order_events (order_id, shop_id, step_id, actor, actor_id, kind, from_status, to_status, detail)
  values (o.id, o.shop_id, p_step_id, p_actor, p_actor_id, 'status', o.status, v_back, 'reopen');
  update public.food_orders
  set status = v_back, updated_at = now(), delivered_at = null, stock_taken_at = null, reopens = reopens + 1
  where id = o.id;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (o.shop_id, case when p_actor = 'owner' then p_actor_id end, 'food_order_reopened',
          jsonb_build_object('order', o.id, 'number', o.number, 'from', o.status, 'to', v_back, 'by', p_actor,
                             'stock_returned', v_returned));
  return public.food_order_json(o.id) || jsonb_build_object('duplicate', false, 'reopened', v_back, 'stock_returned', v_returned);
end;
$$;
revoke execute on function public.food_order_reopen(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.food_order_reopen(uuid, uuid, text, uuid) to service_role;

/** "Vybavené" by the owner (members + the plan): food_order_finish. */
create or replace function public.owner_food_order_finish(p_shop_id uuid, p_order_id uuid, p_step_id uuid,
                                                          p_pay_method text default null, p_cash_given_cents integer default null)
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
  return public.food_order_finish(p_order_id, p_step_id, 'owner', auth.uid(), p_pay_method, p_cash_given_cents);
end;
$$;
revoke execute on function public.owner_food_order_finish(uuid, uuid, uuid, text, integer) from public, anon;
grant execute on function public.owner_food_order_finish(uuid, uuid, uuid, text, integer) to authenticated;

/** "Vrátiť" / "Späť" by the owner (members + the plan): food_order_reopen. */
create or replace function public.owner_food_order_reopen(p_shop_id uuid, p_order_id uuid, p_step_id uuid)
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
  return public.food_order_reopen(p_order_id, p_step_id, 'owner', auth.uid());
end;
$$;
revoke execute on function public.owner_food_order_reopen(uuid, uuid, uuid) from public, anon;
grant execute on function public.owner_food_order_reopen(uuid, uuid, uuid) to authenticated;

-- ------------------------------------------------------------------ 5. the delay: the bar above the feed, the reset

/** "Meškanie" above the feed (and the MCP / Telegram): 0–120 minutes, at once; activity food_delay. */
create or replace function public.owner_food_set_delay(p_shop_id uuid, p_minutes integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old integer;
begin
  perform public.food_owner_write(p_shop_id);
  if p_minutes is null or p_minutes not between 0 and 120 then raise exception 'delay' using errcode = '22023'; end if;
  perform public.food_setup(p_shop_id);
  select delay_minutes into v_old from public.food_settings where shop_id = p_shop_id for update;
  update public.food_settings set delay_minutes = p_minutes, delay_set_at = now(), updated_at = now() where shop_id = p_shop_id;
  if v_old is distinct from p_minutes then
    insert into public.shop_activity (shop_id, actor, action, details)
    values (p_shop_id, auth.uid(), 'food_delay', jsonb_build_object('from', v_old, 'to', p_minutes));
  end if;
  return public.food_times(p_shop_id) || jsonb_build_object('state', public.food_open_state(p_shop_id));
end;
$$;
revoke execute on function public.owner_food_set_delay(uuid, integer) from public, anon;
grant execute on function public.owner_food_set_delay(uuid, integer) to authenticated;

/**
 * When a shop's delay goes back to 0: midnight = the shop's next midnight after it was set; close = the end of the
 * open range it was set in, else of the next one that day or the next (no hours → midnight); never = null.
 */
create or replace function public.food_delay_due(p_shop_id uuid)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.food_settings;
  v_tz text := coalesce((select timezone from public.shops where id = p_shop_id), 'UTC');
  v_day date;
  v_midnight timestamptz;
  v_end timestamptz;
begin
  select * into v from public.food_settings where shop_id = p_shop_id;
  if v.shop_id is null or v.delay_minutes = 0 or v.delay_reset = 'never' then return null; end if;
  v_day := (coalesce(v.delay_set_at, v.updated_at) at time zone v_tz)::date;
  v_midnight := (v_day + 1)::timestamp at time zone v_tz;
  if v.delay_reset = 'midnight' then return v_midnight; end if;
  select min(r.range_end) into v_end
  from (select * from public.booking_day_ranges(p_shop_id, v_day)
        union all
        select * from public.booking_day_ranges(p_shop_id, v_day + 1)) r
  where r.range_end > coalesce(v.delay_set_at, v.updated_at);
  return coalesce(v_end, v_midnight);
end;
$$;
revoke execute on function public.food_delay_due(uuid) from public, anon, authenticated;
grant execute on function public.food_delay_due(uuid) to service_role;

/** The 5-minute job (SQL only): every delay that is due goes back to 0 (activity food_delay, by 'reset'). */
create or replace function public.food_delay_tick()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r record;
  n integer := 0;
begin
  for r in select s.shop_id, s.delay_minutes from public.food_settings s
           where s.delay_minutes > 0 and s.delay_reset <> 'never'
           for update skip locked loop
    if public.food_delay_due(r.shop_id) <= now() then
      update public.food_settings set delay_minutes = 0, delay_set_at = now(), updated_at = now() where shop_id = r.shop_id;
      insert into public.shop_activity (shop_id, actor, action, details)
      values (r.shop_id, null, 'food_delay', jsonb_build_object('from', r.delay_minutes, 'to', 0, 'by', 'reset'));
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;
revoke execute on function public.food_delay_tick() from public, anon, authenticated;
grant execute on function public.food_delay_tick() to service_role;

do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'cron' and p.proname = 'schedule') then
    raise notice 'pg_cron is not on: switch on pg_cron (Database → Extensions), then run this file again.';
    return;
  end if;
  perform cron.schedule('ppi-food-delay-reset', '*/5 * * * *', 'select public.food_delay_tick()');
end;
$$;

-- ------------------------------------------------------------------ 6. the owner's settings and the feed

/** As update 73 ("Nastavenia objednávok"), and the parts switched on, the times and the shop's couriers. */
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
    'parts', public.food_parts(p_shop_id),
    'times', public.food_times(p_shop_id),
    'delay_resets_at', public.food_delay_due(p_shop_id),
    'couriers', (select count(*) from public.food_couriers c where c.shop_id = p_shop_id and c.active),
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

/**
 * As update 75 ("Uložiť": only the fields given change; at least one payment method stays on), and "Čo používate"
 * (courier_app, payments_on, register = deduct_on_delivery, qr_terminal), "Časy pre asistenta" (delay_minutes,
 * delay_reset, warn_long_delay) and "Feed" (feed_order).
 */
create or replace function public.owner_food_save_settings(p_shop_id uuid, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.food_settings;
  v_old integer;
  b text;
  n text;
begin
  perform public.food_owner_write(p_shop_id);
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'bad_request' using errcode = '22023'; end if;
  v := public.food_setup(p_shop_id);
  v_old := v.delay_minutes;
  foreach b in array array['enabled', 'pickup_on', 'delivery_on', 'pay_qr', 'pay_cash', 'pay_card', 'deduct_on_delivery',
                           'alert_sound', 'alert_email', 'alert_telegram', 'sms_on_the_way', 'courier_can_qr',
                           'courier_can_cash', 'courier_has_card', 'courier_app', 'payments_on', 'qr_terminal',
                           'warn_long_delay'] loop
    if p ? b and jsonb_typeof(p -> b) <> 'boolean' then raise exception '%', b using errcode = '22023'; end if;
  end loop;
  foreach n in array array['prep_minutes', 'delivery_minutes', 'last_order_minutes', 'delay_minutes'] loop
    if p ? n and (jsonb_typeof(p -> n) <> 'number' or (p ->> n)::numeric <> floor((p ->> n)::numeric)) then
      raise exception '%', n using errcode = '22023';
    end if;
  end loop;
  if p ? 'assign_mode' and coalesce(p ->> 'assign_mode', '') not in ('manual', 'auto') then
    raise exception 'assign_mode' using errcode = '22023';
  end if;
  if p ? 'delay_reset' and coalesce(p ->> 'delay_reset', '') not in ('close', 'midnight', 'never') then
    raise exception 'delay_reset' using errcode = '22023';
  end if;
  if p ? 'feed_order' and coalesce(p ->> 'feed_order', '') not in ('newest', 'oldest') then
    raise exception 'feed_order' using errcode = '22023';
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
      courier_can_qr = coalesce((p ->> 'courier_can_qr')::boolean, courier_can_qr),
      courier_can_cash = coalesce((p ->> 'courier_can_cash')::boolean, courier_can_cash),
      courier_has_card = coalesce((p ->> 'courier_has_card')::boolean, courier_has_card),
      courier_app = coalesce((p ->> 'courier_app')::boolean, courier_app),
      payments_on = coalesce((p ->> 'payments_on')::boolean, payments_on),
      qr_terminal = coalesce((p ->> 'qr_terminal')::boolean, qr_terminal),
      warn_long_delay = coalesce((p ->> 'warn_long_delay')::boolean, warn_long_delay),
      delay_reset = coalesce(p ->> 'delay_reset', delay_reset),
      feed_order = coalesce(p ->> 'feed_order', feed_order),
      delay_minutes = coalesce((p ->> 'delay_minutes')::integer, delay_minutes),
      delay_set_at = case when p ? 'delay_minutes' then now() else delay_set_at end,
      updated_at = now()
    where shop_id = p_shop_id
    returning * into v;
  exception when check_violation then
    raise exception 'settings' using errcode = '22023';
  end;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'food_settings_saved',
          jsonb_build_object('enabled', v.enabled, 'fields', (select coalesce(jsonb_agg(k order by k), '[]'::jsonb) from jsonb_object_keys(p) k)));
  if v_old is distinct from v.delay_minutes then
    insert into public.shop_activity (shop_id, actor, action, details)
    values (p_shop_id, auth.uid(), 'food_delay', jsonb_build_object('from', v_old, 'to', v.delay_minutes));
  end if;
  return public.owner_food_settings(p_shop_id);
end;
$$;
revoke execute on function public.owner_food_save_settings(uuid, jsonb) from public, anon;
grant execute on function public.owner_food_save_settings(uuid, jsonb) to authenticated;

/** As update 74 (whether the Objednávky tab shows, new orders), and the parts switched on (the Kuriéri tab). */
create or replace function public.owner_food_tab(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_shop_member(p_shop_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'enabled', coalesce((select enabled from public.food_settings where shop_id = p_shop_id), false),
    'new', (select count(*) from public.food_orders where shop_id = p_shop_id and status = 'new')::integer,
    'latest', (select max(created_at) from public.food_orders where shop_id = p_shop_id),
    'changed', (select max(updated_at) from public.food_orders where shop_id = p_shop_id),
    'parts', public.food_parts(p_shop_id));
end;
$$;
revoke execute on function public.owner_food_tab(uuid) from public, anon;
grant execute on function public.owner_food_tab(uuid) to authenticated;

/** When an order left the feed's active cards (finished, handed to the courier, cancelled); null while active. */
create or replace function public.food_feed_done_at(p_id uuid, p_courier_app boolean)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when o.status in ('delivered', 'picked_up') then o.delivered_at
    when o.status = 'cancelled' then o.cancelled_at
    when o.status = 'on_the_way' and p_courier_app then
      coalesce((select max(e.created_at) from public.food_order_events e
                where e.order_id = o.id and e.kind = 'status' and e.to_status = 'on_the_way'), o.updated_at)
  end
  from public.food_orders o where o.id = p_id
$$;
revoke execute on function public.food_feed_done_at(uuid, boolean) from public, anon, authenticated;
grant execute on function public.food_feed_done_at(uuid, boolean) to service_role;

/**
 * The feed (Objednávky): the active cards (every order not finished, newest or oldest first by feed_order), today's
 * finished ones (grey, the latest first; cancelled ones too), how many older ones there are (the last 7 days) and,
 * with p_older, those; plus the times, the parts switched on, the state and the settings the bar shows.
 */
create or replace function public.owner_food_feed(p_shop_id uuid, p_older boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.food_settings;
  v_tz text := coalesce((select timezone from public.shops where id = p_shop_id), 'UTC');
  v_from timestamptz;
  v_courier boolean;
  v_rows jsonb;
begin
  perform public.sklad_member(p_shop_id);
  select * into v from public.food_settings where shop_id = p_shop_id;
  v_from := ((now() at time zone v_tz)::date)::timestamp at time zone v_tz;
  v_courier := (public.food_parts(p_shop_id) ->> 'courier_app')::boolean;
  select coalesce(jsonb_agg(x.j order by x.created_at), '[]'::jsonb) into v_rows
  from (
    select public.food_order_json(o.id) - 'events' - 'iban' - 'bic' - 'payee'
           || jsonb_build_object('done_at', d.done_at, 'reopens', o.reopens,
                                 'finish_to', public.food_finish_target(o.kind, v_courier)) j,
           o.created_at
    from public.food_orders o
    cross join lateral (select public.food_feed_done_at(o.id, v_courier) done_at) d
    where o.shop_id = p_shop_id
      -- a finished order's done_at is never after its updated_at: only the recent ones need a look
      and (o.status in ('new', 'preparing', 'ready', 'on_the_way')
           or o.updated_at >= v_from - case when p_older then interval '7 days' else interval '0' end)
      and (d.done_at is null and o.status in ('new', 'preparing', 'ready', 'on_the_way')
           or d.done_at >= v_from - case when p_older then interval '7 days' else interval '0' end)
    order by o.created_at desc
    limit 600
  ) x;
  return jsonb_build_object(
    'active', coalesce((select jsonb_agg(r order by
                          case when coalesce(v.feed_order, 'newest') = 'oldest' then (r ->> 'created_at')::timestamptz end,
                          case when coalesce(v.feed_order, 'newest') = 'oldest' then (r ->> 'number')::integer end,
                          (r ->> 'created_at')::timestamptz desc, (r ->> 'number')::integer desc)
                        from jsonb_array_elements(v_rows) r where r ->> 'done_at' is null), '[]'::jsonb),
    'done', coalesce((select jsonb_agg(r order by (r ->> 'done_at')::timestamptz desc)
                      from jsonb_array_elements(v_rows) r
                      where r ->> 'done_at' is not null and (r ->> 'done_at')::timestamptz >= v_from), '[]'::jsonb),
    'older', case when p_older then
               coalesce((select jsonb_agg(r order by (r ->> 'done_at')::timestamptz desc)
                         from jsonb_array_elements(v_rows) r
                         where r ->> 'done_at' is not null and (r ->> 'done_at')::timestamptz < v_from), '[]'::jsonb) end,
    'older_count', (select count(*) from public.food_orders o
                    where o.shop_id = p_shop_id and o.status in ('delivered', 'picked_up', 'cancelled', 'on_the_way')
                      and o.updated_at >= v_from - interval '7 days'
                      and public.food_feed_done_at(o.id, v_courier) between v_from - interval '7 days' and v_from - interval '1 microsecond'),
    'today', (now() at time zone v_tz)::date,
    'timezone', v_tz,
    'times', public.food_times(p_shop_id),
    'parts', public.food_parts(p_shop_id),
    'state', public.food_open_state(p_shop_id),
    'settings', jsonb_build_object('enabled', coalesce(v.enabled, false), 'paused', coalesce(v.paused, false),
                                   'pickup_on', coalesce(v.pickup_on, true), 'delivery_on', coalesce(v.delivery_on, false),
                                   'feed_order', coalesce(v.feed_order, 'newest'), 'alert_sound', coalesce(v.alert_sound, true),
                                   'pay_qr', coalesce(v.pay_qr, true), 'pay_cash', coalesce(v.pay_cash, true),
                                   'pay_card', coalesce(v.pay_card, false),
                                   'iban_set', exists (select 1 from public.sklad_settings st where st.shop_id = p_shop_id and st.iban is not null)),
    'couriers', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.name)
                          from public.food_couriers c where c.shop_id = p_shop_id and c.active), '[]'::jsonb));
end;
$$;
revoke execute on function public.owner_food_feed(uuid, boolean) from public, anon;
grant execute on function public.owner_food_feed(uuid, boolean) to authenticated;

-- ------------------------------------------------------------------ 7. the owner MCP: the delay, finish, reopen

create or replace function public.mcp_tool_scope(p_tool text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_tool in ('list_shops', 'get_shop_details', 'get_opening_hours', 'list_conversations', 'get_conversation',
                    'list_contacts', 'get_contact', 'list_bookings', 'list_email_templates', 'search_stock',
                    'get_sms_usage', 'list_booking_services', 'find_free_slots', 'list_food_orders', 'list_menu') then 'shop.read'
    when p_tool in ('update_conversations', 'save_contact', 'delete_contact', 'set_booking_status', 'set_opening_hours',
                    'update_shop_details', 'update_stock', 'create_booking', 'move_booking', 'cancel_booking',
                    'set_food_order_status', 'set_menu_sold_out', 'set_food_delay', 'finish_food_order',
                    'reopen_food_order') then 'shop.write'
    when p_tool in ('preview_message') then 'messages.send'
  end
$$;
revoke execute on function public.mcp_tool_scope(text) from public, anon, authenticated;

-- update 80's door is kept under its own name (once); the feed's tools are answered here, every other tool there
do $$
begin
  if to_regprocedure('public.owner_mcp_call_80(text, text, jsonb)') is null
     and to_regprocedure('public.owner_mcp_call(text, text, jsonb)') is not null then
    alter function public.owner_mcp_call(text, text, jsonb) rename to owner_mcp_call_80;
  end if;
end;
$$;
revoke execute on function public.owner_mcp_call_80(text, text, jsonb) from public, anon, authenticated;

create or replace function public.owner_mcp_call(p_token text, p_tool text, p_args jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  g public.owner_mcp_tokens%rowtype;
  a jsonb := coalesce(nullif(p_args, 'null'::jsonb), '{}'::jsonb);
  v_scope text;
  v_shop uuid;
  v_slug text;
  v_id uuid;
  v_min integer;
  v_pay text;
  v_cash integer;
  v_to text;
  v_out jsonb;
  v_changed boolean := false;
  o public.food_orders;
begin
  if p_tool not in ('set_food_delay', 'finish_food_order', 'reopen_food_order') then
    return public.owner_mcp_call_80(p_token, p_tool, p_args);
  end if;
  if jsonb_typeof(a) <> 'object' then raise exception 'bad_argument: arguments' using errcode = '22023'; end if;
  g := public.mcp_grant(p_token);
  v_scope := public.mcp_tool_scope(p_tool);
  if not v_scope = any (g.scopes) then raise exception 'scope: %', v_scope using errcode = '42501'; end if;
  perform public.mcp_act_as(g.user_id);

  if p_tool = 'set_food_delay' then
    v_shop := public.mcp_shop(g, a ->> 'shop');
  else
    v_id := public.mcp_uuid(a, 'order_id');
    v_shop := public.mcp_own(g, (select shop_id from public.food_orders where id = v_id));
  end if;
  select slug into v_slug from public.shops where id = v_shop;

  if p_tool = 'set_food_delay' then
    if jsonb_typeof(a -> 'minutes') <> 'number' or (a ->> 'minutes')::numeric <> floor((a ->> 'minutes')::numeric)
       or (a ->> 'minutes')::numeric not between 0 and 120 then
      raise exception 'bad_argument: minutes' using errcode = '22023';
    end if;
    v_min := (a ->> 'minutes')::integer;
    if coalesce((a ->> 'confirm')::boolean, false) then
      v_out := jsonb_build_object('changed', true, 'times', public.owner_food_set_delay(v_shop, v_min) - 'state');
      v_changed := true;
    else
      v_out := public.food_times(v_shop);
      v_out := jsonb_build_object(
        'changed', false,
        'needs_confirm', 'Show the owner before → after and call again with confirm: true after they agree.',
        'before', jsonb_build_object('delay_minutes', (v_out ->> 'delay_minutes')::integer,
                                     'pickup_in_min', (v_out ->> 'ready_pickup_min')::integer,
                                     'delivery_in_min', (v_out ->> 'ready_delivery_min')::integer),
        'after', jsonb_build_object('delay_minutes', v_min,
                                    'pickup_in_min', (v_out ->> 'prep_minutes')::integer + v_min,
                                    'delivery_in_min', (v_out ->> 'delivery_minutes')::integer + v_min,
                                    'resets', v_out ->> 'delay_reset'));
    end if;

  elsif p_tool = 'finish_food_order' then
    v_pay := nullif(a ->> 'paid_with', '');
    if v_pay is not null and v_pay not in ('qr', 'cash', 'card') then raise exception 'bad_argument: paid_with' using errcode = '22023'; end if;
    if jsonb_typeof(a -> 'cash_given') = 'number' then v_cash := round((a ->> 'cash_given')::numeric * 100)::integer; end if;
    select * into o from public.food_orders where id = v_id;
    v_to := public.food_finish_target(o.kind, (public.food_parts(v_shop) ->> 'courier_app')::boolean);
    if coalesce((a ->> 'confirm')::boolean, false) then
      perform public.owner_food_order_finish(v_shop, v_id, coalesce(nullif(a ->> 'step_id', '')::uuid, gen_random_uuid()), v_pay, v_cash);
      v_out := jsonb_build_object('changed', true, 'order', public.mcp_food_order_json(v_id));
      v_changed := true;
    else
      v_out := jsonb_build_object(
        'changed', false,
        'needs_confirm', 'Show the owner before → after and call again with confirm: true after they agree.',
        'before', public.mcp_food_order_json(v_id),
        'after', jsonb_build_object('status', v_to, 'paid_with', coalesce(v_pay, o.pay_method)),
        'allowed', o.status in ('new', 'preparing', 'ready', 'on_the_way') and o.status <> v_to
                   and (v_to <> 'on_the_way' or o.courier_id is not null),
        'needs_payment_first', v_to <> 'on_the_way' and o.paid_at is null and v_pay is null
                               and coalesce((public.food_parts(v_shop) ->> 'payments')::boolean, true));
    end if;

  else
    select * into o from public.food_orders where id = v_id;
    if coalesce((a ->> 'confirm')::boolean, false) then
      perform public.owner_food_order_reopen(v_shop, v_id, coalesce(nullif(a ->> 'step_id', '')::uuid, gen_random_uuid()));
      v_out := jsonb_build_object('changed', true, 'order', public.mcp_food_order_json(v_id));
      v_changed := true;
    else
      v_out := jsonb_build_object(
        'changed', false,
        'needs_confirm', 'Show the owner before → after and call again with confirm: true after they agree.',
        'before', public.mcp_food_order_json(v_id),
        'after', jsonb_build_object('status', coalesce((select e.from_status from public.food_order_events e
                                                        where e.order_id = o.id and e.kind = 'status' and e.to_status = o.status
                                                        order by e.id desc limit 1), 'new'),
                                    'stock_returned', o.stock_taken_at is not null),
        'allowed', o.status in ('picked_up', 'delivered', 'on_the_way'));
    end if;
  end if;

  return jsonb_build_object('shop', v_slug, 'result', coalesce(v_out, 'null'::jsonb), 'changed', v_changed);
end;
$$;
revoke execute on function public.owner_mcp_call(text, text, jsonb) from public;
grant execute on function public.owner_mcp_call(text, text, jsonb) to anon, authenticated, service_role;
