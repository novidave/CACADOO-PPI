import type { Metadata } from "next";
import Link from "next/link";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { SCAN_CODE } from "@/lib/sklad";
import { DbError } from "@/components/DbError";
import { btn, first, loadSklad, Notice, PlanCounter, SkladShell } from "../../parts";
import { ProductForm } from "../../ProductForm";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/sklad/products/new">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).sklad.new_product_title };
}

/** "+ Nový produkt" — also where an unknown scanned code lands (?ean=…). At the free plan's limit: the way to Pro. */
export default async function SkladNewProduct({ params, searchParams }: PageProps<"/[lang]/dashboard/sklad/products/new">) {
  const { lang } = await params;
  const sp = await searchParams;
  const ctx = await loadSklad(lang, sp);
  if (!ctx.ok) return <DbError message={ctx.error} dict={ctx.dict} />;
  const { dict, s, session, shop, shops, hidden, href } = ctx;
  const { data, error } = await session.supabase.rpc("owner_stock_source", { p_shop_id: shop.id });
  if (error) return <DbError message={error.message} dict={dict} />;
  const src = data as { active: string; sklad_products?: number; sklad_limit?: number | null };
  const products = src.sklad_products ?? 0;
  const limit = src.sklad_limit ?? null;
  const ean = SCAN_CODE.test(first(sp.ean) ?? "") ? first(sp.ean)! : "";
  const planHref = `/${ctx.lang}/dashboard/plan?${new URLSearchParams({ shop: shop.slug })}`;

  return (
    <SkladShell lang={ctx.lang} s={s} dict={dict} shops={shops} shop={shop} current="products" source={src.active}>
      <h2 className="text-xl font-bold">{s.new_product_title}</h2>
      {ean && <p className="text-sm">{s.scan_unknown}</p>}
      <Notice s={s} ok={first(sp.ok)} err={first(sp.err)} />
      {limit !== null && products >= limit ? (
        <section className="flex flex-col gap-3 rounded-xl border border-line p-4" data-sklad-limit>
          <PlanCounter s={s} products={products} limit={limit} planHref={planHref} />
          <Link href={planHref} className={btn}>
            {s.limit_go_pro}
          </Link>
        </section>
      ) : (
        <ProductForm s={s} hidden={hidden} p={{ ean, vat_rate: 23, unit: "ks", min_qty: 0 }} saving={dict.owner.saving} cancelHref={href("/products")} />
      )}
    </SkladShell>
  );
}
