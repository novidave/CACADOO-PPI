-- PPI · database update 59 — unanswered questions: the shopper leaves a phone or e-mail (CRM phase 5, 30 October 2026)
--
-- When the shop assistant cannot answer (its call_shop: the conversation is "Bez odpovede", update 55), the chat shows
-- the page's own small form — never the AI: a phone or an e-mail (at least one), an optional name and the consent.
-- shopper_leave_contact() (the website, as a visitor, with the conversation's own token):
--   * finds the shop's contact by the phone (crm_phone, update 56) or else by the e-mail, or makes one (source chat);
--     fills only empty fields; a number left here is never "overené" (only a booking's SMS code verifies, update 57);
--   * joins the conversation to the contact (shopper_phone + contact_id), marks it new and "Bez odpovede", and keeps
--     when and how the shopper asked to be answered (callback_*);
--   * queues one e-mail to the shop's owners — "Nový zákazník, prosím odpovedzte" (shop_owner_alerts, sent by the
--     crm-messages function: at once through pg_net and by the job every 5 minutes) — and logs callback_requested.
-- The owner answers from the conversation or the contact card (SMS or e-mail, update 56 / 58 rules); a sent answer to
-- that contact marks the waiting conversation answered (crm_message_result), or the owner marks it "Vybavené".
-- Môj obchod shows how many wait (owner_callbacks_waiting(): the menu's badge) and the list (owner_callbacks()).
--
-- Paste the whole file into Supabase → SQL Editor → Run. Safe to run again. Needs updates 55, 56 and 58.

-- ------------------------------------------------------------------ the conversation's callback

alter table public.assistant_conversations
  add column if not exists callback_at timestamptz,
  add column if not exists callback_name text check (callback_name is null or char_length(callback_name) <= 120),
  add column if not exists callback_email text check (callback_email is null or char_length(callback_email) <= 254),
  add column if not exists callback_consent_version text,
  add column if not exists callback_answered_at timestamptz,
  add column if not exists callback_answered_by uuid,
  add column if not exists callback_caller text;
create index if not exists assistant_conversations_callback_idx
  on public.assistant_conversations (shop_id, callback_at desc) where callback_at is not null;
grant select (callback_at, callback_name, callback_email, callback_answered_at) on public.assistant_conversations to authenticated;

-- ------------------------------------------------------------------ e-mails to the owners (queue)

create table if not exists public.shop_owner_alerts (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references public.shops (id) on delete cascade,
  kind            text not null check (kind in ('callback')),
  conversation_id uuid references public.assistant_conversations (id) on delete cascade,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  attempts        integer not null default 0,
  last_error      text,
  next_try_at     timestamptz not null default now()
);
create index if not exists shop_owner_alerts_due_idx on public.shop_owner_alerts (next_try_at) where sent_at is null;
alter table public.shop_owner_alerts enable row level security;
revoke all on public.shop_owner_alerts from public, anon, authenticated;
grant all on public.shop_owner_alerts to service_role;

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
                    'booking_calendar_connected', 'booking_calendar_disconnected',
                    'callback_requested', 'callback_done', 'callback_reopened'));

-- ------------------------------------------------------------------ the job's secret and the kick

