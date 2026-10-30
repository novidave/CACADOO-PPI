-- PPI · database update 58 — SMS quotas and the real SMS provider (CRM phase 4, 30 October 2026)
--
-- Two monthly SMS quotas per shop, kept apart:
--   * "booking": the booking's SMS codes and day-before reminders (shop_outgoing_messages.kind booking_code /
--     booking_reminder), default 100 a month;
--   * "owner": the owner's own SMS from a contact card (kind owner), default 100 a month.
-- A quota counts the SMS **parts** a text is billed as (GSM-7 160 / 153 per part, Unicode 70 / 67 —
-- crm_sms_parts(), the same rule as smsParts() in src/lib/crm.ts), in the shop's own calendar month (shops.timezone).
-- Every SMS still in the log counts (queued, sent, and "test" while no provider is connected), except failed ones.
-- At the limit nothing is sent: owner_message_queue() refuses with sms_quota, the bookings function's
-- booking_sms_claim() refuses, the assistant stops offering times (shop_takes_bookings) and reminders wait.
-- The limits are the admin's (sms_quota_limits, admin_save_sms_quotas()); owners see their use (owner_sms_usage()).
-- Every SMS is written down as "queued" before it leaves (booking_sms_claim → the function sends →
-- booking_sms_settle), so two sends at the same moment can never pass the quota together (one lock per shop and quota).
--
-- Paste the whole file into Supabase → SQL Editor → Run. Safe to run again. Needs updates 56 and 57.

-- ------------------------------------------------------------------ the limits (admin)

create table if not exists public.sms_quota_limits (
  quota      text primary key check (quota in ('booking', 'owner')),
  monthly    integer not null check (monthly between 0 and 100000),
  updated_at timestamptz not null default now()
);
insert into public.sms_quota_limits (quota, monthly) values ('booking', 100), ('owner', 100) on conflict (quota) do nothing;
alter table public.sms_quota_limits enable row level security;
revoke all on public.sms_quota_limits from public, anon, authenticated;
grant all on public.sms_quota_limits to service_role;

-- ------------------------------------------------------------------ parts of each SMS

alter table public.shop_outgoing_messages add column if not exists parts integer check (parts is null or parts between 0 and 20);
create index if not exists shop_outgoing_messages_sms_month_idx
  on public.shop_outgoing_messages (shop_id, created_at) where channel = 'sms';

/**
 * How many SMS parts a text is billed as: GSM-7 (the GSM 03.38 alphabet; its extension characters count twice) 160
 * characters in one SMS, 153 per part when longer; anything else is Unicode: 70 in one SMS, 67 per part (a character
 * outside the basic plane counts twice). Slovak and Hungarian accents (á, č, ő, …) make a text Unicode.
 * The same rule as smsParts() in src/lib/crm.ts and the SMS providers in the Edge Functions.
 */
create or replace function public.crm_sms_parts(p_text text)
returns integer
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_basic constant text := $g$@£$¥èéùìòÇ$g$ || chr(10) || $g$Øø$g$ || chr(13)
    || $g$ÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà$g$;
  v_ext constant text := $g$^{}\[~]|€$g$ || chr(12);
  v_char text;
  v_gsm integer := 0;
  v_uni integer := 0;
  v_is_gsm boolean := true;
begin
  if p_text is null or p_text = '' then return 0; end if;
  foreach v_char in array regexp_split_to_array(p_text, '') loop
    if position(v_char in v_basic) > 0 then
      v_gsm := v_gsm + 1;
    elsif position(v_char in v_ext) > 0 then
      v_gsm := v_gsm + 2;
    else
      v_is_gsm := false;
    end if;
    v_uni := v_uni + case when ascii(v_char) > 65535 then 2 else 1 end;
  end loop;
  if v_is_gsm then
    return case when v_gsm <= 160 then 1 else ceil(v_gsm / 153.0)::integer end;
  end if;
  return case when v_uni <= 70 then 1 else ceil(v_uni / 67.0)::integer end;
end;
$$;
grant execute on function public.crm_sms_parts(text) to anon, authenticated, service_role;

-- Old rows get their parts once (the quotas of this month count them).
update public.shop_outgoing_messages set parts = public.crm_sms_parts(body) where channel = 'sms' and parts is null;

