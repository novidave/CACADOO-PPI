-- =====================================================================================================================
-- Update 47: the company behind the shop in "Môj obchod" (at the owner's request, 2026-10-27).
--
-- Under the address: the ZIP code (PSČ), the company name (Obchodné meno), IČO (already shops.ico) and DIČ (tax
-- identification number); no IČ DPH (at the owner's request). Owner data only: its own table shop_company (RLS: the
-- shop's members read; no grants to visitors — they can read every column of shops, so nothing private goes there),
-- shown in Môj obchod, never on public pages, in the API/MCP, the JSON-LD or the assistant. Written only through
-- owner_save_company() (membership checked here); an empty field clears the value.
-- Paste this whole file into the Supabase SQL Editor once.
-- =====================================================================================================================

create table if not exists public.shop_company (
  shop_id      uuid primary key references public.shops (id) on delete cascade,
  company_name text check (company_name is null or length(company_name) between 1 and 200),
  dic          text check (dic is null or dic ~ '^[A-Z0-9 ./-]{4,20}$'),
  zip          text check (zip is null or zip ~ '^[A-Z0-9 -]{2,12}$'),
  updated_at   timestamptz not null default now()
);
alter table public.shop_company enable row level security;
revoke all on public.shop_company from public, anon, authenticated;
grant select on public.shop_company to authenticated;
drop policy if exists "shop_company: members read" on public.shop_company;
create policy "shop_company: members read" on public.shop_company
  for select to authenticated using (public.is_shop_member(shop_id));

-- The owner saves the company: plain text, empty = none. A bad DIČ / PSČ → the message 'dic' / 'zip'.
create or replace function public.owner_save_company(p_shop_id uuid, p_company_name text, p_dic text, p_zip text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name   text := nullif(btrim(regexp_replace(coalesce(p_company_name, ''), '[[:cntrl:][:space:]<>]+', ' ', 'g')), '');
  v_dic    text := nullif(upper(btrim(coalesce(p_dic, ''))), '');
  v_zip    text := nullif(upper(btrim(regexp_replace(coalesce(p_zip, ''), '\s+', ' ', 'g'))), '');
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if v_name is not null and length(v_name) > 200 then
    raise exception 'company_name' using errcode = '22023';
  end if;
  if v_dic is not null and v_dic !~ '^[A-Z0-9 ./-]{4,20}$' then
    raise exception 'dic' using errcode = '22023';
  end if;
  if v_zip is not null and v_zip !~ '^[A-Z0-9 -]{2,12}$' then
    raise exception 'zip' using errcode = '22023';
  end if;
  insert into public.shop_company as c (shop_id, company_name, dic, zip) values (p_shop_id, v_name, v_dic, v_zip)
  on conflict (shop_id) do update set company_name = excluded.company_name, dic = excluded.dic, zip = excluded.zip,
    updated_at = now();
end;
$$;
revoke execute on function public.owner_save_company(uuid, text, text, text) from public, anon;
grant execute on function public.owner_save_company(uuid, text, text, text) to authenticated;

-- my_shops: as in update 26, plus the company (last).
drop function if exists public.my_shops();
create function public.my_shops()
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
  zip text
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
         public.freshness_label(ss.latest_file_time), ss.folder_seen_at, ss.last_file_name,
         sh.email, sh.facebook_url, sh.assistant_label, sh.assistant_welcome, ss.file_columns, sh.booking_url,
         co.company_name, co.dic, co.zip
  from public.shops sh
  join public.shop_members m on m.shop_id = sh.id and m.user_id = auth.uid()
  left join public.sync_sources ss on ss.shop_id = sh.id
  left join public.shop_company co on co.shop_id = sh.id
  order by sh.name
$$;
revoke execute on function public.my_shops() from public, anon;
grant execute on function public.my_shops() to authenticated;
