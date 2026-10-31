-- =====================================================================================================================
-- Update 63 — "Asistent + CRM + Rezervácie" (2026-10-31, at the owner's request)
--
-- Run it in Supabase → SQL Editor (Claude applies it with the Supabase connector). Running it again changes nothing.
-- Needs updates 55–61 (conversations, contacts, bookings, SMS quotas, unanswered questions, the owner's MCP).
--
-- Cacaduu's own booking system is the source of truth and works with no outside calendar. EVERY booking rule lives in
-- the SQL functions below, so the website, the shop assistant, the MCP connector and a future app use the same ones;
-- Google Calendar is only an optional sync (pushed out, busy times read in, never decisive).
--
-- 1. CRM: contacts know when they were last in touch and whether they wait for a reply; conversations remember the
--    contact verified with an SMS code; the owner's SMS / e-mail replies are part of the conversation; one SMS-code
--    table for every purpose (contact, booking, "Všetko o mne"); message templates for SMS and e-mail with {meno}
--    {obchod} {produkt} {datum} {cas}; the shop's CRM settings (reminders, the alert address, messages when the owner
--    moves or cancels); conversations are kept until the owner deletes them (the keep-time job is gone).
-- 2. Bookings: services (length, buffers, capacity, resource), resources (person, machine, room; own hours), the shop's
--    rules (notice, how far ahead, step, bookings per contact a day), blocked times, an audit log, ONE availability
--    function booking_free_slots() (opening hours ∩ resource hours − special days − holidays − blocks − bookings with
--    their buffers − busy calendar times), booking_create() / owner_booking_move() check it again under a lock, and no
--    double booking is possible (an exclusion constraint per lane; capacity counted under an advisory lock).
-- 3. A read-only calendar feed per shop (a secret link; only its hash is kept).
-- =====================================================================================================================

create extension if not exists btree_gist with schema extensions;

-- ------------------------------------------------------------------ 1. CRM: contacts and conversations

alter table public.shop_contacts
  add column if not exists last_contact_at timestamptz,
  add column if not exists needs_reply boolean not null default false;
create index if not exists shop_contacts_reply_idx on public.shop_contacts (shop_id) where needs_reply;

alter table public.assistant_conversations
  -- the contact whose number was checked with an SMS code in this conversation (the assistant may then book for it)
  add column if not exists contact_verified_at timestamptz,
  add column if not exists contact_consent_version text check (contact_consent_version is null
                                                               or char_length(contact_consent_version) <= 40);
grant select (contact_verified_at) on public.assistant_conversations to authenticated;

-- The owner's SMS / e-mail replies belong to the conversation they answer.
alter table public.assistant_messages
  add column if not exists channel text check (channel is null or channel in ('sms', 'email')),
  add column if not exists template_id uuid references public.shop_email_templates (id) on delete set null,
  add column if not exists outgoing_id uuid references public.shop_outgoing_messages (id) on delete set null;
alter table public.assistant_messages drop constraint if exists assistant_messages_role_check;
alter table public.assistant_messages add constraint assistant_messages_role_check
  check (role in ('shopper', 'assistant', 'owner'));

/** A contact waits for a reply while one of its conversations has a contact left and no answer yet. */
create or replace function public.crm_contact_reply_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.shop_contacts k
  set needs_reply = exists (select 1 from public.assistant_conversations c
                            where c.contact_id = k.id and c.callback_at is not null and c.callback_answered_at is null),
      last_contact_at = greatest(k.last_contact_at,
                                 (select max(c.last_message_at) from public.assistant_conversations c where c.contact_id = k.id))
  where k.id in (new.contact_id, case when tg_op = 'UPDATE' then old.contact_id end);
  return null;
end;
$$;
drop trigger if exists assistant_conversations_reply_sync on public.assistant_conversations;
create trigger assistant_conversations_reply_sync
  after insert or update of contact_id, callback_at, callback_answered_at, last_message_at on public.assistant_conversations
  for each row execute function public.crm_contact_reply_sync();

-- the contacts that wait today
update public.shop_contacts k
set needs_reply = exists (select 1 from public.assistant_conversations c
                          where c.contact_id = k.id and c.callback_at is not null and c.callback_answered_at is null),
    last_contact_at = coalesce(k.last_contact_at,
                               (select max(c.last_message_at) from public.assistant_conversations c where c.contact_id = k.id))
where true;

-- ------------------------------------------------------------------ conversations are kept until the owner deletes them

-- The nightly keep-time job is gone (the column retention_days stays, unused); the function it asked returns nothing.
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'cron' and p.proname = 'unschedule')
     and to_regclass('cron.job') is not null then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'ppi-assistant-retention';
  end if;
end;
$$;

create or replace function public.assistant_expired(p_limit integer default 200)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select null::uuid where false
$$;
revoke execute on function public.assistant_expired(integer) from public, anon, authenticated;
grant execute on function public.assistant_expired(integer) to service_role;

-- ------------------------------------------------------------------ message templates for SMS and e-mail

alter table public.shop_email_templates
  add column if not exists channel text not null default 'email';
alter table public.shop_email_templates drop constraint if exists shop_email_templates_channel_check;
alter table public.shop_email_templates add constraint shop_email_templates_channel_check
  check (channel in ('sms', 'email', 'both'));
alter table public.shop_email_templates alter column subject drop not null;
alter table public.shop_email_templates drop constraint if exists shop_email_templates_subject_check;
alter table public.shop_email_templates add constraint shop_email_templates_subject_check
  check (subject is null or char_length(btrim(subject)) between 1 and 200);
alter table public.shop_email_templates drop constraint if exists shop_email_templates_subject_needed;
alter table public.shop_email_templates add constraint shop_email_templates_subject_needed
  check (channel = 'sms' or subject is not null);

/**
 * Fills a template or a typed text: {{name}} {{first_name}} {{shop}} {{shop_phone}} {{shop_email}} {{shop_address}}
 * {{shop_web}} (update 56) and the Slovak ones of update 63: {meno} {obchod} {produkt} {datum} {cas}. {datum} {cas} =
 * the contact's next confirmed booking in the shop's time zone (empty without one); {produkt} = p_extra.produkt;
 * p_extra may also set datum / cas. Nothing else is ever filled in.
 */
create or replace function public.crm_render(p_text text, p_contact_id uuid, p_shop_id uuid, p_extra jsonb)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_contact public.shop_contacts%rowtype;
  v_shop public.shops%rowtype;
  v text := coalesce(p_text, '');
  v_pair record;
  v_next timestamptz;
