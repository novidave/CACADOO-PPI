-- PPI · 33 · Shops on their own domains, easy to find (Google Search Console, llms.txt, IndexNow).
--  Paste the whole file into the Supabase SQL Editor and Run. Needs update 25 (own domains). Safe to run again.
--  - domain_orders: the Google Search Console value the owner pasted (google-site-verification=…) and whether the
--    domains function wrote it into the domain's DNS ("added") or the owner adds it at their registrar ("manual");
--    the IndexNow bookkeeping (the upload last announced, when, how many addresses, the answer). Written only by the
--    Edge Functions (service role); owners read their own rows as before.
--  - domain_settings.indexnow_key: one random IndexNow key, served as https://<domain>/<key>.txt on every own domain
--    (public by design: the search engines read it there); indexnow_key() reads it.
--  - inventory.changed_at / shop_items.changed_at: when quantity, price or currency (inventory) or the name, EAN or brand
--    (item) last changed — set by triggers, so a stock upload that rewrites every row marks only what really changed.
--  - indexnow_claim(shop): after a stock upload, once per upload, the live own domain of the shop and the items that
--    changed in that upload (≤ 10 000); indexnow_sent() notes the answer of the request (none is sent when nothing
--    changed). Service role only (stock-pull).
--  - shops.product_categories: "Kategórie tovaru" for llms.txt, written by the owner (owner_set_categories(); plain
--    text, ≤ 12, each ≤ 40 characters); shop_llms_facts(slug): those categories, the brands and the item count of the
--    shop's stock file, for the domain's llms.txt.

-- ------------------------------------------------------------------ 1. Google Search Console

alter table public.domain_orders add column if not exists google_verification text;
alter table public.domain_orders add column if not exists google_verification_state text;
alter table public.domain_orders add column if not exists google_verification_at timestamptz;

alter table public.domain_orders drop constraint if exists domain_orders_google_verification;
alter table public.domain_orders add constraint domain_orders_google_verification check (
  google_verification is null or google_verification ~ '^google-site-verification=[A-Za-z0-9_-]{20,100}$');
alter table public.domain_orders drop constraint if exists domain_orders_google_state;
alter table public.domain_orders add constraint domain_orders_google_state check (
  (google_verification is null) = (google_verification_state is null)
  and (google_verification_state is null or google_verification_state in ('added', 'manual')));

-- ------------------------------------------------------------------ 2. IndexNow

alter table public.domain_orders add column if not exists indexnow_upload_at timestamptz;
alter table public.domain_orders add column if not exists indexnow_at timestamptz;
alter table public.domain_orders add column if not exists indexnow_urls integer;
alter table public.domain_orders add column if not exists indexnow_result text;
alter table public.domain_orders drop constraint if exists domain_orders_indexnow_result;
alter table public.domain_orders add constraint domain_orders_indexnow_result check (
  indexnow_result is null or length(indexnow_result) <= 200);

alter table public.domain_settings add column if not exists indexnow_key text;
update public.domain_settings set indexnow_key = replace(gen_random_uuid()::text, '-', '') where indexnow_key is null;
alter table public.domain_settings drop constraint if exists domain_settings_indexnow_key;
alter table public.domain_settings add constraint domain_settings_indexnow_key check (
  indexnow_key is null or indexnow_key ~ '^[A-Za-z0-9-]{8,128}$');

/** The IndexNow key: public by design (https://<domain>/<key>.txt proves the domain is ours). */
create or replace function public.indexnow_key()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.indexnow_key from public.domain_settings s where s.id
$$;
revoke execute on function public.indexnow_key() from public;
grant execute on function public.indexnow_key() to anon, authenticated, service_role;

-- What changed in a stock upload: apply_stock_file() rewrites every row, the triggers keep the time of the last
-- real change (in the upload's own transaction, so it equals that upload's received_at).
alter table public.inventory add column if not exists changed_at timestamptz;
alter table public.shop_items add column if not exists changed_at timestamptz;

