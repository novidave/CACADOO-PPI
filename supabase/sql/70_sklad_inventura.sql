-- =====================================================================================================================
-- Update 70 — "Sklad v Cacaduu", phase D: Inventúra (Prompt 14, 2026-11-02, at the owner's request)
--
-- A stock count of one location (all of it, or one shelf = sklad_items.shelf) while the shop stays open:
--   * "Spustiť inventúru" makes sklad_counts (the client's UUID, I-<year>-<NN> in the shop's year, open); blind by
--     default (the counting phones never get the expected quantity).
--   * Every phone counts under its own name ("Telefón 1 · Peter", kept on the phone; every phone is logged in as one of
--     the shop's owners): one row per product and counter in sklad_count_lines (the total it counted + when). Two
--     phones on the same product are added up, or "Platí môj počet" sets the others' rows of that product to 0.
--   * The expected quantity of a product = its stock at the location AT THE TIME IT WAS COUNTED (the stock now minus
--     the movements since — sales and receipts during the count never make a false difference).
--   * "Schváliť inventúru": per counted product (not marked "Prepočítať") one Inventúra movement (kind count, the
--     difference, ref = the number; id from the count id + product, so a second call counts nothing twice) — at the
--     time of approval the new stock = counted + what happened since it was counted. Optionally (a whole location
--     only) the products never counted are set to 0. One transaction (owner_sklad_move → sklad_apply: the shop page
--     follows). The value of the differences uses the average purchase price (private).
--   * "Vrátiť inventúru späť" within 24 hours: one Oprava per corrected product with the opposite quantity (reason
--     "Vrátenie inventúry I-…"); the movements stay, as always.
-- Owners only (sklad_member); no grants but the service role. Needs updates 67–69. Safe to run twice.
-- =====================================================================================================================

alter table public.sklad_settings add column if not exists ic_year integer;
alter table public.sklad_settings add column if not exists ic_seq integer not null default 0;

create table if not exists public.sklad_counts (
  id             uuid primary key,
  shop_id        uuid not null references public.shops (id) on delete cascade,
  number         text not null check (number ~ '^I-[0-9]{4}-[0-9]{2,6}$'),
  name           text check (name is null or char_length(name) <= 80),
  location_id    uuid not null references public.sklad_locations (id),
  shelf          text check (shelf is null or char_length(shelf) <= 80),
  blind          boolean not null default true,
  status         text not null default 'open' check (status in ('open', 'approved', 'cancelled', 'undone')),
  zeroed         boolean not null default false,
  result         jsonb,
  started_by     uuid references auth.users (id) on delete set null,
  started_at     timestamptz not null default now(),
  approved_by    uuid references auth.users (id) on delete set null,
  approved_at    timestamptz,
  closed_at      timestamptz
);
create unique index if not exists sklad_counts_number_idx on public.sklad_counts (shop_id, number);
create index if not exists sklad_counts_shop_idx on public.sklad_counts (shop_id, started_at desc);

create table if not exists public.sklad_count_lines (
  count_id      uuid not null references public.sklad_counts (id) on delete cascade,
  shop_item_id  uuid not null references public.sklad_items (shop_item_id) on delete cascade,
  counter       text not null check (char_length(btrim(counter)) between 1 and 60),
  qty           numeric not null check (qty >= 0 and qty <= 1000000000),
  counted_at    timestamptz not null default now(),
  counted_by    uuid references auth.users (id) on delete set null,
  primary key (count_id, shop_item_id, counter)
);

create table if not exists public.sklad_count_marks (
  count_id      uuid not null references public.sklad_counts (id) on delete cascade,
  shop_item_id  uuid not null references public.sklad_items (shop_item_id) on delete cascade,
  recount       boolean not null default true,
  primary key (count_id, shop_item_id)
);

do $$
declare
  t text;
begin
  foreach t in array array['sklad_counts', 'sklad_count_lines', 'sklad_count_marks'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

-- ------------------------------------------------------------------ helpers

create or replace function public.sklad_next_count_no(p_shop_id uuid)
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
  set ic_seq = case when ic_year = v_year then ic_seq + 1 else 1 end, ic_year = v_year
  where shop_id = p_shop_id
  returning ic_seq into v_seq;
  return 'I-' || v_year || '-' || lpad(v_seq::text, 2, '0');
end;
$$;
revoke execute on function public.sklad_next_count_no(uuid) from public, anon, authenticated;

/** The stock of a product at a location at a moment (the stock now minus every movement there since). */
create or replace function public.sklad_stock_at(p_item uuid, p_location uuid, p_at timestamptz)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select sum(s.qty) from public.sklad_stock s where s.shop_item_id = p_item and s.location_id = p_location), 0)
       - coalesce((select sum(case
                                when m.kind = 'transfer' and m.location_id = p_location then -m.qty
                                when m.kind = 'transfer' then m.qty
                                else m.qty end)
                   from public.sklad_movements m
                   where m.shop_item_id = p_item and m.created_at > p_at
                     and (m.location_id = p_location or m.to_location_id = p_location)), 0)
$$;
revoke execute on function public.sklad_stock_at(uuid, uuid, timestamptz) from public, anon, authenticated;

/** The products a count covers: on its shelf (shelf counts), else every product with stock at the location; + counted. */
create or replace function public.sklad_count_scope(p_count public.sklad_counts)
returns table (shop_item_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select i.shop_item_id from public.sklad_items i
  where i.shop_id = p_count.shop_id
    and case when p_count.shelf is not null then lower(btrim(coalesce(i.shelf, ''))) = lower(btrim(p_count.shelf))
             else exists (select 1 from public.sklad_stock s where s.shop_item_id = i.shop_item_id
                          and s.location_id = p_count.location_id and s.qty <> 0) end
  union
  select l.shop_item_id from public.sklad_count_lines l where l.count_id = p_count.id
$$;
revoke execute on function public.sklad_count_scope(public.sklad_counts) from public, anon, authenticated;

-- ------------------------------------------------------------------ the owner's side

/** "Spustiť inventúru": a count of one location (shelf optional), blind by default. Returns its id and number. */
create or replace function public.owner_sklad_count_start(p_shop_id uuid, p_id uuid, p_name text, p_location_id uuid,
                                                          p_shelf text default null, p_blind boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c public.sklad_counts%rowtype;
  v_loc uuid;
begin
  perform public.sklad_member(p_shop_id);
  perform public.sklad_setup(p_shop_id);
  if p_id is null then raise exception 'id' using errcode = '22023'; end if;
  select * into v_c from public.sklad_counts where id = p_id;
  if found then
    if v_c.shop_id <> p_shop_id then raise exception 'id' using errcode = '22023'; end if;
    return jsonb_build_object('id', v_c.id, 'number', v_c.number, 'duplicate', true);
  end if;
  v_loc := coalesce(p_location_id, public.sklad_default_location(p_shop_id, false));
  if not exists (select 1 from public.sklad_locations l where l.id = v_loc and l.shop_id = p_shop_id) then
    raise exception 'location' using errcode = '22023';
  end if;
  if char_length(coalesce(p_name, '')) > 80 then raise exception 'name' using errcode = '22023'; end if;
  if char_length(coalesce(p_shelf, '')) > 80 then raise exception 'shelf' using errcode = '22023'; end if;
  if (select count(*) from public.sklad_counts c where c.shop_id = p_shop_id and c.status = 'open') >= 5 then
    raise exception 'too_many' using errcode = 'P0001';
  end if;
  insert into public.sklad_counts (id, shop_id, number, name, location_id, shelf, blind, started_by)
  values (p_id, p_shop_id, public.sklad_next_count_no(p_shop_id), nullif(btrim(coalesce(p_name, '')), ''), v_loc,
          nullif(btrim(coalesce(p_shelf, '')), ''), coalesce(p_blind, true), auth.uid())
  returning * into v_c;
  return jsonb_build_object('id', v_c.id, 'number', v_c.number, 'duplicate', false);
end;
$$;
revoke execute on function public.owner_sklad_count_start(uuid, uuid, text, uuid, text, boolean) from public, anon;
grant execute on function public.owner_sklad_count_start(uuid, uuid, text, uuid, text, boolean) to authenticated;

/**
 * A phone's count of one product: p_qty = the total it counted now (≥ 0; the + / − and "Zadať počet naraz" all send the
 * total), under the phone's name. p_only_mine = "Platí môj počet": the other phones' counts of it become 0. Returns
 * the product's counts of every phone (never the expected quantity of a blind count).
 */
create or replace function public.owner_sklad_count_set(p_shop_id uuid, p_count_id uuid, p_item_id uuid, p_counter text,
                                                        p_qty numeric, p_only_mine boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c public.sklad_counts%rowtype;
  v_counter text := left(btrim(coalesce(p_counter, '')), 60);
begin
  perform public.sklad_member(p_shop_id);
  select * into v_c from public.sklad_counts where id = p_count_id and shop_id = p_shop_id;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_c.status <> 'open' then raise exception 'closed' using errcode = '55000'; end if;
  if v_counter = '' then raise exception 'counter' using errcode = '22023'; end if;
  if p_qty is null or p_qty < 0 or p_qty > 1000000000 or p_qty <> round(p_qty, 3) then raise exception 'qty' using errcode = '22023'; end if;
  if not exists (select 1 from public.sklad_items i where i.shop_item_id = p_item_id and i.shop_id = p_shop_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  insert into public.sklad_count_lines (count_id, shop_item_id, counter, qty, counted_at, counted_by)
  values (p_count_id, p_item_id, v_counter, p_qty, now(), auth.uid())
  on conflict (count_id, shop_item_id, counter) do update set qty = excluded.qty, counted_at = now(), counted_by = auth.uid();
  if coalesce(p_only_mine, false) then
    update public.sklad_count_lines set qty = 0, counted_at = now()
    where count_id = p_count_id and shop_item_id = p_item_id and counter <> v_counter and qty <> 0;
  end if;
  return public.owner_sklad_count_item(p_shop_id, p_count_id, p_item_id);
end;
$$;
revoke execute on function public.owner_sklad_count_set(uuid, uuid, uuid, text, numeric, boolean) from public, anon;
grant execute on function public.owner_sklad_count_set(uuid, uuid, uuid, text, numeric, boolean) to authenticated;

/** One product of a count: every phone's count (+ the expected quantity only when the count is not blind). */
create or replace function public.owner_sklad_count_item(p_shop_id uuid, p_count_id uuid, p_item_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_c public.sklad_counts%rowtype;
begin
  perform public.sklad_member(p_shop_id);
  select * into v_c from public.sklad_counts where id = p_count_id and shop_id = p_shop_id;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'item_id', p_item_id,
    'name', (select si.name from public.shop_items si where si.id = p_item_id),
    'code', (select si.source_code from public.shop_items si where si.id = p_item_id),
    'total', coalesce((select sum(l.qty) from public.sklad_count_lines l where l.count_id = p_count_id and l.shop_item_id = p_item_id), 0),
    'counters', coalesce((select jsonb_agg(jsonb_build_object('counter', l.counter, 'qty', l.qty, 'at', l.counted_at) order by l.counted_at)
                          from public.sklad_count_lines l where l.count_id = p_count_id and l.shop_item_id = p_item_id), '[]'::jsonb),
    'expected', case when v_c.blind then null else public.sklad_stock_at(p_item_id, v_c.location_id, now()) end);
end;
$$;
revoke execute on function public.owner_sklad_count_item(uuid, uuid, uuid) from public, anon;
grant execute on function public.owner_sklad_count_item(uuid, uuid, uuid) to authenticated;

/**
 * The counting screen: the count, how many of its products are counted, this phone's last counts, the products not
 * counted yet (names only). Never the expected quantities of a blind count.
 */
create or replace function public.owner_sklad_count(p_shop_id uuid, p_count_id uuid, p_counter text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_c public.sklad_counts%rowtype;
begin
  perform public.sklad_member(p_shop_id);
  select * into v_c from public.sklad_counts where id = p_count_id and shop_id = p_shop_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'id', v_c.id, 'number', v_c.number, 'name', v_c.name, 'status', v_c.status, 'blind', v_c.blind, 'shelf', v_c.shelf,
    'location_id', v_c.location_id,
    'location', (select l.name from public.sklad_locations l where l.id = v_c.location_id),
    'started_at', v_c.started_at, 'approved_at', v_c.approved_at, 'result', v_c.result, 'zeroed', v_c.zeroed,
    'in_scope', (select count(*) from public.sklad_count_scope(v_c)),
    'counted', (select count(distinct l.shop_item_id) from public.sklad_count_lines l where l.count_id = v_c.id),
    'counters', coalesce((select jsonb_agg(x order by x.last desc) from (
                  select l.counter, count(distinct l.shop_item_id) as products, max(l.counted_at) as last
                  from public.sklad_count_lines l where l.count_id = v_c.id group by l.counter) x), '[]'::jsonb),
    'mine', coalesce((select jsonb_agg(x order by x.counted_at desc) from (
               select l.shop_item_id as item_id, si.name, si.source_code as code, l.qty, l.counted_at
               from public.sklad_count_lines l join public.shop_items si on si.id = l.shop_item_id
               where l.count_id = v_c.id and l.counter = left(btrim(coalesce(p_counter, '')), 60)
               order by l.counted_at desc limit 20) x), '[]'::jsonb),
    'uncounted', coalesce((select jsonb_agg(x order by lower(x.name)) from (
                    select si.id as item_id, si.name, si.source_code as code
                    from public.sklad_count_scope(v_c) sc join public.shop_items si on si.id = sc.shop_item_id
                    where not exists (select 1 from public.sklad_count_lines l where l.count_id = v_c.id and l.shop_item_id = sc.shop_item_id)
                    order by lower(si.name) limit 200) x), '[]'::jsonb),
    'can_undo', v_c.status = 'approved' and v_c.approved_at > now() - interval '24 hours');
end;
$$;
revoke execute on function public.owner_sklad_count(uuid, uuid, text) from public, anon;
grant execute on function public.owner_sklad_count(uuid, uuid, text) to authenticated;

/**
 * "Rozdiely inventúry" (the owner's screen, never a blind phone's): per counted product the expected quantity at the
 * time it was counted, the counted total, the difference and its value (average purchase price); who counted; the
 * products not counted; the "Prepočítať" marks. Biggest values first.
 */
create or replace function public.owner_sklad_count_diff(p_shop_id uuid, p_count_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_c public.sklad_counts%rowtype;
  v_rows jsonb;
begin
  perform public.sklad_member(p_shop_id);
  select * into v_c from public.sklad_counts where id = p_count_id and shop_id = p_shop_id;
  if not found then return null; end if;
  with per as (
    select l.shop_item_id, sum(l.qty) as counted, max(l.counted_at) as at,
           string_agg(l.counter, ' + ' order by l.counted_at) filter (where l.qty > 0) as who
    from public.sklad_count_lines l where l.count_id = v_c.id group by l.shop_item_id
  ), calc as (
    select p.shop_item_id, si.name, si.source_code as code, i.unit, p.counted, p.at, p.who,
           public.sklad_stock_at(p.shop_item_id, v_c.location_id, p.at) as expected, i.avg_cost,
           coalesce((select m.recount from public.sklad_count_marks m where m.count_id = v_c.id and m.shop_item_id = p.shop_item_id), false) as recount
    from per p join public.sklad_items i on i.shop_item_id = p.shop_item_id join public.shop_items si on si.id = p.shop_item_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'item_id', c.shop_item_id, 'name', c.name, 'code', c.code, 'unit', c.unit, 'counted', c.counted,
           'expected', c.expected, 'diff', c.counted - c.expected, 'at', c.at, 'who', c.who, 'recount', c.recount,
           'value', case when c.avg_cost is null then null else round((c.counted - c.expected) * c.avg_cost, 2) end)
         order by abs((c.counted - c.expected) * coalesce(c.avg_cost, 1)) desc, lower(c.name)), '[]'::jsonb)
  into v_rows
  from calc c;
  return jsonb_build_object(
    'count', public.owner_sklad_count(p_shop_id, p_count_id, null) - 'mine',
    'rows', v_rows,
    'with_diff', (select count(*) from jsonb_array_elements(v_rows) r where (r ->> 'diff')::numeric <> 0),
    'value', (select coalesce(sum((r ->> 'value')::numeric), 0) from jsonb_array_elements(v_rows) r
              where (r ->> 'diff')::numeric <> 0 and not (r ->> 'recount')::boolean),
    'sales_during', (select count(distinct coalesce(m.sale_id, m.id)) from public.sklad_movements m
                     where m.shop_id = v_c.shop_id and m.kind = 'sale' and m.created_at > v_c.started_at
                       and m.location_id = v_c.location_id),
    'zero_allowed', v_c.shelf is null);
end;
$$;
revoke execute on function public.owner_sklad_count_diff(uuid, uuid) from public, anon;
grant execute on function public.owner_sklad_count_diff(uuid, uuid) to authenticated;

/** "Prepočítať" / "Prijať napočítané": a product left out of the approval (to count again) or back in. */
create or replace function public.owner_sklad_count_mark(p_shop_id uuid, p_count_id uuid, p_item_id uuid, p_recount boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.sklad_member(p_shop_id);
  if not exists (select 1 from public.sklad_counts c where c.id = p_count_id and c.shop_id = p_shop_id and c.status = 'open') then
    raise exception 'closed' using errcode = '55000';
  end if;
  if not exists (select 1 from public.sklad_items i where i.shop_item_id = p_item_id and i.shop_id = p_shop_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  insert into public.sklad_count_marks (count_id, shop_item_id, recount) values (p_count_id, p_item_id, coalesce(p_recount, true))
  on conflict (count_id, shop_item_id) do update set recount = excluded.recount;
end;
$$;
revoke execute on function public.owner_sklad_count_mark(uuid, uuid, uuid, boolean) from public, anon;
grant execute on function public.owner_sklad_count_mark(uuid, uuid, uuid, boolean) to authenticated;

/**
 * "Schváliť inventúru": per counted product not marked "Prepočítať" one Inventúra movement so the stock = counted +
 * what happened since it was counted (owner_sklad_move kind count; id from the count + product: never twice);
 * p_zero_uncounted (a whole location only): the products never counted with stock there → 0. One transaction.
 */
create or replace function public.owner_sklad_count_approve(p_shop_id uuid, p_count_id uuid, p_zero_uncounted boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c public.sklad_counts%rowtype;
  v_r record;
  v_now numeric;
  v_target numeric;
  v_fixes integer := 0;
  v_value numeric := 0;
  v_pieces numeric := 0;
begin
  perform public.sklad_member(p_shop_id);
  select * into v_c from public.sklad_counts where id = p_count_id and shop_id = p_shop_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_c.status = 'approved' then return v_c.result || jsonb_build_object('duplicate', true); end if;
  if v_c.status <> 'open' then raise exception 'closed' using errcode = '55000'; end if;
  if coalesce(p_zero_uncounted, false) and v_c.shelf is not null then raise exception 'zero_shelf' using errcode = '22023'; end if;

  for v_r in
    select l.shop_item_id, sum(l.qty) as counted, max(l.counted_at) as at
    from public.sklad_count_lines l
    where l.count_id = v_c.id
      and not exists (select 1 from public.sklad_count_marks m where m.count_id = v_c.id and m.shop_item_id = l.shop_item_id and m.recount)
    group by l.shop_item_id
  loop
    perform pg_advisory_xact_lock(hashtextextended('sklad:' || v_r.shop_item_id::text, 0));
    v_now := coalesce((select sum(s.qty) from public.sklad_stock s where s.shop_item_id = v_r.shop_item_id and s.location_id = v_c.location_id), 0);
    v_target := v_r.counted + (v_now - public.sklad_stock_at(v_r.shop_item_id, v_c.location_id, v_r.at));
    if v_target < 0 then v_target := 0; end if;
    if v_target <> v_now then
      perform public.owner_sklad_move(p_shop_id, md5(v_c.id::text || ':' || v_r.shop_item_id::text)::uuid, v_r.shop_item_id,
                                      'count', v_target, v_c.location_id, null, null, null, v_c.number, null, null);
      v_fixes := v_fixes + 1;
      v_pieces := v_pieces + (v_target - v_now);
      v_value := v_value + coalesce((select round((v_target - v_now) * i.avg_cost, 2) from public.sklad_items i where i.shop_item_id = v_r.shop_item_id), 0);
    end if;
  end loop;

  if coalesce(p_zero_uncounted, false) then
    for v_r in
      select s.shop_item_id, s.qty from public.sklad_stock s
      join public.sklad_items i on i.shop_item_id = s.shop_item_id
      where i.shop_id = p_shop_id and s.location_id = v_c.location_id and s.qty <> 0
        and not exists (select 1 from public.sklad_count_lines l where l.count_id = v_c.id and l.shop_item_id = s.shop_item_id)
    loop
      perform public.owner_sklad_move(p_shop_id, md5(v_c.id::text || ':' || v_r.shop_item_id::text)::uuid, v_r.shop_item_id,
                                      'count', 0, v_c.location_id, null, null, null, v_c.number, null, null);
      v_fixes := v_fixes + 1;
      v_pieces := v_pieces - v_r.qty;
      v_value := v_value + coalesce((select round(-v_r.qty * i.avg_cost, 2) from public.sklad_items i where i.shop_item_id = v_r.shop_item_id), 0);
    end loop;
  end if;

  update public.sklad_counts
  set status = 'approved', zeroed = coalesce(p_zero_uncounted, false), approved_at = now(), approved_by = auth.uid(), closed_at = now(),
      result = jsonb_build_object('fixes', v_fixes, 'pieces', v_pieces, 'value', v_value,
                                  'counted', (select count(distinct l.shop_item_id) from public.sklad_count_lines l where l.count_id = v_c.id))
  where id = v_c.id
  returning * into v_c;
  return v_c.result || jsonb_build_object('duplicate', false);
end;
$$;
revoke execute on function public.owner_sklad_count_approve(uuid, uuid, boolean) from public, anon;
grant execute on function public.owner_sklad_count_approve(uuid, uuid, boolean) to authenticated;

/** "Vrátiť inventúru späť (do 24 h)": an Oprava with the opposite quantity of each of its Inventúra movements. */
create or replace function public.owner_sklad_count_undo(p_shop_id uuid, p_count_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c public.sklad_counts%rowtype;
  v_m record;
begin
  perform public.sklad_member(p_shop_id);
  select * into v_c from public.sklad_counts where id = p_count_id and shop_id = p_shop_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_c.status = 'undone' then return; end if;
  if v_c.status <> 'approved' or v_c.approved_at < now() - interval '24 hours' then raise exception 'too_late' using errcode = '55000'; end if;
  for v_m in
    select m.shop_item_id, m.qty, m.location_id from public.sklad_movements m
    where m.shop_id = p_shop_id and m.kind = 'count' and m.ref = v_c.number
      and m.id = md5(v_c.id::text || ':' || m.shop_item_id::text)::uuid
  loop
    perform public.owner_sklad_move(p_shop_id, md5('undo:' || v_c.id::text || ':' || v_m.shop_item_id::text)::uuid, v_m.shop_item_id,
                                    'correction', -v_m.qty, v_m.location_id, null, null, 'Vrátenie inventúry ' || v_c.number,
                                    v_c.number, null, null);
  end loop;
  update public.sklad_counts set status = 'undone', closed_at = now() where id = v_c.id;
end;
$$;
revoke execute on function public.owner_sklad_count_undo(uuid, uuid) from public, anon;
grant execute on function public.owner_sklad_count_undo(uuid, uuid) to authenticated;

/** "Zrušiť inventúru": an open count is closed without any change of the stock (its counts stay as a record). */
create or replace function public.owner_sklad_count_cancel(p_shop_id uuid, p_count_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.sklad_member(p_shop_id);
  update public.sklad_counts set status = 'cancelled', closed_at = now()
  where id = p_count_id and shop_id = p_shop_id and status = 'open';
end;
$$;
revoke execute on function public.owner_sklad_count_cancel(uuid, uuid) from public, anon;
grant execute on function public.owner_sklad_count_cancel(uuid, uuid) to authenticated;

/** "Inventúra": the open counts and the history; the shelves of each location (for "Jeden regál"). */
create or replace function public.owner_sklad_counts(p_shop_id uuid, p_limit integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.sklad_member(p_shop_id);
  return jsonb_build_object(
    'rows', coalesce((select jsonb_agg(x order by x.ord, x.started_at desc) from (
               select c.id, c.number, c.name, c.status, c.shelf, c.blind, c.started_at, c.approved_at, c.result,
                      (select l.name from public.sklad_locations l where l.id = c.location_id) as location,
                      (select count(distinct cl.shop_item_id) from public.sklad_count_lines cl where cl.count_id = c.id) as counted,
                      case c.status when 'open' then 0 else 1 end as ord
               from public.sklad_counts c where c.shop_id = p_shop_id
               order by case c.status when 'open' then 0 else 1 end, c.started_at desc
               limit least(greatest(coalesce(p_limit, 30), 1), 200)) x), '[]'::jsonb),
    'shelves', coalesce((select jsonb_agg(distinct btrim(i.shelf)) from public.sklad_items i
                         where i.shop_id = p_shop_id and nullif(btrim(coalesce(i.shelf, '')), '') is not null), '[]'::jsonb));
end;
$$;
revoke execute on function public.owner_sklad_counts(uuid, integer) from public, anon;
grant execute on function public.owner_sklad_counts(uuid, integer) to authenticated;
