-- =====================================================================================================================
-- Update 50: the Cacaduu Cloud Connection for the POS Sync Agent, phase A — pairing, devices, heartbeat.
--
-- The POS Sync Agent is an optional desktop app (its own repository) that reads stock from a POS and sends it to
-- Cacaduu. This is the cloud side: a shop owner creates a one-time pairing code in Môj obchod, types it into the app,
-- the app calls the Edge Function "connector" (POST /v1/pair) and gets a device token for that ONE shop. From then
-- on the agent sends heartbeats; the dashboard shows the device Online / Offline / Chyba from their times (never a
-- stored "connected" flag). Codes and tokens are kept only as SHA-256 hashes; nobody (owner, visitor) can read a hash.
-- Only the function (service role) pairs, authenticates and records heartbeats; owners create codes, rename and
-- revoke through owner_connector_* (membership checked here). Stock uploads (phase B) and Sync Now (phase C) come
-- in later updates. Paste this whole file into the Supabase SQL Editor once; safe to run again.
-- =====================================================================================================================

-- ------------------------------------------------------------------ 1. tables

create table if not exists public.connector_devices (
  id                uuid primary key default gen_random_uuid(),
  shop_id           uuid not null references public.shops (id) on delete cascade,
  name              text not null check (length(name) between 1 and 80),
  -- SHA-256 (hex) of the device token; never granted to anyone but the service role
  token_hash        text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  -- rotation: the new token's hash until the agent first uses it (then it replaces token_hash); 24 h at most
  next_token_hash   text unique check (next_token_hash is null or next_token_hash ~ '^[0-9a-f]{64}$'),
  next_token_at     timestamptz,
  agent_version     text check (agent_version is null or length(agent_version) <= 40),
  os                text check (os is null or length(os) <= 80),
  -- e.g. "POHODA XML": only a label, never a POS setting or password
  source_label      text check (source_label is null or length(source_label) <= 80),
  last_read_result  text check (last_read_result is null or last_read_result in ('ok', 'unchanged', 'error', 'none')),
  last_error        text check (last_error is null or length(last_error) <= 500),
  paired_at         timestamptz not null default now(),
  paired_by         uuid references auth.users (id) on delete set null,
  last_seen_at      timestamptz,
  -- filled in by phase B (the last snapshot applied from this device)
  last_sync_at      timestamptz,
  revoked_at        timestamptz
);
create index if not exists connector_devices_shop_idx on public.connector_devices (shop_id) where revoked_at is null;

create table if not exists public.connector_pairing_codes (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops (id) on delete cascade,
  code_hash   text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  device_id   uuid references public.connector_devices (id) on delete set null
);
create index if not exists connector_pairing_codes_shop_idx on public.connector_pairing_codes (shop_id, created_at desc);

-- Rate limits of the device API (wrong pairing codes per caller, heartbeats per device, rotations per device).
-- The key is a daily-salted hash of the caller's IP or a device id: never an IP address.
create table if not exists public.connector_hits (
  id    bigint generated always as identity primary key,
  key   text not null check (length(key) between 8 and 128),
  kind  text not null check (kind in ('pair_fail', 'heartbeat', 'rotate', 'status')),
  at    timestamptz not null default now()
);
create index if not exists connector_hits_key_idx on public.connector_hits (key, kind, at desc);

alter table public.connector_devices enable row level security;
alter table public.connector_pairing_codes enable row level security;
alter table public.connector_hits enable row level security;
revoke all on public.connector_devices from public, anon, authenticated;
revoke all on public.connector_pairing_codes from public, anon, authenticated;
revoke all on public.connector_hits from public, anon, authenticated;
-- owners may read their shops' devices, but never the hash columns (the dashboard uses owner_connector_devices())
grant select (id, shop_id, name, agent_version, os, source_label, last_read_result, last_error, paired_at, last_seen_at,
              last_sync_at, revoked_at)
  on public.connector_devices to authenticated;
grant all on public.connector_devices, public.connector_pairing_codes, public.connector_hits to service_role;
drop policy if exists "connector_devices: members read" on public.connector_devices;
create policy "connector_devices: members read" on public.connector_devices
  for select to authenticated using (public.is_shop_member(shop_id));