create or replace function public.track_inventory_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT'
     or new.quantity is distinct from old.quantity
     or new.price is distinct from old.price
     or new.currency is distinct from old.currency then
    new.changed_at := now();
  else
    new.changed_at := old.changed_at;
  end if;
  return new;
end;
$$;
revoke execute on function public.track_inventory_change() from public, anon, authenticated;
drop trigger if exists inventory_track_change on public.inventory;
create trigger inventory_track_change before insert or update on public.inventory
  for each row execute function public.track_inventory_change();

create or replace function public.track_item_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT'
     or new.name is distinct from old.name
     or new.ean is distinct from old.ean
     or new.brand is distinct from old.brand then
    new.changed_at := now();
  else
    new.changed_at := old.changed_at;
  end if;
  return new;
end;
$$;
revoke execute on function public.track_item_change() from public, anon, authenticated;
drop trigger if exists shop_items_track_change on public.shop_items;
create trigger shop_items_track_change before insert or update on public.shop_items
  for each row execute function public.track_item_change();

/**
 * After a stock upload (stock-pull, in the background): the shop's live own domain (the same rule as shop_site())
 * and the items whose quantity, price, currency, name, EAN or brand changed in its latest upload. Once per upload:
 * a second call for the same upload returns null, so IndexNow is pinged at most once per upload.
 */
create or replace function public.indexnow_claim(p_shop_id uuid, p_limit integer default 10000)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order uuid;
  v_host text;
  v_lang text;
  v_key text := public.indexnow_key();
  v_upload timestamptz;
  v_items jsonb;
begin
  select o.id, o.site_host, public.shop_site_lang(s.country) into v_order, v_host, v_lang
  from public.domain_orders o
  join public.shops s on s.id = o.shop_id
  where o.shop_id = p_shop_id and o.status = 'live' and o.site_host is not null and s.is_active and public.shop_has_plan(s.id)
  limit 1;
  if v_order is null or v_key is null then
    return null;
  end if;

  -- Every row an upload writes carries that upload's time.
  select max(inv.received_at) into v_upload
  from public.inventory inv
  join public.shop_items si on si.id = inv.shop_item_id
  where si.shop_id = p_shop_id;
  if v_upload is null then
    return null;
  end if;

  -- The last request's answer (indexnow_at, _urls, _result) stays until the next request is answered.
  update public.domain_orders
  set indexnow_upload_at = v_upload
  where id = v_order and (indexnow_upload_at is null or indexnow_upload_at < v_upload);
  if not found then
    return null;
  end if;

  select coalesce(jsonb_agg(x.id), '[]'::jsonb) into v_items
  from (
    select si.id
    from public.shop_items si
    join public.inventory inv on inv.shop_item_id = si.id
    where si.shop_id = p_shop_id and (inv.changed_at = v_upload or si.changed_at = v_upload)
    order by si.id
    limit greatest(1, least(coalesce(p_limit, 10000), 10000))
  ) x;

  return jsonb_build_object('order_id', v_order, 'host', v_host, 'lang', v_lang, 'key', v_key,
                            'upload_at', v_upload, 'items', v_items);
end;
$$;
revoke execute on function public.indexnow_claim(uuid, integer) from public, anon, authenticated;
grant execute on function public.indexnow_claim(uuid, integer) to service_role;

