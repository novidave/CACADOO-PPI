-- PPI · 11 · Stock pull: apply a shop's stock file, tunnel credentials in Vault,
-- raw-file storage. Used by the "stock-pull" Edge Function (service role only).

-- Apply one complete stock file in one transaction:
--  * upsert every row into shop_items + inventory (keyed by the shop's item code)
--  * items of this shop that are NOT in the file are set to quantity 0
--    (the export is a full list, so a missing item is no longer in stock)
--  * link items to products by EAN
--  * record the file time (= freshness), clear the last error, keep 10 sample rows
-- p_rows: [{"source_code","name","ean","brand","quantity","price","currency"}, ...]
create or replace function public.apply_stock_file(
  p_shop_id uuid,
  p_rows jsonb,
  p_file_time timestamptz,
  p_sample jsonb default null
)
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

  drop table if exists pull_rows;
  create temporary table pull_rows on commit drop as
  select distinct on (r.source_code)
    left(trim(r.source_code), 100)           as source_code,
    left(trim(r.name), 300)                  as name,
    nullif(left(trim(r.ean), 32), '')        as ean,
    nullif(left(trim(r.brand), 100), '')     as brand,
    r.quantity                               as quantity,
    r.price                                  as price,
    upper(coalesce(nullif(trim(r.currency), ''), 'EUR')) as currency
  from jsonb_to_recordset(p_rows) as r(
    source_code text, name text, ean text, brand text,
    quantity numeric, price numeric, currency text
  )
  where nullif(trim(r.source_code), '') is not null
    and nullif(trim(r.name), '') is not null
  order by r.source_code;

  -- Products by EAN (shared across shops; "also available at").
  insert into public.products (ean, name, brand)
  select distinct on (p.ean) p.ean, p.name, p.brand
  from pull_rows p
  where p.ean is not null
  order by p.ean
  on conflict (ean) do nothing;

  insert into public.shop_items (shop_id, source_code, name, ean, brand, product_id, updated_at)
  select p_shop_id, p.source_code, p.name, p.ean, p.brand,
         (select pr.id from public.products pr where pr.ean = p.ean), now()
  from pull_rows p
  on conflict (shop_id, source_code) do update set
    name = excluded.name,
    ean = excluded.ean,
    brand = excluded.brand,
    product_id = excluded.product_id,
    updated_at = now();
  get diagnostics v_items = row_count;

  insert into public.inventory (shop_item_id, quantity, price, currency, source_updated_at, received_at)
  select si.id, coalesce(p.quantity, 0), p.price, p.currency, p_file_time, now()
  from pull_rows p
  join public.shop_items si on si.shop_id = p_shop_id and si.source_code = p.source_code
  on conflict (shop_item_id) do update set
    quantity = excluded.quantity,
    price = excluded.price,
    currency = excluded.currency,
    source_updated_at = excluded.source_updated_at,
    received_at = excluded.received_at;

  update public.inventory inv
  set quantity = 0, source_updated_at = p_file_time, received_at = now()
  from public.shop_items si
  where si.id = inv.shop_item_id
    and si.shop_id = p_shop_id
    and inv.quantity <> 0
    and not exists (select 1 from pull_rows p where p.source_code = si.source_code);
  get diagnostics v_zeroed = row_count;

  update public.sync_sources
  set latest_file_time = p_file_time,
      last_checked_at = now(),
      last_error = null,
      sample_rows = coalesce(p_sample, sample_rows)
  where shop_id = p_shop_id;

  return jsonb_build_object('items', v_items, 'zeroed', v_zeroed);
end;
$$;

revoke execute on function public.apply_stock_file(uuid, jsonb, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.apply_stock_file(uuid, jsonb, timestamptz, jsonb) to service_role;

-- Tunnel credentials per shop live in Supabase Vault (encrypted), one secret per
-- shop: {"cf_client_id","cf_client_secret","basic_user","basic_password"}.
create or replace function public.sync_secret_name(p_shop_id uuid)
returns text
language sql
immutable
set search_path = ''
as $$ select 'ppi_shop_' || p_shop_id::text $$;

-- Admin saves credentials (write-only: they are never shown again).
create or replace function public.admin_set_sync_credentials(p_shop_id uuid, p_credentials jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing uuid;
  v_clean jsonb;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if not exists (select 1 from public.shops where id = p_shop_id) then
    raise exception 'Shop not found' using errcode = 'P0002';
  end if;
  v_clean := jsonb_strip_nulls(jsonb_build_object(
    'cf_client_id',     nullif(trim(p_credentials ->> 'cf_client_id'), ''),
    'cf_client_secret', nullif(trim(p_credentials ->> 'cf_client_secret'), ''),
    'basic_user',       nullif(trim(p_credentials ->> 'basic_user'), ''),
    'basic_password',   nullif(p_credentials ->> 'basic_password', '')
  ));
  select id into v_existing from vault.secrets where name = public.sync_secret_name(p_shop_id);
  if v_existing is null then
    perform vault.create_secret(v_clean::text, public.sync_secret_name(p_shop_id), 'PPI stock pull credentials');
  else
    perform vault.update_secret(v_existing, v_clean::text);
  end if;
end;
$$;

revoke execute on function public.admin_set_sync_credentials(uuid, jsonb) from public, anon;
grant execute on function public.admin_set_sync_credentials(uuid, jsonb) to authenticated;

-- Admin sees only WHICH credentials are set, never their values.
create or replace function public.admin_sync_credentials_status(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_secret jsonb;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  select decrypted_secret::jsonb into v_secret
  from vault.decrypted_secrets where name = public.sync_secret_name(p_shop_id);
  return jsonb_build_object(
    'cloudflare', v_secret ? 'cf_client_id' and v_secret ? 'cf_client_secret',
    'basic_auth', v_secret ? 'basic_user' and v_secret ? 'basic_password'
  );
end;
$$;

revoke execute on function public.admin_sync_credentials_status(uuid) from public, anon;
grant execute on function public.admin_sync_credentials_status(uuid) to authenticated;

-- The stock-pull function reads the credentials (service role only).
create or replace function public.sync_credentials(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select decrypted_secret::jsonb from vault.decrypted_secrets where name = public.sync_secret_name(p_shop_id)),
    '{}'::jsonb
  )
$$;

revoke execute on function public.sync_credentials(uuid) from public, anon, authenticated;
grant execute on function public.sync_credentials(uuid) to service_role;

-- Last raw file per shop, kept 7 days for troubleshooting. Private bucket:
-- only the service role (stock-pull) reads or writes it.
do $$
begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'storage' and c.relname = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('raw-files', 'raw-files', false, 52428800)
    on conflict (id) do nothing;
  end if;
end;
$$;
