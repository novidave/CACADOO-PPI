import type { Locale } from "@/i18n/config";
import { t, type Dictionary } from "@/i18n/dictionaries";
import type { ShopTexts } from "@/lib/contentTranslations";
import { formatPrice } from "@/lib/format";
import { allergenLegend, menuSections, orderLines, type MenuCategory, type MenuDish, type ShopMenu as Menu } from "@/lib/menuRules";
import { itemNames } from "@/lib/names";
import { MenuToolsLazy } from "./MenuToolsLazy";
import { StockDot } from "./StockDot";

/** The section's id and each category's anchor (the chips scroll there). */
export const categoryAnchor = (category: MenuCategory | null) => (category ? `menu-c-${category.id}` : "menu-c-other");

/** A category's name in the page language: the translation of its dishes' category (update 40's item_category). */
export function categoryName(category: MenuCategory | null, dishes: MenuDish[], texts: ShopTexts | null, other: string) {
  if (!category) return other;
  const first = dishes[0];
  return texts && first ? texts.text("item_category", first.id, category.name) : category.name;
}

/**
 * A restaurant's Menu on its page (update 80), instead of "Produkty / Zoznam": server-rendered (crawlers and the page
 * without JavaScript read every dish), sticky category chips, the dishes in the owner's order with their sizes and
 * prices (Sklad's sale price — the only price), allergen numbers with one legend of the numbers used, the tags,
 * "Vypredané dnes" in grey. No stock dot on an untracked dish (it is not stock); a tracked one keeps the dot as in the
 * shop's lists. "Objednať" (only while ordering in the assistant is on) opens the assistant with that dish or size in
 * the order (MenuTools → the assistant's loader → the chat route, which puts it into the cart card priced by
 * food_quote); without JavaScript the link starts the assistant's question. `matched` = a search without JavaScript
 * (?mq=): only those dishes are drawn.
 */
