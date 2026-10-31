-- =====================================================================================================================
-- Update 53: the Cacaduu Cloud Connection for the POS Sync Agent, phase C — "Synchronizovať teraz" (Sync Now).
--
-- The owner presses "Synchronizovať teraz" in Môj obchod; that makes ONE command for the shop. The agent never gets a
-- connection from the cloud: it sees the command in its next heartbeat (or GET /v1/commands), claims it (one atomic
-- update: two agents never run the same command), reads the POS and answers with a full snapshot (phase B, update 52)
-- or "unchanged" (confirm), then reports the result. Only two types exist: sync_inventory and ping; the cloud never
-- sends code, file paths or POS settings.
--
-- States: pending → claimed → running → completed | failed | expired. A claim is a 2-minute lease ("running" renews
-- it); a lease that runs out puts the command back to pending, after 3 attempts it is failed. A command nobody claims
-- within 10 minutes expires ("Agent je offline – zapnite počítač s POS agentom"). A sync_inventory counts as completed
-- only with a snapshot that was applied or held after the command was made, or an "unchanged" confirmation for it.
-- Owners only read their shops' commands and make them through owner_connector_sync_now(); everything else is the
-- connector function's (service role). Paste this whole file into the Supabase SQL Editor once; safe to run again.
-- =====================================================================================================================

-- ------------------------------------------------------------------ 1. the table

