-- PPI · 23 · Cloud export of the assistant's conversations (paid plan). Paste the whole file into the Supabase SQL Editor and Run.
--  Needs update 22. When a conversation of the shop's assistant has ended and its PDF is
--  ready, the cloud-export Edge Function copies the PDF and the shopper's files into the
--  shop's own OneDrive or Dropbox folder:
--    <target>/<YYYY-MM>/<YYYY-MM-DD_HH-MM_id>/konverzacia.pdf and …/subory/<files>
--  The owner connects the cloud with OAuth; the tokens are encrypted by the function
--  (EXPORT_TOKEN_ENCRYPTION_KEY) and only the service role reads them. PPI never overwrites
--  or deletes anything in the shop's cloud. Every conversation shows Čaká / Uložené v cloude
--  / Chyba; failed copies are tried again (5 minutes, doubling, at most every 6 hours, 20
--  times); after 24 hours of failures the owners get one e-mail. A conversation the shopper
--  deletes after it was copied stays in the owner's list as "zákazník požiadal o vymazanie".
-- Safe to run again.

-- ------------------------------------------------------------------ tables

create table if not exists public.cloud_connections (
  shop_id           uuid primary key references public.shops (id) on delete cascade,
  provider          text not null check (provider in ('onedrive', 'dropbox')),
  account_name      text check (account_name is null or length(account_name) <= 200),
  account_email     text check (account_email is null or length(account_email) <= 320),
  -- the target folder in the cloud, e.g. /Cacadoo/Potraviny Centrum
  folder_path       text not null check (folder_path ~ '^/[^/]' and length(folder_path) <= 400),
  -- encrypted by the cloud-export function; never readable by owners or visitors
  access_token_enc  text not null,
  refresh_token_enc text not null,
  access_expires_at timestamptz,
  scope             text,
  -- the website the owner connected from (links in e-mails)
  site_url          text check (site_url is null or site_url ~ '^https?://'),
  status            text not null default 'ok' check (status in ('ok', 'expired', 'error')),
  last_error        text check (last_error is null or length(last_error) <= 500),
  connected_by      uuid,
  connected_at      timestamptz not null default now(),
  last_success_at   timestamptz,
  failing_since     timestamptz,
  alert_sent_at     timestamptz,
  updated_at        timestamptz not null default now()
);

-- One OAuth round trip: a random state (kept as SHA-256), the PKCE verifier, 10 minutes, single use.
create table if not exists public.cloud_oauth_states (
  state_hash  text primary key,
  shop_id     uuid not null references public.shops (id) on delete cascade,
  provider    text not null check (provider in ('onedrive', 'dropbox')),
  user_id     uuid not null,
  verifier    text not null,
  folder_path text not null,
  return_url  text not null check (return_url ~ '^https?://'),
  expires_at  timestamptz not null
);

-- What was copied already (so a retry never copies a file twice).
create table if not exists public.cloud_export_items (
  id              bigint generated always as identity primary key,
  conversation_id uuid not null references public.assistant_conversations (id) on delete cascade,
  shop_id         uuid not null references public.shops (id) on delete cascade,
  -- 'pdf' or the attachment's id
  item_key        text not null,
  remote_path     text not null,
  remote_id       text,
  bytes           integer,
  uploaded_at     timestamptz not null default now(),
  unique (conversation_id, item_key)
);

