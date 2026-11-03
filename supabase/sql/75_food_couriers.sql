-- =====================================================================================================================
-- Update 75 — "Objednávky jedla" phase F4: couriers (Prompt 15, 2026-11-03, the owner's OK for the SMS-code login)
--
-- The shop's own couriers deliver the food orders. Every rule lives here; the courier app and the owner's Kuriéri tab
-- only call these functions:
--   * food_couriers (≤ 20 per shop): a name and a mobile number (E.164 by crm_phone, one per shop), active or not, when
--     invited, when the cash was last settled. What a courier may do is the shop's (food_settings.courier_can_qr /
--     courier_can_cash / courier_has_card, each also needing the payment method itself switched on).
--   * The courier signs in WITHOUT a Cacaduu account: the invite SMS ("Pozvať SMS", the owner's monthly SMS quota) only
--     carries the address of the shop's courier login; there the courier types the number and gets a 6-digit code — a
--     sms_codes row of the new purpose 'courier' (update 63's limits: hash only, 10 minutes, 5 tries, 3 per number and
--     10 per caller an hour; the owner quota). An unknown number gets the same answer and a code that can never be
--     right (nothing is sent), so nobody can find out who the couriers are.
--   * The right code gives the phone a key (ckr_ + 64 hex) for 30 days, kept by the website in a signed HttpOnly cookie;
--     the database keeps only its hash (food_courier_sessions). One key = one courier of one shop. "Odhlásiť",
--     "Deaktivovať" or a new phone number end every key of that courier at once.
--   * ONE door: food_courier_call(key, fn, args) — the key checked every time (not ended, not expired, the courier
--     active, the shop active with the plan), 120 calls a minute, and only the courier's OWN deliveries: name,
--     address, phone, note, items, total and the payment data for the QR. Never contacts, conversations, Sklad, sales,
--     other orders or other shops. The steps go through update 73's food_order_step() (actor 'courier'): "Na ceste",
--     the payment mark (only the methods the shop allows its couriers), "Doručené" (only after a payment mark; takes
--     the items off Sklad once), each step's own UUID once. "Problém s donáškou" is an order event the owner sees.
--   * Assignment: owner_food_assign() by hand (default), or food_settings.assign_mode 'auto' gives a new delivery to the
--     active, signed-in courier with the fewest open deliveries. Every assignment is an order event.
--   * The cash: what a courier took in cash since the owner's last "Vyúčtovať hotovosť" (owner_food_courier_settle).
--   * Also: booking_sms_settle() now settles the order codes (update 73) and the courier codes too (they stayed queued).
-- Tables: RLS, no grants (service role only). Needs updates 56–58, 61, 63, 73, 74. Safe to run twice; nothing is deleted.
-- =====================================================================================================================

-- ------------------------------------------------------------------ 0. the activity log, the code purpose, settings

do $$
declare
  v_def text := (select pg_get_constraintdef(c.oid) from pg_constraint c
                 where c.conrelid = 'public.shop_activity'::regclass and c.conname = 'shop_activity_action_check');
  v_add text := '';
  a text;
begin
  if v_def is null then return; end if;
  foreach a in array array['food_courier_saved', 'food_courier_invited', 'food_courier_login', 'food_courier_logged_out',
                           'food_courier_settled', 'food_order_assigned'] loop
    if position('''' || a || '''' in v_def) = 0 then v_add := v_add || '''' || a || '''::text, '; end if;
  end loop;
  if v_add <> '' then
    alter table public.shop_activity drop constraint shop_activity_action_check;
    execute 'alter table public.shop_activity add constraint shop_activity_action_check ' || replace(v_def, 'ARRAY[', 'ARRAY[' || v_add);
  end if;
end;
$$;

do $$
declare
  v_def text := (select pg_get_constraintdef(c.oid) from pg_constraint c
                 where c.conrelid = 'public.sms_codes'::regclass and c.conname = 'sms_codes_purpose_check');
begin
  if v_def is not null and position('''courier''' in v_def) = 0 then
    alter table public.sms_codes drop constraint sms_codes_purpose_check;
    execute 'alter table public.sms_codes add constraint sms_codes_purpose_check '
            || replace(v_def, 'ARRAY[', 'ARRAY[''courier''::text, ');
  end if;
end;
$$;

-- what the shop's couriers may do (each also needs the payment method itself on)
alter table public.food_settings add column if not exists courier_can_qr boolean not null default true;
alter table public.food_settings add column if not exists courier_can_cash boolean not null default true;
alter table public.food_settings add column if not exists courier_has_card boolean not null default false;

-- ------------------------------------------------------------------ 1. tables

create table if not exists public.food_couriers (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops (id) on delete cascade,
  name             text not null check (char_length(btrim(name)) between 1 and 60),
  phone            text not null check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  active           boolean not null default true,
  invited_at       timestamptz,
  -- "Vyúčtovať hotovosť": the cash a courier holds = cash payments they marked after this moment
  cash_settled_at  timestamptz,
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (shop_id, phone)
);
create index if not exists food_couriers_shop_idx on public.food_couriers (shop_id, created_at);

create table if not exists public.food_courier_sessions (
  id            uuid primary key default gen_random_uuid(),
  courier_id    uuid not null references public.food_couriers (id) on delete cascade,
  shop_id       uuid not null references public.shops (id) on delete cascade,
  token_hash    text not null unique,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  last_seen_at  timestamptz,
  ended_at      timestamptz
);
create index if not exists food_courier_sessions_courier_idx on public.food_courier_sessions (courier_id) where ended_at is null;

create table if not exists public.food_courier_hits (
  session_id  uuid not null references public.food_courier_sessions (id) on delete cascade,
  minute      timestamptz not null,
  n           integer not null default 0,
  primary key (session_id, minute)
);

do $$
declare t text;
begin
  foreach t in array array['food_couriers', 'food_courier_sessions', 'food_courier_hits'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

-- update 73 kept the order's courier as a plain id; now it points at a courier (a courier is never deleted, only
-- switched off, so the "set null" never runs in practice)
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.food_orders'::regclass and conname = 'food_orders_courier_fk') then
    update public.food_orders o set courier_id = null
    where o.courier_id is not null and not exists (select 1 from public.food_couriers c where c.id = o.courier_id);
    alter table public.food_orders
      add constraint food_orders_courier_fk foreign key (courier_id) references public.food_couriers (id) on delete set null;
  end if;
end;
$$;
create index if not exists food_orders_courier_idx on public.food_orders (courier_id, status) where courier_id is not null;

-- ------------------------------------------------------------------ 2. helpers

create or replace function public.food_courier_hash(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to('ppi-kur:' || coalesce(p_value, ''), 'UTF8')), 'hex')
$$;
revoke execute on function public.food_courier_hash(text) from public, anon, authenticated;

/** The payment methods the shop's couriers may mark: the method on AND allowed to couriers. */
create or replace function public.food_courier_perms(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'qr', coalesce(s.pay_qr and s.courier_can_qr, false),
    'cash', coalesce(s.pay_cash and s.courier_can_cash, false),
    'card', coalesce(s.pay_card and s.courier_has_card, false))
  from (select 1) one
  left join public.food_settings s on s.shop_id = p_shop_id
$$;
revoke execute on function public.food_courier_perms(uuid) from public, anon, authenticated;

/** The cash a courier holds: the cash payments they marked since the owner's last settlement. */
create or replace function public.food_courier_cash(p_courier_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(o.total_cents), 0)::integer
  from public.food_orders o
  join public.food_couriers c on c.id = p_courier_id
  where o.paid_by_courier = c.id and o.shop_id = c.shop_id and o.pay_method = 'cash' and o.paid_at is not null
    and o.status <> 'cancelled' and (c.cash_settled_at is null or o.paid_at > c.cash_settled_at)
$$;
revoke execute on function public.food_courier_cash(uuid) from public, anon, authenticated;

/** Every key of a courier ends now ("Odhlásiť", "Deaktivovať", a new number). */
create or replace function public.food_courier_end_sessions(p_courier_id uuid)
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with ended as (
    update public.food_courier_sessions set ended_at = now()
    where courier_id = p_courier_id and ended_at is null
    returning 1)
  select count(*)::integer from ended
$$;
revoke execute on function public.food_courier_end_sessions(uuid) from public, anon, authenticated;

/** The key, checked: format, not ended, not expired, the courier active, the shop active with the plan; 120 a minute. */
create or replace function public.food_courier_open(p_key text)
returns public.food_courier_sessions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s public.food_courier_sessions;
  v_minute timestamptz := date_trunc('minute', now());
  v_n integer;
begin
  if p_key is null or p_key !~ '^ckr_[0-9a-f]{64}$' then raise exception 'courier' using errcode = '28000'; end if;
  select * into s from public.food_courier_sessions where token_hash = public.food_courier_hash(p_key);
  if s.id is null or s.ended_at is not null then raise exception 'courier' using errcode = '28000'; end if;
  if s.expires_at <= now() then raise exception 'courier_expired' using errcode = '28000'; end if;
  if not exists (select 1 from public.food_couriers c join public.shops sh on sh.id = c.shop_id
                 where c.id = s.courier_id and c.active and sh.is_active) then
    raise exception 'courier' using errcode = '28000';
  end if;
  if not public.shop_has_plan(s.shop_id) then raise exception 'no_plan' using errcode = 'P0001'; end if;
  insert into public.food_courier_hits (session_id, minute, n) values (s.id, v_minute, 1)
  on conflict (session_id, minute) do update set n = public.food_courier_hits.n + 1
  returning n into v_n;
  if v_n > 120 then raise exception 'too_many' using errcode = '54000'; end if;
  if s.last_seen_at is null or s.last_seen_at < now() - interval '1 minute' then
    update public.food_courier_sessions set last_seen_at = now() where id = s.id;
    delete from public.food_courier_hits where session_id = s.id and minute < v_minute - interval '10 minutes';
  end if;
  return s;
end;
$$;
revoke execute on function public.food_courier_open(text) from public, anon, authenticated;

/** One delivery as the courier sees it: only what delivering needs (never the contact, conversation or events). */
create or replace function public.food_courier_order_json(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', o.id, 'number', o.number, 'status', o.status, 'kind', o.kind, 'name', o.name, 'phone', o.phone,
    'address', o.address, 'note', o.note, 'lat', o.lat, 'lng', o.lng, 'zone_name', o.zone_name, 'ready_by', o.ready_by,
    'pay_method', o.pay_method, 'paid', o.paid_at is not null, 'paid_at', o.paid_at,
    'cash_given_cents', o.cash_given_cents,
    'change_cents', case when o.cash_given_cents is not null then greatest(o.cash_given_cents - o.total_cents, 0) end,
    'subtotal_cents', o.subtotal_cents, 'delivery_cents', o.delivery_cents, 'total_cents', o.total_cents,
    'currency', o.currency, 'vs', o.vs, 'delivered_at', o.delivered_at,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('name', l.name, 'qty', l.qty, 'extras_text', l.extras_text,
                                                           'line_cents', l.line_cents) order by l.position)
                       from public.food_order_lines l where l.order_id = o.id), '[]'::jsonb),
    'items', (select coalesce(sum(l.qty), 0) from public.food_order_lines l where l.order_id = o.id),
    'problem', (select e.detail from public.food_order_events e
                where e.order_id = o.id and e.kind = 'problem'
                  and e.id > coalesce((select max(x.id) from public.food_order_events x
                                       where x.order_id = o.id and x.kind = 'status'), 0)
                order by e.id desc limit 1),
    'timezone', coalesce(sh.timezone, 'UTC'), 'shop_name', sh.name,
    'payee', coalesce(st.payee, left(sh.name, 70)), 'iban', st.iban, 'bic', st.bic)
  from public.food_orders o
  join public.shops sh on sh.id = o.shop_id
  left join public.sklad_settings st on st.shop_id = o.shop_id
  where o.id = p_id
