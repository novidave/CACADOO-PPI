import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import type { SkladRow } from "@/lib/sklad";
import { type InventuraLabels, SkladInventura } from "@/components/SkladInventura";
import { can, DeviceShell, loadDevice, NotPaired } from "../../device";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: PageProps<"/[lang]/zariadenie/inventura/[id]">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).device.tile_counts };
}

/**
 * Counting on a paired phone (database update 72): the same counting screen as Môj obchod, always under the phone's
 * own name (the door sets it); the differences and the approval stay with the owner.
 */
export default async function DeviceCount({ params }: PageProps<"/[lang]/zariadenie/inventura/[id]">) {
  const { lang, id } = await params;
  if (!UUID.test(id)) notFound();
  const { s, d, device, rpc, lang: l } = await loadDevice(lang);
  if (!device || !rpc) return <NotPaired lang={l} d={d} />;
  if (!can(device, "counts")) notFound();
  const [c, prod] = await Promise.all([
    rpc("owner_sklad_count", { p_count_id: id }),
    rpc("owner_sklad_products", { p_q: null, p_filter: "all", p_limit: 5000, p_offset: 0 }),
  ]);
  if (c.error || !c.data || prod.error) notFound();
  const count = c.data as { number: string; name: string | null; status: string; blind: boolean; shelf: string | null; location: string | null; in_scope: number; counted: number; uncounted: { item_id: string; name: string; code: string | null }[] };
  if (count.status !== "open") redirect(`/${l}/zariadenie/inventura`);
  const labels = Object.fromEntries(Object.entries(s as Record<string, string>).filter(([k]) => k.startsWith("ic_") || k.startsWith("err_") || k === "sale_less" || k === "sale_more")) as InventuraLabels;
  const rows = (prod.data as { rows: SkladRow[] }).rows;
  return (
    <DeviceShell lang={l} d={d} device={device}>
      <SkladInventura
        lang={l}
        shopId={device.shop.id}
        countId={id}
        title={`${s.tab_counts} ${count.number}${count.name ? ` · ${count.name}` : ""}`}
        subtitle={[count.location, count.shelf ? `${s.ic_shelf} ${count.shelf}` : null].filter(Boolean).join(" · ")}
        blind={count.blind}
        inScope={count.in_scope}
        counted={count.counted}
        products={rows.map((r) => ({ id: r.id, name: r.name, code: r.code ?? null, ean: r.ean ?? null }))}
        uncounted={count.uncounted}
        diffHref=""
        fixedName={device.name}
        labels={labels}
      />
    </DeviceShell>
  );
}