alter table public.assistant_conversations
  add column if not exists export_status text not null default 'none',
  add column if not exists export_error text,
  add column if not exists export_attempts integer not null default 0,
  add column if not exists export_next_try timestamptz,
  add column if not exists export_started_at timestamptz,
  add column if not exists exported_at timestamptz,
  add column if not exists export_path text,
  add column if not exists export_provider text,
  add column if not exists shopper_deleted_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'assistant_conversations_export_status_check') then
    alter table public.assistant_conversations add constraint assistant_conversations_export_status_check
      check (export_status in ('none', 'pending', 'running', 'done', 'failed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'assistant_conversations_export_error_check') then
    alter table public.assistant_conversations add constraint assistant_conversations_export_error_check
      check (export_error is null or length(export_error) <= 300);
  end if;
end;
$$;

create index if not exists assistant_conversations_export_idx on public.assistant_conversations (export_next_try)
  where export_status in ('pending', 'running', 'failed');

-- ------------------------------------------------------------------ access

alter table public.cloud_connections enable row level security;
alter table public.cloud_oauth_states enable row level security;
alter table public.cloud_export_items enable row level security;

revoke all on public.cloud_connections, public.cloud_oauth_states, public.cloud_export_items
  from public, anon, authenticated;
grant all on public.cloud_connections, public.cloud_oauth_states, public.cloud_export_items to service_role;
-- Owners see which cloud is connected and how it goes; never the tokens.
grant select (shop_id, provider, account_name, account_email, folder_path, status, last_error, connected_at,
              last_success_at, failing_since)
  on public.cloud_connections to authenticated;
grant select (conversation_id, shop_id, item_key, remote_path, bytes, uploaded_at) on public.cloud_export_items to authenticated;
grant select (export_status, export_error, export_attempts, export_next_try, exported_at, export_path, export_provider,
              shopper_deleted_at)
  on public.assistant_conversations to authenticated;

drop policy if exists "cloud_connections: members read" on public.cloud_connections;
create policy "cloud_connections: members read" on public.cloud_connections
  for select to authenticated using (public.is_shop_member(shop_id));
drop policy if exists "cloud_export_items: members read" on public.cloud_export_items;
create policy "cloud_export_items: members read" on public.cloud_export_items
  for select to authenticated using (public.is_shop_member(shop_id));

-- ------------------------------------------------------------------ OAuth (service role)

/** Stores one OAuth round trip (expired ones are cleared on the way). */
create or replace function public.cloud_state_save(
  p_state_hash text, p_shop_id uuid, p_provider text, p_user_id uuid, p_verifier text, p_folder text, p_return_url text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  delete from public.cloud_oauth_states where expires_at < now();
  insert into public.cloud_oauth_states (state_hash, shop_id, provider, user_id, verifier, folder_path, return_url, expires_at)
  values (p_state_hash, p_shop_id, p_provider, p_user_id, p_verifier, p_folder, p_return_url, now() + interval '10 minutes');
end;
$$;
revoke execute on function public.cloud_state_save(text, uuid, text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.cloud_state_save(text, uuid, text, uuid, text, text, text) to service_role;

/** Takes a state once: the row when it exists and has not expired, else null. */
create or replace function public.cloud_state_take(p_state_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.cloud_oauth_states%rowtype;
begin
  delete from public.cloud_oauth_states where state_hash = p_state_hash returning * into v_row;
  if not found or v_row.expires_at < now() then
    return null;
  end if;
  return jsonb_build_object('shop_id', v_row.shop_id, 'provider', v_row.provider, 'user_id', v_row.user_id,
                            'verifier', v_row.verifier, 'folder_path', v_row.folder_path, 'return_url', v_row.return_url);
end;
$$;
revoke execute on function public.cloud_state_take(text) from public, anon, authenticated;
grant execute on function public.cloud_state_take(text) to service_role;

-- ------------------------------------------------------------------ connections (service role)

/**
 * A new or renewed connection (one per shop; connecting another cloud replaces it). Copies
 * that failed are tried again at once.
 */
create or replace function public.cloud_connection_save(
  p_shop_id uuid, p_provider text, p_account_name text, p_account_email text, p_folder text,
  p_access_enc text, p_refresh_enc text, p_expires_at timestamptz, p_scope text, p_site_url text, p_user_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into public.cloud_connections (shop_id, provider, account_name, account_email, folder_path, access_token_enc,
                                        refresh_token_enc, access_expires_at, scope, site_url, connected_by)
  values (p_shop_id, p_provider, left(p_account_name, 200), left(p_account_email, 320), p_folder, p_access_enc,
          p_refresh_enc, p_expires_at, p_scope, p_site_url, p_user_id)
  on conflict (shop_id) do update
    set provider = excluded.provider, account_name = excluded.account_name, account_email = excluded.account_email,
        folder_path = excluded.folder_path, access_token_enc = excluded.access_token_enc,
        refresh_token_enc = excluded.refresh_token_enc, access_expires_at = excluded.access_expires_at,
        scope = excluded.scope, site_url = coalesce(excluded.site_url, public.cloud_connections.site_url),
        connected_by = excluded.connected_by, connected_at = now(), status = 'ok', last_error = null,
        failing_since = null, alert_sent_at = null, updated_at = now();
  update public.assistant_conversations
  set export_status = 'pending', export_next_try = now(), export_attempts = 0, export_error = null
  where shop_id = p_shop_id and export_status = 'failed' and shopper_deleted_at is null;
end;
$$;
revoke execute on function public.cloud_connection_save(uuid, text, text, text, text, text, text, timestamptz, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.cloud_connection_save(uuid, text, text, text, text, text, text, timestamptz, text, text, uuid)
  to service_role;

/** New tokens after a refresh. */
create or replace function public.cloud_connection_tokens(p_shop_id uuid, p_access_enc text, p_refresh_enc text, p_expires_at timestamptz)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.cloud_connections
  set access_token_enc = p_access_enc, refresh_token_enc = coalesce(p_refresh_enc, refresh_token_enc),
      access_expires_at = p_expires_at, updated_at = now()
  where shop_id = p_shop_id
$$;
revoke execute on function public.cloud_connection_tokens(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.cloud_connection_tokens(uuid, text, text, timestamptz) to service_role;

/** How the last copy went: ok, or the error (expired = the owner must connect again). */
create or replace function public.cloud_connection_result(p_shop_id uuid, p_error text, p_expired boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_error is null then
    update public.cloud_connections
    set status = 'ok', last_error = null, last_success_at = now(), failing_since = null, alert_sent_at = null,
        updated_at = now()
    where shop_id = p_shop_id;
  else
    update public.cloud_connections
    set status = case when coalesce(p_expired, false) then 'expired' else 'error' end,
        last_error = left(p_error, 500), failing_since = coalesce(failing_since, now()), updated_at = now()
    where shop_id = p_shop_id;
  end if;
end;
$$;
revoke execute on function public.cloud_connection_result(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.cloud_connection_result(uuid, text, boolean) to service_role;

/** The target folder the owner chose (the function has made sure it exists). */
create or replace function public.cloud_set_folder(p_shop_id uuid, p_folder text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.cloud_connections set folder_path = p_folder, updated_at = now() where shop_id = p_shop_id
$$;
revoke execute on function public.cloud_set_folder(uuid, text) from public, anon, authenticated;
grant execute on function public.cloud_set_folder(uuid, text) to service_role;

/** "Odpojiť": the tokens are deleted; copies still waiting are not made. */
create or replace function public.cloud_disconnect(p_shop_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  delete from public.cloud_connections where shop_id = p_shop_id;
  if not found then
    return false;
  end if;
  update public.assistant_conversations
  set export_status = 'none', export_next_try = null, export_error = null
  where shop_id = p_shop_id and export_status in ('pending', 'running', 'failed');
  return true;
end;
$$;
revoke execute on function public.cloud_disconnect(uuid) from public, anon, authenticated;
grant execute on function public.cloud_disconnect(uuid) to service_role;

-- ------------------------------------------------------------------ the copies (service role)

/** Marks a conversation to be copied now, when its shop has a cloud and it was not deleted. */
create or replace function public.cloud_export_enqueue(p_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.assistant_conversations c
  set export_status = 'pending', export_next_try = now(), export_attempts = 0, export_error = null
  where c.id = p_id and c.shopper_deleted_at is null and c.pdf_status = 'ready'
    and c.export_status in ('none', 'failed')
    and exists (select 1 from public.cloud_connections k where k.shop_id = c.shop_id);
  return found;
end;
$$;
revoke execute on function public.cloud_export_enqueue(uuid) from public, anon, authenticated;
grant execute on function public.cloud_export_enqueue(uuid) to service_role;

/**
 * Conversations to copy now (due, PDF ready, not deleted, the shop's cloud not expired),
 * marked running; a copy stuck running for 15 minutes is taken again. p_id: only that one.
 */
create or replace function public.cloud_export_claim(p_limit integer default 3, p_id uuid default null)
returns setof uuid
language sql
volatile
security definer
set search_path = ''
as $$
  with picked as (
    select c.id
    from public.assistant_conversations c
    join public.cloud_connections k on k.shop_id = c.shop_id and k.status <> 'expired'
    where (p_id is null or c.id = p_id)
      and c.pdf_status = 'ready' and c.shopper_deleted_at is null
      and ((c.export_status in ('pending', 'failed') and c.export_next_try is not null and c.export_next_try <= now())
           or (c.export_status = 'running' and c.export_started_at < now() - interval '15 minutes'))
    order by c.export_next_try nulls first, c.id
    limit least(greatest(coalesce(p_limit, 3), 1), 20)
    for update of c skip locked
  )
  update public.assistant_conversations c
  set export_status = 'running', export_started_at = now()
  from picked
  where c.id = picked.id
  returning c.id
$$;
revoke execute on function public.cloud_export_claim(integer, uuid) from public, anon, authenticated;
grant execute on function public.cloud_export_claim(integer, uuid) to service_role;

/** Everything one copy needs: the conversation, its shop, the connection (encrypted tokens), files, what is copied already. */
create or replace function public.cloud_export_data(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'conversation', jsonb_build_object('id', c.id, 'shop_id', c.shop_id, 'started_at', c.started_at,
                                       'pdf_path', c.pdf_path, 'pdf_name', c.pdf_name,
                                       'deleted', c.shopper_deleted_at is not null),
    'shop', jsonb_build_object('name', s.name, 'timezone', s.timezone),
    'connection', jsonb_build_object('provider', k.provider, 'folder_path', k.folder_path,
                                     'access_token_enc', k.access_token_enc, 'refresh_token_enc', k.refresh_token_enc,
                                     'access_expires_at', k.access_expires_at, 'status', k.status),
    'attachments', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'kind', a.kind, 'bytes', a.bytes,
                                          'path', a.storage_path) order by a.created_at, a.id)
      from public.assistant_attachments a where a.conversation_id = c.id), '[]'::jsonb),
    'done', coalesce((
      select jsonb_object_agg(i.item_key, i.remote_path)
      from public.cloud_export_items i where i.conversation_id = c.id), '{}'::jsonb))
  from public.assistant_conversations c
  join public.shops s on s.id = c.shop_id
  left join public.cloud_connections k on k.shop_id = c.shop_id
  where c.id = p_id
$$;
revoke execute on function public.cloud_export_data(uuid) from public, anon, authenticated;
grant execute on function public.cloud_export_data(uuid) to service_role;

/** One file copied (kept once, so a retry skips it). */
create or replace function public.cloud_export_item_done(
  p_id uuid, p_key text, p_remote_path text, p_remote_id text, p_bytes integer
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.cloud_export_items (conversation_id, shop_id, item_key, remote_path, remote_id, bytes)
  select c.id, c.shop_id, p_key, p_remote_path, p_remote_id, p_bytes
  from public.assistant_conversations c where c.id = p_id
  on conflict (conversation_id, item_key) do nothing
$$;
revoke execute on function public.cloud_export_item_done(uuid, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.cloud_export_item_done(uuid, text, text, text, integer) to service_role;

/**
 * The copy is done (p_error null: its folder in the cloud) or failed: tried again 5, 10,
 * 20 … minutes later, at most every 6 hours, 20 times (p_retry false: not again by itself).
 */
drop function if exists public.cloud_export_finish(uuid, text, text, boolean);
create or replace function public.cloud_export_finish(
  p_id uuid, p_path text, p_error text, p_retry boolean default true, p_retry_after integer default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_error is null then
    update public.assistant_conversations c
    set export_status = 'done', exported_at = now(), export_path = p_path, export_error = null, export_next_try = null,
        export_started_at = null,
        export_provider = (select k.provider from public.cloud_connections k where k.shop_id = c.shop_id)
    where c.id = p_id;
  else
    update public.assistant_conversations
    set export_status = 'failed', export_error = left(p_error, 300), export_attempts = export_attempts + 1,
        export_started_at = null,
        -- 5 minutes, doubling, at most every 6 hours; never sooner than a busy cloud's Retry-After
        export_next_try = case
          when coalesce(p_retry, true) and export_attempts + 1 < 20
            then now() + greatest(least(interval '5 minutes' * power(2, least(export_attempts, 10)), interval '6 hours'),
                                  make_interval(secs => least(greatest(coalesce(p_retry_after, 0), 0), 21600)))
          end
    where id = p_id and export_status <> 'none';
  end if;
end;
$$;
revoke execute on function public.cloud_export_finish(uuid, text, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.cloud_export_finish(uuid, text, text, boolean, integer) to service_role;

/** Shops whose copies have failed for 24 hours and whose owners were not told yet: names and e-mails. */
drop function if exists public.cloud_alerts_due();
create function public.cloud_alerts_due()
returns table (shop_id uuid, shop_name text, shop_slug text, timezone text, provider text, last_error text,
               failing_since timestamptz, site_url text, emails text[])
language sql
stable
security definer
set search_path = ''
as $$
  select k.shop_id, s.name, s.slug, s.timezone, k.provider, k.last_error, k.failing_since, k.site_url,
         coalesce((select array_agg(u.email::text order by u.email) from public.shop_members m
                   join auth.users u on u.id = m.user_id
                   where m.shop_id = k.shop_id and u.email is not null), '{}')
  from public.cloud_connections k
  join public.shops s on s.id = k.shop_id
  where k.failing_since is not null and k.failing_since <= now() - interval '24 hours'
    and (k.alert_sent_at is null or k.alert_sent_at < k.failing_since)
$$;
revoke execute on function public.cloud_alerts_due() from public, anon, authenticated;
grant execute on function public.cloud_alerts_due() to service_role;

create or replace function public.cloud_alert_sent(p_shop_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.cloud_connections set alert_sent_at = now() where shop_id = p_shop_id
$$;
revoke execute on function public.cloud_alert_sent(uuid) from public, anon, authenticated;
grant execute on function public.cloud_alert_sent(uuid) to service_role;

-- ------------------------------------------------------------------ the shopper's "Vymazať moju konverzáciu"

/**
 * Forgets a conversation the shopper deleted (its stored files were deleted first). When it
 * was copied to the cloud already, a stub stays for the owners ("zákazník požiadal o
 * vymazanie", with the folder in the cloud) without any message or file. Returns
 * 'deleted' or 'kept_for_owner'.
 */
create or replace function public.assistant_shopper_forget(p_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_conv public.assistant_conversations%rowtype;
begin
  select * into v_conv from public.assistant_conversations where id = p_id for update;
  if not found then
    return 'deleted';
  end if;
  if not exists (select 1 from public.cloud_export_items i where i.conversation_id = p_id)
     and v_conv.export_status <> 'running' and v_conv.export_path is null then
    delete from public.assistant_conversations where id = p_id;
    return 'deleted';
  end if;
  delete from public.assistant_messages where conversation_id = p_id;
  delete from public.assistant_attachments where conversation_id = p_id;
  update public.assistant_conversations
  set shopper_deleted_at = now(), first_question = null, message_count = 0, attachment_count = 0,
      pdf_path = null, pdf_status = 'none', pdf_next_try = null, ended_at = coalesce(ended_at, now()),
      end_reason = coalesce(end_reason, 'closed'),
      export_path = coalesce(export_path,
        (select regexp_replace(i.remote_path, '/[^/]+$', '') from public.cloud_export_items i
         where i.conversation_id = p_id and i.item_key = 'pdf')),
      export_status = case when export_status = 'done' then 'done' else 'none' end,
      export_next_try = null
  where id = p_id;
  return 'kept_for_owner';
end;
$$;
revoke execute on function public.assistant_shopper_forget(uuid) from public, anon, authenticated;
grant execute on function public.assistant_shopper_forget(uuid) to service_role;

/** As in update 22 (ended conversations without a message are forgotten), but never the stubs above. */
create or replace function public.assistant_empty_ended(p_limit integer default 50)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from public.assistant_conversations
  where ended_at is not null and message_count = 0 and shopper_deleted_at is null
  order by ended_at
  limit least(greatest(coalesce(p_limit, 50), 1), 500)
$$;
revoke execute on function public.assistant_empty_ended(integer) from public, anon, authenticated;
grant execute on function public.assistant_empty_ended(integer) to service_role;

-- ------------------------------------------------------------------ the PDF is ready → copy it

/**
 * As in update 22, and a ready PDF is queued for the shop's cloud; returns true when it was
 * queued (the archive then asks cloud-export to copy it at once).
 */
drop function if exists public.assistant_pdf_done(uuid, text, text, text);
create function public.assistant_pdf_done(p_id uuid, p_path text, p_name text, p_error text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_error is null then
    update public.assistant_conversations
    set pdf_status = 'ready', pdf_path = p_path, pdf_name = p_name, pdf_error = null, pdf_next_try = null
    where id = p_id;
    return public.cloud_export_enqueue(p_id);
  else
    update public.assistant_conversations
    set pdf_attempts = pdf_attempts + 1,
        pdf_error = left(p_error, 500),
        pdf_status = case when pdf_attempts + 1 >= 3 then 'failed' else 'none' end,
        pdf_next_try = now() + make_interval(mins => 10 * (pdf_attempts + 1))
    where id = p_id;
    return false;
  end if;
end;
$$;
revoke execute on function public.assistant_pdf_done(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.assistant_pdf_done(uuid, text, text, text) to service_role;

-- ------------------------------------------------------------------ owners

/**
 * "Uložiť znova": copy this conversation now (members of its shop; the shop needs a cloud).
 * What was copied before is checked again in the cloud: files still there (same size and
 * content) are not sent twice, missing ones are sent again, into the folder chosen now.
 */
create or replace function public.owner_cloud_retry(p_conversation_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
begin
  select shop_id into v_shop from public.assistant_conversations where id = p_conversation_id;
  if v_shop is null or not public.is_shop_member(v_shop) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if not exists (select 1 from public.cloud_connections where shop_id = v_shop) then
    raise exception 'no_cloud' using errcode = 'P0001';
  end if;
  update public.assistant_conversations
  set export_status = 'pending', export_next_try = now(), export_attempts = 0, export_error = null
  where id = p_conversation_id and shopper_deleted_at is null and pdf_status = 'ready' and export_status <> 'running';
  if not found then
    return false;
  end if;
  delete from public.cloud_export_items where conversation_id = p_conversation_id;
  return true;
end;
$$;
revoke execute on function public.owner_cloud_retry(uuid) from public, anon;
grant execute on function public.owner_cloud_retry(uuid) to authenticated, service_role;

/**
 * "Uložiť staršie konverzácie": every ended conversation of the period (days in the shop's
 * time zone) that is not in the cloud yet is copied; returns how many.
 */
create or replace function public.owner_cloud_backfill(p_shop_id uuid, p_from date, p_to date)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_count integer;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if not exists (select 1 from public.cloud_connections where shop_id = p_shop_id) then
    raise exception 'no_cloud' using errcode = 'P0001';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'period' using errcode = '22023';
  end if;
  select timezone into v_tz from public.shops where id = p_shop_id;
  update public.assistant_conversations
  set export_status = 'pending', export_next_try = now(), export_attempts = 0, export_error = null
  where shop_id = p_shop_id and pdf_status = 'ready' and shopper_deleted_at is null
    and export_status in ('none', 'failed')
    and started_at >= (p_from::timestamp at time zone v_tz)
    and started_at < ((p_to + 1)::timestamp at time zone v_tz);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function public.owner_cloud_backfill(uuid, date, date) from public, anon;
grant execute on function public.owner_cloud_backfill(uuid, date, date) to authenticated, service_role;

/** The owner's list (update 22) with each conversation's copy status and the shopper's deletions. */
drop function if exists public.owner_assistant_conversations(uuid, text, date, date, integer, integer);
create function public.owner_assistant_conversations(
  p_shop_id uuid,
  p_q text default null,
  p_from date default null,
  p_to date default null,
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  id uuid,
  started_at timestamptz,
  ended_at timestamptz,
  page_lang text,
  shopper_lang text,
  message_count integer,
  attachment_count integer,
  first_question text,
  pdf_status text,
  export_status text,
  export_error text,
  export_path text,
  shopper_deleted_at timestamptz,
  total_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with shop as (
    select s.id, s.timezone from public.shops s
    where s.id = owner_assistant_conversations.p_shop_id and public.is_shop_member(s.id)
  )
  select c.id, c.started_at, c.ended_at, c.page_lang, c.shopper_lang, c.message_count, c.attachment_count,
         c.first_question, c.pdf_status, c.export_status, c.export_error, c.export_path, c.shopper_deleted_at,
         count(*) over ()
  from public.assistant_conversations c
  join shop on shop.id = c.shop_id
  where (c.message_count > 0 or c.shopper_deleted_at is not null)
    and (owner_assistant_conversations.p_from is null
         or c.started_at >= (owner_assistant_conversations.p_from::timestamp at time zone shop.timezone))
    and (owner_assistant_conversations.p_to is null
         or c.started_at < ((owner_assistant_conversations.p_to + 1)::timestamp at time zone shop.timezone))
    and (nullif(btrim(coalesce(owner_assistant_conversations.p_q, '')), '') is null
         or public.matches_all_words(public.search_text(
              (select string_agg(m.body || ' ' || coalesce(m.body_owner, ''), ' ')
               from public.assistant_messages m where m.conversation_id = c.id)),
            owner_assistant_conversations.p_q))
  order by c.started_at desc, c.id
  limit least(greatest(coalesce(owner_assistant_conversations.p_limit, 20), 1), 100)
  offset greatest(coalesce(owner_assistant_conversations.p_offset, 0), 0)
$$;
revoke execute on function public.owner_assistant_conversations(uuid, text, date, date, integer, integer) from public, anon;
grant execute on function public.owner_assistant_conversations(uuid, text, date, date, integer, integer)
  to authenticated, service_role;

-- ------------------------------------------------------------------ the job (pg_cron + pg_net)

-- Every 5 minutes (2 minutes after the archive's tick): copies that are due, token refresh,
-- the 24-hour e-mail. Uses the Vault secrets ppi_project_url and ppi_assistant_cron (update 22).
do $$
declare
  v_call text := $call$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_project_url') || '/functions/v1/cloud-export',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'x-ppi-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_assistant_cron')),
      body := jsonb_build_object('action', 'tick'),
      timeout_milliseconds := 120000)$call$;
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'cron' and p.proname = 'schedule') then
    raise notice 'pg_cron is not on: switch on pg_cron and pg_net (Database → Extensions), then run this file again.';
    return;
  end if;
  perform cron.schedule('ppi-cloud-export-tick', '2-59/5 * * * *', v_call);
end;
$$;