begin
  select * into v_contact from public.shop_contacts where id = p_contact_id and shop_id = p_shop_id;
  select * into v_shop from public.shops where id = p_shop_id;
  select b.starts_at into v_next from public.shop_bookings b
  where b.contact_id = p_contact_id and b.shop_id = p_shop_id and b.status = 'confirmed' and b.starts_at > now()
  order by b.starts_at limit 1;
  for v_pair in
    select * from (values
      ('name', coalesce(v_contact.name, '')),
      ('first_name', coalesce(split_part(btrim(v_contact.name), ' ', 1), '')),
      ('shop', coalesce(v_shop.name, '')),
      ('shop_phone', coalesce(v_shop.phone, '')),
      ('shop_email', coalesce(v_shop.email, '')),
      ('shop_address', concat_ws(', ', nullif(v_shop.address, ''), nullif(v_shop.city, ''))),
      ('shop_web', coalesce(v_shop.website, ''))
    ) as p(k, val)
  loop
    v := regexp_replace(v, '\{\{\s*' || v_pair.k || '\s*\}\}', replace(v_pair.val, '\', '\\'), 'gi');
  end loop;
  for v_pair in
    select * from (values
      ('meno', coalesce(v_contact.name, '')),
      ('obchod', coalesce(v_shop.name, '')),
      ('produkt', coalesce(p_extra ->> 'produkt', '')),
      ('datum', coalesce(p_extra ->> 'datum',
                         case when v_next is not null then to_char(v_next at time zone v_shop.timezone, 'FMDD.FMMM.YYYY') end, '')),
      ('cas', coalesce(p_extra ->> 'cas',
                       case when v_next is not null then to_char(v_next at time zone v_shop.timezone, 'FMHH24:MI') end, ''))
    ) as p(k, val)
  loop
    v := regexp_replace(v, '\{\s*' || v_pair.k || '\s*\}', replace(left(v_pair.val, 200), '\', '\\'), 'gi');
  end loop;
  return v;
end;
$$;
revoke execute on function public.crm_render(text, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.crm_render(text, uuid, uuid, jsonb) to service_role;

create or replace function public.crm_render(p_text text, p_contact_id uuid, p_shop_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select public.crm_render(p_text, p_contact_id, p_shop_id, '{}'::jsonb)
$$;
revoke execute on function public.crm_render(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.crm_render(text, uuid, uuid) to service_role;

/** "Šablóny": a template for SMS, e-mail or both (name ≤ 60, text ≤ 1000; an e-mail needs a subject). */
create or replace function public.owner_save_message_template(
  p_shop_id uuid, p_id uuid, p_name text, p_channel text, p_subject text, p_body text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_subject text := nullif(btrim(coalesce(p_subject, '')), '');
  v_body text := btrim(coalesce(p_body, ''));
  v_id uuid;
begin
  perform public.crm_owner_check(p_shop_id);
  if char_length(v_name) not between 1 and 60 then raise exception 'name' using errcode = '22023'; end if;
  if p_channel is null or p_channel not in ('sms', 'email', 'both') then raise exception 'channel' using errcode = '22023'; end if;
  if char_length(v_body) not between 1 and 1000 then raise exception 'body' using errcode = '22023'; end if;
  if p_channel <> 'sms' and (v_subject is null or char_length(v_subject) > 200) then
    raise exception 'subject' using errcode = '22023';
  end if;
  if p_channel = 'sms' then v_subject := null; end if;
  if p_id is null then
    if (select count(*) from public.shop_email_templates where shop_id = p_shop_id) >= 50 then
      raise exception 'too_many' using errcode = '54000';
    end if;
    begin
      insert into public.shop_email_templates (shop_id, name, channel, subject, body)
      values (p_shop_id, v_name, p_channel, v_subject, v_body)
      returning id into v_id;
    exception when unique_violation then
      raise exception 'duplicate' using errcode = '23505';
    end;
  else
    begin
      update public.shop_email_templates
      set name = v_name, channel = p_channel, subject = v_subject, body = v_body, updated_at = now()
      where id = p_id and shop_id = p_shop_id
      returning id into v_id;
    exception when unique_violation then
      raise exception 'duplicate' using errcode = '23505';
    end;
    if v_id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  end if;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'email_template_saved', jsonb_build_object('template_id', v_id, 'channel', p_channel));
  return v_id;
end;
$$;
revoke execute on function public.owner_save_message_template(uuid, uuid, text, text, text, text) from public, anon;
grant execute on function public.owner_save_message_template(uuid, uuid, text, text, text, text) to authenticated, service_role;

-- ------------------------------------------------------------------ the shop's CRM settings

create table if not exists public.crm_settings (
  shop_id                uuid primary key references public.shops (id) on delete cascade,
  reminder_on            boolean not null default false,
  -- '2h' = two hours before; 'day_before_18' = the day before from 18:00 (the shop's time)
  reminder_offset        text not null default 'day_before_18' check (reminder_offset in ('2h', 'day_before_18')),
  -- where "Zákazník čaká na odpoveď" goes; null = every owner of the shop
  alert_email            text check (alert_email is null or (char_length(alert_email) <= 254
                                                             and alert_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  -- an SMS to the customer when the owner moves or cancels a booking
  notify_on_owner_change boolean not null default true,
  updated_at             timestamptz not null default now()
);
alter table public.crm_settings enable row level security;
revoke all on public.crm_settings from public, anon, authenticated;
grant all on public.crm_settings to service_role;
grant select on public.crm_settings to authenticated;
drop policy if exists "crm_settings: members read" on public.crm_settings;
create policy "crm_settings: members read" on public.crm_settings
  for select to authenticated using (public.is_shop_member(shop_id));

-- shops that had the day-before reminder on keep it (it now goes from 18:00 the day before)
insert into public.crm_settings (shop_id, reminder_on)
select shop_id, true from public.shop_booking_settings where reminder
on conflict (shop_id) do nothing;

create or replace function public.crm_settings_of(p_shop_id uuid)
returns public.crm_settings
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select c from public.crm_settings c where c.shop_id = p_shop_id),
                  row(p_shop_id, false, 'day_before_18', null, true, now())::public.crm_settings)
$$;
revoke execute on function public.crm_settings_of(uuid) from public, anon, authenticated;
grant execute on function public.crm_settings_of(uuid) to service_role;

create or replace function public.owner_save_crm_settings(
  p_shop_id uuid, p_reminder_on boolean, p_reminder_offset text, p_alert_email text, p_notify_on_owner_change boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text := nullif(lower(btrim(coalesce(p_alert_email, ''))), '');
begin
  perform public.crm_owner_check(p_shop_id);
  if coalesce(p_reminder_offset, 'day_before_18') not in ('2h', 'day_before_18') then
    raise exception 'offset' using errcode = '22023';
  end if;
  if v_email is not null and (char_length(v_email) > 254 or v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'email' using errcode = '22023';
  end if;
  insert into public.crm_settings (shop_id, reminder_on, reminder_offset, alert_email, notify_on_owner_change, updated_at)
  values (p_shop_id, coalesce(p_reminder_on, false), coalesce(p_reminder_offset, 'day_before_18'), v_email,
          coalesce(p_notify_on_owner_change, true), now())
  on conflict (shop_id) do update
    set reminder_on = excluded.reminder_on, reminder_offset = excluded.reminder_offset, alert_email = excluded.alert_email,
        notify_on_owner_change = excluded.notify_on_owner_change, updated_at = now();
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'crm_settings_saved',
          jsonb_build_object('reminder_on', coalesce(p_reminder_on, false), 'offset', coalesce(p_reminder_offset, 'day_before_18'),
                             'notify', coalesce(p_notify_on_owner_change, true)));
end;
$$;
revoke execute on function public.owner_save_crm_settings(uuid, boolean, text, text, boolean) from public, anon;
grant execute on function public.owner_save_crm_settings(uuid, boolean, text, text, boolean) to authenticated, service_role;

-- ------------------------------------------------------------------ the activity log's and the message log's new kinds

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
                    'business_connected', 'business_disconnected', 'business_location_set', 'business_pushed',
                    'mcp_connected', 'mcp_disconnected', 'mcp_key_created', 'mcp_message_queued',
                    'hours_changed', 'shop_details_changed', 'stock_edited',
                    'crm_settings_saved', 'booking_service_saved', 'booking_service_removed',
                    'booking_resource_saved', 'booking_resource_removed', 'booking_rules_saved',
                    'booking_block_saved', 'booking_block_removed', 'booking_created', 'booking_moved',
                    'booking_cancelled', 'calendar_feed_created', 'calendar_feed_removed', 'shopper_forgot_all'));

alter table public.shop_outgoing_messages drop constraint if exists shop_outgoing_messages_kind_check;
alter table public.shop_outgoing_messages add constraint shop_outgoing_messages_kind_check
  check (kind in ('owner', 'booking_code', 'booking_reminder', 'hours_reply', 'phone_code', 'sms_code',
                  'booking_moved', 'booking_cancelled'));

alter table public.shop_owner_alerts add column if not exists resolved_at timestamptz;
alter table public.shop_owner_alerts drop constraint if exists shop_owner_alerts_kind_check;
alter table public.shop_owner_alerts add constraint shop_owner_alerts_kind_check check (kind in ('callback', 'forget_all'));

-- ------------------------------------------------------------------ 2. booking engine: rules, services, resources, blocks

-- The shop's rules (update 57's settings + bookings per contact a day). Step 5/10/15/30 for new choices.
alter table public.shop_booking_settings
  add column if not exists max_per_contact_day integer not null default 2 check (max_per_contact_day between 1 and 20);
alter table public.shop_booking_settings alter column step_minutes set default 15;

create or replace function public.booking_settings_of(p_shop_id uuid)
returns public.shop_booking_settings
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s from public.shop_booking_settings s where s.shop_id = p_shop_id),
                  row(p_shop_id, false, null, 30, 15, 0, 120, 30, false, now(), 2)::public.shop_booking_settings)
$$;
revoke execute on function public.booking_settings_of(uuid) from public, anon, authenticated;
grant execute on function public.booking_settings_of(uuid) to service_role;

create table if not exists public.booking_services (
  id                   uuid primary key default gen_random_uuid(),
  shop_id              uuid not null references public.shops (id) on delete cascade,
  name                 text not null check (char_length(btrim(name)) between 1 and 80),
  duration_minutes     integer not null default 30 check (duration_minutes between 5 and 480),
  buffer_before        integer not null default 0 check (buffer_before between 0 and 120),
  buffer_after         integer not null default 0 check (buffer_after between 0 and 120),
  -- how many people at the same start (a course: 8; a haircut: 1)
  capacity             integer not null default 1 check (capacity between 1 and 500),
  needs_resource       boolean not null default false,
  active               boolean not null default true,
  offered_by_assistant boolean not null default true,
  -- shown as the owner wrote it
  note                 text check (note is null or char_length(note) <= 500),
  position             integer not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists booking_services_shop_idx on public.booking_services (shop_id, position);

create table if not exists public.booking_resources (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops (id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 80),
  kind       text not null default 'person' check (kind in ('person', 'machine', 'room')),
  active     boolean not null default true,
  -- own weekly hours like shops.opening_hours ({"mon": [["08:00","12:00"]], …}); null = the shop's opening hours
  hours      jsonb check (hours is null or jsonb_typeof(hours) = 'object'),
  position   integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists booking_resources_shop_idx on public.booking_resources (shop_id, position);

create table if not exists public.booking_service_resources (
  service_id  uuid not null references public.booking_services (id) on delete cascade,
  resource_id uuid not null references public.booking_resources (id) on delete cascade,
  primary key (service_id, resource_id)
);
create index if not exists booking_service_resources_resource_idx on public.booking_service_resources (resource_id);

create table if not exists public.booking_blocks (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops (id) on delete cascade,
  -- null = the whole shop
  resource_id uuid references public.booking_resources (id) on delete cascade,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  note        text check (note is null or char_length(note) <= 200),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  constraint booking_blocks_order check (ends_at > starts_at)
);
create index if not exists booking_blocks_shop_idx on public.booking_blocks (shop_id, starts_at);

-- busy times read in from a connected calendar (never shown, never decisive alone; replaced on every read)
create table if not exists public.booking_calendar_busy (
  id          bigint generated always as identity primary key,
  shop_id     uuid not null references public.shops (id) on delete cascade,
  resource_id uuid references public.booking_resources (id) on delete cascade,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  source      text not null default 'google' check (source in ('google', 'outlook')),
  fetched_at  timestamptz not null default now(),
  constraint booking_calendar_busy_order check (ends_at > starts_at)
);
create index if not exists booking_calendar_busy_shop_idx on public.booking_calendar_busy (shop_id, starts_at);

do $$
declare
  t text;
begin
  foreach t in array array['booking_services', 'booking_resources', 'booking_blocks', 'booking_calendar_busy'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists "%s: members read" on public.%I', t, t);
    execute format('create policy "%s: members read" on public.%I for select to authenticated using (public.is_shop_member(shop_id))', t, t);
  end loop;
end;
$$;
alter table public.booking_service_resources enable row level security;
revoke all on public.booking_service_resources from public, anon, authenticated;
grant all on public.booking_service_resources to service_role;
grant select on public.booking_service_resources to authenticated;
drop policy if exists "booking_service_resources: members read" on public.booking_service_resources;
create policy "booking_service_resources: members read" on public.booking_service_resources
  for select to authenticated using (exists (select 1 from public.booking_services s
                                             where s.id = service_id and public.is_shop_member(s.shop_id)));

-- every shop that has booking settings gets its one service from them (what was booked so far), once
insert into public.booking_services (shop_id, name, duration_minutes, buffer_before, buffer_after)
select st.shop_id, coalesce(st.service_name, 'Rezervácia'), st.duration_minutes, st.buffer_minutes, st.buffer_minutes
from public.shop_booking_settings st
where not exists (select 1 from public.booking_services s where s.shop_id = st.shop_id);

-- ------------------------------------------------------------------ bookings: services, resources, people, lanes

alter table public.shop_bookings
  add column if not exists service_id    uuid references public.booking_services (id) on delete set null,
  add column if not exists resource_id   uuid references public.booking_resources (id) on delete set null,
  add column if not exists people        integer not null default 1 check (people between 1 and 500),
  add column if not exists source        text not null default 'assistant' check (source in ('assistant', 'owner', 'app', 'api')),
  add column if not exists created_by    uuid,
  add column if not exists buffer_before integer not null default 0 check (buffer_before between 0 and 120),
  add column if not exists buffer_after  integer not null default 0 check (buffer_after between 0 and 120),
  -- capacity 1: no other booking may overlap on the lane (the exclusion constraint below)
  add column if not exists exclusive     boolean not null default true,
  -- the lane = the resource, or the shop itself for a service without a resource
  add column if not exists lane          uuid,
  -- the time the booking holds, its buffers included
  add column if not exists busy_from     timestamptz,
  add column if not exists busy_to       timestamptz,
  add column if not exists updated_at    timestamptz;

-- bookings made by the owner, the assistant after an SMS code, the app or the API have no booking token or form consent
alter table public.shop_bookings alter column token_hash drop not null;
alter table public.shop_bookings alter column phone drop not null;
alter table public.shop_bookings alter column consent_at drop not null;
alter table public.shop_bookings alter column consent_version drop not null;
alter table public.shop_bookings drop constraint if exists shop_bookings_status_check;
alter table public.shop_bookings add constraint shop_bookings_status_check
  check (status in ('pending', 'confirmed', 'cancelled', 'done', 'no_show', 'expired'));

create or replace function public.shop_bookings_lane()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.lane := coalesce(new.resource_id, new.shop_id);
  new.busy_from := new.starts_at - make_interval(mins => new.buffer_before);
  new.busy_to := new.ends_at + make_interval(mins => new.buffer_after);
  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end;
$$;
drop trigger if exists shop_bookings_lane on public.shop_bookings;
create trigger shop_bookings_lane before insert or update on public.shop_bookings
  for each row execute function public.shop_bookings_lane();

update public.shop_bookings set lane = null where lane is null or busy_from is null;
alter table public.shop_bookings alter column lane set not null;
alter table public.shop_bookings alter column busy_from set not null;
alter table public.shop_bookings alter column busy_to set not null;

-- update 57's one-per-shop rule becomes one per lane, with the buffers
alter table public.shop_bookings drop constraint if exists shop_bookings_no_overlap;
alter table public.shop_bookings drop constraint if exists shop_bookings_lane_no_overlap;
alter table public.shop_bookings add constraint shop_bookings_lane_no_overlap
  exclude using gist (lane with =, tstzrange(busy_from, busy_to, '[)') with &&)
  where (exclusive and status in ('pending', 'confirmed'));
create index if not exists shop_bookings_lane_idx on public.shop_bookings (lane, busy_from);

grant select (service_id, resource_id, people, source, created_by, buffer_before, buffer_after, updated_at)
  on public.shop_bookings to authenticated;

-- every change of a booking, with who and the times (no personal data: kept after "Vymazať moje údaje")
create table if not exists public.booking_events (
  id          bigint generated always as identity primary key,
  shop_id     uuid not null references public.shops (id) on delete cascade,
  booking_id  uuid references public.shop_bookings (id) on delete set null,
  kind        text not null check (kind in ('created', 'moved', 'cancelled', 'status', 'forgotten')),
  actor       uuid,
  actor_kind  text not null check (actor_kind in ('owner', 'shopper', 'assistant', 'app', 'api', 'system')),
  old_starts  timestamptz,
  new_starts  timestamptz,
  old_status  text,
  new_status  text,
  at          timestamptz not null default now()
);
create index if not exists booking_events_booking_idx on public.booking_events (booking_id, id);
create index if not exists booking_events_shop_idx on public.booking_events (shop_id, at desc);
alter table public.booking_events enable row level security;
revoke all on public.booking_events from public, anon, authenticated;
grant all on public.booking_events to service_role;
grant select on public.booking_events to authenticated;
drop policy if exists "booking_events: members read" on public.booking_events;
create policy "booking_events: members read" on public.booking_events
  for select to authenticated using (public.is_shop_member(shop_id));

-- what the calendar sync must do (pushed by the crm job; a failure never blocks a booking)
create table if not exists public.booking_sync_jobs (
  id              bigint generated always as identity primary key,
  shop_id         uuid not null references public.shops (id) on delete cascade,
  booking_id      uuid references public.shop_bookings (id) on delete set null,
  op              text not null check (op in ('create', 'update', 'delete')),
  google_event_id text,
  status          text not null default 'queued' check (status in ('queued', 'done', 'failed', 'skipped')),
  attempts        integer not null default 0,
  next_try_at     timestamptz not null default now(),
  last_error      text check (last_error is null or char_length(last_error) <= 300),
  created_at      timestamptz not null default now(),
  done_at         timestamptz
);
create index if not exists booking_sync_jobs_due_idx on public.booking_sync_jobs (next_try_at) where status = 'queued';
alter table public.booking_sync_jobs enable row level security;
revoke all on public.booking_sync_jobs from public, anon, authenticated;
grant all on public.booking_sync_jobs to service_role;

-- the SMS to the customer when the owner moves or cancels (crm job; 3 tries)
create table if not exists public.booking_notifications (
  id          bigint generated always as identity primary key,
  shop_id     uuid not null references public.shops (id) on delete cascade,
  booking_id  uuid references public.shop_bookings (id) on delete cascade,
  kind        text not null check (kind in ('moved', 'cancelled')),
  status      text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'skipped')),
  attempts    integer not null default 0,
  next_try_at timestamptz not null default now(),
  last_error  text check (last_error is null or char_length(last_error) <= 300),
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);
create index if not exists booking_notifications_due_idx on public.booking_notifications (next_try_at) where status = 'queued';
alter table public.booking_notifications enable row level security;
revoke all on public.booking_notifications from public, anon, authenticated;
grant all on public.booking_notifications to service_role;

-- ------------------------------------------------------------------ the one availability function

/** Is a resource working the whole time [p_from, p_to) by its own weekly hours (none = always, the shop decides)? */
create or replace function public.booking_resource_open(p_resource_id uuid, p_tz text, p_from timestamptz, p_to timestamptz)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_hours jsonb;
  v_day date := (p_from at time zone p_tz)::date;
  v_range jsonb;
  v_start timestamptz;
  v_end timestamptz;
begin
  select hours into v_hours from public.booking_resources where id = p_resource_id;
  if v_hours is null then return true; end if;
  for v_range in select * from jsonb_array_elements(coalesce(
      case when jsonb_typeof(v_hours -> (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from v_day)::int + 1]) = 'array'
           then v_hours -> (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from v_day)::int + 1] end,
      '[]'::jsonb)) loop
    continue when jsonb_typeof(v_range) <> 'array' or (v_range ->> 0) !~ '^\d{2}:\d{2}$' or (v_range ->> 1) !~ '^\d{2}:\d{2}$';
    v_start := (v_day + (v_range ->> 0)::time) at time zone p_tz;
    v_end := case when (v_range ->> 1)::time > (v_range ->> 0)::time then (v_day + (v_range ->> 1)::time) at time zone p_tz
                  else (v_day + 1)::timestamp at time zone p_tz end;
    if p_from >= v_start and p_to <= v_end then return true; end if;
  end loop;
  return false;
end;
$$;
revoke execute on function public.booking_resource_open(uuid, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.booking_resource_open(uuid, text, timestamptz, timestamptz) to service_role;

/**
 * THE availability rule (every caller: website, assistant, MCP, API, app). Free start times of a service between two
 * instants: inside the shop's open ranges of each local day (booking_day_ranges: a special day wins, a holiday closes
 * or cuts the day — the shopStatus rules), inside the resource's own hours, every step from a range's start, the whole
 * service inside the range, not before now + notice, not after now + the days ahead; never over a blocked time, a busy
 * time of a connected calendar, or another booking of the same lane with both bookings' buffers — except people of the
 * same service at the same start while its capacity lasts. p_service_id null = update 57's single setting (one person,
 * the shop's lane). With a resource needed and none given, the first free resource of the service is returned per start.
 * p_ignore = a booking being moved. At most 62 days and 500 rows.
 */
create or replace function public.booking_free_slots(
  p_shop_id uuid, p_service_id uuid, p_from timestamptz, p_to timestamptz,
  p_resource_id uuid default null, p_ignore uuid default null, p_people integer default 1
)
returns table (starts_at timestamptz, ends_at timestamptz, resource_id uuid, seats_left integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_set public.shop_booking_settings := public.booking_settings_of(p_shop_id);
  v_tz text;
  v_svc public.booking_services%rowtype;
  v_len interval;
  v_before interval;
  v_after interval;
  v_cap integer;
  v_needs boolean;
  v_people integer := coalesce(p_people, 1);
  v_from timestamptz;
  v_to timestamptz;
  v_day date;
  v_range record;
  v_t timestamptz;
  v_n integer := 0;
  v_lanes uuid[];
  v_r uuid;
  v_lane uuid;
  v_used integer;
  v_conflict boolean;
begin
  select s.timezone into v_tz from public.shops s where s.id = p_shop_id and s.is_active;
  if v_tz is null then return; end if;
  if p_service_id is null then
    v_len := make_interval(mins => v_set.duration_minutes);
    v_before := make_interval(mins => v_set.buffer_minutes);
    v_after := v_before;
    v_cap := 1;
    v_needs := false;
  else
    select * into v_svc from public.booking_services s where s.id = p_service_id and s.shop_id = p_shop_id and s.active;
    if not found then return; end if;
    v_len := make_interval(mins => v_svc.duration_minutes);
    v_before := make_interval(mins => v_svc.buffer_before);
    v_after := make_interval(mins => v_svc.buffer_after);
    v_cap := v_svc.capacity;
    v_needs := v_svc.needs_resource;
  end if;
  if v_people < 1 or v_people > v_cap then return; end if;
  v_from := greatest(p_from, now() + make_interval(mins => v_set.lead_minutes));
  v_to := least(p_to, now() + make_interval(days => v_set.horizon_days), p_from + interval '62 days');
  if v_to <= v_from then return; end if;

  if v_needs then
    select array_agg(r.id order by r.position, r.name, r.id) into v_lanes
    from public.booking_resources r
    join public.booking_service_resources sr on sr.resource_id = r.id and sr.service_id = p_service_id
    where r.shop_id = p_shop_id and r.active and (p_resource_id is null or r.id = p_resource_id);
    if v_lanes is null then return; end if;
  elsif p_resource_id is not null then
    -- a service without a resource is booked on the shop's own lane
    v_lanes := array[null::uuid];
  else
    v_lanes := array[null::uuid];
  end if;

  v_day := (v_from at time zone v_tz)::date;
  while v_day <= (v_to at time zone v_tz)::date loop
    for v_range in select * from public.booking_day_ranges(p_shop_id, v_day) order by 1 loop
      v_t := v_range.range_start;
      while v_t + v_len <= v_range.range_end loop
        if v_t >= v_from and v_t + v_len <= v_to then
          foreach v_r in array v_lanes loop
            v_lane := coalesce(v_r, p_shop_id);
            continue when v_r is not null and not public.booking_resource_open(v_r, v_tz, v_t, v_t + v_len);
            continue when exists (
              select 1 from public.booking_blocks bl
              where bl.shop_id = p_shop_id and (bl.resource_id is null or bl.resource_id = v_r)
                and tstzrange(bl.starts_at, bl.ends_at, '[)') && tstzrange(v_t, v_t + v_len, '[)'));
            continue when exists (
              select 1 from public.booking_calendar_busy cb
              where cb.shop_id = p_shop_id and (cb.resource_id is null or cb.resource_id = v_r)
                and tstzrange(cb.starts_at, cb.ends_at, '[)') && tstzrange(v_t, v_t + v_len, '[)'));
            select coalesce(sum(b.people) filter (where not b.exclusive and b.starts_at = v_t
                                                  and b.service_id is not distinct from p_service_id), 0),
                   coalesce(bool_or(b.exclusive or b.starts_at <> v_t or b.service_id is distinct from p_service_id
                                    or v_cap = 1), false)
              into v_used, v_conflict
            from public.shop_bookings b
            where b.lane = v_lane and b.id is distinct from p_ignore
              and (b.status = 'confirmed' or (b.status = 'pending' and b.code_expires_at > now()))
              and tstzrange(b.busy_from, b.busy_to, '[)') && tstzrange(v_t - v_before, v_t + v_len + v_after, '[)');
            continue when v_conflict or v_cap - v_used < v_people;
            starts_at := v_t;
            ends_at := v_t + v_len;
            resource_id := v_r;
            seats_left := v_cap - v_used;
            return next;
            v_n := v_n + 1;
            if v_n >= 500 then return; end if;
            exit;
          end loop;
        end if;
        v_t := v_t + make_interval(mins => v_set.step_minutes);
      end loop;
    end loop;
    v_day := v_day + 1;
  end loop;
end;
$$;
revoke execute on function public.booking_free_slots(uuid, uuid, timestamptz, timestamptz, uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.booking_free_slots(uuid, uuid, timestamptz, timestamptz, uuid, uuid, integer) to service_role;

/** Update 57's form (one setting, the shop's lane): the same rule as above. */
create or replace function public.booking_free_slots(p_shop_id uuid, p_from timestamptz, p_to timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select f.starts_at, f.ends_at
  from public.booking_free_slots(p_shop_id, null::uuid, p_from, p_to, null::uuid, null::uuid, 1) f
  limit 300
$$;
revoke execute on function public.booking_free_slots(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.booking_free_slots(uuid, timestamptz, timestamptz) to service_role;

-- ------------------------------------------------------------------ writing a booking (every caller)

create or replace function public.booking_actor_kind(p_source text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_source when 'owner' then 'owner' when 'app' then 'app' when 'api' then 'api'
                       when 'assistant' then 'assistant' else 'system' end
$$;
revoke execute on function public.booking_actor_kind(text) from public, anon, authenticated;
grant execute on function public.booking_actor_kind(text) to service_role;

/** Queues the calendar sync of a booking when the shop has a working calendar connection (never blocks anything). */
create or replace function public.booking_sync_queue(p_booking_id uuid, p_op text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.shop_bookings%rowtype;
begin
  select * into v from public.shop_bookings where id = p_booking_id;
  if not found then return; end if;
  if not exists (select 1 from public.booking_google_connections g where g.shop_id = v.shop_id) then return; end if;
  -- a push still waiting already takes the booking's newest times
  if p_op = 'update' and exists (select 1 from public.booking_sync_jobs j where j.booking_id = p_booking_id and j.status = 'queued'
                                 and j.op in ('create', 'update')) then
    return;
  end if;
  if p_op = 'delete' then
    update public.booking_sync_jobs set status = 'skipped', done_at = now()
    where booking_id = p_booking_id and status = 'queued' and op in ('create', 'update') and v.google_event_id is not null;
  end if;
  if p_op = 'delete' and v.google_event_id is null then
    -- nothing to delete there; a create still waiting is dropped
    update public.booking_sync_jobs set status = 'skipped', done_at = now()
    where booking_id = p_booking_id and status = 'queued';
    return;
  end if;
  insert into public.booking_sync_jobs (shop_id, booking_id, op, google_event_id)
  values (v.shop_id, v.id,
          case when p_op = 'update' and v.google_event_id is null then 'create' else p_op end,
          v.google_event_id);
end;
$$;
revoke execute on function public.booking_sync_queue(uuid, text) from public, anon, authenticated;
grant execute on function public.booking_sync_queue(uuid, text) to service_role;

/**
 * Writes one booking for a contact of the shop, after checking the slot again under a lock of its lane (two clicks at
 * the same moment: the second gets slot_taken). Refusals (raised): source, not_available, service, people, contact,
 * contact_limit (bookings per contact a day; not for the owner), slot_taken. Returns the booking id. Service role and
 * the SQL functions below; never callable from a browser.
 */
create or replace function public.booking_create(
  p_shop_id uuid, p_service_id uuid, p_starts_at timestamptz, p_resource_id uuid, p_people integer,
  p_contact_id uuid, p_conversation_id uuid, p_source text, p_actor uuid, p_note text, p_consent_version text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_set public.shop_booking_settings := public.booking_settings_of(p_shop_id);
  v_tz text;
  v_svc public.booking_services%rowtype;
  v_contact public.shop_contacts%rowtype;
  v_people integer := coalesce(p_people, 1);
  v_len integer;
  v_before integer;
  v_after integer;
  v_cap integer;
  v_name text;
  v_slot record;
  v_id uuid := gen_random_uuid();
begin
  if p_source is null or p_source not in ('assistant', 'owner', 'app', 'api') then
    raise exception 'source' using errcode = '22023';
  end if;
  select timezone into v_tz from public.shops where id = p_shop_id and is_active;
  if v_tz is null then raise exception 'not_available' using errcode = 'P0001'; end if;
  if p_service_id is null then
    v_len := v_set.duration_minutes; v_before := v_set.buffer_minutes; v_after := v_set.buffer_minutes; v_cap := 1;
    v_name := v_set.service_name;
  else
    select * into v_svc from public.booking_services where id = p_service_id and shop_id = p_shop_id and active;
    if not found then raise exception 'service' using errcode = '22023'; end if;
    v_len := v_svc.duration_minutes; v_before := v_svc.buffer_before; v_after := v_svc.buffer_after; v_cap := v_svc.capacity;
    v_name := v_svc.name;
  end if;
  if v_people < 1 or v_people > v_cap then raise exception 'people' using errcode = '22023'; end if;
  select * into v_contact from public.shop_contacts where id = p_contact_id and shop_id = p_shop_id;
  if not found then raise exception 'contact' using errcode = '22023'; end if;
  if p_source <> 'owner' and (
       select count(*) from public.shop_bookings b
       where b.shop_id = p_shop_id and b.contact_id = p_contact_id and b.status = 'confirmed'
         and (b.starts_at at time zone v_tz)::date = (p_starts_at at time zone v_tz)::date) >= v_set.max_per_contact_day then
    raise exception 'contact_limit' using errcode = '54000';
  end if;

  select * into v_slot
  from public.booking_free_slots(p_shop_id, p_service_id, p_starts_at, p_starts_at + make_interval(mins => v_len),
                                 p_resource_id, null, v_people) f
  where f.starts_at = p_starts_at
  limit 1;
  if not found then raise exception 'slot_taken' using errcode = 'P0001'; end if;
  -- the lane's lock until the end of the transaction; then the same check again (it now sees every committed booking)
  perform pg_advisory_xact_lock(hashtextextended('ppi-booking:' || coalesce(v_slot.resource_id, p_shop_id)::text, 0));
  if not exists (
    select 1 from public.booking_free_slots(p_shop_id, p_service_id, p_starts_at, p_starts_at + make_interval(mins => v_len),
                                            v_slot.resource_id, null, v_people) f
    where f.starts_at = p_starts_at and f.resource_id is not distinct from v_slot.resource_id) then
    raise exception 'slot_taken' using errcode = 'P0001';
  end if;

  begin
    insert into public.shop_bookings (id, shop_id, contact_id, conversation_id, starts_at, ends_at, status, service_name, name,
                                      phone, email, address, note, consent_at, consent_version, confirmed_at, status_changed_at,
                                      service_id, resource_id, people, source, created_by, buffer_before, buffer_after, exclusive,
                                      verified_at)
    values (v_id, p_shop_id, p_contact_id, p_conversation_id, p_starts_at, p_starts_at + make_interval(mins => v_len),
            'confirmed', v_name, left(coalesce(v_contact.name, v_contact.phone, v_contact.email, '—'), 120),
            v_contact.phone, v_contact.email, left(v_contact.address, 300), left(nullif(btrim(coalesce(p_note, '')), ''), 500),
            case when p_consent_version is not null then now() end, left(p_consent_version, 40), now(), now(),
            p_service_id, v_slot.resource_id, v_people, p_source, p_actor, v_before, v_after, v_cap = 1,
            case when v_contact.phone_verified_at is not null then now() end);
  exception when exclusion_violation then
    raise exception 'slot_taken' using errcode = 'P0001';
  end;
  insert into public.booking_events (shop_id, booking_id, kind, actor, actor_kind, new_starts, new_status)
  values (p_shop_id, v_id, 'created', p_actor, public.booking_actor_kind(p_source), p_starts_at, 'confirmed');
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, p_actor, 'booking_created', jsonb_build_object('booking_id', v_id, 'source', p_source));
  update public.shop_contacts set last_contact_at = greatest(coalesce(last_contact_at, now()), now()) where id = p_contact_id;
  perform public.booking_sync_queue(v_id, 'create');
  return v_id;
end;
$$;
revoke execute on function public.booking_create(uuid, uuid, timestamptz, uuid, integer, uuid, uuid, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.booking_create(uuid, uuid, timestamptz, uuid, integer, uuid, uuid, text, uuid, text, text)
  to service_role;

/** The customer's SMS after the owner moved or cancelled a booking (when the shop wants it and it lies ahead). */
create or replace function public.booking_notify_queue(p_booking_id uuid, p_kind text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.shop_bookings%rowtype;
begin
  select * into v from public.shop_bookings where id = p_booking_id;
  if not found or v.phone is null or v.starts_at <= now() then return; end if;
  if not (public.crm_settings_of(v.shop_id)).notify_on_owner_change then return; end if;
  -- the newest message replaces one still waiting (moved twice = one SMS with the last time)
  update public.booking_notifications set status = 'skipped' where booking_id = p_booking_id and status = 'queued';
  insert into public.booking_notifications (shop_id, booking_id, kind) values (v.shop_id, v.id, p_kind);
end;
$$;
revoke execute on function public.booking_notify_queue(uuid, text) from public, anon, authenticated;
grant execute on function public.booking_notify_queue(uuid, text) to service_role;

/**
 * Moves a confirmed booking (the same service and people; the same resource unless another is given), checked again
 * like a new one under the lane's lock. p_source/p_actor say who moved it. Refusals: not_found, not_confirmed,
 * slot_taken. The customer's SMS and the calendar sync follow.
 */
create or replace function public.booking_move(p_id uuid, p_starts_at timestamptz, p_resource_id uuid, p_source text, p_actor uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.shop_bookings%rowtype;
  v_svc public.booking_services%rowtype;
  v_len interval;
  v_res uuid;
  v_slot record;
  v_lanes text[];
begin
  select * into v from public.shop_bookings where id = p_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v.status <> 'confirmed' then raise exception 'not_confirmed' using errcode = '22023'; end if;
  v_len := v.ends_at - v.starts_at;
  if v.service_id is not null then
    select * into v_svc from public.booking_services where id = v.service_id;
    v_res := case when v_svc.needs_resource then coalesce(p_resource_id, v.resource_id) end;
  end if;
  select * into v_slot
  from public.booking_free_slots(v.shop_id, v.service_id, p_starts_at, p_starts_at + v_len, v_res, v.id, v.people) f
  where f.starts_at = p_starts_at
  limit 1;
  if not found then raise exception 'slot_taken' using errcode = 'P0001'; end if;
  -- both lanes, in one order, so two moves never wait for each other
  select array_agg(l order by l) into v_lanes
  from unnest(array[v.lane::text, coalesce(v_slot.resource_id, v.shop_id)::text]) l;
  perform pg_advisory_xact_lock(hashtextextended('ppi-booking:' || v_lanes[1], 0));
  if v_lanes[2] <> v_lanes[1] then perform pg_advisory_xact_lock(hashtextextended('ppi-booking:' || v_lanes[2], 0)); end if;
  if not exists (
    select 1 from public.booking_free_slots(v.shop_id, v.service_id, p_starts_at, p_starts_at + v_len, v_slot.resource_id,
                                            v.id, v.people) f
    where f.starts_at = p_starts_at and f.resource_id is not distinct from v_slot.resource_id) then
    raise exception 'slot_taken' using errcode = 'P0001';
  end if;
  begin
    update public.shop_bookings
    set starts_at = p_starts_at, ends_at = p_starts_at + v_len, resource_id = v_slot.resource_id,
        reminder_sent_at = null, status_changed_at = now(), status_by = p_actor
    where id = p_id;
  exception when exclusion_violation then
    raise exception 'slot_taken' using errcode = 'P0001';
  end;
  insert into public.booking_events (shop_id, booking_id, kind, actor, actor_kind, old_starts, new_starts)
  values (v.shop_id, v.id, 'moved', p_actor, public.booking_actor_kind(p_source), v.starts_at, p_starts_at);
  insert into public.shop_activity (shop_id, actor, action, details)
  values (v.shop_id, p_actor, 'booking_moved', jsonb_build_object('booking_id', v.id, 'source', p_source));
  perform public.booking_sync_queue(v.id, 'update');
  if p_source <> 'assistant' then perform public.booking_notify_queue(v.id, 'moved'); end if;
  return jsonb_build_object('id', v.id, 'starts_at', p_starts_at, 'ends_at', p_starts_at + v_len,
                            'resource_id', v_slot.resource_id);
end;
$$;
revoke execute on function public.booking_move(uuid, timestamptz, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.booking_move(uuid, timestamptz, uuid, text, uuid) to service_role;

/** Cancels a confirmed booking (its time is free at once); the customer's SMS and the calendar sync follow. */
create or replace function public.booking_cancel(p_id uuid, p_source text, p_actor uuid, p_notify boolean default true)
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
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v.status <> 'confirmed' then return false; end if;
  update public.shop_bookings set status = 'cancelled', status_changed_at = now(), status_by = p_actor where id = p_id;
  insert into public.booking_events (shop_id, booking_id, kind, actor, actor_kind, old_starts, old_status, new_status)
  values (v.shop_id, v.id, 'cancelled', p_actor, case when p_source = 'shopper' then 'shopper'
                                                      else public.booking_actor_kind(p_source) end,
          v.starts_at, v.status, 'cancelled');
  insert into public.shop_activity (shop_id, actor, action, details)
  values (v.shop_id, p_actor, 'booking_cancelled', jsonb_build_object('booking_id', v.id, 'source', p_source));
  perform public.booking_sync_queue(v.id, 'delete');
  if p_notify and p_source not in ('assistant', 'shopper') then perform public.booking_notify_queue(v.id, 'cancelled'); end if;
  return true;
end;
$$;
revoke execute on function public.booking_cancel(uuid, text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.booking_cancel(uuid, text, uuid, boolean) to service_role;

-- ------------------------------------------------------------------ the owner's booking functions

/** Members with the plan of the booking's shop (raises like crm_owner_check); returns the shop. */
create or replace function public.booking_owner_check(p_booking_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
begin
  select shop_id into v_shop from public.shop_bookings where id = p_booking_id;
  if v_shop is null or not public.is_shop_member(v_shop) then raise exception 'Not your shop' using errcode = '42501'; end if;
  perform public.crm_owner_check(v_shop);
  return v_shop;
end;
$$;
revoke execute on function public.booking_owner_check(uuid) from public, anon;
grant execute on function public.booking_owner_check(uuid) to authenticated, service_role;

/** "+ Rezervácia": for a contact of the shop, or a new / known one by name and phone (the same number = the same contact). */
create or replace function public.owner_booking_create(
  p_shop_id uuid, p_service_id uuid, p_starts_at timestamptz, p_resource_id uuid default null, p_people integer default 1,
  p_contact_id uuid default null, p_name text default null, p_phone text default null, p_note text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_contact uuid := p_contact_id;
  v_phone text;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
begin
  perform public.crm_owner_check(p_shop_id);
  if v_contact is null then
    v_phone := public.crm_phone(p_phone, (select country from public.shops where id = p_shop_id));
    if v_phone is null then raise exception 'phone' using errcode = '22023'; end if;
    if v_name is not null and char_length(v_name) > 80 then raise exception 'name' using errcode = '22023'; end if;
    select id into v_contact from public.shop_contacts where shop_id = p_shop_id and phone = v_phone;
    if v_contact is null then
      insert into public.shop_contacts (shop_id, name, phone, source, created_by)
      values (p_shop_id, v_name, v_phone, 'owner', auth.uid())
      returning id into v_contact;
    elsif v_name is not null then
      update public.shop_contacts set name = coalesce(name, v_name), updated_at = now() where id = v_contact;
    end if;
  end if;
  return public.booking_create(p_shop_id, p_service_id, p_starts_at, p_resource_id, p_people, v_contact, null, 'owner',
                               auth.uid(), p_note, null);
end;
$$;
revoke execute on function public.owner_booking_create(uuid, uuid, timestamptz, uuid, integer, uuid, text, text, text) from public, anon;
grant execute on function public.owner_booking_create(uuid, uuid, timestamptz, uuid, integer, uuid, text, text, text)
  to authenticated, service_role;

create or replace function public.owner_booking_move(p_id uuid, p_starts_at timestamptz, p_resource_id uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.booking_owner_check(p_id);
  return public.booking_move(p_id, p_starts_at, p_resource_id, 'owner', auth.uid());
end;
$$;
revoke execute on function public.owner_booking_move(uuid, timestamptz, uuid) from public, anon;
grant execute on function public.owner_booking_move(uuid, timestamptz, uuid) to authenticated, service_role;

create or replace function public.owner_booking_cancel(p_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.booking_owner_check(p_id);
  return public.booking_cancel(p_id, 'owner', auth.uid(), true);
end;
$$;
revoke execute on function public.owner_booking_cancel(uuid) from public, anon;
grant execute on function public.owner_booking_cancel(uuid) to authenticated, service_role;

/** "Prišiel" (done) / "Neprišiel" (no_show) / back to confirmed. A cancelled booking is not brought back here. */
create or replace function public.owner_booking_mark(p_id uuid, p_status text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.shop_bookings%rowtype;
begin
  perform public.booking_owner_check(p_id);
  if p_status is null or p_status not in ('done', 'no_show', 'confirmed') then raise exception 'status' using errcode = '22023'; end if;
  select * into v from public.shop_bookings where id = p_id for update;
  if v.status not in ('confirmed', 'done', 'no_show') then raise exception 'not_confirmed' using errcode = '22023'; end if;
  if v.status = p_status then return false; end if;
  begin
    update public.shop_bookings set status = p_status, status_changed_at = now(), status_by = auth.uid() where id = p_id;
  exception when exclusion_violation then
    raise exception 'slot_taken' using errcode = 'P0001';
  end;
  insert into public.booking_events (shop_id, booking_id, kind, actor, actor_kind, old_status, new_status)
  values (v.shop_id, v.id, 'status', auth.uid(), 'owner', v.status, p_status);
  insert into public.shop_activity (shop_id, actor, action, details)
  values (v.shop_id, auth.uid(), 'booking_status_changed', jsonb_build_object('booking_id', p_id, 'from', v.status, 'to', p_status));
  return true;
end;
$$;
revoke execute on function public.owner_booking_mark(uuid, text) from public, anon;
grant execute on function public.owner_booking_mark(uuid, text) to authenticated, service_role;

/** As update 57 (Potvrdená / Zrušená / Neprišiel), now with "Prišiel" and the audit log; Zrušená goes through booking_cancel. */
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
  select * into v from public.shop_bookings where id = p_id;
  if not found or not public.is_shop_member(v.shop_id) then raise exception 'Not your shop' using errcode = '42501'; end if;
  if p_status is null or p_status not in ('confirmed', 'cancelled', 'no_show', 'done') then
    raise exception 'status' using errcode = '22023';
  end if;
  if v.status not in ('confirmed', 'cancelled', 'no_show', 'done') then raise exception 'not_confirmed' using errcode = '22023'; end if;
  if v.status = p_status then return false; end if;
  if p_status = 'cancelled' then
    return public.booking_cancel(p_id, 'owner', auth.uid(), true);
  end if;
  if v.status = 'cancelled' then
    -- back from cancelled only while the time is still free
    begin
      update public.shop_bookings set status = p_status, status_changed_at = now(), status_by = auth.uid() where id = p_id;
    exception when exclusion_violation then
      raise exception 'slot_taken' using errcode = 'P0001';
    end;
  else
    update public.shop_bookings set status = p_status, status_changed_at = now(), status_by = auth.uid() where id = p_id;
  end if;
  insert into public.booking_events (shop_id, booking_id, kind, actor, actor_kind, old_status, new_status)
  values (v.shop_id, v.id, 'status', auth.uid(), 'owner', v.status, p_status);
  insert into public.shop_activity (shop_id, actor, action, details)
  values (v.shop_id, auth.uid(), 'booking_status_changed', jsonb_build_object('booking_id', p_id, 'from', v.status, 'to', p_status));
  return true;
end;
$$;
revoke execute on function public.owner_set_booking_status(uuid, text) from public, anon;
grant execute on function public.owner_set_booking_status(uuid, text) to authenticated, service_role;

/** "Rezervácie" (day / week): the shop's bookings that start in [p_from, p_to), with service and resource names. Members. */
create or replace function public.owner_booking_list(p_shop_id uuid, p_from timestamptz, p_to timestamptz, p_status text default null)
returns table (id uuid, starts_at timestamptz, ends_at timestamptz, status text, service_id uuid, service_name text,
               resource_id uuid, resource_name text, people integer, name text, phone text, email text, note text,
               contact_id uuid, conversation_id uuid, source text, google_status text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id, b.starts_at, b.ends_at, b.status, b.service_id, coalesce(s.name, b.service_name), b.resource_id, r.name,
         b.people, b.name, b.phone, b.email, b.note, b.contact_id, b.conversation_id, b.source, b.google_status, b.created_at
  from public.shop_bookings b
  left join public.booking_services s on s.id = b.service_id
  left join public.booking_resources r on r.id = b.resource_id
  where b.shop_id = p_shop_id and public.is_shop_member(p_shop_id)
    and b.starts_at >= p_from and b.starts_at < least(p_to, p_from + interval '62 days')
    and case when nullif(p_status, '') is null then b.status in ('confirmed', 'done', 'no_show', 'cancelled')
             else b.status = p_status end
  order by b.starts_at, b.id
  limit 1000
$$;
revoke execute on function public.owner_booking_list(uuid, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.owner_booking_list(uuid, timestamptz, timestamptz, text) to authenticated, service_role;

/** "Voľné termíny" for the owner (the same rule as everyone; members). */
create or replace function public.owner_booking_free_slots(
  p_shop_id uuid, p_service_id uuid, p_from timestamptz, p_to timestamptz, p_resource_id uuid default null,
  p_people integer default 1
)
returns table (starts_at timestamptz, ends_at timestamptz, resource_id uuid, seats_left integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_shop_member(p_shop_id) then raise exception 'Not your shop' using errcode = '42501'; end if;
  return query select * from public.booking_free_slots(p_shop_id, p_service_id, p_from, p_to, p_resource_id, null, p_people);
end;
$$;
revoke execute on function public.owner_booking_free_slots(uuid, uuid, timestamptz, timestamptz, uuid, integer) from public, anon;
grant execute on function public.owner_booking_free_slots(uuid, uuid, timestamptz, timestamptz, uuid, integer)
  to authenticated, service_role;

/** A booking's history (members). */
create or replace function public.owner_booking_events(p_id uuid)
returns table (kind text, actor_kind text, old_starts timestamptz, new_starts timestamptz, old_status text, new_status text,
               at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select e.kind, e.actor_kind, e.old_starts, e.new_starts, e.old_status, e.new_status, e.at
  from public.booking_events e
  where e.booking_id = p_id and public.is_shop_member(e.shop_id)
  order by e.id
$$;
revoke execute on function public.owner_booking_events(uuid) from public, anon;
grant execute on function public.owner_booking_events(uuid) to authenticated, service_role;

-- ------------------------------------------------------------------ services, resources, rules, blocks (owner)

create or replace function public.owner_save_booking_service(
  p_shop_id uuid, p_id uuid, p_name text, p_duration integer, p_buffer_before integer, p_buffer_after integer,
  p_capacity integer, p_needs_resource boolean, p_active boolean, p_offered_by_assistant boolean, p_note text,
  p_resource_ids uuid[] default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
begin
  perform public.crm_owner_check(p_shop_id);
  if char_length(v_name) not between 1 and 80 then raise exception 'name' using errcode = '22023'; end if;
  if p_duration is null or p_duration not between 5 and 480 or coalesce(p_buffer_before, 0) not between 0 and 120
     or coalesce(p_buffer_after, 0) not between 0 and 120 or coalesce(p_capacity, 1) not between 1 and 500
     or char_length(coalesce(p_note, '')) > 500 then
    raise exception 'service' using errcode = '22023';
  end if;
  if p_resource_ids is not null and exists (select 1 from unnest(p_resource_ids) r
                                            where not exists (select 1 from public.booking_resources x
                                                              where x.id = r and x.shop_id = p_shop_id)) then
    raise exception 'resource' using errcode = '22023';
  end if;
  if p_id is null then
    if (select count(*) from public.booking_services where shop_id = p_shop_id) >= 100 then
      raise exception 'too_many' using errcode = '54000';
    end if;
    insert into public.booking_services (shop_id, name, duration_minutes, buffer_before, buffer_after, capacity, needs_resource,
                                         active, offered_by_assistant, note, position)
    values (p_shop_id, v_name, p_duration, coalesce(p_buffer_before, 0), coalesce(p_buffer_after, 0), coalesce(p_capacity, 1),
            coalesce(p_needs_resource, false), coalesce(p_active, true), coalesce(p_offered_by_assistant, true),
            nullif(btrim(coalesce(p_note, '')), ''),
            coalesce((select max(position) + 1 from public.booking_services where shop_id = p_shop_id), 0))
    returning id into v_id;
  else
    update public.booking_services
    set name = v_name, duration_minutes = p_duration, buffer_before = coalesce(p_buffer_before, 0),
        buffer_after = coalesce(p_buffer_after, 0), capacity = coalesce(p_capacity, 1),
        needs_resource = coalesce(p_needs_resource, false), active = coalesce(p_active, true),
        offered_by_assistant = coalesce(p_offered_by_assistant, true), note = nullif(btrim(coalesce(p_note, '')), ''),
        updated_at = now()
    where id = p_id and shop_id = p_shop_id
    returning id into v_id;
    if v_id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  end if;
  if p_resource_ids is not null then
    delete from public.booking_service_resources where service_id = v_id and resource_id <> all (p_resource_ids);
    insert into public.booking_service_resources (service_id, resource_id)
    select v_id, r from unnest(p_resource_ids) r on conflict do nothing;
  end if;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'booking_service_saved', jsonb_build_object('service_id', v_id));
  return v_id;
end;
$$;
revoke execute on function public.owner_save_booking_service(uuid, uuid, text, integer, integer, integer, integer, boolean, boolean, boolean, text, uuid[])
  from public, anon;
grant execute on function public.owner_save_booking_service(uuid, uuid, text, integer, integer, integer, integer, boolean, boolean, boolean, text, uuid[])
  to authenticated, service_role;

/** Removes a service; one that was ever booked is only switched off (its bookings keep their name). */
create or replace function public.owner_remove_booking_service(p_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop uuid := (select shop_id from public.booking_services where id = p_id);
begin
  perform public.crm_owner_check(v_shop);
  insert into public.shop_activity (shop_id, actor, action, details)
  values (v_shop, auth.uid(), 'booking_service_removed', jsonb_build_object('service_id', p_id));
  if exists (select 1 from public.shop_bookings where service_id = p_id) then
    update public.booking_services set active = false, updated_at = now() where id = p_id;
    return 'deactivated';
  end if;
  delete from public.booking_services where id = p_id;
  return 'deleted';
end;
$$;
revoke execute on function public.owner_remove_booking_service(uuid) from public, anon;
grant execute on function public.owner_remove_booking_service(uuid) to authenticated, service_role;

/** Same weekly format as shops.opening_hours: {"mon":[["08:00","12:00"],…],…}; null = the shop's hours. */
create or replace function public.booking_hours_ok(p_hours jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_hours is null or (
    jsonb_typeof(p_hours) = 'object'
    and not exists (select 1 from jsonb_object_keys(p_hours) k where k not in ('mon','tue','wed','thu','fri','sat','sun'))
    and not exists (
      select 1 from jsonb_each(p_hours) d
      where jsonb_typeof(d.value) <> 'array'
         or exists (select 1 from jsonb_array_elements(d.value) r
                    where jsonb_typeof(r) <> 'array' or jsonb_array_length(r) <> 2
                       or (r ->> 0) !~ '^([01]\d|2[0-3]):[0-5]\d$' or (r ->> 1) !~ '^([01]\d|2[0-3]):[0-5]\d$')))
$$;
revoke execute on function public.booking_hours_ok(jsonb) from public, anon;
grant execute on function public.booking_hours_ok(jsonb) to authenticated, service_role;

create or replace function public.owner_save_booking_resource(
  p_shop_id uuid, p_id uuid, p_name text, p_kind text, p_active boolean, p_hours jsonb, p_service_ids uuid[] default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
begin
  perform public.crm_owner_check(p_shop_id);
  if char_length(v_name) not between 1 and 80 then raise exception 'name' using errcode = '22023'; end if;
  if coalesce(p_kind, 'person') not in ('person', 'machine', 'room') then raise exception 'kind' using errcode = '22023'; end if;
  if not public.booking_hours_ok(p_hours) then raise exception 'hours' using errcode = '22023'; end if;
  if p_service_ids is not null and exists (select 1 from unnest(p_service_ids) s
                                           where not exists (select 1 from public.booking_services x
                                                             where x.id = s and x.shop_id = p_shop_id)) then
    raise exception 'service' using errcode = '22023';
  end if;
  if p_id is null then
    if (select count(*) from public.booking_resources where shop_id = p_shop_id) >= 50 then
      raise exception 'too_many' using errcode = '54000';
    end if;
    insert into public.booking_resources (shop_id, name, kind, active, hours, position)
    values (p_shop_id, v_name, coalesce(p_kind, 'person'), coalesce(p_active, true), p_hours,
            coalesce((select max(position) + 1 from public.booking_resources where shop_id = p_shop_id), 0))
    returning id into v_id;
  else
    update public.booking_resources
    set name = v_name, kind = coalesce(p_kind, 'person'), active = coalesce(p_active, true), hours = p_hours, updated_at = now()
    where id = p_id and shop_id = p_shop_id
    returning id into v_id;
    if v_id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  end if;
  if p_service_ids is not null then
    delete from public.booking_service_resources where resource_id = v_id and service_id <> all (p_service_ids);
    insert into public.booking_service_resources (service_id, resource_id)
    select s, v_id from unnest(p_service_ids) s on conflict do nothing;
  end if;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'booking_resource_saved', jsonb_build_object('resource_id', v_id));
  return v_id;
end;
$$;
revoke execute on function public.owner_save_booking_resource(uuid, uuid, text, text, boolean, jsonb, uuid[]) from public, anon;
grant execute on function public.owner_save_booking_resource(uuid, uuid, text, text, boolean, jsonb, uuid[])
  to authenticated, service_role;

/** Removes a resource; one with bookings ahead is only switched off (they keep it), one booked only in the past too. */
create or replace function public.owner_remove_booking_resource(p_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop uuid := (select shop_id from public.booking_resources where id = p_id);
begin
  perform public.crm_owner_check(v_shop);
  insert into public.shop_activity (shop_id, actor, action, details)
  values (v_shop, auth.uid(), 'booking_resource_removed', jsonb_build_object('resource_id', p_id));
  if exists (select 1 from public.shop_bookings where resource_id = p_id) then
    update public.booking_resources set active = false, updated_at = now() where id = p_id;
    return 'deactivated';
  end if;
  delete from public.booking_resources where id = p_id;
  return 'deleted';
end;
$$;
revoke execute on function public.owner_remove_booking_resource(uuid) from public, anon;
grant execute on function public.owner_remove_booking_resource(uuid) to authenticated, service_role;

/** "Pravidlá": notice (minutes), days ahead, step (5/10/15/30), bookings per contact a day; switches bookings on/off. */
create or replace function public.owner_save_booking_rules(
  p_shop_id uuid, p_enabled boolean, p_min_notice integer, p_max_days integer, p_step integer, p_max_per_contact_day integer
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.shop_booking_settings := public.booking_settings_of(p_shop_id);
begin
  perform public.crm_owner_check(p_shop_id);
  if p_min_notice is null or p_min_notice not between 0 and 10080 or p_max_days is null or p_max_days not between 1 and 365
     or p_step is null or p_step not in (5, 10, 15, 30)
     or p_max_per_contact_day is null or p_max_per_contact_day not between 1 and 20 then
    raise exception 'rules' using errcode = '22023';
  end if;
  insert into public.shop_booking_settings (shop_id, enabled, service_name, duration_minutes, step_minutes, buffer_minutes,
                                            lead_minutes, horizon_days, reminder, updated_at, max_per_contact_day)
  values (p_shop_id, coalesce(p_enabled, v.enabled), v.service_name, v.duration_minutes, p_step, v.buffer_minutes,
          p_min_notice, p_max_days, v.reminder, now(), p_max_per_contact_day)
  on conflict (shop_id) do update
    set enabled = excluded.enabled, step_minutes = excluded.step_minutes, lead_minutes = excluded.lead_minutes,
        horizon_days = excluded.horizon_days, max_per_contact_day = excluded.max_per_contact_day, updated_at = now();
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'booking_rules_saved',
          jsonb_build_object('enabled', coalesce(p_enabled, v.enabled), 'min_notice', p_min_notice, 'max_days', p_max_days,
                             'step', p_step, 'per_contact', p_max_per_contact_day));
end;
$$;
revoke execute on function public.owner_save_booking_rules(uuid, boolean, integer, integer, integer, integer) from public, anon;
grant execute on function public.owner_save_booking_rules(uuid, boolean, integer, integer, integer, integer) to authenticated, service_role;

-- horizon_days had a limit of 180; "max_days_ahead" up to 365
alter table public.shop_booking_settings drop constraint if exists shop_booking_settings_horizon_days_check;
alter table public.shop_booking_settings add constraint shop_booking_settings_horizon_days_check
  check (horizon_days between 1 and 365);

create or replace function public.owner_save_booking_block(
  p_shop_id uuid, p_id uuid, p_resource_id uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_note text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform public.crm_owner_check(p_shop_id);
  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at or p_ends_at - p_starts_at > interval '366 days'
     or char_length(coalesce(p_note, '')) > 200 then
    raise exception 'block' using errcode = '22023';
  end if;
  if p_resource_id is not null and not exists (select 1 from public.booking_resources where id = p_resource_id and shop_id = p_shop_id) then
    raise exception 'resource' using errcode = '22023';
  end if;
  if p_id is null then
    insert into public.booking_blocks (shop_id, resource_id, starts_at, ends_at, note, created_by)
    values (p_shop_id, p_resource_id, p_starts_at, p_ends_at, nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
    returning id into v_id;
  else
    update public.booking_blocks
    set resource_id = p_resource_id, starts_at = p_starts_at, ends_at = p_ends_at, note = nullif(btrim(coalesce(p_note, '')), '')
    where id = p_id and shop_id = p_shop_id
    returning id into v_id;
    if v_id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  end if;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'booking_block_saved', jsonb_build_object('block_id', v_id));
  return v_id;
end;
$$;
revoke execute on function public.owner_save_booking_block(uuid, uuid, uuid, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.owner_save_booking_block(uuid, uuid, uuid, timestamptz, timestamptz, text) to authenticated, service_role;

create or replace function public.owner_remove_booking_block(p_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop uuid := (select shop_id from public.booking_blocks where id = p_id);
begin
  perform public.crm_owner_check(v_shop);
  delete from public.booking_blocks where id = p_id;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (v_shop, auth.uid(), 'booking_block_removed', jsonb_build_object('block_id', p_id));
  return true;
end;
$$;
revoke execute on function public.owner_remove_booking_block(uuid) from public, anon;
grant execute on function public.owner_remove_booking_block(uuid) to authenticated, service_role;

/** Everything the "Nastavenia" sections show, in one read (members). */
create or replace function public.owner_booking_setup(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.shop_booking_settings := public.booking_settings_of(p_shop_id);
  c public.crm_settings := public.crm_settings_of(p_shop_id);
begin
  if not public.is_shop_member(p_shop_id) then raise exception 'Not your shop' using errcode = '42501'; end if;
  return jsonb_build_object(
    'plan', public.shop_has_plan(p_shop_id),
    'rules', jsonb_build_object('enabled', v.enabled, 'min_notice', v.lead_minutes, 'max_days', v.horizon_days,
                                'step', v.step_minutes, 'max_per_contact_day', v.max_per_contact_day),
    'crm', jsonb_build_object('reminder_on', c.reminder_on, 'reminder_offset', c.reminder_offset,
                              'alert_email', c.alert_email, 'notify_on_owner_change', c.notify_on_owner_change),
    'services', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'duration', s.duration_minutes, 'buffer_before', s.buffer_before,
        'buffer_after', s.buffer_after, 'capacity', s.capacity, 'needs_resource', s.needs_resource, 'active', s.active,
        'offered_by_assistant', s.offered_by_assistant, 'note', s.note,
        'resource_ids', coalesce((select jsonb_agg(sr.resource_id) from public.booking_service_resources sr
                                  where sr.service_id = s.id), '[]'::jsonb)) order by s.position, s.name)
      from public.booking_services s where s.shop_id = p_shop_id), '[]'::jsonb),
    'resources', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'name', r.name, 'kind', r.kind, 'active', r.active, 'hours', r.hours) order by r.position, r.name)
      from public.booking_resources r where r.shop_id = p_shop_id), '[]'::jsonb),
    'blocks', coalesce((select jsonb_agg(jsonb_build_object(
        'id', b.id, 'resource_id', b.resource_id, 'starts_at', b.starts_at, 'ends_at', b.ends_at, 'note', b.note)
        order by b.starts_at)
      from public.booking_blocks b where b.shop_id = p_shop_id and b.ends_at > now()), '[]'::jsonb),
    'feed', (select jsonb_build_object('created_at', f.created_at) from public.shop_calendar_feeds f where f.shop_id = p_shop_id),
    'google', (select jsonb_build_object('status', g.status, 'last_error', g.last_error, 'connected_at', g.connected_at)
               from public.booking_google_connections g where g.shop_id = p_shop_id),
    'timezone', (select timezone from public.shops where id = p_shop_id)
  );
end;
$$;

-- ------------------------------------------------------------------ 3. the calendar feed (read-only, a secret link)

create table if not exists public.shop_calendar_feeds (
  shop_id    uuid primary key references public.shops (id) on delete cascade,
  token_hash text not null unique,
  created_by uuid,
  created_at timestamptz not null default now()
);
alter table public.shop_calendar_feeds enable row level security;
revoke all on public.shop_calendar_feeds from public, anon, authenticated;
grant all on public.shop_calendar_feeds to service_role;
grant select (shop_id, created_at) on public.shop_calendar_feeds to authenticated;
drop policy if exists "shop_calendar_feeds: members read" on public.shop_calendar_feeds;
create policy "shop_calendar_feeds: members read" on public.shop_calendar_feeds
  for select to authenticated using (public.is_shop_member(shop_id));

-- (owner_booking_setup above reads this table; created after it, so define the function again now that it exists)
revoke execute on function public.owner_booking_setup(uuid) from public, anon;
grant execute on function public.owner_booking_setup(uuid) to authenticated, service_role;

/** "Vygenerovať nový": a new secret link (shown once; the old one stops at once). Returns the token. */
create or replace function public.owner_calendar_feed_new(p_shop_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token text := 'cal_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  perform public.crm_owner_check(p_shop_id);
  insert into public.shop_calendar_feeds (shop_id, token_hash, created_by)
  values (p_shop_id, public.booking_hash(v_token), auth.uid())
  on conflict (shop_id) do update set token_hash = excluded.token_hash, created_by = excluded.created_by, created_at = now();
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'calendar_feed_created', '{}'::jsonb);
  return v_token;
end;
$$;
revoke execute on function public.owner_calendar_feed_new(uuid) from public, anon;
grant execute on function public.owner_calendar_feed_new(uuid) to authenticated, service_role;

create or replace function public.owner_calendar_feed_off(p_shop_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_shop_member(p_shop_id) then raise exception 'Not your shop' using errcode = '42501'; end if;
  delete from public.shop_calendar_feeds where shop_id = p_shop_id;
  if not found then return false; end if;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'calendar_feed_removed', '{}'::jsonb);
  return true;
end;
$$;
revoke execute on function public.owner_calendar_feed_off(uuid) from public, anon;
grant execute on function public.owner_calendar_feed_off(uuid) to authenticated, service_role;

/**
 * The feed's bookings for GET /api/calendar/<token>.ics (anon may call it with the token; nothing without it): the
 * shop's confirmed and done bookings from 60 days back to a year ahead, with the service, the resource and the
 * customer's FIRST name only — never a phone, an e-mail, an address or a note. Only while the shop has the plan.
 */
create or replace function public.calendar_feed(p_token text)
returns table (shop_name text, timezone text, booking_id uuid, starts_at timestamptz, ends_at timestamptz, status text,
               service_name text, resource_name text, first_name text, people integer, updated_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select s.name, s.timezone, b.id, b.starts_at, b.ends_at, b.status, coalesce(sv.name, b.service_name), r.name,
         nullif(split_part(btrim(coalesce(b.name, '')), ' ', 1), '—'), b.people,
         coalesce(b.updated_at, b.status_changed_at, b.created_at)
  from public.shop_calendar_feeds f
  join public.shops s on s.id = f.shop_id
  join public.shop_bookings b on b.shop_id = f.shop_id
  left join public.booking_services sv on sv.id = b.service_id
  left join public.booking_resources r on r.id = b.resource_id
  where length(coalesce(p_token, '')) between 40 and 100
    and f.token_hash = public.booking_hash(p_token)
    and public.shop_has_plan(f.shop_id)
    and b.status in ('confirmed', 'done')
    and b.starts_at between now() - interval '60 days' and now() + interval '366 days'
  order by b.starts_at
  limit 3000
$$;
revoke execute on function public.calendar_feed(text) from public;
grant execute on function public.calendar_feed(text) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ SMS codes (contact, booking, "Všetko o mne")

create table if not exists public.sms_codes (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references public.shops (id) on delete cascade,
  purpose         text not null check (purpose in ('contact', 'booking', 'delete_all')),
  phone_hash      text not null,
  -- the number and the name typed with the request: kept only until the code is used or runs out (tidied away)
  phone           text check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$'),
  name            text check (name is null or char_length(name) <= 80),
  code_hash       text,
  caller_hash     text not null,
  conversation_id uuid references public.assistant_conversations (id) on delete set null,
  consent_version text check (consent_version is null or char_length(consent_version) <= 40),
  attempts        integer not null default 0,
  expires_at      timestamptz not null,
  verified_at     timestamptz,
  used_at         timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists sms_codes_phone_idx on public.sms_codes (phone_hash, created_at desc);
create index if not exists sms_codes_caller_idx on public.sms_codes (caller_hash, created_at desc);
alter table public.sms_codes enable row level security;
revoke all on public.sms_codes from public, anon, authenticated;
grant all on public.sms_codes to service_role;

/** Codes older than a day lose the number and name they held (only the hashes stay for the limits). */
create or replace function public.sms_codes_tidy()
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.sms_codes set phone = null, name = null, code_hash = null
  where (expires_at < now() - interval '1 day' or used_at is not null) and (phone is not null or code_hash is not null);
  delete from public.sms_codes where created_at < now() - interval '30 days';
$$;
revoke execute on function public.sms_codes_tidy() from public, anon, authenticated;
grant execute on function public.sms_codes_tidy() to service_role;

/**
 * A new 6-digit code for a number (10 minutes, 5 tries): only for an active shop with the plan; at most 3 codes per
 * number an hour and 10 per caller an hour; for "contact" a conversation of that shop with its token is required. The
 * code itself is returned once for the SMS and never stored (SHA-256 with the code's id). Refusals (raised):
 * not_available, purpose, phone, name, conversation, too_many, sms_quota. Service role only (the crm function).
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
begin
  select * into v_shop from public.shops where slug = p_slug and is_active;
  if not found or not public.shop_has_plan(v_shop.id) then raise exception 'not_available' using errcode = 'P0001'; end if;
  if p_purpose is null or p_purpose not in ('contact', 'booking', 'delete_all') then raise exception 'purpose' using errcode = '22023'; end if;
  v_phone := public.crm_phone(p_phone, v_shop.country);
  if v_phone is null then raise exception 'phone' using errcode = '22023'; end if;
  if v_name is not null and char_length(v_name) > 80 then raise exception 'name' using errcode = '22023'; end if;
  if p_purpose = 'contact' and v_name is null then raise exception 'name' using errcode = '22023'; end if;
  if p_caller_hash is null or length(p_caller_hash) < 16 then raise exception 'Invalid caller hash' using errcode = '22023'; end if;
  if p_conversation_id is not null then
    select c.id into v_conv from public.assistant_conversations c
    where c.id = p_conversation_id and c.shop_id = v_shop.id and c.token_hash = public.assistant_token_hash(p_conversation_token);
  end if;
  if p_purpose in ('contact', 'booking') and v_conv is null then raise exception 'conversation' using errcode = '22023'; end if;
  v_hash := public.booking_hash(v_phone);
  perform pg_advisory_xact_lock(hashtextextended('ppi-sms-code:' || v_hash, 0));
  if (select count(*) from public.sms_codes where phone_hash = v_hash and created_at > now() - interval '1 hour') >= 3
     or (select count(*) from public.sms_codes where caller_hash = p_caller_hash and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'too_many' using errcode = '54000';
  end if;
  if public.sms_quota_left(v_shop.id, 'booking') < 1 then raise exception 'sms_quota' using errcode = '54000'; end if;
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

/** Writes the code's SMS into the message log (the code masked) and takes its parts of the "booking" quota. */
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
  perform public.sms_quota_take(v.shop_id, 'booking', v_parts);
  insert into public.shop_outgoing_messages (shop_id, contact_id, channel, recipient, body, status, kind, parts)
  values (v.shop_id, (select id from public.shop_contacts where shop_id = v.shop_id and phone = v.phone), 'sms', v.phone,
          regexp_replace(left(p_body, 480), '\d{6}', '••••••', 'g'), 'queued', 'sms_code', v_parts)
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.sms_code_claim(uuid, text) from public, anon, authenticated;
grant execute on function public.sms_code_claim(uuid, text) to service_role;

/**
 * The code typed into the page's own field (never the AI). {ok:false, reason: wrong_code (attempts_left) | expired |
 * too_many_attempts | not_found} or {ok:true, purpose, …}. For "contact": the contact is found by the number or made
 * (the same number in the same shop = the same contact; empty fields filled, nothing overwritten; the number is now
 * checked) and the conversation knows it (the assistant may book for it). "delete_all" is only marked verified (the
 * deletion itself: shopper_forget_all_*). Service role only.
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
  if v.purpose in ('contact', 'booking') then
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

-- ------------------------------------------------------------------ the shop assistant's booking tools (service role)

/** The services the assistant may offer (active, "offered by the assistant") of a shop that takes bookings now. */
create or replace function public.shop_booking_services(p_slug text)
returns table (id uuid, name text, duration_minutes integer, capacity integer, needs_resource boolean, note text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.name, s.duration_minutes, s.capacity, s.needs_resource, s.note
  from public.booking_shop(p_slug) b
  join public.booking_services s on s.shop_id = b.shop_id
  where s.active and s.offered_by_assistant and public.sms_quota_left(b.shop_id, 'booking') > 0
  order by s.position, s.name
$$;
revoke execute on function public.shop_booking_services(text) from public;
grant execute on function public.shop_booking_services(text) to anon, authenticated, service_role;

-- the slots the assistant offered in one conversation (the AI only ever sends back one of these short refs)
create table if not exists public.booking_offers (
  conversation_id uuid not null references public.assistant_conversations (id) on delete cascade,
  ref             text not null check (ref ~ '^s[0-9]{1,3}$'),
  shop_id         uuid not null references public.shops (id) on delete cascade,
  service_id      uuid not null references public.booking_services (id) on delete cascade,
  resource_id     uuid references public.booking_resources (id) on delete cascade,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  expires_at      timestamptz not null,
  primary key (conversation_id, ref)
);
alter table public.booking_offers enable row level security;
revoke all on public.booking_offers from public, anon, authenticated;
grant all on public.booking_offers to service_role;

/**
 * find_free_slots for the assistant: the free starts of an offered service in a conversation of the shop (with its
 * token) between two instants (≤ 14 days), at most 12, each with a short ref kept for 30 minutes. The rule is
 * booking_free_slots(). Service role only.
 */
create or replace function public.booking_offer_slots(
  p_slug text, p_conversation_id uuid, p_conversation_token text, p_service_id uuid, p_from timestamptz, p_to timestamptz,
  p_people integer default 1
)
returns table (ref text, starts_at timestamptz, ends_at timestamptz, resource_name text, seats_left integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
  v_conv uuid;
  v_n integer;
begin
  select b.shop_id into v_shop from public.booking_shop(p_slug) b;
  if v_shop is null then return; end if;
  if not exists (select 1 from public.booking_services s where s.id = p_service_id and s.shop_id = v_shop and s.active
                 and s.offered_by_assistant) then
    return;
  end if;
  select c.id into v_conv from public.assistant_conversations c
  where c.id = p_conversation_id and c.shop_id = v_shop and c.token_hash = public.assistant_token_hash(p_conversation_token);
  if v_conv is null then return; end if;
  delete from public.booking_offers where conversation_id = v_conv and expires_at < now();
  select count(*) into v_n from public.booking_offers where conversation_id = v_conv;
  if v_n > 900 then delete from public.booking_offers where conversation_id = v_conv; v_n := 0; end if;
  return query
  with f as (
    select x.starts_at, x.ends_at, x.resource_id, x.seats_left, row_number() over (order by x.starts_at) as n
    from public.booking_free_slots(v_shop, p_service_id, p_from, least(p_to, p_from + interval '14 days'), null, null,
                                   coalesce(p_people, 1)) x
    limit 12
  ), ins as (
    insert into public.booking_offers (conversation_id, ref, shop_id, service_id, resource_id, starts_at, ends_at, expires_at)
    select v_conv, 's' || (v_n + f.n)::text, v_shop, p_service_id, f.resource_id, f.starts_at, f.ends_at, now() + interval '30 minutes'
    from f
    on conflict on constraint booking_offers_pkey do update
      set service_id = excluded.service_id, resource_id = excluded.resource_id, starts_at = excluded.starts_at,
          ends_at = excluded.ends_at, expires_at = excluded.expires_at
    returning booking_offers.ref, booking_offers.starts_at, booking_offers.ends_at, booking_offers.resource_id
  )
  select ins.ref, ins.starts_at, ins.ends_at, r.name, f.seats_left
  from ins
  join f on f.starts_at = ins.starts_at and f.resource_id is not distinct from ins.resource_id
  left join public.booking_resources r on r.id = ins.resource_id
  order by ins.starts_at;
end;
$$;
revoke execute on function public.booking_offer_slots(text, uuid, text, uuid, timestamptz, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.booking_offer_slots(text, uuid, text, uuid, timestamptz, timestamptz, integer) to service_role;

/**
 * book_slot: books one of the refs this conversation was offered, for the contact verified in this conversation with
 * an SMS code (within 2 hours). booking_create() checks the slot again. Refusals (raised): not_available, conversation,
 * not_verified, ref, + booking_create's. Returns {id, starts_at, ends_at, service_name, resource_name}.
 */
create or replace function public.booking_assistant_book(
  p_slug text, p_conversation_id uuid, p_conversation_token text, p_ref text, p_people integer default 1
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
  v_conv public.assistant_conversations%rowtype;
  v_offer public.booking_offers%rowtype;
  v_id uuid;
begin
  select b.shop_id into v_shop from public.booking_shop(p_slug) b;
  if v_shop is null then raise exception 'not_available' using errcode = 'P0001'; end if;
  select * into v_conv from public.assistant_conversations c
  where c.id = p_conversation_id and c.shop_id = v_shop and c.token_hash = public.assistant_token_hash(p_conversation_token);
  if not found then raise exception 'conversation' using errcode = '22023'; end if;
  if v_conv.contact_id is null or v_conv.contact_verified_at is null or v_conv.contact_verified_at < now() - interval '2 hours' then
    raise exception 'not_verified' using errcode = 'P0001';
  end if;
  select * into v_offer from public.booking_offers
  where conversation_id = v_conv.id and ref = p_ref and expires_at > now();
  if not found then raise exception 'ref' using errcode = '22023'; end if;
  v_id := public.booking_create(v_shop, v_offer.service_id, v_offer.starts_at, v_offer.resource_id, p_people, v_conv.contact_id,
                                v_conv.id, 'assistant', null, null, coalesce(v_conv.contact_consent_version, 'chat-sms'));
  delete from public.booking_offers where conversation_id = v_conv.id;
  return (select jsonb_build_object('id', b.id, 'starts_at', b.starts_at, 'ends_at', b.ends_at,
                                    'service_name', b.service_name, 'resource_name', r.name, 'timezone', s.timezone)
          from public.shop_bookings b
          join public.shops s on s.id = b.shop_id
          left join public.booking_resources r on r.id = b.resource_id
          where b.id = v_id);
end;
$$;
revoke execute on function public.booking_assistant_book(text, uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.booking_assistant_book(text, uuid, text, text, integer) to service_role;

-- ------------------------------------------------------------------ "Vymazať moje údaje" → "Všetko o mne"

/**
 * After a verified delete_all code (within 15 minutes, used once): the shop's conversations of that number (by the
 * contact and by the number) for the archive function to forget one by one (files, PDFs; copied ones keep the
 * content-free line). Service role only.
 */
create or replace function public.shopper_forget_all_plan(p_code_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.sms_codes%rowtype;
  v_contact uuid;
begin
  select * into v from public.sms_codes where id = p_code_id;
  if not found or v.purpose <> 'delete_all' or v.verified_at is null or v.used_at is not null
     or v.verified_at < now() - interval '15 minutes' or v.phone is null then
    raise exception 'not_verified' using errcode = 'P0001';
  end if;
  select id into v_contact from public.shop_contacts where shop_id = v.shop_id and phone = v.phone;
  return jsonb_build_object(
    'shop_id', v.shop_id, 'contact_id', v_contact,
    'conversation_ids', coalesce((select jsonb_agg(c.id) from public.assistant_conversations c
                                  where c.shop_id = v.shop_id and c.shopper_deleted_at is null
                                    and (c.shopper_phone = v.phone or (v_contact is not null and c.contact_id = v_contact))),
                                 '[]'::jsonb));
end;
$$;
revoke execute on function public.shopper_forget_all_plan(uuid) from public, anon, authenticated;
grant execute on function public.shopper_forget_all_plan(uuid) to service_role;

/**
 * Finishes "Všetko o mne" (after the archive function forgot the conversations): future bookings cancelled (their
 * calendar events deleted when synced; the audit log keeps a line without personal data), every booking of that
 * number emptied of personal data, the message log's lines to it emptied, the conversations' remaining lines unlinked,
 * the contact deleted, the codes of that number deleted, and one e-mail to the owners queued (copies in their cloud or
 * PC folder must be deleted by them). Returns {ok, bookings_cancelled, had_data}. Once per code.
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
           or exists (select 1 from public.assistant_conversations where shop_id = v.shop_id and shopper_phone = v.phone);
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

-- ------------------------------------------------------------------ the owner's alerts: the shop's own address

/** As update 59, but to the shop's "alert_email" when it set one (else every owner), and for "Všetko o mne" too. */
create or replace function public.crm_alerts_due(p_limit integer default 20)
returns table (id uuid, shop_id uuid, shop_name text, shop_slug text, kind text, conversation_id uuid,
               question text, has_phone boolean, has_email boolean, recipients jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, s.id, s.name, s.slug, a.kind, a.conversation_id,
         (select left(coalesce(m.body_owner, m.body), 500) from public.assistant_messages m
          where m.conversation_id = a.conversation_id and m.role = 'shopper' order by m.id desc limit 1),
         c.shopper_phone is not null, c.callback_email is not null,
         case when cs.alert_email is not null
              then jsonb_build_array(jsonb_build_object('email', cs.alert_email,
                     'lang', coalesce((select p.language from public.shop_members sm join public.profiles p on p.user_id = sm.user_id
                                       where sm.shop_id = s.id order by sm.created_at limit 1), 'sk')))
              else coalesce((select jsonb_agg(jsonb_build_object('email', u.email, 'lang', coalesce(p.language, 'sk')))
                             from public.shop_members sm
                             join auth.users u on u.id = sm.user_id
                             left join public.profiles p on p.user_id = sm.user_id
                             where sm.shop_id = s.id and u.email is not null), '[]'::jsonb) end
  from public.shop_owner_alerts a
  join public.shops s on s.id = a.shop_id
  left join public.crm_settings cs on cs.shop_id = a.shop_id
  left join public.assistant_conversations c on c.id = a.conversation_id
  where a.sent_at is null and a.resolved_at is null and a.next_try_at <= now() and a.attempts < 10
  order by a.created_at
  limit least(greatest(coalesce(p_limit, 20), 1), 100)
$$;
revoke execute on function public.crm_alerts_due(integer) from public, anon, authenticated;
grant execute on function public.crm_alerts_due(integer) to service_role;

-- ------------------------------------------------------------------ the owner's reply in a conversation

/**
 * "Odpovedať" in a conversation: the message goes to the conversation's contact through owner_message_queue (quota,
 * 100 a day, the log) and is part of the conversation (role owner, its channel and template). Returns what to send.
 */
create or replace function public.owner_reply(
  p_conversation_id uuid, p_channel text, p_template_id uuid default null, p_subject text default null, p_body text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_conv public.assistant_conversations%rowtype;
  v jsonb;
begin
  select * into v_conv from public.assistant_conversations where id = p_conversation_id;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform public.crm_owner_check(v_conv.shop_id);
  if v_conv.contact_id is null then raise exception 'no_contact' using errcode = '22023'; end if;
  v := public.owner_message_queue(v_conv.contact_id, p_channel, p_template_id, p_subject, p_body);
  insert into public.assistant_messages (conversation_id, shop_id, role, body, channel, template_id, outgoing_id)
  values (v_conv.id, v_conv.shop_id, 'owner', left(v ->> 'body', 8000), p_channel, p_template_id, (v ->> 'id')::uuid);
  return v || jsonb_build_object('conversation_id', v_conv.id);
end;
$$;
revoke execute on function public.owner_reply(uuid, text, uuid, text, text) from public, anon;
grant execute on function public.owner_reply(uuid, text, uuid, text, text) to authenticated, service_role;

-- ------------------------------------------------------------------ the crm job: reminders, owner-change SMS, sync

/**
 * Reminders due now (update 57's job asks this): confirmed, ahead, not sent, the shop's reminder on (crm_settings; a
 * shop that never saved them keeps update 57's switch) — '2h': within the last two hours before the start;
 * 'day_before_18': the day before from 18:00 shop time (or the same day for a booking made after that). Only with the
 * plan and SMS left in the booking quota.
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
  left join public.crm_settings cs on cs.shop_id = b.shop_id
  left join public.shop_booking_settings st on st.shop_id = b.shop_id
  where b.status = 'confirmed' and b.phone is not null and b.reminder_sent_at is null and b.starts_at > now()
    and coalesce(cs.reminder_on, st.reminder, false)
    and case coalesce(cs.reminder_offset, 'day_before_18')
          when '2h' then b.starts_at <= now() + interval '2 hours'
          else ((b.starts_at at time zone s.timezone)::date = (now() at time zone s.timezone)::date + 1
                and (now() at time zone s.timezone)::time >= time '18:00')
               or ((b.starts_at at time zone s.timezone)::date = (now() at time zone s.timezone)::date
                   and b.created_at > ((b.starts_at at time zone s.timezone)::date - 1 + time '18:00') at time zone s.timezone)
        end
    and public.shop_has_plan(b.shop_id)
    and public.sms_quota_left(b.shop_id, 'booking') > 0
  order by b.starts_at
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
$$;
revoke execute on function public.booking_reminders_due(integer) from public, anon, authenticated;
grant execute on function public.booking_reminders_due(integer) to service_role;

/** The owner-change SMS due now (moved / cancelled), with what the text needs. Service role only. */
create or replace function public.booking_notifications_due(p_limit integer default 50)
returns table (id bigint, booking_id uuid, kind text, shop_id uuid, shop_name text, shop_phone text, timezone text,
               phone text, name text, starts_at timestamptz, lang text, service_name text, attempts integer)
language sql
stable
security definer
set search_path = ''
as $$
  select n.id, b.id, n.kind, s.id, s.name, s.phone, s.timezone, b.phone, b.name, b.starts_at, b.lang,
         coalesce(sv.name, b.service_name), n.attempts
  from public.booking_notifications n
  join public.shop_bookings b on b.id = n.booking_id
  join public.shops s on s.id = n.shop_id
  left join public.booking_services sv on sv.id = b.service_id
  where n.status = 'queued' and n.next_try_at <= now() and n.attempts < 3 and b.phone is not null
    and public.shop_has_plan(n.shop_id)
  order by n.next_try_at
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
$$;
revoke execute on function public.booking_notifications_due(integer) from public, anon, authenticated;
grant execute on function public.booking_notifications_due(integer) to service_role;

/** Writes the owner-change SMS down (booking quota; refused with sms_quota) before it is sent. */
create or replace function public.booking_notification_claim(p_id bigint, p_body text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  n public.booking_notifications%rowtype;
  v public.shop_bookings%rowtype;
  v_parts integer := public.crm_sms_parts(left(p_body, 480));
  v_id uuid;
begin
  select * into n from public.booking_notifications where id = p_id and status = 'queued' for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select * into v from public.shop_bookings where id = n.booking_id;
  perform public.sms_quota_take(v.shop_id, 'booking', v_parts);
  insert into public.shop_outgoing_messages (shop_id, contact_id, channel, recipient, body, status, kind, booking_id, parts)
  values (v.shop_id, v.contact_id, 'sms', v.phone, left(p_body, 480), 'queued',
          case n.kind when 'moved' then 'booking_moved' else 'booking_cancelled' end, v.id, v_parts)
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.booking_notification_claim(bigint, text) from public, anon, authenticated;
grant execute on function public.booking_notification_claim(bigint, text) to service_role;

/** What happened to one owner-change SMS: sent, or one more try (5 min · 2ⁿ), failed after the 3rd. */
create or replace function public.booking_notification_result(p_id bigint, p_ok boolean, p_error text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.booking_notifications
  set attempts = attempts + 1,
      status = case when p_ok then 'sent' when attempts + 1 >= 3 then 'failed' else 'queued' end,
      sent_at = case when p_ok then now() end,
      last_error = case when p_ok then null else left(p_error, 300) end,
      next_try_at = now() + interval '5 minutes' * power(2, attempts)
  where id = p_id and status = 'queued'
$$;
revoke execute on function public.booking_notification_result(bigint, boolean, text) from public, anon, authenticated;
grant execute on function public.booking_notification_result(bigint, boolean, text) to service_role;

/** As update 58, for every booking SMS kind of update 63 too (sent / failed / test, once). */
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
  where id = p_id and status = 'queued' and kind in ('booking_code', 'booking_reminder', 'sms_code', 'booking_moved', 'booking_cancelled')
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

/** The calendar pushes due now (3 tries; the connection must exist). */
create or replace function public.booking_sync_due(p_limit integer default 50)
returns table (id bigint, shop_id uuid, booking_id uuid, op text, google_event_id text, starts_at timestamptz,
               ends_at timestamptz, timezone text, summary text, status text, attempts integer)
language sql
stable
security definer
set search_path = ''
as $$
  select j.id, j.shop_id, j.booking_id, j.op, coalesce(j.google_event_id, b.google_event_id), b.starts_at, b.ends_at, s.timezone,
         concat_ws(' – ', coalesce(sv.name, b.service_name, 'Rezervácia'),
                   nullif(split_part(btrim(coalesce(b.name, '')), ' ', 1), '—'), r.name),
         b.status, j.attempts
  from public.booking_sync_jobs j
  join public.shops s on s.id = j.shop_id
  join public.booking_google_connections g on g.shop_id = j.shop_id
  left join public.shop_bookings b on b.id = j.booking_id
  left join public.booking_services sv on sv.id = b.service_id
  left join public.booking_resources r on r.id = b.resource_id
  where j.status = 'queued' and j.next_try_at <= now() and j.attempts < 3
  order by j.id
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
$$;
revoke execute on function public.booking_sync_due(integer) from public, anon, authenticated;
grant execute on function public.booking_sync_due(integer) to service_role;

/**
 * One push done or failed. A create keeps the event id on the booking (only events Cacaduu made are ever changed);
 * a failure is retried (5 min · 2ⁿ), after the 3rd the booking shows "failed" and the connection the error.
 */
create or replace function public.booking_sync_result(p_id bigint, p_ok boolean, p_event_id text, p_error text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  j public.booking_sync_jobs%rowtype;
begin
  select * into j from public.booking_sync_jobs where id = p_id and status = 'queued' for update;
  if not found then return; end if;
  if p_ok then
    update public.booking_sync_jobs set status = 'done', done_at = now(), attempts = attempts + 1, last_error = null,
                                        google_event_id = coalesce(left(p_event_id, 200), google_event_id)
    where id = p_id;
    if j.booking_id is not null then
      update public.shop_bookings
      set google_event_id = case when j.op = 'delete' then google_event_id else coalesce(left(p_event_id, 200), google_event_id) end,
          google_status = 'created'
      where id = j.booking_id;
    end if;
    update public.booking_google_connections set last_error = null where shop_id = j.shop_id and status = 'ok';
  else
    update public.booking_sync_jobs
    set attempts = attempts + 1, last_error = left(p_error, 300),
        status = case when attempts + 1 >= 3 then 'failed' else 'queued' end,
        next_try_at = now() + interval '5 minutes' * power(2, attempts)
    where id = p_id;
    if j.attempts + 1 >= 3 then
      if j.booking_id is not null then update public.shop_bookings set google_status = 'failed' where id = j.booking_id; end if;
      update public.booking_google_connections set last_error = left(p_error, 500) where shop_id = j.shop_id;
    end if;
  end if;
end;
$$;
revoke execute on function public.booking_sync_result(bigint, boolean, text, text) from public, anon, authenticated;
grant execute on function public.booking_sync_result(bigint, boolean, text, text) to service_role;

/** Replaces the connected calendar's busy times of a shop in [p_from, p_to) ([{start, end}] from freeBusy). */
create or replace function public.booking_calendar_busy_set(p_shop_id uuid, p_from timestamptz, p_to timestamptz, p_ranges jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  delete from public.booking_calendar_busy where shop_id = p_shop_id and starts_at < p_to and ends_at > p_from;
  insert into public.booking_calendar_busy (shop_id, starts_at, ends_at, source)
  select p_shop_id, (r ->> 'start')::timestamptz, (r ->> 'end')::timestamptz, 'google'
  from jsonb_array_elements(case when jsonb_typeof(p_ranges) = 'array' then p_ranges else '[]'::jsonb end) r
  where (r ->> 'end')::timestamptz > (r ->> 'start')::timestamptz
  limit 2000;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke execute on function public.booking_calendar_busy_set(uuid, timestamptz, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.booking_calendar_busy_set(uuid, timestamptz, timestamptz, jsonb) to service_role;

/** As update 57, and the busy times read from that calendar go with the connection (Cacaduu's bookings stay as they are). */
create or replace function public.booking_google_remove(p_shop_id uuid, p_user_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  with d as (delete from public.booking_google_connections where shop_id = p_shop_id returning 1),
       b as (delete from public.booking_calendar_busy where shop_id = p_shop_id and source = 'google' returning 1),
       j as (update public.booking_sync_jobs set status = 'skipped', done_at = now()
             where shop_id = p_shop_id and status = 'queued' returning 1),
       l as (insert into public.shop_activity (shop_id, actor, action, details)
             select p_shop_id, p_user_id, 'booking_calendar_disconnected', '{}'::jsonb where exists (select 1 from d)
             returning 1)
  select exists (select 1 from d)
$$;
revoke execute on function public.booking_google_remove(uuid, uuid) from public, anon, authenticated;
grant execute on function public.booking_google_remove(uuid, uuid) to service_role;

-- ------------------------------------------------------------------ the crm job every 5 minutes

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

-- update 57's hourly job now runs every 5 minutes (reminders, owner-change SMS, calendar sync, retries)
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
  perform cron.schedule('ppi-bookings-tick', '*/5 * * * *', v_call);
end;
$$;
