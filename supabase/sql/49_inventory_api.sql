-- =====================================================================================================================
-- Update 49: "Pripojiť skladový program (API)" — a shop links its inventory system with an API key and Cacaduu pulls
-- its stock automatically (at the owner's request, 2026-10-27).
--
-- Until now stock only came as uploads (the shop PC's folder or "Nahrať súbor"); nothing was pulled. This adds pulling
-- ONLY for shops that connect an API; uploads are unchanged. The Edge Function `inventory-connect` does the outside
-- calls; the database decides everything else:
--   * one connection per shop (inventory_connections); the key only encrypted (AES-GCM in the function), in a column
--     owners have no grant on — never readable again, only "••••1234" and the date;
--   * plan rule and intervals are the admin's (inventory_plan_settings: Pro on, 15 min; Free off, 24 h), each provider
--     can be switched off (inventory_providers; providers not built = "Pripravujeme");
--   * ONE stock source per shop: while a connection exists, upload_check_in() refuses (folder sync and "Nahrať súbor"
--     stop) — never two sources writing the same inventory;
--   * the first fetch only shows a preview; nothing is published before the owner approves the field mapping
--     (owner_inventory_approve); changed fields later → asked again, never approved by itself;
--   * every run goes through apply_stock_file() (the same freshness, labels, IndexNow trigger, translations), its
--     report into stock_imports with source 'api'; a run that is not provably complete, empty or failed never sets
--     anything to 0 (the old stock stays and ages normally);
--   * back-off 5 min · 2ⁿ ≤ 6 h; an invalid key → "Kľúč neplatný" + one e-mail after 24 h; the activity log notes
--     connect / approve / errors / recovery / disconnect.
-- Paste this whole file into the Supabase SQL Editor once (pg_cron + pg_net on, Vault secret ppi_project_url as for
-- the other jobs). Then deploy supabase/functions/inventory-connect (Verify JWT off) with INVENTORY_TOKEN_ENCRYPTION_KEY.
-- =====================================================================================================================

-- ------------------------------------------------------------------ 1. the admin's settings

create table if not exists public.inventory_plan_settings (
  plan             text primary key check (plan in ('free', 'pro')),
  allowed          boolean not null,
  interval_minutes integer not null check (interval_minutes between 5 and 10080),
  updated_at       timestamptz not null default now()
);
insert into public.inventory_plan_settings (plan, allowed, interval_minutes) values
  ('pro', true, 15), ('free', false, 1440)
on conflict (plan) do nothing;
alter table public.inventory_plan_settings enable row level security;
revoke all on public.inventory_plan_settings from public, anon, authenticated;
grant all on public.inventory_plan_settings to service_role;

-- built = an adapter exists in inventory-connect (from the provider's official API documentation); not built = shown
-- as "Pripravujeme", never offered. min_interval_minutes = the provider's own request limit (SuperFaktúra: 1000 a day).
create table if not exists public.inventory_providers (
  code                 text primary key check (code ~ '^[a-z]{2,20}$'),
  sort                 integer not null default 0,
  built                boolean not null default false,
  enabled              boolean not null default false,
  min_interval_minutes integer not null default 0 check (min_interval_minutes between 0 and 10080),
  updated_at           timestamptz not null default now(),
  constraint inventory_providers_built check (built or not enabled)
);
insert into public.inventory_providers (code, sort, built, enabled, min_interval_minutes) values
  ('superfaktura', 1, true, true, 60),
  ('woocommerce', 2, true, true, 0),
  ('custom', 3, true, true, 0),
  ('shoptet', 4, false, false, 0),
  ('dotykacka', 5, false, false, 0)
on conflict (code) do nothing;
alter table public.inventory_providers enable row level security;
revoke all on public.inventory_providers from public, anon, authenticated;
grant all on public.inventory_providers to service_role;

-- ------------------------------------------------------------------ 2. the connection

create table if not exists public.inventory_connections (
  shop_id          uuid primary key references public.shops (id) on delete cascade,
  provider         text not null references public.inventory_providers (code),
  -- the credentials, encrypted by inventory-connect ("v1.<iv>.<data>", bound to shop + provider); never granted
  key_cipher       text not null check (key_cipher ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  -- the last 4 characters of the key, for "••••1234"
  key_hint         text check (key_hint is null or key_hint ~ '^[A-Za-z0-9]{1,4}$'),
  -- what is not secret: the shop's address at the provider, the format of a custom feed
  settings         jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  status           text not null default 'preview'
                   check (status in ('preview', 'active', 'invalid_key', 'error')),
  -- the field names the provider sends (purchase prices, suppliers, margins never: dropped in the function)
  fields           text[] not null default '{}',
  -- the preview: the first rows, no private-looking field
  sample_rows      jsonb not null default '[]'::jsonb check (jsonb_typeof(sample_rows) = 'array'),
  product_count    integer check (product_count is null or product_count >= 0),
  has_quantity     boolean not null default true,
  mapping          jsonb check (mapping is null or jsonb_typeof(mapping) = 'object'),
  mapping_status   text check (mapping_status in ('proposed', 'confirmed')),
  -- a provider without quantities: names and prices only when the owner agrees, never an availability
  publish_without_quantity boolean not null default false,
  connected_at     timestamptz not null default now(),
  key_changed_at   timestamptz not null default now(),
  approved_at      timestamptz,
  last_run_at      timestamptz,
  last_success_at  timestamptz,
  -- the newest data applied (the provider's own time when it gives one, else the fetch time)
  last_source_time timestamptz,
  last_result      jsonb,
  next_run_at      timestamptz,
  running_since    timestamptz,
  fail_count       integer not null default 0 check (fail_count >= 0),
  last_error       text check (last_error is null or length(last_error) <= 500),
  last_error_code  text check (last_error_code is null or last_error_code ~ '^[a-z_]{1,40}$'),
  invalid_since    timestamptz,
  alert_sent_at    timestamptz,
  manual_runs      timestamptz[] not null default '{}'
);
create index if not exists inventory_connections_due_idx on public.inventory_connections (next_run_at)
  where status = 'active';
alter table public.inventory_connections enable row level security;
revoke all on public.inventory_connections from public, anon, authenticated;
-- owners read their row — every column but the key
grant select (shop_id, provider, key_hint, settings, status, fields, sample_rows, product_count, has_quantity, mapping,
              mapping_status, publish_without_quantity, connected_at, key_changed_at, approved_at, last_run_at,
              last_success_at, last_source_time, last_result, next_run_at, running_since, fail_count, last_error,
              last_error_code, invalid_since, manual_runs)
  on public.inventory_connections to authenticated;
grant all on public.inventory_connections to service_role;
drop policy if exists "inventory_connections: members read" on public.inventory_connections;
create policy "inventory_connections: members read" on public.inventory_connections
  for select to authenticated using (public.is_shop_member(shop_id));

-- the import report knows where it came from
alter table public.stock_imports add column if not exists source text not null default 'file';
alter table public.stock_imports drop constraint if exists stock_imports_source_check;
alter table public.stock_imports add constraint stock_imports_source_check check (source in ('file', 'api'));

-- the activity log knows the new actions
alter table public.shop_activity drop constraint if exists shop_activity_action_check;
alter table public.shop_activity add constraint shop_activity_action_check
  check (action in ('stock_files_deleted', 'inventory_missing_removed', 'inventory_reset', 'inventory_restored',
                    'inventory_purged', 'export_review', 'export_edits', 'export_files_deleted',
                    'inventory_api_connected', 'inventory_api_key_changed', 'inventory_api_approved',
                    'inventory_api_error', 'inventory_api_recovered', 'inventory_api_disconnected'));

-- ------------------------------------------------------------------ 3. the rules

-- The plan's rule for a shop: may it connect, how often is it pulled (the provider's minimum on top).
create or replace function public.inventory_plan_for(p_shop_id uuid)
returns table (plan text, allowed boolean, interval_minutes integer)
language sql
stable
security definer
set search_path = ''
as $$
  select ps.plan, ps.allowed, ps.interval_minutes
  from public.inventory_plan_settings ps
  where ps.plan = case when public.shop_has_plan(p_shop_id) then 'pro' else 'free' end
$$;
revoke execute on function public.inventory_plan_for(uuid) from public, anon, authenticated;
grant execute on function public.inventory_plan_for(uuid) to service_role;

create or replace function public.inventory_interval(p_shop_id uuid, p_provider text)
returns interval
language sql
stable
security definer
set search_path = ''
as $$
  select make_interval(mins => greatest(
    coalesce((select p.interval_minutes from public.inventory_plan_for(p_shop_id) p), 1440),
    coalesce((select pr.min_interval_minutes from public.inventory_providers pr where pr.code = p_provider), 0)))
$$;
revoke execute on function public.inventory_interval(uuid, text) from public, anon, authenticated;
grant execute on function public.inventory_interval(uuid, text) to service_role;

-- A mapping of the API's fields: known keys only, each an API field, never a private-looking one; Kód, Názov and
-- Predajná cena always; the quantity unless the owner publishes without quantities.
create or replace function public.inventory_mapping_ok(p_mapping jsonb, p_fields text[], p_without_quantity boolean)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_mapping) = 'object'
    and not exists (
      select 1 from jsonb_each(p_mapping) e
      where e.key not in ('source_code', 'name', 'ean', 'brand', 'quantity', 'price', 'currency', 'description', 'category')
         or (jsonb_typeof(e.value) <> 'null'
             and (jsonb_typeof(e.value) <> 'string' or not (e.value #>> '{}') = any (p_fields)
                  or public.is_private_column(e.value #>> '{}'))))
    and coalesce(p_mapping ->> 'source_code', '') <> ''
    and coalesce(p_mapping ->> 'name', '') <> ''
    and coalesce(p_mapping ->> 'price', '') <> ''
    and (p_without_quantity or coalesce(p_mapping ->> 'quantity', '') <> '')
$$;

-- ------------------------------------------------------------------ 4. what the owner does

-- The card on "Priečinok s exportom": the providers, the plan's rule, the connection without its key.
create or replace function public.owner_inventory_api(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_plan record;
  v_conn public.inventory_connections;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  select * into v_plan from public.inventory_plan_for(p_shop_id);
  select * into v_conn from public.inventory_connections where shop_id = p_shop_id;
  return jsonb_build_object(
    'plan', v_plan.plan,
    'allowed', coalesce(v_plan.allowed, false),
    'interval_minutes', extract(epoch from public.inventory_interval(p_shop_id, coalesce(v_conn.provider, '')))::int / 60,
    'providers', (select coalesce(jsonb_agg(jsonb_build_object('code', p.code, 'available', p.built and p.enabled,
                                                               'min_interval_minutes', p.min_interval_minutes)
                                            order by p.sort), '[]'::jsonb)
                  from public.inventory_providers p),
    'connection', case when v_conn.shop_id is null then null else jsonb_build_object(
      'provider', v_conn.provider, 'key_hint', v_conn.key_hint, 'settings', v_conn.settings, 'status', v_conn.status,
      'fields', to_jsonb(v_conn.fields), 'sample_rows', v_conn.sample_rows, 'product_count', v_conn.product_count,
      'has_quantity', v_conn.has_quantity, 'mapping', v_conn.mapping, 'mapping_status', v_conn.mapping_status,
      'publish_without_quantity', v_conn.publish_without_quantity, 'connected_at', v_conn.connected_at,
      'key_changed_at', v_conn.key_changed_at, 'approved_at', v_conn.approved_at, 'last_run_at', v_conn.last_run_at,
      'last_success_at', v_conn.last_success_at, 'last_result', v_conn.last_result,
      'next_run_at', case when v_conn.status = 'active' then v_conn.next_run_at end,
      'running', v_conn.running_since is not null and v_conn.running_since > now() - interval '15 minutes',
      'last_error', v_conn.last_error, 'last_error_code', v_conn.last_error_code,
      'manual_left', greatest(0, 4 - (select count(*) from unnest(v_conn.manual_runs) r where r > now() - interval '1 hour')))
    end);
end;
$$;
revoke execute on function public.owner_inventory_api(uuid) from public, anon;
grant execute on function public.owner_inventory_api(uuid) to authenticated;

-- "Schváliť a spustiť": the owner approves the mapping once; only then is anything published.
create or replace function public.owner_inventory_approve(p_shop_id uuid, p_mapping jsonb, p_without_quantity boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.inventory_connections;
  v_without boolean;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  select * into v_conn from public.inventory_connections where shop_id = p_shop_id for update;
  if not found then
    raise exception 'not_connected' using errcode = 'P0002';
  end if;
  if v_conn.status = 'invalid_key' then
    raise exception 'invalid_key' using errcode = '22023';
  end if;
  -- without quantities only where the provider really sends none (never to hide a missing column)
  v_without := coalesce(p_without_quantity, false) and not v_conn.has_quantity;
  if not public.inventory_mapping_ok(p_mapping, v_conn.fields, v_without) then
    raise exception 'mapping' using errcode = '22023';
  end if;
  update public.inventory_connections set
    mapping = (select jsonb_object_agg(e.key, e.value) from jsonb_each(p_mapping) e where jsonb_typeof(e.value) = 'string'),
    mapping_status = 'confirmed', publish_without_quantity = v_without, approved_at = now(),
    status = 'active', next_run_at = now(), fail_count = 0, last_error = null, last_error_code = null
  where shop_id = p_shop_id;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'inventory_api_approved',
          jsonb_build_object('provider', v_conn.provider, 'without_quantity', v_without));
end;
$$;
revoke execute on function public.owner_inventory_approve(uuid, jsonb, boolean) from public, anon;
grant execute on function public.owner_inventory_approve(uuid, jsonb, boolean) to authenticated;

-- "Synchronizovať teraz": at most 4 times an hour; the function runs it at once.
create or replace function public.owner_inventory_sync_now(p_shop_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.inventory_connections;
  v_recent timestamptz[];
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  select * into v_conn from public.inventory_connections where shop_id = p_shop_id for update;
  if not found then
    raise exception 'not_connected' using errcode = 'P0002';
  end if;
  if v_conn.status <> 'active' or v_conn.mapping_status is distinct from 'confirmed' then
    raise exception 'not_active' using errcode = '22023';
  end if;
  select coalesce(array_agg(r order by r), '{}') into v_recent from unnest(v_conn.manual_runs) r where r > now() - interval '1 hour';
  if cardinality(v_recent) >= 4 then
    raise exception 'too_many' using errcode = '54000';
  end if;
  update public.inventory_connections set manual_runs = v_recent || now(), next_run_at = now() where shop_id = p_shop_id;
end;
$$;
revoke execute on function public.owner_inventory_sync_now(uuid) from public, anon;
grant execute on function public.owner_inventory_sync_now(uuid) to authenticated;

-- "Odpojiť": the key (and everything fetched with it) is deleted at once; folder sync and uploads work again.
create or replace function public.owner_inventory_disconnect(p_shop_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider text;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  delete from public.inventory_connections where shop_id = p_shop_id returning provider into v_provider;
  if v_provider is not null then
    insert into public.shop_activity (shop_id, actor, action, details)
    values (p_shop_id, auth.uid(), 'inventory_api_disconnected', jsonb_build_object('provider', v_provider));
  end if;
end;
$$;
revoke execute on function public.owner_inventory_disconnect(uuid) from public, anon;
grant execute on function public.owner_inventory_disconnect(uuid) to authenticated;

-- The function asks before it tests a key: the caller's shop, the plan's rule, the provider switched on.
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

-- ------------------------------------------------------------------ 5. one stock source per shop

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

-- ------------------------------------------------------------------ 6. what only inventory-connect does (service role)

-- A tested key: a new connection waits for the preview's approval; a new key for the same provider keeps the mapping.
create or replace function public.inventory_save_connection(p_shop_id uuid, p_provider text, p_cipher text,
                                                            p_hint text, p_settings jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.inventory_connections;
begin
  select * into v_old from public.inventory_connections where shop_id = p_shop_id for update;
  if found and v_old.provider = p_provider then
    update public.inventory_connections set
      key_cipher = p_cipher, key_hint = p_hint, settings = coalesce(p_settings, '{}'::jsonb), key_changed_at = now(),
      status = case when v_old.mapping_status = 'confirmed' then 'active' else 'preview' end,
      next_run_at = case when v_old.mapping_status = 'confirmed' then now() else null end,
      fail_count = 0, last_error = null, last_error_code = null, invalid_since = null, alert_sent_at = null
    where shop_id = p_shop_id;
    insert into public.shop_activity (shop_id, action, details)
    values (p_shop_id, 'inventory_api_key_changed', jsonb_build_object('provider', p_provider));
  else
    delete from public.inventory_connections where shop_id = p_shop_id;
    insert into public.inventory_connections (shop_id, provider, key_cipher, key_hint, settings)
    values (p_shop_id, p_provider, p_cipher, p_hint, coalesce(p_settings, '{}'::jsonb));
    insert into public.shop_activity (shop_id, action, details)
    values (p_shop_id, 'inventory_api_connected', jsonb_build_object('provider', p_provider));
  end if;
end;
$$;
revoke execute on function public.inventory_save_connection(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.inventory_save_connection(uuid, text, text, text, jsonb) to service_role;

-- The preview after a fetch: fields, first rows (the function already dropped private-looking fields), count.
-- A confirmed mapping whose fields changed goes back to the owner (never approved by itself).
create or replace function public.inventory_save_preview(p_shop_id uuid, p_fields text[], p_sample jsonb, p_count integer,
                                                         p_has_quantity boolean, p_proposal jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.inventory_connections;
  v_fields text[];
  v_changed boolean;
begin
  select * into v_conn from public.inventory_connections where shop_id = p_shop_id for update;
  if not found then return 'not_connected'; end if;
  select coalesce(array_agg(f order by f), '{}') into v_fields
  from unnest(p_fields) f where not public.is_private_column(f);
  v_changed := v_conn.mapping_status = 'confirmed'
    and (v_conn.fields is distinct from v_fields
         or not public.inventory_mapping_ok(v_conn.mapping, v_fields, v_conn.publish_without_quantity));
  update public.inventory_connections set
    fields = v_fields,
    sample_rows = (select coalesce(jsonb_agg(public.keep_columns(r.value, v_fields) order by r.ord), '[]'::jsonb)
                   from jsonb_array_elements(case when jsonb_typeof(p_sample) = 'array' then p_sample else '[]' end)
                        with ordinality r(value, ord) where r.ord <= 5),
    product_count = p_count,
    has_quantity = coalesce(p_has_quantity, true),
    mapping = case when v_conn.mapping_status = 'confirmed' and not v_changed then v_conn.mapping else p_proposal end,
    mapping_status = case when v_conn.mapping_status = 'confirmed' and not v_changed then 'confirmed' else 'proposed' end,
    status = case when v_conn.status = 'active' and v_changed then 'preview' else v_conn.status end
  where shop_id = p_shop_id;
  return case when v_changed then 'changed' else 'ok' end;
end;
$$;
revoke execute on function public.inventory_save_preview(uuid, text[], jsonb, integer, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.inventory_save_preview(uuid, text[], jsonb, integer, boolean, jsonb) to service_role;

-- The encrypted key, for the function only.
create or replace function public.inventory_key(p_shop_id uuid)
returns table (provider text, key_cipher text, settings jsonb, mapping jsonb, mapping_status text,
               publish_without_quantity boolean, last_source_time timestamptz, status text, fields text[])
language sql
stable
security definer
set search_path = ''
as $$
  select c.provider, c.key_cipher, c.settings, c.mapping, c.mapping_status, c.publish_without_quantity,
         c.last_source_time, c.status, c.fields
  from public.inventory_connections c where c.shop_id = p_shop_id
$$;
revoke execute on function public.inventory_key(uuid) from public, anon, authenticated;
grant execute on function public.inventory_key(uuid) to service_role;

-- The runs that are due (or one shop's "Synchronizovať teraz"), claimed so no run starts twice; a run still going on
-- (claimed in the last 15 minutes) is skipped.
create or replace function public.inventory_claim(p_limit integer default 10, p_shop_id uuid default null)
returns table (shop_id uuid, provider text, shop_country text)
language sql
volatile
security definer
set search_path = ''
as $$
  with due as (
    select c.shop_id
    from public.inventory_connections c
    join public.shops s on s.id = c.shop_id and s.is_active
    join public.inventory_providers p on p.code = c.provider and p.built and p.enabled
    where c.status = 'active' and c.mapping_status = 'confirmed'
      and (p_shop_id is null or c.shop_id = p_shop_id)
      and coalesce(c.next_run_at, now()) <= now()
      and (c.running_since is null or c.running_since < now() - interval '15 minutes')
      and coalesce((select pl.allowed from public.inventory_plan_for(c.shop_id) pl), false)
    order by c.next_run_at nulls first
    limit least(greatest(coalesce(p_limit, 10), 1), 50)
    for update of c skip locked
  )
  update public.inventory_connections c set running_since = now(), last_run_at = now()
  from due, public.shops s
  where c.shop_id = due.shop_id and s.id = c.shop_id
  returning c.shop_id, c.provider, s.country
$$;
revoke execute on function public.inventory_claim(integer, uuid) from public, anon, authenticated;
grant execute on function public.inventory_claim(integer, uuid) to service_role;

-- Applies a COMPLETE snapshot (the function proved it: all pages, the provider's total, no error) through
-- apply_stock_file(); data not newer than the last applied is refused ('older').
create or replace function public.inventory_apply(p_shop_id uuid, p_rows jsonb, p_source_time timestamptz, p_sample jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.inventory_connections;
  v_result jsonb;
  v_changed integer;
begin
  select * into v_conn from public.inventory_connections where shop_id = p_shop_id for update;
  if not found or v_conn.status <> 'active' or v_conn.mapping_status <> 'confirmed' then
    return jsonb_build_object('status', 'not_active');
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    -- an empty result is never "everything sold out"
    return jsonb_build_object('status', 'empty');
  end if;
  if v_conn.last_source_time is not null and p_source_time <= v_conn.last_source_time then
    return jsonb_build_object('status', 'older');
  end if;
  insert into public.sync_sources (shop_id) values (p_shop_id) on conflict (shop_id) do nothing;
  -- "Y zmien": items that are new or whose price (or quantity) differs from what visitors see now
  select count(*) into v_changed
  from jsonb_to_recordset(p_rows) as r(source_code text, quantity numeric, price numeric)
  where not exists (
    select 1 from public.shop_items si join public.inventory inv on inv.shop_item_id = si.id
    where si.shop_id = p_shop_id and si.source_code = left(trim(r.source_code), 100)
      and inv.price is not distinct from r.price
      and (v_conn.publish_without_quantity or inv.quantity = coalesce(r.quantity, 0)));
  if v_conn.publish_without_quantity then
    -- names and prices only; quantities untouched and the shop's freshness not renewed: no availability is shown
    v_result := public.inventory_apply_prices(p_shop_id, p_rows);
  else
    v_result := public.apply_stock_file(p_shop_id, p_rows, p_source_time, p_sample);
  end if;
  update public.sync_sources set last_file_name = 'API · ' || v_conn.provider where shop_id = p_shop_id;
  update public.inventory_connections set last_source_time = p_source_time where shop_id = p_shop_id;
  return jsonb_build_object('status', 'updated', 'changed', v_changed + coalesce((v_result ->> 'zeroed')::int, 0)) || v_result;
end;
$$;
revoke execute on function public.inventory_apply(uuid, jsonb, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.inventory_apply(uuid, jsonb, timestamptz, jsonb) to service_role;

-- Names and prices of a provider without quantities: new items start at 0 (sold out is never claimed — the shop's
-- data time is not renewed, so the page shows no availability), existing quantities are left as they are.
create or replace function public.inventory_apply_prices(p_shop_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_items integer;
begin
  insert into public.shop_items (shop_id, source_code, name, ean, brand, updated_at)
  select distinct on (left(trim(r.source_code), 100)) p_shop_id, left(trim(r.source_code), 100), left(trim(r.name), 300),
         nullif(left(trim(r.ean), 32), ''), nullif(left(trim(r.brand), 100), ''), now()
  from jsonb_to_recordset(p_rows) as r(source_code text, name text, ean text, brand text)
  where nullif(trim(r.source_code), '') is not null and nullif(trim(r.name), '') is not null
  order by left(trim(r.source_code), 100)
  on conflict (shop_id, source_code) do update set name = excluded.name, ean = excluded.ean, brand = excluded.brand,
    updated_at = now();
  get diagnostics v_items = row_count;
  insert into public.inventory (shop_item_id, quantity, price, currency, received_at)
  select si.id, 0, r.price, upper(coalesce(nullif(trim(r.currency), ''), 'EUR')), now()
  from jsonb_to_recordset(p_rows) as r(source_code text, price numeric, currency text)
  join public.shop_items si on si.shop_id = p_shop_id and si.source_code = left(trim(r.source_code), 100)
  where r.price is not null
  on conflict (shop_item_id) do update set price = excluded.price, currency = excluded.currency, received_at = now();
  return jsonb_build_object('items', v_items, 'zeroed', 0);
end;
$$;
revoke execute on function public.inventory_apply_prices(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.inventory_apply_prices(uuid, jsonb) to service_role;

-- The run's end: success, a warning (incomplete data: nothing applied, the old stock stays) or a failure with
-- back-off (5 min · 2ⁿ, at most 6 h; the provider's Retry-After when longer). An invalid key stops the runs.
create or replace function public.inventory_finish(p_shop_id uuid, p_outcome jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn public.inventory_connections;
  v_kind text := p_outcome ->> 'kind';
  v_code text := nullif(p_outcome ->> 'code', '');
  v_retry integer := nullif(p_outcome ->> 'retry_after', '')::integer;
  v_wait interval;
begin
  select * into v_conn from public.inventory_connections where shop_id = p_shop_id for update;
  if not found then return; end if;
  if v_kind in ('ok', 'warning') then
    update public.inventory_connections set
      running_since = null,
      last_success_at = case when v_kind = 'ok' then now() else last_success_at end,
      last_result = p_outcome - 'kind',
      fail_count = 0,
      last_error = case when v_kind = 'warning' then left(p_outcome ->> 'message', 500) end,
      last_error_code = case when v_kind = 'warning' then v_code end,
      invalid_since = null,
      next_run_at = now() + public.inventory_interval(p_shop_id, provider)
    where shop_id = p_shop_id;
    if v_conn.fail_count > 0 or v_conn.status = 'error' then
      insert into public.shop_activity (shop_id, action, details)
      values (p_shop_id, 'inventory_api_recovered', jsonb_build_object('provider', v_conn.provider));
    end if;
  elsif v_code = 'invalid_key' then
    update public.inventory_connections set
      running_since = null, status = 'invalid_key', last_error = left(p_outcome ->> 'message', 500),
      last_error_code = 'invalid_key', invalid_since = coalesce(invalid_since, now()), next_run_at = null,
      fail_count = fail_count + 1
    where shop_id = p_shop_id;
    if v_conn.status <> 'invalid_key' then
      insert into public.shop_activity (shop_id, action, details)
      values (p_shop_id, 'inventory_api_error', jsonb_build_object('provider', v_conn.provider, 'code', 'invalid_key'));
    end if;
  else
    v_wait := least(interval '6 hours', interval '5 minutes' * power(2, least(v_conn.fail_count, 10)));
    if v_retry is not null and make_interval(secs => v_retry) > v_wait then
      v_wait := least(interval '24 hours', make_interval(secs => v_retry));
    end if;
    update public.inventory_connections set
      running_since = null, last_error = left(p_outcome ->> 'message', 500), last_error_code = coalesce(v_code, 'failed'),
      fail_count = fail_count + 1, next_run_at = now() + v_wait
    where shop_id = p_shop_id;
    if v_conn.fail_count = 0 then
      insert into public.shop_activity (shop_id, action, details)
      values (p_shop_id, 'inventory_api_error', jsonb_build_object('provider', v_conn.provider, 'code', coalesce(v_code, 'failed')));
    end if;
  end if;
end;
$$;
revoke execute on function public.inventory_finish(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.inventory_finish(uuid, jsonb) to service_role;

-- A test of the key from "Otestovať pripojenie" or a fetch for the preview: only its status.
create or replace function public.inventory_key_state(p_shop_id uuid, p_valid boolean, p_message text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.inventory_connections set
    status = case when p_valid then (case when status = 'invalid_key' then
                                            case when mapping_status = 'confirmed' then 'active' else 'preview' end
                                          else status end)
                  else 'invalid_key' end,
    invalid_since = case when p_valid then null else coalesce(invalid_since, now()) end,
    last_error = case when p_valid then (case when last_error_code = 'invalid_key' then null else last_error end)
                      else left(p_message, 500) end,
    last_error_code = case when p_valid then (case when last_error_code = 'invalid_key' then null else last_error_code end)
                           else 'invalid_key' end,
    next_run_at = case when p_valid and status = 'invalid_key' and mapping_status = 'confirmed' then now()
                       when p_valid then next_run_at else null end
  where shop_id = p_shop_id
$$;
revoke execute on function public.inventory_key_state(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.inventory_key_state(uuid, boolean, text) to service_role;

-- The report of a run in "Posledné nahrané súbory" (source 'api'; the approved fields' first 5 rows; last 10 kept).
create or replace function public.inventory_record_import(p_shop_id uuid, p_name text, p_source_time timestamptz,
                                                          p_status text, p_total integer, p_imported integer,
                                                          p_zeroed integer, p_skipped integer, p_error text, p_rows jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cols text[];
  v_id bigint;
begin
  if p_status is null or p_status not in ('ok', 'errors', 'waiting') then
    raise exception 'Unknown import status' using errcode = '22023';
  end if;
  select public.mapped_columns(c.mapping) into v_cols
  from public.inventory_connections c where c.shop_id = p_shop_id and c.mapping_status = 'confirmed';
  v_cols := coalesce(v_cols, '{}'::text[]);
  insert into public.stock_imports (shop_id, file_name, file_time, status, total_rows, imported, zeroed, skipped,
                                    error, columns, preview, source)
  values (p_shop_id, left(p_name, 200), p_source_time, p_status, greatest(coalesce(p_total, 0), 0),
          greatest(coalesce(p_imported, 0), 0), greatest(coalesce(p_zeroed, 0), 0), greatest(coalesce(p_skipped, 0), 0),
          left(p_error, 500), v_cols,
          (select coalesce(jsonb_agg(public.keep_columns(r.value, v_cols) order by r.ord), '[]'::jsonb)
           from jsonb_array_elements(case when jsonb_typeof(p_rows) = 'array' then p_rows else '[]'::jsonb end)
                with ordinality r(value, ord)
           where r.ord <= 5 and cardinality(v_cols) > 0), 'api')
  returning id into v_id;
  delete from public.stock_imports
  where shop_id = p_shop_id
    and id not in (select i.id from public.stock_imports i where i.shop_id = p_shop_id
                   order by i.received_at desc, i.id desc limit 10);
  return v_id;
end;
$$;
revoke execute on function public.inventory_record_import(uuid, text, timestamptz, text, integer, integer, integer, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.inventory_record_import(uuid, text, timestamptz, text, integer, integer, integer, integer, text, jsonb)
  to service_role;

-- "Kľúč neplatný" for 24 hours: one e-mail to the shop's owners.
create or replace function public.inventory_alerts_due()
returns table (shop_id uuid, shop_name text, shop_slug text, provider text, invalid_since timestamptz, emails text[])
language sql
stable
security definer
set search_path = ''
as $$
  select c.shop_id, s.name, s.slug, c.provider, c.invalid_since,
         coalesce((select array_agg(u.email::text order by u.email) from public.shop_members m
                   join auth.users u on u.id = m.user_id
                   where m.shop_id = c.shop_id and u.email is not null), '{}')
  from public.inventory_connections c
  join public.shops s on s.id = c.shop_id
  where c.status = 'invalid_key' and c.invalid_since <= now() - interval '24 hours'
    and (c.alert_sent_at is null or c.alert_sent_at < c.invalid_since)
$$;
revoke execute on function public.inventory_alerts_due() from public, anon, authenticated;
grant execute on function public.inventory_alerts_due() to service_role;

create or replace function public.inventory_alert_sent(p_shop_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.inventory_connections set alert_sent_at = now() where shop_id = p_shop_id
$$;
revoke execute on function public.inventory_alert_sent(uuid) from public, anon, authenticated;
grant execute on function public.inventory_alert_sent(uuid) to service_role;

-- ------------------------------------------------------------------ 7. the admin

create or replace function public.admin_inventory_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'plans', (select jsonb_agg(jsonb_build_object('plan', p.plan, 'allowed', p.allowed, 'interval_minutes', p.interval_minutes)
                               order by p.plan desc) from public.inventory_plan_settings p),
    'providers', (select jsonb_agg(jsonb_build_object('code', p.code, 'built', p.built, 'enabled', p.enabled,
                                                      'min_interval_minutes', p.min_interval_minutes,
                                                      'connections', (select count(*) from public.inventory_connections c where c.provider = p.code))
                                   order by p.sort) from public.inventory_providers p),
    -- no key, no key hint: shop, provider, state and the last error in plain words
    'connections', (select coalesce(jsonb_agg(jsonb_build_object('shop', s.name, 'slug', s.slug, 'timezone', s.timezone, 'provider', c.provider,
                                                                 'status', c.status, 'last_success_at', c.last_success_at,
                                                                 'fail_count', c.fail_count, 'last_error', c.last_error,
                                                                 'connected_at', c.connected_at)
                                              order by c.status, s.name), '[]'::jsonb)
                    from public.inventory_connections c join public.shops s on s.id = c.shop_id));
end;
$$;
revoke execute on function public.admin_inventory_overview() from public, anon;
grant execute on function public.admin_inventory_overview() to authenticated;

create or replace function public.admin_save_inventory_settings(p_pro_interval integer, p_free_allowed boolean, p_free_interval integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if p_pro_interval is null or p_pro_interval not between 5 and 10080
     or p_free_interval is null or p_free_interval not between 5 and 10080 then
    raise exception 'interval' using errcode = '22023';
  end if;
  update public.inventory_plan_settings set interval_minutes = p_pro_interval, updated_at = now() where plan = 'pro';
  update public.inventory_plan_settings set allowed = coalesce(p_free_allowed, false), interval_minutes = p_free_interval,
    updated_at = now() where plan = 'free';
end;
$$;
revoke execute on function public.admin_save_inventory_settings(integer, boolean, integer) from public, anon;
grant execute on function public.admin_save_inventory_settings(integer, boolean, integer) to authenticated;

create or replace function public.admin_set_inventory_provider(p_code text, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  update public.inventory_providers set enabled = coalesce(p_enabled, false) and built, updated_at = now()
  where code = p_code;
  if not found then
    raise exception 'provider' using errcode = '22023';
  end if;
end;
$$;
revoke execute on function public.admin_set_inventory_provider(text, boolean) from public, anon;
grant execute on function public.admin_set_inventory_provider(text, boolean) to authenticated;

-- ------------------------------------------------------------------ 8. the 5-minute job

create or replace function public.inventory_cron_ok(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(length(p_secret) >= 32 and exists (
    select 1 from vault.decrypted_secrets
    where name = 'ppi_inventory_cron'
      and encode(sha256(convert_to(decrypted_secret, 'UTF8')), 'hex')
          = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')), false)
$$;
revoke execute on function public.inventory_cron_ok(text) from public, anon, authenticated;
grant execute on function public.inventory_cron_ok(text) to service_role;

do $$
begin
  if to_regclass('vault.secrets') is not null
     and not exists (select 1 from vault.secrets where name = 'ppi_inventory_cron') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      'ppi_inventory_cron', 'PPI: the inventory job proves itself to the inventory-connect function');
  end if;
end;
$$;

do $$
begin
  if to_regnamespace('cron') is null or to_regnamespace('net') is null then
    raise notice 'pg_cron is not on: switch on pg_cron and pg_net (Database → Extensions), then run this file again.';
    return;
  end if;
  perform cron.schedule('ppi-inventory-tick', '*/5 * * * *', $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_project_url') || '/functions/v1/inventory-connect',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'x-ppi-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_inventory_cron')),
      body := '{"action":"tick"}'::jsonb,
      timeout_milliseconds := 120000)$job$);
end;
$$;
