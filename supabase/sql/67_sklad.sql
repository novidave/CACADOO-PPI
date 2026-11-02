-- =====================================================================================================================
-- Update 67 — "Sklad v Cacaduu", phase A (Prompt 14, 2026-11-02, at the owner's request)
--
-- Shops without stock software keep their stock in Cacaduu itself. "Sklad v Cacaduu" is a new choice in "Zdroj zásob"
-- (shop_stock_source.source = 'sklad'). While it is the source it is the ONLY writer of the shop's stock:
--   * quantities are never typed over: every change is a movement (append-only; a mistake is fixed by a "Oprava"
--     movement with a reason); the stock per location = the sum of its movements;
--   * every movement carries the client's own UUID, so a retried or offline-queued request is never counted twice;
--   * sklad_apply() writes inventory (quantity = total over all locations, price = the sale price, EUR) and the shop's
--     freshness time in the same transaction as every movement and every "Stav je správny"; a product without a sale
--     price is not public; no movement and no confirmation for 24 h → stale, as for every shop (freshness_label());
--   * the file upload / folder (upload_check_in), the inventory program and the POS agent are refused while 'sklad'
--     is the source, and a guard on inventory refuses every other writer (the owner MCP's update_stock too);
--   * purchase prices, the supplier and the margin are private: no table of this update is granted to anyone but the
--     service role; owners read and write only through the owner_sklad_* functions (members of the shop).
-- Switching to 'sklad' takes over the shop's existing products (their sale price from the file, their quantity as an
-- opening count at the sale location); switching back is one click and never deletes Sklad data.
-- Free shops: at most 50 Sklad products (sklad_product_limit()); Pro (shop_has_plan): unlimited.
-- A daily reminder (pg_cron every 15 minutes → the "sklad" function): at each shop's reminder time, when today had no
-- movement and no confirmation, one e-mail "Potvrďte stav skladu" to the owners (Môj obchod shows the banner itself).
-- Needs updates 52 (stock source), 61/64 (owner MCP), 36 (IndexNow). Safe to run twice.
-- =====================================================================================================================

-- ------------------------------------------------------------------ 0. the activity log and the stock source know Sklad

do $$
declare
  v_def text := (select pg_get_constraintdef(c.oid) from pg_constraint c
                 where c.conrelid = 'public.shop_activity'::regclass and c.conname = 'shop_activity_action_check');
  v_add text := '';
  a text;
begin
  if v_def is null then return; end if;
  foreach a in array array['sklad_product_saved', 'sklad_location_saved', 'sklad_settings_saved', 'sklad_confirmed'] loop
    if position('''' || a || '''' in v_def) = 0 then v_add := v_add || '''' || a || '''::text, '; end if;
  end loop;
  if v_add <> '' then
    alter table public.shop_activity drop constraint shop_activity_action_check;
    execute 'alter table public.shop_activity add constraint shop_activity_action_check ' || replace(v_def, 'ARRAY[', 'ARRAY[' || v_add);
  end if;
end;
$$;

alter table public.shop_stock_source drop constraint if exists shop_stock_source_source_check;
alter table public.shop_stock_source add constraint shop_stock_source_source_check check (source in ('file', 'agent', 'sklad'));

-- ------------------------------------------------------------------ 1. tables

create table if not exists public.sklad_settings (
  shop_id         uuid primary key references public.shops (id) on delete cascade,
  margin_reports  boolean not null default true,
  reminder_time   time not null default '08:00',
  reminder_on     boolean not null default true,
  confirmed_at    timestamptz,
  reminded_on     date,
  updated_at      timestamptz not null default now()
);

create table if not exists public.sklad_locations (
  id                  uuid primary key default gen_random_uuid(),
  shop_id             uuid not null references public.shops (id) on delete cascade,
  name                text not null check (char_length(btrim(name)) between 1 and 80),
  note                text check (note is null or char_length(note) <= 200),
  sort                integer not null default 0,
  is_sale_default     boolean not null default false,
  is_receipt_default  boolean not null default false,
  created_at          timestamptz not null default now()
);
create index if not exists sklad_locations_shop_idx on public.sklad_locations (shop_id, sort);
create unique index if not exists sklad_locations_sale_idx on public.sklad_locations (shop_id) where is_sale_default;
create unique index if not exists sklad_locations_receipt_idx on public.sklad_locations (shop_id) where is_receipt_default;

create table if not exists public.sklad_items (
  shop_item_id  uuid primary key references public.shop_items (id) on delete cascade,
  shop_id       uuid not null references public.shops (id) on delete cascade,
  unit          text not null default 'ks' check (unit in ('ks', 'l', 'kg', 'm')),
  vat_rate      numeric not null default 23 check (vat_rate between 0 and 100),
  -- with VAT; NULL = not public ("Bez predajnej ceny – na stránke sa nezobrazuje")
  sale_price    numeric check (sale_price is null or sale_price between 0 and 1000000000),
  min_qty       numeric not null default 0 check (min_qty between 0 and 1000000000),
  shelf         text check (shelf is null or char_length(shelf) <= 80),
  -- private (owners only, never public): without VAT
  last_cost     numeric check (last_cost is null or last_cost between 0 and 1000000000),
  last_cost_at  timestamptz,
  avg_cost      numeric check (avg_cost is null or avg_cost between 0 and 1000000000),
  supplier      text check (supplier is null or char_length(supplier) <= 120),
  photos        jsonb not null default '[]'::jsonb check (jsonb_typeof(photos) = 'array'),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists sklad_items_shop_idx on public.sklad_items (shop_id);

do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typname = 'sklad_kind') then
    create type public.sklad_kind as enum ('receipt', 'sale', 'writeoff', 'count', 'correction', 'transfer');
  end if;
end;
$$;

create table if not exists public.sklad_movements (
  id              uuid primary key,
  shop_id         uuid not null references public.shops (id) on delete cascade,
  shop_item_id    uuid not null references public.sklad_items (shop_item_id) on delete cascade,
  location_id     uuid not null references public.sklad_locations (id),
  kind            public.sklad_kind not null,
  -- signed: receipt +, sale / writeoff −, count / correction ±, transfer + (from location_id to to_location_id)
  qty             numeric not null check (qty <> 0 and abs(qty) <= 1000000000),
  to_location_id  uuid references public.sklad_locations (id),
  unit_cost       numeric check (unit_cost is null or unit_cost between 0 and 1000000000),
  reason          text check (reason is null or char_length(reason) <= 200),
  ref             text check (ref is null or char_length(ref) <= 80),
  device_label    text check (device_label is null or char_length(device_label) <= 60),
  created_by      uuid references auth.users (id) on delete set null,
  client_at       timestamptz,
  created_at      timestamptz not null default now(),
  check ((kind = 'transfer') = (to_location_id is not null)),
  check (kind <> 'transfer' or (qty > 0 and to_location_id <> location_id)),
  check (kind not in ('receipt') or qty > 0),
  check (kind not in ('sale', 'writeoff') or qty < 0),
  check (kind not in ('correction', 'writeoff') or nullif(btrim(coalesce(reason, '')), '') is not null),
  check (unit_cost is null or kind = 'receipt')
);
create index if not exists sklad_movements_item_idx on public.sklad_movements (shop_item_id, created_at desc);
create index if not exists sklad_movements_shop_idx on public.sklad_movements (shop_id, created_at desc);

-- movements are append-only: no update, no delete (a whole shop or product may still go, by cascade)
create or replace function public.sklad_movements_frozen()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'sklad_append_only' using errcode = '55000';
  end if;
  -- a delete only as part of deleting the shop or the product
  if exists (select 1 from public.sklad_items i where i.shop_item_id = old.shop_item_id)
     and exists (select 1 from public.shops sh where sh.id = old.shop_id) then
    raise exception 'sklad_append_only' using errcode = '55000';
  end if;
  return old;
end;
$$;
drop trigger if exists sklad_movements_frozen on public.sklad_movements;
create trigger sklad_movements_frozen before update or delete on public.sklad_movements
  for each row execute function public.sklad_movements_frozen();

do $$
declare
  t text;
begin
  foreach t in array array['sklad_settings', 'sklad_locations', 'sklad_items', 'sklad_movements'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

-- the stock per product and location = the sum of its movements (a transfer counts on both sides)
create or replace view public.sklad_stock
with (security_invoker = true)
as
select m.shop_id, m.shop_item_id, x.location_id, sum(x.qty) as qty
from public.sklad_movements m
cross join lateral (
  select m.location_id, case when m.kind = 'transfer' then -m.qty else m.qty end
  union all
  select m.to_location_id, m.qty where m.kind = 'transfer'
) as x(location_id, qty)
group by m.shop_id, m.shop_item_id, x.location_id;

create or replace view public.sklad_stock_total
with (security_invoker = true)
as
select m.shop_id, m.shop_item_id, sum(case when m.kind = 'transfer' then 0 else m.qty end) as qty
from public.sklad_movements m
group by m.shop_id, m.shop_item_id;

revoke all on public.sklad_stock, public.sklad_stock_total from public, anon, authenticated;
grant select on public.sklad_stock, public.sklad_stock_total to service_role;

-- ------------------------------------------------------------------ 2. one stock source at a time, now with 'sklad'

-- 'api' while an inventory program is connected, 'agent' (chosen + a paired device), 'sklad' (chosen), else 'file'.
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
    when exists (select 1 from public.shop_stock_source s where s.shop_id = p_shop_id and s.source = 'sklad') then 'sklad'
    else 'file'
  end
$$;
revoke execute on function public.stock_source_of(uuid) from public, anon, authenticated;
grant execute on function public.stock_source_of(uuid) to service_role;

/** Free shops: at most 50 Sklad products; with the plan (shop_has_plan) no limit (NULL). */
create or replace function public.sklad_product_limit(p_shop_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.shop_has_plan(p_shop_id) then null else 50 end
$$;
revoke execute on function public.sklad_product_limit(uuid) from public, anon, authenticated;
grant execute on function public.sklad_product_limit(uuid) to service_role;

create or replace function public.sklad_member(p_shop_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_shop_id is null or not public.is_shop_member(p_shop_id) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
end;
$$;
revoke execute on function public.sklad_member(uuid) from public, anon, authenticated;

/** The shop's settings row and its two first locations ("Predajňa" = sales, "Sklad" = receipts), made once. */
create or replace function public.sklad_setup(p_shop_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into public.sklad_settings (shop_id) values (p_shop_id) on conflict (shop_id) do nothing;
  if not exists (select 1 from public.sklad_locations where shop_id = p_shop_id) then
    insert into public.sklad_locations (shop_id, name, sort, is_sale_default) values (p_shop_id, 'Predajňa', 1, true);
    insert into public.sklad_locations (shop_id, name, sort, is_receipt_default) values (p_shop_id, 'Sklad', 2, true);
  end if;
end;
$$;
revoke execute on function public.sklad_setup(uuid) from public, anon, authenticated;

create or replace function public.sklad_default_location(p_shop_id uuid, p_receipt boolean)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select l.id from public.sklad_locations l
  where l.shop_id = p_shop_id
  order by case when p_receipt then l.is_receipt_default else l.is_sale_default end desc, l.sort, l.created_at
  limit 1
$$;
revoke execute on function public.sklad_default_location(uuid, boolean) from public, anon, authenticated;

-- ------------------------------------------------------------------ 3. the public side (inventory) follows the movements

/**
 * Writes inventory for the given products (NULL = every Sklad product of the shop; an empty array = none) and moves the
 * shop's freshness time to now. Only while 'sklad' is the shop's stock source; the guard below lets only this function
 * write while it is. A product without a sale price has no inventory row (not public).
 */
create or replace function public.sklad_apply(p_shop_id uuid, p_items uuid[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if public.stock_source_of(p_shop_id) <> 'sklad' then
    return;
  end if;
  perform set_config('ppi.sklad_apply', 'on', true);

  delete from public.inventory inv
  using public.sklad_items i
  where inv.shop_item_id = i.shop_item_id and i.shop_id = p_shop_id and i.sale_price is null
    and (p_items is null or i.shop_item_id = any (p_items));

  insert into public.inventory (shop_item_id, quantity, price, currency, source_updated_at, received_at)
  select i.shop_item_id, coalesce(t.qty, 0), i.sale_price, 'EUR', now(), now()
  from public.sklad_items i
  left join public.sklad_stock_total t on t.shop_item_id = i.shop_item_id
  where i.shop_id = p_shop_id and i.sale_price is not null
    and (p_items is null or i.shop_item_id = any (p_items))
  on conflict (shop_item_id) do update set
    quantity = excluded.quantity, price = excluded.price, currency = excluded.currency,
    source_updated_at = excluded.source_updated_at, received_at = excluded.received_at;

  insert into public.sync_sources (shop_id) values (p_shop_id) on conflict (shop_id) do nothing;
  update public.sync_sources
  set latest_file_time = now(), last_checked_at = now(), last_error = null, last_file_name = 'Sklad v Cacaduu'
  where shop_id = p_shop_id;

  perform set_config('ppi.sklad_apply', '', true);
end;
$$;
revoke execute on function public.sklad_apply(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.sklad_apply(uuid, uuid[]) to service_role;

-- While 'sklad' is the source, nothing but sklad_apply() changes the shop's inventory (file, program, POS agent, the
-- owner MCP's update_stock, the inventory reset). Deleting the whole shop still works.
create or replace function public.inventory_sklad_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
begin
  if coalesce(current_setting('ppi.sklad_apply', true), '') = 'on' then
    return coalesce(new, old);
  end if;
  select si.shop_id into v_shop from public.shop_items si where si.id = coalesce(new.shop_item_id, old.shop_item_id);
  if v_shop is not null
     and exists (select 1 from public.shop_stock_source s where s.shop_id = v_shop and s.source = 'sklad')
     and exists (select 1 from public.shops sh where sh.id = v_shop) then
    raise exception 'sklad_active' using errcode = '55000',
      hint = 'The stock is kept in "Sklad v Cacaduu"; change it there (a movement), or choose another stock source.';
  end if;
  return coalesce(new, old);
end;
$$;
drop trigger if exists inventory_sklad_guard on public.inventory;
create trigger inventory_sklad_guard before insert or update or delete on public.inventory
  for each row execute function public.inventory_sklad_guard();

-- A Sklad product is never deleted by the inventory reset or anything else while its shop exists (its movements are the
-- shop's records); deleting the shop still deletes everything.
create or replace function public.shop_items_sklad_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.sklad_items i where i.shop_item_id = old.id)
     and exists (select 1 from public.shops sh where sh.id = old.shop_id) then
    raise exception 'sklad_item' using errcode = '55000',
      hint = 'This product is kept in "Sklad v Cacaduu" and is not deleted with the stock.';
  end if;
  return old;
end;
$$;
drop trigger if exists shop_items_sklad_guard on public.shop_items;
create trigger shop_items_sklad_guard before delete on public.shop_items
  for each row execute function public.shop_items_sklad_guard();

/** Every product of the shop that is not yet in Sklad: sale price from the file (EUR only), quantity as an opening count. */
create or replace function public.sklad_adopt(p_shop_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_n integer;
  v_loc uuid;
begin
  perform public.sklad_setup(p_shop_id);
  v_loc := public.sklad_default_location(p_shop_id, false);
  with taken as (
    insert into public.sklad_items (shop_item_id, shop_id, sale_price)
    select si.id, p_shop_id, case when inv.currency = 'EUR' then inv.price end
    from public.shop_items si
    left join public.inventory inv on inv.shop_item_id = si.id
    where si.shop_id = p_shop_id
      and not exists (select 1 from public.sklad_items i where i.shop_item_id = si.id)
    returning shop_item_id
  )
  insert into public.sklad_movements (id, shop_id, shop_item_id, location_id, kind, qty, reason, created_by)
  select gen_random_uuid(), p_shop_id, t.shop_item_id, v_loc, 'count', inv.quantity, 'Počiatočný stav (zo súboru)', auth.uid()
  from taken t
  join public.inventory inv on inv.shop_item_id = t.shop_item_id
  where inv.quantity <> 0 and abs(inv.quantity) <= 1000000000;
  select count(*) into v_n from public.sklad_items where shop_id = p_shop_id;
  return v_n;
end;
$$;
revoke execute on function public.sklad_adopt(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ 4. "Zdroj zásob" with Sklad

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
    'changed_at', (select s.changed_at from public.shop_stock_source s where s.shop_id = p_shop_id),
    'sklad_products', (select count(*) from public.sklad_items i where i.shop_id = p_shop_id),
    'shop_products', (select count(*) from public.shop_items si where si.shop_id = p_shop_id),
    'sklad_limit', public.sklad_product_limit(p_shop_id));
end;
$$;
revoke execute on function public.owner_stock_source(uuid) from public, anon;
grant execute on function public.owner_stock_source(uuid) to authenticated;

-- 'file', 'agent' (a paired device) or 'sklad' (takes over the existing products; within the plan's product limit).
-- Refused while an inventory program is connected (disconnect it first). Switching away from Sklad deletes nothing.
create or replace function public.owner_set_stock_source(p_shop_id uuid, p_source text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old text;
  v_limit integer;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  if p_source is null or p_source not in ('file', 'agent', 'sklad') then
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
  if p_source = 'sklad' then
    v_limit := public.sklad_product_limit(p_shop_id);
    if v_limit is not null and (select count(*) from public.shop_items si where si.shop_id = p_shop_id
                                  and not exists (select 1 from public.sklad_items i where i.shop_item_id = si.id))
                               + (select count(*) from public.sklad_items i where i.shop_id = p_shop_id) > v_limit then
      raise exception 'plan_limit' using errcode = 'P0001';
    end if;
  end if;
  insert into public.shop_stock_source (shop_id, source, changed_at, changed_by)
  values (p_shop_id, p_source, now(), auth.uid())
  on conflict (shop_id) do update set source = excluded.source, changed_at = now(), changed_by = auth.uid();
  insert into public.shop_activity (shop_id, action, details)
  values (p_shop_id, 'stock_source_changed', jsonb_build_object('from', coalesce(v_old, 'file'), 'to', p_source));
  if p_source = 'sklad' then
    perform public.sklad_adopt(p_shop_id);
    perform public.sklad_apply(p_shop_id, null);
  end if;
end;
$$;
revoke execute on function public.owner_set_stock_source(uuid, text) from public, anon;
grant execute on function public.owner_set_stock_source(uuid, text) to authenticated;

-- As in update 52, plus: while Sklad is the shop's stock source, the folder and uploads are refused too.
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
  if exists (select 1 from public.inventory_connections c where c.shop_id = p_shop_id) then
    raise exception 'api_connected' using errcode = '55000',
      hint = 'The stock comes from the connected inventory program; disconnect it in My shop to upload files again.';
  end if;
  if public.stock_source_of(p_shop_id) = 'agent' then
    raise exception 'agent_connected' using errcode = '55000',
      hint = 'The stock comes from the POS agent; choose "files" as the stock source in My shop to upload files again.';
  end if;
  -- update 67
  if public.stock_source_of(p_shop_id) = 'sklad' then
    raise exception 'sklad_active' using errcode = '55000',
      hint = 'The stock is kept in "Sklad v Cacaduu"; choose "files" as the stock source in My shop to upload files again.';
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

-- As in update 52, plus: no inventory program while Sklad is the stock source.
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
  if public.stock_source_of(p_shop_id) = 'sklad' then
    return 'sklad';
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

-- ------------------------------------------------------------------ 5. movements

/**
 * One movement, by the client's own id (a retry with the same id changes nothing and answers duplicate: true).
 * p_qty: receipt / sale / writeoff / transfer = how many (> 0); count = the number counted at the location (≥ 0, the
 * difference is stored); correction = signed (± the difference), with a reason. Receipt may carry the unit cost
 * without VAT (private: last and average cost). Then the public side follows (sklad_apply).
 */
create or replace function public.owner_sklad_move(
  p_shop_id uuid, p_id uuid, p_item_id uuid, p_kind text, p_qty numeric,
  p_location_id uuid default null, p_to_location_id uuid default null, p_unit_cost numeric default null,
  p_reason text default null, p_ref text default null, p_device text default null, p_client_at timestamptz default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_kind public.sklad_kind;
  v_loc uuid;
  v_to uuid;
  v_qty numeric;
  v_here numeric;
  v_total numeric;
  v_item public.sklad_items%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_ref text := nullif(btrim(coalesce(p_ref, '')), '');
  v_old public.sklad_movements%rowtype;
begin
  perform public.sklad_member(p_shop_id);
  if p_id is null then raise exception 'id' using errcode = '22023'; end if;
  select * into v_old from public.sklad_movements where id = p_id;
  if found then
    if v_old.shop_id <> p_shop_id then raise exception 'id' using errcode = '22023'; end if;
    return jsonb_build_object('duplicate', true, 'id', v_old.id, 'item_id', v_old.shop_item_id,
                              'total', (select t.qty from public.sklad_stock_total t where t.shop_item_id = v_old.shop_item_id));
  end if;
  begin
    v_kind := p_kind::public.sklad_kind;
  exception when invalid_text_representation then
    raise exception 'kind' using errcode = '22023';
  end;
  -- one movement of a product at a time (the average cost and the counted difference stay right)
  perform pg_advisory_xact_lock(hashtextextended('sklad:' || coalesce(p_item_id::text, ''), 0));
  select * into v_item from public.sklad_items where shop_item_id = p_item_id and shop_id = p_shop_id;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform public.sklad_setup(p_shop_id);
  v_loc := coalesce(p_location_id, public.sklad_default_location(p_shop_id, v_kind = 'receipt'));
  if not exists (select 1 from public.sklad_locations l where l.id = v_loc and l.shop_id = p_shop_id) then
    raise exception 'location' using errcode = '22023';
  end if;
  if p_qty is null or abs(p_qty) > 1000000000 or p_qty <> round(p_qty, 3) then
    raise exception 'qty' using errcode = '22023';
  end if;
  if p_unit_cost is not null and (v_kind <> 'receipt' or p_unit_cost < 0 or p_unit_cost > 1000000000) then
    raise exception 'unit_cost' using errcode = '22023';
  end if;
  select coalesce(sum(s.qty), 0) into v_here from public.sklad_stock s where s.shop_item_id = p_item_id and s.location_id = v_loc;

  if v_kind = 'receipt' then
    if p_qty <= 0 then raise exception 'qty' using errcode = '22023'; end if;
    v_qty := p_qty;
  elsif v_kind in ('sale', 'writeoff') then
    if p_qty <= 0 then raise exception 'qty' using errcode = '22023'; end if;
    if v_kind = 'writeoff' and v_reason is null then raise exception 'reason' using errcode = '22023'; end if;
    v_qty := -p_qty;
  elsif v_kind = 'transfer' then
    if p_qty <= 0 then raise exception 'qty' using errcode = '22023'; end if;
    v_to := p_to_location_id;
    if v_to is null or v_to = v_loc or not exists (select 1 from public.sklad_locations l where l.id = v_to and l.shop_id = p_shop_id) then
      raise exception 'to_location' using errcode = '22023';
    end if;
    v_qty := p_qty;
  elsif v_kind = 'count' then
    if p_qty < 0 then raise exception 'qty' using errcode = '22023'; end if;
    v_qty := p_qty - v_here;
    v_ref := coalesce(v_ref, 'napočítané ' || trim(to_char(p_qty, 'FM999999999990.###')));
    if v_qty = 0 then
      -- the count matches: nothing to store, but the stock is confirmed as right
      perform public.sklad_apply(p_shop_id, array[p_item_id]);
      return jsonb_build_object('duplicate', false, 'id', null, 'item_id', p_item_id, 'unchanged', true,
                                'total', (select t.qty from public.sklad_stock_total t where t.shop_item_id = p_item_id));
    end if;
  else -- correction
    if p_qty = 0 then raise exception 'qty' using errcode = '22023'; end if;
    if v_reason is null then raise exception 'reason' using errcode = '22023'; end if;
    v_qty := p_qty;
  end if;

  insert into public.sklad_movements (id, shop_id, shop_item_id, location_id, kind, qty, to_location_id, unit_cost,
                                      reason, ref, device_label, created_by, client_at)
  values (p_id, p_shop_id, p_item_id, v_loc, v_kind, v_qty, v_to, p_unit_cost, left(v_reason, 200), left(v_ref, 80),
          nullif(left(btrim(coalesce(p_device, '')), 60), ''), auth.uid(), p_client_at)
  on conflict (id) do nothing;
  if not found then
    return jsonb_build_object('duplicate', true, 'id', p_id, 'item_id', p_item_id);
  end if;

  if v_kind = 'receipt' and p_unit_cost is not null then
    select coalesce(t.qty, 0) - v_qty into v_total from public.sklad_stock_total t where t.shop_item_id = p_item_id;
    update public.sklad_items
    set last_cost = round(p_unit_cost, 4), last_cost_at = now(),
        avg_cost = round(case when coalesce(avg_cost, -1) < 0 or coalesce(v_total, 0) <= 0 then p_unit_cost
                              else (avg_cost * v_total + p_unit_cost * v_qty) / (v_total + v_qty) end, 4),
        updated_at = now()
    where shop_item_id = p_item_id;
  end if;

  perform public.sklad_apply(p_shop_id, array[p_item_id]);
  return jsonb_build_object('duplicate', false, 'id', p_id, 'item_id', p_item_id,
                            'total', (select t.qty from public.sklad_stock_total t where t.shop_item_id = p_item_id));
end;
$$;
revoke execute on function public.owner_sklad_move(uuid, uuid, uuid, text, numeric, uuid, uuid, numeric, text, text, text, timestamptz) from public, anon;
grant execute on function public.owner_sklad_move(uuid, uuid, uuid, text, numeric, uuid, uuid, numeric, text, text, text, timestamptz) to authenticated;

/** "Stav je správny": the stock is right as it is → the shop's freshness time moves to now (no product changes). */
create or replace function public.owner_sklad_confirm(p_shop_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.sklad_member(p_shop_id);
  perform public.sklad_setup(p_shop_id);
  if public.stock_source_of(p_shop_id) <> 'sklad' then
    raise exception 'not_sklad' using errcode = '55000';
  end if;
  update public.sklad_settings set confirmed_at = now(), updated_at = now() where shop_id = p_shop_id;
  perform public.sklad_apply(p_shop_id, '{}'::uuid[]);
  insert into public.shop_activity (shop_id, action, details) values (p_shop_id, 'sklad_confirmed', '{}'::jsonb);
  return jsonb_build_object('confirmed_at', now());
end;
$$;
revoke execute on function public.owner_sklad_confirm(uuid) from public, anon;
grant execute on function public.owner_sklad_confirm(uuid) to authenticated;

-- ------------------------------------------------------------------ 6. products

/**
 * "Nový produkt" (p_item_id NULL) or "Upraviť". p jsonb: name, code, ean, brand, description, unit, vat_rate,
 * sale_price (with VAT; null = not public), min_qty, shelf, supplier; only the keys given change. A new product needs a
 * name; without a code it gets the next free "C00001". EAN unique among the shop's products. Free plan: 50 products.
 */
create or replace function public.owner_sklad_save_product(p_shop_id uuid, p_item_id uuid, p jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid := p_item_id;
  v_limit integer;
  v_name text := nullif(btrim(coalesce(p ->> 'name', '')), '');
  v_code text := nullif(btrim(coalesce(p ->> 'code', '')), '');
  v_ean text := nullif(regexp_replace(coalesce(p ->> 'ean', ''), '\s', '', 'g'), '');
  v_n integer;
  v_num numeric;
  v_key text;
begin
  perform public.sklad_member(p_shop_id);
  perform public.sklad_setup(p_shop_id);
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'bad_argument' using errcode = '22023'; end if;
  if v_name is not null and char_length(v_name) > 300 then raise exception 'name' using errcode = '22023'; end if;
  if v_code is not null and char_length(v_code) > 100 then raise exception 'code' using errcode = '22023'; end if;
  if v_ean is not null and v_ean !~ '^[0-9A-Za-z-]{4,32}$' then raise exception 'ean' using errcode = '22023'; end if;
  -- numbers given as text or number; empty = null
  foreach v_key in array array['vat_rate', 'sale_price', 'min_qty'] loop
    if p ? v_key and nullif(p ->> v_key, '') is not null then
      begin
        v_num := (p ->> v_key)::numeric;
      exception when others then
        raise exception '%', v_key using errcode = '22023';
      end;
      if v_num < 0 or v_num > 1000000000 or (v_key = 'vat_rate' and v_num > 100) then
        raise exception '%', v_key using errcode = '22023';
      end if;
    end if;
  end loop;
  if p ? 'unit' and coalesce(p ->> 'unit', '') not in ('ks', 'l', 'kg', 'm') then raise exception 'unit' using errcode = '22023'; end if;

  if v_ean is not null and exists (select 1 from public.shop_items si where si.shop_id = p_shop_id and si.ean = v_ean
                                     and si.id is distinct from v_id) then
    raise exception 'ean_taken' using errcode = '23505';
  end if;

  if v_id is null then
    if v_name is null then raise exception 'name' using errcode = '22023'; end if;
    v_limit := public.sklad_product_limit(p_shop_id);
    if v_limit is not null and (select count(*) from public.sklad_items i where i.shop_id = p_shop_id) >= v_limit then
      raise exception 'plan_limit' using errcode = 'P0001';
    end if;
    if v_code is null then
      v_n := (select count(*) from public.shop_items si where si.shop_id = p_shop_id) + 1;
      loop
        v_code := 'C' || lpad(v_n::text, 5, '0');
        exit when not exists (select 1 from public.shop_items si where si.shop_id = p_shop_id and si.source_code = v_code);
        v_n := v_n + 1;
      end loop;
    elsif exists (select 1 from public.shop_items si where si.shop_id = p_shop_id and si.source_code = v_code) then
      raise exception 'code_taken' using errcode = '23505';
    end if;
    if v_ean is not null then
      insert into public.products (ean, name, brand) values (v_ean, v_name, nullif(btrim(coalesce(p ->> 'brand', '')), ''))
      on conflict (ean) do nothing;
    end if;
    insert into public.shop_items (shop_id, source_code, name, ean, brand, description, product_id, updated_at)
    values (p_shop_id, v_code, v_name, v_ean, nullif(left(btrim(coalesce(p ->> 'brand', '')), 100), ''),
            nullif(left(btrim(coalesce(p ->> 'description', '')), 5000), ''),
            (select pr.id from public.products pr where pr.ean = v_ean), now())
    returning id into v_id;
    insert into public.sklad_items (shop_item_id, shop_id) values (v_id, p_shop_id);
  else
    if not exists (select 1 from public.sklad_items i where i.shop_item_id = v_id and i.shop_id = p_shop_id) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    if p ? 'name' and v_name is null then raise exception 'name' using errcode = '22023'; end if;
    if v_code is not null and exists (select 1 from public.shop_items si where si.shop_id = p_shop_id
                                        and si.source_code = v_code and si.id <> v_id) then
      raise exception 'code_taken' using errcode = '23505';
    end if;
    if v_ean is not null then
      insert into public.products (ean, name, brand) values (v_ean, coalesce(v_name, (select name from public.shop_items where id = v_id)), null)
      on conflict (ean) do nothing;
    end if;
    update public.shop_items si set
      name = case when p ? 'name' then v_name else si.name end,
      source_code = coalesce(v_code, si.source_code),
      ean = case when p ? 'ean' then v_ean else si.ean end,
      product_id = case when p ? 'ean' then (select pr.id from public.products pr where pr.ean = v_ean) else si.product_id end,
      brand = case when p ? 'brand' then nullif(left(btrim(coalesce(p ->> 'brand', '')), 100), '') else si.brand end,
      description = case when p ? 'description' then nullif(left(btrim(coalesce(p ->> 'description', '')), 5000), '') else si.description end,
      updated_at = now()
    where si.id = v_id;
  end if;

  update public.sklad_items i set
    unit = case when p ? 'unit' then p ->> 'unit' else i.unit end,
    vat_rate = case when p ? 'vat_rate' and nullif(p ->> 'vat_rate', '') is not null then (p ->> 'vat_rate')::numeric else i.vat_rate end,
    sale_price = case when p ? 'sale_price' then round(nullif(p ->> 'sale_price', '')::numeric, 2) else i.sale_price end,
    min_qty = case when p ? 'min_qty' then coalesce(nullif(p ->> 'min_qty', '')::numeric, 0) else i.min_qty end,
    shelf = case when p ? 'shelf' then nullif(left(btrim(coalesce(p ->> 'shelf', '')), 80), '') else i.shelf end,
    supplier = case when p ? 'supplier' then nullif(left(btrim(coalesce(p ->> 'supplier', '')), 120), '') else i.supplier end,
    updated_at = now()
  where i.shop_item_id = v_id;

  insert into public.shop_activity (shop_id, action, details)
  values (p_shop_id, 'sklad_product_saved', jsonb_build_object('item_id', v_id, 'new', p_item_id is null));
  perform public.sklad_apply(p_shop_id, array[v_id]);
  return v_id;
end;
$$;
revoke execute on function public.owner_sklad_save_product(uuid, uuid, jsonb) from public, anon;
grant execute on function public.owner_sklad_save_product(uuid, uuid, jsonb) to authenticated;

/** The rows of "Produkty": stock per location, total, price, and the four filters (all / low / out / no_price). */
create or replace function public.owner_sklad_products(p_shop_id uuid, p_q text default null, p_filter text default 'all',
                                                       p_limit integer default 100, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_q text := nullif(public.search_text(btrim(coalesce(p_q, ''))), '');
  v_out jsonb;
begin
  perform public.sklad_member(p_shop_id);
  with base as (
    select si.id, si.name, si.source_code, si.ean, i.sale_price, i.min_qty, i.unit, i.shelf,
           coalesce(t.qty, 0) as total,
           coalesce((select jsonb_agg(jsonb_build_object('location_id', l.id, 'name', l.name, 'qty', coalesce(s.qty, 0)) order by l.sort, l.created_at)
                     from public.sklad_locations l
                     left join public.sklad_stock s on s.location_id = l.id and s.shop_item_id = si.id
                     where l.shop_id = p_shop_id), '[]'::jsonb) as locations
    from public.sklad_items i
    join public.shop_items si on si.id = i.shop_item_id
    left join public.sklad_stock_total t on t.shop_item_id = i.shop_item_id
    where i.shop_id = p_shop_id
      and (v_q is null or public.search_text(si.name) like '%' || v_q || '%' or public.search_text(si.source_code) like '%' || v_q || '%'
           or coalesce(si.ean, '') like '%' || btrim(p_q) || '%')
  ), flagged as (
    select b.*, b.total <= 0 as is_out, b.total > 0 and b.total < b.min_qty as is_low, b.sale_price is null as no_price from base b
  )
  select jsonb_build_object(
    'counts', jsonb_build_object('all', count(*), 'low', count(*) filter (where is_low or is_out),
                                 'out', count(*) filter (where is_out), 'no_price', count(*) filter (where no_price)),
    'rows', coalesce((select jsonb_agg(to_jsonb(r) order by lower(r.name)) from (
              select f.id, f.name, f.source_code as code, f.ean, f.sale_price, f.min_qty, f.unit, f.shelf, f.total, f.locations,
                     f.is_out, f.is_low, f.no_price
              from flagged f
              where case coalesce(p_filter, 'all') when 'low' then f.is_low or f.is_out when 'out' then f.is_out
                                                   when 'no_price' then f.no_price else true end
              order by lower(f.name)
              limit least(greatest(coalesce(p_limit, 100), 1), 500) offset greatest(coalesce(p_offset, 0), 0)) r), '[]'::jsonb),
    'products', (select count(*) from public.sklad_items i where i.shop_id = p_shop_id),
    'limit', public.sklad_product_limit(p_shop_id),
    'source', public.stock_source_of(p_shop_id))
  into v_out
  from flagged;
  return v_out;
end;
$$;
revoke execute on function public.owner_sklad_products(uuid, text, text, integer, integer) from public, anon;
grant execute on function public.owner_sklad_products(uuid, text, text, integer, integer) to authenticated;

/** A product by its code or EAN (the scanner): its id, or NULL when the shop has no such product. */
create or replace function public.owner_sklad_find(p_shop_id uuid, p_code text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select si.id
  from public.sklad_items i join public.shop_items si on si.id = i.shop_item_id
  where i.shop_id = p_shop_id and public.is_shop_member(p_shop_id)
    and (si.ean = btrim(p_code) or si.source_code = btrim(p_code))
  order by (si.ean = btrim(p_code)) desc
  limit 1
$$;
revoke execute on function public.owner_sklad_find(uuid, text) from public, anon;
grant execute on function public.owner_sklad_find(uuid, text) to authenticated;

/** The product card: everything, stock per location, the private "Nákup" part, the last 5 movements. */
create or replace function public.owner_sklad_product(p_shop_id uuid, p_item_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_out jsonb;
  v_margin boolean;
begin
  perform public.sklad_member(p_shop_id);
  v_margin := coalesce((select s.margin_reports from public.sklad_settings s where s.shop_id = p_shop_id), true);
  select jsonb_build_object(
    'id', si.id, 'name', si.name, 'code', si.source_code, 'ean', si.ean, 'brand', si.brand, 'description', si.description,
    'unit', i.unit, 'vat_rate', i.vat_rate, 'sale_price', i.sale_price, 'min_qty', i.min_qty, 'shelf', i.shelf,
    'supplier', i.supplier, 'last_cost', i.last_cost, 'last_cost_at', i.last_cost_at, 'avg_cost', i.avg_cost,
    'margin_reports', v_margin,
    'total', coalesce(t.qty, 0),
    'public', exists (select 1 from public.inventory inv where inv.shop_item_id = si.id),
    'locations', coalesce((select jsonb_agg(jsonb_build_object('location_id', l.id, 'name', l.name, 'note', l.note,
                                                              'qty', coalesce(s.qty, 0)) order by l.sort, l.created_at)
                           from public.sklad_locations l
                           left join public.sklad_stock s on s.location_id = l.id and s.shop_item_id = si.id
                           where l.shop_id = p_shop_id), '[]'::jsonb),
    'movements', coalesce((select jsonb_agg(m order by m.created_at desc) from (
                    select mv.id, mv.kind, mv.qty, mv.unit_cost, mv.reason, mv.ref, mv.device_label, mv.created_at,
                           l.name as location, l2.name as to_location
                    from public.sklad_movements mv
                    join public.sklad_locations l on l.id = mv.location_id
                    left join public.sklad_locations l2 on l2.id = mv.to_location_id
                    where mv.shop_item_id = si.id
                    order by mv.created_at desc limit 5) m), '[]'::jsonb),
    'movement_count', (select count(*) from public.sklad_movements mv where mv.shop_item_id = si.id))
  into v_out
  from public.sklad_items i
  join public.shop_items si on si.id = i.shop_item_id
  left join public.sklad_stock_total t on t.shop_item_id = i.shop_item_id
  where i.shop_item_id = p_item_id and i.shop_id = p_shop_id;
  return v_out;
end;
$$;
revoke execute on function public.owner_sklad_product(uuid, uuid) from public, anon;
grant execute on function public.owner_sklad_product(uuid, uuid) to authenticated;

/** "Pohyby": newest first, filtered by product, kind, location and the shop's days [p_from, p_to]. */
create or replace function public.owner_sklad_movements(p_shop_id uuid, p_item_id uuid default null, p_kind text default null,
                                                        p_location_id uuid default null, p_from date default null,
                                                        p_to date default null, p_limit integer default 100,
                                                        p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_out jsonb;
begin
  perform public.sklad_member(p_shop_id);
  select coalesce(timezone, 'UTC') into v_tz from public.shops where id = p_shop_id;
  with f as (
    select mv.*, si.name as item_name, si.source_code as code, l.name as location, l2.name as to_location
    from public.sklad_movements mv
    join public.shop_items si on si.id = mv.shop_item_id
    join public.sklad_locations l on l.id = mv.location_id
    left join public.sklad_locations l2 on l2.id = mv.to_location_id
    where mv.shop_id = p_shop_id
      and (p_item_id is null or mv.shop_item_id = p_item_id)
      and (nullif(p_kind, '') is null or mv.kind::text = p_kind)
      and (p_location_id is null or mv.location_id = p_location_id or mv.to_location_id = p_location_id)
      and (p_from is null or mv.created_at >= (p_from::timestamp at time zone v_tz))
      and (p_to is null or mv.created_at < ((p_to + 1)::timestamp at time zone v_tz))
  )
  select jsonb_build_object(
    'total', (select count(*) from f),
    'rows', coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc) from (
               select f.id, f.shop_item_id as item_id, f.item_name, f.code, f.kind, f.qty, f.location, f.to_location,
                      f.unit_cost, f.reason, f.ref, f.device_label, f.created_at, f.client_at
               from f order by f.created_at desc
               limit least(greatest(coalesce(p_limit, 100), 1), 50000) offset greatest(coalesce(p_offset, 0), 0)) r), '[]'::jsonb))
  into v_out;
  return v_out;
end;
$$;
revoke execute on function public.owner_sklad_movements(uuid, uuid, text, uuid, date, date, integer, integer) from public, anon;
grant execute on function public.owner_sklad_movements(uuid, uuid, text, uuid, date, date, integer, integer) to authenticated;

-- ------------------------------------------------------------------ 7. locations and settings

create or replace function public.owner_sklad_save_location(p_shop_id uuid, p_id uuid, p_name text, p_note text,
                                                            p_sale_default boolean default false,
                                                            p_receipt_default boolean default false)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid := p_id;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
begin
  perform public.sklad_member(p_shop_id);
  perform public.sklad_setup(p_shop_id);
  if v_name is null or char_length(v_name) > 80 then raise exception 'name' using errcode = '22023'; end if;
  if v_id is not null and not exists (select 1 from public.sklad_locations l where l.id = v_id and l.shop_id = p_shop_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_id is null then
    if (select count(*) from public.sklad_locations l where l.shop_id = p_shop_id) >= 20 then
      raise exception 'too_many' using errcode = 'P0001';
    end if;
    insert into public.sklad_locations (shop_id, name, note, sort)
    values (p_shop_id, v_name, nullif(left(btrim(coalesce(p_note, '')), 200), ''),
            coalesce((select max(sort) from public.sklad_locations where shop_id = p_shop_id), 0) + 1)
    returning id into v_id;
  else
    update public.sklad_locations set name = v_name, note = nullif(left(btrim(coalesce(p_note, '')), 200), '') where id = v_id;
  end if;
  if coalesce(p_sale_default, false) then
    update public.sklad_locations set is_sale_default = false where shop_id = p_shop_id and is_sale_default and id <> v_id;
    update public.sklad_locations set is_sale_default = true where id = v_id;
  end if;
  if coalesce(p_receipt_default, false) then
    update public.sklad_locations set is_receipt_default = false where shop_id = p_shop_id and is_receipt_default and id <> v_id;
    update public.sklad_locations set is_receipt_default = true where id = v_id;
  end if;
  insert into public.shop_activity (shop_id, action, details)
  values (p_shop_id, 'sklad_location_saved', jsonb_build_object('location_id', v_id, 'new', p_id is null));
  return v_id;
end;
$$;
revoke execute on function public.owner_sklad_save_location(uuid, uuid, text, text, boolean, boolean) from public, anon;
grant execute on function public.owner_sklad_save_location(uuid, uuid, text, text, boolean, boolean) to authenticated;

create or replace function public.owner_sklad_save_settings(p_shop_id uuid, p_margin_reports boolean, p_reminder_on boolean,
                                                            p_reminder_time time)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.sklad_member(p_shop_id);
  perform public.sklad_setup(p_shop_id);
  update public.sklad_settings set
    margin_reports = coalesce(p_margin_reports, margin_reports),
    reminder_on = coalesce(p_reminder_on, reminder_on),
    reminder_time = coalesce(p_reminder_time, reminder_time),
    updated_at = now()
  where shop_id = p_shop_id;
  insert into public.shop_activity (shop_id, action, details) values (p_shop_id, 'sklad_settings_saved', '{}'::jsonb);
end;
$$;
revoke execute on function public.owner_sklad_save_settings(uuid, boolean, boolean, time) from public, anon;
grant execute on function public.owner_sklad_save_settings(uuid, boolean, boolean, time) to authenticated;

/**
 * "Prehľad" and the banner: the source, whether today needs a confirmation (no movement and no confirmation today in the
 * shop's time zone), the minutes until the stock on the shop page turns stale, yesterday's numbers, "Doobjednať", the
 * plan counter, the locations and the settings.
 */
create or replace function public.owner_sklad_overview(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_today date;
  v_day_start timestamptz;
  v_last_move timestamptz;
  v_conf timestamptz;
  v_fresh timestamptz;
begin
  perform public.sklad_member(p_shop_id);
  select coalesce(timezone, 'UTC') into v_tz from public.shops where id = p_shop_id;
  v_today := (now() at time zone v_tz)::date;
  v_day_start := v_today::timestamp at time zone v_tz;
  select max(created_at) into v_last_move from public.sklad_movements where shop_id = p_shop_id;
  select confirmed_at into v_conf from public.sklad_settings where shop_id = p_shop_id;
  select latest_file_time into v_fresh from public.sync_sources where shop_id = p_shop_id;
  return jsonb_build_object(
    'source', public.stock_source_of(p_shop_id),
    'timezone', v_tz,
    'last_movement_at', v_last_move,
    'last_movement_kind', (select kind from public.sklad_movements where shop_id = p_shop_id order by created_at desc limit 1),
    'confirmed_at', v_conf,
    'needs_check', public.stock_source_of(p_shop_id) = 'sklad'
                   and coalesce(v_last_move < v_day_start, true) and coalesce(v_conf < v_day_start, true),
    'fresh_until', case when v_fresh is not null then v_fresh + interval '24 hours' end,
    'freshness_state', public.freshness_label(v_fresh),
    'yesterday', (select jsonb_build_object(
                    'sales', count(*) filter (where kind = 'sale'),
                    'sold', coalesce(-sum(qty) filter (where kind = 'sale'), 0),
                    'receipts', count(*) filter (where kind = 'receipt'),
                    'received', coalesce(sum(qty) filter (where kind = 'receipt'), 0))
                  from public.sklad_movements
                  where shop_id = p_shop_id and created_at >= v_day_start - interval '1 day' and created_at < v_day_start),
    'low', coalesce((select jsonb_agg(x order by x.total, lower(x.name)) from (
              select si.id, si.name, i.min_qty, i.unit, coalesce(t.qty, 0) as total
              from public.sklad_items i join public.shop_items si on si.id = i.shop_item_id
              left join public.sklad_stock_total t on t.shop_item_id = i.shop_item_id
              where i.shop_id = p_shop_id and i.min_qty > 0 and coalesce(t.qty, 0) < i.min_qty
              order by coalesce(t.qty, 0), lower(si.name) limit 8) x), '[]'::jsonb),
    'low_count', (select count(*) from public.sklad_items i left join public.sklad_stock_total t on t.shop_item_id = i.shop_item_id
                  where i.shop_id = p_shop_id and coalesce(t.qty, 0) > 0 and coalesce(t.qty, 0) < i.min_qty),
    'out_count', (select count(*) from public.sklad_items i left join public.sklad_stock_total t on t.shop_item_id = i.shop_item_id
                  where i.shop_id = p_shop_id and coalesce(t.qty, 0) <= 0),
    'no_price_count', (select count(*) from public.sklad_items i where i.shop_id = p_shop_id and i.sale_price is null),
    'products', (select count(*) from public.sklad_items i where i.shop_id = p_shop_id),
    'limit', public.sklad_product_limit(p_shop_id),
    'has_plan', public.shop_has_plan(p_shop_id),
    'locations', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'note', l.note,
                                                              'sale_default', l.is_sale_default,
                                                              'receipt_default', l.is_receipt_default) order by l.sort, l.created_at)
                           from public.sklad_locations l where l.shop_id = p_shop_id), '[]'::jsonb),
    'settings', (select jsonb_build_object('margin_reports', s.margin_reports, 'reminder_on', s.reminder_on,
                                           'reminder_time', to_char(s.reminder_time, 'HH24:MI'))
                 from public.sklad_settings s where s.shop_id = p_shop_id));
end;
$$;
revoke execute on function public.owner_sklad_overview(uuid) from public, anon;
grant execute on function public.owner_sklad_overview(uuid) to authenticated;

/** Môj obchod's first step into Sklad: the settings row and the two locations exist (no stock source change). */
create or replace function public.owner_sklad_start(p_shop_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.sklad_member(p_shop_id);
  perform public.sklad_setup(p_shop_id);
end;
$$;
revoke execute on function public.owner_sklad_start(uuid) from public, anon;
grant execute on function public.owner_sklad_start(uuid) to authenticated;

-- ------------------------------------------------------------------ 8. the daily reminder and the job

create or replace function public.sklad_cron_ok(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(length(p_secret) >= 32 and exists (
    select 1 from vault.decrypted_secrets
    where name = 'ppi_sklad_cron'
      and encode(sha256(convert_to(decrypted_secret, 'UTF8')), 'hex')
          = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')), false)
$$;
revoke execute on function public.sklad_cron_ok(text) from public, anon, authenticated;
grant execute on function public.sklad_cron_ok(text) to service_role;

do $$
begin
  if to_regclass('vault.secrets') is not null
     and not exists (select 1 from vault.secrets where name = 'ppi_sklad_cron') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      'ppi_sklad_cron', 'PPI: the Sklad job proves itself to the sklad function');
  end if;
end;
$$;

/**
 * The shops whose reminder is due now (Sklad is the source, the reminder is on, it is past the reminder time in the
 * shop's time zone, today had no movement and no confirmation, not reminded today), claimed at once (reminded_on =
 * today), with the owners' e-mail addresses and languages. Only the service role (the sklad function's job).
 */
create or replace function public.sklad_reminders_due()
returns table (shop_id uuid, shop_name text, shop_slug text, recipients jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    update public.sklad_settings st
    set reminded_on = (now() at time zone coalesce(sh.timezone, 'UTC'))::date
    from public.shops sh
    where sh.id = st.shop_id and sh.is_active and st.reminder_on
      and public.stock_source_of(st.shop_id) = 'sklad'
      and (now() at time zone coalesce(sh.timezone, 'UTC'))::time >= st.reminder_time
      and st.reminded_on is distinct from (now() at time zone coalesce(sh.timezone, 'UTC'))::date
      and coalesce(st.confirmed_at < ((now() at time zone coalesce(sh.timezone, 'UTC'))::date::timestamp at time zone coalesce(sh.timezone, 'UTC')), true)
      and not exists (select 1 from public.sklad_movements m
                      where m.shop_id = st.shop_id
                        and m.created_at >= ((now() at time zone coalesce(sh.timezone, 'UTC'))::date::timestamp at time zone coalesce(sh.timezone, 'UTC')))
    returning st.shop_id, sh.name, sh.slug
  )
  select d.shop_id, d.name, d.slug,
         coalesce((select jsonb_agg(jsonb_build_object('email', u.email, 'lang', coalesce(p.language, 'sk')))
                   from public.shop_members sm
                   join auth.users u on u.id = sm.user_id
                   left join public.profiles p on p.user_id = sm.user_id
                   where sm.shop_id = d.shop_id and u.email is not null), '[]'::jsonb)
  from due d;
end;
$$;
revoke execute on function public.sklad_reminders_due() from public, anon, authenticated;
grant execute on function public.sklad_reminders_due() to service_role;

/** The shops in Sklad mode whose products changed since their last IndexNow ping (the job pings them, ≤ once an hour). */
create or replace function public.sklad_indexnow_shops()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.shop_id from public.shop_stock_source s
  where s.source = 'sklad'
    and exists (select 1 from public.inventory inv join public.shop_items si on si.id = inv.shop_item_id
                where si.shop_id = s.shop_id and inv.indexnow_at > now() - interval '2 hours')
$$;
revoke execute on function public.sklad_indexnow_shops() from public, anon, authenticated;
grant execute on function public.sklad_indexnow_shops() to service_role;

do $$
declare
  v_call text := $call$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_project_url') || '/functions/v1/sklad',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'x-ppi-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'ppi_sklad_cron')),
      body := jsonb_build_object('action', 'tick'),
      timeout_milliseconds := 30000)$call$;
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'cron' and p.proname = 'schedule') then
    raise notice 'pg_cron is not on: the Sklad reminders are not sent.';
    return;
  end if;
  perform cron.schedule('ppi-sklad-tick', '*/15 * * * *', v_call);
end;
$$;
