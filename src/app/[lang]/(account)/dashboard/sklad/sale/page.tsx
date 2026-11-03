import type { Metadata } from "next";
import Link from "next/link";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { formatPrice } from "@/lib/format";
import { saleProducts, type SkladRow } from "@/lib/sklad";
import { DbError } from "@/components/DbError";
import { type PredajLabels, SkladPredaj } from "@/components/SkladPredaj";
import { btnGhost, card, first, loadSklad, Notice, SkladShell } from "../parts";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/sklad/sale">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const s = (await getDictionary(lang)).sklad;
  return { title: `${s.sale_title} · ${s.title}` };
}

const LIST = 500;
const LABELS = [
  "sale_search", "sale_search_ph", "sale_results", "sale_none", "sale_add", "sale_scanned", "sale_added", "sale_unknown",
  "sale_unknown_add", "sale_no_price_short", "sale_no_price", "sale_basket", "sale_empty", "sale_empty_hint", "sale_stock",
  "sale_sold_out", "sale_warn", "sale_low", "sale_per_unit", "sale_less", "sale_more", "sale_remove", "sale_qty", "sale_from",
  "sale_clear", "sale_pay_label", "pay_cash", "pay_card", "pay_qr", "sale_note_ekasa", "sale_note_qr", "sale_qr_off",
  "sale_qr_off_link", "sale_total", "items_one", "items_few", "items_other", "sale_confirm", "sale_confirm_empty",
  "sale_show_qr", "sale_saving", "sale_offline", "sale_done_title", "sale_done_text", "sale_done_ekasa", "sale_new",
  "sale_show_moves", "sale_pending_banner", "sale_pending_open", "err_failed", "err_no_price", "err_empty", "err_no_iban",
  "err_not_found", "err_qty",
] as const satisfies readonly (keyof PredajLabels)[];

interface SaleInfo {
  location: { id: string; name: string } | null;
  qr_ready: boolean;
  today: { sales: number; total: number };
  pending: { id: string; total: number; vs: string; created_at: string }[];
  recent: { id: string; status: string }[];
}

/**
 * Sklad → Predaj (database update 68; screens "Predaj (mobil)" and "Predaj na tablete"): the basket for the counter.
 * The products (the first 500 by name; a bigger shop's search and scans ask the database) and the sale location come
 * from SQL; the basket itself is the browser's (SkladPredaj). Without JavaScript only the waiting QR sales show.
 */
export default async function SkladSale({ params, searchParams }: PageProps<"/[lang]/dashboard/sklad/sale">) {
  const { lang } = await params;
  const sp = await searchParams;
  const ctx = await loadSklad(lang, sp);
  if (!ctx.ok) return <DbError message={ctx.error} dict={ctx.dict} />;
  const { dict, s, session, shop, shops, href } = ctx;
  const [prod, info, ekasa] = await Promise.all([
    session.supabase.rpc("owner_sklad_products", { p_shop_id: shop.id, p_q: null, p_filter: "all", p_limit: LIST + 1, p_offset: 0 }),
    session.supabase.rpc("owner_sklad_sale_info", { p_shop_id: shop.id }),
    session.supabase.rpc("owner_sklad_ekasa_info", { p_shop_id: shop.id }),
  ]);
  // update 71: while sales come from the eKasa export the Predaj screen is off (before update 71: always on)
  const fromEkasa = (ekasa.data as { sale_source?: string } | null)?.sale_source === "ekasa";
  if (prod.error) return <DbError message={prod.error.message} dict={dict} />;
  if (info.error) return <DbError message={info.error.message} dict={dict} />;
  const res = prod.data as { rows: SkladRow[]; source: string };
  const sale = info.data as SaleInfo;
  const rows = res.rows.slice(0, LIST);
  const labels = Object.fromEntries(LABELS.map((k) => [k, (s as Record<string, string>)[k]])) as PredajLabels;
  const statuses = Object.fromEntries(sale.recent.map((r) => [r.id, r.status]));
  const plural = new Intl.PluralRules(ctx.lang).select(sale.today.sales);
  const salesWord = (plural === "one" ? s.sales_one : plural === "few" ? s.sales_few : s.sales_other).replace("{n}", String(sale.today.sales));

  return (
    <SkladShell lang={ctx.lang} s={s} dict={dict} shops={shops} shop={shop} current="sale" source={res.source}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-bold">{s.sale_title}</h2>
        <span className="text-sm text-muted" data-sklad-today>
          {s.sale_today.replace("{n}", salesWord).replace("{total}", formatPrice(sale.today.total, ctx.lang, "EUR"))}
        </span>
      </div>
      <Notice s={s} ok={first(sp.ok)} err={first(sp.err)} />
      {sale.pending.length > 0 && (
        <ul className="flex flex-col gap-2" data-sklad-pending-list>
          {sale.pending.map((x) => (
            <li key={x.id}>
              <Link href={href(`/sale/${x.id}`)} className="flex min-h-12 items-center justify-between gap-3 rounded-xl border border-foreground px-4">
                <span>
                  {s.qr_waiting} · VS {x.vs}
                </span>
                <strong>{formatPrice(x.total, ctx.lang, "EUR")}</strong>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {fromEkasa ? (
        <section className={card} aria-labelledby="sale-off" data-sklad-sale-off>
          <h3 id="sale-off" className="text-lg font-bold">{s.sale_off_title}</h3>
          <p className="text-sm text-muted">{s.sale_off_text}</p>
          <div className="flex flex-wrap gap-2">
            <Link href={href("/ekasa")} className={btnGhost}>
              {s.sale_off_import}
            </Link>
            <Link href={href("/settings") + "#sales"} className={btnGhost}>
              {s.sale_off_settings}
            </Link>
          </div>
        </section>
      ) : (
      <SkladPredaj
        lang={ctx.lang}
        shopId={shop.id}
        shopSlug={shop.slug}
        products={saleProducts(rows)}
        complete={res.rows.length <= LIST}
        location={sale.location?.name ?? ""}
        qrReady={sale.qr_ready}
        statuses={statuses}
        links={{
          settings: href("/settings") + "#payment",
          movements: href("/movements", { kind: "sale" }),
          newProduct: href("/products/new"),
          salePath: `/${ctx.lang}/dashboard/sklad/sale`,
          query: new URLSearchParams({ shop: shop.slug }).toString(),
        }}
        labels={labels}
      />
      )}
      <p className="text-sm">
        <Link href={href("/terminal")} className="font-semibold underline underline-offset-4">
          {s.qr_terminal_link}
        </Link>{" "}
        <span className="text-muted">– {s.pay_terminal_hint}</span>
      </p>
    </SkladShell>
  );
}