export function ShopMenu({
  menu,
  lang,
  dict,
  texts,
  slug,
  path,
  ordering,
  q,
  matched,
  preview = false,
}: {
  menu: Menu;
  lang: Locale;
  dict: Dictionary;
  texts: ShopTexts | null;
  slug: string;
  /** The shop page's own address ("Objednať" without JavaScript leads there with the question). */
  path: string;
  ordering: boolean;
  q: string;
  matched: string[] | null;
  /** The owner's preview: no search, no ordering, no ids that would clash with the page. */
  preview?: boolean;
}) {
  const m = dict.menu;
  // a search without JavaScript (?mq=): every dish is still in the page, the others hidden (the live search shows them again)
  const shown = matched ? new Set(matched) : null;
  const hide = (dish: MenuDish) => (shown ? !shown.has(dish.id) : false);
  const sections = menuSections(menu);
  const legend = allergenLegend(menu.items);
  const money = (cents: number) => formatPrice(cents / 100, lang, menu.currency);
  const id = (base: string) => (preview ? undefined : base);
  const dishName = (dish: MenuDish) => itemNames(dish.name, dish.name_i18n, lang);

  return (
    <section id={id("menu")} className="flex scroll-mt-4 flex-col gap-3" aria-labelledby={id("menu-heading")} data-shop-menu>
      <h2 id={id("menu-heading")} className="text-[19px] font-bold">
        {m.title}
      </h2>
      {!preview && menu.items.length > 0 && (
        <MenuToolsLazy
          slug={slug}
          path={path}
          q={q}
          count={matched ? menu.items.filter((d) => !hide(d)).length : null}
          labels={{ label: m.search_label, placeholder: m.search_placeholder, go: m.search_go, clear: m.search_clear, found: m.found, none: m.none }}
        />
      )}
      {sections.length > 1 && (
        <nav aria-label={m.chips_label} className="ppi-menu-chips" data-menu-chips>
          {sections.map((s) => (
            <a
              key={categoryAnchor(s.category)}
              href={`#${categoryAnchor(s.category)}`}
              data-menu-chip={s.category?.id ?? "other"}
              tabIndex={preview ? -1 : undefined}
              hidden={s.dishes.every(hide) || undefined}
            >
              {categoryName(s.category, s.dishes, texts, m.other)}
            </a>
          ))}
        </nav>
      )}
      {menu.items.length === 0 ? (
        <p className="text-sm text-muted" data-menu-empty>
          {m.empty}
        </p>
      ) : (
        sections.map((s) => {
          const anchor = categoryAnchor(s.category);
          return (
            <section
              key={anchor}
              id={id(anchor)}
              className="flex scroll-mt-16 flex-col gap-2.5"
              aria-labelledby={id(`${anchor}-h`)}
              data-menu-section={s.category?.id ?? "other"}
              hidden={s.dishes.every(hide) || undefined}
            >
              <h3 id={id(`${anchor}-h`)} className="text-[17px] font-bold">
                {categoryName(s.category, s.dishes, texts, m.other)}
              </h3>
              <ul className="flex flex-col gap-2.5">
                {s.dishes.map((dish) => {
                  const names = dishName(dish);
                  const description = texts ? texts.text("item_description", dish.id, dish.description) : dish.description;
                  const lines = orderLines(dish);
                  const soldOut = lines.every((l) => l.sold_out);
                  return (
                    <li key={dish.id} className="ppi-menu-dish" data-menu-dish={dish.id} data-sold-out={soldOut || undefined} hidden={hide(dish) || undefined}>
                      <div className="flex items-start gap-3">
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <h4 className="text-[16px] leading-snug font-bold">{names.primary}</h4>
                          {names.secondary && <p className="text-[13px] text-muted">{names.secondary}</p>}
                          {description && <p className="text-[14px] leading-normal text-[#5B6670]">{description}</p>}
                          {(dish.tags.length > 0 || dish.allergens.length > 0) && (
                            <p className="flex flex-wrap items-center gap-1.5 text-[13px]">
                              {dish.tags.map((tag) => (
                                <span key={tag} className="ppi-menu-tag" data-menu-tag={tag}>
                                  {tag === "veg" ? m.tag_veg : m.tag_spicy}
                                </span>
                              ))}
                              {dish.allergens.length > 0 && (
                                <span className="text-muted" data-menu-allergens>
                                  {t(m.allergens_list, { list: dish.allergens.join(", ") })}
                                </span>
                              )}
                            </p>
                          )}
                        </div>
                        {dish.photo && (
                          // eslint-disable-next-line @next/next/no-img-element -- the stored 800 px photo straight from storage
                          <img
                            src={dish.photo.small}
                            alt=""
                            width={96}
                            height={96}
                            loading="lazy"
                            decoding="async"
                            className="h-24 w-24 shrink-0 rounded-[14px] object-cover"
                            data-menu-photo
                          />
                        )}
                      </div>
                      <ul className="ppi-menu-lines">
                        {lines.map((line) => {
                          const label = line.label ? `${names.primary} ${line.label}` : names.primary;
                          const message = t(m.order_message, { name: line.label ? `${dish.name} ${line.label}` : dish.name });
                          return (
                            <li key={line.id} data-menu-line={line.id} data-sold-out={line.sold_out || undefined}>
                              {line.label && <span className="min-w-0 flex-1 text-[14px]">{line.label}</span>}
                              <span className={`flex items-center gap-2 text-[15px] font-bold ${line.label ? "" : "flex-1"}`}>
                                {line.tracked && (
                                  <StockDot state={line.sold_out ? "sold_out" : "available"} label={line.sold_out ? dict.stock.dot_sold_out : dict.stock.dot_available} />
                                )}
                                {money(line.price_cents)}
                              </span>
                              {line.sold_out ? (
                                <span className="ppi-menu-soldout" data-menu-soldout>
                                  {m.sold_out_today}
                                </span>
                              ) : ordering && !preview ? (
                                <a
                                  href={`${path}?${new URLSearchParams({ ask: message })}#assistant`}
                                  className="ppi-menu-order"
                                  aria-label={t(m.order_aria, { name: label })}
                                  data-menu-order={line.id}
                                  data-order-text={message}
                                >
                                  {m.order}
                                </a>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })
      )}
      {legend.length > 0 && (
        <details className="ppi-menu-legend" data-menu-legend>
          <summary>{m.legend}</summary>
          <ul className="mt-2 grid gap-1 text-[14px] sm:grid-cols-2">
            {legend.map((a) => (
              <li key={a}>
                <span className="font-bold">{a}</span> – {m[`allergen_${a}` as keyof typeof m]}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
