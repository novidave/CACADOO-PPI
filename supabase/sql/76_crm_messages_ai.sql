-- PPI · update 76: CRM → Správy, "Opraviť gramatiku" and the AI pomocník on the website (2026-11-04)
--
-- 1. "Opraviť gramatiku" (e-mail and SMS, templates and messages): paid (shop_has_plan), members only, at most
--    owner_ai_settings.grammar_daily_limit a day per shop (default 30, the admin's setting; 0 = off). Every call is
--    counted in owner_ai_usage (kind grammar) with its tokens — the AI spend of the owner's AI tools.
-- 2. CRM → Správy: owner_contact_search() (the recipient bar: name, phone, e-mail; only the shop's contacts) and
--    owner_messages_log() (every message sent to the shop's contacts, without the SMS codes).
-- 3. The AI pomocník on the website: the same engine as the Telegram bot (src/lib/ownerAssistantCore.ts) and the same
--    one door — assistant_web_call() = owner_mcp_call() with the owner's own grant of kind 'web' (its token only in
--    the Vault, like Telegram's). Every write waits for "Potvrdiť": assistant_pending_new() → assistant_confirm() (the
--    same owner, 10 minutes, once; activity marked source 'web'); a write outside a confirmation is refused. The admin's
--    AI switch and the daily limit are Telegram's (telegram_settings) and ONE limit per owner: web + Telegram together.
--
-- Run once in the Supabase SQL Editor (Claude applies it as 76_crm_messages_ai). Safe to run again.

-- ------------------------------------------------------------------ 1. settings and usage

create table if not exists public.owner_ai_settings (
  id                  boolean primary key default true check (id),
  grammar_daily_limit integer not null default 30 check (grammar_daily_limit between 0 and 1000),
  updated_at          timestamptz not null default now()
);
insert into public.owner_ai_settings (id) values (true) on conflict (id) do nothing;

-- one row per shop, owner, day and kind: how many AI calls and their tokens (the spend of the owner's AI tools)
create table if not exists public.owner_ai_usage (
  shop_id       uuid not null references public.shops (id) on delete cascade,
  user_id       uuid not null,
  day           date not null,
  kind          text not null check (kind in ('grammar', 'assistant')),
  calls         integer not null default 0,
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  primary key (shop_id, user_id, day, kind)
);
create index if not exists owner_ai_usage_user_idx on public.owner_ai_usage (user_id, day, kind);

-- the owner's own grant for the website's AI pomocník (kind 'web'; its token only in the Vault)
create table if not exists public.assistant_web_links (
  user_id    uuid primary key,
  grant_id   uuid references public.owner_mcp_tokens (id) on delete set null,
  vault_id   uuid,
  created_at timestamptz not null default now()
);

-- a write the AI proposed, waiting for the owner's "Potvrdiť" (10 minutes, once)
create table if not exists public.assistant_pending (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  tool        text not null,
  args        jsonb not null,
  summary     jsonb not null default '{}'::jsonb,
  expires_at  timestamptz not null default now() + interval '10 minutes',
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists assistant_pending_user_idx on public.assistant_pending (user_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['owner_ai_settings', 'owner_ai_usage', 'assistant_web_links', 'assistant_pending'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

alter table public.owner_mcp_tokens drop constraint if exists owner_mcp_tokens_kind_check;
alter table public.owner_mcp_tokens add constraint owner_mcp_tokens_kind_check
  check (kind in ('oauth', 'personal', 'telegram', 'web'));

-- ------------------------------------------------------------------ 2. "Opraviť gramatiku"

/**
 * Before every "Opraviť gramatiku": a member of the shop with the plan, the admin's daily limit per shop (the shop's own
 * day). Raises no_plan / grammar_off / grammar_limit; returns the fixes left today.
 */
create or replace function public.owner_grammar_hit(p_shop_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_limit integer := (select grammar_daily_limit from public.owner_ai_settings where id);
  v_day date;
  v_used integer;
begin
  perform public.crm_owner_check(p_shop_id);
  if coalesce(v_limit, 0) = 0 then raise exception 'grammar_off' using errcode = 'P0001'; end if;
  v_day := (now() at time zone coalesce((select timezone from public.shops where id = p_shop_id), 'UTC'))::date;
  perform pg_advisory_xact_lock(hashtext('ppi-grammar:' || p_shop_id::text));
  select coalesce(sum(calls), 0) into v_used from public.owner_ai_usage
  where shop_id = p_shop_id and day = v_day and kind = 'grammar';
  if v_used >= v_limit then raise exception 'grammar_limit' using errcode = '54000'; end if;
  insert into public.owner_ai_usage (shop_id, user_id, day, kind, calls) values (p_shop_id, auth.uid(), v_day, 'grammar', 1)
  on conflict (shop_id, user_id, day, kind) do update set calls = public.owner_ai_usage.calls + 1;
  delete from public.owner_ai_usage where day < current_date - 90;
  return v_limit - v_used - 1;
end;
$$;
revoke execute on function public.owner_grammar_hit(uuid) from public, anon;
grant execute on function public.owner_grammar_hit(uuid) to authenticated;

/** After an AI call of the owner's tools: its tokens on today's row (the AI spend). Members only. */
create or replace function public.owner_ai_spend(p_shop_id uuid, p_kind text, p_input bigint, p_output bigint)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_day date;
begin
  if p_shop_id is null or not public.is_shop_member(p_shop_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_kind not in ('grammar', 'assistant') then raise exception 'kind' using errcode = '22023'; end if;
  v_day := case when p_kind = 'grammar'
                then (now() at time zone coalesce((select timezone from public.shops where id = p_shop_id), 'UTC'))::date
                else current_date end;
  insert into public.owner_ai_usage (shop_id, user_id, day, kind, input_tokens, output_tokens)
  values (p_shop_id, auth.uid(), v_day, p_kind, greatest(coalesce(p_input, 0), 0), greatest(coalesce(p_output, 0), 0))
  on conflict (shop_id, user_id, day, kind) do update
  set input_tokens = public.owner_ai_usage.input_tokens + excluded.input_tokens,
      output_tokens = public.owner_ai_usage.output_tokens + excluded.output_tokens;
end;
$$;
revoke execute on function public.owner_ai_spend(uuid, text, bigint, bigint) from public, anon;
grant execute on function public.owner_ai_spend(uuid, text, bigint, bigint) to authenticated;

-- ------------------------------------------------------------------ 3. CRM → Správy

/**
 * The recipient bar: the shop's contacts whose name or e-mail contains every typed word (accents ignored, partial words
 * count) or whose phone contains the typed digits (≥ 3). Members only; at most 20, names starting with the words first.
 */
create or replace function public.owner_contact_search(p_shop_id uuid, p_q text, p_limit integer default 8)
returns table (id uuid, name text, phone text, email text, phone_verified boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with q as (
    select public.search_text(btrim(coalesce(p_q, ''))) as words,
           regexp_replace(regexp_replace(coalesce(p_q, ''), '[^0-9]', '', 'g'), '^0+', '') as digits
  )
  select c.id, c.name, c.phone, c.email, c.phone_verified_at is not null
  from public.shop_contacts c, q
  where c.shop_id = p_shop_id and public.is_shop_member(p_shop_id) and q.words <> ''
    and ((select bool_and(public.search_text(concat_ws(' ', c.name, c.email)) like '%' || w || '%')
          from unnest(regexp_split_to_array(q.words, '\s+')) w where w <> '')
         or (char_length(q.digits) >= 3 and c.phone like '%' || q.digits || '%'))
  order by public.search_text(coalesce(c.name, '')) like split_part(q.words, ' ', 1) || '%' desc,
           c.name nulls last, c.id
  limit least(greatest(coalesce(p_limit, 8), 1), 20)
$$;
revoke execute on function public.owner_contact_search(uuid, text, integer) from public, anon;
grant execute on function public.owner_contact_search(uuid, text, integer) to authenticated;

/**
 * "Odoslané správy": every SMS and e-mail the shop sent to its contacts, newest first (never the SMS codes). Filters:
 * channel, status, words (the contact's name, the address, the text). Members only.
 */
create or replace function public.owner_messages_log(
  p_shop_id uuid, p_channel text default null, p_status text default null, p_q text default null,
  p_limit integer default 50, p_offset integer default 0
)
returns table (id uuid, created_at timestamptz, contact_id uuid, contact_name text, recipient text, channel text,
               status text, kind text, subject text, first_line text, total_count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select m.id, m.created_at, m.contact_id, c.name, m.recipient, m.channel, m.status, m.kind, m.subject,
         left(split_part(btrim(m.body), E'\n', 1), 140), count(*) over ()
  from public.shop_outgoing_messages m
  left join public.shop_contacts c on c.id = m.contact_id
  where m.shop_id = p_shop_id and public.is_shop_member(p_shop_id)
    and coalesce(m.kind, 'owner') not like '%code%'
    and (nullif(p_channel, '') is null or m.channel = p_channel)
    and (nullif(p_status, '') is null or m.status = p_status)
    and (nullif(btrim(coalesce(p_q, '')), '') is null
         or public.matches_all_words(public.search_text(concat_ws(' ', c.name, m.recipient, m.subject, m.body)), p_q))
  order by m.created_at desc, m.id
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0)
$$;
revoke execute on function public.owner_messages_log(uuid, text, text, text, integer, integer) from public, anon;
grant execute on function public.owner_messages_log(uuid, text, text, text, integer, integer) to authenticated;

-- ------------------------------------------------------------------ 4. the AI pomocník on the website

/**
 * The owner's own web grant (kind 'web', shop.read + shop.write): every shop they are a member of with the plan
 * (refreshed on each call). Its token is made once and kept only in the Vault. Internal.
 */
create or replace function public.assistant_web_token()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  l public.assistant_web_links%rowtype;
  t public.owner_mcp_tokens%rowtype;
  v_shops uuid[];
  v_token text;
  v_grant uuid;
  v_vault uuid;
begin
  if auth.uid() is null then raise exception 'login' using errcode = '42501'; end if;
  select coalesce(array_agg(m.shop_id order by m.shop_id), '{}') into v_shops
  from (select m.shop_id from public.shop_members m join public.shops s on s.id = m.shop_id
        where m.user_id = auth.uid() and public.shop_has_plan(m.shop_id) order by m.shop_id limit 20) m;
  if cardinality(v_shops) = 0 then raise exception 'no_plan' using errcode = 'P0001'; end if;
  select * into l from public.assistant_web_links where user_id = auth.uid() for update;
  if found and l.grant_id is not null and l.vault_id is not null then
    select * into t from public.owner_mcp_tokens where id = l.grant_id;
    if t.id is not null and t.revoked_at is null and t.access_expires_at > now() + interval '1 day' then
      select decrypted_secret into v_token from vault.decrypted_secrets where id = l.vault_id;
      if v_token is not null then
        if t.shop_ids is distinct from v_shops then
          update public.owner_mcp_tokens set shop_ids = v_shops where id = t.id;
        end if;
        return v_token;
      end if;
    end if;
  end if;
  -- a new grant (first use, or the old one revoked / expiring)
  if l.grant_id is not null then
    update public.owner_mcp_tokens set revoked_at = coalesce(revoked_at, now()) where id = l.grant_id;
  end if;
  if l.vault_id is not null then delete from vault.secrets where id = l.vault_id; end if;
  v_token := public.mcp_random('cwa_');
  insert into public.owner_mcp_tokens (kind, user_id, name, shop_ids, scopes, access_hash, access_expires_at)
  values ('web', auth.uid(), 'AI pomocník', v_shops, array['shop.read', 'shop.write'], public.mcp_hash(v_token),
          now() + interval '1 year')
  returning id into v_grant;
  v_vault := vault.create_secret(v_token, 'ppi_web_grant_' || auth.uid()::text || '_' || extract(epoch from clock_timestamp())::bigint,
                                 'AI pomocník grant');
  insert into public.assistant_web_links (user_id, grant_id, vault_id) values (auth.uid(), v_grant, v_vault)
  on conflict (user_id) do update set grant_id = excluded.grant_id, vault_id = excluded.vault_id;
  return v_token;
end;
$$;
revoke execute on function public.assistant_web_token() from public, anon, authenticated;

/**
 * Every tool of the website's AI pomocník: the owner MCP's one door with the owner's web grant, marked source 'web'.
 * A write runs only from "Potvrdiť" (assistant_confirm); update_stock without confirm only shows before → after.
 */
create or replace function public.assistant_web_call(p_tool text, p_args jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  if auth.uid() is null then raise exception 'login' using errcode = '42501'; end if;
  if public.mcp_tool_scope(p_tool) is null then raise exception 'unknown_tool' using errcode = '22023'; end if;
  if public.mcp_tool_scope(p_tool) in ('shop.write', 'messages.send')
     and not (p_tool = 'update_stock' and coalesce((p_args ->> 'confirm')::boolean, false) is not true)
     and coalesce(current_setting('ppi.assistant_confirmed', true), '') = '' then
    raise exception 'needs_confirmation' using errcode = '42501';
  end if;
  v_token := public.assistant_web_token();
  perform set_config('ppi.source', 'web', true);
  return public.owner_mcp_call(v_token, p_tool, coalesce(p_args, '{}'::jsonb));
end;
$$;
revoke execute on function public.assistant_web_call(text, jsonb) from public, anon;
grant execute on function public.assistant_web_call(text, jsonb) to authenticated;

/** A write the AI proposed, waiting for "Potvrdiť" (10 minutes, once). Only write tools; the summary is shown as is. */
create or replace function public.assistant_pending_new(p_tool text, p_args jsonb, p_summary jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'login' using errcode = '42501'; end if;
  if coalesce(public.mcp_tool_scope(p_tool), '') <> 'shop.write' then raise exception 'unknown_tool' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_args, '{}'::jsonb)) <> 'object' or pg_column_size(p_args) > 8000
     or pg_column_size(coalesce(p_summary, '{}'::jsonb)) > 4000 then
    raise exception 'bad_argument' using errcode = '22023';
  end if;
  if (select count(*) from public.assistant_pending where user_id = auth.uid() and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'too_many' using errcode = '54000';
  end if;
  delete from public.assistant_pending where user_id = auth.uid() and created_at < now() - interval '1 day';
  insert into public.assistant_pending (user_id, tool, args, summary)
  values (auth.uid(), p_tool, coalesce(p_args, '{}'::jsonb), coalesce(p_summary, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.assistant_pending_new(text, jsonb, jsonb) from public, anon;
grant execute on function public.assistant_pending_new(text, jsonb, jsonb) to authenticated;

/** "Potvrdiť": the waiting write runs through the one door — the same owner, within 10 minutes, once. */
create or replace function public.assistant_confirm(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  p public.assistant_pending%rowtype;
  v_out jsonb;
begin
  if auth.uid() is null then raise exception 'login' using errcode = '42501'; end if;
  select * into p from public.assistant_pending where id = p_id and user_id = auth.uid() for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p.used_at is not null then raise exception 'used' using errcode = '22023'; end if;
  if p.expires_at < now() then raise exception 'expired' using errcode = '22023'; end if;
  update public.assistant_pending set used_at = now() where id = p.id;
  perform set_config('ppi.assistant_confirmed', p.id::text, true);
  v_out := public.assistant_web_call(p.tool, p.args);
  perform set_config('ppi.assistant_confirmed', '', true);
  return jsonb_build_object('tool', p.tool, 'summary', p.summary, 'out', v_out);
end;
$$;
revoke execute on function public.assistant_confirm(uuid) from public, anon;
grant execute on function public.assistant_confirm(uuid) to authenticated;

/** "Zrušiť" on a waiting write. */
create or replace function public.assistant_cancel(p_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  update public.assistant_pending set used_at = now()
  where id = p_id and user_id = auth.uid() and used_at is null
  returning true
$$;
revoke execute on function public.assistant_cancel(uuid) from public, anon;
grant execute on function public.assistant_cancel(uuid) to authenticated;

/** The owner's AI messages today: the website's (all their shops) + Telegram's — one daily limit for both. */
create or replace function public.owner_ai_messages_today(p_user uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select sum(u.calls) from public.owner_ai_usage u
                   where u.user_id = p_user and u.day = current_date and u.kind = 'assistant'), 0)::integer
       + coalesce((select sum(t.messages) from public.telegram_ai_usage t join public.telegram_links l on l.id = t.link_id
                   where l.user_id = p_user and t.day = current_date), 0)::integer
$$;
revoke execute on function public.owner_ai_messages_today(uuid) from public, anon, authenticated;

/**
 * Before every answer of the website's AI pomocník: the admin's AI switch and daily limit (telegram_settings — the
 * same as the bot's, counted together with the owner's Telegram messages), a member of the shop with the plan.
 * Raises ai_off / ai_limit / no_plan / forbidden; returns the messages left today.
 */
create or replace function public.assistant_ai_hit(p_shop text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s public.telegram_settings%rowtype;
  v_shop uuid;
  v_used integer;
begin
  if auth.uid() is null then raise exception 'login' using errcode = '42501'; end if;
  select * into s from public.telegram_settings where id;
  if not coalesce(s.ai_enabled, false) or coalesce(s.ai_daily_limit, 0) = 0 then raise exception 'ai_off' using errcode = 'P0001'; end if;
  select id into v_shop from public.shops where slug = p_shop;
  if v_shop is null or not public.is_shop_member(v_shop) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not public.shop_has_plan(v_shop) then raise exception 'no_plan' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtext('ppi-ai:' || auth.uid()::text));
  v_used := public.owner_ai_messages_today(auth.uid());
  if v_used >= s.ai_daily_limit then raise exception 'ai_limit' using errcode = '54000'; end if;
  insert into public.owner_ai_usage (shop_id, user_id, day, kind, calls) values (v_shop, auth.uid(), current_date, 'assistant', 1)
  on conflict (shop_id, user_id, day, kind) do update set calls = public.owner_ai_usage.calls + 1;
  return s.ai_daily_limit - v_used - 1;
end;
$$;
revoke execute on function public.assistant_ai_hit(text) from public, anon;
grant execute on function public.assistant_ai_hit(text) to authenticated;

/** Update 66's Telegram AI limit, now shared with the website's AI pomocník (one limit per owner and day). */
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
  perform pg_advisory_xact_lock(hashtext('ppi-ai:' || l.user_id::text));
  v_used := public.owner_ai_messages_today(l.user_id);
  if v_used >= s.ai_daily_limit then raise exception 'ai_limit' using errcode = '54000'; end if;
  insert into public.telegram_ai_usage (link_id, day, messages) values (l.id, current_date, 1)
  on conflict (link_id, day) do update set messages = telegram_ai_usage.messages + 1;
  delete from public.telegram_ai_usage where link_id = l.id and day < current_date - 30;
  return s.ai_daily_limit - v_used - 1;
end;
$$;
revoke execute on function public.telegram_ai_hit(bigint, text) from public, anon, authenticated;
grant execute on function public.telegram_ai_hit(bigint, text) to service_role;

-- ------------------------------------------------------------------ 5. the admin

/** "AI pre majiteľov" on the admin page: the grammar limit and today's / this month's use of the owner's AI tools. */
create or replace function public.admin_owner_ai()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'grammar_daily_limit', (select grammar_daily_limit from public.owner_ai_settings where id),
    'today', (select coalesce(jsonb_object_agg(kind, jsonb_build_object('calls', calls, 'input', input, 'output', output)), '{}'::jsonb)
              from (select kind, sum(calls) as calls, sum(input_tokens) as input, sum(output_tokens) as output
                    from public.owner_ai_usage where day = current_date group by kind) x),
    'month', (select coalesce(jsonb_object_agg(kind, jsonb_build_object('calls', calls, 'input', input, 'output', output)), '{}'::jsonb)
              from (select kind, sum(calls) as calls, sum(input_tokens) as input, sum(output_tokens) as output
                    from public.owner_ai_usage where day >= date_trunc('month', current_date)::date group by kind) x));
end;
$$;
revoke execute on function public.admin_owner_ai() from public, anon;
grant execute on function public.admin_owner_ai() to authenticated;

create or replace function public.admin_save_owner_ai(p_grammar_daily_limit integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_grammar_daily_limit is null or p_grammar_daily_limit not between 0 and 1000 then
    raise exception 'limit' using errcode = '22023';
  end if;
  update public.owner_ai_settings set grammar_daily_limit = p_grammar_daily_limit, updated_at = now() where id;
end;
$$;
revoke execute on function public.admin_save_owner_ai(integer) from public, anon;
grant execute on function public.admin_save_owner_ai(integer) to authenticated;
