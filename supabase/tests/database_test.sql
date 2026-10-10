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
    for v_line in execute 'explain select id from public.shop_items where public.item_names_text(name, name_i18n) like ''%white%''' loop
      v_plan := v_plan || v_line."QUERY PLAN" || ' ';
    end loop;
    assert v_plan like '%shop_items_names_search_idx%', 'name search uses the index: ' || v_plan;
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

-- keys: each opens only its folders, for 12 hours, until revoked or expired
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
  assert (v_r ->> 'expires_at')::timestamptz between now() + interval '11 hours 59 minutes' and now() + interval '12 hours 1 minute';
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
  assert public.shop_file_path(v_slug, 'picture', current_setting('ppi.pic_s')::uuid, v_all) is not null;
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

\echo 'ALL DATABASE CHECKS PASSED'