$$;
revoke execute on function public.food_courier_order_json(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ 3. the owner's side (members; writes also the plan)

/** "Kuriéri": the couriers, what each is doing now, the cash each holds, and the shop's courier settings. */
create or replace function public.owner_food_couriers(p_shop_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_tz text := coalesce((select timezone from public.shops where id = p_shop_id), 'UTC');
  v_from timestamptz := ((now() at time zone v_tz)::date)::timestamp at time zone v_tz;
  v public.food_settings;
begin
  perform public.sklad_member(p_shop_id);
  v := public.food_setup(p_shop_id);
  return jsonb_build_object(
    'couriers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'phone', c.phone, 'active', c.active, 'invited_at', c.invited_at,
        'cash_settled_at', c.cash_settled_at, 'created_at', c.created_at,
        'signed_in', exists (select 1 from public.food_courier_sessions s where s.courier_id = c.id
                             and s.ended_at is null and s.expires_at > now()),
        'last_seen_at', (select max(s.last_seen_at) from public.food_courier_sessions s where s.courier_id = c.id),
        'open', (select count(*) from public.food_orders o where o.courier_id = c.id
                 and o.status in ('new', 'preparing', 'on_the_way')),
        'on_the_way', (select count(*) from public.food_orders o where o.courier_id = c.id and o.status = 'on_the_way'),
        'delivered_today', (select count(*) from public.food_orders o where o.courier_id = c.id and o.status = 'delivered'
                            and o.delivered_at >= v_from),
        'cash_cents', public.food_courier_cash(c.id)) order by c.active desc, c.name)
      from public.food_couriers c where c.shop_id = p_shop_id), '[]'::jsonb),
    'assign_mode', v.assign_mode,
    'courier_can_qr', v.courier_can_qr, 'courier_can_cash', v.courier_can_cash, 'courier_has_card', v.courier_has_card,
    'pay_qr', v.pay_qr, 'pay_cash', v.pay_cash, 'pay_card', v.pay_card, 'delivery_on', v.delivery_on,
    'has_plan', public.shop_has_plan(p_shop_id),
    'sms', public.sms_quota_state(p_shop_id) -> 'owner',
    'timezone', v_tz);
