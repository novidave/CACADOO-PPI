-- PPI · 16 · Cloud links removed: stock reaches PPI only by upload — the PPI app window
-- on the shop PC (every 15 minutes) and "Upload file" on the dashboard. PPI downloads
-- nothing itself any more.
--  - the 15-minute download schedule (pg_cron job "ppi-stock-pull") is stopped, if it exists
--  - owners can no longer save a cloud link: owner_set_file_url() is dropped
--  - my_shops() no longer returns file_url
--  - sync_sources.last_file_hash is dropped (only the download path used it)
--  - sync_sources.file_url stays: the upload path does not use it, but the legacy
--    admin_shops() still reads it, and the admin functions are not changed here.

-- The schedule exists only where it was set up by hand (old SETUP.md part G4).
do $$
begin
  if to_regclass('cron.job') is not null then
    execute $q$select cron.unschedule(jobid) from cron.job where jobname = 'ppi-stock-pull'$q$;
  end if;
end;
$$;

drop function if exists public.owner_set_file_url(uuid, text);

-- my_shops() as before migration 15, without file_url (a result column goes away:
-- drop and create again).
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
  last_file_name text
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
         public.freshness_label(ss.latest_file_time), ss.folder_seen_at, ss.last_file_name
  from public.shops sh
  join public.shop_members m on m.shop_id = sh.id and m.user_id = auth.uid()
  left join public.sync_sources ss on ss.shop_id = sh.id
  order by sh.name
$$;

revoke execute on function public.my_shops() from public, anon;
grant execute on function public.my_shops() to authenticated;

alter table public.sync_sources drop column if exists last_file_hash;
