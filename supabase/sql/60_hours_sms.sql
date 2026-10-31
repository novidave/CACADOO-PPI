-- PPI · database update 60 — opening hours by SMS and the Google Business Profile (CRM phase 6, 30 October 2026)
--
-- The owner sends an SMS like "Po–Pi 8–17, So 8–12, Ne zatvorené" or "24.12. zatvorené" to the shops' SMS number;
-- Cacaduu changes the shop's opening hours (only the hours: nothing else is ever done by SMS), shows them on the shop
-- page, sends them to the shop's Google Business Profile when it is connected, and answers with a confirmation SMS —
-- or asks to write it again when the SMS was not clear.
--   * Only from an owner's **verified** phone (shop_owner_phones): the owner adds the number in Môj obchod and types
--     the 6-digit code the SMS brought (10 minutes, 5 tries, 3 codes an hour). The code is issued only by the
--     hours-sms function (service role), never handed to the website, so a number is verified only by its owner.
--   * Every received SMS is written down (hours_sms_messages; an unknown number keeps no text, only a hash of it);
--     at most 10 per phone an hour.
--   * The hours are read by Claude (the hours-sms function); the database checks them again (valid_hour_ranges,
--     dates from yesterday to +400 days, ≤ 62 days at once) and changes only the days the SMS named
--     (hours_sms_apply: regular days in shops.opening_hours, special days in shop_special_hours).
--   * The reply SMS and the phone code take the shop's monthly "owner" SMS quota (update 58).
--   * Google Business Profile: OAuth (scope business.manage), tokens only encrypted, one location per shop; the
--     function sends the regular and the special hours after each SMS change and on "Odoslať do Google teraz".
--
-- Paste the whole file into Supabase → SQL Editor → Run. Safe to run again. Needs updates 56, 57, 58 and 59.

-- ------------------------------------------------------------------ the owners' phones

create table if not exists public.shop_owner_phones (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references public.shops (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  phone           text not null check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  verified_at     timestamptz,
  code_hash       text,
  code_expires_at timestamptz,
  code_attempts   integer not null default 0,
  code_sends      integer not null default 0,
  last_code_at    timestamptz,
  created_at      timestamptz not null default now(),
  unique (shop_id, phone)
);
create index if not exists shop_owner_phones_phone_idx on public.shop_owner_phones (phone) where verified_at is not null;
alter table public.shop_owner_phones enable row level security;
revoke all on public.shop_owner_phones from public, anon, authenticated;
grant all on public.shop_owner_phones to service_role;
grant select (id, shop_id, user_id, phone, verified_at, created_at) on public.shop_owner_phones to authenticated;
drop policy if exists "shop_owner_phones: members read" on public.shop_owner_phones;
create policy "shop_owner_phones: members read" on public.shop_owner_phones
  for select to authenticated using (public.is_shop_member(shop_id));

-- ------------------------------------------------------------------ the received SMS

create table if not exists public.hours_sms_messages (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid references public.shops (id) on delete cascade,
  phone        text,
  phone_hash   text not null,
  body         text check (body is null or char_length(body) <= 1000),
  provider     text,
  provider_ref text,
  status       text not null default 'received'
               check (status in ('received', 'applied', 'unclear', 'not_hours', 'unknown_phone', 'which_shop', 'no_plan',
                                 'too_many', 'failed')),
  parsed       jsonb,
  reply        text,
  google       text not null default 'none' check (google in ('none', 'pushed', 'failed', 'not_connected')),
  error        text,
  received_at  timestamptz not null default now()
);
create index if not exists hours_sms_messages_shop_idx on public.hours_sms_messages (shop_id, received_at desc);
create index if not exists hours_sms_messages_phone_idx on public.hours_sms_messages (phone_hash, received_at desc);
create unique index if not exists hours_sms_messages_ref_key on public.hours_sms_messages (provider, provider_ref)
  where provider_ref is not null;
alter table public.hours_sms_messages enable row level security;
revoke all on public.hours_sms_messages from public, anon, authenticated;
grant all on public.hours_sms_messages to service_role;
grant select (id, shop_id, body, status, reply, google, received_at) on public.hours_sms_messages to authenticated;
drop policy if exists "hours_sms_messages: members read" on public.hours_sms_messages;
create policy "hours_sms_messages: members read" on public.hours_sms_messages
  for select to authenticated using (shop_id is not null and public.is_shop_member(shop_id));

-- ------------------------------------------------------------------ Google Business Profile

create table if not exists public.business_profile_connections (
  shop_id           uuid primary key references public.shops (id) on delete cascade,
  access_token_enc  text not null,
  refresh_token_enc text not null,
  access_expires_at timestamptz,
  scope             text,
  status            text not null default 'ok' check (status in ('ok', 'expired', 'error')),
  location_name     text check (location_name is null or location_name ~ '^locations/[0-9A-Za-z_-]{1,64}$'),
  location_title    text check (location_title is null or char_length(location_title) <= 200),
  last_error        text check (last_error is null or char_length(last_error) <= 500),
  last_push_at      timestamptz,
  connected_by      uuid,
  connected_at      timestamptz not null default now()
);
alter table public.business_profile_connections enable row level security;
revoke all on public.business_profile_connections from public, anon, authenticated;
grant all on public.business_profile_connections to service_role;
grant select (shop_id, status, location_name, location_title, last_error, last_push_at, connected_at)
  on public.business_profile_connections to authenticated;
drop policy if exists "business_profile_connections: members read" on public.business_profile_connections;
create policy "business_profile_connections: members read" on public.business_profile_connections
  for select to authenticated using (public.is_shop_member(shop_id));

create table if not exists public.business_oauth_states (
  state_hash text primary key,
  shop_id    uuid not null references public.shops (id) on delete cascade,
  user_id    uuid not null,
  verifier   text not null,
  return_url text not null,
  expires_at timestamptz not null
);
alter table public.business_oauth_states enable row level security;
revoke all on public.business_oauth_states from public, anon, authenticated;
grant all on public.business_oauth_states to service_role;

-- ------------------------------------------------------------------ the message log and the activity log

alter table public.shop_outgoing_messages drop constraint if exists shop_outgoing_messages_kind_check;
alter table public.shop_outgoing_messages add constraint shop_outgoing_messages_kind_check
  check (kind in ('owner', 'booking_code', 'booking_reminder', 'hours_reply', 'phone_code'));

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
                    'booking_calendar_connected', 'booking_calendar_disconnected',
                    'callback_requested', 'callback_done', 'callback_reopened',
                    'hours_phone_verified', 'hours_phone_removed', 'hours_sms_applied',
                    'business_connected', 'business_disconnected', 'business_location_set', 'business_pushed'));

