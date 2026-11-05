-- =====================================================================================================================
-- Update 80 — a restaurant's menu (2026-11-05, at the owner's request; the owner's OK for the shop type rule: food menu
-- items are not "stock" and do not use the 24 h stock-file freshness)
--
-- 1. The menu = Sklad products of a shop marked `menu_item` (sklad_items): the owner's own categories (menu_categories,
--    ordered), a short description (shop_items.description), the photo (update 78's product photo), the price with VAT
--    (Sklad's sale price — the ONLY price; food_quote unchanged), sizes as variants (each its own Sklad product with its
--    own price, `menu_parent` + `variant_label`), extras (Sklad products, as food_quote does), allergens 1–14 (the EU
--    list), the tags veg / spicy, `menu_hidden`.
-- 2. Availability: `track_stock` off (dishes, the default) = available unless "Vypredané dnes" (`sold_out_on` = the
--    shop's today, so it ends by itself at the shop's midnight); on (drinks, desserts in pieces) = Sklad's quantity as
--    before. food_item (and so food_quote and food_menu) follows it; an untracked dish is never in public_stock (it is not
--    stock: no freshness, no "Vypredané" from an empty stock) — sklad_apply leaves it out.
-- 3. The owner: owner_menu (the editor), owner_menu_save_category / _delete_category / _order_categories,
--    owner_menu_save_item (a dish with its sizes; only the given fields change), owner_menu_duplicate_item,
--    owner_menu_order_items, owner_menu_set_sold_out; the import from a PDF or a photo: owner_menu_import_hit (10 a day
--    per shop, owner_ai_usage kind menu) and owner_menu_import_save (everything in ONE transaction, after the owner's
--    confirmation; nothing is stored before).
-- 4. Visitors: shop_menu(slug) (active food shops; the dishes, sizes, prices, allergens, tags, sold out today, the
--    photo) and shop_menu_search(slug, q) (update 54's forgiving rule on the menu's names).
-- 5. The owner MCP: list_menu (shop.read) and set_menu_sold_out (shop.write, before → after until confirm: true), a door
--    of their own (update 74's door kept as owner_mcp_call_74). The Telegram bot and the AI pomocník use the same tool.
-- 6. "Nastavenie obchodu": the restaurant's Menu step counts menu dishes with a price.
--
-- Needs updates 54, 63, 67, 73–79. Run the whole file once; running it again is harmless.
-- =====================================================================================================================

-- ------------------------------------------------------------------ 0. the activity log, the AI usage kind

do $$
declare
  v_def text := (select pg_get_constraintdef(c.oid) from pg_constraint c
                 where c.conrelid = 'public.shop_activity'::regclass and c.conname = 'shop_activity_action_check');
  v_add text := '';
  a text;
begin
  if v_def is null then return; end if;
  foreach a in array array['menu_item_saved', 'menu_category_saved', 'menu_sold_out', 'menu_imported'] loop
    if position('''' || a || '''' in v_def) = 0 then v_add := v_add || '''' || a || '''::text, '; end if;
  end loop;
  if v_add <> '' then
    alter table public.shop_activity drop constraint shop_activity_action_check;
    execute 'alter table public.shop_activity add constraint shop_activity_action_check ' || replace(v_def, 'ARRAY[', 'ARRAY[' || v_add);
  end if;
end;
$$;

alter table public.owner_ai_usage drop constraint if exists owner_ai_usage_kind_check;
alter table public.owner_ai_usage add constraint owner_ai_usage_kind_check check (kind in ('grammar', 'assistant', 'blog', 'menu'));

-- ------------------------------------------------------------------ 1. the menu's tables

/** The owner's own categories (Pizza, Polievky, Nápoje …), in their order. */
create table if not exists public.menu_categories (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops (id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  position    integer not null default 0,
  created_at  timestamptz not null default now()
);
create unique index if not exists menu_categories_name_idx on public.menu_categories (shop_id, lower(btrim(name)));
alter table public.menu_categories enable row level security;
revoke all on public.menu_categories from public, anon, authenticated;
grant all on public.menu_categories to service_role;

alter table public.sklad_items add column if not exists menu_item boolean not null default false;
alter table public.sklad_items add column if not exists menu_category uuid references public.menu_categories (id) on delete set null;
alter table public.sklad_items add column if not exists menu_parent uuid references public.shop_items (id) on delete cascade;
alter table public.sklad_items add column if not exists variant_label text;
alter table public.sklad_items add column if not exists menu_position integer not null default 0;
alter table public.sklad_items add column if not exists allergens smallint[] not null default '{}';
alter table public.sklad_items add column if not exists menu_tags text[] not null default '{}';
alter table public.sklad_items add column if not exists track_stock boolean not null default false;
alter table public.sklad_items add column if not exists sold_out_on date;
alter table public.sklad_items add column if not exists menu_hidden boolean not null default false;
alter table public.sklad_items drop constraint if exists sklad_items_variant_label_check;
alter table public.sklad_items add constraint sklad_items_variant_label_check
  check (variant_label is null or char_length(btrim(variant_label)) between 1 and 40);
alter table public.sklad_items drop constraint if exists sklad_items_allergens_check;
alter table public.sklad_items add constraint sklad_items_allergens_check
  check (allergens <@ '{1,2,3,4,5,6,7,8,9,10,11,12,13,14}'::smallint[]);
alter table public.sklad_items drop constraint if exists sklad_items_menu_tags_check;
alter table public.sklad_items add constraint sklad_items_menu_tags_check check (menu_tags <@ array['veg', 'spicy']);
alter table public.sklad_items drop constraint if exists sklad_items_menu_parent_check;
alter table public.sklad_items add constraint sklad_items_menu_parent_check
  check (menu_parent is null or (menu_item and menu_parent <> shop_item_id and variant_label is not null));
create index if not exists sklad_items_menu_idx on public.sklad_items (shop_id, menu_category, menu_position) where menu_item;
create index if not exists sklad_items_menu_parent_idx on public.sklad_items (menu_parent) where menu_parent is not null;

-- "Vypredané dnes" ends at the shop's midnight: shop_today(shop) of update 28 (the shop's own calendar day).

-- ------------------------------------------------------------------ 2. availability: food_item, food_menu, sklad_apply

/**
 * One dish, size or extra for the orders (as update 73, plus the menu): a size is named "<dish> <size>"; a menu item
 * without stock tracking is sold out only while "Vypredané dnes" (itself or its dish) — never from an empty stock; a
 * tracked one (and every other Sklad product) by its quantity; a hidden menu item (or a size of a hidden dish) cannot be
 * ordered. The allergens and tags go along for the assistant.
 */
create or replace function public.food_item(p_shop_id uuid, p_item_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'item_id', si.id,
    'name', case when i.menu_parent is not null then btrim(coalesce(ps.name, '') || ' ' || coalesce(i.variant_label, '')) else si.name end,
    'category', coalesce(mc.name, si.category),
    'price_cents', round(i.sale_price * 100)::integer,
    'sold_out', case when i.menu_item and not i.track_stock
                     then coalesce(i.sold_out_on = public.shop_today(p_shop_id), false) or coalesce(pp.sold_out_on = public.shop_today(p_shop_id), false)
                     else coalesce(t.qty, 0) <= 0 end,
    'allergens', to_jsonb(case when i.menu_parent is not null then coalesce(pp.allergens, '{}') else i.allergens end),
    'tags', to_jsonb(case when i.menu_parent is not null then coalesce(pp.menu_tags, '{}') else i.menu_tags end))
  from public.sklad_items i
  join public.shop_items si on si.id = i.shop_item_id
  left join public.sklad_stock_total t on t.shop_item_id = i.shop_item_id
  left join public.sklad_items pp on pp.shop_item_id = i.menu_parent
  left join public.shop_items ps on ps.id = i.menu_parent
  left join public.menu_categories mc on mc.id = coalesce(pp.menu_category, i.menu_category)
  where i.shop_id = p_shop_id and i.shop_item_id = p_item_id and i.sale_price is not null
    and not (i.menu_item and (i.menu_hidden or coalesce(pp.menu_hidden, false)))
$$;
revoke execute on function public.food_item(uuid, uuid) from public, anon, authenticated;
grant execute on function public.food_item(uuid, uuid) to service_role;

/**
 * The menu for the assistant's food_menu tool (as update 73): Sklad products with a sale price (sizes are separate
 * products, named "<dish> <size>"), hidden menu items left out, sold out marked, in the owner's category order;
 * optionally narrowed by words. Only while the shop has food ordering on.
 */
create or replace function public.food_menu(p_slug text, p_q text default null, p_limit integer default 60)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shop public.shops%rowtype;
  v_q text := nullif(btrim(coalesce(p_q, '')), '');
begin
  select * into v_shop from public.shops where slug = p_slug and is_active;
  if not found or not ((public.food_state(p_slug) ->> 'enabled')::boolean) then
    return jsonb_build_object('enabled', false, 'items', '[]'::jsonb);
  end if;
  return jsonb_build_object('enabled', true, 'items', coalesce((
    select jsonb_agg(x.j order by x.cat_pos nulls last, x.cat nulls last, x.pos, x.name)
    from (
      select public.food_item(v_shop.id, i.shop_item_id) j, coalesce(mc.name, si.category) cat, mc.position cat_pos,
             coalesce(pp.menu_position, i.menu_position) * 1000 + case when i.menu_parent is null then 0 else i.menu_position + 1 end pos,
             si.name
      from public.sklad_items i
      join public.shop_items si on si.id = i.shop_item_id
      left join public.sklad_items pp on pp.shop_item_id = i.menu_parent
      left join public.menu_categories mc on mc.id = coalesce(pp.menu_category, i.menu_category)
      where i.shop_id = v_shop.id and i.sale_price is not null
        and not (i.menu_item and (i.menu_hidden or coalesce(pp.menu_hidden, false)))
        and (v_q is null or public.search_text(si.name || ' ' || coalesce(mc.name, si.category, '')) like
             all (array(select '%' || w || '%' from regexp_split_to_table(public.search_text(v_q), '\s+') w where w <> '')))
      order by mc.position nulls last, coalesce(mc.name, si.category) nulls last, si.name
      limit least(greatest(coalesce(p_limit, 60), 1), 200)
    ) x
    where x.j is not null), '[]'::jsonb));
end;
$$;
revoke execute on function public.food_menu(text, text, integer) from public;
grant execute on function public.food_menu(text, text, integer) to anon, authenticated, service_role;

/**
 * As update 67, and a menu item without stock tracking (or a hidden one) is not stock: it is left out of the shop's
 * inventory (public_stock, the search, the API, the MCP) — a restaurant's dishes are on its Menu (shop_menu).
 */
create or replace function public.sklad_apply(p_shop_id uuid, p_items uuid[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if public.stock_source_of(p_shop_id) <> 'sklad' then
    return;
  end if;
  perform set_config('ppi.sklad_apply', 'on', true);

  delete from public.inventory inv
  using public.sklad_items i
  where inv.shop_item_id = i.shop_item_id and i.shop_id = p_shop_id
    and (i.sale_price is null or (i.menu_item and (not i.track_stock or i.menu_hidden)))
    and (p_items is null or i.shop_item_id = any (p_items));

  insert into public.inventory (shop_item_id, quantity, price, currency, source_updated_at, received_at)
  select i.shop_item_id, coalesce(t.qty, 0), i.sale_price, 'EUR', now(), now()
  from public.sklad_items i
  left join public.sklad_stock_total t on t.shop_item_id = i.shop_item_id
  where i.shop_id = p_shop_id and i.sale_price is not null
    and not (i.menu_item and (not i.track_stock or i.menu_hidden))
    and (p_items is null or i.shop_item_id = any (p_items))
  on conflict (shop_item_id) do update set
    quantity = excluded.quantity, price = excluded.price, currency = excluded.currency,
    source_updated_at = excluded.source_updated_at, received_at = excluded.received_at;

  insert into public.sync_sources (shop_id) values (p_shop_id) on conflict (shop_id) do nothing;
  update public.sync_sources
  set latest_file_time = now(), last_checked_at = now(), last_error = null, last_file_name = 'Sklad v Cacaduu'
  where shop_id = p_shop_id;

  perform set_config('ppi.sklad_apply', '', true);
end;
$$;
revoke execute on function public.sklad_apply(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.sklad_apply(uuid, uuid[]) to service_role;

-- ------------------------------------------------------------------ 3. the owner: the editor

/** "1,2" / [1, 2] / "[1,2]" → smallint[] of the EU allergens 1–14 (anything else refused). */
create or replace function public.menu_allergens_of(p jsonb)
returns smallint[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v smallint[] := '{}';
  x jsonb;
begin
  if p is null or p = 'null'::jsonb then return '{}'; end if;
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 14 then raise exception 'allergens' using errcode = '22023'; end if;
  for x in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(x) not in ('number', 'string') or (x #>> '{}') !~ '^[0-9]{1,2}$'
       or (x #>> '{}')::integer not between 1 and 14 then
      raise exception 'allergens' using errcode = '22023';
    end if;
    v := v || (x #>> '{}')::smallint;
  end loop;
  return (select coalesce(array_agg(distinct a order by a), '{}') from unnest(v) a);
end;
$$;
revoke execute on function public.menu_allergens_of(jsonb) from public;

/** ["veg", "spicy"] → text[] (anything else refused). */
create or replace function public.menu_tags_of(p jsonb)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text[] := '{}';
  x text;
begin
  if p is null or p = 'null'::jsonb then return '{}'; end if;
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 2 then raise exception 'tags' using errcode = '22023'; end if;
  for x in select * from jsonb_array_elements_text(p) loop
    if x not in ('veg', 'spicy') then raise exception 'tags' using errcode = '22023'; end if;
    v := v || x;
  end loop;
  return (select coalesce(array_agg(distinct t order by t), '{}') from unnest(v) t);
end;
$$;
revoke execute on function public.menu_tags_of(jsonb) from public;

/** A price as typed ("8,90", "8.90", 8.9) → numeric with 2 decimals; empty → null; anything else refused. */
create or replace function public.menu_price_of(p text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := replace(btrim(coalesce(p, '')), ',', '.');
begin
  if v = '' then return null; end if;
  if v !~ '^[0-9]{1,6}(\.[0-9]{1,2})?$' then raise exception 'price' using errcode = '22023'; end if;
  return round(v::numeric, 2);
end;
$$;
revoke execute on function public.menu_price_of(text) from public;

/** The menu category of the shop or null; another shop's category is refused. */
create or replace function public.menu_category_of(p_shop_id uuid, p jsonb)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v uuid;
begin
  if p is null or p = 'null'::jsonb or coalesce(p #>> '{}', '') = '' then return null; end if;
  begin
    v := (p #>> '{}')::uuid;
  exception when others then
    raise exception 'category' using errcode = '22023';
  end;
  if not exists (select 1 from public.menu_categories c where c.id = v and c.shop_id = p_shop_id) then
    raise exception 'category' using errcode = '22023';
  end if;
  return v;
end;
$$;
revoke execute on function public.menu_category_of(uuid, jsonb) from public, anon, authenticated;

/**
 * One dish with its sizes (the editor and the import). p: name, description, category_id, price, allergens, tags,
 * track_stock, hidden, variants [{id?, label, price}] — only the given keys change; given variants replace the visible
 * ones (a size left out is hidden, never deleted: Sklad products stay). A dish with sizes has no price of its own (each
 * size is ordered). Sklad's own function makes and prices the products (plan limit, codes). Members only.
 */
create or replace function public.menu_save_dish(p_shop_id uuid, p_item_id uuid, p jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid := p_item_id;
  v_cat uuid;
  v_name text;
  v_has_variants boolean;
  v_variant jsonb;
  v_vid uuid;
  v_label text;
  v_keep uuid[] := '{}';
  v_pos integer := 0;
  v_ids uuid[];
  v_price numeric;
begin
  perform public.sklad_member(p_shop_id);
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'bad_argument' using errcode = '22023'; end if;
  if p ? 'name' and char_length(btrim(coalesce(p ->> 'name', ''))) not between 1 and 200 then
    raise exception 'name' using errcode = '22023';
  end if;
  if p ? 'description' and char_length(coalesce(p ->> 'description', '')) > 600 then raise exception 'description' using errcode = '22023'; end if;
  if p ? 'variants' and (jsonb_typeof(p -> 'variants') <> 'array' or jsonb_array_length(p -> 'variants') > 8) then
    raise exception 'variants' using errcode = '22023';
  end if;
  v_has_variants := case when p ? 'variants' then jsonb_array_length(p -> 'variants') > 0 else null end;
  if p ? 'category_id' then v_cat := public.menu_category_of(p_shop_id, p -> 'category_id'); end if;
  if p ? 'price' then v_price := public.menu_price_of(p ->> 'price'); end if;

  if v_id is null then
    if not (p ? 'name') then raise exception 'name' using errcode = '22023'; end if;
    v_id := public.owner_sklad_save_product(p_shop_id, null, jsonb_build_object(
      'name', btrim(p ->> 'name'), 'description', coalesce(p ->> 'description', ''),
      'sale_price', case when coalesce(v_has_variants, false) then '' else coalesce(v_price::text, '') end));
    update public.sklad_items set menu_item = true,
      menu_position = coalesce((select max(menu_position) + 1 from public.sklad_items
                                where shop_id = p_shop_id and menu_item and menu_parent is null
                                  and menu_category is not distinct from v_cat), 0)
    where shop_item_id = v_id;
  else
    if not exists (select 1 from public.sklad_items i where i.shop_item_id = v_id and i.shop_id = p_shop_id and i.menu_parent is null) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    perform public.owner_sklad_save_product(p_shop_id, v_id,
      (case when p ? 'name' then jsonb_build_object('name', btrim(p ->> 'name')) else '{}'::jsonb end)
      || (case when p ? 'description' then jsonb_build_object('description', coalesce(p ->> 'description', '')) else '{}'::jsonb end)
      || (case when coalesce(v_has_variants, false) then jsonb_build_object('sale_price', '')
               when p ? 'price' then jsonb_build_object('sale_price', coalesce(v_price::text, '')) else '{}'::jsonb end));
    update public.sklad_items set menu_item = true where shop_item_id = v_id;
  end if;

  update public.sklad_items i set
    menu_category = case when p ? 'category_id' then v_cat else i.menu_category end,
    allergens = case when p ? 'allergens' then public.menu_allergens_of(p -> 'allergens') else i.allergens end,
    menu_tags = case when p ? 'tags' then public.menu_tags_of(p -> 'tags') else i.menu_tags end,
    track_stock = case when p ? 'track_stock' then coalesce((p ->> 'track_stock')::boolean, false) else i.track_stock end,
    menu_hidden = case when p ? 'hidden' then coalesce((p ->> 'hidden')::boolean, false) else i.menu_hidden end,
    updated_at = now()
  where i.shop_item_id = v_id;
  -- the category's name on the product (the translations and the search read it)
  update public.shop_items si set category = (select c.name from public.menu_categories c
                                               join public.sklad_items i on i.menu_category = c.id where i.shop_item_id = v_id)
  where si.id = v_id;
  select name into v_name from public.shop_items where id = v_id;

  if p ? 'variants' then
    for v_variant in select * from jsonb_array_elements(p -> 'variants') loop
      v_pos := v_pos + 1;
      v_label := btrim(coalesce(v_variant ->> 'label', ''));
      if jsonb_typeof(v_variant) <> 'object' or char_length(v_label) not between 1 and 40 then
        raise exception 'label' using errcode = '22023';
      end if;
      v_price := public.menu_price_of(v_variant ->> 'price');
      if v_price is null then raise exception 'price' using errcode = '22023'; end if;
      v_vid := nullif(v_variant ->> 'id', '')::uuid;
      if v_vid is not null then
        if not exists (select 1 from public.sklad_items i where i.shop_item_id = v_vid and i.shop_id = p_shop_id and i.menu_parent = v_id) then
          raise exception 'variants' using errcode = '22023';
        end if;
        perform public.owner_sklad_save_product(p_shop_id, v_vid, jsonb_build_object('name', left(v_name || ' ' || v_label, 300),
                                                                                       'sale_price', v_price::text));
      else
        v_vid := public.owner_sklad_save_product(p_shop_id, null, jsonb_build_object('name', left(v_name || ' ' || v_label, 300),
                                                                                      'sale_price', v_price::text));
      end if;
      update public.sklad_items i set menu_item = true, menu_parent = v_id, variant_label = v_label, menu_position = v_pos,
        menu_hidden = false, menu_category = (select menu_category from public.sklad_items where shop_item_id = v_id),
        track_stock = (select track_stock from public.sklad_items where shop_item_id = v_id), updated_at = now()
      where i.shop_item_id = v_vid;
      update public.shop_items set category = (select category from public.shop_items where id = v_id) where id = v_vid;
      v_keep := v_keep || v_vid;
    end loop;
    -- a size the owner removed: hidden (its Sklad product and its history stay)
    update public.sklad_items set menu_hidden = true, updated_at = now()
    where menu_parent = v_id and shop_id = p_shop_id and not (shop_item_id = any (v_keep));
  else
    -- the dish's name, category and tracking follow its sizes
    update public.shop_items si set name = left(v_name || ' ' || i.variant_label, 300),
      category = (select category from public.shop_items where id = v_id), updated_at = now()
    from public.sklad_items i
    where i.menu_parent = v_id and i.shop_item_id = si.id and si.name is distinct from left(v_name || ' ' || i.variant_label, 300);
    update public.sklad_items i set menu_category = p2.menu_category, track_stock = p2.track_stock
    from public.sklad_items p2 where p2.shop_item_id = v_id and i.menu_parent = v_id;
  end if;

  select array_agg(shop_item_id) into v_ids from public.sklad_items where shop_item_id = v_id or menu_parent = v_id;
  perform public.sklad_apply(p_shop_id, v_ids);
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'menu_item_saved', jsonb_build_object('item_id', v_id, 'new', p_item_id is null));
  return v_id;
end;
$$;
revoke execute on function public.menu_save_dish(uuid, uuid, jsonb) from public, anon, authenticated;

create or replace function public.owner_menu_save_item(p_shop_id uuid, p_item_id uuid, p jsonb)
returns uuid
language sql
volatile
security definer
set search_path = ''
as $$
  select public.menu_save_dish(p_shop_id, p_item_id, p)
$$;
revoke execute on function public.owner_menu_save_item(uuid, uuid, jsonb) from public, anon;
grant execute on function public.owner_menu_save_item(uuid, uuid, jsonb) to authenticated;

/** "Duplikovať": the same dish with its sizes, right after it (no photo: a photo belongs to one product). */
create or replace function public.owner_menu_duplicate_item(p_shop_id uuid, p_item_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  d record;
  v_new uuid;
begin
  perform public.sklad_member(p_shop_id);
  select si.name, si.description, i.menu_category, i.allergens, i.menu_tags, i.track_stock, i.sale_price, i.menu_position
  into d
  from public.sklad_items i join public.shop_items si on si.id = i.shop_item_id
  where i.shop_item_id = p_item_id and i.shop_id = p_shop_id and i.menu_item and i.menu_parent is null;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  v_new := public.menu_save_dish(p_shop_id, null, jsonb_build_object(
    'name', left(d.name || ' (2)', 200), 'description', coalesce(d.description, ''), 'category_id', d.menu_category,
    'price', coalesce(d.sale_price::text, ''), 'allergens', to_jsonb(d.allergens), 'tags', to_jsonb(d.menu_tags),
    'track_stock', d.track_stock,
    'variants', coalesce((select jsonb_agg(jsonb_build_object('label', v.variant_label, 'price', v.sale_price::text)
                                           order by v.menu_position)
                          from public.sklad_items v where v.menu_parent = p_item_id and not v.menu_hidden
                            and v.sale_price is not null), '[]'::jsonb)));
  -- right after the original
  update public.sklad_items set menu_position = menu_position + 1
  where shop_id = p_shop_id and menu_item and menu_parent is null and menu_category is not distinct from d.menu_category
    and menu_position > d.menu_position and shop_item_id <> v_new;
  update public.sklad_items set menu_position = d.menu_position + 1 where shop_item_id = v_new;
  return v_new;
end;
$$;
revoke execute on function public.owner_menu_duplicate_item(uuid, uuid) from public, anon;
grant execute on function public.owner_menu_duplicate_item(uuid, uuid) to authenticated;

/** A category: new (at the end) or renamed (its dishes' category name follows). Members only. */
create or replace function public.owner_menu_save_category(p_shop_id uuid, p_id uuid, p_name text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid := p_id;
  v_name text := btrim(coalesce(p_name, ''));
begin
  perform public.sklad_member(p_shop_id);
  if char_length(v_name) not between 1 and 60 then raise exception 'name' using errcode = '22023'; end if;
  if exists (select 1 from public.menu_categories c where c.shop_id = p_shop_id and lower(btrim(c.name)) = lower(v_name)
               and c.id is distinct from v_id) then
    raise exception 'name_taken' using errcode = '23505';
  end if;
  if (select count(*) from public.menu_categories where shop_id = p_shop_id) >= 60 and v_id is null then
    raise exception 'too_many' using errcode = '54000';
  end if;
  if v_id is null then
    insert into public.menu_categories (shop_id, name, position)
    values (p_shop_id, v_name, coalesce((select max(position) + 1 from public.menu_categories where shop_id = p_shop_id), 0))
    returning id into v_id;
  else
    update public.menu_categories set name = v_name where id = v_id and shop_id = p_shop_id;
    if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
    update public.shop_items si set category = v_name, updated_at = now()
    from public.sklad_items i where i.shop_item_id = si.id and i.menu_category = v_id and si.category is distinct from v_name;
  end if;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'menu_category_saved', jsonb_build_object('category_id', v_id, 'new', p_id is null));
  return v_id;
end;
$$;
revoke execute on function public.owner_menu_save_category(uuid, uuid, text) from public, anon;
grant execute on function public.owner_menu_save_category(uuid, uuid, text) to authenticated;

/** An empty category goes; one with dishes is refused (not_empty) — move or hide the dishes first. */
create or replace function public.owner_menu_delete_category(p_shop_id uuid, p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.sklad_member(p_shop_id);
  if exists (select 1 from public.sklad_items where menu_category = p_id and shop_id = p_shop_id and menu_item and menu_parent is null) then
    raise exception 'not_empty' using errcode = 'P0001';
  end if;
  delete from public.menu_categories where id = p_id and shop_id = p_shop_id;
end;
$$;
revoke execute on function public.owner_menu_delete_category(uuid, uuid) from public, anon;
grant execute on function public.owner_menu_delete_category(uuid, uuid) to authenticated;

/** The categories' order (drag or the arrows): the given ids in their new order; others keep theirs after them. */
create or replace function public.owner_menu_order_categories(p_shop_id uuid, p_ids uuid[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.sklad_member(p_shop_id);
  update public.menu_categories c set position = x.n - 1
  from unnest(coalesce(p_ids, '{}')) with ordinality as x(id, n)
  where c.id = x.id and c.shop_id = p_shop_id;
end;
$$;
revoke execute on function public.owner_menu_order_categories(uuid, uuid[]) from public, anon;
grant execute on function public.owner_menu_order_categories(uuid, uuid[]) to authenticated;

/** The dishes' order inside a category (the given dish ids in their new order). */
create or replace function public.owner_menu_order_items(p_shop_id uuid, p_ids uuid[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.sklad_member(p_shop_id);
  update public.sklad_items i set menu_position = x.n - 1
  from unnest(coalesce(p_ids, '{}')) with ordinality as x(id, n)
  where i.shop_item_id = x.id and i.shop_id = p_shop_id and i.menu_item and i.menu_parent is null;
end;
$$;
revoke execute on function public.owner_menu_order_items(uuid, uuid[]) from public, anon;
grant execute on function public.owner_menu_order_items(uuid, uuid[]) to authenticated;

/**
 * "Vypredané dnes" on / off (one tap): a dish (all its sizes) or one size, until the shop's midnight. Members only; the
 * owner MCP's set_menu_sold_out and the Telegram bot come here after "Potvrdiť". Returns {item_id, name, sold_out}.
 */
create or replace function public.owner_menu_set_sold_out(p_shop_id uuid, p_item_id uuid, p_sold_out boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_today date;
begin
  perform public.sklad_member(p_shop_id);
  if not exists (select 1 from public.sklad_items where shop_item_id = p_item_id and shop_id = p_shop_id and menu_item) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_today := public.shop_today(p_shop_id);
  update public.sklad_items set sold_out_on = case when coalesce(p_sold_out, true) then v_today end, updated_at = now()
  where shop_item_id = p_item_id;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'menu_sold_out', jsonb_build_object('item_id', p_item_id, 'sold_out', coalesce(p_sold_out, true)));
  return public.menu_line(p_shop_id, p_item_id);
end;
$$;
revoke execute on function public.owner_menu_set_sold_out(uuid, uuid, boolean) from public, anon;
grant execute on function public.owner_menu_set_sold_out(uuid, uuid, boolean) to authenticated;

/** One menu line as the owner's tools (MCP, Telegram) see it: no costs, suppliers or stock values. */
create or replace function public.menu_line(p_shop_id uuid, p_item_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'item_id', i.shop_item_id,
    'name', case when i.menu_parent is not null then btrim(coalesce(ps.name, '') || ' ' || coalesce(i.variant_label, '')) else si.name end,
    'category', mc.name,
    'price', i.sale_price,
    'tracked', i.track_stock,
    'hidden', i.menu_hidden,
    'sold_out_today', case when i.track_stock then coalesce(t.qty, 0) <= 0
                           else coalesce(i.sold_out_on = public.shop_today(p_shop_id), false) or coalesce(pp.sold_out_on = public.shop_today(p_shop_id), false) end)
  from public.sklad_items i
  join public.shop_items si on si.id = i.shop_item_id
  left join public.sklad_stock_total t on t.shop_item_id = i.shop_item_id
  left join public.sklad_items pp on pp.shop_item_id = i.menu_parent
  left join public.shop_items ps on ps.id = i.menu_parent
  left join public.menu_categories mc on mc.id = coalesce(pp.menu_category, i.menu_category)
  where i.shop_id = p_shop_id and i.shop_item_id = p_item_id and i.menu_item
$$;
revoke execute on function public.menu_line(uuid, uuid) from public, anon, authenticated;

/**
 * The menu editor: the categories with their dishes (hidden ones too), each dish's sizes, price, allergens, tags,
 * tracking (with Sklad's quantity), "Vypredané dnes", the photo. Members only.
 */
create or replace function public.owner_menu(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date;
begin
  perform public.sklad_member(p_shop_id);
  v_today := public.shop_today(p_shop_id);
  return jsonb_build_object(
    'today', v_today,
    'kind', (select kind from public.shops where id = p_shop_id),
    'has_plan', public.shop_has_plan(p_shop_id),
    'limit', public.sklad_product_limit(p_shop_id),
    'products', (select count(*) from public.sklad_items where shop_id = p_shop_id),
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'position', c.position)
                                             order by c.position, c.name)
                            from public.menu_categories c where c.shop_id = p_shop_id), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.shop_item_id, 'name', si.name, 'description', si.description, 'category_id', i.menu_category,
        'position', i.menu_position, 'price', i.sale_price, 'hidden', i.menu_hidden, 'track_stock', i.track_stock,
        'qty', coalesce(t.qty, 0), 'sold_out_today', coalesce(i.sold_out_on = v_today, false),
        'allergens', to_jsonb(i.allergens), 'tags', to_jsonb(i.menu_tags),
        'photo', (select jsonb_build_object('small', ph.path_small, 'v', extract(epoch from ph.updated_at)::bigint)
                  from public.product_photos ph where ph.item_id = i.shop_item_id),
        'variants', coalesce((select jsonb_agg(jsonb_build_object(
                                'id', v.shop_item_id, 'label', v.variant_label, 'price', v.sale_price, 'hidden', v.menu_hidden,
                                'qty', coalesce(vt.qty, 0), 'sold_out_today', coalesce(v.sold_out_on = v_today, false)) order by v.menu_position)
                              from public.sklad_items v left join public.sklad_stock_total vt on vt.shop_item_id = v.shop_item_id
                              where v.menu_parent = i.shop_item_id and not v.menu_hidden), '[]'::jsonb))
        order by c.position nulls last, i.menu_position, si.name)
      from public.sklad_items i
      join public.shop_items si on si.id = i.shop_item_id
      left join public.sklad_stock_total t on t.shop_item_id = i.shop_item_id
      left join public.menu_categories c on c.id = i.menu_category
      where i.shop_id = p_shop_id and i.menu_item and i.menu_parent is null), '[]'::jsonb));
end;
$$;
revoke execute on function public.owner_menu(uuid) from public, anon;
grant execute on function public.owner_menu(uuid) to authenticated;

-- ------------------------------------------------------------------ 4. the import from a PDF or a photo

/**
 * Before the AI reads a menu (a PDF's text or a photo): members, at most 10 a day per shop (the shop's day; counted in
 * owner_ai_usage, kind menu — the tokens follow with owner_ai_spend). Returns how many are left.
 */
create or replace function public.owner_menu_import_hit(p_shop_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_limit constant integer := 10;
  v_day date;
  v_used integer;
begin
  perform public.sklad_member(p_shop_id);
  v_day := public.shop_today(p_shop_id);
  perform pg_advisory_xact_lock(hashtext('ppi-menu-import:' || p_shop_id::text));
  select coalesce(sum(calls), 0) into v_used from public.owner_ai_usage
  where shop_id = p_shop_id and day = v_day and kind = 'menu';
  if v_used >= v_limit then raise exception 'import_limit' using errcode = '54000'; end if;
  insert into public.owner_ai_usage (shop_id, user_id, day, kind, calls) values (p_shop_id, auth.uid(), v_day, 'menu', 1)
  on conflict (shop_id, user_id, day, kind) do update set calls = public.owner_ai_usage.calls + 1;
  return v_limit - v_used - 1;
end;
$$;
revoke execute on function public.owner_menu_import_hit(uuid) from public, anon;
grant execute on function public.owner_menu_import_hit(uuid) to authenticated;

-- the import's tokens are part of the owner tools' AI spend (kind menu)
create or replace function public.owner_ai_spend(p_shop_id uuid, p_kind text, p_input bigint, p_output bigint)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_day date;
begin
  if p_shop_id is null or not public.is_shop_member(p_shop_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_kind not in ('grammar', 'assistant', 'blog', 'menu') then raise exception 'kind' using errcode = '22023'; end if;
  v_day := case when p_kind in ('grammar', 'blog', 'menu')
                then (now() at time zone coalesce((select timezone from public.shops where id = p_shop_id), 'UTC'))::date
                else current_date end;
  insert into public.owner_ai_usage (shop_id, user_id, day, kind, input_tokens, output_tokens)
  values (p_shop_id, auth.uid(), v_day, p_kind, greatest(coalesce(p_input, 0), 0), greatest(coalesce(p_output, 0), 0))
  on conflict (shop_id, user_id, day, kind) do update
  set input_tokens = public.owner_ai_usage.input_tokens + excluded.input_tokens,
      output_tokens = public.owner_ai_usage.output_tokens + excluded.output_tokens;
end;
$$;
revoke execute on function public.owner_ai_spend(uuid, text, bigint, bigint) from public, anon;
grant execute on function public.owner_ai_spend(uuid, text, bigint, bigint) to authenticated;

/**
 * "Uložiť do menu": the rows the owner checked and edited, in ONE transaction (all or nothing): rows [{category, name,
 * description, price, variants: [{label, price}], allergens, tags}] (≤ 300); a category is found by its name (any case)
 * or made at the end. Every dish through menu_save_dish (Sklad's products, the plan's limit). Returns {dishes, categories}.
 */
create or replace function public.owner_menu_import_save(p_shop_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r jsonb;
  v_cat uuid;
  v_cat_name text;
  v_dishes integer := 0;
  v_new_cats integer := 0;
begin
  perform public.sklad_member(p_shop_id);
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 300 then
    raise exception 'rows' using errcode = '22023';
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(r) <> 'object' then raise exception 'rows' using errcode = '22023'; end if;
    v_cat := null;
    v_cat_name := left(btrim(coalesce(r ->> 'category', '')), 60);
    if v_cat_name <> '' then
      select id into v_cat from public.menu_categories where shop_id = p_shop_id and lower(btrim(name)) = lower(v_cat_name);
      if v_cat is null then
        v_cat := public.owner_menu_save_category(p_shop_id, null, v_cat_name);
        v_new_cats := v_new_cats + 1;
      end if;
    end if;
    perform public.menu_save_dish(p_shop_id, null, jsonb_build_object(
      'name', r ->> 'name', 'description', coalesce(r ->> 'description', ''), 'category_id', v_cat,
      'price', coalesce(r ->> 'price', ''), 'allergens', coalesce(r -> 'allergens', '[]'::jsonb),
      'tags', coalesce(r -> 'tags', '[]'::jsonb), 'variants', coalesce(r -> 'variants', '[]'::jsonb)));
    v_dishes := v_dishes + 1;
  end loop;
  insert into public.shop_activity (shop_id, actor, action, details)
  values (p_shop_id, auth.uid(), 'menu_imported', jsonb_build_object('dishes', v_dishes, 'categories', v_new_cats));
  return jsonb_build_object('dishes', v_dishes, 'categories', v_new_cats);
end;
$$;
revoke execute on function public.owner_menu_import_save(uuid, jsonb) from public, anon;
grant execute on function public.owner_menu_import_save(uuid, jsonb) to authenticated;

-- ------------------------------------------------------------------ 5. visitors: the Menu

/**
 * The public Menu of an active restaurant (kind food): the categories in the owner's order (only those with dishes),
 * the dishes (not hidden) with a price or with sizes, each size's price, allergens, tags, sold out today (tracked:
 * Sklad's quantity), the photo (update 78's files, read here only for a restaurant's menu). null for any other shop.
 */
create or replace function public.shop_menu(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set jit = off
as $$
declare
  v_shop public.shops;
  v_today date;
  v_items jsonb;
begin
  select * into v_shop from public.shops where slug = p_slug and is_active and kind = 'food';
  if v_shop.id is null then return null; end if;
  v_today := public.shop_today(v_shop.id);
  with variants as (
    select v.menu_parent as parent,
           jsonb_agg(jsonb_build_object(
             'id', v.shop_item_id, 'label', v.variant_label, 'price_cents', round(v.sale_price * 100)::integer,
             'tracked', v.track_stock,
             'sold_out', case when v.track_stock then coalesce(vt.qty, 0) <= 0
                              else coalesce(v.sold_out_on = v_today, false) or coalesce(p.sold_out_on = v_today, false) end)
             order by v.menu_position, v.sale_price) as list
    from public.sklad_items v
    join public.sklad_items p on p.shop_item_id = v.menu_parent
    left join public.sklad_stock_total vt on vt.shop_item_id = v.shop_item_id
    where v.shop_id = v_shop.id and v.menu_item and not v.menu_hidden and v.sale_price is not null
    group by v.menu_parent
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', i.shop_item_id, 'name', si.name, 'name_i18n', si.name_i18n, 'description', si.description,
           'category_id', i.menu_category,
           'price_cents', case when va.list is null then round(i.sale_price * 100)::integer end,
           'variants', coalesce(va.list, '[]'::jsonb),
           'tracked', i.track_stock,
           'sold_out', case when va.list is not null
                            then not exists (select 1 from jsonb_array_elements(va.list) e where not (e ->> 'sold_out')::boolean)
                            when i.track_stock then coalesce(t.qty, 0) <= 0
                            else coalesce(i.sold_out_on = v_today, false) end,
           'allergens', to_jsonb(i.allergens), 'tags', to_jsonb(i.menu_tags),
           'photo', case when ph.item_id is null then null
                         else jsonb_build_object('large', ph.path_large, 'small', ph.path_small, 'width', ph.width,
                                                 'height', ph.height, 'v', extract(epoch from ph.updated_at)::bigint) end)
         order by c.position nulls last, i.menu_position, si.name), '[]'::jsonb)
  into v_items
  from public.sklad_items i
  join public.shop_items si on si.id = i.shop_item_id
  left join public.menu_categories c on c.id = i.menu_category
  left join variants va on va.parent = i.shop_item_id
  left join public.sklad_stock_total t on t.shop_item_id = i.shop_item_id
  left join public.product_photos ph on ph.item_id = i.shop_item_id
  where i.shop_id = v_shop.id and i.menu_item and i.menu_parent is null and not i.menu_hidden
    and (va.list is not null or i.sale_price is not null);
  return jsonb_build_object(
    'today', v_today,
    'currency', 'EUR',
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.position, c.name)
                            from public.menu_categories c
                            where c.shop_id = v_shop.id
                              and exists (select 1 from jsonb_array_elements(v_items) e where e ->> 'category_id' = c.id::text)),
                           '[]'::jsonb),
    'items', v_items);
end;
$$;
revoke execute on function public.shop_menu(text) from public;
grant execute on function public.shop_menu(text) to anon, authenticated, service_role;

/**
 * "Hľadať v menu": update 54's forgiving rule (exact words, beginnings, typos, stems, sizes) on the restaurant's menu
 * names (a size counts for its dish); nothing matched → the closest names. The dishes' ids, the best first.
 */
create or replace function public.shop_menu_search(p_slug text, p_q text)
returns table (item_id uuid, score real)
language sql
stable
security definer
set search_path = ''
set jit = off
as $$
  with q as materialized (
    select sq.*, nullif(trim(coalesce(p_q, '')), '') as raw, public.search_patterns(p_q) as patterns,
           public.search_text(p_q) as norm
    from public.search_query(left(coalesce(p_q, ''), 200)) sq
  ),
  items as materialized (
    select si.id, coalesce(sk.menu_parent, si.id) as dish, si.search_stems, si.search_sizes, si.names_search, si.source_code
    from public.shops sh
    join public.shop_items si on si.shop_id = sh.id
    join public.sklad_items sk on sk.shop_item_id = si.id and sk.menu_item and not sk.menu_hidden
    where sh.slug = p_slug and sh.is_active and sh.kind = 'food'
  ),
  quick as (
    select i.*, w.cov, w.spec, coalesce(i.search_sizes && q.sizes, false) as size_hit,
      (lower(i.source_code) = lower(q.raw)) as code_hit,
      (i.names_search like all (q.patterns)) as all_words
    from items i
    cross join q
    cross join lateral (
      select coalesce(public.search_quick_cov(z.hits, q.weights), 0)::real as cov,
             coalesce(public.search_quick_spec(z.hits, q.weights), false)
               and coalesce(public.search_quick_ok(z.hits, q.weights), false) as spec
      from (select case when i.search_stems like any (q.starts)
                        then public.search_quick_hits(i.search_stems, q.stems, q.weights) end as hits) z) w
    where q.raw is not null
  ),
  hits as (
    select h.* from quick h, q
    where h.code_hit or h.all_words or (h.cov > 0 and (h.spec or not q.specific))
       or (cardinality(q.stems) = 0 and h.size_hit)
  ),
  best as (
    select h.dish,
      (case when h.code_hit then 100 else 0 end + case when h.all_words then 10 else 0 end + p.cov2
       + case when h.size_hit then 0.25 else 0 end)::real as score_
    from (select * from hits order by code_hit desc, all_words desc, cov desc limit 300) h
    cross join q
    cross join lateral (
      select coalesce(sum(x.weight * x.hit) / nullif(sum(x.weight), 0), 0)::real as cov2
      from (select u.weight,
                   (select case when m >= 0.85 then m
                                else greatest(m, public.search_word_match(u.stem, string_to_array(trim(h.search_stems), ' ')))
                           end
                    from (select public.search_quick_match(u.stem, h.search_stems) as m) mm) as hit
            from unnest(q.stems, q.weights) as u(stem, weight)) x) p
  ),
  near_names as (
    select i.dish, extensions.word_similarity(q.norm, i.names_search)::real as score_
    from items i, q
    where q.raw is not null and not exists (select 1 from hits)
      and extensions.word_similarity(q.norm, i.names_search) > 0.15
  )
  select r.dish, max(r.score_)::real
  from (select * from best union all select * from near_names) r
  group by r.dish
  order by 2 desc, 1
  limit 100
$$;
revoke execute on function public.shop_menu_search(text, text) from public;
grant execute on function public.shop_menu_search(text, text) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ 6. the owner MCP: list_menu, set_menu_sold_out

create or replace function public.mcp_tool_scope(p_tool text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_tool in ('list_shops', 'get_shop_details', 'get_opening_hours', 'list_conversations', 'get_conversation',
                    'list_contacts', 'get_contact', 'list_bookings', 'list_email_templates', 'search_stock',
                    'get_sms_usage', 'list_booking_services', 'find_free_slots', 'list_food_orders', 'list_menu') then 'shop.read'
    when p_tool in ('update_conversations', 'save_contact', 'delete_contact', 'set_booking_status', 'set_opening_hours',
                    'update_shop_details', 'update_stock', 'create_booking', 'move_booking', 'cancel_booking',
                    'set_food_order_status', 'set_menu_sold_out') then 'shop.write'
    when p_tool in ('preview_message') then 'messages.send'
  end
$$;
revoke execute on function public.mcp_tool_scope(text) from public, anon, authenticated;

-- update 74's door is kept under its own name (once); the menu tools are answered here, every other tool there
do $$
begin
  if to_regprocedure('public.owner_mcp_call_74(text, text, jsonb)') is null
     and to_regprocedure('public.owner_mcp_call(text, text, jsonb)') is not null then
    alter function public.owner_mcp_call(text, text, jsonb) rename to owner_mcp_call_74;
  end if;
end;
$$;
revoke execute on function public.owner_mcp_call_74(text, text, jsonb) from public, anon, authenticated;

create or replace function public.owner_mcp_call(p_token text, p_tool text, p_args jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  g public.owner_mcp_tokens%rowtype;
  a jsonb := coalesce(nullif(p_args, 'null'::jsonb), '{}'::jsonb);
  v_scope text;
  v_shop uuid;
  v_slug text;
  v_id uuid;
  v_sold boolean;
  v_out jsonb;
  v_changed boolean := false;
begin
  if p_tool not in ('list_menu', 'set_menu_sold_out') then
    return public.owner_mcp_call_74(p_token, p_tool, p_args);
  end if;
  if jsonb_typeof(a) <> 'object' then raise exception 'bad_argument: arguments' using errcode = '22023'; end if;
  g := public.mcp_grant(p_token);
  v_scope := public.mcp_tool_scope(p_tool);
  if not v_scope = any (g.scopes) then raise exception 'scope: %', v_scope using errcode = '42501'; end if;
  perform public.mcp_act_as(g.user_id);
  v_shop := public.mcp_shop(g, a ->> 'shop');
  select slug into v_slug from public.shops where id = v_shop;

  if p_tool = 'list_menu' then
    select coalesce(jsonb_agg(public.menu_line(v_shop, i.shop_item_id)
                              order by c.position nulls last, coalesce(pp.menu_position, i.menu_position), i.menu_parent nulls first,
                                       i.menu_position), '[]'::jsonb)
    into v_out
    from public.sklad_items i
    left join public.sklad_items pp on pp.shop_item_id = i.menu_parent
    left join public.menu_categories c on c.id = coalesce(pp.menu_category, i.menu_category)
    where i.shop_id = v_shop and i.menu_item and not i.menu_hidden and not coalesce(pp.menu_hidden, false);
    v_out := jsonb_build_object('today', public.shop_today(v_shop), 'items', v_out);
  else
    v_id := public.mcp_uuid(a, 'item_id');
    if not exists (select 1 from public.sklad_items where shop_item_id = v_id and shop_id = v_shop and menu_item) then
      raise exception 'not_found: item_id' using errcode = 'P0002';
    end if;
    v_sold := coalesce((a ->> 'sold_out')::boolean, true);
    if coalesce((a ->> 'confirm')::boolean, false) then
      v_out := jsonb_build_object('changed', true, 'item', public.owner_menu_set_sold_out(v_shop, v_id, v_sold));
      v_changed := true;
    else
      v_out := jsonb_build_object(
        'changed', false,
        'needs_confirm', 'Show the owner before → after and call again with confirm: true after they agree.',
        'before', public.menu_line(v_shop, v_id),
        'after', jsonb_build_object('sold_out_today', v_sold, 'until', 'the shop''s midnight'));
    end if;
  end if;
  return jsonb_build_object('shop', v_slug, 'result', coalesce(v_out, 'null'::jsonb), 'changed', v_changed);
end;
$$;
revoke execute on function public.owner_mcp_call(text, text, jsonb) from public;
grant execute on function public.owner_mcp_call(text, text, jsonb) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ 7. "Nastavenie obchodu": the Menu step

/** A restaurant's menu has a dish: a menu item (not hidden) with a price or with a size that has one. */
create or replace function public.menu_has_dishes(p_shop_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.sklad_items i
    where i.shop_id = p_shop_id and i.menu_item and i.menu_parent is null and not i.menu_hidden
      and (i.sale_price is not null
           or exists (select 1 from public.sklad_items v where v.menu_parent = i.shop_item_id and not v.menu_hidden
                        and v.sale_price is not null)))
$$;
revoke execute on function public.menu_has_dishes(uuid) from public, anon, authenticated;

-- owner_setup_steps: as in update 79, the restaurant's Menu step = menu dishes (menu_has_dishes)
create or replace function public.owner_setup_steps(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  sh public.shops;
  ss public.sync_sources;
  fs public.food_settings;
  v_skipped text[];
  v_plan boolean;
  v_source text;
  v_steps jsonb := '[]'::jsonb;
  v_miss text[];
  v_done integer := 0;
  v_total integer := 0;
  v_open integer := 0;
  v_optional text[];
  k text;
  v_list jsonb := '[]'::jsonb;
  st jsonb;
begin
  if auth.uid() is null or p_shop_id is null or not public.is_shop_member(p_shop_id) then
    raise exception 'not_member' using errcode = '42501';
  end if;
  select * into sh from public.shops where id = p_shop_id;
  select * into ss from public.sync_sources where shop_id = p_shop_id;
  select * into fs from public.food_settings where shop_id = p_shop_id;
  v_skipped := coalesce((select skipped from public.shop_setup where shop_id = p_shop_id), '{}');
  v_plan := public.shop_has_plan(p_shop_id);
  v_optional := public.setup_optional_steps(sh.kind);

  v_miss := array_remove(array[
    case when nullif(btrim(coalesce(sh.address, '')), '') is null then 'address' end,
    case when nullif(btrim(coalesce(sh.city, '')), '') is null then 'city' end,
    case when sh.country is null then 'country' end,
    case when nullif(btrim(coalesce(sh.phone, '')), '') is null and sh.email is null then 'contact' end], null);
  v_list := v_list || jsonb_build_object('key', 'details', 'missing', to_jsonb(v_miss));

  v_list := v_list || jsonb_build_object('key', 'hours', 'missing', to_jsonb(case when exists (
    select 1 from jsonb_each(coalesce(sh.opening_hours, '{}'::jsonb)) e
    where jsonb_typeof(e.value) = 'array' and jsonb_array_length(e.value) > 0) then '{}'::text[] else array['hours'] end));

  if sh.kind = 'food' then
    -- Menu (update 80): a menu dish with a price
    v_list := v_list || jsonb_build_object('key', 'menu', 'missing', to_jsonb(case when public.menu_has_dishes(p_shop_id)
      then '{}'::text[] else array['menu'] end));

    v_miss := array_remove(array[
      case when not v_plan then 'plan' end,
      case when not coalesce(fs.pickup_on, true) and not coalesce(fs.delivery_on, false) then 'no_kind' end,
      case when coalesce(fs.delivery_on, false)
             and not exists (select 1 from public.food_zones z where z.shop_id = p_shop_id) then 'zones' end,
      case when coalesce(fs.pay_qr, true)
             and not exists (select 1 from public.sklad_settings st where st.shop_id = p_shop_id and st.iban is not null)
           then 'iban' end], null);
    v_list := v_list || jsonb_build_object('key', 'orders', 'missing', to_jsonb(v_miss));

    v_list := v_list || jsonb_build_object('key', 'couriers', 'missing', to_jsonb(case when exists (
      select 1 from public.food_couriers c where c.shop_id = p_shop_id and c.active)
      then '{}'::text[] else array['couriers'] end));

    v_miss := array_remove(array[
      case when not v_plan then 'plan' end,
      case when sh.assistant_welcome is null then 'welcome' end,
      case when not exists (select 1 from public.shop_documents d join public.shop_folders f on f.id = d.folder_id and f.is_public
                            where d.shop_id = p_shop_id and d.status = 'ready' and d.assistant_enabled) then 'menu_pdf' end], null);
    v_list := v_list || jsonb_build_object('key', 'assistant', 'missing', to_jsonb(v_miss));

    v_list := v_list || jsonb_build_object('key', 'launch', 'missing', to_jsonb(case when coalesce(fs.enabled, false)
      then '{}'::text[] else array['enabled'] end));
  else
    v_source := public.stock_source_of(p_shop_id);
    v_list := v_list || jsonb_build_object('key', 'stock', 'missing', to_jsonb(case
      when v_source <> 'file' then '{}'::text[]
      when ss.latest_file_time is null and ss.mapping_status is distinct from 'proposed' then array['stock']
      when ss.mapping_status is distinct from 'confirmed' then array['columns']
      else '{}'::text[] end));

    v_list := v_list || jsonb_build_object('key', 'languages', 'missing', to_jsonb(case when exists (
      select 1 from public.shop_language_settings ls where ls.shop_id = p_shop_id) then '{}'::text[] else array['languages'] end));

    v_list := v_list || jsonb_build_object('key', 'page', 'missing', to_jsonb(case when sh.logo_url is not null
      then '{}'::text[] else array['logo'] end));

    v_miss := array_remove(array[
      case when not v_plan then 'plan' end,
      case when sh.assistant_welcome is null then 'welcome' end], null);
    v_list := v_list || jsonb_build_object('key', 'assistant', 'missing', to_jsonb(v_miss));
  end if;

  for st in select * from jsonb_array_elements(v_list) loop
    k := st ->> 'key';
    v_total := v_total + 1;
    if jsonb_array_length(st -> 'missing') = 0 then v_done := v_done + 1;
    elsif not (k = any(v_optional) and k = any(v_skipped)) then v_open := v_open + 1;
    end if;
    v_steps := v_steps || jsonb_build_object(
      'key', k,
      'done', jsonb_array_length(st -> 'missing') = 0,
      'optional', k = any(v_optional),
      'skipped', k = any(v_optional) and k = any(v_skipped),
      'missing', st -> 'missing');
  end loop;
  return jsonb_build_object('kind', sh.kind, 'steps', v_steps, 'done', v_done, 'total', v_total, 'finished', v_open = 0);
end;
$$;
revoke execute on function public.owner_setup_steps(uuid) from public, anon;
grant execute on function public.owner_setup_steps(uuid) to authenticated;


-- ------------------------------------------------------------------ 8. the Telegram bot: each shop's kind

-- as update 66, and each shop's kind (a restaurant's bot shows "Vypredané dnes"); the live bot ignores the new key
create or replace function public.telegram_whoami(p_tg_user bigint, p_count boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  l public.telegram_links%rowtype;
  t public.owner_mcp_tokens%rowtype;
begin
  select * into l from public.telegram_links where tg_user_id = p_tg_user for update;
  if not found then return jsonb_build_object('linked', false); end if;
  if p_count then
    if l.window_start < now() - interval '1 minute' then
      update public.telegram_links set window_start = now(), window_count = 1, last_seen_at = now() where id = l.id;
    elsif l.window_count >= 30 then
      raise exception 'too_many' using errcode = '54000';
    else
      update public.telegram_links set window_count = window_count + 1, last_seen_at = now() where id = l.id;
    end if;
  end if;
  select * into t from public.owner_mcp_tokens where id = l.grant_id;
  return jsonb_build_object(
    'linked', true,
    'link_id', l.id,
    'lang', coalesce((select language from public.profiles where user_id = l.user_id), l.tg_lang, 'sk'),
    'state', l.state,
    'granted', t.id is not null and t.revoked_at is null and t.access_expires_at > now(),
    'scopes', coalesce(to_jsonb(t.scopes), '[]'::jsonb),
    'current_shop', (select s.slug from public.shops s where s.id = l.current_shop_id),
    'shops', coalesce((select jsonb_agg(jsonb_build_object('slug', s.slug, 'name', s.name, 'timezone', s.timezone, 'kind', s.kind,
                                                           'usable', public.shop_has_plan(s.id)
                                                             and exists (select 1 from public.shop_members m
                                                                         where m.shop_id = s.id and m.user_id = l.user_id))
                                        order by s.name)
                       from public.shops s where s.id = any (coalesce(t.shop_ids, '{}'))), '[]'::jsonb));
end;
$$;
revoke execute on function public.telegram_whoami(bigint, boolean) from public, anon, authenticated;
grant execute on function public.telegram_whoami(bigint, boolean) to service_role;

notify pgrst, 'reload schema';