create table if not exists public.connector_commands (
  id                uuid primary key default gen_random_uuid(),
  shop_id           uuid not null references public.shops (id) on delete cascade,
  type              text not null check (type in ('sync_inventory', 'ping')),
  state             text not null default 'pending'
                    check (state in ('pending', 'claimed', 'running', 'completed', 'failed', 'expired')),
  requested_by      uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  -- unclaimed until then → expired (set again when a lease runs out and the command goes back to pending)
  expires_at        timestamptz not null default now() + interval '10 minutes',
  claimed_by        uuid references public.connector_devices (id) on delete set null,
  claimed_at        timestamptz,
  lease_expires_at  timestamptz,
  attempt           integer not null default 0 check (attempt between 0 and 10),
  -- "unchanged" (POST /v1/inventory/confirm with this command_id) while it was claimed
  confirmed_at      timestamptz,
  snapshot_id       uuid,
  -- why it failed: lease_expired (3 attempts) or agent (then reason = the agent's plain text, ≤ 500)
  error             text check (error is null or error in ('lease_expired', 'agent')),
  reason            text check (reason is null or length(reason) <= 500),
  finished_at       timestamptz
);
create index if not exists connector_commands_shop_idx on public.connector_commands (shop_id, created_at desc);
create index if not exists connector_commands_open_idx on public.connector_commands (shop_id)
  where state in ('pending', 'claimed', 'running');

alter table public.connector_commands enable row level security;
revoke all on public.connector_commands from public, anon, authenticated;
grant select on public.connector_commands to authenticated;
grant all on public.connector_commands to service_role;
drop policy if exists "connector_commands: members read" on public.connector_commands;
create policy "connector_commands: members read" on public.connector_commands
  for select to authenticated using (public.is_shop_member(shop_id));

alter table public.connector_hits drop constraint if exists connector_hits_kind_check;
alter table public.connector_hits add constraint connector_hits_kind_check
  check (kind in ('pair_fail', 'heartbeat', 'rotate', 'status', 'confirm', 'commands', 'command'));

alter table public.shop_activity drop constraint if exists shop_activity_action_check;
alter table public.shop_activity add constraint shop_activity_action_check
  check (action in ('stock_files_deleted', 'inventory_missing_removed', 'inventory_reset', 'inventory_restored',
                    'inventory_purged', 'export_review', 'export_edits', 'export_files_deleted',
                    'inventory_api_connected', 'inventory_api_key_changed', 'inventory_api_approved',
                    'inventory_api_error', 'inventory_api_recovered', 'inventory_api_disconnected',
                    'connector_paired', 'connector_revoked', 'stock_source_changed', 'connector_snapshot_held',
                    'connector_snapshot_approved', 'connector_snapshot_discarded', 'connector_sync_requested'));

-- ------------------------------------------------------------------ 2. small rules

-- Time moves the states on (no job needed): an unclaimed command past expires_at → expired; a claim whose lease ran
-- out → pending again (10 more minutes), or failed after the 3rd attempt. Run before every read and write.
create or replace function public.connector_commands_tidy(p_shop_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.connector_commands c set
    state = case when c.attempt >= 3 then 'failed' else 'pending' end,
    error = case when c.attempt >= 3 then 'lease_expired' end,
    finished_at = case when c.attempt >= 3 then now() end,
    expires_at = case when c.attempt >= 3 then c.expires_at else now() + interval '10 minutes' end,
    claimed_by = case when c.attempt >= 3 then c.claimed_by end,
    lease_expires_at = null
  where c.shop_id = p_shop_id and c.state in ('claimed', 'running') and c.lease_expires_at < now();
  update public.connector_commands c set state = 'expired', finished_at = now()
  where c.shop_id = p_shop_id and c.state = 'pending' and c.expires_at < now();
$$;
revoke execute on function public.connector_commands_tidy(uuid) from public, anon, authenticated;
grant execute on function public.connector_commands_tidy(uuid) to service_role;

-- What the agent sees of a command (the contract's Command).
create or replace function public.connector_command_view(p public.connector_commands)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('id', p.id, 'type', p.type, 'state', p.state, 'created_at', p.created_at,
                            'expires_at', p.expires_at, 'lease_expires_at', p.lease_expires_at, 'attempt', p.attempt)
$$;

-- Is this device answering this shop's Sync Now right now (claimed or running, lease not run out)?
create or replace function public.connector_command_active(p_shop_id uuid, p_device_id uuid, p_command_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_command_id is not null and exists (
    select 1 from public.connector_commands c
    where c.id = p_command_id and c.shop_id = p_shop_id and c.type = 'sync_inventory' and c.claimed_by = p_device_id
      and c.state in ('claimed', 'running') and c.lease_expires_at > now())
$$;
revoke execute on function public.connector_command_active(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.connector_command_active(uuid, uuid, uuid) to service_role;

-- A device holding a live lease is "syncing" (shown instead of its other state, unless it was disconnected).
create or replace function public.connector_device_syncing(p_device_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.connector_commands c
                 where c.claimed_by = p_device_id and c.state in ('claimed', 'running') and c.lease_expires_at > now())
$$;
revoke execute on function public.connector_device_syncing(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ 3. the owner: "Synchronizovať teraz"

-- One sync_inventory for the shop: only with a paired agent that is the shop's stock source ("Zdroj zásob"); an open
-- one is returned instead of a second; at most 4 an hour per shop.
create or replace function public.owner_connector_sync_now(p_shop_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cmd public.connector_commands;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  if not exists (select 1 from public.connector_devices d where d.shop_id = p_shop_id and d.revoked_at is null) then
    raise exception 'no_device' using errcode = '55000';
  end if;
  if public.stock_source_of(p_shop_id) <> 'agent' then
    raise exception 'not_agent' using errcode = '55000';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('connector-command:' || p_shop_id::text, 53));
  perform public.connector_commands_tidy(p_shop_id);
  select * into v_cmd from public.connector_commands c
  where c.shop_id = p_shop_id and c.type = 'sync_inventory' and c.state in ('pending', 'claimed', 'running')
  order by c.created_at desc limit 1;
  if v_cmd.id is not null then
    return jsonb_build_object('status', 'existing', 'command', public.connector_command_view(v_cmd));
  end if;
  if (select count(*) from public.connector_commands c
      where c.shop_id = p_shop_id and c.type = 'sync_inventory' and c.created_at > now() - interval '1 hour') >= 4 then
    raise exception 'too_many' using errcode = '55000';
  end if;
  insert into public.connector_commands (shop_id, type, requested_by) values (p_shop_id, 'sync_inventory', auth.uid())
  returning * into v_cmd;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'connector_sync_requested', jsonb_build_object('command', v_cmd.id));
  -- the last 50 per shop are kept
  delete from public.connector_commands c
  where c.shop_id = p_shop_id
    and c.id not in (select k.id from public.connector_commands k where k.shop_id = p_shop_id order by k.created_at desc limit 50);
  return jsonb_build_object('status', 'new', 'command', public.connector_command_view(v_cmd));
end;
$$;
revoke execute on function public.owner_connector_sync_now(uuid) from public, anon;
grant execute on function public.owner_connector_sync_now(uuid) to authenticated;

-- The last 5 commands for the dashboard (with the computer that answered).
create or replace function public.owner_connector_commands(p_shop_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  perform public.connector_commands_tidy(p_shop_id);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', c.id, 'type', c.type, 'state', c.state, 'created_at', c.created_at, 'expires_at', c.expires_at,
             'claimed_at', c.claimed_at, 'finished_at', c.finished_at, 'attempt', c.attempt, 'error', c.error,
             'reason', c.reason, 'unchanged', c.confirmed_at is not null and c.snapshot_id is null,
             'snapshot_id', c.snapshot_id, 'device', d.name)
           order by c.created_at desc)
    from (select * from public.connector_commands x where x.shop_id = p_shop_id order by x.created_at desc limit 5) c
    left join public.connector_devices d on d.id = c.claimed_by), '[]'::jsonb);
end;
$$;
revoke execute on function public.owner_connector_commands(uuid) from public, anon;
grant execute on function public.owner_connector_commands(uuid) to authenticated;

-- "Synchronizuje" in the device list and in GET /v1/status (same output as update 50, the state can now be syncing).
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
        'state', case when public.connector_device_syncing(d.id) then 'syncing'
                      else public.connector_device_state(d.last_seen_at, d.revoked_at, d.last_read_result, d.last_sync_at) end)
        order by d.paired_at desc), '[]'::jsonb)
      from public.connector_devices d where d.shop_id = p_shop_id and d.revoked_at is null),
    'open_code_until', (select max(c.expires_at) from public.connector_pairing_codes c
                        where c.shop_id = p_shop_id and c.used_at is null and c.expires_at > now()));
