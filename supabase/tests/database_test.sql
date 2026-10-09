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
      and column_name in ('ico', 'visibility_mode', 'low_stock_threshold', 'is_active', 'location')
  ), 'public_shops exposes a private column';
  assert (select freshness_state from public.public_shops where slug = 'zeleziarstvo-vychod') = 'stale';
  assert (select round(lat::numeric, 3) from public.public_shops where slug = 'kisbolt-budapest') = 47.499;

  -- amenities are public
  assert (select has_toilet and has_douchette and has_card_terminal from public.public_shops where slug = 'potraviny-centrum');
  assert (select not has_toilet and has_card_terminal from public.public_shops where slug = 'kisbolt-budapest');

  -- shop_stock: paging, total count, accent-insensitive filter, hidden items excluded
  select count(*) into n from public.shop_stock('potraviny-centrum');
  assert n = 6, format('shop page should list 6 public items (1 hidden), got %s', n);
  assert (select max(total_count) from public.shop_stock('potraviny-centrum', null, 2, 0)) = 6;
  select count(*) into n from public.shop_stock('potraviny-centrum', null, 2, 4);
  assert n = 2, 'third page of 2 should have 2 rows';
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
  begin
    perform * from public.admin_shops();
    raise exception 'anon ran admin_shops';
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

  -- owners set their own amenities, never another shop's
  update public.shops set has_toilet = false, has_card_terminal = true where slug = 'potraviny-centrum';
  get diagnostics n = row_count;
  assert n = 1, 'owner should set own amenities';
  update public.shops set has_toilet = true where slug = 'drogeria-kostolne';
  get diagnostics n = row_count;
  assert n = 0, 'owner A changed shop B amenities';
  update public.shops set has_toilet = true where slug = 'potraviny-centrum';

  -- dashboard item list: own shop incl. hidden items, never another shop's
  select count(*) into n from public.owner_items((select id from public.shops where slug = 'potraviny-centrum'));
  assert n = 7, format('owner should see all 7 own items incl. hidden, got %s', n);
  assert (select availability from public.owner_items((select id from public.shops where slug = 'potraviny-centrum'), 'kava zrnkova')) = 'in_stock';
  select count(*) into n from public.owner_items((select id from public.shops s where s.slug = 'drogeria-kostolne'));
  assert n = 0, 'owner A listed shop B items';

  -- visibility preview comes from availability_label()
  assert (select string_agg(coalesce(label, '-'), ',') from public.availability_preview(3))
         = 'in_stock_count,in_stock_count,out_of_stock,in_stock,low_stock,out_of_stock,available,available,not_available';

  -- admin-only functions refuse owners
  begin
    perform * from public.admin_shops();
    raise exception 'owner ran admin_shops';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.admin_save_shop('{"slug":"x","name":"x"}');
    raise exception 'owner ran admin_save_shop';
  exception when insufficient_privilege then null;
  end;
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

  -- admin list, owners, create + edit a shop
  assert (select count(*) from public.admin_shops()) = 4;
  assert (select owner_count from public.admin_shops() where slug = 'potraviny-centrum') = 1;
  assert (select email from public.admin_shop_owners((select id from public.shops where slug = 'potraviny-centrum')))
         = 'owner-a@example.invalid';
  declare v_id uuid;
  begin
    v_id := public.admin_save_shop(jsonb_build_object(
      'slug', 'test-wien', 'name', 'Test Wien', 'city', 'Wien', 'country', 'at',
      'timezone', 'Europe/Vienna', 'lat', '48.2082', 'lng', '16.3738', 'is_active', 'false',
      'opening_hours', '{"mon":[["09:00","18:00"]]}'::jsonb));
    assert (select country || ' ' || round(lat::numeric, 2) from public.admin_shops() where id = v_id) = 'AT 48.21';
    assert exists (select 1 from public.sync_sources where shop_id = v_id), 'new shop needs a sync source row';
    perform public.admin_save_shop(jsonb_build_object('id', v_id, 'slug', 'test-wien', 'name', 'Test Wien 2',
      'timezone', 'Europe/Vienna', 'is_active', 'true'));
    assert (select name || ' ' || is_active from public.shops where id = v_id) = 'Test Wien 2 true';
    perform public.admin_save_shop(jsonb_build_object('id', v_id, 'slug', 'test-wien', 'name', 'Test Wien 2',
      'timezone', 'Europe/Vienna', 'is_active', 'true', 'has_toilet', 'true', 'has_card_terminal', 'true'));
    assert (select has_toilet and not has_douchette and has_card_terminal from public.admin_shops() where id = v_id),
      'admin_save_shop should save amenities';
    begin
      perform public.admin_save_shop(jsonb_build_object('id', v_id, 'slug', 'test-wien', 'name', 'x', 'lat', '95', 'lng', '0'));
      raise exception 'invalid coordinates accepted';
    exception when invalid_parameter_value then null;
    end;
    delete from public.shops where id = v_id;
  end;
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
  -- hidden items stay hidden after a pull
  assert (select not is_public from public.shop_items where shop_id = v_shop and source_code = 'P007');
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

\echo 'ALL DATABASE CHECKS PASSED'
