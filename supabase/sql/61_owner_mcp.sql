-- PPI · database update 61 — the owner's MCP server: AI assistants work for the shop owner (CRM phase 7, 31 October 2026)
--
-- An owner connects Claude, ChatGPT, Gemini, Grok or any other MCP client to https://<site>/mcp/owner and lets it read
-- and change their own shop's data — conversations, contacts, bookings, messages, opening hours, shop details and
-- stock — exactly as Môj obchod does, through the same owner_* functions. The shopper MCP (/mcp) is unchanged.
--   * Access: OAuth 2.1 (dynamic client registration, authorization code + PKCE S256, refresh tokens that rotate) for
--     clients that support it, or a personal key made in Môj obchod → "AI asistenti" for clients that only take a
--     bearer token. Every grant names the shops and the scopes the owner ticked: shop.read, shop.write,
--     messages.send. Tokens are random, returned once and stored only as SHA-256; access tokens last 1 hour, refresh
--     tokens 60 days (a refresh token used twice revokes the grant), personal keys 1 year. Pro shops only.
--   * One door: owner_mcp_call(token, tool, args) (callable by the website without any secret). It checks the token,
--     the scope of the tool, the shop (one of the grant's, the owner still a member, the plan), 120 calls a minute
--     per grant, then acts AS the owner (the request's JWT claims are set to the owner, so auth.uid() and every
--     owner_* rule apply as on the website) and logs writes in shop_activity.
--   * Nothing goes out without a preview: preview_message stores exactly what would be sent and returns a
--     confirmation id (10 minutes, once); the crm-messages function sends it only through owner_mcp_message_queue,
--     which refuses when the rendered message changed since the preview. Stock edits and deleting a contact also need
--     a second call with confirm: true; a stock edit says that the next stock file / POS agent / inventory program
--     will overwrite it, and never changes the currency or the stock's freshness.
--
-- Paste the whole file into Supabase → SQL Editor → Run. Safe to run again. Needs updates 55–60.

-- ------------------------------------------------------------------ activity

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
                    'hours_changed', 'shop_details_changed', 'stock_edited'));

-- ------------------------------------------------------------------ tables (service definer functions only)

create table if not exists public.owner_mcp_clients (
  client_id     text primary key,
  client_name   text not null check (char_length(client_name) between 1 and 100),
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 10),
  caller        text,
  created_at    timestamptz not null default now()
);
create index if not exists owner_mcp_clients_caller_idx on public.owner_mcp_clients (caller, created_at desc);

create table if not exists public.owner_mcp_codes (
  code_hash      text primary key,
  client_id      text not null references public.owner_mcp_clients (client_id) on delete cascade,
  user_id        uuid not null,
  shop_ids       uuid[] not null,
  scopes         text[] not null,
  redirect_uri   text not null,
  code_challenge text not null,
  resource       text,
  expires_at     timestamptz not null,
  used_at        timestamptz,
  token_id       uuid
);

create table if not exists public.owner_mcp_tokens (
  id                 uuid primary key default gen_random_uuid(),
  kind               text not null check (kind in ('oauth', 'personal')),
  user_id            uuid not null,
  client_id          text references public.owner_mcp_clients (client_id) on delete set null,
  name               text not null check (char_length(name) between 1 and 100),
  shop_ids           uuid[] not null check (cardinality(shop_ids) between 1 and 20),
  scopes             text[] not null,
  access_hash        text not null unique,
  access_expires_at  timestamptz not null,
  refresh_hash       text unique,
  prev_refresh_hash  text,
  refresh_expires_at timestamptz,
  resource           text,
  window_start       timestamptz not null default now(),
  window_calls       integer not null default 0,
  created_at         timestamptz not null default now(),
  last_used_at       timestamptz,
  revoked_at         timestamptz
);
create index if not exists owner_mcp_tokens_user_idx on public.owner_mcp_tokens (user_id, created_at desc);

