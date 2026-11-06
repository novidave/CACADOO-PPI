-- =====================================================================================================================
-- Update 86 — a restaurant's stock (2026-11-06, the owner's OK for this rule change)
--
-- 1. sklad_tracks_stock(item) = not (menu_item and not track_stock) — a size follows its dish. An UNTRACKED dish (a menu
--    item without "Sledovať zásobu") is not stock: no Sklad movement is ever stored for it.
--    * One guard on sklad_movements (sklad_movements_untracked, before insert): a row for an untracked dish is skipped.
--      So a sale (sklad_sale_book: the sale, its lines, VS, prices, totals and payment are stored as before), a food
--      order's finish ("Odpísať zo skladu": food_take_stock, ids md5(order ':' line) as before) and an eKasa line paired
--      with a dish (booked, never "unmatched") write no movement for it; a reopen returns only the movements a finish
--      really stored (so never more than was taken).
--    * Manual movements on an untracked dish (Príjem, Odpis, Inventúra, Oprava, Presun — owner_sklad_move, also inside a
--      Príjemka's confirmation, which then stores nothing: one transaction) and an Inventúra line (owner_sklad_count_set)
--      are refused: untracked_dish. A count's products (sklad_count_scope) leave untracked dishes out.
--    * "Sledovať zásobu" switched ON (a dish or a size): the item starts at 0 — one Oprava "Začiatok sledovania zásoby"
--      per place that held stock (clears an old negative), id md5('track:' item ':' switch time ':' place), once.
--    * Sklad's lists (owner_sklad_products — Produkty, Predaj, Inventúra's lookup —, owner_sklad_product, Prehľad) carry
--      `tracked` and `sold_out_today`; untracked dishes are left out of the stock counts (low / out).
-- 2. A shop of kind food: its stock never goes stale by time — shown as it is until the owner changes it.
--    * freshness_label(file_time, kind): a food shop with a stock time = 'current' at any age; every other shop exactly
--      as freshness_label(file_time). public_stock and public_shops use it (so search_stock, item_search,
--      shop_item_search, shop_stock, the API, the MCP and the assistants: availability from the quantity).
--    * The owner's side answers 'never_expires' for a food shop (freshness_state(shop) → owner_items / owner_item_counts,
--      my_shops, Sklad's Prehľad: no countdown, no "Stav je správny").
--    * The daily "potvrďte stav" reminder (sklad_reminders_due) never picks a food shop.
--    * The kind decides at every read: food → goods = the 24 h rule from that moment; goods → food = shown again at once.
-- 3. Jazyky a inventár → Tovar: an untracked dish's availability = 'in_menu' (neither in stock nor sold out).
-- Every goods shop: unchanged.
--
-- Needs updates 62, 67, 70, 79, 80, 81. Run the whole file once; running it again is harmless.
-- =====================================================================================================================

-- ------------------------------------------------------------------ 1. untracked dishes are not stock

/** Whether Sklad keeps stock of a product: every product, except a menu item (or a size of a dish) without "Sledovať zásobu". */
create or replace function public.sklad_tracks_stock(p_item uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select not (i.menu_item and not coalesce(pp.track_stock, i.track_stock))
                   from public.sklad_items i
                   left join public.sklad_items pp on pp.shop_item_id = i.menu_parent
                   where i.shop_item_id = p_item), true)
$$;
revoke execute on function public.sklad_tracks_stock(uuid) from public, anon, authenticated;
grant execute on function public.sklad_tracks_stock(uuid) to service_role;

/** The one guard: a movement of an untracked dish is never stored (sales, food orders, eKasa — they skip it). */
create or replace function public.sklad_movements_untracked()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.sklad_tracks_stock(new.shop_item_id) then
    return null;
  end if;
  return new;
end;
$$;
drop trigger if exists sklad_movements_untracked on public.sklad_movements;
create trigger sklad_movements_untracked before insert on public.sklad_movements
  for each row execute function public.sklad_movements_untracked();

/**
 * "Sledovať zásobu" switched on: the item starts at 0 — an Oprava per place that held stock (an old negative too), id
 * md5('track:' item ':' switch time ':' place): a second save in the same transaction adds nothing.
 */
