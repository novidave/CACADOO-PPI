-- Update 85 (2026-11-05, at the owner's request): the order panel of the shop assistant.
--   * The customer never chooses how to pay: every order is created with pay_method null, whatever "Platby v
--     Cacaduu" says. With Platby on, the owner (the feed's payment dialog, the order's page) or the courier still marks
--     how it was paid at the handover; food_order_step / food_order_finish keep requiring that mark before picked up
--     / delivered (unchanged).
--   * "Poznámka k platbe po objednaní" (food_settings.pay_note, ≤ 120, plain text): the one line under the time in the
--     "Objednané" box. null = the default line of the page language, '-' = no line, else the owner's text — translated
--     like the assistant's texts (kind food_pay_note: a preset of every translation run, kept in the shop's own
--     language too). Only the customer sees it (not in the owner's e-mail).
--   * A code SMS whose provider result is "failed" (a 401, no credits) no longer counts toward the per-number (3 an
--     hour) and per-caller (10 an hour) limits of sms_codes; queued, sent and test ones do. When the limit is reached
--     and the number's last attempt failed at the provider, the refusal is sms_failed instead of too_many. The shop's
--     monthly SMS quota already skipped failed ones (unchanged).
--
-- Nothing is deleted; no grant or policy changes. One check constraint (content_translations' kinds) is replaced by
-- the same list plus food_pay_note.

-- ------------------------------------------------------------------ 1. orders without a customer pay method

/**
 * As update 81 (the code + the order in one transaction, the same UUID again = the same order, ready_by with the delay
 * of this moment), and the order has no pay method, whatever was sent (p_pay_method is ignored; kept in the signature
 * for the website and the bookings function that send it).
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
  v := public.food_setup(v_shop.id);
  -- update 85: the customer never chooses how to pay; the owner or the courier marks it at the handover
  -- the price rule before the code is spent (a refusal leaves the code to try again with another cart)
  v_quote := public.food_quote(v_shop.slug, p_lines, p_kind, v_address, p_lat, p_lng);
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

-- ------------------------------------------------------------------ 2. the payment note after ordering

alter table public.food_settings add column if not exists pay_note text;
alter table public.food_settings drop constraint if exists food_settings_pay_note_check;
alter table public.food_settings add constraint food_settings_pay_note_check
  check (pay_note is null or char_length(pay_note) between 1 and 120);

/** As update 81, and the payment note (pay_note: null = the default line, '-' = none, else the owner's text). */
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
    'pay_note', v.pay_note,
    'phone', v_shop.phone);
end;
$$;
revoke execute on function public.food_state(text) from public;
grant execute on function public.food_state(text) to anon, authenticated, service_role;

/**
 * As update 81 (only the fields given change), and "Poznámka k platbe po objednaní" (pay_note: a string or null;
 * plain_text, ≤ 120; empty = null = the default line; "-" = no line).
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
  v_note text;
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
  if p ? 'pay_note' and jsonb_typeof(p -> 'pay_note') not in ('string', 'null') then
    raise exception 'pay_note' using errcode = '22023';
  end if;
  v_note := case when btrim(coalesce(p ->> 'pay_note', '')) = '-' then '-' else public.plain_text(p ->> 'pay_note', 120) end;
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
      pay_note = case when p ? 'pay_note' then v_note else pay_note end,
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

-- ------------------------------------------------------------------ 3. failed code SMS do not count

-- The message log row of a code's SMS (set when the SMS is claimed): its status decides whether the code counts.
alter table public.sms_codes add column if not exists message_id uuid;

/**
 * How many codes of the last hour count for the limits: of a number (p_phone_hash) or of a caller (p_caller_hash).
 * A code whose SMS failed at the provider does not count; a code without a message (an unknown courier's number, a
 * code from before update 85) counts as before.
 */
create or replace function public.sms_codes_counted(p_phone_hash text, p_caller_hash text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.sms_codes s
  left join public.shop_outgoing_messages m on m.id = s.message_id
  where s.created_at > now() - interval '1 hour'
    and (p_phone_hash is null or s.phone_hash = p_phone_hash)
    and (p_caller_hash is null or s.caller_hash = p_caller_hash)
    and (p_phone_hash is not null or p_caller_hash is not null)
    and m.status is distinct from 'failed'
$$;
revoke execute on function public.sms_codes_counted(text, text) from public, anon, authenticated;
grant execute on function public.sms_codes_counted(text, text) to service_role;

/** Whether the number's latest code of the last hour failed at the provider. */
create or replace function public.sms_code_last_failed(p_phone_hash text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select m.status = 'failed'
    from public.sms_codes s
    left join public.shop_outgoing_messages m on m.id = s.message_id
    where s.phone_hash = p_phone_hash and s.created_at > now() - interval '1 hour'
    order by s.created_at desc
    limit 1), false)
$$;
revoke execute on function public.sms_code_last_failed(text) from public, anon, authenticated;
grant execute on function public.sms_code_last_failed(text) to service_role;

/**
 * As update 73 (purposes contact, booking, delete_all, order), and the limits count only codes whose SMS did not fail
 * at the provider; refused sms_failed (not too_many) when the number's last attempt failed. Refusals (raised):
 * not_available, purpose, phone, name, conversation, too_many, sms_failed, sms_quota. Service role only.
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
  if public.sms_codes_counted(v_hash, null) >= 3 or public.sms_codes_counted(null, p_caller_hash) >= 10 then
    -- the last attempt failed at the provider: say so, not "too many"
    raise exception '%', case when public.sms_code_last_failed(v_hash) then 'sms_failed' else 'too_many' end using errcode = '54000';
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

/** As update 73, and the code keeps its message's id (its status decides whether the code counts). */
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
  update public.sms_codes set message_id = v_id where id = p_code_id;
  return v_id;
end;
$$;
revoke execute on function public.sms_code_claim(uuid, text) from public, anon, authenticated;
grant execute on function public.sms_code_claim(uuid, text) to service_role;

/**
 * As update 75 (an unknown number gets the same answer and no SMS), and the limits count only codes whose SMS did not
 * fail at the provider (sms_failed as above). Service role only.
 */
create or replace function public.food_courier_code_start(p_slug text, p_phone text, p_caller_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop public.shops;
  v_phone text;
  v_hash text;
  c public.food_couriers;
  v_code text := public.booking_new_code();
  v_id uuid := gen_random_uuid();
begin
  select * into v_shop from public.shops where slug = p_slug and is_active;
  if not found or not public.shop_has_plan(v_shop.id) then raise exception 'not_available' using errcode = 'P0001'; end if;
  v_phone := public.crm_phone(p_phone, v_shop.country);
  if v_phone is null then raise exception 'phone' using errcode = '22023'; end if;
  if p_caller_hash is null or length(p_caller_hash) < 16 then raise exception 'Invalid caller hash' using errcode = '22023'; end if;
  v_hash := public.booking_hash(v_phone);
  perform pg_advisory_xact_lock(hashtextextended('ppi-sms-code:' || v_hash, 0));
  if public.sms_codes_counted(v_hash, null) >= 3 or public.sms_codes_counted(null, p_caller_hash) >= 10 then
    -- the last attempt failed at the provider: say so, not "too many"
    raise exception '%', case when public.sms_code_last_failed(v_hash) then 'sms_failed' else 'too_many' end using errcode = '54000';
  end if;
  if public.sms_quota_left(v_shop.id, 'owner') < 1 then raise exception 'sms_quota' using errcode = '54000'; end if;
  select * into c from public.food_couriers where shop_id = v_shop.id and phone = v_phone and active;
  if c.id is null then
    -- the same answer for an unknown number: a row that counts for the limits but can never be right
    insert into public.sms_codes (id, shop_id, purpose, phone_hash, caller_hash, expires_at)
    values (v_id, v_shop.id, 'courier', v_hash, p_caller_hash, now() + interval '10 minutes');
    return jsonb_build_object('id', v_id, 'send', false, 'phone', v_phone, 'shop_name', v_shop.name,
                              'expires_at', now() + interval '10 minutes');
  end if;
  insert into public.sms_codes (id, shop_id, purpose, phone_hash, phone, name, code_hash, caller_hash, expires_at)
  values (v_id, v_shop.id, 'courier', v_hash, v_phone, left(c.name, 80), public.booking_hash(v_id::text || ':' || v_code),
          p_caller_hash, now() + interval '10 minutes');
  return jsonb_build_object('id', v_id, 'send', true, 'code', v_code, 'phone', v_phone, 'shop_name', v_shop.name,
                            'expires_at', now() + interval '10 minutes');
end;
$$;
revoke execute on function public.food_courier_code_start(text, text, text) from public, anon, authenticated;
grant execute on function public.food_courier_code_start(text, text, text) to service_role;

/** As update 75, and the code keeps its message's id. */
create or replace function public.food_courier_code_claim(p_code_id uuid, p_body text)
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
  select * into v from public.sms_codes where id = p_code_id and purpose = 'courier';
  if not found or v.phone is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform public.sms_quota_take(v.shop_id, 'owner', v_parts);
  insert into public.shop_outgoing_messages (shop_id, contact_id, channel, recipient, body, status, kind, parts)
  values (v.shop_id, null, 'sms', v.phone, regexp_replace(left(p_body, 480), '\d{6}', '••••••', 'g'), 'queued',
          'phone_code', v_parts)
  returning id into v_id;
  update public.sms_codes set message_id = v_id where id = p_code_id;
  return v_id;
end;
$$;
revoke execute on function public.food_courier_code_claim(uuid, text) from public, anon, authenticated;
grant execute on function public.food_courier_code_claim(uuid, text) to service_role;

-- ------------------------------------------------------------------ 4. the payment note in every language

alter table public.content_translations drop constraint if exists content_translations_kind_check;
alter table public.content_translations add constraint content_translations_kind_check
  check (kind in ('item_name', 'item_description', 'item_category', 'assistant_label', 'assistant_welcome', 'special_note',
                  'content_title', 'section_title', 'section_alt', 'blog_title', 'blog_body', 'food_pay_note'));

-- The texts translated in every pre-translated language and in the shop's own language (update 46 + the payment note).
create or replace function public.preset_translation_kind(p_kind text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_kind in ('assistant_label', 'assistant_welcome', 'food_pay_note')
$$;
grant execute on function public.preset_translation_kind(text) to anon, authenticated, service_role;

-- As update 40, and the payment note after ordering (food_pay_note, ref = the shop's id) while the owner wrote one.
create or replace function public.translation_sources(p_shop_id uuid)
returns table (kind text, ref text, source text)
language sql
stable
security definer
set search_path = ''
as $$
  select 'item_name', si.id::text, si.name from public.shop_items si where si.shop_id = p_shop_id
  union all
  select 'item_description', si.id::text, d.text
  from public.shop_items si cross join lateral public.item_description_shown(si.id) d where si.shop_id = p_shop_id
  union all
  select 'item_category', si.id::text, si.category from public.shop_items si
  where si.shop_id = p_shop_id and nullif(btrim(si.category), '') is not null
  union all
  select 'assistant_label', s.id::text, s.assistant_label from public.shops s where s.id = p_shop_id and s.assistant_label is not null
  union all
  select 'assistant_welcome', s.id::text, s.assistant_welcome from public.shops s where s.id = p_shop_id and s.assistant_welcome is not null
  union all
  select 'food_pay_note', fs.shop_id::text, fs.pay_note from public.food_settings fs
  where fs.shop_id = p_shop_id and fs.pay_note is not null and fs.pay_note <> '-'
  union all
  select 'special_note', h.date::text, h.note from public.shop_special_hours h
  where h.shop_id = p_shop_id and nullif(btrim(h.note), '') is not null and h.date >= current_date - 1
  union all
  select 'content_title', c.shop_id::text, c.title from public.shop_page_content c where c.shop_id = p_shop_id and c.title is not null
  union all
  select 'section_title', ps.id::text, ps.title from public.shop_page_sections ps
  where ps.shop_id = p_shop_id and public.section_visible(ps.id)
  union all
  select 'section_alt', ps.id::text, coalesce(nullif(btrim(ps.alt), ''), nullif(btrim(ps.alt_ai), '')) from public.shop_page_sections ps
  where ps.shop_id = p_shop_id and public.section_visible(ps.id) and coalesce(nullif(btrim(ps.alt), ''), nullif(btrim(ps.alt_ai), '')) is not null
  union all
  select 'blog_title', p.id::text, p.title from public.blog_visible_posts(p_shop_id) p
  union all
  select 'blog_body', p.id::text, p.body from public.blog_visible_posts(p_shop_id) p where nullif(btrim(p.body), '') is not null
$$;
revoke execute on function public.translation_sources(uuid) from public, anon, authenticated;
grant execute on function public.translation_sources(uuid) to service_role;

-- The groups of the "Čo" filter: the payment note sits with the assistant's texts.
create or replace function public.page_text_group(p_kind text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_kind in ('assistant_label', 'assistant_welcome', 'food_pay_note') then 'assistant'
    when p_kind = 'special_note' then 'hours'
    when p_kind in ('content_title', 'section_title', 'section_alt') then 'content'
    when p_kind in ('blog_title', 'blog_body') then 'blog'
  end
$$;
grant execute on function public.page_text_group(text) to authenticated, service_role;

