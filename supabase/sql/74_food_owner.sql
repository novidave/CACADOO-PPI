-- =====================================================================================================================
-- Update 74 — "Objednávky jedla" phase F3: the owner's side (Prompt 15, 2026-11-03; boards 11–14)
--
-- What the owner's screens, the alerts and the owner's AI tools need on top of update 73. Nothing here changes a price,
-- an order rule or a status rule (those stay in food_quote / food_order_create / food_order_step):
--   * The Objednávky tab: owner_food_tab() — whether the tab shows (ordering on) and how many orders are new.
--   * The owner's e-mail of a new order (food_order_alerts, written by food_order_create when "E-mail" is on): sent by
--     the crm-messages function's job (food_alerts_due → food_alert_result), kicked at once by a trigger (pg_net after
--     commit, else the 5-minute job). The e-mail carries the number, the time, pickup / delivery, the items and the
--     total — never the customer's phone number or address.
--   * Telegram (update 66): a new kind 'food_order' (one notification per order for every linked owner, when the
--     shop's "Telegram" alert is on). The bot that is live now does not know this kind, so the old reader
--     telegram_notify_due() never returns it; only the new reader telegram_notify_due_all() (the telegram function of
--     this phase) does — and it drops a food order notice older than 2 hours instead of sending it late.
--   * "Poslať zákazníkovi SMS „Objednávka je na ceste“": owner_food_sms_queue() writes the SMS down first (kind
--     order_on_way, the shop's monthly 'order' quota, once per order) and returns it to the crm-messages function,
--     which sends it and stores the result once (crm_message_result) — as every other SMS.
--   * "2 položky z PDF nie sú v Sklade": owner_food_menu_docs / owner_food_menu_text give the website the text of the
--     menu in the shop's Public folder (10 checks per shop and day); Claude only lists the dish names; the pairing with
--     Sklad's products is decided here (owner_food_menu_pair: trigram similarity of the names) and kept in
--     food_settings.menu_check. The assistant never offers a dish that is not a Sklad product with a price (update 73).
--   * The owner's MCP (updates 61, 64): list_food_orders (shop.read) and set_food_order_status (shop.write; without
--     confirm: true only before → after). The AI's tool data carry no phone number, address, note or place.
-- Needs updates 56–59, 61, 63, 64, 66, 73. Safe to run twice; nothing is deleted.
-- =====================================================================================================================

-- ------------------------------------------------------------------ 0. the activity log, the SMS kind, two columns

do $$
declare
  v_def text := (select pg_get_constraintdef(c.oid) from pg_constraint c
                 where c.conrelid = 'public.shop_activity'::regclass and c.conname = 'shop_activity_action_check');
  v_add text := '';
  a text;
begin
  if v_def is null then return; end if;
  foreach a in array array['food_menu_checked'] loop
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
                 where c.conrelid = 'public.shop_outgoing_messages'::regclass and c.conname = 'shop_outgoing_messages_kind_check');
begin
  if v_def is not null and position('''order_on_way''' in v_def) = 0 then
    alter table public.shop_outgoing_messages drop constraint shop_outgoing_messages_kind_check;
    execute 'alter table public.shop_outgoing_messages add constraint shop_outgoing_messages_kind_check '
            || replace(v_def, 'ARRAY[', 'ARRAY[''order_on_way''::text, ');
  end if;
end;
$$;

-- the order an SMS belongs to (the "on the way" SMS goes once per order)
alter table public.shop_outgoing_messages
  add column if not exists food_order_id uuid references public.food_orders (id) on delete set null;
create unique index if not exists shop_outgoing_messages_food_once_idx
  on public.shop_outgoing_messages (food_order_id) where kind = 'order_on_way' and status <> 'failed';

