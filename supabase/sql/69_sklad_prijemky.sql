-- =====================================================================================================================
-- Update 69 — "Sklad v Cacaduu", phase C: Príjemky (Prompt 14, 2026-11-02, at the owner's request)
--
-- A goods receipt ("príjemka") with many lines: supplier, invoice number, delivery date, the location to stock into,
-- and per line a product (or a NEW product: name, EAN, sale price), the quantity and the purchase price without VAT.
--   * A receipt is a draft ("koncept", saved as often as wanted, numbered P-<year>-<NNN> in the shop's year) until
--     "Potvrdiť príjemku": then, in ONE transaction, the new products are made (owner_sklad_save_product: the plan's
--     limit, EAN unique), one Príjem movement per line (owner_sklad_move: last / average cost, the public side) with a
--     movement id made from the receipt id and the line number, so a second "Potvrdiť" or a retry counts nothing
--     twice, and the receipt's supplier becomes the products' supplier (private). A confirmed receipt never changes;
--     a mistake is an Oprava on the product card. A draft can be discarded (kept as "discarded", never deleted).
--   * The invoice read by the AI: the website reads the photo / PDF with Claude and gets the lines as written;
--     owner_sklad_match() pairs them with the shop's products IN SQL (EAN, then the shop's code, then the name by
--     trigram similarity: sure / "Skontrolujte produkt" with up to 3 candidates / new). Nothing is saved until the
--     owner adds the lines to the receipt and confirms it. sklad_ai_hit(): Free 5, Pro 50 readings a day per shop.
--   * Purchase prices, suppliers and invoices are private like every Sklad table: service role only; owners only
--     through the owner_sklad_* functions (members).
-- Needs updates 67 and 68. Safe to run twice.
-- =====================================================================================================================

alter table public.sklad_settings add column if not exists rc_year integer;
alter table public.sklad_settings add column if not exists rc_seq integer not null default 0;

create table if not exists public.sklad_receipts (
  id            uuid primary key,
  shop_id       uuid not null references public.shops (id) on delete cascade,
  number        text not null check (number ~ '^P-[0-9]{4}-[0-9]{3,6}$'),
  status        text not null default 'draft' check (status in ('draft', 'done', 'discarded')),
  supplier      text check (supplier is null or char_length(supplier) <= 120),
  invoice_no    text check (invoice_no is null or char_length(invoice_no) <= 60),
  delivered_on  date,
  location_id   uuid not null references public.sklad_locations (id),
  -- [{item_id | null, name, code, ean, qty, unit_cost (without VAT) | null, sale_price | null (new products),
  --   vat_rate | null (new products), src (the invoice's text) | null}]
  lines         jsonb not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) <= 200),
  total         numeric not null default 0,
  pieces        numeric not null default 0,
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  confirmed_at  timestamptz,
  confirmed_by  uuid references auth.users (id) on delete set null,
  check ((status = 'done') = (confirmed_at is not null))
);
create unique index if not exists sklad_receipts_number_idx on public.sklad_receipts (shop_id, number);
create index if not exists sklad_receipts_shop_idx on public.sklad_receipts (shop_id, created_at desc);

create table if not exists public.sklad_ai_usage (
  shop_id  uuid not null references public.shops (id) on delete cascade,
  day      date not null,
  n        integer not null default 0,
  primary key (shop_id, day)
);

do $$
declare
  t text;
begin
  foreach t in array array['sklad_receipts', 'sklad_ai_usage'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

-- ------------------------------------------------------------------ helpers

/** The next receipt number of the shop's year: P-2026-001 (the settings row is locked meanwhile). */
create or replace function public.sklad_next_receipt_no(p_shop_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_tz text := coalesce((select timezone from public.shops where id = p_shop_id), 'UTC');
  v_year integer := extract(year from (now() at time zone v_tz))::integer;
  v_seq integer;
begin
  perform public.sklad_setup(p_shop_id);
  update public.sklad_settings
  set rc_seq = case when rc_year = v_year then rc_seq + 1 else 1 end, rc_year = v_year
  where shop_id = p_shop_id
  returning rc_seq into v_seq;
  return 'P-' || v_year || '-' || lpad(v_seq::text, 3, '0');
end;
$$;
revoke execute on function public.sklad_next_receipt_no(uuid) from public, anon, authenticated;

/** A receipt as the owner's screens show it (the lines with their product's current name, code, VAT and price). */
create or replace function public.sklad_receipt_json(p_r public.sklad_receipts)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_r.id, 'number', p_r.number, 'status', p_r.status, 'supplier', p_r.supplier, 'invoice_no', p_r.invoice_no,
    'delivered_on', p_r.delivered_on, 'location_id', p_r.location_id,
    'location', (select l.name from public.sklad_locations l where l.id = p_r.location_id),
    'total', p_r.total, 'pieces', p_r.pieces, 'created_at', p_r.created_at, 'updated_at', p_r.updated_at,
    'confirmed_at', p_r.confirmed_at,
    'lines', coalesce((
      select jsonb_agg(l || jsonb_build_object(
               'vat_rate', coalesce(i.vat_rate, (l ->> 'vat_rate')::numeric, 23),
               'current_sale_price', i.sale_price,
               'name', coalesce(si.name, l ->> 'name'),
               'code', coalesce(si.source_code, l ->> 'code'))
             order by ord)
      from jsonb_array_elements(p_r.lines) with ordinality as t(l, ord)
      left join public.sklad_items i on i.shop_item_id = nullif(l ->> 'item_id', '')::uuid and i.shop_id = p_r.shop_id
      left join public.shop_items si on si.id = i.shop_item_id), '[]'::jsonb))
$$;
revoke execute on function public.sklad_receipt_json(public.sklad_receipts) from public, anon, authenticated;

-- ------------------------------------------------------------------ the owner's side

/**
 * "Uložiť koncept" (and every change before "Potvrdiť"): the receipt by the client's own id, made on first save
 * (numbered then). p: supplier, invoice_no, delivered_on (YYYY-MM-DD), location_id, lines [{item_id | null, name,
 * ean, qty, unit_cost, sale_price, vat_rate, src}]. Only a draft changes ("done" / "discarded" otherwise).
 */
create or replace function public.owner_sklad_receipt_save(p_shop_id uuid, p_id uuid, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_r public.sklad_receipts%rowtype;
  v_loc uuid;
  v_lines jsonb := '[]'::jsonb;
  v_l jsonb;
  v_item uuid;
  v_qty numeric;
  v_cost numeric;
  v_sale numeric;
  v_vat numeric;
  v_name text;
  v_ean text;
  v_date date;
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  perform public.sklad_member(p_shop_id);
  perform public.sklad_setup(p_shop_id);
  if p_id is null or p is null or jsonb_typeof(p) <> 'object' then raise exception 'bad_argument' using errcode = '22023'; end if;
  select * into v_r from public.sklad_receipts where id = p_id for update;
  if found and v_r.shop_id <> p_shop_id then raise exception 'id' using errcode = '22023'; end if;
  if found and v_r.status = 'done' then raise exception 'done' using errcode = '55000'; end if;
  if found and v_r.status = 'discarded' then raise exception 'discarded' using errcode = '55000'; end if;

  v_loc := coalesce(case when coalesce(p ->> 'location_id', '') ~* v_uuid then (p ->> 'location_id')::uuid end,
                    v_r.location_id, public.sklad_default_location(p_shop_id, true));
  if not exists (select 1 from public.sklad_locations l where l.id = v_loc and l.shop_id = p_shop_id) then
    raise exception 'location' using errcode = '22023';
  end if;
  if nullif(p ->> 'delivered_on', '') is not null then
    begin
      v_date := (p ->> 'delivered_on')::date;
    exception when others then
      raise exception 'date' using errcode = '22023';
    end;
    if v_date < date '2000-01-01' or v_date > current_date + 366 then raise exception 'date' using errcode = '22023'; end if;
  end if;
  if char_length(coalesce(p ->> 'supplier', '')) > 120 then raise exception 'supplier' using errcode = '22023'; end if;
  if char_length(coalesce(p ->> 'invoice_no', '')) > 60 then raise exception 'invoice_no' using errcode = '22023'; end if;
  if p ? 'lines' and jsonb_typeof(p -> 'lines') <> 'array' then raise exception 'bad_argument' using errcode = '22023'; end if;
  if jsonb_array_length(coalesce(p -> 'lines', '[]'::jsonb)) > 200 then raise exception 'too_many' using errcode = '22023'; end if;

  for v_l in select x from jsonb_array_elements(coalesce(p -> 'lines', v_r.lines, '[]'::jsonb)) x loop
    if jsonb_typeof(v_l) <> 'object' then raise exception 'bad_argument' using errcode = '22023'; end if;
    if coalesce(v_l ->> 'qty', '') !~ '^[0-9]{1,9}(\.[0-9]{1,3})?$' or (v_l ->> 'qty')::numeric <= 0 then
      raise exception 'qty' using errcode = '22023';
    end if;
    v_qty := (v_l ->> 'qty')::numeric;
    v_cost := null; v_sale := null; v_vat := null; v_item := null;
    if nullif(v_l ->> 'unit_cost', '') is not null then
      if (v_l ->> 'unit_cost') !~ '^[0-9]{1,9}(\.[0-9]{1,4})?$' then raise exception 'unit_cost' using errcode = '22023'; end if;
      v_cost := (v_l ->> 'unit_cost')::numeric;
    end if;
    if coalesce(v_l ->> 'item_id', '') ~* v_uuid then
      v_item := (v_l ->> 'item_id')::uuid;
      if not exists (select 1 from public.sklad_items i where i.shop_item_id = v_item and i.shop_id = p_shop_id) then
        raise exception 'not_found' using errcode = 'P0002';
      end if;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'item_id', v_item, 'qty', v_qty, 'unit_cost', v_cost,
        'src', nullif(left(btrim(coalesce(v_l ->> 'src', '')), 200), '')));
    else
      v_name := nullif(btrim(coalesce(v_l ->> 'name', '')), '');
      if v_name is null or char_length(v_name) > 300 then raise exception 'name' using errcode = '22023'; end if;
      v_ean := nullif(regexp_replace(coalesce(v_l ->> 'ean', ''), '\s', '', 'g'), '');
      if v_ean is not null and v_ean !~ '^[0-9A-Za-z-]{4,32}$' then raise exception 'ean' using errcode = '22023'; end if;
      if nullif(v_l ->> 'sale_price', '') is not null then
        if (v_l ->> 'sale_price') !~ '^[0-9]{1,9}(\.[0-9]{1,2})?$' then raise exception 'sale_price' using errcode = '22023'; end if;
        v_sale := (v_l ->> 'sale_price')::numeric;
      end if;
      if nullif(v_l ->> 'vat_rate', '') is not null then
        if (v_l ->> 'vat_rate') !~ '^[0-9]{1,3}(\.[0-9]{1,2})?$' or (v_l ->> 'vat_rate')::numeric > 100 then
          raise exception 'vat_rate' using errcode = '22023';
        end if;
        v_vat := (v_l ->> 'vat_rate')::numeric;
      end if;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'item_id', null, 'name', v_name, 'ean', v_ean, 'qty', v_qty, 'unit_cost', v_cost, 'sale_price', v_sale,
        'vat_rate', v_vat, 'src', nullif(left(btrim(coalesce(v_l ->> 'src', '')), 200), '')));
    end if;
  end loop;

  if v_r.id is null then
    insert into public.sklad_receipts (id, shop_id, number, supplier, invoice_no, delivered_on, location_id, lines,
                                       total, pieces, created_by)
    values (p_id, p_shop_id, public.sklad_next_receipt_no(p_shop_id),
            nullif(btrim(coalesce(p ->> 'supplier', '')), ''), nullif(btrim(coalesce(p ->> 'invoice_no', '')), ''),
            v_date, v_loc, v_lines,
            coalesce((select sum(round(coalesce((l ->> 'unit_cost')::numeric, 0) * (l ->> 'qty')::numeric, 2)) from jsonb_array_elements(v_lines) l), 0),
            coalesce((select sum((l ->> 'qty')::numeric) from jsonb_array_elements(v_lines) l), 0),
            auth.uid())
    on conflict (id) do nothing
    returning * into v_r;
    if not found then raise exception 'id' using errcode = '22023'; end if;
  else
    update public.sklad_receipts set
      supplier = case when p ? 'supplier' then nullif(btrim(coalesce(p ->> 'supplier', '')), '') else supplier end,
      invoice_no = case when p ? 'invoice_no' then nullif(btrim(coalesce(p ->> 'invoice_no', '')), '') else invoice_no end,
      delivered_on = case when p ? 'delivered_on' then v_date else delivered_on end,
      location_id = v_loc,
      lines = v_lines,
      total = coalesce((select sum(round(coalesce((l ->> 'unit_cost')::numeric, 0) * (l ->> 'qty')::numeric, 2)) from jsonb_array_elements(v_lines) l), 0),
      pieces = coalesce((select sum((l ->> 'qty')::numeric) from jsonb_array_elements(v_lines) l), 0),
      updated_at = now()
    where id = p_id
    returning * into v_r;
  end if;
  return public.sklad_receipt_json(v_r);
