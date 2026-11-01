-- PPI · database update 64 — "Asistent + CRM + Rezervácie", phase 6: the bookings for the owner's AI assistants and API
--
-- The owner's MCP server (update 61) and the owner API (/api/owner/bookings…) get the booking engine of update 63 through
-- the same one door, owner_mcp_call(token, tool, args): the token, its scope, the shop in the grant, the plan and
-- 120 calls a minute are checked first, then the call acts as the owner, and every booking rule stays in SQL
-- (booking_free_slots / booking_create / booking_move / booking_cancel: opening hours, blocks, buffers, capacity, the
-- lane's lock). New tools:
--   list_booking_services (shop.read)   the services and resources
--   find_free_slots       (shop.read)   free starts of one service from a day on (≤ 14 days), in the shop's time
--   create_booking        (shop.write)  a free time for a contact, or a name + phone (the contact is found or made)
--   move_booking          (shop.write)  without confirm: before → after and whether the new time is free; with
--                                       confirm: true the move (checked again; the customer's SMS is queued)
--   cancel_booking        (shop.write)  without confirm: what would be cancelled; with confirm: true the cancel
-- Bookings made or changed here are written as source / actor "api" (the booking's events show "AI asistent / API").
-- list_bookings now reads the booking engine (owner_booking_list: services, resources, people, source).
--
-- The update-61 function is kept as owner_mcp_call_61 and every other tool still goes there unchanged.
-- Safe to run twice.

-- ------------------------------------------------------------------ 1. the tools' scopes

create or replace function public.mcp_tool_scope(p_tool text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_tool in ('list_shops', 'get_shop_details', 'get_opening_hours', 'list_conversations', 'get_conversation',
                    'list_contacts', 'get_contact', 'list_bookings', 'list_email_templates', 'search_stock',
                    'get_sms_usage', 'list_booking_services', 'find_free_slots') then 'shop.read'
    when p_tool in ('update_conversations', 'save_contact', 'delete_contact', 'set_booking_status', 'set_opening_hours',
                    'update_shop_details', 'update_stock', 'create_booking', 'move_booking', 'cancel_booking') then 'shop.write'
    when p_tool in ('preview_message') then 'messages.send'
  end
$$;
revoke execute on function public.mcp_tool_scope(text) from public, anon, authenticated;

-- ------------------------------------------------------------------ 2. keep update 61's door under its own name (once)

do $$
begin
  if to_regprocedure('public.owner_mcp_call_61(text, text, jsonb)') is null
     and to_regprocedure('public.owner_mcp_call(text, text, jsonb)') is not null then
    alter function public.owner_mcp_call(text, text, jsonb) rename to owner_mcp_call_61;
  end if;
end;
$$;
revoke execute on function public.owner_mcp_call_61(text, text, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------------ 3. one booking as the tools show it

create or replace function public.mcp_booking_json(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'id', b.id, 'starts_at', b.starts_at, 'ends_at', b.ends_at,
           'local', to_char(b.starts_at at time zone s.timezone, 'YYYY-MM-DD HH24:MI'),
           'status', b.status, 'service', coalesce(v.name, b.service_name), 'service_id', b.service_id,
           -- update 61's key, still read by the Telegram bot (update 66)
           'service_name', coalesce(v.name, b.service_name),
           'resource', r.name, 'resource_id', b.resource_id, 'people', b.people, 'name', b.name, 'phone', b.phone,
           'contact_id', b.contact_id, 'source', b.source, 'note', b.note)
  from public.shop_bookings b
  join public.shops s on s.id = b.shop_id
  left join public.booking_services v on v.id = b.service_id
  left join public.booking_resources r on r.id = b.resource_id
  where b.id = p_id
$$;
revoke execute on function public.mcp_booking_json(uuid) from public, anon, authenticated;

/** An ISO time from the arguments, or bad_argument. */
create or replace function public.mcp_time(p_args jsonb, p_key text)
returns timestamptz
language plpgsql
immutable
set search_path = ''
as $$
begin
  if nullif(p_args ->> p_key, '') is null then raise exception 'bad_argument: %', p_key using errcode = '22023'; end if;
  return (p_args ->> p_key)::timestamptz;
exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format then
  raise exception 'bad_argument: %', p_key using errcode = '22023';
end;
$$;
revoke execute on function public.mcp_time(jsonb, text) from public, anon, authenticated;

-- ------------------------------------------------------------------ 4. the door: the booking tools, then update 61's

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
  v_tz text;
  v_id uuid;
  v_out jsonb;
  v_changed boolean := false;
  v_from timestamptz;
  v_day date;
  v_days integer;
  v_service uuid;
  v_resource uuid;
  v_people integer;
  v_contact uuid;
  v_phone text;
  v_name text;
  v_start timestamptz;
  v_b public.shop_bookings%rowtype;
begin
  if p_tool not in ('list_bookings', 'list_booking_services', 'find_free_slots', 'create_booking', 'move_booking',
                    'cancel_booking') then
    return public.owner_mcp_call_61(p_token, p_tool, p_args);
  end if;
  if jsonb_typeof(a) <> 'object' then raise exception 'bad_argument: arguments' using errcode = '22023'; end if;
  g := public.mcp_grant(p_token);
  v_scope := public.mcp_tool_scope(p_tool);
  if not v_scope = any (g.scopes) then raise exception 'scope: %', v_scope using errcode = '42501'; end if;
  perform public.mcp_act_as(g.user_id);

  if p_tool in ('move_booking', 'cancel_booking') then
    v_id := public.mcp_uuid(a, 'booking_id');
    v_shop := public.mcp_own(g, (select shop_id from public.shop_bookings where id = v_id));
  else
    v_shop := public.mcp_shop(g, a ->> 'shop');
  end if;
  select slug, timezone into v_slug, v_tz from public.shops where id = v_shop;

  if p_tool = 'list_bookings' then
    v_day := coalesce(public.mcp_date(a, 'from'), (now() at time zone v_tz)::date);
    select coalesce(jsonb_agg(public.mcp_booking_json(b.id) order by b.starts_at), '[]') into v_out
    from (select * from public.owner_booking_list(
            v_shop, (v_day::timestamp at time zone v_tz),
            coalesce((public.mcp_date(a, 'to') + 1)::timestamp at time zone v_tz, (v_day + 31)::timestamp at time zone v_tz),
            public.mcp_text(a, 'status', 20))
          limit public.mcp_int(a, 'limit', 50, 1, 200) offset public.mcp_int(a, 'offset', 0, 0, 100000)) b;
    -- a list, as in update 61 (each booking carries its local time)

  elsif p_tool = 'list_booking_services' then
    v_out := public.owner_booking_setup(v_shop);
    v_out := jsonb_build_object('time_zone', v_tz, 'taking_bookings', v_out -> 'rules' -> 'enabled',
                                'services', v_out -> 'services', 'resources', v_out -> 'resources',
                                'rules', v_out -> 'rules');

  elsif p_tool = 'find_free_slots' then
    v_service := public.mcp_uuid(a, 'service_id');
    if not exists (select 1 from public.booking_services where id = v_service and shop_id = v_shop) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    v_resource := case when nullif(a ->> 'resource_id', '') is not null then public.mcp_uuid(a, 'resource_id') end;
    v_day := coalesce(public.mcp_date(a, 'from'), (now() at time zone v_tz)::date);
    v_days := public.mcp_int(a, 'days', 1, 1, 14);
    v_people := public.mcp_int(a, 'people', 1, 1, 500);
    select coalesce(jsonb_agg(jsonb_build_object(
             'starts_at', f.starts_at, 'ends_at', f.ends_at,
             'local', to_char(f.starts_at at time zone v_tz, 'YYYY-MM-DD HH24:MI'),
             'resource_id', f.resource_id, 'resource', r.name, 'places_left', f.seats_left) order by f.starts_at), '[]')
    into v_out
    from (select * from public.booking_free_slots(v_shop, v_service, v_day::timestamp at time zone v_tz,
                                                  (v_day + v_days)::timestamp at time zone v_tz, v_resource, null, v_people)
          limit 200) f
    left join public.booking_resources r on r.id = f.resource_id;
    v_out := jsonb_build_object('time_zone', v_tz, 'from', v_day, 'days', v_days, 'slots', v_out);

  elsif p_tool = 'create_booking' then
    v_service := public.mcp_uuid(a, 'service_id');
    v_start := public.mcp_time(a, 'starts_at');
    v_resource := case when nullif(a ->> 'resource_id', '') is not null then public.mcp_uuid(a, 'resource_id') end;
    v_people := public.mcp_int(a, 'people', 1, 1, 500);
    perform public.crm_owner_check(v_shop);
    if nullif(a ->> 'contact_id', '') is not null then
      v_contact := public.mcp_uuid(a, 'contact_id');
      if not exists (select 1 from public.shop_contacts where id = v_contact and shop_id = v_shop) then
        raise exception 'not_found' using errcode = 'P0002';
      end if;
    else
      v_phone := public.crm_phone(public.mcp_text(a, 'phone', 40), (select country from public.shops where id = v_shop));
      if v_phone is null then raise exception 'phone' using errcode = '22023'; end if;
      v_name := nullif(btrim(coalesce(public.mcp_text(a, 'name', 80), '')), '');
      select id into v_contact from public.shop_contacts where shop_id = v_shop and phone = v_phone;
      if v_contact is null then
        insert into public.shop_contacts (shop_id, name, phone, source, created_by)
        values (v_shop, v_name, v_phone, 'owner', g.user_id)
        returning id into v_contact;
      elsif v_name is not null then
        update public.shop_contacts set name = coalesce(name, v_name), updated_at = now() where id = v_contact;
      end if;
    end if;
    v_id := public.booking_create(v_shop, v_service, v_start, v_resource, v_people, v_contact, null, 'api', g.user_id,
                                  public.mcp_text(a, 'note', 500), null);
    v_out := jsonb_build_object('created', true, 'booking', public.mcp_booking_json(v_id));

  elsif p_tool = 'move_booking' then
    select * into v_b from public.shop_bookings where id = v_id;
    v_start := public.mcp_time(a, 'starts_at');
    v_resource := case when nullif(a ->> 'resource_id', '') is not null then public.mcp_uuid(a, 'resource_id') end;
    if coalesce((a ->> 'confirm')::boolean, false) then
      perform public.crm_owner_check(v_shop);
      perform public.booking_move(v_id, v_start, v_resource, 'api', g.user_id);
      v_out := jsonb_build_object('moved', true, 'booking', public.mcp_booking_json(v_id),
                                  'customer_sms', (select notify_on_owner_change from public.crm_settings_of(v_shop)));
    else
      v_out := jsonb_build_object(
        'moved', false,
        'needs_confirm', 'Show the owner before → after and call again with confirm: true after they agree.',
        'before', public.mcp_booking_json(v_id),
        'after', jsonb_build_object('starts_at', v_start, 'local', to_char(v_start at time zone v_tz, 'YYYY-MM-DD HH24:MI')),
        'status_ok', v_b.status = 'confirmed',
        'time_free', exists (select 1 from public.booking_free_slots(v_shop, v_b.service_id, v_start,
                                                                      v_start + (v_b.ends_at - v_b.starts_at),
                                                                      coalesce(v_resource, v_b.resource_id), v_b.id, v_b.people) f
                             where f.starts_at = v_start),
        'customer_sms', (select notify_on_owner_change from public.crm_settings_of(v_shop)));
    end if;

  elsif p_tool = 'cancel_booking' then
    if coalesce((a ->> 'confirm')::boolean, false) then
      perform public.crm_owner_check(v_shop);
      perform public.booking_cancel(v_id, 'api', g.user_id, true);
      v_out := jsonb_build_object('cancelled', true, 'booking', public.mcp_booking_json(v_id),
                                  'customer_sms', (select notify_on_owner_change from public.crm_settings_of(v_shop)));
    else
      v_out := jsonb_build_object(
        'cancelled', false,
        'needs_confirm', 'Show the owner which booking would be cancelled and call again with confirm: true after they agree.',
        'booking', public.mcp_booking_json(v_id),
        'customer_sms', (select notify_on_owner_change from public.crm_settings_of(v_shop)));
    end if;
  end if;

  return jsonb_build_object('shop', v_slug, 'result', coalesce(v_out, 'null'::jsonb), 'changed', v_changed);
end;
$$;
revoke execute on function public.owner_mcp_call(text, text, jsonb) from public;
grant execute on function public.owner_mcp_call(text, text, jsonb) to anon, authenticated, service_role;
