import type { Dictionary } from "@/i18n/dictionaries";
import type { ShopProductsLabels } from "@/components/ShopProducts";

/** The texts of the products tabs (ShopProducts / ShopList), in the page language. */
export function productLabels(dict: Dictionary, dishes = false): ShopProductsLabels {
  const s = dict.shop;
  return {
    // a restaurant (update 84): "Jedlá" (the tab, its group's name, "Nájdené: 3 jedlá"); everything else as in every shop
    tabs: dishes ? s.tabs_label_dishes : s.tabs_label,
    products: dishes ? s.tab_dishes : s.tab_products,
    list: s.tab_list,
    listCount: s.tab_list_count,
    placeholder: s.search_items,
    clear: s.search_clear,
    button: dict.search.button,
    found: dishes ? { one: s.found_dish_one, few: s.found_dish_few, other: s.found_dish_other } : { one: s.found_one, few: s.found_few, other: s.found_other },
    none: s.search_none,
    similar: s.search_similar,
    add: s.list_add,
    addMore: s.list_add_more,
    status: { dot_available: dict.stock.dot_available, dot_sold_out: dict.stock.dot_sold_out, dot_no_info: dict.stock.dot_no_info },
    prev: s.prev,
    next: s.next,
    pageOf: s.page_of,
    said: { added: s.said_added, less: s.said_less, removed: s.said_removed, copied: s.said_copied, copyFailed: s.said_copy_failed },
    shopList: {
      title: s.list_title,
      empty: s.list_empty,
      total: s.list_total,
      minus: s.list_minus,
      plus: s.list_plus,
      remove: s.list_remove,
      qty: s.list_qty,
      swipe: s.list_swipe,
      copy: s.list_copy,
      copied: s.list_copied,
      copyManual: s.list_copy_manual,
    },
  };
}