end;
$$;
revoke execute on function public.owner_sklad_receipt_save(uuid, uuid, jsonb) from public, anon;
grant execute on function public.owner_sklad_receipt_save(uuid, uuid, jsonb) to authenticated;

/**
 * "Potvrdiť príjemku": the new products are made, one Príjem movement per line (its id from the receipt id + the line
 * number: a second call counts nothing twice), the supplier set on the products, the receipt "done" — one transaction.
 */
create or replace function public.owner_sklad_receipt_confirm(p_shop_id uuid, p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_r public.sklad_receipts%rowtype;
  v_l jsonb;
  v_ord bigint;
  v_item uuid;
  v_lines jsonb := '[]'::jsonb;
  v_ref text;
begin
  perform public.sklad_member(p_shop_id);
  select * into v_r from public.sklad_receipts where id = p_id and shop_id = p_shop_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_r.status = 'done' then return public.sklad_receipt_json(v_r) || jsonb_build_object('duplicate', true); end if;
  if v_r.status = 'discarded' then raise exception 'discarded' using errcode = '55000'; end if;
  if jsonb_array_length(v_r.lines) = 0 then raise exception 'empty' using errcode = '22023'; end if;
  v_ref := left(v_r.number || coalesce(' · ' || v_r.invoice_no, ''), 80);

  for v_l, v_ord in select x, o from jsonb_array_elements(v_r.lines) with ordinality as t(x, o) loop
    v_item := nullif(v_l ->> 'item_id', '')::uuid;
    if v_item is null then
      v_item := public.owner_sklad_save_product(p_shop_id, null, jsonb_strip_nulls(jsonb_build_object(
        'name', v_l ->> 'name', 'ean', v_l ->> 'ean', 'sale_price', v_l ->> 'sale_price', 'vat_rate', v_l ->> 'vat_rate',
        'supplier', v_r.supplier)));
    elsif v_r.supplier is not null then
      update public.sklad_items set supplier = v_r.supplier, updated_at = now()
      where shop_item_id = v_item and shop_id = p_shop_id and supplier is distinct from v_r.supplier;
    end if;
    perform public.owner_sklad_move(p_shop_id, md5(v_r.id::text || ':' || v_ord)::uuid, v_item, 'receipt',
                                    (v_l ->> 'qty')::numeric, v_r.location_id, null,
                                    nullif(v_l ->> 'unit_cost', '')::numeric, null, v_ref, null, null);
    v_lines := v_lines || jsonb_build_array(v_l || jsonb_build_object('item_id', v_item));
  end loop;

  update public.sklad_receipts
  set status = 'done', lines = v_lines, confirmed_at = now(), confirmed_by = auth.uid(), updated_at = now()
  where id = p_id
  returning * into v_r;
  return public.sklad_receipt_json(v_r) || jsonb_build_object('duplicate', false);
end;
$$;
revoke execute on function public.owner_sklad_receipt_confirm(uuid, uuid) from public, anon;
grant execute on function public.owner_sklad_receipt_confirm(uuid, uuid) to authenticated;

/** "Zahodiť koncept": a draft becomes "discarded" (kept, never deleted; nothing was stocked). */
create or replace function public.owner_sklad_receipt_discard(p_shop_id uuid, p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.sklad_member(p_shop_id);
  if exists (select 1 from public.sklad_receipts where id = p_id and shop_id = p_shop_id and status = 'done') then
    raise exception 'done' using errcode = '55000';
  end if;
  update public.sklad_receipts set status = 'discarded', updated_at = now()
  where id = p_id and shop_id = p_shop_id and status = 'draft';
end;
$$;
revoke execute on function public.owner_sklad_receipt_discard(uuid, uuid) from public, anon;
grant execute on function public.owner_sklad_receipt_discard(uuid, uuid) to authenticated;

create or replace function public.owner_sklad_receipt(p_shop_id uuid, p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_r public.sklad_receipts%rowtype;
begin
  perform public.sklad_member(p_shop_id);
  select * into v_r from public.sklad_receipts where id = p_id and shop_id = p_shop_id;
  if not found then return null; end if;
  return public.sklad_receipt_json(v_r);
end;
$$;
revoke execute on function public.owner_sklad_receipt(uuid, uuid) from public, anon;
grant execute on function public.owner_sklad_receipt(uuid, uuid) to authenticated;

/** "Príjemky": the drafts first, then the confirmed ones, newest first; the known suppliers for the field. */
create or replace function public.owner_sklad_receipts(p_shop_id uuid, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.sklad_member(p_shop_id);
  return jsonb_build_object(
    'rows', coalesce((select jsonb_agg(x order by x.ord, x.created_at desc) from (
               select r.id, r.number, r.status, r.supplier, r.invoice_no, r.delivered_on, r.total, r.pieces,
                      jsonb_array_length(r.lines) as line_count, r.created_at, r.confirmed_at,
                      (select l.name from public.sklad_locations l where l.id = r.location_id) as location,
                      case r.status when 'draft' then 0 else 1 end as ord
               from public.sklad_receipts r
               where r.shop_id = p_shop_id and r.status <> 'discarded'
               order by case r.status when 'draft' then 0 else 1 end, r.created_at desc
               limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) x), '[]'::jsonb),
    'drafts', (select count(*) from public.sklad_receipts r where r.shop_id = p_shop_id and r.status = 'draft'),
    'suppliers', public.owner_sklad_suppliers(p_shop_id));
end;
$$;
revoke execute on function public.owner_sklad_receipts(uuid, integer, integer) from public, anon;
grant execute on function public.owner_sklad_receipts(uuid, integer, integer) to authenticated;

/** The suppliers the shop already wrote (products and receipts), for the "Dodávateľ" field (≤ 50, by name). */
create or replace function public.owner_sklad_suppliers(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.sklad_member(p_shop_id);
  return coalesce((select jsonb_agg(s order by lower(s)) from (
            select distinct s from (
              select i.supplier as s from public.sklad_items i where i.shop_id = p_shop_id and i.supplier is not null
              union
              select r.supplier from public.sklad_receipts r where r.shop_id = p_shop_id and r.supplier is not null) a
            limit 50) b), '[]'::jsonb);
end;
$$;
revoke execute on function public.owner_sklad_suppliers(uuid) from public, anon;
grant execute on function public.owner_sklad_suppliers(uuid) to authenticated;

/**
 * The invoice's lines (as the AI read them: [{text, ean, code}]) paired with the shop's Sklad products: the EAN, then
 * the shop's code → "ean" / "code"; else by name: similarity ≥ 0.55 and clearly ahead of the next → "name"; ≥ 0.25 →
 * "unsure" with up to 3 candidates; else "new". Only this shop's products; decided here, never in the browser.
 */
create or replace function public.owner_sklad_match(p_shop_id uuid, p_lines jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_l jsonb;
  v_out jsonb := '[]'::jsonb;
  v_hit uuid;
  v_kind text;
  v_cands jsonb;
  v_best numeric;
  v_second numeric;
  v_text text;
begin
  perform public.sklad_member(p_shop_id);
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 200 then
    raise exception 'bad_argument' using errcode = '22023';
  end if;
  for v_l in select x from jsonb_array_elements(p_lines) x loop
    v_hit := null; v_kind := 'new'; v_cands := '[]'::jsonb;
    v_text := left(btrim(coalesce(v_l ->> 'text', '')), 200);
    if nullif(btrim(coalesce(v_l ->> 'ean', '')), '') is not null then
      select si.id into v_hit from public.sklad_items i join public.shop_items si on si.id = i.shop_item_id
      where i.shop_id = p_shop_id and si.ean = btrim(v_l ->> 'ean') limit 1;
      if v_hit is not null then v_kind := 'ean'; end if;
    end if;
    if v_hit is null and nullif(btrim(coalesce(v_l ->> 'code', '')), '') is not null then
      select si.id into v_hit from public.sklad_items i join public.shop_items si on si.id = i.shop_item_id
      where i.shop_id = p_shop_id and si.source_code = btrim(v_l ->> 'code') limit 1;
      if v_hit is not null then v_kind := 'code'; end if;
    end if;
    if v_hit is null and v_text <> '' then
      select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'code', c.source_code, 'score', round(c.score, 3))
                                order by c.score desc), '[]'::jsonb),
             max(c.score), (array_agg(c.score order by c.score desc))[2]
      into v_cands, v_best, v_second
      from (
        select si.id, si.name, si.source_code,
               extensions.similarity(public.search_text(si.name), public.search_text(v_text))::numeric as score
        from public.sklad_items i join public.shop_items si on si.id = i.shop_item_id
        where i.shop_id = p_shop_id
        order by 4 desc
        limit 3) c
      where c.score >= 0.25;
      if v_best is not null and v_best >= 0.55 and (v_second is null or v_second < v_best - 0.1) then
        v_hit := (v_cands -> 0 ->> 'id')::uuid;
        v_kind := 'name';
      elsif v_best is not null then
        v_kind := 'unsure';
      end if;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'kind', v_kind, 'item_id', v_hit,
      'name', (select si.name from public.shop_items si where si.id = v_hit),
      'code', (select si.source_code from public.shop_items si where si.id = v_hit),
      'candidates', case when v_kind = 'unsure' then v_cands else '[]'::jsonb end));
  end loop;
  return v_out;
end;
$$;
revoke execute on function public.owner_sklad_match(uuid, jsonb) from public, anon;
grant execute on function public.owner_sklad_match(uuid, jsonb) to authenticated;

/** One AI reading of an invoice (the website asks before calling Claude): Free 5, Pro 50 a day per shop. */
create or replace function public.sklad_ai_hit(p_shop_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone coalesce((select timezone from public.shops where id = p_shop_id), 'UTC'))::date;
  v_n integer;
begin
  perform public.sklad_member(p_shop_id);
  insert into public.sklad_ai_usage (shop_id, day, n) values (p_shop_id, v_day, 1)
  on conflict (shop_id, day) do update set n = public.sklad_ai_usage.n + 1
  returning n into v_n;
  if v_n > (case when public.shop_has_plan(p_shop_id) then 50 else 5 end) then
    update public.sklad_ai_usage set n = n - 1 where shop_id = p_shop_id and day = v_day;
    return false;
  end if;
  delete from public.sklad_ai_usage where shop_id = p_shop_id and day < v_day - 7;
  return true;
end;
$$;
revoke execute on function public.sklad_ai_hit(uuid) from public, anon;
grant execute on function public.sklad_ai_hit(uuid) to authenticated;
