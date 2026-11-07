-- PPI · database update 91 — AI asistent → Nastavenia, "Keď asistent nevie odpovedať" (2026-11-07, the owner's request;
-- canvas "Cacaduu – webová aplikácia (Môj obchod)", artboard 12). Two switches that had no stored setting yet; both
-- default to today's behaviour (on), so nothing changes for any shop until its owner switches one off.
--
--   shop_assistant_settings.ask_contact      "Poprosiť zákazníka o kontakt": the page's callback form after the
--                                            assistant's call_shop (update 59). Read by the chat (shop_asks_contact).
--   shop_assistant_settings.alert_email_on   "Upozorniť ma e-mailom": crm-messages' alert e-mail for a callback (update
--                                            59). crm_alerts_due() leaves the shop's alerts out while it is off.
--   owner_assistant_flags(shop)              members read {ask_contact, alert_email_on}
--   owner_save_assistant_flags(shop, jsonb)  members write; only the keys it gets change; a change of the e-mail switch
--                                            closes the shop's unsent alerts (never e-mailed later, never twice)
--   shop_asks_contact(slug)                  anyone (the chat route): true unless the owner switched it off
--
-- "Upozorniť ma v Telegrame" is update 66's existing per-shop notice `callback` (owner_telegram_save_prefs): no change.

alter table public.shop_assistant_settings add column if not exists ask_contact boolean not null default true;
alter table public.shop_assistant_settings add column if not exists alert_email_on boolean not null default true;

/** The two switches of a shop (members only); a shop without a settings row reads both on. */
create or replace function public.owner_assistant_flags(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_build_object('ask_contact', s.ask_contact, 'alert_email_on', s.alert_email_on)
    from public.shop_assistant_settings s where s.shop_id = p_shop_id
  ), jsonb_build_object('ask_contact', true, 'alert_email_on', true));
end;
$$;
revoke execute on function public.owner_assistant_flags(uuid) from public, anon;
grant execute on function public.owner_assistant_flags(uuid) to authenticated, service_role;

/**
 * Saves the switches it gets (`ask_contact`, `alert_email_on`, booleans); other keys are ignored. When the e-mail switch
 * changes, the shop's alerts not sent yet are closed (resolved): switched off they are not wanted, switched on again the
 * ones that waited while it was off are old news. Returns the switches as stored.
 */
create or replace function public.owner_save_assistant_flags(p_shop_id uuid, p_flags jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_before boolean;
  v_ask boolean;
  v_email boolean;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if p_flags is null or jsonb_typeof(p_flags) <> 'object' then
    raise exception 'flags' using errcode = '22023';
  end if;
  if p_flags ? 'ask_contact' and jsonb_typeof(p_flags -> 'ask_contact') <> 'boolean' then
    raise exception 'flags' using errcode = '22023';
  end if;
  if p_flags ? 'alert_email_on' and jsonb_typeof(p_flags -> 'alert_email_on') <> 'boolean' then
    raise exception 'flags' using errcode = '22023';
  end if;
  select s.alert_email_on into v_before from public.shop_assistant_settings s where s.shop_id = p_shop_id;
  v_before := coalesce(v_before, true);
  insert into public.shop_assistant_settings (shop_id) values (p_shop_id) on conflict (shop_id) do nothing;
  update public.shop_assistant_settings s
     set ask_contact = case when p_flags ? 'ask_contact' then (p_flags ->> 'ask_contact')::boolean else s.ask_contact end,
         alert_email_on = case when p_flags ? 'alert_email_on' then (p_flags ->> 'alert_email_on')::boolean else s.alert_email_on end,
         updated_at = now()
   where s.shop_id = p_shop_id
  returning s.ask_contact, s.alert_email_on into v_ask, v_email;
  if v_email is distinct from v_before then
    update public.shop_owner_alerts a set resolved_at = now()
     where a.shop_id = p_shop_id and a.sent_at is null and a.resolved_at is null;
  end if;
  return jsonb_build_object('ask_contact', v_ask, 'alert_email_on', v_email);
end;
$$;
revoke execute on function public.owner_save_assistant_flags(uuid, jsonb) from public, anon;
grant execute on function public.owner_save_assistant_flags(uuid, jsonb) to authenticated, service_role;

/** Whether the shop's assistant offers "Nechajte nám kontakt" after an unanswered question (true unless switched off). */
create or replace function public.shop_asks_contact(p_slug text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select s.ask_contact from public.shop_assistant_settings s
    join public.shops sh on sh.id = s.shop_id
    where sh.slug = p_slug
  ), true)
$$;
revoke execute on function public.shop_asks_contact(text) from public;
grant execute on function public.shop_asks_contact(text) to anon, authenticated, service_role;

/** update 59's alerts to e-mail, without the shops whose owner switched "Upozorniť ma e-mailom" off. */
create or replace function public.crm_alerts_due(p_limit integer default 20)
returns table (id uuid, shop_id uuid, shop_name text, shop_slug text, kind text, conversation_id uuid, question text,
               has_phone boolean, has_email boolean, recipients jsonb)
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
    and coalesce((select x.alert_email_on from public.shop_assistant_settings x where x.shop_id = a.shop_id), true)
  order by a.created_at
  limit least(greatest(coalesce(p_limit, 20), 1), 100)
$$;
revoke execute on function public.crm_alerts_due(integer) from public, anon, authenticated;
grant execute on function public.crm_alerts_due(integer) to service_role;
