import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import type { SkladRow } from "@/lib/sklad";
import { DbError } from "@/components/DbError";
import { type InventuraLabels, SkladInventura } from "@/components/SkladInventura";
import { loadSklad, Notice, first, SkladShell, UUID } from "../../parts";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/sklad/counts/[id]">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const s = (await getDictionary(lang)).sklad;
  return { title: `${s.tab_counts} · ${s.title}` };
}

interface Count {
  id: string;
  number: string;
  name: string | null;
  status: string;
  blind: boolean;
  shelf: string | null;
  location: string | null;
  in_scope: number;
  counted: number;
  uncounted: { item_id: string; name: string; code: string | null }[];
}

/**
 * The counting phone of an open count: the products for the scanner and the search (names, codes, EANs only — never
 * a quantity), the counted numbers and the products not counted yet. A closed count goes to its differences.
 */
export default async function SkladCount({ params, searchParams }: PageProps<"/[lang]/dashboard/sklad/counts/[id]">) {
  const { lang, id } = await params;
  const sp = await searchParams;
  if (!UUID.test(id)) notFound();
  const ctx = await loadSklad(lang, sp);
  if (!ctx.ok) return <DbError message={ctx.error} dict={ctx.dict} />;
  const { dict, s, session, shop, shops, href } = ctx;
  const [c, prod] = await Promise.all([
    session.supabase.rpc("owner_sklad_count", { p_shop_id: shop.id, p_count_id: id, p_counter: null }),
    session.supabase.rpc("owner_sklad_products", { p_shop_id: shop.id, p_q: null, p_filter: "all", p_limit: 5000, p_offset: 0 }),
  ]);
  const error = c.error ?? prod.error;
  if (error) return <DbError message={error.message} dict={dict} />;
  if (!c.data) notFound();
  const count = c.data as Count;
  if (count.status !== "open") redirect(href(`/counts/${id}/diff`));
  const labels = Object.fromEntries(Object.entries(s as Record<string, string>).filter(([k]) => k.startsWith("ic_") || k.startsWith("err_") || k === "sale_less" || k === "sale_more")) as InventuraLabels;
  const rows = (prod.data as { rows: SkladRow[] }).rows;
  return (
    <SkladShell lang={ctx.lang} s={s} dict={dict} shops={shops} shop={shop} current="counts" source={null}>
      <Notice s={s} ok={first(sp.ok)} err={first(sp.err)} />
      <SkladInventura
        lang={ctx.lang}
        shopId={shop.id}
        countId={id}
        title={`${s.tab_counts} ${count.number}${count.name ? ` · ${count.name}` : ""}`}
        subtitle={[count.location, count.shelf ? `${s.ic_shelf} ${count.shelf}` : null].filter(Boolean).join(" · ")}
        blind={count.blind}
        inScope={count.in_scope}
        counted={count.counted}
        products={rows.map((r) => ({ id: r.id, name: r.name, code: r.code ?? null, ean: r.ean ?? null }))}
        uncounted={count.uncounted}
        diffHref={href(`/counts/${id}/diff`)}
        labels={labels}
      />
    </SkladShell>
  );
}
