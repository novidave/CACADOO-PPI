-- PPI database checks. Run with: npm run test:db  (needs local Postgres + PostGIS)
-- Each block raises an exception (and stops the run) if a rule is broken.
\set ON_ERROR_STOP on
\set QUIET on

-- Two test owners: A owns potraviny-centrum, B owns drogeria-kostolne.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'owner-a@example.invalid'),
  ('00000000-0000-0000-0000-00000000000b', 'owner-b@example.invalid'),
  ('00000000-0000-0000-0000-0000000000ad', 'admin@example.invalid');
update public.profiles set is_admin = true where user_id = '00000000-0000-0000-0000-0000000000ad';
insert into public.shop_members (shop_id, user_id)
select id, '00000000-0000-0000-0000-00000000000a' from public.shops where slug = 'potraviny-centrum';
insert into public.shop_members (shop_id, user_id)
select id, '00000000-0000-0000-0000-00000000000b' from public.shops where slug = 'drogeria-kostolne';

\echo '--- visitor (anon)'
set role anon;

do $$
declare n int;
begin
  -- "kava" finds "Káva"
  select count(*) into n from public.search_stock('kava') where item_name ilike 'káva%';
  assert n >= 3, format('kava should find Káva items, got %s', n);

  -- capital letters and accents in the query too
  select count(*) into n from public.search_stock('KÁVA');
  assert n >= 3, 'KÁVA should match too';

  -- EAN search
  select count(*) into n from public.search_stock('8000070012345');
  assert n = 1, 'EAN search should find exactly one item';

  -- stale shop (25 h file): no availability, no quantity, never "available"
  select count(*) into n from public.public_stock
  where shop_slug = 'zeleziarstvo-vychod'
    and (availability is not null or quantity is not null or is_available or freshness_state <> 'stale');
  assert n = 0, 'stale shop must not show availability';

  -- in_stock mode: quantity never leaves the database
  select count(*) into n from public.public_stock
  where shop_slug = 'potraviny-centrum' and quantity is not null;
  assert n = 0, 'in_stock mode must hide quantity';

  -- in_stock mode labels with threshold 3
  assert (select availability from public.public_stock where item_name = 'Káva zrnková 1 kg') = 'in_stock';
  assert (select availability from public.public_stock where item_name = 'Káva mletá 250 g') = 'low_stock';
  assert (select availability from public.public_stock where item_name = 'Chlieb konzumný 1 kg') = 'out_of_stock';
  assert (select freshness_state from public.public_stock where item_name = 'Maslo 250 g') = 'current';

  -- exact mode (recent shop): quantity shown
  assert (select quantity from public.public_stock where item_name = 'Zubná pasta 75 ml') = 12;
  assert (select availability from public.public_stock where item_name = 'Zubná pasta 75 ml') = 'in_stock_count';
  assert (select freshness_state from public.public_stock where item_name = 'Zubná pasta 75 ml') = 'recent';

  -- hidden item never public
  select count(*) into n from public.public_stock where item_name like 'Čaj zelený%';
  assert n = 0, 'is_public = false item must be hidden';

  -- only_available hides stale and out-of-stock rows
  select count(*) into n from public.search_stock(null, 48.755, 21.918, 10, true) where not is_available;
  assert n = 0, 'only_available returned unavailable rows';
  select count(*) into n from public.search_stock(null, 48.755, 21.918, 10, true) where shop_slug = 'zeleziarstvo-vychod';
  assert n = 0, 'only_available returned stale shop rows';

  -- sort: available first
  assert (select bool_and(is_available) from (select * from public.search_stock('kava') limit 2) s),
    'available rows must come first';

  -- radius: nothing 100+ km away from Bratislava
  select count(*) into n from public.search_stock(null, 48.1486, 17.1077, 10, false);
  assert n = 0, 'radius filter failed';

  -- no direct access to inventory / sync_sources / api_usage
  begin
    perform 1 from public.inventory limit 1;
    raise exception 'anon could read inventory';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.sync_sources limit 1;
    raise exception 'anon could read sync_sources';
  exception when insufficient_privilege then null;
  end;

  -- freshness_state() function
  assert (select state from public.freshness_state(
    (select id from public.shops where slug = 'zeleziarstvo-vychod'))) = 'stale';
  assert (select state from public.freshness_state(gen_random_uuid())) = 'stale',
    'shop without sync source must be stale';
