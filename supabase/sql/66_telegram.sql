-- PPI · database update 66 — the Cacaduu Telegram bot for shop owners, phase 1: linking, consent, the same one door
--
-- One bot for all shops. An owner links their Telegram on the website (Môj obchod → AI asistenti → Telegram): a
-- one-time code (10 minutes, single use, SHA-256 only) opened as t.me/<bot>?start=<code> links that Telegram user (a
-- private chat only) to the owner. The owner then ticks shops and permissions on the website — the same consent as the
-- owner MCP (update 61): shop.read always, shop.write, messages.send; Pro shops only. That consent becomes an owner-MCP
-- grant of kind "telegram"; its bearer token is kept only encrypted in the Vault (never in a table, never sent anywhere)
-- and the bot's every tool goes through telegram_call() = owner_mcp_call(token, tool, args), the ONE door of update 61
-- (scopes, the shop in the grant, membership, the plan, 120 calls a minute, mcp_act_as) — never a second write path.
-- Every write the bot makes waits for "Potvrdiť" (telegram_pending: 10 minutes, once). Every action is in shop_activity
-- as the owner with details.source = "telegram" (a trigger reads the request's ppi.source setting).
--
--   telegram_link_codes  telegram_links  telegram_pending  telegram_shop_prefs  telegram_settings
--   (RLS, no grants: functions only)
--
-- Safe to run twice.

-- ------------------------------------------------------------------ 0. the grant kind and the activity's source

alter table public.owner_mcp_tokens drop constraint if exists owner_mcp_tokens_kind_check;
alter table public.owner_mcp_tokens add constraint owner_mcp_tokens_kind_check check (kind in ('oauth', 'personal', 'telegram'));

/** Every activity line written while a request set ppi.source (the Telegram bot: "telegram") carries it. */
create or replace function public.shop_activity_source()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v text := nullif(current_setting('ppi.source', true), '');
begin
  if v is not null and not coalesce(new.details, '{}'::jsonb) ? 'source' then
    new.details := coalesce(new.details, '{}'::jsonb) || jsonb_build_object('source', v);
  end if;
  return new;
end;
$$;
revoke execute on function public.shop_activity_source() from public, anon, authenticated;
drop trigger if exists shop_activity_source on public.shop_activity;
create trigger shop_activity_source before insert on public.shop_activity
  for each row execute function public.shop_activity_source();

-- the activity log's list of actions gets the Telegram ones (added to the list that is live)
do $$
declare
  v_def text := (select pg_get_constraintdef(c.oid) from pg_constraint c
                 where c.conrelid = 'public.shop_activity'::regclass and c.conname = 'shop_activity_action_check');
  v_add text := '';
  a text;
begin
  if v_def is null then return; end if;
  foreach a in array array['telegram_connected', 'telegram_disconnected'] loop
    if position('''' || a || '''' in v_def) = 0 then v_add := v_add || '''' || a || '''::text, '; end if;
  end loop;
  if v_add <> '' then
    alter table public.shop_activity drop constraint shop_activity_action_check;
    execute 'alter table public.shop_activity add constraint shop_activity_action_check ' || replace(v_def, 'ARRAY[', 'ARRAY[' || v_add);
  end if;
end;
$$;

-- ------------------------------------------------------------------ 1. tables

create table if not exists public.telegram_settings (
  id              boolean primary key default true check (id),
  ai_enabled      boolean not null default true,
  ai_daily_limit  integer not null default 50 check (ai_daily_limit between 0 and 1000),
  notify_daily_cap integer not null default 30 check (notify_daily_cap between 0 and 200),
  updated_at      timestamptz not null default now()
);
insert into public.telegram_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.telegram_link_codes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  code_hash   text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists telegram_link_codes_user_idx on public.telegram_link_codes (user_id, created_at desc);

create table if not exists public.telegram_links (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null unique,
  tg_user_id      bigint not null unique,
  chat_id         bigint not null,
  tg_username     text,
  tg_lang         text,
  grant_id        uuid references public.owner_mcp_tokens (id) on delete set null,
  vault_id        uuid,
  current_shop_id uuid references public.shops (id) on delete set null,
  state           jsonb not null default '{}'::jsonb,
  window_start    timestamptz not null default now(),
  window_count    integer not null default 0,
  linked_at       timestamptz not null default now(),
  last_seen_at    timestamptz
);

create table if not exists public.telegram_pending (
  id          uuid primary key default gen_random_uuid(),
  link_id     uuid not null references public.telegram_links (id) on delete cascade,
  tool        text not null,
  args        jsonb not null,
  summary     jsonb not null default '{}'::jsonb,
  expires_at  timestamptz not null default now() + interval '10 minutes',
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists telegram_pending_link_idx on public.telegram_pending (link_id, created_at desc);

/** Per linked owner and shop: AI for free text (phase 2) and the notifications (phase 3). */
create table if not exists public.telegram_shop_prefs (
  link_id      uuid not null references public.telegram_links (id) on delete cascade,
  shop_id      uuid not null references public.shops (id) on delete cascade,
  ai_on        boolean not null default true,
  notify       jsonb not null default '{}'::jsonb,
  quiet_from   time,
  quiet_to     time,
  updated_at   timestamptz not null default now(),
  primary key (link_id, shop_id)
);

do $$
declare t text;
begin
  foreach t in array array['telegram_settings', 'telegram_link_codes', 'telegram_links', 'telegram_pending', 'telegram_shop_prefs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

-- ------------------------------------------------------------------ 2. the owner on the website

/** "Prepojiť Telegram": a one-time code for t.me/<bot>?start=<code> (10 minutes, once; ≤ 5 an hour). */
create or replace function public.owner_telegram_link_start()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_code text := 'tg' || replace(gen_random_uuid()::text, '-', '') || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
begin
  if auth.uid() is null then raise exception 'login' using errcode = '42501'; end if;
  if (select count(*) from public.telegram_link_codes where user_id = auth.uid() and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'too_many' using errcode = '54000';
  end if;
  insert into public.telegram_link_codes (user_id, code_hash, expires_at)
  values (auth.uid(), public.mcp_hash(v_code), now() + interval '10 minutes');
  return jsonb_build_object('code', v_code, 'expires_at', now() + interval '10 minutes');
end;
$$;
revoke execute on function public.owner_telegram_link_start() from public, anon;
grant execute on function public.owner_telegram_link_start() to authenticated;

/** The owner's link as the website shows it (never a code, token or hash). */
create or replace function public.owner_telegram_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when l.id is null then null else jsonb_build_object(
    'username', l.tg_username, 'linked_at', l.linked_at, 'last_seen_at', l.last_seen_at,
    'scopes', case when t.revoked_at is null then to_jsonb(t.scopes) end,
    'shops', case when t.revoked_at is null then (
      select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'slug', s.slug, 'name', s.name,
                                                   'has_plan', public.shop_has_plan(s.id)) order by s.name), '[]')
      from public.shops s where s.id = any (t.shop_ids)) end) end
  from (select auth.uid() as uid) me
  left join public.telegram_links l on l.user_id = me.uid
  left join public.owner_mcp_tokens t on t.id = l.grant_id
$$;
revoke execute on function public.owner_telegram_status() from public, anon;
grant execute on function public.owner_telegram_status() to authenticated;

/**
 * "Uložiť povolenia": the shops and permissions the bot may use — the same consent as the owner MCP (shop.read
 * always; Pro shops the owner is a member of). A new grant replaces the old one at once; its token goes to the Vault.
 */
create or replace function public.owner_telegram_consent(p_shop_ids uuid[], p_scopes text[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  l public.telegram_links%rowtype;
  v_shops uuid[];
  v_token text := public.mcp_random('ctg_');
  v_grant uuid;
  v_vault uuid;
  v_shop uuid;
begin
  if auth.uid() is null then raise exception 'login' using errcode = '42501'; end if;
  select * into l from public.telegram_links where user_id = auth.uid() for update;
  if not found then raise exception 'not_linked' using errcode = 'P0002'; end if;
  if not public.mcp_scopes_ok(p_scopes) then raise exception 'scope' using errcode = '22023'; end if;
  v_shops := public.mcp_grant_shops(p_shop_ids);
  if l.grant_id is not null then
    update public.owner_mcp_tokens set revoked_at = coalesce(revoked_at, now()) where id = l.grant_id;
  end if;
  if l.vault_id is not null then delete from vault.secrets where id = l.vault_id; end if;
  insert into public.owner_mcp_tokens (kind, user_id, name, shop_ids, scopes, access_hash, access_expires_at)
  values ('telegram', auth.uid(), 'Telegram', v_shops, p_scopes, public.mcp_hash(v_token), now() + interval '1 year')
  returning id into v_grant;
  v_vault := vault.create_secret(v_token, 'ppi_tg_grant_' || l.id::text || '_' || extract(epoch from now())::bigint, 'Telegram bot grant');
  update public.telegram_links
  set grant_id = v_grant, vault_id = v_vault,
      current_shop_id = case when current_shop_id = any (v_shops) then current_shop_id else v_shops[1] end
  where id = l.id;
  foreach v_shop in array v_shops loop
    insert into public.shop_activity (shop_id, actor, action, details)
    values (v_shop, auth.uid(), 'telegram_connected', jsonb_build_object('scopes', to_jsonb(p_scopes), 'username', l.tg_username));
    insert into public.telegram_shop_prefs (link_id, shop_id) values (l.id, v_shop) on conflict do nothing;
  end loop;
  return jsonb_build_object('ok', true, 'shops', cardinality(v_shops));
end;
$$;
revoke execute on function public.owner_telegram_consent(uuid[], text[]) from public, anon;
grant execute on function public.owner_telegram_consent(uuid[], text[]) to authenticated;

/** Removes a link: the grant revoked, the token deleted from the Vault, the link gone (website or /odpojit). */
create or replace function public.telegram_unlink_row(p_link uuid, p_actor uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  l public.telegram_links%rowtype;
  t public.owner_mcp_tokens%rowtype;
  v_shop uuid;
begin
  select * into l from public.telegram_links where id = p_link for update;
  if not found then return false; end if;
  if l.grant_id is not null then
    select * into t from public.owner_mcp_tokens where id = l.grant_id for update;
    update public.owner_mcp_tokens set revoked_at = coalesce(revoked_at, now()) where id = l.grant_id;
    foreach v_shop in array coalesce(t.shop_ids, '{}') loop
      if exists (select 1 from public.shop_members where shop_id = v_shop and user_id = l.user_id) then
        insert into public.shop_activity (shop_id, actor, action, details)
        values (v_shop, p_actor, 'telegram_disconnected', jsonb_build_object('username', l.tg_username));
      end if;
    end loop;
  end if;
  if l.vault_id is not null then delete from vault.secrets where id = l.vault_id; end if;
  delete from public.telegram_links where id = p_link;
  return true;
end;
$$;
revoke execute on function public.telegram_unlink_row(uuid, uuid) from public, anon, authenticated;

create or replace function public.owner_telegram_unlink()
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'login' using errcode = '42501'; end if;
  return public.telegram_unlink_row((select id from public.telegram_links where user_id = auth.uid()), auth.uid());
end;
$$;
revoke execute on function public.owner_telegram_unlink() from public, anon;
grant execute on function public.owner_telegram_unlink() to authenticated;

-- ------------------------------------------------------------------ 3. the bot (the telegram function, service role)

/**
 * /start <code>: links the Telegram user to the code's owner. Private chats only. One Telegram per owner and one owner
 * per Telegram user (a code for another owner is refused while the Telegram user is linked). Refusals: chat, code, taken.
 */
create or replace function public.telegram_claim(
  p_code text, p_tg_user bigint, p_chat bigint, p_chat_type text, p_username text, p_lang text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.telegram_link_codes%rowtype;
  v_other uuid;
begin
  if p_chat_type is distinct from 'private' then raise exception 'chat' using errcode = '22023'; end if;
  select * into c from public.telegram_link_codes where code_hash = public.mcp_hash(coalesce(p_code, '')) for update;
  if not found or c.used_at is not null or c.expires_at < now() then raise exception 'code' using errcode = '22023'; end if;
  update public.telegram_link_codes set used_at = now() where id = c.id;
  select user_id into v_other from public.telegram_links where tg_user_id = p_tg_user;
  if v_other is not null and v_other <> c.user_id then raise exception 'taken' using errcode = '23505'; end if;
  insert into public.telegram_links (user_id, tg_user_id, chat_id, tg_username, tg_lang)
  values (c.user_id, p_tg_user, p_chat, left(p_username, 64), left(p_lang, 12))
  on conflict (user_id) do update
    set tg_user_id = excluded.tg_user_id, chat_id = excluded.chat_id, tg_username = excluded.tg_username,
        tg_lang = excluded.tg_lang, linked_at = now();
  return jsonb_build_object('ok', true, 'lang', (select language from public.profiles where user_id = c.user_id));
end;
$$;
revoke execute on function public.telegram_claim(text, bigint, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.telegram_claim(text, bigint, bigint, text, text, text) to service_role;

/**
 * Who is writing: the link, its language, its grant (scopes, shops with their plan and the owner still a member),
 * the chosen shop and the conversation state — or {linked:false}. Counts the message: ≤ 30 a minute per Telegram user.
 */
create or replace function public.telegram_whoami(p_tg_user bigint, p_count boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  l public.telegram_links%rowtype;
  t public.owner_mcp_tokens%rowtype;
begin
  select * into l from public.telegram_links where tg_user_id = p_tg_user for update;
  if not found then return jsonb_build_object('linked', false); end if;
  if p_count then
    if l.window_start < now() - interval '1 minute' then
      update public.telegram_links set window_start = now(), window_count = 1, last_seen_at = now() where id = l.id;
    elsif l.window_count >= 30 then
      raise exception 'too_many' using errcode = '54000';
    else
      update public.telegram_links set window_count = window_count + 1, last_seen_at = now() where id = l.id;
    end if;
  end if;
  select * into t from public.owner_mcp_tokens where id = l.grant_id;
  return jsonb_build_object(
    'linked', true,
    'link_id', l.id,
    'lang', coalesce((select language from public.profiles where user_id = l.user_id), l.tg_lang, 'sk'),
    'state', l.state,
    'granted', t.id is not null and t.revoked_at is null and t.access_expires_at > now(),
    'scopes', coalesce(to_jsonb(t.scopes), '[]'::jsonb),
    'current_shop', (select s.slug from public.shops s where s.id = l.current_shop_id),
    'shops', coalesce((select jsonb_agg(jsonb_build_object('slug', s.slug, 'name', s.name, 'timezone', s.timezone,
                                                           'usable', public.shop_has_plan(s.id)
                                                             and exists (select 1 from public.shop_members m
                                                                         where m.shop_id = s.id and m.user_id = l.user_id))
                                        order by s.name)
                       from public.shops s where s.id = any (coalesce(t.shop_ids, '{}'))), '[]'::jsonb));
end;
$$;
revoke execute on function public.telegram_whoami(bigint, boolean) from public, anon, authenticated;
grant execute on function public.telegram_whoami(bigint, boolean) to service_role;

/** The bot's shop for its buttons (one of the grant's shops) and its conversation state (what it waits for). */
create or replace function public.telegram_set(p_tg_user bigint, p_shop text, p_state jsonb)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  l public.telegram_links%rowtype;
  v_shop uuid;
begin
  select * into l from public.telegram_links where tg_user_id = p_tg_user for update;
  if not found then return false; end if;
  if p_shop is not null then
    select s.id into v_shop from public.shops s join public.owner_mcp_tokens t on t.id = l.grant_id
    where s.slug = p_shop and s.id = any (t.shop_ids);
    if v_shop is null then raise exception 'shop_not_in_grant' using errcode = '42501'; end if;
    update public.telegram_links set current_shop_id = v_shop where id = l.id;
  end if;
  if p_state is not null then
    if pg_column_size(p_state) > 4000 then raise exception 'state' using errcode = '22023'; end if;
    update public.telegram_links set state = p_state where id = l.id;
  end if;
  return true;
end;
$$;
revoke execute on function public.telegram_set(bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.telegram_set(bigint, text, jsonb) to service_role;

/**
 * Every tool the bot uses: the owner MCP's one door (owner_mcp_call) with the link's own grant, marked as coming from
 * Telegram. The token is read from the Vault here and never leaves the database.
 */
create or replace function public.telegram_call(p_tg_user bigint, p_tool text, p_args jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  l public.telegram_links%rowtype;
  v_token text;
begin
  select * into l from public.telegram_links where tg_user_id = p_tg_user;
  if not found or l.vault_id is null then raise exception 'invalid_token' using errcode = '28000'; end if;
  select decrypted_secret into v_token from vault.decrypted_secrets where id = l.vault_id;
  if v_token is null then raise exception 'invalid_token' using errcode = '28000'; end if;
  -- A write runs only from "Potvrdiť" (telegram_confirm); update_stock without confirm only shows before → after.
  if public.mcp_tool_scope(p_tool) in ('shop.write', 'messages.send')
     and not (p_tool = 'update_stock' and coalesce((p_args ->> 'confirm')::boolean, false) is not true)
     and coalesce(current_setting('ppi.telegram_confirmed', true), '') = '' then
    raise exception 'needs_confirmation' using errcode = '42501';
  end if;
  perform set_config('ppi.source', 'telegram', true);
  return public.owner_mcp_call(v_token, p_tool, coalesce(p_args, '{}'::jsonb));
end;
$$;
revoke execute on function public.telegram_call(bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.telegram_call(bigint, text, jsonb) to service_role;

/** A write waiting for "Potvrdiť" (10 minutes, once). Only write tools of the owner MCP. */
create or replace function public.telegram_pending_new(p_tg_user bigint, p_tool text, p_args jsonb, p_summary jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_link uuid := (select id from public.telegram_links where tg_user_id = p_tg_user);
  v_id uuid;
begin
  if v_link is null then raise exception 'invalid_token' using errcode = '28000'; end if;
  if public.mcp_tool_scope(p_tool) not in ('shop.write', 'messages.send') then raise exception 'unknown_tool' using errcode = '22023'; end if;
  delete from public.telegram_pending where link_id = v_link and (expires_at < now() - interval '1 day' or used_at < now() - interval '1 day');
  insert into public.telegram_pending (link_id, tool, args, summary)
  values (v_link, p_tool, coalesce(p_args, '{}'::jsonb), coalesce(p_summary, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.telegram_pending_new(bigint, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.telegram_pending_new(bigint, text, jsonb, jsonb) to service_role;

/** "Potvrdiť": the waiting write runs through the one door, once, within 10 minutes, for the same Telegram user. */
create or replace function public.telegram_confirm(p_tg_user bigint, p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  p public.telegram_pending%rowtype;
  v_out jsonb;
begin
  select pe.* into p from public.telegram_pending pe join public.telegram_links l on l.id = pe.link_id
  where pe.id = p_id and l.tg_user_id = p_tg_user for update of pe;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p.used_at is not null then raise exception 'used' using errcode = '22023'; end if;
  if p.expires_at < now() then raise exception 'expired' using errcode = '22023'; end if;
  update public.telegram_pending set used_at = now() where id = p.id;
  perform set_config('ppi.telegram_confirmed', p.id::text, true);
  v_out := public.telegram_call(p_tg_user, p.tool, p.args);
  perform set_config('ppi.telegram_confirmed', '', true);
  return jsonb_build_object('tool', p.tool, 'summary', p.summary, 'out', v_out);
end;
$$;
revoke execute on function public.telegram_confirm(bigint, uuid) from public, anon, authenticated;
grant execute on function public.telegram_confirm(bigint, uuid) to service_role;

/** "Zrušiť" on a waiting write. */
create or replace function public.telegram_cancel(p_tg_user bigint, p_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  update public.telegram_pending pe set used_at = now()
  from public.telegram_links l
  where pe.id = p_id and l.id = pe.link_id and l.tg_user_id = p_tg_user and pe.used_at is null
  returning true
$$;
revoke execute on function public.telegram_cancel(bigint, uuid) from public, anon, authenticated;
grant execute on function public.telegram_cancel(bigint, uuid) to service_role;

/** /odpojit in the bot. */
create or replace function public.telegram_unlink_by_bot(p_tg_user bigint)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select public.telegram_unlink_row(l.id, l.user_id) from public.telegram_links l where l.tg_user_id = p_tg_user
$$;
revoke execute on function public.telegram_unlink_by_bot(bigint) from public, anon, authenticated;
grant execute on function public.telegram_unlink_by_bot(bigint) to service_role;

-- ------------------------------------------------------------------ 4. the admin

create or replace function public.admin_telegram_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return (select jsonb_build_object('ai_enabled', s.ai_enabled, 'ai_daily_limit', s.ai_daily_limit,
                                    'notify_daily_cap', s.notify_daily_cap,
                                    'links', (select count(*) from public.telegram_links),
                                    'granted', (select count(*) from public.telegram_links l join public.owner_mcp_tokens t
                                                on t.id = l.grant_id where t.revoked_at is null))
          from public.telegram_settings s where s.id);
end;
$$;
revoke execute on function public.admin_telegram_settings() from public, anon;
grant execute on function public.admin_telegram_settings() to authenticated;

create or replace function public.admin_save_telegram_settings(p_ai_enabled boolean, p_ai_daily_limit integer, p_notify_daily_cap integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.telegram_settings
  set ai_enabled = coalesce(p_ai_enabled, ai_enabled), ai_daily_limit = coalesce(p_ai_daily_limit, ai_daily_limit),
      notify_daily_cap = coalesce(p_notify_daily_cap, notify_daily_cap), updated_at = now()
  where id;
end;
$$;
revoke execute on function public.admin_save_telegram_settings(boolean, integer, integer) from public, anon;
grant execute on function public.admin_save_telegram_settings(boolean, integer, integer) to authenticated;

-- ------------------------------------------------------------------ 5. phase 2: the AI for free text (proposals only)

-- one row per link and day (the shop's own day does not matter here: a UTC day per Telegram user)
create table if not exists public.telegram_ai_usage (
  link_id  uuid not null references public.telegram_links (id) on delete cascade,
  day      date not null,
  messages integer not null default 0,
  primary key (link_id, day)
);
alter table public.telegram_ai_usage enable row level security;
revoke all on public.telegram_ai_usage from public, anon, authenticated;
grant all on public.telegram_ai_usage to service_role;

/**
 * Before every AI answer: the admin's switch (telegram_settings.ai_enabled), the owner's switch for that shop
 * (telegram_shop_prefs.ai_on) and the daily limit per Telegram user (ai_daily_limit). Raises ai_off / ai_limit.
 * Returns the messages left today.
 */
create or replace function public.telegram_ai_hit(p_tg_user bigint, p_shop text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  l public.telegram_links%rowtype;
  s public.telegram_settings%rowtype;
  v_shop uuid;
  v_used integer;
begin
  select * into l from public.telegram_links where tg_user_id = p_tg_user;
  if not found then raise exception 'invalid_token' using errcode = '28000'; end if;
  select * into s from public.telegram_settings where id;
  if not coalesce(s.ai_enabled, false) or coalesce(s.ai_daily_limit, 0) = 0 then raise exception 'ai_off' using errcode = 'P0001'; end if;
  select id into v_shop from public.shops where slug = p_shop;
  if exists (select 1 from public.telegram_shop_prefs p where p.link_id = l.id and p.shop_id = v_shop and not p.ai_on) then
    raise exception 'ai_off' using errcode = 'P0001';
  end if;
  insert into public.telegram_ai_usage (link_id, day, messages) values (l.id, current_date, 1)
  on conflict (link_id, day) do update set messages = telegram_ai_usage.messages + 1
  returning messages into v_used;
  if v_used > s.ai_daily_limit then
    update public.telegram_ai_usage set messages = s.ai_daily_limit where link_id = l.id and day = current_date;
    raise exception 'ai_limit' using errcode = '54000';
  end if;
  delete from public.telegram_ai_usage where link_id = l.id and day < current_date - 30;
  return s.ai_daily_limit - v_used;
end;
$$;
revoke execute on function public.telegram_ai_hit(bigint, text) from public, anon, authenticated;
grant execute on function public.telegram_ai_hit(bigint, text) to service_role;

-- ------------------------------------------------------------------ 6. phase 3: notifications (opt-in)

-- kinds: booking_new (a customer booked), booking_cancelled (a customer cancelled), callback (a customer waits for an
-- answer, update 59). Never on: the owner ticks them per shop. Quiet hours wait (never dropped); 30 a day per link.
create table if not exists public.telegram_outbox (
  id          bigint generated always as identity primary key,
  link_id     uuid not null references public.telegram_links (id) on delete cascade,
  shop_id     uuid not null references public.shops (id) on delete cascade,
  kind        text not null check (kind in ('booking_new', 'booking_cancelled', 'callback', 'test')),
  ref_id      uuid,
  status      text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'skipped')),
  reason      text check (reason is null or char_length(reason) <= 60),
  not_before  timestamptz not null default now(),
  attempts    integer not null default 0,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);
create index if not exists telegram_outbox_due_idx on public.telegram_outbox (not_before) where status = 'queued';
create index if not exists telegram_outbox_link_idx on public.telegram_outbox (link_id, sent_at desc);
create unique index if not exists telegram_outbox_once_idx on public.telegram_outbox (link_id, kind, ref_id) where ref_id is not null;
alter table public.telegram_outbox enable row level security;
revoke all on public.telegram_outbox from public, anon, authenticated;
grant all on public.telegram_outbox to service_role;

create or replace function public.telegram_cron_ok(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(length(p_secret) >= 32 and exists (
    select 1 from vault.decrypted_secrets
    where name = 'ppi_telegram_cron'
      and encode(sha256(convert_to(decrypted_secret, 'UTF8')), 'hex')
          = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')), false)
$$;
revoke execute on function public.telegram_cron_ok(text) from public, anon, authenticated;
grant execute on function public.telegram_cron_ok(text) to service_role;

do $$
begin
  if to_regclass('vault.secrets') is not null
     and not exists (select 1 from vault.secrets where name = 'ppi_telegram_cron') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      'ppi_telegram_cron', 'PPI: the Telegram job proves itself to the telegram function');
  end if;
end;
$$;

/** Asks the telegram function to send now (pg_net after commit); without pg_net the job every 5 minutes sends. */
create or replace function public.telegram_kick()
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
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'ppi_telegram_cron';
  if v_url is null or v_secret is null then return; end if;
  execute 'select net.http_post(url := $1, body := $2, params := ''{}''::jsonb, headers := $3, timeout_milliseconds := 30000)'
  using v_url || '/functions/v1/telegram', jsonb_build_object('action', 'notify'),
        jsonb_build_object('Content-Type', 'application/json', 'x-ppi-cron', v_secret);
exception when others then
  null;
end;
$$;
revoke execute on function public.telegram_kick() from public, anon, authenticated;
grant execute on function public.telegram_kick() to service_role;

/** One notification for every linked owner of the shop who ticked that kind (the grant still covers the shop). */
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
    and coalesce((p.notify ->> p_kind)::boolean, false)
    and exists (select 1 from public.shop_members m where m.shop_id = p_shop and m.user_id = l.user_id)
  on conflict do nothing;
  get diagnostics v_n = row_count;
  if v_n > 0 then perform public.telegram_kick(); end if;
  return v_n;
exception when others then
  -- a notification never costs the booking or the shopper's message
  return 0;
end;
$$;
revoke execute on function public.telegram_notify(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.telegram_notify(uuid, text, uuid) to service_role;

/** A customer booked (straight away, or by entering the SMS code) or cancelled; never the owner's own changes. */
create or replace function public.telegram_booking_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'confirmed' and not exists (select 1 from public.shop_members m where m.shop_id = new.shop_id and m.user_id = auth.uid()) then
      perform public.telegram_notify(new.shop_id, 'booking_new', new.id);
    end if;
  elsif new.status is distinct from old.status then
    if old.status = 'pending' and new.status = 'confirmed' then
      perform public.telegram_notify(new.shop_id, 'booking_new', new.id);
    elsif old.status = 'confirmed' and new.status = 'cancelled'
          and not exists (select 1 from public.shop_members m where m.shop_id = new.shop_id
                          and m.user_id = coalesce(new.status_by, auth.uid())) then
      perform public.telegram_notify(new.shop_id, 'booking_cancelled', new.id);
    end if;
  end if;
  return null;
end;
$$;
revoke execute on function public.telegram_booking_trigger() from public, anon, authenticated;
drop trigger if exists telegram_booking_notify on public.shop_bookings;
create trigger telegram_booking_notify after insert or update of status on public.shop_bookings
  for each row execute function public.telegram_booking_trigger();

/** A shopper left a contact for an unanswered question (update 59's shop_owner_alerts). */
create or replace function public.telegram_callback_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.telegram_notify(new.shop_id, 'callback', new.conversation_id);
  return null;
end;
$$;
revoke execute on function public.telegram_callback_trigger() from public, anon, authenticated;
do $$
begin
  if to_regclass('public.shop_owner_alerts') is not null then
    drop trigger if exists telegram_callback_notify on public.shop_owner_alerts;
    create trigger telegram_callback_notify after insert on public.shop_owner_alerts
      for each row execute function public.telegram_callback_trigger();
  end if;
end;
$$;

/**
 * The notifications to send now (the telegram function, service role): quiet hours move a row to their end (in the
 * shop's time zone), the daily cap (telegram_settings.notify_daily_cap per link, 24 hours) and an ended grant, plan
 * or membership skip it. Each row carries only what the message shows: the shop, the time, the service, the
 * customer's name (never their phone or e-mail) or the conversation's first question.
 */
create or replace function public.telegram_notify_due(p_limit integer default 20)
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
  for r in
    select o.*, l.chat_id, l.user_id, l.grant_id, s.name as shop_name, s.slug, s.timezone, p.quiet_from, p.quiet_to,
           coalesce((select language from public.profiles where user_id = l.user_id), l.tg_lang, 'sk') as lang
    from public.telegram_outbox o
    join public.telegram_links l on l.id = o.link_id
    join public.shops s on s.id = o.shop_id
    left join public.telegram_shop_prefs p on p.link_id = o.link_id and p.shop_id = o.shop_id
    where o.status = 'queued' and o.not_before <= now()
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
                   where c.id = r.ref_id and r.kind = 'callback')));
  end loop;
  return v_out;
end;
$$;
revoke execute on function public.telegram_notify_due(integer) from public, anon, authenticated;
grant execute on function public.telegram_notify_due(integer) to service_role;

/** After sending: sent, or failed after 5 tries (the row was moved 5 minutes on when it was claimed). */
create or replace function public.telegram_notify_result(p_id bigint, p_ok boolean, p_reason text default null)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.telegram_outbox
  set status = case when p_ok then 'sent' when attempts >= 5 then 'failed' else 'queued' end,
      sent_at = case when p_ok then now() end,
      reason = case when p_ok then null else left(p_reason, 60) end,
      not_before = case when p_ok then not_before else now() + make_interval(mins => 5 * attempts) end
  where id = p_id
$$;
revoke execute on function public.telegram_notify_result(bigint, boolean, text) from public, anon, authenticated;
grant execute on function public.telegram_notify_result(bigint, boolean, text) to service_role;

-- the job every 5 minutes (quiet hours ended, retries; a new notification is also kicked at once)
do $$
declare
  v_call text := $call$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_project_url') || '/functions/v1/telegram',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'x-ppi-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_telegram_cron')),
      body := jsonb_build_object('action', 'notify'),
      timeout_milliseconds := 30000)$call$;
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'cron' and p.proname = 'schedule') then
    raise notice 'pg_cron is not on: the Telegram notifications are sent only when kicked.';
    return;
  end if;
  perform cron.schedule('ppi-telegram-tick', '*/5 * * * *', v_call);
end;
$$;

-- ------------------------------------------------------------------ 7. the owner's choices per shop (website)

/** Per shop of the bot's grant: the AI on/off, the notifications ticked and the quiet hours. */
create or replace function public.owner_telegram_prefs()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('shop_id', p.shop_id, 'ai_on', p.ai_on, 'notify', p.notify,
                                               'quiet_from', to_char(p.quiet_from, 'HH24:MI'),
                                               'quiet_to', to_char(p.quiet_to, 'HH24:MI'))), '[]'::jsonb)
  from public.telegram_links l join public.telegram_shop_prefs p on p.link_id = l.id
  where l.user_id = auth.uid()
$$;
revoke execute on function public.owner_telegram_prefs() from public, anon;
grant execute on function public.owner_telegram_prefs() to authenticated;

create or replace function public.owner_telegram_save_prefs(
  p_shop_id uuid, p_ai_on boolean, p_notify jsonb, p_quiet_from text, p_quiet_to text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  l public.telegram_links%rowtype;
  v_notify jsonb;
begin
  if auth.uid() is null then raise exception 'login' using errcode = '42501'; end if;
  select * into l from public.telegram_links where user_id = auth.uid();
  if not found then raise exception 'not_linked' using errcode = 'P0002'; end if;
  if not public.is_shop_member(p_shop_id)
     or not exists (select 1 from public.owner_mcp_tokens t where t.id = l.grant_id and p_shop_id = any (t.shop_ids)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if (nullif(p_quiet_from, '') is null) <> (nullif(p_quiet_to, '') is null)
     or coalesce(p_quiet_from, '') !~ '^(|([01][0-9]|2[0-3]):[0-5][0-9])$'
     or coalesce(p_quiet_to, '') !~ '^(|([01][0-9]|2[0-3]):[0-5][0-9])$' then
    raise exception 'quiet' using errcode = '22023';
  end if;
  select coalesce(jsonb_object_agg(k, true), '{}'::jsonb) into v_notify
  from jsonb_object_keys(coalesce(p_notify, '{}'::jsonb)) k
  where k in ('booking_new', 'booking_cancelled', 'callback') and coalesce((p_notify ->> k)::boolean, false);
  insert into public.telegram_shop_prefs (link_id, shop_id, ai_on, notify, quiet_from, quiet_to, updated_at)
  values (l.id, p_shop_id, coalesce(p_ai_on, true), v_notify, nullif(p_quiet_from, '')::time, nullif(p_quiet_to, '')::time, now())
  on conflict (link_id, shop_id) do update
    set ai_on = excluded.ai_on, notify = excluded.notify, quiet_from = excluded.quiet_from, quiet_to = excluded.quiet_to,
        updated_at = now();
  return true;
end;
$$;
revoke execute on function public.owner_telegram_save_prefs(uuid, boolean, jsonb, text, text) from public, anon;
grant execute on function public.owner_telegram_save_prefs(uuid, boolean, jsonb, text, text) to authenticated;

/** "Poslať skúšobné upozornenie": one test message to the owner's Telegram (ignores quiet hours, counts in the cap). */
create or replace function public.owner_telegram_test(p_shop_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  l public.telegram_links%rowtype;
begin
  if auth.uid() is null then raise exception 'login' using errcode = '42501'; end if;
  select * into l from public.telegram_links where user_id = auth.uid();
  if not found then raise exception 'not_linked' using errcode = 'P0002'; end if;
  if not public.is_shop_member(p_shop_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if (select count(*) from public.telegram_outbox where link_id = l.id and kind = 'test' and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'too_many' using errcode = '54000';
  end if;
  insert into public.telegram_outbox (link_id, shop_id, kind) values (l.id, p_shop_id, 'test');
  perform public.telegram_kick();
  return true;
end;
$$;
revoke execute on function public.owner_telegram_test(uuid) from public, anon;
grant execute on function public.owner_telegram_test(uuid) to authenticated;
