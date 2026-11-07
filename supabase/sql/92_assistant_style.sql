-- PPI · database update 92 — AI asistent → Nastavenia → "Štýl asistenta" and "Meno asistenta" (2026-11-07, the
-- owner's request). A fixed choice of how the shop assistant talks; never free text, never instructions anyone writes.
--
--   shop_assistant_settings.style            plain (Vecný, today's behaviour) | friendly (Priateľský) | waiter (Čašník,
--                                            only a shop of kind food). NULL = the default of the shop's kind: a NEW
--                                            restaurant talks as a waiter, every other shop plain. Every restaurant
--                                            that exists now is set to plain here, so nothing changes for it.
--   shop_assistant_settings.assistant_name   optional, ≤ 20 characters, plain_text(); said once in the first answer
--                                            ("Som Marco") and the chat's header title; never translated
--   assistant_style_of(style, kind)          the one rule: waiter only for food; NULL → waiter for food, else plain
--   owner_assistant_style(shop)              members read {style, name, kind}
--   owner_set_assistant_style(shop, style, name)  members + the plan; waiter only for food (`not_food`); `name` ≤ 20
--                                            (`name`); activity assistant_style_changed
--   shop_assistant_persona(slug)             anyone (the shop page and the chat route): {style, name} of an active shop;
--                                            visitors never read the table
--   owner_set_shop_kind                      as update 79, plus: a shop that becomes goods while on waiter is set to plain

alter table public.shop_assistant_settings add column if not exists style text;
alter table public.shop_assistant_settings add column if not exists assistant_name text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shop_assistant_settings_style_check') then
    alter table public.shop_assistant_settings
      add constraint shop_assistant_settings_style_check check (style is null or style in ('plain', 'friendly', 'waiter'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shop_assistant_settings_name_check') then
    alter table public.shop_assistant_settings
      add constraint shop_assistant_settings_name_check
      check (assistant_name is null or char_length(assistant_name) between 1 and 20);
  end if;
end;
$$;

-- the activity log: the new action
do $$
declare
  v_def text := (select pg_get_constraintdef(c.oid) from pg_constraint c
                 where c.conrelid = 'public.shop_activity'::regclass and c.conname = 'shop_activity_action_check');
begin
  if v_def is not null and position('''assistant_style_changed''' in v_def) = 0 then
    alter table public.shop_activity drop constraint shop_activity_action_check;
    execute 'alter table public.shop_activity add constraint shop_activity_action_check '
            || replace(v_def, 'ARRAY[', 'ARRAY[''assistant_style_changed''::text, ');
  end if;
end;
$$;

-- Every restaurant that exists now keeps today's way of talking (only a NEW one starts as a waiter).
insert into public.shop_assistant_settings (shop_id, style)
select s.id, 'plain' from public.shops s where s.kind = 'food'
on conflict (shop_id) do update set style = coalesce(public.shop_assistant_settings.style, 'plain');

/** The style a shop's assistant uses: waiter only for a restaurant; no choice = waiter for food, plain otherwise. */
create or replace function public.assistant_style_of(p_style text, p_kind text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_style = 'waiter' and p_kind is distinct from 'food' then 'plain'
    when p_style in ('plain', 'friendly', 'waiter') then p_style
    when p_kind = 'food' then 'waiter'
    else 'plain'
  end
$$;
revoke execute on function public.assistant_style_of(text, text) from public;
grant execute on function public.assistant_style_of(text, text) to anon, authenticated, service_role;

/** The style and name of a shop's assistant for its owners (members only). */
create or replace function public.owner_assistant_style(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_style text;
  v_name text;
begin
  if p_shop_id is null or not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  select s.kind into v_kind from public.shops s where s.id = p_shop_id;
  select x.style, x.assistant_name into v_style, v_name from public.shop_assistant_settings x where x.shop_id = p_shop_id;
  return jsonb_build_object('style', public.assistant_style_of(v_style, v_kind), 'name', v_name, 'kind', v_kind);
end;
$$;
revoke execute on function public.owner_assistant_style(uuid) from public, anon;
grant execute on function public.owner_assistant_style(uuid) to authenticated, service_role;

/**
 * Saves the style (plain | friendly | waiter — waiter only for a shop of kind food) and the name (≤ 20 characters of
 * plain text; '' or NULL = no name). Members with the plan. Returns {style, name}.
 */
create or replace function public.owner_set_assistant_style(p_shop_id uuid, p_style text, p_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_old_style text;
  v_old_name text;
  v_name text;
begin
  if auth.uid() is null or p_shop_id is null or not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if not public.shop_has_plan(p_shop_id) then
    raise exception 'no_plan' using errcode = '42501';
  end if;
  if p_style is null or p_style not in ('plain', 'friendly', 'waiter') then
    raise exception 'style' using errcode = '22023';
  end if;
  select s.kind into v_kind from public.shops s where s.id = p_shop_id;
  if p_style = 'waiter' and v_kind is distinct from 'food' then
    raise exception 'not_food' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) > 20 then
    raise exception 'name' using errcode = '22023';
  end if;
  v_name := public.plain_text(p_name, 20);
  select x.style, x.assistant_name into v_old_style, v_old_name from public.shop_assistant_settings x where x.shop_id = p_shop_id;
  insert into public.shop_assistant_settings (shop_id, style, assistant_name)
  values (p_shop_id, p_style, v_name)
  on conflict (shop_id) do update set style = excluded.style, assistant_name = excluded.assistant_name, updated_at = now();
  if v_old_style is distinct from p_style or v_old_name is distinct from v_name then
    insert into public.shop_activity (shop_id, actor, action, details)
    values (p_shop_id, auth.uid(), 'assistant_style_changed',
            jsonb_build_object('from', public.assistant_style_of(v_old_style, v_kind), 'to', p_style,
                               'name_changed', v_old_name is distinct from v_name));
  end if;
  return jsonb_build_object('style', p_style, 'name', v_name);
end;
$$;
revoke execute on function public.owner_set_assistant_style(uuid, text, text) from public, anon;
grant execute on function public.owner_set_assistant_style(uuid, text, text) to authenticated, service_role;

/** How an active shop's assistant talks: {style, name} (the shop page's chat header and the chat route). */
create or replace function public.shop_assistant_persona(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('style', public.assistant_style_of(x.style, s.kind), 'name', x.assistant_name)
  from public.shops s
  left join public.shop_assistant_settings x on x.shop_id = s.id
  where s.slug = p_slug and s.is_active
$$;
revoke execute on function public.shop_assistant_persona(text) from public;
grant execute on function public.shop_assistant_persona(text) to anon, authenticated, service_role;

/** Update 79's kind change, plus: a restaurant that becomes a goods shop while its assistant is a waiter talks plain. */
create or replace function public.owner_set_shop_kind(p_shop_id uuid, p_kind text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old text;
begin
  if auth.uid() is null or p_shop_id is null or not public.is_shop_member(p_shop_id) then
    raise exception 'not_member' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('goods', 'food') then
    raise exception 'kind' using errcode = '22023';
  end if;
  select kind into v_old from public.shops where id = p_shop_id for update;
  if v_old = p_kind then return p_kind; end if;
  update public.shops set kind = p_kind where id = p_shop_id;
  if p_kind = 'goods' then
    update public.shop_assistant_settings x set style = 'plain', updated_at = now()
     where x.shop_id = p_shop_id and x.style = 'waiter';
  end if;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'shop_kind_changed', jsonb_build_object('from', v_old, 'to', p_kind));
  return p_kind;
end;
$$;
revoke execute on function public.owner_set_shop_kind(uuid, text) from public, anon;
grant execute on function public.owner_set_shop_kind(uuid, text) to authenticated;
