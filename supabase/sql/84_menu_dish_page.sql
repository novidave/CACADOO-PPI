-- Update 84 (2026-11-05, at the owner's request): a restaurant's dishes in the shop page's "Produkty / Zoznam" box
-- (the first tab reads "Jedlá"), each row a link to the dish's own page — the product page's design. This file adds the
-- one read that page needs: which restaurant a dish (or one of its sizes) belongs to. Everything else is update 80's
-- shop_menu(slug), unchanged: the page finds the dish there, so the price, the sizes, "Vypredané dnes", the allergens
-- and the photo are decided exactly as on the shop page.
--
-- Nothing is deleted or changed; no table, grant or policy is touched.

/**
 * The restaurant and the dish of a menu item: {slug, dish} for a dish or one of its sizes (a size gives its dish),
 * only while shop_menu() would show it — an active shop of kind food, the menu item and its dish not hidden. null for
 * anything else (a product of a shop with goods, a hidden dish, an unknown id). Visitors' read, cached like shop_menu.
 */
create or replace function public.shop_menu_dish_of(p_item uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
set jit = off
as $$
  select jsonb_build_object('slug', s.slug, 'dish', coalesce(i.menu_parent, i.shop_item_id))
  from public.sklad_items i
  join public.shops s on s.id = i.shop_id and s.is_active and s.kind = 'food'
  left join public.sklad_items p on p.shop_item_id = i.menu_parent
  where i.shop_item_id = p_item
    and i.menu_item
    and not i.menu_hidden
    and (i.menu_parent is null or (p.menu_item and not p.menu_hidden and p.menu_parent is null))
  limit 1
$$;
revoke execute on function public.shop_menu_dish_of(uuid) from public;
grant execute on function public.shop_menu_dish_of(uuid) to anon, authenticated, service_role;
