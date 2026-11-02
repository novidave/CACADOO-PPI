-- =====================================================================================================================
-- Update 71 — "Sklad v Cacaduu", phase E: sales from eKasa, the suppliers export (2026-11-02, Nastavenia screen 15)
--
-- "Odkiaľ prichádzajú predaje" — ONE source of sales, so the same sale is never taken off the stock twice:
--   * 'predaj' (default): the Predaj screen of update 68;
--   * 'ekasa': the shop keeps selling on its own cash register (eKasa) and uploads its daily export; the Predaj
--     screen is off (a trigger refuses a new sale: 'sale_source').
-- An eKasa export (CSV or XLSX, read on the website) is matched to the shop's columns once ("Stĺpce exportu sú
-- schválené": product, quantity, and the receipt number or the time; optional price, code, EAN). The website sends the
-- lines as written; here:
--   * every line gets a key = md5(shop, receipt number, time, the product's text, quantity, price, the n-th same line in
--     that file) — the same line in a later, overlapping export is a 'duplicate' and is never booked again; the same
--     file twice = the same import;
--   * the product is found by EAN, then the code, then a pairing the owner made before (sklad_ekasa_pairs, "Spárovanie
--     sa zapamätá"), then the exact name; otherwise the line waits 'unmatched' ("Spárovať 3 riadky"); a pairing books
--     every waiting line of that text, and "Nie je tovar" (transport, a deposit, a service) ignores it for good;
--   * a booked line = one Výdaj movement (kind sale, at the shop's sale location, ref "eKasa <receipt>", the time of the
--     receipt) — a negative quantity (a refund) = an Oprava back; one transaction with sklad_apply (the shop page).
-- Nothing of a receipt but these columns is stored; never the customer, the payment or the cashier. Owners only
-- (sklad_member); no grants on the tables but the service role. Also: owner_sklad_supplier_list for "Dodávatelia
-- (XLSX)". Needs updates 67–70. Safe to run twice.
-- =====================================================================================================================

do $$
declare
  v_def text := (select pg_get_constraintdef(c.oid) from pg_constraint c
                 where c.conrelid = 'public.shop_activity'::regclass and c.conname = 'shop_activity_action_check');
  v_add text := '';
  a text;
begin
  if v_def is null then return; end if;
  foreach a in array array['sklad_ekasa_imported', 'sklad_ekasa_paired'] loop
    if position('''' || a || '''' in v_def) = 0 then v_add := v_add || '''' || a || '''::text, '; end if;
  end loop;
  if v_add <> '' then
    alter table public.shop_activity drop constraint shop_activity_action_check;
    execute 'alter table public.shop_activity add constraint shop_activity_action_check ' || replace(v_def, 'ARRAY[', 'ARRAY[' || v_add);
  end if;
end;
$$;

alter table public.sklad_settings add column if not exists sale_source text not null default 'predaj';
alter table public.sklad_settings drop constraint if exists sklad_settings_sale_source_check;
alter table public.sklad_settings add constraint sklad_settings_sale_source_check check (sale_source in ('predaj', 'ekasa'));
-- {product, qty, doc, time, price, code, ean}: the export's column names (as the file writes them)
alter table public.sklad_settings add column if not exists ekasa_columns jsonb;

create table if not exists public.sklad_ekasa_imports (
  id          uuid primary key,
  shop_id     uuid not null references public.shops (id) on delete cascade,
  file_name   text not null check (char_length(file_name) between 1 and 200),
  file_hash   text not null check (file_hash ~ '^[0-9a-f]{64}$'),
  status      text not null default 'staged' check (status in ('staged', 'done')),
  headers     jsonb,
  rows        jsonb,
  docs        integer not null default 0,
  lines       integer not null default 0,
  booked      integer not null default 0,
  unmatched   integer not null default 0,
  ignored     integer not null default 0,
  duplicate   integer not null default 0,
  pieces      numeric not null default 0,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  done_at     timestamptz
);
create index if not exists sklad_ekasa_imports_shop_idx on public.sklad_ekasa_imports (shop_id, created_at desc);
create unique index if not exists sklad_ekasa_imports_hash_idx on public.sklad_ekasa_imports (shop_id, file_hash) where status = 'done';

create table if not exists public.sklad_ekasa_lines (
  import_id  uuid not null references public.sklad_ekasa_imports (id) on delete cascade,
  ord        integer not null,
  shop_id    uuid not null references public.shops (id) on delete cascade,
  line_key   uuid not null,
  doc        text check (doc is null or char_length(doc) <= 80),
  sold_at    timestamptz,
  text       text not null check (char_length(text) between 1 and 200),
  text_key   text not null,
  code       text check (code is null or char_length(code) <= 80),
  ean        text check (ean is null or char_length(ean) <= 32),
  qty        numeric not null check (abs(qty) <= 1000000),
  price      numeric check (price is null or abs(price) <= 1000000000),
  item_id    uuid references public.sklad_items (shop_item_id) on delete set null,
  state      text not null check (state in ('booked', 'unmatched', 'ignored', 'duplicate')),
  primary key (import_id, ord)
);
create index if not exists sklad_ekasa_lines_wait_idx on public.sklad_ekasa_lines (shop_id, state, text_key);
create index if not exists sklad_ekasa_lines_key_idx on public.sklad_ekasa_lines (shop_id, line_key);

create table if not exists public.sklad_ekasa_pairs (
  shop_id     uuid not null references public.shops (id) on delete cascade,
  text_key    text not null check (char_length(text_key) between 1 and 200),
  item_id     uuid references public.sklad_items (shop_item_id) on delete cascade,
  ignore      boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (shop_id, text_key),
  check (ignore or item_id is not null)
);

do $$
declare t text;
begin
  foreach t in array array['sklad_ekasa_imports', 'sklad_ekasa_lines', 'sklad_ekasa_pairs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

-- ------------------------------------------------------------------ 1. one source of sales

/** While sales come from eKasa, the Predaj screen sells nothing (the same sale would leave the stock twice). */
create or replace function public.sklad_sales_source_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.sklad_settings s where s.shop_id = new.shop_id and s.sale_source = 'ekasa') then
    raise exception 'sale_source' using errcode = '55000',
      hint = 'Sales come from the eKasa export; switch "Odkiaľ prichádzajú predaje" to the Predaj screen first.';
  end if;
  return new;
end;
$$;
drop trigger if exists sklad_sales_source_guard on public.sklad_sales;
create trigger sklad_sales_source_guard before insert on public.sklad_sales
  for each row execute function public.sklad_sales_source_guard();

create or replace function public.owner_sklad_set_sale_source(p_shop_id uuid, p_source text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.sklad_member(p_shop_id);
  if p_source is null or p_source not in ('predaj', 'ekasa') then raise exception 'bad_argument' using errcode = '22023'; end if;
  perform public.sklad_setup(p_shop_id);
  update public.sklad_settings set sale_source = p_source, updated_at = now() where shop_id = p_shop_id;
  insert into public.shop_activity (shop_id, action, details)
  values (p_shop_id, 'sklad_settings_saved', jsonb_build_object('sale_source', p_source));
end;
$$;
revoke execute on function public.owner_sklad_set_sale_source(uuid, text) from public, anon;
grant execute on function public.owner_sklad_set_sale_source(uuid, text) to authenticated;

-- ------------------------------------------------------------------ 2. the export's columns

/** The approved column names: product + qty + (doc or time) required; price, code, EAN optional. */
create or replace function public.owner_sklad_ekasa_save_columns(p_shop_id uuid, p_columns jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_out jsonb := '{}'::jsonb;
  k text;
  v text;
begin
  perform public.sklad_member(p_shop_id);
  if p_columns is null or jsonb_typeof(p_columns) <> 'object' then raise exception 'columns' using errcode = '22023'; end if;
  foreach k in array array['product', 'qty', 'doc', 'time', 'price', 'code', 'ean'] loop
    v := nullif(btrim(coalesce(p_columns ->> k, '')), '');
    if v is not null then
      if char_length(v) > 80 then raise exception 'columns' using errcode = '22023'; end if;
      v_out := v_out || jsonb_build_object(k, v);
    end if;
  end loop;
  if v_out ->> 'product' is null or v_out ->> 'qty' is null or (v_out ->> 'doc' is null and v_out ->> 'time' is null) then
    raise exception 'columns' using errcode = '22023';
  end if;
  perform public.sklad_setup(p_shop_id);
  update public.sklad_settings set ekasa_columns = v_out, updated_at = now() where shop_id = p_shop_id;
  insert into public.shop_activity (shop_id, action, details)
  values (p_shop_id, 'sklad_settings_saved', jsonb_build_object('ekasa_columns', true));
end;
$$;
revoke execute on function public.owner_sklad_ekasa_save_columns(uuid, jsonb) from public, anon;
grant execute on function public.owner_sklad_ekasa_save_columns(uuid, jsonb) to authenticated;

/** A file whose columns are not approved yet waits here (1 day) until the owner picks them. */
create or replace function public.owner_sklad_ekasa_stage(p_shop_id uuid, p_id uuid, p_file_name text, p_file_hash text,
                                                         p_headers jsonb, p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_done uuid;
begin
  perform public.sklad_member(p_shop_id);
  if p_id is null or p_file_hash !~ '^[0-9a-f]{64}$' or nullif(btrim(coalesce(p_file_name, '')), '') is null
     or jsonb_typeof(p_headers) <> 'array' or jsonb_array_length(p_headers) not between 1 and 60
     or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then
    raise exception 'bad_argument' using errcode = '22023';
  end if;
  delete from public.sklad_ekasa_imports where shop_id = p_shop_id and status = 'staged' and created_at < now() - interval '1 day';
  select id into v_done from public.sklad_ekasa_imports where shop_id = p_shop_id and file_hash = p_file_hash and status = 'done';
  if v_done is not null then return jsonb_build_object('duplicate', v_done); end if;
  insert into public.sklad_ekasa_imports (id, shop_id, file_name, file_hash, headers, rows, created_by)
  values (p_id, p_shop_id, left(btrim(p_file_name), 200), p_file_hash, p_headers, p_rows, auth.uid())
  on conflict (id) do nothing;
  return jsonb_build_object('staged', p_id);
end;
$$;
revoke execute on function public.owner_sklad_ekasa_stage(uuid, uuid, text, text, jsonb, jsonb) from public, anon;
grant execute on function public.owner_sklad_ekasa_stage(uuid, uuid, text, text, jsonb, jsonb) to authenticated;

create or replace function public.owner_sklad_ekasa_staged(p_shop_id uuid, p_id uuid, p_limit integer default 5)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.sklad_ekasa_imports;
begin
  perform public.sklad_member(p_shop_id);
  select * into v from public.sklad_ekasa_imports where id = p_id and shop_id = p_shop_id and status = 'staged';
  if v.id is null then return null; end if;
  return jsonb_build_object(
    'id', v.id, 'file_name', v.file_name, 'file_hash', v.file_hash, 'headers', v.headers,
    'count', jsonb_array_length(v.rows),
    'rows', case when p_limit is null then v.rows
                 else coalesce((select jsonb_agg(r order by n) from jsonb_array_elements(v.rows) with ordinality x(r, n)
                                where n <= greatest(p_limit, 0)), '[]'::jsonb) end);
end;
$$;
revoke execute on function public.owner_sklad_ekasa_staged(uuid, uuid, integer) from public, anon;
grant execute on function public.owner_sklad_ekasa_staged(uuid, uuid, integer) to authenticated;

-- ------------------------------------------------------------------ 3. booking a line

/** The key of an export line (see the header): the same sale in two exports has the same key. */
create or replace function public.sklad_ekasa_key(p_shop_id uuid, p_doc text, p_time text, p_text_key text, p_qty numeric,
                                                 p_price numeric, p_n integer)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select md5(p_shop_id::text || ':ekasa:' || coalesce(p_doc, '') || '|' || coalesce(p_time, '') || '|' || p_text_key || '|'
             || trim_scale(p_qty)::text || '|' || coalesce(trim_scale(p_price)::text, '') || '|' || p_n::text)::uuid
$$;
revoke execute on function public.sklad_ekasa_key(uuid, text, text, text, numeric, numeric, integer) from public, anon, authenticated;

/** One waiting or new line → its movement (once: the movement's id is the line's key). Locks are taken by the caller. */
create or replace function public.sklad_ekasa_book(p_line public.sklad_ekasa_lines, p_location uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_line.item_id is null or p_line.qty = 0 then return; end if;
  insert into public.sklad_movements (id, shop_id, shop_item_id, location_id, kind, qty, reason, ref, device_label,
                                      created_by, client_at)
  values (p_line.line_key, p_line.shop_id, p_line.item_id, p_location,
          case when p_line.qty > 0 then 'sale'::public.sklad_kind else 'correction'::public.sklad_kind end,
          -p_line.qty,
          case when p_line.qty < 0 then 'Vrátenie – eKasa' end,
          left('eKasa ' || coalesce(p_line.doc, to_char(p_line.sold_at, 'YYYY-MM-DD HH24:MI')), 80),
          'eKasa', auth.uid(), p_line.sold_at)
  on conflict (id) do nothing;
end;
$$;
revoke execute on function public.sklad_ekasa_book(public.sklad_ekasa_lines, uuid) from public, anon, authenticated;

/** The import's numbers from its lines. */
create or replace function public.sklad_ekasa_count(p_import uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.sklad_ekasa_imports i set
    lines = c.n, booked = c.booked, unmatched = c.unmatched, ignored = c.ignored, duplicate = c.duplicate,
    pieces = c.pieces, docs = c.docs
  from (select count(*)::int n,
               count(*) filter (where state = 'booked')::int booked,
               count(*) filter (where state = 'unmatched')::int unmatched,
               count(*) filter (where state = 'ignored')::int ignored,
               count(*) filter (where state = 'duplicate')::int duplicate,
               coalesce(sum(qty) filter (where state = 'booked'), 0) pieces,
               count(distinct coalesce(doc, sold_at::text))::int docs
        from public.sklad_ekasa_lines where import_id = p_import) c
  where i.id = p_import
$$;
revoke execute on function public.sklad_ekasa_count(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ 4. the import

/**
 * The lines of one export, as the file writes them: [{doc, time (ISO), text, code, ean, qty, price}] (≤ 5 000). Only
 * while sales come from eKasa. The same file twice → the first import ({duplicate: true}).
 */
create or replace function public.owner_sklad_ekasa_import(p_shop_id uuid, p_id uuid, p_file_name text, p_file_hash text,
                                                          p_lines jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_done uuid;
  v_loc uuid;
  v_l jsonb;
  v_ord integer := 0;
  v_text text;
  v_key text;
  v_doc text;
  v_time text;
  v_at timestamptz;
  v_qty numeric;
  v_price numeric;
  v_code text;
  v_ean text;
  v_item uuid;
  v_state text;
  v_pair public.sklad_ekasa_pairs;
  v_seen jsonb := '{}'::jsonb;
  v_sig text;
  v_n integer;
  v_line_key uuid;
  v_ids uuid[];
  r public.sklad_ekasa_lines;
begin
  perform public.sklad_member(p_shop_id);
  if p_id is null or p_file_hash !~ '^[0-9a-f]{64}$' or nullif(btrim(coalesce(p_file_name, '')), '') is null
     or p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 5000 then
    raise exception 'bad_argument' using errcode = '22023';
  end if;
  perform public.sklad_setup(p_shop_id);
  if (select sale_source from public.sklad_settings where shop_id = p_shop_id) <> 'ekasa' then
    raise exception 'sale_source' using errcode = '55000';
  end if;
  -- one import of one shop at a time (two windows uploading the same day never book a line twice)
  perform pg_advisory_xact_lock(hashtextextended('sklad-ekasa:' || p_shop_id::text, 0));

  select id into v_done from public.sklad_ekasa_imports where shop_id = p_shop_id and file_hash = p_file_hash and status = 'done';
  if v_done is not null then
    return (select jsonb_build_object('id', i.id, 'duplicate', true, 'lines', i.lines, 'booked', i.booked,
                                      'unmatched', i.unmatched, 'ignored', i.ignored, 'skipped', i.duplicate,
                                      'pieces', i.pieces, 'docs', i.docs)
            from public.sklad_ekasa_imports i where i.id = v_done);
  end if;

  insert into public.sklad_ekasa_imports (id, shop_id, file_name, file_hash, status, created_by)
  values (p_id, p_shop_id, left(btrim(p_file_name), 200), p_file_hash, 'done', auth.uid())
  on conflict (id) do update set status = 'done', headers = null, rows = null, file_name = excluded.file_name,
                                 file_hash = excluded.file_hash
  where public.sklad_ekasa_imports.shop_id = p_shop_id and public.sklad_ekasa_imports.status = 'staged';
  if not exists (select 1 from public.sklad_ekasa_imports where id = p_id and shop_id = p_shop_id and status = 'done') then
    raise exception 'bad_argument' using errcode = '22023';
  end if;
  update public.sklad_ekasa_imports set done_at = now() where id = p_id;
  v_loc := public.sklad_default_location(p_shop_id, false);

  for v_l in select x from jsonb_array_elements(p_lines) x loop
    v_ord := v_ord + 1;
    v_text := left(btrim(coalesce(v_l ->> 'text', '')), 200);
    continue when v_text = '';
    v_qty := case when (v_l ->> 'qty') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_l ->> 'qty')::numeric end;
    continue when v_qty is null or abs(v_qty) > 1000000;
    v_price := case when (v_l ->> 'price') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_l ->> 'price')::numeric end;
    v_doc := nullif(left(btrim(coalesce(v_l ->> 'doc', '')), 80), '');
    v_at := null;
    begin
      v_at := nullif(btrim(coalesce(v_l ->> 'time', '')), '')::timestamptz;
    exception when others then v_at := null;
    end;
    v_time := case when v_at is null then null else to_char(v_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') end;
    v_code := nullif(left(btrim(coalesce(v_l ->> 'code', '')), 80), '');
    v_ean := nullif(left(regexp_replace(coalesce(v_l ->> 'ean', ''), '[^0-9]', '', 'g'), 32), '');
    v_key := left(public.search_text(v_text), 200);
    if v_key = '' then v_key := lower(v_text); end if;

    v_sig := coalesce(v_doc, '') || '|' || coalesce(v_time, '') || '|' || v_key || '|' || trim_scale(v_qty)::text || '|'
             || coalesce(trim_scale(v_price)::text, '');
    v_n := coalesce((v_seen ->> v_sig)::int, 0) + 1;
    v_seen := v_seen || jsonb_build_object(v_sig, v_n);
    v_line_key := public.sklad_ekasa_key(p_shop_id, v_doc, v_time, v_key, v_qty, v_price, v_n);

    v_item := null;
    v_state := 'unmatched';
    if exists (select 1 from public.sklad_ekasa_lines l where l.shop_id = p_shop_id and l.line_key = v_line_key)
       or exists (select 1 from public.sklad_movements m where m.id = v_line_key) then
      v_state := 'duplicate';
    elsif v_qty = 0 then
      v_state := 'ignored';
    else
      if v_ean is not null then
        select si.id into v_item from public.sklad_items i join public.shop_items si on si.id = i.shop_item_id
        where i.shop_id = p_shop_id and si.ean = v_ean limit 1;
      end if;
      if v_item is null and v_code is not null then
        select si.id into v_item from public.sklad_items i join public.shop_items si on si.id = i.shop_item_id
        where i.shop_id = p_shop_id and si.source_code = v_code limit 1;
      end if;
      if v_item is null then
        select * into v_pair from public.sklad_ekasa_pairs p where p.shop_id = p_shop_id and p.text_key = v_key;
        if v_pair.ignore then v_state := 'ignored'; else v_item := v_pair.item_id; end if;
      end if;
      if v_item is null and v_state = 'unmatched' then
        select min(si.id::text)::uuid into v_item
        from public.sklad_items i join public.shop_items si on si.id = i.shop_item_id
        where i.shop_id = p_shop_id and public.search_text(si.name) = v_key
        having count(*) = 1;
      end if;
      if v_item is not null then v_state := 'booked'; end if;
    end if;

    insert into public.sklad_ekasa_lines (import_id, ord, shop_id, line_key, doc, sold_at, text, text_key, code, ean, qty,
                                          price, item_id, state)
    values (p_id, v_ord, p_shop_id, v_line_key, v_doc, v_at, v_text, v_key, v_code, v_ean, v_qty, v_price, v_item, v_state);
  end loop;

  select array_agg(distinct item_id order by item_id) into v_ids
  from public.sklad_ekasa_lines where import_id = p_id and state = 'booked';
  if v_ids is not null then
    perform pg_advisory_xact_lock(hashtextextended('sklad:' || x::text, 0)) from unnest(v_ids) x order by x;
    for r in select * from public.sklad_ekasa_lines where import_id = p_id and state = 'booked' order by ord loop
      perform public.sklad_ekasa_book(r, v_loc);
    end loop;
    perform public.sklad_apply(p_shop_id, v_ids);
  end if;
  perform public.sklad_ekasa_count(p_id);

  insert into public.shop_activity (shop_id, action, details)
  select p_shop_id, 'sklad_ekasa_imported', jsonb_build_object('lines', i.lines, 'booked', i.booked, 'unmatched', i.unmatched)
  from public.sklad_ekasa_imports i where i.id = p_id;
  return (select jsonb_build_object('id', i.id, 'duplicate', false, 'lines', i.lines, 'booked', i.booked,
                                    'unmatched', i.unmatched, 'ignored', i.ignored, 'skipped', i.duplicate,
                                    'pieces', i.pieces, 'docs', i.docs)
          from public.sklad_ekasa_imports i where i.id = p_id);
end;
$$;
revoke execute on function public.owner_sklad_ekasa_import(uuid, uuid, text, text, jsonb) from public, anon;
grant execute on function public.owner_sklad_ekasa_import(uuid, uuid, text, text, jsonb) to authenticated;

-- ------------------------------------------------------------------ 5. pairing what waits

/** The waiting texts, one row per text (lines, pieces, a code/EAN seen) with up to 3 likely products. */
create or replace function public.owner_sklad_ekasa_unmatched(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.sklad_member(p_shop_id);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'key', w.text_key, 'text', w.text, 'lines', w.n, 'pieces', w.pieces, 'code', w.code, 'ean', w.ean,
             'candidates', coalesce((
               select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'code', c.source_code) order by c.score desc)
               from (select si.id, si.name, si.source_code,
                            extensions.similarity(public.search_text(si.name), w.text_key) as score
                     from public.sklad_items i join public.shop_items si on si.id = i.shop_item_id
                     where i.shop_id = p_shop_id
                     order by 4 desc limit 3) c
               where c.score >= 0.2), '[]'::jsonb))
           order by w.n desc, w.text)
    from (select l.text_key, min(l.text) as text, count(*)::int as n, sum(l.qty) as pieces,
                 min(l.code) as code, min(l.ean) as ean
          from public.sklad_ekasa_lines l
          where l.shop_id = p_shop_id and l.state = 'unmatched'
          group by l.text_key
          limit 200) w), '[]'::jsonb);
end;
$$;
revoke execute on function public.owner_sklad_ekasa_unmatched(uuid) from public, anon;
grant execute on function public.owner_sklad_ekasa_unmatched(uuid) to authenticated;

/**
 * Pairs a text with a product (or "Nie je tovar" = ignore), remembers it for the next exports and books (or ignores)
 * every line of that text waiting now. Returns {lines, pieces}.
 */
create or replace function public.owner_sklad_ekasa_pair(p_shop_id uuid, p_key text, p_item_id uuid, p_ignore boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := left(btrim(coalesce(p_key, '')), 200);
  v_loc uuid;
  v_n integer := 0;
  v_pieces numeric := 0;
  v_imports uuid[];
  r public.sklad_ekasa_lines;
  x uuid;
begin
  perform public.sklad_member(p_shop_id);
  if v_key = '' or (coalesce(p_ignore, false) = false and p_item_id is null) then
    raise exception 'bad_argument' using errcode = '22023';
  end if;
  if not coalesce(p_ignore, false)
     and not exists (select 1 from public.sklad_items i where i.shop_item_id = p_item_id and i.shop_id = p_shop_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sklad-ekasa:' || p_shop_id::text, 0));
  insert into public.sklad_ekasa_pairs (shop_id, text_key, item_id, ignore)
  values (p_shop_id, v_key, case when p_ignore then null else p_item_id end, coalesce(p_ignore, false))
  on conflict (shop_id, text_key) do update set item_id = excluded.item_id, ignore = excluded.ignore, created_at = now();

  select array_agg(distinct import_id) into v_imports
  from public.sklad_ekasa_lines where shop_id = p_shop_id and state = 'unmatched' and text_key = v_key;
  if v_imports is null then return jsonb_build_object('lines', 0, 'pieces', 0); end if;

  if p_ignore then
    update public.sklad_ekasa_lines set state = 'ignored'
    where shop_id = p_shop_id and state = 'unmatched' and text_key = v_key;
    get diagnostics v_n = row_count;
  else
    perform pg_advisory_xact_lock(hashtextextended('sklad:' || p_item_id::text, 0));
    v_loc := public.sklad_default_location(p_shop_id, false);
    for r in update public.sklad_ekasa_lines set state = 'booked', item_id = p_item_id
             where shop_id = p_shop_id and state = 'unmatched' and text_key = v_key
             returning * loop
      perform public.sklad_ekasa_book(r, v_loc);
      v_n := v_n + 1;
      v_pieces := v_pieces + r.qty;
    end loop;
    perform public.sklad_apply(p_shop_id, array[p_item_id]);
  end if;
  foreach x in array v_imports loop perform public.sklad_ekasa_count(x); end loop;
  insert into public.shop_activity (shop_id, action, details)
  values (p_shop_id, 'sklad_ekasa_paired', jsonb_build_object('lines', v_n, 'ignore', coalesce(p_ignore, false)));
  return jsonb_build_object('lines', v_n, 'pieces', v_pieces);
end;
$$;
revoke execute on function public.owner_sklad_ekasa_pair(uuid, text, uuid, boolean) from public, anon;
grant execute on function public.owner_sklad_ekasa_pair(uuid, text, uuid, boolean) to authenticated;

/** "Zabudnúť spárovanie": the next exports ask again; booked movements stay (a mistake = an Oprava, as always). */
create or replace function public.owner_sklad_ekasa_forget(p_shop_id uuid, p_key text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.sklad_member(p_shop_id);
  delete from public.sklad_ekasa_pairs where shop_id = p_shop_id and text_key = left(btrim(coalesce(p_key, '')), 200);
end;
$$;
revoke execute on function public.owner_sklad_ekasa_forget(uuid, text) from public, anon;
grant execute on function public.owner_sklad_ekasa_forget(uuid, text) to authenticated;

-- ------------------------------------------------------------------ 6. what the screens read

/** Settings card + the eKasa page: the source, the columns, the last imports, how many texts wait, the pairings. */
create or replace function public.owner_sklad_ekasa_info(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.sklad_settings;
begin
  perform public.sklad_member(p_shop_id);
  select * into s from public.sklad_settings where shop_id = p_shop_id;
  return jsonb_build_object(
    'sale_source', coalesce(s.sale_source, 'predaj'),
    'columns', s.ekasa_columns,
    'waiting_texts', (select count(distinct text_key) from public.sklad_ekasa_lines
                      where shop_id = p_shop_id and state = 'unmatched'),
    'waiting_lines', (select count(*) from public.sklad_ekasa_lines where shop_id = p_shop_id and state = 'unmatched'),
    'imports', coalesce((select jsonb_agg(jsonb_build_object(
                  'id', i.id, 'file_name', i.file_name, 'at', i.done_at, 'docs', i.docs, 'lines', i.lines,
                  'booked', i.booked, 'unmatched', i.unmatched, 'ignored', i.ignored, 'skipped', i.duplicate,
                  'pieces', i.pieces) order by i.done_at desc)
                from (select * from public.sklad_ekasa_imports
                      where shop_id = p_shop_id and status = 'done' order by done_at desc limit 20) i), '[]'::jsonb),
    'pairs', coalesce((select jsonb_agg(jsonb_build_object('key', p.text_key, 'ignore', p.ignore, 'item_id', p.item_id,
                                                           'name', si.name) order by p.created_at desc)
                       from (select * from public.sklad_ekasa_pairs where shop_id = p_shop_id
                             order by created_at desc limit 200) p
                       left join public.shop_items si on si.id = p.item_id), '[]'::jsonb));
end;
$$;
revoke execute on function public.owner_sklad_ekasa_info(uuid) from public, anon;
grant execute on function public.owner_sklad_ekasa_info(uuid) to authenticated;

/** "Dodávatelia (XLSX)": every supplier written on a product or a receipt, with counts (private, owners only). */
create or replace function public.owner_sklad_supplier_list(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.sklad_member(p_shop_id);
  return coalesce((
    select jsonb_agg(jsonb_build_object('name', n.name, 'products', n.products, 'receipts', n.receipts,
                                        'last_receipt', n.last_receipt) order by lower(n.name))
    from (select a.name,
                 (select count(*) from public.sklad_items i where i.shop_id = p_shop_id and i.supplier = a.name)::int as products,
                 (select count(*) from public.sklad_receipts r where r.shop_id = p_shop_id and r.supplier = a.name
                    and r.status = 'done')::int as receipts,
                 (select max(r.confirmed_at) from public.sklad_receipts r where r.shop_id = p_shop_id and r.supplier = a.name
                    and r.status = 'done') as last_receipt
          from (select distinct s as name from (
                  select i.supplier as s from public.sklad_items i where i.shop_id = p_shop_id and i.supplier is not null
                  union
                  select r.supplier from public.sklad_receipts r where r.shop_id = p_shop_id and r.supplier is not null) u
                limit 2000) a) n), '[]'::jsonb);
end;
$$;
revoke execute on function public.owner_sklad_supplier_list(uuid) from public, anon;
grant execute on function public.owner_sklad_supplier_list(uuid) to authenticated;
