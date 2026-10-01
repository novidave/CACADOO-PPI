-- PPI · 4/5 · Row Level Security (docs/PRD.md section 7)
-- Every table has RLS on. Visitors (anon) read only public data, owners only
-- their own shop, admin everything. inventory and sync results are written
-- only by the service role, which bypasses RLS.

alter table public.profiles     enable row level security;
alter table public.shops        enable row level security;
alter table public.shop_members enable row level security;
alter table public.products     enable row level security;
alter table public.shop_items   enable row level security;
alter table public.inventory    enable row level security;
alter table public.sync_sources enable row level security;
alter table public.api_usage    enable row level security;

-- Table privileges first (RLS policies only narrow what these allow).
revoke all on public.profiles, public.shops, public.shop_members, public.products,
              public.shop_items, public.inventory, public.sync_sources, public.api_usage
  from anon, authenticated;

grant select on public.shops, public.products, public.shop_items to anon;

grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.shops, public.shop_members, public.products
  to authenticated;
grant select, insert, delete on public.shop_items to authenticated;
grant update (is_public) on public.shop_items to authenticated;   -- owners toggle visibility only
grant select on public.inventory to authenticated;                -- never insert/update from a client
grant select, insert, update, delete on public.sync_sources to authenticated;
-- api_usage: no client access at all.

-- profiles -------------------------------------------------------------------
create policy "profiles: read own or admin" on public.profiles
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

create policy "profiles: update own or admin" on public.profiles
  for update to authenticated
  using (user_id = (select auth.uid()) or public.is_admin())
  with check (user_id = (select auth.uid()) or public.is_admin());

-- shops ----------------------------------------------------------------------
create policy "shops: visitors read active" on public.shops
  for select to anon
  using (is_active);

create policy "shops: users read active, own or all if admin" on public.shops
  for select to authenticated
  using (is_active or public.is_shop_member(id) or public.is_admin());

create policy "shops: owner or admin update" on public.shops
  for update to authenticated
  using (public.is_shop_member(id) or public.is_admin())
  with check (public.is_shop_member(id) or public.is_admin());

create policy "shops: admin insert" on public.shops
  for insert to authenticated
  with check (public.is_admin());

create policy "shops: admin delete" on public.shops
  for delete to authenticated
  using (public.is_admin());

-- shop_members ---------------------------------------------------------------
create policy "shop_members: read own or admin" on public.shop_members
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

create policy "shop_members: admin insert" on public.shop_members
  for insert to authenticated
  with check (public.is_admin());

create policy "shop_members: admin update" on public.shop_members
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "shop_members: admin delete" on public.shop_members
  for delete to authenticated
  using (public.is_admin());

-- products -------------------------------------------------------------------
create policy "products: everyone reads" on public.products
  for select to anon, authenticated
  using (true);

create policy "products: admin insert" on public.products
  for insert to authenticated
  with check (public.is_admin());

create policy "products: admin update" on public.products
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "products: admin delete" on public.products
  for delete to authenticated
  using (public.is_admin());

-- shop_items -----------------------------------------------------------------
create policy "shop_items: visitors read public items of active shops" on public.shop_items
  for select to anon
  using (
    is_public
    and exists (select 1 from public.shops s where s.id = shop_id and s.is_active)
  );

create policy "shop_items: users read public, own or all if admin" on public.shop_items
  for select to authenticated
  using (
    (is_public and exists (select 1 from public.shops s where s.id = shop_id and s.is_active))
    or public.is_shop_member(shop_id)
    or public.is_admin()
  );

-- Column grant above limits owners to is_public.
create policy "shop_items: owner or admin update" on public.shop_items
  for update to authenticated
  using (public.is_shop_member(shop_id) or public.is_admin())
  with check (public.is_shop_member(shop_id) or public.is_admin());

create policy "shop_items: admin insert" on public.shop_items
  for insert to authenticated
  with check (public.is_admin());

create policy "shop_items: admin delete" on public.shop_items
  for delete to authenticated
  using (public.is_admin());

-- inventory (read only; visitors use the public_stock view) -----------------
create policy "inventory: owner or admin read" on public.inventory
  for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.shop_items si
      where si.id = shop_item_id and public.is_shop_member(si.shop_id)
    )
  );

-- sync_sources (admin only; owners use my_sync_status()) ---------------------
create policy "sync_sources: admin read" on public.sync_sources
  for select to authenticated
  using (public.is_admin());

create policy "sync_sources: admin insert" on public.sync_sources
  for insert to authenticated
  with check (public.is_admin());

create policy "sync_sources: admin update" on public.sync_sources
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "sync_sources: admin delete" on public.sync_sources
  for delete to authenticated
  using (public.is_admin());

-- Helper functions: only what clients need may be called.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.guard_shop_update() from public, anon, authenticated;
revoke execute on function public.guard_profile_update() from public, anon, authenticated;
revoke execute on function public.guard_sync_source_write() from public, anon, authenticated;
