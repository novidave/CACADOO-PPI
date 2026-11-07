-- =====================================================================================================================
-- Update 88 — "Ignorované produkty" (2026-11-07, at the owner's request; the owner's OK to change the display rule)
--
-- A product the owner removes on "Priečinok s exportom" → "Nebezpečná zóna – sklad" → "Ignorované produkty" stays away
-- although the stock file (the folder, an upload, the inventory program or the POS agent) still lists it, until the
-- owner restores it. It is on no page, in no search, the API, the MCP, the assistants or the AI search — never
-- "hidden but listed": the product row itself goes (as update 43's option A does: the backup CSV first, the product
-- into the trash with its translations, Cacaduu description and photo kept by its code).
--
--   * shop_ignored_items: shop + key (key_kind 'code' = stock_item_key(source_code), the same rule every import uses
--     to recognise a product: shop_items' unique (shop_id, source_code)); ≤ 5000 per shop; members read, nobody writes
--     but the functions below.
--   * Every import skips ignored keys FIRST: apply_stock_file (the folder, uploads, the inventory program),
--     inventory_apply_prices, connector_apply_rows / connector_snapshot_settle (the POS agent), apply_shop_translations
--     (a stock file in another language). Skipped rows are not errors: never in the > 5 % unreadable-rows rule (that
--     rule counts unreadable rows in stock-pull, before SQL) nor in the agent's "fewer than half" rule (the count
--     without ignored rows). The guard trigger shop_items_ignored_guard keeps every other writer out too.
--   * stock_imports.ignored_count: "Ignorované: n" on the import cards.
--   * owner_ignore_items / owner_unignore_items / owner_ignore_undo (the toast's "Späť", 10 minutes, before the next
--     file) / owner_ignore_candidates / owner_ignored_items. A shop whose stock source is "Sklad v Cacaduu" is refused
--     `sklad_source` (the owner deletes products there).
--   * The owner MCP's update_stock on an ignored product: `ignored`.
-- Nothing is deleted from the database by this file itself; it only adds a table, columns and functions.
-- =====================================================================================================================

-- the activity log: the two new actions
do $$
declare
  v_def text := (select pg_get_constraintdef(c.oid) from pg_constraint c
                 where c.conrelid = 'public.shop_activity'::regclass and c.conname = 'shop_activity_action_check');
begin
  if v_def is not null and position('''items_ignored''' in v_def) = 0 then
    alter table public.shop_activity drop constraint shop_activity_action_check;
    execute 'alter table public.shop_activity add constraint shop_activity_action_check '
            || replace(v_def, 'ARRAY[', 'ARRAY[''items_ignored''::text, ''items_unignored''::text, ');
  end if;
end;
$$;

-- ------------------------------------------------------------------ 1. the key and the table

