-- =====================================================================================================================
-- Update 57 — "Rezervácie" for Pro shops (2026-10-30, at the owner's request; phase 3 of the CRM work)
--
-- Paste the whole file into Supabase → SQL Editor and run it. Running it again changes nothing.
-- Needs updates 55 and 56 first (conversations, contacts, the message log).
--
-- 1. The shop's booking settings (off by default): what is booked, how long, the step between start times, a buffer,
--    the notice, how far ahead, the day-before reminder SMS (off by default; never a cancel link).
-- 2. Free times: only inside the shop's opening hours of that day (a special day wins, a shop-closing holiday closes
--    or cuts the day, a day-off holiday has no times), never overlapping another booking (an exclusion constraint), and
--    — in the bookings function — never over a busy time of the shop's Google Calendar (free/busy only).
-- 3. A booking: name, mobile (E.164), optional e-mail and address, a short note, GDPR consent (time + text version).
--    The shopper gets a 6-digit SMS code (10 minutes, 5 tries, at most 3 codes; 3 bookings an hour per number, 5 per
--    caller, 100 a day per shop). The right code confirms it at once (no confirmation SMS): the Google event is
--    inserted, the contact is found or made by the number (now "overené"), the chat's conversation is linked.
-- 4. The owner's list (Potvrdená / Zrušená / Neprišiel), the activity log, the SMS log (booking codes masked).
-- =====================================================================================================================

create extension if not exists btree_gist with schema extensions;

-- ------------------------------------------------------------------ 1. settings

create table if not exists public.shop_booking_settings (
  shop_id          uuid primary key references public.shops (id) on delete cascade,
  enabled          boolean not null default false,
  -- what is booked, as the owner writes it ("Strih", "Konzultácia"); null = the i18n default
  service_name     text check (service_name is null or char_length(service_name) <= 80),
  duration_minutes integer not null default 30 check (duration_minutes between 5 and 480),
  step_minutes     integer not null default 30 check (step_minutes between 5 and 240),
  buffer_minutes   integer not null default 0 check (buffer_minutes between 0 and 120),
  -- the earliest start: now + notice
  lead_minutes     integer not null default 120 check (lead_minutes between 0 and 10080),
  horizon_days     integer not null default 30 check (horizon_days between 1 and 180),
  reminder         boolean not null default false,
  updated_at       timestamptz not null default now()
);
alter table public.shop_booking_settings enable row level security;
revoke all on public.shop_booking_settings from public, anon, authenticated;
grant all on public.shop_booking_settings to service_role;
grant select on public.shop_booking_settings to authenticated;
drop policy if exists "shop_booking_settings: members read" on public.shop_booking_settings;
create policy "shop_booking_settings: members read" on public.shop_booking_settings
  for select to authenticated using (public.is_shop_member(shop_id));

-- The shop's Google Calendar: tokens only encrypted by the bookings function; owners see the state, never a token.
create table if not exists public.booking_google_connections (
  shop_id           uuid primary key references public.shops (id) on delete cascade,
  access_token_enc  text not null,
  refresh_token_enc text not null,
  access_expires_at timestamptz,
  scope             text,
  status            text not null default 'ok' check (status in ('ok', 'expired', 'error')),
  last_error        text check (last_error is null or char_length(last_error) <= 500),
  connected_by      uuid,
  connected_at      timestamptz not null default now()
);
alter table public.booking_google_connections enable row level security;
revoke all on public.booking_google_connections from public, anon, authenticated;
grant all on public.booking_google_connections to service_role;
grant select (shop_id, status, last_error, connected_at) on public.booking_google_connections to authenticated;
drop policy if exists "booking_google_connections: members read" on public.booking_google_connections;
create policy "booking_google_connections: members read" on public.booking_google_connections
  for select to authenticated using (public.is_shop_member(shop_id));

create table if not exists public.booking_oauth_states (
  state_hash text primary key,
  shop_id    uuid not null references public.shops (id) on delete cascade,
  user_id    uuid not null,
  verifier   text not null,
  return_url text not null check (return_url ~ '^https?://'),
  expires_at timestamptz not null
);
alter table public.booking_oauth_states enable row level security;
revoke all on public.booking_oauth_states from public, anon, authenticated;
grant all on public.booking_oauth_states to service_role;

-- ------------------------------------------------------------------ 3. bookings

