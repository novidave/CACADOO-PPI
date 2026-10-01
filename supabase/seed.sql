-- PPI · TEST DATA ONLY. Do not run on the live project after launch.
-- Three shops in Michalovce, one per freshness state:
--   potraviny-centrum   file 10 min old  -> current   (mode: in_stock)
--   drogeria-kostolne   file 3 h old     -> recent    (mode: exact)
--   zeleziarstvo-vychod file 25 h old    -> stale     (mode: yes_no)
-- Times are relative to when you run this, so re-run it to reset them.

delete from public.shops
where slug in ('potraviny-centrum', 'drogeria-kostolne', 'zeleziarstvo-vychod');

insert into public.shops
  (slug, name, ico, address, city, location, phone, website, opening_hours,
   visibility_mode, low_stock_threshold, is_active)
values
  ('potraviny-centrum', 'Potraviny Centrum', '12345678', 'Námestie osloboditeľov 10',
   'Michalovce', 'SRID=4326;POINT(21.9185 48.7547)', '+421 56 000 0001', null,
   '{"mon":[["07:00","18:00"]],"tue":[["07:00","18:00"]],"wed":[["07:00","18:00"]],"thu":[["07:00","18:00"]],"fri":[["07:00","18:00"]],"sat":[["07:00","12:00"]],"sun":[]}',
   'in_stock', 3, true),
  ('drogeria-kostolne', 'Drogéria Kostolné', '23456789', 'Kostolné námestie 4',
   'Michalovce', 'SRID=4326;POINT(21.9140 48.7570)', '+421 56 000 0002', null,
   '{"mon":[["08:00","12:00"],["13:00","17:00"]],"tue":[["08:00","12:00"],["13:00","17:00"]],"wed":[["08:00","12:00"],["13:00","17:00"]],"thu":[["08:00","12:00"],["13:00","17:00"]],"fri":[["08:00","12:00"],["13:00","17:00"]],"sat":[],"sun":[]}',
   'exact', 3, true),
  ('zeleziarstvo-vychod', 'Železiarstvo Východ', '34567890', 'Užhorodská 25',
   'Michalovce', 'SRID=4326;POINT(21.9350 48.7520)', '+421 56 000 0003', null,
   '{"mon":[["08:00","17:00"]],"tue":[["08:00","17:00"]],"wed":[["08:00","17:00"]],"thu":[["08:00","17:00"]],"fri":[["08:00","17:00"]],"sat":[["08:00","12:00"]],"sun":[]}',
   'yes_no', 3, true);

insert into public.sync_sources (shop_id, file_format, mapping_status, file_url, latest_file_time, last_checked_at)
select id, 'xml', 'confirmed', 'https://' || slug || '.example.invalid/stock.xml',
       case slug
         when 'potraviny-centrum'   then now() - interval '10 minutes'
         when 'drogeria-kostolne'   then now() - interval '3 hours'
         else                            now() - interval '25 hours'
       end,
       now() - interval '5 minutes'
from public.shops
where slug in ('potraviny-centrum', 'drogeria-kostolne', 'zeleziarstvo-vychod');

-- Items: (shop slug, code, name, brand, ean, quantity, price)
with items (slug, code, name, brand, ean, qty, price) as (
  values
    ('potraviny-centrum', 'P001', 'Káva zrnková 1 kg',          'Lavazza',  '8000070012345', 14, 18.90),
    ('potraviny-centrum', 'P002', 'Káva mletá 250 g',           'Jacobs',   '8711000012346',  2,  4.49),
    ('potraviny-centrum', 'P003', 'Mlieko polotučné 1 l',       'Rajo',     '8586000012347', 40,  1.09),
    ('potraviny-centrum', 'P004', 'Chlieb konzumný 1 kg',       null,       null,             0,  1.89),
    ('potraviny-centrum', 'P005', 'Maslo 250 g',                'Tami',     '8586000012348',  6,  2.79),
    ('potraviny-centrum', 'P006', 'Čokoláda horká 100 g',       'Figaro',   '8586000012349',  1,  1.49),
    ('potraviny-centrum', 'P007', 'Čaj zelený 20 vreciek',      'Pickwick', '8711000012350', 12,  2.29),
    ('drogeria-kostolne', 'D001', 'Zubná pasta 75 ml',          'Colgate',  '8714789012351', 12,  2.49),
    ('drogeria-kostolne', 'D002', 'Šampón na vlasy 400 ml',     'Nivea',    '4005900012352',  2,  4.99),
    ('drogeria-kostolne', 'D003', 'Prací prášok 3 kg',          'Persil',   '9000101012353',  0, 15.90),
    ('drogeria-kostolne', 'D004', 'Káva instantná 200 g',       'Nescafé',  '7613036012354',  5,  6.99),
    ('drogeria-kostolne', 'D005', 'Mydlo tekuté 500 ml',        'Dove',     '8710447012355', 20,  3.29),
    ('zeleziarstvo-vychod', 'Z001', 'Vŕtačka príklepová 750 W', 'Bosch',    '3165140012356',  3, 89.00),
    ('zeleziarstvo-vychod', 'Z002', 'Skrutky do dreva 4x40 200 ks', null,   null,            50,  5.90),
    ('zeleziarstvo-vychod', 'Z003', 'Kladivo 500 g',            'Fiskars',  '6411500012357',  0, 19.90),
    ('zeleziarstvo-vychod', 'Z004', 'Kávovar prekvapkávací',    'Sencor',   '8590669012358',  2, 34.90)
),
new_items as (
  insert into public.shop_items (shop_id, source_code, name, brand, ean)
  select s.id, i.code, i.name, i.brand, i.ean
  from items i
  join public.shops s on s.slug = i.slug
  returning id, shop_id, source_code
)
insert into public.inventory (shop_item_id, quantity, price, source_updated_at)
select ni.id, i.qty, i.price, now() - interval '10 minutes'
from new_items ni
join public.shops s on s.id = ni.shop_id
join items i on i.slug = s.slug and i.code = ni.source_code;

-- One hidden item, to check that is_public = false never shows publicly.
update public.shop_items set is_public = false
where source_code = 'P007'
  and shop_id = (select id from public.shops where slug = 'potraviny-centrum');