end;
$$;
revoke execute on function public.owner_food_couriers(uuid) from public, anon;
grant execute on function public.owner_food_couriers(uuid) to authenticated;

/**
 * "Pridať kuriéra" / "Upraviť" / "Deaktivovať": a name and a mobile number (the shop's country decides a number written
 * without the international prefix); ≤ 20 couriers per shop; one courier per number. A new number or switching a
 * courier off ends every key of that courier at once. Refusals (raised): name, phone, phone_taken, limit, not_found.
 */
create or replace function public.owner_food_courier_save(p_shop_id uuid, p_id uuid, p_name text, p_phone text,
                                                          p_active boolean default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.food_couriers;
  v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_phone text;
  v_ended integer := 0;
begin
  perform public.food_owner_write(p_shop_id);
  if char_length(v_name) not between 1 and 60 then raise exception 'name' using errcode = '22023'; end if;
  v_phone := public.crm_phone(p_phone, (select country from public.shops where id = p_shop_id));
  if v_phone is null then raise exception 'phone' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ppi-couriers:' || p_shop_id::text, 0));
  if exists (select 1 from public.food_couriers where shop_id = p_shop_id and phone = v_phone
             and id is distinct from p_id) then
    raise exception 'phone_taken' using errcode = '23505';
  end if;
  if p_id is null then
    if (select count(*) from public.food_couriers where shop_id = p_shop_id) >= 20 then
      raise exception 'limit' using errcode = '54000';
    end if;
    insert into public.food_couriers (shop_id, name, phone, active, created_by)
    values (p_shop_id, v_name, v_phone, coalesce(p_active, true), auth.uid())
    returning * into c;
  else
    select * into c from public.food_couriers where id = p_id and shop_id = p_shop_id for update;
    if c.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
    if c.phone <> v_phone or not coalesce(p_active, c.active) then
      v_ended := public.food_courier_end_sessions(c.id);
    end if;
    update public.food_couriers
    set name = v_name, phone = v_phone, active = coalesce(p_active, active), updated_at = now()
    where id = c.id
    returning * into c;
  end if;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'food_courier_saved',
          jsonb_build_object('courier', c.id, 'active', c.active, 'new', p_id is null, 'sessions_ended', v_ended));
  return jsonb_build_object('id', c.id, 'name', c.name, 'active', c.active, 'sessions_ended', v_ended);