-- the last menu check: {checked_at, document_id, document, names, missing: [...]} (the owner's screen only)
alter table public.food_settings add column if not exists menu_check jsonb;

/** Which quota an SMS kind belongs to (update 73's rule + the "on the way" SMS of update 74). */
create or replace function public.sms_quota_of(p_kind text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_kind in ('booking_code', 'booking_reminder') then 'booking'
              when p_kind in ('order_code', 'order_on_way') then 'order'
              else 'owner' end
$$;
revoke execute on function public.sms_quota_of(text) from public, anon, authenticated;
grant execute on function public.sms_quota_of(text) to service_role;

-- ------------------------------------------------------------------ 1. the Objednávky tab

/** Whether the Asistent row shows "Objednávky" (ordering switched on) and its badge (orders still new). Members. */
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
    'latest', (select max(created_at) from public.food_orders where shop_id = p_shop_id));
end;
$$;
revoke execute on function public.owner_food_tab(uuid) from public, anon;
grant execute on function public.owner_food_tab(uuid) to authenticated;

-- ------------------------------------------------------------------ 2. the owner's e-mail of a new order

/** One line per item as the kitchen reads it: "2× Margherita 32 cm (+ olivy)". */
create or replace function public.food_order_items_text(p_order_id uuid, p_max integer default 600)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select left(string_agg(l.qty || '× ' || l.name || coalesce(' (' || l.extras_text || ')', ''), ', ' order by l.position),
              greatest(coalesce(p_max, 600), 40))
  from public.food_order_lines l where l.order_id = p_order_id
$$;
revoke execute on function public.food_order_items_text(uuid, integer) from public, anon, authenticated;
grant execute on function public.food_order_items_text(uuid, integer) to service_role;

/** The e-mails to send now (the crm-messages job): the order's summary and the shop's recipients (as update 63). */
create or replace function public.food_alerts_due(p_limit integer default 20)
returns table (id uuid, shop_id uuid, shop_name text, order_id uuid, number integer, kind text, pay_method text,
               total_cents integer, created_at timestamptz, ready_by timestamptz, timezone text, items text,
               recipients jsonb)
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
                             where sm.shop_id = s.id and u.email is not null), '[]'::jsonb) end
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

