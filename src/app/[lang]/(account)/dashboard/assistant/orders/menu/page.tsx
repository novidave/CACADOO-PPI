import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { foodTab, type FoodSettings } from "@/lib/foodOwner";
import { plural } from "@/lib/foodRules";
import { DbError } from "@/components/DbError";
import { cardClass } from "@/components/owner/ui";
import { chooseShop } from "../../../contacts/parts";
import { hiddenFields, inputClass, ProOnly } from "../../../shared";
import { checkMenu } from "../actions";
import { btnGhost, FoodHead, FoodNotice } from "../parts";

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

/**
 * Objednávky jedla → Menu (update 79: its own address; it was Nastavenia?view=menu): the menu's sources — Sklad's
 * products with a price (the only price of an order), the menu in the Public folder for descriptions and allergens —
 * and the menu check ("… nie sú v Sklade"). A restaurant reaches it from "Menu" in Hlavné; phase B's menu editor
 * replaces this page.
 */
export default async function FoodMenuPage({ params, searchParams }: PageProps<"/[lang]/dashboard/assistant/orders/menu">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const f = dict.food;
  const chosen = await chooseShop(supabase, first(sp.shop));
  if (chosen.error) return <DbError message={chosen.error} dict={dict} />;
  const shop = chosen.shop;
  if (!shop) redirect(`/${lang}/dashboard`);
  const [res, docsRes, foodTabRes] = await Promise.all([
    supabase.rpc("owner_food_settings", { p_shop_id: shop.id }),
    supabase.rpc("owner_food_menu_docs", { p_shop_id: shop.id }),
    foodTab(supabase, shop.id),
  ]);
  if (res.error) return <DbError message={res.error.message} dict={dict} />;
  const s = res.data as FoodSettings;
  const docs = (docsRes.error ? [] : (docsRes.data ?? [])) as MenuDoc[];
  const hidden = (extra: Record<string, string> = {}) => hiddenFields(lang, shop)({ back: "menu", ...extra });
  const canWrite = s.has_plan;
  const check = s.menu_check;
  const skladHref = `/${lang}/dashboard/sklad?shop=${shop.slug}`;
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
        switchHref={(slug) => `/${lang}/dashboard/assistant/orders/menu?${new URLSearchParams({ shop: slug })}`}
      />
      <div className="flex w-full max-w-xl flex-col gap-5" data-food-settings="menu">
        {!canWrite && <ProOnly dict={dict} href={`/${lang}/dashboard/plan?shop=${shop.slug}`} />}
        <FoodNotice f={f} ok={first(sp.ok)} err={first(sp.err)} />

        <section id="menu" className={`${cardClass} scroll-mt-4`}>
          <h2 className="text-[19px] font-bold">{f.s_menu}</h2>
          <p className="text-sm text-muted">{f.s_menu_hint}</p>
          <div className="flex items-center justify-between gap-3 rounded-lg bg-[#F6F7F9] p-3">
            <span className="flex flex-col">
              <strong>{s.sklad_source ? plural(s.menu_items, { one: f.s_sklad_one, few: f.s_sklad_few, many: f.s_sklad_many }, lang) : f.s_sklad_off}</strong>
              {s.menu_categories.length > 0 && <span className="text-sm text-muted">{s.menu_categories.join(" · ")}</span>}
            </span>
            <Link href={skladHref} className="flex min-h-11 flex-none items-center text-sm font-semibold underline underline-offset-4">
              {f.s_open_sklad}
            </Link>
          </div>
          {docs.length === 0 ? (
            <p className="text-sm text-muted">
              {f.s_docs_none}{" "}
              <Link href={`/${lang}/dashboard/assistant/folders?shop=${shop.slug}`} className="font-semibold underline underline-offset-4">
                {f.s_docs_upload}
              </Link>
            </p>
          ) : (
            docs.slice(0, 3).map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-3 rounded-lg bg-[#F6F7F9] p-3">
                <span className="flex min-w-0 flex-col">
                  <strong className="truncate">{d.name}</strong>
                  <span className="text-sm text-muted">{t(f.s_doc_line, { date: day(d.created_at) })}</span>
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
        </section>

      {/* the menu check: Claude lists the dishes of the menu, the pairing with Sklad is decided in SQL */}
      {canWrite && docs.length > 0 && (
        <form action={checkMenu} className={`${cardClass} gap-2`}>
          {hidden()}
          <label className="flex flex-col gap-1 text-sm font-semibold">
            {f.s_check_doc}
            <select name="document_id" className={inputClass} defaultValue={check?.document_id ?? docs[0].id}>
              {docs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
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

      </div>
    </div>
  );
}
