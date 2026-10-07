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

\echo '--- cloud link: owners set their own'
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare
  v_shop uuid := (select id from public.shops where slug = 'potraviny-centrum');
  v_bad text;
begin
  perform public.owner_set_file_url(v_shop, ' https://drive.google.com/uc?export=download&id=abc ');
  assert (select file_url from public.my_shops() where id = v_shop) = 'https://drive.google.com/uc?export=download&id=abc';
  foreach v_bad in array array['http://example.com/a.csv', 'https://localhost/a.csv', 'https://127.0.0.1/a.csv',
                                'https://10.0.0.1/x', 'ftp://example.com/a.csv', 'https://intranet/a.csv'] loop
    begin
      perform public.owner_set_file_url(v_shop, v_bad);
      raise exception 'accepted %', v_bad;
    exception when invalid_parameter_value then null;
    end;
  end loop;
  begin
    perform public.owner_set_file_url((select id from public.shops where slug = 'drogeria-kostolne'), 'https://example.com/a.csv');
    raise exception 'owner A set shop B link';
  exception when insufficient_privilege then null;
  end;
  perform public.owner_set_file_url(v_shop, '');
  assert (select file_url is null from public.my_shops() where id = v_shop), 'empty text clears the link';
end $$;
reset role;
reset request.jwt.claim.sub;

\echo 'ALL DATABASE CHECKS PASSED'