/** Sent, or one more try later (5 min · 2ⁿ, at most 6 hours). */
create or replace function public.food_alert_result(p_id uuid, p_ok boolean, p_error text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.food_order_alerts
  set sent_at = case when p_ok then now() end,
      attempts = attempts + 1,
      last_error = case when p_ok then null else left(p_error, 200) end,
      next_try_at = case when p_ok then next_try_at
                         else now() + least(interval '5 minutes' * power(2, attempts), interval '6 hours') end
  where id = p_id and sent_at is null
$$;
revoke execute on function public.food_alert_result(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.food_alert_result(uuid, boolean, text) to service_role;

/** A new alert row asks crm-messages to send at once (the same kick as update 59's alerts). */
create or replace function public.food_alert_kick_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.crm_alerts_kick();
  return null;
exception when others then
  return null;
end;
$$;
revoke execute on function public.food_alert_kick_trigger() from public, anon, authenticated;
drop trigger if exists food_order_alerts_kick on public.food_order_alerts;
create trigger food_order_alerts_kick after insert on public.food_order_alerts
  for each row execute function public.food_alert_kick_trigger();

-- ------------------------------------------------------------------ 3. Telegram: the kind 'food_order'

do $$
declare
  v_def text := (select pg_get_constraintdef(c.oid) from pg_constraint c
                 where c.conrelid = 'public.telegram_outbox'::regclass and c.conname = 'telegram_outbox_kind_check');
begin
  if v_def is not null and position('''food_order''' in v_def) = 0 then
    alter table public.telegram_outbox drop constraint telegram_outbox_kind_check;
    execute 'alter table public.telegram_outbox add constraint telegram_outbox_kind_check '
            || replace(v_def, 'ARRAY[', 'ARRAY[''food_order''::text, ');
  end if;
end;
$$;

/**
 * As update 66; a food order goes to every linked owner of the shop unless that link's prefs say food_order: false
 * (the shop's own switch is food_settings.alert_telegram, checked by the trigger).
 */
create or replace function public.telegram_notify(p_shop uuid, p_kind text, p_ref uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  insert into public.telegram_outbox (link_id, shop_id, kind, ref_id)
  select l.id, p_shop, p_kind, p_ref
  from public.telegram_links l
  join public.owner_mcp_tokens t on t.id = l.grant_id and t.revoked_at is null and t.access_expires_at > now()
  join public.telegram_shop_prefs p on p.link_id = l.id and p.shop_id = p_shop
  where p_shop = any (t.shop_ids)
    and coalesce((p.notify ->> p_kind)::boolean, p_kind = 'food_order')
    and exists (select 1 from public.shop_members m where m.shop_id = p_shop and m.user_id = l.user_id)
  on conflict do nothing;
  get diagnostics v_n = row_count;
  if v_n > 0 then perform public.telegram_kick(); end if;
  return v_n;
exception when others then
  -- a notification never costs the booking, the order or the shopper's message
  return 0;
end;
$$;
revoke execute on function public.telegram_notify(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.telegram_notify(uuid, text, uuid) to service_role;

/** A new order (the customer's code was right): one Telegram notice when the shop's "Telegram" alert is on. */
create or replace function public.telegram_food_order_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce((select alert_telegram from public.food_settings where shop_id = new.shop_id), false) then
    perform public.telegram_notify(new.shop_id, 'food_order', new.id);
  end if;
  return null;
exception when others then
  return null;
end;
$$;
revoke execute on function public.telegram_food_order_trigger() from public, anon, authenticated;
drop trigger if exists telegram_food_order_notify on public.food_orders;
create trigger telegram_food_order_notify after insert on public.food_orders
  for each row execute function public.telegram_food_order_trigger();

/**
 * update 66's reader, shared: p_food = false (the bot live before this phase) never takes a food order notice;
 * p_food = true (this phase's bot) takes them, drops one older than 2 hours (never sent late) and carries the order's
 * number, kind, total, time and items — never the customer's phone, address or note.
 */
create or replace function public.telegram_notify_take(p_limit integer, p_food boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r record;
  v_cap integer := coalesce((select notify_daily_cap from public.telegram_settings where id), 30);
  v_local time;
  v_end timestamptz;
  v_out jsonb := '[]'::jsonb;
begin
  if p_food then
    update public.telegram_outbox set status = 'skipped', reason = 'stale'
    where status = 'queued' and kind = 'food_order' and created_at < now() - interval '2 hours';
  end if;
  for r in
    select o.*, l.chat_id, l.user_id, l.grant_id, s.name as shop_name, s.slug, s.timezone, p.quiet_from, p.quiet_to,
           coalesce((select language from public.profiles where user_id = l.user_id), l.tg_lang, 'sk') as lang
    from public.telegram_outbox o
    join public.telegram_links l on l.id = o.link_id
    join public.shops s on s.id = o.shop_id
    left join public.telegram_shop_prefs p on p.link_id = o.link_id and p.shop_id = o.shop_id
    where o.status = 'queued' and o.not_before <= now() and (p_food or o.kind <> 'food_order')
    order by o.id
    limit least(greatest(coalesce(p_limit, 20), 1), 100)
    for update of o skip locked
  loop
    if not exists (select 1 from public.owner_mcp_tokens t where t.id = r.grant_id and t.revoked_at is null
                   and t.access_expires_at > now() and r.shop_id = any (t.shop_ids))
       or not public.shop_has_plan(r.shop_id)
       or not exists (select 1 from public.shop_members m where m.shop_id = r.shop_id and m.user_id = r.user_id) then
      update public.telegram_outbox set status = 'skipped', reason = 'no_access' where id = r.id;
      continue;
    end if;
    if r.quiet_from is not null and r.quiet_to is not null and r.quiet_from <> r.quiet_to and r.kind <> 'test' then
      v_local := (now() at time zone r.timezone)::time;
      if (r.quiet_from < r.quiet_to and v_local >= r.quiet_from and v_local < r.quiet_to)
         or (r.quiet_from > r.quiet_to and (v_local >= r.quiet_from or v_local < r.quiet_to)) then
        v_end := (((now() at time zone r.timezone)::date + case when v_local >= r.quiet_to then 1 else 0 end)
                  + r.quiet_to) at time zone r.timezone;
        update public.telegram_outbox set not_before = v_end where id = r.id;
        continue;
      end if;
    end if;
    if (select count(*) from public.telegram_outbox x where x.link_id = r.link_id and x.status = 'sent'
        and x.sent_at > now() - interval '24 hours') >= v_cap then
      update public.telegram_outbox set status = 'skipped', reason = 'daily_cap' where id = r.id;
      continue;
    end if;
    update public.telegram_outbox set attempts = attempts + 1, not_before = now() + interval '5 minutes' where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', r.id, 'chat_id', r.chat_id, 'lang', r.lang, 'kind', r.kind, 'shop', r.shop_name, 'slug', r.slug,
      'timezone', r.timezone, 'ref_id', r.ref_id,
      'booking', (select jsonb_build_object('starts_at', b.starts_at, 'service', b.service_name, 'name', b.name,
                                            'status', b.status)
                  from public.shop_bookings b where b.id = r.ref_id and r.kind in ('booking_new', 'booking_cancelled')),
      'question', (select left(c.first_question, 200) from public.assistant_conversations c
                   where c.id = r.ref_id and r.kind = 'callback'),
      'order', (select jsonb_build_object('number', fo.number, 'kind', fo.kind, 'total_cents', fo.total_cents,
                                          'pay_method', fo.pay_method, 'created_at', fo.created_at, 'ready_by', fo.ready_by,
                                          'items', public.food_order_items_text(fo.id, 300))
                from public.food_orders fo where fo.id = r.ref_id and r.kind = 'food_order')));
  end loop;
  return v_out;
end;
$$;
revoke execute on function public.telegram_notify_take(integer, boolean) from public, anon, authenticated;
grant execute on function public.telegram_notify_take(integer, boolean) to service_role;

/** update 66's reader, unchanged for the bot live before this phase: never a food order notice. */
create or replace function public.telegram_notify_due(p_limit integer default 20)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select public.telegram_notify_take(p_limit, false)
$$;
revoke execute on function public.telegram_notify_due(integer) from public, anon, authenticated;
grant execute on function public.telegram_notify_due(integer) to service_role;

/** This phase's reader: every kind, food orders too. */
create or replace function public.telegram_notify_due_all(p_limit integer default 20)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select public.telegram_notify_take(p_limit, true)
$$;
revoke execute on function public.telegram_notify_due_all(integer) from public, anon, authenticated;
grant execute on function public.telegram_notify_due_all(integer) to service_role;

-- ------------------------------------------------------------------ 4. "Objednávka je na ceste" (one SMS per order)

/** The SMS text in the order's language (Slovak, Hungarian, else English); short, so it is one SMS part. */
create or replace function public.food_on_way_text(p_shop text, p_number integer, p_lang text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case left(coalesce(p_lang, 'sk'), 2)
    when 'hu' then left(p_shop, 30) || ': a(z) ' || p_number || '. számú rendelés úton van.'
    when 'sk' then left(p_shop, 30) || ': objednávka č. ' || p_number || ' je na ceste.'
    when 'cs' then left(p_shop, 30) || ': objednávka č. ' || p_number || ' je na ceste.'
    else left(p_shop, 30) || ': order no. ' || p_number || ' is on its way.'
  end
$$;
revoke execute on function public.food_on_way_text(text, integer, text) from public, anon, authenticated;

/**
 * "Poslať zákazníkovi SMS „Objednávka je na ceste“": written down first (kind order_on_way, the 'order' quota —
 * sms_quota at the limit), once per order (a second time: already_sent), only for a delivery that has a number and
 * is not finished. Returns the message for the crm-messages function (which sends it and stores the result once).
 */
create or replace function public.owner_food_sms_queue(p_shop_id uuid, p_order_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  o public.food_orders;
  v_shop public.shops;
  v_body text;
  v_parts integer;
  v_id uuid;
begin
  perform public.food_owner_write(p_shop_id);
  select * into o from public.food_orders where id = p_order_id and shop_id = p_shop_id for update;
  if o.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if o.kind <> 'delivery' or o.status not in ('new', 'preparing', 'on_the_way') then raise exception 'step' using errcode = 'P0001'; end if;
  if o.phone is null then raise exception 'no_recipient' using errcode = '22023'; end if;
  if exists (select 1 from public.shop_outgoing_messages m
             where m.food_order_id = o.id and m.kind = 'order_on_way' and m.status <> 'failed') then
    raise exception 'already_sent' using errcode = '23505';
  end if;
  select * into v_shop from public.shops where id = p_shop_id;
  v_body := public.food_on_way_text(v_shop.name, o.number, o.lang);
  v_parts := public.crm_sms_parts(v_body);
  perform public.sms_quota_take(p_shop_id, 'order', v_parts);
  insert into public.shop_outgoing_messages (shop_id, contact_id, channel, recipient, body, status, kind, parts,
                                             food_order_id, sent_by)
  values (p_shop_id, o.contact_id, 'sms', o.phone, v_body, 'queued', 'order_on_way', v_parts, o.id, auth.uid())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'channel', 'sms', 'recipient', o.phone, 'subject', null, 'body', v_body,
                            'shop_name', v_shop.name, 'reply_to', null);
end;
$$;
revoke execute on function public.owner_food_sms_queue(uuid, uuid) from public, anon;
grant execute on function public.owner_food_sms_queue(uuid, uuid) to authenticated;

/** Whether this order's "on the way" SMS already went (the detail page hides the box then). */
create or replace function public.owner_food_sms_state(p_shop_id uuid, p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.sklad_member(p_shop_id);
  return jsonb_build_object(
    'sent', exists (select 1 from public.shop_outgoing_messages m where m.shop_id = p_shop_id and m.food_order_id = p_order_id
                    and m.kind = 'order_on_way' and m.status <> 'failed'),
    'quota', public.sms_quota_state(p_shop_id) -> 'order');
end;
$$;
revoke execute on function public.owner_food_sms_state(uuid, uuid) from public, anon;
grant execute on function public.owner_food_sms_state(uuid, uuid) to authenticated;

-- ------------------------------------------------------------------ 5. the menu check ("… nie sú v Sklade")

/** The documents of the shop's Public folder the assistant reads (the menu is usually one of them). */
create or replace function public.owner_food_menu_docs(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.sklad_member(p_shop_id);
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'pages', d.pages, 'created_at', d.created_at)
                     order by d.created_at desc)
    from public.shop_documents d
    join public.shop_folders f on f.id = d.folder_id and f.is_public
    where d.shop_id = p_shop_id and d.status = 'ready' and d.assistant_enabled), '[]'::jsonb);
end;
$$;
revoke execute on function public.owner_food_menu_docs(uuid) from public, anon;
grant execute on function public.owner_food_menu_docs(uuid) to authenticated;

/**
 * The text of one Public-folder document for the menu check (≤ 30 000 characters), at most 10 checks per shop and
 * day (each check is logged by owner_food_menu_pair; a text read without a pairing counts too).
 */
create or replace function public.owner_food_menu_text(p_shop_id uuid, p_document_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_text text;
begin
  perform public.food_owner_write(p_shop_id);
  if not exists (select 1 from public.shop_documents d join public.shop_folders f on f.id = d.folder_id and f.is_public
                 where d.id = p_document_id and d.shop_id = p_shop_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if (select count(*) from public.shop_activity a where a.shop_id = p_shop_id and a.action = 'food_menu_checked'
      and a.at > now() - interval '24 hours') >= 10 then
    raise exception 'too_many' using errcode = '54000';
  end if;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'food_menu_checked', jsonb_build_object('document', p_document_id, 'step', 'read'));
  select left(string_agg(c.text, E'\n' order by c.page nulls last, c.id), 30000) into v_text
  from public.shop_document_chunks c where c.document_id = p_document_id and c.type = 'text';
  return coalesce(v_text, '');
end;
$$;
revoke execute on function public.owner_food_menu_text(uuid, uuid) from public, anon;
grant execute on function public.owner_food_menu_text(uuid, uuid) to authenticated;

/**
 * The dish names Claude read from the menu, paired with Sklad's products that have a sale price (the closest name by
 * trigram similarity ≥ 0.45 of the folded names). The result is kept in food_settings.menu_check and returned.
 */
create or replace function public.owner_food_menu_pair(p_shop_id uuid, p_document_id uuid, p_names text[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_names text[];
  v_rows jsonb;
  v_doc text;
  v_check jsonb;
begin
  perform public.food_owner_write(p_shop_id);
  perform public.food_setup(p_shop_id);
  select d.name into v_doc from public.shop_documents d where d.id = p_document_id and d.shop_id = p_shop_id;
  if v_doc is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  select coalesce(array_agg(distinct x), '{}') into v_names
  from (select left(btrim(n), 120) x from unnest(coalesce(p_names, '{}')) n where nullif(btrim(n), '') is not null limit 200) t;
  select coalesce(jsonb_agg(jsonb_build_object('name', n.x, 'item_id', m.id, 'item', m.name, 'score', round(m.score::numeric, 2))
                            order by m.id is not null, n.x), '[]'::jsonb)
  into v_rows
  from unnest(v_names) n(x)
  left join lateral (
    select si.id, si.name, extensions.similarity(public.search_text(si.name), public.search_text(n.x)) score
    from public.sklad_items i join public.shop_items si on si.id = i.shop_item_id
    where i.shop_id = p_shop_id and i.sale_price is not null
    order by extensions.similarity(public.search_text(si.name), public.search_text(n.x)) desc
    limit 1
  ) m0 on true
  left join lateral (select m0.id, m0.name, m0.score where m0.score >= 0.45) m on true;
  v_check := jsonb_build_object(
    'checked_at', now(), 'document_id', p_document_id, 'document', v_doc, 'names', cardinality(v_names),
    'paired', (select count(*) from jsonb_array_elements(v_rows) r where r ->> 'item_id' is not null),
    'missing', coalesce((select jsonb_agg(r ->> 'name') from jsonb_array_elements(v_rows) r where r ->> 'item_id' is null), '[]'::jsonb),
    'rows', v_rows);
  update public.food_settings set menu_check = v_check, updated_at = now() where shop_id = p_shop_id;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'food_menu_checked',
          jsonb_build_object('document', p_document_id, 'step', 'paired', 'names', cardinality(v_names),
                             'missing', jsonb_array_length(v_check -> 'missing')));
  return v_check;
end;
$$;
revoke execute on function public.owner_food_menu_pair(uuid, uuid, text[]) from public, anon;
grant execute on function public.owner_food_menu_pair(uuid, uuid, text[]) to authenticated;

-- ------------------------------------------------------------------ 6. the owner's MCP: two food tools

create or replace function public.mcp_tool_scope(p_tool text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_tool in ('list_shops', 'get_shop_details', 'get_opening_hours', 'list_conversations', 'get_conversation',
                    'list_contacts', 'get_contact', 'list_bookings', 'list_email_templates', 'search_stock',
                    'get_sms_usage', 'list_booking_services', 'find_free_slots', 'list_food_orders') then 'shop.read'
    when p_tool in ('update_conversations', 'save_contact', 'delete_contact', 'set_booking_status', 'set_opening_hours',
                    'update_shop_details', 'update_stock', 'create_booking', 'move_booking', 'cancel_booking',
                    'set_food_order_status') then 'shop.write'
    when p_tool in ('preview_message') then 'messages.send'
  end
$$;
revoke execute on function public.mcp_tool_scope(text) from public, anon, authenticated;

/** One order as the AI's tools see it: no phone number, address, note or place. */
create or replace function public.mcp_food_order_json(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', o.id, 'number', o.number, 'status', o.status, 'kind', o.kind, 'pay_method', o.pay_method,
    'paid', o.paid_at is not null, 'total', round(o.total_cents / 100.0, 2), 'currency', o.currency,
    'customer', o.name, 'zone', o.zone_name,
    'placed_local', to_char(o.created_at at time zone coalesce(s.timezone, 'UTC'), 'YYYY-MM-DD HH24:MI'),
    'ready_by_local', to_char(o.ready_by at time zone coalesce(s.timezone, 'UTC'), 'YYYY-MM-DD HH24:MI'),
    'items', coalesce((select jsonb_agg(jsonb_build_object('qty', l.qty, 'name', l.name, 'extras', l.extras_text,
                                                           'price', round(l.line_cents / 100.0, 2)) order by l.position)
                       from public.food_order_lines l where l.order_id = o.id), '[]'::jsonb),
    'next_steps', case
      when o.status in ('delivered', 'picked_up', 'cancelled') then '[]'::jsonb
      when o.kind = 'delivery' then (select coalesce(jsonb_agg(x), '[]') from unnest(array['preparing', 'on_the_way', 'delivered', 'cancelled']) x
                                     where public.food_step_allowed(o.kind, o.status, x))
      else (select coalesce(jsonb_agg(x), '[]') from unnest(array['preparing', 'ready', 'picked_up', 'cancelled']) x
            where public.food_step_allowed(o.kind, o.status, x)) end)
  from public.food_orders o join public.shops s on s.id = o.shop_id
  where o.id = p_id
$$;
revoke execute on function public.mcp_food_order_json(uuid) from public, anon, authenticated;

-- update 64's door is kept under its own name (once); the food tools are answered here, every other tool there
do $$
begin
  if to_regprocedure('public.owner_mcp_call_64(text, text, jsonb)') is null
     and to_regprocedure('public.owner_mcp_call(text, text, jsonb)') is not null then
    alter function public.owner_mcp_call(text, text, jsonb) rename to owner_mcp_call_64;
  end if;
end;
$$;
revoke execute on function public.owner_mcp_call_64(text, text, jsonb) from public, anon, authenticated;

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
  v_to text;
  v_pay text;
  v_out jsonb;
  v_changed boolean := false;
  o public.food_orders;
begin
  if p_tool not in ('list_food_orders', 'set_food_order_status') then
    return public.owner_mcp_call_64(p_token, p_tool, p_args);
  end if;
  if jsonb_typeof(a) <> 'object' then raise exception 'bad_argument: arguments' using errcode = '22023'; end if;
  g := public.mcp_grant(p_token);
  v_scope := public.mcp_tool_scope(p_tool);
  if not v_scope = any (g.scopes) then raise exception 'scope: %', v_scope using errcode = '42501'; end if;
  perform public.mcp_act_as(g.user_id);

  if p_tool = 'set_food_order_status' then
    v_id := public.mcp_uuid(a, 'order_id');
    v_shop := public.mcp_own(g, (select shop_id from public.food_orders where id = v_id));
  else
    v_shop := public.mcp_shop(g, a ->> 'shop');
  end if;
  select slug into v_slug from public.shops where id = v_shop;

  if p_tool = 'list_food_orders' then
    v_to := coalesce(nullif(a ->> 'filter', ''), 'open');
    if v_to not in ('new', 'preparing', 'on_the_way', 'done', 'open') then raise exception 'bad_argument: filter' using errcode = '22023'; end if;
    select coalesce(jsonb_agg(public.mcp_food_order_json((x ->> 'id')::uuid)), '[]'::jsonb) into v_out
    from jsonb_array_elements(public.owner_food_orders(v_shop, v_to, public.mcp_int(a, 'limit', 50, 1, 100)) -> 'orders') x;
    v_out := jsonb_build_object('filter', v_to, 'orders', v_out,
                                'accepting', public.food_open_state(v_shop));

  else
    v_to := nullif(a ->> 'status', '');
    v_pay := nullif(a ->> 'paid_with', '');
    if v_to is null and v_pay is null then raise exception 'bad_argument: status' using errcode = '22023'; end if;
    if v_to is not null and v_to not in ('preparing', 'on_the_way', 'ready', 'delivered', 'picked_up', 'cancelled') then
      raise exception 'bad_argument: status' using errcode = '22023';
    end if;
    if v_pay is not null and v_pay not in ('qr', 'cash', 'card') then raise exception 'bad_argument: paid_with' using errcode = '22023'; end if;
    select * into o from public.food_orders where id = v_id;
    if coalesce((a ->> 'confirm')::boolean, false) then
      v_out := public.owner_food_order_status(v_shop, v_id, v_to, coalesce(nullif(a ->> 'step_id', '')::uuid, gen_random_uuid()),
                                              v_pay, null, public.mcp_text(a, 'reason', 200));
      v_out := jsonb_build_object('changed', true, 'order', public.mcp_food_order_json(v_id));
      v_changed := true;
    else
      v_out := jsonb_build_object(
        'changed', false,
        'needs_confirm', 'Show the owner before → after and call again with confirm: true after they agree.',
        'before', public.mcp_food_order_json(v_id),
        'after', jsonb_build_object('status', coalesce(v_to, o.status), 'paid_with', v_pay),
        'allowed', v_to is null or public.food_step_allowed(o.kind, o.status, v_to),
        'needs_payment_first', v_to in ('delivered', 'picked_up') and o.paid_at is null and v_pay is null);
    end if;
  end if;

  return jsonb_build_object('shop', v_slug, 'result', coalesce(v_out, 'null'::jsonb), 'changed', v_changed);
end;
$$;
revoke execute on function public.owner_mcp_call(text, text, jsonb) from public;
grant execute on function public.owner_mcp_call(text, text, jsonb) to anon, authenticated, service_role;
