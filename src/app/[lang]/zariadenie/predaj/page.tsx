import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { saleProducts, type SkladRow } from "@/lib/sklad";
import { type PredajLabels, SkladPredaj } from "@/components/SkladPredaj";
import { can, DeviceShell, loadDevice, NotPaired } from "../device";

export async function generateMetadata({ params }: PageProps<"/[lang]/zariadenie/predaj">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).sklad.sale_title };
}

const LIST = 500;

/** Predaj on a paired phone (database update 72): the same basket as Môj obchod, through the phone's door. */
export default async function DeviceSale({ params, searchParams }: PageProps<"/[lang]/zariadenie/predaj">) {
  const { lang } = await params;
  const sp = await searchParams;
  const { s, d, device, rpc, lang: l } = await loadDevice(lang);
  if (!device || !rpc) return <NotPaired lang={l} d={d} />;
  if (!can(device, "sale")) notFound();
  const texts = s as Record<string, string>;
  if (device.sale_source === "ekasa") {
    return (
      <DeviceShell lang={l} d={d} device={device}>
        <section className="flex flex-col gap-2 rounded-xl border border-line p-4" data-sklad-sale-off>
          <strong className="text-lg">{s.sale_off_title}</strong>
          <p className="text-sm text-muted">{s.sale_off_text}</p>
        </section>
      </DeviceShell>
    );
  }
  const [prod, info] = await Promise.all([
    rpc("owner_sklad_products", { p_q: null, p_filter: "all", p_limit: LIST + 1, p_offset: 0 }),
    rpc("owner_sklad_sale_info", {}),
  ]);
  if (prod.error || info.error) return <DeviceShell lang={l} d={d} device={device}><p role="alert">{s.err_failed}</p></DeviceShell>;
  const rows = (prod.data as { rows: SkladRow[] }).rows;
  const sale = info.data as { location: { name: string } | null; qr_ready: boolean; recent: { id: string; status: string }[] };
  const labels = Object.fromEntries(Object.keys(texts).filter((k) => k.startsWith("sale_") || k.startsWith("pay_") || k.startsWith("err_") || k.startsWith("items_")).map((k) => [k, texts[k]])) as PredajLabels;
  return (
    <DeviceShell lang={l} d={d} device={device}>
      {typeof sp.ok === "string" && texts[`ok_${sp.ok}`] && (
        <p role="status" className="rounded-xl border border-foreground p-3 font-medium">
          {texts[`ok_${sp.ok}`]}
        </p>
      )}
      <SkladPredaj
        lang={l}
        shopId={device.shop.id}
        shopSlug={device.shop.slug}
        products={saleProducts(rows.slice(0, LIST))}
        complete={rows.length <= LIST}
        location={sale.location?.name ?? ""}
        qrReady={sale.qr_ready}
        statuses={Object.fromEntries(sale.recent.map((r) => [r.id, r.status]))}
        links={{ settings: "", movements: "", newProduct: "", salePath: `/${l}/zariadenie/predaj`, query: "" }}
        labels={labels}
      />
    </DeviceShell>
  );
}
