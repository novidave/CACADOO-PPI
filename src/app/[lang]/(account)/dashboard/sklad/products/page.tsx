import type { Metadata } from "next";
import Link from "next/link";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { formatPrice } from "@/lib/format";
import { formatQty, isCardAction, type SkladRow } from "@/lib/sklad";
import { DbError } from "@/components/DbError";
import { btn, first, loadSklad, Notice, PlanCounter, SkladShell } from "../parts";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/sklad/products">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const s = (await getDictionary(lang)).sklad;
  return { title: `${s.tab_products} · ${s.title}` };
}

const FILTERS = ["all", "low", "out", "no_price"] as const;
type Filter = (typeof FILTERS)[number];
const PAGE = 100;

interface Products {
  counts: Record<Filter, number>;
  rows: SkladRow[];
  products: number;
  limit: number | null;
  source: string;
}

/**
 * Sklad → Produkty (screen 14): search by name (without accents), code or EAN; Všetko / Pod minimom / Vypredané / Bez
 * ceny with their counts; each row = the name, the code, the stock per location, the total with its dot and the price.
 * "+ Nový produkt" — or at the free plan's limit "Pre viac produktov prejdite na Pro" (no error). From Prehľad's
 * quick actions (?act=receipt|sale) a tapped row opens the card with that form.
 */