end;
$$;
revoke execute on function public.owner_food_courier_save(uuid, uuid, text, text, boolean) from public, anon;
grant execute on function public.owner_food_courier_save(uuid, uuid, text, text, boolean) to authenticated;

/** "Odhlásiť": every key of the courier ends now (the courier signs in again with a new code). */
create or replace function public.owner_food_courier_logout(p_shop_id uuid, p_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  perform public.food_owner_write(p_shop_id);
  if not exists (select 1 from public.food_couriers where id = p_id and shop_id = p_shop_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_n := public.food_courier_end_sessions(p_id);
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'food_courier_logged_out', jsonb_build_object('courier', p_id, 'sessions_ended', v_n));
  return v_n;
end;
$$;
revoke execute on function public.owner_food_courier_logout(uuid, uuid) from public, anon;
grant execute on function public.owner_food_courier_logout(uuid, uuid) to authenticated;

/** "Vyúčtovať hotovosť": the courier handed over the cash; returns how much it was. */
create or replace function public.owner_food_courier_settle(p_shop_id uuid, p_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cash integer;
begin
  perform public.food_owner_write(p_shop_id);
  perform 1 from public.food_couriers where id = p_id and shop_id = p_shop_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  v_cash := public.food_courier_cash(p_id);
  update public.food_couriers set cash_settled_at = now(), updated_at = now() where id = p_id;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'food_courier_settled', jsonb_build_object('courier', p_id, 'cash_cents', v_cash));
  return v_cash;
end;
$$;
revoke execute on function public.owner_food_courier_settle(uuid, uuid) from public, anon;
grant execute on function public.owner_food_courier_settle(uuid, uuid) to authenticated;

/** The invite SMS's text: the shop and the address of its courier login (sk / hu / else en). */
create or replace function public.food_courier_invite_text(p_shop text, p_link text, p_lang text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case left(coalesce(p_lang, ''), 2)
    when 'sk' then left(p_shop, 40) || ': ste kuriér obchodu. Prihláste sa kódom zo SMS: ' || p_link
    when 'hu' then left(p_shop, 40) || ': Ön az üzlet futárja. Jelentkezzen be SMS-kóddal: ' || p_link
    else left(p_shop, 40) || ': you are the shop''s courier. Sign in with an SMS code: ' || p_link end
$$;
revoke execute on function public.food_courier_invite_text(text, text, text) from public, anon, authenticated;

/**
 * "Pozvať SMS": one SMS with the address of the shop's courier login (no password, no key in it), written down first
 * (kind owner, the shop's monthly owner quota — sms_quota at the limit), at most once in 2 minutes per courier.
 * p_site = the website's own address (the crm-messages function passes its SITE_URL). Returns the message for the
 * crm-messages function, which sends it and stores the result once. Refusals: not_found, inactive, too_many, site.
 */
create or replace function public.owner_food_courier_invite(p_shop_id uuid, p_id uuid, p_site text, p_lang text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.food_couriers;
  v_shop public.shops;
  v_lang text := case when left(coalesce(p_lang, ''), 2) in ('sk', 'hu', 'en') then left(p_lang, 2) else 'sk' end;
  v_body text;
  v_parts integer;
  v_id uuid;
begin
  perform public.food_owner_write(p_shop_id);
  if p_site is null or p_site !~ '^https://[a-z0-9.-]+(:[0-9]{2,5})?$' then raise exception 'site' using errcode = '22023'; end if;
  select * into c from public.food_couriers where id = p_id and shop_id = p_shop_id for update;
  if c.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not c.active then raise exception 'inactive' using errcode = 'P0001'; end if;
  if c.invited_at is not null and c.invited_at > now() - interval '2 minutes' then
    raise exception 'too_many' using errcode = '54000';
  end if;
  select * into v_shop from public.shops where id = p_shop_id;
  v_body := public.food_courier_invite_text(v_shop.name, p_site || '/' || v_lang || '/kurier/prihlasenie/' || v_shop.slug, v_lang);
  v_parts := public.crm_sms_parts(v_body);
  perform public.sms_quota_take(p_shop_id, 'owner', v_parts);
  insert into public.shop_outgoing_messages (shop_id, contact_id, channel, recipient, body, status, kind, parts, sent_by)
  values (p_shop_id, null, 'sms', c.phone, v_body, 'queued', 'owner', v_parts, auth.uid())
  returning id into v_id;
  update public.food_couriers set invited_at = now(), updated_at = now() where id = c.id;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'food_courier_invited', jsonb_build_object('courier', c.id, 'message_id', v_id));
  return jsonb_build_object('id', v_id, 'channel', 'sms', 'recipient', c.phone, 'subject', null, 'body', v_body,
                            'shop_name', v_shop.name, 'reply_to', null);
end;
$$;
revoke execute on function public.owner_food_courier_invite(uuid, uuid, text, text) from public, anon;
grant execute on function public.owner_food_courier_invite(uuid, uuid, text, text) to authenticated;

/**
 * "Prideliť kuriérovi" (or none): a delivery that is not finished, an active courier of the shop. The step's own UUID
 * once (an order event of kind 'assigned'). Refusals: not_found, step, courier.
 */
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

/**
 * "Voľný kuriér automaticky": a new delivery goes to the active, signed-in courier with the fewest open deliveries
 * (then the one assigned longest ago). It runs when the order's transaction commits, after the order's own first event.
 */
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
drop trigger if exists food_orders_auto_assign on public.food_orders;
create constraint trigger food_orders_auto_assign after insert on public.food_orders
  deferrable initially deferred
  for each row execute function public.food_orders_auto_assign();

/** As update 73, and the courier's name and the latest unresolved "Problém s donáškou" for the owner's screens. */
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
    'courier_name', (select c.name from public.food_couriers c where c.id = o.courier_id),
    'paid_by_courier', o.paid_by_courier is not null,
    'problem', (select e.detail from public.food_order_events e
                where e.order_id = o.id and e.kind = 'problem'
                  and e.id > coalesce((select max(x.id) from public.food_order_events x
                                       where x.order_id = o.id and x.kind = 'status'), 0)
                order by e.id desc limit 1),
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

/** As update 73 ("Uložiť": only the fields given change), and the couriers' three switches. */
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
                           'alert_sound', 'alert_email', 'alert_telegram', 'sms_on_the_way', 'courier_can_qr',
                           'courier_can_cash', 'courier_has_card'] loop
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
      courier_can_qr = coalesce((p ->> 'courier_can_qr')::boolean, courier_can_qr),
      courier_can_cash = coalesce((p ->> 'courier_can_cash')::boolean, courier_can_cash),
      courier_has_card = coalesce((p ->> 'courier_has_card')::boolean, courier_has_card),
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

-- ------------------------------------------------------------------ 4. the courier's login (no Cacaduu account)

/**
 * The courier types the number on the shop's courier login → a code (the bookings function sends it). A real courier
 * (active, of this shop with the plan) gets a sms_codes row of purpose 'courier' with the code; an unknown number gets
 * a row that can never be right and nothing is sent (send: false) — the answer looks the same. Rate limits as update
 * 63 (3 per number and 10 per caller an hour); the owner quota is checked for both. Refusals: not_available, phone,
 * too_many, sms_quota. Service role only.
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
  if (select count(*) from public.sms_codes where phone_hash = v_hash and created_at > now() - interval '1 hour') >= 3
     or (select count(*) from public.sms_codes where caller_hash = p_caller_hash and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'too_many' using errcode = '54000';
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

/** The courier code's SMS into the message log (kind phone_code, the code masked) and its parts of the owner quota. */
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
  return v_id;
end;
$$;
revoke execute on function public.food_courier_code_claim(uuid, text) from public, anon, authenticated;
grant execute on function public.food_courier_code_claim(uuid, text) to service_role;

/** As update 63, and it also settles the order codes (update 73) and the courier codes (they stayed queued). */
create or replace function public.booking_sms_settle(p_id uuid, p_status text, p_provider text, p_ref text, p_error text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.shop_outgoing_messages%rowtype;
begin
  if p_status not in ('sent', 'failed', 'test') then raise exception 'status' using errcode = '22023'; end if;
  update public.shop_outgoing_messages
  set status = p_status, provider = left(p_provider, 40), provider_ref = left(p_ref, 200), error = left(p_error, 500),
      sent_at = case when p_status = 'sent' then now() end
  where id = p_id and status = 'queued'
    and kind in ('booking_code', 'booking_reminder', 'sms_code', 'booking_moved', 'booking_cancelled', 'order_code', 'phone_code')
  returning * into v;
  if not found then return false; end if;
  if v.kind = 'booking_reminder' then
    update public.shop_bookings set reminder_sent_at = now() where id = v.booking_id;
  end if;
  return true;
end;
$$;
revoke execute on function public.booking_sms_settle(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.booking_sms_settle(uuid, text, text, text, text) to service_role;

/**
 * The code typed on the courier login → a key for 30 days (returned once; the database keeps its hash). A wrong code
 * counts a try (5 at most); an unknown number's code is never right. {ok: false, reason} or {ok: true, key, …}.
 * anon may call it (the website keeps the key in its signed HttpOnly cookie).
 */
create or replace function public.food_courier_login(p_code_id uuid, p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.sms_codes%rowtype;
  c public.food_couriers;
  sh public.shops;
  v_key text := public.mcp_random('ckr_');
  v_expires timestamptz := now() + interval '30 days';
begin
  select * into v from public.sms_codes where id = p_code_id and purpose = 'courier' for update;
  if not found or v.used_at is not null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if v.attempts >= 5 then return jsonb_build_object('ok', false, 'reason', 'too_many_attempts'); end if;
  if v.code_hash is null
     or public.booking_hash(v.id::text || ':' || btrim(coalesce(p_code, ''))) is distinct from v.code_hash then
    update public.sms_codes set attempts = attempts + 1 where id = p_code_id returning * into v;
    if v.attempts >= 5 then return jsonb_build_object('ok', false, 'reason', 'too_many_attempts'); end if;
    return jsonb_build_object('ok', false, 'reason', 'wrong_code', 'attempts_left', 5 - v.attempts);
  end if;
  select * into c from public.food_couriers where shop_id = v.shop_id and phone = v.phone and active;
  select * into sh from public.shops where id = v.shop_id and is_active;
  update public.sms_codes set verified_at = now(), used_at = now(), code_hash = null, phone = null, name = null
  where id = p_code_id;
  if c.id is null or sh.id is null or not public.shop_has_plan(sh.id) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  insert into public.food_courier_sessions (courier_id, shop_id, token_hash, expires_at, last_seen_at)
  values (c.id, c.shop_id, public.food_courier_hash(v_key), v_expires, now());
  insert into public.shop_activity (shop_id, action, details)
  values (c.shop_id, 'food_courier_login', jsonb_build_object('courier', c.id));
  return jsonb_build_object('ok', true, 'key', v_key, 'expires_at', v_expires, 'name', c.name,
                            'shop', jsonb_build_object('slug', sh.slug, 'name', sh.name));
end;
$$;
revoke execute on function public.food_courier_login(uuid, text) from public;
grant execute on function public.food_courier_login(uuid, text) to anon, authenticated;

/** What the courier login page shows before the code: the shop's name, and whether it takes couriers at all. */
create or replace function public.food_courier_shop(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('slug', sh.slug, 'name', sh.name,
                            'available', public.shop_has_plan(sh.id)
                                         and exists (select 1 from public.food_couriers c where c.shop_id = sh.id and c.active))
  from public.shops sh
  where sh.slug = p_slug and sh.is_active
$$;
revoke execute on function public.food_courier_shop(text) from public;
grant execute on function public.food_courier_shop(text) to anon, authenticated;

-- ------------------------------------------------------------------ 5. the courier's one door

/**
 * Every call of the courier app: the key checked (food_courier_open) and then only the courier's own deliveries.
 *   whoami                      the courier, the shop, the payment methods allowed, the cash held, today's numbers
 *   deliveries                  the open deliveries assigned to the courier (by time), today's delivered ones
 *   delivery {order_id}         one of the courier's deliveries (open, or delivered today) with the QR payment data
 *   step {order_id, step_id, to?, pay_method?, cash_given_cents?}   "Na ceste" / a payment mark / "Doručené"
 *                               (food_order_step, actor courier; only the allowed payment methods)
 *   problem {order_id, step_id, reason}   "Problém s donáškou" (an order event the owner sees)
 *   logout                      ends this key
 * Refusals: courier / courier_expired (the key), no_plan, too_many, fn, not_found, step, pay_method, not_paid, cash,
 * reason, already_paid.
 */
create or replace function public.food_courier_call(p_key text, p_fn text, p_args jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s public.food_courier_sessions := public.food_courier_open(p_key);
  c public.food_couriers;
  sh public.shops;
  v_perms jsonb;
  v_tz text;
  v_from timestamptz;
  v_order uuid;
  v_step uuid;
  v_to text;
  v_pay text;
  v_reason text;
  v_cash integer;
  ord public.food_orders;
begin
  select * into c from public.food_couriers where id = s.courier_id;
  select * into sh from public.shops where id = s.shop_id;
  v_perms := public.food_courier_perms(s.shop_id);
  v_tz := coalesce(sh.timezone, 'UTC');
  v_from := ((now() at time zone v_tz)::date)::timestamp at time zone v_tz;
  p_args := coalesce(p_args, '{}'::jsonb);

  if p_fn = 'logout' then
    update public.food_courier_sessions set ended_at = now() where id = s.id;
    return jsonb_build_object('ok', true);
  end if;

  if p_fn = 'whoami' then
    return jsonb_build_object(
      'courier', jsonb_build_object('id', c.id, 'name', c.name),
      'shop', jsonb_build_object('slug', sh.slug, 'name', sh.name, 'timezone', v_tz, 'phone', sh.phone),
      'perms', v_perms, 'expires_at', s.expires_at,
      'cash_cents', public.food_courier_cash(c.id),
      'open', (select count(*) from public.food_orders o where o.courier_id = c.id and o.status in ('new', 'preparing', 'on_the_way')),
      'delivered_today', (select count(*) from public.food_orders o where o.courier_id = c.id and o.status = 'delivered'
                          and o.delivered_at >= v_from),
      'qr_today_cents', (select coalesce(sum(o.total_cents), 0) from public.food_orders o where o.paid_by_courier = c.id
                         and o.pay_method = 'qr' and o.paid_at >= v_from and o.status <> 'cancelled'),
      'card_today_cents', (select coalesce(sum(o.total_cents), 0) from public.food_orders o where o.paid_by_courier = c.id
                           and o.pay_method = 'card' and o.paid_at >= v_from and o.status <> 'cancelled'));
  end if;

  if p_fn = 'deliveries' then
    return jsonb_build_object(
      'open', coalesce((select jsonb_agg(public.food_courier_order_json(o.id) - 'iban' - 'bic' - 'payee' - 'vs'
                                         order by o.ready_by, o.created_at)
                        from public.food_orders o where o.courier_id = c.id and o.shop_id = s.shop_id
                          and o.status in ('new', 'preparing', 'on_the_way')), '[]'::jsonb),
      'done_today', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'number', o.number, 'name', o.name,
                                                                  'total_cents', o.total_cents, 'pay_method', o.pay_method,
                                                                  'delivered_at', o.delivered_at) order by o.delivered_at desc)
                              from public.food_orders o where o.courier_id = c.id and o.shop_id = s.shop_id
                                and o.status = 'delivered' and o.delivered_at >= v_from), '[]'::jsonb),
      'timezone', v_tz);
  end if;

  if p_fn not in ('delivery', 'step', 'problem') then raise exception 'fn' using errcode = '22023'; end if;
  begin
    v_order := (p_args ->> 'order_id')::uuid;
  exception when invalid_text_representation then
    raise exception 'not_found' using errcode = 'P0002';
  end;
  select * into ord from public.food_orders where id = v_order and courier_id = c.id and shop_id = s.shop_id;
  if ord.id is null or not (ord.status in ('new', 'preparing', 'on_the_way') or ord.status = 'delivered' and ord.delivered_at >= v_from) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if p_fn = 'delivery' then
    return public.food_courier_order_json(ord.id) || jsonb_build_object('perms', v_perms);
  end if;

  begin
    v_step := (p_args ->> 'step_id')::uuid;
  exception when invalid_text_representation then
    raise exception 'step' using errcode = '22023';
  end;
  if v_step is null then raise exception 'step' using errcode = '22023'; end if;

  if p_fn = 'problem' then
    v_reason := nullif(left(btrim(coalesce(p_args ->> 'reason', '')), 200), '');
    if v_reason is null then raise exception 'reason' using errcode = '22023'; end if;
    if not exists (select 1 from public.food_order_events e where e.step_id = v_step) then
      insert into public.food_order_events (order_id, shop_id, step_id, actor, actor_id, kind, from_status, to_status, detail)
      values (ord.id, ord.shop_id, v_step, 'courier', c.id, 'problem', ord.status, ord.status, v_reason);
    end if;
    return public.food_courier_order_json(ord.id) || jsonb_build_object('perms', v_perms);
  end if;

  -- step: "Na ceste", a payment mark, "Doručené" (only the methods the shop allows its couriers)
  v_to := nullif(p_args ->> 'to', '');
  v_pay := nullif(p_args ->> 'pay_method', '');
  if v_to is not null and v_to not in ('on_the_way', 'delivered') then raise exception 'step' using errcode = 'P0001'; end if;
  if v_pay is not null and coalesce((v_perms ->> v_pay)::boolean, false) is not true then
    raise exception 'pay_method' using errcode = '22023';
  end if;
  if v_to is null and v_pay is null then raise exception 'step' using errcode = 'P0001'; end if;
  if v_pay = 'cash' and nullif(p_args ->> 'cash_given_cents', '') is not null then
    begin
      v_cash := (p_args ->> 'cash_given_cents')::integer;
    exception when others then
      raise exception 'cash' using errcode = '22023';
    end;
  end if;
  perform public.food_order_step(ord.id, v_to, 'courier', c.id, v_step, v_pay, v_cash, null);
  return public.food_courier_order_json(ord.id) || jsonb_build_object('perms', v_perms);
end;
$$;
revoke execute on function public.food_courier_call(text, text, jsonb) from public;
grant execute on function public.food_courier_call(text, text, jsonb) to anon, authenticated;