alter table public.shop_activity drop constraint if exists shop_activity_action_check;
alter table public.shop_activity add constraint shop_activity_action_check
  check (action in ('stock_files_deleted', 'inventory_missing_removed', 'inventory_reset', 'inventory_restored',
                    'inventory_purged', 'export_review', 'export_edits', 'export_files_deleted',
                    'inventory_api_connected', 'inventory_api_key_changed', 'inventory_api_approved',
                    'inventory_api_error', 'inventory_api_recovered', 'inventory_api_disconnected',
                    'connector_paired', 'connector_revoked'));

-- ------------------------------------------------------------------ 2. small rules

-- A text from the agent as plain text: no control characters, trimmed, cut to a length; empty = NULL.
create or replace function public.connector_text(p_text text, p_max integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(left(btrim(regexp_replace(coalesce(p_text, ''), '[[:cntrl:]]+', ' ', 'g')), p_max), '')
$$;

-- What the dashboard shows, worked out from the times (never stored): revoked / offline (no heartbeat in the last
-- 3 minutes) / error (the last local read failed) / never_synced (online, no snapshot applied yet) / online.
-- Phase C adds "syncing" while a Sync Now runs.
create or replace function public.connector_device_state(p_last_seen timestamptz, p_revoked timestamptz,
                                                         p_result text, p_last_sync timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_revoked is not null then 'revoked'
    when p_last_seen is null or p_last_seen < now() - interval '3 minutes' then 'offline'
    when p_result = 'error' then 'error'
    when p_last_sync is null then 'never_synced'
    else 'online'
  end
$$;

-- One rate-limit step: true while fewer than p_limit hits of this kind and key happened in the window. With
-- p_record the hit is counted. Old hits are forgotten now and then.
create or replace function public.connector_hit(p_key text, p_kind text, p_limit integer, p_window interval,
                                                p_record boolean default true)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recent integer;
begin
  select count(*) into v_recent from public.connector_hits
  where key = p_key and kind = p_kind and at > now() - p_window;
  if p_record then
    insert into public.connector_hits (key, kind) values (p_key, p_kind);
  end if;
  if random() < 0.02 then
    delete from public.connector_hits where at < now() - interval '1 day';
  end if;
  return v_recent < p_limit;
end;
$$;
revoke execute on function public.connector_hit(text, text, integer, interval, boolean) from public, anon, authenticated;
grant execute on function public.connector_hit(text, text, integer, interval, boolean) to service_role;

-- ------------------------------------------------------------------ 3. what the owner does

-- "Pridať POS agenta": a one-time code for this shop, 8 characters from an alphabet without look-alikes (no 0/O,
-- 1/I/L), valid 10 minutes, kept only as a hash; returned once ("ABCD-EFGH"). At most 10 codes an hour per shop.
create or replace function public.owner_connector_create_code(p_shop_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_bytes bytea;
  v_code text;
  v_expires timestamptz := now() + interval '10 minutes';
  i integer;
  b integer;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  if (select count(*) from public.connector_pairing_codes
      where shop_id = p_shop_id and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'too_many' using errcode = '54000';
  end if;
  loop
    v_code := '';
    -- 31 letters; bytes ≥ 248 are skipped so every letter is equally likely. The random bytes come from
    -- gen_random_uuid() (a strong random source in core Postgres); its two fixed version/variant bytes are skipped.
    while length(v_code) < 8 loop
      v_bytes := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
      for i in 0 .. 15 loop
        b := get_byte(v_bytes, i);
        if i not in (6, 8) and b < 248 and length(v_code) < 8 then
          v_code := v_code || substr(c_alphabet, (b % 31) + 1, 1);
        end if;
      end loop;
    end loop;
    exit when not exists (select 1 from public.connector_pairing_codes
                          where code_hash = encode(sha256(convert_to(v_code, 'UTF8')), 'hex'));
  end loop;
  insert into public.connector_pairing_codes (shop_id, code_hash, created_by, expires_at)
  values (p_shop_id, encode(sha256(convert_to(v_code, 'UTF8')), 'hex'), auth.uid(), v_expires);
  -- forget codes nobody used, a day after they ran out
  delete from public.connector_pairing_codes where used_at is null and expires_at < now() - interval '1 day';
  return jsonb_build_object('code', substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4), 'expires_at', v_expires);
end;
$$;
revoke execute on function public.owner_connector_create_code(uuid) from public, anon;
grant execute on function public.owner_connector_create_code(uuid) to authenticated;

-- The devices of a shop for the dashboard (no hashes), newest first, with the state worked out from the times.
create or replace function public.owner_connector_devices(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'devices', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', d.id, 'name', d.name, 'agent_version', d.agent_version, 'os', d.os, 'source_label', d.source_label,
        'last_read_result', d.last_read_result, 'last_error', d.last_error, 'paired_at', d.paired_at,
        'last_seen_at', d.last_seen_at, 'last_sync_at', d.last_sync_at,
        'state', public.connector_device_state(d.last_seen_at, d.revoked_at, d.last_read_result, d.last_sync_at))
        order by d.paired_at desc), '[]'::jsonb)
      from public.connector_devices d where d.shop_id = p_shop_id and d.revoked_at is null),
    'open_code_until', (select max(c.expires_at) from public.connector_pairing_codes c
                        where c.shop_id = p_shop_id and c.used_at is null and c.expires_at > now()));
