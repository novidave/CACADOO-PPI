-- =====================================================================================================================
-- Update 52: the Cacaduu Cloud Connection for the POS Sync Agent, phase B — inventory snapshots and "Zdroj zásob".
--
-- A paired POS agent (update 50) now sends the shop's whole stock as a snapshot: it announces it, uploads the gzipped
-- JSON straight to the private bucket "connector-staging" (a signed upload address, never through the function) and
-- asks the function to complete it. The function checks the file (hash, product count, every row) and calls
-- connector_snapshot_apply() here, which decides — in SQL only — what happens:
--   * the shop's stock source ("Zdroj zásob") is not the POS agent → "test_ok": checked, shown to the owner, not applied;
--   * 0 products, or fewer than half of the last applied count → "held": the owner decides ("Áno, použiť tento stav");
--   * otherwise "applied" in one transaction (products missing from the snapshot → quantity 0, as with files; rows the
--     function had to skip keep their previous stock and time).
-- A partial, failed, older or wrong snapshot never changes the stock. One stock source at a time: the folder / file
-- upload, the inventory program (update 49) or the POS agent; while one is active the others are refused.
-- Paste this whole file into the Supabase SQL Editor once; safe to run again.
-- =====================================================================================================================

-- ------------------------------------------------------------------ 1. the shop's stock source ("Zdroj zásob")

create table if not exists public.shop_stock_source (
  shop_id                 uuid primary key references public.shops (id) on delete cascade,
  -- what the owner chose; the inventory program (update 49) wins while it is connected
  source                  text not null default 'file' check (source in ('file', 'agent')),
  changed_at              timestamptz not null default now(),
  changed_by              uuid references auth.users (id) on delete set null,
  -- the last snapshot the POS agent applied (the "confirm unchanged" check and the "held" rule compare against it)
  agent_snapshot_id       uuid,
  agent_content_hash      text check (agent_content_hash is null or agent_content_hash ~ '^[0-9a-f]{64}$'),
  agent_product_count     integer check (agent_product_count is null or agent_product_count >= 0),
  agent_source_time       timestamptz,
  agent_applied_at        timestamptz
);
alter table public.shop_stock_source enable row level security;
revoke all on public.shop_stock_source from public, anon, authenticated;
grant select on public.shop_stock_source to authenticated;
grant all on public.shop_stock_source to service_role;
drop policy if exists "shop_stock_source: members read" on public.shop_stock_source;
create policy "shop_stock_source: members read" on public.shop_stock_source
  for select to authenticated using (public.is_shop_member(shop_id));

-- ------------------------------------------------------------------ 2. the snapshots

