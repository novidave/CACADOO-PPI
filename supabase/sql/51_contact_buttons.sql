-- =====================================================================================================================
-- Update 51: the shop page's contact buttons — short or long per button (at the owner's request, 2026-10-28).
--
-- The shop page shows its contacts as press-and-hold buttons in two columns: Facebook · Rezervovať termín · Web ·
-- e-mail · Navigovať · phone (a button without its link or value is not shown). The owner chooses per button whether
-- it is "short" (one column) or "long" (both columns) in Môj obchod. Only the choices that differ from nothing are
-- stored, in shops.contact_buttons ({"email": "long", "phone": "short"}); a button without a choice uses the default
-- (e-mail long, the others short), so every existing shop keeps working unchanged. This is page layout, never shop or
-- stock data. Written only through owner_set_contact_buttons() (membership checked); visitors read it through
-- shop_contact_buttons(slug). Paste this whole file into the Supabase SQL Editor once; safe to run again.
-- =====================================================================================================================

alter table public.shops add column if not exists contact_buttons jsonb not null default '{}'::jsonb;

-- Only the six buttons, only "short" or "long".
create or replace function public.contact_buttons_valid(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p) = 'object'
    and not exists (
      select 1 from jsonb_each(p) e
      where e.key not in ('facebook', 'booking', 'web', 'email', 'navigate', 'phone')
         or e.value not in ('"short"'::jsonb, '"long"'::jsonb))
$$;

alter table public.shops drop constraint if exists shops_contact_buttons_check;
alter table public.shops add constraint shops_contact_buttons_check check (public.contact_buttons_valid(contact_buttons));

-- "Krátke / Dlhé" in Môj obchod: the whole set of choices at once (keys left out keep their default).
create or replace function public.owner_set_contact_buttons(p_shop_id uuid, p_widths jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  if p_widths is null or not public.contact_buttons_valid(p_widths) then
    raise exception 'contact_buttons' using errcode = '22023';
  end if;
  update public.shops set contact_buttons = p_widths where id = p_shop_id;
end;
$$;
revoke execute on function public.owner_set_contact_buttons(uuid, jsonb) from public, anon;
grant execute on function public.owner_set_contact_buttons(uuid, jsonb) to authenticated;

-- What the shop page reads (active shops only): the owner's choices; the page fills in the defaults.
create or replace function public.shop_contact_buttons(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
set jit = off
as $$
  select sh.contact_buttons from public.shops sh where sh.slug = p_slug and sh.is_active
$$;
revoke execute on function public.shop_contact_buttons(text) from public;
grant execute on function public.shop_contact_buttons(text) to anon, authenticated, service_role;

-- my_shops: as in update 47, plus the choices (last).
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
  zip text,
  contact_buttons jsonb
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
         co.company_name, co.dic, co.zip, sh.contact_buttons
  from public.shops sh
  join public.shop_members m on m.shop_id = sh.id and m.user_id = auth.uid()
  left join public.sync_sources ss on ss.shop_id = sh.id
  left join public.shop_company co on co.shop_id = sh.id
  order by sh.name
$$;
revoke execute on function public.my_shops() from public, anon;
grant execute on function public.my_shops() to authenticated;
