-- PPI · 12 · Folder upload: the shop's PC keeps PPI open in Edge/Chrome, watches the
-- folder the stock software exports to and uploads the newest file to the
-- "stock-pull" function. No tunnel, no server on the shop PC.

-- When the PPI window on the shop PC last checked the folder, and the file it last sent.
alter table public.sync_sources add column if not exists folder_seen_at timestamptz;
alter table public.sync_sources add column if not exists last_file_name text;

-- Called by the PPI window on every folder check (and by stock-pull before an upload,
-- with the uploader's own login): only the shop's owners and the admin.
-- Records "PPI window seen now" and returns what the window needs to decide
-- whether to upload. Creates the shop's sync_sources row if it is missing.
create or replace function public.upload_check_in(p_shop_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status jsonb;
begin
  if not (public.is_shop_member(p_shop_id) or public.is_admin()) then
    raise exception 'Not a member of this shop' using errcode = '42501';
  end if;
  if not exists (select 1 from public.shops where id = p_shop_id) then
    raise exception 'Shop not found' using errcode = 'P0002';
  end if;

  insert into public.sync_sources (shop_id) values (p_shop_id)
  on conflict (shop_id) do nothing;

  update public.sync_sources s
  set folder_seen_at = now()
  where s.shop_id = p_shop_id
  returning jsonb_build_object(
    'latest_file_time', s.latest_file_time,
    'last_checked_at',  s.last_checked_at,
    'last_error',       s.last_error,
    'mapping_status',   s.mapping_status,
    'freshness_state',  public.freshness_label(s.latest_file_time),
    'folder_seen_at',   s.folder_seen_at,
    'last_file_name',   s.last_file_name
  ) into v_status;

  return v_status;
end;
$$;

revoke execute on function public.upload_check_in(uuid) from public, anon;
grant execute on function public.upload_check_in(uuid) to authenticated;