create table if not exists public.owner_mcp_pending (
  id         uuid primary key default gen_random_uuid(),
  token_id   uuid not null references public.owner_mcp_tokens (id) on delete cascade,
  shop_id    uuid not null references public.shops (id) on delete cascade,
  kind       text not null check (kind in ('message')),
  args       jsonb not null,
  draft_hash text not null,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

do $$
declare
  t text;
begin
  foreach t in array array['owner_mcp_clients', 'owner_mcp_codes', 'owner_mcp_tokens', 'owner_mcp_pending'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

-- ------------------------------------------------------------------ helpers

create or replace function public.mcp_hash(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to('ppi-mcp:' || coalesce(p_value, ''), 'UTF8')), 'hex')
$$;
revoke execute on function public.mcp_hash(text) from public, anon, authenticated;

/** 64 random hex characters (two v4 UUIDs: 244 random bits) behind a prefix. */
create or replace function public.mcp_random(p_prefix text)
returns text
language sql
volatile
set search_path = ''
as $$
  select p_prefix || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
$$;
revoke execute on function public.mcp_random(text) from public, anon, authenticated;

/** PKCE S256: base64url(sha256(verifier)) without padding. */
create or replace function public.mcp_s256(p_verifier text)
returns text
language sql
immutable
set search_path = ''
as $$
  select rtrim(translate(encode(sha256(convert_to(coalesce(p_verifier, ''), 'UTF8')), 'base64'), '+/', '-_'), '=')
$$;
revoke execute on function public.mcp_s256(text) from public, anon, authenticated;

/** The scopes an owner can grant. */
create or replace function public.mcp_scopes_ok(p_scopes text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select cardinality(p_scopes) between 1 and 3
     and p_scopes <@ array['shop.read', 'shop.write', 'messages.send']
     and 'shop.read' = any (p_scopes)
$$;
revoke execute on function public.mcp_scopes_ok(text[]) from public, anon, authenticated;

/** A redirect address a client may use: https on a real host, or http on this computer (CLI clients). */
create or replace function public.mcp_redirect_ok(p_uri text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_uri is not null and char_length(p_uri) <= 500 and p_uri !~ '[[:space:]<>"#]'
     and (p_uri ~* '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?(/[^?]*)?(\?.*)?$'
          or p_uri ~* '^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?(/[^?]*)?(\?.*)?$')
$$;
revoke execute on function public.mcp_redirect_ok(text) from public, anon, authenticated;

/**
 * Makes the rest of this request act as the owner: the JWT claims PostgREST would set for their own login, so
 * auth.uid() and every owner_* check work as on the website. Only for the definer functions below (no grants).
 */
create or replace function public.mcp_act_as(p_user uuid)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end;
$$;
revoke execute on function public.mcp_act_as(uuid) from public, anon, authenticated, service_role;

-- ------------------------------------------------------------------ OAuth: register, authorize, token, revoke

/**
 * Dynamic client registration (RFC 7591), public clients only (PKCE, no secret). 10 per caller an hour.
 * Refusals: redirect_uri, name, too_many.
 */
create or replace function public.owner_mcp_register(p_name text, p_redirect_uris text[], p_caller text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id text := public.mcp_random('cmc_');
  v_name text := left(btrim(coalesce(p_name, '')), 100);
  v_uri text;
begin
  if p_redirect_uris is null or cardinality(p_redirect_uris) not between 1 and 10 then
    raise exception 'redirect_uri' using errcode = '22023';
  end if;
  foreach v_uri in array p_redirect_uris loop
    if not public.mcp_redirect_ok(v_uri) then raise exception 'redirect_uri' using errcode = '22023'; end if;
  end loop;
  if v_name = '' then v_name := 'AI'; end if;
  if p_caller is null or length(p_caller) not between 16 and 128 then raise exception 'caller' using errcode = '22023'; end if;
  if (select count(*) from public.owner_mcp_clients where caller = p_caller and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'too_many' using errcode = '54000';
  end if;
  insert into public.owner_mcp_clients (client_id, client_name, redirect_uris, caller)
  values (v_id, v_name, p_redirect_uris, p_caller);
  return jsonb_build_object('client_id', v_id, 'client_name', v_name, 'redirect_uris', to_jsonb(p_redirect_uris));
end;
$$;
revoke execute on function public.owner_mcp_register(text, text[], text) from public;
grant execute on function public.owner_mcp_register(text, text[], text) to anon, authenticated, service_role;

/** A registered client's name and redirect addresses (the consent page shows the name). */
create or replace function public.owner_mcp_client(p_client_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('client_id', client_id, 'client_name', client_name, 'redirect_uris', to_jsonb(redirect_uris))
  from public.owner_mcp_clients where client_id = p_client_id
$$;
revoke execute on function public.owner_mcp_client(text) from public;
grant execute on function public.owner_mcp_client(text) to anon, authenticated, service_role;

/** The owner's shops a grant may name: members, active, with the plan (the consent page's ticks). */
create or replace function public.owner_mcp_shops()
returns table (shop_id uuid, slug text, name text, has_plan boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.slug, s.name, public.shop_has_plan(s.id)
  from public.shops s join public.shop_members m on m.shop_id = s.id and m.user_id = auth.uid()
  order by s.name
$$;
revoke execute on function public.owner_mcp_shops() from public, anon;
grant execute on function public.owner_mcp_shops() to authenticated;

/** Checks the shops of a new grant: the caller's own, with the plan. */
create or replace function public.mcp_grant_shops(p_shop_ids uuid[])
returns uuid[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
  v_out uuid[] := '{}';
begin
  if p_shop_ids is null or cardinality(p_shop_ids) not between 1 and 20 then raise exception 'shops' using errcode = '22023'; end if;
  foreach v_shop in array p_shop_ids loop
    if not public.is_shop_member(v_shop) then raise exception 'forbidden' using errcode = '42501'; end if;
    if not public.shop_has_plan(v_shop) then raise exception 'no_plan' using errcode = 'P0001'; end if;
    if not v_shop = any (v_out) then v_out := v_out || v_shop; end if;
  end loop;
  return v_out;
end;
$$;
revoke execute on function public.mcp_grant_shops(uuid[]) from public, anon, authenticated;

/**
 * "Povoliť" on the consent page (the owner's own login): a single-use code for 10 minutes. Refusals: client,
 * redirect_uri, challenge, scope, shops, forbidden, no_plan.
 */
create or replace function public.owner_mcp_authorize(
  p_client_id text, p_redirect_uri text, p_code_challenge text, p_scopes text[], p_shop_ids uuid[], p_resource text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_client public.owner_mcp_clients%rowtype;
  v_shops uuid[];
  v_code text := public.mcp_random('cmo_');
begin
  if auth.uid() is null then raise exception 'login' using errcode = '42501'; end if;
  select * into v_client from public.owner_mcp_clients where client_id = p_client_id;
  if not found then raise exception 'client' using errcode = '22023'; end if;
  if not p_redirect_uri = any (v_client.redirect_uris) then raise exception 'redirect_uri' using errcode = '22023'; end if;
  if p_code_challenge is null or p_code_challenge !~ '^[A-Za-z0-9_-]{43,128}$' then
    raise exception 'challenge' using errcode = '22023';
  end if;
  if not public.mcp_scopes_ok(p_scopes) then raise exception 'scope' using errcode = '22023'; end if;
  v_shops := public.mcp_grant_shops(p_shop_ids);
  delete from public.owner_mcp_codes where expires_at < now() - interval '1 day';
  insert into public.owner_mcp_codes (code_hash, client_id, user_id, shop_ids, scopes, redirect_uri, code_challenge,
                                      resource, expires_at)
  values (public.mcp_hash(v_code), p_client_id, auth.uid(), v_shops, p_scopes, p_redirect_uri, p_code_challenge,
          left(p_resource, 300), now() + interval '10 minutes');
  return v_code;
end;
$$;
revoke execute on function public.owner_mcp_authorize(text, text, text, text[], uuid[], text) from public, anon;
grant execute on function public.owner_mcp_authorize(text, text, text, text[], uuid[], text) to authenticated;

/** A grant's new access and refresh tokens (rotated), as the token endpoint returns them. */
create or replace function public.mcp_issue(p_token_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_access text := public.mcp_random('cma_');
  v_refresh text := public.mcp_random('cmr_');
  v_scopes text[];
begin
  update public.owner_mcp_tokens
  set access_hash = public.mcp_hash(v_access), access_expires_at = now() + interval '1 hour',
      prev_refresh_hash = refresh_hash, refresh_hash = public.mcp_hash(v_refresh),
      refresh_expires_at = now() + interval '60 days'
  where id = p_token_id
  returning scopes into v_scopes;
  return jsonb_build_object('access_token', v_access, 'token_type', 'Bearer', 'expires_in', 3600,
                            'refresh_token', v_refresh, 'scope', array_to_string(v_scopes, ' '));
end;
$$;
revoke execute on function public.mcp_issue(uuid) from public, anon, authenticated;

/**
 * The token endpoint (RFC 6749 + PKCE). authorization_code: the code once, the same client and redirect address, the
 * verifier matching the challenge — a code used twice revokes what it gave. refresh_token: rotates; an old refresh
 * token used again revokes the grant (both answer {"error": "invalid_grant"}, returned so the revocation stays).
 * Other refusals are raised as OAuth error codes: invalid_grant, invalid_client, unsupported_grant_type,
 * invalid_request.
 */
create or replace function public.owner_mcp_token(
  p_grant_type text, p_code text, p_code_verifier text, p_client_id text, p_redirect_uri text, p_refresh_token text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_code public.owner_mcp_codes%rowtype;
  v_token public.owner_mcp_tokens%rowtype;
  v_id uuid;
  v_shop uuid;
begin
  if p_grant_type = 'authorization_code' then
    if p_code is null or p_code_verifier is null or p_code_verifier !~ '^[A-Za-z0-9._~-]{43,128}$' then
      raise exception 'invalid_request' using errcode = '22023';
    end if;
    select * into v_code from public.owner_mcp_codes where code_hash = public.mcp_hash(p_code) for update;
    if not found or v_code.expires_at < now() then raise exception 'invalid_grant' using errcode = '22023'; end if;
    if v_code.used_at is not null then
      -- Returned, not raised, so that the revocation stays.
      update public.owner_mcp_tokens set revoked_at = coalesce(revoked_at, now()) where id = v_code.token_id;
      return jsonb_build_object('error', 'invalid_grant');
    end if;
    if v_code.client_id is distinct from p_client_id then raise exception 'invalid_client' using errcode = '22023'; end if;
    if v_code.redirect_uri is distinct from p_redirect_uri or public.mcp_s256(p_code_verifier) <> v_code.code_challenge then
      raise exception 'invalid_grant' using errcode = '22023';
    end if;
    insert into public.owner_mcp_tokens (kind, user_id, client_id, name, shop_ids, scopes, access_hash, access_expires_at,
                                         resource)
    values ('oauth', v_code.user_id, v_code.client_id,
            (select client_name from public.owner_mcp_clients where client_id = v_code.client_id),
            v_code.shop_ids, v_code.scopes, public.mcp_hash(public.mcp_random('cmx_')), now(), v_code.resource)
    returning id into v_id;
    update public.owner_mcp_codes set used_at = now(), token_id = v_id where code_hash = v_code.code_hash;
    foreach v_shop in array v_code.shop_ids loop
      insert into public.shop_activity (shop_id, actor, action, details)
      values (v_shop, v_code.user_id, 'mcp_connected',
              jsonb_build_object('grant_id', v_id, 'client', (select client_name from public.owner_mcp_clients
                                                             where client_id = v_code.client_id),
                                 'scopes', to_jsonb(v_code.scopes)));
    end loop;
    return public.mcp_issue(v_id);
  elsif p_grant_type = 'refresh_token' then
    if p_refresh_token is null then raise exception 'invalid_request' using errcode = '22023'; end if;
    select * into v_token from public.owner_mcp_tokens where refresh_hash = public.mcp_hash(p_refresh_token) for update;
    if not found then
      update public.owner_mcp_tokens set revoked_at = coalesce(revoked_at, now())
      where prev_refresh_hash = public.mcp_hash(p_refresh_token);
      return jsonb_build_object('error', 'invalid_grant');
    end if;
    if v_token.revoked_at is not null or v_token.refresh_expires_at < now() then
      raise exception 'invalid_grant' using errcode = '22023';
    end if;
    if v_token.client_id is distinct from p_client_id then raise exception 'invalid_client' using errcode = '22023'; end if;
    return public.mcp_issue(v_token.id);
  end if;
  raise exception 'unsupported_grant_type' using errcode = '22023';
end;
$$;
revoke execute on function public.owner_mcp_token(text, text, text, text, text, text) from public;
grant execute on function public.owner_mcp_token(text, text, text, text, text, text) to anon, authenticated, service_role;

/** Token revocation (RFC 7009): an access or refresh token revokes its grant. Always true (no oracle). */
create or replace function public.owner_mcp_revoke(p_token text)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  update public.owner_mcp_tokens set revoked_at = coalesce(revoked_at, now())
  where access_hash = public.mcp_hash(p_token) or refresh_hash = public.mcp_hash(p_token);
  select true
$$;
revoke execute on function public.owner_mcp_revoke(text) from public;
grant execute on function public.owner_mcp_revoke(text) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ the owner's own screen ("AI asistenti")

/** A personal key for clients without OAuth (shown once; 1 year). Refusals: name, scope, shops, no_plan, too_many. */
create or replace function public.owner_mcp_create_key(p_name text, p_shop_ids uuid[], p_scopes text[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := public.mcp_random('cmk_');
  v_name text := left(btrim(coalesce(p_name, '')), 100);
  v_shops uuid[];
  v_id uuid;
  v_shop uuid;
begin
  if auth.uid() is null then raise exception 'login' using errcode = '42501'; end if;
  if v_name = '' then raise exception 'name' using errcode = '22023'; end if;
  if not public.mcp_scopes_ok(p_scopes) then raise exception 'scope' using errcode = '22023'; end if;
  v_shops := public.mcp_grant_shops(p_shop_ids);
  if (select count(*) from public.owner_mcp_tokens where user_id = auth.uid() and kind = 'personal' and revoked_at is null
      and access_expires_at > now()) >= 10 then
    raise exception 'too_many' using errcode = '54000';
  end if;
  insert into public.owner_mcp_tokens (kind, user_id, name, shop_ids, scopes, access_hash, access_expires_at)
  values ('personal', auth.uid(), v_name, v_shops, p_scopes, public.mcp_hash(v_key), now() + interval '1 year')
  returning id into v_id;
  foreach v_shop in array v_shops loop
    insert into public.shop_activity (shop_id, actor, action, details)
    values (v_shop, auth.uid(), 'mcp_key_created', jsonb_build_object('grant_id', v_id, 'name', v_name, 'scopes', to_jsonb(p_scopes)));
  end loop;
  return jsonb_build_object('id', v_id, 'key', v_key, 'expires_at', now() + interval '1 year');
end;
$$;
revoke execute on function public.owner_mcp_create_key(text, uuid[], text[]) from public, anon;
grant execute on function public.owner_mcp_create_key(text, uuid[], text[]) to authenticated;

/** The caller's connected assistants and keys (never a hash). */
create or replace function public.owner_mcp_grants()
returns table (id uuid, kind text, name text, scopes text[], shops jsonb, created_at timestamptz, last_used_at timestamptz,
               expires_at timestamptz, active boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.kind, t.name, t.scopes,
         (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'slug', s.slug, 'name', s.name) order by s.name), '[]')
          from public.shops s where s.id = any (t.shop_ids)),
         t.created_at, t.last_used_at,
         case when t.kind = 'oauth' then t.refresh_expires_at else t.access_expires_at end,
         t.revoked_at is null and (case when t.kind = 'oauth' then t.refresh_expires_at else t.access_expires_at end) > now()
  from public.owner_mcp_tokens t
  where t.user_id = auth.uid() and (t.revoked_at is null or t.revoked_at > now() - interval '30 days')
    and (t.kind = 'personal' or t.refresh_expires_at is not null)
  order by t.revoked_at is not null, t.created_at desc
  limit 100
$$;
revoke execute on function public.owner_mcp_grants() from public, anon;
grant execute on function public.owner_mcp_grants() to authenticated;

/** "Odpojiť": the grant stops at once (its own owner only). */
create or replace function public.owner_mcp_disconnect(p_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.owner_mcp_tokens%rowtype;
  v_shop uuid;
begin
  select * into v from public.owner_mcp_tokens where id = p_id and user_id = auth.uid() for update;
  if not found then raise exception 'forbidden' using errcode = '42501'; end if;
  if v.revoked_at is null then
    update public.owner_mcp_tokens set revoked_at = now() where id = p_id;
    foreach v_shop in array v.shop_ids loop
      if public.is_shop_member(v_shop) then
        insert into public.shop_activity (shop_id, actor, action, details)
        values (v_shop, auth.uid(), 'mcp_disconnected', jsonb_build_object('grant_id', p_id, 'name', v.name));
      end if;
    end loop;
  end if;
  return true;
end;
$$;
revoke execute on function public.owner_mcp_disconnect(uuid) from public, anon;
grant execute on function public.owner_mcp_disconnect(uuid) to authenticated;

-- ------------------------------------------------------------------ the tools

/** Which scope a tool needs; null = no such tool. */
create or replace function public.mcp_tool_scope(p_tool text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_tool in ('list_shops', 'get_shop_details', 'get_opening_hours', 'list_conversations', 'get_conversation',
                    'list_contacts', 'get_contact', 'list_bookings', 'list_email_templates', 'search_stock',
                    'get_sms_usage') then 'shop.read'
    when p_tool in ('update_conversations', 'save_contact', 'delete_contact', 'set_booking_status', 'set_opening_hours',
                    'update_shop_details', 'update_stock') then 'shop.write'
    when p_tool in ('preview_message') then 'messages.send'
  end
$$;
revoke execute on function public.mcp_tool_scope(text) from public, anon, authenticated;

/** The grant behind a bearer token, checked (not revoked, not expired, ≤ 120 calls a minute). */
create or replace function public.mcp_grant(p_token text)
returns public.owner_mcp_tokens
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.owner_mcp_tokens%rowtype;
begin
  select * into v from public.owner_mcp_tokens where access_hash = public.mcp_hash(p_token) for update;
  if not found or v.revoked_at is not null or v.access_expires_at < now() then
    raise exception 'invalid_token' using errcode = '28000';
  end if;
  if v.window_start < now() - interval '1 minute' then
    update public.owner_mcp_tokens set window_start = now(), window_calls = 1, last_used_at = now() where id = v.id;
  elsif v.window_calls >= 120 then
    raise exception 'too_many' using errcode = '54000';
  else
    update public.owner_mcp_tokens set window_calls = window_calls + 1, last_used_at = now() where id = v.id;
  end if;
  return v;
end;
$$;
revoke execute on function public.mcp_grant(text) from public, anon, authenticated;

/**
 * The website's first check of a bearer token on every MCP request (no call counted): the grant's scopes and shops,
 * or invalid_token — then the MCP server answers 401 so the client renews its token or asks the owner again.
 */
create or replace function public.owner_mcp_whoami(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.owner_mcp_tokens%rowtype;
begin
  select * into v from public.owner_mcp_tokens where access_hash = public.mcp_hash(p_token);
  if not found or v.revoked_at is not null or v.access_expires_at < now() then
    raise exception 'invalid_token' using errcode = '28000';
  end if;
  return jsonb_build_object('scopes', to_jsonb(v.scopes), 'name', v.name,
                            'shops', (select coalesce(jsonb_agg(jsonb_build_object('slug', s.slug, 'name', s.name) order by s.name), '[]')
                                      from public.shops s where s.id = any (v.shop_ids)));
end;
$$;
revoke execute on function public.owner_mcp_whoami(text) from public;
grant execute on function public.owner_mcp_whoami(text) to anon, authenticated, service_role;

/** The shop a call is about: the one named (slug or id) or the grant's only shop; a member, with the plan. */
create or replace function public.mcp_shop(p_grant public.owner_mcp_tokens, p_ref text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
begin
  if nullif(btrim(coalesce(p_ref, '')), '') is null then
    if cardinality(p_grant.shop_ids) = 1 then v_shop := p_grant.shop_ids[1];
    else raise exception 'shop_required' using errcode = '22023';
    end if;
  else
    select s.id into v_shop from public.shops s
    where s.id = any (p_grant.shop_ids) and (s.slug = btrim(p_ref) or s.id::text = btrim(p_ref));
    if v_shop is null then raise exception 'shop_not_in_grant' using errcode = '42501'; end if;
  end if;
  if not exists (select 1 from public.shop_members where shop_id = v_shop and user_id = p_grant.user_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not public.shop_has_plan(v_shop) then raise exception 'no_plan' using errcode = 'P0001'; end if;
  return v_shop;
end;
$$;
revoke execute on function public.mcp_shop(public.owner_mcp_tokens, text) from public, anon, authenticated;

/** The grant may reach the shop of a row named by its id (conversation, contact, booking). */
create or replace function public.mcp_own(p_grant public.owner_mcp_tokens, p_shop uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_shop is null or not p_shop = any (p_grant.shop_ids) then raise exception 'not_found' using errcode = 'P0002'; end if;
  return public.mcp_shop(p_grant, p_shop::text);
end;
$$;
revoke execute on function public.mcp_own(public.owner_mcp_tokens, uuid) from public, anon, authenticated;

create or replace function public.mcp_int(p_args jsonb, p_key text, p_default integer, p_min integer, p_max integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select least(greatest(coalesce(case when jsonb_typeof(p_args -> p_key) = 'number' then (p_args ->> p_key)::numeric::integer end,
                                 p_default), p_min), p_max)
$$;
revoke execute on function public.mcp_int(jsonb, text, integer, integer, integer) from public, anon, authenticated;

create or replace function public.mcp_uuid(p_args jsonb, p_key text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  return nullif(p_args ->> p_key, '')::uuid;
exception when others then
  raise exception 'bad_argument: %', p_key using errcode = '22023';
end;
$$;
revoke execute on function public.mcp_uuid(jsonb, text) from public, anon, authenticated;

create or replace function public.mcp_date(p_args jsonb, p_key text)
returns date
language plpgsql
immutable
set search_path = ''
as $$
begin
  if nullif(p_args ->> p_key, '') is null then return null; end if;
  if (p_args ->> p_key) !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'bad_argument: %', p_key using errcode = '22023'; end if;
  return (p_args ->> p_key)::date;
exception when invalid_parameter_value then raise;
  when others then raise exception 'bad_argument: %', p_key using errcode = '22023';
end;
$$;
revoke execute on function public.mcp_date(jsonb, text) from public, anon, authenticated;

/** The shop's regular week + its special days from today (in its time zone), as Môj obchod keeps them. */
create or replace function public.mcp_hours_of(p_shop uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'time_zone', s.timezone,
    'regular', coalesce(s.opening_hours, '{}'::jsonb),
    'public_holidays_apply', s.auto_holidays,
    'special_days', coalesce((select jsonb_agg(jsonb_build_object('date', h.date, 'closed', h.closed, 'ranges', h.ranges,
                                                                   'note', h.note) order by h.date)
                              from public.shop_special_hours h
                              where h.shop_id = s.id and h.date >= (now() at time zone s.timezone)::date
                                and h.date < (now() at time zone s.timezone)::date + 120), '[]'::jsonb))
  from public.shops s where s.id = p_shop
$$;
revoke execute on function public.mcp_hours_of(uuid) from public, anon, authenticated;

/**
 * Changes only the days named: regular {"mon": [["08:00","17:00"]], "sun": []} merged into the week, special
 * [{from, to?, closed, ranges}] (yesterday … +400 days, ≤ 62 days a row, ≤ 10 rows) per day. As hours_sms_apply.
 */
create or replace function public.mcp_set_hours(p_shop uuid, p_user uuid, p_regular jsonb, p_special jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_regular jsonb := coalesce(nullif(p_regular, 'null'::jsonb), '{}'::jsonb);
  v_special jsonb := coalesce(nullif(p_special, 'null'::jsonb), '[]'::jsonb);
  v_row jsonb;
  v_from date;
  v_to date;
  v_closed boolean;
  v_ranges jsonb;
  v_days integer := 0;
begin
  if jsonb_typeof(v_regular) <> 'object' or not public.valid_week_hours(v_regular) then
    raise exception 'hours' using errcode = '22023';
  end if;
  if jsonb_typeof(v_special) <> 'array' or jsonb_array_length(v_special) > 10 then raise exception 'dates' using errcode = '22023'; end if;
  if v_regular = '{}'::jsonb and jsonb_array_length(v_special) = 0 then raise exception 'empty' using errcode = '22023'; end if;
  for v_row in select * from jsonb_array_elements(v_special) loop
    begin
      v_from := (v_row ->> 'from')::date;
      v_to := coalesce(nullif(v_row ->> 'to', '')::date, v_from);
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

  update public.shops set opening_hours = coalesce(opening_hours, '{}'::jsonb) || v_regular where id = p_shop;
  for v_row in select * from jsonb_array_elements(v_special) loop
    v_from := (v_row ->> 'from')::date;
    v_to := coalesce(nullif(v_row ->> 'to', '')::date, v_from);
    v_closed := coalesce((v_row ->> 'closed')::boolean, false);
    v_ranges := case when v_closed then '[]'::jsonb else v_row -> 'ranges' end;
    insert into public.shop_special_hours (shop_id, date, closed, ranges, note)
    select p_shop, d::date, v_closed, v_ranges, left(nullif(btrim(v_row ->> 'note'), ''), 100)
    from generate_series(v_from::timestamp, v_to::timestamp, interval '1 day') d
    on conflict (shop_id, date) do update
      set closed = excluded.closed, ranges = excluded.ranges, note = coalesce(excluded.note, shop_special_hours.note),
          updated_at = now();
    v_days := v_days + (v_to - v_from + 1);
  end loop;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop, p_user, 'hours_changed',
          jsonb_build_object('via', 'mcp',
                             'regular_days', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(v_regular) k),
                             'special_days', v_days));
  return public.mcp_hours_of(p_shop);
end;
$$;
revoke execute on function public.mcp_set_hours(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;

/** A text argument cut to a length; absent → null. */
create or replace function public.mcp_text(p_args jsonb, p_key text, p_max integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when jsonb_typeof(p_args -> p_key) = 'string' then left(p_args ->> p_key, p_max) end
$$;
revoke execute on function public.mcp_text(jsonb, text, integer) from public, anon, authenticated;

/**
 * The one door for the owner's MCP server (the website calls it with the bearer token; no secret). Returns
 * {"shop": slug?, "result": …, "changed": bool} — changed = the public pages should be refreshed. Errors are raised
 * with short reasons the website turns into the tool's error text.
 */
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
  v_scope text := public.mcp_tool_scope(p_tool);
  v_shop uuid;
  v_id uuid;
  v_out jsonb;
  v_row jsonb;
  v_slug text;
  v_changed boolean := false;
  v_q text;
  v_ids uuid[];
  v_qty numeric;
  v_price numeric;
  v_item record;
  v_draft jsonb;
  v_pending uuid;
  v_patch jsonb;
begin
  if jsonb_typeof(a) <> 'object' then raise exception 'bad_argument: arguments' using errcode = '22023'; end if;
  g := public.mcp_grant(p_token);
  if v_scope is null then raise exception 'unknown_tool' using errcode = '22023'; end if;
  if not v_scope = any (g.scopes) then raise exception 'scope: %', v_scope using errcode = '42501'; end if;
  perform public.mcp_act_as(g.user_id);

  if p_tool = 'list_shops' then
    select coalesce(jsonb_agg(jsonb_build_object('slug', s.slug, 'name', s.name, 'city', s.city,
                                                 'has_plan', public.shop_has_plan(s.id)) order by s.name), '[]')
    into v_out
    from public.shops s
    where s.id = any (g.shop_ids) and exists (select 1 from public.shop_members m where m.shop_id = s.id and m.user_id = g.user_id);
    return jsonb_build_object('result', jsonb_build_object('shops', v_out, 'scopes', to_jsonb(g.scopes)));
  end if;

  -- Tools that name a row by its id find their shop from it; the rest name the shop (or the grant has one).
  if p_tool = 'get_conversation' then
    v_id := public.mcp_uuid(a, 'conversation_id');
    v_shop := public.mcp_own(g, (select shop_id from public.assistant_conversations where id = v_id));
  elsif p_tool in ('get_contact', 'delete_contact') then
    v_id := public.mcp_uuid(a, 'contact_id');
    v_shop := public.mcp_own(g, (select shop_id from public.shop_contacts where id = v_id));
  elsif p_tool = 'set_booking_status' then
    v_id := public.mcp_uuid(a, 'booking_id');
    v_shop := public.mcp_own(g, (select shop_id from public.shop_bookings where id = v_id));
  elsif p_tool = 'preview_message' then
    v_id := public.mcp_uuid(a, 'contact_id');
    v_shop := public.mcp_own(g, (select shop_id from public.shop_contacts where id = v_id));
  elsif p_tool = 'save_contact' and a ? 'contact_id' and nullif(a ->> 'contact_id', '') is not null then
    v_id := public.mcp_uuid(a, 'contact_id');
    v_shop := public.mcp_own(g, (select shop_id from public.shop_contacts where id = v_id));
  else
    v_shop := public.mcp_shop(g, a ->> 'shop');
  end if;
  select slug into v_slug from public.shops where id = v_shop;

  if p_tool = 'get_shop_details' then
    select jsonb_build_object('slug', s.slug, 'name', s.name, 'address', s.address, 'city', s.city, 'country', s.country,
                              'time_zone', s.timezone, 'phone', s.phone, 'email', s.email, 'website', s.website,
                              'facebook_url', s.facebook_url, 'booking_url', s.booking_url, 'is_active', s.is_active,
                              'stock_source', public.stock_source_of(s.id),
                              'last_stock_file_at', (select latest_file_time from public.sync_sources where shop_id = s.id),
                              'freshness', public.freshness_label((select latest_file_time from public.sync_sources
                                                                   where shop_id = s.id)))
    into v_out from public.shops s where s.id = v_shop;

  elsif p_tool = 'get_opening_hours' then
    v_out := public.mcp_hours_of(v_shop);

  elsif p_tool = 'list_conversations' then
    select coalesce(jsonb_agg(to_jsonb(c) - 'export_path' - 'export_error' - 'export_status'), '[]') into v_out
    from public.owner_conversations(v_shop, public.mcp_text(a, 'q', 200), public.mcp_date(a, 'from'), public.mcp_date(a, 'to'),
                                    public.mcp_text(a, 'status', 20),
                                    case when a ? 'starred' then (a ->> 'starred')::boolean end,
                                    case when a ? 'unanswered' then (a ->> 'unanswered')::boolean end,
                                    null, public.mcp_text(a, 'language', 10),
                                    public.mcp_int(a, 'limit', 20, 1, 50), public.mcp_int(a, 'offset', 0, 0, 100000)) c;

  elsif p_tool = 'get_conversation' then
    select jsonb_build_object(
             'id', c.id, 'started_at', c.started_at, 'ended_at', c.ended_at, 'status', c.status, 'starred', c.starred,
             'unanswered', c.unanswered, 'owner_note', c.owner_note, 'contact_id', c.contact_id,
             'messages', coalesce((select jsonb_agg(jsonb_build_object('role', m.role, 'text', m.body,
                                                                        'text_slovak', m.body_owner, 'lang', m.lang,
                                                                        'cards', m.cards, 'at', m.created_at) order by m.id)
                                   from public.assistant_messages m where m.conversation_id = c.id), '[]'))
    into v_out from public.assistant_conversations c where c.id = v_id;

  elsif p_tool = 'list_contacts' then
    v_q := public.search_text(public.mcp_text(a, 'q', 200));
    select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'phone', x.phone,
                                                 'phone_verified', x.phone_verified_at is not null, 'email', x.email,
                                                 'tags', to_jsonb(x.tags), 'source', x.source, 'updated_at', x.updated_at)
                              order by x.updated_at desc), '[]') into v_out
    from (select * from public.shop_contacts k
          where k.shop_id = v_shop
            and (v_q is null or v_q = '' or public.search_text(concat_ws(' ', k.name, k.phone, k.email, k.address, k.note,
                                                                         array_to_string(k.tags, ' '))) like '%' || v_q || '%')
            and (public.mcp_text(a, 'tag', 40) is null or public.mcp_text(a, 'tag', 40) = any (k.tags))
          order by k.updated_at desc
          limit public.mcp_int(a, 'limit', 50, 1, 200) offset public.mcp_int(a, 'offset', 0, 0, 100000)) x;

  elsif p_tool = 'get_contact' then
    select jsonb_build_object(
             'id', k.id, 'name', k.name, 'phone', k.phone, 'phone_verified', k.phone_verified_at is not null,
             'email', k.email, 'address', k.address, 'tags', to_jsonb(k.tags), 'note', k.note, 'source', k.source,
             'created_at', k.created_at, 'updated_at', k.updated_at,
             'conversations', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'started_at', c.started_at,
                                                                             'status', c.status) order by c.started_at desc)
                                        from public.assistant_conversations c where c.contact_id = k.id), '[]'),
             'bookings', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'starts_at', b.starts_at, 'status', b.status)
                                                    order by b.starts_at desc)
                                   from public.shop_bookings b where b.contact_id = k.id), '[]'),
             'messages', coalesce((select jsonb_agg(jsonb_build_object('channel', o.channel, 'subject', o.subject,
                                                                        'text', o.body, 'status', o.status,
                                                                        'at', o.created_at) order by o.created_at desc)
                                   from (select * from public.shop_outgoing_messages o2 where o2.contact_id = k.id
                                         order by o2.created_at desc limit 20) o), '[]'))
    into v_out from public.shop_contacts k where k.id = v_id;

  elsif p_tool = 'list_bookings' then
    select coalesce(jsonb_agg(to_jsonb(b) - 'total_count'), '[]') into v_out
    from public.owner_bookings(v_shop, public.mcp_date(a, 'from'), public.mcp_date(a, 'to'), public.mcp_text(a, 'status', 20),
                               public.mcp_int(a, 'limit', 50, 1, 200), public.mcp_int(a, 'offset', 0, 0, 100000)) b;

  elsif p_tool = 'list_email_templates' then
    select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'subject', t.subject, 'text', t.body)
                              order by lower(t.name)), '[]') into v_out
    from public.shop_email_templates t where t.shop_id = v_shop;

  elsif p_tool = 'get_sms_usage' then
    v_out := to_jsonb(public.owner_sms_usage(v_shop));

  elsif p_tool = 'search_stock' then
    select coalesce(jsonb_agg(jsonb_build_object('item_id', r.item_id, 'code', r.source_code, 'name', r.item_name,
                                                 'ean', r.ean, 'price', r.price, 'currency', r.currency,
                                                 'quantity', r.quantity, 'shopper_sees', r.availability,
                                                 'updated_at', r.updated_at)), '[]') into v_out
    from public.owner_items(v_shop, public.mcp_text(a, 'q', 200), public.mcp_int(a, 'limit', 25, 1, 100),
                            public.mcp_int(a, 'offset', 0, 0, 100000), coalesce(public.mcp_text(a, 'filter', 30), 'all')) r;
    v_out := jsonb_build_object('items', v_out, 'stock_source', public.stock_source_of(v_shop));

  elsif p_tool = 'update_conversations' then
    v_ids := array(select (jsonb_array_elements_text(coalesce(a -> 'conversation_ids', '[]'::jsonb)))::uuid);
    if cardinality(v_ids) = 0 or cardinality(v_ids) > 200 then raise exception 'bad_argument: conversation_ids' using errcode = '22023'; end if;
    if exists (select 1 from unnest(v_ids) i where not exists (select 1 from public.assistant_conversations c
                                                               where c.id = i and c.shop_id = v_shop)) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    if a ? 'action' then
      perform public.owner_conversations_mark(v_shop, v_ids, public.mcp_text(a, 'action', 20));
    end if;
    if a ? 'note' then
      if cardinality(v_ids) <> 1 then raise exception 'bad_argument: note' using errcode = '22023'; end if;
      perform public.owner_conversation_note(v_ids[1], public.mcp_text(a, 'note', 4000));
    end if;
    v_out := jsonb_build_object('updated', cardinality(v_ids));

  elsif p_tool = 'save_contact' then
    -- Only the fields given change; an existing contact keeps the rest.
    if v_id is not null then
      select to_jsonb(k) into v_row from public.shop_contacts k where k.id = v_id;
    else
      v_row := '{}'::jsonb;
    end if;
    v_id := public.owner_save_contact(
      v_shop, v_id,
      case when a ? 'name' then public.mcp_text(a, 'name', 200) else v_row ->> 'name' end,
      case when a ? 'phone' then public.mcp_text(a, 'phone', 40) else v_row ->> 'phone' end,
      case when a ? 'email' then public.mcp_text(a, 'email', 254) else v_row ->> 'email' end,
      case when a ? 'address' then public.mcp_text(a, 'address', 300) else v_row ->> 'address' end,
      case when a ? 'tags' then array(select left(jsonb_array_elements_text(a -> 'tags'), 40))
           else array(select jsonb_array_elements_text(coalesce(v_row -> 'tags', '[]'::jsonb))) end,
      case when a ? 'note' then public.mcp_text(a, 'note', 4000) else v_row ->> 'note' end,
      null);
    v_out := jsonb_build_object('contact_id', v_id);

  elsif p_tool = 'delete_contact' then
    if coalesce((a ->> 'confirm')::boolean, false) is not true then
      select jsonb_build_object('needs_confirmation', true,
                                'contact', jsonb_build_object('id', k.id, 'name', k.name, 'phone', k.phone, 'email', k.email),
                                'warning', 'Deleting removes the contact for good (conversations and bookings stay). Ask the owner, then call again with confirm: true.')
      into v_out from public.shop_contacts k where k.id = v_id;
    else
      perform public.owner_delete_contact(v_id);
      v_out := jsonb_build_object('deleted', true);
    end if;

  elsif p_tool = 'set_booking_status' then
    perform public.owner_set_booking_status(v_id, public.mcp_text(a, 'status', 20));
    v_out := jsonb_build_object('booking_id', v_id, 'status', a ->> 'status');

  elsif p_tool = 'set_opening_hours' then
    v_out := public.mcp_set_hours(v_shop, g.user_id, a -> 'regular', a -> 'special');
    v_changed := true;

  elsif p_tool = 'update_shop_details' then
    -- Only these fields; the rest of the shop is sent back to owner_save_shop as it is.
    v_patch := a - 'shop';
    if exists (select 1 from jsonb_object_keys(v_patch) k
               where k not in ('name', 'phone', 'email', 'website', 'facebook_url', 'booking_url')) then
      raise exception 'bad_argument: only name, phone, email, website, facebook_url, booking_url' using errcode = '22023';
    end if;
    if v_patch = '{}'::jsonb then raise exception 'empty' using errcode = '22023'; end if;
    select jsonb_build_object('id', s.id, 'name', s.name, 'ico', s.ico, 'address', s.address, 'city', s.city,
                              'country', s.country, 'timezone', s.timezone,
                              'lat', extensions.st_y(s.location::extensions.geometry),
                              'lng', extensions.st_x(s.location::extensions.geometry),
                              'phone', s.phone, 'website', s.website, 'email', s.email, 'facebook_url', s.facebook_url,
                              'booking_url', s.booking_url, 'opening_hours', s.opening_hours, 'is_active', s.is_active,
                              'has_toilet', s.has_toilet, 'has_douchette', s.has_douchette,
                              'has_card_terminal', s.has_card_terminal)
    into v_row from public.shops s where s.id = v_shop;
    select coalesce(jsonb_object_agg(k, case when jsonb_typeof(v) = 'string' then to_jsonb(left(v #>> '{}', 500)) else v end), '{}')
    into v_patch from jsonb_each(v_patch) as e(k, v);
    perform public.owner_save_shop(v_row || v_patch);
    insert into public.shop_activity (shop_id, actor, action, details)
    values (v_shop, g.user_id, 'shop_details_changed',
            jsonb_build_object('via', 'mcp', 'fields', (select jsonb_agg(k) from jsonb_object_keys(v_patch) k)));
    select jsonb_build_object('name', s.name, 'phone', s.phone, 'email', s.email, 'website', s.website,
                              'facebook_url', s.facebook_url, 'booking_url', s.booking_url)
    into v_out from public.shops s where s.id = v_shop;
    v_changed := true;

  elsif p_tool = 'update_stock' then
    -- One item by item_id or its code; quantity and/or price; the currency and the freshness never change.
    select i.id, i.source_code, i.name, inv.quantity, inv.price, inv.currency into v_item
    from public.shop_items i join public.inventory inv on inv.shop_item_id = i.id
    where i.shop_id = v_shop
      and (i.id::text = coalesce(a ->> 'item_id', '') or i.source_code = coalesce(a ->> 'code', ''))
    limit 1;
    if v_item.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
    v_qty := case when a ? 'quantity' and jsonb_typeof(a -> 'quantity') = 'number' then (a ->> 'quantity')::numeric end;
    v_price := case when a ? 'price' and jsonb_typeof(a -> 'price') = 'number' then (a ->> 'price')::numeric end;
    if (a ? 'quantity' and v_qty is null) or (a ? 'price' and v_price is null) or (v_qty is null and v_price is null)
       or abs(coalesce(v_qty, 0)) > 1000000000 or v_price < 0 or v_price > 1000000000 then
      raise exception 'bad_argument: quantity / price' using errcode = '22023';
    end if;
    v_out := jsonb_build_object(
      'item', jsonb_build_object('item_id', v_item.id, 'code', v_item.source_code, 'name', v_item.name,
                                 'currency', v_item.currency),
      'before', jsonb_build_object('quantity', v_item.quantity, 'price', v_item.price),
      'after', jsonb_build_object('quantity', coalesce(v_qty, v_item.quantity), 'price', coalesce(v_price, v_item.price)),
      'stock_source', public.stock_source_of(v_shop),
      'warning', case public.stock_source_of(v_shop)
                   when 'api' then 'The connected inventory program sends the whole stock again at its next sync and will overwrite this change.'
                   when 'agent' then 'The POS sync agent sends the whole stock again at its next sync and will overwrite this change.'
                   else 'The next stock file from the shop''s folder (or an uploaded file) replaces the whole stock and will overwrite this change. Change it in the stock program too.'
                 end);
    if coalesce((a ->> 'confirm')::boolean, false) is not true then
      v_out := v_out || jsonb_build_object('needs_confirmation', true);
    else
      update public.inventory set quantity = coalesce(v_qty, quantity), price = coalesce(v_price, price)
      where shop_item_id = v_item.id;
      insert into public.shop_activity (shop_id, actor, action, details)
      values (v_shop, g.user_id, 'stock_edited',
              jsonb_build_object('via', 'mcp', 'item_id', v_item.id, 'code', v_item.source_code,
                                 'before', v_out -> 'before', 'after', v_out -> 'after'));
      v_out := v_out || jsonb_build_object('applied', true);
      v_changed := true;
    end if;

  elsif p_tool = 'preview_message' then
    v_draft := public.owner_message_preview(v_id, public.mcp_text(a, 'channel', 10), public.mcp_uuid(a, 'template_id'),
                                            public.mcp_text(a, 'subject', 400), public.mcp_text(a, 'text', 12000));
    delete from public.owner_mcp_pending where expires_at < now() - interval '1 day';
    insert into public.owner_mcp_pending (token_id, shop_id, kind, args, draft_hash, expires_at)
    values (g.id, v_shop, 'message',
            jsonb_build_object('contact_id', v_id, 'channel', a ->> 'channel', 'template_id', a ->> 'template_id',
                               'subject', public.mcp_text(a, 'subject', 400), 'text', public.mcp_text(a, 'text', 12000)),
            public.mcp_hash(v_draft::text), now() + interval '10 minutes')
    returning id into v_pending;
    v_out := jsonb_build_object('preview', v_draft, 'confirmation_id', v_pending, 'expires_in_seconds', 600,
                                'sms_usage', case when a ->> 'channel' = 'sms' then to_jsonb(public.owner_sms_usage(v_shop)) end,
                                'next', 'Show this preview to the owner. Only after they approve it, call send_message with the confirmation_id.');
  end if;

  return jsonb_build_object('shop', v_slug, 'result', coalesce(v_out, 'null'::jsonb), 'changed', v_changed);
end;
$$;
revoke execute on function public.owner_mcp_call(text, text, jsonb) from public;
grant execute on function public.owner_mcp_call(text, text, jsonb) to anon, authenticated, service_role;

/**
 * send_message: the crm-messages function (service role) with the bearer token and a confirmation id from
 * preview_message. Once, within 10 minutes, the same grant, and only if the message still renders exactly as
 * previewed; then owner_message_queue as the owner (quota, 100 a day, log) — the function sends it.
 * Refusals: invalid_token, scope, confirmation, preview_changed, and owner_message_queue's own.
 */
create or replace function public.owner_mcp_message_queue(p_token text, p_confirmation uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  g public.owner_mcp_tokens%rowtype;
  p public.owner_mcp_pending%rowtype;
  v_draft jsonb;
  v_out jsonb;
begin
  g := public.mcp_grant(p_token);
  if not 'messages.send' = any (g.scopes) then raise exception 'scope: messages.send' using errcode = '42501'; end if;
  select * into p from public.owner_mcp_pending where id = p_confirmation and token_id = g.id and kind = 'message' for update;
  if not found or p.used_at is not null or p.expires_at < now() then raise exception 'confirmation' using errcode = '22023'; end if;
  update public.owner_mcp_pending set used_at = now() where id = p.id;
  perform public.mcp_shop(g, p.shop_id::text);
  perform public.mcp_act_as(g.user_id);
  v_draft := public.owner_message_preview((p.args ->> 'contact_id')::uuid, p.args ->> 'channel',
                                          nullif(p.args ->> 'template_id', '')::uuid, p.args ->> 'subject', p.args ->> 'text');
  if public.mcp_hash(v_draft::text) <> p.draft_hash then raise exception 'preview_changed' using errcode = '22023'; end if;
  v_out := public.owner_message_queue((p.args ->> 'contact_id')::uuid, p.args ->> 'channel',
                                      nullif(p.args ->> 'template_id', '')::uuid, p.args ->> 'subject', p.args ->> 'text');
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p.shop_id, g.user_id, 'mcp_message_queued',
          jsonb_build_object('via', 'mcp', 'grant_id', g.id, 'message_id', v_out ->> 'id', 'channel', p.args ->> 'channel'));
  return v_out;
end;
$$;
revoke execute on function public.owner_mcp_message_queue(text, uuid) from public, anon, authenticated;
grant execute on function public.owner_mcp_message_queue(text, uuid) to service_role;