create or replace function public.sklad_track_start()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.menu_item and new.track_stock and not coalesce(old.track_stock, false) and public.sklad_tracks_stock(new.shop_item_id) then
    perform pg_advisory_xact_lock(hashtextextended('sklad:' || new.shop_item_id::text, 0));
    insert into public.sklad_movements (id, shop_id, shop_item_id, location_id, kind, qty, reason, ref, created_by, client_at)
    select md5('track:' || new.shop_item_id::text || ':' || now()::text || ':' || s.location_id::text)::uuid,
           new.shop_id, new.shop_item_id, s.location_id, 'correction', -s.qty, 'Začiatok sledovania zásoby', 'Menu',
           auth.uid(), now()
    from public.sklad_stock s
    where s.shop_item_id = new.shop_item_id and s.qty <> 0
    on conflict (id) do nothing;
  end if;
  return null;
end;
$$;
revoke execute on function public.sklad_track_start() from public, anon, authenticated;
drop trigger if exists sklad_track_start on public.sklad_items;
create trigger sklad_track_start after update of track_stock on public.sklad_items
  for each row execute function public.sklad_track_start();

/** As update 67, and an untracked dish is refused (untracked_dish): it has no stock to move. */
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
  -- update 86: an untracked dish is not stock (Príjem, Odpis, Inventúra, Oprava, Presun all refused)
  if not public.sklad_tracks_stock(p_item_id) then raise exception 'untracked_dish' using errcode = '22023'; end if;
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