export default async function SkladProducts({ params, searchParams }: PageProps<"/[lang]/dashboard/sklad/products">) {
  const { lang } = await params;
  const sp = await searchParams;
  const ctx = await loadSklad(lang, sp);
  if (!ctx.ok) return <DbError message={ctx.error} dict={ctx.dict} />;
  const { dict, s, session, shop, shops, href } = ctx;
  const q = (first(sp.q) ?? "").slice(0, 100);
  const f: Filter = FILTERS.find((x) => x === first(sp.f)) ?? "all";
  const act = isCardAction(first(sp.act)) ? first(sp.act)! : "";
  const offset = Math.max(0, Math.floor(Number(first(sp.from)) || 0));
  const { data, error } = await session.supabase.rpc("owner_sklad_products", {
    p_shop_id: shop.id,
    p_q: q || null,
    p_filter: f,
    p_limit: PAGE + 1,
    p_offset: offset,
  });
  if (error) return <DbError message={error.message} dict={dict} />;
  const res = data as Products;
  const rows = res.rows.slice(0, PAGE);
  const more = res.rows.length > PAGE;
  const label: Record<Filter, string> = { all: s.f_all, low: s.f_low, out: s.f_out, no_price: s.f_no_price };
  const atLimit = res.limit !== null && res.products >= res.limit;
  const planHref = `/${ctx.lang}/dashboard/plan?${new URLSearchParams({ shop: shop.slug })}`;
  const keep = (extra: Record<string, string>) => ({ ...(q ? { q } : {}), ...(f !== "all" ? { f } : {}), ...(act ? { act } : {}), ...extra });

  return (
    <SkladShell lang={ctx.lang} s={s} dict={dict} shops={shops} shop={shop} current="products" source={res.source}>
      <Notice s={s} ok={first(sp.ok)} err={first(sp.err)} />
      {act && <p className="rounded-xl border border-foreground p-3 text-sm font-semibold">{act === "sale" ? s.pick_for_sale : s.pick_for_receipt}</p>}

      <form method="get" action={`/${ctx.lang}/dashboard/sklad/products`} className="flex gap-2" role="search">
        <input type="hidden" name="shop" value={shop.slug} />
        {f !== "all" && <input type="hidden" name="f" value={f} />}
        {act && <input type="hidden" name="act" value={act} />}
        <label className="flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-xl border border-[#D6D6D6] px-3">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5C5C5C" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
          <span className="sr-only">{s.search_label}</span>
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder={s.search_placeholder}
            className="min-w-0 flex-1 bg-transparent text-base outline-none"
            data-scan-ok
            autoComplete="off"
          />
        </label>
        <button type="submit" className={`${btn} flex-none`}>
          {s.search}
        </button>
      </form>

      <div role="group" aria-label={s.filter} className="flex gap-2 overflow-x-auto pb-0.5">
        {FILTERS.map((x) => (
          <Link
            key={x}
            href={href("/products", { ...(q ? { q } : {}), ...(x !== "all" ? { f: x } : {}), ...(act ? { act } : {}) })}
            aria-pressed={x === f}
            className={`flex min-h-11 flex-none items-center whitespace-nowrap rounded-full px-3.5 text-sm font-semibold ${
              x === f ? "border-2 border-foreground bg-foreground text-white" : "border border-[#D6D6D6] bg-white"
            }`}
            data-sklad-filter={x}
          >
            {x === "all" ? label[x] : `${label[x]} (${res.counts[x]})`}
          </Link>
        ))}
      </div>

      <section aria-label={s.tab_products} className="flex flex-col">
        {rows.length === 0 ? (
          <p className="py-6 text-center text-[15px] text-muted">{q || f !== "all" ? s.none_filter : s.none_yet}</p>
        ) : (
          rows.map((p) => {
            const note = p.is_out
              ? t(s.out_line, { min: formatQty(p.min_qty, p.unit, ctx.lang) })
              : p.is_low
                ? t(s.low_note, { min: formatQty(p.min_qty, p.unit, ctx.lang) })
                : p.no_price
                  ? s.no_price
                  : "";
            return (
              <Link
                key={p.id}
                href={href(`/products/${p.id}`, act ? { act } : {})}
                className="flex items-center justify-between gap-3 border-b border-line py-3"
                data-sklad-row={p.code}
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <strong className="text-[15px]">{p.name}</strong>
                  <span className="text-[13px] text-muted">
                    {[p.code, ...p.locations.map((l) => `${l.name} ${new Intl.NumberFormat(ctx.lang, { maximumFractionDigits: 3 }).format(l.qty)}`)].join(" · ")}
                  </span>
                  {note && <span className={`text-[13px] font-bold ${p.is_out ? "text-[#B42318]" : "text-[#7A4A00]"}`}>{note}</span>}
                </span>
                <span className="flex flex-none flex-col items-end gap-0.5">
                  <span className="flex items-center gap-1.5 text-base font-bold">
                    <span
                      role="img"
                      aria-label={p.total > 0 ? dict.stock.dot_available : dict.stock.dot_sold_out}
                      className={`size-2.5 flex-none rounded-full shadow-[0_0_0_1px_rgba(0,0,0,.25)] ${p.total > 0 ? "bg-[#22C55E]" : "bg-[#EF4444]"}`}
                    />
                    {p.total > 0 ? formatQty(p.total, p.unit, ctx.lang) : s.sold_out}
                  </span>
                  <span className="text-sm text-muted">{p.sale_price === null ? s.no_price_short : formatPrice(p.sale_price, ctx.lang, "EUR")}</span>
                </span>
              </Link>
            );
          })
        )}
        {(offset > 0 || more) && (
          <div className="flex justify-between pt-3 text-sm">
            {offset > 0 ? (
              <Link href={href("/products", keep({ from: String(Math.max(0, offset - PAGE)) }))} className="flex min-h-11 items-center underline underline-offset-4">
                {s.prev}
              </Link>
            ) : (
              <span />
            )}
            {more && (
              <Link href={href("/products", keep({ from: String(offset + PAGE) }))} className="flex min-h-11 items-center underline underline-offset-4">
                {s.next}
              </Link>
            )}
          </div>
        )}
      </section>

      <footer className="flex flex-col gap-2 border-t border-line pt-3">
        <PlanCounter s={s} products={res.products} limit={res.limit} planHref={planHref} />
        {atLimit ? (
          <Link href={planHref} className={`${btn} min-h-[52px]`} data-sklad-limit>
            {s.limit_go_pro}
          </Link>
        ) : (
          <Link href={href("/products/new")} className={`${btn} min-h-[52px]`} data-sklad-new>
            {s.new_product}
          </Link>
        )}
      </footer>
    </SkladShell>
  );
}
