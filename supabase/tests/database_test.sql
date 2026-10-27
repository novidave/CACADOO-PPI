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

  -- one rule for every shop: the quantity exactly as in the shop's file
  assert (select quantity || ' ' || availability from public.public_stock where item_name = 'Káva zrnková 1 kg')
         = '14 in_stock_count', 'quantity as in the file';
  assert (select quantity || ' ' || availability from public.public_stock where item_name = 'Káva mletá 250 g')
         = '2 in_stock_count', 'no "low stock" label any more';
  assert (select quantity || ' ' || availability from public.public_stock where item_name = 'Chlieb konzumný 1 kg')
         = '0 out_of_stock', 'sold out at 0';
  assert (select freshness_state from public.public_stock where item_name = 'Maslo 250 g') = 'current';
  assert (select quantity from public.public_stock where item_name = 'Zubná pasta 75 ml') = 12;
  assert (select availability from public.public_stock where item_name = 'Zubná pasta 75 ml') = 'in_stock_count';
  assert (select freshness_state from public.public_stock where item_name = 'Zubná pasta 75 ml') = 'recent';
  assert (select count(*) from public.public_stock where shop_slug = 'kisbolt-budapest' and quantity is null) = 0,
    'every current shop shows its quantities';
  assert not exists (select 1 from public.public_stock
                     where availability not in ('in_stock_count', 'out_of_stock')), 'only the one rule''s labels';

  -- every item of the file is public: there is no hide switch any more
  select count(*) into n from public.public_stock where item_name like 'Čaj zelený%';
  assert n = 1, 'every item of the file is shown';

  -- only_available hides stale and out-of-stock rows
  select count(*) into n from public.search_stock(null, 48.755, 21.918, 10, true) where not is_available;
  assert n = 0, 'only_available returned unavailable rows';
  select count(*) into n from public.search_stock(null, 48.755, 21.918, 10, true) where shop_slug = 'zeleziarstvo-vychod';
  assert n = 0, 'only_available returned stale shop rows';

  -- sort: available first
  assert (select bool_and(is_available) from (select * from public.search_stock('kava') limit 2) s),
    'available rows must come first';

  -- no location given: search every shop in every country, no distance
  select count(*) into n from public.search_stock('8714789012351');
  assert n = 2, format('EAN without location should find SK + HU shop, got %s', n);
  assert (select bool_and(distance_km is null) from public.search_stock('8714789012351')),
    'distance must be NULL without a location';
  assert (select count(distinct shop_country) from public.search_stock('8714789012351')) = 2;

  -- with a location: radius applies, shop currency and time zone come along
  select count(*) into n from public.search_stock('kave', 47.4979, 19.0402, 10, false);
  assert n = 1, format('Budapest search should find Kávé, got %s', n);
  assert (select currency || ' ' || shop_timezone || ' ' || shop_country
          from public.search_stock('kave', 47.4979, 19.0402, 10, false)) = 'HUF Europe/Budapest HU';
  assert (select distance_km from public.search_stock('kave', 47.4979, 19.0402, 10, false)) between 1 and 3;
  select count(*) into n from public.search_stock('kave', 48.755, 21.918, 10, false);
  assert n = 0, 'Budapest shop must not appear within 10 km of Michalovce';

  -- nonsense coordinates are ignored (treated as no location)
  select count(*) into n from public.search_stock('8714789012351', 999, 999, 10, false);
  assert n = 2, 'invalid coordinates should fall back to searching everywhere';

  -- public_shops: active shops only, never private columns
  assert (select count(*) from public.public_shops) = 4, 'public_shops should list the 4 active test shops';
  assert not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'public_shops'
      and column_name in ('ico', 'is_active', 'location', 'docs_terms_accepted_at')
  ), 'public_shops exposes a private column';
  assert (select freshness_state from public.public_shops where slug = 'zeleziarstvo-vychod') = 'stale';
  assert (select round(lat::numeric, 3) from public.public_shops where slug = 'kisbolt-budapest') = 47.499;

  -- amenities are public
  assert (select has_toilet and has_douchette and has_card_terminal from public.public_shops where slug = 'potraviny-centrum');
  assert (select not has_toilet and has_card_terminal from public.public_shops where slug = 'kisbolt-budapest');

  -- shop_stock: paging, total count, accent-insensitive filter
  select count(*) into n from public.shop_stock('potraviny-centrum');
  assert n = 7, format('shop page should list all 7 items of the file, got %s', n);
  assert (select max(total_count) from public.shop_stock('potraviny-centrum', null, 2, 0)) = 7;
  select count(*) into n from public.shop_stock('potraviny-centrum', null, 2, 4);
  assert n = 2, 'third page of 2 should have 2 rows';
  select count(*) into n from public.shop_stock('potraviny-centrum', null, 2, 6);
  assert n = 1, 'fourth page of 2 should have 1 row';
  select count(*) into n from public.shop_stock('potraviny-centrum', 'cokolada');
  assert n = 1, 'cokolada should find Čokoláda';
  select count(*) into n from public.shop_stock('zeleziarstvo-vychod') where availability is not null;
  assert n = 0, 'stale shop page must not show availability';
  select count(*) into n from public.shop_stock('no-such-shop');
  assert n = 0;

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

  -- API rate limit: 60 calls per minute per caller, then refused; others unaffected
  for i in 1..60 loop
    assert public.api_hit('test-caller-hash-0001', '/api/v1/search'), format('call %s should be allowed', i);
  end loop;
  assert not public.api_hit('test-caller-hash-0001', '/api/v1/search'), '61st call in a minute must be refused';
  assert public.api_hit('test-caller-hash-0002', '/mcp'), 'another caller must not be limited';
  begin
    perform public.api_hit('short', '/x');
    raise exception 'too-short caller hash accepted';
  exception when invalid_parameter_value then null;
  end;
  -- visitors cannot read the usage log
  begin
    perform 1 from public.api_usage limit 1;
    raise exception 'anon could read api_usage';
  exception when insufficient_privilege then null;
  end;

  -- town lookup for "near <town>" (accents and case ignored)
  assert (select round(lat::numeric, 2) || ',' || round(lng::numeric, 2) from public.town_center('MICHALOVCE')) = '48.75,21.92';
  assert (select town || ' ' || country from public.town_center('budapest')) = 'Budapest HU';
  assert not exists (select 1 from public.town_center('Atlantis'));

  -- dashboard / admin functions are not for visitors
  begin
    perform * from public.owner_items((select id from public.shops where slug = 'potraviny-centrum'));
    raise exception 'anon ran owner_items';
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

  -- owners change nothing of their items: no hide switch, no renaming
  begin
    update public.shop_items set name = 'x' where source_code = 'P006';
    raise exception 'owner renamed an item';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.shop_items set updated_at = now() where source_code = 'P006';
    raise exception 'owner changed an item';
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

  -- owners set their own amenities, never another shop's
  update public.shops set has_toilet = false, has_card_terminal = true where slug = 'potraviny-centrum';
  get diagnostics n = row_count;
  assert n = 1, 'owner should set own amenities';
  update public.shops set has_toilet = true where slug = 'drogeria-kostolne';
  get diagnostics n = row_count;
  assert n = 0, 'owner A changed shop B amenities';
  update public.shops set has_toilet = true where slug = 'potraviny-centrum';

  -- dashboard item list: own shop, never another shop's; the same rule as shoppers see
  select count(*) into n from public.owner_items((select id from public.shops where slug = 'potraviny-centrum'));
  assert n = 7, format('owner should see all 7 own items, got %s', n);
  assert (select quantity || ' ' || availability
          from public.owner_items((select id from public.shops where slug = 'potraviny-centrum'), 'kava zrnkova'))
         = '14 in_stock_count';
  select count(*) into n from public.owner_items((select id from public.shops s where s.slug = 'drogeria-kostolne'));
  assert n = 0, 'owner A listed shop B items';

  -- admin-only functions refuse owners
  begin
    perform * from public.admin_shop_owners((select id from public.shops where slug = 'potraviny-centrum'));
    raise exception 'owner ran admin_shop_owners';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.user_id_by_email('owner-b@example.invalid');
    raise exception 'owner looked up a user by e-mail';
  exception when insufficient_privilege then null;
  end;

  -- stock-pull functions are not for owners
  begin
    perform public.apply_stock_file((select id from public.shops where slug = 'potraviny-centrum'), '[]', now());
    raise exception 'owner applied a stock file';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.sync_credentials((select id from public.shops where slug = 'potraviny-centrum'));
    raise exception 'owner read sync credentials';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.admin_set_sync_credentials((select id from public.shops where slug = 'potraviny-centrum'), '{}');
    raise exception 'owner set sync credentials';
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

\echo '--- nothing can change how stock is shown'
do $$ begin
  assert not exists (select 1 from information_schema.columns
                     where table_schema = 'public'
                       and ((table_name = 'shops' and column_name in ('visibility_mode', 'low_stock_threshold'))
                            or (table_name = 'shop_items' and column_name = 'is_public'))),
    'the old display settings are gone';
  assert to_regprocedure('public.availability_preview(integer)') is null, 'availability_preview is gone';
  assert to_regprocedure('public.availability_label(text, numeric, integer, text)') is null;
  assert to_regprocedure('public.admin_save_shop(jsonb)') is null and to_regprocedure('public.admin_shops()') is null,
    'the legacy admin functions that set the display are gone';
  assert not exists (select 1 from pg_policies where tablename = 'shop_items' and cmd = 'UPDATE'),
    'no update path on items for owners';
  assert public.availability_label(-2, 'current') = 'out_of_stock', 'sold out at less than 0';
  assert public.availability_label(0.5, 'recent') = 'in_stock_count';
  assert public.availability_label(12, 'stale') is null, 'nothing while stale';
end $$;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
begin
  -- the owner's shop form cannot carry a display setting any more
  perform public.owner_save_shop(jsonb_build_object('id', v_b, 'name', 'Drogéria Kostolné', 'timezone', 'Europe/Bratislava',
    'country', 'SK', 'city', 'Michalovce', 'address', 'Kostolné námestie 4', 'lat', '48.757', 'lng', '21.914',
    'is_active', 'true', 'visibility_mode', 'yes_no', 'low_stock_threshold', '10'));
end $$;
reset role;
reset request.jwt.claim.sub;
set role anon;
do $$
begin
  assert (select quantity || ' ' || availability from public.public_stock where item_name = 'Zubná pasta 75 ml')
         = '12 in_stock_count', 'still the quantity as in the file';
  assert (select quantity || ' ' || availability from public.public_stock where item_name = 'Prací prášok 3 kg')
         = '0 out_of_stock';
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
    update public.sync_sources set sample_rows = '[]';
    raise exception 'admin wrote sample_rows';
  exception when insufficient_privilege then null;
  end;

  -- tunnel credentials: write-only for the admin
  perform public.admin_set_sync_credentials((select id from public.shops where slug = 'potraviny-centrum'),
    '{"cf_client_id":"id-1","cf_client_secret":"s3cret","basic_user":"ppi","basic_password":"pw"}');
  assert (select public.admin_sync_credentials_status((select id from public.shops where slug = 'potraviny-centrum')))
         = '{"cloudflare": true, "basic_auth": true}'::jsonb;
  perform public.admin_set_sync_credentials((select id from public.shops where slug = 'potraviny-centrum'),
    '{"cf_client_id":"id-2","cf_client_secret":"s3cret2"}');
  assert (select public.admin_sync_credentials_status((select id from public.shops where slug = 'potraviny-centrum')))
         = '{"cloudflare": true, "basic_auth": false}'::jsonb, 'update must replace the secret';
  begin
    perform public.sync_credentials((select id from public.shops where slug = 'potraviny-centrum'));
    raise exception 'admin could read the secret values';
  exception when insufficient_privilege then null;
  end;

  -- legacy owner lookup still works for the admin
  assert (select email from public.admin_shop_owners((select id from public.shops where slug = 'potraviny-centrum')))
         = 'owner-a@example.invalid';
  begin
    update public.shops set timezone = 'Mars/Olympus' where slug = 'kisbolt-budapest';
    raise exception 'unknown time zone accepted';
  exception when invalid_parameter_value then null;
  end;
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
  assert (select count(*) from public.public_shops where slug = 'zeleziarstvo-vychod') = 0,
    'inactive shop must disappear from public_shops';
end;
$$;
reset role;

\echo '--- service role (stock pull) can write stock'
set role service_role;
update public.inventory set quantity = 0 where shop_item_id in (select id from public.shop_items where source_code = 'P001');
update public.sync_sources set latest_file_time = now(), sample_rows = '[{"code":"P001"}]';
do $$ begin
  assert public.user_id_by_email('OWNER-B@example.invalid') = '00000000-0000-0000-0000-00000000000b';
end $$;

-- stock pull: apply a full file for Potraviny Centrum
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_result jsonb;
begin
  assert public.sync_credentials(v_shop) ->> 'cf_client_id' = 'id-2', 'service role reads credentials';
  v_result := public.apply_stock_file(v_shop, '[
    {"source_code":"P001","name":"Káva zrnková 1 kg","ean":"8000070012345","brand":"Lavazza","quantity":7,"price":19.5},
    {"source_code":"P100","name":"Kakao 100 g","ean":"5900000000001","quantity":"3","price":"2.2","currency":"eur"},
    {"source_code":"P100","name":"duplicate code ignored","quantity":1,"price":1},
    {"source_code":"","name":"no code, ignored","quantity":1,"price":1},
    {"source_code":"P003","name":"Mlieko polotučné 1 l","quantity":40,"price":1.09}
  ]', '2026-10-04 08:15:00+00', '[{"KOD":"P001"}]');
  assert v_result = '{"items": 3, "zeroed": 4}'::jsonb, format('unexpected result %s', v_result);
  assert (select quantity || '/' || price from public.inventory i join public.shop_items si on si.id = i.shop_item_id
          where si.shop_id = v_shop and si.source_code = 'P001') = '7/19.5';
  assert (select quantity || ' ' || currency from public.inventory i join public.shop_items si on si.id = i.shop_item_id
          where si.shop_id = v_shop and si.source_code = 'P100') = '3 EUR', 'new item added';
  assert (select quantity from public.inventory i join public.shop_items si on si.id = i.shop_item_id
          where si.shop_id = v_shop and si.source_code = 'P002') = 0, 'item missing from file must be zeroed';
  assert (select product_id is not null from public.shop_items where shop_id = v_shop and source_code = 'P100'),
    'item linked to product by EAN';
  assert (select latest_file_time = '2026-10-04 08:15:00+00' and last_error is null and sample_rows = '[{"KOD":"P001"}]'
          from public.sync_sources where shop_id = v_shop);
  -- an item missing from the file stays listed, sold out
  assert (select count(*) from public.public_stock where shop_id = v_shop and item_name = 'Čaj zelený 20 vreciek') = 1;
  assert (select i.quantity from public.inventory i join public.shop_items si on si.id = i.shop_item_id
          where si.shop_id = v_shop and si.source_code = 'P007') = 0;
end $$;
reset role;

\echo '--- folder upload check-in'
set role anon;
do $$
begin
  perform public.upload_check_in((select id from public.public_shops where slug = 'potraviny-centrum'));
  raise exception 'visitor checked in as a shop PC';
exception when insufficient_privilege then null;
end $$;
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_status jsonb;
begin
  v_status := public.upload_check_in((select id from public.shops where slug = 'potraviny-centrum'));
  assert v_status ->> 'latest_file_time' is not null and v_status ->> 'mapping_status' in ('proposed', 'confirmed')
         and (v_status ->> 'folder_seen_at')::timestamptz > now() - interval '1 minute',
    format('owner check-in returns the status and records the PPI window: %s', v_status);
  begin
    perform public.upload_check_in((select id from public.shops s where s.slug = 'drogeria-kostolne'));
    raise exception 'owner A checked in for shop B';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

-- the admin can check in for any shop; a shop without a stock source gets one
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000ad';
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'kisbolt-budapest');
begin
  delete from public.sync_sources where shop_id = v_shop;
  assert public.upload_check_in(v_shop) ->> 'freshness_state' = 'stale', 'new source starts stale';
  assert (select folder_seen_at is not null and file_url is null from public.sync_sources where shop_id = v_shop),
    'check-in creates the stock source';
end $$;
reset role;
reset request.jwt.claim.sub;

\echo '--- self-service: a new owner creates and runs a shop'
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000c', 'owner-c@example.invalid');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
do $$
declare
  v_shop uuid;
  v_other uuid;
  n int;
begin
  assert (select count(*) from public.my_shops()) = 0, 'a new account has no shops';
  v_shop := public.owner_save_shop('{"name":"Corner Shop","slug_base":"Potraviny Centrum","city":"Graz","country":"at",
    "timezone":"Europe/Vienna","lat":"47.07","lng":"15.44","opening_hours":{"mon":[["08:00","18:00"]]}}');
  assert (select slug from public.shops where id = v_shop) = 'potraviny-centrum-2', 'slug made unique';
  assert (select country || ' ' || timezone || ' ' || is_active from public.shops where id = v_shop) = 'AT Europe/Vienna true';
  assert (select round(lat::numeric, 2) || ',' || round(lng::numeric, 2) from public.my_shops() where id = v_shop) = '47.07,15.44';
  assert (select mapping_status = 'proposed' from public.my_shops() where id = v_shop), 'new shop has a stock source';

  -- the owner edits it, but cannot touch another owner's shop
  perform public.owner_save_shop(jsonb_build_object('id', v_shop, 'name', 'Corner Shop Graz', 'is_active', false,
    'timezone', 'Europe/Vienna'));
  assert (select name || ' ' || is_active from public.shops where id = v_shop) = 'Corner Shop Graz false';
  v_other := (select id from public.shops where slug = 'drogeria-kostolne');
  begin
    perform public.owner_save_shop(jsonb_build_object('id', v_other, 'name', 'taken over'));
    raise exception 'owner C changed shop B';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.owner_set_mapping(v_other, '{"source_code":"a","name":"b","quantity":"c","price":"d"}');
    raise exception 'owner C approved shop B columns';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.owner_delete_shop(v_other);
    raise exception 'owner C deleted shop B';
  exception when insufficient_privilege then null;
  end;

  -- column approval: required fields, then confirmed
  begin
    perform public.owner_set_mapping(v_shop, '{"source_code":"KOD","name":"NAZOV"}');
    raise exception 'mapping without quantity/price accepted';
  exception when invalid_parameter_value then null;
  end;
  perform public.owner_set_mapping(v_shop, '{"source_code":"KOD","name":"NAZOV","quantity":"MN","price":"CENA","extra":"x"}');
  assert (select mapping_status = 'confirmed' and field_mapping ->> 'price' = 'CENA' and not field_mapping ? 'extra'
          and field_mapping ? 'ean' from public.my_shops() where id = v_shop), 'mapping saved and approved';

  -- at most 5 shops per account
  for n in 2..5 loop
    perform public.owner_save_shop(jsonb_build_object('name', 'Shop ' || n, 'slug_base', 'shop'));
  end loop;
  begin
    perform public.owner_save_shop('{"name":"Shop 6","slug_base":"shop"}');
    raise exception 'sixth shop allowed';
  exception when program_limit_exceeded then null;
  end;

  -- delete own shop
  perform public.owner_delete_shop(v_shop);
  assert not exists (select 1 from public.shops where id = v_shop), 'own shop deleted';
end $$;
reset role;
reset request.jwt.claim.sub;

set role anon;
do $$
begin
  perform public.owner_save_shop('{"name":"anon shop"}');
  raise exception 'visitor created a shop';
exception when insufficient_privilege then null;
end $$;
reset role;

\echo '--- search finds a shop by its name, street or town'
set role anon;
do $$
begin
  assert (select count(*) from public.search_stock('drogeria kostolne')) > 0, 'shop name finds its items';
  assert (select bool_and(shop_slug = 'drogeria-kostolne') from public.search_stock('Drogéria Kostolné')), 'only that shop';
  assert (select count(*) from public.search_stock('Kostolne namestie')) > 0, 'street finds the shop''s items';
  assert (select count(*) from public.search_stock('budapest')) > 0, 'town finds its shops'' items';
end $$;
reset role;

\echo '--- no cloud links: stock arrives only by upload'
do $$
begin
  assert to_regprocedure('public.owner_set_file_url(uuid, text)') is null, 'owners can no longer save a cloud link';
  assert pg_get_function_result('public.my_shops()'::regprocedure) not like '%file_url%', 'my_shops() has no file_url';
  assert not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'sync_sources' and column_name = 'last_file_hash'),
    'last_file_hash is dropped';
  assert not exists (select 1 from cron.job where jobname = 'ppi-stock-pull'), 'the 15-minute download schedule is stopped';
  assert exists (select 1 from cron.job where jobname = 'some-other-job'), 'other scheduled jobs are left alone';
end $$;

\echo '--- item names in three languages: search across languages'
set role service_role;
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_item uuid;
begin
  -- a paint written with a shop abbreviation, as the shop's software exports it
  insert into public.shop_items (shop_id, source_code, name, brand)
  values (v_shop, 'D900', 'Farba fas. biela 5L', 'Primalex') returning id into v_item;
  insert into public.inventory (shop_item_id, quantity, price, currency, source_updated_at)
  values (v_item, 4, 24.90, 'EUR', now());
  assert exists (select 1 from public.items_to_translate(v_shop) where item_id = v_item), 'a new name waits for translation';
  assert public.apply_item_translations(v_shop, jsonb_build_array(jsonb_build_object(
    'item_id', v_item, 'source', 'Farba fas. biela 5L', 'lang', 'sk',
    'sk', 'Fasádna farba biela 5 l', 'hu', 'Homlokzatfesték fehér 5 l', 'en', 'White facade paint 5 l'))) = 1;
  assert not exists (select 1 from public.items_to_translate(v_shop) where item_id = v_item), 'translated names are not asked again';
  -- a translation made from an older name is not saved
  assert public.apply_item_translations(v_shop, jsonb_build_array(jsonb_build_object(
    'item_id', v_item, 'source', 'Farba biela', 'lang', 'sk', 'sk', 'x', 'hu', 'x', 'en', 'x'))) = 0, 'outdated translation skipped';
  -- the trigram index covers the original name and all three translations
  perform set_config('enable_seqscan', 'off', true);
  declare
    v_plan text := '';
    v_line record;
  begin
    -- since update 42 the same text is the stored column names_search with its own index
    for v_line in execute 'explain select id from public.shop_items where names_search like ''%white%''' loop
      v_plan := v_plan || v_line."QUERY PLAN" || ' ';
    end loop;
    assert v_plan like '%shop_items_names_search_col_idx%', 'name search uses the index: ' || v_plan;
  end;
end $$;
reset role;

set role anon;
do $$
declare
  v_q text;
begin
  -- Slovak, Hungarian and English words, any order, accents and case ignored
  foreach v_q in array array['white paint', 'fehér festék', 'biela farba', 'FESTEK', 'paint white 5 l', 'farba fas'] loop
    assert exists (select 1 from public.search_stock(v_q) where item_name = 'Farba fas. biela 5L'),
      format('search_stock(%L) should find the paint', v_q);
    assert exists (select 1 from public.shop_stock('drogeria-kostolne', v_q) where item_name = 'Farba fas. biela 5L'),
      format('shop_stock(%L) should find the paint', v_q);
  end loop;
  -- words of the item and of the shop together; every word must match
  assert exists (select 1 from public.search_stock('white paint kostolne') where item_name = 'Farba fas. biela 5L');
  assert not exists (select 1 from public.search_stock('white chocolate') where item_name = 'Farba fas. biela 5L');
  -- a word together with an EAN
  assert exists (select 1 from public.search_stock('kava 8000070012345') where ean = '8000070012345'), 'word + EAN';
  -- results carry the translations and the language of the original name
  assert (select item_name_i18n ->> 'en' || ' / ' || item_name_lang from public.search_stock('fehér festék')
          where item_name = 'Farba fas. biela 5L') = 'White facade paint 5 l / sk';
  assert (select item_name_i18n ->> 'hu' from public.public_stock where item_name = 'Farba fas. biela 5L') = 'Homlokzatfesték fehér 5 l';
  -- visitors cannot write translations
  begin
    perform public.apply_item_translations((select id from public.public_shops where slug = 'drogeria-kostolne'), '[]');
    raise exception 'visitor saved translations';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

\echo '--- the owner corrects a translation; a new stock file keeps it'
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_item uuid := (select id from public.shop_items where source_code = 'D900');
begin
  perform public.owner_set_item_translation(v_item,
    '{"sk":"Fasádna farba biela 5 l","hu":"Fehér homlokzatfesték 5 l","en":"White exterior wall paint 5 l"}');
  assert (select name_i18n ->> 'en' || ' ' || name_i18n_by_owner from public.owner_items(v_shop, 'exterior wall')
          where item_id = v_item) = 'White exterior wall paint 5 l true', 'the owner sees and finds the correction';
  begin
    perform public.owner_set_item_translation((select id from public.shop_items where source_code = 'P001'), '{"en":"x"}');
    raise exception 'owner B corrected an item of shop A';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.owner_set_item_translation(v_item, '{"sk":" "}');
    raise exception 'an empty correction was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    update public.shop_items set name_i18n = '{"en":"x"}' where id = v_item;
    raise exception 'owner wrote name_i18n directly';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.items_to_translate(v_shop);
    raise exception 'owner read the translation queue';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

set role service_role;
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_item uuid := (select id from public.shop_items where source_code = 'D900');
begin
  -- the shop's next stock file, with the name now written differently
  perform public.apply_stock_file(v_shop,
    '[{"source_code":"D900","name":"Farba fasadna biela 5L","brand":"Primalex","quantity":3,"price":24.9}]', now());
  assert (select quantity from public.inventory where shop_item_id = v_item) = 3, 'the new file was applied';
  assert (select name_i18n ->> 'en' || ' ' || name_i18n_by_owner from public.shop_items where id = v_item)
         = 'White exterior wall paint 5 l true', 'the correction survives a new file';
  assert not exists (select 1 from public.items_to_translate(v_shop) where item_id = v_item), 'a corrected item is never sent to translation';
  assert public.apply_item_translations(v_shop, jsonb_build_array(jsonb_build_object(
    'item_id', v_item, 'source', 'Farba fasadna biela 5L', 'lang', 'sk', 'sk', 'a', 'hu', 'b', 'en', 'c'))) = 0,
    'a machine translation never overwrites the owner';
  assert (select name_i18n ->> 'en' from public.shop_items where id = v_item) = 'White exterior wall paint 5 l';
end $$;
reset role;

-- the owner hands the item back to the automatic translation
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$ begin
  perform public.owner_set_item_translation((select id from public.shop_items where source_code = 'D900'), null);
end $$;
reset role;
reset request.jwt.claim.sub;
set role service_role;
do $$
declare
  v_item uuid := (select id from public.shop_items where source_code = 'D900');
begin
  assert exists (select 1 from public.items_to_translate((select id from public.shops where slug = 'drogeria-kostolne'))
                 where item_id = v_item), 'back to automatic: translated again with the next file';
  assert exists (select 1 from public.search_stock('exterior wall paint') where item_id = v_item),
    'the last translation stays searchable until then';
end $$;
reset role;

\echo '--- AI search limits'
set role anon;
do $$
declare
  i int;
begin
  for i in 1..10 loop
    assert public.ai_search_hit(repeat('a', 64), 1000), format('AI search %s allowed', i);
  end loop;
  assert not public.ai_search_hit(repeat('a', 64), 1000), 'the 11th AI search in a minute is refused';
  assert public.ai_search_hit(repeat('b', 64), 1000), 'another caller is still allowed';
  -- the daily total for the whole site (11 so far today)
  assert not public.ai_search_hit(repeat('c', 64), 11), 'daily limit reached';
  assert public.ai_search_hit(repeat('c', 64), 12), 'below the daily limit';
  begin
    perform public.ai_search_hit('short', 100);
    raise exception 'invalid caller hash accepted';
  exception when invalid_parameter_value then null;
  end;
end $$;
reset role;

\echo '--- paid plan: only the service role writes subscriptions; shop_has_plan'
set role service_role;
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
begin
  assert not public.shop_has_plan(v_a), 'no subscription row: no plan';
  assert public.link_stripe_customer(v_a, 'cus_A1') = 'cus_A1', 'customer linked';
  assert public.link_stripe_customer(v_a, 'cus_A2') = 'cus_A1', 'the first customer stays';
  assert (select status from public.subscriptions where shop_id = v_a) = 'none';
  assert not public.shop_has_plan(v_a), 'a customer without a subscription is no plan';

  assert public.apply_stripe_subscription(v_a, 'cus_A1', 'sub_A1', 'active', 'pro', now() + interval '30 days', null);
  assert public.shop_has_plan(v_a), 'active and inside the period: plan';
  assert public.apply_stripe_subscription(v_b, 'cus_B1', 'sub_B1', 'trialing', 'pro', now() + interval '7 days', null);
  assert public.shop_has_plan(v_b), 'trialing inside the period: plan';

  perform public.apply_stripe_subscription(v_b, 'cus_B1', 'sub_B1', 'active', 'pro', now() - interval '1 minute', null);
  assert not public.shop_has_plan(v_b), 'past current_period_end: no plan';
  perform public.apply_stripe_subscription(v_b, 'cus_B1', 'sub_B1', 'trialing', 'pro', now() - interval '1 minute', null);
  assert not public.shop_has_plan(v_b), 'trial past its end: no plan';
  perform public.apply_stripe_subscription(v_b, 'cus_B1', 'sub_B1', 'active', 'pro', null, null);
  assert not public.shop_has_plan(v_b), 'no period end: no plan';
  perform public.apply_stripe_subscription(v_b, 'cus_B1', 'sub_B1', 'past_due', 'pro', now() + interval '30 days', null);
  assert not public.shop_has_plan(v_b), 'past_due: no plan';
  perform public.apply_stripe_subscription(v_b, 'cus_B1', 'sub_B1', 'unpaid', 'pro', now() + interval '30 days', null);
  assert not public.shop_has_plan(v_b), 'unpaid: no plan';
  perform public.apply_stripe_subscription(v_b, 'cus_B1', 'sub_B1', 'paused', 'pro', now() + interval '30 days', null);
  assert not public.shop_has_plan(v_b), 'paused: no plan';
  perform public.apply_stripe_subscription(v_b, 'cus_B1', 'sub_B1', 'incomplete', 'pro', now() + interval '30 days', null);
  assert not public.shop_has_plan(v_b), 'incomplete: no plan';
  perform public.apply_stripe_subscription(v_b, 'cus_B1', 'sub_B1', 'canceled', 'pro', now() + interval '30 days', null);
  assert not public.shop_has_plan(v_b), 'canceled: no plan';
  perform public.apply_stripe_subscription(v_b, 'cus_B1', 'sub_B1', 'active', 'pro', now() + interval '30 days',
                                           now() + interval '30 days');
  assert public.shop_has_plan(v_b), 'cancelled at the period end: still the plan until then';

  -- a new subscription replaces an ended one; a late event about the old one changes nothing
  perform public.apply_stripe_subscription(v_b, 'cus_B1', 'sub_B1', 'canceled', 'pro', now(), null);
  assert public.apply_stripe_subscription(v_b, 'cus_B1', 'sub_B2', 'active', 'pro', now() + interval '30 days', null),
    'a new live subscription replaces the ended one';
  assert not public.apply_stripe_subscription(v_b, 'cus_B1', 'sub_B1', 'canceled', 'pro', now(), null),
    'an ended subscription never replaces the live one';
  assert (select stripe_subscription_id || ' ' || status from public.subscriptions where shop_id = v_b) = 'sub_B2 active';
  assert public.shop_has_plan(v_b);

  assert not public.apply_stripe_subscription(gen_random_uuid(), 'cus_X1', 'sub_X1', 'active', 'pro', now(), null),
    'unknown shop: nothing written';
  begin
    perform public.apply_stripe_subscription(v_b, 'cus_B1', 'sub_B2', 'gold', 'pro', now(), null);
    raise exception 'unknown status accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.link_stripe_customer(v_b, 'not-a-customer');
    raise exception 'invalid customer id accepted';
  exception when invalid_parameter_value then null;
  end;
end $$;
reset role;

-- owner A reads only their own row and can never write one
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
begin
  assert (select count(*) from public.subscriptions) = 1, 'owner A sees only their own subscription';
  assert (select stripe_subscription_id from public.subscriptions where shop_id = v_a) = 'sub_A1';
  assert public.shop_has_plan(v_a);
  begin
    insert into public.subscriptions (shop_id, status) values (gen_random_uuid(), 'none');
    raise exception 'owner inserted a subscription';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.subscriptions set status = 'active', current_period_end = now() + interval '10 years';
    raise exception 'owner changed a subscription';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.subscriptions;
    raise exception 'owner deleted a subscription';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.apply_stripe_subscription(v_a, 'cus_A1', 'sub_A9', 'active', 'pro', now() + interval '10 years', null);
    raise exception 'owner wrote the subscription through the webhook function';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.link_stripe_customer(v_a, 'cus_A9');
    raise exception 'owner linked a customer';
  exception when insufficient_privilege then null;
  end;
  -- a shop whose plan still renews cannot be deleted (it would keep being charged)
  begin
    perform public.owner_delete_shop(v_a);
    raise exception 'shop with a renewing plan deleted';
  exception when object_not_in_prerequisite_state then null;
  end;
  assert exists (select 1 from public.shops where id = v_a), 'the shop is still there';
end $$;
reset role;
reset request.jwt.claim.sub;

-- visitors: no subscription data, but anyone may ask whether a shop has the plan
set role anon;
do $$ begin
  begin
    perform count(*) from public.subscriptions;
    raise exception 'visitor read subscriptions';
  exception when insufficient_privilege then null;
  end;
  assert public.shop_has_plan((select id from public.shops where slug = 'potraviny-centrum'));
  assert not public.shop_has_plan((select id from public.shops where slug = 'zeleziarstvo-vychod'));
end $$;
reset role;

-- once the plan is cancelled at the period end, the owner can delete the shop
set role service_role;
do $$
declare
  v_c uuid := (select s.id from public.shops s join public.shop_members m on m.shop_id = s.id
               where m.user_id = '00000000-0000-0000-0000-00000000000c' order by s.created_at, s.slug limit 1);
begin
  assert v_c is not null, 'owner C still has a shop';
  perform public.link_stripe_customer(v_c, 'cus_C1');
  perform public.apply_stripe_subscription(v_c, 'cus_C1', 'sub_C1', 'active', 'pro', now() + interval '30 days', null);
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
do $$
declare
  v_c uuid := (select s.id from public.shops s join public.shop_members m on m.shop_id = s.id
               where m.user_id = '00000000-0000-0000-0000-00000000000c' order by s.created_at, s.slug limit 1);
begin
  begin
    perform public.owner_delete_shop(v_c);
    raise exception 'owner C deleted a shop with a renewing plan';
  exception when object_not_in_prerequisite_state then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;
set role service_role;
do $$
declare
  v_c uuid := (select shop_id from public.subscriptions where stripe_customer_id = 'cus_C1');
begin
  perform public.apply_stripe_subscription(v_c, 'cus_C1', 'sub_C1', 'active', 'pro', now() + interval '30 days',
                                           now() + interval '30 days');
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
do $$
declare
  v_c uuid := (select s.id from public.shops s join public.shop_members m on m.shop_id = s.id
               where m.user_id = '00000000-0000-0000-0000-00000000000c' order by s.created_at, s.slug limit 1);
begin
  perform public.owner_delete_shop(v_c);
  assert not exists (select 1 from public.shops where id = v_c), 'shop with a plan that ends deleted';
  assert not exists (select 1 from public.subscriptions where shop_id = v_c), 'its plan row went with it';
end $$;
reset role;
reset request.jwt.claim.sub;

\echo '--- shop assistant: paid plan, 20 messages an hour per caller, monthly cap per shop'
set role anon;
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');      -- has the plan (above)
  v_none uuid := (select id from public.shops where slug = 'zeleziarstvo-vychod'); -- no plan
  i int;
begin
  assert public.shop_chat_hit(repeat('d', 64), v_none, 20, 1000) = 'no_plan', 'no paid plan: no assistant';
  for i in 1..20 loop
    assert public.shop_chat_hit(repeat('d', 64), v_a, 20, 1000) = 'ok', format('message %s allowed', i);
  end loop;
  assert public.shop_chat_hit(repeat('d', 64), v_a, 20, 1000) = 'caller_limit', 'the 21st message in an hour is refused';
  assert public.shop_chat_hit(repeat('e', 64), v_a, 20, 1000) = 'ok', 'another caller is still allowed';
  -- 21 messages counted for the shop this month
  assert public.shop_chat_hit(repeat('f', 64), v_a, 20, 21) = 'shop_limit', 'monthly cap reached';
  assert public.shop_chat_hit(repeat('f', 64), v_a, 20, 22) = 'ok', 'below the monthly cap';
  assert public.shop_chat_hit(repeat('f', 64), v_a, 20, 0) = 'shop_limit', 'cap 0 switches the assistant off';
  begin
    perform public.shop_chat_hit('short', v_a, 20, 1000);
    raise exception 'invalid caller hash accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform count(*) from public.shop_chat_usage;
    raise exception 'visitor read the assistant usage';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set role service_role;
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
begin
  assert (select messages from public.shop_chat_usage
          where shop_id = v_a and month = date_trunc('month', now() at time zone 'UTC')::date) = 22,
    'only allowed messages are counted, per shop and month';
  assert (select count(*) from public.api_usage where endpoint = 'shop-chat') = 22, 'each allowed message logged once';
  -- the plan ends (payment failed): the assistant stops at once
  perform public.apply_stripe_subscription(v_a, 'cus_A1', 'sub_A1', 'past_due', 'pro', now() + interval '30 days', null);
  assert public.shop_chat_hit(repeat('g', 64), v_a, 20, 1000) = 'no_plan', 'no assistant without a paid plan';
end $$;
reset role;

\echo '--- documents for the assistant: folders, keys, sessions, search, files'
-- Both test shops get the paid plan; owner A accepts the terms and makes two private folders.
set role service_role;
do $$ begin
  perform public.apply_stripe_subscription((select id from public.shops where slug = 'potraviny-centrum'),
    'cus_A1', 'sub_A1', 'active', 'pro', now() + interval '30 days', null);
  assert (select count(*) from public.shops s
          where not exists (select 1 from public.shop_folders f where f.shop_id = s.id and f.is_public)) = 0,
    'every shop has its Public folder';
end $$;
reset role;

set role anon;
do $$
declare
  t text;
begin
  foreach t in array array['shop_folders', 'shop_documents', 'shop_pictures', 'shop_document_chunks',
                           'folder_keys', 'folder_sessions'] loop
    begin
      execute format('select count(*) from public.%I', t);
      raise exception 'visitor read %', t;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    perform public.owner_save_folder((select id from public.shops where slug = 'potraviny-centrum'), null, 'X');
    raise exception 'visitor made a folder';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.docs_visible_folders((select id from public.shops where slug = 'potraviny-centrum'), null);
    raise exception 'visitor asked which folders are visible';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.shop_file_path('potraviny-centrum', 'document', gen_random_uuid(), null);
    raise exception 'visitor asked for a file path';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_w uuid;
  v_s uuid;
  v_key text;
begin
  perform public.owner_accept_docs_terms(v_a);
  v_w := public.owner_save_folder(v_a, null, 'Veľkoobchod');
  v_s := public.owner_save_folder(v_a, null, 'Servis');
  perform set_config('ppi.folder_w', v_w::text, false);
  perform set_config('ppi.folder_s', v_s::text, false);
  assert (select count(*) from public.shop_folders) = 3, 'owner A sees only their own three folders';
  begin
    perform public.owner_save_folder(v_a, null, 'veľkoobchod');
    raise exception 'two folders with one name';
  exception when unique_violation then null;
  end;
  begin
    perform public.owner_save_folder(v_a, (select id from public.shop_folders where shop_id = v_a and is_public), 'Iné');
    raise exception 'the Public folder renamed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.owner_save_folder(v_b, null, 'Cudzí');
    raise exception 'owner A made a folder in shop B';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.owner_accept_docs_terms(v_b);
    raise exception 'owner A accepted terms for shop B';
  exception when insufficient_privilege then null;
  end;

  -- keys: shown once, in groups of four; stored only as a hash
  v_key := public.owner_create_folder_key(v_a, 'Partner Veľkoobchod', array[v_w], null);
  assert v_key ~ '^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){4}$', format('key format: %s', v_key);
  perform set_config('ppi.key_w', v_key, false);
  perform set_config('ppi.key_s', public.owner_create_folder_key(v_a, 'Servis 1 day', array[v_s], now() + interval '1 day'), false);
  perform set_config('ppi.key_r', public.owner_create_folder_key(v_a, 'To revoke', array[v_w], null), false);
  perform set_config('ppi.key_all', public.owner_create_folder_key(v_a, 'Both', array[v_w, v_s], null), false);
  assert (select count(*) from public.folder_keys) = 4;
  begin
    perform key_hash from public.folder_keys;
    raise exception 'owner read a key hash';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.owner_create_folder_key(v_a, 'Public', array[(select id from public.shop_folders where shop_id = v_a and is_public)], null);
    raise exception 'a key for the Public folder';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.owner_create_folder_key(v_a, 'Made up', array[gen_random_uuid()], null);
    raise exception 'a key for a made-up folder';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.owner_create_folder_key(v_a, 'Past', array[v_w], now() - interval '1 minute');
    raise exception 'a key that has already expired';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.docs_register_document(v_a, v_w, 'X', null, 1, 1, 30, 500);
    raise exception 'owner registered a document without doc-ingest';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.shop_folders (shop_id, name) values (v_a, 'Direct');
    raise exception 'owner wrote a folder directly';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

-- doc-ingest (service role): four PDFs, their text, pictures and a scanned page
set role service_role;
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_pub uuid := (select id from public.shop_folders where shop_id = v_a and is_public);
  v_w uuid := current_setting('ppi.folder_w')::uuid;
  v_s uuid := current_setting('ppi.folder_s')::uuid;
  v_doc uuid;
  v_path text;
  v_pic uuid;
  r record;
  n int;
begin
  select document_id, storage_path into v_doc, v_path
  from public.docs_register_document(v_a, v_pub, 'Katalóg 2026', 'Záhrada', 10, 1000, 30, 500);
  assert v_path = v_a || '/docs/' || v_doc || '.pdf', 'files live in a folder per shop';
  perform set_config('ppi.doc_p', v_doc::text, false);
  select document_id into v_doc from public.docs_register_document(v_a, v_w, 'Veľkoobchodný cenník 2026', null, 2, 1000, 30, 500);
  perform set_config('ppi.doc_w', v_doc::text, false);
  select document_id into v_doc from public.docs_register_document(v_a, v_s, 'Servisný manuál', null, 5, 1000, 30, 500);
  perform set_config('ppi.doc_s', v_doc::text, false);
  select document_id into v_doc from public.docs_register_document(v_a, v_pub, 'Stará akcia', null, 1, 1000, 30, 500);
  perform set_config('ppi.doc_off', v_doc::text, false);
  select document_id into v_doc from public.docs_register_document(v_a, v_pub, 'Nedokončený', null, 1, 1000, 30, 500);
  perform set_config('ppi.doc_up', v_doc::text, false);

  -- limits, terms, plan, folder
  begin
    perform public.docs_register_document(v_a, v_pub, 'Too many', null, 1, 1000, 5, 500);
    raise exception 'file limit ignored';
  exception when raise_exception then assert sqlerrm = 'limit_files', sqlerrm;
  end;
  begin
    perform public.docs_register_document(v_a, v_pub, 'Too long', null, 500, 1000, 30, 500);
    raise exception 'page limit ignored';
  exception when raise_exception then assert sqlerrm = 'limit_pages', sqlerrm;
  end;
  begin
    perform public.docs_register_document(v_b, (select id from public.shop_folders where shop_id = v_b and is_public),
                                          'No terms', null, 1, 1000, 30, 500);
    raise exception 'terms not accepted, still registered';
  exception when raise_exception then assert sqlerrm = 'terms', sqlerrm;
  end;
  begin
    perform public.docs_register_document(v_a, (select id from public.shop_folders where shop_id = v_b and is_public),
                                          'Other shop folder', null, 1, 1000, 30, 500);
    raise exception 'registered into another shop''s folder';
  exception when raise_exception then assert sqlerrm = 'folder', sqlerrm;
  end;
  begin
    perform public.docs_register_document((select id from public.shops where slug = 'zeleziarstvo-vychod'),
      (select f.id from public.shop_folders f join public.shops s on s.id = f.shop_id
       where s.slug = 'zeleziarstvo-vychod' and f.is_public), 'No plan', null, 1, 1000, 30, 500);
    raise exception 'registered without the paid plan';
  exception when raise_exception then assert sqlerrm = 'no_plan', sqlerrm;
  end;

  -- text as written, page by page
  foreach v_doc in array array[current_setting('ppi.doc_p'), current_setting('ppi.doc_w'),
                               current_setting('ppi.doc_s'), current_setting('ppi.doc_off')]::uuid[] loop
    assert public.docs_document_uploaded(v_doc);
  end loop;
  assert not public.docs_document_uploaded(current_setting('ppi.doc_p')::uuid), 'uploaded only once';
  n := public.docs_save_text(current_setting('ppi.doc_p')::uuid,
    '[{"page": 4, "text": "Záhradná hadica Flexi 25 m, odolná voči UV žiareniu."},
      {"page": 1, "text": "Katalóg záhradnej techniky 2026"},
      {"page": 99, "text": "a page the PDF does not have"}]', 'sk');
  assert n = 2, format('two pages saved, the one outside the PDF ignored (%s)', n);
  perform public.docs_save_text(current_setting('ppi.doc_p')::uuid,
    '[{"page": 4, "text": "Záhradná hadica Flexi 25 m, odolná voči UV žiareniu. Cena 21,90 €."}]', 'hu');
  assert (select count(*) from public.shop_document_chunks where document_id = current_setting('ppi.doc_p')::uuid and page = 4) = 1,
    'saving a page again replaces its text';
  assert (select lang from public.shop_documents where id = current_setting('ppi.doc_p')::uuid) = 'sk',
    'the document keeps the first language found';
  perform public.docs_save_text(current_setting('ppi.doc_w')::uuid,
    '[{"page": 2, "text": "Veľkoobchodná cena hadice Flexi 25 m: 18,40 € bez DPH."}]', 'sk');
  perform public.docs_save_text(current_setting('ppi.doc_s')::uuid,
    '[{"page": 3, "text": "Výmena tesnenia čerpadla Hydro 300: povoľte štyri skrutky."}]', 'sk');
  perform public.docs_save_text(current_setting('ppi.doc_off')::uuid,
    '[{"page": 1, "text": "Tajná akcia: hadica Flexi zadarmo."}]', 'sk');
  begin
    perform public.docs_save_text(current_setting('ppi.doc_up')::uuid, '[{"page": 1, "text": "x"}]', 'sk');
    raise exception 'text saved before the file was uploaded';
  exception when raise_exception then assert sqlerrm = 'document', sqlerrm;
  end;

  -- pictures: the owner's own (Public), one from the service manual, a scanned page of the catalogue
  select picture_id, storage_path into v_pic, v_path from public.docs_register_pictures(v_a, v_pub, null,
    '[{"title": "Hotová záhrada", "caption": "Projekt 2025, Košice", "bytes": 5000, "type": "image/webp"}]', 'sk', 300);
  assert v_path = v_a || '/pictures/' || v_pic || '.webp';
  perform set_config('ppi.pic_own', v_pic::text, false);
  select picture_id into v_pic from public.docs_register_pictures(v_a, null, current_setting('ppi.doc_s')::uuid,
    '[{"page": 3, "bytes": 5000, "type": "image/webp"}]', null, 300);
  assert (select folder_id from public.shop_pictures where id = v_pic) = v_s, 'a PDF picture is in its document''s folder';
  assert (select lang from public.shop_pictures where id = v_pic) = 'sk', 'and in its document''s language';
  perform set_config('ppi.pic_s', v_pic::text, false);
  select picture_id into v_pic from public.docs_register_pictures(v_a, null, current_setting('ppi.doc_p')::uuid,
    '[{"page": 5, "kind": "scan", "bytes": 5000, "type": "image/jpeg"}]', null, 300);
  assert (select kind = 'scan' and not show from public.shop_pictures where id = v_pic), 'a scan page is never shown';
  perform set_config('ppi.pic_scan', v_pic::text, false);
  select picture_id into v_pic from public.docs_register_pictures(v_a, v_pub, null,
    '[{"title": "Skrytý obrázok", "bytes": 5000, "type": "image/png"}]', 'sk', 300);
  perform set_config('ppi.pic_hidden', v_pic::text, false);
  -- the picture limit counts own and PDF pictures, never scan pages
  select count(*) into n from public.docs_register_pictures(v_a, v_pub, null,
    '[{"title": "Over the limit", "bytes": 5000}]', 'sk', 3) where picture_id is null;
  assert n = 1, 'a picture over the limit is refused';
  select count(*) into n from public.docs_register_pictures(v_a, null, current_setting('ppi.doc_p')::uuid,
    '[{"page": 6, "kind": "scan", "bytes": 5000}, {"page": 7, "bytes": 5000}]', null, 3) where picture_id is null;
  assert n = 1, 'scan pages are not pictures and do not count';
  delete from public.shop_pictures where document_id = current_setting('ppi.doc_p')::uuid and page in (6, 7);

  assert public.docs_pictures_uploaded(v_a, array[current_setting('ppi.pic_own'), current_setting('ppi.pic_s'),
    current_setting('ppi.pic_scan'), current_setting('ppi.pic_hidden')]::uuid[]) = 4;
  assert public.docs_pictures_uploaded(v_b, array[current_setting('ppi.pic_own')]::uuid[]) = 0,
    'another shop cannot mark these pictures';
  select count(*) into n from public.docs_claim_work(v_a, 10);
  assert n = 4, format('four pictures for the AI (%s)', n);
  assert (select count(*) from public.docs_claim_work(v_a, 10)) = 0, 'claimed pictures are not handed out twice';
  perform public.docs_save_work(current_setting('ppi.pic_own')::uuid,
    'Záhrada s hadicou Flexi a zavlažovačom.', null, null);
  perform public.docs_save_work(current_setting('ppi.pic_s')::uuid, 'Čerpadlo Hydro 300, štítok HY-300.', null, null);
  perform public.docs_save_work(current_setting('ppi.pic_scan')::uuid, null,
    array['Návod na zapojenie hadice Flexi do rýchlospojky.'], null);
  perform public.docs_save_work(current_setting('ppi.pic_hidden')::uuid, 'Sklad.', null, 'timeout');
  assert (select status from public.shop_pictures where id = current_setting('ppi.pic_hidden')::uuid) = 'pending',
    'a failed picture is tried again';
  assert (select count(*) from public.shop_document_chunks
          where document_id = current_setting('ppi.doc_p')::uuid and page = 5 and type = 'text') = 1,
    'a scanned page becomes document text of that page';
  assert (select text from public.shop_document_chunks where picture_id = current_setting('ppi.pic_own')::uuid)
         = E'Hotová záhrada\nProjekt 2025, Košice\nZáhrada s hadicou Flexi a zavlažovačom.',
    'a picture is found by its title, the owner''s caption and the AI description';

  perform public.docs_finish(v_a);
  assert (select status from public.shop_documents where id = current_setting('ppi.doc_p')::uuid) = 'processing',
    'not ready while the browser is still sending';
  foreach v_doc in array array[current_setting('ppi.doc_p'), current_setting('ppi.doc_w'),
                               current_setting('ppi.doc_s'), current_setting('ppi.doc_off')]::uuid[] loop
    assert public.docs_document_extracted(v_doc);
  end loop;
  assert public.docs_finish(v_a) = 1, 'one picture still waits for the AI';
  for r in select name, status from public.shop_documents where shop_id = v_a and id <> current_setting('ppi.doc_up')::uuid loop
    assert r.status = 'ready', format('%s is %s', r.name, r.status);
  end loop;
  assert (select status from public.shop_documents where id = current_setting('ppi.doc_up')::uuid) = 'uploading';
  -- an upload left unfinished for an hour is shown as an error
  update public.shop_documents set updated_at = now() - interval '2 hours' where id = current_setting('ppi.doc_up')::uuid;
  perform public.docs_finish(v_a);
  assert (select status from public.shop_documents where id = current_setting('ppi.doc_up')::uuid) = 'error';
end $$;
reset role;

-- owner A switches things: the old offer off for the assistant, one picture not shown
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_pub uuid := (select id from public.shop_folders where shop_id = (select id from public.shops where slug = 'potraviny-centrum') and is_public);
begin
  perform public.owner_update_document(current_setting('ppi.doc_off')::uuid, 'Stará akcia', null, v_pub, false, true);
  perform public.owner_update_picture(current_setting('ppi.pic_hidden')::uuid, 'Skrytý obrázok', null, null, null, false);
  perform public.owner_update_document(current_setting('ppi.doc_w')::uuid, 'Veľkoobchodný cenník 2026', 'Len pre partnerov',
                                       current_setting('ppi.folder_w')::uuid, true, true);
  -- update 24: a private folder's file is downloadable by its own access setting (or its folder's mode)
  perform public.owner_set_file_access('document', current_setting('ppi.doc_w')::uuid, 'download');
  -- the upload check: only a registered file of the owner's own shop that is not uploaded yet
  assert public.shop_docs_upload_allowed((select storage_path from public.shop_documents where id = current_setting('ppi.doc_up')::uuid)) = false,
    'an upload marked as failed cannot be finished';
  assert not public.shop_docs_upload_allowed((select storage_path from public.shop_documents where id = current_setting('ppi.doc_p')::uuid)),
    'an uploaded file is never replaced';
  assert not public.shop_docs_upload_allowed((select id from public.shops where slug = 'potraviny-centrum') || '/docs/made-up.pdf');
end $$;
reset role;
reset request.jwt.claim.sub;

set role service_role;
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_path text;
begin
  select storage_path into v_path from public.docs_register_document(v_a, (select id from public.shop_folders where shop_id = v_a and is_public),
                                                                     'Nový', null, 1, 1000, 30, 500);
  perform set_config('ppi.path_new', v_path, false);
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  assert public.shop_docs_upload_allowed(current_setting('ppi.path_new')), 'the owner may upload a registered file';
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$ begin
  assert not public.shop_docs_upload_allowed(current_setting('ppi.path_new')), 'another shop''s owner may not';
end $$;
reset role;
reset request.jwt.claim.sub;

-- a visitor without a key, with a made-up token or a folder id: only the Public folder
set role anon;
do $$
declare
  v_slug text := 'potraviny-centrum';
  v_bad text;
  n int;
begin
  select count(*) into n from public.search_shop_docs(v_slug, 'hadica', null, 20);
  assert n = 3, format('Public: catalogue text, scanned page, own picture (%s)', n);
  assert not exists (select 1 from public.search_shop_docs(v_slug, 'hadica', null, 20) where not is_public),
    'nothing private without a key';
  assert not exists (select 1 from public.search_shop_docs(v_slug, 'hadica', null, 20) where source = 'Stará akcia'),
    'a document the assistant may not use is never found';
  assert not exists (select 1 from public.search_shop_docs(v_slug, 'tesnenie', null, 20)), 'private text needs a key';
  assert not exists (select 1 from public.search_shop_docs(v_slug, 'skryty obrazok', null, 20)),
    'a picture the assistant may not show is never found';
  assert exists (select 1 from public.search_shop_docs(v_slug, 'zahradnu hadicu', null, 20) where page = 4),
    'inflected words match by their start, without accents';
  assert (select source from public.search_shop_docs(v_slug, 'zavlazovac', null, 20) where type = 'picture' and page is null)
         = 'Hotová záhrada', 'an own picture is named by its title';
  assert not exists (select 1 from public.search_shop_docs(v_slug, '', null, 20) where not is_public),
    'an empty question lists Public excerpts only';
  foreach v_bad in array array[current_setting('ppi.folder_w'), current_setting('ppi.folder_s'),
                               '{' || current_setting('ppi.folder_w') || ',' || current_setting('ppi.folder_s') || '}',
                               repeat('A', 40), current_setting('ppi.key_w'), ''] loop
    assert not exists (select 1 from public.search_shop_docs(v_slug, 'hadica', v_bad, 20) where not is_public),
      format('made-up token %s opened a private folder', v_bad);
    assert not exists (select 1 from public.search_shop_docs(v_slug, 'tesnenie', v_bad, 20));
    assert not exists (select 1 from public.shop_docs_list(v_slug, v_bad) where not is_public);
    assert public.shop_folder_session(v_slug, v_bad) is null;
  end loop;
  assert (select count(*) from public.shop_docs_list(v_slug, null)) = 1, 'a visitor knows only the Public catalogue';
  assert (select status from jsonb_to_record(public.unlock_shop_folders(v_slug, 'AAAA-BBBB-CCCC-DDDD-EEEE', repeat('k', 64)))
          as x(status text)) = 'wrong', 'a wrong key opens nothing';
  assert public.unlock_shop_folders('no-such-shop', current_setting('ppi.key_w'), repeat('k', 64)) ->> 'status' = 'unavailable';
  assert public.unlock_shop_folders('drogeria-kostolne', current_setting('ppi.key_w'), repeat('k', 64)) ->> 'status' = 'wrong',
    'a key works only in its own shop';
end $$;
reset role;

-- keys: each opens only its folders, for 24 hours (update 24), until revoked or expired
set role anon;
do $$
declare
  v_slug text := 'potraviny-centrum';
  v_r jsonb;
  t text;
begin
  v_r := public.unlock_shop_folders(v_slug, lower(current_setting('ppi.key_w')), repeat('m', 64));
  assert v_r ->> 'status' = 'ok', format('key for Veľkoobchod (typed in small letters): %s', v_r);
  assert v_r -> 'folders' = '["Veľkoobchod"]'::jsonb;
  assert (v_r ->> 'expires_at')::timestamptz between now() + interval '23 hours 59 minutes' and now() + interval '24 hours 1 minute',
    'a session lasts 24 hours (update 24)';
  t := v_r ->> 'token';
  assert length(t) >= 32;
  perform set_config('ppi.t_w', t, false);
  assert exists (select 1 from public.search_shop_docs(v_slug, 'cena hadice', t, 20)
                 where source = 'Veľkoobchodný cenník 2026' and page = 2 and not is_public and downloadable),
    'the key opens Veľkoobchod';
  assert not exists (select 1 from public.search_shop_docs(v_slug, 'tesnenie cerpadla', t, 20)),
    'a key for folder Veľkoobchod does not open Servis';
  assert not exists (select 1 from public.search_shop_docs(v_slug, 'hydro', t, 20)),
    'nor its pictures';
  assert not exists (select 1 from public.search_shop_docs('drogeria-kostolne', 'hadica', t, 20) where not is_public),
    'a session works only in its own shop';
  assert public.shop_folder_session(v_slug, t) -> 'folders' = '["Veľkoobchod"]'::jsonb;
  assert (select count(*) from public.shop_docs_list(v_slug, t)) = 2;

  perform set_config('ppi.t_s', public.unlock_shop_folders(v_slug, current_setting('ppi.key_s'), repeat('m', 64)) ->> 'token', false);
  perform set_config('ppi.t_r', public.unlock_shop_folders(v_slug, current_setting('ppi.key_r'), repeat('m', 64)) ->> 'token', false);
  perform set_config('ppi.t_all', public.unlock_shop_folders(v_slug, current_setting('ppi.key_all'), repeat('m', 64)) ->> 'token', false);
  assert exists (select 1 from public.search_shop_docs(v_slug, 'tesnenie', current_setting('ppi.t_s'), 20)), 'key for Servis works';
  assert exists (select 1 from public.search_shop_docs(v_slug, 'hydro', current_setting('ppi.t_all'), 20) where type = 'picture'
                 and source = 'Servisný manuál' and page = 3), 'a PDF picture is named by its document and page';
  assert not exists (select 1 from public.search_shop_docs(v_slug, 'zadarmo', current_setting('ppi.t_all'), 20)),
    'a document the assistant may not use stays hidden with every key';
end $$;
reset role;

set role service_role;
do $$ begin
  assert not exists (select 1 from public.folder_sessions where token_hash = current_setting('ppi.t_w')), 'tokens are stored only as a hash';
  assert exists (select 1 from public.folder_sessions where token_hash = public.docs_hash(current_setting('ppi.t_w')));
  assert not exists (select 1 from public.folder_keys where key_hash = current_setting('ppi.key_w'));
  assert (select use_count from public.folder_keys where label = 'Partner Veľkoobchod') = 1;
  assert (select last_used_at is not null from public.folder_keys where label = 'Partner Veľkoobchod');
  -- the Servis key expires; a session older than 12 hours ends
  update public.folder_keys set expires_at = now() - interval '1 second' where label = 'Servis 1 day';
  update public.folder_sessions set expires_at = now() - interval '1 second'
  where token_hash = public.docs_hash(current_setting('ppi.t_all'));
end $$;
reset role;

-- owner A revokes a key: whoever opened folders with it loses them at once
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  perform public.owner_revoke_folder_key((select id from public.folder_keys where label = 'To revoke'));
  assert (select revoked_at is not null from public.folder_keys where label = 'To revoke');
end $$;
reset role;
reset request.jwt.claim.sub;

set role anon;
do $$
declare
  v_slug text := 'potraviny-centrum';
  i int;
begin
  assert not exists (select 1 from public.search_shop_docs(v_slug, 'tesnenie', current_setting('ppi.t_s'), 20)),
    'an expired key closes its folders';
  assert public.unlock_shop_folders(v_slug, current_setting('ppi.key_s'), repeat('n', 64)) ->> 'status' = 'wrong',
    'an expired key opens nothing';
  assert not exists (select 1 from public.search_shop_docs(v_slug, 'cena', current_setting('ppi.t_r'), 20) where not is_public),
    'a revoked key closes its folders';
  assert public.unlock_shop_folders(v_slug, current_setting('ppi.key_r'), repeat('n', 64)) ->> 'status' = 'wrong',
    'a revoked key opens nothing';
  assert not exists (select 1 from public.search_shop_docs(v_slug, 'tesnenie', current_setting('ppi.t_all'), 20)),
    'a session ends after 12 hours';
  assert public.shop_folder_session(v_slug, current_setting('ppi.t_all')) is null;

  -- "Lock again"
  assert public.lock_shop_folders(v_slug, current_setting('ppi.t_w'));
  assert not exists (select 1 from public.search_shop_docs(v_slug, 'cena', current_setting('ppi.t_w'), 20) where not is_public),
    'locked again: private folders closed';
  assert not public.lock_shop_folders(v_slug, current_setting('ppi.t_w'));

  -- at most 5 wrong keys per caller and shop in 15 minutes (n already has 2)
  for i in 1..3 loop
    assert public.unlock_shop_folders(v_slug, 'WRONG-KEY-' || i, repeat('n', 64)) ->> 'status' = 'wrong';
  end loop;
  assert public.unlock_shop_folders(v_slug, current_setting('ppi.key_w'), repeat('n', 64)) ->> 'status' = 'too_many',
    'after 5 wrong keys even the right key waits';
  assert public.unlock_shop_folders(v_slug, current_setting('ppi.key_w'), repeat('o', 64)) ->> 'status' = 'ok',
    'another caller is not blocked';
  assert public.unlock_shop_folders('drogeria-kostolne', 'WRONG', repeat('n', 64)) ->> 'status' = 'wrong',
    'the counter is per shop';
  begin
    perform public.unlock_shop_folders(v_slug, 'x', 'short');
    raise exception 'invalid caller hash accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.owner_update_picture(current_setting('ppi.pic_own')::uuid, 'x', null, 'Visitor text', null, true);
    raise exception 'a visitor corrected a picture description';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- files a shopper may open (shop-files signs a 10-minute address only for these)
set role service_role;
do $$
declare
  v_slug text := 'potraviny-centrum';
  v_t text := public.unlock_shop_folders(v_slug, current_setting('ppi.key_w'), repeat('p', 64)) ->> 'token';
  v_all text := public.unlock_shop_folders(v_slug, current_setting('ppi.key_all'), repeat('p', 64)) ->> 'token';
begin
  assert public.shop_file_path(v_slug, 'document', current_setting('ppi.doc_w')::uuid, null) is null,
    'a private document needs a session';
  assert public.shop_file_path(v_slug, 'document', current_setting('ppi.doc_w')::uuid, current_setting('ppi.t_r')) is null,
    'a session of a revoked key opens no file';
  assert public.shop_file_path(v_slug, 'document', current_setting('ppi.doc_w')::uuid, v_t) like '%/docs/%.pdf',
    'with a valid session and "Shoppers may download it"';
  assert public.shop_file_path('drogeria-kostolne', 'document', current_setting('ppi.doc_w')::uuid, v_t) is null,
    'never through another shop';
  assert public.shop_file_path(v_slug, 'document', current_setting('ppi.doc_p')::uuid, null) is null,
    'a document is not downloadable unless the owner allows it';
  assert public.shop_file_path(v_slug, 'picture', current_setting('ppi.pic_own')::uuid, null) like '%/pictures/%.webp',
    'a Public picture the assistant may show';
  assert public.shop_file_path(v_slug, 'picture', current_setting('ppi.pic_hidden')::uuid, null) is null,
    'never a picture the assistant may not show';
  assert public.shop_file_path(v_slug, 'picture', current_setting('ppi.pic_scan')::uuid, v_all) is null,
    'never a scan page';
  assert public.shop_file_path(v_slug, 'picture', current_setting('ppi.pic_s')::uuid, v_t) is null,
    'a key for Veľkoobchod opens no picture in Servis';
  assert public.shop_file_path(v_slug, 'picture', current_setting('ppi.pic_s')::uuid, v_all) is null,
    'update 24: a private picture in a view-only folder is shown only through the viewer (with the watermark)';
  assert public.shop_file_path(v_slug, 'document', current_setting('ppi.doc_off')::uuid, null) is not null,
    'downloadable even when the assistant may not use it';
end $$;
reset role;

-- another shop's owner gets nothing of shop A and can change nothing
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
begin
  assert (select count(*) from public.shop_documents) = 0, 'owner B sees no documents of shop A';
  assert (select count(*) from public.shop_pictures) = 0;
  assert (select count(*) from public.folder_keys) = 0;
  assert (select count(*) from public.shop_folders) = 1, 'owner B sees only their own Public folder';
  assert not exists (select 1 from public.search_shop_docs('potraviny-centrum', 'cena', null, 20) where not is_public),
    'logged in as another owner: still only the Public folder';
  assert (select count(*) from public.owner_picture_paths(v_a, array[current_setting('ppi.pic_own')]::uuid[])) = 0;
  begin
    perform public.owner_update_picture(current_setting('ppi.pic_own')::uuid, 'x', null, 'Owner B text', null, true);
    raise exception 'owner B corrected shop A''s picture';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.owner_update_document(current_setting('ppi.doc_w')::uuid, 'x', null,
      (select id from public.shop_folders where is_public), true, true);
    raise exception 'owner B moved shop A''s document';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.owner_docs_files('document', current_setting('ppi.doc_w')::uuid);
    raise exception 'owner B got shop A''s file paths';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.owner_create_folder_key(v_a, 'B', array[current_setting('ppi.folder_w')]::uuid[], null);
    raise exception 'owner B made a key for shop A';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.owner_revoke_folder_key((select id from public.folder_keys limit 1));
    raise exception 'owner B revoked a key';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.shop_pictures set description = 'x';
    raise exception 'owner B wrote a picture directly';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

-- owner A corrects a picture description; the AI never writes over it
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  begin
    update public.shop_pictures set description = 'Directly';
    raise exception 'owner wrote a picture row directly';
  exception when insufficient_privilege then null;
  end;
  perform public.owner_update_picture(current_setting('ppi.pic_own')::uuid, 'Hotová záhrada', 'Projekt 2025, Košice',
    'Záhrada s hadicou Flexi 25 m a zavlažovačom Rain.', null, true);
  assert (select description_by_owner from public.shop_pictures where id = current_setting('ppi.pic_own')::uuid);
  begin
    perform count(*) from public.shop_document_chunks;
    raise exception 'an owner read the search excerpts directly';
  exception when insufficient_privilege then null;
  end;
  -- a document picture stays in its document's folder
  perform public.owner_update_picture(current_setting('ppi.pic_s')::uuid, '', null, 'Čerpadlo Hydro 300.',
    (select id from public.shop_folders where is_public), true);
  assert (select folder_id from public.shop_pictures where id = current_setting('ppi.pic_s')::uuid) = current_setting('ppi.folder_s')::uuid;
  begin
    perform public.owner_update_picture(current_setting('ppi.pic_scan')::uuid, 'x', null, 'x', null, true);
    raise exception 'a scan page edited as a picture';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

set role service_role;
do $$ begin
  assert (select text from public.shop_document_chunks where picture_id = current_setting('ppi.pic_own')::uuid)
         like '%zavlažovačom Rain.', 'the corrected description is what the assistant finds';
  update public.shop_pictures set status = 'working' where id = current_setting('ppi.pic_own')::uuid;
  perform public.docs_save_work(current_setting('ppi.pic_own')::uuid, 'The AI again.', null, null);
  assert (select description from public.shop_pictures where id = current_setting('ppi.pic_own')::uuid)
         = 'Záhrada s hadicou Flexi 25 m a zavlažovačom Rain.', 'the owner''s correction stays';
end $$;
reset role;

-- moving a document moves its text and pictures; folders with files cannot be deleted
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_pub uuid := (select id from public.shop_folders where is_public);
  v_files text[];
  v_empty uuid;
begin
  perform public.owner_update_document(current_setting('ppi.doc_s')::uuid, 'Servisný manuál', null, v_pub, true, false);
  assert (select count(*) from public.shop_pictures where document_id = current_setting('ppi.doc_s')::uuid and folder_id = v_pub) = 1;
  perform set_config('ppi.moved', 'yes', false);
  begin
    perform public.owner_delete_folder(current_setting('ppi.folder_w')::uuid);
    raise exception 'a folder with documents deleted';
  exception when object_in_use then null;
  end;
  begin
    perform public.owner_delete_folder(v_pub);
    raise exception 'the Public folder deleted';
  exception when invalid_parameter_value then null;
  end;
  v_empty := public.owner_save_folder((select id from public.shops where slug = 'potraviny-centrum'), null, 'Prázdny');
  perform public.owner_create_folder_key((select id from public.shops where slug = 'potraviny-centrum'), 'Only empty', array[v_empty], null);
  perform public.owner_create_folder_key((select id from public.shops where slug = 'potraviny-centrum'), 'Empty and W',
                                         array[v_empty, current_setting('ppi.folder_w')::uuid], null);
  perform public.owner_delete_folder(v_empty);
  assert not exists (select 1 from public.folder_keys where label = 'Only empty'), 'a key left without folders is deleted';
  assert (select folder_ids from public.folder_keys where label = 'Empty and W') = array[current_setting('ppi.folder_w')::uuid];

  v_files := public.owner_docs_files('document', current_setting('ppi.doc_s')::uuid);
  assert cardinality(v_files) = 2, format('the PDF and its picture: %s', v_files);
  perform set_config('ppi.files_s', array_to_string(v_files, ','), false);
end $$;
reset role;
reset request.jwt.claim.sub;

set role anon;
do $$ begin
  assert exists (select 1 from public.search_shop_docs('potraviny-centrum', 'tesnenie', null, 20) where is_public),
    'moved to Public: found without a key';
end $$;
reset role;

-- deleting a document (doc-ingest removes the files first) removes its pictures and text
set role service_role;
do $$
declare
  v_doc uuid := current_setting('ppi.doc_s')::uuid;
begin
  delete from public.shop_documents where id = v_doc;
  assert not exists (select 1 from public.shop_document_chunks where document_id = v_doc), 'its text is gone';
  assert not exists (select 1 from public.shop_pictures where document_id = v_doc), 'its pictures are gone';
  assert not exists (select 1 from public.shop_document_chunks where picture_id = current_setting('ppi.pic_s')::uuid);
  delete from public.shop_pictures where id = current_setting('ppi.pic_hidden')::uuid;
  assert not exists (select 1 from public.shop_document_chunks where picture_id = current_setting('ppi.pic_hidden')::uuid);
end $$;
reset role;

-- a shop without the paid plan (or not active): nothing at all, not even Public
set role service_role;
do $$ begin
  perform public.apply_stripe_subscription((select id from public.shops where slug = 'potraviny-centrum'),
    'cus_A1', 'sub_A1', 'past_due', 'pro', now() + interval '30 days', null);
end $$;
reset role;
set role anon;
do $$
declare
  v_slug text := 'potraviny-centrum';
begin
  assert not exists (select 1 from public.search_shop_docs(v_slug, 'hadica', null, 20)), 'no plan: nothing found';
  assert not exists (select 1 from public.search_shop_docs(v_slug, '', null, 20));
  assert not exists (select 1 from public.shop_docs_list(v_slug, null));
  assert public.unlock_shop_folders(v_slug, current_setting('ppi.key_w'), repeat('q', 64)) ->> 'status' = 'unavailable';
end $$;
reset role;
set role service_role;
do $$ begin
  assert public.shop_file_path('potraviny-centrum', 'picture', current_setting('ppi.pic_own')::uuid, null) is null,
    'no plan: no files';
  perform public.apply_stripe_subscription((select id from public.shops where slug = 'potraviny-centrum'),
    'cus_A1', 'sub_A1', 'active', 'pro', now() + interval '30 days', null);
  update public.shops set is_active = false where slug = 'potraviny-centrum';
  assert not exists (select 1 from public.search_shop_docs('potraviny-centrum', 'hadica', null, 20)), 'inactive shop: nothing';
  update public.shops set is_active = true where slug = 'potraviny-centrum';
  assert exists (select 1 from public.search_shop_docs('potraviny-centrum', 'hadica', null, 20));
  -- the plan ends at the period end: the shop cannot be deleted while it has documents
  perform public.apply_stripe_subscription((select id from public.shops where slug = 'potraviny-centrum'),
    'cus_A1', 'sub_A1', 'active', 'pro', now() + interval '30 days', now() + interval '30 days');
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  begin
    perform public.owner_delete_shop((select id from public.shops where slug = 'potraviny-centrum'));
    raise exception 'a shop with documents deleted';
  exception when object_in_use then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

\echo '--- shop profile: e-mail and Facebook page, assistant texts (plain text, paid plan)'
set role service_role;
do $$ begin
  perform public.apply_stripe_subscription((select id from public.shops where slug = 'potraviny-centrum'),
    'cus_A1', 'sub_A1', 'active', 'pro', now() + interval '30 days', null);
  perform public.apply_stripe_subscription((select id from public.shops where slug = 'drogeria-kostolne'),
    'cus_B1', 'sub_B2', 'past_due', 'pro', now() + interval '30 days', null);
  assert public.plain_text('  <b>Vitajte</b> v obchode!  Pozrite www.farby.sk a https://x.sk/a?b=1 alebo info@farby.sk  ', 300)
         = 'Vitajte v obchode! Pozrite a alebo', 'HTML, links and e-mail addresses are stripped';
  assert public.plain_text('Farby s.r.o., 12.50 €, napr. otvorené', 300) = 'Farby s.r.o., 12.50 €, napr. otvorené',
    'ordinary text stays as written';
  assert public.plain_text(E'Riadok\nďalší\tkoniec', 300) = 'Riadok ďalší koniec';
  assert public.plain_text('farby.sk/akcia dnes', 300) = 'dnes', 'a bare web address is a link too';
  assert length(public.plain_text(repeat('a', 50), 40)) = 40;
  assert public.plain_text('  <br>  ', 40) is null, 'nothing left = the default text';
end $$;
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_r jsonb;
begin
  v_r := public.owner_set_assistant_texts(v_a, '<i>Spýtajte sa nás</i>', 'Dobrý deň! Píšte nám aj na https://evil.example/x.');
  assert v_r = '{"label": "Spýtajte sa nás", "welcome": "Dobrý deň! Píšte nám aj na"}'::jsonb, format('saved %s', v_r);
  v_r := public.owner_set_assistant_texts(v_a, '', '   ');
  assert v_r = '{"label": null, "welcome": null}'::jsonb, 'empty = the default texts';
  perform public.owner_set_assistant_texts(v_a, repeat('x', 60), 'Vitajte');
  assert (select length(assistant_label) from public.shops where id = v_a) = 40, 'label at most 40 characters';
  -- written directly: still cleaned
  update public.shops set assistant_welcome = '<script>alert(1)</script>Ahoj' where id = v_a;
  assert (select assistant_welcome from public.shops where id = v_a) = 'alert(1) Ahoj';
  begin
    perform public.owner_set_assistant_texts(v_b, 'x', 'y');
    raise exception 'owner A changed shop B''s assistant';
  exception when insufficient_privilege then null;
  end;

  -- e-mail and Facebook page: checked and tidied
  perform public.owner_save_shop(jsonb_build_object('id', v_a, 'name', 'Potraviny Centrum', 'timezone', 'Europe/Bratislava',
    'country', 'SK', 'city', 'Michalovce', 'address', 'Námestie osloboditeľov 10', 'lat', '48.7547', 'lng', '21.9185',
    'phone', '+421 56 000 0001', 'is_active', 'true', 'has_toilet', 'true', 'has_douchette', 'true', 'has_card_terminal', 'true',
    'email', ' Info@Potraviny.SK ', 'facebook_url', 'facebook.com/potravinycentrum'));
  assert (select email || ' ' || facebook_url from public.shops where id = v_a)
         = 'info@potraviny.sk https://facebook.com/potravinycentrum';
  perform public.owner_save_shop(jsonb_build_object('id', v_a, 'name', 'Potraviny Centrum', 'timezone', 'Europe/Bratislava',
    'is_active', 'true', 'email', 'info@potraviny.sk', 'facebook_url', 'http://www.facebook.com/potravinycentrum'));
  assert (select facebook_url from public.shops where id = v_a) = 'https://www.facebook.com/potravinycentrum';
  begin
    perform public.owner_save_shop(jsonb_build_object('id', v_a, 'name', 'x', 'email', 'info@'));
    raise exception 'invalid e-mail accepted';
  exception when invalid_parameter_value then assert sqlerrm = 'email', sqlerrm;
  end;
  foreach v_r in array array['"https://example.com/potraviny"', '"https://evilfacebook.com/x"',
                             '"https://facebook.com.evil.io/x"', '"javascript:alert(1)//facebook.com/x"']::jsonb[] loop
    begin
      perform public.owner_save_shop(jsonb_build_object('id', v_a, 'name', 'x', 'facebook_url', v_r #>> '{}'));
      raise exception 'not a Facebook page accepted: %', v_r;
    exception when invalid_parameter_value then assert sqlerrm = 'facebook', sqlerrm;
    end;
  end loop;
  begin
    update public.shops set email = 'not an address' where id = v_a;
    raise exception 'invalid e-mail written directly';
  exception when check_violation then null;
  end;
  perform public.owner_save_shop(jsonb_build_object('id', v_a, 'name', 'Potraviny Centrum', 'timezone', 'Europe/Bratislava',
    'country', 'SK', 'city', 'Michalovce', 'address', 'Námestie osloboditeľov 10', 'lat', '48.7547', 'lng', '21.9185',
    'phone', '+421 56 000 0001', 'is_active', 'true', 'has_toilet', 'true', 'has_douchette', 'true', 'has_card_terminal', 'true',
    'email', 'info@potraviny.sk', 'facebook_url', 'https://fb.com/potravinycentrum'));
  assert (select facebook_url from public.shops where id = v_a) = 'https://fb.com/potravinycentrum';
  assert (select email from public.my_shops() where id = v_a) = 'info@potraviny.sk', 'the owner reads them back';
end $$;
reset role;
reset request.jwt.claim.sub;

-- a shop without the paid plan cannot set the assistant texts in any way
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
begin
  begin
    perform public.owner_set_assistant_texts(v_b, 'Spýtajte sa', 'Vitajte');
    raise exception 'assistant texts set without the plan';
  exception when raise_exception then assert sqlerrm = 'no_plan', sqlerrm;
  end;
  begin
    update public.shops set assistant_label = 'Spýtajte sa' where id = v_b;
    raise exception 'assistant texts written directly without the plan';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

set role anon;
do $$ begin
  assert (select email || ' ' || facebook_url || ' ' || assistant_label || '|' || assistant_welcome
          from public.public_shops where slug = 'potraviny-centrum')
         = 'info@potraviny.sk https://fb.com/potravinycentrum xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx|alert(1) Ahoj',
    'the shop page reads the contact links and the assistant texts';
end $$;
reset role;

\echo '--- stock file reports and private columns'
do $$ begin
  assert public.is_private_column('Nákupná cena') and public.is_private_column('NC bez DPH')
     and public.is_private_column('Dodávateľ') and public.is_private_column('Marža %')
     and public.is_private_column('Číslo faktúry') and public.is_private_column('Beszerzési ár')
     and public.is_private_column('Supplier') and public.is_private_column('Invoice no')
     and public.is_private_column('Zisk'), 'purchase price, supplier, margin and invoice columns';
  assert not (public.is_private_column('Cena s DPH') or public.is_private_column('Názov')
     or public.is_private_column('Množstvo') or public.is_private_column('EAN') or public.is_private_column('Kód')
     or public.is_private_column('Popis') or public.is_private_column('Mena')), 'ordinary columns';
  assert public.mapped_columns('{"price":"Cena","source_code":"Kód","name":"Názov","ean":null,"quantity":"Množstvo"}')
         = array['Kód', 'Názov', 'Množstvo', 'Cena'], 'in field order';
end $$;

set role service_role;
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_rows jsonb := '[
    {"Kód":"P1","Názov":"Káva","Množstvo":"5","Cena":"2,50","Nákupná cena":"1,20","Dodávateľ":"Veľkosklad","Poznámka":"a"},
    {"Kód":"P2","Názov":"Čaj","Množstvo":"0","Cena":"1,10","Nákupná cena":"0,60","Dodávateľ":"Veľkosklad","Poznámka":"b"},
    {"Kód":"P3","Názov":"Mlieko","Množstvo":"-1","Cena":"0,99","Nákupná cena":"0,50","Dodávateľ":"Mliekáreň","Poznámka":"c"},
    {"Kód":"P4","Názov":"Maslo","Množstvo":"3","Cena":"2,10","Nákupná cena":"1,50","Dodávateľ":"Mliekáreň","Poznámka":"d"},
    {"Kód":"P5","Názov":"Chlieb","Množstvo":"8","Cena":"1,30","Nákupná cena":"0,70","Dodávateľ":"Pekáreň","Poznámka":"e"},
    {"Kód":"P6","Názov":"Rožok","Množstvo":"90","Cena":"0,10","Nákupná cena":"0,05","Dodávateľ":"Pekáreň","Poznámka":"f"}]';
  v_id bigint;
  v_wait bigint;
  i int;
begin
  -- a proposed mapping: 3 sample rows, never the private-looking columns
  update public.sync_sources
  set field_mapping = '{"source_code":"Kód","name":"Názov","quantity":"Množstvo","price":"Cena"}',
      mapping_status = 'proposed', sample_rows = v_rows,
      file_columns = array['Kód', 'Názov', 'Množstvo', 'Cena', 'Nákupná cena', 'Dodávateľ', 'Poznámka']
  where shop_id = v_a;
  assert (select jsonb_array_length(sample_rows) from public.sync_sources where shop_id = v_a) = 3;
  assert not exists (select 1 from public.sync_sources s, jsonb_array_elements(s.sample_rows) r
                     where s.shop_id = v_a and (r ? 'Nákupná cena' or r ? 'Dodávateľ')), 'no private values before approval';
  assert (select sample_rows -> 0 ->> 'Poznámka' from public.sync_sources where shop_id = v_a) = 'a';
  -- approved: only the mapped columns
  update public.sync_sources set mapping_status = 'confirmed' where shop_id = v_a;
  assert (select sample_rows -> 0 from public.sync_sources where shop_id = v_a)
         = '{"Kód":"P1","Názov":"Káva","Množstvo":"5","Cena":"2,50"}'::jsonb, 'only the approved columns';
  assert (select cardinality(file_columns) from public.sync_sources where shop_id = v_a) = 7, 'the names stay, for re-mapping';
  update public.sync_sources set sample_rows = v_rows where shop_id = v_a;
  assert (select jsonb_array_length(sample_rows) = 5 and not (sample_rows -> 4 ? 'Poznámka')
          from public.sync_sources where shop_id = v_a), 'a new sample is trimmed too';

  -- import reports: the mapped columns of the first 5 rows, exactly as in the file
  v_id := public.record_stock_import(v_a, 'sklad.csv', now() - interval '1 minute', 'ok', 6, 6, 0, 0, null, v_rows);
  assert (select columns from public.stock_imports where id = v_id) = array['Kód', 'Názov', 'Množstvo', 'Cena'];
  assert (select jsonb_array_length(preview) from public.stock_imports where id = v_id) = 5;
  assert (select preview -> 2 from public.stock_imports where id = v_id)
         = '{"Kód":"P3","Názov":"Mlieko","Množstvo":"-1","Cena":"0,99"}'::jsonb, 'values as written';
  assert not exists (select 1 from public.stock_imports i, jsonb_array_elements(i.preview) r
                     where (r ? 'Nákupná cena') or (r ? 'Dodávateľ') or (r ? 'Poznámka')), 'never a private column';
  -- columns not approved yet: every column is private, so no preview at all
  update public.sync_sources set mapping_status = 'proposed' where shop_id = v_a;
  v_wait := public.record_stock_import(v_a, 'novy.csv', now(), 'waiting', 6, 0, 0, 0, null, v_rows);
  assert (select cardinality(columns) = 0 and preview = '[]'::jsonb from public.stock_imports where id = v_wait),
         'no preview before the columns are approved';
  delete from public.stock_imports where id = v_wait;
  update public.sync_sources set mapping_status = 'confirmed' where shop_id = v_a;
  for i in 1..11 loop
    perform public.record_stock_import(v_a, 'sklad.csv', now(), case when i = 11 then 'errors' else 'ok' end,
                                       6, 5, 1, 1, case when i = 11 then 'Riadok 7: chýba cena' end, v_rows);
  end loop;
  assert (select count(*) from public.stock_imports where shop_id = v_a) = 10, 'the last 10 files are kept';
  assert not exists (select 1 from public.stock_imports where id = v_id), 'the oldest went';
  perform public.record_stock_import((select id from public.shops where slug = 'drogeria-kostolne'),
                                     'export.xml', now(), 'waiting', 2, 0, 0, 0, null, '[{"a":"1"}]');
  begin
    perform public.record_stock_import(v_a, 'x', now(), 'great', 0, 0, 0, 0, null, '[]');
    raise exception 'unknown status accepted';
  exception when invalid_parameter_value then null;
  end;
end $$;
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  assert (select count(*) from public.stock_imports) = 10, 'owner A reads only their own reports';
  assert (select status || ' ' || error from public.stock_imports order by received_at desc, id desc limit 1)
         = 'errors Riadok 7: chýba cena';
  begin
    insert into public.stock_imports (shop_id, status) values ((select id from public.shops where slug = 'potraviny-centrum'), 'ok');
    raise exception 'an owner wrote an import report';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.record_stock_import((select id from public.shops where slug = 'potraviny-centrum'), 'x', now(), 'ok',
                                       0, 0, 0, 0, null, '[]');
    raise exception 'an owner recorded an import';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$ begin
  assert (select count(*) from public.stock_imports) = 1, 'owner B sees only shop B''s report';
end $$;
reset role;
reset request.jwt.claim.sub;

set role anon;
do $$ begin
  begin
    perform count(*) from public.stock_imports;
    raise exception 'a visitor read import reports';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

\echo '--- shop assistant archive: conversations, files, PDFs, keep time, owners only'
do $$ begin
  assert (select schedule from cron.job where jobname = 'ppi-assistant-tick') = '*/5 * * * *', 'the 5-minute job';
  assert (select schedule from cron.job where jobname = 'ppi-assistant-retention') = '17 3 * * *', 'the daily job';
  assert (select command from cron.job where jobname = 'ppi-assistant-tick') like '%/functions/v1/assistant-archive%'
     and (select command from cron.job where jobname = 'ppi-assistant-tick') like '%''action'', ''tick''%', 'calls the function';
  assert (select command from cron.job where jobname = 'ppi-assistant-retention') like '%''action'', ''retention''%';
  assert (select length(secret) from vault.secrets where name = 'ppi_assistant_cron') = 64, 'a random secret in Vault';
end $$;

create temporary table archive_test (k text primary key, v text);
grant all on archive_test to public;
insert into archive_test select 'secret', decrypted_secret from vault.decrypted_secrets where name = 'ppi_assistant_cron';

set role service_role;
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_secret text := (select v from archive_test where k = 'secret');
  v_open jsonb;
  v_id uuid;
  v_token text;
  v_att jsonb;
  v_files uuid[] := '{}';
  v_other jsonb;
  i int;
begin
  assert public.assistant_cron_ok(v_secret), 'the job''s secret is accepted';
  assert not public.assistant_cron_ok(v_secret || 'x') and not public.assistant_cron_ok('short')
     and not public.assistant_cron_ok(null), 'any other secret is refused';

  -- only active shops with the paid plan get conversations
  begin
    perform public.assistant_open(v_b, 'sk', repeat('b', 32));
    raise exception 'a shop without the plan got a conversation';
  exception when raise_exception then
    if sqlerrm <> 'no_plan' then raise; end if;
  end;
  begin
    perform public.assistant_open(gen_random_uuid(), 'sk', repeat('b', 32));
    raise exception 'an unknown shop got a conversation';
  exception when no_data_found then null;
  end;
  v_open := public.assistant_open(v_a, 'it', repeat('a', 32));
  v_id := (v_open ->> 'id')::uuid;
  v_token := v_open ->> 'token';
  assert length(v_token) = 64, 'a long random token';
  assert (select page_lang from public.assistant_conversations where id = v_id) = 'sk', 'unknown page language → sk';
  assert (select token_hash from public.assistant_conversations where id = v_id) = public.assistant_token_hash(v_token)
     and (select token_hash from public.assistant_conversations where id = v_id) <> v_token, 'only the token''s hash is kept';
  assert (public.assistant_conversation(v_id, v_token) ->> 'open')::boolean, 'the token opens it';
  assert public.assistant_conversation(v_id, v_token || '0') is null, 'a wrong token gets nothing';

  -- at most 30 new conversations per shopper and shop an hour
  for i in 1..29 loop
    perform public.assistant_open(v_a, 'sk', repeat('c', 32));
  end loop;
  perform public.assistant_open(v_a, 'sk', repeat('c', 32));
  begin
    perform public.assistant_open(v_a, 'sk', repeat('c', 32));
    raise exception 'the 31st conversation an hour was opened';
  exception when program_limit_exceeded then null;
  end;
  delete from public.assistant_conversations where id <> v_id;
  delete from public.api_usage where endpoint like 'assistant-open:%';

  -- files: names cleaned, only the five types, 10 MB, 10 per conversation
  v_att := public.assistant_add_attachment(v_id, v_token, '../../tmp/Štítok č.1 <nový>.HEIC', 'heic', 2048, true);
  assert v_att ->> 'name' = 'Štítok č.1 _nový_.HEIC', 'path and reserved characters go, letters stay';
  assert v_att ->> 'path' = v_a || '/' || v_id || '/files/' || (v_att ->> 'id') || '.heic', 'stored under shop/conversation';
  assert v_att ->> 'preview_path' like '%.preview.jpg', 'a picture gets a preview path';
  v_files := v_files || (v_att ->> 'id')::uuid;
  v_att := public.assistant_add_attachment(v_id, v_token, '  ', 'pdf', 4096, true);
  assert v_att ->> 'name' = 'subor.pdf' and v_att -> 'preview_path' = 'null'::jsonb, 'a PDF has no preview; an empty name gets one';
  v_files := v_files || (v_att ->> 'id')::uuid;
  begin
    perform public.assistant_add_attachment(v_id, v_token, 'a.gif', 'gif', 10, false);
    raise exception 'a GIF was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.assistant_add_attachment(v_id, v_token, 'big.jpg', 'jpeg', 10485761, false);
    raise exception 'a file over 10 MB was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.assistant_add_attachment(v_id, 'wrong', 'a.jpg', 'jpeg', 10, false);
    raise exception 'a wrong token added a file';
  exception when no_data_found then null;
  end;
  for i in 3..10 loop
    perform public.assistant_add_attachment(v_id, v_token, 'f' || i || '.jpg', 'jpeg', 100, false);
  end loop;
  begin
    perform public.assistant_add_attachment(v_id, v_token, 'f11.jpg', 'jpeg', 100, false);
    raise exception 'an 11th file was accepted';
  exception when program_limit_exceeded then null;
  end;
  assert (select attachment_count from public.assistant_conversations where id = v_id) = 10;
  perform public.assistant_drop_attachment((select id from public.assistant_attachments where name = 'f10.jpg'));
  assert (select attachment_count from public.assistant_conversations where id = v_id) = 9, 'a failed upload is forgotten';

  -- a second conversation, to check that files never move between conversations
  v_other := public.assistant_open(v_a, 'hu', repeat('d', 32));
  v_att := public.assistant_add_attachment((v_other ->> 'id')::uuid, v_other ->> 'token', 'cudzi.png', 'png', 10, false);

  -- a file taken back before sending: its paths, only with the right token and only while no message has it
  assert public.assistant_discardable(v_id, v_token, (select id from public.assistant_attachments where name = 'f9.jpg'))
         = array[(select storage_path from public.assistant_attachments where name = 'f9.jpg')], 'paths of a file taken back';
  assert public.assistant_discardable(v_id, 'wrong', (select id from public.assistant_attachments where name = 'f9.jpg')) is null,
    'not with a wrong token';
  assert public.assistant_discardable(v_id, v_token, (v_att ->> 'id')::uuid) is null, 'not another conversation''s file';

  -- only into a conversation of the same shop
  begin
    perform public.assistant_add_turn(v_id, v_token, v_b, '{"body":"x"}', '{"body":"y"}');
    raise exception 'a turn went into another shop''s conversation';
  exception when no_data_found then null;
  end;

  -- one exchange: the shopper's message with its files, the answer with its cards
  perform public.assistant_add_turn(v_id, v_token, v_a,
    jsonb_build_object('body', E'Máte štetec č. 5 na  túto\nfarbu?', 'body_owner', null, 'lang', 'sk',
                       'at', to_jsonb(now() + interval '1 hour'),
                       'attachments', to_jsonb(v_files || (v_att ->> 'id')::uuid)),
    jsonb_build_object('body', 'Áno, máme ho.', 'lang', 'sk', 'cards', jsonb_build_array(
      jsonb_build_object('name', 'Štetec plochý 5 cm', 'price', '2,50 €', 'availability', '12 ks na sklade',
                         'data_time', '2026-10-10T12:05:00+00:00', 'secret', 'x', 'quantity', 2),
      'not a card')));
  assert (select message_count from public.assistant_conversations where id = v_id) = 2;
  assert (select first_question from public.assistant_conversations where id = v_id) = 'Máte štetec č. 5 na túto farbu?',
    'the first question, on one line';
  assert (select shopper_lang from public.assistant_conversations where id = v_id) = 'sk';
  assert (select attachment_ids from public.assistant_messages where conversation_id = v_id and role = 'shopper') = v_files,
    'only this conversation''s files are linked';
  assert (select created_at <= now() from public.assistant_messages where conversation_id = v_id and role = 'shopper'),
    'a time in the future is not taken';
  assert (select cards from public.assistant_messages where conversation_id = v_id and role = 'assistant')
         = '[{"name": "Štetec plochý 5 cm", "price": "2,50 €", "quantity": 2, "data_time": "2026-10-10T12:05:00+00:00", "availability": "12 ks na sklade"}]'::jsonb,
    'cards keep only their fields';
  assert public.assistant_discardable(v_id, v_token, v_files[1]) is null, 'a file sent with a message stays';
  -- the same files again: not linked twice
  perform public.assistant_add_turn(v_id, v_token, v_a,
    jsonb_build_object('body', 'Ešte raz', 'lang', 'sk', 'attachments', to_jsonb(v_files)),
    jsonb_build_object('body', 'Dobre.', 'lang', 'sk'));
  assert (select attachment_ids from public.assistant_messages where conversation_id = v_id and body = 'Ešte raz') = '{}';
  begin
    perform public.assistant_add_turn(v_id, v_token, v_a, '{"body":"x"}', '{"body":""}');
    raise exception 'an empty answer was stored';
  exception when invalid_parameter_value then null;
  end;

  -- ending: closed by the shopper, nothing more after that
  assert public.assistant_end(v_id, v_token, 'closed') and not public.assistant_end(v_id, v_token, 'closed');
  begin
    perform public.assistant_add_turn(v_id, v_token, v_a, '{"body":"x"}', '{"body":"y"}');
    raise exception 'a message went into an ended conversation';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform public.assistant_add_attachment(v_id, v_token, 'late.jpg', 'jpeg', 10, false);
    raise exception 'a file went into an ended conversation';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- 30 minutes without a message: ended at the last message
  update public.assistant_conversations set last_message_at = now() - interval '31 minutes' where id = (v_other ->> 'id')::uuid;
  assert (select array_agg(x) from public.assistant_end_idle(30) x) = array[(v_other ->> 'id')::uuid], 'the idle one ends';
  assert (select ended_at = last_message_at and end_reason = 'idle' from public.assistant_conversations
          where id = (v_other ->> 'id')::uuid);
  assert not exists (select 1 from public.assistant_end_idle(30)), 'nothing else';
  assert (select array_agg(x) from public.assistant_empty_ended(50) x) = array[(v_other ->> 'id')::uuid],
    'an ended conversation without a message is forgotten, not made into a PDF';
  assert (select array_agg(x) from public.assistant_pdf_todo(5) x) = array[v_id], 'the ended one needs its PDF';

  -- the PDF's data, and three failed tries at most
  assert (select public.assistant_pdf_data(v_id) #>> '{shop,name}') = 'Potraviny Centrum';
  assert (select jsonb_array_length(public.assistant_pdf_data(v_id) -> 'messages')) = 4
     and (select public.assistant_pdf_data(v_id) #>> '{messages,0,role}') = 'shopper'
     and (select jsonb_array_length(public.assistant_pdf_data(v_id) -> 'attachments')) = 9;
  perform public.assistant_pdf_done(v_id, null, null, 'font missing');
  assert not exists (select 1 from public.assistant_pdf_todo(5)), 'tried again only after a pause';
  update public.assistant_conversations set pdf_next_try = now() - interval '1 second' where id = v_id;
  perform public.assistant_pdf_done(v_id, null, null, 'again');
  perform public.assistant_pdf_done(v_id, null, null, 'and again');
  assert (select pdf_status = 'failed' and pdf_attempts = 3 from public.assistant_conversations where id = v_id);
  perform public.assistant_pdf_done(v_id, v_a || '/' || v_id || '/x.pdf', 'x.pdf', null);
  assert (select pdf_status = 'ready' and pdf_error is null from public.assistant_conversations where id = v_id);
  assert cardinality(public.assistant_files(v_id)) = 9 + 1 + 1, 'files, the HEIC preview and the PDF';

  insert into archive_test values ('id', v_id), ('token', v_token), ('other', v_other ->> 'id');
end $$;
reset role;

-- owners: read their own, never tokens or storage paths, never write
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_id uuid := (select v::uuid from archive_test where k = 'id');
begin
  assert (select count(*) from public.assistant_messages where conversation_id = v_id) = 4, 'owner A reads the messages';
  assert (select first_question from public.assistant_conversations where id = v_id) like 'Máte štetec%';
  begin
    perform token_hash from public.assistant_conversations;
    raise exception 'an owner read a token hash';
  exception when insufficient_privilege then null;
  end;
  begin
    perform storage_path from public.assistant_attachments;
    raise exception 'an owner read a storage path';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.assistant_messages set body = 'changed' where conversation_id = v_id;
    raise exception 'an owner changed a message';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.assistant_open(v_a, 'sk', repeat('e', 32));
    raise exception 'an owner called a function of the archive';
  exception when insufficient_privilege then null;
  end;
  -- the list: words in any message (accents and case ignored), days in the shop's time zone
  assert (select count(*) from public.owner_assistant_conversations(v_a)) = 1, 'conversations without a message are not listed';
  assert (select count(*) from public.owner_assistant_conversations(v_a, 'stetec FARBU')) = 1;
  assert (select count(*) from public.owner_assistant_conversations(v_a, 'stetec valec')) = 0, 'every word must appear';
  assert (select count(*) from public.owner_assistant_conversations(v_a, null,
            (now() at time zone 'Europe/Bratislava')::date, (now() at time zone 'Europe/Bratislava')::date)) = 1;
  assert (select count(*) from public.owner_assistant_conversations(v_a, null,
            (now() at time zone 'Europe/Bratislava')::date + 1, null)) = 0;
  assert (select message_count = 4 and attachment_count = 9 and pdf_status = 'ready' and total_count = 1
          from public.owner_assistant_conversations(v_a));
  -- keep time
  assert public.owner_set_assistant_retention(v_a, 30) = 30;
  assert (select retention_days from public.shop_assistant_settings where shop_id = v_a) = 30;
  begin
    perform public.owner_set_assistant_retention(v_a, 45);
    raise exception '45 days was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.owner_set_assistant_retention((select id from public.shops where slug = 'drogeria-kostolne'), 365);
    raise exception 'owner A set another shop''s keep time';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$ begin
  assert (select count(*) from public.assistant_conversations) = 0, 'owner B sees none of shop A''s conversations';
  assert (select count(*) from public.assistant_messages) = 0 and (select count(*) from public.assistant_attachments) = 0;
  assert (select count(*) from public.owner_assistant_conversations((select id from public.shops where slug = 'potraviny-centrum'))) = 0;
end $$;
reset role;
reset request.jwt.claim.sub;

set role anon;
do $$ begin
  begin
    perform count(*) from public.assistant_messages;
    raise exception 'a visitor read conversations';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.assistant_conversation((select v::uuid from archive_test where k = 'id'), 'x');
    raise exception 'a visitor called the archive';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- keep time: past it, the daily job deletes the conversation
set role service_role;
do $$
declare
  v_id uuid := (select v::uuid from archive_test where k = 'id');
begin
  update public.assistant_conversations set last_message_at = now() - interval '29 days' where id = v_id;
  assert not exists (select 1 from public.assistant_expired(10)), 'kept for 30 days';
  update public.assistant_conversations set last_message_at = now() - interval '31 days' where id = v_id;
  assert (select array_agg(x) from public.assistant_expired(10) x) = array[v_id], 'deleted after 30 days';
  update public.shop_assistant_settings set retention_days = 90;
  assert not exists (select 1 from public.assistant_expired(10)), 'a longer keep time keeps it';
  delete from public.shop_assistant_settings;
  update public.assistant_conversations set last_message_at = now() - interval '91 days' where id = v_id;
  assert (select array_agg(x) from public.assistant_expired(10) x) = array[v_id], '90 days when nothing is set';
  -- forgetting removes the messages and files with it
  assert public.assistant_forget(v_id);
  assert not exists (select 1 from public.assistant_messages where conversation_id = v_id)
     and not exists (select 1 from public.assistant_attachments where conversation_id = v_id);
  perform public.assistant_forget((select v::uuid from archive_test where k = 'other'));
end $$;
reset role;
drop table archive_test;

\echo '--- cloud export: connections, OAuth states, copies, retries, deletions, owners only'
do $$ begin
  assert (select schedule from cron.job where jobname = 'ppi-cloud-export-tick') = '2-59/5 * * * *', 'the 5-minute job';
  assert (select command from cron.job where jobname = 'ppi-cloud-export-tick') like '%/functions/v1/cloud-export%'
     and (select command from cron.job where jobname = 'ppi-cloud-export-tick') like '%x-ppi-cron%', 'calls the function with the secret';
end $$;

create temporary table cloud_test (k text primary key, v text);
grant all on cloud_test to public;

set role service_role;
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_owner uuid := '00000000-0000-0000-0000-00000000000a';
  v_take jsonb;
  v_open jsonb;
  v_id uuid;
  v_token text;
  v_att jsonb;
  v_second uuid;
  v_third uuid;
begin
  -- OAuth round trips: once, for 10 minutes
  perform public.cloud_state_save('state-1', v_a, 'onedrive', v_owner, 'verifier-1', '/Cacaduu/Potraviny Centrum',
                                   'https://ppi.example/sk/dashboard?shop=potraviny-centrum&at=cloud');
  v_take := public.cloud_state_take('state-1');
  assert v_take ->> 'shop_id' = v_a::text and v_take ->> 'provider' = 'onedrive' and v_take ->> 'verifier' = 'verifier-1'
     and v_take ->> 'folder_path' = '/Cacaduu/Potraviny Centrum' and v_take ->> 'user_id' = v_owner::text, 'the state';
  assert public.cloud_state_take('state-1') is null, 'a state works only once';
  perform public.cloud_state_save('state-2', v_a, 'dropbox', v_owner, 'v', '/Cacaduu/A', 'https://ppi.example/');
  update public.cloud_oauth_states set expires_at = now() - interval '1 second' where state_hash = 'state-2';
  assert public.cloud_state_take('state-2') is null, 'an expired state is refused';
  assert public.cloud_state_take('made-up') is null;
  begin
    perform public.cloud_state_save('state-3', v_a, 'gdrive', v_owner, 'v', '/x', 'https://ppi.example/');
    raise exception 'Google Drive was accepted';
  exception when check_violation then null;
  end;
  begin
    perform public.cloud_state_save('state-4', v_a, 'dropbox', v_owner, 'v', '/x', 'javascript:alert(1)');
    raise exception 'a return address that is not a web page was accepted';
  exception when check_violation then null;
  end;

  -- a conversation whose PDF is ready before the shop has a cloud: nothing waits
  v_open := public.assistant_open(v_a, 'sk', repeat('f', 32));
  v_id := (v_open ->> 'id')::uuid;
  v_token := v_open ->> 'token';
  v_att := public.assistant_add_attachment(v_id, v_token, 'štítok.jpg', 'jpeg', 1000, true);
  perform public.assistant_add_turn(v_id, v_token, v_a,
    jsonb_build_object('body', 'Máte farbu na plot?', 'lang', 'sk', 'attachments', jsonb_build_array(v_att ->> 'id')),
    '{"body": "Áno, máme."}');
  perform public.assistant_end(v_id, v_token, 'closed');
  assert not public.assistant_pdf_done(v_id, v_a || '/' || v_id || '/x.pdf', 'x.pdf', null), 'no cloud: not queued';
  assert (select export_status from public.assistant_conversations where id = v_id) = 'none', 'no cloud: nothing waits';
  assert not public.cloud_export_enqueue(v_id);

  -- connecting (one per shop)
  perform public.cloud_connection_save(v_a, 'onedrive', 'Ján Novák', 'jan@example.invalid', '/Cacaduu/Potraviny Centrum',
    'enc:access', 'enc:refresh', now() + interval '1 hour', 'Files.ReadWrite offline_access', 'https://ppi.example', v_owner);
  begin
    perform public.cloud_connection_save(v_b, 'onedrive', null, null, 'Cacaduu/B', 'a', 'r', null, null, null, v_owner);
    raise exception 'a folder without a leading / was accepted';
  exception when check_violation then null;
  end;
  assert public.cloud_export_enqueue(v_id), 'with a cloud the conversation is queued';
  assert (select export_status from public.assistant_conversations where id = v_id) = 'pending';

  -- taking copies: running, not twice; stuck for 15 minutes → taken again
  assert (select array_agg(x) from public.cloud_export_claim(5) x) = array[v_id], 'the due copy';
  assert (select export_status from public.assistant_conversations where id = v_id) = 'running';
  assert not exists (select 1 from public.cloud_export_claim(5)), 'never taken twice';
  update public.assistant_conversations set export_started_at = now() - interval '16 minutes' where id = v_id;
  assert (select array_agg(x) from public.cloud_export_claim(5, v_id) x) = array[v_id], 'a stuck copy is taken again';
  assert (select public.cloud_export_data(v_id) -> 'connection' ->> 'access_token_enc') = 'enc:access';
  assert jsonb_array_length(public.cloud_export_data(v_id) -> 'attachments') = 1
     and public.cloud_export_data(v_id) -> 'attachments' -> 0 ->> 'name' = 'štítok.jpg', 'the shopper''s files';

  -- what is copied is kept once
  perform public.cloud_export_item_done(v_id, 'pdf', '/Cacaduu/Potraviny Centrum/2026-10/2026-10-10_14-05_abcd1234/konverzacia.pdf', 'r1', 1234);
  perform public.cloud_export_item_done(v_id, 'pdf', '/elsewhere/konverzacia.pdf', 'r2', 1234);
  assert (select count(*) from public.cloud_export_items where conversation_id = v_id) = 1
     and (select remote_path from public.cloud_export_items where conversation_id = v_id) like '/Cacaduu/%', 'never twice';
  assert public.cloud_export_data(v_id) -> 'done' ->> 'pdf' like '%/konverzacia.pdf';

  -- failures: again after 5, 10 … minutes, at most every 6 hours, 20 times
  perform public.cloud_export_finish(v_id, null, 'The cloud did not answer');
  assert (select export_status = 'failed' and export_attempts = 1 and export_error = 'The cloud did not answer'
                 and export_next_try between now() + interval '4 minutes' and now() + interval '6 minutes'
          from public.assistant_conversations where id = v_id), 'first retry after 5 minutes';
  perform public.cloud_export_finish(v_id, null, 'again');
  assert (select export_next_try between now() + interval '9 minutes' and now() + interval '11 minutes'
          from public.assistant_conversations where id = v_id), 'then after 10 minutes';
  update public.assistant_conversations set export_attempts = 12 where id = v_id;
  perform public.cloud_export_finish(v_id, null, 'again');
  assert (select export_next_try between now() + interval '359 minutes' and now() + interval '361 minutes'
          from public.assistant_conversations where id = v_id), 'at most every 6 hours';
  update public.assistant_conversations set export_attempts = 19 where id = v_id;
  perform public.cloud_export_finish(v_id, null, 'again');
  assert (select export_attempts = 20 and export_next_try is null from public.assistant_conversations where id = v_id), '20 times';
  assert not exists (select 1 from public.cloud_export_claim(5)), 'no more tries by itself';
  update public.assistant_conversations set export_attempts = 0 where id = v_id;
  perform public.cloud_export_finish(v_id, null, 'busy', true, 1800);
  assert (select export_next_try between now() + interval '29 minutes' and now() + interval '31 minutes'
          from public.assistant_conversations where id = v_id), 'a busy cloud: not before its Retry-After';
  perform public.cloud_export_finish(v_id, null, 'a broken file', false);
  assert (select export_next_try is null from public.assistant_conversations where id = v_id), 'not again when it cannot work';

  -- done
  update public.assistant_conversations set export_status = 'running' where id = v_id;
  perform public.cloud_export_finish(v_id, '/Cacaduu/Potraviny Centrum/2026-10/2026-10-10_14-05_abcd1234', null);
  assert (select export_status = 'done' and exported_at is not null and export_error is null and export_provider = 'onedrive'
                 and export_path like '%_abcd1234' from public.assistant_conversations where id = v_id);
  assert not public.cloud_export_enqueue(v_id), 'a copied conversation is not copied again by itself';

  -- a second conversation, waiting; a third one only started
  v_open := public.assistant_open(v_a, 'hu', repeat('g', 32));
  v_second := (v_open ->> 'id')::uuid;
  perform public.assistant_add_turn(v_second, v_open ->> 'token', v_a, '{"body": "Van festék?", "lang": "hu"}', '{"body": "Igen."}');
  perform public.assistant_end(v_second, v_open ->> 'token', 'closed');
  assert public.assistant_pdf_done(v_second, 'x/y.pdf', 'y.pdf', null), 'queued: the archive pushes it';
  assert (select export_status = 'pending' and export_next_try <= now() from public.assistant_conversations where id = v_second),
    'a ready PDF is queued for the cloud at once';
  v_third := (public.assistant_open(v_a, 'sk', repeat('h', 32)) ->> 'id')::uuid;

  -- the connection's health: an expired one stops the copies; 24 hours of failures → one e-mail
  perform public.cloud_connection_result(v_a, 'invalid_grant: the refresh token has expired', true);
  assert (select status = 'expired' and failing_since is not null and last_error like 'invalid_grant%'
          from public.cloud_connections where shop_id = v_a);
  assert not exists (select 1 from public.cloud_export_claim(5)), 'no copies while the connection has expired';
  assert not exists (select 1 from public.cloud_alerts_due()), 'not before 24 hours';
  update public.cloud_connections set failing_since = now() - interval '25 hours' where shop_id = v_a;
  assert (select emails from public.cloud_alerts_due() where shop_id = v_a) = array['owner-a@example.invalid'],
    'the shop''s owners are told';
  assert (select shop_name = 'Potraviny Centrum' and site_url = 'https://ppi.example' from public.cloud_alerts_due());
  perform public.cloud_alert_sent(v_a);
  assert not exists (select 1 from public.cloud_alerts_due()), 'only once';
  perform public.cloud_connection_result(v_a, 'still failing', false);
  assert (select failing_since < now() - interval '24 hours' from public.cloud_connections where shop_id = v_a),
    'the failures keep their first time';
  perform public.cloud_connection_result(v_a, null, false);
  assert (select status = 'ok' and failing_since is null and alert_sent_at is null and last_success_at is not null
          and last_error is null from public.cloud_connections where shop_id = v_a), 'a success clears it';
  perform public.cloud_connection_tokens(v_a, 'enc:access-2', null, now() + interval '1 hour');
  assert (select access_token_enc = 'enc:access-2' and refresh_token_enc = 'enc:refresh' from public.cloud_connections
          where shop_id = v_a), 'a refresh keeps the refresh token when none comes back';

  -- connecting again retries the failed copies at once
  update public.assistant_conversations set export_status = 'failed', export_next_try = null, export_attempts = 20
  where id = v_second;
  perform public.cloud_connection_save(v_a, 'dropbox', 'Ján', null, '/Cacaduu/Potraviny Centrum', 'enc:a3', 'enc:r3',
                                       null, null, null, v_owner);
  assert (select export_status = 'pending' and export_attempts = 0 and export_next_try <= now()
          from public.assistant_conversations where id = v_second), 'failed copies are tried again';
  assert (select provider from public.cloud_connections where shop_id = v_a) = 'dropbox', 'one cloud per shop';
  assert v_third is not null;
end $$;
reset role;

set role service_role;
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_done uuid := (select id from public.assistant_conversations where shop_id = v_a and export_status = 'done' limit 1);
  v_waiting uuid := (select id from public.assistant_conversations where shop_id = v_a and export_status = 'pending' limit 1);
  v_b_conv uuid := gen_random_uuid();
  v_ready uuid;
  v_again uuid;
begin
  -- the shopper deletes: not copied yet → gone, never copied; copied → a stub for the owners, without content
  assert v_done is not null and v_waiting is not null;
  assert public.assistant_shopper_forget(v_waiting) = 'deleted', 'not copied yet: deleted, never copied';
  assert not exists (select 1 from public.assistant_conversations where id = v_waiting);
  assert public.assistant_shopper_forget(v_done) = 'kept_for_owner', 'copied already: a stub stays';
  assert (select shopper_deleted_at is not null and first_question is null and message_count = 0 and pdf_path is null
                 and export_status = 'done' and export_path like '%_abcd1234'
          from public.assistant_conversations where id = v_done), 'the stub keeps only where it is in the cloud';
  assert not exists (select 1 from public.assistant_messages where conversation_id = v_done)
     and not exists (select 1 from public.assistant_attachments where conversation_id = v_done), 'no content left';
  assert not exists (select 1 from public.assistant_empty_ended(50) x where x = v_done), 'the stub is not forgotten as empty';
  assert not public.cloud_export_enqueue(v_done) and not exists (select 1 from public.cloud_export_claim(5, v_done)),
    'a deleted conversation is never copied';

  -- two finished conversations not copied yet, and one of shop B, for the owner checks
  insert into public.assistant_conversations (id, shop_id, token_hash, message_count, ended_at, pdf_status)
  values (v_b_conv, v_b, 'x', 2, now(), 'ready');
  insert into public.assistant_conversations (shop_id, token_hash, message_count, ended_at, pdf_status)
  values (v_a, 'x', 2, now(), 'ready') returning id into v_ready;
  insert into public.assistant_conversations (shop_id, token_hash, message_count, ended_at, pdf_status)
  values (v_a, 'x', 2, now(), 'ready');
  -- one copied before (its files noted), for "Uložiť znova" on a copied conversation
  insert into public.assistant_conversations (shop_id, token_hash, message_count, ended_at, pdf_status, export_status,
                                              exported_at, export_path)
  values (v_a, 'x', 2, now() - interval '40 days', 'ready', 'done', now() - interval '40 days', '/C/2026-08/2026-08-31_10-00_aaaaaaaa')
  returning id into v_again;
  perform public.cloud_export_item_done(v_again, 'pdf', '/C/2026-08/2026-08-31_10-00_aaaaaaaa/konverzacia.pdf', 'r1', 100);
  insert into cloud_test values ('done', v_done), ('b_conv', v_b_conv), ('ready1', v_ready), ('again', v_again);
end $$;
reset role;

-- owners: read their own connection and copies, never the tokens; retry and older conversations
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_done uuid := (select v::uuid from cloud_test where k = 'done');
  v_today date := (now() at time zone 'Europe/Bratislava')::date;
  v_ready uuid;
begin
  assert (select provider = 'dropbox' and folder_path = '/Cacaduu/Potraviny Centrum' and status = 'ok'
          from public.cloud_connections where shop_id = v_a), 'owner A sees the connection';
  begin
    perform access_token_enc from public.cloud_connections;
    raise exception 'an owner read a token';
  exception when insufficient_privilege then null;
  end;
  begin
    perform refresh_token_enc from public.cloud_connections;
    raise exception 'an owner read a refresh token';
  exception when insufficient_privilege then null;
  end;
  begin
    perform count(*) from public.cloud_oauth_states;
    raise exception 'an owner read OAuth states';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.cloud_connections set folder_path = '/x' where shop_id = v_a;
    raise exception 'an owner changed the connection directly';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.cloud_connection_save(v_a, 'dropbox', null, null, '/x', 'a', 'r', null, null, null, null);
    raise exception 'an owner called a function of the copies';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.cloud_disconnect(v_a);
    raise exception 'an owner disconnected directly';
  exception when insufficient_privilege then null;
  end;
  assert (select count(*) from public.cloud_export_items where shop_id = v_a) = 2, 'the copied files';
  -- the list shows copies and the shopper's deletions
  assert (select shopper_deleted_at is not null and export_status = 'done' and export_path like '%_abcd1234'
          from public.owner_assistant_conversations(v_a) where id = v_done), 'the stub is listed with its cloud folder';
  -- "Uložiť znova" and older conversations
  v_ready := (select v::uuid from cloud_test where k = 'ready1');
  assert public.owner_cloud_retry(v_ready), 'Uložiť znova';
  assert (select export_status from public.assistant_conversations where id = v_ready) = 'pending';
  assert not public.owner_cloud_retry(v_done), 'a deleted conversation is not copied again';
  v_ready := (select v::uuid from cloud_test where k = 'again');
  assert (select count(*) from public.cloud_export_items where conversation_id = v_ready) = 1;
  assert public.owner_cloud_retry(v_ready), 'Uložiť znova on a copied conversation';
  assert (select export_status = 'pending' and export_path like '%_aaaaaaaa' from public.assistant_conversations where id = v_ready),
    'waits again; where it was copied stays known';
  assert (select count(*) from public.cloud_export_items where conversation_id = v_ready) = 0,
    'its files are checked again in the cloud (same ones are not sent twice there)';
  assert public.owner_cloud_backfill(v_a, v_today, v_today) = 1, 'the other finished one of today';
  assert public.owner_cloud_backfill(v_a, v_today, v_today) = 0, 'nothing twice';
  assert public.owner_cloud_backfill(v_a, v_today - 30, v_today - 1) = 0, 'nothing in an earlier period';
  begin
    perform public.owner_cloud_backfill(v_a, v_today, v_today - 1);
    raise exception 'a period ending before it starts was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.owner_cloud_retry((select v::uuid from cloud_test where k = 'b_conv'));
    raise exception 'owner A retried shop B''s conversation';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.owner_cloud_backfill(v_b, v_today, v_today);
    raise exception 'owner A copied shop B''s conversations';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
begin
  assert (select count(*) from public.cloud_connections) = 0, 'owner B sees no other shop''s cloud';
  assert (select count(*) from public.cloud_export_items) = 0;
  begin
    perform public.owner_cloud_retry((select v::uuid from cloud_test where k = 'done'));
    raise exception 'owner B retried shop A''s conversation';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.owner_cloud_backfill(v_b, current_date, current_date);
    raise exception 'a shop without a cloud copied';
  exception when raise_exception then
    if sqlerrm <> 'no_cloud' then raise; end if;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

set role anon;
do $$ begin
  begin
    perform count(*) from public.cloud_connections;
    raise exception 'a visitor read a cloud connection';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.cloud_state_take('x');
    raise exception 'a visitor took an OAuth state';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- "Odpojiť": tokens gone, waiting copies are not made
set role service_role;
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
begin
  -- copied before, then waiting again ("Uložiť znova") with no files noted: the shopper's deletion still leaves the line
  assert public.assistant_shopper_forget((select v::uuid from cloud_test where k = 'again')) = 'kept_for_owner',
    'copied before: a stub stays even while it is copied again';
  assert (select export_status = 'none' and export_path like '%_aaaaaaaa' and shopper_deleted_at is not null
          from public.assistant_conversations where id = (select v::uuid from cloud_test where k = 'again'));
  update public.assistant_conversations set export_status = 'pending', export_next_try = now()
  where shop_id = v_a and shopper_deleted_at is null and pdf_status = 'ready';
  assert public.cloud_disconnect(v_a);
  assert not exists (select 1 from public.cloud_connections where shop_id = v_a), 'the tokens are deleted';
  assert not exists (select 1 from public.assistant_conversations where shop_id = v_a and export_status in ('pending', 'running', 'failed')),
    'nothing waits any more';
  assert (select export_status from public.assistant_conversations where id = (select v::uuid from cloud_test where k = 'done')) = 'done',
    'copies made stay marked';
  assert not public.cloud_disconnect(v_a), 'only once';
  delete from public.assistant_conversations where shop_id in (v_a, (select id from public.shops where slug = 'drogeria-kostolne'));
end $$;
reset role;
drop table cloud_test;

\echo '--- access keys: shoppers view or download a private folder (update 24)'
create temporary table vip_test (k text primary key, v text);
grant all on vip_test to public;

-- a private folder "VIP" with a 3-page PDF (page pictures), an own picture and a second PDF
set role service_role;
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_folder uuid;
  v_doc uuid;
  v_doc2 uuid;
  v_pic uuid := gen_random_uuid();
  v_paths text[];
begin
  insert into public.shop_folders (shop_id, name) values (v_a, 'VIP') returning id into v_folder;
  assert (select access_mode from public.shop_folders where id = v_folder) = 'view', 'a new folder is "Len zobraziť"';
  select document_id into v_doc from public.docs_register_document(v_a, v_folder, 'Cenník VIP', null, 3, 3000, 30, 500);
  perform public.docs_document_uploaded(v_doc);
  select document_id into v_doc2 from public.docs_register_document(v_a, v_folder, 'Návod', null, 1, 2000, 30, 500);
  perform public.docs_document_uploaded(v_doc2);
  insert into public.shop_pictures (id, shop_id, folder_id, title, storage_path, bytes, status)
  values (v_pic, v_a, v_folder, 'Vzorkovník', v_a || '/pictures/' || v_pic || '.webp', 5000, 'ready');

  -- page pictures: registered (page numbers the PDF has, WebP or JPEG, at most 5 MB), then marked uploaded
  begin
    perform public.docs_register_pages(v_doc, '[{"page": 4, "bytes": 100, "type": "image/webp"}]');
    raise exception 'a page the PDF does not have was registered';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.docs_register_pages(v_doc, '[{"page": 1, "bytes": 100, "type": "application/pdf"}]');
    raise exception 'a page picture of another type was registered';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.docs_register_pages(v_doc, '[{"page": 1, "bytes": 6000000, "type": "image/webp"}]');
    raise exception 'a page picture over 5 MB was registered';
  exception when invalid_parameter_value then null;
  end;
  select array_agg(storage_path order by page) into v_paths
  from public.docs_register_pages(v_doc, '[{"page": 1, "bytes": 1000, "type": "image/webp", "width": 1100, "height": 1568},
                                            {"page": 2, "bytes": 1000, "type": "image/webp"},
                                            {"page": 3, "bytes": 1000, "type": "image/jpeg"}]');
  assert cardinality(v_paths) = 3 and v_paths[1] like v_a || '/' || v_doc || '/pages/1-%.webp' and v_paths[3] like '%/pages/3-%.jpg',
    format('page paths: %s', v_paths);
  assert public.docs_pages_uploaded(v_doc, array[1, 2]) = 2;
  perform set_config('ppi.vip_page3', v_paths[3], false);
  perform public.docs_register_pages(v_doc2, '[{"page": 1, "bytes": 1000, "type": "image/webp"}]');
  perform public.docs_pages_uploaded(v_doc2, array[1]);
  insert into vip_test values ('folder', v_folder), ('doc', v_doc), ('doc2', v_doc2), ('pic', v_pic);
end $$;
reset role;

-- owners: the folder's own key (shown once, replaced on change), the access mode, a file's own setting
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_folder uuid := (select v::uuid from vip_test where k = 'folder');
  v_first text;
  v_key text;
begin
  assert public.shop_docs_upload_allowed(current_setting('ppi.vip_page3')), 'the owner may upload a registered page picture';
  assert not public.shop_docs_upload_allowed(replace(current_setting('ppi.vip_page3'), '/pages/3-', '/pages/1-')),
    'never a page picture that is not registered or already uploaded';
  assert (select count(*) from public.shop_document_pages where document_id = (select v::uuid from vip_test where k = 'doc')) = 3,
    'owners see whether the viewer is ready';
  assert cardinality(public.owner_docs_files('document', (select v::uuid from vip_test where k = 'doc'))) = 4,
    'deleting a document also deletes its page pictures';
  v_first := public.owner_set_folder_key(v_folder);
  v_key := public.owner_set_folder_key(v_folder);
  assert v_key ~ '^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){4}$' and v_key <> v_first, 'a new folder key, shown once';
  assert (select count(*) from public.folder_keys where folder_key and folder_ids = array[v_folder] and revoked_at is null) = 1,
    'one key per folder: the previous one stopped';
  perform set_config('ppi.vip_old_key', v_first, false);
  perform set_config('ppi.vip_key', v_key, false);
  begin
    perform public.owner_set_folder_key((select id from public.shop_folders where shop_id = (select shop_id from public.shop_folders where id = v_folder) and is_public));
    raise exception 'a key for the Public folder';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.owner_set_folder_access(v_folder, 'everything');
    raise exception 'an unknown access mode';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.owner_set_file_access('document', (select v::uuid from vip_test where k = 'doc'), 'always');
    raise exception 'an unknown file access';
  exception when invalid_parameter_value then null;
  end;
  begin
    update public.shop_folders set access_mode = 'download' where id = v_folder;
    raise exception 'an owner changed the mode directly';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.folder_zip_tickets;
    raise exception 'an owner read ZIP tickets';
  exception when insufficient_privilege then null;
  end;
  assert (select unlocks + views + downloads from public.shop_folders where id = v_folder) = 0, 'counts start at 0';
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare
  v_folder uuid := (select v::uuid from vip_test where k = 'folder');
begin
  assert not exists (select 1 from public.shop_document_pages), 'owner B sees no page of shop A';
  assert not public.shop_docs_upload_allowed(current_setting('ppi.vip_page3')), 'owner B may not upload shop A''s page';
  begin
    perform public.owner_set_folder_key(v_folder);
    raise exception 'owner B set a key for shop A';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.owner_set_folder_access(v_folder, 'download');
    raise exception 'owner B changed shop A''s access mode';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.owner_set_file_access('document', (select v::uuid from vip_test where k = 'doc'), 'download');
    raise exception 'owner B changed shop A''s file';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.owner_set_shopper_pdf((select id from public.shops where slug = 'potraviny-centrum'), false);
    raise exception 'owner B changed shop A''s setting';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

-- shoppers: the right key opens only that folder, for 24 hours; a replaced key opens nothing
set role anon;
do $$
declare
  v_slug text := 'potraviny-centrum';
  v_r jsonb;
  v_t text;
  v_folder uuid := (select v::uuid from vip_test where k = 'folder');
begin
  assert public.unlock_shop_folders(v_slug, current_setting('ppi.vip_old_key'), repeat('v', 64)) ->> 'status' = 'wrong',
    'the folder''s previous key stopped when it was changed';
  v_r := public.unlock_shop_folders(v_slug, current_setting('ppi.vip_key'), repeat('v', 64));
  assert v_r ->> 'status' = 'ok' and v_r -> 'folders' = '["VIP"]'::jsonb, format('the folder key opens VIP: %s', v_r);
  assert (v_r ->> 'expires_at')::timestamptz > now() + interval '23 hours 59 minutes', '24 hours';
  v_t := v_r ->> 'token';
  perform set_config('ppi.vip_t', v_t, false);
  assert (select count(*) from public.shop_folder_files(v_slug, v_t)) = 3, 'two PDFs and the picture';
  assert (select bool_and(folder = 'VIP' and not can_download) from public.shop_folder_files(v_slug, v_t)),
    '"Len zobraziť": nothing downloadable';
  assert (select viewable from public.shop_folder_files(v_slug, v_t) where id = (select v::uuid from vip_test where k = 'doc')) = false,
    'a PDF whose pages are not all uploaded is not viewable yet';
  assert (select viewable from public.shop_folder_files(v_slug, v_t) where id = (select v::uuid from vip_test where k = 'doc2')),
    'a PDF with all its pages is viewable';
  assert not exists (select 1 from public.shop_folder_files(v_slug, null)), 'no files without a key';
  assert not exists (select 1 from public.shop_folder_files(v_slug, repeat('A', 40))), 'nor with a made-up token';
  assert not exists (select 1 from public.shop_folder_files('drogeria-kostolne', v_t)), 'never through another shop';
  assert not exists (select 1 from public.shop_folder_files(v_slug, current_setting('ppi.t_w')) where folder = 'VIP'),
    'a key for Veľkoobchod does not open VIP';
  assert (public.shop_folder_session(v_slug, v_t) ->> 'downloads_left')::int = 20, '20 downloads per unlocked session';
  begin
    perform 1 from public.shop_document_pages;
    raise exception 'a visitor read page pictures';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.shop_view_file(v_slug, 'document', (select v::uuid from vip_test where k = 'doc2'), v_t, true);
    raise exception 'a visitor called the viewer function directly';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.shop_download_file(v_slug, 'document', (select v::uuid from vip_test where k = 'doc2'), v_t);
    raise exception 'a visitor called the download function directly';
  exception when insufficient_privilege then null;
  end;
  assert public.shopper_pdf_allowed(v_slug), 'the shopper''s own conversation PDF is on by default';
  assert not public.shopper_pdf_allowed('drogeria-kostolne'), 'not for a shop without the paid plan';
end $$;
reset role;

-- viewing, downloading, the ZIP (shop-files, service role)
set role service_role;
do $$
declare
  v_slug text := 'potraviny-centrum';
  v_t text := current_setting('ppi.vip_t');
  v_folder uuid := (select v::uuid from vip_test where k = 'folder');
  v_doc uuid := (select v::uuid from vip_test where k = 'doc');
  v_doc2 uuid := (select v::uuid from vip_test where k = 'doc2');
  v_pic uuid := (select v::uuid from vip_test where k = 'pic');
  v_view jsonb;
  v_r jsonb;
  v_zip jsonb;
begin
  assert public.shop_view_file(v_slug, 'document', v_doc, v_t, true) is null, 'not viewable before all pages are uploaded';
  perform public.docs_pages_uploaded(v_doc, array[3]);
  v_view := public.shop_view_file(v_slug, 'document', v_doc, v_t, true);
  assert v_view ->> 'name' = 'Cenník VIP' and jsonb_array_length(v_view -> 'pages') = 3
         and (v_view -> 'pages' -> 0 ->> 'page')::int = 1 and (v_view -> 'pages' -> 0 ->> 'width')::int = 1100
         and v_view -> 'shop' ->> 'name' = 'Potraviny Centrum' and not (v_view ->> 'can_download')::boolean,
    format('the viewer gets the page pictures in order: %s', v_view);
  assert jsonb_array_length(public.shop_view_file(v_slug, 'picture', v_pic, v_t, false) -> 'pages') = 1, 'a picture is one page';
  assert public.shop_view_file(v_slug, 'document', v_doc, null, true) is null, 'no viewer without a key';
  assert public.shop_view_file(v_slug, 'document', v_doc, current_setting('ppi.t_w'), true) is null, 'nor with another folder''s key';
  assert public.shop_view_file('drogeria-kostolne', 'document', v_doc, v_t, true) is null, 'nor through another shop';
  assert (select views from public.shop_folders where id = v_folder) = 1, 'one "Otvoriť" counted (not the refresh)';

  -- "Len zobraziť": no download, no original file, no ZIP
  assert public.shop_download_file(v_slug, 'document', v_doc, v_t) ->> 'status' = 'not_found', 'view only: no download';
  assert public.shop_file_path(v_slug, 'document', v_doc, v_t) is null, 'view only: never the original PDF';
  assert public.shop_zip_ticket(v_slug, v_folder, v_t) ->> 'status' = 'empty', 'view only: no ZIP';

  -- the folder "Zobraziť a stiahnuť", one file overridden to "len zobraziť"
  update public.shop_folders set access_mode = 'download' where id = v_folder;
  update public.shop_documents set access = 'view' where id = v_doc2;
  assert (select array_agg(name order by name) from public.shop_folder_files(v_slug, v_t) where can_download)
         = array['Cenník VIP', 'Vzorkovník'], 'the per-file override wins over the folder';
  v_r := public.shop_download_file(v_slug, 'document', v_doc, v_t);
  assert v_r ->> 'status' = 'ok' and v_r ->> 'name' = 'Cenník VIP.pdf' and v_r ->> 'path' like '%/docs/%.pdf', format('download: %s', v_r);
  assert public.shop_download_file(v_slug, 'document', v_doc2, v_t) ->> 'status' = 'not_found', 'the overridden file: view only';
  assert public.shop_download_file(v_slug, 'picture', v_pic, v_t) ->> 'name' = 'Vzorkovník.webp';
  assert public.shop_download_file(v_slug, 'document', v_doc, null) ->> 'status' = 'not_found', 'no download without a key';
  assert public.shop_file_path(v_slug, 'document', v_doc, v_t) is not null, 'downloadable: the original PDF';
  assert (select downloads from public.folder_sessions where token_hash = public.docs_hash(v_t)) = 2
     and (select downloads from public.shop_folders where id = v_folder) = 2, 'downloads counted for the session and the folder';

  -- the ZIP: a single-use ticket with only the downloadable files
  v_zip := public.shop_zip_ticket(v_slug, v_folder, v_t);
  assert v_zip ->> 'status' = 'ok' and length(v_zip ->> 'ticket') >= 32, format('ZIP ticket: %s', v_zip);
  assert not exists (select 1 from public.folder_zip_tickets where ticket_hash = v_zip ->> 'ticket'), 'tickets kept only as a hash';
  v_r := public.shop_zip_take(v_zip ->> 'ticket');
  assert v_r ->> 'folder' = 'VIP'
         and (select array_agg(x ->> 'name' order by x ->> 'name') from jsonb_array_elements(v_r -> 'files') x)
             = array['Cenník VIP.pdf', 'Vzorkovník.webp'],
    format('the ZIP holds only the downloadable files: %s', v_r);
  assert public.shop_zip_take(v_zip ->> 'ticket') is null, 'a ticket works once';
  v_zip := public.shop_zip_ticket(v_slug, v_folder, v_t);
  update public.folder_zip_tickets set expires_at = now() - interval '1 second' where ticket_hash = public.docs_hash(v_zip ->> 'ticket');
  assert public.shop_zip_take(v_zip ->> 'ticket') is null, 'a ticket expires after 10 minutes';
  assert public.shop_zip_ticket(v_slug, v_folder, current_setting('ppi.t_w')) ->> 'status' = 'not_found', 'another folder''s key: no ZIP';
  assert public.shop_zip_ticket('drogeria-kostolne', v_folder, v_t) ->> 'status' = 'not_found', 'never through another shop';

  -- at most 100 MB in a ZIP
  insert into public.shop_documents (shop_id, folder_id, name, storage_path, bytes, pages, status, access)
  select (select shop_id from public.shop_folders where id = v_folder), v_folder, 'Veľký ' || i, 'big/' || i || '.pdf', 20971520, 1,
         'ready', 'download'
  from generate_series(1, 5) i;
  assert public.shop_zip_ticket(v_slug, v_folder, v_t) ->> 'status' = 'too_big', 'more than 100 MB: no ZIP';
  delete from public.shop_documents where storage_path like 'big/%';

  -- 20 downloads per session (a ZIP counts as one)
  update public.folder_sessions set downloads = 19 where token_hash = public.docs_hash(v_t);
  assert public.shop_download_file(v_slug, 'document', v_doc, v_t) ->> 'status' = 'ok', 'the 20th download';
  assert public.shop_download_file(v_slug, 'document', v_doc, v_t) ->> 'status' = 'limit', 'the 21st is refused';
  assert public.shop_zip_ticket(v_slug, v_folder, v_t) ->> 'status' = 'limit', 'no ZIP after 20 downloads';

  -- a changed folder key closes the folder for whoever opened it with the old one
  update public.folder_keys set revoked_at = now() where folder_key and folder_ids = array[v_folder];
  assert not exists (select 1 from public.shop_folder_files(v_slug, v_t)), 'a revoked key: the session sees nothing';
  assert public.shop_view_file(v_slug, 'document', v_doc, v_t, false) is null;
  update public.folder_keys set revoked_at = null where folder_key and folder_ids = array[v_folder];
  -- the chat closes: "Znova zamknúť"
  assert public.lock_shop_folders(v_slug, v_t);
  assert not exists (select 1 from public.shop_folder_files(v_slug, v_t)), 'a locked session sees nothing';
  assert (select unlocks from public.shop_folders where id = v_folder) = 1, 'one unlock counted';
end $$;
reset role;

-- the shopper's own conversation PDF: only with its token, only when the shop allows it
set role service_role;
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_open jsonb := public.assistant_open(v_a, 'hu', repeat('w', 32));
  v_id uuid := (v_open ->> 'id')::uuid;
  v_token text := v_open ->> 'token';
begin
  assert public.assistant_shopper_pdf_data(v_id, v_token) is null, 'nothing before the first message';
  perform public.assistant_add_turn(v_id, v_token, v_a, '{"body": "Van festék?", "lang": "hu"}', '{"body": "Igen."}');
  assert public.assistant_shopper_pdf_data(v_id, v_token) -> 'conversation' ->> 'id' = v_id::text, 'the shopper''s own chat';
  assert jsonb_array_length(public.assistant_shopper_pdf_data(v_id, v_token) -> 'messages') = 2, 'only this conversation''s messages';
  assert public.assistant_shopper_pdf_data(v_id, repeat('0', 64)) is null, 'never with another token';
  insert into vip_test values ('conv', v_id), ('conv_token', v_token);
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  perform public.owner_set_shopper_pdf((select id from public.shops where slug = 'potraviny-centrum'), false);
  assert (select shopper_pdf from public.shop_assistant_settings
          where shop_id = (select id from public.shops where slug = 'potraviny-centrum')) = false, 'the owner turned it off';
end $$;
reset role;
reset request.jwt.claim.sub;
set role service_role;
do $$
declare
  v_id uuid := (select v::uuid from vip_test where k = 'conv');
begin
  assert not public.shopper_pdf_allowed('potraviny-centrum');
  assert public.assistant_shopper_pdf_data(v_id, (select v from vip_test where k = 'conv_token')) is null, 'turned off: no PDF';
  update public.shop_assistant_settings set shopper_pdf = true where shop_id = (select id from public.shops where slug = 'potraviny-centrum');
  delete from public.assistant_conversations where id = v_id;
  delete from public.shop_pictures where id = (select v::uuid from vip_test where k = 'pic');
  delete from public.shop_documents where folder_id = (select v::uuid from vip_test where k = 'folder');
end $$;
reset role;
set role authenticated;
do $$ begin
  begin
    perform public.assistant_shopper_pdf_data(gen_random_uuid(), 'x');
    raise exception 'a logged-in user called the archive''s function';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
drop table vip_test;

\echo '--- custom domains: price table, owner details, payment once, hostname -> shop, admin (update 25)'
create temporary table dom_test (k text primary key, v text);
grant all on dom_test to public;

-- the admin fills the price table and the settings; nothing else may
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000ad';
do $$ begin
  perform public.admin_save_domain_price('.SK', 1990, 1990, true, 1, true);
  perform public.admin_save_domain_price('eu', 1490, 1590, true, 2, true);
  perform public.admin_save_domain_price('co.uk', 2500, 2500, false, 3, true);
  perform public.admin_save_domain_price('xyz', 900, 900, true, 9, false);
  assert (select price_cents from public.domain_prices where tld = 'sk') = 1990, 'the TLD is cleaned (".SK" -> "sk")';
  perform public.admin_save_domain_settings('https://www.websupport.sk/domeny', true, 30, 'test.example-shop.sk');
  assert (public.admin_domain_stats() ->> 'low_credit_eur')::numeric = 30;
  assert public.admin_domain_stats() ->> 'test_domain' = 'test.example-shop.sk';
  begin
    perform public.admin_save_domain_settings('http://websupport.sk', false, 30, null);
    raise exception 'a search page without https was saved';
  exception when check_violation then null;
  end;
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  begin
    perform public.admin_save_domain_price('com', 1, 1, true, 1, true);
    raise exception 'an owner changed the price table';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.admin_domain_overview();
    raise exception 'an owner read the admin overview';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.admin_domain_stats();
    raise exception 'an owner read the credit';
  exception when insufficient_privilege then null;
  end;
  assert not exists (select 1 from public.domain_settings), 'owners never read the settings row (credit, threshold)';
  assert (select search_url from public.domain_shop_settings()) = 'https://www.websupport.sk/domeny', 'but the search page';
  assert (select same_price_as_registrar from public.domain_shop_settings()), 'and the "same price" switch';
  assert (select count(*) from public.domain_prices) = 3, 'owners see the active prices only';
end $$;
reset role;
set role anon;
do $$ begin
  assert (select count(*) from public.domain_prices) = 3, 'prices are public (shown to shops)';
  begin
    perform public.domain_shop_settings();
    raise exception 'a visitor read the settings';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- the price of a name: the longest TLD it ends with; a subdomain or an unknown TLD has none
set role service_role;
do $$ begin
  assert (public.domain_price_for('davide.sk')).price_cents = 1990;
  assert (public.domain_price_for('obchod.co.uk')).tld = 'co.uk';
  assert (public.domain_price_for('shop.davide.sk')).tld is null, 'only second-level names are sold';
  assert (public.domain_price_for('davide.xyz')).tld is null, 'an inactive TLD is not sold';
  assert (public.domain_price_for('davide.de')).tld is null, 'a TLD not in the table';
end $$;
reset role;

-- the owner's details: the shop's profile first, the rest asked for; never another shop's
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_d jsonb;
begin
  v_d := public.domain_owner_details(v_a);
  assert v_d -> 'missing' ? 'company_name' and v_d -> 'missing' ? 'zip', 'company name and ZIP are asked for';
  assert v_d ->> 'city' = (select city from public.shops where id = v_a), 'the shop''s own town is used';
  begin
    perform public.owner_save_legal(v_a, '{"email": "not-an-email"}');
    raise exception 'a wrong e-mail was saved';
  exception when check_violation then null;
  end;
  begin
    perform public.owner_save_legal(v_a, '{"website": "x"}');
    raise exception 'an unknown field was saved';
  exception when invalid_parameter_value then null;
  end;
  perform public.owner_save_legal(v_a, jsonb_build_object('company_name', 'Potraviny Centrum s.r.o.', 'contact_name', 'Ján Novák',
    'zip', '040 01', 'country', 'sk', 'ico', '12345678', 'email', 'Info@Example.invalid', 'phone', '+421 900 123 456',
    'street', 'Hlavná 1', 'dic', '', 'ic_dph', ''));
  v_d := public.domain_owner_details(v_a);
  assert jsonb_array_length(v_d -> 'missing') = 0, format('nothing missing any more: %s', v_d -> 'missing');
  assert v_d ->> 'country' = 'SK' and v_d ->> 'email' = 'info@example.invalid', 'cleaned';
  assert v_d ->> 'dic' is null, 'an empty DIČ stays empty (never invented)';
  perform public.owner_save_legal(v_a, '{"zip": "04001"}');
  assert (select company_name from public.shop_legal where shop_id = v_a) = 'Potraviny Centrum s.r.o.', 'only the sent field changes';
  begin
    perform public.owner_save_legal(v_b, '{"zip": "1"}');
    raise exception 'an owner wrote another shop''s details';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.domain_owner_details(v_b);
    raise exception 'an owner read another shop''s details';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- flow 13: the price is frozen at the check; the payment is recorded once (a repeated
-- webhook changes nothing); while it is set up the domain is not served
set role service_role;
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_q jsonb;
  v_id uuid;
begin
  begin
    perform public.domain_quote(v_a, 'davide.de', 'https://ppi.example', false);
    raise exception 'a TLD not in the table was quoted';
  exception when no_data_found then null;
  end;
  v_q := public.domain_quote(v_a, 'Davide.SK', 'https://ppi.example', false);
  v_id := (v_q ->> 'id')::uuid;
  assert v_q ->> 'hostname' = 'davide.sk' and (v_q ->> 'price_cents')::int = 1990, 'the shown price';
  -- the admin changes the table afterwards: the shop still pays what it saw
  update public.domain_prices set price_cents = 2490 where tld = 'sk';
  assert (select price_cents from public.domain_orders where id = v_id) = 1990, 'price shown = price charged';
  update public.domain_prices set price_cents = 1990 where tld = 'sk';
  -- a second check replaces the first quote
  v_q := public.domain_quote(v_a, 'davide2.sk', 'https://ppi.example', false);
  assert not exists (select 1 from public.domain_orders where id = v_id), 'one quote per shop';
  v_id := (v_q ->> 'id')::uuid;
  update public.domain_orders set status = 'checkout', stripe_session = 'cs_test_1' where id = v_id;

  assert public.domain_payment_received(v_id, 'cs_test_1', null, 'pi_1', null) = 'recorded';
  assert public.domain_payment_received(v_id, 'cs_test_1', 'in_1', 'pi_1', 'https://invoice.example/1') = 'duplicate',
    'a repeated webhook changes nothing';
  assert (select status || ' ' || attempts || ' ' || stripe_invoice from public.domain_orders where id = v_id) = 'paid 0 in_1',
    'still one paid order; the invoice of the later event is kept';
  assert (select log -> 0 ->> 'step' from public.domain_orders where id = v_id) = 'paid', 'logged with its time';
  assert public.domain_payment_received(gen_random_uuid(), null, null, null, null) = 'not_found';

  -- the shop's e-mail: its own address, else its owners'
  assert public.domain_shop_emails(v_a) is not null and cardinality(public.domain_shop_emails(v_a)) >= 1;
  -- a renewal is recorded once
  update public.domain_orders set expires_at = now() + interval '20 days', renewal_state = 'due' where id = v_id;
  assert public.domain_renewal_paid(v_id, 'in_r1'), 'the renewal is paid';
  assert not public.domain_renewal_paid(v_id, 'in_r1'), 'a repeated event changes nothing';
  update public.domain_orders set expires_at = null, renewal_state = 'none', renewal_invoice = null, renewal_paid_until = null where id = v_id;
  -- one worker at a time
  assert (select count(*) from public.domain_claim(10)) = 1;
  assert (select count(*) from public.domain_claim(10)) = 0, 'a claimed order is not handed out twice';
  assert not public.domain_claim_one(v_id), 'a claimed order is not run twice';
  update public.domain_orders set claimed_until = null where id = v_id;
  assert public.domain_claim_one(v_id), 'one order now';
  assert not public.domain_claim_one(v_id), 'and only once';
  update public.domain_orders set claimed_until = null where id = v_id;

  -- the host is the shop's while it is set up; nobody else can start it
  begin
    perform public.domain_connect_start(v_a, 'other-domain.sk', true, 'https://ppi.example');
    raise exception 'a second domain for the same shop';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    insert into public.domain_orders (shop_id, kind, hostname, status) values (v_b, 'connected', 'davide2.sk', 'waiting_dns');
    raise exception 'the same host for two shops';
  exception when unique_violation then null;
  end;
  assert (select count(*) from public.shop_for_host('davide2.sk')) = 0, 'not served before it is live';

  -- live: served on the bare host and on www (the bare one is the address)
  update public.domain_orders set status = 'live', site_host = 'davide2.sk', live_at = now() where id = v_id;
  insert into dom_test values ('bought', v_id);

  -- a payment for an order that was given up meanwhile: kept apart, refunded by the function
  insert into public.domain_orders (shop_id, kind, hostname, status, price_cents, renewal_cents, vat_included)
  values (v_a, 'bought', 'old-name.sk', 'canceled', 1990, 1990, true) returning id into v_id;
  assert public.domain_payment_received(v_id, 'cs_old', null, 'pi_old', null) = 'orphan', 'refund, never a second domain';
  assert (select status from public.domain_orders where id = v_id) = 'canceled';
end $$;
reset role;
set role anon;
do $$ begin
  assert (select slug || ' ' || primary_host || ' ' || site_lang from public.shop_for_host('davide2.sk'))
         = 'potraviny-centrum davide2.sk sk', 'hostname -> shop';
  assert (select primary_host from public.shop_for_host('WWW.Davide2.sk ')) = 'davide2.sk', 'www answers too';
  assert (select count(*) from public.shop_for_host('evil.davide2.sk')) = 0;
  assert public.shop_site('potraviny-centrum') = 'davide2.sk', 'the canonical address';
  assert (select count(*) from public.live_shop_sites()) = 1;
  begin
    perform 1 from public.domain_orders;
    raise exception 'a visitor read domain orders';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- owners read their own orders only; connecting needs the plan; the admin sees every shop
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$ begin
  assert (select count(*) from public.domain_orders) = 0, 'owner B sees none of A''s domains';
  begin
    perform public.domain_connect_start((select id from public.shops where slug = 'drogeria-kostolne'), 'b-shop.sk', true, 'x');
    raise exception 'an owner called the function''s own step';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set role service_role;
do $$ begin
  begin
    perform public.domain_connect_start((select id from public.shops where slug = 'drogeria-kostolne'), 'b-shop.sk', true, 'x');
    raise exception 'a shop without the plan connected a domain';
  exception when object_not_in_prerequisite_state then null;
  end;
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  assert (select count(*) from public.domain_orders) = 2, 'owner A sees its own orders';
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000ad';
do $$ begin
  assert (select status from public.admin_domain_overview('davide2', null, null)) = 'live', 'the admin finds the shop by its domain';
  assert (select count(*) from public.admin_domain_overview(null, 'none', null)) >= 1, 'shops without a domain are listed too';
  assert (select count(*) from public.admin_domain_overview()) = (select count(*) from public.shops), 'one row per shop';
  perform public.admin_resolve_domain((select v::uuid from dom_test where k = 'bought'));
  assert (public.admin_domain_stats() ->> 'live')::int = 1;
end $$;
reset role;

-- the plan ends: the domain is no longer served (the shop is back on its Cacaduu address)
set role service_role;
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_end timestamptz := (select current_period_end from public.subscriptions where shop_id = v_a);
begin
  update public.subscriptions set current_period_end = now() - interval '1 minute' where shop_id = v_a;
  assert (select count(*) from public.shop_for_host('davide2.sk')) = 0, 'no plan: not served';
  assert public.shop_site('potraviny-centrum') is null, 'no canonical to it either';
  update public.subscriptions set current_period_end = v_end where shop_id = v_a;
  -- the credit: once a day under the threshold
  assert public.domain_set_credit(12.50), 'under the threshold: e-mail the admin';
  assert not public.domain_set_credit(11), 'not twice in a day';
  assert not public.domain_set_credit(500), 'enough credit';
  delete from public.domain_orders where shop_id = v_a;
  delete from public.shop_legal where shop_id = v_a;
end $$;
reset role;
drop table dom_test;

\echo '--- booking link and product pages without other shops (update 26)'
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_shop jsonb := jsonb_build_object('id', (select id from public.shops where slug = 'potraviny-centrum'),
    'name', 'Potraviny Centrum', 'timezone', 'Europe/Bratislava', 'country', 'SK', 'city', 'Michalovce',
    'address', 'Námestie osloboditeľov 10', 'lat', '48.7547', 'lng', '21.9185', 'phone', '+421 56 000 0001',
    'is_active', 'true', 'has_toilet', 'true', 'has_douchette', 'true', 'has_card_terminal', 'true',
    'email', 'info@potraviny.sk', 'facebook_url', 'https://fb.com/potravinycentrum');
  v_r text;
begin
  -- tidied like the other links: https:// added, http:// upgraded
  perform public.owner_save_shop(v_shop || jsonb_build_object('booking_url', ' reservio.com/potraviny-centrum '));
  assert (select booking_url from public.shops where id = v_a) = 'https://reservio.com/potraviny-centrum';
  perform public.owner_save_shop(v_shop || jsonb_build_object('booking_url', 'http://www.bookio.com/potraviny?lang=sk#termin'));
  assert (select booking_url from public.shops where id = v_a) = 'https://www.bookio.com/potraviny?lang=sk#termin';
  perform public.owner_save_shop(v_shop || jsonb_build_object('booking_url', 'https://xn--rezervcia-x2a.sk/potraviny'));
  assert (select booking_url from public.shops where id = v_a) = 'https://xn--rezervcia-x2a.sk/potraviny', 'an IDN host (punycode)';
  -- a form without the field keeps it; an empty field removes it
  perform public.owner_save_shop(v_shop);
  assert (select booking_url from public.shops where id = v_a) = 'https://xn--rezervcia-x2a.sk/potraviny', 'kept when not sent';
  perform public.owner_save_shop(v_shop || jsonb_build_object('booking_url', '  '));
  assert (select booking_url from public.shops where id = v_a) is null, 'an empty field removes it';
  -- only a web address of a real host
  foreach v_r in array array['javascript:alert(1)', 'ftp://reservio.com/x', 'https://localhost/x', 'https://10.0.0.10/x',
                             'https://reservio.com/a b', 'https://evil.com@reservio.com/x', 'https://reservio.com/"><script>',
                             'data:text/html,hi', 'https://' || repeat('a', 490) || '.com'] loop
    begin
      perform public.owner_save_shop(v_shop || jsonb_build_object('booking_url', v_r));
      raise exception 'bad booking link accepted: %', v_r;
    exception when invalid_parameter_value then assert sqlerrm = 'booking', sqlerrm;
    end;
  end loop;
  perform public.owner_save_shop(v_shop || jsonb_build_object('booking_url', 'https://calendly.com/potraviny-centrum/30min'));
  begin
    update public.shops set booking_url = 'javascript:alert(1)' where id = v_a;
    raise exception 'bad booking link written directly';
  exception when check_violation then null;
  end;
  begin
    perform public.owner_save_shop(jsonb_build_object('id', v_b, 'name', 'x', 'booking_url', 'https://reservio.com/x'));
    raise exception 'owner A saved shop B''s booking link';
  exception when insufficient_privilege then null;
  end;
  assert (select booking_url from public.my_shops() where id = v_a) = 'https://calendly.com/potraviny-centrum/30min',
    'the owner reads it back';
end $$;
reset role;
reset request.jwt.claim.sub;

set role anon;
do $$ begin
  assert (select booking_url from public.public_shops where slug = 'potraviny-centrum')
         = 'https://calendly.com/potraviny-centrum/30min', 'the shop page reads the booking link';
  assert (select booking_url from public.public_shops where slug = 'drogeria-kostolne') is null;
  assert public.shop_stands_alone((select id from public_shops where slug = 'potraviny-centrum')), 'paid plan: no other shops';
  assert not public.shop_stands_alone((select id from public_shops where slug = 'drogeria-kostolne')), 'free shop: other shops shown';
end $$;
reset role;

set role service_role;
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_end timestamptz := (select current_period_end from public.subscriptions where shop_id = v_a);
  v_o uuid;
begin
  -- a domain of its own being set up or live: no other shops either
  insert into public.domain_orders (shop_id, kind, hostname, status) values (v_b, 'connected', 'drogeria26.sk', 'waiting_dns')
  returning id into v_o;
  assert public.shop_stands_alone(v_b), 'domain being connected';
  update public.domain_orders set status = 'live' where id = v_o;
  assert public.shop_stands_alone(v_b), 'domain live';
  update public.domain_orders set status = 'canceled' where id = v_o;
  assert not public.shop_stands_alone(v_b), 'a cancelled domain does not count';
  update public.domain_orders set status = 'quoted' where id = v_o;
  assert not public.shop_stands_alone(v_b), 'nor a price quote';
  delete from public.domain_orders where id = v_o;
  -- the plan ends: other shops come back
  update public.subscriptions set current_period_end = now() - interval '1 minute' where shop_id = v_a;
  assert not public.shop_stands_alone(v_a), 'plan ended';
  update public.subscriptions set current_period_end = v_end where shop_id = v_a;
end $$;
reset role;

\echo '--- shop status: public holidays, special days, automatic holidays (update 27)'
set role anon;
do $$
declare v_n integer;
begin
  -- Slovakia: days off, not every state holiday (2026: no 8.5, 1.9, 15.9, 17.11; 2027: 8.5 and 15.9 again)
  select count(*) into v_n from public.holidays_between('SK', '2026-01-01', '2026-12-31');
  assert v_n = 12, format('SK 2026: 11 days off + Easter Sunday (shops closed), got %s', v_n);
  assert not exists (select 1 from public.holidays_between('sk', '2026-01-01', '2026-12-31')
                     where date in ('2026-05-08', '2026-09-01', '2026-09-15', '2026-11-17')), 'no longer days off in 2026';
  assert (select string_agg(to_char(date, 'MM-DD'), ',' order by date) from public.holidays_between('SK', '2026-01-01', '2026-12-31')
          where kind = 'shops_closed') = '01-01,04-03,04-05,12-24,12-25,12-26', 'shops closed by law';
  assert (select closed_from from public.holidays_between('SK', '2026-12-24', '2026-12-24')) = '12:00', '24.12 from 12:00';
  assert (select kind from public.holidays_between('SK', '2026-01-06', '2026-01-06')) = 'day_off';
  assert exists (select 1 from public.holidays_between('SK', '2027-01-01', '2027-12-31') where date = '2027-05-08' and kind = 'day_off');
  assert exists (select 1 from public.holidays_between('SK', '2027-01-01', '2027-12-31') where date = '2027-09-15' and kind = 'day_off');
  assert not exists (select 1 from public.holidays_between('SK', '2027-01-01', '2027-12-31') where date in ('2027-09-01', '2027-11-17'));
  assert (select count(*) from public.holidays_between('HU', '2026-01-01', '2026-12-31')) >= 10, 'Hungary';
  assert (select count(*) from public.holidays_between('CZ', '2026-01-01', '2026-12-31')) >= 10, 'Czechia';
  assert (select name_en from public.holidays_between('SK', '2026-12-25', '2026-12-25')) = 'Christmas Day';
  begin
    insert into public.public_holidays (country, date, kind) values ('SK', '2026-03-01', 'day_off');
    raise exception 'a visitor wrote a holiday';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- an owner cannot write holidays, directly or through the admin functions
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  begin
    insert into public.public_holidays (country, date, kind, source) values ('SK', '2026-03-01', 'day_off', 'admin');
    raise exception 'an owner wrote a holiday';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.admin_save_holiday('SK', '2026-03-01', 'day_off', null, 'x', null, null);
    raise exception 'an owner used admin_save_holiday';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.admin_holidays('SK', 2026);
    raise exception 'an owner listed holidays as the admin';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- the admin's rows win over the library's and survive a new run of the script
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000ad';
do $$ begin
  perform public.admin_save_holiday('SK', '2026-05-08', 'day_off', null, 'Deň víťazstva nad fašizmom', null, 'Victory Day');
  perform public.admin_save_holiday('SK', '2026-01-06', 'removed', null, null, null, null);
  perform public.admin_save_holiday('SK', '2026-12-31', 'shops_closed', '14:00', '<b>Silvester</b>', null, null);
  assert exists (select 1 from public.holidays_between('SK', '2026-05-08', '2026-05-08')), 'admin adds a date';
  assert not exists (select 1 from public.holidays_between('SK', '2026-01-06', '2026-01-06')), 'admin removes a library date';
  assert (select name_sk || ' ' || closed_from from public.holidays_between('SK', '2026-12-31', '2026-12-31')) = 'Silvester 14:00',
    'admin row, plain text name';
  assert (select count(*) from public.admin_holidays('SK', 2026) where date = '2026-01-06') = 2, 'both rows listed';
  assert (select counts from public.admin_holidays('SK', 2026) where date = '2026-01-06' and source = 'library') = false;
  begin
    perform public.admin_save_holiday('SK', '2026-03-02', 'day_off', '12:00', null, null, null);
    assert (select closed_from from public.public_holidays where country = 'SK' and date = '2026-03-02' and source = 'admin') is null,
      'closed_from only for shops_closed';
  end;
  perform public.admin_delete_holiday('SK', '2026-03-02');
end $$;
reset role;
-- the script runs again (library rows only): the admin's rows stay and still win
insert into public.public_holidays (country, date, name_sk, name_hu, name_en, kind, closed_from, source) values
  ('SK', '2026-01-06', 'Zjavenie Pána', 'Vízkereszt', 'Epiphany', 'day_off', null, 'library')
on conflict (country, date, source) do update set name_sk = excluded.name_sk, kind = excluded.kind, updated_at = now();
do $$ begin
  assert (select kind from public.public_holidays where country = 'SK' and date = '2026-01-06' and source = 'admin') = 'removed';
  assert not exists (select 1 from public.holidays_between('SK', '2026-01-06', '2026-01-06')), 'still removed after the script';
end $$;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000ad';
do $$ begin
  assert public.admin_delete_holiday('SK', '2026-01-06'), 'admin row deleted';
  assert exists (select 1 from public.holidays_between('SK', '2026-01-06', '2026-01-06')), 'the library row counts again';
  perform public.admin_delete_holiday('SK', '2026-05-08');
  perform public.admin_delete_holiday('SK', '2026-12-31');
end $$;
reset role;

-- special days: only the shop's owner writes them, through the owner function
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_d date := current_date + 3;
  v_r jsonb;
begin
  assert public.owner_save_special_hours(v_a, v_d, v_d + 2, true, null, ' Inventúra  www.example.com ') = 3, 'a date range';
  assert (select count(*) from public.shop_special_hours where shop_id = v_a and closed) = 3;
  assert (select note from public.shop_special_hours where shop_id = v_a and date = v_d) = 'Inventúra', 'note: plain text';
  assert public.owner_save_special_hours(v_a, v_d, null, false, '[["08:00","12:00"],["12:30","17:00"]]', null) = 1, 'other hours with a break';
  assert (select ranges from public.shop_special_hours where shop_id = v_a and date = v_d) = '[["08:00","12:00"],["12:30","17:00"]]'::jsonb;
  assert public.owner_save_special_hours(v_a, v_d + 1, null, false, '[["22:00","02:00"]]', null) = 1, 'past midnight';
  foreach v_r in array array['[]', '[["25:00","26:00"]]', '[["08:00","08:00"]]', '[["8:00","12:00"]]', '"x"',
                             '[["08:00","09:00"],["09:00","10:00"],["10:00","11:00"],["11:00","12:00"],["13:00","14:00"]]']::jsonb[] loop
    begin
      perform public.owner_save_special_hours(v_a, v_d, null, false, v_r, null);
      raise exception 'bad ranges accepted: %', v_r;
    exception when invalid_parameter_value then assert sqlerrm = 'ranges', sqlerrm;
    end;
  end loop;
  begin
    perform public.owner_save_special_hours(v_a, current_date - 5, null, true, null, null);
    raise exception 'a past date accepted';
  exception when invalid_parameter_value then assert sqlerrm = 'dates', sqlerrm;
  end;
  begin
    perform public.owner_save_special_hours(v_a, v_d, v_d + 70, true, null, null);
    raise exception 'a 71-day range accepted';
  exception when invalid_parameter_value then assert sqlerrm = 'dates', sqlerrm;
  end;
  begin
    perform public.owner_save_special_hours(v_a, v_d, null, true, null, repeat('x', 150));
    assert (select length(note) from public.shop_special_hours where shop_id = v_a and date = v_d) = 100, 'note at most 100';
  end;
  begin
    perform public.owner_save_special_hours(v_b, v_d, null, true, null, null);
    raise exception 'owner A saved shop B''s special hours';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.shop_special_hours (shop_id, date, closed) values (v_a, v_d + 10, true);
    raise exception 'special hours written directly';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.owner_delete_special_hours(v_b, v_d);
    raise exception 'owner A deleted shop B''s special hours';
  exception when insufficient_privilege then null;
  end;
  assert public.owner_delete_special_hours(v_a, v_d + 2), 'deleted';
  assert (select count(*) from public.shop_special_hours where shop_id = v_a) = 2;

  -- "Automatické štátne sviatky": only through the owner function
  begin
    update public.shops set auto_holidays = false where id = v_a;
    raise exception 'auto_holidays written directly';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.owner_set_auto_holidays(v_b, false);
    raise exception 'owner A switched shop B''s holidays';
  exception when insufficient_privilege then null;
  end;
  assert (select auto_holidays from public.shops where id = v_a), 'on by default';
end $$;
reset role;

-- the calendar: holidays only with the switch on, special days always, an admin row wins
set role anon;
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_h uuid := (select id from public.shops where slug = 'kisbolt-budapest');
  v_d date := current_date + 3;
begin
  assert (select count(*) from public.shop_special_hours where shop_id = v_a) = 2, 'visitors read special days';
  assert (select holiday_kind || ' ' || holiday_closed_from from public.shop_calendar(array[v_a, v_h], '2026-12-20', '2027-01-10')
          where shop_id = v_a and date = '2026-12-24') = 'shops_closed 12:00';
  assert (select holiday_kind from public.shop_calendar(array[v_a, v_h], '2026-12-20', '2027-01-10')
          where shop_id = v_h and date = '2026-12-25') = 'day_off', 'Hungarian shop: Hungarian holidays';
  assert not exists (select 1 from public.shop_calendar(array[v_h], '2026-12-20', '2026-12-31') where date = '2026-12-24'),
    'no Slovak holiday for a Hungarian shop';
  assert (select special_closed::text || ' ' || coalesce(holiday_kind, '-') from public.shop_calendar(array[v_a], v_d, v_d + 1)
          where date = v_d) = 'true -', 'special day (closed) without a holiday';
  assert (select special_ranges from public.shop_calendar(array[v_a], v_d, v_d + 1) where date = v_d + 1) = '[["22:00","02:00"]]'::jsonb;
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_d date := current_date + 3;
begin
  assert public.owner_set_auto_holidays(v_a, false) = false;
  assert not exists (select 1 from public.shop_calendar(array[v_a], '2026-12-20', '2027-01-10') where holiday_kind is not null),
    'switch off: no holidays';
  assert (select count(*) from public.shop_calendar(array[v_a], v_d, v_d + 5)) = 2, 'switch off: special days still apply';
  assert public.owner_set_auto_holidays(v_a, true);
  assert exists (select 1 from public.shop_calendar(array[v_a], '2026-12-20', '2027-01-10') where holiday_kind = 'shops_closed');
  begin
    delete from public.shop_special_hours where shop_id = v_a;
    raise exception 'special hours deleted directly';
  exception when insufficient_privilege then null;
  end;
  perform public.owner_delete_special_hours(v_a, v_d);
  perform public.owner_delete_special_hours(v_a, v_d + 1);
end $$;
reset role;
reset request.jwt.claim.sub;

\echo '--- page sections from PDFs and the header picture (update 28)'
-- potraviny-centrum (owner A) with the paid plan; drogeria-kostolne (owner B) without
do $$ begin
  perform public.apply_stripe_subscription((select id from public.shops where slug = 'potraviny-centrum'),
    'cus_A1', 'sub_A1', 'active', 'pro', now() + interval '30 days', null);
  perform public.apply_stripe_subscription((select id from public.shops where slug = 'drogeria-kostolne'),
    'cus_B1', 'sub_B1', 'canceled', 'pro', now() - interval '1 day', null);
  assert public.shop_has_plan((select id from public.shops where slug = 'potraviny-centrum'));
  assert not public.shop_has_plan((select id from public.shops where slug = 'drogeria-kostolne'));
end $$;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_s uuid;
  v_t uuid;
  v_i integer;
begin
  -- an owner adds a section (plain text title), at the end of its position
  v_s := public.owner_save_section(v_a, null, '  <b>Novinky</b> október ', 'collapsed', 'after_details', false, null, null);
  assert (select title from public.shop_page_sections where id = v_s) = 'Novinky október', 'plain text title';
  v_t := public.owner_save_section(v_a, null, 'Leták', 'open', 'after_details', true, current_date - 1, current_date + 30);
  assert (select sort from public.shop_page_sections where id = v_t) = 1 + (select sort from public.shop_page_sections where id = v_s);
  -- wrong input
  foreach v_i in array array[1, 2, 3] loop
    begin
      if v_i = 1 then perform public.owner_save_section(v_a, null, '   ', 'open', 'end', false, null, null); end if;
      if v_i = 2 then perform public.owner_save_section(v_a, null, 'x', 'open', 'end', false, current_date, current_date - 1); end if;
      if v_i = 3 then perform public.owner_save_section(v_a, null, 'x', 'wide', 'end', false, null, null); end if;
      raise exception 'bad section accepted (%)', v_i;
    exception when raise_exception then
      assert sqlerrm in ('title', 'dates', 'bad'), sqlerrm;
    end;
  end loop;
  -- another shop's sections: never
  begin
    perform public.owner_save_section(v_b, null, 'x', 'open', 'end', false, null, null);
    raise exception 'owner A added a section to shop B';
  exception when insufficient_privilege then null;
  end;
  -- no direct writes, no public reading of the tables
  begin
    update public.shop_page_sections set published = true where id = v_s;
    raise exception 'section written directly';
  exception when insufficient_privilege then null;
  end;
  -- publishing needs a PDF
  begin
    perform public.owner_set_section_state(v_s, 'publish');
    raise exception 'published without a PDF';
  exception when raise_exception then assert sqlerrm = 'empty', sqlerrm;
  end;
  -- at most 10 per shop
  for v_i in 3..10 loop
    perform public.owner_save_section(v_a, null, 'S' || v_i, 'collapsed', 'end', false, null, null);
  end loop;
  begin
    perform public.owner_save_section(v_a, null, 'S11', 'collapsed', 'end', false, null, null);
    raise exception 'an 11th section';
  exception when raise_exception then assert sqlerrm = 'limit', sqlerrm;
  end;
  -- reorder within a position; moving to another position puts it last there
  perform public.owner_reorder_sections(v_a, 'after_details', array[v_t, v_s]);
  assert (select sort from public.shop_page_sections where id = v_t) = 0 and (select sort from public.shop_page_sections where id = v_s) = 1;
  perform public.owner_save_section(v_a, v_s, 'Novinky október', 'collapsed', 'end', false, null, null);
  assert (select sort from public.shop_page_sections where id = v_s) = 8, 'moved last into "end"';
  perform public.owner_save_section(v_a, v_s, 'Novinky október', 'collapsed', 'after_details', false, null, null);
  -- the files of a section are listed only for its owner
  assert (select count(*) from public.owner_section_files(v_s)) = 0;
end $$;
reset role;
reset request.jwt.claim.sub;

-- owner B sees and touches nothing of shop A
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare v_s uuid := (select id from public.shop_page_sections where title = 'Novinky október' limit 1);
begin
  assert v_s is null, 'owner B reads shop A''s sections';
  v_s := (select id from public.shop_page_sections limit 1);
  assert v_s is null;
end $$;
do $$
declare v_s uuid;
begin
  set role postgres;
  v_s := (select id from public.shop_page_sections where title = 'Novinky október');
  set role authenticated;
  begin
    perform public.owner_set_section_state(v_s, 'hide');
    raise exception 'owner B hid shop A''s section';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.owner_section_files(v_s);
    raise exception 'owner B listed shop A''s files';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.sections_begin_upload(v_s, 3, 1000);
    raise exception 'an owner called a function-only step';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

-- the function's steps (service role): a 3-page PDF, pictures, text, live; then shown on the page
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_s uuid := (select id from public.shop_page_sections where title = 'Novinky október');
  v_t uuid := (select id from public.shop_page_sections where title = 'Leták');
  v_v integer;
  v_r record;
begin
  delete from public.shop_page_sections where shop_id = v_a and title ~ '^S[0-9]+$';
  select * into v_r from public.sections_begin_upload(v_s, 3, 250000);
  v_v := v_r.version;
  assert v_v = 1 and v_r.pdf_path = format('%s/%s/v1/section.pdf', v_a, v_s) and v_r.stale_paths = '{}';
  assert (select count(*) from public.shop_section_pages where section_id = v_s and version = 1) = 3;
  begin
    perform public.sections_begin_upload(v_s, 21, 250000);
    raise exception '21 pages accepted';
  exception when raise_exception then assert sqlerrm = 'limits';
  end;
  -- not complete yet: no going live
  begin
    perform public.sections_finish(v_s, v_v);
    raise exception 'finished without pictures';
  exception when raise_exception then assert sqlerrm = 'incomplete';
  end;
  for i in 1..3 loop
    perform public.sections_page_stored(v_s, v_v, i, 800, 'webp', 60000, 800, 1131);
    perform public.sections_page_stored(v_s, v_v, i, 1600, 'webp', 200000, 1600, 2263);
  end loop;
  perform public.sections_save_text(v_s, v_v,
    '[{"page":1,"text":"Novinky október: nové farby Primalex za 19,90 €"},{"page":2,"text":"Otváracie hodiny cez sviatky"},{"page":3,"text":""}]', 'sk');
  assert (select needs_ai from public.shop_section_pages where section_id = v_s and page = 3), 'a page without text goes to the AI';
  select * into v_r from public.sections_finish(v_s, v_v);
  assert (select version from public.shop_page_sections where id = v_s) = 1;
  assert (select pdf_path from public.shop_page_sections where id = v_s) = format('%s/%s/v1/section.pdf', v_a, v_s);
  assert (select upload_version from public.shop_page_sections where id = v_s) is null;
  -- the AI reads page 3
  assert (select count(*) from public.sections_claim_ai(v_s, 5)) = 1;
  perform public.sections_save_ai_text((select id from public.shop_section_pages where section_id = v_s and page = 3),
    'Akcia: valček 4,50 €', null);
  assert not (select needs_ai from public.shop_section_pages where section_id = v_s and page = 3);
  -- not published yet: not visible, nothing to sync
  assert not public.section_visible(v_s);
  assert (select count(*) from public.sections_to_sync(v_s)) = 0;
end $$;

-- owner A publishes it (after the preview); the function moves the pictures; visitors see it
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare v_s uuid := (select id from public.shop_page_sections where title = 'Novinky október');
begin
  assert public.owner_set_section_state(v_s, 'publish'), 'published = visible now';
end $$;
reset role;
reset request.jwt.claim.sub;

do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_s uuid := (select id from public.shop_page_sections where title = 'Novinky október');
  v_r record;
begin
  select * into v_r from public.sections_to_sync(v_s);
  assert v_r.visible and v_r.version = 1 and v_r.public_version is null and jsonb_array_length(v_r.pages) = 3;
  -- before the pictures are public, visitors get nothing
  assert (select count(*) from public.shop_sections('potraviny-centrum')) = 0, 'not before the pictures are public';
  perform public.sections_mark_public(v_s, 1);
  assert (select count(*) from public.sections_to_sync(v_s)) = 0;
end $$;

set role anon;
do $$
declare v_r record;
begin
  select * into v_r from public.shop_sections('potraviny-centrum');
  assert v_r.title = 'Novinky október' and v_r.display = 'collapsed' and v_r.position = 'after_details' and not v_r.allow_download;
  assert jsonb_array_length(v_r.pages) = 3 and (v_r.pages -> 0 ->> 'width')::int = 1600 and (v_r.pages -> 0 ->> 'ext') = 'webp';
  assert (v_r.pages -> 2 ->> 'text') = 'Akcia: valček 4,50 €', 'the text as written (AI page)';
  -- the assistant finds it, named by the section's title, page by page
  assert exists (select 1 from public.search_shop_docs('potraviny-centrum', 'primalex', null) where source = 'Novinky október' and page = 1),
    'the assistant finds a shown section';
  assert exists (select 1 from public.shop_docs_list('potraviny-centrum', null) where name = 'Novinky október' and pages = 3);
  -- the tables themselves: not for visitors
  begin
    perform 1 from public.shop_page_sections;
    raise exception 'a visitor read the sections table';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.shop_section_pdf('potraviny-centrum', v_r.id);
    raise exception 'a visitor got a PDF path';
  exception when insufficient_privilege then null;
  end;
  -- free shops: none
  assert (select count(*) from public.shop_sections('drogeria-kostolne')) = 0;
end $$;
reset role;

do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_s uuid := (select id from public.shop_page_sections where title = 'Novinky október');
  v_r record;
begin
  -- download only when the owner allows it
  assert (select count(*) from public.shop_section_pdf('potraviny-centrum', v_s)) = 0, 'download off';
  update public.shop_page_sections set allow_download = true where id = v_s;
  assert (select path from public.shop_section_pdf('potraviny-centrum', v_s)) = format('%s/%s/v1/section.pdf', v_a, v_s);
  assert (select count(*) from public.shop_section_pdf('drogeria-kostolne', v_s)) = 0, 'only under its own shop';
  -- visible until yesterday (the shop's day): gone from the page and the assistant at once, pictures must leave
  update public.shop_page_sections set visible_until = public.shop_today(v_a) - 1, visible_from = null where id = v_s;
  assert not public.section_visible(v_s);
  assert (select count(*) from public.shop_sections('potraviny-centrum')) = 0, 'expired: not on the page';
  assert not exists (select 1 from public.search_shop_docs('potraviny-centrum', 'primalex', null)), 'expired: not for the assistant';
  assert (select count(*) from public.shop_section_pdf('potraviny-centrum', v_s)) = 0, 'expired: no download';
  select * into v_r from public.sections_to_sync(null) where id = v_s;
  assert not v_r.visible and v_r.public_version = 1, 'the hourly job removes its pictures';
  perform public.sections_mark_public(v_s, null);
  -- visible from tomorrow: not yet
  update public.shop_page_sections set visible_until = null, visible_from = public.shop_today(v_a) + 1 where id = v_s;
  assert not public.section_visible(v_s);
  update public.shop_page_sections set visible_from = public.shop_today(v_a) where id = v_s;
  assert public.section_visible(v_s), 'from today: visible';
  perform public.sections_mark_public(v_s, 1);
  -- hidden: gone
  update public.shop_page_sections set hidden = true where id = v_s;
  assert (select count(*) from public.shop_sections('potraviny-centrum')) = 0, 'hidden';
  update public.shop_page_sections set hidden = false where id = v_s;
  assert (select count(*) from public.shop_sections('potraviny-centrum')) = 1;
  -- the paid plan ends: since update 30 a free shop keeps its first section (the free limit);
  -- with no free sections allowed it is hidden (not deleted), and back when the plan returns
  update public.subscriptions set current_period_end = now() - interval '1 minute' where shop_id = v_a;
  assert (select count(*) from public.shop_sections('potraviny-centrum')) = 1, 'plan ended: the first one stays';
  update public.section_limits set max_sections = 0 where plan = 'free';
  assert (select count(*) from public.shop_sections('potraviny-centrum')) = 0, 'plan ended, no free sections: hidden';
  assert exists (select 1 from public.sections_to_sync(null) where id = v_s and not visible), 'plan ended: pictures leave';
  assert exists (select 1 from public.shop_page_sections where id = v_s), 'plan ended: not deleted';
  update public.section_limits set max_sections = 1 where plan = 'free';
  update public.subscriptions set current_period_end = now() + interval '30 days' where shop_id = v_a;
  assert (select count(*) from public.shop_sections('potraviny-centrum')) = 1, 'plan back: shown again';
  -- a new PDF for the section: the live one stays until the new one is complete
  select * into v_r from public.sections_begin_upload(v_s, 1, 90000);
  assert v_r.version = 2;
  assert (select count(*) from public.shop_sections('potraviny-centrum')) = 1, 'the old PDF stays while the new one is made';
  perform public.sections_page_stored(v_s, 2, 1, 800, 'jpg', 50000, 800, 566);
  begin
    perform public.sections_page_stored(v_s, 2, 1, 1600, 'webp', 50000, 1600, 1131);
    raise exception 'two picture types on one page';
  exception when raise_exception then assert sqlerrm = 'page';
  end;
  perform public.sections_page_stored(v_s, 2, 1, 1600, 'jpg', 150000, 1600, 1131);
  perform public.sections_save_text(v_s, 2, '[{"page":1,"text":"Nový leták"}]', 'sk');
  select * into v_r from public.sections_finish(v_s, 2);
  assert format('%s/%s/v1/section.pdf', v_a, v_s) = any (v_r.old_paths) and array_length(v_r.old_paths, 1) = 7,
    'the old PDF and its 6 pictures are removed';
  assert array_length(v_r.old_public_paths, 1) = 6, 'and its public copies';
  assert (select count(*) from public.shop_section_pages where section_id = v_s) = 1;
  assert (select count(*) from public.shop_sections('potraviny-centrum')) = 0, 'shown again once the new pictures are public';
  perform public.sections_mark_public(v_s, 2);
  assert (select pages ->> 0 from public.shop_sections('potraviny-centrum')) is not null;
end $$;

-- deleting: files listed for the owner; a shop with sections cannot be deleted before them
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_s uuid := (select id from public.shop_page_sections where title = 'Novinky október');
begin
  assert (select count(*) from public.owner_section_files(v_s)) = 5, 'PDF + 2 pictures in each bucket';
  assert exists (select 1 from public.owner_section_files(v_s) where bucket = 'shop-sections-public' and path like '%/v2/1-1600.jpg');
  assert (select count(*) from public.shop_page_sections) = 2, 'the owner reads only their own sections';
  assert (select count(*) from public.shop_section_pages) = 1;
end $$;
reset role;
reset request.jwt.claim.sub;

-- the header picture of an own domain: only through the owner function, only the shop's own folder
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_url text := 'https://abc.supabase.co/storage/v1/object/public/logos/' || (select id from public.shops where slug = 'potraviny-centrum') || '/header-1760000000000';
begin
  perform public.owner_set_header_picture(v_a, v_url || '.webp', v_url || '-800.webp', 1600, 400);
  assert (select width from public.shop_header_picture('potraviny-centrum')) = 1600;
  begin
    perform public.owner_set_header_picture(v_a, 'https://evil.example/x.webp', v_url || '-800.webp', 1600, 400);
    raise exception 'a picture from elsewhere';
  exception when invalid_parameter_value then assert sqlerrm = 'picture';
  end;
  begin
    perform public.owner_set_header_picture(v_a, replace(v_url, v_a::text, v_b::text) || '.webp',
      replace(v_url, v_a::text, v_b::text) || '-800.webp', 1600, 400);
    raise exception 'another shop''s folder';
  exception when invalid_parameter_value then null;
  end;
  begin
    update public.shops set header_url = null, header_small_url = null, header_width = null, header_height = null where id = v_a;
    raise exception 'header picture changed directly';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.owner_set_header_picture(v_b, v_url || '.webp', v_url || '-800.webp', 1600, 400);
    raise exception 'owner A set shop B''s header';
  exception when insufficient_privilege then null;
  end;
  perform public.owner_set_header_picture(v_a, null, null, null, null);
  assert (select count(*) from public.shop_header_picture('potraviny-centrum')) = 0;
end $$;
reset role;
reset request.jwt.claim.sub;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_url text := 'https://abc.supabase.co/storage/v1/object/public/logos/' || (select id from public.shops where slug = 'drogeria-kostolne') || '/header-1760000000000';
begin
  begin
    perform public.owner_set_header_picture(v_b, v_url || '.webp', v_url || '-800.webp', 1600, 400);
    raise exception 'a free shop without a domain set a header picture';
  exception when raise_exception then assert sqlerrm = 'no_plan';
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

-- the function (service role) may delete a section; owners only through it
do $$ begin
  assert has_table_privilege('service_role', 'public.shop_page_sections', 'DELETE');
  assert has_table_privilege('service_role', 'public.shop_section_pages', 'SELECT');
  assert not has_table_privilege('authenticated', 'public.shop_page_sections', 'DELETE');
  assert not has_table_privilege('anon', 'public.shop_page_sections', 'SELECT');
end $$;

-- the hourly job is scheduled
do $$ begin
  assert exists (select 1 from cron.job where jobname = 'ppi-sections-hourly' and schedule = '7 * * * *'
                 and command like '%/functions/v1/page-sections%' and command like '%tick%');
end $$;

-- leave shop A as it was for the checks below
do $$
declare v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
begin
  set role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
  begin
    perform public.owner_delete_shop(v_a);
    raise exception 'a shop with a plan or sections deleted';
  exception when others then
    assert sqlstate in ('55000', '55006'), sqlerrm;
  end;
  reset role;
  delete from public.shop_page_sections where shop_id = v_a;
end $$;

\echo '--- page sections: slider or one under another (update 29)'
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_s uuid;
  v_t uuid;
begin
  -- a new section: the slider by default (also through the old eight-argument call)
  v_s := public.owner_save_section(v_a, null, 'Slider', 'open', 'end', false, null, null);
  assert (select page_layout from public.shop_page_sections where id = v_s) = 'slider', 'default slider';
  v_t := public.owner_save_section(v_a, null, 'Pod sebou', 'open', 'end', false, null, null, 'stacked');
  assert (select page_layout from public.shop_page_sections where id = v_t) = 'stacked';
  -- saving without it keeps the choice; with it changes it
  perform public.owner_save_section(v_a, v_t, 'Pod sebou', 'collapsed', 'end', false, null, null);
  assert (select page_layout from public.shop_page_sections where id = v_t) = 'stacked', 'kept when not sent';
  perform public.owner_save_section(v_a, v_t, 'Pod sebou', 'collapsed', 'end', false, null, null, 'slider');
  assert (select page_layout from public.shop_page_sections where id = v_t) = 'slider';
  begin
    perform public.owner_save_section(v_a, v_t, 'x', 'open', 'end', false, null, null, 'carousel');
    raise exception 'a wrong page layout accepted';
  exception when raise_exception then assert sqlerrm = 'bad', sqlerrm;
  end;
  begin
    update public.shop_page_sections set page_layout = 'stacked' where id = v_s;
    raise exception 'page layout changed directly';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

-- visitors get it with the section (shown only)
do $$
declare v_s uuid := (select id from public.shop_page_sections where title = 'Slider');
begin
  perform public.sections_begin_upload(v_s, 1, 1000);
  perform public.sections_page_stored(v_s, 1, 1, 800, 'webp', 100, 800, 1131);
  perform public.sections_page_stored(v_s, 1, 1, 1600, 'webp', 200, 1600, 2263);
  perform public.sections_save_text(v_s, 1, '[{"page":1,"text":"Strana"}]', 'sk');
  perform public.sections_finish(v_s, 1);
  update public.shop_page_sections set published = true where id = v_s;
  perform public.sections_mark_public(v_s, 1);
  assert (select page_layout from public.shop_sections('potraviny-centrum') where title = 'Slider') = 'slider';
  assert not exists (select 1 from public.shop_sections('potraviny-centrum') where title = 'Pod sebou'), 'not shown without a PDF';
end $$;
do $$ begin
  begin
    update public.shop_page_sections set page_layout = 'grid';
    raise exception 'a wrong page layout stored';
  exception when check_violation then null;
  end;
  delete from public.shop_page_sections where title in ('Slider', 'Pod sebou');
end $$;

\echo '--- page sections for free shops: limits per plan, the first one after Pro ends, the admin (update 30)'
-- drogeria-kostolne (owner B) has no paid plan (canceled above)
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_s uuid;
  v_r record;
begin
  assert not public.shop_has_plan(v_b);
  select * into v_r from public.owner_section_limits(v_b);
  assert v_r.plan = 'free' and v_r.max_sections = 1 and v_r.max_pages = 5 and v_r.max_bytes = 10485760 and v_r.sections = 0,
    'free defaults: 1 section, 5 pages, 10 MB';
  -- a free shop adds one section, with every option; its place is before the items whatever the form sends
  v_s := public.owner_save_section(v_b, null, 'Jedálny lístok', 'open', 'after_details', true, null, null, 'stacked');
  assert (select position from public.shop_page_sections where id = v_s) = 'after_hours', 'free: after the opening hours (update 31; before_items in update 30)';
  perform public.owner_save_section(v_b, v_s, 'Jedálny lístok', 'collapsed', 'end', true, null, null, 'slider');
  assert (select position || ' ' || display || ' ' || page_layout || ' ' || allow_download from public.shop_page_sections where id = v_s)
    = 'after_hours collapsed slider true', 'free: the settings change, the place stays';
  -- the second one: 'limit' (Môj obchod shows "Pre viac sekcií prejdite na Pro" instead of the form)
  begin
    perform public.owner_save_section(v_b, null, 'Druhá', 'open', 'end', false, null, null);
    raise exception 'a second section on a free shop';
  exception when raise_exception then assert sqlerrm = 'limit', sqlerrm;
  end;
  assert (select sections from public.owner_section_limits(v_b)) = 1;
  -- only the admin changes the limits; another shop's limits are not readable
  begin
    perform public.admin_save_section_limits('free', 5, 5, 10);
    raise exception 'an owner changed the limits';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.section_limits set max_sections = 9;
    raise exception 'limits changed directly';
  exception when insufficient_privilege then null;
  end;
  assert (select count(*) from public.section_limits) = 2, 'owners read the limits';
  begin
    perform public.owner_section_limits((select id from public.shops where slug = 'potraviny-centrum'));
    raise exception 'owner B read shop A''s limits';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

-- the function's steps for the free shop: at most 5 pages and 10 MB; then shown, its text on the page only
do $$
declare
  v_s uuid := (select id from public.shop_page_sections where title = 'Jedálny lístok');
  v_i integer;
begin
  begin
    perform public.sections_begin_upload(v_s, 6, 1000);
    raise exception '6 pages on a free shop';
  exception when raise_exception then assert sqlerrm = 'limits', sqlerrm;
  end;
  begin
    perform public.sections_begin_upload(v_s, 2, 10485761);
    raise exception 'more than 10 MB on a free shop';
  exception when raise_exception then assert sqlerrm = 'limits', sqlerrm;
  end;
  perform public.sections_begin_upload(v_s, 5, 10485760);
  perform public.sections_begin_upload(v_s, 2, 1000);
  for v_i in 1..2 loop
    perform public.sections_page_stored(v_s, 2, v_i, 800, 'webp', 100, 800, 1131);
    perform public.sections_page_stored(v_s, 2, v_i, 1600, 'webp', 200, 1600, 2263);
  end loop;
  perform public.sections_save_text(v_s, 2, '[{"page":1,"text":"Polievka dňa 2,50 €"},{"page":2,"text":""}]', 'sk');
  perform public.sections_finish(v_s, 2);
  assert (select count(*) from public.sections_claim_ai(v_s, 5)) = 1, 'the AI writes out a page without text (free too)';
  update public.shop_page_sections set published = true where id = v_s;
  assert public.section_visible(v_s), 'a free shop''s first section is visible';
  assert exists (select 1 from public.sections_to_sync(v_s) where visible), 'its pictures go public';
  perform public.sections_mark_public(v_s, 2);
  assert (select path from public.shop_section_pdf('drogeria-kostolne', v_s)) like '%/v2/section.pdf', 'download allowed: free too';
end $$;

set role anon;
do $$
declare v_r record;
begin
  select * into v_r from public.shop_sections('drogeria-kostolne');
  assert v_r.title = 'Jedálny lístok' and v_r.position = 'after_hours' and v_r.allow_download and v_r.page_layout = 'slider',
    'the free page: after the opening hours, before the items';
  assert (v_r.pages -> 0 ->> 'text') = 'Polievka dňa 2,50 €', 'its text on the page';
  -- no assistant on free shops: the sections' text is not given to it
  assert not exists (select 1 from public.search_shop_docs('drogeria-kostolne', 'polievka', null)), 'no assistant text for a free shop';
  assert not exists (select 1 from public.shop_docs_list('drogeria-kostolne', null) where name = 'Jedálny lístok');
end $$;
reset role;

-- the admin changes the limits: wrong values refused; a free shop then may add a second one
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000ad';
do $$
declare v_i integer;
begin
  perform public.admin_save_section_limits('free', 2, 6, 12);
  assert (select max_sections || '/' || max_pages || '/' || max_mb from public.section_limits where plan = 'free') = '2/6/12';
  foreach v_i in array array[1, 2, 3, 4, 5] loop
    begin
      if v_i = 1 then perform public.admin_save_section_limits('gold', 1, 5, 10); end if;
      if v_i = 2 then perform public.admin_save_section_limits('free', 51, 5, 10); end if;
      if v_i = 3 then perform public.admin_save_section_limits('pro', 10, 51, 10); end if;
      if v_i = 4 then perform public.admin_save_section_limits('pro', 10, 20, 21); end if;
      if v_i = 5 then perform public.admin_save_section_limits('pro', 10, 0, 10); end if;
      raise exception 'wrong limits accepted (%)', v_i;
    exception when raise_exception then assert sqlerrm = 'limits', sqlerrm;
    end;
  end loop;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_r record;
begin
  select * into v_r from public.owner_section_limits(v_b);
  assert v_r.max_sections = 2 and v_r.max_pages = 6 and v_r.max_bytes = 12 * 1048576, 'the admin''s new limits';
  perform public.owner_save_section(v_b, null, 'Druhá', 'open', 'after_details', false, null, null);
  assert (select count(*) from public.shop_page_sections where shop_id = v_b) = 2;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000ad';
do $$ begin
  perform public.admin_save_section_limits('free', 1, 5, 10);
end $$;
reset role;
reset request.jwt.claim.sub;
do $$ begin
  delete from public.shop_page_sections where title = 'Druhá';
end $$;

-- a Pro shop goes back to free: every section kept, only the first that could be shown is shown
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_d uuid;
  v_f uuid;
  v_x uuid;
  v_id uuid;
  v_end timestamptz := (select current_period_end from public.subscriptions where shop_id = v_a);
begin
  delete from public.shop_page_sections where shop_id = v_a;
  -- a draft without a PDF first in the list, then two shown sections
  insert into public.shop_page_sections (shop_id, title, display, position, sort) values (v_a, 'Návrh', 'open', 'after_details', 0)
  returning id into v_d;
  insert into public.shop_page_sections (shop_id, title, display, position, sort) values (v_a, 'Prvá', 'open', 'after_details', 1)
  returning id into v_f;
  insert into public.shop_page_sections (shop_id, title, display, position, sort) values (v_a, 'Koniec', 'open', 'end', 0)
  returning id into v_x;
  foreach v_id in array array[v_f, v_x] loop
    perform public.sections_begin_upload(v_id, 1, 1000);
    perform public.sections_page_stored(v_id, 1, 1, 800, 'webp', 100, 800, 1131);
    perform public.sections_page_stored(v_id, 1, 1, 1600, 'webp', 200, 1600, 2263);
    perform public.sections_save_text(v_id, 1, '[{"page":1,"text":"Kyslá kapusta zo suda"}]', 'sk');
    perform public.sections_finish(v_id, 1);
    update public.shop_page_sections set published = true where id = v_id;
    perform public.sections_mark_public(v_id, 1);
  end loop;
  assert (select string_agg(title, ',') from public.shop_sections('potraviny-centrum')) = 'Prvá,Koniec', 'Pro: both shown';
  assert exists (select 1 from public.search_shop_docs('potraviny-centrum', 'kapusta', null)), 'Pro: the assistant has the text';
  -- free again: the draft does not take the one place; the first that can be shown does, in the free page's place
  update public.subscriptions set current_period_end = now() - interval '1 minute' where shop_id = v_a;
  assert (select string_agg(title, ',') from public.shop_sections('potraviny-centrum')) = 'Prvá', 'free again: only the first shown';
  assert (select position from public.shop_sections('potraviny-centrum')) = 'after_hours', 'in the free page''s place';
  assert (select count(*) from public.shop_page_sections where shop_id = v_a) = 3, 'free again: every section kept';
  assert exists (select 1 from public.sections_to_sync(null) where id = v_x and not visible), 'the hidden one''s pictures leave';
  assert exists (select 1 from public.sections_to_sync(null, v_a) where id = v_x and not visible), 'one shop''s sync has it';
  assert not exists (select 1 from public.sections_to_sync(null, (select id from public.shops where slug = 'drogeria-kostolne')) where id = v_x),
    'another shop''s sync does not';
  assert not exists (select 1 from public.search_shop_docs('potraviny-centrum', 'kapusta', null)), 'free again: no assistant text';
  assert (select count(*) from public.shop_section_pdf('potraviny-centrum', v_x)) = 0, 'no download of a hidden one';
  -- the owner hides the first one (or deletes it): the next one takes its place
  update public.shop_page_sections set hidden = true where id = v_f;
  assert (select string_agg(title, ',') from public.shop_sections('potraviny-centrum')) = 'Koniec', 'the next one that can be shown';
  update public.shop_page_sections set hidden = false where id = v_f;
  -- Pro again: all of them, in their own places
  update public.subscriptions set current_period_end = v_end where shop_id = v_a;
  assert (select string_agg(position, ',') from public.shop_sections('potraviny-centrum')) = 'after_details,end', 'Pro again: in their places';
  assert exists (select 1 from public.search_shop_docs('potraviny-centrum', 'kapusta', null)), 'Pro again: the assistant has the text';
  -- the admin lowers Pro's number: only the first ones show
  update public.section_limits set max_sections = 1 where plan = 'pro';
  assert (select string_agg(title, ',') from public.shop_sections('potraviny-centrum')) = 'Prvá', 'Pro over its limit: the first';
  update public.section_limits set max_sections = 10 where plan = 'pro';
end $$;
-- a free shop with 3 kept sections cannot add a fourth
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
begin
  set role postgres;
  update public.subscriptions set current_period_end = now() - interval '1 minute' where shop_id = v_a;
  set role authenticated;
  begin
    perform public.owner_save_section(v_a, null, 'Štvrtá', 'open', 'end', false, null, null);
    raise exception 'a downgraded shop added a section';
  exception when raise_exception then assert sqlerrm = 'limit', sqlerrm;
  end;
  assert (select plan from public.owner_section_limits(v_a)) = 'free';
  set role postgres;
  update public.subscriptions set current_period_end = now() + interval '30 days' where shop_id = v_a;
  delete from public.shop_page_sections where shop_id = v_a;
  set role authenticated;
end $$;
reset role;
reset request.jwt.claim.sub;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare v_r record;
begin
  select * into v_r from public.owner_section_limits((select id from public.shops where slug = 'potraviny-centrum'));
  assert v_r.plan = 'pro' and v_r.max_sections = 10 and v_r.max_pages = 20, 'Pro defaults: 10 sections, 20 pages';
end $$;
reset role;
reset request.jwt.claim.sub;

\echo '--- own-domain header logo, the position after the opening hours, sections of pictures (update 31)'
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_url text := 'https://abc.supabase.co/storage/v1/object/public/logos/' || (select id from public.shops where slug = 'potraviny-centrum') || '/site-logo-1760000000000';
  v_s uuid;
  v_i integer;
begin
  -- the header logo: only through the owner function, only the shop's own folder, WebP or PNG
  perform public.owner_set_site_logo(v_a, v_url || '.webp', 360, 120);
  assert (select url || ' ' || width || 'x' || height from public.shop_site_logo('potraviny-centrum')) = v_url || '.webp 360x120';
  perform public.owner_set_site_logo(v_a, v_url || '.png', 120, 120);
  foreach v_i in array array[1, 2, 3, 4] loop
    begin
      if v_i = 1 then perform public.owner_set_site_logo(v_a, 'https://evil.example/site-logo-1760000000000.png', 120, 120); end if;
      if v_i = 2 then perform public.owner_set_site_logo(v_a, v_url || '.jpg', 120, 120); end if;
      if v_i = 3 then perform public.owner_set_site_logo(v_a, replace(v_url, 'site-logo', 'header') || '.webp', 120, 120); end if;
      if v_i = 4 then perform public.owner_set_site_logo(v_a, v_url || '.png', 120, 900); end if;
      raise exception 'a wrong header logo accepted (%)', v_i;
    exception when invalid_parameter_value then assert sqlerrm = 'picture', sqlerrm;
    end;
  end loop;
  begin
    perform public.owner_set_site_logo(v_a, replace(v_url, v_a::text, v_b::text) || '.png', 120, 120);
    raise exception 'another shop''s folder';
  exception when invalid_parameter_value then null;
  end;
  begin
    update public.shops set site_logo_url = null, site_logo_width = null, site_logo_height = null where id = v_a;
    raise exception 'header logo changed directly';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.owner_set_site_logo(v_b, v_url || '.png', 120, 120);
    raise exception 'owner A set shop B''s header logo';
  exception when insufficient_privilege then null;
  end;
  -- the position after the opening hours (between the hours and the assistant)
  v_s := public.owner_save_section(v_a, null, 'Za hodinami', 'open', 'after_hours', false, null, null);
  assert (select position from public.shop_page_sections where id = v_s) = 'after_hours';
  begin
    perform public.owner_save_section(v_a, null, 'x', 'open', 'after_assistant', false, null, null);
    raise exception 'an unknown position accepted';
  exception when raise_exception then assert sqlerrm = 'bad', sqlerrm;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

-- a free shop without a domain of its own: no header logo (the page uses the shop's logo); removing is always allowed
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_url text := 'https://abc.supabase.co/storage/v1/object/public/logos/' || (select id from public.shops where slug = 'drogeria-kostolne') || '/site-logo-1760000000000.png';
begin
  begin
    perform public.owner_set_site_logo(v_b, v_url, 120, 120);
    raise exception 'a free shop set a header logo';
  exception when raise_exception then assert sqlerrm = 'no_plan', sqlerrm;
  end;
  perform public.owner_set_site_logo(v_b, null, null, null);
end $$;
reset role;
reset request.jwt.claim.sub;

-- sections of pictures (one picture = one page; no PDF, nothing to download) and the order with after_hours
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_h uuid := (select id from public.shop_page_sections where title = 'Za hodinami');
  v_m uuid;
  v_r record;
  v_i integer;
begin
  begin
    perform public.sections_begin_upload(v_h, 2, 1000, 'gif');
    raise exception 'an unknown source accepted';
  exception when raise_exception then assert sqlerrm = 'bad', sqlerrm;
  end;
  begin
    perform public.sections_begin_upload(v_h, 21, 1000, 'pictures');
    raise exception '21 pictures on Pro (20 pages)';
  exception when raise_exception then assert sqlerrm = 'limits', sqlerrm;
  end;
  select * into v_r from public.sections_begin_upload(v_h, 2, 3000000, 'pictures');
  assert v_r.pdf_path is null, 'pictures: no PDF to store';
  for v_i in 1..2 loop
    perform public.sections_page_stored(v_h, v_r.version, v_i, 800, 'webp', 100, 800, 600);
    perform public.sections_page_stored(v_h, v_r.version, v_i, 1600, 'webp', 200, 1600, 1200);
  end loop;
  perform public.sections_save_text(v_h, v_r.version, '[{"page":1,"text":""},{"page":2,"text":""}]', null);
  perform public.sections_finish(v_h, v_r.version);
  assert (select source || ' ' || coalesce(pdf_path, 'none') || ' ' || pages from public.shop_page_sections where id = v_h) = 'pictures none 2';
  assert (select count(*) from public.sections_claim_ai(v_h, 5)) = 2, 'the AI writes out the pictures'' text';
  update public.shop_page_sections set published = true, allow_download = true where id = v_h;
  perform public.sections_mark_public(v_h, v_r.version);
  -- a section after the map, to see the order
  insert into public.shop_page_sections (shop_id, title, display, position, sort) values (v_a, 'Za mapou', 'open', 'after_map', 0)
  returning id into v_m;
  perform public.sections_begin_upload(v_m, 1, 1000);
  perform public.sections_page_stored(v_m, 1, 1, 800, 'webp', 100, 800, 1131);
  perform public.sections_page_stored(v_m, 1, 1, 1600, 'webp', 200, 1600, 2263);
  perform public.sections_save_text(v_m, 1, '[{"page":1,"text":"Mapa"}]', 'sk');
  perform public.sections_finish(v_m, 1);
  update public.shop_page_sections set published = true where id = v_m;
  perform public.sections_mark_public(v_m, 1);
  assert (select string_agg(title || ':' || position || ':' || source, ',') from public.shop_sections('potraviny-centrum'))
    = 'Za mapou:after_map:pdf,Za hodinami:after_hours:pictures', 'the order and the source';
  assert (select count(*) from public.shop_section_pdf('potraviny-centrum', v_h)) = 0, 'pictures: nothing to download';
  -- free again: the first in the owner's order (after_map before after_hours), in the free page's place
  update public.subscriptions set current_period_end = now() - interval '1 minute' where shop_id = v_a;
  assert (select title || ':' || position from public.shop_sections('potraviny-centrum')) = 'Za mapou:after_hours';
  update public.subscriptions set current_period_end = now() + interval '30 days' where shop_id = v_a;
  -- pictures replaced by a PDF: a PDF again (and back)
  select * into v_r from public.sections_begin_upload(v_h, 1, 1000, 'pdf');
  perform public.sections_page_stored(v_h, v_r.version, 1, 800, 'webp', 100, 800, 1131);
  perform public.sections_page_stored(v_h, v_r.version, 1, 1600, 'webp', 200, 1600, 2263);
  perform public.sections_save_text(v_h, v_r.version, '[{"page":1,"text":"PDF"}]', 'sk');
  perform public.sections_finish(v_h, v_r.version);
  assert (select source from public.shop_page_sections where id = v_h) = 'pdf' and
    (select pdf_path from public.shop_page_sections where id = v_h) like '%/section.pdf';
  -- a live PDF section always has its PDF
  begin
    update public.shop_page_sections set pdf_path = null where id = v_h;
    raise exception 'a PDF section without its PDF';
  exception when check_violation then null;
  end;
  begin
    update public.shop_page_sections set position = 'after_assistant' where id = v_h;
    raise exception 'an unknown position stored';
  exception when check_violation then null;
  end;
  delete from public.shop_page_sections where id in (v_h, v_m);
  update public.shops set site_logo_url = null, site_logo_width = null, site_logo_height = null where id = v_a;
end $$;

\echo '--- where the own domain''s header logo leads (update 32)'
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_i integer;
begin
  -- the address as typed, https:// in front when missing, http becomes https
  assert public.owner_set_site_logo_link(v_a, '  www.potraviny-centrum.sk/o-nas ') = 'https://www.potraviny-centrum.sk/o-nas';
  assert public.owner_set_site_logo_link(v_a, 'http://potraviny-centrum.sk') = 'https://potraviny-centrum.sk';
  assert public.owner_set_site_logo_link(v_a, 'https://xn--potraviny-tka.sk:8443/?z=1#top') = 'https://xn--potraviny-tka.sk:8443/?z=1#top';
  foreach v_i in array array[1, 2, 3, 4, 5, 6, 7] loop
    begin
      if v_i = 1 then perform public.owner_set_site_logo_link(v_a, 'javascript:alert(1)'); end if;
      if v_i = 2 then perform public.owner_set_site_logo_link(v_a, 'https://localhost/'); end if;
      if v_i = 3 then perform public.owner_set_site_logo_link(v_a, 'https://user@potraviny-centrum.sk/'); end if;
      if v_i = 4 then perform public.owner_set_site_logo_link(v_a, 'https://potraviny centrum.sk/'); end if;
      if v_i = 5 then perform public.owner_set_site_logo_link(v_a, 'https://potraviny-centrum.sk/"><script>'); end if;
      if v_i = 6 then perform public.owner_set_site_logo_link(v_a, 'ftp://potraviny-centrum.sk/'); end if;
      if v_i = 7 then perform public.owner_set_site_logo_link(v_a, 'https://potraviny-centrum.sk/' || repeat('a', 480)); end if;
      raise exception 'a wrong logo link accepted (%)', v_i;
    exception when invalid_parameter_value then assert sqlerrm = 'link', sqlerrm;
    end;
  end loop;
  assert (select site_logo_link from public.shops where id = v_a) = 'https://xn--potraviny-tka.sk:8443/?z=1#top', 'a wrong link leaves the old one';
  -- only through the owner function; not another shop's
  begin
    update public.shops set site_logo_link = 'https://evil.example/' where id = v_a;
    raise exception 'logo link changed directly';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.owner_set_site_logo_link(v_b, 'https://drogeria-kostolne.sk/');
    raise exception 'owner A set shop B''s logo link';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

-- the visitor's page reads it (a link alone is enough for a row: the header then shows the shop's logo or name)
set role anon;
do $$
declare v_r record;
begin
  select * into v_r from public.shop_site_logo('potraviny-centrum');
  assert v_r.url is null and v_r.link = 'https://xn--potraviny-tka.sk:8443/?z=1#top', 'the link without a header logo';
  assert not exists (select 1 from public.shop_site_logo('drogeria-kostolne')), 'no logo and no link: no row';
  begin
    perform public.owner_set_site_logo_link((select id from public.shops where slug = 'potraviny-centrum'), null);
    raise exception 'a visitor changed the logo link';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- a free shop without a domain of its own: no other address; the home page (empty) is always allowed
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
begin
  begin
    perform public.owner_set_site_logo_link(v_b, 'https://drogeria-kostolne.sk/');
    raise exception 'a free shop set a logo link';
  exception when raise_exception then assert sqlerrm = 'no_plan', sqlerrm;
  end;
  assert public.owner_set_site_logo_link(v_b, '   ') is null;
  assert public.owner_set_site_logo_link(v_b, null) is null;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_url text := 'https://abc.supabase.co/storage/v1/object/public/logos/' || (select id from public.shops where slug = 'potraviny-centrum') || '/site-logo-1760000000000.png';
begin
  -- the header logo and its link together; removing the logo keeps the link, the empty link leads home again
  perform public.owner_set_site_logo(v_a, v_url, 120, 120);
  assert (select url || ' ' || link from public.shop_site_logo('potraviny-centrum')) = v_url || ' https://xn--potraviny-tka.sk:8443/?z=1#top';
  perform public.owner_set_site_logo(v_a, null, null, null);
  assert (select link from public.shop_site_logo('potraviny-centrum')) is not null, 'removing the logo keeps its link';
  assert public.owner_set_site_logo_link(v_a, '') is null;
  assert not exists (select 1 from public.shop_site_logo('potraviny-centrum')), 'home page again';
end $$;
reset role;
reset request.jwt.claim.sub;

\echo '--- own domains easy to find: Search Console value, IndexNow once per upload, categories (update 33)'
-- one IndexNow key, public by design (the domain serves it as /<key>.txt)
set role anon;
do $$ begin
  assert public.indexnow_key() ~ '^[a-f0-9]{32}$', 'a random 32-character key';
  begin
    perform public.indexnow_claim((select id from public.shops where slug = 'potraviny-centrum'));
    raise exception 'a visitor claimed an IndexNow ping';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set role service_role;
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
begin
  assert public.shop_has_plan(v_a), 'shop A has the plan here';
  -- no own domain yet: nothing to announce
  assert public.indexnow_claim(v_a) is null, 'no live domain: no ping';
  insert into public.domain_orders (shop_id, kind, hostname, site_host, status, live_at)
  values (v_a, 'connected', 'potraviny33.sk', 'potraviny33.sk', 'waiting_dns', null);
  assert public.indexnow_claim(v_a) is null, 'not live yet: no ping';
  update public.domain_orders set status = 'live', live_at = now() where hostname = 'potraviny33.sk';
end $$;

-- upload 1 (its own transaction, like every stock upload)
do $$ begin perform public.apply_stock_file((select id from public.shops where slug = 'potraviny-centrum'), '[
  {"source_code":"P001","name":"Káva zrnková 1 kg","ean":"8000070012345","brand":"Lavazza","quantity":7,"price":19.5},
  {"source_code":"P003","name":"Mlieko polotučné 1 l","brand":"Rajo","quantity":40,"price":1.09},
  {"source_code":"P004","name":"Chlieb konzumný 1 kg","quantity":5,"price":1.89},
  {"source_code":"P005","name":"Maslo 250 g","brand":"Tami","quantity":6,"price":2.79},
  {"source_code":"P100","name":"Kakao 100 g","ean":"5900000000001","quantity":3,"price":2.2}
]', now(), null); end $$;
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_c jsonb := public.indexnow_claim(v_a);
begin
  assert v_c ->> 'host' = 'potraviny33.sk' and v_c ->> 'lang' = 'sk' and v_c ->> 'key' = public.indexnow_key(), v_c::text;
  assert jsonb_array_length(v_c -> 'items') >= 1, 'upload 1 changed something';
  assert public.indexnow_claim(v_a) is null, 'once per upload';
  perform public.indexnow_sent((v_c ->> 'order_id')::uuid, (v_c ->> 'upload_at')::timestamptz, 3, '202');
  assert (select indexnow_urls || ' ' || indexnow_result from public.domain_orders where hostname = 'potraviny33.sk') = '3 202';
  -- a late answer for an older upload changes nothing
  perform public.indexnow_sent((v_c ->> 'order_id')::uuid, (v_c ->> 'upload_at')::timestamptz - interval '1 hour', 9, '500');
  assert (select indexnow_result from public.domain_orders where hostname = 'potraviny33.sk') = '202';
end $$;

-- upload 2: P001 price, P003 quantity, P004 name changed; P200 new; P100 missing (sold out); P005 the same
do $$ begin perform public.apply_stock_file((select id from public.shops where slug = 'potraviny-centrum'), '[
  {"source_code":"P001","name":"Káva zrnková 1 kg","ean":"8000070012345","brand":"Lavazza","quantity":7,"price":18.9},
  {"source_code":"P003","name":"Mlieko polotučné 1 l","brand":"Rajo","quantity":39,"price":1.09},
  {"source_code":"P004","name":"Chlieb konzumný 1,2 kg","quantity":5,"price":1.89},
  {"source_code":"P005","name":"Maslo 250 g","brand":"Tami","quantity":6,"price":2.79},
  {"source_code":"P200","name":"Med kvetový 500 g","quantity":2,"price":6.5}
]', now(), null); end $$;
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_c jsonb := public.indexnow_claim(v_a);
begin
  assert (select array_agg(si.source_code order by si.source_code) from public.shop_items si
          where si.id::text in (select jsonb_array_elements_text(v_c -> 'items')))
         = array['P001', 'P003', 'P004', 'P100', 'P200'], 'only the items that changed: ' || (v_c -> 'items')::text;
  assert (select i.changed_at < i.received_at from public.inventory i join public.shop_items si on si.id = i.shop_item_id
          where si.shop_id = v_a and si.source_code = 'P005'), 'an unchanged row keeps its time';
  assert public.indexnow_claim(v_a) is null, 'once per upload';
  assert public.indexnow_claim(v_a, 2) is null;
end $$;

-- upload 3: the same file again: nothing changed, nothing to send
do $$ begin perform public.apply_stock_file((select id from public.shops where slug = 'potraviny-centrum'), '[
  {"source_code":"P001","name":"Káva zrnková 1 kg","ean":"8000070012345","brand":"Lavazza","quantity":7,"price":18.9},
  {"source_code":"P003","name":"Mlieko polotučné 1 l","brand":"Rajo","quantity":39,"price":1.09},
  {"source_code":"P004","name":"Chlieb konzumný 1,2 kg","quantity":5,"price":1.89},
  {"source_code":"P005","name":"Maslo 250 g","brand":"Tami","quantity":6,"price":2.79},
  {"source_code":"P200","name":"Med kvetový 500 g","quantity":2,"price":6.5}
]', now(), null); end $$;
do $$ begin
  assert public.indexnow_claim((select id from public.shops where slug = 'potraviny-centrum')) -> 'items' = '[]'::jsonb, 'an identical file: no address';
end $$;

-- upload 4 after the plan ended: the domain is no longer served, no ping; never another shop's domain
update public.subscriptions set current_period_end = now() - interval '1 minute' where shop_id = (select id from public.shops where slug = 'potraviny-centrum');
do $$ begin perform public.apply_stock_file((select id from public.shops where slug = 'potraviny-centrum'), '[
  {"source_code":"P001","name":"Káva zrnková 1 kg","ean":"8000070012345","brand":"Lavazza","quantity":6,"price":18.9}
]', now(), null); end $$;
do $$ begin
  assert public.indexnow_claim((select id from public.shops where slug = 'potraviny-centrum')) is null, 'plan ended: no ping';
  assert public.indexnow_claim((select id from public.shops where slug = 'drogeria-kostolne')) is null, 'shop B has no domain';
end $$;
update public.subscriptions set current_period_end = now() + interval '30 days' where shop_id = (select id from public.shops where slug = 'potraviny-centrum');

-- the Search Console value: only google-site-verification=<token>, always with its state
do $$
declare v_o uuid := (select id from public.domain_orders where hostname = 'potraviny33.sk');
begin
  begin
    update public.domain_orders set google_verification = 'google-site-verification=short', google_verification_state = 'manual' where id = v_o;
    raise exception 'a wrong verification value stored';
  exception when check_violation then null;
  end;
  begin
    update public.domain_orders set google_verification = 'v=spf1 include:evil ~all', google_verification_state = 'added' where id = v_o;
    raise exception 'another TXT value stored as the Google one';
  exception when check_violation then null;
  end;
  begin
    update public.domain_orders set google_verification = 'google-site-verification=AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-abcd' where id = v_o;
    raise exception 'a value without its state';
  exception when check_violation then null;
  end;
  update public.domain_orders
  set google_verification = 'google-site-verification=AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-abcd', google_verification_state = 'manual',
      google_verification_at = now()
  where id = v_o;
end $$;
reset role;

-- owners read their own value and IndexNow answer, and change neither
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
begin
  assert (select google_verification_state || ' ' || (indexnow_upload_at is not null) from public.domain_orders where hostname = 'potraviny33.sk')
    = 'manual true', 'the owner reads the value and the IndexNow bookkeeping';
  begin
    update public.domain_orders set google_verification = null, google_verification_state = null where hostname = 'potraviny33.sk';
    raise exception 'an owner changed the order';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.indexnow_claim(v_a);
    raise exception 'an owner claimed a ping';
  exception when insufficient_privilege then null;
  end;

  -- "Kategórie tovaru": plain text, commas, semicolons or lines, duplicates once
  assert public.owner_set_categories(v_a, E'Potraviny, Drogéria; káva\n<b>Pečivo</b>, potraviny , https://evil.example,,')
    = array['Potraviny', 'Drogéria', 'káva', 'Pečivo'], 'cleaned categories';
  begin
    perform public.owner_set_categories(v_a, 'a,b,c,d,e,f,g,h,i,j,k,l,m');
    raise exception 'thirteen categories';
  exception when invalid_parameter_value then assert sqlerrm = 'categories', sqlerrm;
  end;
  begin
    perform public.owner_set_categories(v_a, repeat('x', 41));
    raise exception 'a category over 40 characters';
  exception when invalid_parameter_value then assert sqlerrm = 'categories', sqlerrm;
  end;
  assert (select product_categories from public.shops where id = v_a) = array['Potraviny', 'Drogéria', 'káva', 'Pečivo'], 'a refused list keeps the old one';
  begin
    update public.shops set product_categories = array['Lacné lieky'] where id = v_a;
    raise exception 'categories changed directly';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.owner_set_categories(v_b, 'Drogéria');
    raise exception 'owner A set shop B''s categories';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

set role anon;
do $$
declare v_f jsonb := public.shop_llms_facts('potraviny-centrum');
begin
  assert v_f -> 'categories' = '["Potraviny", "Drogéria", "káva", "Pečivo"]'::jsonb, v_f::text;
  assert v_f -> 'brands' ? 'Lavazza' and v_f -> 'brands' ? 'Tami', 'brands from the stock file';
  assert (v_f ->> 'items')::int >= 5;
  assert public.shop_llms_facts('drogeria-kostolne') -> 'categories' = '[]'::jsonb, 'none written: empty';
  assert public.shop_llms_facts('no-such-shop') is null;
  begin
    perform public.owner_set_categories((select id from public.shops where slug = 'potraviny-centrum'), 'x');
    raise exception 'a visitor set categories';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  assert public.owner_set_categories((select id from public.shops where slug = 'potraviny-centrum'), '  ') is null, 'empty = none';
end $$;
reset role;
reset request.jwt.claim.sub;
delete from public.domain_orders where hostname = 'potraviny33.sk';

\echo '--- layered search: outside layers, allowed web domains, daily limit, OSM caches, Nominatim slot (update 34)'
-- visitors and owners see none of it and call none of the function's helpers
set role anon;
do $$
declare v_table text;
begin
  foreach v_table in array array['search_layers', 'web_search_domains', 'external_search_usage', 'town_geocodes', 'osm_shop_cache', 'external_throttle'] loop
    begin
      execute format('select count(*) from public.%I', v_table);
      raise exception 'a visitor read %', v_table;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    perform public.external_search_claim('web', 'web_search', 1000);
    raise exception 'a visitor claimed an outside call';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.external_slot('nominatim', 1000, 3000);
    raise exception 'a visitor took a Nominatim slot';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.osm_cache_put('x', 'hardware', 5000, '[]');
    raise exception 'a visitor wrote the OSM cache';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.cacadoo_shops_near(48.75, 21.92, 5);
    raise exception 'a visitor called cacadoo_shops_near';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.admin_search_settings();
    raise exception 'a visitor read the admin settings';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  begin
    perform count(*) from public.web_search_domains;
    raise exception 'an owner read the web domains';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.admin_search_settings();
    raise exception 'an owner read the admin settings';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.admin_save_search_layer('web', false, 0.01, 0.1, 0.5);
    raise exception 'an owner switched a layer';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.admin_save_web_domain('evil.example', 'Evil', null, true, 1);
    raise exception 'an owner added a web domain';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

-- the function (service role): the daily limit counts every layer together; costs are added; one Nominatim per second
set role service_role;
do $$
declare
  v_wait integer;
begin
  delete from public.external_search_usage;
  assert public.external_search_claim('geocode', 'nominatim', 3);
  assert public.external_search_claim('osm', 'overpass', 3);
  assert public.external_search_claim('web', 'web_search', 3);
  assert not public.external_search_claim('google_places', 'google_places', 3), 'the 4th call of the day is over the limit of 3';
  assert not public.external_search_claim('osm', 'overpass', 0), 'limit 0: nothing goes out';
  assert (select sum(calls) from public.external_search_usage) = 3, 'refused calls are not counted';
  perform public.external_search_cost('web', 'web_search', 0.0123);
  perform public.external_search_cost('web', 'web_search', 0.0100);
  perform public.external_search_cost('web', 'web_search', -5);
  assert (select cost_usd from public.external_search_usage where layer = 'web' and service = 'web_search') = 0.0223, 'costs add up, never below 0';
  begin
    insert into public.external_search_usage (day, layer, service, calls) values (current_date, 'scraper', 'google_places', 1);
    raise exception 'an unknown layer was counted';
  exception when check_violation then null;
  end;

  delete from public.external_throttle;
  assert public.external_slot('nominatim', 1000, 3000) = 0, 'the first request goes at once';
  v_wait := public.external_slot('nominatim', 1000, 3000);
  assert v_wait between 900 and 1000, format('the next one waits about a second: %s', v_wait);
  v_wait := public.external_slot('nominatim', 1000, 3000);
  assert v_wait between 1900 and 2000, format('and the one after it two: %s', v_wait);
  assert public.external_slot('nominatim', 1000, 500) = -1, 'too long a wait: nothing reserved';
  v_wait := public.external_slot('nominatim', 1000, 5000);
  assert v_wait between 2900 and 3000, format('the refused one took no slot: %s', v_wait);
  assert public.external_slot('overpass', 1000, 3000) = 0, 'each service has its own slot';

  -- Overpass answers: kept per town, category and radius; older than 7 days cleared on the way
  insert into public.osm_shop_cache (town_key, category, radius_m, results, fetched_at)
  values ('old town', 'hardware', 7000, '[]', now() - interval '8 days');
  perform public.osm_cache_put('michalovce', 'hardware', 7000, '[{"name":"Železiarstvo XY"}]');
  perform public.osm_cache_put('michalovce', 'hardware', 7000, '[{"name":"Železiarstvo XY"},{"name":"Iné"}]');
  assert (select jsonb_array_length(results) from public.osm_shop_cache where town_key = 'michalovce' and category = 'hardware') = 2, 'replaced, not added';
  assert not exists (select 1 from public.osm_shop_cache where town_key = 'old town'), 'old answers cleared';
  begin
    perform public.osm_cache_put('michalovce', 'fuel', 7000, '{"not":"a list"}');
    raise exception 'a non-list was cached';
  exception when check_violation then null;
  end;

  -- a town is kept for good; a point must be a point
  insert into public.town_geocodes (key, query, name, lat, lng, country_code, found)
  values ('michalovce', 'Michalovce', 'Michalovce', 48.7553, 21.9184, 'SK', true) on conflict (key) do nothing;
  begin
    insert into public.town_geocodes (key, query, found, lat, lng) values ('nowhere', 'Nowhere', true, 123, 0);
    raise exception 'a point outside the earth was stored';
  exception when check_violation then null;
  end;

  -- Cacaduu shops near the town centre: the nearby list leaves them out
  assert exists (select 1 from public.cacadoo_shops_near(48.7553, 21.9184, 3) where slug = 'potraviny-centrum');
  assert not exists (select 1 from public.cacadoo_shops_near(48.7553, 21.9184, 3) where slug = 'kisbolt-budapest');

  -- the allowed domains: only clean ASCII domains, deep links only on the shop's own host
  begin
    insert into public.web_search_domains (domain, label) values ('*.example.sk', 'Star');
    raise exception 'a wildcard domain was stored';
  exception when check_violation then null;
  end;
  begin
    insert into public.web_search_domains (domain, label, search_url) values ('example.sk', 'Ex', 'https://evil.sk/s?q={query}');
    raise exception 'a deep link to another host was stored';
  exception when check_violation then null;
  end;
end $$;
reset role;

-- the admin: settings, switches, domains (checked again in the database)
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000ad';
do $$
declare
  v_s jsonb := public.admin_search_settings();
  v_domain text;
begin
  assert jsonb_array_length(v_s -> 'layers') = 3, v_s::text;
  assert (v_s -> 'layers' -> 0 ->> 'layer') = 'osm' and (v_s -> 'layers' -> 2 ->> 'layer') = 'web';
  assert (v_s -> 'layers' -> 2 ->> 'cost_per_call_usd')::numeric = 0.01, 'the web search: $10 per 1,000';
  assert jsonb_array_length(v_s -> 'domains') = 5 and (v_s -> 'domains' -> 0 ->> 'domain') = 'decathlon.sk', v_s::text;
  assert (v_s ->> 'today_calls')::int = 3 and (v_s ->> 'today_cost_usd')::numeric = 0.0223, 'today''s calls and cost';
  assert jsonb_array_length(v_s -> 'usage') >= 3;

  perform public.admin_save_search_layer('web', false, 0.012, 0.1, 0.5);
  assert not (public.admin_search_settings() -> 'layers' -> 2 ->> 'enabled')::boolean, 'the admin switched the web layer off';
  perform public.admin_save_search_layer('web', true, 0.01, 0.1, 0.5);
  begin
    perform public.admin_save_search_layer('scraping', true, 0, 0, 0);
    raise exception 'an unknown layer was saved';
  exception when sqlstate 'P0001' then null;
  end;
  begin
    perform public.admin_save_search_layer('osm', true, -1, 0, 0);
    raise exception 'a negative price was saved';
  exception when sqlstate 'P0001' then null;
  end;

  v_domain := public.admin_save_web_domain('  https://www.Example-Shop.SK/ ', 'Example <b>Shop</b>', 'https://www.example-shop.sk/hladat?q={query}', true, 60);
  assert v_domain = 'www.example-shop.sk', v_domain;
  assert (select d ->> 'label' from jsonb_array_elements(public.admin_search_settings() -> 'domains') d where d ->> 'domain' = v_domain) = 'Example Shop', 'the label is plain text';
  v_domain := public.admin_save_web_domain('example-shop.sk', 'Example', 'https://eshop.example-shop.sk/s?term={query}&page=1', true, 61);
  assert (select d ->> 'search_url' from jsonb_array_elements(public.admin_search_settings() -> 'domains') d where d ->> 'domain' = 'example-shop.sk') like 'https://eshop.example-shop.sk/%', 'a subdomain of the shop is fine';
  perform public.admin_save_web_domain('example-shop.sk', 'Example', '', false, 61);
  assert (select d -> 'search_url' = 'null'::jsonb and not (d ->> 'enabled')::boolean from jsonb_array_elements(public.admin_search_settings() -> 'domains') d where d ->> 'domain' = 'example-shop.sk'), 'an empty address removes the deep link';
  foreach v_domain in array array['exa mple.sk', '*.example.sk', 'ex*.com', 'localhost', 'еxample.sk', 'example.sk/*'] loop
    begin
      perform public.admin_save_web_domain(v_domain, 'X', null, true, 1);
      raise exception 'a bad domain was saved: %', v_domain;
    exception when sqlstate 'P0001' then
      assert sqlerrm = 'domain', sqlerrm;
    end;
  end loop;
  foreach v_domain in array array['http://example-shop.sk/s?q={query}', 'https://example-shop.sk/s', 'https://other.sk/s?q={query}',
                                  'https://example-shop.sk/s?q={query}&r={query}', 'https://example-shop.sk/s?q={query}"onclick'] loop
    begin
      perform public.admin_save_web_domain('example-shop.sk', 'Example', v_domain, true, 1);
      raise exception 'a bad deep link was saved: %', v_domain;
    exception when sqlstate 'P0001' then
      assert sqlerrm = 'search_url', sqlerrm;
    end;
  end loop;
  begin
    perform public.admin_save_web_domain('example-shop.sk', '   ', null, true, 1);
    raise exception 'an empty label was saved';
  exception when sqlstate 'P0001' then null;
  end;
  assert public.admin_delete_web_domain('www.example-shop.sk');
  assert public.admin_delete_web_domain('example-shop.sk');
  assert not public.admin_delete_web_domain('example-shop.sk'), 'already gone';
end $$;
reset role;
reset request.jwt.claim.sub;
delete from public.external_search_usage;
delete from public.external_throttle;
delete from public.osm_shop_cache;
delete from public.town_geocodes;

\echo '--- partner feeds: own tables, imports in parts, 48 hours, stock per store only from the feed, affiliate never ranks (update 35)'
-- visitors and owners read none of the tables and call none of the import steps; visitors may search
set role anon;
do $$
declare v_table text;
begin
  foreach v_table in array array['partners', 'partner_stores', 'partner_products', 'partner_store_stock', 'partner_imports'] loop
    begin
      execute format('select count(*) from public.%I', v_table);
      raise exception 'a visitor read %', v_table;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    perform public.partner_start_due();
    raise exception 'a visitor started an import';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.partner_import_rows(gen_random_uuid(), 0, '[]', true, '', 0, 0, null, null);
    raise exception 'a visitor wrote partner rows';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.admin_partner_settings();
    raise exception 'a visitor read the partner settings';
  exception when insufficient_privilege then null;
  end;
  assert not public.partner_layer_ready(), 'no partner yet: the layer is skipped';
  assert not exists (select 1 from public.search_partner_products('kladivo', null, 10)), 'nothing to find yet';
end $$;
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  begin
    perform public.admin_save_partner('{"name":"Evil","feed_format":"csv","timezone":"UTC"}');
    raise exception 'an owner added a partner';
  exception when insufficient_privilege then null;
  end;
  begin
    perform count(*) from public.partner_products;
    raise exception 'an owner read partner rows';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.partner_import_finish(gen_random_uuid());
    raise exception 'an owner finished an import';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

-- the admin adds partners (checked again in the database)
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000ad';
do $$
declare
  v_a uuid;
  v_b uuid;
  v_url text;
  v_err text;
begin
  foreach v_url in array array['http://feeds.example.com/a.xml', 'https://127.0.0.1/a.xml', 'https://localhost/a.xml',
                               'https://intranet.local/a.xml', 'https://user:pw@example.com/a.xml', 'ftp://example.com/a.xml',
                               'https://example.com/a b.xml'] loop
    begin
      perform public.admin_save_partner(jsonb_build_object('name', 'X', 'feed_format', 'google_xml', 'timezone', 'UTC', 'feed_url', v_url));
      raise exception 'a bad feed address was saved: %', v_url;
    exception when sqlstate '22023' then
      assert sqlerrm = 'feed_url', sqlerrm;
    end;
  end loop;
  foreach v_err in array array['name', 'format', 'heureka_currency', 'currency', 'timezone', 'schedule'] loop
    begin
      perform public.admin_save_partner(case v_err
        when 'name' then '{"name":" ","feed_format":"csv","timezone":"UTC"}'::jsonb
        when 'format' then '{"name":"X","feed_format":"rss","timezone":"UTC"}'::jsonb
        when 'heureka_currency' then '{"name":"X","feed_format":"heureka_xml","timezone":"UTC"}'::jsonb
        when 'currency' then '{"name":"X","feed_format":"csv","timezone":"UTC","currency":"EURO"}'::jsonb
        when 'timezone' then '{"name":"X","feed_format":"csv","timezone":"Mars/Base"}'::jsonb
        else '{"name":"X","feed_format":"csv","timezone":"UTC","schedule":"minutely"}'::jsonb end);
      raise exception 'a bad partner was saved (%)', v_err;
    exception when sqlstate '22023' then
      assert sqlerrm = v_err, format('%s expected, got %s', v_err, sqlerrm);
    end;
  end loop;

  v_a := public.admin_save_partner('{"name":"Šport Partner","feed_format":"google_xml","feed_url":"https://feeds.example.com/google.xml","inventory_url":"https://feeds.example.com/local.xml","timezone":"Europe/Bratislava","affiliate":true}');
  v_b := public.admin_save_partner('{"name":"Bazár Partner","feed_format":"heureka_xml","feed_url":"https://feeds.example.org/heureka.xml","currency":"eur","timezone":"Europe/Budapest"}');
  assert (select value ->> 'schedule' from jsonb_array_elements(public.admin_partner_settings() -> 'partners') where value ->> 'id' = v_b::text) = 'daily', 'daily by default';
  assert (select value ->> 'inventory_format' from jsonb_array_elements(public.admin_partner_settings() -> 'partners') where value ->> 'id' = v_a::text) = 'google_local_xml', 'the local inventory feed has a format';
  assert (select value ->> 'currency' from jsonb_array_elements(public.admin_partner_settings() -> 'partners') where value ->> 'id' = v_b::text) = 'EUR';

  -- the store list (only when the partner gives one); a wrong row names its number
  assert public.admin_save_partner_stores(v_a, '[
    {"code":"KE1","name":"Predajňa Košice","address":"Hlavná 1","city":"Košice","country":"SK"},
    {"code":"MI1","name":"Predajňa Michalovce","address":"Nám. osloboditeľov 1","city":"Michalovce","country":"sk"},
    {"code":"MI2","name":"Sklad pri Michalovciach","city":"Pozdišovce","lat":48.735,"lng":21.94},
    {"code":"BA1","name":"Predajňa Bratislava","city":"Bratislava"}]') = 4;
  begin
    perform public.admin_save_partner_stores(v_a, '[{"code":"X1","name":"OK"},{"code":"X2","name":"","city":"Nowhere"}]');
    raise exception 'a store without a name was saved';
  exception when sqlstate '22023' then
    assert sqlerrm = 'stores:2', sqlerrm;
  end;
  assert (select jsonb_array_length(value -> 'stores') from jsonb_array_elements(public.admin_partner_settings() -> 'partners') where value ->> 'id' = v_a::text) = 4, 'a refused list changes nothing';

  -- an uploaded file only from the partner's own folder, with the right name
  begin
    perform public.admin_set_partner_file(v_b, 'products', v_a::text || '/feed-1760000000000.xml');
    raise exception 'another partner''s file was taken';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.admin_set_partner_file(v_b, 'products', v_b::text || '/../feed-1760000000000.xml');
    raise exception 'a path with .. was taken';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.admin_set_partner_logo(v_b, 'other/logo.svg');
    raise exception 'a bad logo path was taken';
  exception when sqlstate '22023' then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

-- the function (service role): start, claim, parts, rows, finish
set role service_role;
do $$
declare
  v_a uuid := (select id from public.partners where name = 'Šport Partner');
  v_b uuid := (select id from public.partners where name = 'Bazár Partner');
  v_shop_items bigint := (select count(*) from public.shop_items);
  v_inventory bigint := (select count(*) from public.inventory);
  v_ids uuid[];
  v_imp uuid;
  v_inv uuid;
  v_claim jsonb;
  v_r record;
  v_changed timestamptz;
  v_first text;
begin
  select array_agg(x) into v_ids from public.partner_start_due() x;
  assert array_length(v_ids, 1) = 3, format('products for both, inventory for one: %s', array_length(v_ids, 1));
  assert not exists (select 1 from public.partner_start_due()), 'not due again until the schedule says so';
  assert (select next_run_at from public.partners where id = v_a) > now() + interval '23 hours', 'next turn a day later';
  select id into v_imp from public.partner_imports where partner_id = v_a and kind = 'products';
  select id into v_inv from public.partner_imports where partner_id = v_a and kind = 'inventory';

  -- one caller at a time
  v_claim := public.partner_import_claim(v_imp, 60);
  assert v_claim ->> 'url' = 'https://feeds.example.com/google.xml' and v_claim ->> 'format' = 'google_xml';
  assert v_claim -> 'previous' = 'null'::jsonb or v_claim -> 'previous' is null, 'no earlier import';
  assert public.partner_import_claim(v_imp, 60) is null, 'taken: a second caller gets nothing';
  begin
    insert into public.partner_imports (partner_id, kind, source, source_key) values (v_a, 'products', 'url', 'x');
    raise exception 'two running imports of one kind';
  exception when unique_violation then null;
  end;
  perform public.partner_import_downloaded(v_imp, 2, 1234, now() + interval '1 hour', 'Tue, 14 Oct 2026 06:00:00 GMT', '"abc"');
  assert (select feed_time <= now() from public.partner_imports where id = v_imp), 'the data''s time is never in the future';
  -- part 0 in two batches, then part 1; rows of a part read again are not doubled
  perform public.partner_import_rows(v_imp, 0, '[
    {"id":"S1","title":"Stan Quechua 2 Seconds","brand":"Quechua","gtin":"3608439000001","price":89.99,"currency":"EUR","availability":"in_stock","state":"in_stock","link":"https://partner.example.com/p/S1"},
    {"id":"S2","title":"Kladivo tesárske 600 g","brand":"Geologic","price":19.99,"sale_price":14.99,"sale_from":"2020-01-01T00:00:00Z","sale_to":"2099-01-01T00:00:00Z","currency":"EUR","availability":"out_of_stock","state":"out_of_stock","link":"https://partner.example.com/p/S2"}
  ]', false, null, null, null, null, null);
  perform public.partner_import_rows(v_imp, 0, '[
    {"id":"S3","title":"Spacák Forclaz 0°","price":59.0,"currency":"EUR","availability":"preorder","state":"preorder","link":"https://partner.example.com/p/S3"},
    {"id":"S3","title":"Spacák Forclaz 0° (2)","price":61.0,"currency":"EUR","availability":"preorder","state":"preorder","link":"https://partner.example.com/p/S3"}
  ]', true, '<item><g:id>S4', 4, 0, null, 'utf-8');
  assert (select title from public.partner_products where partner_id = v_a and item_id = 'S3') = 'Spacák Forclaz 0° (2)', 'the later row of a batch wins';
  begin
    perform public.partner_import_rows(v_imp, 0, '[]', true, '', 0, 0, null, null);
    raise exception 'a part was written twice';
  exception when sqlstate '55000' then null;
  end;
  assert (select part_index = 1 and carry = '<item><g:id>S4' and rows_read = 4 from public.partner_imports where id = v_imp);
  begin
    perform public.partner_import_finish(v_imp);
    raise exception 'finished before the last part';
  exception when sqlstate '55000' then null;
  end;
  perform public.partner_import_rows(v_imp, 1, '[{"id":"S4","title":"Turistická obuv MH100","price":49.99,"currency":"EUR","availability":"in_stock","state":"in_stock","link":"https://partner.example.com/p/S4"}]',
                                     true, '', 1, 0, null, null);
  assert public.partner_import_finish(v_imp) ->> 'status' = 'done';
  assert (select count(*) from public.partner_products where partner_id = v_a) = 4;
  assert (select bool_and(updated_at = (select feed_time from public.partner_imports where id = v_imp)) from public.partner_products where partner_id = v_a),
    'each item keeps the time of its data';

  -- the local inventory feed: stock per store, as the partner reports it
  perform public.partner_import_claim(v_inv, 60);
  perform public.partner_import_downloaded(v_inv, 1, 100, now() - interval '1 hour', null, null);
  perform public.partner_import_rows(v_inv, 0, '[
    {"id":"S1","store":"KE1","availability":"in_stock","state":"in_stock","quantity":3},
    {"id":"S1","store":"MI1","availability":"out_of_stock","state":"out_of_stock","quantity":0},
    {"id":"S1","store":"MI2","availability":"limited_availability","state":"limited","quantity":1},
    {"id":"S4","store":"BA1","availability":"in_stock","state":"in_stock","quantity":8}
  ]', true, '', 4, 0, null, 'utf-8');
  assert public.partner_import_finish(v_inv) ->> 'status' = 'done';

  -- Heureka partner: no inventory feed → no store stock at all
  v_imp := (select id from public.partner_imports where partner_id = v_b and kind = 'products');
  perform public.partner_import_claim(v_imp, 60);
  perform public.partner_import_downloaded(v_imp, 1, 100, now() - interval '2 hours', null, null);
  perform public.partner_import_rows(v_imp, 0, '[
    {"id":"H1","title":"Stan Quechua 2 Seconds","price":89.99,"currency":"EUR","availability":"0","state":"in_stock","link":"https://bazar.example.org/s1"},
    {"id":"H2","title":"Stan rodinný 4 osoby","price":149.0,"currency":"EUR","availability":"3","state":"in_days","days":3,"link":"https://bazar.example.org/s2"}
  ]', true, '', 2, 0, null, 'utf-8');
  assert public.partner_import_finish(v_imp) ->> 'status' = 'done';

  -- never mixed with the shops' data
  assert (select count(*) from public.shop_items) = v_shop_items and (select count(*) from public.inventory) = v_inventory,
    'a partner import touches no shop data';
  assert not exists (select 1 from public.search_stock('kladivo', null, null, null, false) where item_name ilike '%tesárske%'),
    'search_stock never returns partner rows';
  assert not exists (select 1 from public.search_stock('stan quechua', null, null, null, false)), 'no partner row in the shops'' search';
  assert not exists (select 1 from public.search_stock('kladivo', null, null, null, false) s
                     where not exists (select 1 from public.shop_items si where si.id = s.item_id)), 'only shop items in search_stock';
  assert not exists (select 1 from public.public_stock where item_name ilike '%Quechua%'), 'public_stock has no partner rows';

  -- an unchanged feed (304) keeps the time of its data
  update public.partners set next_run_at = now() where id = v_b;
  perform public.partner_start_due();
  v_imp := (select id from public.partner_imports where partner_id = v_b and status = 'download');
  v_claim := public.partner_import_claim(v_imp, 60);
  assert v_claim -> 'previous' ->> 'feed_time' is not null, 'the earlier import is offered for If-Modified-Since';
  perform public.partner_import_unchanged(v_imp);
  assert (select status = 'unchanged' and feed_time is not null from public.partner_imports where id = v_imp);

  -- a feed with mostly unreadable rows changes nothing more and is tried again within the hour
  update public.partners set next_run_at = now() where id = v_b;
  perform public.partner_start_due();
  v_imp := (select id from public.partner_imports where partner_id = v_b and status = 'download');
  perform public.partner_import_claim(v_imp, 60);
  perform public.partner_import_downloaded(v_imp, 1, 100, now(), null, null);
  perform public.partner_import_rows(v_imp, 0, '[]', true, '', 10, 9, null, null);
  assert public.partner_import_finish(v_imp) ->> 'error' = 'unreadable';
  assert (select count(*) from public.partner_products where partner_id = v_b) = 2, 'the earlier rows stay';
  assert (select next_run_at < now() + interval '61 minutes' from public.partners where id = v_b), 'tried again within the hour';

  -- a feed over the size limit stops with its reason and waits for the partner's next turn
  update public.partners set next_run_at = now() where id = v_b;
  perform public.partner_start_due();
  v_imp := (select id from public.partner_imports where partner_id = v_b and status = 'download');
  perform public.partner_import_claim(v_imp, 60);
  perform public.partner_import_fail(v_imp, 'too_big', 'The feed is larger than 50 MB (PARTNER_FEED_MAX_MB).');
  assert (select status = 'error' and error = 'too_big' and error_detail like '%PARTNER_FEED_MAX_MB%' from public.partner_imports where id = v_imp);
  assert (select next_run_at > now() + interval '23 hours' from public.partners where id = v_b), 'too big: no retry within the hour';
  assert (select count(*) from public.partner_products where partner_id = v_b) = 2, 'and nothing changed';

  -- an import that never finishes is given up after 30 tries
  update public.partners set next_run_at = now() where id = v_b;
  perform public.partner_start_due();
  v_imp := (select id from public.partner_imports where partner_id = v_b and status = 'download');
  update public.partner_imports set attempts = 30 where id = v_imp;
  assert public.partner_import_claim(v_imp, 60) ->> 'error' = 'stuck';

  -- a full new feed: rows it no longer has are removed; unchanged rows keep changed_at
  update public.partner_products set changed_at = now() - interval '1 day' where partner_id = v_a;
  select changed_at into v_changed from public.partner_products where partner_id = v_a and item_id = 'S1';
  update public.partners set next_run_at = now() where id = v_a;
  perform public.partner_start_due();
  v_imp := (select id from public.partner_imports where partner_id = v_a and kind = 'products' and status = 'download');
  delete from public.partner_imports where partner_id = v_a and kind = 'inventory' and status = 'download';
  perform public.partner_import_claim(v_imp, 60);
  perform public.partner_import_downloaded(v_imp, 1, 100, now() - interval '30 minutes', null, null);
  perform public.partner_import_rows(v_imp, 0, '[
    {"id":"S1","title":"Stan Quechua 2 Seconds","brand":"Quechua","gtin":"3608439000001","price":89.99,"currency":"EUR","availability":"in_stock","state":"in_stock","link":"https://partner.example.com/p/S1"},
    {"id":"S2","title":"Kladivo tesárske 600 g","brand":"Geologic","price":19.99,"sale_price":14.99,"sale_from":"2020-01-01T00:00:00Z","sale_to":"2099-01-01T00:00:00Z","currency":"EUR","availability":"out_of_stock","state":"out_of_stock","link":"https://partner.example.com/p/S2"},
    {"id":"S4","title":"Turistická obuv MH100","price":44.99,"currency":"EUR","availability":"in_stock","state":"in_stock","link":"https://partner.example.com/p/S4"}
  ]', true, '', 3, 0, null, null);
  perform public.partner_import_finish(v_imp);
  assert not exists (select 1 from public.partner_products where partner_id = v_a and item_id = 'S3'), 'gone from the feed: gone';
  assert (select changed_at from public.partner_products where partner_id = v_a and item_id = 'S1') = v_changed, 'unchanged values keep changed_at';
  assert (select changed_at > v_changed from public.partner_products where partner_id = v_a and item_id = 'S4'), 'a new price is a change';
end $$;
reset role;

-- the search: accent-insensitive, every word, partner name, GTIN; stores in the town from the feed only
set role anon;
do $$
declare
  v_r record;
  v_first uuid;
  v_order text;
begin
  assert public.partner_layer_ready();
  select * into v_r from public.search_partner_products('KLADIVO tesarske', null, 10);
  assert v_r.title = 'Kladivo tesárske 600 g' and v_r.price = 14.99 and v_r.regular_price = 19.99, 'sale price inside its dates';
  assert v_r.availability_state = 'out_of_stock' and v_r.availability = 'out_of_stock', 'availability as the feed wrote it';
  assert not exists (select 1 from public.search_partner_products('kladivo', null, 10) where title = 'Kladivo 500 g'), 'no shop items here';
  assert (select count(*) from public.search_partner_products('stan', null, 10)) = 3, 'both partners, accent-insensitive';
  assert (select count(*) from public.search_partner_products('stan bazar', null, 10)) = 2, 'the partner''s name is searched too';
  assert (select count(*) from public.search_partner_products('3608439000001', null, 10)) = 1, 'by GTIN';
  assert (select count(*) from public.search_partner_products('stan lietadlo', null, 10)) = 0, 'every word must match';
  assert not exists (select 1 from public.search_partner_products('', null, 10)), 'no term: nothing';

  -- no town: no stores; Michalovce: the store there and the one within 20 km of its centre (by the shops' centre)
  assert (select bool_and(stores = '[]'::jsonb) from public.search_partner_products('stan', null, 10)), 'stores only for a town';
  select * into v_r from public.search_partner_products('quechua', 'michalovce', 10) where partner_name = 'Šport Partner';
  assert jsonb_array_length(v_r.stores) = 2, format('two stores around Michalovce: %s', v_r.stores);
  assert v_r.stores -> 0 ->> 'code' = 'MI2' and v_r.stores -> 0 ->> 'state' = 'limited', 'in stock first';
  assert v_r.stores -> 1 ->> 'code' = 'MI1' and v_r.stores -> 1 ->> 'state' = 'out_of_stock';
  select * into v_r from public.search_partner_products('quechua', 'Košice', 10) where partner_name = 'Šport Partner';
  assert v_r.stores -> 0 ->> 'name' = 'Predajňa Košice' and (v_r.stores -> 0 ->> 'quantity')::numeric = 3;
  -- the Heureka partner has no local inventory feed: never any store stock
  assert (select bool_and(stores = '[]'::jsonb) from public.search_partner_products('stan', 'Košice', 10) where partner_name = 'Bazár Partner');
  -- the store list alone is no stock: Bratislava has a store, but this item has no row there
  assert (select stores from public.search_partner_products('quechua', 'Bratislava', 10) where partner_name = 'Šport Partner') = '[]'::jsonb;
  -- the store in Košice with stock comes first for Košice
  select partner_name into v_order from public.search_partner_products('stan quechua', 'Košice', 10) limit 1;
  assert v_order = 'Šport Partner', 'stock in a store in the town first';
end $$;
reset role;

-- older than 48 hours: no availability, no store stock, only the time; last in the order
set role service_role;
update public.partner_products set updated_at = now() - interval '49 hours' where item_id = 'S1';
update public.partner_store_stock set updated_at = now() - interval '49 hours' where item_id = 'S1' and store_code = 'KE1';
reset role;
set role anon;
do $$
declare v_r record;
begin
  select * into v_r from public.search_partner_products('quechua', 'Košice', 10) where partner_name = 'Šport Partner';
  assert v_r.stale and v_r.availability is null and v_r.availability_state is null and v_r.stores = '[]'::jsonb,
    'old data shows no availability';
  assert v_r.updated_at < now() - interval '48 hours', 'only its time';
  assert (select partner_name from public.search_partner_products('stan quechua', 'Košice', 10) limit 1) = 'Bazár Partner', 'fresh first';
end $$;
reset role;

-- the affiliate flag never changes the order
set role service_role;
update public.partner_products set updated_at = now() - interval '1 hour' where item_id = 'S1';
reset role;
do $$
declare
  v_before text;
  v_after text;
begin
  set local role anon;
  select string_agg(partner_name || ':' || item_id, ',') into v_before from public.search_partner_products('stan quechua', null, 10);
  reset role;
  update public.partners set affiliate = not affiliate;
  set local role anon;
  select string_agg(partner_name || ':' || item_id, ',') into v_after from public.search_partner_products('stan quechua', null, 10);
  reset role;
  assert v_before = v_after, format('affiliate changed the order: %s / %s', v_before, v_after);
  update public.partners set affiliate = not affiliate;
end $$;

-- the admin sees counts and imports; deleting a partner removes everything of it
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000ad';
do $$
declare
  v_s jsonb := public.admin_partner_settings();
  v_p jsonb;
  v_a uuid;
  v_del jsonb;
begin
  select value into v_p from jsonb_array_elements(v_s -> 'partners') where value ->> 'name' = 'Šport Partner';
  v_a := (v_p ->> 'id')::uuid;
  assert (v_p ->> 'products')::int = 3 and (v_p ->> 'store_stock')::int = 4 and jsonb_array_length(v_p -> 'stores') = 4;
  assert jsonb_array_length(v_p -> 'imports') >= 2;
  perform public.admin_queue_partner_import(v_a);
  v_del := public.admin_delete_partner(v_a);
  assert v_del ->> 'logo' is null and v_del -> 'files' = '[]'::jsonb;
  assert public.admin_delete_partner(v_a) is null, 'already gone';
end $$;
reset role;
reset request.jwt.claim.sub;
do $$ begin
  assert not exists (select 1 from public.partner_products pp where not exists (select 1 from public.partners p where p.id = pp.partner_id));
  assert not exists (select 1 from public.partner_store_stock ss where not exists (select 1 from public.partners p where p.id = ss.partner_id));
end $$;
delete from public.partners;

\echo '--- own domains fully findable: only our TXT record, Google and Bing meta tags, IndexNow per host (update 36)'
-- a live own domain for shop A (owner ...0a), a bought one in test mode for the TXT record
set role service_role;
do $$
declare v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
begin
  assert public.shop_has_plan(v_a), 'shop A has the plan';
  insert into public.domain_orders (shop_id, kind, hostname, site_host, status, live_at)
  values (v_a, 'connected', 'potraviny36.sk', 'potraviny36.sk', 'live', now());
end $$;
reset role;

-- the Search Console TXT: a record id only for a record Cacaduu added; a value already in DNS is "present"
do $$
declare v_o uuid := (select id from public.domain_orders where hostname = 'potraviny36.sk');
begin
  update public.domain_orders set google_verification = 'google-site-verification=AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-abcd',
    google_verification_state = 'present', google_verification_at = now() where id = v_o;
  begin
    update public.domain_orders set google_txt_record_id = '123' where id = v_o;
    raise exception 'a record id for a record Cacaduu did not add';
  exception when check_violation then null;
  end;
  update public.domain_orders set google_verification_state = 'added', google_txt_record_id = '123' where id = v_o;
  begin
    update public.domain_orders set google_txt_record_id = '1; drop table x' where id = v_o;
    raise exception 'a strange record id';
  exception when check_violation then null;
  end;
  update public.domain_orders set google_verification = null, google_verification_state = null, google_txt_record_id = null where id = v_o;
end $$;

-- visitors: no table, no owner or IndexNow function; the meta values only through site_verification_meta()
set role anon;
do $$
declare v_t text;
begin
  foreach v_t in array array['domain_site_verifications', 'indexnow_hosts', 'indexnow_pings'] loop
    begin
      execute format('select count(*) from public.%I', v_t);
      raise exception 'a visitor read %', v_t;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    perform public.owner_set_site_verification((select id from public.domain_orders where hostname = 'potraviny36.sk'), 'google', 'x');
    raise exception 'a visitor set a meta tag';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.indexnow_claim_host((select id from public.shops where slug = 'potraviny-centrum'), 'ppi.example.com');
    raise exception 'a visitor claimed a ping';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.indexnow_done('ppi.example.com', 'main', now(), null, 1, 200, '200');
    raise exception 'a visitor logged a ping';
  exception when insufficient_privilege then null;
  end;
  assert public.site_verification_meta('potraviny-centrum') ->> 'host' = 'potraviny36.sk';
  assert public.site_verification_meta('potraviny-centrum') ->> 'google' is null, 'nothing set yet';
  assert public.site_verification_meta('drogeria-kostolne') is null, 'no own domain: nothing';
end $$;
reset role;

-- the owner: Google's and Bing's meta tag values, the whole tag or the value, only that kind's format
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_o uuid := (select id from public.domain_orders where hostname = 'potraviny36.sk');
  v_bad text;
begin
  assert public.owner_set_site_verification(v_o, 'google', '<meta name="google-site-verification" content="Zx9_Yw8-Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe" />')
    = 'Zx9_Yw8-Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe', 'the whole tag';
  assert public.owner_set_site_verification(v_o, 'bing', '<meta name="msvalidate.01" content="0123456789abcdef0123456789ABCDEF" />')
    = '0123456789ABCDEF0123456789ABCDEF', 'Bing''s code';
  assert public.owner_set_site_verification(v_o, 'google', 'content="Ab12Cd34Ef56Gh78Ij90Kl12Mn34"') = 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34', 'content=…';
  foreach v_bad in array array[
    '<meta name="msvalidate.01" content="0123456789abcdef0123456789ABCDEF" />',
    '<script>alert(1)</script>', 'google-site-verification=short', 'abc def ghi jkl mno pqr stu',
    '"><script src=x>', '<meta name="google-site-verification" content="ok" onload="x">'] loop
    begin
      perform public.owner_set_site_verification(v_o, 'google', v_bad);
      raise exception 'a bad Google value was taken: %', v_bad;
    exception when invalid_parameter_value then assert sqlerrm = 'value', sqlerrm;
    end;
  end loop;
  begin
    perform public.owner_set_site_verification(v_o, 'bing', 'Zx9_Yw8-Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe');
    raise exception 'a Google value taken as Bing''s';
  exception when invalid_parameter_value then null;
  end;
  assert (select google_meta || ' ' || bing_meta from public.domain_site_verifications where order_id = v_o)
    = 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34 0123456789ABCDEF0123456789ABCDEF', 'the owner reads them; a refused value changes nothing';
  begin
    update public.domain_site_verifications set google_meta = 'Xx12Cd34Ef56Gh78Ij90Kl12Mn34' where order_id = v_o;
    raise exception 'an owner wrote the table directly';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

-- another owner: nothing of shop A
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$ begin
  assert not exists (select 1 from public.domain_site_verifications), 'another owner reads nothing';
  begin
    perform public.owner_set_site_verification((select id from public.domain_orders where hostname = 'potraviny36.sk'), 'google', 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34');
    raise exception 'another owner set shop A''s value';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

set role anon;
do $$ begin
  assert public.site_verification_meta('potraviny-centrum') = jsonb_build_object('host', 'potraviny36.sk', 'google', 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34', 'bing', '0123456789ABCDEF0123456789ABCDEF');
end $$;
reset role;

-- not live any more: the pages lose the tags, the owner cannot set new ones; an empty value removes
update public.domain_orders set status = 'waiting_dns' where hostname = 'potraviny36.sk';
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  begin
    perform public.owner_set_site_verification((select id from public.domain_orders where hostname = 'potraviny36.sk'), 'bing', '');
    raise exception 'set on a domain that is not live';
  exception when sqlstate 'P0001' then assert sqlerrm = 'state', sqlerrm;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;
do $$ begin assert public.site_verification_meta('potraviny-centrum') is null, 'not live: no tags'; end $$;
update public.domain_orders set status = 'live' where hostname = 'potraviny36.sk';
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  assert public.owner_set_site_verification((select id from public.domain_orders where hostname = 'potraviny36.sk'), 'bing', '  ') is null;
  assert (select bing_meta from public.domain_site_verifications) is null, 'removed';
end $$;
reset role;
reset request.jwt.claim.sub;

-- IndexNow: only what a search result shows (new, price, in stock <-> sold out), never 12 -> 11
delete from public.indexnow_hosts;
delete from public.indexnow_pings;
do $$ begin perform public.apply_stock_file((select id from public.shops where slug = 'potraviny-centrum'), '[
  {"source_code":"N1","name":"Ryža 1 kg","quantity":12,"price":1.5},
  {"source_code":"N2","name":"Cukor 1 kg","quantity":1,"price":0.99},
  {"source_code":"N3","name":"Soľ 1 kg","quantity":5,"price":0.39},
  {"source_code":"N4","name":"Múka 1 kg","quantity":0,"price":0.79}
]', now(), null); end $$;
-- (the trigger keeps indexnow_at on a plain update: back-dated with triggers off)
set session_replication_role = replica;
update public.inventory set indexnow_at = now() - interval '3 hours'
where shop_item_id in (select id from public.shop_items where shop_id = (select id from public.shops where slug = 'potraviny-centrum'));
reset session_replication_role;
do $$ begin perform public.apply_stock_file((select id from public.shops where slug = 'potraviny-centrum'), '[
  {"source_code":"N1","name":"Ryža 1 kg","quantity":11,"price":1.5},
  {"source_code":"N2","name":"Cukor 1 kg","quantity":0,"price":0.99},
  {"source_code":"N3","name":"Soľ 1 kg","quantity":5,"price":0.45},
  {"source_code":"N4","name":"Múka 1 kg","quantity":3,"price":0.79},
  {"source_code":"N5","name":"Olej 1 l","quantity":2,"price":2.49}
]', now(), null); end $$;
set role service_role;
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_c jsonb;
  v_codes text[];
begin
  v_c := public.indexnow_claim_host(v_a, 'ppi.example.com');
  assert v_c ->> 'host' = 'potraviny36.sk' and v_c ->> 'kind' = 'site' and v_c ->> 'lang' = 'sk', 'the own domain: ' || v_c::text;
  select array_agg(si.source_code order by si.source_code) into v_codes
  from public.shop_items si where si.id::text in (select value ->> 'id' from jsonb_array_elements(v_c -> 'items'));
  assert v_codes @> array['N2', 'N3', 'N4', 'N5'] and not (v_codes @> array['N1']),
    'sold out, price, back in stock and new — not 12 -> 11: ' || array_to_string(v_codes, ',');
  -- at most once an hour per host: the next upload waits, its changes stay for the next ping
  assert public.indexnow_claim_host(v_a, 'ppi.example.com') ->> 'skip' = 'hour';
  perform public.indexnow_done('potraviny36.sk', 'site', (v_c ->> 'upto')::timestamptz, (v_c ->> 'upto_id')::uuid, 12, 202, '202');
  assert (select sent_upto = (v_c ->> 'upto')::timestamptz and last_status = 202 and last_urls = 12 from public.indexnow_hosts where host = 'potraviny36.sk');
  assert (select indexnow_urls || ' ' || indexnow_result from public.domain_orders where hostname = 'potraviny36.sk') = '12 202', 'the owner sees it';
  assert (select count(*) from public.indexnow_pings where host = 'potraviny36.sk' and urls = 12 and status = 202) = 1, 'logged';
  -- an hour later, nothing new: no ping
  update public.indexnow_hosts set last_ping_at = now() - interval '61 minutes' where host = 'potraviny36.sk';
  assert public.indexnow_claim_host(v_a, 'ppi.example.com') ->> 'skip' = 'nothing';
  assert (select last_ping_at < now() - interval '1 hour' from public.indexnow_hosts where host = 'potraviny36.sk'), 'nothing sent: the hour is not used';
end $$;
reset role;

-- a failed ping: the same changes go with the next one
set session_replication_role = replica;
update public.inventory set indexnow_at = now() + interval '1 second'
where shop_item_id = (select id from public.shop_items where source_code = 'N5' and shop_id = (select id from public.shops where slug = 'potraviny-centrum'));
reset session_replication_role;
set role service_role;
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_c jsonb := public.indexnow_claim_host(v_a, 'ppi.example.com');
  v_d jsonb;
begin
  assert jsonb_array_length(v_c -> 'items') = 1, v_c::text;
  perform public.indexnow_done('potraviny36.sk', 'site', (v_c ->> 'upto')::timestamptz, (v_c ->> 'upto_id')::uuid, 3, null, 'failed: TypeError');
  update public.indexnow_hosts set last_ping_at = now() - interval '61 minutes' where host = 'potraviny36.sk';
  v_d := public.indexnow_claim_host(v_a, 'ppi.example.com');
  assert v_d -> 'items' = v_c -> 'items', 'retried with the next ping';
  perform public.indexnow_done('potraviny36.sk', 'site', (v_d ->> 'upto')::timestamptz, (v_d ->> 'upto_id')::uuid, 3, 200, '200');
  assert (select count(*) from public.indexnow_pings where host = 'potraviny36.sk') = 3;
end $$;
reset role;

-- the main Cacaduu host: every shop without a live own domain, never shop A's items; no main host given → nothing
set session_replication_role = replica;
update public.inventory set indexnow_at = now() + interval '2 seconds'
where shop_item_id in (select si.id from public.shop_items si join public.shops s on s.id = si.shop_id where s.slug in ('drogeria-kostolne', 'potraviny-centrum'));
reset session_replication_role;
-- and a plain update of the quantity only (12 -> 11 style) keeps it
do $$
declare v_before timestamptz;
begin
  select inv.indexnow_at into v_before from public.inventory inv join public.shop_items si on si.id = inv.shop_item_id
  where si.source_code = 'N1' and si.shop_id = (select id from public.shops where slug = 'potraviny-centrum');
  update public.inventory inv set quantity = 10 from public.shop_items si
  where si.id = inv.shop_item_id and si.source_code = 'N1' and si.shop_id = (select id from public.shops where slug = 'potraviny-centrum');
  assert (select inv.indexnow_at = v_before from public.inventory inv join public.shop_items si on si.id = inv.shop_item_id
          where si.source_code = 'N1' and si.shop_id = (select id from public.shops where slug = 'potraviny-centrum')), 'a sale keeps the time';
end $$;
set role service_role;
do $$
declare
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_c jsonb;
begin
  assert public.indexnow_claim_host(v_b, null) is null, 'no main host: no ping';
  assert public.indexnow_claim_host(v_b, 'not a host') is null;
  v_c := public.indexnow_claim_host(v_b, 'PPI.Example.com', 2);
  assert v_c ->> 'host' = 'ppi.example.com' and v_c ->> 'kind' = 'main', v_c::text;
  assert jsonb_array_length(v_c -> 'items') = 2, 'at most the limit';
  assert not exists (select 1 from jsonb_array_elements(v_c -> 'items') e where e.value ->> 'slug' = 'potraviny-centrum'),
    'a shop on its own domain is never pinged on the main host';
  assert public.indexnow_claim_host(v_b, 'ppi.example.com') ->> 'skip' = 'hour', 'the main host too: once an hour';
end $$;
reset role;

-- one upload's items share one time: a ping that holds only part of them, the next one goes on after the last one sent
set role service_role;
do $$
declare
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_t timestamptz;
  v_n integer;
  v_c jsonb;
  v_d jsonb;
begin
  select max(inv.indexnow_at), count(*) into v_t, v_n
  from public.inventory inv join public.shop_items si on si.id = inv.shop_item_id where si.shop_id = v_b;
  assert v_n >= 3, 'shop B has a few items';
  update public.indexnow_hosts set sent_upto = v_t - interval '1 millisecond', sent_upto_id = null, last_ping_at = null
  where host = 'ppi.example.com';
  v_c := public.indexnow_claim_host(v_b, 'ppi.example.com', 2);
  assert jsonb_array_length(v_c -> 'items') = 2 and (v_c ->> 'upto')::timestamptz = v_t and v_c ? 'upto_id', v_c::text;
  perform public.indexnow_done('ppi.example.com', 'main', (v_c ->> 'upto')::timestamptz, (v_c ->> 'upto_id')::uuid, 6, 200, '200');
  assert (select sent_upto = v_t and sent_upto_id = (v_c ->> 'upto_id')::uuid from public.indexnow_hosts where host = 'ppi.example.com');
  update public.indexnow_hosts set last_ping_at = null where host = 'ppi.example.com';
  v_d := public.indexnow_claim_host(v_b, 'ppi.example.com');
  assert jsonb_array_length(v_d -> 'items') = v_n - 2, 'the rest of the same upload: ' || v_d::text;
  assert not exists (select 1 from jsonb_array_elements(v_d -> 'items') d join jsonb_array_elements(v_c -> 'items') c on c.value = d.value),
    'none sent twice';
  -- an answer older than what was sent never moves the cursor back
  perform public.indexnow_done('ppi.example.com', 'main', v_t - interval '1 hour', null, 1, 200, '200');
  assert (select sent_upto = v_t from public.indexnow_hosts where host = 'ppi.example.com'), 'never back';
end $$;
reset role;

-- llms.txt facts: the stock file's categories and the holiday switch
set role anon;
do $$
declare v_f jsonb := public.shop_llms_facts('potraviny-centrum');
begin
  assert v_f ? 'stock_categories' and jsonb_typeof(v_f -> 'stock_categories') = 'array';
  assert (v_f ->> 'auto_holidays')::boolean is not null;
end $$;
reset role;
delete from public.domain_orders where hostname = 'potraviny36.sk';
delete from public.indexnow_hosts;
delete from public.indexnow_pings;

\echo '--- shop blog: posts as written, the publish dialog''s choice, free limit, Facebook import and publishing, IndexNow (update 37)'
-- shop B is free (its plan canceled above), shop A has the plan; B's subscription row is put back at the end
create temporary table blog_b_subscription as
select status, current_period_end from public.subscriptions where shop_id = (select id from public.shops where slug = 'drogeria-kostolne');
do $$
begin
  assert not public.shop_has_plan((select id from public.shops where slug = 'drogeria-kostolne'));
  assert public.shop_has_plan((select id from public.shops where slug = 'potraviny-centrum'));
end $$;
update public.blog_limits set max_posts = 10 where plan = 'free';
update public.blog_limits set max_posts = null where plan = 'pro';

-- visitors and other owners read nothing directly
set role anon;
do $$
begin
  begin
    perform 1 from public.blog_posts limit 1;
    raise exception 'a visitor read blog_posts';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.facebook_connections limit 1;
    raise exception 'a visitor read facebook_connections';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.owner_blog_save((select id from public.shops where slug = 'potraviny-centrum'), null, 'x', 'y');
    raise exception 'a visitor wrote a post';
  exception when insufficient_privilege then null;
  end;
  assert public.shop_blog_count('potraviny-centrum') = 0, 'no posts yet';
  assert (public.shop_blog('potraviny-centrum') ->> 'total')::integer = 0;
  assert public.shop_blog('no-such-shop') is null;
end $$;
reset role;

-- owner A writes: the title gives the address (accents dropped, unique), drafts are never public
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_p uuid;
  v_q uuid;
  v_r jsonb;
begin
  v_p := public.owner_blog_save(v_a, null, '  Čerstvé jahody už sú tu!  ', E'Prvý odsek.\n\nDruhý odsek s odkazom https://example.com a #jahody');
  assert (select slug from public.blog_posts where id = v_p) = 'cerstve-jahody-uz-su-tu', (select slug from public.blog_posts where id = v_p);
  assert (select title from public.blog_posts where id = v_p) = 'Čerstvé jahody už sú tu!', 'the title as written (trimmed)';
  assert (select body from public.blog_posts where id = v_p) like E'Prvý odsek.\n\nDruhý%#jahody', 'the text exactly as written';
  assert (select status from public.blog_posts where id = v_p) = 'draft';
  v_q := public.owner_blog_save(v_a, null, 'Čerstvé jahody už sú tu', 'b');
  assert (select slug from public.blog_posts where id = v_q) = 'cerstve-jahody-uz-su-tu-2', 'addresses are unique in the shop';
  -- a draft's address follows its title
  perform public.owner_blog_save(v_a, v_q, 'Malinový týždeň', 'b');
  assert (select slug from public.blog_posts where id = v_q) = 'malinovy-tyzden';
  begin
    perform public.owner_blog_save(v_a, null, '   ', 'x');
    raise exception 'an empty title accepted';
  exception when invalid_parameter_value then assert sqlerrm = 'title';
  end;
  begin
    perform public.owner_blog_save(v_b, null, 'Cudzí', 'x');
    raise exception 'owner A wrote into shop B';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.blog_posts set title = 'x' where id = v_p;
    raise exception 'a post changed directly';
  exception when insufficient_privilege then null;
  end;
  -- "Web + Facebook" needs a connected Page
  begin
    perform public.owner_blog_publish(v_p, null, 'web_fb');
    raise exception 'web_fb without a Page';
  exception when object_not_in_prerequisite_state then assert sqlerrm = 'no_facebook';
  end;
  begin
    perform public.owner_blog_publish(v_p, null, 'facebook');
    raise exception 'an unknown choice';
  exception when invalid_parameter_value then assert sqlerrm = 'choice';
  end;
  -- "Len na web", now
  v_r := public.owner_blog_publish(v_p, null, 'web');
  assert (v_r ->> 'scheduled')::boolean = false and (v_r ->> 'facebook_now')::boolean = false, v_r::text;
  assert (select status = 'published' and fb_choice = 'web' and fb_status is null from public.blog_posts where id = v_p);
  assert (select last_choice from public.shop_blog_settings where shop_id = v_a) = 'web', 'the choice is remembered';
  -- live: published again → refused (edits never go to Facebook); the address stays when the title changes
  begin
    perform public.owner_blog_publish(v_p, null, 'web');
    raise exception 'published twice';
  exception when object_not_in_prerequisite_state then assert sqlerrm = 'published';
  end;
  perform public.owner_blog_save(v_a, v_p, 'Čerstvé jahody sú tu', E'Prvý odsek.\n\nDruhý odsek s odkazom https://example.com a #jahody');
  assert (select slug from public.blog_posts where id = v_p) = 'cerstve-jahody-uz-su-tu', 'a live post keeps its address';
  -- scheduled: a time ahead (at most a year)
  v_r := public.owner_blog_publish(v_q, now() + interval '2 days', 'web');
  assert (v_r ->> 'scheduled')::boolean, v_r::text;
  begin
    perform public.owner_blog_publish(v_q, now() + interval '400 days', 'web');
    raise exception 'two years ahead';
  exception when invalid_parameter_value then assert sqlerrm = 'when';
  end;
  -- owner A sees its posts, never shop B's; the list says which are visible
  v_r := public.owner_blog_posts(v_a);
  assert jsonb_array_length(v_r -> 'posts') = 2 and (v_r -> 'limit') = 'null'::jsonb, v_r::text;
  assert exists (select 1 from jsonb_array_elements(v_r -> 'posts') e where e.value ->> 'id' = v_p::text and (e.value ->> 'visible')::boolean);
  assert exists (select 1 from jsonb_array_elements(v_r -> 'posts') e where e.value ->> 'id' = v_q::text and not (e.value ->> 'visible')::boolean);
  begin
    perform public.owner_blog_posts(v_b);
    raise exception 'owner A read shop B''s posts';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

-- visitors: the published post, as written; the scheduled one only when its time comes
set role anon;
do $$
declare v_b jsonb := public.shop_blog('potraviny-centrum');
declare v_p jsonb;
begin
  assert (v_b ->> 'total')::integer = 1 and public.shop_blog_count('potraviny-centrum') = 1, v_b::text;
  v_p := public.shop_blog_post('potraviny-centrum', 'cerstve-jahody-uz-su-tu');
  assert v_p ->> 'title' = 'Čerstvé jahody sú tu' and v_p ->> 'body' like '%#jahody', v_p::text;
  assert public.shop_blog_post('potraviny-centrum', 'malinovy-tyzden') is null, 'a scheduled post is not public before its time';
  assert public.shop_blog_post('potraviny-centrum', 'nope') is null;
  -- the assistant's search: every word, accents and case ignored
  assert (select count(*) from public.search_shop_blog('potraviny-centrum', 'JAHODY odsek')) = 1;
  assert (select count(*) from public.search_shop_blog('potraviny-centrum', 'malinovy')) = 0, 'never a post that is not visible';
  assert (select count(*) from public.blog_index('potraviny-centrum')) = 1;
end $$;
reset role;
update public.blog_posts set publish_at = now() where slug = 'malinovy-tyzden';
set role anon;
do $$
begin
  assert public.shop_blog_count('potraviny-centrum') = 2, 'the scheduled post is live at its time';
  assert (public.shop_blog('potraviny-centrum') -> 'posts' -> 0 ->> 'slug') = 'malinovy-tyzden', 'newest first';
end $$;
reset role;

-- hide / show; an edit of a live post is dateModified
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare v_p uuid := (select id from public.blog_posts where slug = 'malinovy-tyzden');
begin
  perform public.owner_blog_set_hidden(v_p, true);
  assert public.shop_blog_count('potraviny-centrum') = 1;
  perform public.owner_blog_set_hidden(v_p, false);
  assert public.shop_blog_count('potraviny-centrum') = 2;
end $$;
reset role;
reset request.jwt.claim.sub;
update public.blog_posts set edited_at = null where slug = 'malinovy-tyzden';
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare v_p uuid := (select id from public.blog_posts where slug = 'malinovy-tyzden');
begin
  perform public.owner_blog_save((select id from public.shops where slug = 'potraviny-centrum'), v_p, 'Malinový týždeň', 'nový text');
  assert (select edited_at is not null from public.blog_posts where id = v_p), 'an edit of a live post';
end $$;
reset role;
reset request.jwt.claim.sub;

-- the free limit: the newest 10 of a free shop, all with the plan; only the admin changes it
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_id uuid;
  i integer;
begin
  for i in 1..12 loop
    v_id := public.owner_blog_save(v_b, null, 'Novinka ' || i, 'text ' || i);
    perform public.owner_blog_publish(v_id, null, 'web');
  end loop;
end $$;
reset role;
reset request.jwt.claim.sub;
do $$
declare v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
begin
  -- one second apart: 1 oldest, 12 newest
  update public.blog_posts set publish_at = now() - make_interval(secs => 100 - substring(title from '[0-9]+')::integer)
  where shop_id = v_b;
end $$;
set role anon;
do $$
declare v_j jsonb := public.shop_blog('drogeria-kostolne', 1, 12);
begin
  assert (v_j ->> 'total')::integer = 10, 'free: the newest 10 ' || v_j::text;
  assert v_j -> 'posts' -> 0 ->> 'title' = 'Novinka 12' and v_j -> 'posts' -> 9 ->> 'title' = 'Novinka 3', v_j::text;
  assert public.shop_blog_post('drogeria-kostolne', 'novinka-1') is null, 'the 11th newest is not shown';
  assert (public.shop_blog('drogeria-kostolne', 2, 6) -> 'posts' -> 0 ->> 'title') = 'Novinka 6', 'page 2';
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
begin
  begin
    perform public.admin_save_blog_limits('free', 50);
    raise exception 'an owner changed the limits';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000ad';
set role authenticated;
do $$
begin
  perform public.admin_save_blog_limits('free', 11);
  assert public.shop_blog_count('drogeria-kostolne') = 11;
  perform public.admin_save_blog_limits('free', 10);
  begin
    perform public.admin_save_blog_limits('gold', 1);
    raise exception 'an unknown plan';
  exception when invalid_parameter_value then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;
update public.subscriptions set status = 'active', current_period_end = now() + interval '30 days'
where shop_id = (select id from public.shops where slug = 'drogeria-kostolne');
set role anon;
do $$
begin
  assert public.shop_blog_count('drogeria-kostolne') = 12, 'the plan: every post';
end $$;
reset role;
update public.subscriptions s set status = b.status, current_period_end = b.current_period_end from blog_b_subscription b
where s.shop_id = (select id from public.shops where slug = 'drogeria-kostolne');

-- the Facebook Page: OAuth states once, pages only for whoever logged in, the token never for owners
set role service_role;
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_s jsonb;
  v_id uuid := gen_random_uuid();
begin
  perform public.facebook_state_save('hash-1', v_a, '00000000-0000-0000-0000-00000000000a', 'https://ppi.example/sk/dashboard/blog?shop=x');
  v_s := public.facebook_state_take('hash-1');
  assert v_s ->> 'shop_id' = v_a::text, v_s::text;
  assert public.facebook_state_take('hash-1') is null, 'a state works once';
  perform public.facebook_pending_save(v_id, v_a, '00000000-0000-0000-0000-00000000000a', 'v1.enc', 'https://ppi.example/sk/dashboard/blog', 'pages_show_list');
  assert public.facebook_pending_get(v_id, '00000000-0000-0000-0000-00000000000b') is null, 'another user never sees the pages';
  assert public.facebook_pending_get(v_id, '00000000-0000-0000-0000-00000000000a') ->> 'pages_enc' = 'v1.enc';
  assert public.facebook_pending_get(v_id, '00000000-0000-0000-0000-00000000000a', true) is not null;
  assert public.facebook_pending_get(v_id, '00000000-0000-0000-0000-00000000000a') is null, 'taken';
  perform public.facebook_connection_save(v_a, '123456789', 'Potraviny Centrum', 'https://scontent.example/p.jpg',
                                          'v1.secret-token', 'pages_show_list,pages_read_engagement,pages_manage_posts',
                                          '00000000-0000-0000-0000-00000000000a', 'https://ppi.example');
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
begin
  assert (select page_name from public.facebook_connections) = 'Potraviny Centrum', 'the owner sees the Page';
  begin
    perform page_token_enc from public.facebook_connections;
    raise exception 'an owner read the Page token';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
begin
  assert not exists (select 1 from public.facebook_connections), 'owner B never sees shop A''s Page';
end $$;
reset role;
reset request.jwt.claim.sub;

-- "Web + Facebook": now (the function posts it at once), scheduled (the job at its time), retry, never twice
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_p uuid := public.owner_blog_save(v_a, null, 'Na webe aj na Facebooku', 'Text pre obe miesta.');
  v_q uuid := public.owner_blog_save(v_a, null, 'Naplánované na Facebook', 'Neskôr.');
  v_r jsonb;
begin
  v_r := public.owner_blog_publish(v_p, null, 'web_fb');
  assert (v_r ->> 'facebook_now')::boolean, v_r::text;
  assert (select fb_status from public.blog_posts where id = v_p) = 'waiting';
  v_r := public.owner_blog_publish(v_q, now() + interval '1 day', 'web_fb');
  assert not (v_r ->> 'facebook_now')::boolean;
  -- changeable until its time
  perform public.owner_blog_set_choice(v_q, 'web');
  assert (select fb_choice = 'web' and fb_status is null from public.blog_posts where id = v_q);
  perform public.owner_blog_set_choice(v_q, 'web_fb');
  assert (select fb_status from public.blog_posts where id = v_q) = 'waiting';
  begin
    perform public.owner_blog_set_choice(v_p, 'web');
    raise exception 'the choice of a live post changed';
  exception when object_not_in_prerequisite_state then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;
set role service_role;
do $$
declare
  v_p uuid := (select id from public.blog_posts where slug = 'na-webe-aj-na-facebooku');
  v_q uuid := (select id from public.blog_posts where slug = 'naplanovane-na-facebook');
  v_c jsonb;
begin
  assert v_p in (select public.blog_fb_due(10)) and v_q not in (select public.blog_fb_due(10)), 'only what is live';
  v_c := public.blog_fb_claim(v_p);
  assert v_c ->> 'title' = 'Na webe aj na Facebooku' and v_c ->> 'shop_slug' = 'potraviny-centrum', v_c::text;
  assert public.blog_fb_claim(v_p) is null, 'taken once';
  perform public.blog_fb_result(v_p, null, null, '(#200) The user hasn''t authorized the application');
  assert (select fb_status = 'failed' and fb_error like '(#200)%' from public.blog_posts where id = v_p);
  assert v_p not in (select public.blog_fb_due(10)), 'a failure waits for the owner';
  assert public.blog_fb_claim(v_p) is null, 'no retry without the owner';
  assert public.blog_fb_claim(v_p, true) is not null, '"Skúsiť znova na Facebook"';
  perform public.blog_fb_result(v_p, '123456789_555', 'https://www.facebook.com/123456789/posts/555', null);
  assert (select fb_status = 'posted' and fb_post_id = '123456789_555' and fb_error is null from public.blog_posts where id = v_p);
  assert public.blog_fb_claim(v_p, true) is null, 'never posted twice';
  -- the next import reads that post back from the Page: nothing new
  v_c := public.blog_import_post((select shop_id from public.blog_posts where id = v_p), '123456789_555', 'Na webe aj na Facebooku',
                                 E'Text pre obe miesta.\n\nČítať na webe: https://ppi.example/sk/shops/potraviny-centrum/blog/na-webe-aj-na-facebooku',
                                 now(), now(), null, '[]', '[]');
  assert v_c ->> 'result' = 'own', v_c::text;
  -- a stuck attempt (no answer for 10 minutes) is a failure, never sent again by itself
  update public.blog_posts set publish_at = now() - interval '1 minute' where id = v_q;
  perform public.blog_fb_claim(v_q);
  update public.blog_posts set fb_posting_at = now() - interval '11 minutes' where id = v_q;
  assert public.blog_fb_claim(v_q) is null;
  assert (select fb_status from public.blog_posts where id = v_q) = 'failed';
end $$;
reset role;

-- imports: as written, live or waiting for approval, edits (not comments), deleted → hidden, photos replaced
set role service_role;
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_r jsonb;
  v_id uuid;
  v_t timestamptz := now() - interval '3 days';
begin
  v_r := public.blog_import_post(v_a, '123456789_1001', 'Otvárame v nedeľu', E'Otvárame v nedeľu. Príďte! #nedela',
                                 v_t, v_t, 'https://www.facebook.com/123456789/posts/1001',
                                 '[{"kind":"link","url":"https://example.com/akcia","title":"Akcia"}]',
                                 '[{"kind":"photo","fb_media_id":"9001","source_url":"https://scontent.example/1.jpg"},
                                   {"kind":"video","fb_media_id":"9002","source_url":"https://scontent.example/v.jpg","link_url":"https://www.facebook.com/watch/?v=9002"}]');
  assert v_r ->> 'result' = 'new', v_r::text;
  v_id := (v_r ->> 'post_id')::uuid;
  assert (select status = 'published' and source = 'facebook' and publish_at = v_t and body = E'Otvárame v nedeľu. Príďte! #nedela'
          from public.blog_posts where id = v_id);
  assert (select count(*) from public.blog_photos where post_id = v_id and status = 'pending') = 2;
  assert (select link_url from public.blog_photos where post_id = v_id and kind = 'video') = 'https://www.facebook.com/watch/?v=9002';
  -- the same post again: nothing; a later updated_time without a change (a comment): still the same
  assert public.blog_import_post(v_a, '123456789_1001', 'Otvárame v nedeľu', E'Otvárame v nedeľu. Príďte! #nedela',
                                 v_t, v_t, null, '[{"kind":"link","url":"https://example.com/akcia","title":"Akcia"}]',
                                 '[{"fb_media_id":"9001"},{"kind":"video","fb_media_id":"9002"}]') ->> 'result' = 'same';
  assert public.blog_import_post(v_a, '123456789_1001', 'Otvárame v nedeľu', E'Otvárame v nedeľu. Príďte! #nedela',
                                 v_t, now(), null, '[{"kind":"link","url":"https://example.com/akcia","title":"Akcia"}]',
                                 '[{"fb_media_id":"9001"},{"kind":"video","fb_media_id":"9002"}]') ->> 'result' = 'same';
  assert (select edited_at is null from public.blog_posts where id = v_id), 'a comment is no edit';
  -- the owner's title stays when Facebook's text changes; the photos changed: the old files are returned
  update public.blog_posts set title = 'Nedeľa otvorené', title_by_owner = true where id = v_id;
  update public.blog_photos set status = 'ready', path_large = v_a || '/' || v_id || '/' || id || '-1600.webp' where post_id = v_id;
  v_r := public.blog_import_post(v_a, '123456789_1001', 'Otvárame v nedeľu od 9', E'Otvárame v nedeľu od 9. Príďte!',
                                 v_t, now(), null, '[]', '[{"fb_media_id":"9003"}]');
  assert v_r ->> 'result' = 'updated' and jsonb_array_length(v_r -> 'removed') = 2, v_r::text;
  assert (select title = 'Nedeľa otvorené' and body = E'Otvárame v nedeľu od 9. Príďte!' and edited_at is not null and links = '[]'
          from public.blog_posts where id = v_id);
  assert (select count(*) from public.blog_photos where post_id = v_id) = 1;
  -- deleted on Facebook → hidden here
  assert public.blog_posts_deleted_on_facebook(v_a, array['123456789_1001']) = 1;
  assert (select status = 'hidden' and fb_deleted_at is not null from public.blog_posts where id = v_id);
  assert public.blog_posts_deleted_on_facebook(v_a, array['123456789_1001']) = 0, 'once';
  -- a Cacaduu post Facebook gave no id for (an answer lost): linked by its "Čítať na webe" address, never imported
  update public.blog_posts set fb_post_id = null, fb_status = 'failed' where slug = 'naplanovane-na-facebook';
  v_r := public.blog_import_post(v_a, '123456789_1002', 'Naplánované na Facebook', 'Neskôr. Čítať na webe: …', now(), now(),
                                 'https://www.facebook.com/123456789/posts/1002', '[]', '[]', 'naplanovane-na-facebook');
  assert v_r ->> 'result' = 'linked', v_r::text;
  assert (select fb_post_id = '123456789_1002' and fb_status = 'posted' from public.blog_posts where slug = 'naplanovane-na-facebook');
  -- "Schvaľovať pred zverejnením": imported posts wait
  insert into public.shop_blog_settings (shop_id, auto_publish) values (v_a, false)
  on conflict (shop_id) do update set auto_publish = false;
  v_r := public.blog_import_post(v_a, '123456789_1003', 'Čakám na schválenie', 'Text', now(), now(), null, '[]', '[]');
  assert (select status from public.blog_posts where id = (v_r ->> 'post_id')::uuid) = 'pending';
  assert not public.blog_post_visible((v_r ->> 'post_id')::uuid), 'not shown before approval';
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare v_id uuid := (select id from public.blog_posts where fb_post_id = '123456789_1003');
begin
  -- the owner changes the title only; Facebook's text stays
  begin
    perform public.owner_blog_save((select id from public.shops where slug = 'potraviny-centrum'), v_id, 'Schválené', 'iný text');
    raise exception 'an imported text changed';
  exception when invalid_parameter_value then assert sqlerrm = 'imported_text';
  end;
  perform public.owner_blog_save((select id from public.shops where slug = 'potraviny-centrum'), v_id, 'Schválené', '');
  perform public.owner_blog_set_hidden(v_id, false);
  assert (select status = 'published' and title = 'Schválené' and title_by_owner and body = 'Text' from public.blog_posts where id = v_id);
  perform public.owner_blog_settings((select id from public.shops where slug = 'potraviny-centrum'), true);
end $$;
reset role;
reset request.jwt.claim.sub;

-- photos: at most 10 on a Cacaduu post, ready with both sizes, removed with their files
set role service_role;
do $$
declare
  v_p uuid := (select id from public.blog_posts where slug = 'cerstve-jahody-uz-su-tu');
  v_a uuid := (select shop_id from public.blog_posts where slug = 'cerstve-jahody-uz-su-tu');
  v_f uuid;
  i integer;
begin
  for i in 1..10 loop
    v_f := public.blog_photo_add(v_p, 'uploading');
  end loop;
  begin
    perform public.blog_photo_add(v_p, 'uploading');
    raise exception 'an 11th photo';
  exception when object_not_in_prerequisite_state then assert sqlerrm = 'photo_limit';
  end;
  perform public.blog_photo_stored(v_f, 1600, v_a || '/' || v_p || '/' || v_f || '-1600.webp', 'webp', 1600, 1200);
  assert (select status from public.blog_photos where id = v_f) = 'uploading', 'not before both sizes';
  perform public.blog_photo_stored(v_f, 800, v_a || '/' || v_p || '/' || v_f || '-800.webp', 'webp', 800, 600);
  assert (select status from public.blog_photos where id = v_f) = 'ready';
  assert jsonb_array_length(public.shop_blog_post('potraviny-centrum', 'cerstve-jahody-uz-su-tu') -> 'photos') = 1;
  assert (public.shop_blog_post('potraviny-centrum', 'cerstve-jahody-uz-su-tu') -> 'photos' -> 0 ->> 'small') like '%-800.webp';
  assert array_length(public.blog_photo_delete(v_f), 1) = 2, 'both files to remove';
  -- unfinished uploads go after an hour
  update public.blog_photos set created_at = now() - interval '2 hours' where post_id = v_p and status = 'uploading';
  assert public.blog_stale_uploads() = 9;
  v_f := public.blog_photo_add(v_p, 'uploading');
  begin
    update public.blog_photos set path_large = '../../etc/passwd' where id = v_f;
    raise exception 'a strange path accepted';
  exception when check_violation then null;
  end;
  perform public.blog_photo_delete(v_f);
end $$;
reset role;

-- the e-mail when the connection expires: once; "Odpojiť" deletes the token, waiting posts fail with a reason
set role service_role;
do $$
declare v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
begin
  perform public.facebook_connection_result(v_a, 'Error validating access token', true);
  assert (select status from public.facebook_connections where shop_id = v_a) = 'expired';
  assert (select emails from public.facebook_alerts_due() where shop_id = v_a) = array['owner-a@example.invalid'];
  perform public.facebook_alert_sent(v_a);
  assert not exists (select 1 from public.facebook_alerts_due() where shop_id = v_a), 'one e-mail';
  assert not public.facebook_import_start(v_a), 'no import while expired';
  perform public.facebook_connection_save(v_a, '123456789', 'Potraviny Centrum', null, 'v1.new', null, null, null);
  assert (select status = 'ok' and alert_sent_at is null from public.facebook_connections where shop_id = v_a), 'connected again';
  -- the import: page by page, one call at a time
  assert public.facebook_import_start(v_a);
  assert not public.facebook_import_start(v_a), 'one import at a time';
  assert public.facebook_import_take(v_a) ->> 'cursor' = '';
  assert public.facebook_import_take(v_a) is null, 'one call at a time';
  perform public.facebook_import_step(v_a, 'QVFIUa', 25);
  assert public.facebook_import_take(v_a) ->> 'cursor' = 'QVFIUa';
  perform public.facebook_import_step(v_a, null, 3);
  assert (select import_state = 'done' and import_count = 28 from public.facebook_connections where shop_id = v_a);
  -- a webhook: that Page syncs soon
  assert public.facebook_sync_page_soon('123456789') = 1;
  assert v_a in (select public.facebook_sync_due(5));
  assert v_a not in (select public.facebook_sync_due(5)), 'taken';
  perform public.facebook_sync_done(v_a, 'Potraviny Centrum s.r.o.', null);
  assert (select page_name = 'Potraviny Centrum s.r.o.' and next_sync_at > now() + interval '23 hours' from public.facebook_connections where shop_id = v_a);
  -- "Odpojiť"
  update public.blog_posts set fb_status = 'waiting', publish_at = now() + interval '1 day', status = 'published'
  where slug = 'naplanovane-na-facebook';
  update public.blog_posts set fb_post_id = null where slug = 'naplanovane-na-facebook';
  assert public.facebook_disconnect(v_a);
  assert not exists (select 1 from public.facebook_connections where shop_id = v_a), 'the token is gone';
  assert (select fb_status = 'failed' and fb_error is not null from public.blog_posts where slug = 'naplanovane-na-facebook');
  assert exists (select 1 from public.blog_posts where shop_id = v_a and source = 'facebook'), 'imported posts stay';
end $$;
reset role;

-- IndexNow: new and changed posts per host, once an hour (shared with the stock), sent only on a 2xx
delete from public.indexnow_hosts;
set role service_role;
do $$
declare
  v_c jsonb;
  v_ids uuid[];
begin
  v_c := public.blog_indexnow_claim('ppi.example.com');
  assert v_c ->> 'host' = 'ppi.example.com' and v_c ->> 'kind' = 'main', coalesce(v_c::text, 'null');
  assert exists (select 1 from jsonb_array_elements(v_c -> 'posts') e where e.value ->> 'slug' = 'cerstve-jahody-uz-su-tu');
  assert not exists (select 1 from jsonb_array_elements(v_c -> 'posts') e where e.value ->> 'slug' = 'novinka-1'),
    'never a post the free limit does not show';
  assert public.blog_indexnow_claim('ppi.example.com') is null, 'once an hour per host';
  select array_agg((e.value ->> 'id')::uuid) into v_ids from jsonb_array_elements(v_c -> 'posts') e;
  perform public.blog_indexnow_done('ppi.example.com', 'main', (v_c ->> 'at')::timestamptz, v_ids, 3, 500, 'error');
  assert exists (select 1 from public.blog_posts where id = any(v_ids) and indexnow_sent_at is null), 'a failure is sent again';
  perform public.blog_indexnow_done('ppi.example.com', 'main', (v_c ->> 'at')::timestamptz, v_ids, 3, 200, 'ok');
  assert not exists (select 1 from public.blog_posts where id = any(v_ids) and indexnow_sent_at is null);
  assert (select count(*) from public.indexnow_pings where result like 'blog:%') = 2;
end $$;
reset role;
-- only the hour stopped it: nothing left now
update public.indexnow_hosts set last_ping_at = null;
set role service_role;
do $$
begin
  assert public.blog_indexnow_claim('ppi.example.com') is null, 'nothing new';
  assert public.blog_indexnow_claim(null) is null;
end $$;
reset role;

do $$
begin
  assert exists (select 1 from cron.job where jobname = 'ppi-blog-tick'), 'the blog job is scheduled';
end $$;
drop table blog_b_subscription;
delete from public.indexnow_hosts;
delete from public.indexnow_pings;

\echo '--- "Obsah stránky": one slider of posts, PDFs and pictures, the owner''s order, limits per plan (update 38)'
-- shop B (owner B, free) starts empty; shop A (owner A, Pro) keeps its sections of updates 28–31 (not arranged yet)
do $$
declare
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
begin
  delete from public.shop_content_slots where shop_id = v_b;
  delete from public.shop_page_content where shop_id = v_b;
  delete from public.shop_page_sections where shop_id = v_b;
  delete from public.blog_posts where shop_id = v_b;
  perform public.apply_stripe_subscription(v_b, 'cus_B1', 'sub_B1', 'canceled', 'pro', now() - interval '1 day', null);
  assert not public.shop_has_plan(v_b);
  -- the update's defaults: free 5 slides of which 1 PDF and 10 files, Pro 10 / 10 / 30
  update public.section_limits set max_slides = 5, max_pdf_slides = 1, max_items = 10, max_pages = 5, max_mb = 10 where plan = 'free';
  update public.section_limits set max_slides = 10, max_pdf_slides = 10, max_items = 30, max_pages = 20, max_mb = 10 where plan = 'pro';
end $$;

-- visitors read nothing directly; the slides only through shop_content()
set role anon;
do $$
begin
  begin
    perform 1 from public.shop_content_slots limit 1;
    raise exception 'a visitor read the slots';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.shop_page_content limit 1;
    raise exception 'a visitor read the settings';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.owner_content((select id from public.shops where slug = 'drogeria-kostolne'));
    raise exception 'a visitor read the editor';
  exception when insufficient_privilege then null;
  end;
  -- not arranged, no posts, no files: three automatic slots and nothing to show (no blank slides)
  assert jsonb_array_length(public.shop_content('drogeria-kostolne') -> 'slides') = 0;
  assert not (public.shop_content('drogeria-kostolne') ->> 'has_posts')::boolean;
  assert public.shop_content('drogeria-kostolne') ->> 'display' = 'open';
  assert (public.shop_content('drogeria-kostolne') ->> 'show_title')::boolean;
  assert public.shop_content('no-such-shop') is null;
end $$;
reset role;
do $$
declare
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
begin
  assert (select count(*) from public.content_slots(v_b) where kind = 'auto_post') = 3, 'three automatic posts by default';
  -- two posts: two slides (fewer posts than automatic slots: no empty slide)
  insert into public.blog_posts (shop_id, slug, title, body, status, publish_at)
  values (v_b, 'clanok-1', 'Článok 1', 'Prvý.', 'published', now() - interval '4 days'),
         (v_b, 'clanok-2', 'Článok 2', 'Druhý.', 'published', now() - interval '3 days');
  assert jsonb_array_length(public.shop_content('drogeria-kostolne') -> 'slides') = 2;
  assert public.shop_content('drogeria-kostolne') #>> '{slides,0,post,slug}' = 'clanok-2', 'newest first';
  -- a new post: the automatic slots move on by themselves
  insert into public.blog_posts (shop_id, slug, title, body, status, publish_at)
  values (v_b, 'clanok-3', 'Článok 3', 'Tretí.', 'published', now() - interval '2 days'),
         (v_b, 'clanok-4', 'Článok 4', 'Štvrtý.', 'published', now() - interval '1 day'),
         (v_b, 'koncept', 'Koncept', 'Nie.', 'draft', null);
  assert jsonb_array_length(public.shop_content('drogeria-kostolne') -> 'slides') = 3;
  assert public.shop_content('drogeria-kostolne') #>> '{slides,0,post,slug}' = 'clanok-4';
  assert public.shop_content('drogeria-kostolne') #>> '{slides,2,post,slug}' = 'clanok-2';
  assert (public.shop_content('drogeria-kostolne') #>> '{slides,0,auto}')::boolean;
  assert (public.shop_content('drogeria-kostolne') ->> 'has_posts')::boolean;
end $$;

-- owner B: files in the library (a PDF needs a title; a picture may go without one), each into a free slot
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_pdf uuid;
  v_pic uuid;
  v_i integer;
begin
  begin
    perform public.owner_save_item(v_b, null, 'pdf', '  ', 'leták.pdf', false, 'slider', null, null, null);
    raise exception 'a PDF without a title';
  exception when raise_exception then assert sqlerrm = 'title', sqlerrm;
  end;
  foreach v_i in array array[1, 2, 3] loop
    begin
      if v_i = 1 then perform public.owner_save_item(v_b, null, 'video', 'x', null, false, 'slider', null, null, null); end if;
      if v_i = 2 then perform public.owner_save_item(v_b, null, 'pdf', 'x', null, false, 'wide', null, null, null); end if;
      if v_i = 3 then perform public.owner_save_item(v_b, null, 'pdf', 'x', null, false, 'slider', current_date, current_date - 1, null); end if;
      raise exception 'bad file accepted (%)', v_i;
    exception when raise_exception then assert sqlerrm in ('bad', 'dates'), sqlerrm;
    end;
  end loop;
  begin
    perform public.owner_save_item(v_a, null, 'pdf', 'Cudzí', null, false, 'slider', null, null, null);
    raise exception 'owner B added a file to shop A';
  exception when insufficient_privilege then null;
  end;
  v_pdf := public.owner_save_item(v_b, null, 'pdf', '<b>Novinky</b> október', 'novinky-oktober.pdf', true, 'stacked', null, null, null);
  assert (select title = 'Novinky október' and kind = 'pdf' and published and version = 0 from public.shop_page_sections where id = v_pdf);
  v_pic := public.owner_save_item(v_b, null, 'picture', '', 'leto-akcia.JPG', false, 'slider', null, null, null);
  assert (select title = 'leto-akcia' and not show_title and kind = 'picture' from public.shop_page_sections where id = v_pic),
    'a picture without a title keeps its file name as its name (not shown)';
  -- the slider is arranged now: the three automatic posts it showed, then the new files
  assert (select string_agg(kind, ',' order by position) from public.shop_content_slots where shop_id = v_b)
         = 'auto_post,auto_post,auto_post,pdf,picture', (select string_agg(kind, ',' order by position) from public.shop_content_slots where shop_id = v_b);
  -- the owner reads the settings and slots, never another shop's
  assert (select count(*) from public.shop_content_slots) = 5, 'owner B reads only B''s slots';
  assert (public.owner_content(v_b) -> 'limits' ->> 'max_slides')::integer = 5;
  assert jsonb_array_length(public.owner_content(v_b) -> 'items') = 2;
  assert jsonb_array_length(public.owner_content(v_b) -> 'posts') = 4, 'every visible post can be pinned';
  begin
    perform public.owner_content(v_a);
    raise exception 'owner B read shop A''s editor';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.shop_content_slots (shop_id, position, kind) values (v_b, 9, 'auto_post');
    raise exception 'a slot written directly';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

-- the function's steps: the PDF (3 pages) and the picture (1 picture + its original) go live
set role service_role;
do $$
declare
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_pdf uuid := (select id from public.shop_page_sections where shop_id = v_b and kind = 'pdf');
  v_pic uuid := (select id from public.shop_page_sections where shop_id = v_b and kind = 'picture');
  v_r record;
  v_path text;
begin
  -- nothing uploaded yet: not shown
  assert not public.section_visible(v_pdf) and not public.section_visible(v_pic);
  select * into v_r from public.sections_begin_upload(v_pdf, 3, 250000);
  for i in 1..3 loop
    perform public.sections_page_stored(v_pdf, v_r.version, i, 800, 'webp', 60000, 800, 1131);
    perform public.sections_page_stored(v_pdf, v_r.version, i, 1600, 'webp', 200000, 1600, 2263);
  end loop;
  perform public.sections_save_text(v_pdf, v_r.version, '[{"page":1,"text":"Novinky október"},{"page":2,"text":"Akcie"},{"page":3,"text":"Kontakt"}]', 'sk');
  perform public.sections_finish(v_pdf, v_r.version);
  -- a picture takes exactly one picture
  begin
    perform public.sections_begin_upload(v_pic, 2, 1000, 'pictures');
    raise exception 'two pictures for one picture';
  exception when raise_exception then assert sqlerrm = 'bad', sqlerrm;
  end;
  begin
    perform public.sections_begin_upload(v_pic, 1, 1000, 'pdf');
    raise exception 'a PDF for a picture';
  exception when raise_exception then assert sqlerrm = 'bad', sqlerrm;
  end;
  select * into v_r from public.sections_begin_upload(v_pic, 1, 900000, 'pictures');
  assert v_r.pdf_path is null;
  perform public.sections_page_stored(v_pic, v_r.version, 1, 800, 'webp', 50000, 800, 1000);
  perform public.sections_page_stored(v_pic, v_r.version, 1, 1600, 'webp', 150000, 1600, 2000);
  perform public.sections_save_text(v_pic, v_r.version, '[{"page":1,"text":""}]', null);
  begin
    perform public.sections_finish(v_pic, v_r.version);
    raise exception 'a picture went live without its original';
  exception when raise_exception then assert sqlerrm = 'incomplete', sqlerrm;
  end;
  begin
    perform public.sections_original_stored(v_pic, v_r.version, 'gif', 1000);
    raise exception 'a GIF original';
  exception when raise_exception then assert sqlerrm = 'limits', sqlerrm;
  end;
  begin
    perform public.sections_original_stored(v_pic, v_r.version, 'webp', 11 * 1048576);
    raise exception 'an original over the plan''s MB';
  exception when raise_exception then assert sqlerrm = 'limits', sqlerrm;
  end;
  begin
    perform public.sections_original_stored(v_pdf, (select version from public.shop_page_sections where id = v_pdf), 'webp', 1000);
    raise exception 'an original for a PDF';
  exception when raise_exception then assert sqlerrm = 'version', sqlerrm;
  end;
  v_path := public.sections_original_stored(v_pic, v_r.version, 'webp', 400000);
  assert v_path = format('%s/%s/v%s/original.webp', v_b, v_pic, v_r.version);
  perform public.sections_finish(v_pic, v_r.version);
  assert (select original_path = v_path and upload_original_path is null from public.shop_page_sections where id = v_pic);
  -- shown now (in a shown slot), but on the page only once their pictures are public
  assert public.section_visible(v_pdf) and public.section_visible(v_pic);
  assert jsonb_array_length(public.shop_content('drogeria-kostolne') -> 'slides') = 3;
  assert (select count(*) from public.sections_to_sync(null, v_b) where visible) = 2;
  perform public.sections_mark_public(v_pdf, (select version from public.shop_page_sections where id = v_pdf));
  perform public.sections_mark_public(v_pic, (select version from public.shop_page_sections where id = v_pic));
  assert jsonb_array_length(public.shop_content('drogeria-kostolne') -> 'slides') = 5;
  assert public.shop_content('drogeria-kostolne') #>> '{slides,3,kind}' = 'pdf';
  assert public.shop_content('drogeria-kostolne') #>> '{slides,3,item,title}' = 'Novinky október';
  assert jsonb_array_length(public.shop_content('drogeria-kostolne') #> '{slides,3,item,pages}') = 3;
  assert public.shop_content('drogeria-kostolne') #>> '{slides,3,item,page_layout}' = 'stacked';
  assert (public.shop_content('drogeria-kostolne') #>> '{slides,3,item,download}')::boolean, 'the PDF may be downloaded';
  assert public.shop_content('drogeria-kostolne') #>> '{slides,4,kind}' = 'picture';
  assert not (public.shop_content('drogeria-kostolne') #>> '{slides,4,item,show_title}')::boolean;
  assert not (public.shop_content('drogeria-kostolne') #>> '{slides,4,item,download}')::boolean;
  -- the download: the cleaned PDF; the picture's original only once its owner allows it
  assert (select path from public.shop_section_pdf('drogeria-kostolne', v_pdf)) like '%/section.pdf';
  assert not exists (select 1 from public.shop_section_pdf('drogeria-kostolne', v_pic));
  -- the AI reads the picture: its text and a short alt text (the owner's alt text wins)
  assert exists (select 1 from public.sections_claim_ai(v_pic, 3) c where c.kind = 'picture' and c.wants_alt);
  perform public.sections_save_ai_text((select id from public.shop_section_pages where section_id = v_pic), 'LETO -20 %', null,
                                       'Plagát letnej akcie: zľava 20 %');
  assert public.shop_content('drogeria-kostolne') #>> '{slides,4,item,alt}' = 'Plagát letnej akcie: zľava 20 %';
  assert public.shop_content('drogeria-kostolne') #>> '{slides,4,item,pages,0,text}' = 'LETO -20 %';
end $$;
reset role;

-- owner B arranges the slider: checks, a pinned post never repeated, hidden / expired / deleted drop out
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_pdf uuid := (select id from public.shop_page_sections where shop_id = v_b and kind = 'pdf');
  v_pic uuid := (select id from public.shop_page_sections where shop_id = v_b and kind = 'picture');
  v_p2 uuid := (select id from public.blog_posts where slug = 'clanok-2' and shop_id = v_b);
  v_draft uuid := (select id from public.blog_posts where slug = 'koncept' and shop_id = v_b);
  v_pdf2 uuid;
  v_i integer;
begin
  perform public.owner_save_item(v_b, v_pic, null, 'Letná akcia', null, true, 'slider', null, null, ' Plagát: <i>leto</i> ');
  assert (select show_title and title = 'Letná akcia' and alt = 'Plagát: leto' from public.shop_page_sections where id = v_pic);
  v_pdf2 := public.owner_save_item(v_b, null, 'pdf', 'Leták 2', 'letak-2.pdf', false, 'slider', null, null, null, false);
  assert not exists (select 1 from public.shop_content_slots where item_id = v_pdf2), 'p_add_slot false: only in the library';
  foreach v_i in array array[1, 2, 3, 4, 5, 6, 7, 8] loop
    begin
      if v_i = 1 then -- 6 slides on a free shop
        perform public.owner_save_content(v_b, null, true, 'open', '[{"kind":"auto_post"},{"kind":"auto_post"},{"kind":"auto_post"},{"kind":"auto_post"},{"kind":"auto_post"},{"kind":"auto_post"}]');
      elsif v_i = 2 then -- two PDFs on a free shop
        perform public.owner_save_content(v_b, null, true, 'open', jsonb_build_array(
          jsonb_build_object('kind', 'pdf', 'item_id', v_pdf), jsonb_build_object('kind', 'pdf', 'item_id', v_pdf2)));
      elsif v_i = 3 then -- one file twice
        perform public.owner_save_content(v_b, null, true, 'open', jsonb_build_array(
          jsonb_build_object('kind', 'picture', 'item_id', v_pic), jsonb_build_object('kind', 'picture', 'item_id', v_pic)));
      elsif v_i = 4 then -- a picture in a PDF slot
        perform public.owner_save_content(v_b, null, true, 'open', jsonb_build_array(jsonb_build_object('kind', 'pdf', 'item_id', v_pic)));
      elsif v_i = 5 then -- a file that is not this shop's (owner B cannot even see another shop's ids)
        perform public.owner_save_content(v_b, null, true, 'open', jsonb_build_array(jsonb_build_object('kind', 'pdf', 'item_id', gen_random_uuid())));
      elsif v_i = 6 then -- a draft pinned
        perform public.owner_save_content(v_b, null, true, 'open', jsonb_build_array(jsonb_build_object('kind', 'pinned_post', 'post_id', v_draft)));
      elsif v_i = 7 then
        perform public.owner_save_content(v_b, null, true, 'wide', '[]');
      else
        perform public.owner_save_content(v_b, null, true, 'open', '[{"kind":"video"}]');
      end if;
      raise exception 'bad slider accepted (%)', v_i;
    exception when raise_exception then
      assert sqlerrm in ('limit', 'pdf_limit', 'duplicate', 'item', 'post', 'bad'), sqlerrm;
      assert (v_i = 1) = (sqlerrm = 'limit') and (v_i = 2) = (sqlerrm = 'pdf_limit') and (v_i = 3) = (sqlerrm = 'duplicate'), v_i || ' ' || sqlerrm;
    end;
  end loop;
  -- pinned "Článok 2" first, two automatic posts, the PDF, the picture; own title, collapsed, title shown
  assert public.owner_save_content(v_b, ' <b>Akcie</b> týždňa ', false, 'collapsed', jsonb_build_array(
    jsonb_build_object('kind', 'pinned_post', 'post_id', v_p2), jsonb_build_object('kind', 'auto_post'),
    jsonb_build_object('kind', 'auto_post'), jsonb_build_object('kind', 'pdf', 'item_id', v_pdf),
    jsonb_build_object('kind', 'picture', 'item_id', v_pic))) = 5;
  assert (select title = 'Akcie týždňa' and not show_title and display = 'collapsed' from public.shop_page_content where shop_id = v_b);
  begin
    perform public.owner_save_content(v_a, null, true, 'open', '[]');
    raise exception 'owner B arranged shop A''s slider';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;
do $$
declare
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_pdf uuid := (select id from public.shop_page_sections where shop_id = v_b and kind = 'pdf' and title = 'Novinky október');
  v_pic uuid := (select id from public.shop_page_sections where shop_id = v_b and kind = 'picture');
  v_c jsonb := public.shop_content('drogeria-kostolne');
  v_order text;
begin
  select string_agg(coalesce(e ->> 'kind', '') || ':' || coalesce(e #>> '{post,slug}', e #>> '{item,title}'), ',' order by n)
  into v_order from jsonb_array_elements(v_c -> 'slides') with ordinality as x(e, n);
  assert v_order = 'post:clanok-2,post:clanok-4,post:clanok-3,pdf:Novinky október,picture:Letná akcia', v_order;
  assert not (v_c #>> '{slides,0,auto}')::boolean and (v_c #>> '{slides,1,auto}')::boolean, 'the pinned post is never repeated';
  assert v_c ->> 'title' = 'Akcie týždňa' and v_c ->> 'display' = 'collapsed' and not (v_c ->> 'show_title')::boolean;
  assert v_c #>> '{slides,4,item,alt}' = 'Plagát: leto', 'the owner''s alt text wins over the AI''s';
  assert v_c #>> '{slides,4,crop}' = 'center' and v_c #>> '{slides,3,crop}' = 'center', 'file slides carry their Výrez (update 44)';
  assert v_c ->> 'ratio' = '4:5', 'the default frame (update 44)';
  assert (v_c #>> '{slides,4,item,download}')::boolean;
  assert (select path from public.shop_section_pdf('drogeria-kostolne', v_pic)) like '%/original.webp';
  -- a hidden file drops out, the rest keep their order
  update public.shop_page_sections set hidden = true where id = v_pdf;
  assert not public.section_visible(v_pdf);
  select string_agg(e ->> 'kind', ',' order by n) into v_order
  from jsonb_array_elements(public.shop_content('drogeria-kostolne') -> 'slides') with ordinality as x(e, n);
  assert v_order = 'post,post,post,picture', v_order;
  update public.shop_page_sections set hidden = false where id = v_pdf;
  -- an expired one too (the shop's day)
  update public.shop_page_sections set visible_until = public.shop_today(v_b) - 1 where id = v_pic;
  assert not public.section_visible(v_pic);
  assert jsonb_array_length(public.shop_content('drogeria-kostolne') -> 'slides') = 4;
  update public.shop_page_sections set visible_until = null where id = v_pic;
  -- a newer post: the automatic slots take it, the pinned one stays
  insert into public.blog_posts (shop_id, slug, title, body, status, publish_at)
  values (v_b, 'clanok-5', 'Článok 5', 'Piaty.', 'published', now() - interval '1 hour');
  assert public.shop_content('drogeria-kostolne') #>> '{slides,1,post,slug}' = 'clanok-5';
  assert public.shop_content('drogeria-kostolne') #>> '{slides,2,post,slug}' = 'clanok-4';
  -- the pinned post deleted: its slot shows nothing, the automatic ones go on (and may show it no more)
  delete from public.blog_posts where slug = 'clanok-2' and shop_id = v_b;
  select string_agg(e #>> '{post,slug}', ',' order by n) into v_order
  from jsonb_array_elements(public.shop_content('drogeria-kostolne') -> 'slides') with ordinality as x(e, n) where e ->> 'kind' = 'post';
  assert v_order = 'clanok-5,clanok-4', v_order;
  assert exists (select 1 from public.shop_content_slots where shop_id = v_b and kind = 'pinned_post' and post_id is null), 'the slot stays, empty';
  -- a deleted file: its slot stays empty, nothing shown for it
  delete from public.shop_page_sections where id = v_pic;
  assert exists (select 1 from public.shop_content_slots where shop_id = v_b and kind = 'picture' and item_id is null);
  assert not exists (select 1 from jsonb_array_elements(public.shop_content('drogeria-kostolne') -> 'slides') e where e ->> 'kind' = 'picture');
end $$;

-- a post imported from Facebook fills the first automatic slot at once
set role service_role;
do $$
declare
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
begin
  perform public.blog_import_post(v_b, '1234567890_42', 'Z Facebooku', 'Nový tovar z Facebooku.', now() - interval '5 minutes',
                                  now() - interval '5 minutes', 'https://www.facebook.com/1234567890/posts/42', '[]', '[]');
  assert public.shop_content('drogeria-kostolne') #>> '{slides,0,post,source}' = 'facebook',
    coalesce(public.shop_content('drogeria-kostolne') #>> '{slides,0,post,slug}', 'null');
end $$;
reset role;

-- Pro → free: every setting stays; only the first slides within the free limit (5, one PDF) are shown
do $$
declare
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_pdf uuid := (select id from public.shop_page_sections where shop_id = v_b and title = 'Novinky október');
  v_pdf2 uuid := (select id from public.shop_page_sections where shop_id = v_b and title = 'Leták 2');
  v_slots jsonb;
begin
  perform public.apply_stripe_subscription(v_b, 'cus_B1', 'sub_B1', 'active', 'pro', now() + interval '30 days', null);
  update public.shop_page_sections set version = 1, pages = 1, source = 'pdf', pdf_path = format('%s/%s/v1/section.pdf', v_b, v_pdf2),
         public_version = 1 where id = v_pdf2;
  insert into public.shop_section_pages (section_id, shop_id, version, page, width, height, ext, small_bytes, large_bytes, text, text_done)
  values (v_pdf2, v_b, 1, 1, 1600, 2263, 'webp', 1, 1, 'Leták', true);
  v_slots := jsonb_build_array(
    jsonb_build_object('kind', 'pdf', 'item_id', v_pdf), jsonb_build_object('kind', 'pdf', 'item_id', v_pdf2),
    jsonb_build_object('kind', 'auto_post'), jsonb_build_object('kind', 'auto_post'), jsonb_build_object('kind', 'auto_post'),
    jsonb_build_object('kind', 'auto_post'), jsonb_build_object('kind', 'auto_post'));
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);
  set local role authenticated;
  assert public.owner_save_content(v_b, null, true, 'open', v_slots) = 7, 'Pro: 7 slides, two PDFs';
  reset role;
  assert (select count(*) from public.content_slots_shown(v_b)) = 7;
  perform public.apply_stripe_subscription(v_b, 'cus_B1', 'sub_B1', 'canceled', 'pro', now() - interval '1 day', null);
  assert (select count(*) from public.shop_content_slots where shop_id = v_b) = 7, 'the settings stay';
  assert (select string_agg(kind, ',' order by n) from public.content_slots_shown(v_b)) = 'pdf,auto_post,auto_post,auto_post,auto_post',
    (select string_agg(kind, ',' order by n) from public.content_slots_shown(v_b));
  assert public.section_visible(v_pdf) and not public.section_visible(v_pdf2), 'the second PDF is over the free limit';
  -- the owner may keep what was stored, never add
  set local role authenticated;
  assert public.owner_save_content(v_b, null, true, 'open', v_slots) = 7;
  begin
    perform public.owner_save_content(v_b, null, true, 'open', v_slots || '[{"kind":"auto_post"}]'::jsonb);
    raise exception 'a free shop added a slide';
  exception when raise_exception then assert sqlerrm = 'limit', sqlerrm;
  end;
  reset role;
end $$;

-- shop A, never arranged: shows its sections as before (rule of update 31), then three automatic posts; stored once
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_before text;
  v_n integer;
begin
  assert not exists (select 1 from public.shop_page_content where shop_id = v_a);
  select string_agg(coalesce(item_id::text, kind), ',' order by position) into v_before from public.content_slots(v_a);
  assert v_before like '%auto_post,auto_post,auto_post', v_before;
  assert (select count(*) from public.content_slots(v_a) c where c.item_id is not null and not public.section_visible_legacy(c.item_id)) = 0;
  assert public.content_materialize(v_a);
  assert not public.content_materialize(v_a), 'only once';
  select count(*) into v_n from public.shop_page_sections where shop_id = v_a and published and not hidden and version > 0;
  assert (select count(*) from public.shop_content_slots where shop_id = v_a and item_id is not null) = least(v_n, 10);
  assert (select count(*) from public.shop_content_slots where shop_id = v_a and kind = 'auto_post') = least(3, 10 - least(v_n, 10));
  assert (select min(position) from public.shop_content_slots where shop_id = v_a and kind = 'auto_post')
         > coalesce((select max(position) from public.shop_content_slots where shop_id = v_a and item_id is not null), -1),
    'the sections first, in their old order';
end $$;

-- the admin's limits
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
begin
  begin
    perform public.admin_save_content_limits('free', 3, 1, 5);
    raise exception 'an owner changed the limits';
  exception when insufficient_privilege then null;
  end;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000ad';
do $$
begin
  begin
    perform public.admin_save_content_limits('free', 11, 1, 5);
    raise exception 'eleven slides';
  exception when raise_exception then assert sqlerrm = 'limits', sqlerrm;
  end;
  perform public.admin_save_content_limits('free', 4, 0, 8);
  assert (select max_slides = 4 and max_pdf_slides = 0 and max_items = 8 from public.section_limits where plan = 'free');
  perform public.admin_save_content_limits('free', 5, 1, 10);
end $$;
reset role;
reset request.jwt.claim.sub;

-- the files a free shop may keep in its library (max_items)
do $$
declare
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
begin
  update public.section_limits set max_items = (select count(*) from public.shop_page_sections where shop_id = v_b) where plan = 'free';
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);
  set local role authenticated;
  begin
    perform public.owner_save_item(v_b, null, 'picture', 'Ďalší', null, false, 'slider', null, null, null);
    raise exception 'a file over the plan''s number';
  exception when raise_exception then assert sqlerrm = 'limit', sqlerrm;
  end;
  reset role;
  update public.section_limits set max_items = 10 where plan = 'free';
end $$;

-- back as it was: shop B without the slider, its posts and files
do $$
declare
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
begin
  delete from public.shop_content_slots where shop_id = v_b;
  delete from public.shop_page_content where shop_id = v_b;
  delete from public.shop_page_sections where shop_id = v_b;
  delete from public.blog_posts where shop_id = v_b;
end $$;

\echo '--- videos in the blog and the slider: Facebook videos, YouTube shares, "Tlačidlo ▶ pri videách otvorí" (update 39)'
do $$
begin
  assert public.youtube_id('https://www.youtube.com/watch?v=dQw4w9WgXcQ') = 'dQw4w9WgXcQ';
  assert public.youtube_id('https://youtube.com/watch?feature=share&v=dQw4w9WgXcQ&t=10') = 'dQw4w9WgXcQ';
  assert public.youtube_id('https://m.youtube.com/watch?v=dQw4w9WgXcQ') = 'dQw4w9WgXcQ';
  assert public.youtube_id('https://youtu.be/dQw4w9WgXcQ?si=abc') = 'dQw4w9WgXcQ';
  assert public.youtube_id('https://www.youtube.com/shorts/dQw4w9WgXcQ') = 'dQw4w9WgXcQ';
  assert public.youtube_id('https://www.youtube.com/live/dQw4w9WgXcQ') = 'dQw4w9WgXcQ';
  assert public.youtube_id('https://www.youtube.com/channel/UCxyz') is null;
  assert public.youtube_id('https://www.youtube.com/watch?v=short') is null;
  assert public.youtube_id('https://evil.example/watch?v=dQw4w9WgXcQ') is null;
  assert public.youtube_id('https://notyoutube.com/watch?v=dQw4w9WgXcQ') is null;
  assert public.youtube_id(null) is null;
end $$;

do $$
declare
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_fb uuid;
  v_yt uuid;
  v_own uuid;
  v_n integer;
  v jsonb;
begin
  -- a Facebook video, a YouTube share imported before update 39 (only a link card) and a post without a video
  insert into public.blog_posts (shop_id, slug, title, body, source, status, publish_at, fb_post_id, fb_permalink, links)
  values (v_b, 'video-fb', 'Video z predajne', 'Pozrite si video.', 'facebook', 'published', now() - interval '3 hours',
          '111_901', 'https://www.facebook.com/111/posts/901', '[]'::jsonb)
  returning id into v_fb;
  perform public.blog_photo_add(v_fb, 'pending', 'video', '901', 'https://scontent.fbcdn.net/v/901.jpg',
                                'https://www.facebook.com/111/videos/901');
  insert into public.blog_posts (shop_id, slug, title, body, source, status, publish_at, fb_post_id, fb_permalink, links)
  values (v_b, 'video-yt', 'Recept na koláč', '', 'facebook', 'published', now() - interval '2 hours',
          '111_902', 'https://www.facebook.com/111/posts/902',
          '[{"kind": "link", "url": "https://youtu.be/dQw4w9WgXcQ", "title": "Recept na koláč", "description": null}]'::jsonb)
  returning id into v_yt;
  insert into public.blog_posts (shop_id, slug, title, body, status, publish_at)
  values (v_b, 'bez-videa', 'Bez videa', 'Text.', 'published', now() - interval '1 hour')
  returning id into v_own;

  -- the YouTube link counts as a video before its picture exists
  assert public.blog_post_video(v_yt) ->> 'kind' = 'youtube';
  assert public.blog_post_video(v_yt) ->> 'youtube_id' = 'dQw4w9WgXcQ';
  assert public.blog_post_video(v_yt) ->> 'facebook_url' = 'https://www.facebook.com/111/posts/902';
  assert public.blog_post_video(v_fb) ->> 'kind' = 'facebook';
  assert public.blog_post_video(v_fb) ->> 'link' = 'https://www.facebook.com/111/videos/901';
  assert public.blog_post_video(v_fb) ->> 'youtube_id' is null;
  assert public.blog_post_video(v_own) is null, 'no video';

  -- the backfill: one YouTube picture row for the share, none for the others; again = nothing new
  v_n := public.blog_youtube_backfill();
  assert v_n = 1, v_n::text;
  assert (select count(*) from public.blog_photos where post_id = v_yt and kind = 'video' and status = 'pending'
          and source_url = 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
          and link_url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ') = 1;
  assert public.blog_youtube_backfill() = 0, 'never twice';
  assert public.blog_post_video(v_yt) ->> 'link' = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

  -- the slider carries the video and the owner's choice (default: the article on Cacaduu)
  v := public.shop_content('drogeria-kostolne');
  assert v ->> 'video_target' = 'post';
  assert v #>> '{slides,0,post,slug}' = 'bez-videa' and v #> '{slides,0,post,video}' = 'null'::jsonb;
  assert v #>> '{slides,1,post,video,kind}' = 'youtube';
  assert v #>> '{slides,2,post,video,kind}' = 'facebook';
  assert v #>> '{slides,2,post,video,facebook_url}' = 'https://www.facebook.com/111/posts/901';
end $$;

-- the owner's setting: only through owner_save_content; null keeps it; anything else is refused
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_slots jsonb := '[{"kind": "auto_post"}, {"kind": "auto_post"}, {"kind": "auto_post"}]';
begin
  begin
    update public.shop_page_content set video_target = 'facebook' where shop_id = v_b;
    raise exception 'an owner wrote the setting directly';
  exception when insufficient_privilege then null;
  end;
  perform public.owner_save_content(v_b, null, true, 'open', v_slots, 'facebook');
  assert public.owner_content(v_b) ->> 'video_target' = 'facebook';
  assert public.shop_content('drogeria-kostolne') ->> 'video_target' = 'facebook';
  perform public.owner_save_content(v_b, 'Novinky', true, 'open', v_slots);
  assert public.owner_content(v_b) ->> 'video_target' = 'facebook', 'kept when not sent';
  assert public.owner_content(v_b) #>> '{posts,1,video,kind}' = 'youtube', 'the editor sees the videos too';
  begin
    perform public.owner_save_content(v_b, null, true, 'open', v_slots, 'app');
    raise exception 'a wrong target saved';
  exception when raise_exception then assert sqlerrm = 'bad', sqlerrm;
  end;
  perform public.owner_save_content(v_b, null, true, 'open', v_slots, 'post');
  assert public.owner_content(v_b) ->> 'video_target' = 'post';
  begin
    perform public.owner_save_content((select id from public.shops where slug = 'potraviny-centrum'), null, true, 'open', v_slots, 'facebook');
    raise exception 'another shop''s setting saved';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;
set role anon;
do $$
begin
  begin
    perform public.blog_post_video((select id from public.blog_posts where slug = 'video-yt'));
    raise exception 'a visitor called blog_post_video directly';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.blog_youtube_backfill();
    raise exception 'a visitor ran the backfill';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
do $$
declare
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
begin
  delete from public.shop_content_slots where shop_id = v_b;
  delete from public.shop_page_content where shop_id = v_b;
  delete from public.blog_posts where shop_id = v_b;
end $$;

\echo '--- translations: languages, interface texts, shop content, descriptions, shop languages, two-language files (update 40)'
set role anon;
do $$
declare
  v_n integer;
begin
  -- every language listed; Slovak always on; Russian and the regional ones off; only sk/hu/en pre-translated
  select count(*) into v_n from public.site_languages();
  assert v_n = 42, 'all languages listed: ' || v_n;
  assert (select enabled and indexed from public.site_languages() where code = 'sk');
  assert not (select enabled from public.site_languages() where code = 'ru'), 'Russian off by default';
  assert (select enabled from public.site_languages() where code = 'zh-hans') and not (select enabled from public.site_languages() where code = 'zh-hant');
  assert (select count(*) from public.site_languages() where indexed) = 3;
  assert public.ui_messages('de') = '{}'::jsonb;
  begin
    perform 1 from public.languages;
    raise exception 'a visitor read the languages table';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.content_translations;
    raise exception 'a visitor read content_translations';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.admin_save_language('ru', true, false);
    raise exception 'a visitor switched a language on';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.apply_translations('[]');
    raise exception 'a visitor wrote translations';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.translation_work(1);
    raise exception 'a visitor read the work list';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.apply_ui_translations('de', '[]');
    raise exception 'a visitor wrote interface texts';
  exception when insufficient_privilege then null;
  end;
  -- before the owner saved languages: no row (the website uses the country), the home language = the country's
  assert not exists (select 1 from public.shop_languages('drogeria-kostolne'));
  assert (select site_lang from public.public_shops where slug = 'kisbolt-budapest') = 'hu';
  -- a visitor may ask for a language (not the shop's own, not a switched-off one), once in 10 minutes
  assert public.request_translation('drogeria-kostolne', 'de');
  assert not public.request_translation('drogeria-kostolne', 'de'), 'asked again too soon';
  assert not public.request_translation('drogeria-kostolne', 'sk'), 'its own language';
  assert not public.request_translation('drogeria-kostolne', 'ru'), 'switched off';
end $$;
reset role;

-- the admin: languages, interface texts, limits
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000ad';
do $$
begin
  perform public.admin_save_language('de', true, true);
  perform public.admin_save_language('sk', false, false);
  assert (select enabled and indexed from public.site_languages() where code = 'sk'), 'Slovak cannot be switched off';
  perform public.admin_save_language('lb', false, true);
  assert not (select indexed from public.site_languages() where code = 'lb'), 'a switched-off language is never pre-translated';
  perform public.admin_save_ui_text('de', 'shop.items_title', 'Waren im Geschäft', md5('Tovar v obchode'), true);
  assert public.ui_messages('de') ->> 'shop.items_title' = 'Waren im Geschäft';
  assert (select status || checked from public.admin_ui_translations('de') where key = 'shop.items_title') = 'manualtrue';
  begin
    perform public.admin_save_ui_text('sk', 'shop.items_title', 'x', md5('x'), true);
    raise exception 'a hand-written language was stored in the database';
  exception when check_violation then null;
  end;
  perform public.admin_save_translation_limits(2, 6);
  begin
    perform public.admin_save_translation_limits(-1, 6);
    raise exception 'a negative limit saved';
  exception when invalid_parameter_value then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

set role service_role;
do $$
declare
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_item uuid := (select id from public.shop_items where source_code = 'D900');
  v_hash text;
  v_r jsonb;
begin
  -- Claude never replaces the admin's interface text of the same Slovak source; a new Slovak text does
  assert public.apply_ui_translations('de', jsonb_build_array(
    jsonb_build_object('key', 'shop.items_title', 'text', 'Artikel', 'source_hash', md5('Tovar v obchode')),
    jsonb_build_object('key', 'shop.hours', 'text', 'Öffnungszeiten', 'source_hash', md5('Otváracie hodiny')))) = 1;
  assert public.ui_messages('de') ->> 'shop.items_title' = 'Waren im Geschäft';
  assert 'shop.hours' = any (public.ui_unchecked('de'));
  -- the budget: 80 % sends one alert a month, over the budget no more calls
  assert public.translation_budget_ok(10);
  assert not (public.translation_spend(1000, 500, 5, 10) ->> 'alert')::boolean;
  assert (public.translation_spend(1000, 500, 3.5, 10) ->> 'alert')::boolean, '80 % reached: alert';
  assert not (public.translation_spend(1, 1, 0.1, 10) ->> 'alert')::boolean, 'only once a month';
  assert public.translation_budget_ok(10) and not public.translation_budget_ok(8);
  -- the old item names became rows: D900 was the owner's correction, now handed back (ai)
  assert (select status from public.content_translations where kind = 'item_name' and ref = v_item::text and lang = 'en') = 'ai';
  -- what to translate: item names into sk/hu/en (not the item's own language) and the asked-for German
  assert exists (select 1 from public.translation_work(500, v_b) where kind = 'item_name' and ref = v_item::text and lang = 'de');
  assert not exists (select 1 from public.translation_work(500, v_b) where kind = 'item_name' and lang = 'sk'
                     and ref in (select id::text from public.shop_items where shop_id = v_b and name_lang = 'sk')), 'never into its own language';
  select source_hash into v_hash from public.translation_work(500, v_b, 'de') where kind = 'item_name' and ref = v_item::text;
  assert public.apply_translations(jsonb_build_array(jsonb_build_object('shop_id', v_b, 'kind', 'item_name', 'ref', v_item::text,
    'lang', 'de', 'text', 'Fassadenfarbe weiß 5 l', 'source_hash', v_hash))) = 1;
  assert (select name_i18n ->> 'de' from public.shop_items where id = v_item) = 'Fassadenfarbe weiß 5 l', 'name_i18n follows';
  assert not exists (select 1 from public.translation_work(500, v_b, 'de') where kind = 'item_name' and ref = v_item::text);
  -- a translation of an older original is not stored
  assert public.apply_translations(jsonb_build_array(jsonb_build_object('shop_id', v_b, 'kind', 'item_name', 'ref', v_item::text,
    'lang', 'fr', 'text', 'x', 'source_hash', md5('an older name')))) = 0;
  -- descriptions: a draft waits for the owner (automatic publishing is off by default)
  assert public.save_description_draft(v_item, 'Biela fasádna farba Primalex v balení 5 l.') = 'draft';
  assert not exists (select 1 from public.item_description_shown(v_item));
  assert (public.item_description_facts(v_item) ->> 'brand') = 'Primalex';
  -- option B: the HU file, matched by Kód then EAN; quantity and price only from the main file
  v_r := public.apply_shop_translations(v_b, 'hu', jsonb_build_array(
    jsonb_build_object('source_code', 'D900', 'name', 'Homlokzatfesték fehér 5 l (bolt)', 'quantity', 99, 'price', 24.9),
    jsonb_build_object('source_code', 'NOPE', 'name', 'Ismeretlen')));
  assert (v_r ->> 'matched')::int = 1 and (v_r ->> 'unmatched_count')::int = 1, v_r::text;
  assert jsonb_array_length(v_r -> 'conflicts') = 1 and v_r #>> '{conflicts,0,quantity}' = '99', 'a different quantity is reported';
  assert (select quantity from public.inventory where shop_item_id = v_item) = 3, '…and ignored';
  assert (select status || ':' || text from public.content_translations where ref = v_item::text and kind = 'item_name' and lang = 'hu')
         = 'shop:Homlokzatfesték fehér 5 l (bolt)';
  assert (select name_i18n ->> 'hu' from public.shop_items where id = v_item) = 'Homlokzatfesték fehér 5 l (bolt)';
  assert (select name from public.shop_items where id = v_item) = 'Farba fasadna biela 5L', 'the original is never changed';
  -- Claude never overwrites the shop's translation, not even a stale one
  assert public.apply_item_translations(v_b, jsonb_build_array(jsonb_build_object('item_id', v_item, 'source', 'Farba fasadna biela 5L',
    'lang', 'sk', 'sk', 'Farba biela', 'hu', 'Festék', 'en', 'Paint'))) = 1;
  assert (select text from public.content_translations where ref = v_item::text and kind = 'item_name' and lang = 'hu') = 'Homlokzatfesték fehér 5 l (bolt)';
  assert (select text from public.content_translations where ref = v_item::text and kind = 'item_name' and lang = 'en') = 'Paint';
  -- option A: a language per column
  assert public.apply_file_texts(v_b, jsonb_build_array(jsonb_build_object('source_code', 'D900', 'has_texts', true,
    'description', 'Fasádna farba', 'category', 'Farby', 'i18n', jsonb_build_object('de', jsonb_build_object('category', 'Farben'))))) = 1;
  assert (select category from public.shop_items where id = v_item) = 'Farby';
  assert (select status from public.content_translations where ref = v_item::text and kind = 'item_category' and lang = 'de') = 'shop';
  -- the search finds the German name and the Hungarian one from the shop's file
  assert exists (select 1 from public.search_stock('Fassadenfarbe weiß') where item_id = v_item), 'search in any language';
  assert exists (select 1 from public.search_stock('homlokzatfesték bolt') where item_id = v_item);
  -- cached search expansions
  perform public.save_query_expansion('白色油漆', array['biela farba', 'white paint', '']);
  assert public.query_expansion('白色油漆') = array['biela farba', 'white paint'];
  assert not exists (select 1 from public.translation_work(500, v_b) where kind = 'item_category' and ref = v_item::text and lang = 'de'), 'the shop gave it';
end $$;
reset role;

-- the owner: languages, descriptions, the Preklady tab
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_item uuid := (select id from public.shop_items where source_code = 'D900');
  v_before jsonb;
  v_lim integer;
begin
  v_lim := (select max_preferred from public.owner_language_settings(v_b));
  begin
    perform public.owner_save_language_settings(v_b, 'sk', array['hu'], array['de', 'el', 'uk', 'cs', 'pl', 'fr', 'it'], null, false);
    raise exception 'more preferred languages than the plan allows';
  exception when invalid_parameter_value then assert sqlerrm = 'limit', sqlerrm;
  end;
  begin
    perform public.owner_save_language_settings(v_b, 'sk', null, array['ru'], null, false);
    raise exception 'a switched-off language saved';
  exception when invalid_parameter_value then assert sqlerrm = 'langs', sqlerrm;
  end;
  perform public.owner_save_language_settings(v_b, 'sk', array['hu'], (array['de', 'el', 'uk'])[1:v_lim], 'de', false);
  assert (select inventory_langs from public.owner_language_settings(v_b)) = array['sk', 'hu'], 'the main language first';
  assert (select domain_lang from public.shop_languages('drogeria-kostolne')) = 'de';
  assert (select site_lang from public.public_shops where slug = 'drogeria-kostolne') = 'de', 'the own domain''s "/"';
  begin
    perform public.owner_save_language_settings(v_a, 'sk', null, null, null, false);
    raise exception 'owner B saved shop A''s languages';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.content_translations (shop_id, kind, ref, lang, text, status) values (v_b, 'item_name', v_item::text, 'it', 'x', 'manual');
    raise exception 'an owner wrote a translation directly';
  exception when insufficient_privilege then null;
  end;
  -- the draft: edited, "Uložiť a zverejniť"; the shop's own description would win, the owner can choose Cacaduu's
  assert (select draft from public.item_descriptions where item_id = v_item) like 'Biela fasádna%';
  perform public.owner_save_description(v_item, 'Biela fasádna farba Primalex, 5 l.', true);
  assert (select text || '/' || source from public.item_description_shown(v_item)) = 'Fasádna farba/shop', 'the shop''s own wins';
  perform public.owner_set_description_choice(v_item, 'cacaduu');
  assert (select text || '/' || source from public.item_description_shown(v_item)) = 'Biela fasádna farba Primalex, 5 l./cacaduu';
  -- Preklady: states of the item's cells
  assert (select state from public.owner_translations(v_b, 'hu', null, null, null, v_item::text) where kind = 'item_name') = 'shop';
  assert (select state from public.owner_translations(v_b, 'de', null, null, null, v_item::text) where kind = 'item_name') = 'ai';
  assert (select state from public.owner_translations(v_b, 'de', null, null, null, v_item::text) where kind = 'item_description') = 'missing';
  -- "Zmazať" German → translated again on the next visit; "Späť" puts it back; "Neprekladať" keeps it out
  v_before := public.owner_delete_translations(v_b, jsonb_build_array(jsonb_build_object('kind', 'item_name', 'ref', v_item::text, 'lang', 'de')), false);
  assert (select name_i18n ->> 'de' from public.shop_items where id = v_item) is null;
  assert (select state from public.owner_translations(v_b, 'de', null, null, null, v_item::text) where kind = 'item_name') = 'missing';
  perform public.owner_restore_translations(v_b, v_before);
  assert (select name_i18n ->> 'de' from public.shop_items where id = v_item) = 'Fassadenfarbe weiß 5 l', 'Späť';
  perform public.owner_delete_translations(v_b, jsonb_build_array(jsonb_build_object('kind', 'item_name', 'ref', v_item::text, 'lang', 'de')), true);
  assert (select state from public.owner_translations(v_b, 'de', null, null, null, v_item::text) where kind = 'item_name') = 'none';
  -- "Upraviť": the owner's own text; Claude's suggestion never replaces it
  perform public.owner_save_translation(v_b, 'item_name', v_item::text, 'de', 'Weiße Fassadenfarbe 5 l');
  perform public.owner_accept_translation(v_b, 'item_name', v_item::text, 'de', 'KI-Text');
  assert (select text || '/' || status from public.content_translations where ref = v_item::text and kind = 'item_name' and lang = 'de') = 'Weiße Fassadenfarbe 5 l/manual';
  begin
    perform public.owner_save_translation(v_a, 'item_name', (select id::text from public.shop_items where source_code = 'P001'), 'de', 'x');
    raise exception 'owner B translated shop A''s item';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.owner_translations(v_a);
    raise exception 'owner B read shop A''s translations';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.save_description_draft(v_item, 'x');
    raise exception 'an owner stored a draft as the AI';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

-- visitors read only shown translations, never a stale one
set role anon;
do $$
declare
  v_item uuid := (select id from public.shop_items where source_code = 'D900');
begin
  assert (select text from public.shop_translations('drogeria-kostolne', 'de', array['item_name'], array[v_item::text])) = 'Weiße Fassadenfarbe 5 l';
  assert (select text from public.shop_translations('drogeria-kostolne', 'de', array['item_description'])) is null, 'no German description yet';
  assert (select description_source from public.item_texts(v_item)) = 'cacaduu';
  assert not exists (select 1 from public.shop_translations('drogeria-kostolne', 'ru')), 'a switched-off language';
end $$;
reset role;
set role service_role;
do $$
declare
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_item uuid := (select id from public.shop_items where source_code = 'D900');
begin
  -- an approved description is translated like the rest; a changed original makes the AI text "zastaraný"
  assert exists (select 1 from public.translation_work(500, v_b, 'de') where kind = 'item_description' and ref = v_item::text);
  perform public.apply_translations(jsonb_build_array(jsonb_build_object('shop_id', v_b, 'kind', 'item_description', 'ref', v_item::text,
    'lang', 'de', 'text', 'Weiße Fassadenfarbe Primalex, 5 l.', 'source_hash', md5('Biela fasádna farba Primalex, 5 l.'))));
  update public.item_descriptions set text = 'Biela fasádna farba Primalex, balenie 5 l.' where item_id = v_item;
  assert exists (select 1 from public.translation_work(500, v_b, 'de') where kind = 'item_description' and ref = v_item::text), 'stale: made again';
end $$;
reset role;
set role anon;
do $$ begin
  assert not exists (select 1 from public.shop_translations('drogeria-kostolne', 'de', array['item_description'])), 'a stale text is not shown';
end $$;
reset role;
do $$
declare
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
begin
  delete from public.content_translations where shop_id = v_b and lang not in ('sk', 'hu', 'en');
  delete from public.item_descriptions where shop_id = v_b;
  delete from public.shop_language_settings where shop_id = v_b;
  delete from public.translation_requests;
  update public.languages set indexed = false where code = 'de';
end $$;

\echo '--- Môj obchod → Tovar: filters, what the shopper sees, what is missing (update 41)'
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_p1 uuid := (select id from public.shop_items where source_code = 'P001');
  v_p2 uuid := (select id from public.shop_items where source_code = 'P002');
  v_z uuid := (select id from public.shops where slug = 'zeleziarstvo-vychod');
begin
  -- test setup: a visitor asked for German (so descriptions are translated too); P001 gets an approved description;
  -- P002's name is translated into every language the shop needs
  delete from public.translation_requests where shop_id = v_a;
  insert into public.translation_requests (shop_id, lang) values (v_a, 'de');
  delete from public.content_translations where shop_id = v_a and kind like 'item_%';
  delete from public.item_descriptions where item_id in (select id from public.shop_items where shop_id = v_a);
  update public.shop_items set name_lang = 'sk' where shop_id = v_a;
  insert into public.item_descriptions (item_id, shop_id, text, published_at, show)
  values (v_p1, v_a, 'Zrnková káva Lavazza, 1 kg.', now(), 'auto');
  insert into public.content_translations (shop_id, kind, ref, lang, text, status, source_hash)
  select v_a, 'item_name', v_p2::text, l, 'Kaffee ' || l, 'ai', md5('Káva mletá 250 g')
  from unnest(public.shop_target_langs(v_a, 'item_name')) l where l <> 'sk';
  assert cardinality(public.shop_target_langs(v_a, 'item_name')) > 0, 'the shop has languages to translate into';
  -- for the stale shop's check: owner A is also a member of zeleziarstvo-vychod for a moment
  insert into public.shop_members (shop_id, user_id) values (v_z, '00000000-0000-0000-0000-00000000000a');
  perform set_config('ppi.t_z_time', coalesce((select latest_file_time::text from public.sync_sources where shop_id = v_z), ''), false);
  update public.sync_sources set latest_file_time = now() - interval '25 hours' where shop_id = v_z;
  -- what the counts must be, straight from the tables (earlier checks added items to this shop)
  perform set_config('ppi.t_all', (select count(*) from public.shop_items where shop_id = v_a)::text, false);
  perform set_config('ppi.t_in', (select count(*) from public.shop_items si join public.inventory i on i.shop_item_id = si.id
    where si.shop_id = v_a and i.quantity > 0)::text, false);
  perform set_config('ppi.t_desc', (select count(*) from public.shop_items si
    where si.shop_id = v_a and exists (select 1 from public.item_description_shown(si.id)))::text, false);
  perform set_config('ppi.t_z_in', (select count(*) from public.shop_items si join public.inventory i on i.shop_item_id = si.id
    where si.shop_id = v_z and i.quantity > 0)::text, false);
  perform set_config('ppi.t_z_all', (select count(*) from public.shop_items where shop_id = v_z)::text, false);
end $$;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_z uuid := (select id from public.shops where slug = 'zeleziarstvo-vychod');
  c record;
begin
  select * into c from public.owner_item_counts(v_a);
  assert c.all_items = current_setting('ppi.t_all')::bigint and c.in_stock = current_setting('ppi.t_in')::bigint
     and c.sold_out = c.all_items - c.in_stock, format('counts %s', c);
  assert c.in_stock > 0 and c.sold_out > 0, 'both kinds present';
  assert c.no_description = c.all_items - current_setting('ppi.t_desc')::bigint and c.no_description < c.all_items, format('no description %s', c);
  assert c.missing_translation between 1 and c.all_items - 1, format('missing %s', c);
  -- each filter lists the same items as its count; the shopper's label comes from the database
  assert (select count(*) from public.owner_items(v_a, null, 100, 0, 'in_stock')) = c.in_stock;
  assert (select count(*) from public.owner_items(v_a, null, 100, 0, 'sold_out')) = c.sold_out;
  assert (select count(*) from public.owner_items(v_a, null, 100, 0, 'no_description')) = c.no_description;
  assert (select count(*) from public.owner_items(v_a, null, 100, 0, 'missing_translation')) = c.missing_translation;
  assert (select availability from public.owner_items(v_a, 'P004', 50, 0, 'sold_out')) = 'out_of_stock', 'sold out: "Vypredané"';
  assert (select bool_and(availability = 'in_stock_count') from public.owner_items(v_a, null, 100, 0, 'in_stock'));
  assert (select bool_and(item_id <> (select id from public.shop_items where source_code = 'P001'))
          from public.owner_items(v_a, null, 50, 0, 'no_description')), 'P001 has a description';
  assert (select has_description from public.owner_items(v_a, 'P001')), 'the flag comes with the row';
  assert not exists (select 1 from public.owner_items(v_a, null, 50, 0, 'missing_translation') where source_code = 'P002');
  assert (select total_count from public.owner_items(v_a, null, 50, 0, 'all') limit 1) = c.all_items
     and (select total_count from public.owner_items(v_a) limit 1) = c.all_items;
  assert (select total_count from public.owner_items(v_a, null, 2, 0, 'in_stock') limit 1) = c.in_stock, 'total of the filter, not of the page';
  begin
    perform * from public.owner_items(v_a, null, 50, 0, 'hidden');
    raise exception 'an unknown filter was accepted';
  exception when invalid_parameter_value then null;
  end;
  -- stale data: the shopper sees nothing (no label), the filters still go by the file's quantity
  assert (select bool_and(availability is null) from public.owner_items(v_z)), 'stale: no availability';
  assert (select in_stock = current_setting('ppi.t_z_in')::bigint and all_items = current_setting('ppi.t_z_all')::bigint
          from public.owner_item_counts(v_z)), 'stale shop: filters by the quantity in the file';
  begin
    perform * from public.owner_item_rows(v_a, null);
    raise exception 'an owner ran owner_item_rows directly';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_p1 uuid := (select id from public.shop_items where source_code = 'P001');
  v_p2 uuid := (select id from public.shop_items where source_code = 'P002');
begin
  -- a changed original makes P002's AI names stale → missing again; "Neprekladať" is not missing
  update public.content_translations set source_hash = md5('old name') where shop_id = v_a and ref = v_p2::text;
  insert into public.content_translations (shop_id, kind, ref, lang, text, status, source_hash)
  select v_a, 'item_name', v_p1::text, l, null, 'none', null from unnest(public.shop_target_langs(v_a, 'item_name')) l where l <> 'sk';
end $$;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
begin
  assert (select missing_translation from public.owner_items(v_a, 'P002')), 'stale AI names count as missing';
  -- P001: names "Neprekladať", but its description has no translation yet
  assert (select missing_translation from public.owner_items(v_a, 'P001')), 'the shown description still needs translating';
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
begin
  assert (select all_items from public.owner_item_counts(v_a)) = 0, 'owner B counted shop A items';
  assert not exists (select 1 from public.owner_items(v_a, null, 50, 0, 'in_stock')), 'owner B listed shop A items';
end $$;
reset role;
set role anon;
do $$ begin
  begin
    perform * from public.owner_item_counts((select id from public.shops where slug = 'potraviny-centrum'));
    raise exception 'anon ran owner_item_counts';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
do $$
declare
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
begin
  delete from public.shop_members where shop_id = (select id from public.shops where slug = 'zeleziarstvo-vychod')
    and user_id = '00000000-0000-0000-0000-00000000000a';
  update public.sync_sources set latest_file_time = nullif(current_setting('ppi.t_z_time'), '')::timestamptz
  where shop_id = (select id from public.shops where slug = 'zeleziarstvo-vychod');
  delete from public.content_translations where shop_id = v_a and kind like 'item_%';
  delete from public.item_descriptions where shop_id = v_a;
  delete from public.translation_requests where shop_id = v_a;
end $$;

\echo '--- speed: stored name text, search patterns, no JIT, the error log (update 42)'
reset role;
do $$
declare
  v_bad integer;
begin
  -- The stored column is always the same text the search used to build per row.
  select count(*) into v_bad from public.shop_items
  where names_search is distinct from public.item_names_text(name, name_i18n);
  assert v_bad = 0, 'names_search differs from item_names_text';
  assert exists (select 1 from pg_indexes where indexname = 'shop_items_names_search_col_idx'), 'trigram index on names_search';
  -- One LIKE pattern per word, the same words matches_all_words() uses; nothing for an empty query.
  assert public.search_patterns(null) = '{}'::text[], 'empty query → no patterns';
  assert public.search_patterns('  ') = '{}'::text[], 'blank query → no patterns';
  assert cardinality(public.search_patterns('Káva  zrnková')) = 2, 'two words → two patterns';
  assert public.search_patterns('50%') = array['%50\%%'], '% is escaped';
  -- Search gives what the rule says: every word matches, sold out still listed, EAN exact.
  assert (select count(*) from public.search_stock('káva')) = 3, 'three coffees in the seed';
  assert (select count(*) from public.search_stock('kava zrnkova')) = 1, 'every word must match (no accents)';
  assert (select count(*) from public.search_stock('káva lavazza')) = 1, 'brand counts as a word';
  assert (select count(*) from public.search_stock('káva centrum')) = 2, 'shop name counts as a word';
  assert (select count(*) from public.search_stock('8000070012345')) = 1, 'EAN';
  assert (select count(*) from public.search_stock('káva neexistuje')) = 0, 'a missing word → nothing';
  assert not exists (
    select 1 from public.search_stock('káva') r join public.shop_items si on si.id = r.item_id
    where not public.matches_all_words(
      public.item_names_text(si.name, si.name_i18n) || ' ' || coalesce(r.brand, '') || ' ' || coalesce(r.ean, '') || ' '
        || r.shop_name || ' ' || coalesce(r.shop_address, '') || ' ' || coalesce(r.shop_city, ''), 'káva')
  ), 'every row matches all words';
  assert (select count(*) from public.shop_stock('potraviny-centrum', 'káva')) = 2, 'shop_stock with a word';
  -- No JIT compile on the hot functions (it cost ~0.5 s per call).
  assert (select proconfig @> array['jit=off'] from pg_proc where oid = 'public.search_stock(text,double precision,double precision,double precision,boolean)'::regprocedure),
    'search_stock runs without JIT';
  assert (select proconfig @> array['jit=off'] from pg_proc where proname = 'shop_content' and pronamespace = 'public'::regnamespace limit 1),
    'shop_content runs without JIT';
end $$;

-- The error log: anyone may write through the function (cleaned, counted up), nobody reads the table but the admin.
set role anon;
do $$
begin
  perform public.log_server_error('render', '/[lang]/shops/[slug]?q=mlieko', 'TypeError: x for jana@obchod.sk 3f2c1b9e-1111-2222-3333-444455556666', 'abc');
  perform public.log_server_error('render', '/[lang]/shops/[slug]', 'TypeError: x for jana@obchod.sk 3f2c1b9e-1111-2222-3333-444455556666');
  perform public.log_server_error('nonsense', '', '');
  begin
    perform 1 from public.server_errors;
    raise exception 'anon read server_errors';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.admin_server_errors(7);
    raise exception 'anon read the error list';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
do $$
begin
  assert (select hits from public.server_errors where route = '/[lang]/shops/[slug]') = 2, 'the same error counts up';
  assert not exists (select 1 from public.server_errors where message ~ '@|3f2c1b9e|mlieko' or route ~ '\?.'), 'no personal data stored';
  assert exists (select 1 from public.server_errors where kind = 'other' and route = '?' and message = 'error'), 'odd input is made safe';
end $$;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
begin
  begin
    perform * from public.admin_server_errors(7);
    raise exception 'an owner read the error list';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000ad';
set role authenticated;
do $$
begin
  assert (select hits from public.admin_server_errors(7) where route = '/[lang]/shops/[slug]') = 2, 'the admin sees the error';
end $$;
reset role;
delete from public.server_errors;

-- ------------------------------------------------------------------ update 43: "Začať sklad odznova"
\echo '--- inventory reset (update 43)'
-- A test shop of owner A with two files: F1 (A1–A5, A5 at 0) then F2 (A1, A2, A5): A3 and A4 are missing from F2.
do $$
declare
  v_shop uuid;
begin
  insert into public.shops (slug, name, ico, address, city, country, timezone, location, phone, opening_hours, is_active)
  select 'farby-reset', 'Farby Reset', null, address, city, country, timezone, location, phone, opening_hours, true
  from public.shops where slug = 'potraviny-centrum'
  returning id into v_shop;
  insert into public.shop_members (shop_id, user_id) values (v_shop, '00000000-0000-0000-0000-00000000000a');
  insert into public.sync_sources (shop_id, file_format, field_mapping, mapping_status, last_file_name, file_columns)
  values (v_shop, 'csv', '{"source_code":"Kód","name":"Názov","quantity":"Mn","price":"Cena"}', 'confirmed', 'sklad2.csv',
          array['Kód', 'Názov', 'Mn', 'Cena', 'NákupnáCena']);
  perform public.apply_stock_file(v_shop, '[
    {"source_code":"A1","name":"Farba biela 5 l","ean":"8580000000011","quantity":4,"price":29.9},
    {"source_code":"A2","name":"Farba modrá 1 l","quantity":2,"price":9.9},
    {"source_code":"A3","name":"Štetec 50 mm","quantity":7,"price":3.5},
    {"source_code":"A4","name":"Valček \"Profi\"; 25 cm","quantity":1,"price":6},
    {"source_code":"A5","name":"Riedidlo 1 l","quantity":0,"price":4}
  ]', '2026-10-20 08:00:00+00', '[{"Kód":"A1","Názov":"Farba biela 5 l"}]');
end $$;
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-reset');
  v_a1 uuid := (select id from public.shop_items where shop_id = (select id from public.shops where slug = 'farby-reset') and source_code = 'A1');
  v_a2 uuid := (select id from public.shop_items where shop_id = (select id from public.shops where slug = 'farby-reset') and source_code = 'A2');
begin
  perform public.apply_stock_file(v_shop, '[
    {"source_code":"A1","name":"Farba biela 5 l","ean":"8580000000011","quantity":3,"price":29.9},
    {"source_code":"A2","name":"Farba modrá 1 l","quantity":2,"price":9.9},
    {"source_code":"A5","name":"Riedidlo 1 l","quantity":0,"price":4}
  ]', '2026-10-21 08:00:00+00', '[{"Kód":"A1","Názov":"Farba biela 5 l"}]');
  -- translations and a Cacaduu description
  update public.shop_items set name_lang = 'sk', translated_name_source = 'Farba biela 5 l', name_i18n_by_owner = true where id = v_a1;
  insert into public.content_translations (shop_id, kind, ref, lang, text, status, source_hash)
  values (v_shop, 'item_name', v_a1::text, 'de', 'Weiße Farbe 5 l', 'manual', md5('Farba biela 5 l')),
         (v_shop, 'item_name', v_a1::text, 'hu', 'Fehér festék 5 l', 'manual', md5('Farba biela 5 l')),
         (v_shop, 'item_name', v_a1::text, 'en', 'White paint 5 l', 'ai', md5('Farba biela 5 l'));
  assert (select name_i18n ->> 'hu' from public.shop_items where id = v_a1) = 'Fehér festék 5 l';
  insert into public.item_descriptions (item_id, shop_id, text, published_at, show)
  values (v_a2, v_shop, 'Modrá farba na drevo.', now(), 'cacaduu');
  perform public.record_stock_import(v_shop, 'sklad1.csv', '2026-10-20 08:00:00+00', 'ok', 5, 5, 0, 0, null, '[]');
  perform public.record_stock_import(v_shop, 'sklad2.csv', '2026-10-21 08:00:00+00', 'ok', 3, 3, 2, 0, null, '[]');
  assert (select count(*) from public.shop_items where shop_id = v_shop) = 5;
end $$;

-- Totals of everything a reset must never touch (all shops).
create temporary table reset_untouched as
select (select count(*) from public.shop_items si join public.shops s on s.id = si.shop_id where s.slug <> 'farby-reset') as other_items,
       (select count(*) from public.stock_imports i join public.shops s on s.id = i.shop_id where s.slug <> 'farby-reset') as other_imports,
       (select count(*) from public.shop_documents) as documents,
       (select count(*) from public.shop_folders) as folders,
       (select count(*) from public.shop_page_sections) as sections,
       (select count(*) from public.blog_posts) as posts,
       (select count(*) from public.assistant_conversations) as conversations,
       (select count(*) from public.shop_special_hours) as special_days,
       (select count(*) from public.subscriptions) as subscriptions;
grant select on reset_untouched to authenticated;

-- another shop's owner and visitors can do nothing
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-reset');
begin
  begin perform public.owner_inventory_preview(v_shop); raise exception 'B previewed'; exception when insufficient_privilege then null; end;
  begin perform public.owner_inventory_state(v_shop); raise exception 'B read the state'; exception when insufficient_privilege then null; end;
  begin perform public.owner_delete_stock_files(v_shop); raise exception 'B deleted files'; exception when insufficient_privilege then null; end;
  begin perform public.owner_inventory_reset(v_shop, 'all', 'Farby Reset'); raise exception 'B reset'; exception when insufficient_privilege then null; end;
  begin perform public.owner_raw_files_to_delete(v_shop); raise exception 'B asked for raw files'; exception when insufficient_privilege then null; end;
  assert (select count(*) from public.shop_activity where shop_id = v_shop) = 0, 'B reads no activity of A';
  begin perform 1 from public.inventory_trash; raise exception 'owner read the trash'; exception when insufficient_privilege then null; end;
  begin perform 1 from public.inventory_backups; raise exception 'owner read the backups table'; exception when insufficient_privilege then null; end;
  begin perform public.stock_files_clear(v_shop); raise exception 'owner called the internal clear'; exception when insufficient_privilege then null; end;
  begin perform public.inventory_purge_expired(); raise exception 'owner purged'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set role anon;
do $$
begin
  begin perform public.owner_inventory_preview((select id from public.public_shops where slug = 'farby-reset')); raise exception 'anon previewed';
  exception when insufficient_privilege then null; end;
  assert public.shop_stock_resetting('farby-reset') = false, 'no note before a reset';
end $$;
reset role;

-- owner A: the preview counts only the products missing from the last file (A3, A4), not A5 (in the file with 0)
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-reset');
  v_p jsonb;
begin
  v_p := public.owner_inventory_preview(v_shop);
  assert (v_p ->> 'items')::int = 5 and (v_p ->> 'missing')::int = 2 and (v_p ->> 'files')::int = 2, format('preview %s', v_p);
  assert (select array_agg(e ->> 'code' order by e ->> 'code') from jsonb_array_elements(v_p -> 'missing_list') e) = array['A3', 'A4'];
  assert v_p ->> 'shop_name' = 'Farby Reset' and (v_p ->> 'resets_left')::int = 3;
end $$;

-- 2b alone: every uploaded file goes (list, name, mapping example); the inventory and its freshness stay
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-reset');
  v_r jsonb;
  v_s jsonb;
begin
  v_r := public.owner_delete_stock_files(v_shop);
  assert (v_r ->> 'files')::int = 2, format('files %s', v_r);
  assert (select count(*) from public.stock_imports where shop_id = v_shop) = 0, 'the list is empty';
  assert (select count(*) from public.shop_items where shop_id = v_shop) = 5, '2b keeps the inventory';
  v_s := public.upload_check_in(v_shop);
  assert (v_s ->> 'files_cleared')::boolean and v_s ->> 'last_file_name' is null, format('check-in %s', v_s);
  assert v_s ->> 'latest_file_time' is not null, 'freshness stays (expires normally)';
  v_s := public.owner_inventory_state(v_shop);
  assert (v_s ->> 'files_cleared')::boolean and (v_s ->> 'files')::int = 0 and not (v_s ->> 'needs_file')::boolean;
  assert (select sample_rows is null and last_file_name is null and field_mapping is not null from public.my_shops() where slug = 'farby-reset'),
    'no example rows, no last file name; the mapping stays';
  assert public.owner_raw_files_to_delete(v_shop) is not null, 'stock-pull is told to delete the raw files';
  assert (select action from public.shop_activity where shop_id = v_shop order by at desc limit 1) = 'stock_files_deleted';
end $$;
reset role;
-- stock-pull (service role) clears the mark once the raw files are gone; a new file after 2b shows as present
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-reset');
begin
  perform public.raw_files_deleted(v_shop, (select raw_files_delete_before from public.sync_sources where shop_id = v_shop));
  assert (select raw_files_delete_before is null from public.sync_sources where shop_id = v_shop);
end $$;

-- option A: only A3 and A4 go, after a backup of everything; "Obnoviť sklad" brings them back exactly
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-reset');
  v_a3 uuid := (select id from public.shop_items where shop_id = (select id from public.shops where slug = 'farby-reset') and source_code = 'A3');
  v_r jsonb;
  v_csv text;
  v_reset bigint;
begin
  v_r := public.owner_inventory_reset(v_shop, 'missing');
  assert (v_r ->> 'items')::int = 2 and (v_r ->> 'files')::int = 0, format('A %s', v_r);
  assert (select array_agg(source_code order by source_code) from public.shop_items where shop_id = v_shop) = array['A1', 'A2', 'A5'];
  select csv into v_csv from public.owner_inventory_backup((v_r ->> 'backup_id')::bigint);
  assert v_csv like E'\uFEFFkod;nazov;ean;znacka;kategoria;popis;mnozstvo;cena;mena;cas_suboru;popis_cacaduu;nazov@de;popis@de;kategoria@de;nazov@en;%;nazov@hu;popis@hu;kategoria@hu\r\n%',
    format('csv header %s', left(v_csv, 200));
  assert (select count(*) from regexp_split_to_table(rtrim(v_csv, E'\r\n'), E'\r\n')) = 6, 'header + all 5 products';
  assert v_csv like '%"A4";"Valček ""Profi""; 25 cm"%', 'quoted as CSV';
  assert v_csv like '%"Fehér festék 5 l"%' and v_csv like '%"Weiße Farbe 5 l"%' and v_csv like '%"Modrá farba na drevo."%',
    'translations and the Cacaduu description are in the backup';
  assert v_csv not like '%NákupnáCena%' and v_csv not ilike '%nakup%', 'no private column';
  v_reset := (v_r ->> 'reset_id')::bigint;
  assert (select (e ->> 'blocked') is null from jsonb_array_elements(public.owner_inventory_state(v_shop) -> 'resets') e
          where (e ->> 'id')::bigint = v_reset), 'can be restored';
  v_r := public.owner_inventory_restore(v_reset);
  assert (v_r ->> 'items')::int = 2;
  assert (select id from public.shop_items where shop_id = v_shop and source_code = 'A3') = v_a3, 'the same product id';
  assert (select quantity || '/' || price from public.inventory where shop_item_id = v_a3) = '0/3.5', 'quantity and price as they were';
  assert (select count(*) from public.shop_items where shop_id = v_shop) = 5;
  begin perform public.owner_inventory_restore(v_reset); raise exception 'restored twice';
  exception when raise_exception then assert sqlerrm = 'restore_restored', sqlerrm; end;
  -- the backups are not uploaded files: they stay through 2b
  perform public.owner_delete_stock_files(v_shop);
  assert jsonb_array_length(public.owner_inventory_state(v_shop) -> 'backups') = 1, 'backup survives 2b';
end $$;

reset role;
do $$ begin perform public.record_stock_import((select id from public.shops where slug = 'farby-reset'), 'sklad3.csv', '2026-10-21 08:00:00+00', 'ok', 3, 3, 0, 0, null, '[]'); end $$;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
-- option B: the shop's name must be typed; everything goes (files too); the page says "Sortiment sa práve aktualizuje"
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-reset');
  v_a1 uuid := (select id from public.shop_items where shop_id = (select id from public.shops where slug = 'farby-reset') and source_code = 'A1');
  v_r jsonb;
begin
  begin perform public.owner_inventory_reset(v_shop, 'all', 'Farby'); raise exception 'reset without the name';
  exception when raise_exception then assert sqlerrm = 'confirm_name', sqlerrm; end;
  v_r := public.owner_inventory_reset(v_shop, 'all', '  farby reset ', true, false);
  assert (v_r ->> 'items')::int = 5 and (v_r ->> 'files')::int = 1, format('B %s', v_r);
  assert not exists (select 1 from public.shop_items where shop_id = v_shop), 'no products';
  assert not exists (select 1 from public.content_translations where shop_id = v_shop and kind like 'item%'), 'no item translations left behind';
  assert (select count(*) from public.stock_imports where shop_id = v_shop) = 0, 'B deletes the files';
  assert (select latest_file_time is null and field_mapping is not null and mapping_status = 'confirmed'
          from public.my_shops() where slug = 'farby-reset'), 'mapping kept, any next file is taken';
  assert public.owner_inventory_state(v_shop) ->> 'inventory_reset_at' is not null;
  assert (public.owner_inventory_state(v_shop) ->> 'needs_file')::boolean, 'Môj obchod asks for a new file';
  assert public.owner_raw_files_to_delete(v_shop) is not null;
  -- restore within 30 days: the same products, translations, description and file time; the files do not come back
  v_r := public.owner_inventory_restore((v_r ->> 'reset_id')::bigint);
  assert (v_r ->> 'items')::int = 5;
  assert (select name_i18n ->> 'hu' = 'Fehér festék 5 l' and name_i18n_by_owner from public.shop_items where id = v_a1);
  assert (select text from public.content_translations where shop_id = v_shop and ref = v_a1::text and lang = 'de') = 'Weiße Farbe 5 l';
  assert exists (select 1 from public.item_descriptions d join public.shop_items si on si.id = d.item_id
                 where si.shop_id = v_shop and si.source_code = 'A2' and d.text = 'Modrá farba na drevo.');
  assert (select latest_file_time = '2026-10-21 08:00:00+00' from public.my_shops() where slug = 'farby-reset');
  assert public.owner_inventory_state(v_shop) ->> 'inventory_reset_at' is null;
  assert (select count(*) from public.stock_imports where shop_id = v_shop) = 0;
  assert (select array_agg(action order by id) from public.shop_activity where shop_id = v_shop)
         = array['stock_files_deleted', 'inventory_missing_removed', 'inventory_restored', 'stock_files_deleted', 'inventory_reset', 'inventory_restored'],
    'every action is in the log';
end $$;
reset role;
set role anon;
do $$ begin assert public.shop_stock_resetting('farby-reset') = false, 'no note after the restore'; end $$;
reset role;

-- B again, with the mapping cleared: the page note shows; a new file brings back A1 and A2 with their translations
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-reset');
begin
  perform public.owner_inventory_reset(v_shop, 'all', 'Farby Reset', true, true);
  assert (select field_mapping is null and mapping_status = 'proposed' and file_columns is null from public.my_shops() where slug = 'farby-reset'),
    'the column mapping starts over';
  assert (public.owner_inventory_preview(v_shop) ->> 'resets_left')::int = 0, 'three resets today';
  begin perform public.owner_inventory_reset(v_shop, 'missing'); raise exception 'a fourth reset';
  exception when raise_exception then assert sqlerrm in ('reset_limit', 'nothing_to_remove'), sqlerrm; end;
  begin perform public.owner_inventory_reset(v_shop, 'all', 'Farby Reset'); raise exception 'a fourth reset';
  exception when raise_exception then assert sqlerrm = 'reset_limit', sqlerrm; end;
end $$;
reset role;
set role anon;
do $$ begin assert public.shop_stock_resetting('farby-reset'), 'the page says "Sortiment sa práve aktualizuje"'; end $$;
reset role;
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-reset');
  v_a1 uuid;
  v_reset bigint := (select max(id) from public.inventory_resets where shop_id = (select id from public.shops where slug = 'farby-reset'));
begin
  -- stock-pull applies a new file (the owner approved the new columns)
  perform public.apply_stock_file(v_shop, '[
    {"source_code":"A1","name":"Farba biela 5 l","ean":"8580000000011","quantity":9,"price":31},
    {"source_code":"A2","name":"Farba modrá 1 l","quantity":1,"price":9.9},
    {"source_code":"B9","name":"Lak bezfarebný","quantity":5,"price":12}
  ]', '2026-10-23 07:00:00+00');
  v_a1 := (select id from public.shop_items where shop_id = v_shop and source_code = 'A1');
  assert (select name_i18n ->> 'en' = 'White paint 5 l' and translated_name_source = 'Farba biela 5 l' and name_i18n_by_owner
          from public.shop_items where id = v_a1), 'the translated names come back by code';
  assert (select text from public.content_translations where shop_id = v_shop and ref = v_a1::text and lang = 'de') = 'Weiße Farbe 5 l',
    'other translations come back on the new row';
  assert exists (select 1 from public.item_descriptions d join public.shop_items si on si.id = d.item_id
                 where si.shop_id = v_shop and si.source_code = 'A2' and d.text = 'Modrá farba na drevo.'), 'the description comes back';
  assert (select name_i18n is null from public.shop_items where shop_id = v_shop and source_code = 'B9'), 'a new product gets nothing';
  assert (select quantity from public.inventory where shop_item_id = v_a1) = 9, 'stock only from the new file';
  assert public.inventory_restore_blocked(v_reset) = 'newer_upload', 'no restore over a newer file';
  assert public.shop_stock_resetting('farby-reset') = false, 'the note goes with the new file';
  -- a removal without "zachovať preklady": nothing comes back (the day's limit is over: these resets are older)
  update public.inventory_resets set created_at = created_at - interval '2 days' where shop_id = v_shop;
end $$;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-reset');
  v_reset bigint;
begin
  begin perform public.owner_inventory_restore((select (e ->> 'id')::bigint from jsonb_array_elements(public.owner_inventory_state(v_shop) -> 'resets') e
                                                order by (e ->> 'id')::bigint desc offset 1 limit 1));
    raise exception 'an older reset restored';
  exception when raise_exception then assert sqlerrm like 'restore_%', sqlerrm; end;
  v_reset := (public.owner_inventory_reset(v_shop, 'all', 'Farby Reset', false, false) ->> 'reset_id')::bigint;
  assert (select not (e ->> 'keep_translations')::boolean from jsonb_array_elements(public.owner_inventory_state(v_shop) -> 'resets') e
          where (e ->> 'id')::bigint = v_reset);
end $$;
reset role;
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-reset');
begin
  perform public.apply_stock_file(v_shop, '[{"source_code":"A1","name":"Farba biela 5 l","quantity":2,"price":31}]', '2026-10-23 09:00:00+00');
  assert (select name_i18n is null and not name_i18n_by_owner from public.shop_items where shop_id = v_shop and source_code = 'A1'),
    'without "zachovať preklady" nothing comes back';
  assert not exists (select 1 from public.content_translations c join public.shop_items si on si.id::text = c.ref
                     where si.shop_id = v_shop and si.source_code = 'A1');
  -- after 30 days: the trash is emptied, the backups go, the log says so
  update public.inventory_resets set expires_at = now() - interval '1 minute' where shop_id = v_shop and restored_at is null;
  update public.inventory_backups set expires_at = now() - interval '1 minute' where shop_id = v_shop;
  assert public.inventory_purge_expired() >= 1;
  assert not exists (select 1 from public.inventory_trash where shop_id = v_shop), 'the trash is empty';
  assert not exists (select 1 from public.inventory_backups where shop_id = v_shop), 'old backups are gone';
  assert exists (select 1 from public.shop_activity where shop_id = v_shop and action = 'inventory_purged');
  assert public.inventory_restore_blocked((select max(id) from public.inventory_resets where shop_id = v_shop)) = 'purged';
  assert exists (select 1 from cron.job where jobname = 'ppi-inventory-purge'), 'the daily purge job';
  -- nothing else of any shop changed
  assert (select other_items = (select count(*) from public.shop_items si join public.shops s on s.id = si.shop_id where s.slug <> 'farby-reset')
             and other_imports = (select count(*) from public.stock_imports i join public.shops s on s.id = i.shop_id where s.slug <> 'farby-reset')
             and documents = (select count(*) from public.shop_documents)
             and folders = (select count(*) from public.shop_folders)
             and sections = (select count(*) from public.shop_page_sections)
             and posts = (select count(*) from public.blog_posts)
             and conversations = (select count(*) from public.assistant_conversations)
             and special_days = (select count(*) from public.shop_special_hours)
             and subscriptions = (select count(*) from public.subscriptions)
          from reset_untouched), 'a reset touches nothing else';
end $$;
drop table reset_untouched;

-- ------------------------------------------------------------------ update 44: the slider's fixed frame
\echo '--- slider ratio and Výrez (update 44)'
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare
  v_b uuid := (select id from public.shops where slug = 'drogeria-kostolne');
  v_a uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_pic uuid := (select id from public.shop_page_sections where shop_id = v_b and kind = 'picture');
  v_c jsonb;
begin
  assert public.owner_content(v_b) ->> 'ratio' = '4:5', 'default ratio 4:5';
  -- a picture slot cropped to the top, a post slot's crop is ignored, the ratio 1:1
  perform public.owner_save_content(v_b, null, true, 'open', jsonb_build_array(
    jsonb_build_object('kind', 'auto_post', 'crop', 'bottom'), jsonb_build_object('kind', 'picture', 'item_id', v_pic, 'crop', 'top')),
    null, '1:1');
  v_c := public.owner_content(v_b);
  assert v_c ->> 'ratio' = '1:1' and v_c #>> '{slots,1,crop}' = 'top' and v_c #>> '{slots,0,crop}' = 'center', v_c::text;
  -- null keeps the ratio; center is stored as nothing
  perform public.owner_save_content(v_b, null, true, 'open', jsonb_build_array(
    jsonb_build_object('kind', 'picture', 'item_id', v_pic, 'crop', 'center')));
  assert public.owner_content(v_b) ->> 'ratio' = '1:1', 'null keeps the ratio';
  assert public.owner_content(v_b) #>> '{slots,0,crop}' = 'center';
  perform public.owner_save_content(v_b, null, true, 'open', jsonb_build_array(
    jsonb_build_object('kind', 'picture', 'item_id', v_pic, 'crop', 'bottom')), null, '16:9');
  foreach v_c in array array['{"r":"3:4"}'::jsonb, '{"crop":"left"}'::jsonb] loop
    begin
      if v_c ? 'r' then
        perform public.owner_save_content(v_b, null, true, 'open', '[]', null, v_c ->> 'r');
      else
        perform public.owner_save_content(v_b, null, true, 'open', jsonb_build_array(jsonb_build_object('kind', 'picture', 'item_id', v_pic, 'crop', v_c ->> 'crop')));
      end if;
      raise exception 'bad ratio or crop accepted';
    exception when raise_exception then
      assert sqlerrm = 'bad', sqlerrm;
    end;
  end loop;
  begin
    perform public.owner_save_content(v_a, null, true, 'open', '[]', null, '1:1');
    raise exception 'owner B set shop A''s ratio';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
do $$ begin
  assert public.content_slot_crop((select id from public.shops where slug = 'drogeria-kostolne'), 0) = 'bottom', 'the slide''s Výrez';
end $$;
set role anon;
do $$
declare
  v_c jsonb := public.shop_content('drogeria-kostolne');
begin
  assert v_c ->> 'ratio' = '16:9', 'visitors get the ratio';
  -- a shown file slide carries its crop (drogeria's files are hidden by the earlier checks: see content_slot_crop above)
  assert not exists (select 1 from jsonb_array_elements(v_c -> 'slides') e where e ->> 'kind' in ('pdf', 'picture') and e ->> 'crop' is null);
  assert (select proconfig @> array['jit=off'] from pg_proc where oid = 'public.shop_content(text)'::regprocedure), 'still without JIT';
end $$;
reset role;

-- ------------------------------------------------------------------ update 45: review after an upload, translations folder
\echo '--- export folder: review and translation files (update 45)'
do $$
declare
  v_shop uuid;
begin
  insert into public.shops (slug, name, ico, address, city, country, timezone, location, phone, opening_hours, is_active)
  select 'farby-export', 'Farby Export', null, address, city, country, timezone, location, phone, opening_hours, true
  from public.shops where slug = 'potraviny-centrum'
  returning id into v_shop;
  insert into public.shop_members (shop_id, user_id) values (v_shop, '00000000-0000-0000-0000-00000000000a');
  insert into public.sync_sources (shop_id, file_format, field_mapping, mapping_status, last_file_name, file_columns)
  values (v_shop, 'csv', '{"source_code":"Kód","name":"Názov","ean":"EAN","quantity":"Mn","price":"Cena","category":"Kat"}', 'confirmed',
          'sklad.csv', array['Kód', 'Názov', 'EAN', 'Mn', 'Cena', 'Kat', 'NákupnáCena', 'Poznámka']);
  perform public.apply_stock_file(v_shop, '[
    {"source_code":"E1","name":"Farba biela 5 l","ean":"8580000000101","quantity":4,"price":29.9,"category":"Farby"},
    {"source_code":"E2","name":"Štetec 50 mm","ean":"8580000000102","quantity":7,"price":3.5},
    {"source_code":"E3","name":"Valček 25 cm","quantity":0,"price":6}
  ]', '2026-10-25 08:00:00+00', '[]');
end $$;

-- another owner and visitors: nothing
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-export');
begin
  begin perform public.owner_export_review(v_shop); raise exception 'B read the review'; exception when insufficient_privilege then null; end;
  begin perform public.owner_save_export_review(v_shop, '{}', null, false, false); raise exception 'B saved'; exception when insufficient_privilege then null; end;
  begin perform public.owner_export_auto(v_shop); raise exception 'B auto'; exception when insufficient_privilege then null; end;
  begin perform public.owner_export_info(v_shop); raise exception 'B info'; exception when insufficient_privilege then null; end;
  begin perform * from public.owner_export_rows(v_shop, null); raise exception 'B rows'; exception when insufficient_privilege then null; end;
  begin perform public.owner_apply_export_edits(v_shop, 'hu', 'x', '[]'); raise exception 'B edits'; exception when insufficient_privilege then null; end;
  begin perform public.owner_log_export_files_deleted(v_shop, 1); raise exception 'B logged'; exception when insufficient_privilege then null; end;
  begin perform public.owner_request_export_files_delete(v_shop); raise exception 'B asked to delete'; exception when insufficient_privilege then null; end;
  begin perform public.export_new_items(v_shop); raise exception 'internal function callable'; exception when insufficient_privilege then null; end;
  begin perform public.export_mark_seen(v_shop); raise exception 'internal function callable'; exception when insufficient_privilege then null; end;
  assert (select count(*) from public.shop_export_marks where shop_id = v_shop) = 0, 'B reads no marks of A';
end $$;
reset role;
set role anon;
do $$
begin
  begin perform public.owner_export_review((select id from public.public_shops where slug = 'farby-export')); raise exception 'anon read';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- owner A: the card asks about the two new columns and the three new products
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-export');
  v_r jsonb := public.owner_export_review((select id from public.shops where slug = 'farby-export'));
  v_s jsonb;
begin
  assert (v_r ->> 'needed')::boolean, 'a decision is needed';
  assert v_r -> 'new_columns' = '["NákupnáCena", "Poznámka"]'::jsonb, v_r ->> 'new_columns';
  assert (v_r ->> 'new_products')::int = 3 and (v_r ->> 'changed_products')::int = 0, v_r::text;
  assert v_r -> 'free_fields' = '["brand", "currency", "description"]'::jsonb, v_r ->> 'free_fields';
  assert (v_r ->> 'max_langs')::int = 2, 'free plan: two languages';
  -- refused: a column that is not new, a field already used, the same field twice, more languages than the plan
  begin perform public.owner_save_export_review(v_shop, '{"Názov":"private"}', null, false, false); raise exception 'old column accepted';
  exception when invalid_parameter_value then assert sqlerrm = 'column'; end;
  begin perform public.owner_save_export_review(v_shop, '{"Poznámka":"name"}', null, false, false); raise exception 'taken field accepted';
  exception when invalid_parameter_value then assert sqlerrm = 'field'; end;
  begin perform public.owner_save_export_review(v_shop, '{"Poznámka":"description","NákupnáCena":"description"}', null, false, false);
    raise exception 'same field twice accepted';
  exception when invalid_parameter_value then assert sqlerrm = 'field'; end;
  begin perform public.owner_save_export_review(v_shop, '{}', array['hu', 'de', 'en'], false, false); raise exception 'over the plan';
  exception when invalid_parameter_value then assert sqlerrm = 'limit'; end;
  assert (select field_mapping ->> 'description' from public.my_shops() where id = v_shop) is null, 'a refused card changed nothing';
  -- saved: Poznámka → description, NákupnáCena private, hu + de, descriptions for the new products
  v_s := public.owner_save_export_review(v_shop, '{"Poznámka":"description","NákupnáCena":"private"}', array['hu', 'de'], true, false);
  assert jsonb_array_length(v_s -> 'describe_ids') = 3 and (v_s ->> 'marked')::int = 3, v_s::text;
  assert (select field_mapping ->> 'description' from public.my_shops() where id = v_shop) = 'Poznámka';
  assert (select mapping_status from public.my_shops() where id = v_shop) = 'confirmed', 'still approved';
  assert (select private_columns from public.shop_export_settings where shop_id = v_shop) = array['NákupnáCena'];
  assert public.shop_preferred_langs(v_shop) = array['hu', 'de'], 'the languages';
  v_r := public.owner_export_review(v_shop);
  assert not (v_r ->> 'needed')::boolean and v_r -> 'new_columns' = '[]'::jsonb, v_r::text;
  assert exists (select 1 from public.shop_activity where shop_id = v_shop and action = 'export_review');
end $$;
reset role;

-- a changed product (its name in the next file) is asked about again; "Zapamätať" handles it without asking
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-export');
begin
  perform public.apply_stock_file(v_shop, '[
    {"source_code":"E1","name":"Farba biela 5 l","ean":"8580000000101","quantity":4,"price":29.9,"category":"Farby"},
    {"source_code":"E2","name":"Štetec plochý 50 mm","ean":"8580000000102","quantity":7,"price":3.5},
    {"source_code":"E3","name":"Valček 25 cm","quantity":0,"price":6},
    {"source_code":"E4","name":"Páska 50 m","quantity":3,"price":2}
  ]', '2026-10-26 08:00:00+00', '[]');
end $$;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-export');
  v_r jsonb := public.owner_export_review((select id from public.shops where slug = 'farby-export'));
  v_a jsonb;
begin
  assert (v_r ->> 'needed')::boolean and (v_r ->> 'new_products')::int = 1 and (v_r ->> 'changed_products')::int = 1, v_r::text;
  v_a := public.owner_export_auto(v_shop);
  assert not (v_a ->> 'remember')::boolean and (v_a ->> 'marked')::int = 0, 'nothing without "Zapamätať"';
  perform public.owner_save_export_review(v_shop, '{}', null, true, true);
  assert not (public.owner_export_review(v_shop) ->> 'needed')::boolean;
end $$;
reset role;
do $$ begin
  perform public.apply_stock_file((select id from public.shops where slug = 'farby-export'), '[
    {"source_code":"E1","name":"Farba biela 5 l","ean":"8580000000101","quantity":4,"price":29.9,"category":"Farby"},
    {"source_code":"E2","name":"Štetec plochý 50 mm","ean":"8580000000102","quantity":7,"price":3.5},
    {"source_code":"E3","name":"Valček 25 cm","quantity":0,"price":6},
    {"source_code":"E4","name":"Páska 50 m","quantity":3,"price":2},
    {"source_code":"E5","name":"Tmel 300 ml","quantity":5,"price":4}
  ]', '2026-10-27 08:00:00+00', '[]');
end $$;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-export');
  v_a jsonb;
begin
  assert not (public.owner_export_review(v_shop) ->> 'needed')::boolean, 'remembered: no card for new products';
  v_a := public.owner_export_auto(v_shop);
  assert (v_a ->> 'remember')::boolean and (v_a ->> 'marked')::int = 1, v_a::text;
  -- E5 has no description: it is described; E1–E4 were marked before and are not described again
  assert v_a -> 'describe_ids' = jsonb_build_array((select id from public.shop_items where shop_id = v_shop and source_code = 'E5')), v_a::text;
  assert (public.owner_export_auto(v_shop) ->> 'marked')::int = 0, 'only once';
end $$;
reset role;

-- the files: what is written (approved columns only) and the owner's edits
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-export');
  v_e1 uuid := (select id from public.shop_items where shop_id = (select id from public.shops where slug = 'farby-export') and source_code = 'E1');
begin
  -- E1 has a category (from the file's texts), Cacaduu's description and an AI translation of it
  update public.shop_items set category = 'Farby' where id = v_e1;
  insert into public.item_descriptions (item_id, shop_id, text, published_at) values (v_e1, v_shop, 'Biela farba.', now());
  insert into public.content_translations (shop_id, kind, ref, lang, text, status, source_hash)
  values (v_shop, 'item_description', v_e1::text, 'hu', 'Fehér festék.', 'ai', md5('Biela farba.'));
end $$;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-export');
  v_e1 uuid := (select id from public.shop_items where shop_id = (select id from public.shops where slug = 'farby-export') and source_code = 'E1');
  v_i jsonb := public.owner_export_info((select id from public.shops where slug = 'farby-export'));
  v_version text;
  v_e jsonb;
  v_n integer;
begin
  assert v_i -> 'langs' = '["de", "hu"]'::jsonb, v_i ->> 'langs';
  assert (v_i ->> 'items')::int = 5;
  assert not (v_i -> 'columns')::text like '%NákupnáCena%', 'a private column is never a column of the files';
  assert v_i -> 'columns' @> '[{"field":"description","column":"Poznámka"}]'::jsonb, v_i ->> 'columns';
  v_version := v_i ->> 'version';
  assert (select count(*) from public.owner_export_rows(v_shop, null)) = 5;
  assert (select st_name from public.owner_export_rows(v_shop, null) where code = 'E1') is null, 'the main file has no translation states';
  assert (select st_name from public.owner_export_rows(v_shop, 'hu') where code = 'E1') = 'missing';
  assert (select st_cat from public.owner_export_rows(v_shop, 'hu') where code = 'E2') = 'no_source', 'E2 has no category';
  assert (select count(*) from public.owner_export_rows(v_shop, 'hu', 4, 1000)) = 1, 'paged';
  begin perform * from public.owner_export_rows(v_shop, 'xx-yy'); raise exception 'bad language'; exception when invalid_parameter_value then null; end;

  -- the main file's "Popis" → the owner's approved description; an AI translation of the old one becomes stale
  v_e := public.owner_apply_export_edits(v_shop, null, 'sklad.sk.xlsx', '[
    {"code":"E1","field":"description","text":"Biela farba na steny, 5 l."},
    {"code":"E2","field":"price","text":"1"},
    {"code":"NEZNAMY","field":"description","text":"x"}
  ]');
  assert (v_e ->> 'applied')::int = 1, v_e::text;
  assert v_e -> 'unknown' = '[{"code":"NEZNAMY","ean":null}]'::jsonb, v_e::text;
  assert v_e -> 'skipped' @> '[{"code":"E2","field":"price","reason":"readonly"}]'::jsonb, v_e::text;
  assert (select text from public.item_description_shown(v_e1)) = 'Biela farba na steny, 5 l.';
  assert (select public.translation_state(c.status, c.source_hash, 'Biela farba na steny, 5 l.') from public.content_translations c
          where c.shop_id = v_shop and c.kind = 'item_description' and c.ref = v_e1::text and c.lang = 'hu') = 'stale', 'its AI translation is stale';
  assert (select quantity from public.inventory where shop_item_id = (select id from public.shop_items where shop_id = v_shop and source_code = 'E2')) = 7,
    'the stock is never changed';

  -- a language file: changed cells → the owner's own translations; matched by EAN when the code is missing
  v_e := public.owner_apply_export_edits(v_shop, 'hu', 'sklad.hu.xlsx', '[
    {"code":"E1","field":"name","text":"Fehér festék 5 l"},
    {"code":"","ean":"8580000000102","field":"name","text":"Lapos ecset 50 mm"},
    {"code":"E1","field":"category","text":"Festékek"},
    {"code":"E2","field":"category","text":"Ecsetek"},
    {"code":"E1","field":"description","text":"   "}
  ]');
  assert (v_e ->> 'applied')::int = 3, v_e::text;
  assert v_e -> 'skipped' @> '[{"code":"E2","field":"category","reason":"no_source"}]'::jsonb, v_e::text;
  assert (select status from public.content_translations where shop_id = v_shop and kind = 'item_name' and ref = v_e1::text and lang = 'hu') = 'manual';
  assert (select text from public.content_translations where shop_id = v_shop and kind = 'item_description' and ref = v_e1::text and lang = 'hu') = 'Fehér festék.',
    'an empty cell changes nothing';
  assert (select st_name from public.owner_export_rows(v_shop, 'hu') where code = 'E2') = 'manual';
  -- the same text again: nothing new; the version of the files moved on with the edits
  v_e := public.owner_apply_export_edits(v_shop, 'hu', 'sklad.hu.xlsx', '[{"code":"E1","field":"name","text":"Fehér festék 5 l"}]');
  assert (v_e ->> 'applied')::int = 0 and (v_e ->> 'same')::int = 1, v_e::text;
  assert public.owner_export_info(v_shop) ->> 'version' <> v_version, 'the files are written again';
  begin perform public.owner_apply_export_edits(v_shop, 'hu', 'x', '{}'); raise exception 'not a list'; exception when invalid_parameter_value then null; end;
  select count(*) into v_n from public.shop_activity where shop_id = v_shop and action = 'export_edits';
  assert v_n = 2, 'two applied files in the activity log';
  assert public.owner_export_info(v_shop) -> 'delete_files_at' = 'null'::jsonb, 'no deletion asked';
  perform public.owner_request_export_files_delete(v_shop);
  assert public.owner_export_info(v_shop) ->> 'delete_files_at' is not null, 'the shop PC is asked to delete its files';
  perform public.owner_log_export_files_deleted(v_shop, 3);
  assert public.owner_export_info(v_shop) -> 'delete_files_at' = 'null'::jsonb, 'done';
  assert (select details ->> 'files' from public.shop_activity where shop_id = v_shop and action = 'export_files_deleted') = '3';
  assert (select proconfig @> array['jit=off'] from pg_proc where oid = 'public.owner_export_rows(uuid,text,integer,integer)'::regprocedure);
end $$;
reset role;

-- ------------------------------------------------------------------ update 46: the assistant's texts in every language
\echo '--- assistant label and welcome: preset translations, also into the shop language (update 46)'
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-export');
  v_hash text;
  v_langs text[];
begin
  update public.shops set assistant_label = 'Keresés Cacadoo Assistenssel',
    assistant_welcome = 'Keress rá kedvenc termékedre.' where id = v_shop;
  assert public.shop_main_lang(v_shop) = 'sk', 'a Slovak shop';
  assert public.preset_translation_kind('assistant_label') and public.preset_translation_kind('assistant_welcome');
  assert not public.preset_translation_kind('item_name') and not public.preset_translation_kind('blog_body');
  -- every pre-translated language (sk, hu, en) and the shop's own language; item names never into the shop's own
  v_langs := public.shop_target_langs(v_shop, 'assistant_label');
  assert v_langs @> array['sk', 'hu', 'en'], v_langs::text;
  assert not ('sk' = any (public.shop_target_langs(v_shop, 'item_name'))), 'items keep the old rule';
  assert not ('sk' = any (public.shop_target_langs(v_shop, 'special_note'))), 'other texts keep the old rule';
  -- the translate function is told to see the language itself
  assert (select source_lang from public.translation_work(500, v_shop, 'sk') where kind = 'assistant_label') = 'auto';
  assert exists (select 1 from public.translation_work(500, v_shop, 'hu') where kind = 'assistant_welcome' and source_lang = 'auto');
  assert exists (select 1 from public.translation_work(500, v_shop, 'en') where kind = 'assistant_label');
  -- stored like any AI translation; the shop's own language reads it
  select source_hash into v_hash from public.translation_work(500, v_shop, 'sk') where kind = 'assistant_label';
  assert public.apply_translations(jsonb_build_array(jsonb_build_object('shop_id', v_shop, 'kind', 'assistant_label', 'ref', v_shop::text,
    'lang', 'sk', 'text', 'Hľadanie s asistentom Cacadoo', 'source_hash', v_hash))) = 1;
  assert (select text from public.shop_translations('farby-export', 'sk', array['assistant_label'])) = 'Hľadanie s asistentom Cacadoo';
  assert not exists (select 1 from public.translation_work(500, v_shop, 'sk') where kind = 'assistant_label'), 'done once';
  -- the owner changes the text: made again
  update public.shops set assistant_label = 'Keresés' where id = v_shop;
  assert exists (select 1 from public.translation_work(500, v_shop, 'sk') where kind = 'assistant_label'), 'a changed original is translated again';
  assert not exists (select 1 from public.shop_translations('farby-export', 'sk', array['assistant_label'])), 'never a stale text';
  assert (select proconfig @> array['jit=off'] from pg_proc where oid = 'public.translation_work(integer,uuid,text)'::regprocedure);
end $$;
set role anon;
do $$
begin
  begin perform public.shop_target_langs((select id from public.public_shops where slug = 'farby-export'), 'assistant_label');
    raise exception 'anon read the target languages';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ------------------------------------------------------------------ update 47: the company in Môj obchod
\echo '--- the company under the address: name, IČO, DIČ, PSČ (update 47)'
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-export');
begin
  perform public.owner_save_company(v_shop, '  Farby  <s.r.o.> ', ' sk2020123456 ', ' 040  01 ');
  assert (select zip from public.my_shops() where id = v_shop) = '040 01', 'one space';
  assert (select company_name from public.my_shops() where id = v_shop) = 'Farby s.r.o.', 'plain text, no tags';
  assert (select dic from public.my_shops() where id = v_shop) = 'SK2020123456', 'trimmed, upper case';
  begin perform public.owner_save_company(v_shop, 'Farby', 'x', null); raise exception 'a bad DIČ was kept';
  exception when invalid_parameter_value then assert sqlerrm = 'dic'; end;
  begin perform public.owner_save_company(v_shop, repeat('a', 201), null, null); raise exception 'a long name was kept';
  exception when invalid_parameter_value then assert sqlerrm = 'company_name'; end;
  begin perform public.owner_save_company(v_shop, 'Farby', null, '04001!'); raise exception 'a bad PSČ was kept';
  exception when invalid_parameter_value then assert sqlerrm = 'zip'; end;
  perform public.owner_save_company(v_shop, '', '', '');
  assert (select company_name is null and dic is null and zip is null from public.my_shops() where id = v_shop), 'empty fields clear';
  perform public.owner_save_company(v_shop, 'Farby s.r.o.', '2020123456', '04001');
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
begin
  begin perform public.owner_save_company((select id from public.shops where slug = 'farby-export'), 'X', null, null);
    raise exception 'B saved A''s company';
  exception when insufficient_privilege then null; end;
  assert not exists (select 1 from public.shop_company), 'B reads no company of A';
end $$;
reset role;
set role anon;
do $$
begin
  begin perform public.owner_save_company((select id from public.public_shops where slug = 'farby-export'), 'X', null, null);
    raise exception 'anon saved';
  exception when insufficient_privilege then null; end;
  begin perform (select company_name from public.shop_company limit 1); raise exception 'anon read the company';
  exception when insufficient_privilege then null; end;
  assert not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name in ('public_shops', 'shops')
    and column_name in ('company_name', 'dic', 'zip')), 'never next to the public shop data';
end $$;
reset role;

-- ------------------------------------------------------------------ update 48: the company on the shop page
\echo '--- the company on the shop page: shop_company_details() (update 48)'
set role anon;
do $$
declare
  r record;
begin
  select * into r from public.shop_company_details('farby-export');
  assert r.company_name = 'Farby s.r.o.' and r.dic = '2020123456' and r.zip = '04001', r::text;
  assert not exists (select 1 from public.shop_company_details('no-such-shop')), 'unknown shop: nothing';
  begin perform (select company_name from public.shop_company limit 1); raise exception 'anon read the table';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$
begin
  update public.shops set is_active = false where slug = 'farby-export';
end $$;
set role anon;
do $$
begin
  assert not exists (select 1 from public.shop_company_details('farby-export')), 'a hidden shop shows nothing';
end $$;
reset role;
update public.shops set is_active = true where slug = 'farby-export';

-- ------------------------------------------------------------------ update 49: inventory program over an API
\echo '--- inventory API: connection, key never readable, one source, approval, safe runs (update 49)'
do $$
declare
  v_shop uuid;
  v_free uuid;
begin
  insert into public.shops (slug, name, address, city, country, timezone, location, phone, opening_hours, is_active)
  select 'farby-api', 'Farby API', address, city, country, timezone, location, phone, opening_hours, true
  from public.shops where slug = 'potraviny-centrum' returning id into v_shop;
  insert into public.shop_members (shop_id, user_id) values (v_shop, '00000000-0000-0000-0000-00000000000a');
  perform public.apply_stripe_subscription(v_shop, 'cus_INV1', 'sub_INV1', 'active', 'pro', now() + interval '30 days', null);
  insert into public.shops (slug, name, address, city, country, timezone, location, phone, opening_hours, is_active)
  select 'farby-api-free', 'Farby API Free', address, city, country, timezone, location, phone, opening_hours, true
  from public.shops where slug = 'potraviny-centrum' returning id into v_free;
  insert into public.shop_members (shop_id, user_id) values (v_free, '00000000-0000-0000-0000-00000000000a');
  -- the defaults: Pro on every 15 minutes, Free off; SuperFaktúra at least hourly; Shoptet / Dotykačka not built
  assert (select allowed and interval_minutes = 15 from public.inventory_plan_settings where plan = 'pro');
  assert (select not allowed and interval_minutes = 1440 from public.inventory_plan_settings where plan = 'free');
  assert (select not built and not enabled from public.inventory_providers where code = 'shoptet');
  assert extract(epoch from public.inventory_interval(v_shop, 'superfaktura')) = 3600, 'the provider''s request limit';
  assert extract(epoch from public.inventory_interval(v_shop, 'woocommerce')) = 900;
  begin update public.inventory_providers set enabled = true where code = 'dotykacka'; raise exception 'enabled unbuilt';
  exception when check_violation then null; end;
end $$;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-api');
  v_free uuid := (select id from public.shops where slug = 'farby-api-free');
  v_card jsonb;
begin
  assert public.owner_inventory_can_connect(v_shop, 'woocommerce') = 'ok';
  assert public.owner_inventory_can_connect(v_free, 'woocommerce') = 'plan', 'Free: not by default';
  assert public.owner_inventory_can_connect(v_shop, 'shoptet') = 'provider', 'Pripravujeme';
  v_card := public.owner_inventory_api(v_shop);
  assert (v_card ->> 'allowed')::boolean and v_card -> 'connection' = 'null'::jsonb, v_card::text;
  assert (select (e ->> 'available')::boolean from jsonb_array_elements(v_card -> 'providers') e where e ->> 'code' = 'shoptet') = false;
  -- owners never write a connection themselves
  begin insert into public.inventory_connections (shop_id, provider, key_cipher) values (v_shop, 'custom', 'v1.a.b');
    raise exception 'owner inserted'; exception when insufficient_privilege then null; end;
  begin perform public.inventory_save_connection(v_shop, 'custom', 'v1.a.b', '1234', '{}'); raise exception 'service fn callable';
  exception when insufficient_privilege then null; end;
  begin perform public.owner_inventory_approve(v_shop, '{}'::jsonb); raise exception 'approved nothing';
  exception when no_data_found then null; end;
end $$;
reset role;

-- the function saves a tested key and the preview
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-api');
begin
  perform public.inventory_save_connection(v_shop, 'woocommerce', 'v1.aXY.c2VjcmV0', 'ab12', '{"store_url":"https://obchod.example"}');
  assert (select status from public.inventory_connections where shop_id = v_shop) = 'preview';
  assert public.inventory_save_preview(v_shop, array['id', 'sku', 'name', 'price', 'stock_quantity', 'purchase_price'],
    '[{"sku":"A1","name":"Farba","price":"9.90","stock_quantity":3,"purchase_price":"5"}]', 120, true,
    '{"source_code":"sku","name":"name","price":"price","quantity":"stock_quantity"}') = 'ok';
  assert not (select 'purchase_price' = any (fields) from public.inventory_connections where shop_id = v_shop), 'private field dropped';
  assert not ((select sample_rows -> 0 from public.inventory_connections where shop_id = v_shop) ? 'purchase_price'), 'not in the preview';
  -- one source: no folder sync, no upload while connected
end $$;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-api');
  v_card jsonb;
begin
  begin perform public.upload_check_in(v_shop); raise exception 'upload while connected';
  exception when object_not_in_prerequisite_state then assert sqlerrm = 'api_connected'; end;
  -- the key column is not readable, everything else is
  begin perform (select key_cipher from public.inventory_connections where shop_id = v_shop); raise exception 'key readable';
  exception when insufficient_privilege then null; end;
  assert (select key_hint from public.inventory_connections where shop_id = v_shop) = 'ab12';
  v_card := public.owner_inventory_api(v_shop);
  assert not (v_card -> 'connection' ? 'key_cipher') and v_card::text not like '%c2VjcmV0%', 'the card has no key';
  assert v_card #>> '{connection,status}' = 'preview' and v_card #>> '{connection,mapping_status}' = 'proposed';
  -- nothing runs before the approval
  begin perform public.owner_inventory_sync_now(v_shop); raise exception 'synced before approval';
  exception when invalid_parameter_value then assert sqlerrm = 'not_active'; end;
  -- a mapping must use the API's fields, never a private one, and have code, name, price and quantity
  begin perform public.owner_inventory_approve(v_shop, '{"source_code":"sku","name":"name","price":"price"}'); raise exception 'no quantity';
  exception when invalid_parameter_value then assert sqlerrm = 'mapping'; end;
  begin perform public.owner_inventory_approve(v_shop, '{"source_code":"sku","name":"name","price":"purchase_price","quantity":"stock_quantity"}');
    raise exception 'private field approved'; exception when invalid_parameter_value then null; end;
  begin perform public.owner_inventory_approve(v_shop, '{"source_code":"sku","name":"nope","price":"price","quantity":"stock_quantity"}');
    raise exception 'unknown field approved'; exception when invalid_parameter_value then null; end;
  begin perform public.owner_inventory_approve(v_shop, '{"source_code":"sku","name":"name","price":"price"}', true);
    raise exception 'without quantity although it has one'; exception when invalid_parameter_value then null; end;
  perform public.owner_inventory_approve(v_shop, '{"source_code":"sku","name":"name","price":"price","quantity":"stock_quantity","ean":null}');
  assert (select status = 'active' and mapping_status = 'confirmed' and not (mapping ? 'ean') from public.inventory_connections where shop_id = v_shop);
  assert exists (select 1 from public.shop_activity where shop_id = v_shop and action = 'inventory_api_approved');
end $$;
reset role;

-- runs: claimed once, complete data applied, empty / older never, failures back off, an invalid key stops
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-api');
  v_r jsonb;
  v_next timestamptz;
begin
  assert (select count(*) from public.inventory_claim(10, v_shop)) = 1, 'due';
  assert (select count(*) from public.inventory_claim(10, v_shop)) = 0, 'never two runs at once';
  v_r := public.inventory_apply(v_shop, '[{"source_code":"A1","name":"Farba biela","quantity":3,"price":9.9,"currency":"EUR"},
                                          {"source_code":"A2","name":"Štetec","quantity":0,"price":2.5,"currency":"EUR"}]',
                                '2026-10-27 10:00:00+00', '[{"sku":"A1"}]');
  assert v_r ->> 'status' = 'updated' and (v_r ->> 'items')::int = 2 and (v_r ->> 'changed')::int = 2, v_r::text;
  assert (select public.freshness_label(latest_file_time) from public.sync_sources where shop_id = v_shop) is not null;
  assert (select last_file_name from public.sync_sources where shop_id = v_shop) = 'API · woocommerce';
  -- the same or older data again: refused
  assert public.inventory_apply(v_shop, '[{"source_code":"A1","name":"Farba biela","quantity":0,"price":9.9}]',
                                '2026-10-27 10:00:00+00', null) ->> 'status' = 'older';
  -- an empty result is never "everything sold out"
  assert public.inventory_apply(v_shop, '[]', '2026-10-27 11:00:00+00', null) ->> 'status' = 'empty';
  assert (select inv.quantity from public.inventory inv join public.shop_items si on si.id = inv.shop_item_id
          where si.shop_id = v_shop and si.source_code = 'A1') = 3, 'stock kept';
  perform public.inventory_record_import(v_shop, 'API · WooCommerce', '2026-10-27 10:00:00+00', 'ok', 2, 2, 0, 0, null,
    '[{"sku":"A1","name":"Farba biela","price":"9.9","stock_quantity":3,"purchase_price":"5"}]');
  assert (select source = 'api' and not (preview -> 0 ? 'purchase_price') from public.stock_imports
          where shop_id = v_shop order by id desc limit 1), 'the report: source api, approved fields only';
  perform public.inventory_finish(v_shop, '{"kind":"ok","items":2,"changed":2}');
  assert (select running_since is null and last_success_at is not null and next_run_at > now() + interval '14 minutes'
          from public.inventory_connections where shop_id = v_shop);
  -- a warning (incomplete data): nothing applied, the next run as usual
  perform public.inventory_finish(v_shop, '{"kind":"warning","code":"incomplete","message":"Not all pages"}');
  assert (select last_error_code = 'incomplete' and fail_count = 0 from public.inventory_connections where shop_id = v_shop);
  -- failures: 5 min, then 10, logged once
  perform public.inventory_finish(v_shop, '{"kind":"error","code":"network","message":"timeout"}');
  select next_run_at into v_next from public.inventory_connections where shop_id = v_shop;
  assert v_next between now() + interval '4 minutes' and now() + interval '6 minutes', v_next::text;
  perform public.inventory_finish(v_shop, '{"kind":"error","code":"network","message":"timeout"}');
  assert (select next_run_at between now() + interval '9 minutes' and now() + interval '11 minutes' from public.inventory_connections where shop_id = v_shop);
  perform public.inventory_finish(v_shop, '{"kind":"error","code":"rate_limited","message":"429","retry_after":7200}');
  assert (select next_run_at > now() + interval '119 minutes' from public.inventory_connections where shop_id = v_shop), 'Retry-After';
  assert (select count(*) from public.shop_activity where shop_id = v_shop and action = 'inventory_api_error') = 1, 'logged once';
  perform public.inventory_finish(v_shop, '{"kind":"ok","items":2,"changed":0}');
  assert exists (select 1 from public.shop_activity where shop_id = v_shop and action = 'inventory_api_recovered');
  -- an invalid key stops the runs; after 24 h one e-mail
  perform public.inventory_finish(v_shop, '{"kind":"error","code":"invalid_key","message":"401"}');
  assert (select status = 'invalid_key' and next_run_at is null from public.inventory_connections where shop_id = v_shop);
  assert (select count(*) from public.inventory_claim(10, v_shop)) = 0, 'no runs with an invalid key';
  assert not exists (select 1 from public.inventory_alerts_due() where shop_id = v_shop), 'not before 24 h';
  update public.inventory_connections set invalid_since = now() - interval '25 hours' where shop_id = v_shop;
  assert (select emails from public.inventory_alerts_due() where shop_id = v_shop) = array['owner-a@example.invalid'];
  perform public.inventory_alert_sent(v_shop);
  assert not exists (select 1 from public.inventory_alerts_due() where shop_id = v_shop), 'once';
  -- a new valid key brings it back, mapping kept
  perform public.inventory_save_connection(v_shop, 'woocommerce', 'v1.bmV3.a2V5', 'cd34', '{"store_url":"https://obchod.example"}');
  assert (select status = 'active' and mapping_status = 'confirmed' and invalid_since is null from public.inventory_connections where shop_id = v_shop);
  -- the fields changed: asked again, never approved by itself
  assert public.inventory_save_preview(v_shop, array['id', 'code', 'title', 'price'], '[]', 10, false, '{"source_code":"code"}') = 'changed';
  assert (select status = 'preview' and mapping_status = 'proposed' from public.inventory_connections where shop_id = v_shop);
  assert public.inventory_apply(v_shop, '[{"source_code":"A1","name":"x","quantity":0,"price":1}]', now(), null) ->> 'status' = 'not_active';
end $$;

-- a provider without quantities: names and prices only, never an availability
do $$
declare
  v_free uuid := (select id from public.shops where slug = 'farby-api-free');
begin
  update public.inventory_plan_settings set allowed = true where plan = 'free';
  perform public.inventory_save_connection(v_free, 'custom', 'v1.YQ.Yg', '9999', '{"format":"json"}');
  perform public.inventory_save_preview(v_free, array['code', 'title', 'price'], '[]', 1, false, '{"source_code":"code","name":"title","price":"price"}');
end $$;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_free uuid := (select id from public.shops where slug = 'farby-api-free');
begin
  perform public.owner_inventory_approve(v_free, '{"source_code":"code","name":"title","price":"price"}', true);
  assert (select publish_without_quantity from public.inventory_connections where shop_id = v_free);
end $$;
reset role;
do $$
declare
  v_free uuid := (select id from public.shops where slug = 'farby-api-free');
begin
  assert public.inventory_apply(v_free, '[{"source_code":"P1","name":"Lak","price":4.2,"currency":"EUR"}]', now(), null) ->> 'status' = 'updated';
  assert (select public.freshness_label(latest_file_time) from public.sync_sources where shop_id = v_free) = 'stale',
    'the data time is not renewed: no availability is shown';
  assert (select availability is null and price = 4.2 from public.public_stock where shop_slug = 'farby-api-free' and item_name = 'Lak');
  update public.inventory_plan_settings set allowed = false where plan = 'free';
  assert (select count(*) from public.inventory_claim(10, v_free)) = 0, 'Free switched off: no runs';
end $$;

-- another owner and visitors: nothing
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-api');
begin
  assert not exists (select 1 from public.inventory_connections where shop_id = v_shop), 'B sees no connection of A';
  begin perform public.owner_inventory_api(v_shop); raise exception 'B read'; exception when insufficient_privilege then null; end;
  begin perform public.owner_inventory_disconnect(v_shop); raise exception 'B disconnected'; exception when insufficient_privilege then null; end;
  begin perform public.owner_inventory_sync_now(v_shop); raise exception 'B synced'; exception when insufficient_privilege then null; end;
  begin perform public.owner_inventory_approve(v_shop, '{}'); raise exception 'B approved'; exception when insufficient_privilege then null; end;
  begin perform public.admin_inventory_overview(); raise exception 'not admin'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set role anon;
do $$
begin
  begin perform (select provider from public.inventory_connections limit 1); raise exception 'anon read';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- the admin: settings, providers, the list without keys
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000ad';
do $$
declare
  v_o jsonb;
begin
  perform public.admin_save_inventory_settings(30, true, 720);
  assert (select (e ->> 'interval_minutes')::int from jsonb_array_elements(public.admin_inventory_overview() -> 'plans') e where e ->> 'plan' = 'pro') = 30;
  perform public.admin_set_inventory_provider('shoptet', true);
  assert (select not (e ->> 'enabled')::boolean from jsonb_array_elements(public.admin_inventory_overview() -> 'providers') e where e ->> 'code' = 'shoptet'), 'not built: stays off';
  perform public.admin_set_inventory_provider('woocommerce', false);
  v_o := public.admin_inventory_overview();
  assert jsonb_array_length(v_o -> 'connections') >= 2 and v_o::text not like '%v1.%' and v_o::text not like '%cd34%', 'no keys';
  perform public.admin_set_inventory_provider('woocommerce', true);
  perform public.admin_save_inventory_settings(15, false, 1440);
end $$;
reset role;

-- sync now: 4 an hour; disconnect deletes the key and frees the uploads
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-api');
begin
  perform public.owner_inventory_approve(v_shop, '{"source_code":"code","name":"title","price":"price"}', false)
  ;
exception when invalid_parameter_value then null; -- no quantity field any more: refused (checked above)
end $$;
reset role;
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-api');
begin
  perform public.inventory_save_preview(v_shop, array['sku', 'name', 'price', 'stock_quantity'], '[]', 2, true,
    '{"source_code":"sku","name":"name","price":"price","quantity":"stock_quantity"}');
end $$;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'farby-api');
begin
  perform public.owner_inventory_approve(v_shop, '{"source_code":"sku","name":"name","price":"price","quantity":"stock_quantity"}');
  for i in 1..4 loop perform public.owner_inventory_sync_now(v_shop); end loop;
  begin perform public.owner_inventory_sync_now(v_shop); raise exception 'fifth sync';
  exception when program_limit_exceeded then assert sqlerrm = 'too_many'; end;
  perform public.owner_inventory_disconnect(v_shop);
  assert not exists (select 1 from public.inventory_connections where shop_id = v_shop), 'the key is gone';
  assert exists (select 1 from public.shop_activity where shop_id = v_shop and action = 'inventory_api_disconnected');
  perform public.upload_check_in(v_shop);
end $$;
reset role;

\echo 'ALL DATABASE CHECKS PASSED'
