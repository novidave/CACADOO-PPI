-- PPI · 15 · Cloud link: an owner can give PPI a share link to the stock file in
-- Google Drive, Dropbox or OneDrive; the 15-minute stock pull downloads it.
-- A file without a "Last-Modified" date counts as new only when its content changed.

alter table public.sync_sources add column if not exists last_file_hash text;

-- The owner sets (or clears, with an empty text) the cloud link of one of their shops.
-- Only https addresses with a host name (no IP addresses, no localhost).
create or replace function public.owner_set_file_url(p_shop_id uuid, p_url text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text := nullif(trim(coalesce(p_url, '')), '');
  v_host text;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  if v_url is not null then
    v_host := lower(substring(v_url from '^https://([^/:?#@\s]+)'));
    if length(v_url) > 1000 or v_url ~ '\s' or v_host is null
       or v_host = 'localhost' or v_host !~ '[a-z]' or v_host !~ '\.' or v_host ~ '^[0-9.]+$' then
      raise exception 'The link must be an https:// address of a cloud service' using errcode = '22023';
    end if;
  end if;

  insert into public.sync_sources (shop_id) values (p_shop_id) on conflict (shop_id) do nothing;
  update public.sync_sources
  set file_url = v_url, last_file_hash = null
  where shop_id = p_shop_id;
end;
$$;

revoke execute on function public.owner_set_file_url(uuid, text) from public, anon;
grant execute on function public.owner_set_file_url(uuid, text) to authenticated;

-- my_shops() also returns the cloud link (a new result column: drop and create again).
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
  visibility_mode text,
  low_stock_threshold integer,
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
  file_url text
)
language sql
stable
security definer
set search_path = ''
as $$
  select sh.id, sh.slug, sh.name, sh.ico, sh.address, sh.city, sh.country, sh.timezone,
         extensions.st_y(sh.location::extensions.geometry), extensions.st_x(sh.location::extensions.geometry),
         sh.phone, sh.website, sh.opening_hours, sh.visibility_mode, sh.low_stock_threshold, sh.logo_url,
         sh.is_active, sh.has_toilet, sh.has_douchette, sh.has_card_terminal,
         ss.field_mapping, ss.mapping_status, ss.sample_rows, ss.latest_file_time, ss.last_error,
         public.freshness_label(ss.latest_file_time), ss.folder_seen_at, ss.last_file_name, ss.file_url
  from public.shops sh
  join public.shop_members m on m.shop_id = sh.id and m.user_id = auth.uid()
  left join public.sync_sources ss on ss.shop_id = sh.id
  order by sh.name
$$;

revoke execute on function public.my_shops() from public, anon;
grant execute on function public.my_shops() to authenticated;
