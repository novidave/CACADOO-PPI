-- PPI · 27 · Shop status: open / lunch break / closed / holiday, public holidays and special days. Paste the whole file into the Supabase SQL Editor and Run.
--  Needs update 26. Shop profile content, not stock:
--  - public.public_holidays: the public holidays of SK, HU and CZ for 2026 and 2027 (rows made
--    by scripts/holidays.mjs with the date-holidays library, below). kind 'day_off' = shops may
--    open ("Štátny sviatok – overte otváracie hodiny"); 'shops_closed' = shops must close by law
--    (closed_from: from that time, e.g. 24.12 from 12:00). Rows the admin enters (source 'admin',
--    "Sviatky" on the admin page) always win over the library's and are never overwritten; an
--    admin row of kind 'removed' takes a library date away. Everyone reads; only the service
--    role and the admin_* functions (is_admin) write.
--  - shops.auto_holidays ("Automatické štátne sviatky", on by default): off = holidays are
--    ignored for this shop everywhere. Only owner_set_auto_holidays() changes it.
--  - public.shop_special_hours: the owner's special days (closed all day or other hours, a
--    short note); public read, written only through owner_save_special_hours() /
--    owner_delete_special_hours().
--  - shop_calendar(): for a set of shops and dates, the special days and the holidays that
--    apply to each shop (the website, API and MCP compute the status from it with one function).
-- Safe to run again.

-- ------------------------------------------------------------------ shops.auto_holidays

alter table public.shops add column if not exists auto_holidays boolean not null default true;

/** "Automatické štátne sviatky" is changed only through owner_set_auto_holidays(). */
create or replace function public.guard_shop_auto_holidays()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_client_request() and new.auto_holidays is distinct from old.auto_holidays then
    raise exception 'auto_holidays is changed only through owner_set_auto_holidays()' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_shop_auto_holidays() from public, anon, authenticated;
drop trigger if exists shops_guard_auto_holidays on public.shops;
create trigger shops_guard_auto_holidays before update of auto_holidays on public.shops
  for each row execute function public.guard_shop_auto_holidays();