create or replace function public.crm_cron_ok(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(length(p_secret) >= 32 and exists (
    select 1 from vault.decrypted_secrets
    where name = 'ppi_crm_cron'
      and encode(sha256(convert_to(decrypted_secret, 'UTF8')), 'hex')
          = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')), false)
$$;
revoke execute on function public.crm_cron_ok(text) from public, anon, authenticated;
grant execute on function public.crm_cron_ok(text) to service_role;

do $$
begin
  if to_regclass('vault.secrets') is not null
     and not exists (select 1 from vault.secrets where name = 'ppi_crm_cron') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      'ppi_crm_cron', 'PPI: the CRM job proves itself to the crm-messages function');
  end if;
end;
$$;

/**
 * Asks the crm-messages function to send the waiting owner e-mails now (pg_net, after the transaction commits).
 * Without pg_net or the Vault secrets nothing happens here: the job every 5 minutes sends them.
 */
create or replace function public.crm_alerts_kick()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null or to_regclass('vault.decrypted_secrets') is null then
    return;
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'ppi_project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'ppi_crm_cron';
  if v_url is null or v_secret is null then return; end if;
  execute 'select net.http_post(url := $1, body := $2, params := ''{}''::jsonb, headers := $3, timeout_milliseconds := 30000)'
  using v_url || '/functions/v1/crm-messages', jsonb_build_object('action', 'alerts'),
        jsonb_build_object('Content-Type', 'application/json', 'x-ppi-cron', v_secret);
exception when others then
  -- never let a missing extension cost the shopper their message: the job sends it later
  null;
end;
$$;
revoke execute on function public.crm_alerts_kick() from public, anon, authenticated;
grant execute on function public.crm_alerts_kick() to service_role;

-- ------------------------------------------------------------------ the shopper leaves a contact

/**
 * "Nechajte nám kontakt": the conversation's own token proves it is the shopper's. Refusals (raised): not_available
 * (no such open conversation of a shop with the plan, or older than 24 hours), consent, empty (neither phone nor
 * e-mail), phone, email, name, too_many (3 per conversation, 5 per caller an hour, 100 per shop a day).
 * Returns {ok: true} only — never whether the shop already knew the person.
 */
create or replace function public.shopper_leave_contact(
  p_slug text, p_conversation_id uuid, p_token text, p_name text, p_phone text, p_email text,
  p_consent boolean, p_consent_version text, p_caller_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_conv public.assistant_conversations%rowtype;
  v_shop public.shops%rowtype;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_raw_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_phone text;
  v_contact uuid;
begin
  select * into v_shop from public.shops where slug = p_slug and is_active;
  if not found or not public.shop_has_plan(v_shop.id) then raise exception 'not_available' using errcode = 'P0001'; end if;
  select * into v_conv from public.assistant_conversations
  where id = p_conversation_id and shop_id = v_shop.id and token_hash = public.assistant_token_hash(p_token)
    and started_at > now() - interval '24 hours'
  for update;
  if not found then raise exception 'not_available' using errcode = 'P0001'; end if;
  if p_consent is not true or nullif(btrim(coalesce(p_consent_version, '')), '') is null then
    raise exception 'consent' using errcode = '22023';
  end if;
  if v_raw_phone is null and v_email is null then raise exception 'empty' using errcode = '22023'; end if;
  if v_raw_phone is not null then
    v_phone := public.crm_phone(v_raw_phone, v_shop.country);
    if v_phone is null then raise exception 'phone' using errcode = '22023'; end if;
  end if;
  if v_email is not null and (char_length(v_email) > 254 or v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'email' using errcode = '22023';
  end if;
  if v_name is not null and char_length(v_name) > 120 then raise exception 'name' using errcode = '22023'; end if;
  if p_caller_hash is null or length(p_caller_hash) < 16 then raise exception 'Invalid caller hash' using errcode = '22023'; end if;
  if (select count(*) from public.shop_activity where shop_id = v_shop.id and action = 'callback_requested'
      and details ->> 'conversation_id' = v_conv.id::text) >= 3
     or (select count(*) from public.assistant_conversations where callback_caller = p_caller_hash
         and callback_at > now() - interval '1 hour' and id <> v_conv.id) >= 5
     or (select count(*) from public.shop_activity where shop_id = v_shop.id and action = 'callback_requested'
         and at > now() - interval '1 day') >= 100 then
    raise exception 'too_many' using errcode = '54000';
  end if;

  -- the contact: by the phone, else by the e-mail, else a new one
  if v_phone is not null then
    select id into v_contact from public.shop_contacts where shop_id = v_shop.id and phone = v_phone;
  end if;
  if v_contact is null and v_email is not null then
    select id into v_contact from public.shop_contacts where shop_id = v_shop.id and email = v_email
    order by updated_at desc limit 1;
  end if;
  if v_contact is null then
    insert into public.shop_contacts (shop_id, name, phone, email, source)
    values (v_shop.id, v_name, v_phone, v_email, 'chat')
    returning id into v_contact;
  else
    update public.shop_contacts
    set name = coalesce(name, v_name),
        phone = coalesce(phone, case when v_phone is not null
                                      and not exists (select 1 from public.shop_contacts o
                                                      where o.shop_id = v_shop.id and o.phone = v_phone and o.id <> v_contact)
                                     then v_phone end),
        email = coalesce(email, v_email),
        updated_at = now()
    where id = v_contact;
  end if;

  update public.assistant_conversations
  set contact_id = v_contact,
      shopper_phone = coalesce(v_phone, shopper_phone),
      unanswered = true,
      status = 'new',
      callback_at = now(),
      callback_name = coalesce(v_name, callback_name),
      callback_email = coalesce(v_email, callback_email),
      callback_consent_version = left(btrim(p_consent_version), 40),
      callback_answered_at = null,
      callback_answered_by = null,
      callback_caller = p_caller_hash
  where id = v_conv.id;

  insert into public.shop_owner_alerts (shop_id, kind, conversation_id) values (v_shop.id, 'callback', v_conv.id);
  insert into public.shop_activity (shop_id, actor, action, details)
  values (v_shop.id, null, 'callback_requested',
          jsonb_build_object('conversation_id', v_conv.id, 'contact_id', v_contact,
                             'phone', v_phone is not null, 'email', v_email is not null));
  perform public.crm_alerts_kick();
  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.shopper_leave_contact(text, uuid, text, text, text, text, boolean, text, text) from public;
grant execute on function public.shopper_leave_contact(text, uuid, text, text, text, text, boolean, text, text)
  to anon, authenticated, service_role;

-- ------------------------------------------------------------------ the owner e-mails (service role: crm-messages)

/**
 * Owner e-mails due now: the shop, its owners' addresses and languages, the conversation, the question that was not
 * answered (the shopper's last message, in Slovak when the archive has it), and whether a phone / e-mail was left
 * (never the number or address itself). At most 10 tries, waiting longer after each.
 */
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
         coalesce((select jsonb_agg(jsonb_build_object('email', u.email, 'lang', coalesce(p.language, 'sk')))
                   from public.shop_members sm
                   join auth.users u on u.id = sm.user_id
                   left join public.profiles p on p.user_id = sm.user_id
                   where sm.shop_id = s.id and u.email is not null), '[]'::jsonb)
  from public.shop_owner_alerts a
  join public.shops s on s.id = a.shop_id
  left join public.assistant_conversations c on c.id = a.conversation_id
  where a.sent_at is null and a.next_try_at <= now() and a.attempts < 10
  order by a.created_at
  limit least(greatest(coalesce(p_limit, 20), 1), 100)
$$;
revoke execute on function public.crm_alerts_due(integer) from public, anon, authenticated;
grant execute on function public.crm_alerts_due(integer) to service_role;

/** What happened to one owner e-mail: sent, or one more try later (5 min · 2ⁿ, at most 6 hours). */
create or replace function public.crm_alert_result(p_id uuid, p_ok boolean, p_error text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.shop_owner_alerts
  set sent_at = case when p_ok then now() end,
      attempts = attempts + 1,
      last_error = case when p_ok then null else left(p_error, 300) end,
      next_try_at = case when p_ok then next_try_at
                         else now() + least(interval '5 minutes' * power(2, attempts), interval '6 hours') end
  where id = p_id and sent_at is null
$$;
revoke execute on function public.crm_alert_result(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.crm_alert_result(uuid, boolean, text) to service_role;

-- ------------------------------------------------------------------ the owner: the list, the badge, "Vybavené"

/** "Čakajú na odpoveď" in Môj obchod: conversations whose shopper left a contact, the waiting ones first. */
create or replace function public.owner_callbacks(p_shop_id uuid, p_limit integer default 50)
returns table (conversation_id uuid, callback_at timestamptz, answered_at timestamptz, name text, contact_id uuid,
               contact_name text, phone text, email text, question text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_shop_member(p_shop_id) then raise exception 'Not a member of this shop' using errcode = '42501'; end if;
  return query
  select c.id, c.callback_at, c.callback_answered_at, c.callback_name, c.contact_id, k.name,
         coalesce(k.phone, c.shopper_phone), coalesce(k.email, c.callback_email),
         (select left(coalesce(m.body_owner, m.body), 300) from public.assistant_messages m
          where m.conversation_id = c.id and m.role = 'shopper' order by m.id desc limit 1)
  from public.assistant_conversations c
  left join public.shop_contacts k on k.id = c.contact_id
  where c.shop_id = p_shop_id and c.callback_at is not null
    and (c.callback_answered_at is null or c.callback_answered_at > now() - interval '30 days')
  order by (c.callback_answered_at is null) desc, c.callback_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;
revoke execute on function public.owner_callbacks(uuid, integer) from public, anon;
grant execute on function public.owner_callbacks(uuid, integer) to authenticated, service_role;

/** The menu's badge: per shop of the caller, how many shoppers wait for an answer. */
create or replace function public.owner_callbacks_waiting()
returns table (shop_id uuid, waiting bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select c.shop_id, count(*)
  from public.assistant_conversations c
  join public.shop_members m on m.shop_id = c.shop_id and m.user_id = auth.uid()
  where c.callback_at is not null and c.callback_answered_at is null
  group by c.shop_id
$$;
revoke execute on function public.owner_callbacks_waiting() from public, anon;
grant execute on function public.owner_callbacks_waiting() to authenticated, service_role;

/** "Vybavené" (p_done true) or "Vrátiť medzi čakajúce" (false); logged. */
create or replace function public.owner_callback_done(p_conversation_id uuid, p_done boolean)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.assistant_conversations%rowtype;
begin
  select * into v from public.assistant_conversations where id = p_conversation_id;
  if not found or not public.is_shop_member(v.shop_id) then raise exception 'Not a member of this shop' using errcode = '42501'; end if;
  if v.callback_at is null then return false; end if;
  update public.assistant_conversations
  set callback_answered_at = case when p_done then coalesce(callback_answered_at, now()) end,
      callback_answered_by = case when p_done then coalesce(callback_answered_by, auth.uid()) end
  where id = p_conversation_id;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (v.shop_id, auth.uid(), case when p_done then 'callback_done' else 'callback_reopened' end,
          jsonb_build_object('conversation_id', v.id));
  return true;
end;
$$;
revoke execute on function public.owner_callback_done(uuid, boolean) from public, anon;
grant execute on function public.owner_callback_done(uuid, boolean) to authenticated, service_role;

-- ------------------------------------------------------------------ an answer sent marks the conversation answered

/** As update 56; a sent (or test) owner message to a contact also marks that contact's waiting conversations answered. */
create or replace function public.crm_message_result(p_id uuid, p_status text, p_provider text, p_ref text, p_error text)
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
  returning * into v;
  if not found then return false; end if;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (v.shop_id, v.sent_by, 'message_sent',
          jsonb_build_object('message_id', v.id, 'channel', v.channel, 'status', p_status, 'contact_id', v.contact_id));
  if p_status in ('sent', 'test') and v.contact_id is not null and v.kind = 'owner' then
    update public.assistant_conversations
    set callback_answered_at = now(), callback_answered_by = v.sent_by
    where contact_id = v.contact_id and shop_id = v.shop_id and callback_at is not null and callback_answered_at is null;
  end if;
  return true;
end;
$$;
revoke execute on function public.crm_message_result(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.crm_message_result(uuid, text, text, text, text) to service_role;

-- ------------------------------------------------------------------ the job (every 5 minutes: owner e-mails left over)

do $$
declare
  v_call text := $call$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_project_url') || '/functions/v1/crm-messages',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'x-ppi-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_crm_cron')),
      body := jsonb_build_object('action', 'alerts'),
      timeout_milliseconds := 30000)$call$;
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'cron' and p.proname = 'schedule') then
    raise notice 'pg_cron is not on: switch on pg_cron and pg_net (Database → Extensions), then run this file again.';
    return;
  end if;
  perform cron.schedule('ppi-crm-alerts-tick', '*/5 * * * *', v_call);
end;
$$;