/** The answer of the IndexNow ping for that upload (the number of addresses sent and the HTTP status). */
create or replace function public.indexnow_sent(p_order_id uuid, p_upload_at timestamptz, p_urls integer, p_result text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.domain_orders
  set indexnow_urls = greatest(coalesce(p_urls, 0), 0), indexnow_result = left(coalesce(p_result, ''), 200), indexnow_at = now()
  where id = p_order_id and indexnow_upload_at = p_upload_at
$$;
revoke execute on function public.indexnow_sent(uuid, timestamptz, integer, text) from public, anon, authenticated;
grant execute on function public.indexnow_sent(uuid, timestamptz, integer, text) to service_role;

-- ------------------------------------------------------------------ 3. categories for llms.txt

alter table public.shops add column if not exists product_categories text[];

create or replace function public.valid_categories(p_list text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_list is null or (
    cardinality(p_list) between 1 and 12
    and not exists (select 1 from unnest(p_list) c where c is null or btrim(c) = '' or length(c) > 40 or c ~ '[<>]'))
$$;
revoke execute on function public.valid_categories(text[]) from public;
grant execute on function public.valid_categories(text[]) to anon, authenticated, service_role;

alter table public.shops drop constraint if exists shops_product_categories_check;
alter table public.shops add constraint shops_product_categories_check check (public.valid_categories(product_categories));

/** "Kategórie tovaru" as typed (commas, semicolons or lines): plain text, duplicates once, ≤ 12, each ≤ 40. */
create or replace function public.clean_categories(p_value text)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_out text[] := '{}';
  v_part text;
  v_clean text;
begin
  foreach v_part in array regexp_split_to_array(coalesce(p_value, ''), '[,;\n\r]+') loop
    v_clean := public.plain_text(v_part, 1000);
    if v_clean is null then
      continue;
    end if;
    if length(v_clean) > 40 then
      raise exception 'categories' using errcode = '22023';
    end if;
    if exists (select 1 from unnest(v_out) c where lower(c) = lower(v_clean)) then
      continue;
    end if;
    v_out := v_out || v_clean;
  end loop;
  if cardinality(v_out) > 12 then
    raise exception 'categories' using errcode = '22023';
  end if;
  return nullif(v_out, '{}'::text[]);
end;
$$;
revoke execute on function public.clean_categories(text) from public;
grant execute on function public.clean_categories(text) to authenticated, service_role;

/** The categories are changed only through owner_set_categories(). */
create or replace function public.guard_shop_categories()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_client_request() and new.product_categories is distinct from old.product_categories then
    raise exception 'product_categories is changed only through owner_set_categories()' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_shop_categories() from public, anon, authenticated;
drop trigger if exists shops_guard_categories on public.shops;
create trigger shops_guard_categories before update of product_categories on public.shops
  for each row execute function public.guard_shop_categories();

create or replace function public.owner_set_categories(p_shop_id uuid, p_categories text)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_list text[] := public.clean_categories(p_categories);
begin
  if auth.uid() is null or not public.is_shop_member(p_shop_id) then
    raise exception 'Not your shop' using errcode = '42501';
  end if;
  update public.shops set product_categories = v_list where id = p_shop_id;
  return v_list;
end;
$$;
revoke execute on function public.owner_set_categories(uuid, text) from public, anon;
grant execute on function public.owner_set_categories(uuid, text) to authenticated;

/** What the own domain's llms.txt says about the shop's goods: the owner's categories, the stock file's brands. */
create or replace function public.shop_llms_facts(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'categories', coalesce(to_jsonb(s.product_categories), '[]'::jsonb),
    'brands', (
      select coalesce(jsonb_agg(b.brand order by b.n desc, b.brand), '[]'::jsonb)
      from (
        select si.brand, count(*) as n
        from public.shop_items si
        join public.inventory inv on inv.shop_item_id = si.id
        where si.shop_id = s.id and nullif(btrim(si.brand), '') is not null
        group by si.brand
        order by count(*) desc, si.brand
        limit 15
      ) b),
    'items', (
      select count(*)
      from public.shop_items si
      join public.inventory inv on inv.shop_item_id = si.id
      where si.shop_id = s.id))
  from public.shops s
  where s.slug = p_slug and s.is_active
$$;
revoke execute on function public.shop_llms_facts(text) from public;
grant execute on function public.shop_llms_facts(text) to anon, authenticated, service_role;