create or replace function public.owner_set_auto_holidays(p_shop_id uuid, p_on boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  update public.shops set auto_holidays = coalesce(p_on, true) where id = p_shop_id;
  return coalesce(p_on, true);
end;
$$;
revoke execute on function public.owner_set_auto_holidays(uuid, boolean) from public, anon;
grant execute on function public.owner_set_auto_holidays(uuid, boolean) to authenticated;

-- ------------------------------------------------------------------ public holidays

create table if not exists public.public_holidays (
  id          bigint generated always as identity primary key,
  country     text not null,
  date        date not null,
  name_sk     text,
  name_hu     text,
  name_en     text,
  kind        text not null,
  closed_from text,
  source      text not null default 'library',
  updated_at  timestamptz not null default now(),
  constraint public_holidays_one unique (country, date, source),
  constraint public_holidays_country check (country ~ '^[A-Z]{2}$'),
  constraint public_holidays_kind check (kind in ('day_off', 'shops_closed', 'removed')),
  constraint public_holidays_source check (source in ('library', 'admin')),
  constraint public_holidays_removed check (kind <> 'removed' or source = 'admin'),
  constraint public_holidays_closed_from check (
    closed_from is null or (kind = 'shops_closed' and closed_from ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')),
  constraint public_holidays_names check (
    coalesce(length(name_sk), 0) <= 120 and coalesce(length(name_hu), 0) <= 120 and coalesce(length(name_en), 0) <= 120)
);
create index if not exists public_holidays_country_date on public.public_holidays (country, date);

alter table public.public_holidays enable row level security;
drop policy if exists "public_holidays: everyone reads" on public.public_holidays;
create policy "public_holidays: everyone reads" on public.public_holidays
  for select to anon, authenticated using (true);
revoke insert, update, delete on public.public_holidays from anon, authenticated;
grant select on public.public_holidays to anon, authenticated;
grant all on public.public_holidays to service_role;

/** The holidays that count for one country: an admin row wins over the library's; 'removed' = none. */
create or replace function public.holidays_between(p_country text, p_from date, p_to date)
returns table (date date, name_sk text, name_hu text, name_en text, kind text, closed_from text)
language sql
stable
security definer
set search_path = ''
as $$
  select h.date, h.name_sk, h.name_hu, h.name_en, h.kind, h.closed_from
  from (
    select distinct on (p.date) p.*
    from public.public_holidays p
    where p.country = upper(p_country) and p.date between p_from and least(p_to, p_from + 400)
    order by p.date, (p.source = 'admin') desc
  ) h
  where h.kind <> 'removed'
  order by h.date
$$;
revoke execute on function public.holidays_between(text, date, date) from public;
grant execute on function public.holidays_between(text, date, date) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ the owner's special days

/** 1–4 time ranges [["08:00","12:00"],["22:00","02:00"]]; a range that ends earlier runs past midnight. */
create or replace function public.valid_hour_ranges(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_typeof(p) = 'array' and jsonb_array_length(p) between 1 and 4
    and not exists (
      select 1 from jsonb_array_elements(p) r
      where jsonb_typeof(r) <> 'array' or jsonb_array_length(r) <> 2
         or coalesce(r ->> 0, '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         or coalesce(r ->> 1, '') !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'
         or r ->> 0 = r ->> 1), false)
$$;
grant execute on function public.valid_hour_ranges(jsonb) to anon, authenticated, service_role;

create table if not exists public.shop_special_hours (
  shop_id    uuid not null references public.shops(id) on delete cascade,
  date       date not null,
  closed     boolean not null default false,
  ranges     jsonb not null default '[]'::jsonb,
  note       text,
  updated_at timestamptz not null default now(),
  primary key (shop_id, date),
  constraint shop_special_hours_ranges check ((closed and ranges = '[]'::jsonb) or (not closed and public.valid_hour_ranges(ranges))),
  constraint shop_special_hours_note check (note is null or length(note) <= 100)
);

/** Visitors see the special days of active shops; owners also of their inactive ones. */
create or replace function public.shop_visible(p_shop_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.shops s where s.id = p_shop_id and (s.is_active or public.is_shop_member(s.id) or public.is_admin()))
$$;
revoke execute on function public.shop_visible(uuid) from public;
grant execute on function public.shop_visible(uuid) to anon, authenticated, service_role;

alter table public.shop_special_hours enable row level security;
drop policy if exists "shop_special_hours: read with the shop" on public.shop_special_hours;
create policy "shop_special_hours: read with the shop" on public.shop_special_hours
  for select to anon, authenticated using (public.shop_visible(shop_id));
revoke insert, update, delete on public.shop_special_hours from anon, authenticated;
grant select on public.shop_special_hours to anon, authenticated;
grant all on public.shop_special_hours to service_role;

/**
 * A date or a date range (at most 62 days, from yesterday to a year ahead): closed all day, or
 * other hours (1–4 ranges, a break allowed), with an optional note (plain text, 100). A date
 * that already has special hours is replaced. Errors: 'dates', 'ranges'.
 */
create or replace function public.owner_save_special_hours(
  p_shop_id uuid, p_from date, p_to date, p_closed boolean, p_ranges jsonb, p_note text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_to date := coalesce(p_to, p_from);
  v_closed boolean := coalesce(p_closed, false);
  v_ranges jsonb := case when coalesce(p_closed, false) then '[]'::jsonb else coalesce(p_ranges, '[]'::jsonb) end;
  v_note text := public.plain_text(p_note, 100);
  v_n integer;
begin
  if auth.uid() is null or not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if p_from is null or v_to < p_from or v_to - p_from > 61
     or p_from < current_date - 1 or v_to > current_date + 400 then
    raise exception 'dates' using errcode = '22023';
  end if;
  if not v_closed and not public.valid_hour_ranges(v_ranges) then
    raise exception 'ranges' using errcode = '22023';
  end if;
  insert into public.shop_special_hours (shop_id, date, closed, ranges, note)
  select p_shop_id, d::date, v_closed, v_ranges, v_note
  from generate_series(p_from::timestamp, v_to::timestamp, interval '1 day') d
  on conflict (shop_id, date) do update
    set closed = excluded.closed, ranges = excluded.ranges, note = excluded.note, updated_at = now();
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke execute on function public.owner_save_special_hours(uuid, date, date, boolean, jsonb, text) from public, anon;
grant execute on function public.owner_save_special_hours(uuid, date, date, boolean, jsonb, text) to authenticated;

create or replace function public.owner_delete_special_hours(p_shop_id uuid, p_date date)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  delete from public.shop_special_hours where shop_id = p_shop_id and date = p_date;
  return found;
end;
$$;
revoke execute on function public.owner_delete_special_hours(uuid, date) from public, anon;
grant execute on function public.owner_delete_special_hours(uuid, date) to authenticated;

-- ------------------------------------------------------------------ the calendar the status is computed from

/**
 * For up to 200 shops and up to 71 days: every date with special hours or a holiday that
 * applies to the shop (only with "Automatické štátne sviatky" on, from the shop's country,
 * an admin row winning over the library's). The website, API and MCP turn it into the status
 * with one function (src/lib/hours.ts).
 */
create or replace function public.shop_calendar(p_shop_ids uuid[], p_from date, p_to date)
returns table (
  shop_id uuid, date date,
  special_closed boolean, special_ranges jsonb, special_note text,
  holiday_kind text, holiday_closed_from text, holiday_name_sk text, holiday_name_hu text, holiday_name_en text)
language sql
stable
security definer
set search_path = ''
as $$
  with picked as (
    select s.id, upper(s.country) as country, s.auto_holidays
    from public.shops s
    where s.id = any ((coalesce(p_shop_ids, '{}'::uuid[]))[1:200])
      and (s.is_active or public.is_shop_member(s.id) or public.is_admin())
  ),
  span as (select p_from as d0, least(p_to, p_from + 70) as d1),
  hol as (
    select x.country, x.date, x.name_sk, x.name_hu, x.name_en, x.kind, x.closed_from
    from (
      select distinct on (p.country, p.date) p.*
      from public.public_holidays p, span
      where p.country in (select country from picked where auto_holidays and country is not null)
        and p.date between span.d0 and span.d1
      order by p.country, p.date, (p.source = 'admin') desc
    ) x
    where x.kind <> 'removed'
  ),
  days as (
    select pk.id as shop_id, h.date from picked pk join hol h on h.country = pk.country where pk.auto_holidays
    union
    select sh.shop_id, sh.date from public.shop_special_hours sh join picked pk on pk.id = sh.shop_id, span
    where sh.date between span.d0 and span.d1
  )
  select d.shop_id, d.date, sh.closed, sh.ranges, sh.note,
         h.kind, h.closed_from, h.name_sk, h.name_hu, h.name_en
  from days d
  join picked pk on pk.id = d.shop_id
  left join public.shop_special_hours sh on sh.shop_id = d.shop_id and sh.date = d.date
  left join hol h on pk.auto_holidays and h.country = pk.country and h.date = d.date
  order by d.shop_id, d.date
$$;
revoke execute on function public.shop_calendar(uuid[], date, date) from public;
grant execute on function public.shop_calendar(uuid[], date, date) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ admin: "Sviatky"

/** Every row of one country and year, the library's and the admin's, and which one counts. */
create or replace function public.admin_holidays(p_country text, p_year integer)
returns table (date date, name_sk text, name_hu text, name_en text, kind text, closed_from text, source text, counts boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  return query
    select p.date, p.name_sk, p.name_hu, p.name_en, p.kind, p.closed_from, p.source,
           (p.source = 'admin' or not exists (
              select 1 from public.public_holidays a
              where a.country = p.country and a.date = p.date and a.source = 'admin')) and p.kind <> 'removed'
    from public.public_holidays p
    where p.country = upper(p_country) and extract(year from p.date) = p_year
    order by p.date, p.source;
end;
$$;
revoke execute on function public.admin_holidays(text, integer) from public, anon;
grant execute on function public.admin_holidays(text, integer) to authenticated;

/** Adds or changes the admin's row for a date (it wins over the library's; kind 'removed' takes the date away). */
create or replace function public.admin_save_holiday(
  p_country text, p_date date, p_kind text, p_closed_from text, p_name_sk text, p_name_hu text, p_name_en text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  insert into public.public_holidays (country, date, name_sk, name_hu, name_en, kind, closed_from, source)
  values (upper(p_country), p_date, public.plain_text(p_name_sk, 120), public.plain_text(p_name_hu, 120),
          public.plain_text(p_name_en, 120), p_kind,
          case when p_kind = 'shops_closed' then nullif(btrim(coalesce(p_closed_from, '')), '') end, 'admin')
  on conflict (country, date, source) do update
    set name_sk = excluded.name_sk, name_hu = excluded.name_hu, name_en = excluded.name_en,
        kind = excluded.kind, closed_from = excluded.closed_from, updated_at = now();
end;
$$;
revoke execute on function public.admin_save_holiday(text, date, text, text, text, text, text) from public, anon;
grant execute on function public.admin_save_holiday(text, date, text, text, text, text, text) to authenticated;

/** Deletes the admin's row for a date: the library's row (if any) counts again. */
create or replace function public.admin_delete_holiday(p_country text, p_date date)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  delete from public.public_holidays where country = upper(p_country) and date = p_date and source = 'admin';
  return found;
end;
$$;
revoke execute on function public.admin_delete_holiday(text, date) from public, anon;
grant execute on function public.admin_delete_holiday(text, date) to authenticated;

-- ------------------------------------------------------------------ the holidays (scripts/holidays.mjs)
-- Slovakia 2026: days off 1.1, 6.1, 3.4, 6.4, 1.5, 5.7, 29.8, 1.11, 24.12, 25.12, 26.12; not days
-- off: 8.5 and 15.9 (2026 only), 1.9 and 17.11 (for good); shops closed 1.1, 3.4 (Good Friday),
-- 5.4 (Easter Sunday), 24.12 from 12:00, 25.12, 26.12. 2027: 8.5 and 15.9 are days off again.
-- Hungary and Czechia: the library's public holidays, as days off ("overte otváracie hodiny").

-- generated by scripts/holidays.mjs 2026 2027 (date-holidays 3.37.0)
insert into public.public_holidays (country, date, name_sk, name_hu, name_en, kind, closed_from, source) values
  ('SK', '2026-01-01', 'Deň vzniku Slovenskej republiky', 'Újév', 'New Year''s Day', 'shops_closed', null, 'library'),
  ('SK', '2026-01-06', 'Zjavenie Pána', 'Vízkereszt', 'Epiphany', 'day_off', null, 'library'),
  ('SK', '2026-04-03', 'Veľký piatok', 'Nagypéntek', 'Good Friday', 'shops_closed', null, 'library'),
  ('SK', '2026-04-05', 'Veľkonočná nedeľa', 'Húsvétvasárnap', 'Easter Sunday', 'shops_closed', null, 'library'),
  ('SK', '2026-04-06', 'Veľkonočný pondelok', 'Húsvéthétfő', 'Easter Monday', 'day_off', null, 'library'),
  ('SK', '2026-05-01', 'Sviatok práce', 'A munka ünnepe', 'Labour Day', 'day_off', null, 'library'),
  ('SK', '2026-07-05', 'Sviatok svätého Cyrila a Metoda', 'Sviatok svätého Cyrila a Metoda', 'Saints Cyril and Methodius Day', 'day_off', null, 'library'),
  ('SK', '2026-08-29', 'Výročie Slovenského národného povstania', 'Výročie Slovenského národného povstania', 'Slovak National Uprising anniversary', 'day_off', null, 'library'),
  ('SK', '2026-11-01', 'Sviatok všetkých svätých', 'Mindenszentek', 'All Saints'' Day', 'day_off', null, 'library'),
  ('SK', '2026-12-24', 'Štedrý deň', 'Szenteste', 'Christmas Eve', 'shops_closed', '12:00', 'library'),
  ('SK', '2026-12-25', 'Prvý sviatok vianočný', 'Karácsony', 'Christmas Day', 'shops_closed', null, 'library'),
  ('SK', '2026-12-26', 'Druhý sviatok vianočný', 'Karácsony másnapja', 'Boxing Day', 'shops_closed', null, 'library'),
  ('SK', '2027-01-01', 'Deň vzniku Slovenskej republiky', 'Újév', 'New Year''s Day', 'shops_closed', null, 'library'),
  ('SK', '2027-01-06', 'Zjavenie Pána', 'Vízkereszt', 'Epiphany', 'day_off', null, 'library'),
  ('SK', '2027-03-26', 'Veľký piatok', 'Nagypéntek', 'Good Friday', 'shops_closed', null, 'library'),
  ('SK', '2027-03-28', 'Veľkonočná nedeľa', 'Húsvétvasárnap', 'Easter Sunday', 'shops_closed', null, 'library'),
  ('SK', '2027-03-29', 'Veľkonočný pondelok', 'Húsvéthétfő', 'Easter Monday', 'day_off', null, 'library'),
  ('SK', '2027-05-01', 'Sviatok práce', 'A munka ünnepe', 'Labour Day', 'day_off', null, 'library'),
  ('SK', '2027-05-08', 'Deň víťazstva nad fašizmom', 'Deň víťazstva nad fašizmom', 'Day of victory over fascism', 'day_off', null, 'library'),
  ('SK', '2027-07-05', 'Sviatok svätého Cyrila a Metoda', 'Sviatok svätého Cyrila a Metoda', 'Saints Cyril and Methodius Day', 'day_off', null, 'library'),
  ('SK', '2027-08-29', 'Výročie Slovenského národného povstania', 'Výročie Slovenského národného povstania', 'Slovak National Uprising anniversary', 'day_off', null, 'library'),
  ('SK', '2027-09-15', 'Sviatok Panny Márie Sedembolestnej', 'Sviatok Panny Márie Sedembolestnej', 'Day of Our Lady of the Seven Sorrows', 'day_off', null, 'library'),
  ('SK', '2027-11-01', 'Sviatok všetkých svätých', 'Mindenszentek', 'All Saints'' Day', 'day_off', null, 'library'),
  ('SK', '2027-12-24', 'Štedrý deň', 'Szenteste', 'Christmas Eve', 'shops_closed', '12:00', 'library'),
  ('SK', '2027-12-25', 'Prvý sviatok vianočný', 'Karácsony', 'Christmas Day', 'shops_closed', null, 'library'),
  ('SK', '2027-12-26', 'Druhý sviatok vianočný', 'Karácsony másnapja', 'Boxing Day', 'shops_closed', null, 'library'),
  ('HU', '2026-01-01', 'Újév', 'Újév', 'New Year''s Day', 'day_off', null, 'library'),
  ('HU', '2026-03-15', '1848-as forradalom', '1848-as forradalom', 'National Day', 'day_off', null, 'library'),
  ('HU', '2026-04-03', 'Veľký piatok', 'Nagypéntek', 'Good Friday', 'day_off', null, 'library'),
  ('HU', '2026-04-05', 'Veľká noc', 'Húsvétvasárnap', 'Easter Sunday', 'day_off', null, 'library'),
  ('HU', '2026-04-06', 'Veľkonočný pondelok', 'Húsvéthétfő', 'Easter Monday', 'day_off', null, 'library'),
  ('HU', '2026-05-01', 'Sviatok práce', 'A munka ünnepe', 'Labour Day', 'day_off', null, 'library'),
  ('HU', '2026-05-24', 'Pünkösdvasárnap', 'Pünkösdvasárnap', 'Pentecost', 'day_off', null, 'library'),
  ('HU', '2026-05-25', 'Pünkösdhétfő', 'Pünkösdhétfő', 'Whit Monday', 'day_off', null, 'library'),
  ('HU', '2026-08-20', 'Szent István ünnepe', 'Szent István ünnepe', 'Saint Stephen''s Day', 'day_off', null, 'library'),
  ('HU', '2026-10-23', '1956-os forradalom', '1956-os forradalom', 'National Day', 'day_off', null, 'library'),
  ('HU', '2026-11-01', 'Sviatok všetkých svätých', 'Mindenszentek', 'All Saints'' Day', 'day_off', null, 'library'),
  ('HU', '2026-12-25', 'Prvý sviatok vianočný', 'Karácsony', 'Christmas Day', 'day_off', null, 'library'),
  ('HU', '2026-12-26', 'Druhý sviatok vianočný', 'Karácsony másnapja', 'Boxing Day', 'day_off', null, 'library'),
  ('HU', '2027-01-01', 'Újév', 'Újév', 'New Year''s Day', 'day_off', null, 'library'),
  ('HU', '2027-03-15', '1848-as forradalom', '1848-as forradalom', 'National Day', 'day_off', null, 'library'),
  ('HU', '2027-03-26', 'Veľký piatok', 'Nagypéntek', 'Good Friday', 'day_off', null, 'library'),
  ('HU', '2027-03-28', 'Veľká noc', 'Húsvétvasárnap', 'Easter Sunday', 'day_off', null, 'library'),
  ('HU', '2027-03-29', 'Veľkonočný pondelok', 'Húsvéthétfő', 'Easter Monday', 'day_off', null, 'library'),
  ('HU', '2027-05-01', 'Sviatok práce', 'A munka ünnepe', 'Labour Day', 'day_off', null, 'library'),
  ('HU', '2027-05-16', 'Pünkösdvasárnap', 'Pünkösdvasárnap', 'Pentecost', 'day_off', null, 'library'),
  ('HU', '2027-05-17', 'Pünkösdhétfő', 'Pünkösdhétfő', 'Whit Monday', 'day_off', null, 'library'),
  ('HU', '2027-08-20', 'Szent István ünnepe', 'Szent István ünnepe', 'Saint Stephen''s Day', 'day_off', null, 'library'),
  ('HU', '2027-10-23', '1956-os forradalom', '1956-os forradalom', 'National Day', 'day_off', null, 'library'),
  ('HU', '2027-11-01', 'Sviatok všetkých svätých', 'Mindenszentek', 'All Saints'' Day', 'day_off', null, 'library'),
  ('HU', '2027-12-25', 'Prvý sviatok vianočný', 'Karácsony', 'Christmas Day', 'day_off', null, 'library'),
  ('HU', '2027-12-26', 'Druhý sviatok vianočný', 'Karácsony másnapja', 'Boxing Day', 'day_off', null, 'library'),
  ('CZ', '2026-01-01', 'Nový rok a Den obnovy samostatného českého státu', 'Újév', 'New Year''s Day', 'day_off', null, 'library'),
  ('CZ', '2026-04-03', 'Veľký piatok', 'Nagypéntek', 'Good Friday', 'day_off', null, 'library'),
  ('CZ', '2026-04-06', 'Veľkonočný pondelok', 'Húsvéthétfő', 'Easter Monday', 'day_off', null, 'library'),
  ('CZ', '2026-05-01', 'Sviatok práce', 'A munka ünnepe', 'Labour Day', 'day_off', null, 'library'),
  ('CZ', '2026-05-08', 'Den vítězství', 'Den vítězství', 'Liberation Day', 'day_off', null, 'library'),
  ('CZ', '2026-07-05', 'Den slovanských věrozvěstů Cyrila a Metoděje', 'Den slovanských věrozvěstů Cyrila a Metoděje', 'Saints Cyril and Methodius Day', 'day_off', null, 'library'),
  ('CZ', '2026-07-06', 'Den upálení mistra Jana Husa', 'Den upálení mistra Jana Husa', 'Jan Hus Day', 'day_off', null, 'library'),
  ('CZ', '2026-09-28', 'Den české státnosti', 'Den české státnosti', 'St. Wenceslas Day (Czech Statehood Day)', 'day_off', null, 'library'),
  ('CZ', '2026-10-28', 'Den vzniku samostatného československého státu', 'Den vzniku samostatného československého státu', 'Independent Czechoslovak State Day', 'day_off', null, 'library'),
  ('CZ', '2026-11-17', 'Den boje za svobodu a demokracii', 'Den boje za svobodu a demokracii', 'Struggle for Freedom and Democracy Day', 'day_off', null, 'library'),
  ('CZ', '2026-12-24', 'Štedrý deň', 'Szenteste', 'Christmas Eve', 'day_off', null, 'library'),
  ('CZ', '2026-12-25', 'Prvý sviatok vianočný', 'Karácsony', 'Christmas Day', 'day_off', null, 'library'),
  ('CZ', '2026-12-26', 'Druhý sviatok vianočný', 'Karácsony másnapja', 'Boxing Day', 'day_off', null, 'library'),
  ('CZ', '2027-01-01', 'Nový rok a Den obnovy samostatného českého státu', 'Újév', 'New Year''s Day', 'day_off', null, 'library'),
  ('CZ', '2027-03-26', 'Veľký piatok', 'Nagypéntek', 'Good Friday', 'day_off', null, 'library'),
  ('CZ', '2027-03-29', 'Veľkonočný pondelok', 'Húsvéthétfő', 'Easter Monday', 'day_off', null, 'library'),
  ('CZ', '2027-05-01', 'Sviatok práce', 'A munka ünnepe', 'Labour Day', 'day_off', null, 'library'),
  ('CZ', '2027-05-08', 'Den vítězství', 'Den vítězství', 'Liberation Day', 'day_off', null, 'library'),
  ('CZ', '2027-07-05', 'Den slovanských věrozvěstů Cyrila a Metoděje', 'Den slovanských věrozvěstů Cyrila a Metoděje', 'Saints Cyril and Methodius Day', 'day_off', null, 'library'),
  ('CZ', '2027-07-06', 'Den upálení mistra Jana Husa', 'Den upálení mistra Jana Husa', 'Jan Hus Day', 'day_off', null, 'library'),
  ('CZ', '2027-09-28', 'Den české státnosti', 'Den české státnosti', 'St. Wenceslas Day (Czech Statehood Day)', 'day_off', null, 'library'),
  ('CZ', '2027-10-28', 'Den vzniku samostatného československého státu', 'Den vzniku samostatného československého státu', 'Independent Czechoslovak State Day', 'day_off', null, 'library'),
  ('CZ', '2027-11-17', 'Den boje za svobodu a demokracii', 'Den boje za svobodu a demokracii', 'Struggle for Freedom and Democracy Day', 'day_off', null, 'library'),
  ('CZ', '2027-12-24', 'Štedrý deň', 'Szenteste', 'Christmas Eve', 'day_off', null, 'library'),
  ('CZ', '2027-12-25', 'Prvý sviatok vianočný', 'Karácsony', 'Christmas Day', 'day_off', null, 'library'),
  ('CZ', '2027-12-26', 'Druhý sviatok vianočný', 'Karácsony másnapja', 'Boxing Day', 'day_off', null, 'library')
on conflict (country, date, source) do update set
  name_sk = excluded.name_sk, name_hu = excluded.name_hu, name_en = excluded.name_en,
  kind = excluded.kind, closed_from = excluded.closed_from, updated_at = now();