-- ------------------------------------------------------------------ the counting

/** Which quota an SMS kind belongs to. */
create or replace function public.sms_quota_of(p_kind text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_kind in ('booking_code', 'booking_reminder') then 'booking' else 'owner' end
$$;
revoke execute on function public.sms_quota_of(text) from public, anon, authenticated;
grant execute on function public.sms_quota_of(text) to service_role;

/** The start of the shop's current calendar month (in its time zone) and of the next one. */
create or replace function public.sms_month(p_shop_id uuid)
returns table (starts_at timestamptz, resets_at timestamptz)
language sql
stable
set search_path = ''
as $$
  select (date_trunc('month', now() at time zone coalesce(s.timezone, 'UTC'))) at time zone coalesce(s.timezone, 'UTC'),
         (date_trunc('month', now() at time zone coalesce(s.timezone, 'UTC')) + interval '1 month')
           at time zone coalesce(s.timezone, 'UTC')
  from public.shops s where s.id = p_shop_id
$$;
revoke execute on function public.sms_month(uuid) from public, anon, authenticated;
grant execute on function public.sms_month(uuid) to service_role;

/** SMS parts of one quota used by a shop this month: every SMS in the log except failed ones. */
create or replace function public.sms_quota_used(p_shop_id uuid, p_quota text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(coalesce(m.parts, 1)), 0)::integer
  from public.shop_outgoing_messages m, public.sms_month(p_shop_id) mo
  where m.shop_id = p_shop_id and m.channel = 'sms' and m.status <> 'failed'
    and m.created_at >= mo.starts_at and public.sms_quota_of(m.kind) = p_quota
$$;
revoke execute on function public.sms_quota_used(uuid, text) from public, anon, authenticated;
grant execute on function public.sms_quota_used(uuid, text) to service_role;

create or replace function public.sms_quota_limit(p_quota text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select monthly from public.sms_quota_limits where quota = p_quota), 100)
$$;
revoke execute on function public.sms_quota_limit(text) from public, anon, authenticated;
grant execute on function public.sms_quota_limit(text) to service_role;

