-- PPI · 43 · "Začať sklad odznova": remove products missing from the last file, reset the whole inventory, delete the
-- uploaded stock files — safely (backup CSV, 30-day trash, "Obnoviť sklad", activity log).
--
--  - owner_delete_stock_files(): "Vymazať všetky nahrané súbory" — the reports of every uploaded stock file
--    ("Posledné nahrané súbory"), the file name and the mapping example rows go; stock-pull then deletes the raw
--    files from Storage (raw_files_delete_before). The inventory and its freshness stay as they are.
--  - owner_inventory_reset(..., 'missing'): removes only the products that are sold out because they were missing
--    from the latest file (not the ones the file itself lists with 0).
--  - owner_inventory_reset(..., 'all', <shop name>): removes every product, quantity and price of the shop and every
--    uploaded file; optionally the column mapping too. Translations and descriptions come back with a product that
--    returns with the same code (keep_translations, default on).
--  - Before either: a backup CSV of the whole current inventory (public fields + translations; a shop's private
--    columns are never stored, so they can never be in it), kept 30 days. Removed products wait 30 days in a trash;
--    owner_inventory_restore() brings them back exactly, unless a newer stock file has been applied since.
--  - At most 3 inventory resets per shop and day; every action is written to shop_activity.
--  - Never touches anything else: blog, slider, assistant, private folders and their files, contacts, domain,
--    subscription, opening hours.
-- Run once in the SQL Editor (after update 42). Redeploy stock-pull from its new index.ts (it deletes the raw files).

-- ------------------------------------------------------------------ 1. tables

-- What owners did to their shop's stock and files (read by the owners; written only by the functions below).
create table if not exists public.shop_activity (
  id      bigint generated always as identity primary key,
  shop_id uuid not null references public.shops (id) on delete cascade,
  at      timestamptz not null default now(),
  actor   uuid references auth.users (id) on delete set null,
  action  text not null check (action in ('stock_files_deleted', 'inventory_missing_removed', 'inventory_reset',
                                          'inventory_restored', 'inventory_purged')),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object')
);
create index if not exists shop_activity_shop_idx on public.shop_activity (shop_id, at desc);
alter table public.shop_activity enable row level security;
revoke all on public.shop_activity from public, anon, authenticated;
grant select on public.shop_activity to authenticated;
grant all on public.shop_activity to service_role;
drop policy if exists "shop_activity: members read" on public.shop_activity;
create policy "shop_activity: members read" on public.shop_activity
  for select to authenticated using (public.is_shop_member(shop_id));

