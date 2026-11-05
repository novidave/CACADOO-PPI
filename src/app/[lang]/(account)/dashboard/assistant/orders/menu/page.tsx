import type { Metadata } from "next";
import "@/components/shopPage.css";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary, t, type Dictionary } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { formatPrice } from "@/lib/format";
import { foodTab, type FoodSettings } from "@/lib/foodOwner";
import { plural } from "@/lib/foodRules";
import { ALLERGENS, readMenu } from "@/lib/menuRules";
import { ownerProductPhoto, productPhotoLabels } from "@/lib/ownerPhotos";
import { dishPhotoSrc, withPhotoUrls } from "@/lib/menu";
import { DbError } from "@/components/DbError";
import { ShopProducts } from "@/components/ShopProducts";
import { dishRows } from "@/lib/shopRows";
import { productLabels } from "@/lib/productLabels";
import { MenuImport } from "@/components/owner/MenuImport";
import { MenuOrderList } from "@/components/owner/MenuOrderList";
import { MenuPreview } from "@/components/owner/MenuPreview";
import { MenuSizeRows } from "@/components/owner/MenuSizeRows";
import { ProductPhotoField } from "@/components/owner/ProductPhotoField";
import { buttonClass, cardClass, fieldClass, ghostClass, textareaClass, Toggle } from "@/components/owner/ui";
import { chooseShop } from "../../../contacts/parts";
import { hiddenFields, inputClass } from "../../../shared";
import { checkMenu } from "../actions";
import { btnGhost, FoodHead } from "../parts";
import { deleteCategory, duplicateDish, orderCategories, orderDishes, saveCategory, saveDish, saveDishPrice, setDishHidden, setSoldOut } from "./actions";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/assistant/orders/menu">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).nav.food_menu };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

interface MenuDoc {
  id: string;
  name: string;
  pages: number;
  created_at: string;
}

interface OwnerVariant {
  id: string;
  label: string;
  price: number | null;
  hidden: boolean;
  qty: number;
  sold_out_today: boolean;
}

interface OwnerDish {
  id: string;
  name: string;
  description: string | null;
  category_id: string | null;
  position: number;
  price: number | null;
  hidden: boolean;
  track_stock: boolean;
  qty: number;
  sold_out_today: boolean;
  allergens: number[];
  tags: string[];
  photo: { small: string; v: number } | null;
  variants: OwnerVariant[];
}

interface OwnerMenu {
  today: string;
  kind: string;
  has_plan: boolean;
  limit: number | null;
  products: number;
  categories: { id: string; name: string; position: number }[];
  items: OwnerDish[];
}

/** A price as the owner types it ("8,90"); empty without one. */
const priceText = (value: number | null, lang: Locale) =>
  value === null ? "" : new Intl.NumberFormat(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }).format(Number(value));

/**
 * Objednávky jedla → Menu (database update 80; its own address since update 79): the restaurant's menu editor —
 * "Nahrať jedálny lístok" (the AI proposes, the owner reviews and saves), the categories (add, rename, order by drag or
 * ▲ ▼, delete an empty one), the dishes in each (add / edit / duplicate / hide, the price inline, "Vypredané dnes" in
 * one tap), the dish form (sizes, allergens 1–14, Vegetariánske / Pikantné, Sledovať zásobu, the photo), the public
 * Menu's preview at a phone's and a computer's width, and update 74's menu check of a PDF in the Public folder. Every
 * rule is in SQL (owner_menu_*: members; prices are Sklad's sale prices with VAT — the only price).
 */