-- ------------------------------------------------------------------ helpers

create or replace function public.hours_hash(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to('ppi-hours:' || coalesce(p_value, ''), 'UTF8')), 'hex')
$$;
revoke execute on function public.hours_hash(text) from public, anon, authenticated;
grant execute on function public.hours_hash(text) to service_role;

/** Opening hours {"mon": [["08:00","17:00"]], …}: only known days, each [] (closed) or valid ranges. */
create or replace function public.valid_week_hours(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_typeof(p) = 'object'
    and not exists (select 1 from jsonb_object_keys(p) k where k not in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'))
    and not exists (select 1 from jsonb_each(p) e
                    where not (e.value = '[]'::jsonb or public.valid_hour_ranges(e.value))), false)
$$;
grant execute on function public.valid_week_hours(jsonb) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ the owner adds and verifies a phone

/**
 * A new code for an owner's phone (the hours-sms function, with the owner's verified login as p_user_id): the caller
 * must be a member of the shop with the plan; a new number is added unverified. Refusals: phone, too_many (3 codes
 * an hour per phone, 10 per shop a day), no_plan, forbidden. Returns {id, phone, code} — the code goes only into the
 * SMS. Service role only.
 */
create or replace function public.hours_phone_start(p_user_id uuid, p_shop_id uuid, p_phone text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_country text;
  v_phone text;
  v_row public.shop_owner_phones%rowtype;
  v_code text := public.booking_new_code();
begin
  if not exists (select 1 from public.shop_members where shop_id = p_shop_id and user_id = p_user_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not public.shop_has_plan(p_shop_id) then raise exception 'no_plan' using errcode = 'P0001'; end if;
  select country into v_country from public.shops where id = p_shop_id;
  v_phone := public.crm_phone(p_phone, v_country);
  if v_phone is null then raise exception 'phone' using errcode = '22023'; end if;
  if (select count(*) from public.shop_owner_phones where shop_id = p_shop_id and last_code_at > now() - interval '1 day'
      and code_sends > 0) >= 10 then
    raise exception 'too_many' using errcode = '54000';
  end if;
  insert into public.shop_owner_phones (shop_id, user_id, phone) values (p_shop_id, p_user_id, v_phone)
  on conflict (shop_id, phone) do nothing;
  select * into v_row from public.shop_owner_phones where shop_id = p_shop_id and phone = v_phone for update;
  if v_row.last_code_at > now() - interval '1 hour' and v_row.code_sends >= 3 then
    raise exception 'too_many' using errcode = '54000';
  end if;
  update public.shop_owner_phones
  set user_id = case when verified_at is null then p_user_id else user_id end,
      code_hash = public.hours_hash(v_row.id::text || ':' || v_code),
      code_expires_at = now() + interval '10 minutes',
      code_attempts = 0,
      code_sends = case when last_code_at > now() - interval '1 hour' then code_sends + 1 else 1 end,
      last_code_at = now()
  where id = v_row.id;
  return jsonb_build_object('id', v_row.id, 'phone', v_phone, 'code', v_code);
end;
$$;
revoke execute on function public.hours_phone_start(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.hours_phone_start(uuid, uuid, text) to service_role;

/** The owner types the code: {ok} or {ok: false, reason: wrong_code (attempts_left) | expired | too_many_attempts}. */
create or replace function public.owner_phone_verify(p_id uuid, p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.shop_owner_phones%rowtype;
  v_code text := regexp_replace(coalesce(p_code, ''), '\D', '', 'g');
begin
  select * into v from public.shop_owner_phones where id = p_id for update;
  if not found or not public.is_shop_member(v.shop_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if v.verified_at is not null and v.code_hash is null then return jsonb_build_object('ok', true); end if;
  if v.code_hash is null or v.code_expires_at < now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if v.code_attempts >= 5 then return jsonb_build_object('ok', false, 'reason', 'too_many_attempts'); end if;
  if v.code_hash <> public.hours_hash(v.id::text || ':' || v_code) then
    update public.shop_owner_phones set code_attempts = code_attempts + 1 where id = p_id;
    if v.code_attempts + 1 >= 5 then
      update public.shop_owner_phones set code_hash = null where id = p_id;
      return jsonb_build_object('ok', false, 'reason', 'too_many_attempts');
    end if;
    return jsonb_build_object('ok', false, 'reason', 'wrong_code', 'attempts_left', 5 - (v.code_attempts + 1));
  end if;
  update public.shop_owner_phones
  set verified_at = now(), code_hash = null, code_expires_at = null, code_attempts = 0
  where id = p_id;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (v.shop_id, auth.uid(), 'hours_phone_verified', jsonb_build_object('phone_id', v.id));
  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.owner_phone_verify(uuid, text) from public, anon;
grant execute on function public.owner_phone_verify(uuid, text) to authenticated;

create or replace function public.owner_phone_remove(p_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.shop_owner_phones%rowtype;
begin
  select * into v from public.shop_owner_phones where id = p_id;
  if not found or not public.is_shop_member(v.shop_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.shop_owner_phones where id = p_id;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (v.shop_id, auth.uid(), 'hours_phone_removed', jsonb_build_object('phone_id', v.id));
  return true;
end;
$$;
revoke execute on function public.owner_phone_remove(uuid) from public, anon;
grant execute on function public.owner_phone_remove(uuid) to authenticated;

-- ------------------------------------------------------------------ a received SMS (service role: hours-sms)

/**
 * Writes a received SMS down and says whose it is: the shops whose owner verified that phone (with the plan, the
 * owner still a member). An unknown number keeps no text (only a hash of it). A repeat of the same provider message
 * → {duplicate: true}. More than 10 SMS an hour from one phone → status too_many, no shops.
 */
create or replace function public.hours_sms_receive(p_phone text, p_body text, p_provider text, p_ref text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_phone text := public.crm_phone(p_phone, null);
  v_hash text := public.hours_hash(coalesce(public.crm_phone(p_phone, null), btrim(coalesce(p_phone, ''))));
  v_id uuid;
  v_shops jsonb;
  v_status text := 'received';
begin
  if p_ref is not null and exists (select 1 from public.hours_sms_messages where provider = left(p_provider, 40)
                                                                            and provider_ref = left(p_ref, 200)) then
    return jsonb_build_object('duplicate', true);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('shop_id', s.id, 'name', s.name, 'slug', s.slug, 'timezone', s.timezone,
                                               'opening_hours', s.opening_hours, 'user_id', p.user_id)
                            order by s.name), '[]'::jsonb)
  into v_shops
  from public.shop_owner_phones p
  join public.shops s on s.id = p.shop_id
  where v_phone is not null and p.phone = v_phone and p.verified_at is not null and s.is_active
    and public.shop_has_plan(s.id)
    and exists (select 1 from public.shop_members m where m.shop_id = s.id and m.user_id = p.user_id);
  if (select count(*) from public.hours_sms_messages where phone_hash = v_hash and received_at > now() - interval '1 hour') >= 10 then
    v_status := 'too_many';
    v_shops := '[]'::jsonb;
  elsif jsonb_array_length(v_shops) = 0 then
    v_status := 'unknown_phone';
  end if;
  insert into public.hours_sms_messages (shop_id, phone, phone_hash, body, provider, provider_ref, status)
  values (case when jsonb_array_length(v_shops) = 1 then (v_shops -> 0 ->> 'shop_id')::uuid end,
          case when jsonb_array_length(v_shops) > 0 then v_phone end, v_hash,
          case when jsonb_array_length(v_shops) > 0 then left(coalesce(p_body, ''), 1000) end,
          left(p_provider, 40), left(p_ref, 200), v_status)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'status', v_status, 'phone', v_phone, 'shops', v_shops);
end;
$$;
revoke execute on function public.hours_sms_receive(text, text, text, text) from public, anon, authenticated;
grant execute on function public.hours_sms_receive(text, text, text, text) to service_role;

/** What came of a received SMS (the shop it was for, what was read, the reply, Google). */
create or replace function public.hours_sms_result(
  p_id uuid, p_shop_id uuid, p_status text, p_parsed jsonb, p_reply text, p_google text, p_error text
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.hours_sms_messages
  set shop_id = coalesce(p_shop_id, shop_id), status = p_status, parsed = p_parsed, reply = left(p_reply, 480),
      google = coalesce(p_google, google), error = left(p_error, 300)
  where id = p_id
$$;
revoke execute on function public.hours_sms_result(uuid, uuid, text, jsonb, text, text, text) from public, anon, authenticated;
grant execute on function public.hours_sms_result(uuid, uuid, text, jsonb, text, text, text) to service_role;

/**
 * Changes only the days the SMS named: p_regular {"mon": [["08:00","17:00"]], "sun": []} merged into
 * shops.opening_hours; p_special [{from, to, closed, ranges}] into shop_special_hours (yesterday … +400 days, ≤ 62
 * days a row, ≤ 10 rows). Refusals: hours (bad regular hours), dates, ranges, empty. Logged as hours_sms_applied.
 * Returns the shop's new opening_hours. Service role only.
 */
create or replace function public.hours_sms_apply(p_shop_id uuid, p_user_id uuid, p_regular jsonb, p_special jsonb, p_sms_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_regular jsonb := coalesce(p_regular, '{}'::jsonb);
  v_special jsonb := coalesce(p_special, '[]'::jsonb);
  v_row jsonb;
  v_from date;
  v_to date;
  v_closed boolean;
  v_ranges jsonb;
  v_days integer := 0;
  v_hours jsonb;
begin
  if not public.valid_week_hours(v_regular) then raise exception 'hours' using errcode = '22023'; end if;
  if jsonb_typeof(v_special) <> 'array' or jsonb_array_length(v_special) > 10 then
    raise exception 'dates' using errcode = '22023';
  end if;
  if v_regular = '{}'::jsonb and jsonb_array_length(v_special) = 0 then raise exception 'empty' using errcode = '22023'; end if;
  for v_row in select * from jsonb_array_elements(v_special) loop
    begin
      v_from := (v_row ->> 'from')::date;
      v_to := coalesce((v_row ->> 'to')::date, v_from);
    exception when others then
      raise exception 'dates' using errcode = '22023';
    end;
    v_closed := coalesce((v_row ->> 'closed')::boolean, false);
    v_ranges := case when v_closed then '[]'::jsonb else coalesce(v_row -> 'ranges', '[]'::jsonb) end;
    if v_from is null or v_to < v_from or v_to - v_from > 61 or v_from < current_date - 1 or v_to > current_date + 400 then
      raise exception 'dates' using errcode = '22023';
    end if;
    if not v_closed and not public.valid_hour_ranges(v_ranges) then raise exception 'ranges' using errcode = '22023'; end if;
  end loop;

  update public.shops set opening_hours = coalesce(opening_hours, '{}'::jsonb) || v_regular
  where id = p_shop_id
  returning opening_hours into v_hours;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  for v_row in select * from jsonb_array_elements(v_special) loop
    v_from := (v_row ->> 'from')::date;
    v_to := coalesce((v_row ->> 'to')::date, v_from);
    v_closed := coalesce((v_row ->> 'closed')::boolean, false);
    v_ranges := case when v_closed then '[]'::jsonb else v_row -> 'ranges' end;
    insert into public.shop_special_hours (shop_id, date, closed, ranges, note)
    select p_shop_id, d::date, v_closed, v_ranges, null
    from generate_series(v_from::timestamp, v_to::timestamp, interval '1 day') d
    on conflict (shop_id, date) do update
      set closed = excluded.closed, ranges = excluded.ranges, updated_at = now();
    v_days := v_days + (v_to - v_from + 1);
  end loop;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, p_user_id, 'hours_sms_applied',
          jsonb_build_object('sms_id', p_sms_id, 'regular_days', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(v_regular) k),
                             'special_days', v_days));
  return v_hours;
end;
$$;
revoke execute on function public.hours_sms_apply(uuid, uuid, jsonb, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.hours_sms_apply(uuid, uuid, jsonb, jsonb, uuid) to service_role;

/** A reply SMS or a phone code, written down first and taking the shop's "owner" quota (update 58). */
create or replace function public.hours_sms_claim(p_shop_id uuid, p_phone text, p_kind text, p_body text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_parts integer := public.crm_sms_parts(left(p_body, 480));
  v_id uuid;
begin
  if p_kind not in ('hours_reply', 'phone_code') then raise exception 'kind' using errcode = '22023'; end if;
  if p_phone !~ '^\+[1-9][0-9]{6,14}$' then raise exception 'phone' using errcode = '22023'; end if;
  perform public.sms_quota_take(p_shop_id, 'owner', v_parts);
  insert into public.shop_outgoing_messages (shop_id, channel, recipient, body, status, kind, parts)
  values (p_shop_id, 'sms', p_phone,
          case when p_kind = 'phone_code' then regexp_replace(left(p_body, 480), '\d{6}', '••••••', 'g') else left(p_body, 480) end,
          'queued', p_kind, v_parts)
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.hours_sms_claim(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.hours_sms_claim(uuid, text, text, text) to service_role;

create or replace function public.hours_sms_settle(p_id uuid, p_status text, p_provider text, p_ref text, p_error text)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  with u as (
    update public.shop_outgoing_messages
    set status = p_status, provider = left(p_provider, 40), provider_ref = left(p_ref, 200), error = left(p_error, 500),
        sent_at = case when p_status = 'sent' then now() end
    where id = p_id and status = 'queued' and kind in ('hours_reply', 'phone_code') and p_status in ('sent', 'failed', 'test')
    returning 1)
  select exists (select 1 from u)
$$;
revoke execute on function public.hours_sms_settle(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.hours_sms_settle(uuid, text, text, text, text) to service_role;

/** The shop's special days from today on (for Google's specialHours), at most 100. */
create or replace function public.hours_special_days(p_shop_id uuid)
returns table (date date, closed boolean, ranges jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select h.date, h.closed, h.ranges from public.shop_special_hours h
  join public.shops s on s.id = h.shop_id
  where h.shop_id = p_shop_id and h.date >= (now() at time zone coalesce(s.timezone, 'UTC'))::date
  order by h.date limit 100
$$;
revoke execute on function public.hours_special_days(uuid) from public, anon, authenticated;
grant execute on function public.hours_special_days(uuid) to service_role;

-- ------------------------------------------------------------------ Google Business Profile (service role)

create or replace function public.business_oauth_begin(p_shop_id uuid, p_user_id uuid, p_state_hash text, p_verifier text, p_return_url text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  delete from public.business_oauth_states where expires_at < now();
  insert into public.business_oauth_states (state_hash, shop_id, user_id, verifier, return_url, expires_at)
  values (p_state_hash, p_shop_id, p_user_id, p_verifier, p_return_url, now() + interval '10 minutes');
$$;

create or replace function public.business_oauth_take(p_state_hash text)
returns table (shop_id uuid, user_id uuid, verifier text, return_url text)
language sql
volatile
security definer
set search_path = ''
as $$
  delete from public.business_oauth_states s
  where s.state_hash = p_state_hash and s.expires_at >= now()
  returning s.shop_id, s.user_id, s.verifier, s.return_url
$$;

create or replace function public.business_save(
  p_shop_id uuid, p_access_enc text, p_refresh_enc text, p_expires_at timestamptz, p_scope text, p_user_id uuid
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.business_profile_connections (shop_id, access_token_enc, refresh_token_enc, access_expires_at, scope, connected_by)
  values (p_shop_id, p_access_enc, p_refresh_enc, p_expires_at, left(p_scope, 400), p_user_id)
  on conflict (shop_id) do update
    set access_token_enc = excluded.access_token_enc, refresh_token_enc = excluded.refresh_token_enc,
        access_expires_at = excluded.access_expires_at, scope = excluded.scope, status = 'ok', last_error = null,
        connected_by = excluded.connected_by, connected_at = now();
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, p_user_id, 'business_connected', '{}'::jsonb);
$$;

create or replace function public.business_token(p_shop_id uuid)
returns table (access_token_enc text, refresh_token_enc text, access_expires_at timestamptz, status text,
               location_name text, location_title text)
language sql
stable
security definer
set search_path = ''
as $$
  select access_token_enc, refresh_token_enc, access_expires_at, status, location_name, location_title
  from public.business_profile_connections where shop_id = p_shop_id
$$;

create or replace function public.business_refreshed(p_shop_id uuid, p_access_enc text, p_expires_at timestamptz)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.business_profile_connections
  set access_token_enc = p_access_enc, access_expires_at = p_expires_at, status = 'ok', last_error = null
  where shop_id = p_shop_id
$$;

create or replace function public.business_failed(p_shop_id uuid, p_status text, p_error text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.business_profile_connections
  set status = case when p_status in ('expired', 'error') then p_status else 'error' end, last_error = left(p_error, 500)
  where shop_id = p_shop_id
$$;

create or replace function public.business_pushed(p_shop_id uuid, p_user_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.business_profile_connections set last_push_at = now(), last_error = null, status = 'ok' where shop_id = p_shop_id;
  insert into public.shop_activity (shop_id, actor, action, details) values (p_shop_id, p_user_id, 'business_pushed', '{}'::jsonb);
$$;

create or replace function public.business_set_location(p_shop_id uuid, p_user_id uuid, p_name text, p_title text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_name !~ '^locations/[0-9A-Za-z_-]{1,64}$' then raise exception 'location' using errcode = '22023'; end if;
  update public.business_profile_connections set location_name = p_name, location_title = left(p_title, 200)
  where shop_id = p_shop_id;
  if not found then raise exception 'not_connected' using errcode = 'P0002'; end if;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, p_user_id, 'business_location_set', jsonb_build_object('title', left(p_title, 200)));
end;
$$;

create or replace function public.business_remove(p_shop_id uuid, p_user_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  delete from public.business_profile_connections where shop_id = p_shop_id;
  insert into public.shop_activity (shop_id, actor, action, details) values (p_shop_id, p_user_id, 'business_disconnected', '{}'::jsonb);
$$;

revoke execute on function public.business_oauth_begin(uuid, uuid, text, text, text), public.business_oauth_take(text),
  public.business_save(uuid, text, text, timestamptz, text, uuid), public.business_token(uuid),
  public.business_refreshed(uuid, text, timestamptz), public.business_failed(uuid, text, text),
  public.business_pushed(uuid, uuid), public.business_set_location(uuid, uuid, text, text),
  public.business_remove(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.business_oauth_begin(uuid, uuid, text, text, text), public.business_oauth_take(text),
  public.business_save(uuid, text, text, timestamptz, text, uuid), public.business_token(uuid),
  public.business_refreshed(uuid, text, timestamptz), public.business_failed(uuid, text, text),
  public.business_pushed(uuid, uuid), public.business_set_location(uuid, uuid, text, text),
  public.business_remove(uuid, uuid)
  to service_role;