-- One removal of products ("missing" = option A, "all" = option B) with what is needed to undo it.
create table if not exists public.inventory_resets (
  id                bigint generated always as identity primary key,
  shop_id           uuid not null references public.shops (id) on delete cascade,
  kind              text not null check (kind in ('missing', 'all')),
  created_at        timestamptz not null default now(),
  actor             uuid references auth.users (id) on delete set null,
  items             integer not null default 0 check (items >= 0),
  files             integer not null default 0 check (files >= 0),
  keep_translations boolean not null default true,
  cleared_mapping   boolean not null default false,
  -- The stock source as it was (mapping, its state, the latest file's time): restored with the products.
  source_before     jsonb not null default '{}'::jsonb,
  expires_at        timestamptz not null default now() + interval '30 days',
  restored_at       timestamptz,
  purged_at         timestamptz
);
create index if not exists inventory_resets_shop_idx on public.inventory_resets (shop_id, created_at desc);
alter table public.inventory_resets enable row level security;
revoke all on public.inventory_resets from public, anon, authenticated;
grant all on public.inventory_resets to service_role;

-- The removed products, each with its stock row, its Cacaduu description and its translations, exactly as they were.
create table if not exists public.inventory_trash (
  id            bigint generated always as identity primary key,
  reset_id      bigint not null references public.inventory_resets (id) on delete cascade,
  shop_id       uuid not null references public.shops (id) on delete cascade,
  source_code   text not null,
  item          jsonb not null,
  inventory     jsonb,
  description   jsonb,
  translations  jsonb not null default '[]'::jsonb,
  -- The product came back with the same code in a new file and got its translations and description back.
  reattached_at timestamptz
);
create index if not exists inventory_trash_code_idx on public.inventory_trash (shop_id, source_code);
create index if not exists inventory_trash_reset_idx on public.inventory_trash (reset_id);
alter table public.inventory_trash enable row level security;
revoke all on public.inventory_trash from public, anon, authenticated;
grant all on public.inventory_trash to service_role;

-- "Zálohy": the CSV made before each removal (not an uploaded file: "Vymazať všetky nahrané súbory" keeps them).
create table if not exists public.inventory_backups (
  id         bigint generated always as identity primary key,
  shop_id    uuid not null references public.shops (id) on delete cascade,
  reset_id   bigint references public.inventory_resets (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  file_name  text not null check (char_length(file_name) between 1 and 200),
  rows       integer not null default 0 check (rows >= 0),
  csv        text not null
);
create index if not exists inventory_backups_shop_idx on public.inventory_backups (shop_id, created_at desc);
alter table public.inventory_backups enable row level security;
revoke all on public.inventory_backups from public, anon, authenticated;
grant all on public.inventory_backups to service_role;

alter table public.sync_sources
  -- "Vymazať všetky nahrané súbory" (or a full reset) happened then: no uploaded file until the next one.
  add column if not exists files_cleared_at timestamptz,
  -- stock-pull deletes the shop's raw files saved up to this time from Storage, then clears it.
  add column if not exists raw_files_delete_before timestamptz,
  -- A full reset: the shop page says "Sortiment sa práve aktualizuje" until the next file is applied.
  add column if not exists inventory_reset_at timestamptz;

-- ------------------------------------------------------------------ 2. helpers

create or replace function public.inventory_log(p_shop_id uuid, p_action text, p_details jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), p_action, coalesce(p_details, '{}'::jsonb))
$$;
revoke execute on function public.inventory_log(uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.csv_cell(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select '"' || replace(coalesce(p_value, ''), '"', '""') || '"'
$$;

/**
 * The products that are sold out because the latest file did not list them: apply_stock_file() stamps every product
 * of a file with the same time (shop_items.updated_at), so a product older than the newest stamp was missing from it.
 * A product the file itself lists with 0 is not one of them.
 */
create or replace function public.inventory_missing_items(p_shop_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  with last_file as (select max(si.updated_at) as at from public.shop_items si where si.shop_id = p_shop_id)
  select si.id
  from public.shop_items si
  cross join last_file lf
  left join public.inventory inv on inv.shop_item_id = si.id
  where si.shop_id = p_shop_id
    and si.updated_at < lf.at
    and coalesce(inv.quantity, 0) <= 0
$$;
revoke execute on function public.inventory_missing_items(uuid) from public, anon, authenticated;

/**
 * The backup CSV of a shop's whole current inventory: UTF-8 with a BOM and ";" between the columns (spreadsheets in
 * Slovak, Hungarian or Czech open it as it is). Only what visitors may see plus the translations: code, name, EAN,
 * brand, category, description, quantity, price, currency, the time of the file, the approved Cacaduu description
 * and the name, description and category in every language they are translated into (nazov@hu, popis@hu, …). Purchase prices, suppliers and other private
 * columns are never stored by PPI, so they can never be in it.
 */
create or replace function public.inventory_backup_csv(p_shop_id uuid)
returns table (csv text, rows integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_langs text[];
  v_head text;
  v_body text;
  v_rows integer;
begin
  select coalesce(array_agg(distinct c.lang order by c.lang), '{}')
  into v_langs
  from public.content_translations c
  where c.shop_id = p_shop_id and c.kind in ('item_name', 'item_description', 'item_category') and c.text is not null;

  v_head := concat_ws(';', 'kod', 'nazov', 'ean', 'znacka', 'kategoria', 'popis', 'mnozstvo', 'cena', 'mena',
                      'cas_suboru', 'popis_cacaduu')
            || coalesce((select string_agg(';nazov@' || l || ';popis@' || l || ';kategoria@' || l, '' order by l)
                         from unnest(v_langs) l), '');

  select count(*)::integer,
         string_agg(
           concat_ws(';',
             public.csv_cell(si.source_code), public.csv_cell(si.name), public.csv_cell(si.ean),
             public.csv_cell(si.brand), public.csv_cell(si.category), public.csv_cell(si.description),
             public.csv_cell(inv.quantity::text), public.csv_cell(inv.price::text), public.csv_cell(inv.currency),
             public.csv_cell(to_char(inv.source_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
             public.csv_cell(d.text))
           || coalesce((select string_agg(x.cells, '' order by x.lang)
                        from (select l.l as lang,
                                     ';' || public.csv_cell(max(c.text) filter (where c.kind = 'item_name'))
                                     || ';' || public.csv_cell(max(c.text) filter (where c.kind = 'item_description'))
                                     || ';' || public.csv_cell(max(c.text) filter (where c.kind = 'item_category')) as cells
                              from unnest(v_langs) l(l)
                              left join public.content_translations c
                                on c.shop_id = p_shop_id and c.ref = si.id::text and c.lang = l.l
                               and c.kind in ('item_name', 'item_description', 'item_category')
                              group by l.l) x), ''),
           E'\r\n' order by si.source_code)
  into v_rows, v_body
  from public.shop_items si
  left join public.inventory inv on inv.shop_item_id = si.id
  left join public.item_descriptions d on d.item_id = si.id
  where si.shop_id = p_shop_id;

  return query select E'\uFEFF' || v_head || E'\r\n' || coalesce(v_body || E'\r\n', ''), coalesce(v_rows, 0);
end;
$$;
revoke execute on function public.inventory_backup_csv(uuid) from public, anon, authenticated;

/**
 * The uploaded stock files of a shop are gone for good: their reports ("Posledné nahrané súbory"), the last file's
 * name and the mapping example rows; stock-pull deletes the raw files from Storage. The inventory, its freshness and
 * the column mapping stay. Returns how many files the list held.
 */
create or replace function public.stock_files_clear(p_shop_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_files integer;
begin
  delete from public.stock_imports where shop_id = p_shop_id;
  get diagnostics v_files = row_count;
  update public.sync_sources
  set sample_rows = null,
      last_file_name = null,
      files_cleared_at = now(),
      raw_files_delete_before = now()
  where shop_id = p_shop_id;
  return v_files;
end;
$$;
revoke execute on function public.stock_files_clear(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ 3. what the owner sees before deciding

/**
 * For the dialogs: how many products and files there are, the products missing from the last file (code and name,
 * at most 500), how many resets are left today, the shop's name (typed to confirm a full reset).
 */
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
                                     where r.shop_id = p_shop_id and r.created_at > now() - interval '1 day')));
end;
$$;
revoke execute on function public.owner_inventory_preview(uuid) from public, anon;
grant execute on function public.owner_inventory_preview(uuid) to authenticated;

-- ------------------------------------------------------------------ 4. 2b: delete every uploaded file

create or replace function public.owner_delete_stock_files(p_shop_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_files integer;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  if (select count(*) from public.shop_activity a
      where a.shop_id = p_shop_id and a.action = 'stock_files_deleted' and a.at > now() - interval '1 day') >= 10 then
    raise exception 'files_limit' using errcode = 'P0001';
  end if;
  v_files := public.stock_files_clear(p_shop_id);
  perform public.inventory_log(p_shop_id, 'stock_files_deleted', jsonb_build_object('files', v_files));
  return jsonb_build_object('files', v_files);
end;
$$;
revoke execute on function public.owner_delete_stock_files(uuid) from public, anon;
grant execute on function public.owner_delete_stock_files(uuid) to authenticated;

-- ------------------------------------------------------------------ 5. options A and B

/**
 * p_mode 'missing' (A): the products missing from the latest file. p_mode 'all' (B): every product and every uploaded
 * file; p_confirm must be the shop's name; p_keep_translations: a product that returns with the same code gets its
 * translations and description back; p_clear_mapping: the column mapping starts over too (another file format).
 * First the backup CSV, then the products go to the trash (30 days). At most 3 resets per shop and day.
 */
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
      where r.shop_id = p_shop_id and r.created_at > now() - interval '1 day') >= 3 then
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
  insert into public.inventory_trash (reset_id, shop_id, source_code, item, inventory, description, translations)
  select v_reset, p_shop_id, si.source_code, to_jsonb(si) - 'names_search', to_jsonb(inv), to_jsonb(d),
         coalesce((select jsonb_agg(to_jsonb(c)) from public.content_translations c
                   where c.shop_id = p_shop_id and c.ref = si.id::text
                     and c.kind in ('item_name', 'item_description', 'item_category')), '[]'::jsonb)
  from public.shop_items si
  left join public.inventory inv on inv.shop_item_id = si.id
  left join public.item_descriptions d on d.item_id = si.id
  where si.id = any (v_ids);

  delete from public.content_translations c
  where c.shop_id = p_shop_id and c.kind in ('item_name', 'item_description', 'item_category')
    and c.ref = any (select x::text from unnest(v_ids) x);
  -- inventory and item_descriptions go with their product (on delete cascade)
  delete from public.shop_items si where si.id = any (v_ids);

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

-- ------------------------------------------------------------------ 6. "Obnoviť sklad"

/** Why a removal cannot be undone any more (null = it can): restored, purged, expired, or a newer file applied. */
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
    when r.expires_at <= now() then 'expired'
    when (case when r.kind = 'all' then s.latest_file_time is not null
               else s.latest_file_time is distinct from (r.source_before ->> 'latest_file_time')::timestamptz end)
      then 'newer_upload'
    -- only the newest removal of a shop can be undone (an older one would bring back products a later one removed)
    when exists (select 1 from public.inventory_resets n
                 where n.shop_id = r.shop_id and n.created_at > r.created_at and n.restored_at is null) then 'newer_reset'
  end
  from public.inventory_resets r
  left join public.sync_sources s on s.shop_id = r.shop_id
  where r.id = p_reset_id
$$;
revoke execute on function public.inventory_restore_blocked(bigint) from public, anon, authenticated;

create or replace function public.owner_inventory_restore(p_reset_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reset public.inventory_resets%rowtype;
  v_blocked text;
  v_items integer;
begin
  select * into v_reset from public.inventory_resets where id = p_reset_id;
  if not found or not public.is_shop_member(v_reset.shop_id) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('inventory_reset:' || v_reset.shop_id::text));
  v_blocked := public.inventory_restore_blocked(p_reset_id);
  if v_blocked is not null then
    raise exception 'restore_%', v_blocked using errcode = 'P0001';
  end if;

  -- The products exactly as they were (same ids: links, translations and descriptions keep working).
  perform set_config('ppi.inventory_restoring', '1', true);
  insert into public.shop_items (id, shop_id, source_code, product_id, name, ean, brand, updated_at, name_lang,
                                 name_i18n, translated_name_source, name_i18n_by_owner, changed_at, description, category)
  select i.id, i.shop_id, i.source_code,
         (select p.id from public.products p where p.id = i.product_id),
         i.name, i.ean, i.brand, i.updated_at, i.name_lang, i.name_i18n, i.translated_name_source,
         coalesce(i.name_i18n_by_owner, false), i.changed_at, i.description, i.category
  from public.inventory_trash t
  cross join lateral jsonb_populate_record(null::public.shop_items, t.item) i
  where t.reset_id = p_reset_id and t.reattached_at is null
  on conflict do nothing;
  get diagnostics v_items = row_count;
  perform set_config('ppi.inventory_restoring', '', true);

  insert into public.inventory (shop_item_id, quantity, price, currency, source_updated_at, received_at)
  select v.shop_item_id, v.quantity, v.price, v.currency, v.source_updated_at, v.received_at
  from public.inventory_trash t
  cross join lateral jsonb_populate_record(null::public.inventory, t.inventory) v
  where t.reset_id = p_reset_id and t.inventory is not null
    and exists (select 1 from public.shop_items si where si.id = v.shop_item_id)
  on conflict (shop_item_id) do nothing;

  insert into public.item_descriptions (item_id, shop_id, draft, draft_at, text, published_at, show, updated_at)
  select d.item_id, d.shop_id, d.draft, d.draft_at, d.text, d.published_at, d.show, d.updated_at
  from public.inventory_trash t
  cross join lateral jsonb_populate_record(null::public.item_descriptions, t.description) d
  where t.reset_id = p_reset_id and t.description is not null
    and exists (select 1 from public.shop_items si where si.id = d.item_id)
  on conflict (item_id) do nothing;

  insert into public.content_translations (shop_id, kind, ref, lang, text, status, source_hash, created_at, updated_at)
  select c.shop_id, c.kind, c.ref, c.lang, c.text, c.status, c.source_hash, c.created_at, c.updated_at
  from public.inventory_trash t
  cross join lateral jsonb_array_elements(t.translations) e
  cross join lateral jsonb_populate_record(null::public.content_translations, e.value) c
  where t.reset_id = p_reset_id
    and exists (select 1 from public.shop_items si where si.id::text = c.ref)
  on conflict do nothing;

  -- The stock source as it was (the deleted files and their example rows do not come back).
  if v_reset.kind = 'all' then
    update public.sync_sources s
    set latest_file_time = (v_reset.source_before ->> 'latest_file_time')::timestamptz,
        inventory_reset_at = null,
        field_mapping = case when v_reset.cleared_mapping then v_reset.source_before -> 'field_mapping' else s.field_mapping end,
        mapping_status = case when v_reset.cleared_mapping
                              then coalesce(v_reset.source_before ->> 'mapping_status', s.mapping_status) else s.mapping_status end,
        file_columns = case when v_reset.cleared_mapping and jsonb_typeof(v_reset.source_before -> 'file_columns') = 'array'
                            then array(select jsonb_array_elements_text(v_reset.source_before -> 'file_columns'))
                            else s.file_columns end,
        file_encoding = case when v_reset.cleared_mapping then v_reset.source_before ->> 'file_encoding' else s.file_encoding end
    where s.shop_id = v_reset.shop_id;
  end if;

  delete from public.inventory_trash where reset_id = p_reset_id;
  update public.inventory_resets set restored_at = now() where id = p_reset_id;
  perform public.inventory_log(v_reset.shop_id, 'inventory_restored',
                               jsonb_build_object('reset_id', p_reset_id, 'items', v_items, 'kind', v_reset.kind));
  return jsonb_build_object('items', v_items, 'kind', v_reset.kind);
end;
$$;
revoke execute on function public.owner_inventory_restore(bigint) from public, anon;
grant execute on function public.owner_inventory_restore(bigint) to authenticated;

-- ------------------------------------------------------------------ 7. translations come back with the same code

/**
 * A product removed by a reset (with "zachovať preklady a popisy") or as missing from a file comes back in a new file
 * with the same code: its name settings (before the row is written), then its translations and Cacaduu description
 * (after) are attached to the new row; shop_items.name_i18n follows the translations by itself (update 40). A name that changed meanwhile is translated again as
 * usual (translated_name_source, source_hash). Not while "Obnoviť sklad" puts the products back itself.
 */
create or replace function public.reattach_item_names()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
begin
  if current_setting('ppi.inventory_restoring', true) = '1' then
    return new;
  end if;
  select t.item into v_item
  from public.inventory_trash t
  join public.inventory_resets r on r.id = t.reset_id
  where t.shop_id = new.shop_id and t.source_code = new.source_code and t.reattached_at is null
    and r.keep_translations and r.restored_at is null and r.purged_at is null
  order by r.created_at desc, t.id desc
  limit 1;
  if v_item is not null then
    new.name_lang := coalesce(new.name_lang, v_item ->> 'name_lang');
    new.translated_name_source := coalesce(new.translated_name_source, v_item ->> 'translated_name_source');
    new.name_i18n_by_owner := new.name_i18n_by_owner or coalesce((v_item ->> 'name_i18n_by_owner')::boolean, false);
    new.description := coalesce(new.description, v_item ->> 'description');
    new.category := coalesce(new.category, v_item ->> 'category');
  end if;
  return new;
end;
$$;
revoke execute on function public.reattach_item_names() from public, anon, authenticated;

create or replace function public.reattach_item_texts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trash public.inventory_trash%rowtype;
begin
  if current_setting('ppi.inventory_restoring', true) = '1' then
    return null;
  end if;
  select t.* into v_trash
  from public.inventory_trash t
  join public.inventory_resets r on r.id = t.reset_id
  where t.shop_id = new.shop_id and t.source_code = new.source_code and t.reattached_at is null
    and r.keep_translations and r.restored_at is null and r.purged_at is null
  order by r.created_at desc, t.id desc
  limit 1;
  if not found then
    return null;
  end if;
  if v_trash.description is not null then
    insert into public.item_descriptions (item_id, shop_id, draft, draft_at, text, published_at, show, updated_at)
    select new.id, new.shop_id, d.draft, d.draft_at, d.text, d.published_at, d.show, d.updated_at
    from jsonb_populate_record(null::public.item_descriptions, v_trash.description) d
    on conflict (item_id) do nothing;
  end if;
  insert into public.content_translations (shop_id, kind, ref, lang, text, status, source_hash, created_at, updated_at)
  select new.shop_id, c.kind, new.id::text, c.lang, c.text, c.status, c.source_hash, c.created_at, c.updated_at
  from jsonb_array_elements(v_trash.translations) e
  cross join lateral jsonb_populate_record(null::public.content_translations, e.value) c
  on conflict do nothing;
  update public.inventory_trash set reattached_at = now() where id = v_trash.id;
  return null;
end;
$$;
revoke execute on function public.reattach_item_texts() from public, anon, authenticated;

drop trigger if exists shop_items_reattach_names on public.shop_items;
create trigger shop_items_reattach_names before insert on public.shop_items
  for each row execute function public.reattach_item_names();
drop trigger if exists shop_items_reattach_texts on public.shop_items;
create trigger shop_items_reattach_texts after insert on public.shop_items
  for each row execute function public.reattach_item_texts();

-- ------------------------------------------------------------------ 8. what Môj obchod shows

/**
 * The danger zone and the status lines: uploaded files, whether they were deleted (and no file came since), the
 * removals of the last 30 days with whether "Obnoviť sklad" is possible (and why not), the backups, the last actions.
 */
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
    'resets_left', greatest(0, 3 - (select count(*) from public.inventory_resets r
                                     where r.shop_id = p_shop_id and r.created_at > now() - interval '1 day')),
    'resets', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'created_at', r.created_at, 'items', r.items,
                                          'files', r.files, 'expires_at', r.expires_at, 'restored_at', r.restored_at,
                                          'keep_translations', r.keep_translations, 'cleared_mapping', r.cleared_mapping,
                                          'blocked', public.inventory_restore_blocked(r.id))
                       order by r.created_at desc)
      from public.inventory_resets r
      where r.shop_id = p_shop_id and r.created_at > now() - interval '30 days'), '[]'::jsonb),
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

-- One backup to download (its owner only).
create or replace function public.owner_inventory_backup(p_backup_id bigint)
returns table (file_name text, csv text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shop uuid;
begin
  select b.shop_id into v_shop from public.inventory_backups b where b.id = p_backup_id and b.expires_at > now();
  if v_shop is null or not public.is_shop_member(v_shop) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  return query select b.file_name, b.csv from public.inventory_backups b where b.id = p_backup_id;
end;
$$;
revoke execute on function public.owner_inventory_backup(bigint) from public, anon;
grant execute on function public.owner_inventory_backup(bigint) to authenticated;

-- ------------------------------------------------------------------ 9. visitors: "Sortiment sa práve aktualizuje"

-- After a full reset, until the next file is applied: the shop page says so instead of "no products".
create or replace function public.shop_stock_resetting(p_slug text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select s.inventory_reset_at is not null and s.latest_file_time is null
           and not exists (select 1 from public.shop_items si where si.shop_id = sh.id)
    from public.shops sh
    join public.sync_sources s on s.shop_id = sh.id
    where sh.slug = p_slug and sh.is_active), false)
$$;
revoke execute on function public.shop_stock_resetting(text) from public;
grant execute on function public.shop_stock_resetting(text) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ 10. stock-pull: the raw files in Storage

/**
 * stock-pull with the owner's login: the time up to which the shop's raw files are to be deleted from Storage (null:
 * none). Members only — the function then deletes those files with its own key and calls raw_files_deleted().
 */
create or replace function public.owner_raw_files_to_delete(p_shop_id uuid)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (public.is_shop_member(p_shop_id) or public.is_admin()) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  return (select s.raw_files_delete_before from public.sync_sources s where s.shop_id = p_shop_id);
end;
$$;
revoke execute on function public.owner_raw_files_to_delete(uuid) from public, anon;
grant execute on function public.owner_raw_files_to_delete(uuid) to authenticated;

create or replace function public.raw_files_deleted(p_shop_id uuid, p_before timestamptz)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.sync_sources set raw_files_delete_before = null
  where shop_id = p_shop_id and raw_files_delete_before = p_before
$$;
revoke execute on function public.raw_files_deleted(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.raw_files_deleted(uuid, timestamptz) to service_role;

-- The PPI window's status (the same as update 13's) also says whether the uploaded files were deleted since.
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

-- ------------------------------------------------------------------ 11. after 30 days

/** Daily: removals older than 30 days lose their trash (no undo any more), old backups go. */
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
  delete from public.inventory_backups where expires_at <= now();
  delete from public.shop_activity where at < now() - interval '1 year';
  return v_count;
end;
$$;
revoke execute on function public.inventory_purge_expired() from public, anon, authenticated;
grant execute on function public.inventory_purge_expired() to service_role;

do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'cron' and p.proname = 'schedule') then
    raise notice 'pg_cron is not on: switch on pg_cron (Database → Extensions), then run this file again.';
    return;
  end if;
  perform cron.schedule('ppi-inventory-purge', '41 3 * * *', 'select public.inventory_purge_expired()');
end;
$$;