export default async function FoodMenuPage({ params, searchParams }: PageProps<"/[lang]/dashboard/assistant/orders/menu">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const f = dict.food;
  const m = dict.menu;
  const chosen = await chooseShop(supabase, first(sp.shop));
  if (chosen.error) return <DbError message={chosen.error} dict={dict} />;
  const shop = chosen.shop;
  if (!shop) redirect(`/${lang}/dashboard`);
  const [menuRes, settingsRes, docsRes, foodTabRes, publicRes] = await Promise.all([
    supabase.rpc("owner_menu", { p_shop_id: shop.id }),
    supabase.rpc("owner_food_settings", { p_shop_id: shop.id }),
    supabase.rpc("owner_food_menu_docs", { p_shop_id: shop.id }),
    foodTab(supabase, shop.id),
    supabase.rpc("shop_menu", { p_slug: shop.slug }),
  ]);
  if (menuRes.error) return <DbError message={menuRes.error.message} dict={dict} />;
  const menu = menuRes.data as OwnerMenu;
  const s = settingsRes.error ? null : (settingsRes.data as FoodSettings);
  const docs = (docsRes.error ? [] : (docsRes.data ?? [])) as MenuDoc[];
  const preview = publicRes.error ? null : withPhotoUrls(readMenu(publicRes.data));
  const previewRows = preview ? dishRows(preview, lang, "", null) : [];
  const hidden = hiddenFields(lang, shop);
  const plain = { lang, shop_id: shop.id, shop_slug: shop.slug };
  const money = (value: number | null) => (value === null ? "–" : formatPrice(Number(value), lang, "EUR"));
  const editId = first(sp.edit) ?? "";
  const editing = editId === "new" ? null : menu.items.find((d) => d.id === editId) ?? null;
  const showForm = editId === "new" || Boolean(editing);
  const photo = editing ? await ownerProductPhoto(supabase, editing.id) : null;
  const notice = noticeText(dict, first(sp.ok), first(sp.err), first(sp.n));
  const byCategory = [
    ...menu.categories.map((c) => ({ id: c.id, name: c.name, dishes: menu.items.filter((d) => d.category_id === c.id) })),
    { id: "", name: m.ed_no_category, dishes: menu.items.filter((d) => !d.category_id || !menu.categories.some((c) => c.id === d.category_id)) },
  ].filter((c) => c.id || c.dishes.length);
  const editHref = (id: string) => `?${new URLSearchParams({ shop: shop.slug, edit: id })}#dish`;
  const orderLabels = { up: m.ed_up, down: m.ed_down, drag: m.ed_drag, save: m.ed_order_save };
  const check = s?.menu_check ?? null;
  const day = (iso: string) => new Intl.DateTimeFormat(lang, { day: "numeric", month: "numeric" }).format(new Date(iso));

  return (
    <div className="flex w-full flex-col gap-5">
      <FoodHead
        dict={dict}
        lang={lang}
        shops={chosen.shops}
        shop={shop}
        current="menu"
        newOrders={foodTabRes?.new ?? 0}
        couriers={foodTabRes?.parts?.courier_app ?? true}
        switchHref={(slug) => `/${lang}/dashboard/assistant/orders/menu?${new URLSearchParams({ shop: slug })}`}
      />
      <div className="flex w-full max-w-3xl flex-col gap-5" data-menu-editor>
        {notice && (
          <p role={notice.error ? "alert" : "status"} className={`rounded-lg border p-3 ${notice.error ? "border-[#D64545]" : "border-foreground font-medium"}`} data-menu-notice>
            {notice.text}
          </p>
        )}
        {menu.kind !== "food" && <p className="rounded-lg border border-[#F2B705] bg-[#FFF8E1] p-3 text-sm">{m.ed_not_food}</p>}
        <p className="text-sm text-muted">{m.ed_intro}</p>
        {menu.limit !== null && <p className="text-sm">{t(m.ed_limit, { n: menu.limit })}</p>}

        {/* the dish form: a new dish or the one being edited */}
        {showForm && (
          <section id="dish" className={`${cardClass} scroll-mt-4`} data-dish-form={editing?.id ?? "new"}>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[19px] font-bold">{editing ? editing.name : m.ed_dish_new}</h2>
              <Link href={`?${new URLSearchParams({ shop: shop.slug })}`} className="flex min-h-11 items-center text-sm font-semibold underline underline-offset-4">
                {m.ed_close}
              </Link>
            </div>
            <form action={saveDish} className="flex flex-col gap-3.5">
              {hidden({ item_id: editing?.id ?? "" })}
              <label className="flex flex-col gap-1.5 text-sm font-semibold">
                {m.ed_name}
                <input name="name" required maxLength={200} defaultValue={editing?.name ?? ""} className={fieldClass} data-dish-name />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-semibold">
                {m.ed_description}
                <textarea name="description" maxLength={600} rows={2} defaultValue={editing?.description ?? ""} className={textareaClass} />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-semibold">
                {m.ed_category}
                <select name="category_id" defaultValue={editing?.category_id ?? first(sp.cat) ?? ""} className={`${fieldClass} bg-white`}>
                  <option value="">{m.ed_no_category}</option>
                  {menu.categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex w-48 flex-col gap-1.5 text-sm font-semibold">
                {m.ed_price}
                <input name="price" inputMode="decimal" maxLength={12} defaultValue={priceText(editing?.price ?? null, lang)} className={fieldClass} data-dish-price />
              </label>
              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-semibold">{m.ed_sizes}</legend>
                <p className="text-[13px] text-muted">{m.ed_sizes_hint}</p>
                <MenuSizeRows
                  initial={editing?.variants.map((v) => ({ id: v.id, label: v.label, price: priceText(v.price, lang) })) ?? []}
                  labels={{ size: m.ed_size_label, price: m.im_col_price, add: m.ed_size_add, remove: m.ed_size_remove }}
                />
              </fieldset>
              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-semibold">{m.ed_allergens}</legend>
                <div className="grid gap-x-3 sm:grid-cols-2">
                  {ALLERGENS.map((a) => (
                    <label key={a} className="flex min-h-11 items-center gap-2 text-sm">
                      <input type="checkbox" name="allergen" value={a} defaultChecked={editing?.allergens.includes(a)} className="h-5 w-5" />
                      <span>
                        <strong>{a}</strong> – {m[`allergen_${a}` as keyof typeof m]}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset className="flex flex-wrap gap-4">
                <legend className="text-sm font-semibold">{m.ed_tags}</legend>
                {(["veg", "spicy"] as const).map((tag) => (
                  <label key={tag} className="flex min-h-11 items-center gap-2 text-sm font-semibold">
                    <input type="checkbox" name="tag" value={tag} defaultChecked={editing?.tags.includes(tag)} className="h-5 w-5" />
                    {tag === "veg" ? m.tag_veg : m.tag_spicy}
                  </label>
                ))}
              </fieldset>
              <Toggle name="track_stock" label={m.ed_track} hint={m.ed_track_hint} defaultChecked={editing?.track_stock ?? false} />
              <Toggle name="hidden" label={m.ed_hidden} defaultChecked={editing?.hidden ?? false} />
              <button type="submit" className={`${buttonClass} self-start`} data-dish-save>
                {m.ed_save}
              </button>
            </form>
            {editing ? (
              <ProductPhotoField lang={lang} itemId={editing.id} photo={photo} labels={{ ...productPhotoLabels(dict), title: m.ed_photo }} />
            ) : (
              <p className="text-sm text-muted">{m.ed_photo_after}</p>
            )}
          </section>
        )}

        <div className="flex flex-wrap gap-3">
          <Link href={editHref("new")} className={buttonClass} data-dish-new>
            + {m.ed_dish_new}
          </Link>
        </div>

        <details className={cardClass} open={menu.items.length === 0} data-menu-import-card>
          <summary className="flex min-h-11 cursor-pointer items-center text-[17px] font-bold">{m.im_title}</summary>
          <MenuImport shopId={shop.id} slug={shop.slug} labels={m as unknown as Record<string, string>} />
        </details>

        {/* categories: add, rename, delete an empty one, the order */}
        <section id="categories" className={`${cardClass} scroll-mt-4`} data-menu-categories>
          <h2 className="text-[19px] font-bold">{m.ed_categories}</h2>
          <ul className="flex flex-col gap-2">
            {menu.categories.map((c) => (
              <li key={c.id} className="flex flex-wrap items-end gap-2" data-category={c.id}>
                <form action={saveCategory} className="flex min-w-0 flex-1 items-end gap-2">
                  {hidden({ category_id: c.id })}
                  <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-semibold">
                    <span className="sr-only">{m.ed_category_name}</span>
                    <input name="name" required maxLength={60} defaultValue={c.name} className={fieldClass} />
                  </label>
                  <button type="submit" className={ghostClass}>
                    {m.ed_category_rename}
                  </button>
                </form>
                {!menu.items.some((d) => d.category_id === c.id) && (
                  <form action={deleteCategory}>
                    {hidden({ category_id: c.id })}
                    <button type="submit" className={`${ghostClass} text-[#B91C1C]`}>
                      {m.ed_category_delete}
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
          <form action={saveCategory} className="flex items-end gap-2" data-category-add>
            {hidden()}
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-semibold">
              {m.ed_category_name}
              <input name="name" required maxLength={60} className={fieldClass} placeholder="Pizza" />
            </label>
            <button type="submit" className={buttonClass}>
              {m.ed_category_add}
            </button>
          </form>
          {menu.categories.length > 1 && (
            <details>
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold">{m.ed_drag}</summary>
              <MenuOrderList action={orderCategories} hidden={plain} items={menu.categories.map((c) => ({ id: c.id, name: c.name }))} labels={orderLabels} />
            </details>
          )}
        </section>

        {menu.items.length === 0 && <p className="text-sm text-muted" data-menu-empty>{m.ed_empty}</p>}

        {/* the dishes in each category */}
        {byCategory.map((c) => (
          <section key={c.id || "none"} id={`cat-${c.id || "none"}`} className={`${cardClass} scroll-mt-4`} data-menu-category={c.id || "none"}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[19px] font-bold">{c.name}</h2>
              <Link href={`?${new URLSearchParams({ shop: shop.slug, edit: "new", ...(c.id ? { cat: c.id } : {}) })}#dish`} className="flex min-h-11 items-center text-sm font-semibold underline underline-offset-4">
                + {m.ed_dish_new}
              </Link>
            </div>
            <ul className="flex flex-col">
              {c.dishes.map((d) => (
                <DishRow key={d.id} dish={d} lang={lang} m={m} hidden={hidden} money={money} editHref={editHref(d.id)} />
              ))}
            </ul>
            {c.dishes.length > 1 && (
              <details>
                <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold">{m.ed_drag}</summary>
                <MenuOrderList action={orderDishes} hidden={{ ...plain, anchor: c.id || "none" }} items={c.dishes.map((d) => ({ id: d.id, name: d.name }))} labels={orderLabels} />
              </details>
            )}
          </section>
        ))}

        {/* the public Menu as visitors see it */}
        {preview && preview.items.length > 0 && (
          <section className={cardClass} data-menu-preview-card>
            <h2 className="text-[19px] font-bold">{m.ed_preview}</h2>
            <MenuPreview labels={{ phone: m.ed_preview_phone, computer: m.ed_preview_computer }}>
              {/* the restaurant page's "Jedlá / Zoznam" box (update 84), drawn as visitors see it */}
              <ShopProducts
                shopId={shop.id}
                slug={shop.slug}
                lang={lang}
                path=""
                itemBase={`/${lang}/items/`}
                shopName={shop.name}
                address={null}
                initial={{ q: "", kind: null, total: previewRows.length, rows: previewRows }}
                page={1}
                pageSize={1000}
                emptyNote={{ text: m.empty, kind: "menu" }}
                labels={productLabels(dict, true)}
              />
            </MenuPreview>
          </section>
        )}

        {/* update 74's menu check: a PDF of the menu in the Public folder against the menu's dishes */}
        {s && (
          <details className={cardClass} data-food-settings="menu">
            <summary className="flex min-h-11 cursor-pointer items-center text-[17px] font-bold">{m.ed_check_title}</summary>
            <p className="text-sm text-muted">{f.s_menu_hint}</p>
            {docs.length === 0 ? (
              <p className="text-sm text-muted">
                {f.s_docs_none}{" "}
                <Link href={`/${lang}/dashboard/assistant/folders?shop=${shop.slug}`} className="font-semibold underline underline-offset-4">
                  {f.s_docs_upload}
                </Link>
              </p>
            ) : (
              docs.slice(0, 3).map((doc) => (
                <div key={doc.id} className="flex items-center justify-between gap-3 rounded-lg bg-[#F6F7F9] p-3">
                  <span className="flex min-w-0 flex-col">
                    <strong className="truncate">{doc.name}</strong>
                    <span className="text-sm text-muted">{t(f.s_doc_line, { date: day(doc.created_at) })}</span>
                  </span>
                </div>
              ))
            )}
            {check && (
              <div className={`rounded-lg border p-3 ${check.missing.length ? "border-[#F2B705] bg-[#FFF8E1]" : "border-[#1E9E5A]"}`} data-menu-check>
                {check.missing.length ? (
                  <>
                    <strong>{plural(check.missing.length, { one: f.s_missing_one, few: f.s_missing_few, many: f.s_missing_many }, lang)}</strong>
                    <p className="text-sm">{t(f.s_missing_hint, { names: check.missing.slice(0, 12).join(", ") })}</p>
                  </>
                ) : (
                  <strong>{f.s_missing_none}</strong>
                )}
                <p className="text-xs text-muted">{t(f.s_menu_checked, { date: day(check.checked_at), doc: check.document })}</p>
              </div>
            )}
            {s.has_plan && docs.length > 0 && (
              <form action={checkMenu} className="flex flex-col gap-2">
                {hidden({ back: "menu" })}
                <label className="flex flex-col gap-1 text-sm font-semibold">
                  {f.s_check_doc}
                  <select name="document_id" className={inputClass} defaultValue={check?.document_id ?? docs[0].id}>
                    {docs.map((doc) => (
                      <option key={doc.id} value={doc.id}>
                        {doc.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" className={btnGhost} data-menu-check-run>
                  {check ? f.s_check_again : f.s_check}
                </button>
                <p className="text-xs text-muted">{f.s_check_hint}</p>
              </form>
            )}
          </details>
        )}
      </div>
    </div>
  );
}

/** The message after a save: the Menu's own texts, else the food page's (the menu check). */
function noticeText(dict: Dictionary, ok?: string, err?: string, n?: string) {
  const texts = { ...(dict.food as Record<string, string>), ...(dict.menu as Record<string, string>) };
  if (err) return { error: true, text: texts[err] ?? dict.menu.err_failed };
  if (ok && texts[ok]) return { error: false, text: t(texts[ok], { n: n ?? "" }) };
  return null;
}

/** One dish of the editor: its sizes and prices (inline), "Vypredané dnes", Upraviť · Duplikovať · Skryť. */
function DishRow({
  dish,
  lang,
  m,
  hidden,
  money,
  editHref,
}: {
  dish: OwnerDish;
  lang: Locale;
  m: Dictionary["menu"];
  hidden: (extra?: Record<string, string>) => React.ReactNode;
  money: (value: number | null) => string;
  editHref: string;
}) {
  const soldOut = (itemId: string, on: boolean, label: string) => (
    <form action={setSoldOut}>
      {hidden({ item_id: itemId, dish_id: dish.id, sold_out: on ? "0" : "1" })}
      <button
        type="submit"
        aria-pressed={on}
        aria-label={`${m.sold_out_today}: ${label}`}
        className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-3 text-sm font-semibold ${on ? "border-[#111] bg-[#111] text-white" : "border-[#D6D6D6] bg-white"}`}
        data-sold-out-toggle={itemId}
      >
        <span aria-hidden="true">{on ? "✓" : "○"}</span>
        {m.sold_out_today}
      </button>
    </form>
  );
  return (
    <li id={`dish-${dish.id}`} className={`flex scroll-mt-4 flex-col gap-2 border-t border-[#EEE] py-3 first:border-t-0 ${dish.hidden ? "opacity-60" : ""}`} data-dish={dish.id}>
      <div className="flex items-start gap-3">
        {dish.photo && (
          // eslint-disable-next-line @next/next/no-img-element -- the stored 800 px photo
          <img src={dishPhotoSrc(dish.photo.small, dish.photo.v)} alt="" width={56} height={56} className="h-14 w-14 shrink-0 rounded-xl object-cover" />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <strong className="text-base">{dish.name}</strong>
          <span className="flex flex-wrap gap-x-3 text-[13px] text-muted">
            {dish.hidden && <span data-dish-hidden>{m.ed_hidden}</span>}
            {dish.track_stock && !dish.variants.length && <span>{t(m.ed_qty, { n: dish.qty })}</span>}
            {dish.allergens.length > 0 && <span>{t(m.allergens_list, { list: dish.allergens.join(", ") })}</span>}
          </span>
        </div>
      </div>
      {/* the price inline: the dish's own, or each size's */}
      <form action={saveDishPrice} className="flex flex-wrap items-end gap-2" data-dish-price-form>
        {hidden({ item_id: dish.id })}
        {dish.variants.length ? (
          dish.variants.map((v) => (
            <label key={v.id} className="flex w-32 flex-col gap-1 text-[13px] font-semibold">
              {v.label}
              <input type="hidden" name="size_id" value={v.id} />
              <input type="hidden" name="size_label" value={v.label} />
              <input name="size_price" inputMode="decimal" maxLength={12} defaultValue={priceText(v.price, lang)} className={fieldClass} aria-label={t(m.ed_price_of, { name: `${dish.name} ${v.label}` })} />
            </label>
          ))
        ) : (
          <label className="flex w-36 flex-col gap-1 text-[13px] font-semibold">
            {m.ed_price}
            <input name="price" inputMode="decimal" maxLength={12} defaultValue={priceText(dish.price, lang)} className={fieldClass} aria-label={t(m.ed_price_of, { name: dish.name })} data-inline-price />
          </label>
        )}
        <button type="submit" className={ghostClass} data-inline-price-save>
          {m.ed_price_save}
        </button>
        <span className="sr-only">{dish.variants.length ? dish.variants.map((v) => money(v.price)).join(", ") : money(dish.price)}</span>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        {!dish.track_stock && soldOut(dish.id, dish.sold_out_today, dish.name)}
        {!dish.track_stock &&
          dish.variants.length > 1 &&
          dish.variants.map((v) => (
            <span key={v.id} className="flex items-center gap-1 text-[13px]">
              {v.label}: {soldOut(v.id, v.sold_out_today, `${dish.name} ${v.label}`)}
            </span>
          ))}
        <Link href={editHref} className={ghostClass} data-dish-edit>
          {m.ed_dish_edit}
        </Link>
        <form action={duplicateDish}>
          {hidden({ item_id: dish.id })}
          <button type="submit" className={ghostClass} data-dish-duplicate>
            {m.ed_dish_duplicate}
          </button>
        </form>
        <form action={setDishHidden}>
          {hidden({ item_id: dish.id, hidden: dish.hidden ? "0" : "1" })}
          <button type="submit" className={ghostClass} data-dish-hide>
            {dish.hidden ? m.ed_dish_show : m.ed_dish_hide}
          </button>
        </form>
      </div>
    </li>
  );
}