end;
$$;
reset role;

\echo '--- owner A'
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';

do $$
declare n int;
begin
  -- can update own shop details
  update public.shops set phone = '+421 900 000 000' where slug = 'potraviny-centrum';
  get diagnostics n = row_count;
  assert n = 1, 'owner should update own shop';

  -- cannot touch shop B (RLS hides it: 0 rows)
  update public.shops set phone = 'x' where slug = 'drogeria-kostolne';
  get diagnostics n = row_count;
  assert n = 0, 'owner A changed shop B';

  -- cannot see shop B's private data
  select count(*) into n from public.inventory inv
    join public.shop_items si on si.id = inv.shop_item_id
    join public.shops s on s.id = si.shop_id where s.slug = 'drogeria-kostolne';
  assert n = 0, 'owner A sees shop B inventory';
  select count(*) into n from public.inventory;
  assert n = 7, format('owner A should see own 7 inventory rows, got %s', n);

  -- cannot change slug / is_active
  begin
    update public.shops set is_active = false where slug = 'potraviny-centrum';
    raise exception 'owner changed is_active';
  exception when insufficient_privilege then null;
  end;

  -- can hide own item, cannot rename it
  update public.shop_items set is_public = false where source_code = 'P006';
  get diagnostics n = row_count;
  assert n = 1, 'owner should toggle is_public';
  begin
    update public.shop_items set name = 'x' where source_code = 'P006';
    raise exception 'owner renamed an item';
  exception when insufficient_privilege then null;
  end;

  -- cannot write stock
  begin
    update public.inventory set quantity = 999;
    raise exception 'owner wrote inventory';
  exception when insufficient_privilege then null;
  end;

  -- cannot make themself admin
  begin
    update public.profiles set is_admin = true where user_id = auth.uid();
    raise exception 'owner made themself admin';
  exception when insufficient_privilege then null;
  end;

  -- sync status: own yes, other shop no
  assert (select freshness_state from public.my_sync_status(
    (select id from public.shops where slug = 'potraviny-centrum'))) = 'current';
  begin
    perform * from public.my_sync_status(
      (select id from public.shops s where s.slug = 'drogeria-kostolne'));
    raise exception 'owner A read shop B sync status';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
reset request.jwt.claim.sub;

\echo '--- owner B switches to yes_no'
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
update public.shops set visibility_mode = 'yes_no' where slug = 'drogeria-kostolne';
reset role;
reset request.jwt.claim.sub;

set role anon;
do $$
begin
  assert (select count(*) from public.public_stock
          where shop_slug = 'drogeria-kostolne' and quantity is not null) = 0,
    'yes_no must hide quantities immediately';
  assert (select availability from public.public_stock where item_name = 'Zubná pasta 75 ml') = 'available';
  assert (select availability from public.public_stock where item_name = 'Prací prášok 3 kg') = 'not_available';
end;
$$;
reset role;

\echo '--- admin'
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000ad';
do $$
declare n int;
begin
  update public.shops set is_active = false where slug = 'zeleziarstvo-vychod';
  get diagnostics n = row_count;
  assert n = 1, 'admin should deactivate a shop';
  update public.sync_sources set mapping_status = 'confirmed';
  begin
    update public.sync_sources set latest_file_time = now();
    raise exception 'admin faked a file time';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
reset request.jwt.claim.sub;

set role anon;
do $$
begin
  assert (select count(*) from public.public_stock where shop_slug = 'zeleziarstvo-vychod') = 0,
    'inactive shop must disappear from public_stock';
  assert (select count(*) from public.shops where slug = 'zeleziarstvo-vychod') = 0,
    'inactive shop must be hidden from visitors';
end;
$$;
reset role;

\echo '--- service role (stock pull) can write stock'
set role service_role;
update public.inventory set quantity = 0 where shop_item_id in (select id from public.shop_items where source_code = 'P001');
update public.sync_sources set latest_file_time = now();
reset role;

\echo 'ALL DATABASE CHECKS PASSED'
