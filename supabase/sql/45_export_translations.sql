-- Update 45: "Priečinok s exportom" — review after an upload and the translations folder on the shop PC.
--
-- The owner pastes this whole file into the Supabase SQL Editor and runs it once (safe to run again).
--
--  - "Po nahratí súboru" ("Nový súbor – skontrolujte"): after a stock file, only when something needs a decision:
--      * columns of the file that are new (neither approved nor marked private): the owner picks a field or
--        "Súkromné – nezobrazovať" — never approved by itself (until then they are private: never read);
--      * new or changed products (their name, description or category differ from what the owner last saw):
--        the languages they are translated into (the shop's preferred languages, the plan's number) and
--        "Vygenerovať popisy" (drafts for these products only);
--      * "Zapamätať a už sa nepýtať": later new products are handled the same way without asking.
--    owner_export_review(), owner_save_export_review(), owner_export_auto().
--  - "Preklady v priečinku": the shop PC writes sklad.<main>.xlsx and sklad.<lang>.xlsx into a folder the owner chose
--    and reads the owner's edits back. The database only gives the rows (owner_export_info(), owner_export_rows():
--    the approved columns only — private columns are never stored by PPI) and applies the edits
--    (owner_apply_export_edits(): a changed translation becomes the owner's own ("Upravené ručne"), a changed main
--    "Popis" the owner's approved description — its AI translations become stale and are made again).
--  - "Vymazať celý sklad" (update 43) may also delete the files Cacaduu wrote into that folder
--    (owner_request_export_files_delete(): the shop PC's window deletes them on its next check).
--  - Every decision, every applied file and every deletion goes into the shop's activity log (update 43).
--
-- RLS: owners read only their own shop's rows; every write goes through these owner_* functions, which check
-- is_shop_member() first. Nothing here changes the stock, the quantities or the prices.

-- ------------------------------------------------------------------ 1. the activity log knows the new actions

alter table public.shop_activity drop constraint if exists shop_activity_action_check;
alter table public.shop_activity add constraint shop_activity_action_check
  check (action in ('stock_files_deleted', 'inventory_missing_removed', 'inventory_reset', 'inventory_restored',
                    'inventory_purged', 'export_review', 'export_edits', 'export_files_deleted'));

-- ------------------------------------------------------------------ 2. what the owner decided and saw

create table if not exists public.shop_export_settings (
  shop_id         uuid primary key references public.shops (id) on delete cascade,
  -- "Zapamätať a už sa nepýtať"
  remember        boolean not null default false,
  -- "Vygenerovať popisy" for new or changed products (remembered with the choice above)
  describe_new    boolean not null default false,
  -- columns the owner marked "Súkromné – nezobrazovať" (never read)
  private_columns text[] not null default '{}' check (cardinality(private_columns) <= 500),
  -- "Vymazať celý sklad" asked for the files Cacaduu wrote into the translations folder to go too (the shop PC's
  -- window deletes them on its next check; null = nothing to delete)
  delete_files_at timestamptz,
  updated_at      timestamptz not null default now()
);
alter table public.shop_export_settings add column if not exists delete_files_at timestamptz;
alter table public.shop_export_settings enable row level security;
revoke all on public.shop_export_settings from public, anon, authenticated;
grant select on public.shop_export_settings to authenticated;
drop policy if exists "shop_export_settings: members read" on public.shop_export_settings;
create policy "shop_export_settings: members read" on public.shop_export_settings
  for select to authenticated using (public.is_shop_member(shop_id));

-- The version of each product the owner last saw (md5 of its name, description and category): a product without a
-- row, or with another hash, is new or changed.
create table if not exists public.shop_export_marks (
  item_id uuid primary key references public.shop_items (id) on delete cascade,
  shop_id uuid not null references public.shops (id) on delete cascade,
  hash    text not null check (hash ~ '^[0-9a-f]{32}$'),
  seen_at timestamptz not null default now()
);
create index if not exists shop_export_marks_shop_idx on public.shop_export_marks (shop_id);
alter table public.shop_export_marks enable row level security;
revoke all on public.shop_export_marks from public, anon, authenticated;
grant select on public.shop_export_marks to authenticated;
drop policy if exists "shop_export_marks: members read" on public.shop_export_marks;
create policy "shop_export_marks: members read" on public.shop_export_marks
  for select to authenticated using (public.is_shop_member(shop_id));

create or replace function public.export_item_hash(p_name text, p_description text, p_category text)
returns text
language sql
immutable
set search_path = ''
as $$
  select md5(coalesce(p_name, '') || E'\u001f' || coalesce(p_description, '') || E'\u001f' || coalesce(p_category, ''))
$$;
grant execute on function public.export_item_hash(text, text, text) to authenticated, service_role;

-- The products existing now count as seen (the first review asks only about what comes from now on).
insert into public.shop_export_marks (item_id, shop_id, hash)
select si.id, si.shop_id, public.export_item_hash(si.name, si.description, si.category)
from public.shop_items si
on conflict (item_id) do nothing;

-- New (no mark) and changed (another hash) products of a shop.
create or replace function public.export_new_items(p_shop_id uuid)
returns table (item_id uuid, is_new boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select si.id, m.item_id is null
  from public.shop_items si
  left join public.shop_export_marks m on m.item_id = si.id
  where si.shop_id = p_shop_id
    and (m.item_id is null or m.hash <> public.export_item_hash(si.name, si.description, si.category))
$$;
revoke execute on function public.export_new_items(uuid) from public, anon, authenticated;
grant execute on function public.export_new_items(uuid) to service_role;

-- Every product of the shop as seen now; returns how many were new or changed.
create or replace function public.export_mark_seen(p_shop_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.shop_export_marks as m (item_id, shop_id, hash)
  select si.id, si.shop_id, public.export_item_hash(si.name, si.description, si.category)
  from public.shop_items si
  where si.shop_id = p_shop_id
  on conflict (item_id) do update set hash = excluded.hash, seen_at = now()
    where m.hash <> excluded.hash;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function public.export_mark_seen(uuid) from public, anon, authenticated;
grant execute on function public.export_mark_seen(uuid) to service_role;

-- The new or changed products that have no description at all (neither the shop's, nor Cacaduu's, nor a draft).
create or replace function public.export_describe_ids(p_shop_id uuid, p_limit integer default 500)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(x.item_id order by x.name, x.item_id), '{}'::uuid[])
  from (
    select n.item_id, si.name
    from public.export_new_items(p_shop_id) n
    join public.shop_items si on si.id = n.item_id
    left join public.item_descriptions d on d.item_id = si.id
    where nullif(btrim(si.description), '') is null and d.text is null and d.draft is null
    order by si.name, n.item_id
    limit least(greatest(coalesce(p_limit, 500), 1), 500)
  ) x
$$;
revoke execute on function public.export_describe_ids(uuid, integer) from public, anon, authenticated;
grant execute on function public.export_describe_ids(uuid, integer) to service_role;

-- Columns of the last file that are neither approved nor marked private (in the file's order).
create or replace function public.export_new_columns(p_shop_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(c.col order by c.ord), '{}'::text[])
  from public.sync_sources ss
  cross join lateral unnest(coalesce(ss.file_columns, '{}'::text[])) with ordinality as c(col, ord)
  left join public.shop_export_settings es on es.shop_id = ss.shop_id
  where ss.shop_id = p_shop_id
    and ss.mapping_status = 'confirmed'
    and nullif(btrim(c.col), '') is not null
    and not (c.col = any (public.mapped_columns(ss.field_mapping)))
    and not (c.col = any (coalesce(es.private_columns, '{}'::text[])))
$$;
revoke execute on function public.export_new_columns(uuid) from public, anon, authenticated;
grant execute on function public.export_new_columns(uuid) to service_role;

-- ------------------------------------------------------------------ 3. "Nový súbor – skontrolujte"

-- What the card shows: needed = something waits for a decision (new columns always; new or changed products only
-- when the owner did not choose "Zapamätať a už sa nepýtať").
create or replace function public.owner_export_review(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_columns text[];
  v_new integer;
  v_changed integer;
  v_es public.shop_export_settings;
  v_confirmed boolean;
  v_free text[];
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  select * into v_es from public.shop_export_settings where shop_id = p_shop_id;
  v_columns := public.export_new_columns(p_shop_id);
  select count(*) filter (where n.is_new), count(*) filter (where not n.is_new) into v_new, v_changed
  from public.export_new_items(p_shop_id) n;
  select coalesce(ss.mapping_status = 'confirmed', false) into v_confirmed from public.sync_sources ss where ss.shop_id = p_shop_id;
  -- the fields a new column may still take (each field once)
  select coalesce(array_agg(f order by o), '{}') into v_free
  from unnest(array['source_code', 'name', 'ean', 'brand', 'quantity', 'price', 'currency', 'description', 'category'])
       with ordinality as t(f, o)
  where nullif(btrim((select ss.field_mapping ->> f from public.sync_sources ss where ss.shop_id = p_shop_id)), '') is null;
  return jsonb_build_object(
    'needed', cardinality(v_columns) > 0 or (not coalesce(v_es.remember, false) and v_new + v_changed > 0),
    'confirmed', coalesce(v_confirmed, false),
    'new_columns', to_jsonb(v_columns),
    'free_fields', to_jsonb(v_free),
    'new_products', v_new,
    'changed_products', v_changed,
    'langs', to_jsonb(public.shop_preferred_langs(p_shop_id)),
    'saved_langs', to_jsonb(coalesce((select ls.preferred_langs from public.shop_language_settings ls where ls.shop_id = p_shop_id), '{}'::text[])),
    'main_lang', public.shop_main_lang(p_shop_id),
    'max_langs', public.translation_limit_for(p_shop_id),
    'remember', coalesce(v_es.remember, false),
    'describe', coalesce(v_es.describe_new, false),
    'private_columns', to_jsonb(coalesce(v_es.private_columns, '{}'::text[])));
end;
$$;
revoke execute on function public.owner_export_review(uuid) from public, anon;
grant execute on function public.owner_export_review(uuid) to authenticated;

-- "Uložiť" of the card. p_columns: {"<column>": "<field>" | "private"} for new columns only (a field still free; never
-- the same field twice). p_langs: the shop's preferred languages (null = unchanged; the plan's number at most).
-- Returns {describe_ids (new or changed products without any description, when p_describe), marked}.
-- Errors: 'column' (not a new column of the file), 'field' (unknown or taken), 'langs', 'limit'.
create or replace function public.owner_save_export_review(
  p_shop_id uuid, p_columns jsonb, p_langs text[], p_describe boolean, p_remember boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new text[];
  v_mapping jsonb;
  v_private text[] := '{}';
  v_col text;
  v_field text;
  v_used text[] := '{}';
  v_ids uuid[] := '{}';
  v_marked integer;
  v_main text;
  v_langs text[];
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if p_columns is not null and jsonb_typeof(p_columns) <> 'object' then
    raise exception 'column' using errcode = '22023';
  end if;
  v_new := public.export_new_columns(p_shop_id);
  select ss.field_mapping into v_mapping from public.sync_sources ss where ss.shop_id = p_shop_id;

  -- 1. the new columns: a free field or private (an unknown column or field refuses the whole card)
  for v_col, v_field in select e.key, e.value from jsonb_each_text(coalesce(p_columns, '{}'::jsonb)) e loop
    if not (v_col = any (v_new)) then
      raise exception 'column' using errcode = '22023';
    end if;
    if v_field = 'private' then
      v_private := v_private || v_col;
    elsif v_field in ('source_code', 'name', 'ean', 'brand', 'quantity', 'price', 'currency', 'description', 'category')
          and nullif(btrim(coalesce(v_mapping ->> v_field, '')), '') is null and not (v_field = any (v_used)) then
      v_mapping := coalesce(v_mapping, '{}'::jsonb) || jsonb_build_object(v_field, left(v_col, 200));
      v_used := v_used || v_field;
    else
      raise exception 'field' using errcode = '22023';
    end if;
  end loop;
  if cardinality(v_used) > 0 then
    update public.sync_sources set field_mapping = v_mapping where shop_id = p_shop_id and mapping_status = 'confirmed';
    if not found then
      raise exception 'column' using errcode = '22023';
    end if;
  end if;

  -- 2. the languages the products are translated into (= the shop's preferred languages)
  if p_langs is not null then
    v_main := public.shop_main_lang(p_shop_id);
    select coalesce(array_agg(x order by o), '{}') into v_langs
      from (select distinct on (x) x, o from unnest(p_langs) with ordinality as t(x, o) where x <> v_main order by x, o) d;
    if exists (select 1 from unnest(v_langs) x where not public.lang_enabled(x)) then
      raise exception 'langs' using errcode = '22023';
    end if;
    if cardinality(v_langs) > public.translation_limit_for(p_shop_id) then
      raise exception 'limit' using errcode = '22023';
    end if;
    insert into public.shop_language_settings as ls (shop_id, main_lang, inventory_langs, preferred_langs)
    values (p_shop_id, v_main, array[v_main], v_langs)
    on conflict (shop_id) do update set preferred_langs = excluded.preferred_langs, updated_at = now();
  end if;

  -- 3. "Vygenerovať popisy": only the new or changed products (before they are marked as seen)
  if coalesce(p_describe, false) then
    v_ids := public.export_describe_ids(p_shop_id, 500);
  end if;

  insert into public.shop_export_settings as es (shop_id, remember, describe_new, private_columns)
  values (p_shop_id, coalesce(p_remember, false), coalesce(p_describe, false), v_private)
  on conflict (shop_id) do update
    set remember = excluded.remember, describe_new = excluded.describe_new,
        private_columns = (select coalesce(array_agg(distinct c), '{}') from unnest(es.private_columns || excluded.private_columns) c),
        updated_at = now();

  v_marked := public.export_mark_seen(p_shop_id);
  perform public.inventory_log(p_shop_id, 'export_review', jsonb_build_object(
    'columns', cardinality(v_used), 'private', cardinality(v_private), 'items', v_marked, 'describe', cardinality(v_ids),
    'remember', coalesce(p_remember, false)));
  return jsonb_build_object('describe_ids', to_jsonb(v_ids), 'marked', v_marked);
end;
$$;
revoke execute on function public.owner_save_export_review(uuid, jsonb, text[], boolean, boolean) from public, anon;
grant execute on function public.owner_save_export_review(uuid, jsonb, text[], boolean, boolean) to authenticated;

-- With "Zapamätať a už sa nepýtať": the new or changed products are handled as chosen (the shop PC's window asks
-- on every check). Returns {remember, describe_ids, marked}; without the choice nothing happens.
create or replace function public.owner_export_auto(p_shop_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_es public.shop_export_settings;
  v_ids uuid[] := '{}';
  v_marked integer;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  select * into v_es from public.shop_export_settings where shop_id = p_shop_id;
  if not coalesce(v_es.remember, false) then
    return jsonb_build_object('remember', false, 'describe_ids', '[]'::jsonb, 'marked', 0);
  end if;
  if not exists (select 1 from public.export_new_items(p_shop_id)) then
    return jsonb_build_object('remember', true, 'describe_ids', '[]'::jsonb, 'marked', 0);
  end if;
  if v_es.describe_new then
    v_ids := public.export_describe_ids(p_shop_id, 500);
  end if;
  v_marked := public.export_mark_seen(p_shop_id);
  perform public.inventory_log(p_shop_id, 'export_review', jsonb_build_object(
    'columns', 0, 'private', 0, 'items', v_marked, 'describe', cardinality(v_ids), 'remember', true, 'auto', true));
  return jsonb_build_object('remember', true, 'describe_ids', to_jsonb(v_ids), 'marked', v_marked);
end;
$$;
revoke execute on function public.owner_export_auto(uuid) from public, anon;
grant execute on function public.owner_export_auto(uuid) to authenticated;

-- ------------------------------------------------------------------ 4. the files: what is written

-- The files' languages and columns: the main file has the approved columns (as named in the shop's stock file) + the
-- description; one file per further language (preferred + stock file languages). version changes whenever anything
-- written into the files changed (the shop PC rewrites them only then).
create or replace function public.owner_export_info(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_main text;
  v_langs text[];
  v_mapping jsonb;
  v_columns jsonb;
  v_version text;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  v_main := public.shop_main_lang(p_shop_id);
  select coalesce(array_agg(distinct x order by x), '{}') into v_langs from (
    select unnest(public.shop_preferred_langs(p_shop_id)) as x
    union select unnest(ls.inventory_langs) from public.shop_language_settings ls where ls.shop_id = p_shop_id
  ) t where x <> v_main and public.lang_enabled(x);
  select case when ss.mapping_status = 'confirmed' then ss.field_mapping end into v_mapping
  from public.sync_sources ss where ss.shop_id = p_shop_id;
  select coalesce(jsonb_agg(jsonb_build_object('field', f, 'column', v_mapping ->> f) order by o), '[]'::jsonb) into v_columns
  from unnest(array['source_code', 'name', 'ean', 'brand', 'quantity', 'price', 'currency', 'description', 'category'])
       with ordinality as t(f, o)
  where nullif(btrim(coalesce(v_mapping ->> f, '')), '') is not null;
  select md5(concat_ws('|',
    (select count(*)::text || '/' || coalesce(max(si.updated_at)::text, '') from public.shop_items si where si.shop_id = p_shop_id),
    (select coalesce(max(inv.received_at)::text, '') from public.inventory inv join public.shop_items si on si.id = inv.shop_item_id
      where si.shop_id = p_shop_id),
    (select coalesce(max(c.updated_at)::text, '') || '/' || count(*)::text from public.content_translations c
      where c.shop_id = p_shop_id and c.kind in ('item_name', 'item_description', 'item_category')),
    (select coalesce(max(d.updated_at)::text, '') || '/' || count(*)::text from public.item_descriptions d where d.shop_id = p_shop_id),
    v_main, array_to_string(v_langs, ','), coalesce(v_mapping::text, '')))
  into v_version;
  return jsonb_build_object(
    'main_lang', v_main,
    'langs', to_jsonb(v_langs),
    'columns', v_columns,
    'confirmed', v_mapping is not null,
    'items', (select count(*) from public.shop_items si where si.shop_id = p_shop_id),
    'delete_files_at', (select es.delete_files_at from public.shop_export_settings es where es.shop_id = p_shop_id),
    'version', v_version);
end;
$$;
revoke execute on function public.owner_export_info(uuid) from public, anon;
grant execute on function public.owner_export_info(uuid) to authenticated;

-- The rows of one file (p_lang null or the main language = the main file), by code, 1000 at most per call.
-- Only what visitors may see: the approved columns (shop_items holds no other), the description and the translations.
-- d_state: shop (the shop's own, from its file) | published (Cacaduu's, shown) | draft (a "Návrh popisu") | none.
-- *_state: shop | ai | manual | stale | missing | none | original (the name is already in that language) | no_source.
create or replace function public.owner_export_rows(p_shop_id uuid, p_lang text default null, p_offset integer default 0, p_limit integer default 1000)
returns table (
  item_id uuid, code text, ean text, name text, brand text, quantity numeric, price numeric, currency text,
  description text, category text, d_text text, d_state text,
  tr_name text, st_name text, tr_desc text, st_desc text, tr_cat text, st_cat text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lang text;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  v_lang := nullif(p_lang, public.shop_main_lang(p_shop_id));
  if v_lang is not null and not public.valid_lang(v_lang) then
    raise exception 'lang' using errcode = '22023';
  end if;
  return query
    with base as (
      select si.id, si.source_code, si.ean, si.name, si.brand, si.description, si.category, si.name_lang,
             inv.quantity, inv.price, inv.currency, ds.text as shown, ds.source as shown_source, d.draft
      from public.shop_items si
      left join public.inventory inv on inv.shop_item_id = si.id
      left join public.item_descriptions d on d.item_id = si.id
      left join lateral public.item_description_shown(si.id) ds on true
      where si.shop_id = p_shop_id
      order by si.source_code
      offset greatest(coalesce(p_offset, 0), 0)
      limit least(greatest(coalesce(p_limit, 1000), 1), 1000)
    )
    select b.id, b.source_code, b.ean, b.name, b.brand, b.quantity, b.price, b.currency, b.description, b.category,
           coalesce(b.shown, b.draft),
           case when b.shown is not null and b.shown_source = 'shop' then 'shop'
                when b.shown is not null then 'published'
                when b.draft is not null then 'draft'
                else 'none' end,
           cn.text,
           case when v_lang is null then null
                when b.name_lang = v_lang then 'original'
                when cn.shop_id is null then 'missing'
                else public.translation_state(cn.status, cn.source_hash, b.name) end,
           cd.text,
           case when v_lang is null then null
                when b.shown is null then 'no_source'
                when cd.shop_id is null then 'missing'
                else public.translation_state(cd.status, cd.source_hash, b.shown) end,
           cc.text,
           case when v_lang is null then null
                when nullif(btrim(b.category), '') is null then 'no_source'
                when cc.shop_id is null then 'missing'
                else public.translation_state(cc.status, cc.source_hash, b.category) end
    from base b
    left join public.content_translations cn
      on v_lang is not null and cn.shop_id = p_shop_id and cn.kind = 'item_name' and cn.ref = b.id::text and cn.lang = v_lang
    left join public.content_translations cd
      on v_lang is not null and cd.shop_id = p_shop_id and cd.kind = 'item_description' and cd.ref = b.id::text and cd.lang = v_lang
    left join public.content_translations cc
      on v_lang is not null and cc.shop_id = p_shop_id and cc.kind = 'item_category' and cc.ref = b.id::text and cc.lang = v_lang
    order by b.source_code;
end;
$$;
revoke execute on function public.owner_export_rows(uuid, text, integer, integer) from public, anon;
grant execute on function public.owner_export_rows(uuid, text, integer, integer) to authenticated;

-- ------------------------------------------------------------------ 5. the files: the owner's edits

-- The edits of one file: p_rows [{code, ean, field, text}] (only cells the owner changed; an empty cell is never sent).
-- Matched by code, then EAN (one product only). Main file (p_lang null or the main language): field 'description' =
-- the owner's approved description (shown from now on; its AI translations become stale and are made again).
-- A language file: 'name' | 'description' | 'category' = the owner's own translation ('manual', never replaced).
-- Returns {applied, same, unknown: [{code, ean}], skipped: [{code, field, reason}]} and logs the file.
create or replace function public.owner_apply_export_edits(p_shop_id uuid, p_lang text, p_file text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_main text;
  v_lang text;
  v_row jsonb;
  v_code text;
  v_ean text;
  v_field text;
  v_text text;
  v_item public.shop_items;
  v_source text;
  v_kind text;
  v_old_text text;
  v_applied integer := 0;
  v_same integer := 0;
  v_unknown jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 20000 then
    raise exception 'rows' using errcode = '22023';
  end if;
  v_main := public.shop_main_lang(p_shop_id);
  v_lang := nullif(p_lang, v_main);
  if v_lang is not null and not public.valid_lang(v_lang) then
    raise exception 'lang' using errcode = '22023';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_code := nullif(btrim(coalesce(v_row ->> 'code', '')), '');
    v_ean := nullif(regexp_replace(coalesce(v_row ->> 'ean', ''), '\s', '', 'g'), '');
    v_field := v_row ->> 'field';
    v_text := nullif(btrim(coalesce(v_row ->> 'text', '')), '');
    v_item := null;
    if v_code is not null then
      select * into v_item from public.shop_items si where si.shop_id = p_shop_id and si.source_code = v_code;
    end if;
    if v_item.id is null and v_ean is not null and (select count(*) from public.shop_items si where si.shop_id = p_shop_id and si.ean = v_ean) = 1 then
      select * into v_item from public.shop_items si where si.shop_id = p_shop_id and si.ean = v_ean;
    end if;
    if v_item.id is null then
      if jsonb_array_length(v_unknown) < 100 then
        v_unknown := v_unknown || jsonb_build_object('code', v_code, 'ean', v_ean);
      end if;
      continue;
    end if;
    if v_text is null then
      continue; -- an empty cell never changes anything
    end if;

    if v_lang is null then
      -- the main file: only the description can be changed here
      if v_field <> 'description' then
        v_skipped := v_skipped || jsonb_build_object('code', v_item.source_code, 'field', v_field, 'reason', 'readonly');
        continue;
      end if;
      if char_length(v_text) > 3000 then
        v_skipped := v_skipped || jsonb_build_object('code', v_item.source_code, 'field', v_field, 'reason', 'too_long');
        continue;
      end if;
      select ds.text into v_source from public.item_description_shown(v_item.id) ds;
      if v_source is not distinct from v_text then
        v_same := v_same + 1;
        continue;
      end if;
      insert into public.item_descriptions as d (item_id, shop_id, text, published_at, show)
      values (v_item.id, p_shop_id, v_text, now(),
              case when nullif(btrim(v_item.description), '') is not null then 'cacaduu' else 'auto' end)
      on conflict (item_id) do update
        set text = excluded.text, published_at = now(), draft = null, draft_at = null, updated_at = now(),
            show = case when nullif(btrim(v_item.description), '') is not null or d.show = 'shop' then 'cacaduu' else d.show end;
      v_applied := v_applied + 1;
      continue;
    end if;

    -- a language file: the owner's own translation
    v_kind := case v_field when 'name' then 'item_name' when 'description' then 'item_description' when 'category' then 'item_category' end;
    if v_kind is null then
      v_skipped := v_skipped || jsonb_build_object('code', v_item.source_code, 'field', v_field, 'reason', 'readonly');
      continue;
    end if;
    if v_kind = 'item_name' and v_item.name_lang = v_lang then
      v_skipped := v_skipped || jsonb_build_object('code', v_item.source_code, 'field', v_field, 'reason', 'original');
      continue;
    end if;
    v_source := case v_kind
                  when 'item_name' then v_item.name
                  when 'item_category' then nullif(btrim(v_item.category), '')
                  else (select ds.text from public.item_description_shown(v_item.id) ds) end;
    if v_source is null then
      v_skipped := v_skipped || jsonb_build_object('code', v_item.source_code, 'field', v_field, 'reason', 'no_source');
      continue;
    end if;
    if char_length(v_text) > greatest(300, char_length(v_source) * 3 + 200) then
      v_skipped := v_skipped || jsonb_build_object('code', v_item.source_code, 'field', v_field, 'reason', 'too_long');
      continue;
    end if;
    v_old_text := (select c.text from public.content_translations c
                   where c.shop_id = p_shop_id and c.kind = v_kind and c.ref = v_item.id::text and c.lang = v_lang);
    if v_old_text is not distinct from v_text then
      v_same := v_same + 1;
      continue;
    end if;
    insert into public.content_translations as c (shop_id, kind, ref, lang, text, status, source_hash)
    values (p_shop_id, v_kind, v_item.id::text, v_lang, v_text, 'manual', md5(v_source))
    on conflict (shop_id, kind, ref, lang) do update
      set text = excluded.text, status = 'manual', source_hash = excluded.source_hash, updated_at = now();
    v_applied := v_applied + 1;
  end loop;

  if v_applied > 0 or jsonb_array_length(v_unknown) > 0 or jsonb_array_length(v_skipped) > 0 then
    perform public.inventory_log(p_shop_id, 'export_edits', jsonb_build_object(
      'file', left(coalesce(p_file, ''), 120), 'lang', coalesce(v_lang, v_main), 'items', v_applied,
      'unknown', jsonb_array_length(v_unknown), 'skipped', jsonb_array_length(v_skipped)));
  end if;
  return jsonb_build_object('applied', v_applied, 'same', v_same, 'unknown', v_unknown,
                            'skipped', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (select x from jsonb_array_elements(v_skipped) x limit 100) s));
end;
$$;
revoke execute on function public.owner_apply_export_edits(uuid, text, text, jsonb) from public, anon;
grant execute on function public.owner_apply_export_edits(uuid, text, text, jsonb) to authenticated;

-- "Vymazať celý sklad" with "Vymazať aj súbory s prekladmi": the shop PC's window deletes the files Cacaduu wrote into
-- the translations folder on its next check (only the browser can reach that folder).
create or replace function public.owner_request_export_files_delete(p_shop_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  insert into public.shop_export_settings as es (shop_id, delete_files_at) values (p_shop_id, now())
  on conflict (shop_id) do update set delete_files_at = now(), updated_at = now();
end;
$$;
revoke execute on function public.owner_request_export_files_delete(uuid) from public, anon;
grant execute on function public.owner_request_export_files_delete(uuid) to authenticated;

-- The shop PC deleted them: noted in the activity log, the request is done.
create or replace function public.owner_log_export_files_deleted(p_shop_id uuid, p_files integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  update public.shop_export_settings set delete_files_at = null, updated_at = now() where shop_id = p_shop_id;
  perform public.inventory_log(p_shop_id, 'export_files_deleted', jsonb_build_object('files', greatest(coalesce(p_files, 0), 0)));
end;
$$;
revoke execute on function public.owner_log_export_files_deleted(uuid, integer) from public, anon;
grant execute on function public.owner_log_export_files_deleted(uuid, integer) to authenticated;

alter function public.owner_export_rows(uuid, text, integer, integer) set jit = off;
alter function public.owner_export_info(uuid) set jit = off;

notify pgrst, 'reload schema';