/** As update 70, without untracked dishes (no expected quantity, nothing to count). */
create or replace function public.sklad_count_scope(p_count public.sklad_counts)
returns table (shop_item_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select i.shop_item_id from public.sklad_items i
  where i.shop_id = p_count.shop_id and public.sklad_tracks_stock(i.shop_item_id)
    and case when p_count.shelf is not null then lower(btrim(coalesce(i.shelf, ''))) = lower(btrim(p_count.shelf))
             else exists (select 1 from public.sklad_stock s where s.shop_item_id = i.shop_item_id
                          and s.location_id = p_count.location_id and s.qty <> 0) end
  union
  select l.shop_item_id from public.sklad_count_lines l where l.count_id = p_count.id and public.sklad_tracks_stock(l.shop_item_id)
$$;
revoke execute on function public.sklad_count_scope(public.sklad_counts) from public, anon, authenticated;

/** As update 70, and an untracked dish cannot be counted (untracked_dish). */
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
  if not public.sklad_tracks_stock(p_item_id) then raise exception 'untracked_dish' using errcode = '22023'; end if;
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

/**
 * As update 67, and per row `tracked` (sklad_tracks_stock) and `sold_out_today` ("Vypredané dnes", itself or its dish);
 * an untracked dish is never low or out (counts.untracked says how many).
 */
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
           public.sklad_tracks_stock(i.shop_item_id) as tracked,
           i.menu_item and (coalesce(i.sold_out_on = public.shop_today(p_shop_id), false)
                            or coalesce((select pp.sold_out_on = public.shop_today(p_shop_id) from public.sklad_items pp
                                         where pp.shop_item_id = i.menu_parent), false)) as sold_out_today,
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
    select b.*, b.tracked and b.total <= 0 as is_out, b.tracked and b.total > 0 and b.total < b.min_qty as is_low,
           b.sale_price is null as no_price from base b
  )
  select jsonb_build_object(
    'counts', jsonb_build_object('all', count(*), 'low', count(*) filter (where is_low or is_out),
                                 'out', count(*) filter (where is_out), 'no_price', count(*) filter (where no_price),
                                 'untracked', count(*) filter (where not tracked)),
    'rows', coalesce((select jsonb_agg(to_jsonb(r) order by lower(r.name)) from (
              select f.id, f.name, f.source_code as code, f.ean, f.sale_price, f.min_qty, f.unit, f.shelf, f.total, f.locations,
                     f.is_out, f.is_low, f.no_price, f.tracked, f.sold_out_today
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

/** As update 67, and `tracked`, `menu_item`, `sold_out_today`, `never_expires` (a food shop's stock never goes stale). */
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
    'tracked', public.sklad_tracks_stock(si.id),
    'menu_item', i.menu_item,
    'sold_out_today', i.menu_item and (coalesce(i.sold_out_on = public.shop_today(p_shop_id), false)
                      or coalesce((select pp.sold_out_on = public.shop_today(p_shop_id) from public.sklad_items pp
                                   where pp.shop_item_id = i.menu_parent), false)),
    'never_expires', (select sh.kind = 'food' from public.shops sh where sh.id = p_shop_id),
    'public', exists (select 1 from public.inventory inv where inv.shop_item_id = si.id),
    'locations', coalesce((select jsonb_agg(jsonb_build_object('location_id', l.id, 'name', l.name, 'note', l.note,
                                                              'qty', coalesce(s.qty, 0), 'sale_default', l.is_sale_default,
                                                              'receipt_default', l.is_receipt_default) order by l.sort, l.created_at)
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

/**
 * As update 67; a food shop: `never_expires`, no countdown (fresh_until null), no "Stav je správny" (needs_check false);
 * untracked dishes are never low or out.
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
  v_food boolean;
begin
  perform public.sklad_member(p_shop_id);
  select coalesce(timezone, 'UTC') into v_tz from public.shops where id = p_shop_id;
  v_today := (now() at time zone v_tz)::date;
  v_day_start := v_today::timestamp at time zone v_tz;
  select max(created_at) into v_last_move from public.sklad_movements where shop_id = p_shop_id;
  select confirmed_at into v_conf from public.sklad_settings where shop_id = p_shop_id;
  select latest_file_time into v_fresh from public.sync_sources where shop_id = p_shop_id;
  v_food := coalesce((select kind = 'food' from public.shops where id = p_shop_id), false);
  return jsonb_build_object(
    'source', public.stock_source_of(p_shop_id),
    'timezone', v_tz,
    'last_movement_at', v_last_move,
    'last_movement_kind', (select kind from public.sklad_movements where shop_id = p_shop_id order by created_at desc limit 1),
    'confirmed_at', v_conf,
    'never_expires', v_food,
    'needs_check', not v_food and public.stock_source_of(p_shop_id) = 'sklad'
                   and coalesce(v_last_move < v_day_start, true) and coalesce(v_conf < v_day_start, true),
    'fresh_until', case when v_fresh is not null and not v_food then v_fresh + interval '24 hours' end,
    'freshness_state', case when v_food then 'never_expires' else public.freshness_label(v_fresh) end,
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
                and public.sklad_tracks_stock(i.shop_item_id)
              order by coalesce(t.qty, 0), lower(si.name) limit 8) x), '[]'::jsonb),
    'low_count', (select count(*) from public.sklad_items i left join public.sklad_stock_total t on t.shop_item_id = i.shop_item_id
                  where i.shop_id = p_shop_id and coalesce(t.qty, 0) > 0 and coalesce(t.qty, 0) < i.min_qty
                    and public.sklad_tracks_stock(i.shop_item_id)),
    'out_count', (select count(*) from public.sklad_items i left join public.sklad_stock_total t on t.shop_item_id = i.shop_item_id
                  where i.shop_id = p_shop_id and coalesce(t.qty, 0) <= 0 and public.sklad_tracks_stock(i.shop_item_id)),
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

/** As update 67, never a food shop (its stock does not go stale, so there is nothing to confirm). */
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
    where sh.id = st.shop_id and sh.is_active and st.reminder_on and sh.kind is distinct from 'food'
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

-- ------------------------------------------------------------------ 2. a food shop's stock never goes stale

/** The freshness of a shop of this kind: a food shop with a stock time = 'current' at any age; any other as before. */
create or replace function public.freshness_label(file_time timestamptz, p_kind text)
returns text
language sql
stable
set search_path = ''
as $$
  select case when p_kind = 'food' and file_time is not null then 'current' else public.freshness_label(file_time) end
$$;
grant execute on function public.freshness_label(timestamptz, text) to anon, authenticated, service_role;

/** The owner's freshness of a shop: a food shop = 'never_expires' (shown until changed); any other as before. */
create or replace function public.freshness_state(p_shop_id uuid)
returns table (state text, age_minutes integer, latest_file_time timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select case when sh.kind = 'food' then 'never_expires' else public.freshness_label(s.latest_file_time) end,
         public.freshness_age_minutes(s.latest_file_time),
         s.latest_file_time
  from (select p_shop_id as shop_id) x
  left join public.sync_sources s on s.shop_id = x.shop_id
  left join public.shops sh on sh.id = x.shop_id
$$;

/** As before (update 42's columns), and a food shop's rows are current at any age. */
create or replace view public.public_stock
with (security_invoker = false)
as
select si.id as item_id,
       si.name as item_name,
       coalesce(si.ean, p.ean) as ean,
       coalesce(si.brand, p.brand) as brand,
       p.category,
       sh.id as shop_id,
       sh.slug as shop_slug,
       sh.name as shop_name,
       sh.address as shop_address,
       sh.city as shop_city,
       sh.location as shop_location,
       extensions.st_y(sh.location::extensions.geometry) as shop_lat,
       extensions.st_x(sh.location::extensions.geometry) as shop_lng,
       inv.price,
       inv.currency,
       case when f.state <> 'stale' then inv.quantity else null::numeric end as quantity,
       public.availability_label(inv.quantity, f.state) as availability,
       coalesce(public.availability_label(inv.quantity, f.state) = 'in_stock_count', false) as is_available,
       f.state as freshness_state,
       f.age_minutes as freshness_age_minutes,
       ss.latest_file_time,
       coalesce(inv.source_updated_at, inv.received_at) as updated_at,
       sh.country as shop_country,
       sh.timezone as shop_timezone,
       si.name_lang as item_name_lang,
       si.name_i18n as item_name_i18n
from public.shop_items si
join public.shops sh on sh.id = si.shop_id and sh.is_active
join public.inventory inv on inv.shop_item_id = si.id
left join public.products p on p.id = si.product_id
left join public.sync_sources ss on ss.shop_id = sh.id
cross join lateral (select public.freshness_label(ss.latest_file_time, sh.kind) as state,
                           public.freshness_age_minutes(ss.latest_file_time) as age_minutes) f;

/** As update 40 (+ update 26's booking link), and a food shop is current at any age. */
create or replace view public.public_shops as
select sh.id,
       sh.slug,
       sh.name,
       sh.address,
       sh.city,
       sh.country,
       sh.timezone,
       sh.phone,
       sh.website,
       sh.logo_url,
       sh.opening_hours,
       extensions.st_y(sh.location::extensions.geometry) as lat,
       extensions.st_x(sh.location::extensions.geometry) as lng,
       public.freshness_label(ss.latest_file_time, sh.kind) as freshness_state,
       public.freshness_age_minutes(ss.latest_file_time) as freshness_age_minutes,
       ss.latest_file_time,
       sh.has_toilet,
       sh.has_douchette,
       sh.has_card_terminal,
       sh.email,
       sh.facebook_url,
       sh.assistant_label,
       sh.assistant_welcome,
       sh.booking_url,
       public.shop_home_lang(sh.id) as site_lang
from public.shops sh
left join public.sync_sources ss on ss.shop_id = sh.id
where sh.is_active;

/** As update 79, and a food shop's freshness = 'never_expires' (no "aktuálny / starší / zastaraný"). */
create or replace function public.my_shops()
returns table (
  id uuid,
  slug text,
  name text,
  ico text,
  address text,
  city text,
  country text,
  timezone text,
  lat double precision,
  lng double precision,
  phone text,
  website text,
  opening_hours jsonb,
  logo_url text,
  is_active boolean,
  has_toilet boolean,
  has_douchette boolean,
  has_card_terminal boolean,
  field_mapping jsonb,
  mapping_status text,
  sample_rows jsonb,
  latest_file_time timestamptz,
  last_error text,
  freshness_state text,
  folder_seen_at timestamptz,
  last_file_name text,
  email text,
  facebook_url text,
  assistant_label text,
  assistant_welcome text,
  file_columns text[],
  booking_url text,
  company_name text,
  dic text,
  zip text,
  contact_buttons jsonb,
  kind text
)
language sql
stable
security definer
set search_path = ''
set jit = off
as $$
  select sh.id, sh.slug, sh.name, sh.ico, sh.address, sh.city, sh.country, sh.timezone,
         extensions.st_y(sh.location::extensions.geometry), extensions.st_x(sh.location::extensions.geometry),
         sh.phone, sh.website, sh.opening_hours, sh.logo_url,
         sh.is_active, sh.has_toilet, sh.has_douchette, sh.has_card_terminal,
         ss.field_mapping, ss.mapping_status, ss.sample_rows, ss.latest_file_time, ss.last_error,
         case when sh.kind = 'food' then 'never_expires' else public.freshness_label(ss.latest_file_time) end, ss.folder_seen_at, ss.last_file_name,
         sh.email, sh.facebook_url, sh.assistant_label, sh.assistant_welcome, ss.file_columns, sh.booking_url,
         co.company_name, co.dic, co.zip, sh.contact_buttons, sh.kind
  from public.shops sh
  join public.shop_members m on m.shop_id = sh.id and m.user_id = auth.uid()
  left join public.sync_sources ss on ss.shop_id = sh.id
  left join public.shop_company co on co.shop_id = sh.id
  order by sh.name
$$;
revoke execute on function public.my_shops() from public, anon;
grant execute on function public.my_shops() to authenticated;

/** As update 62, and an untracked dish's availability = 'in_menu' ("V menu"). */
create or replace function public.owner_item_rows(p_shop_id uuid, p_q text default null, p_lang text default null)
returns table (
  item_id uuid,
  source_code text,
  item_name text,
  ean text,
  price numeric,
  currency text,
  quantity numeric,
  availability text,
  updated_at timestamptz,
  name_lang text,
  name_i18n jsonb,
  name_i18n_by_owner boolean,
  translated_name_source text,
  has_description boolean,
  missing_translation boolean,
  tr_done integer,
  tr_total integer,
  missing_langs text[]
)
language plpgsql
stable
security definer
set search_path = ''
set jit = off
as $$
#variable_conflict use_column
declare
  v_state text;
  v_main text;
  v_all text[];
  v_check text[];
  v_cols text[];
  v_patterns text[] := public.search_patterns(p_q);
begin
  if not (public.is_shop_member(p_shop_id) or public.is_admin()) then
    return;
  end if;
  select f.state into v_state from public.freshness_state(p_shop_id) f;
  v_main := public.shop_main_lang(p_shop_id);
  v_all := public.shop_preferred_langs(p_shop_id);
  -- the "Jazyk" dropdown: "Chýba preklad" for that language only (an unknown or the shop's own language: none)
  v_check := case when p_lang is null then v_all
                  when public.valid_lang(p_lang) and p_lang <> v_main then array[p_lang]
                  else '{}'::text[] end;
  v_cols := v_all || array(select x from unnest(v_check) x where x <> all (v_all));
  return query
    select
      si.id, si.source_code, si.name, si.ean,
      inv.price, coalesce(inv.currency, 'EUR'), inv.quantity,
      case when not public.sklad_tracks_stock(si.id) then 'in_menu' else public.availability_label(inv.quantity, v_state) end,
      coalesce(inv.source_updated_at, inv.received_at, si.updated_at),
      si.name_lang, si.name_i18n, si.name_i18n_by_owner, si.translated_name_source,
      d.text is not null,
      coalesce(t.missing_check, false),
      coalesce(t.done, 0),
      cardinality(v_all),
      coalesce(t.missing, '{}'::text[])
    from public.shop_items si
    left join public.inventory inv on inv.shop_item_id = si.id
    left join lateral public.item_description_shown(si.id) d on true
    left join lateral (
      select count(*) filter (where k.ok and l.lang = any (v_all))::integer as done,
             array_agg(l.lang order by l.ord) filter (where not k.ok and l.lang = any (v_all)) as missing,
             bool_or(not k.ok and l.lang = any (v_check)) as missing_check
      from unnest(v_cols) with ordinality as l(lang, ord)
      cross join lateral (
        select l.lang = coalesce(si.name_lang, v_main)
               or (exists (select 1 from public.content_translations c
                           where c.shop_id = p_shop_id and c.kind = 'item_name' and c.ref = si.id::text and c.lang = l.lang
                             and public.translation_state(c.status, c.source_hash, si.name) <> 'stale')
                   and (d.text is null or exists (
                          select 1 from public.content_translations c
                          where c.shop_id = p_shop_id and c.kind = 'item_description' and c.ref = si.id::text
                            and c.lang = l.lang and public.translation_state(c.status, c.source_hash, d.text) <> 'stale'))) as ok
      ) k
    ) t on true
    where si.shop_id = p_shop_id
      and (
        nullif(trim(coalesce(p_q, '')), '') is null
        or si.source_code = trim(p_q)
        or si.ean = trim(p_q)
        or si.names_search like all (v_patterns)
      );
end;
$$;
revoke execute on function public.owner_item_rows(uuid, text, text) from public, anon, authenticated;

/** As update 62; an untracked dish ("V menu") is neither in stock nor sold out. */
create or replace function public.owner_items(
  p_shop_id uuid,
  q text default null,
  p_limit integer default 50,
  p_offset integer default 0,
  p_filter text default null,
  p_lang text default null
)
returns table (
  item_id uuid,
  source_code text,
  item_name text,
  ean text,
  price numeric,
  currency text,
  quantity numeric,
  availability text,
  updated_at timestamptz,
  total_count bigint,
  name_lang text,
  name_i18n jsonb,
  name_i18n_by_owner boolean,
  translated_name_source text,
  has_description boolean,
  missing_translation boolean,
  tr_done integer,
  tr_total integer,
  missing_langs text[]
)
language plpgsql
stable
security definer
set search_path = ''
set jit = off
as $$
#variable_conflict use_column
declare
  v_filter text := coalesce(nullif(trim(p_filter), ''), 'all');
begin
  if v_filter not in ('all', 'in_stock', 'sold_out', 'no_description', 'missing_translation') then
    raise exception 'Unknown filter %', v_filter using errcode = '22023';
  end if;
  return query
    select r.item_id, r.source_code, r.item_name, r.ean, r.price, r.currency, r.quantity, r.availability, r.updated_at,
           count(*) over (),
           r.name_lang, r.name_i18n, r.name_i18n_by_owner, r.translated_name_source, r.has_description,
           r.missing_translation, r.tr_done, r.tr_total, r.missing_langs
    from public.owner_item_rows(p_shop_id, q, p_lang) r
    where case v_filter
            when 'in_stock' then r.availability is distinct from 'in_menu' and coalesce(r.quantity, 0) > 0
            when 'sold_out' then r.availability is distinct from 'in_menu' and coalesce(r.quantity, 0) <= 0
            when 'no_description' then not r.has_description
            when 'missing_translation' then r.missing_translation
            else true
          end
    order by r.item_name, r.item_id
    limit least(greatest(coalesce(p_limit, 50), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;
revoke execute on function public.owner_items(uuid, text, integer, integer, text, text) from public, anon;
grant execute on function public.owner_items(uuid, text, integer, integer, text, text) to authenticated, service_role;

/** As update 62, with the same rule as owner_items. */
create or replace function public.owner_item_counts(p_shop_id uuid, p_lang text default null)
returns table (all_items bigint, in_stock bigint, sold_out bigint, no_description bigint, missing_translation bigint)
language sql
stable
security definer
set search_path = ''
set jit = off
as $$
  select count(*),
         count(*) filter (where r.availability is distinct from 'in_menu' and coalesce(r.quantity, 0) > 0),
         count(*) filter (where r.availability is distinct from 'in_menu' and coalesce(r.quantity, 0) <= 0),
         count(*) filter (where not r.has_description),
         count(*) filter (where r.missing_translation)
  from public.owner_item_rows(p_shop_id, null, p_lang) r
$$;
revoke execute on function public.owner_item_counts(uuid, text) from public, anon;
grant execute on function public.owner_item_counts(uuid, text) to authenticated, service_role;
