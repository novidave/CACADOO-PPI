-- =====================================================================================================================
-- Update 68 — "Sklad v Cacaduu", phase B: Predaj (Prompt 14, 2026-11-02, at the owner's request)
--
-- The Predaj tab (phone, tablet, computer): a basket filled by the scanner, the camera, a search or a tap, then one
-- "Potvrdiť predaj". A sale is ONE record (sklad_sales) and one Výdaj movement per line (kind 'sale', sale_id = the
-- sale), written in one transaction with sklad_apply(), so the shop page shows the new stock at once.
--   * Every sale carries the client's own UUID (made when the basket was opened): a double tap or a retry is never
--     counted twice (the answer says duplicate).
--   * Prices are the products' sale prices at that moment (with VAT, EUR), kept in the sale's lines as sold; a product
--     without a sale price cannot be sold here ("no_price").
--   * Payment: Hotovosť / Karta = done at once (the receipt itself comes from the shop's eKasa; Cacaduu only takes the
--     goods off the stock). QR platba = a PAY by square code (IBAN, amount, variable symbol, message) for the customer's
--     bank app; the sale waits ("pending", nothing taken off yet) until the owner confirms "Zaplatené" — on the Predaj
--     screen or on the QR terminal (a spare phone on the counter) — or cancels it. Cacaduu never sees the bank: no
--     payment is ever confirmed by itself. A pending sale older than 24 h is cancelled.
--   * The variable symbol: YYMMDD of the shop's day + a 4-digit number of that day (2611020013).
--   * The shop's IBAN / BIC / payee name (sklad_settings) only through owner_sklad_save_payment() (IBAN checked with
--     mod 97); without an IBAN "QR platba" is refused ("no_iban").
-- No new grants: the tables stay service-role only; owners act through the owner_sklad_* functions (members). Needs
-- update 67. Safe to run twice.
-- =====================================================================================================================

-- ------------------------------------------------------------------ 1. the payment details and the day's numbers

alter table public.sklad_settings add column if not exists iban text;
alter table public.sklad_settings add column if not exists bic text;
alter table public.sklad_settings add column if not exists payee text;
alter table public.sklad_settings add column if not exists vs_day date;
alter table public.sklad_settings add column if not exists vs_seq integer not null default 0;