create table if not exists public.shop_bookings (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops (id) on delete cascade,
  contact_id       uuid references public.shop_contacts (id) on delete set null,
  conversation_id  uuid references public.assistant_conversations (id) on delete set null,
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  -- pending (waiting for the code) → confirmed → cancelled | no_show; expired = the code was never entered right
  status           text not null default 'pending' check (status in ('pending', 'confirmed', 'cancelled', 'no_show', 'expired')),
  end_reason       text check (end_reason is null or end_reason in ('code_expired', 'too_many_attempts', 'slot_taken', 'replaced')),
  service_name     text,
  name             text not null check (char_length(name) between 1 and 120),
  phone            text not null check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  email            text check (email is null or (char_length(email) <= 254 and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  address          text check (address is null or char_length(address) <= 300),
  note             text check (note is null or char_length(note) <= 500),
  lang             text check (lang is null or lang ~ '^[a-z]{2,3}(-[a-z]{2,4})?$'),
  consent_at       timestamptz not null,
  consent_version  text not null check (char_length(consent_version) between 1 and 40),
  -- the shopper's booking token and the code: SHA-256 only, never the code itself
  token_hash       text not null,
  code_hash        text,
  code_expires_at  timestamptz,
  code_attempts    integer not null default 0,
  code_sends       integer not null default 1,
  caller_hash      text,
  verified_at      timestamptz,
  google_event_id  text,
  google_status    text not null default 'none' check (google_status in ('none', 'created', 'failed')),
  reminder_sent_at timestamptz,
  status_by        uuid,
  created_at       timestamptz not null default now(),
  confirmed_at     timestamptz,
  status_changed_at timestamptz,
  constraint shop_bookings_order check (ends_at > starts_at),
  -- never two bookings of a shop at the same time (a waiting one holds its time for its 10 minutes)
  constraint shop_bookings_no_overlap exclude using gist (shop_id with =, tstzrange(starts_at, ends_at, '[)') with &&)
    where (status in ('pending', 'confirmed'))
);
create index if not exists shop_bookings_shop_idx on public.shop_bookings (shop_id, starts_at);
create index if not exists shop_bookings_contact_idx on public.shop_bookings (contact_id, starts_at desc);
create index if not exists shop_bookings_phone_idx on public.shop_bookings (shop_id, phone, created_at desc);
alter table public.shop_bookings enable row level security;
revoke all on public.shop_bookings from public, anon, authenticated;
grant all on public.shop_bookings to service_role;
-- Owners read their bookings; never the token or the code.
grant select (id, shop_id, contact_id, conversation_id, starts_at, ends_at, status, end_reason, service_name, name, phone,
              email, address, note, lang, consent_at, consent_version, google_status, reminder_sent_at, created_at,
              confirmed_at, status_changed_at)
  on public.shop_bookings to authenticated;
drop policy if exists "shop_bookings: members read" on public.shop_bookings;
create policy "shop_bookings: members read" on public.shop_bookings
  for select to authenticated using (public.is_shop_member(shop_id));

-- The message log knows what a message was for (phase 4 counts the booking SMS and the owner's replies apart).
alter table public.shop_outgoing_messages
  add column if not exists kind text not null default 'owner',
  add column if not exists booking_id uuid references public.shop_bookings (id) on delete set null;
alter table public.shop_outgoing_messages drop constraint if exists shop_outgoing_messages_kind_check;
alter table public.shop_outgoing_messages add constraint shop_outgoing_messages_kind_check
  check (kind in ('owner', 'booking_code', 'booking_reminder'));

-- ------------------------------------------------------------------ the activity log's new actions

alter table public.shop_activity drop constraint if exists shop_activity_action_check;
alter table public.shop_activity add constraint shop_activity_action_check
  check (action in ('stock_files_deleted', 'inventory_missing_removed', 'inventory_reset', 'inventory_restored',
                    'inventory_purged', 'export_review', 'export_edits', 'export_files_deleted',
                    'inventory_api_connected', 'inventory_api_key_changed', 'inventory_api_approved',
                    'inventory_api_error', 'inventory_api_recovered', 'inventory_api_disconnected',
                    'connector_paired', 'connector_revoked', 'stock_source_changed', 'connector_snapshot_held',
                    'connector_snapshot_approved', 'connector_snapshot_discarded', 'connector_sync_requested',
                    'conversation_retention', 'conversations_marked', 'conversation_note', 'conversations_deleted',
                    'conversations_exported',
                    'contact_saved', 'contact_deleted', 'contact_linked', 'email_template_saved',
                    'email_template_deleted', 'message_sent',
                    'booking_settings_saved', 'booking_confirmed', 'booking_status_changed',
                    'booking_calendar_connected', 'booking_calendar_disconnected'));

-- ------------------------------------------------------------------ 2. free times

/** The shop's settings, or the defaults when it never saved any. */
create or replace function public.booking_settings_of(p_shop_id uuid)
returns public.shop_booking_settings
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s from public.shop_booking_settings s where s.shop_id = p_shop_id),
                  row(p_shop_id, false, null, 30, 30, 0, 120, 30, false, now())::public.shop_booking_settings)
$$;
revoke execute on function public.booking_settings_of(uuid) from public, anon, authenticated;
grant execute on function public.booking_settings_of(uuid) to service_role;

/**
 * The shop's open times of one local day as instants: a special day wins (closed = none), else a holiday of the shop's
 * country when the shop follows them (shops closed by law: none, or cut at "closed from"; a day off: none — the owner
 * sets a special day to take bookings), else the regular hours. A range past midnight ends at midnight here.
 */
create or replace function public.booking_day_ranges(p_shop_id uuid, p_day date)
returns table (range_start timestamptz, range_end timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shop public.shops%rowtype;
  v_special public.shop_special_hours%rowtype;
  v_kind text;
  v_closed_from text;
  v_ranges jsonb;
  v_cut time;
  v_range jsonb;
  v_from time;
  v_to time;
begin
  select * into v_shop from public.shops where id = p_shop_id;
  if not found then return; end if;
  select * into v_special from public.shop_special_hours where shop_id = p_shop_id and date = p_day;
  if found then
    v_ranges := case when v_special.closed then '[]'::jsonb else v_special.ranges end;
  else
    if v_shop.auto_holidays then
      select h.kind, h.closed_from into v_kind, v_closed_from
      from public.public_holidays h
      where h.country = upper(v_shop.country) and h.date = p_day
      order by (h.source = 'admin') desc
      limit 1;
    end if;
    v_ranges := coalesce(v_shop.opening_hours -> (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from p_day)::int + 1],
                         '[]'::jsonb);
    if v_kind = 'day_off' then
      v_ranges := '[]'::jsonb;
    elsif v_kind = 'shops_closed' then
      if v_closed_from ~ '^\d{2}:\d{2}$' then v_cut := v_closed_from::time; else v_ranges := '[]'::jsonb; end if;
    end if;
  end if;
  for v_range in select * from jsonb_array_elements(case when jsonb_typeof(v_ranges) = 'array' then v_ranges else '[]'::jsonb end) loop
    continue when jsonb_typeof(v_range) <> 'array' or (v_range ->> 0) !~ '^\d{2}:\d{2}$' or (v_range ->> 1) !~ '^\d{2}:\d{2}$';
    v_from := (v_range ->> 0)::time;
    v_to := (v_range ->> 1)::time;
    range_start := (p_day + v_from) at time zone v_shop.timezone;
    range_end := case when v_to > v_from then (p_day + v_to) at time zone v_shop.timezone
                      else (p_day + 1)::timestamp at time zone v_shop.timezone end;
    if v_cut is not null then
      range_end := least(range_end, (p_day + v_cut) at time zone v_shop.timezone);
    end if;
    if range_end > range_start then return next; end if;
  end loop;
end;
$$;
revoke execute on function public.booking_day_ranges(uuid, date) from public, anon, authenticated;
grant execute on function public.booking_day_ranges(uuid, date) to service_role;

/**
 * The free start times of a shop between two instants (at most 300): inside the open ranges, every step from a range's
 * start, the whole duration inside the range, not before now + notice, not after now + horizon, and with its buffer
 * clear of every confirmed booking and every waiting one whose code still runs. Google's busy times are taken off by
 * the bookings function.
 */
create or replace function public.booking_free_slots(p_shop_id uuid, p_from timestamptz, p_to timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_set public.shop_booking_settings := public.booking_settings_of(p_shop_id);
  v_tz text := (select timezone from public.shops where id = p_shop_id);
  v_from timestamptz := greatest(p_from, now() + make_interval(mins => v_set.lead_minutes));
  v_to timestamptz := least(p_to, now() + make_interval(days => v_set.horizon_days));
  v_day date;
  v_range record;
  v_t timestamptz;
  v_n integer := 0;
  v_len interval := make_interval(mins => v_set.duration_minutes);
  v_buf interval := make_interval(mins => v_set.buffer_minutes);
begin
  if v_tz is null or v_to <= v_from then return; end if;
  v_day := (v_from at time zone v_tz)::date;
  while v_day <= (v_to at time zone v_tz)::date loop
    for v_range in select * from public.booking_day_ranges(p_shop_id, v_day) order by 1 loop
      v_t := v_range.range_start;
      while v_t + v_len <= v_range.range_end loop
        if v_t >= v_from and v_t + v_len <= v_to and not exists (
             select 1 from public.shop_bookings b
             where b.shop_id = p_shop_id
               and (b.status = 'confirmed' or (b.status = 'pending' and b.code_expires_at > now()))
               and tstzrange(b.starts_at - v_buf, b.ends_at + v_buf, '[)') && tstzrange(v_t, v_t + v_len, '[)')) then
          starts_at := v_t;
          ends_at := v_t + v_len;
          return next;
          v_n := v_n + 1;
          if v_n >= 300 then return; end if;
        end if;
        v_t := v_t + make_interval(mins => v_set.step_minutes);
      end loop;
    end loop;
    v_day := v_day + 1;
  end loop;
end;
$$;
revoke execute on function public.booking_free_slots(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.booking_free_slots(uuid, timestamptz, timestamptz) to service_role;

/** A shop that takes bookings now: active, the paid plan, bookings switched on. */
create or replace function public.booking_shop(p_slug text)
returns table (shop_id uuid, timezone text, country text, shop_name text, service_name text, duration_minutes integer,
               reminder boolean, google boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.timezone, s.country, s.name, st.service_name, st.duration_minutes, st.reminder,
         exists (select 1 from public.booking_google_connections g where g.shop_id = s.id and g.status = 'ok')
  from public.shops s
  join public.shop_booking_settings st on st.shop_id = s.id
  where s.slug = p_slug and s.is_active and st.enabled and public.shop_has_plan(s.id)
$$;
revoke execute on function public.booking_shop(text) from public, anon, authenticated;
grant execute on function public.booking_shop(text) to service_role;

/** For the shop assistant (anon): does this shop take bookings now, and what is booked for how long. */
create or replace function public.shop_takes_bookings(p_slug text)
returns table (service_name text, duration_minutes integer)
language sql
stable
security definer
set search_path = ''
as $$
  select b.service_name, b.duration_minutes from public.booking_shop(p_slug) b
$$;
revoke execute on function public.shop_takes_bookings(text) from public;
grant execute on function public.shop_takes_bookings(text) to anon, authenticated, service_role;

/** The free times of a bookable shop from a local day on, for up to 14 days (the bookings function's "slots"). */
create or replace function public.booking_slots(p_slug text, p_from date, p_days integer default 7)
returns table (starts_at timestamptz, ends_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select f.starts_at, f.ends_at
  from public.booking_shop(p_slug) b,
       public.booking_free_slots(b.shop_id,
                                 coalesce(p_from, (now() at time zone b.timezone)::date)::timestamp at time zone b.timezone,
                                 (coalesce(p_from, (now() at time zone b.timezone)::date) + least(greatest(coalesce(p_days, 7), 1), 14))::timestamp
                                   at time zone b.timezone) f
$$;
revoke execute on function public.booking_slots(text, date, integer) from public, anon, authenticated;
grant execute on function public.booking_slots(text, date, integer) to service_role;

-- ------------------------------------------------------------------ 3. booking, code, confirmation

/** A 6-digit code from the system's random UUIDs (cryptographically random). */
create or replace function public.booking_new_code()
returns text
language sql
volatile
set search_path = ''
as $$
  select lpad(((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))::bit(48)::bigint) % 1000000)::text, 6, '0')
$$;
revoke execute on function public.booking_new_code() from public, anon, authenticated;
grant execute on function public.booking_new_code() to service_role;

create or replace function public.booking_hash(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(coalesce(p_value, ''), 'UTF8')), 'hex')
$$;
revoke execute on function public.booking_hash(text) from public, anon, authenticated;
grant execute on function public.booking_hash(text) to service_role;

/** Waiting bookings whose code ran out let their time go. */
create or replace function public.booking_tidy(p_shop_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.shop_bookings
  set status = 'expired', end_reason = 'code_expired', status_changed_at = now()
  where shop_id = p_shop_id and status = 'pending' and code_expires_at <= now()
$$;
revoke execute on function public.booking_tidy(uuid) from public, anon, authenticated;
grant execute on function public.booking_tidy(uuid) to service_role;

/**
 * "Rezervovať": holds a free time for 10 minutes and returns the code to send by SMS (never stored, only its hash),
 * the shopper's booking token and the number. Refusals (raised): not_available, consent, name, phone, email,
 * too_many, slot_taken. A conversation of the same shop (with its token) is remembered for the link.
 */
create or replace function public.booking_start(
  p_slug text, p_starts_at timestamptz, p_name text, p_phone text, p_email text, p_address text, p_note text,
  p_consent boolean, p_consent_version text, p_lang text, p_caller_hash text,
  p_conversation_id uuid default null, p_conversation_token text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop record;
  v_phone text;
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_code text := public.booking_new_code();
  v_token text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_id uuid := gen_random_uuid();
  v_conv uuid;
begin
  select * into v_shop from public.booking_shop(p_slug);
  if not found then raise exception 'not_available' using errcode = 'P0001'; end if;
  if p_consent is not true or nullif(btrim(coalesce(p_consent_version, '')), '') is null then
    raise exception 'consent' using errcode = '22023';
  end if;
  if v_name is null or char_length(v_name) > 120 then raise exception 'name' using errcode = '22023'; end if;
  v_phone := public.crm_phone(p_phone, v_shop.country);
  if v_phone is null then raise exception 'phone' using errcode = '22023'; end if;
  if v_email is not null and (char_length(v_email) > 254 or v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'email' using errcode = '22023';
  end if;
  if p_caller_hash is null or length(p_caller_hash) < 16 then raise exception 'Invalid caller hash' using errcode = '22023'; end if;
  if (select count(*) from public.shop_bookings where shop_id = v_shop.shop_id and phone = v_phone
      and created_at > now() - interval '1 hour') >= 3
     or (select count(*) from public.shop_bookings where caller_hash = p_caller_hash
         and created_at > now() - interval '1 hour') >= 5
     or (select count(*) from public.shop_bookings where shop_id = v_shop.shop_id
         and created_at > now() - interval '1 day') >= 100 then
    raise exception 'too_many' using errcode = '54000';
  end if;
  perform public.booking_tidy(v_shop.shop_id);
  if not exists (select 1 from public.booking_free_slots(v_shop.shop_id, p_starts_at,
                                                          p_starts_at + make_interval(mins => v_shop.duration_minutes)) f
                 where f.starts_at = p_starts_at) then
    raise exception 'slot_taken' using errcode = 'P0001';
  end if;
  if p_conversation_id is not null then
    select c.id into v_conv from public.assistant_conversations c
    where c.id = p_conversation_id and c.shop_id = v_shop.shop_id
      and c.token_hash = public.assistant_token_hash(p_conversation_token);
  end if;
  begin
    insert into public.shop_bookings (id, shop_id, conversation_id, starts_at, ends_at, service_name, name, phone, email,
                                      address, note, lang, consent_at, consent_version, token_hash, code_hash,
                                      code_expires_at, caller_hash)
    values (v_id, v_shop.shop_id, v_conv, p_starts_at, p_starts_at + make_interval(mins => v_shop.duration_minutes),
            v_shop.service_name, v_name, v_phone, v_email, left(nullif(btrim(coalesce(p_address, '')), ''), 300),
            left(nullif(btrim(coalesce(p_note, '')), ''), 500),
            case when p_lang ~ '^[a-z]{2,3}(-[a-z]{2,4})?$' then p_lang end, now(), left(btrim(p_consent_version), 40),
            public.booking_hash(v_token), public.booking_hash(v_id::text || ':' || v_code),
            now() + interval '10 minutes', p_caller_hash);
  exception when exclusion_violation then
    raise exception 'slot_taken' using errcode = 'P0001';
  end;
  return jsonb_build_object('id', v_id, 'token', v_token, 'code', v_code, 'phone', v_phone, 'shop_id', v_shop.shop_id,
                            'shop_name', v_shop.shop_name, 'expires_at', now() + interval '10 minutes', 'lang', p_lang);
end;
$$;
revoke execute on function public.booking_start(text, timestamptz, text, text, text, text, text, boolean, text, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.booking_start(text, timestamptz, text, text, text, text, text, boolean, text, text, text, uuid, text)
  to service_role;

/** "Poslať kód znova": a new code (the old one stops working, 10 more minutes, 5 tries), at most 3 codes a booking. */
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

/**
 * The shopper types the code: {ok: true, …the booking} when it is right (the bookings function then checks Google and
 * confirms); else {ok: false, reason: wrong_code (attempts_left) | expired | too_many_attempts | not_pending}. Every try
 * counts; the 5th wrong one ends the booking.
 */
create or replace function public.booking_verify(p_id uuid, p_token text, p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.shop_bookings%rowtype;
  v_shop public.shops%rowtype;
begin
  select * into v from public.shop_bookings where id = p_id and token_hash = public.booking_hash(p_token) for update;
  if not found or v.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'not_pending'); end if;
  if v.verified_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'not_pending');
  end if;
  if v.code_expires_at <= now() then
    update public.shop_bookings set status = 'expired', end_reason = 'code_expired', status_changed_at = now() where id = p_id;
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if public.booking_hash(v.id::text || ':' || btrim(coalesce(p_code, ''))) is distinct from v.code_hash then
    update public.shop_bookings set code_attempts = code_attempts + 1 where id = p_id returning * into v;
    if v.code_attempts >= 5 then
      update public.shop_bookings set status = 'expired', end_reason = 'too_many_attempts', status_changed_at = now() where id = p_id;
      return jsonb_build_object('ok', false, 'reason', 'too_many_attempts');
    end if;
    return jsonb_build_object('ok', false, 'reason', 'wrong_code', 'attempts_left', 5 - v.code_attempts);
  end if;
  update public.shop_bookings set verified_at = now(), code_hash = null where id = p_id;
  select * into v_shop from public.shops where id = v.shop_id;
  return jsonb_build_object('ok', true, 'id', v.id, 'shop_id', v.shop_id, 'shop_name', v_shop.name, 'timezone', v_shop.timezone,
                            'starts_at', v.starts_at, 'ends_at', v.ends_at, 'name', v.name, 'phone', v.phone,
                            'email', v.email, 'address', v.address, 'note', v.note, 'service_name', v.service_name,
                            'lang', v.lang,
                            'google', exists (select 1 from public.booking_google_connections g
                                              where g.shop_id = v.shop_id and g.status = 'ok'));
end;
$$;
revoke execute on function public.booking_verify(uuid, text, text) from public, anon, authenticated;
grant execute on function public.booking_verify(uuid, text, text) to service_role;

/**
 * A verified booking is confirmed: its Google event (or none / failed), the contact found by the number or made from
 * the booking (the number is now "overené"; empty fields filled, nothing overwritten), the conversation linked through
 * the number. Returns {id, contact_id, starts_at, ends_at}. Service role only, once.
 */
create or replace function public.booking_confirm(p_id uuid, p_google_event_id text, p_google_status text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.shop_bookings%rowtype;
  v_contact uuid;
begin
  select * into v from public.shop_bookings where id = p_id for update;
  if not found or v.status <> 'pending' or v.verified_at is null then
    raise exception 'not_verified' using errcode = 'P0001';
  end if;
  select id into v_contact from public.shop_contacts where shop_id = v.shop_id and phone = v.phone for update;
  if v_contact is null then
    insert into public.shop_contacts (shop_id, name, phone, phone_verified_at, email, address, source)
    values (v.shop_id, v.name, v.phone, now(), v.email, v.address, 'booking')
    returning id into v_contact;
  else
    update public.shop_contacts
    set phone_verified_at = now(), name = coalesce(name, v.name), email = coalesce(email, v.email),
        address = coalesce(address, v.address), updated_at = now()
    where id = v_contact;
  end if;
  update public.shop_bookings
  set status = 'confirmed', confirmed_at = now(), status_changed_at = now(), contact_id = v_contact,
      google_event_id = left(p_google_event_id, 200),
      google_status = case when p_google_status in ('created', 'failed') then p_google_status else 'none' end
  where id = p_id;
  if v.conversation_id is not null then
    update public.assistant_conversations set shopper_phone = v.phone, contact_id = v_contact where id = v.conversation_id;
  end if;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (v.shop_id, null, 'booking_confirmed',
          jsonb_build_object('booking_id', v.id, 'contact_id', v_contact, 'google', coalesce(p_google_status, 'none')));
  return jsonb_build_object('id', v.id, 'contact_id', v_contact, 'starts_at', v.starts_at, 'ends_at', v.ends_at);
end;
$$;
revoke execute on function public.booking_confirm(uuid, text, text) from public, anon, authenticated;
grant execute on function public.booking_confirm(uuid, text, text) to service_role;

/** A verified booking whose time turned busy in Google meanwhile lets it go ("slot_taken"). Service role only. */
create or replace function public.booking_release(p_id uuid, p_reason text)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  with u as (
    update public.shop_bookings
    set status = 'expired', end_reason = case when p_reason in ('slot_taken', 'code_expired') then p_reason else 'slot_taken' end,
        status_changed_at = now()
    where id = p_id and status = 'pending'
    returning 1)
  select exists (select 1 from u)
$$;
revoke execute on function public.booking_release(uuid, text) from public, anon, authenticated;
grant execute on function public.booking_release(uuid, text) to service_role;

/**
 * Writes an SMS of a booking into the message log (the code masked: the owner never sees a working code) and, for a
 * reminder, marks it sent. Service role only.
 */
create or replace function public.booking_log_sms(
  p_booking_id uuid, p_kind text, p_body text, p_status text, p_provider text, p_ref text, p_error text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.shop_bookings%rowtype;
  v_id uuid;
begin
  if p_kind not in ('booking_code', 'booking_reminder') or p_status not in ('sent', 'failed', 'test') then
    raise exception 'kind' using errcode = '22023';
  end if;
  select * into v from public.shop_bookings where id = p_booking_id;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  insert into public.shop_outgoing_messages (shop_id, contact_id, channel, recipient, body, status, provider, provider_ref,
                                             error, kind, booking_id, sent_at)
  values (v.shop_id, v.contact_id, 'sms', v.phone,
          case when p_kind = 'booking_code' then regexp_replace(left(p_body, 480), '\d{6}', '••••••', 'g') else left(p_body, 480) end,
          p_status, left(p_provider, 40), left(p_ref, 200), left(p_error, 500), p_kind, v.id,
          case when p_status = 'sent' then now() end)
  returning id into v_id;
  if p_kind = 'booking_reminder' then
    update public.shop_bookings set reminder_sent_at = now() where id = p_booking_id;
  end if;
  return v_id;
end;
$$;
revoke execute on function public.booking_log_sms(uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.booking_log_sms(uuid, text, text, text, text, text, text) to service_role;

/**
 * Day-before reminders due now: confirmed, the shop's reminder on, not sent, the booking's local day is tomorrow and the
 * shop's local time is 09:00 or later. Service role only (the bookings function's job).
 */
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
  order by b.starts_at
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
$$;
revoke execute on function public.booking_reminders_due(integer) from public, anon, authenticated;
grant execute on function public.booking_reminders_due(integer) to service_role;

-- ------------------------------------------------------------------ Google Calendar (service role only)

create or replace function public.booking_oauth_begin(p_shop_id uuid, p_user_id uuid, p_state_hash text, p_verifier text, p_return_url text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  delete from public.booking_oauth_states where expires_at < now();
  insert into public.booking_oauth_states (state_hash, shop_id, user_id, verifier, return_url, expires_at)
  values (p_state_hash, p_shop_id, p_user_id, p_verifier, p_return_url, now() + interval '10 minutes');
$$;

/** The state once (deleted as it is read), only within its 10 minutes. */
create or replace function public.booking_oauth_take(p_state_hash text)
returns table (shop_id uuid, user_id uuid, verifier text, return_url text)
language sql
volatile
security definer
set search_path = ''
as $$
  delete from public.booking_oauth_states s
  where s.state_hash = p_state_hash
  returning s.shop_id, s.user_id, s.verifier, s.return_url
$$;

create or replace function public.booking_google_save(
  p_shop_id uuid, p_access_enc text, p_refresh_enc text, p_expires_at timestamptz, p_scope text, p_user_id uuid
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.booking_google_connections (shop_id, access_token_enc, refresh_token_enc, access_expires_at, scope, connected_by)
  values (p_shop_id, p_access_enc, p_refresh_enc, p_expires_at, left(p_scope, 400), p_user_id)
  on conflict (shop_id) do update
    set access_token_enc = excluded.access_token_enc, refresh_token_enc = excluded.refresh_token_enc,
        access_expires_at = excluded.access_expires_at, scope = excluded.scope, status = 'ok', last_error = null,
        connected_by = excluded.connected_by, connected_at = now();
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, p_user_id, 'booking_calendar_connected', '{}'::jsonb);
$$;

create or replace function public.booking_google_token(p_shop_id uuid)
returns table (access_token_enc text, refresh_token_enc text, access_expires_at timestamptz, status text)
language sql
stable
security definer
set search_path = ''
as $$
  select access_token_enc, refresh_token_enc, access_expires_at, status
  from public.booking_google_connections where shop_id = p_shop_id
$$;

create or replace function public.booking_google_refreshed(p_shop_id uuid, p_access_enc text, p_expires_at timestamptz)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.booking_google_connections
  set access_token_enc = p_access_enc, access_expires_at = p_expires_at, status = 'ok', last_error = null
  where shop_id = p_shop_id
$$;

create or replace function public.booking_google_failed(p_shop_id uuid, p_status text, p_error text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.booking_google_connections
  set status = case when p_status in ('expired', 'error') then p_status else 'error' end, last_error = left(p_error, 500)
  where shop_id = p_shop_id
$$;

/** Removes the connection (the function revoked the token at Google first) and writes it in the activity log. */
create or replace function public.booking_google_remove(p_shop_id uuid, p_user_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  with d as (delete from public.booking_google_connections where shop_id = p_shop_id returning 1),
       l as (insert into public.shop_activity (shop_id, actor, action, details)
             select p_shop_id, p_user_id, 'booking_calendar_disconnected', '{}'::jsonb where exists (select 1 from d)
             returning 1)
  select exists (select 1 from d)
$$;

revoke execute on function public.booking_oauth_begin(uuid, uuid, text, text, text), public.booking_oauth_take(text),
  public.booking_google_save(uuid, text, text, timestamptz, text, uuid), public.booking_google_token(uuid),
  public.booking_google_refreshed(uuid, text, timestamptz), public.booking_google_failed(uuid, text, text),
  public.booking_google_remove(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.booking_oauth_begin(uuid, uuid, text, text, text), public.booking_oauth_take(text),
  public.booking_google_save(uuid, text, text, timestamptz, text, uuid), public.booking_google_token(uuid),
  public.booking_google_refreshed(uuid, text, timestamptz), public.booking_google_failed(uuid, text, text),
  public.booking_google_remove(uuid, uuid)
  to service_role;

-- ------------------------------------------------------------------ 4. the owner's functions

/** "Nastavenia rezervácií" (members with the plan). */
create or replace function public.owner_save_booking_settings(
  p_shop_id uuid, p_enabled boolean, p_service_name text, p_duration integer, p_step integer, p_buffer integer,
  p_lead integer, p_horizon integer, p_reminder boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.crm_owner_check(p_shop_id);
  if p_duration is null or p_duration not between 5 and 480 or p_step is null or p_step not between 5 and 240
     or coalesce(p_buffer, 0) not between 0 and 120 or coalesce(p_lead, 0) not between 0 and 10080
     or p_horizon is null or p_horizon not between 1 and 180
     or char_length(coalesce(p_service_name, '')) > 80 then
    raise exception 'settings' using errcode = '22023';
  end if;
  insert into public.shop_booking_settings (shop_id, enabled, service_name, duration_minutes, step_minutes, buffer_minutes,
                                            lead_minutes, horizon_days, reminder, updated_at)
  values (p_shop_id, coalesce(p_enabled, false), nullif(btrim(coalesce(p_service_name, '')), ''), p_duration, p_step,
          coalesce(p_buffer, 0), coalesce(p_lead, 0), p_horizon, coalesce(p_reminder, false), now())
  on conflict (shop_id) do update
    set enabled = excluded.enabled, service_name = excluded.service_name, duration_minutes = excluded.duration_minutes,
        step_minutes = excluded.step_minutes, buffer_minutes = excluded.buffer_minutes, lead_minutes = excluded.lead_minutes,
        horizon_days = excluded.horizon_days, reminder = excluded.reminder, updated_at = now();
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'booking_settings_saved',
          jsonb_build_object('enabled', coalesce(p_enabled, false), 'duration', p_duration, 'reminder', coalesce(p_reminder, false)));
end;
$$;
revoke execute on function public.owner_save_booking_settings(uuid, boolean, text, integer, integer, integer, integer, integer, boolean)
  from public, anon;
grant execute on function public.owner_save_booking_settings(uuid, boolean, text, integer, integer, integer, integer, integer, boolean)
  to authenticated, service_role;

/**
 * "Rezervácie": the shop's bookings between two local days (null = from today on), p_status null = confirmed,
 * cancelled and no-show (never waiting or expired ones), or one of them. Members only.
 */
create or replace function public.owner_bookings(
  p_shop_id uuid, p_from date default null, p_to date default null, p_status text default null,
  p_limit integer default 100, p_offset integer default 0
)
returns table (id uuid, starts_at timestamptz, ends_at timestamptz, status text, service_name text, name text, phone text,
               email text, address text, note text, contact_id uuid, conversation_id uuid, google_status text,
               reminder_sent_at timestamptz, created_at timestamptz, total_count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id, b.starts_at, b.ends_at, b.status, b.service_name, b.name, b.phone, b.email, b.address, b.note,
         b.contact_id, b.conversation_id, b.google_status, b.reminder_sent_at, b.created_at, count(*) over ()
  from public.shop_bookings b
  join public.shops s on s.id = b.shop_id
  where b.shop_id = p_shop_id and public.is_shop_member(p_shop_id)
    and case when nullif(p_status, '') is null then b.status in ('confirmed', 'cancelled', 'no_show') else b.status = p_status end
    and b.starts_at >= (coalesce(p_from, (now() at time zone s.timezone)::date))::timestamp at time zone s.timezone
    and (p_to is null or b.starts_at < (p_to + 1)::timestamp at time zone s.timezone)
  order by b.starts_at, b.id
  limit least(greatest(coalesce(p_limit, 100), 1), 500)
  offset greatest(coalesce(p_offset, 0), 0)
$$;
revoke execute on function public.owner_bookings(uuid, date, date, text, integer, integer) from public, anon;
grant execute on function public.owner_bookings(uuid, date, date, text, integer, integer) to authenticated, service_role;

/**
 * Potvrdená / Zrušená / Neprišiel for a confirmed (or already changed) booking. A cancelled booking frees its time in
 * Cacaduu; the Google event is left as it is (Cacaduu only inserts events). Members only.
 */
create or replace function public.owner_set_booking_status(p_id uuid, p_status text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.shop_bookings%rowtype;
begin
  select * into v from public.shop_bookings where id = p_id for update;
  if not found or not public.is_shop_member(v.shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('confirmed', 'cancelled', 'no_show') then
    raise exception 'status' using errcode = '22023';
  end if;
  if v.status not in ('confirmed', 'cancelled', 'no_show') then
    raise exception 'not_confirmed' using errcode = '22023';
  end if;
  if v.status = p_status then return false; end if;
  begin
    update public.shop_bookings set status = p_status, status_changed_at = now(), status_by = auth.uid() where id = p_id;
  exception when exclusion_violation then
    -- back to confirmed while another booking took the time meanwhile
    raise exception 'slot_taken' using errcode = 'P0001';
  end;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (v.shop_id, auth.uid(), 'booking_status_changed', jsonb_build_object('booking_id', p_id, 'from', v.status, 'to', p_status));
  return true;
end;
$$;
revoke execute on function public.owner_set_booking_status(uuid, text) from public, anon;
grant execute on function public.owner_set_booking_status(uuid, text) to authenticated, service_role;

-- ------------------------------------------------------------------ the job (hourly reminders and tidying)

create or replace function public.bookings_cron_ok(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(length(p_secret) >= 32 and exists (
    select 1 from vault.decrypted_secrets
    where name = 'ppi_bookings_cron'
      and encode(sha256(convert_to(decrypted_secret, 'UTF8')), 'hex')
          = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')), false)
$$;
revoke execute on function public.bookings_cron_ok(text) from public, anon, authenticated;
grant execute on function public.bookings_cron_ok(text) to service_role;

do $$
begin
  if to_regclass('vault.secrets') is not null
     and not exists (select 1 from vault.secrets where name = 'ppi_bookings_cron') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      'ppi_bookings_cron', 'PPI: the bookings job proves itself to the bookings function');
  end if;
end;
$$;

do $$
declare
  v_call text := $call$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_project_url') || '/functions/v1/bookings',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'x-ppi-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_bookings_cron')),
      body := jsonb_build_object('action', 'tick'),
      timeout_milliseconds := 60000)$call$;
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'cron' and p.proname = 'schedule') then
    raise notice 'pg_cron is not on: switch on pg_cron and pg_net (Database → Extensions), then run this file again.';
    return;
  end if;
  perform cron.schedule('ppi-bookings-tick', '11 * * * *', v_call);
end;
$$;