end;
$$;
revoke execute on function public.owner_connector_devices(uuid) from public, anon;
grant execute on function public.owner_connector_devices(uuid) to authenticated;

create or replace function public.owner_connector_rename(p_device_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
  v_name text := public.connector_text(p_name, 80);
begin
  select shop_id into v_shop from public.connector_devices where id = p_device_id and revoked_at is null;
  if v_shop is null or not public.is_shop_member(v_shop) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  if v_name is null then
    raise exception 'name' using errcode = '22023';
  end if;
  update public.connector_devices set name = v_name where id = p_device_id;
end;
$$;
revoke execute on function public.owner_connector_rename(uuid, text) from public, anon;
grant execute on function public.owner_connector_rename(uuid, text) to authenticated;

-- "Odpojiť": at once; the next call with that token gets 401. The row stays (without a usable token) for the log.
create or replace function public.owner_connector_revoke(p_device_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.connector_devices;
begin
  select * into v_device from public.connector_devices where id = p_device_id and revoked_at is null for update;
  if v_device.id is null or not public.is_shop_member(v_device.shop_id) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  update public.connector_devices set revoked_at = now(), next_token_hash = null, next_token_at = null
  where id = p_device_id;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (v_device.shop_id, auth.uid(), 'connector_revoked', jsonb_build_object('device', v_device.name));
end;
$$;
revoke execute on function public.owner_connector_revoke(uuid) from public, anon;
grant execute on function public.owner_connector_revoke(uuid) to authenticated;

-- ------------------------------------------------------------------ 4. what the function does (service role only)

-- POST /v1/pair: the code's hash, the caller's hash (rate limit), the device's name, version and system, and the
-- hash of the token the function made. 5 wrong codes in 15 minutes per caller → locked (even a right code) until
-- the window passes. Expired, used and unknown codes are all just 'invalid'.
create or replace function public.connector_pair(p_code_hash text, p_caller text, p_name text, p_version text,
                                                 p_os text, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code public.connector_pairing_codes;
  v_device uuid;
  v_shop public.shops;
begin
  if not public.connector_hit(p_caller, 'pair_fail', 5, interval '15 minutes', false) then
    return jsonb_build_object('status', 'locked', 'retry_after', 900);
  end if;
  select * into v_code from public.connector_pairing_codes
  where code_hash = p_code_hash and used_at is null and expires_at > now() for update;
  if v_code.id is null then
    perform public.connector_hit(p_caller, 'pair_fail', 5, interval '15 minutes', true);
    return jsonb_build_object('status', 'invalid');
  end if;
  insert into public.connector_devices (shop_id, name, token_hash, agent_version, os, paired_by)
  values (v_code.shop_id, coalesce(public.connector_text(p_name, 80), 'POS agent'), p_token_hash,
          public.connector_text(p_version, 40), public.connector_text(p_os, 80), v_code.created_by)
  returning id into v_device;
  update public.connector_pairing_codes set used_at = now(), device_id = v_device where id = v_code.id;
  select * into v_shop from public.shops where id = v_code.shop_id;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (v_code.shop_id, v_code.created_by, 'connector_paired',
          jsonb_build_object('device', coalesce(public.connector_text(p_name, 80), 'POS agent')));
  return jsonb_build_object('status', 'ok', 'device_id', v_device, 'shop_id', v_shop.id, 'shop_name', v_shop.name);
end;
$$;
revoke execute on function public.connector_pair(text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.connector_pair(text, text, text, text, text, text) to service_role;

-- Which device a token belongs to (and so which ONE shop). Rotation: the new token works at once and, when first
-- used, replaces the old one; the old one keeps working until then, at most 24 hours. Revoked → nothing.
create or replace function public.connector_auth(p_token_hash text)
returns table (device_id uuid, shop_id uuid, shop_name text, shop_slug text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_device public.connector_devices;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;
  select * into v_device from public.connector_devices d
  where d.revoked_at is null and (d.token_hash = p_token_hash or d.next_token_hash = p_token_hash);
  if v_device.id is null then
    return;
  end if;
  if v_device.next_token_hash = p_token_hash then
    -- the new token is used: the old one stops working now
    update public.connector_devices set token_hash = next_token_hash, next_token_hash = null, next_token_at = null
    where id = v_device.id;
  elsif v_device.next_token_hash is not null and v_device.next_token_at < now() - interval '24 hours' then
    -- the old token, more than 24 hours after a rotation: no longer valid; the new one takes its place
    update public.connector_devices set token_hash = next_token_hash, next_token_hash = null, next_token_at = null
    where id = v_device.id;
    return;
  end if;
  return query select v_device.id, s.id, s.name, s.slug from public.shops s where s.id = v_device.shop_id;
end;
$$;
revoke execute on function public.connector_auth(text) from public, anon, authenticated;
grant execute on function public.connector_auth(text) to service_role;

-- POST /v1/heartbeat: at most 4 a minute per device. Stores only labels and a short plain-text error.
create or replace function public.connector_heartbeat(p_device_id uuid, p_version text, p_os text, p_label text,
                                                      p_result text, p_error text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.connector_devices;
begin
  select * into v_device from public.connector_devices where id = p_device_id and revoked_at is null;
  if v_device.id is null then
    return jsonb_build_object('status', 'revoked');
  end if;
  if not public.connector_hit(p_device_id::text, 'heartbeat', 4, interval '1 minute') then
    return jsonb_build_object('status', 'too_many', 'retry_after', 60);
  end if;
  update public.connector_devices set
    last_seen_at = now(),
    agent_version = coalesce(public.connector_text(p_version, 40), agent_version),
    os = coalesce(public.connector_text(p_os, 80), os),
    source_label = public.connector_text(p_label, 80),
    last_read_result = case when p_result in ('ok', 'unchanged', 'error', 'none') then p_result end,
    last_error = public.connector_text(p_error, 500)
  where id = p_device_id;
  return jsonb_build_object('status', 'ok', 'shop_name', (select name from public.shops where id = v_device.shop_id));
end;
$$;
revoke execute on function public.connector_heartbeat(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.connector_heartbeat(uuid, text, text, text, text, text) to service_role;

-- POST /v1/credentials/rotate: keeps the new token's hash; at most 5 rotations an hour per device.
create or replace function public.connector_rotate(p_device_id uuid, p_new_hash text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_new_hash is null or p_new_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'token' using errcode = '22023';
  end if;
  if not public.connector_hit(p_device_id::text, 'rotate', 5, interval '1 hour') then
    return 'too_many';
  end if;
  update public.connector_devices set next_token_hash = p_new_hash, next_token_at = now()
  where id = p_device_id and revoked_at is null;
  return case when found then 'ok' else 'revoked' end;
end;
$$;
revoke execute on function public.connector_rotate(uuid, text) from public, anon, authenticated;
grant execute on function public.connector_rotate(uuid, text) to service_role;

-- GET /v1/status: the device's shop, its state and the latest sync summary (phase B fills last_sync).
create or replace function public.connector_status(p_device_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'shop', jsonb_build_object('name', s.name, 'slug', s.slug),
    'device', jsonb_build_object('id', d.id, 'name', d.name, 'paired_at', d.paired_at, 'last_seen_at', d.last_seen_at),
    'state', public.connector_device_state(d.last_seen_at, d.revoked_at, d.last_read_result, d.last_sync_at),
    'last_sync', case when d.last_sync_at is null then null else jsonb_build_object('at', d.last_sync_at) end)
  from public.connector_devices d join public.shops s on s.id = d.shop_id
  where d.id = p_device_id and d.revoked_at is null
$$;
revoke execute on function public.connector_status(uuid) from public, anon, authenticated;
grant execute on function public.connector_status(uuid) to service_role;
