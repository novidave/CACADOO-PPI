-- Update 89 (2026-11-07, the owner's request "SMS a Telegram"): the booking SMS switches moved from Rezervácie →
-- Nastavenia to the owner's page "SMS a Telegram", while the alert e-mail stays on Rezervácie → Nastavenia. Two screens
-- now save parts of the same crm_settings row, so each must change ONLY the keys it sends.
--
-- owner_save_crm_settings(shop, settings jsonb): only the keys present change —
--   reminder_on (boolean), reminder_offset ('2h' | 'day_before_18'), alert_email (text, '' or null = none),
--   notify_on_owner_change (boolean); any other key is ignored. Members only (crm_owner_check), the same checks and
--   the same activity 'crm_settings_saved' (details = the keys that were sent).
-- Update 63's five-argument function stays as it is (the live website calls it until this change is merged).

create or replace function public.owner_save_crm_settings(p_shop_id uuid, p_settings jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  p jsonb := case when jsonb_typeof(p_settings) = 'object' then p_settings else '{}'::jsonb end;
  c public.crm_settings;
  v_email text;
  v_offset text;
  v_details jsonb := '{}'::jsonb;
begin
  perform public.crm_owner_check(p_shop_id);
  c := public.crm_settings_of(p_shop_id);

  if p ? 'reminder_on' then
    if jsonb_typeof(p -> 'reminder_on') <> 'boolean' then raise exception 'reminder_on' using errcode = '22023'; end if;
    c.reminder_on := (p ->> 'reminder_on')::boolean;
    v_details := v_details || jsonb_build_object('reminder_on', c.reminder_on);
  end if;
  if p ? 'reminder_offset' then
    v_offset := p ->> 'reminder_offset';
    if v_offset is null or v_offset not in ('2h', 'day_before_18') then
      raise exception 'offset' using errcode = '22023';
    end if;
    c.reminder_offset := v_offset;
    v_details := v_details || jsonb_build_object('offset', v_offset);
  end if;
  if p ? 'alert_email' then
    v_email := nullif(lower(btrim(coalesce(p ->> 'alert_email', ''))), '');
    if v_email is not null and (char_length(v_email) > 254 or v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
      raise exception 'email' using errcode = '22023';
    end if;
    c.alert_email := v_email;
    v_details := v_details || jsonb_build_object('alert_email', v_email is not null);
  end if;
  if p ? 'notify_on_owner_change' then
    if jsonb_typeof(p -> 'notify_on_owner_change') <> 'boolean' then
      raise exception 'notify_on_owner_change' using errcode = '22023';
    end if;
    c.notify_on_owner_change := (p ->> 'notify_on_owner_change')::boolean;
    v_details := v_details || jsonb_build_object('notify', c.notify_on_owner_change);
  end if;

  if v_details = '{}'::jsonb then return; end if;

  insert into public.crm_settings (shop_id, reminder_on, reminder_offset, alert_email, notify_on_owner_change, updated_at)
  values (p_shop_id, c.reminder_on, c.reminder_offset, c.alert_email, c.notify_on_owner_change, now())
  on conflict (shop_id) do update
    set reminder_on = excluded.reminder_on, reminder_offset = excluded.reminder_offset, alert_email = excluded.alert_email,
        notify_on_owner_change = excluded.notify_on_owner_change, updated_at = now();
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'crm_settings_saved', v_details);
end;
$$;
revoke execute on function public.owner_save_crm_settings(uuid, jsonb) from public, anon;
grant execute on function public.owner_save_crm_settings(uuid, jsonb) to authenticated, service_role;