/** SMS parts of a quota still free this month (0 at or over the limit). */
create or replace function public.sms_quota_left(p_shop_id uuid, p_quota text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(public.sms_quota_limit(p_quota) - public.sms_quota_used(p_shop_id, p_quota), 0)
$$;
revoke execute on function public.sms_quota_left(uuid, text) from public, anon, authenticated;
grant execute on function public.sms_quota_left(uuid, text) to service_role;

/**
 * Takes p_parts of a quota for one SMS about to be written down, or refuses with sms_quota. One lock per shop and
 * quota until the end of the transaction, so two SMS at the same moment never pass the limit together.
 */
create or replace function public.sms_quota_take(p_shop_id uuid, p_quota text, p_parts integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('ppi-sms:' || p_shop_id::text || ':' || p_quota, 0));
  if public.sms_quota_used(p_shop_id, p_quota) + greatest(coalesce(p_parts, 1), 1) > public.sms_quota_limit(p_quota) then
    raise exception 'sms_quota' using errcode = '54000';
  end if;
end;
$$;
revoke execute on function public.sms_quota_take(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.sms_quota_take(uuid, text, integer) to service_role;

/** Both quotas of a shop this month (for the owner's pages). */
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
    'month_start', mo.starts_at, 'resets_at', mo.resets_at)
  from public.sms_month(p_shop_id) mo
$$;
revoke execute on function public.sms_quota_state(uuid) from public, anon, authenticated;
grant execute on function public.sms_quota_state(uuid) to service_role;

/** "SMS tento mesiac": the shop's two quotas, used and limit (members of the shop; without the plan too). */
create or replace function public.owner_sms_usage(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_shop_member(p_shop_id) then raise exception 'Not a member of this shop' using errcode = '42501'; end if;
  return public.sms_quota_state(p_shop_id);
end;
$$;
revoke execute on function public.owner_sms_usage(uuid) from public, anon;
grant execute on function public.owner_sms_usage(uuid) to authenticated, service_role;

-- ------------------------------------------------------------------ the owner's SMS (update 56's queue + the quota)

/**
 * As update 56: writes the message down first (status queued) and returns it for crm-messages to send. New: an SMS
 * takes its parts of the shop's "owner" quota (refused with sms_quota at the limit) and keeps them in `parts`.
 */
create or replace function public.owner_message_queue(
  p_contact_id uuid, p_channel text, p_template_id uuid default null, p_subject text default null, p_body text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_draft jsonb := public.crm_message_draft(p_contact_id, p_channel, p_template_id, p_subject, p_body);
  v_shop uuid := (v_draft ->> 'shop_id')::uuid;
  v_parts integer;
  v_id uuid;
begin
  if (select count(*) from public.shop_outgoing_messages
      where shop_id = v_shop and channel = p_channel and created_at > now() - interval '24 hours') >= 100 then
    raise exception 'too_many' using errcode = '54000';
  end if;
  if p_channel = 'sms' then
    v_parts := public.crm_sms_parts(v_draft ->> 'body');
    perform public.sms_quota_take(v_shop, 'owner', v_parts);
  end if;
  insert into public.shop_outgoing_messages (shop_id, contact_id, channel, recipient, subject, body, template_id, sent_by,
                                             kind, parts)
  values (v_shop, p_contact_id, p_channel, v_draft ->> 'recipient', v_draft ->> 'subject', v_draft ->> 'body',
          p_template_id, auth.uid(), 'owner', v_parts)
  returning id into v_id;
  return (v_draft - 'shop_id') || jsonb_build_object('id', v_id, 'shop_name', (select name from public.shops where id = v_shop),
                                                     'reply_to', (select email from public.shops where id = v_shop),
                                                     'parts', v_parts);
end;
$$;
revoke execute on function public.owner_message_queue(uuid, text, uuid, text, text) from public, anon;
grant execute on function public.owner_message_queue(uuid, text, uuid, text, text) to authenticated, service_role;

-- ------------------------------------------------------------------ the booking's SMS (claim → send → settle)

/**
 * The bookings function writes a booking's SMS down before sending it (queued; a 6-digit code in it is kept as
 * "••••••"), taking its parts of the shop's "booking" quota — refused with sms_quota at the limit. Service role only.
 */
create or replace function public.booking_sms_claim(p_booking_id uuid, p_kind text, p_body text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.shop_bookings%rowtype;
  v_parts integer := public.crm_sms_parts(left(p_body, 480));
  v_id uuid;
begin
  if p_kind not in ('booking_code', 'booking_reminder') then raise exception 'kind' using errcode = '22023'; end if;
  select * into v from public.shop_bookings where id = p_booking_id;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform public.sms_quota_take(v.shop_id, 'booking', v_parts);
  insert into public.shop_outgoing_messages (shop_id, contact_id, channel, recipient, body, status, kind, booking_id, parts)
  values (v.shop_id, v.contact_id, 'sms', v.phone,
          case when p_kind = 'booking_code' then regexp_replace(left(p_body, 480), '\d{6}', '••••••', 'g') else left(p_body, 480) end,
          'queued', p_kind, v.id, v_parts)
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.booking_sms_claim(uuid, text, text) from public, anon, authenticated;
grant execute on function public.booking_sms_claim(uuid, text, text) to service_role;

/** What happened to a claimed booking SMS (once): sent / failed / test; a reminder is marked as sent either way. */
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
  where id = p_id and status = 'queued' and kind in ('booking_code', 'booking_reminder')
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

/** As update 57, but nothing is offered while the shop's booking quota is used up (the shopper could not get a code). */
create or replace function public.shop_takes_bookings(p_slug text)
returns table (service_name text, duration_minutes integer)
language sql
stable
security definer
set search_path = ''
as $$
  select b.service_name, b.duration_minutes from public.booking_shop(p_slug) b
  where public.sms_quota_left(b.shop_id, 'booking') > 0
$$;
revoke execute on function public.shop_takes_bookings(text) from public;
grant execute on function public.shop_takes_bookings(text) to anon, authenticated, service_role;

/** As update 57, refused with sms_quota (and the old code kept) while the booking quota is used up. */
create or replace function public.booking_resend(p_id uuid, p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.shop_bookings%rowtype;
  v_code text := public.booking_new_code();
begin
  select * into v from public.shop_bookings where id = p_id and token_hash = public.booking_hash(p_token) for update;
  if not found or v.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'not_pending'); end if;
  if v.code_sends >= 3 then return jsonb_build_object('ok', false, 'reason', 'too_many'); end if;
  if public.sms_quota_left(v.shop_id, 'booking') < 1 then return jsonb_build_object('ok', false, 'reason', 'sms_quota'); end if;
  update public.shop_bookings
  set code_hash = public.booking_hash(v.id::text || ':' || v_code), code_expires_at = now() + interval '10 minutes',
      code_attempts = 0, code_sends = code_sends + 1
  where id = p_id;
  return jsonb_build_object('ok', true, 'code', v_code, 'phone', v.phone, 'shop_id', v.shop_id, 'lang', v.lang,
                            'shop_name', (select name from public.shops where id = v.shop_id),
                            'expires_at', now() + interval '10 minutes');
end;
$$;
revoke execute on function public.booking_resend(uuid, text) from public, anon, authenticated;
grant execute on function public.booking_resend(uuid, text) to service_role;

/** As update 57; a shop whose booking quota is used up waits (its reminders go when the month turns, if still due). */
create or replace function public.booking_reminders_due(p_limit integer default 50)
returns table (id uuid, shop_id uuid, shop_name text, timezone text, phone text, name text, starts_at timestamptz,
               lang text, service_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id, b.shop_id, s.name, s.timezone, b.phone, b.name, b.starts_at, b.lang, b.service_name
  from public.shop_bookings b
  join public.shops s on s.id = b.shop_id
  join public.shop_booking_settings st on st.shop_id = b.shop_id
  where b.status = 'confirmed' and st.reminder and b.reminder_sent_at is null and b.starts_at > now()
    and (b.starts_at at time zone s.timezone)::date = (now() at time zone s.timezone)::date + 1
    and (now() at time zone s.timezone)::time >= time '09:00'
    and public.shop_has_plan(b.shop_id)
    and public.sms_quota_left(b.shop_id, 'booking') > 0
  order by b.starts_at
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
$$;
revoke execute on function public.booking_reminders_due(integer) from public, anon, authenticated;
grant execute on function public.booking_reminders_due(integer) to service_role;

-- ------------------------------------------------------------------ admin: the limits and this month's totals

/** The two limits and how many SMS parts all shops used this month (UTC month) and the shops at their limit. */
create or replace function public.admin_sms_quotas()
returns table (quota text, monthly integer, used_this_month bigint, shops_at_limit bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'Admins only' using errcode = '42501'; end if;
  return query
  select l.quota, l.monthly,
         (select coalesce(sum(coalesce(m.parts, 1)), 0) from public.shop_outgoing_messages m
          where m.channel = 'sms' and m.status <> 'failed' and public.sms_quota_of(m.kind) = l.quota
            and m.created_at >= date_trunc('month', now()))::bigint,
         (select count(*) from public.shops s
          where exists (select 1 from public.shop_outgoing_messages m where m.shop_id = s.id and m.channel = 'sms')
            and public.sms_quota_left(s.id, l.quota) = 0)::bigint
  from public.sms_quota_limits l
  order by l.quota;
end;
$$;
revoke execute on function public.admin_sms_quotas() from public, anon;
grant execute on function public.admin_sms_quotas() to authenticated;

create or replace function public.admin_save_sms_quotas(p_booking integer, p_owner integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'Admins only' using errcode = '42501'; end if;
  if p_booking is null or p_owner is null or p_booking not between 0 and 100000 or p_owner not between 0 and 100000 then
    raise exception 'limits' using errcode = '22023';
  end if;
  update public.sms_quota_limits set monthly = p_booking, updated_at = now() where quota = 'booking';
  update public.sms_quota_limits set monthly = p_owner, updated_at = now() where quota = 'owner';
end;
$$;
revoke execute on function public.admin_save_sms_quotas(integer, integer) from public, anon;
grant execute on function public.admin_save_sms_quotas(integer, integer) to authenticated;