alter table public.sklad_settings drop constraint if exists sklad_settings_iban_check;
alter table public.sklad_settings add constraint sklad_settings_iban_check
  check (iban is null or iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$');
alter table public.sklad_settings drop constraint if exists sklad_settings_bic_check;
alter table public.sklad_settings add constraint sklad_settings_bic_check
  check (bic is null or bic ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$');
alter table public.sklad_settings drop constraint if exists sklad_settings_payee_check;
alter table public.sklad_settings add constraint sklad_settings_payee_check
  check (payee is null or char_length(payee) between 1 and 70);

-- ------------------------------------------------------------------ 2. sales

create table if not exists public.sklad_sales (
  id            uuid primary key,
  shop_id       uuid not null references public.shops (id) on delete cascade,
  status        text not null check (status in ('pending', 'done', 'cancelled')),
  payment       text not null check (payment in ('cash', 'card', 'qr')),
  location_id   uuid not null references public.sklad_locations (id),
  -- as sold: [{item_id, name, code, qty, price, total}] (price with VAT, EUR)
  lines         jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 200),
  total         numeric not null check (total between 0 and 100000000),
  pieces        numeric not null check (pieces > 0),
  vs            text not null check (vs ~ '^[0-9]{10}$'),
  device_label  text check (device_label is null or char_length(device_label) <= 60),
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  paid_at       timestamptz,
  paid_by       uuid references auth.users (id) on delete set null,
  cancelled_at  timestamptz,
  cancelled_by  uuid references auth.users (id) on delete set null,
  check ((status = 'done') = (paid_at is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
create index if not exists sklad_sales_shop_idx on public.sklad_sales (shop_id, created_at desc);
create index if not exists sklad_sales_pending_idx on public.sklad_sales (shop_id, created_at desc) where status = 'pending';

alter table public.sklad_sales enable row level security;
revoke all on public.sklad_sales from public, anon, authenticated;
grant all on public.sklad_sales to service_role;

-- a sale's Výdaj movements know their sale (no foreign key: movements are append-only and never updated)
alter table public.sklad_movements add column if not exists sale_id uuid;
create index if not exists sklad_movements_sale_idx on public.sklad_movements (sale_id) where sale_id is not null;

-- ------------------------------------------------------------------ 3. helpers

/** IBAN as written → the clean IBAN (no spaces, upper case) when its check digits are right (mod 97 = 1), else NULL. */
create or replace function public.sklad_iban(p_value text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := upper(regexp_replace(coalesce(p_value, ''), '[\s-]', '', 'g'));
  v_moved text;
  v_digits text := '';
  v_rest integer := 0;
  ch text;
begin
  if v !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' then return null; end if;
  v_moved := substr(v, 5) || substr(v, 1, 4);
  foreach ch in array regexp_split_to_array(v_moved, '') loop
    v_digits := v_digits || case when ch ~ '[A-Z]' then (ascii(ch) - 55)::text else ch end;
  end loop;
  while length(v_digits) > 0 loop
    v_rest := ((v_rest::text || left(v_digits, 7))::bigint % 97)::integer;
    v_digits := substr(v_digits, 8);
  end loop;
  return case when v_rest = 1 then v end;
end;
$$;
revoke execute on function public.sklad_iban(text) from public, anon, authenticated;
grant execute on function public.sklad_iban(text) to service_role;

/** The next variable symbol of the shop's day: YYMMDD + 4 digits (the settings row is locked meanwhile). */
create or replace function public.sklad_next_vs(p_shop_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_tz text := coalesce((select timezone from public.shops where id = p_shop_id), 'UTC');
  v_day date := (now() at time zone v_tz)::date;
  v_seq integer;
begin
  perform public.sklad_setup(p_shop_id);
  update public.sklad_settings
  set vs_seq = case when vs_day = v_day then vs_seq + 1 else 1 end, vs_day = v_day
  where shop_id = p_shop_id
  returning vs_seq into v_seq;
  if v_seq > 9999 then raise exception 'too_many' using errcode = 'P0001'; end if;
  return to_char(v_day, 'YYMMDD') || lpad(v_seq::text, 4, '0');
end;
$$;
revoke execute on function public.sklad_next_vs(uuid) from public, anon, authenticated;

/** Pending QR sales older than 24 hours are cancelled (nothing was taken off the stock). */
create or replace function public.sklad_sales_tidy(p_shop_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.sklad_sales set status = 'cancelled', cancelled_at = now()
  where shop_id = p_shop_id and status = 'pending' and created_at < now() - interval '24 hours'
$$;
revoke execute on function public.sklad_sales_tidy(uuid) from public, anon, authenticated;

/** Takes a sale's lines off the stock: one Výdaj movement per line at the sale's location, then the public side. */
create or replace function public.sklad_sale_book(p_sale public.sklad_sales)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  select array_agg(distinct (l ->> 'item_id')::uuid order by (l ->> 'item_id')::uuid) into v_ids
  from jsonb_array_elements(p_sale.lines) l;
  -- the same per-product lock as owner_sklad_move (in one order, so two sales never wait on each other)
  perform pg_advisory_xact_lock(hashtextextended('sklad:' || x::text, 0)) from unnest(v_ids) x order by x;
  insert into public.sklad_movements (id, shop_id, shop_item_id, location_id, kind, qty, reason, ref, device_label,
                                      created_by, client_at, sale_id)
  select gen_random_uuid(), p_sale.shop_id, (l ->> 'item_id')::uuid, p_sale.location_id, 'sale', -((l ->> 'qty')::numeric),
         null, left('Predaj ' || p_sale.vs, 80), p_sale.device_label, auth.uid(), p_sale.created_at, p_sale.id
  from jsonb_array_elements(p_sale.lines) l
  where exists (select 1 from public.sklad_items i where i.shop_item_id = (l ->> 'item_id')::uuid and i.shop_id = p_sale.shop_id);
  perform public.sklad_apply(p_sale.shop_id, v_ids);
end;
$$;
revoke execute on function public.sklad_sale_book(public.sklad_sales) from public, anon, authenticated;

/** A sale as the owner's screens show it (the QR page and the terminal get the payee and the IBAN too). */
create or replace function public.sklad_sale_json(p_sale public.sklad_sales)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_sale.id, 'status', p_sale.status, 'payment', p_sale.payment, 'lines', p_sale.lines,
    'total', p_sale.total, 'pieces', p_sale.pieces, 'vs', p_sale.vs, 'created_at', p_sale.created_at,
    'paid_at', p_sale.paid_at, 'cancelled_at', p_sale.cancelled_at,
    'location', (select l.name from public.sklad_locations l where l.id = p_sale.location_id),
    'paid_by', (select coalesce(nullif(split_part(coalesce(u.raw_user_meta_data ->> 'name', ''), ' ', 1), ''), split_part(u.email, '@', 1))
                from auth.users u where u.id = p_sale.paid_by),
    'shop_name', sh.name, 'timezone', coalesce(sh.timezone, 'UTC'),
    'payee', coalesce(st.payee, left(sh.name, 70)), 'iban', st.iban, 'bic', st.bic)
  from public.shops sh
  left join public.sklad_settings st on st.shop_id = sh.id
  where sh.id = p_sale.shop_id
$$;
revoke execute on function public.sklad_sale_json(public.sklad_sales) from public, anon, authenticated;

-- ------------------------------------------------------------------ 4. the owner's side

/** "Platba QR" in Nastavenia: the IBAN (checked), the BIC (optional) and the payee's name (empty = the shop's name). */
create or replace function public.owner_sklad_save_payment(p_shop_id uuid, p_iban text, p_bic text, p_payee text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_iban text := nullif(btrim(coalesce(p_iban, '')), '');
  v_bic text := nullif(upper(regexp_replace(coalesce(p_bic, ''), '\s', '', 'g')), '');
  v_payee text := nullif(btrim(regexp_replace(coalesce(p_payee, ''), '[\r\n\t]+', ' ', 'g')), '');
begin
  perform public.sklad_member(p_shop_id);
  perform public.sklad_setup(p_shop_id);
  if v_iban is not null then
    v_iban := public.sklad_iban(v_iban);
    if v_iban is null then raise exception 'iban' using errcode = '22023'; end if;
  end if;
  if v_bic is not null and v_bic !~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$' then raise exception 'bic' using errcode = '22023'; end if;
  if v_payee is not null and char_length(v_payee) > 70 then raise exception 'payee' using errcode = '22023'; end if;
  update public.sklad_settings set iban = v_iban, bic = v_bic, payee = v_payee, updated_at = now() where shop_id = p_shop_id;
  insert into public.shop_activity (shop_id, action, details)
  values (p_shop_id, 'sklad_settings_saved', jsonb_build_object('payment', v_iban is not null));
end;
$$;
revoke execute on function public.owner_sklad_save_payment(uuid, text, text, text) from public, anon;
grant execute on function public.owner_sklad_save_payment(uuid, text, text, text) to authenticated;

/** What the Predaj screen needs besides the products: the sale location, whether QR works, the last sales of today. */
create or replace function public.owner_sklad_sale_info(p_shop_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_day_start timestamptz;
begin
  perform public.sklad_member(p_shop_id);
  perform public.sklad_setup(p_shop_id);
  perform public.sklad_sales_tidy(p_shop_id);
  select coalesce(timezone, 'UTC') into v_tz from public.shops where id = p_shop_id;
  v_day_start := ((now() at time zone v_tz)::date)::timestamp at time zone v_tz;
  return jsonb_build_object(
    'location', (select jsonb_build_object('id', l.id, 'name', l.name) from public.sklad_locations l
                 where l.id = public.sklad_default_location(p_shop_id, false)),
    'qr_ready', exists (select 1 from public.sklad_settings s where s.shop_id = p_shop_id and s.iban is not null),
    'timezone', v_tz,
    'today', (select jsonb_build_object('sales', count(*), 'total', coalesce(sum(total), 0))
              from public.sklad_sales where shop_id = p_shop_id and status = 'done' and paid_at >= v_day_start),
    'pending', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'total', s.total, 'vs', s.vs, 'created_at', s.created_at)
                                          order by s.created_at desc)
                         from public.sklad_sales s where s.shop_id = p_shop_id and s.status = 'pending'), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(x order by x.created_at desc) from (
                select s.id, s.status, s.payment, s.total, s.pieces, s.vs, s.created_at, s.paid_at
                from public.sklad_sales s where s.shop_id = p_shop_id and s.created_at >= v_day_start
                order by s.created_at desc limit 10) x), '[]'::jsonb));
end;
$$;
revoke execute on function public.owner_sklad_sale_info(uuid) from public, anon;
grant execute on function public.owner_sklad_sale_info(uuid) to authenticated;

/**
 * "Potvrdiť predaj" / "Zobraziť QR": one sale by the client's own id. p_lines = [{item_id, qty}] (the same product
 * twice is added up); p_payment cash | card (taken off at once) | qr (pending until "Zaplatené"). Returns the sale.
 */
create or replace function public.owner_sklad_sell(p_shop_id uuid, p_id uuid, p_lines jsonb, p_payment text,
                                                   p_location_id uuid default null, p_device text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sale public.sklad_sales%rowtype;
  v_loc uuid;
  v_lines jsonb;
  v_n integer;
  v_known integer;
begin
  perform public.sklad_member(p_shop_id);
  if p_id is null then raise exception 'id' using errcode = '22023'; end if;
  select * into v_sale from public.sklad_sales where id = p_id;
  if found then
    if v_sale.shop_id <> p_shop_id then raise exception 'id' using errcode = '22023'; end if;
    return public.sklad_sale_json(v_sale) || jsonb_build_object('duplicate', true);
  end if;
  if p_payment is null or p_payment not in ('cash', 'card', 'qr') then raise exception 'payment' using errcode = '22023'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'empty' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 200 then raise exception 'too_many' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_array_elements(p_lines) l
             where jsonb_typeof(l) <> 'object' or coalesce(l ->> 'item_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                or coalesce(l ->> 'qty', '') !~ '^[0-9]{1,9}(\.[0-9]{1,3})?$' or (l ->> 'qty')::numeric <= 0) then
    raise exception 'qty' using errcode = '22023';
  end if;
  perform public.sklad_setup(p_shop_id);
  perform public.sklad_sales_tidy(p_shop_id);
  v_loc := coalesce(p_location_id, public.sklad_default_location(p_shop_id, false));
  if not exists (select 1 from public.sklad_locations l where l.id = v_loc and l.shop_id = p_shop_id) then
    raise exception 'location' using errcode = '22023';
  end if;
  if p_payment = 'qr' and not exists (select 1 from public.sklad_settings s where s.shop_id = p_shop_id and s.iban is not null) then
    raise exception 'no_iban' using errcode = '55000';
  end if;

  with wanted as (
    select (l ->> 'item_id')::uuid as item_id, sum((l ->> 'qty')::numeric) as qty, min(ord) as ord
    from jsonb_array_elements(p_lines) with ordinality as t(l, ord)
    group by 1
  )
  select count(*), count(i.shop_item_id),
         jsonb_agg(jsonb_build_object('item_id', w.item_id, 'name', si.name, 'code', si.source_code, 'qty', w.qty,
                                      'price', i.sale_price, 'total', round(i.sale_price * w.qty, 2)) order by w.ord)
  into v_n, v_known, v_lines
  from wanted w
  left join public.sklad_items i on i.shop_item_id = w.item_id and i.shop_id = p_shop_id
  left join public.shop_items si on si.id = i.shop_item_id;
  if v_known < v_n then raise exception 'not_found' using errcode = 'P0002'; end if;
  if exists (select 1 from jsonb_array_elements(v_lines) l where l ->> 'price' is null) then
    raise exception 'no_price' using errcode = '55000';
  end if;
  if exists (select 1 from jsonb_array_elements(v_lines) l where (l ->> 'qty')::numeric > 1000000000) then
    raise exception 'qty' using errcode = '22023';
  end if;

  insert into public.sklad_sales (id, shop_id, status, payment, location_id, lines, total, pieces, vs, device_label,
                                  created_by, paid_at, paid_by)
  values (p_id, p_shop_id, case when p_payment = 'qr' then 'pending' else 'done' end, p_payment, v_loc, v_lines,
          (select sum((l ->> 'total')::numeric) from jsonb_array_elements(v_lines) l),
          (select sum((l ->> 'qty')::numeric) from jsonb_array_elements(v_lines) l),
          public.sklad_next_vs(p_shop_id), nullif(left(btrim(coalesce(p_device, '')), 60), ''), auth.uid(),
          case when p_payment = 'qr' then null else now() end, case when p_payment = 'qr' then null else auth.uid() end)
  on conflict (id) do nothing
  returning * into v_sale;
  if not found then
    select * into v_sale from public.sklad_sales where id = p_id;
    return public.sklad_sale_json(v_sale) || jsonb_build_object('duplicate', true);
  end if;
  if v_sale.status = 'done' then
    perform public.sklad_sale_book(v_sale);
  end if;
  return public.sklad_sale_json(v_sale) || jsonb_build_object('duplicate', false);
end;
$$;
revoke execute on function public.owner_sklad_sell(uuid, uuid, jsonb, text, uuid, text) from public, anon;
grant execute on function public.owner_sklad_sell(uuid, uuid, jsonb, text, uuid, text) to authenticated;

/** "Zaplatené – potvrdiť predaj" (Predaj or the QR terminal): a pending QR sale is taken off the stock, once. */
create or replace function public.owner_sklad_sale_paid(p_shop_id uuid, p_sale_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sale public.sklad_sales%rowtype;
begin
  perform public.sklad_member(p_shop_id);
  perform public.sklad_sales_tidy(p_shop_id);
  select * into v_sale from public.sklad_sales where id = p_sale_id and shop_id = p_shop_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_sale.status = 'cancelled' then raise exception 'cancelled' using errcode = '55000'; end if;
  if v_sale.status = 'done' then return public.sklad_sale_json(v_sale) || jsonb_build_object('duplicate', true); end if;
  update public.sklad_sales set status = 'done', paid_at = now(), paid_by = auth.uid()
  where id = p_sale_id returning * into v_sale;
  perform public.sklad_sale_book(v_sale);
  return public.sklad_sale_json(v_sale) || jsonb_build_object('duplicate', false);
end;
$$;
revoke execute on function public.owner_sklad_sale_paid(uuid, uuid) from public, anon;
grant execute on function public.owner_sklad_sale_paid(uuid, uuid) to authenticated;

/** "Zrušiť predaj": only a pending QR sale (nothing was taken off); a finished sale is undone with an Oprava. */
create or replace function public.owner_sklad_sale_cancel(p_shop_id uuid, p_sale_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sale public.sklad_sales%rowtype;
begin
  perform public.sklad_member(p_shop_id);
  select * into v_sale from public.sklad_sales where id = p_sale_id and shop_id = p_shop_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_sale.status = 'done' then raise exception 'done' using errcode = '55000'; end if;
  if v_sale.status = 'pending' then
    update public.sklad_sales set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
    where id = p_sale_id returning * into v_sale;
  end if;
  return public.sklad_sale_json(v_sale);
end;
$$;
revoke execute on function public.owner_sklad_sale_cancel(uuid, uuid) from public, anon;
grant execute on function public.owner_sklad_sale_cancel(uuid, uuid) to authenticated;

/** One sale (the QR page). */
create or replace function public.owner_sklad_sale(p_shop_id uuid, p_sale_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sale public.sklad_sales%rowtype;
begin
  perform public.sklad_member(p_shop_id);
  perform public.sklad_sales_tidy(p_shop_id);
  select * into v_sale from public.sklad_sales where id = p_sale_id and shop_id = p_shop_id;
  if not found then return null; end if;
  return public.sklad_sale_json(v_sale);
end;
$$;
revoke execute on function public.owner_sklad_sale(uuid, uuid) from public, anon;
grant execute on function public.owner_sklad_sale(uuid, uuid) to authenticated;

/**
 * The QR terminal (a spare phone on the counter, logged in as an owner): the newest pending QR sale, else the sale
 * paid in the last 2 minutes (the green "Zaplatené"), else nothing (standby).
 */
create or replace function public.owner_sklad_terminal(p_shop_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sale public.sklad_sales%rowtype;
begin
  perform public.sklad_member(p_shop_id);
  perform public.sklad_sales_tidy(p_shop_id);
  select * into v_sale from public.sklad_sales
  where shop_id = p_shop_id and status = 'pending' order by created_at desc limit 1;
  if not found then
    select * into v_sale from public.sklad_sales
    where shop_id = p_shop_id and status = 'done' and payment = 'qr' and paid_at > now() - interval '2 minutes'
    order by paid_at desc limit 1;
  end if;
  if not found then
    return jsonb_build_object('state', 'standby', 'shop_name', (select name from public.shops where id = p_shop_id));
  end if;
  return public.sklad_sale_json(v_sale) || jsonb_build_object('state', case when v_sale.status = 'pending' then 'waiting' else 'paid' end);
end;
$$;
revoke execute on function public.owner_sklad_terminal(uuid) from public, anon;
grant execute on function public.owner_sklad_terminal(uuid) to authenticated;

-- ------------------------------------------------------------------ 5. Nastavenia shows the payment details

create or replace function public.owner_sklad_payment(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.sklad_member(p_shop_id);
  return (select jsonb_build_object('iban', st.iban, 'bic', st.bic, 'payee', st.payee, 'shop_name', sh.name)
          from public.shops sh left join public.sklad_settings st on st.shop_id = sh.id where sh.id = p_shop_id);
end;
$$;
revoke execute on function public.owner_sklad_payment(uuid) from public, anon;
grant execute on function public.owner_sklad_payment(uuid) to authenticated;