end;
$$;
revoke execute on function public.owner_connector_devices(uuid) from public, anon;
grant execute on function public.owner_connector_devices(uuid) to authenticated;

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
    'state', case when public.connector_device_syncing(d.id) then 'syncing'
                  else public.connector_device_state(d.last_seen_at, d.revoked_at, d.last_read_result, d.last_sync_at) end,
    'last_sync', case when d.last_sync_at is null then null else jsonb_build_object('at', d.last_sync_at) end)
  from public.connector_devices d join public.shops s on s.id = d.shop_id
  where d.id = p_device_id and d.revoked_at is null
$$;
revoke execute on function public.connector_status(uuid) from public, anon, authenticated;
grant execute on function public.connector_status(uuid) to service_role;

-- ------------------------------------------------------------------ 4. what only the connector function does

-- The device's shop's pending commands (heartbeat answers and GET /v1/commands; p_count: GET is limited to 6 a minute).
create or replace function public.connector_commands_list(p_device_id uuid, p_count boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
begin
  select d.shop_id into v_shop from public.connector_devices d where d.id = p_device_id and d.revoked_at is null;
  if v_shop is null then
    return jsonb_build_object('status', 'revoked');
  end if;
  if p_count and not public.connector_hit(p_device_id::text, 'commands', 6, interval '1 minute') then
    return jsonb_build_object('status', 'too_many');
  end if;
  perform public.connector_commands_tidy(v_shop);
  return jsonb_build_object('status', 'ok', 'commands', coalesce((
    select jsonb_agg(public.connector_command_view(c) order by c.created_at)
    from public.connector_commands c where c.shop_id = v_shop and c.state = 'pending'), '[]'::jsonb));
end;
$$;
revoke execute on function public.connector_commands_list(uuid, boolean) from public, anon, authenticated;
grant execute on function public.connector_commands_list(uuid, boolean) to service_role;

-- POST /v1/commands/{id}/claim: one atomic update — only a pending command of the device's own shop; 2-minute lease.
create or replace function public.connector_command_claim(p_device_id uuid, p_command_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
  v_cmd public.connector_commands;
begin
  select d.shop_id into v_shop from public.connector_devices d where d.id = p_device_id and d.revoked_at is null;
  if v_shop is null then
    return jsonb_build_object('status', 'revoked');
  end if;
  if not public.connector_hit(p_device_id::text, 'command', 30, interval '1 minute') then
    return jsonb_build_object('status', 'too_many');
  end if;
  perform public.connector_commands_tidy(v_shop);
  update public.connector_commands c set state = 'claimed', claimed_by = p_device_id, claimed_at = now(),
    lease_expires_at = now() + interval '2 minutes', attempt = c.attempt + 1
  where c.id = p_command_id and c.shop_id = v_shop and c.state = 'pending' and c.expires_at > now()
  returning * into v_cmd;
  if v_cmd.id is not null then
    return jsonb_build_object('status', 'claimed', 'command', public.connector_command_view(v_cmd));
  end if;
  select * into v_cmd from public.connector_commands c where c.id = p_command_id and c.shop_id = v_shop;
  if v_cmd.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  return jsonb_build_object('status', 'already_claimed', 'command', public.connector_command_view(v_cmd));
end;
$$;
revoke execute on function public.connector_command_claim(uuid, uuid) from public, anon, authenticated;
grant execute on function public.connector_command_claim(uuid, uuid) to service_role;

-- POST /v1/commands/{id}/result: running (renews the lease) / failed (plain text) / completed. Only the device holding
-- the claim. A sync_inventory completes only with a snapshot of this shop applied or held after the command was made,
-- or after an "unchanged" confirmation for it.
create or replace function public.connector_command_result(p_device_id uuid, p_command_id uuid, p_state text,
                                                           p_reason text, p_snapshot_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
  v_cmd public.connector_commands;
begin
  select d.shop_id into v_shop from public.connector_devices d where d.id = p_device_id and d.revoked_at is null;
  if v_shop is null then
    return jsonb_build_object('status', 'revoked');
  end if;
  if p_state not in ('running', 'failed', 'completed') then
    return jsonb_build_object('status', 'bad_state');
  end if;
  if not public.connector_hit(p_device_id::text, 'command', 30, interval '1 minute') then
    return jsonb_build_object('status', 'too_many');
  end if;
  perform public.connector_commands_tidy(v_shop);
  select * into v_cmd from public.connector_commands c where c.id = p_command_id and c.shop_id = v_shop for update;
  if v_cmd.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_cmd.claimed_by is distinct from p_device_id or v_cmd.state not in ('claimed', 'running') then
    return jsonb_build_object('status', 'not_claimed', 'command', public.connector_command_view(v_cmd));
  end if;
  if p_state = 'running' then
    update public.connector_commands set state = 'running', lease_expires_at = now() + interval '2 minutes'
    where id = p_command_id returning * into v_cmd;
  elsif p_state = 'failed' then
    update public.connector_commands set state = 'failed', error = 'agent', lease_expires_at = null, finished_at = now(),
      reason = coalesce(public.connector_text(p_reason, 500), 'failed')
    where id = p_command_id returning * into v_cmd;
  else
    if v_cmd.type = 'sync_inventory' and not (
        (p_snapshot_id is not null and exists (
           select 1 from public.connector_snapshots s
           where s.shop_id = v_shop and s.id = p_snapshot_id and s.state in ('applied', 'held')
             and s.created_at >= v_cmd.created_at and (s.command_id is null or s.command_id = p_command_id)))
        or (p_snapshot_id is null and v_cmd.confirmed_at is not null)) then
      return jsonb_build_object('status', 'snapshot_not_applied', 'command', public.connector_command_view(v_cmd));
    end if;
    update public.connector_commands set state = 'completed', snapshot_id = p_snapshot_id, lease_expires_at = null,
      finished_at = now()
    where id = p_command_id returning * into v_cmd;
  end if;
  return jsonb_build_object('status', 'ok', 'command', public.connector_command_view(v_cmd));
end;
$$;
revoke execute on function public.connector_command_result(uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.connector_command_result(uuid, uuid, text, text, uuid) to service_role;

-- POST /v1/inventory/confirm with a command_id that was confirmed: the stock is unchanged — enough to complete it.
create or replace function public.connector_command_confirmed(p_device_id uuid, p_command_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  with dev as (select d.shop_id from public.connector_devices d where d.id = p_device_id and d.revoked_at is null),
  upd as (
    update public.connector_commands c set confirmed_at = now()
    from dev
    where c.id = p_command_id and c.shop_id = dev.shop_id and c.type = 'sync_inventory' and c.claimed_by = p_device_id
      and c.state in ('claimed', 'running')
    returning c.id)
  select exists (select 1 from upd)
$$;
revoke execute on function public.connector_command_confirmed(uuid, uuid) from public, anon, authenticated;
grant execute on function public.connector_command_confirmed(uuid, uuid) to service_role;

-- A snapshot that answers this device's Sync Now skips the 5-minute wait (update 52's announce, one line changed).
-- POST /v1/inventory/snapshots: a snapshot is announced. The same id again returns it as it is (idempotent).
create or replace function public.connector_snapshot_announce(p_device_id uuid, p_snapshot_id uuid, p_source_id text,
                                                              p_source_time timestamptz, p_complete boolean,
                                                              p_count integer, p_hash text, p_command_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
  v_old public.connector_snapshots;
  v_last timestamptz;
  v_new public.connector_snapshots;
begin
  select d.shop_id into v_shop from public.connector_devices d where d.id = p_device_id and d.revoked_at is null;
  if v_shop is null then
    return jsonb_build_object('status', 'revoked');
  end if;
  select * into v_old from public.connector_snapshots where shop_id = v_shop and id = p_snapshot_id;
  if found then
    if v_old.state = 'awaiting_upload' and v_old.upload_expires_at < now() then
      -- a fresh upload address for the same snapshot
      update public.connector_snapshots set upload_expires_at = now() + interval '15 minutes'
      where shop_id = v_shop and id = p_snapshot_id returning * into v_old;
    end if;
    return jsonb_build_object('status', 'existing', 'shop_id', v_shop, 'snapshot', public.connector_snapshot_view(v_old));
  end if;
  if p_source_time > now() + interval '5 minutes' then
    return jsonb_build_object('status', 'clock_ahead');
  end if;
  select s.agent_source_time into v_last from public.shop_stock_source s where s.shop_id = v_shop;
  if v_last is not null and p_source_time <= v_last then
    return jsonb_build_object('status', 'stale');
  end if;
  -- one full snapshot per 5 minutes per shop; an answer to a Sync Now command this device holds skips the wait
  -- (update 53); an incomplete one is refused below without counting
  if p_complete and not public.connector_command_active(v_shop, p_device_id, p_command_id)
     and exists (select 1 from public.connector_snapshots s
             where s.shop_id = v_shop and s.created_at > now() - interval '5 minutes'
               and s.state in ('awaiting_upload', 'processing', 'applied', 'held', 'test_ok')) then
    return jsonb_build_object('status', 'rate_limited', 'retry_after', 300);
  end if;
  insert into public.connector_snapshots (shop_id, id, device_id, source_id, source_time, product_count, content_hash,
                                          command_id, state, error, message, completed_at)
  values (v_shop, p_snapshot_id, p_device_id, public.connector_text(p_source_id, 80), p_source_time,
          greatest(coalesce(p_count, 0), 0), lower(p_hash), p_command_id,
          case when p_complete then 'awaiting_upload' else 'rejected' end,
          case when p_complete then null else 'incomplete' end,
          case when p_complete then null else 'Only complete snapshots are accepted.' end,
          case when p_complete then null else now() end)
  returning * into v_new;
  -- the last 50 per shop are kept
  delete from public.connector_snapshots s
  where s.shop_id = v_shop
    and (s.shop_id, s.id) not in (select k.shop_id, k.id from public.connector_snapshots k where k.shop_id = v_shop
                                  order by k.created_at desc limit 50);
  return jsonb_build_object('status', 'new', 'shop_id', v_shop, 'snapshot', public.connector_snapshot_view(v_new));
end;
$$;
revoke execute on function public.connector_snapshot_announce(uuid, uuid, text, timestamptz, boolean, integer, text, uuid)
  from public, anon, authenticated;
grant execute on function public.connector_snapshot_announce(uuid, uuid, text, timestamptz, boolean, integer, text, uuid)
  to service_role;