create table if not exists public.connector_snapshots (
  shop_id           uuid not null references public.shops (id) on delete cascade,
  -- the agent's own id (a UUID per read of the POS): the idempotency key
  id                uuid not null,
  device_id         uuid references public.connector_devices (id) on delete set null,
  source_id         text not null check (length(source_id) between 1 and 80),
  source_time       timestamptz not null,
  product_count     integer not null check (product_count >= 0),
  content_hash      text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  command_id        uuid,
  state             text not null default 'awaiting_upload'
                    check (state in ('awaiting_upload', 'processing', 'applied', 'held', 'test_ok', 'rejected',
                                     'discarded')),
  error             text check (error is null or error ~ '^[a-z_]{1,40}$'),
  message           text check (message is null or length(message) <= 500),
  -- products, imported, zeroed, skipped (+ up to 20 skipped rows: their line and reason)
  result            jsonb check (result is null or jsonb_typeof(result) = 'object'),
  -- the first 5 rows as the owner sees them (only the snapshot's public fields)
  preview           jsonb not null default '[]'::jsonb check (jsonb_typeof(preview) = 'array'),
  -- a held snapshot's rows until the owner decides (never granted; cleared after the decision)
  held_rows         jsonb check (held_rows is null or jsonb_typeof(held_rows) = 'array'),
  held_keep         text[],
  previous_count    integer,
  created_at        timestamptz not null default now(),
  upload_expires_at timestamptz not null default now() + interval '15 minutes',
  processing_at     timestamptz,
  completed_at      timestamptz,
  decided_at        timestamptz,
  decided_by        uuid references auth.users (id) on delete set null,
  primary key (shop_id, id)
);
create index if not exists connector_snapshots_recent_idx on public.connector_snapshots (shop_id, created_at desc);
alter table public.connector_snapshots enable row level security;
revoke all on public.connector_snapshots from public, anon, authenticated;
-- owners read their shops' snapshots, never the held rows (the dashboard uses owner_connector_snapshots())
grant select (shop_id, id, device_id, source_id, source_time, product_count, state, error, message, result, preview,
              previous_count, created_at, completed_at, decided_at)
  on public.connector_snapshots to authenticated;
grant all on public.connector_snapshots to service_role;
drop policy if exists "connector_snapshots: members read" on public.connector_snapshots;
create policy "connector_snapshots: members read" on public.connector_snapshots
  for select to authenticated using (public.is_shop_member(shop_id));

-- The staging bucket: only the service role writes and reads (the agent uploads through a signed address the function
-- makes; that address is valid for one object only). 50 MB is the hard cap; CONNECTOR_MAX_MB is the working limit.
do $$
begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'storage' and c.relname = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('connector-staging', 'connector-staging', false, 52428800)
    on conflict (id) do update set public = false, file_size_limit = 52428800;
  end if;
end;
$$;

-- the import report knows the POS agent; the rate limits know snapshots and confirmations
alter table public.stock_imports drop constraint if exists stock_imports_source_check;
alter table public.stock_imports add constraint stock_imports_source_check check (source in ('file', 'api', 'agent'));
alter table public.connector_hits drop constraint if exists connector_hits_kind_check;
alter table public.connector_hits add constraint connector_hits_kind_check
  check (kind in ('pair_fail', 'heartbeat', 'rotate', 'status', 'confirm'));

alter table public.shop_activity drop constraint if exists shop_activity_action_check;
alter table public.shop_activity add constraint shop_activity_action_check
  check (action in ('stock_files_deleted', 'inventory_missing_removed', 'inventory_reset', 'inventory_restored',
                    'inventory_purged', 'export_review', 'export_edits', 'export_files_deleted',
                    'inventory_api_connected', 'inventory_api_key_changed', 'inventory_api_approved',
                    'inventory_api_error', 'inventory_api_recovered', 'inventory_api_disconnected',
                    'connector_paired', 'connector_revoked', 'stock_source_changed', 'connector_snapshot_held',
                    'connector_snapshot_approved', 'connector_snapshot_discarded'));

-- ------------------------------------------------------------------ 3. one stock source at a time

-- The source that may change the stock now: 'api' while an inventory program is connected (update 49), 'agent' when
-- the owner chose the POS agent and a paired (not revoked) device exists, else 'file' (folder sync and uploads).
create or replace function public.stock_source_of(p_shop_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (select 1 from public.inventory_connections c where c.shop_id = p_shop_id) then 'api'
    when exists (select 1 from public.shop_stock_source s where s.shop_id = p_shop_id and s.source = 'agent')
     and exists (select 1 from public.connector_devices d where d.shop_id = p_shop_id and d.revoked_at is null)
      then 'agent'
    else 'file'
  end
$$;
revoke execute on function public.stock_source_of(uuid) from public, anon, authenticated;
grant execute on function public.stock_source_of(uuid) to service_role;

-- "Zdroj zásob" in Môj obchod: what is active, what was chosen, what could be chosen.
create or replace function public.owner_stock_source(p_shop_id uuid)
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
    'active', public.stock_source_of(p_shop_id),
    'chosen', coalesce((select s.source from public.shop_stock_source s where s.shop_id = p_shop_id), 'file'),
    'api_provider', (select c.provider from public.inventory_connections c where c.shop_id = p_shop_id),
    'devices', (select count(*) from public.connector_devices d where d.shop_id = p_shop_id and d.revoked_at is null),
    'changed_at', (select s.changed_at from public.shop_stock_source s where s.shop_id = p_shop_id));
end;
$$;
revoke execute on function public.owner_stock_source(uuid) from public, anon;
grant execute on function public.owner_stock_source(uuid) to authenticated;

-- The owner chooses: 'file' (folder / upload) or 'agent' (needs a paired device; refused while an inventory program
-- is connected — disconnect it first).
create or replace function public.owner_set_stock_source(p_shop_id uuid, p_source text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old text;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  if p_source is null or p_source not in ('file', 'agent') then
    raise exception 'source' using errcode = '22023';
  end if;
  if exists (select 1 from public.inventory_connections c where c.shop_id = p_shop_id) then
    raise exception 'api_connected' using errcode = '55000';
  end if;
  if p_source = 'agent' and not exists (select 1 from public.connector_devices d
                                        where d.shop_id = p_shop_id and d.revoked_at is null) then
    raise exception 'no_device' using errcode = '55000';
  end if;
  select s.source into v_old from public.shop_stock_source s where s.shop_id = p_shop_id for update;
  if coalesce(v_old, 'file') = p_source then
    return;
  end if;
  insert into public.shop_stock_source (shop_id, source, changed_at, changed_by)
  values (p_shop_id, p_source, now(), auth.uid())
  on conflict (shop_id) do update set source = excluded.source, changed_at = now(), changed_by = auth.uid();
  insert into public.shop_activity (shop_id, action, details)
  values (p_shop_id, 'stock_source_changed', jsonb_build_object('from', coalesce(v_old, 'file'), 'to', p_source));
end;
$$;
revoke execute on function public.owner_set_stock_source(uuid, text) from public, anon;
grant execute on function public.owner_set_stock_source(uuid, text) to authenticated;

-- As in update 49, plus: while the POS agent is the stock source, the folder and uploads are refused too.
create or replace function public.upload_check_in(p_shop_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status jsonb;
begin
  if not (public.is_shop_member(p_shop_id) or public.is_admin()) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  if not exists (select 1 from public.shops where id = p_shop_id) then
    raise exception 'Shop not found' using errcode = 'P0002';
  end if;
  -- update 49: while an inventory program is connected, it is the only source (no folder sync, no upload)
  if exists (select 1 from public.inventory_connections c where c.shop_id = p_shop_id) then
    raise exception 'api_connected' using errcode = '55000',
      hint = 'The stock comes from the connected inventory program; disconnect it in My shop to upload files again.';
  end if;
  -- update 52: the same while the POS agent is the shop's stock source
  if public.stock_source_of(p_shop_id) = 'agent' then
    raise exception 'agent_connected' using errcode = '55000',
      hint = 'The stock comes from the POS agent; choose "files" as the stock source in My shop to upload files again.';
  end if;

  insert into public.sync_sources (shop_id) values (p_shop_id)
  on conflict (shop_id) do nothing;

  update public.sync_sources s
  set folder_seen_at = now()
  where s.shop_id = p_shop_id
  returning jsonb_build_object(
    'latest_file_time', s.latest_file_time,
    'last_checked_at',  s.last_checked_at,
    'last_error',       s.last_error,
    'mapping_status',   s.mapping_status,
    'freshness_state',  public.freshness_label(s.latest_file_time),
    'folder_seen_at',   s.folder_seen_at,
    'last_file_name',   s.last_file_name,
    'files_cleared',    s.files_cleared_at is not null
                        and not exists (select 1 from public.stock_imports i
                                        where i.shop_id = s.shop_id and i.received_at > s.files_cleared_at)
  ) into v_status;

  return v_status;
end;
$$;
revoke execute on function public.upload_check_in(uuid) from public, anon;
grant execute on function public.upload_check_in(uuid) to authenticated;

-- As in update 49, plus: no inventory program while the POS agent is the stock source ('agent').
create or replace function public.owner_inventory_can_connect(p_shop_id uuid, p_provider text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  if public.stock_source_of(p_shop_id) = 'agent' then
    return 'agent';
  end if;
  if not exists (select 1 from public.inventory_providers p where p.code = p_provider and p.built and p.enabled) then
    return 'provider';
  end if;
  if not coalesce((select p.allowed from public.inventory_plan_for(p_shop_id) p), false) then
    return 'plan';
  end if;
  return 'ok';
end;
$$;
revoke execute on function public.owner_inventory_can_connect(uuid, text) from public, anon;
grant execute on function public.owner_inventory_can_connect(uuid, text) to authenticated;

-- ------------------------------------------------------------------ 4. writing the stock

-- Like apply_stock_file() (one transaction; products missing from the snapshot → quantity 0), but the products in
-- p_keep — rows the function had to skip — keep their previous stock and time, never set to 0.
create or replace function public.connector_apply_rows(p_shop_id uuid, p_rows jsonb, p_keep text[], p_time timestamptz,
                                                       p_label text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_items integer;
  v_zeroed integer;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'p_rows must be a JSON array' using errcode = '22023';
  end if;

  drop table if exists agent_rows;
  create temporary table agent_rows on commit drop as
  select distinct on (left(trim(r.source_code), 100))
    left(trim(r.source_code), 100)           as source_code,
    left(trim(r.name), 300)                  as name,
    nullif(left(trim(r.ean), 32), '')        as ean,
    nullif(left(trim(r.brand), 100), '')     as brand,
    r.quantity                               as quantity,
    r.price                                  as price,
    upper(trim(r.currency))                  as currency
  from jsonb_to_recordset(p_rows) as r(source_code text, name text, ean text, brand text, quantity numeric,
                                       price numeric, currency text)
  where nullif(trim(r.source_code), '') is not null
    and nullif(trim(r.name), '') is not null
    and r.price is not null
    and upper(trim(coalesce(r.currency, ''))) ~ '^[A-Z]{3}$'
  order by left(trim(r.source_code), 100);

  insert into public.products (ean, name, brand)
  select distinct on (p.ean) p.ean, p.name, p.brand
  from agent_rows p
  where p.ean is not null
  order by p.ean
  on conflict (ean) do nothing;

  insert into public.shop_items (shop_id, source_code, name, ean, brand, product_id, updated_at)
  select p_shop_id, p.source_code, p.name, p.ean, p.brand,
         (select pr.id from public.products pr where pr.ean = p.ean), now()
  from agent_rows p
  on conflict (shop_id, source_code) do update set
    name = excluded.name, ean = excluded.ean, brand = excluded.brand, product_id = excluded.product_id,
    updated_at = now();
  get diagnostics v_items = row_count;

  insert into public.inventory (shop_item_id, quantity, price, currency, source_updated_at, received_at)
  select si.id, coalesce(p.quantity, 0), p.price, p.currency, p_time, now()
  from agent_rows p
  join public.shop_items si on si.shop_id = p_shop_id and si.source_code = p.source_code
  on conflict (shop_item_id) do update set
    quantity = excluded.quantity, price = excluded.price, currency = excluded.currency,
    source_updated_at = excluded.source_updated_at, received_at = excluded.received_at;

  update public.inventory inv
  set quantity = 0, source_updated_at = p_time, received_at = now()
  from public.shop_items si
  where si.id = inv.shop_item_id
    and si.shop_id = p_shop_id
    and inv.quantity <> 0
    and not exists (select 1 from agent_rows p where p.source_code = si.source_code)
    and not (si.source_code = any (coalesce(p_keep, '{}'::text[])));
  get diagnostics v_zeroed = row_count;

  insert into public.sync_sources (shop_id) values (p_shop_id) on conflict (shop_id) do nothing;
  update public.sync_sources
  set latest_file_time = p_time, last_checked_at = now(), last_error = null, last_file_name = left(p_label, 200)
  where shop_id = p_shop_id;

  return jsonb_build_object('items', v_items, 'zeroed', v_zeroed);
end;
$$;
revoke execute on function public.connector_apply_rows(uuid, jsonb, text[], timestamptz, text) from public, anon, authenticated;
grant execute on function public.connector_apply_rows(uuid, jsonb, text[], timestamptz, text) to service_role;

-- What the agent and the dashboard learn about one snapshot.
create or replace function public.connector_snapshot_view(p public.connector_snapshots)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'snapshot_id', p.id,
    'state', case p.state when 'discarded' then 'rejected' else p.state end,
    'error', case p.state when 'discarded' then 'discarded_by_owner' when 'held' then null else p.error end,
    'reason', case when p.state = 'held' then p.error end,
    'message', p.message,
    'result', p.result,
    'upload_expires_at', case when p.state = 'awaiting_upload' then p.upload_expires_at end))
$$;

-- Applies (or holds, or only checks) one snapshot under the shop's lock; the caller made sure every row is valid.
create or replace function public.connector_snapshot_settle(p_shop_id uuid, p_snapshot_id uuid, p_rows jsonb, p_keep text[],
                                                            p_result jsonb, p_decided boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_snap public.connector_snapshots;
  v_src public.shop_stock_source;
  v_device text;
  v_applied jsonb;
  v_time timestamptz;
  v_skipped integer := coalesce((p_result ->> 'skipped')::integer, 0);
begin
  -- one snapshot of a shop at a time, the newest source_time wins
  perform pg_advisory_xact_lock(hashtextextended('connector:' || p_shop_id::text, 52));
  select * into v_snap from public.connector_snapshots where shop_id = p_shop_id and id = p_snapshot_id for update;
  select * into v_src from public.shop_stock_source where shop_id = p_shop_id;
  if v_src.agent_source_time is not null and v_snap.source_time <= v_src.agent_source_time then
    update public.connector_snapshots set state = 'rejected', error = 'stale', held_rows = null, held_keep = null,
      message = 'A newer snapshot was applied in the meantime.', completed_at = now()
    where shop_id = p_shop_id and id = p_snapshot_id;
    return jsonb_build_object('state', 'rejected', 'error', 'stale');
  end if;
  if public.stock_source_of(p_shop_id) <> 'agent' then
    -- checked, shown to the owner, never applied: the shop's stock source is something else
    update public.connector_snapshots set state = 'test_ok', result = p_result, held_rows = null, held_keep = null,
      completed_at = now()
    where shop_id = p_shop_id and id = p_snapshot_id;
    return jsonb_build_object('state', 'test_ok');
  end if;
  if not p_decided and (v_snap.product_count = 0
      or (v_src.agent_product_count is not null and v_snap.product_count * 2 < v_src.agent_product_count)) then
    -- never automatic: an empty or much smaller stock waits for the owner
    update public.connector_snapshots set state = 'held', error = case when v_snap.product_count = 0 then 'empty' else 'shrinking' end,
      result = p_result, held_rows = p_rows, held_keep = p_keep, previous_count = v_src.agent_product_count,
      completed_at = now()
    where shop_id = p_shop_id and id = p_snapshot_id;
    insert into public.shop_activity (shop_id, action, details)
    values (p_shop_id, 'connector_snapshot_held',
            jsonb_build_object('snapshot', p_snapshot_id, 'products', v_snap.product_count,
                               'previous', v_src.agent_product_count));
    return jsonb_build_object('state', 'held', 'reason', case when v_snap.product_count = 0 then 'empty' else 'shrinking' end);
  end if;

  -- freshness: the earlier of the POS's time and the time Cacaduu received it
  v_time := least(v_snap.source_time, coalesce(v_snap.processing_at, now()));
  select d.name into v_device from public.connector_devices d where d.id = v_snap.device_id;
  v_applied := public.connector_apply_rows(p_shop_id, p_rows, p_keep, v_time, 'POS agent · ' || coalesce(v_device, '?'));
  update public.shop_stock_source set
    agent_snapshot_id = p_snapshot_id, agent_content_hash = v_snap.content_hash,
    agent_product_count = v_snap.product_count, agent_source_time = v_snap.source_time, agent_applied_at = now()
  where shop_id = p_shop_id;
  update public.connector_devices set last_sync_at = now() where id = v_snap.device_id;
  update public.connector_snapshots set state = 'applied', error = null, held_rows = null, held_keep = null,
    result = coalesce(p_result, '{}'::jsonb) || jsonb_build_object('imported', (v_applied ->> 'items')::integer,
                                                                   'zeroed', (v_applied ->> 'zeroed')::integer),
    completed_at = coalesce(completed_at, now())
  where shop_id = p_shop_id and id = p_snapshot_id;

  -- the report in "Posledné nahrané súbory" (source 'agent'; the first 5 rows of the snapshot's fields; last 10 kept)
  insert into public.stock_imports (shop_id, file_name, file_time, status, total_rows, imported, zeroed, skipped,
                                    error, columns, preview, source)
  values (p_shop_id, left('POS agent · ' || coalesce(v_device, '?'), 200), v_snap.source_time,
          case when v_skipped > 0 then 'errors' else 'ok' end, v_snap.product_count,
          (v_applied ->> 'items')::integer, (v_applied ->> 'zeroed')::integer, v_skipped,
          case when v_skipped > 0 then left(p_result ->> 'skipped_text', 500) end,
          array['source_code', 'name', 'ean', 'brand', 'quantity', 'price', 'currency'], v_snap.preview, 'agent');
  delete from public.stock_imports
  where shop_id = p_shop_id
    and id not in (select i.id from public.stock_imports i where i.shop_id = p_shop_id
                   order by i.received_at desc, i.id desc limit 10);

  return jsonb_build_object('state', 'applied', 'result',
    jsonb_build_object('products', v_snap.product_count, 'imported', (v_applied ->> 'items')::integer,
                       'zeroed', (v_applied ->> 'zeroed')::integer, 'skipped', v_skipped));
end;
$$;
revoke execute on function public.connector_snapshot_settle(uuid, uuid, jsonb, text[], jsonb, boolean) from public, anon, authenticated;
grant execute on function public.connector_snapshot_settle(uuid, uuid, jsonb, text[], jsonb, boolean) to service_role;

-- ------------------------------------------------------------------ 5. what only the connector function does

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
  -- one full snapshot per 5 minutes per shop (a Sync Now command, phase C, may skip the wait); an incomplete one is
  -- refused below without counting
  if p_complete and exists (select 1 from public.connector_snapshots s
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

-- GET /v1/inventory/snapshots/{id}: one of this device's shop's snapshots.
create or replace function public.connector_snapshot_get(p_device_id uuid, p_snapshot_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.connector_snapshot_view(s)
  from public.connector_snapshots s
  join public.connector_devices d on d.shop_id = s.shop_id and d.id = p_device_id and d.revoked_at is null
  where s.id = p_snapshot_id
$$;
revoke execute on function public.connector_snapshot_get(uuid, uuid) from public, anon, authenticated;
grant execute on function public.connector_snapshot_get(uuid, uuid) to service_role;

-- POST …/complete, step 1: awaiting_upload → processing (once; a processing one older than 5 minutes may start
-- again after a crash). Anything else returns its state.
create or replace function public.connector_snapshot_begin(p_device_id uuid, p_snapshot_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
  v_snap public.connector_snapshots;
begin
  select d.shop_id into v_shop from public.connector_devices d where d.id = p_device_id and d.revoked_at is null;
  if v_shop is null then
    return jsonb_build_object('status', 'revoked');
  end if;
  update public.connector_snapshots s set state = 'processing', processing_at = now()
  where s.shop_id = v_shop and s.id = p_snapshot_id
    and (s.state = 'awaiting_upload' or (s.state = 'processing' and s.processing_at < now() - interval '5 minutes'))
  returning * into v_snap;
  if found then
    return jsonb_build_object('status', 'begin', 'shop_id', v_shop, 'source_id', v_snap.source_id,
                              'source_time', v_snap.source_time, 'product_count', v_snap.product_count,
                              'content_hash', v_snap.content_hash, 'upload_expires_at', v_snap.upload_expires_at);
  end if;
  select * into v_snap from public.connector_snapshots where shop_id = v_shop and id = p_snapshot_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  return jsonb_build_object('status', 'existing', 'shop_id', v_shop, 'snapshot', public.connector_snapshot_view(v_snap));
end;
$$;
revoke execute on function public.connector_snapshot_begin(uuid, uuid) from public, anon, authenticated;
grant execute on function public.connector_snapshot_begin(uuid, uuid) to service_role;

-- The file is not there yet (the agent may upload and ask again): back to awaiting_upload.
create or replace function public.connector_snapshot_wait(p_shop_id uuid, p_snapshot_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.connector_snapshots set state = 'awaiting_upload', processing_at = null
  where shop_id = p_shop_id and id = p_snapshot_id and state = 'processing'
$$;
revoke execute on function public.connector_snapshot_wait(uuid, uuid) from public, anon, authenticated;
grant execute on function public.connector_snapshot_wait(uuid, uuid) to service_role;

-- A snapshot the function could not use (hash, count, rows, size, format): the previous stock stays.
create or replace function public.connector_snapshot_reject(p_shop_id uuid, p_snapshot_id uuid, p_error text,
                                                            p_message text, p_result jsonb)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  update public.connector_snapshots s set state = 'rejected',
    error = case when p_error ~ '^[a-z_]{1,40}$' then p_error else 'rejected' end,
    message = public.connector_text(p_message, 500), result = p_result, completed_at = now()
  where s.shop_id = p_shop_id and s.id = p_snapshot_id and s.state = 'processing'
  returning public.connector_snapshot_view(s)
$$;
revoke execute on function public.connector_snapshot_reject(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.connector_snapshot_reject(uuid, uuid, text, text, jsonb) to service_role;

-- POST …/complete, step 2: the checked rows (p_keep = the products of skipped rows, which keep their stock).
create or replace function public.connector_snapshot_apply(p_shop_id uuid, p_snapshot_id uuid, p_rows jsonb,
                                                           p_keep text[], p_result jsonb, p_preview jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.connector_snapshots
                 where shop_id = p_shop_id and id = p_snapshot_id and state = 'processing') then
    return jsonb_build_object('state', 'not_processing');
  end if;
  update public.connector_snapshots
  set preview = case when jsonb_typeof(p_preview) = 'array' then p_preview else '[]'::jsonb end
  where shop_id = p_shop_id and id = p_snapshot_id;
  return public.connector_snapshot_settle(p_shop_id, p_snapshot_id, p_rows, p_keep, p_result, false);
end;
$$;
revoke execute on function public.connector_snapshot_apply(uuid, uuid, jsonb, text[], jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.connector_snapshot_apply(uuid, uuid, jsonb, text[], jsonb, jsonb) to service_role;

-- POST /v1/inventory/confirm: the POS was read again and nothing changed. Only the hash of the last applied
-- snapshot counts; then only the freshness time moves forward (never backwards).
create or replace function public.connector_confirm(p_device_id uuid, p_hash text, p_source_time timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
  v_src public.shop_stock_source;
  v_time timestamptz;
begin
  select d.shop_id into v_shop from public.connector_devices d where d.id = p_device_id and d.revoked_at is null;
  if v_shop is null then
    return jsonb_build_object('status', 'revoked');
  end if;
  if not public.connector_hit(p_device_id::text, 'confirm', 4, interval '1 minute') then
    return jsonb_build_object('status', 'too_many');
  end if;
  if p_source_time > now() + interval '5 minutes' then
    return jsonb_build_object('status', 'clock_ahead');
  end if;
  if public.stock_source_of(v_shop) <> 'agent' then
    return jsonb_build_object('status', 'test_ok');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('connector:' || v_shop::text, 52));
  select * into v_src from public.shop_stock_source where shop_id = v_shop for update;
  if v_src.agent_content_hash is null or v_src.agent_content_hash <> lower(coalesce(p_hash, '')) then
    return jsonb_build_object('status', 'send_full');
  end if;
  if p_source_time > v_src.agent_source_time then
    v_time := least(p_source_time, now());
    update public.shop_stock_source set agent_source_time = p_source_time where shop_id = v_shop;
    update public.sync_sources set latest_file_time = greatest(latest_file_time, v_time), last_checked_at = now()
    where shop_id = v_shop;
  end if;
  update public.connector_devices set last_sync_at = now() where id = p_device_id;
  return jsonb_build_object('status', 'confirmed', 'shop_id', v_shop);
end;
$$;
revoke execute on function public.connector_confirm(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.connector_confirm(uuid, text, timestamptz) to service_role;

-- ------------------------------------------------------------------ 6. what the owner sees and decides

-- The last 10 snapshots for "Prepojenie s pokladňou": state, counts, the held one's numbers, the preview.
create or replace function public.owner_connector_snapshots(p_shop_id uuid)
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
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', s.id, 'device', d.name, 'state', s.state, 'error', s.error, 'message', s.message,
             'source_time', s.source_time, 'created_at', s.created_at, 'completed_at', s.completed_at,
             'decided_at', s.decided_at, 'product_count', s.product_count, 'previous_count', s.previous_count,
             'result', s.result,
             'preview', case when s.state in ('held', 'test_ok', 'applied') then s.preview else '[]'::jsonb end)
           order by s.created_at desc)
    from (select * from public.connector_snapshots x where x.shop_id = p_shop_id
          order by x.created_at desc limit 10) s
    left join public.connector_devices d on d.id = s.device_id), '[]'::jsonb);
end;
$$;
revoke execute on function public.owner_connector_snapshots(uuid) from public, anon;
grant execute on function public.owner_connector_snapshots(uuid) to authenticated;

-- "Áno, použiť tento stav" / "Zahodiť" for a held snapshot. Using it applies it now (still only when the POS agent is
-- the stock source and nothing newer was applied in the meantime).
create or replace function public.owner_connector_decide(p_shop_id uuid, p_snapshot_id uuid, p_use boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_snap public.connector_snapshots;
  v_out jsonb;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  select * into v_snap from public.connector_snapshots where shop_id = p_shop_id and id = p_snapshot_id for update;
  if not found or v_snap.state <> 'held' then
    raise exception 'not_held' using errcode = '55000';
  end if;
  if not p_use then
    update public.connector_snapshots set state = 'discarded', held_rows = null, held_keep = null, decided_at = now(),
      decided_by = auth.uid()
    where shop_id = p_shop_id and id = p_snapshot_id;
    insert into public.shop_activity (shop_id, action, details)
    values (p_shop_id, 'connector_snapshot_discarded', jsonb_build_object('snapshot', p_snapshot_id));
    return jsonb_build_object('state', 'discarded');
  end if;
  if public.stock_source_of(p_shop_id) <> 'agent' then
    raise exception 'not_agent' using errcode = '55000';
  end if;
  v_out := public.connector_snapshot_settle(p_shop_id, p_snapshot_id, coalesce(v_snap.held_rows, '[]'::jsonb),
                                            v_snap.held_keep, v_snap.result, true);
  update public.connector_snapshots set decided_at = now(), decided_by = auth.uid()
  where shop_id = p_shop_id and id = p_snapshot_id;
  if v_out ->> 'state' = 'applied' then
    insert into public.shop_activity (shop_id, action, details)
    values (p_shop_id, 'connector_snapshot_approved',
            jsonb_build_object('snapshot', p_snapshot_id, 'products', v_snap.product_count));
  end if;
  return v_out;
end;
$$;
revoke execute on function public.owner_connector_decide(uuid, uuid, boolean) from public, anon;
grant execute on function public.owner_connector_decide(uuid, uuid, boolean) to authenticated;
