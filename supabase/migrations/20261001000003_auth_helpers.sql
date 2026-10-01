-- PPI · 3/5 · Auth helpers and guard triggers

-- Create a profile row for every new login.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'display_name')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- True when the logged-in user is the admin.
-- SECURITY DEFINER so policies on profiles do not recurse into themselves.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.is_admin from public.profiles p where p.user_id = auth.uid()),
    false
  )
$$;

-- True when the logged-in user is a member (owner) of the given shop.
create or replace function public.is_shop_member(p_shop_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.shop_members m
    where m.shop_id = p_shop_id and m.user_id = auth.uid()
  )
$$;

-- True when the current statement comes from a website/app user
-- (anon or authenticated) rather than the service role or a SQL Editor session.
create or replace function public.is_client_request()
returns boolean
language sql
stable
set search_path = ''
as $$
  select current_user in ('anon', 'authenticated')
$$;

-- Owners may edit their shop, but never slug, ico or is_active.
create or replace function public.guard_shop_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_client_request() and not public.is_admin() then
    if new.slug is distinct from old.slug
       or new.ico is distinct from old.ico
       or new.is_active is distinct from old.is_active then
      raise exception 'Only the admin can change slug, ico or is_active'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger shops_guard_update
  before update on public.shops
  for each row execute function public.guard_shop_update();

-- Nobody but the admin can grant admin rights (or move a profile to another user).
create or replace function public.guard_profile_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_client_request() and not public.is_admin() then
    if new.is_admin is distinct from old.is_admin
       or new.user_id is distinct from old.user_id then
      raise exception 'Not allowed to change is_admin' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger profiles_guard_update
  before update on public.profiles
  for each row execute function public.guard_profile_update();

-- The admin edits a sync source's settings (format, URL, mapping approval);
-- the sync result columns are written only by the stock-pull function.
create or replace function public.guard_sync_source_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_client_request() then
    if tg_op = 'INSERT' then
      new.latest_file_time := null;
      new.last_checked_at := null;
      new.last_error := null;
    elsif new.latest_file_time is distinct from old.latest_file_time
       or new.last_checked_at is distinct from old.last_checked_at
       or new.last_error is distinct from old.last_error then
      raise exception 'Sync results are written only by the stock-pull function'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger sync_sources_guard_write
  before insert or update on public.sync_sources
  for each row execute function public.guard_sync_source_write();