/** How a product of a stock source is recognised: its code, trimmed, ≤ 100 characters (shop_items.source_code). */
create or replace function public.stock_item_key(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(left(trim(coalesce(p_code, '')), 100), '')
$$;
grant execute on function public.stock_item_key(text) to anon, authenticated, service_role;

create table if not exists public.shop_ignored_items (
  shop_id    uuid not null references public.shops (id) on delete cascade,
  key_kind   text not null default 'code' check (key_kind in ('code')),
  key_value  text not null check (char_length(key_value) between 1 and 100),
  name       text check (name is null or char_length(name) <= 300),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  primary key (shop_id, key_kind, key_value)
);
alter table public.shop_ignored_items enable row level security;
revoke all on public.shop_ignored_items from public, anon, authenticated;
grant select on public.shop_ignored_items to authenticated;
grant all on public.shop_ignored_items to service_role;
drop policy if exists "shop_ignored_items: members read" on public.shop_ignored_items;
create policy "shop_ignored_items: members read" on public.shop_ignored_items
  for select to authenticated using (public.is_shop_member(shop_id));

/** Is this code of this shop ignored? */
create or replace function public.stock_item_ignored(p_shop_id uuid, p_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.shop_ignored_items i
                 where i.shop_id = p_shop_id and i.key_kind = 'code' and i.key_value = public.stock_item_key(p_code))
$$;
revoke execute on function public.stock_item_ignored(uuid, text) from public, anon, authenticated;

/** Rows of a preview or sample (column names as the file has them) without the ignored products' rows. */
create or replace function public.stock_rows_without_ignored(p_shop_id uuid, p_rows jsonb, p_code_column text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_rows) is distinct from 'array' or nullif(p_code_column, '') is null then p_rows
    else coalesce((select jsonb_agg(r.value order by r.ord)
                   from jsonb_array_elements(p_rows) with ordinality r(value, ord)
                   where jsonb_typeof(r.value) <> 'object'
                      or not public.stock_item_ignored(p_shop_id, r.value ->> p_code_column)), '[]'::jsonb)
  end
$$;
revoke execute on function public.stock_rows_without_ignored(uuid, jsonb, text) from public, anon, authenticated;

alter table public.stock_imports add column if not exists ignored_count integer not null default 0;
alter table public.stock_imports drop constraint if exists stock_imports_ignored_count_check;
alter table public.stock_imports add constraint stock_imports_ignored_count_check check (ignored_count >= 0);

-- The last applied file's ignored rows, for its report (record_stock_import / inventory_record_import are separate calls).
alter table public.sync_sources
  add column if not exists last_ignored integer not null default 0,
  add column if not exists last_ignored_time timestamptz;

-- update 43's removals get a third kind; an ignore never expires while its products stay ignored
alter table public.inventory_resets drop constraint if exists inventory_resets_kind_check;
alter table public.inventory_resets add constraint inventory_resets_kind_check check (kind in ('missing', 'all', 'ignored'));
-- a restored ignore's trash row keeps its translations 30 days for the product's return (null = its removal's time)
alter table public.inventory_trash add column if not exists expires_at timestamptz;

-- ------------------------------------------------------------------ 2. the guard: nothing writes an ignored product

/** Every writer of shop_items (imports, restores of older removals): an ignored code is skipped, not an error. */
create or replace function public.shop_items_ignored_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.shop_ignored_items i
             where i.shop_id = new.shop_id and i.key_kind = 'code' and i.key_value = public.stock_item_key(new.source_code))
     and public.stock_source_of(new.shop_id) <> 'sklad' then
    return null;
  end if;
  return new;
end;
$$;
revoke execute on function public.shop_items_ignored_guard() from public, anon, authenticated;
drop trigger if exists shop_items_ignored_guard on public.shop_items;
create trigger shop_items_ignored_guard before insert on public.shop_items
  for each row execute function public.shop_items_ignored_guard();

-- ------------------------------------------------------------------ 3. every import skips ignored keys first

create or replace function public.apply_stock_file(p_shop_id uuid, p_rows jsonb, p_file_time timestamptz, p_sample jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_items integer;
  v_zeroed integer;
  v_ignored integer;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'p_rows must be a JSON array' using errcode = '22023';
  end if;

  drop table if exists pull_rows;
  create temporary table pull_rows on commit drop as
  select distinct on (public.stock_item_key(r.source_code))
    public.stock_item_key(r.source_code)     as source_code,
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
  where public.stock_item_key(r.source_code) is not null
    and nullif(trim(r.name), '') is not null
  order by public.stock_item_key(r.source_code);

  -- update 88: the ignored products first (not errors; they stay away)
  delete from pull_rows p
  using public.shop_ignored_items i
  where i.shop_id = p_shop_id and i.key_kind = 'code' and i.key_value = p.source_code;
  get diagnostics v_ignored = row_count;

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

  update public.sync_sources s
  set latest_file_time = p_file_time,
      last_checked_at = now(),
      last_error = null,
      last_ignored = v_ignored,
      last_ignored_time = p_file_time,
      sample_rows = coalesce(public.stock_rows_without_ignored(p_shop_id, p_sample, s.field_mapping ->> 'source_code'),
                             sample_rows)
  where shop_id = p_shop_id;

  return jsonb_build_object('items', v_items, 'zeroed', v_zeroed, 'ignored', v_ignored);
end;
$$;
revoke execute on function public.apply_stock_file(uuid, jsonb, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.apply_stock_file(uuid, jsonb, timestamptz, jsonb) to service_role;

create or replace function public.inventory_apply_prices(p_shop_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_items integer;
  v_ignored integer;
begin
  select count(distinct public.stock_item_key(r.source_code)) into v_ignored
  from jsonb_to_recordset(p_rows) as r(source_code text)
  where public.stock_item_ignored(p_shop_id, r.source_code);
  insert into public.shop_items (shop_id, source_code, name, ean, brand, updated_at)
  select distinct on (public.stock_item_key(r.source_code)) p_shop_id, public.stock_item_key(r.source_code), left(trim(r.name), 300),
         nullif(left(trim(r.ean), 32), ''), nullif(left(trim(r.brand), 100), ''), now()
  from jsonb_to_recordset(p_rows) as r(source_code text, name text, ean text, brand text)
  where public.stock_item_key(r.source_code) is not null and nullif(trim(r.name), '') is not null
    and not public.stock_item_ignored(p_shop_id, r.source_code)
  order by public.stock_item_key(r.source_code)
  on conflict (shop_id, source_code) do update set name = excluded.name, ean = excluded.ean, brand = excluded.brand,
    updated_at = now();
  get diagnostics v_items = row_count;
  insert into public.inventory (shop_item_id, quantity, price, currency, received_at)
  select si.id, 0, r.price, upper(coalesce(nullif(trim(r.currency), ''), 'EUR')), now()
  from jsonb_to_recordset(p_rows) as r(source_code text, price numeric, currency text)
  join public.shop_items si on si.shop_id = p_shop_id and si.source_code = public.stock_item_key(r.source_code)
  where r.price is not null
  on conflict (shop_item_id) do update set price = excluded.price, currency = excluded.currency, received_at = now();
  return jsonb_build_object('items', v_items, 'zeroed', 0, 'ignored', v_ignored);
end;
$$;
revoke execute on function public.inventory_apply_prices(uuid, jsonb) from public, anon, authenticated;

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
  -- "Y zmien": items that are new or whose price (or quantity) differs from what visitors see now (ignored ones never)
  select count(*) into v_changed
  from jsonb_to_recordset(p_rows) as r(source_code text, quantity numeric, price numeric)
  where not public.stock_item_ignored(p_shop_id, r.source_code)
    and not exists (
    select 1 from public.shop_items si join public.inventory inv on inv.shop_item_id = si.id
    where si.shop_id = p_shop_id and si.source_code = public.stock_item_key(r.source_code)
      and inv.price is not distinct from r.price
      and (v_conn.publish_without_quantity or inv.quantity = coalesce(r.quantity, 0)));
  if v_conn.publish_without_quantity then
    -- names and prices only; quantities untouched and the shop's freshness not renewed: no availability is shown
    v_result := public.inventory_apply_prices(p_shop_id, p_rows);
  else
    v_result := public.apply_stock_file(p_shop_id, p_rows, p_source_time,
                                        public.stock_rows_without_ignored(p_shop_id, p_sample, v_conn.mapping ->> 'source_code'));
  end if;
  update public.sync_sources
  set last_file_name = 'API · ' || v_conn.provider,
      last_ignored = coalesce((v_result ->> 'ignored')::int, 0), last_ignored_time = p_source_time
  where shop_id = p_shop_id;
  update public.inventory_connections set last_source_time = p_source_time where shop_id = p_shop_id;
  return jsonb_build_object('status', 'updated', 'changed', v_changed + coalesce((v_result ->> 'zeroed')::int, 0)) || v_result;
end;
$$;
revoke execute on function public.inventory_apply(uuid, jsonb, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.inventory_apply(uuid, jsonb, timestamptz, jsonb) to service_role;

create or replace function public.connector_apply_rows(p_shop_id uuid, p_rows jsonb, p_keep text[], p_time timestamptz, p_label text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_items integer;
  v_zeroed integer;
  v_ignored integer;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'p_rows must be a JSON array' using errcode = '22023';
  end if;

  drop table if exists agent_rows;
  create temporary table agent_rows on commit drop as
  select distinct on (public.stock_item_key(r.source_code))
    public.stock_item_key(r.source_code)     as source_code,
    left(trim(r.name), 300)                  as name,
    nullif(left(trim(r.ean), 32), '')        as ean,
    nullif(left(trim(r.brand), 100), '')     as brand,
    r.quantity                               as quantity,
    r.price                                  as price,
    upper(trim(r.currency))                  as currency
  from jsonb_to_recordset(p_rows) as r(source_code text, name text, ean text, brand text, quantity numeric,
                                       price numeric, currency text)
  where public.stock_item_key(r.source_code) is not null
    and nullif(trim(r.name), '') is not null
    and r.price is not null
    and upper(trim(coalesce(r.currency, ''))) ~ '^[A-Z]{3}$'
  order by public.stock_item_key(r.source_code);

  -- update 88: the ignored products first
  delete from agent_rows p
  using public.shop_ignored_items i
  where i.shop_id = p_shop_id and i.key_kind = 'code' and i.key_value = p.source_code;
  get diagnostics v_ignored = row_count;

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
  set latest_file_time = p_time, last_checked_at = now(), last_error = null, last_file_name = left(p_label, 200),
      last_ignored = v_ignored, last_ignored_time = p_time
  where shop_id = p_shop_id;

  return jsonb_build_object('items', v_items, 'zeroed', v_zeroed, 'ignored', v_ignored);
end;
$$;
revoke execute on function public.connector_apply_rows(uuid, jsonb, text[], timestamptz, text) from public, anon, authenticated;

/** Update 52's settle; the products counted without the ignored ones (the "fewer than half" rule and the report). */
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
  v_ignored integer;
  v_count integer;
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
  -- update 88: the owner's ignored products are not part of the stock (never "shrinking" because of them)
  select count(distinct x.k) into v_ignored
  from (select public.stock_item_key(r.source_code) as k
        from jsonb_to_recordset(case when jsonb_typeof(p_rows) = 'array' then p_rows else '[]'::jsonb end) as r(source_code text)) x
  join public.shop_ignored_items i on i.shop_id = p_shop_id and i.key_kind = 'code' and i.key_value = x.k;
  v_count := greatest(0, v_snap.product_count - v_ignored);
  if not p_decided and (v_count = 0
      or (v_src.agent_product_count is not null and v_count * 2 < v_src.agent_product_count)) then
    -- never automatic: an empty or much smaller stock waits for the owner
    update public.connector_snapshots set state = 'held', error = case when v_count = 0 then 'empty' else 'shrinking' end,
      result = p_result, held_rows = p_rows, held_keep = p_keep, previous_count = v_src.agent_product_count,
      completed_at = now()
    where shop_id = p_shop_id and id = p_snapshot_id;
    insert into public.shop_activity (shop_id, action, details)
    values (p_shop_id, 'connector_snapshot_held',
            jsonb_build_object('snapshot', p_snapshot_id, 'products', v_count,
                               'previous', v_src.agent_product_count));
    return jsonb_build_object('state', 'held', 'reason', case when v_count = 0 then 'empty' else 'shrinking' end);
  end if;

  -- freshness: the earlier of the POS's time and the time Cacaduu received it
  v_time := least(v_snap.source_time, coalesce(v_snap.processing_at, now()));
  select d.name into v_device from public.connector_devices d where d.id = v_snap.device_id;
  v_applied := public.connector_apply_rows(p_shop_id, p_rows, p_keep, v_time, 'POS agent · ' || coalesce(v_device, '?'));
  update public.shop_stock_source set
    agent_snapshot_id = p_snapshot_id, agent_content_hash = v_snap.content_hash,
    agent_product_count = v_count, agent_source_time = v_snap.source_time, agent_applied_at = now()
  where shop_id = p_shop_id;
  update public.connector_devices set last_sync_at = now() where id = v_snap.device_id;
  update public.connector_snapshots set state = 'applied', error = null, held_rows = null, held_keep = null,
    result = coalesce(p_result, '{}'::jsonb) || jsonb_build_object('imported', (v_applied ->> 'items')::integer,
                                                                   'zeroed', (v_applied ->> 'zeroed')::integer,
                                                                   'ignored', v_ignored),
    completed_at = coalesce(completed_at, now())
  where shop_id = p_shop_id and id = p_snapshot_id;

  -- the report in "Posledné nahrané súbory" (source 'agent'; the first 5 rows of the snapshot's fields; last 10 kept)
  insert into public.stock_imports (shop_id, file_name, file_time, status, total_rows, imported, zeroed, skipped,
                                    error, columns, preview, source, ignored_count)
  values (p_shop_id, left('POS agent · ' || coalesce(v_device, '?'), 200), v_snap.source_time,
          case when v_skipped > 0 then 'errors' else 'ok' end, v_snap.product_count,
          (v_applied ->> 'items')::integer, (v_applied ->> 'zeroed')::integer, v_skipped,
          case when v_skipped > 0 then left(p_result ->> 'skipped_text', 500) end,
          array['source_code', 'name', 'ean', 'brand', 'quantity', 'price', 'currency'],
          public.stock_rows_without_ignored(p_shop_id, v_snap.preview, 'source_code'), 'agent', v_ignored);
  delete from public.stock_imports
  where shop_id = p_shop_id
    and id not in (select i.id from public.stock_imports i where i.shop_id = p_shop_id
                   order by i.received_at desc, i.id desc limit 10);

  return jsonb_build_object('state', 'applied', 'result',
    jsonb_build_object('products', v_snap.product_count, 'imported', (v_applied ->> 'items')::integer,
                       'zeroed', (v_applied ->> 'zeroed')::integer, 'skipped', v_skipped, 'ignored', v_ignored));
end;
$$;
revoke execute on function public.connector_snapshot_settle(uuid, uuid, jsonb, text[], jsonb, boolean) from public, anon, authenticated;

/** Update 40's second file per language; ignored products are skipped (never matched by their EAN to another one). */
create or replace function public.apply_shop_translations(p_shop_id uuid, p_lang text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_matched integer;
  v_unmatched jsonb;
  v_conflicts jsonb;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'p_rows must be a JSON array' using errcode = '22023';
  end if;
  if not public.valid_lang(p_lang) then
    raise exception 'Unknown language' using errcode = '22023';
  end if;
  drop table if exists tr_rows;
  create temporary table tr_rows on commit drop as
  select r.n, nullif(left(trim(r.source_code), 100), '') as source_code, nullif(left(trim(r.ean), 32), '') as ean,
         nullif(left(trim(r.name), 300), '') as name, nullif(left(trim(r.description), 5000), '') as description,
         nullif(left(trim(r.category), 200), '') as category, r.quantity, r.price,
         public.stock_item_ignored(p_shop_id, r.source_code) as ignored,
         case when not public.stock_item_ignored(p_shop_id, r.source_code) then coalesce(
           (select si.id from public.shop_items si where si.shop_id = p_shop_id and si.source_code = trim(r.source_code)),
           (select si.id from public.shop_items si where si.shop_id = p_shop_id and si.ean = nullif(trim(r.ean), '') order by si.source_code limit 1)
         ) end as item_id
  from (
    select e.n, e.v ->> 'source_code' as source_code, e.v ->> 'ean' as ean, e.v ->> 'name' as name,
           e.v ->> 'description' as description, e.v ->> 'category' as category,
           case when jsonb_typeof(e.v -> 'quantity') = 'number' then (e.v ->> 'quantity')::numeric end as quantity,
           case when jsonb_typeof(e.v -> 'price') = 'number' then (e.v ->> 'price')::numeric end as price
    from jsonb_array_elements(p_rows) with ordinality as e(v, n)
    where jsonb_typeof(e.v) = 'object'
  ) r;

  select count(*) into v_matched from tr_rows where item_id is not null;
  select coalesce(jsonb_agg(jsonb_build_object('source_code', source_code, 'ean', ean, 'name', name) order by n), '[]'::jsonb)
  into v_unmatched from (select * from tr_rows where item_id is null and not ignored order by n limit 200) u;
  select coalesce(jsonb_agg(jsonb_build_object('source_code', si.source_code, 'name', si.name,
           'quantity', t.quantity, 'main_quantity', inv.quantity, 'price', t.price, 'main_price', inv.price) order by t.n), '[]'::jsonb)
  into v_conflicts
  from (select * from tr_rows where item_id is not null) t
  join public.shop_items si on si.id = t.item_id
  left join public.inventory inv on inv.shop_item_id = si.id
  where (t.quantity is not null and t.quantity is distinct from inv.quantity)
     or (t.price is not null and t.price is distinct from inv.price);
  v_conflicts := coalesce((select jsonb_agg(e) from (select e from jsonb_array_elements(v_conflicts) e limit 200) x), '[]'::jsonb);

  insert into public.content_translations as c (shop_id, kind, ref, lang, text, status, source_hash)
  select p_shop_id, x.kind, t.item_id::text, p_lang, x.text, 'shop', md5(coalesce(x.source, ''))
  from (select distinct on (item_id) * from tr_rows where item_id is not null order by item_id, n) t
  join public.shop_items si on si.id = t.item_id
  cross join lateral (values
    ('item_name', t.name, si.name),
    ('item_description', t.description, si.description),
    ('item_category', t.category, si.category)
  ) as x(kind, text, source)
  where x.text is not null and x.source is not null and p_lang <> coalesce(si.name_lang, public.shop_main_lang(p_shop_id))
  on conflict (shop_id, kind, ref, lang) do update
    set text = excluded.text, status = 'shop', source_hash = excluded.source_hash, updated_at = now()
    where c.status <> 'manual';

  return jsonb_build_object('matched', v_matched, 'unmatched', v_unmatched, 'conflicts', v_conflicts,
                            'unmatched_count', (select count(*) from tr_rows where item_id is null and not ignored),
                            'ignored', (select count(*) from tr_rows where ignored));
end;
$$;
revoke execute on function public.apply_shop_translations(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.apply_shop_translations(uuid, text, jsonb) to service_role;

-- ------------------------------------------------------------------ 4. the reports: "Ignorované: n"

create or replace function public.record_stock_import(p_shop_id uuid, p_file_name text, p_file_time timestamptz, p_status text,
                                                      p_total integer, p_imported integer, p_zeroed integer, p_skipped integer,
                                                      p_error text, p_rows jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cols text[];
  v_code text;
  v_ignored integer;
  v_id bigint;
begin
  if p_status is null or p_status not in ('ok', 'errors', 'waiting') then
    raise exception 'Unknown import status' using errcode = '22023';
  end if;
  select public.mapped_columns(s.field_mapping), s.field_mapping ->> 'source_code' into v_cols, v_code
  from public.sync_sources s
  where s.shop_id = p_shop_id and s.mapping_status = 'confirmed';
  v_cols := coalesce(v_cols, '{}'::text[]);
  -- the ignored rows of the file this report is about (apply_stock_file noted them with the file's time)
  select case when s.last_ignored_time = p_file_time and p_status <> 'waiting' then s.last_ignored else 0 end into v_ignored
  from public.sync_sources s where s.shop_id = p_shop_id;
  insert into public.stock_imports (shop_id, file_name, file_time, status, total_rows, imported, zeroed, skipped,
                                    error, columns, preview, ignored_count)
  values (
    p_shop_id, left(p_file_name, 200), p_file_time, p_status,
    greatest(coalesce(p_total, 0), 0), greatest(coalesce(p_imported, 0), 0),
    greatest(coalesce(p_zeroed, 0), 0), greatest(coalesce(p_skipped, 0), 0),
    left(p_error, 500), v_cols,
    (select coalesce(jsonb_agg(public.keep_columns(r.value, v_cols) order by r.ord), '[]'::jsonb)
     from jsonb_array_elements(case when jsonb_typeof(p_rows) = 'array'
                                    then public.stock_rows_without_ignored(p_shop_id, p_rows, v_code) else '[]'::jsonb end)
          with ordinality r(value, ord)
     where r.ord <= 5 and cardinality(v_cols) > 0),
    greatest(coalesce(v_ignored, 0), 0))
  returning id into v_id;
  delete from public.stock_imports
  where shop_id = p_shop_id
    and id not in (select i.id from public.stock_imports i where i.shop_id = p_shop_id
                   order by i.received_at desc, i.id desc limit 10);
  return v_id;
end;
$$;
revoke execute on function public.record_stock_import(uuid, text, timestamptz, text, integer, integer, integer, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_stock_import(uuid, text, timestamptz, text, integer, integer, integer, integer, text, jsonb)
  to service_role;

create or replace function public.inventory_record_import(p_shop_id uuid, p_name text, p_source_time timestamptz, p_status text,
                                                          p_total integer, p_imported integer, p_zeroed integer,
                                                          p_skipped integer, p_error text, p_rows jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cols text[];
  v_code text;
  v_ignored integer;
  v_id bigint;
begin
  if p_status is null or p_status not in ('ok', 'errors', 'waiting') then
    raise exception 'Unknown import status' using errcode = '22023';
  end if;
  select public.mapped_columns(c.mapping), c.mapping ->> 'source_code' into v_cols, v_code
  from public.inventory_connections c where c.shop_id = p_shop_id and c.mapping_status = 'confirmed';
  v_cols := coalesce(v_cols, '{}'::text[]);
  select case when s.last_ignored_time = p_source_time and p_status <> 'waiting' then s.last_ignored else 0 end into v_ignored
  from public.sync_sources s where s.shop_id = p_shop_id;
  insert into public.stock_imports (shop_id, file_name, file_time, status, total_rows, imported, zeroed, skipped,
                                    error, columns, preview, source, ignored_count)
  values (p_shop_id, left(p_name, 200), p_source_time, p_status, greatest(coalesce(p_total, 0), 0),
          greatest(coalesce(p_imported, 0), 0), greatest(coalesce(p_zeroed, 0), 0), greatest(coalesce(p_skipped, 0), 0),
          left(p_error, 500), v_cols,
          (select coalesce(jsonb_agg(public.keep_columns(r.value, v_cols) order by r.ord), '[]'::jsonb)
           from jsonb_array_elements(case when jsonb_typeof(p_rows) = 'array'
                                          then public.stock_rows_without_ignored(p_shop_id, p_rows, v_code) else '[]'::jsonb end)
                with ordinality r(value, ord)
           where r.ord <= 5 and cardinality(v_cols) > 0), 'api', greatest(coalesce(v_ignored, 0), 0))
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

-- ------------------------------------------------------------------ 5. update 43 knows the third kind

/** Update 43's state; an ignore is not one of the day's 3 resets and not in the removals list (it has its own list). */
create or replace function public.owner_inventory_state(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_src public.sync_sources%rowtype;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  select * into v_src from public.sync_sources where shop_id = p_shop_id;
  return jsonb_build_object(
    'files', (select count(*) from public.stock_imports i where i.shop_id = p_shop_id),
    'files_cleared', v_src.files_cleared_at is not null
                     and not exists (select 1 from public.stock_imports i
                                     where i.shop_id = p_shop_id and i.received_at > v_src.files_cleared_at),
    'files_cleared_at', v_src.files_cleared_at,
    'inventory_reset_at', v_src.inventory_reset_at,
    'needs_file', v_src.inventory_reset_at is not null and v_src.latest_file_time is null,
    'items', (select count(*) from public.shop_items si where si.shop_id = p_shop_id),
    'ignored', (select count(*) from public.shop_ignored_items g where g.shop_id = p_shop_id),
    'resets_left', greatest(0, 3 - (select count(*) from public.inventory_resets r
                                     where r.shop_id = p_shop_id and r.kind <> 'ignored'
                                       and r.created_at > now() - interval '1 day')),
    'resets', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'created_at', r.created_at, 'items', r.items,
                                          'files', r.files, 'expires_at', r.expires_at, 'restored_at', r.restored_at,
                                          'keep_translations', r.keep_translations, 'cleared_mapping', r.cleared_mapping,
                                          'blocked', public.inventory_restore_blocked(r.id))
                       order by r.created_at desc)
      from public.inventory_resets r
      where r.shop_id = p_shop_id and r.kind <> 'ignored' and r.created_at > now() - interval '30 days'), '[]'::jsonb),
    'backups', coalesce((
      select jsonb_agg(jsonb_build_object('id', b.id, 'created_at', b.created_at, 'expires_at', b.expires_at,
                                          'file_name', b.file_name, 'rows', b.rows) order by b.created_at desc)
      from public.inventory_backups b where b.shop_id = p_shop_id and b.expires_at > now()), '[]'::jsonb),
    'activity', coalesce((
      select jsonb_agg(jsonb_build_object('at', a.at, 'action', a.action, 'details', a.details) order by a.at desc)
      from (select * from public.shop_activity a where a.shop_id = p_shop_id order by a.at desc limit 20) a), '[]'::jsonb));
end;
$$;
revoke execute on function public.owner_inventory_state(uuid) from public, anon;
grant execute on function public.owner_inventory_state(uuid) to authenticated;

create or replace function public.owner_inventory_preview(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_missing uuid[];
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  select coalesce(array_agg(m), '{}') into v_missing from public.inventory_missing_items(p_shop_id) m;
  return jsonb_build_object(
    'shop_name', (select s.name from public.shops s where s.id = p_shop_id),
    'items', (select count(*) from public.shop_items si where si.shop_id = p_shop_id),
    'missing', cardinality(v_missing),
    'missing_list', coalesce((
      select jsonb_agg(jsonb_build_object('code', x.source_code, 'name', x.name) order by x.name, x.source_code)
      from (select si.source_code, si.name from public.shop_items si where si.id = any (v_missing)
            order by si.name, si.source_code limit 500) x), '[]'::jsonb),
    'files', (select count(*) from public.stock_imports i where i.shop_id = p_shop_id),
    'resets_left', greatest(0, 3 - (select count(*) from public.inventory_resets r
                                     where r.shop_id = p_shop_id and r.kind <> 'ignored'
                                       and r.created_at > now() - interval '1 day')));
end;
$$;
revoke execute on function public.owner_inventory_preview(uuid) from public, anon;
grant execute on function public.owner_inventory_preview(uuid) to authenticated;

/** Update 43's options A and B; unchanged except that an ignore does not count toward the 3 a day. */
create or replace function public.owner_inventory_reset(
  p_shop_id uuid,
  p_mode text,
  p_confirm text default null,
  p_keep_translations boolean default true,
  p_clear_mapping boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_files integer := 0;
  v_reset bigint;
  v_backup bigint;
  v_csv text;
  v_rows integer;
  v_shop public.shops%rowtype;
  v_keep boolean := coalesce(p_keep_translations, true);
  v_clear boolean := coalesce(p_clear_mapping, false);
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  if p_mode is null or p_mode not in ('missing', 'all') then
    raise exception 'Unknown reset mode' using errcode = '22023';
  end if;
  select * into v_shop from public.shops where id = p_shop_id;
  if p_mode = 'all' and lower(btrim(coalesce(p_confirm, ''))) is distinct from lower(btrim(v_shop.name)) then
    raise exception 'confirm_name' using errcode = 'P0001';
  end if;
  -- One at a time per shop (two quick taps, two windows).
  perform pg_advisory_xact_lock(hashtext('inventory_reset:' || p_shop_id::text));
  if (select count(*) from public.inventory_resets r
      where r.shop_id = p_shop_id and r.kind <> 'ignored' and r.created_at > now() - interval '1 day') >= 3 then
    raise exception 'reset_limit' using errcode = 'P0001';
  end if;

  if p_mode = 'missing' then
    select coalesce(array_agg(m), '{}') into v_ids from public.inventory_missing_items(p_shop_id) m;
    v_keep := true;
    v_clear := false;
  else
    select coalesce(array_agg(si.id), '{}') into v_ids from public.shop_items si where si.shop_id = p_shop_id;
  end if;
  if cardinality(v_ids) = 0 and (p_mode = 'missing' or not exists (select 1 from public.stock_imports i where i.shop_id = p_shop_id)) then
    raise exception 'nothing_to_remove' using errcode = 'P0001';
  end if;

  insert into public.inventory_resets (shop_id, kind, actor, keep_translations, cleared_mapping, source_before)
  select p_shop_id, p_mode, auth.uid(), v_keep, v_clear,
         jsonb_build_object('field_mapping', s.field_mapping, 'mapping_status', s.mapping_status,
                            'file_format', s.file_format, 'file_encoding', s.file_encoding,
                            'file_columns', to_jsonb(s.file_columns), 'latest_file_time', s.latest_file_time)
  from public.sync_sources s where s.shop_id = p_shop_id
  returning id into v_reset;
  if v_reset is null then
    insert into public.inventory_resets (shop_id, kind, actor, keep_translations, cleared_mapping)
    values (p_shop_id, p_mode, auth.uid(), v_keep, v_clear)
    returning id into v_reset;
  end if;

  -- 1. the backup of everything as it is now
  select b.csv, b.rows into v_csv, v_rows from public.inventory_backup_csv(p_shop_id) b;
  insert into public.inventory_backups (shop_id, reset_id, file_name, rows, csv)
  values (p_shop_id, v_reset,
          left(v_shop.slug, 120) || '-zaloha-skladu-' || to_char(now() at time zone v_shop.timezone, 'YYYY-MM-DD_HH24-MI') || '.csv',
          v_rows, v_csv)
  returning id into v_backup;

  -- 2. the products into the trash, exactly as they are (the stored search column is made again on restore)
  perform public.inventory_trash_items(p_shop_id, v_reset, v_ids);

  -- 3. option B: the uploaded files, the latest file's time (any next file is taken), optionally the mapping
  if p_mode = 'all' then
    v_files := public.stock_files_clear(p_shop_id);
    update public.sync_sources s
    set latest_file_time = null,
        last_error = null,
        inventory_reset_at = now(),
        field_mapping = case when v_clear then null else s.field_mapping end,
        mapping_status = case when v_clear then 'proposed' else s.mapping_status end,
        file_columns = case when v_clear then null else s.file_columns end,
        file_encoding = case when v_clear then null else s.file_encoding end
    where s.shop_id = p_shop_id;
  end if;

  update public.inventory_resets set items = cardinality(v_ids), files = v_files where id = v_reset;
  perform public.inventory_log(p_shop_id,
    case p_mode when 'missing' then 'inventory_missing_removed' else 'inventory_reset' end,
    jsonb_build_object('items', cardinality(v_ids), 'files', v_files, 'reset_id', v_reset, 'backup_id', v_backup,
                       'keep_translations', v_keep, 'cleared_mapping', v_clear));
  return jsonb_build_object('reset_id', v_reset, 'backup_id', v_backup, 'items', cardinality(v_ids), 'files', v_files);
end;
$$;
revoke execute on function public.owner_inventory_reset(uuid, text, text, boolean, boolean) from public, anon;
grant execute on function public.owner_inventory_reset(uuid, text, text, boolean, boolean) to authenticated;

/**
 * Update 43's step 2, shared: the products into the trash with their stock row, Cacaduu description and translations
 * (the product photo stays by its code, update 78), then the products go (inventory and descriptions cascade).
 */
create or replace function public.inventory_trash_items(p_shop_id uuid, p_reset bigint, p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.inventory_trash (reset_id, shop_id, source_code, item, inventory, description, translations)
  select p_reset, p_shop_id, si.source_code, to_jsonb(si) - 'names_search', to_jsonb(inv), to_jsonb(d),
         coalesce((select jsonb_agg(to_jsonb(c)) from public.content_translations c
                   where c.shop_id = p_shop_id and c.ref = si.id::text
                     and c.kind in ('item_name', 'item_description', 'item_category')), '[]'::jsonb)
  from public.shop_items si
  left join public.inventory inv on inv.shop_item_id = si.id
  left join public.item_descriptions d on d.item_id = si.id
  where si.shop_id = p_shop_id and si.id = any (p_ids);

  delete from public.content_translations c
  where c.shop_id = p_shop_id and c.kind in ('item_name', 'item_description', 'item_category')
    and c.ref = any (select x::text from unnest(p_ids) x);
  delete from public.shop_items si where si.shop_id = p_shop_id and si.id = any (p_ids);
end;
$$;
revoke execute on function public.inventory_trash_items(uuid, bigint, uuid[]) from public, anon, authenticated;

/** Update 43's rule + an ignore: undone only by its own "Späť" (10 minutes, before the next file). */
create or replace function public.inventory_restore_blocked(p_reset_id bigint)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when r.restored_at is not null then 'restored'
    when r.purged_at is not null then 'purged'
    when r.kind = 'ignored' and (coalesce(current_setting('ppi.ignore_undo', true), '') <> '1'
                                 or r.created_at <= now() - interval '10 minutes') then 'ignored'
    when r.expires_at <= now() then 'expired'
    when (case when r.kind = 'all' then s.latest_file_time is not null
               else s.latest_file_time is distinct from (r.source_before ->> 'latest_file_time')::timestamptz end)
      then 'newer_upload'
    -- only the newest removal of a shop can be undone (an older one would bring back products a later one removed)
    when r.kind <> 'ignored'
     and exists (select 1 from public.inventory_resets n
                 where n.shop_id = r.shop_id and n.kind <> 'ignored' and n.created_at > r.created_at
                   and n.restored_at is null) then 'newer_reset'
  end
  from public.inventory_resets r
  left join public.sync_sources s on s.shop_id = r.shop_id
  where r.id = p_reset_id
$$;
revoke execute on function public.inventory_restore_blocked(bigint) from public, anon, authenticated;

/** Update 43's daily clean-up + the trash rows of products restored from the ignored list 30 days ago. */
create or replace function public.inventory_purge_expired()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reset record;
  v_count integer := 0;
begin
  for v_reset in
    select r.id, r.shop_id, r.items from public.inventory_resets r
    where r.expires_at <= now() and r.restored_at is null and r.purged_at is null
  loop
    delete from public.inventory_trash where reset_id = v_reset.id;
    update public.inventory_resets set purged_at = now() where id = v_reset.id;
    insert into public.shop_activity (shop_id, action, details)
    values (v_reset.shop_id, 'inventory_purged', jsonb_build_object('reset_id', v_reset.id, 'items', v_reset.items));
    v_count := v_count + 1;
  end loop;
  delete from public.inventory_trash where expires_at <= now();
  delete from public.inventory_backups where expires_at <= now();
  delete from public.shop_activity where at < now() - interval '1 year';
  return v_count;
end;
$$;
revoke execute on function public.inventory_purge_expired() from public, anon, authenticated;
grant execute on function public.inventory_purge_expired() to service_role;

-- ------------------------------------------------------------------ 6. the owner's screen

/** Why this shop cannot ignore products (null = it can): its stock is kept in "Sklad v Cacaduu". */
create or replace function public.ignore_refusal(p_shop_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.stock_source_of(p_shop_id) = 'sklad' then 'sklad_source' end
$$;
revoke execute on function public.ignore_refusal(uuid) from public, anon, authenticated;

/**
 * "Produkty zo súboru": the shop's products, all (by name) or what the shop page's forgiving search finds for p_q
 * (shop_item_search: exact / close first; "similar" only when nothing matched). Each with its code, EAN, quantity
 * and whether the data are stale. `matched` = how many "Vymazať všetko" would remove (never the "similar" rows).
 */
create or replace function public.owner_ignore_candidates(p_shop_id uuid, p_q text default null, p_limit integer default 50,
                                                          p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_q text := nullif(trim(coalesce(p_q, '')), '');
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_slug text;
  v_items jsonb;
  v_total bigint;
  v_kind text := 'all';
  v_state text;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  select s.slug into v_slug from public.shops s where s.id = p_shop_id;
  v_state := public.freshness_label((select ss.latest_file_time from public.sync_sources ss where ss.shop_id = p_shop_id),
                                    (select s.kind from public.shops s where s.id = p_shop_id));
  if v_q is null then
    select count(*) into v_total from public.shop_items si where si.shop_id = p_shop_id;
    select coalesce(jsonb_agg(x.j order by x.n), '[]'::jsonb) into v_items
    from (select row_number() over (order by si.name, si.source_code) as n,
                 jsonb_build_object('id', si.id, 'name', si.name, 'code', si.source_code, 'ean', coalesce(si.ean, p.ean),
                                    'quantity', inv.quantity) as j
          from public.shop_items si
          left join public.inventory inv on inv.shop_item_id = si.id
          left join public.products p on p.id = si.product_id
          where si.shop_id = p_shop_id
          order by si.name, si.source_code
          limit v_limit offset v_offset) x;
  else
    select coalesce(jsonb_agg(jsonb_build_object('id', h.item_id, 'name', si.name, 'code', si.source_code, 'ean', h.ean,
                                                 'quantity', inv.quantity) order by h.n), '[]'::jsonb),
           max(h.total_count), max(h.kind)
    into v_items, v_total, v_kind
    from (select row_number() over () as n, s.* from public.shop_item_search(v_slug, v_q, v_limit, v_offset) s) h
    join public.shop_items si on si.id = h.item_id
    left join public.inventory inv on inv.shop_item_id = si.id;
    v_kind := case when v_kind = 'similar' then 'similar' else 'match' end;
    v_total := coalesce(v_total, 0);
  end if;
  return jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'kind', v_kind,
    'matched', case when v_kind = 'similar' then 0 else v_total end,
    'stale', v_state = 'stale',
    'source', public.stock_source_of(p_shop_id),
    'shop_kind', (select s.kind from public.shops s where s.id = p_shop_id),
    'shop_name', (select s.name from public.shops s where s.id = p_shop_id),
    'refusal', public.ignore_refusal(p_shop_id),
    'ignored', (select count(*) from public.shop_ignored_items g where g.shop_id = p_shop_id));
end;
$$;
revoke execute on function public.owner_ignore_candidates(uuid, text, integer, integer) from public, anon;
grant execute on function public.owner_ignore_candidates(uuid, text, integer, integer) to authenticated;

/** "Ignorované (n)": newest first, with who removed it ("by_me" when it was the caller). */
create or replace function public.owner_ignored_items(p_shop_id uuid, p_limit integer default 200, p_offset integer default 0)
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
    'total', (select count(*) from public.shop_ignored_items g where g.shop_id = p_shop_id),
    'source', public.stock_source_of(p_shop_id),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('key', x.key_value, 'name', x.name, 'created_at', x.created_at,
                                          'by', x.display_name, 'by_me', x.created_by = auth.uid())
                       order by x.created_at desc, x.key_value)
      from (select g.key_value, g.name, g.created_at, g.created_by, pr.display_name
            from public.shop_ignored_items g
            left join public.profiles pr on pr.user_id = g.created_by
            where g.shop_id = p_shop_id
            order by g.created_at desc, g.key_value
            limit least(greatest(coalesce(p_limit, 200), 1), 500) offset greatest(coalesce(p_offset, 0), 0)) x), '[]'::jsonb));
end;
$$;
revoke execute on function public.owner_ignored_items(uuid, integer, integer) from public, anon;
grant execute on function public.owner_ignored_items(uuid, integer, integer) to authenticated;

/**
 * "Vymazať (n)" / "Vymazať všetko (n)": p_ids = the ticked products (another shop's ids are left out); null = every
 * product the search p_q shows (null / empty = all; never the "similar" rows). p_expected = the number the screen
 * showed: a different number now → `changed`, nothing removed. ≤ 5000 ignored per shop. ONE transaction: the keys,
 * then update 43's way out (the backup CSV, the trash; translations, the description and the photo stay by code).
 */
create or replace function public.owner_ignore_items(p_shop_id uuid, p_ids uuid[] default null, p_q text default null,
                                                     p_expected integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[] := '{}';
  v_page uuid[];
  v_total bigint;
  v_similar boolean;
  v_offset integer := 0;
  v_q text := nullif(trim(coalesce(p_q, '')), '');
  v_shop public.shops%rowtype;
  v_reset bigint;
  v_backup bigint;
  v_csv text;
  v_rows integer;
  v_keys text[];
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  if public.ignore_refusal(p_shop_id) is not null then
    raise exception '%', public.ignore_refusal(p_shop_id) using errcode = 'P0001';
  end if;
  if p_ids is not null and cardinality(p_ids) > 5000 then
    raise exception 'too_many' using errcode = 'P0001';
  end if;
  select * into v_shop from public.shops where id = p_shop_id;
  perform pg_advisory_xact_lock(hashtext('inventory_reset:' || p_shop_id::text));

  if p_ids is not null then
    select coalesce(array_agg(si.id), '{}') into v_ids
    from public.shop_items si where si.shop_id = p_shop_id and si.id = any (p_ids);
  elsif v_q is null then
    select coalesce(array_agg(si.id), '{}') into v_ids from public.shop_items si where si.shop_id = p_shop_id;
  else
    loop
      select array_agg(s.item_id), max(s.total_count), bool_or(s.kind = 'similar')
      into v_page, v_total, v_similar
      from public.shop_item_search(v_shop.slug, v_q, 100, v_offset) s;
      exit when v_page is null or v_similar;
      if v_total > 5000 then
        raise exception 'too_many' using errcode = 'P0001';
      end if;
      v_ids := v_ids || v_page;
      v_offset := v_offset + 100;
      exit when v_offset >= v_total;
    end loop;
    select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(v_ids) x;
  end if;

  if p_expected is not null and cardinality(v_ids) <> p_expected then
    raise exception 'changed' using errcode = 'P0001';
  end if;
  if cardinality(v_ids) = 0 then
    raise exception 'nothing_to_remove' using errcode = 'P0001';
  end if;
  if (select count(*) from public.shop_ignored_items g where g.shop_id = p_shop_id) + cardinality(v_ids) > 5000 then
    raise exception 'too_many' using errcode = 'P0001';
  end if;

  -- 1. the keys (with the name as it was), so no import brings them back
  insert into public.shop_ignored_items (shop_id, key_kind, key_value, name, created_by)
  select p_shop_id, 'code', public.stock_item_key(si.source_code), left(si.name, 300), auth.uid()
  from public.shop_items si
  where si.shop_id = p_shop_id and si.id = any (v_ids) and public.stock_item_key(si.source_code) is not null
  on conflict (shop_id, key_kind, key_value) do nothing;
  select array_agg(public.stock_item_key(si.source_code) order by si.name, si.source_code) into v_keys
  from public.shop_items si where si.shop_id = p_shop_id and si.id = any (v_ids);

  -- 2. update 43's way out: one removal (kind 'ignored', never expires while ignored), the backup, the trash
  insert into public.inventory_resets (shop_id, kind, actor, keep_translations, cleared_mapping, source_before, expires_at)
  values (p_shop_id, 'ignored', auth.uid(), true, false,
          jsonb_build_object('latest_file_time', (select s.latest_file_time from public.sync_sources s where s.shop_id = p_shop_id)),
          'infinity')
  returning id into v_reset;
  select b.csv, b.rows into v_csv, v_rows from public.inventory_backup_csv(p_shop_id) b;
  insert into public.inventory_backups (shop_id, reset_id, file_name, rows, csv)
  values (p_shop_id, v_reset,
          left(v_shop.slug, 120) || '-zaloha-skladu-' || to_char(now() at time zone v_shop.timezone, 'YYYY-MM-DD_HH24-MI') || '.csv',
          v_rows, v_csv)
  returning id into v_backup;
  perform public.inventory_trash_items(p_shop_id, v_reset, v_ids);
  update public.inventory_resets set items = cardinality(v_ids) where id = v_reset;

  -- the POS agent's "fewer than half" rule compares with this count: the removed products are not part of it any more
  update public.shop_stock_source set agent_product_count = greatest(0, agent_product_count - cardinality(v_ids))
  where shop_id = p_shop_id and agent_product_count is not null;

  perform public.inventory_log(p_shop_id, 'items_ignored',
                               jsonb_build_object('count', cardinality(v_ids), 'reset_id', v_reset, 'backup_id', v_backup));
  return jsonb_build_object('count', cardinality(v_ids), 'ids', to_jsonb(v_ids), 'keys', to_jsonb(coalesce(v_keys, '{}')),
                            'reset_id', v_reset, 'backup_id', v_backup);
end;
$$;
revoke execute on function public.owner_ignore_items(uuid, uuid[], text, integer) from public, anon;
grant execute on function public.owner_ignore_items(uuid, uuid[], text, integer) to authenticated;

/**
 * "Obnoviť (n)": the keys leave the list; the products come back only with the next file / sync (never from the
 * trash), with their translations and description (update 43's triggers, by code). p_keys null = every ignored one
 * (p_expected = the number the screen showed, else `changed`).
 */
create or replace function public.owner_unignore_items(p_shop_id uuid, p_keys text[] default null, p_expected integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_keys text[];
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('inventory_reset:' || p_shop_id::text));
  select coalesce(array_agg(g.key_value), '{}') into v_keys
  from public.shop_ignored_items g
  where g.shop_id = p_shop_id and (p_keys is null or g.key_value = any (p_keys));
  if p_expected is not null and cardinality(v_keys) <> p_expected then
    raise exception 'changed' using errcode = 'P0001';
  end if;
  if cardinality(v_keys) = 0 then
    raise exception 'nothing_to_restore' using errcode = 'P0001';
  end if;
  delete from public.shop_ignored_items g where g.shop_id = p_shop_id and g.key_value = any (v_keys);
  -- their trash rows wait 30 days for the product's return (then update 43's clean-up)
  update public.inventory_trash t set expires_at = now() + interval '30 days'
  from public.inventory_resets r
  where r.id = t.reset_id and r.kind = 'ignored' and t.shop_id = p_shop_id and t.reattached_at is null
    and t.source_code = any (v_keys);
  perform public.inventory_log(p_shop_id, 'items_unignored', jsonb_build_object('count', cardinality(v_keys)));
  return jsonb_build_object('count', cardinality(v_keys), 'source', public.stock_source_of(p_shop_id));
end;
$$;
revoke execute on function public.owner_unignore_items(uuid, text[], integer) from public, anon;
grant execute on function public.owner_unignore_items(uuid, text[], integer) to authenticated;

/** The toast's "Späť" (10 minutes, before the next file): the products exactly back from the trash, the keys gone. */
create or replace function public.owner_ignore_undo(p_reset_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reset public.inventory_resets%rowtype;
  v_out jsonb;
  v_keys text[];
begin
  select * into v_reset from public.inventory_resets where id = p_reset_id;
  if not found or not public.is_shop_member(v_reset.shop_id) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  if v_reset.kind <> 'ignored' then
    raise exception 'restore_not_ignored' using errcode = 'P0001';
  end if;
  select coalesce(array_agg(t.source_code), '{}') into v_keys from public.inventory_trash t where t.reset_id = p_reset_id;
  delete from public.shop_ignored_items g where g.shop_id = v_reset.shop_id and g.key_value = any (v_keys);
  perform set_config('ppi.ignore_undo', '1', true);
  v_out := public.owner_inventory_restore(p_reset_id);
  perform set_config('ppi.ignore_undo', '', true);
  update public.shop_stock_source set agent_product_count = agent_product_count + coalesce((v_out ->> 'items')::int, 0)
  where shop_id = v_reset.shop_id and agent_product_count is not null;
  perform public.inventory_log(v_reset.shop_id, 'items_unignored',
                               jsonb_build_object('count', coalesce((v_out ->> 'items')::int, 0), 'undo', true));
  return jsonb_build_object('count', coalesce((v_out ->> 'items')::int, 0));
end;
$$;
revoke execute on function public.owner_ignore_undo(bigint) from public, anon;
grant execute on function public.owner_ignore_undo(bigint) to authenticated;

-- ------------------------------------------------------------------ 7. the owner MCP: update_stock on an ignored product

/** The token's shops: does p_args name (by code, or by a removed product's id) an ignored product of one of them? */
create or replace function public.mcp_stock_ignored(p_token text, p_args jsonb)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.owner_mcp_tokens tk
    cross join lateral unnest(tk.shop_ids) sid
    join public.shop_ignored_items g on g.shop_id = sid
    where tk.access_hash = public.mcp_hash(p_token)
      and (g.key_value = public.stock_item_key(p_args ->> 'code')
           or exists (select 1 from public.inventory_trash t
                      join public.inventory_resets r on r.id = t.reset_id and r.kind = 'ignored'
                      where t.shop_id = sid and t.source_code = g.key_value
                        and t.item ->> 'id' = coalesce(p_args ->> 'item_id', ''))))
$$;
revoke execute on function public.mcp_stock_ignored(text, jsonb) from public, anon, authenticated;

create or replace function public.owner_mcp_call(p_token text, p_tool text, p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb;
  v_shop uuid;
begin
  begin
    r := public.owner_mcp_call_81(p_token, p_tool, p_args);
  exception when sqlstate 'P0002' then
    -- update 88: a product the owner removed and ignores is not "not found" but "ignored"
    if p_tool = 'update_stock' and public.mcp_stock_ignored(p_token, coalesce(p_args, '{}'::jsonb)) then
      raise exception 'ignored' using errcode = 'P0001';
    end if;
    raise;
  end;
  if p_tool = 'list_food_orders' and jsonb_typeof(r -> 'result') = 'object' then
    -- the shop update 81's door checked and named (the grant's own shop)
    select id into v_shop from public.shops where slug = r ->> 'shop';
    if v_shop is not null then
      r := jsonb_set(r, '{result}', (r -> 'result')
             || jsonb_build_object('times', public.food_times(v_shop), 'parts', public.food_parts(v_shop)));
    end if;
  end if;
  return r;
end;
$$;

-- ------------------------------------------------------------------ 8. an ignored product keeps its photo (update 78)

/** Update 78's tidying; the photo of an ignored product stays (by its code) until the product is restored and back. */
create or replace function public.product_photo_tidy(p_limit integer default 200)
returns setof text
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  delete from public.product_photos pp
  where pp.updated_at < now() - interval '30 days'
    and not exists (select 1 from public.shop_items si where si.id = pp.item_id)
    and not exists (select 1 from public.shop_ignored_items g
                    where g.shop_id = pp.shop_id and g.key_kind = 'code' and g.key_value = public.stock_item_key(pp.source_code));
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'storage' and c.relname = 'objects') then
    return;
  end if;
  return query execute
    'select o.name from storage.objects o
     where o.bucket_id = ''product-photos'' and o.created_at < now() - interval ''1 day''
       and not exists (select 1 from public.product_photos f where f.path_large = o.name or f.path_small = o.name)
       and not exists (select 1 from public.product_photo_job_rows r where r.part_path = o.name)
     order by o.created_at limit $1'
    using least(greatest(coalesce(p_limit, 200), 1), 1000);
end;
$$;
revoke execute on function public.product_photo_tidy(integer) from public, anon, authenticated;
grant execute on function public.product_photo_tidy(integer) to service_role;

grant execute on function public.owner_mcp_call(text, text, jsonb) to anon, authenticated, service_role;
