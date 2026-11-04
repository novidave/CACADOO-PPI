import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { formatDate, formatDateTime, formatPrice } from "@/lib/format";
import { formatQty, isCardAction, margin, netPrice, signedQty, stockValue, type CardAction, type SkladKind } from "@/lib/sklad";
import { DbError } from "@/components/DbError";
import { PendingButton } from "@/components/PendingButton";
import { moveStock } from "../../actions";
import { btnGhost, card, first, loadSklad, Notice, SkladShell, UUID } from "../../parts";
import { ProductForm } from "../../ProductForm";
import { ProductPhotoField } from "@/components/owner/ProductPhotoField";
import { ownerProductPhoto, productPhotoLabels } from "@/lib/ownerPhotos";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/sklad/products/[id]">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).sklad.title };
}

interface Card {
  id: string;
  name: string;
  code: string;
  ean: string | null;
  brand: string | null;
  description: string | null;
  unit: string;
  vat_rate: number;
  sale_price: number | null;
  min_qty: number;
  shelf: string | null;
  supplier: string | null;
  last_cost: number | null;
  last_cost_at: string | null;
  avg_cost: number | null;
  margin_reports: boolean;
  total: number;
  public: boolean;
  locations: { location_id: string; name: string; note: string | null; qty: number; sale_default: boolean; receipt_default: boolean }[];
  movements: { id: string; kind: SkladKind; qty: number; unit_cost: number | null; reason: string | null; ref: string | null; device_label: string | null; created_at: string; location: string; to_location: string | null }[];
  movement_count: number;
}

const input = "min-h-12 rounded-xl border border-[#D6D6D6] px-3 text-base outline-none focus:border-foreground";

/**
 * The product card (screens 4–5): name, code and EAN, the total with its dot and what the shop page shows; Príjem /
 * Výdaj / Odpis / Presun (one form each: amount, location, reason; Príjem also the purchase price without VAT) and
 * Oprava; the stock per location and the minimum; "Predaj" (price with and without VAT); the private "Nákup" card (the
 * margin and the stock value only with Maržové prehľady); "Na stránke produktu"; the last 5 movements. On a notebook
 * two columns. Every form carries its own movement id, so a second tap never counts twice.
 */
export default async function SkladProduct({ params, searchParams }: PageProps<"/[lang]/dashboard/sklad/products/[id]">) {
  const { lang, id } = await params;
  if (!UUID.test(id)) notFound();
  const sp = await searchParams;
  const ctx = await loadSklad(lang, sp);
  if (!ctx.ok) return <DbError message={ctx.error} dict={ctx.dict} />;
  const { dict, s, session, shop, shops, hidden, href } = ctx;
  const [res, src, photo] = await Promise.all([
    session.supabase.rpc("owner_sklad_product", { p_shop_id: shop.id, p_item_id: id }),
    session.supabase.rpc("owner_stock_source", { p_shop_id: shop.id }),
    // the product's one photo (database update 78), shown only on its product page
    ownerProductPhoto(session.supabase, id),
  ]);
  if (res.error) return <DbError message={res.error.message} dict={dict} />;
  const p = res.data as Card | null;
  if (!p) notFound();
  const source = (src.data as { active?: string } | null)?.active ?? null;
  const act: CardAction | null = isCardAction(first(sp.act)) ? (first(sp.act) as CardAction) : null;
  const editing = first(sp.edit) === "1";
  const tz = shop.timezone;
  const L = ctx.lang;
  const q = (n: number) => formatQty(n, p.unit, L);
  const kindText = (k: SkladKind) => (s as Record<string, string>)[`kind_${k}`] ?? k;
  const actText: Record<CardAction, string> = { receipt: s.act_receipt, sale: s.act_sale, writeoff: s.act_writeoff, transfer: s.act_transfer, correction: s.act_correction };
  const m = p.margin_reports ? margin(p.sale_price, p.vat_rate, p.avg_cost) : null;
  const value = p.margin_reports ? stockValue(p.total, p.avg_cost) : null;
  const saleLoc = p.locations.find((l) => l.sale_default)?.location_id ?? p.locations[0]?.location_id;
  const receiptLoc = p.locations.find((l) => l.receipt_default)?.location_id ?? saleLoc;
  const otherLoc = p.locations.find((l) => l.location_id !== saleLoc)?.location_id;
  const shopPage = `/${L}/items/${p.id}`;

  const actionButton = (a: CardAction, icon: React.ReactNode) => (
    <Link
      href={href(`/products/${p.id}`, { act: a })}
      aria-current={act === a ? "true" : undefined}
      className={`flex min-h-14 items-center justify-center gap-2 rounded-xl border text-[15px] font-bold ${act === a ? "border-2 border-foreground" : "border-[#D6D6D6]"}`}
      data-sklad-act={a}
    >
      {icon}
      {actText[a]}
    </Link>
  );

  const moveForm = act && (
    <section className="flex flex-col gap-3 rounded-xl border-2 border-foreground p-4" aria-labelledby="sk-move" data-sklad-move={act}>
      <h2 id="sk-move" className="text-[17px] font-bold">{actText[act]}</h2>
      <form action={moveStock} className="flex flex-col gap-3">
        {hidden({ item_id: p.id, mid: randomUUID(), action: act, back: `/products/${p.id}` })}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm font-semibold">
            {act === "correction" ? s.m_qty_signed : t(s.m_qty, { unit: p.unit })}
            <input name="qty" required inputMode="decimal" autoComplete="off" autoFocus className={input} />
            {act === "correction" && <span className="text-[13px] font-normal text-muted">{s.m_qty_signed_hint}</span>}
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold">
            {act === "transfer" ? s.m_from : s.m_location}
            <select name="location_id" defaultValue={act === "receipt" ? receiptLoc : act === "transfer" ? receiptLoc : saleLoc} className={`${input} bg-white`}>
              {p.locations.map((l) => (
                <option key={l.location_id} value={l.location_id}>
                  {l.name} ({q(l.qty)})
                </option>
              ))}
            </select>
          </label>
          {act === "transfer" && (
            <label className="flex flex-col gap-1 text-sm font-semibold">
              {s.m_to}
              <select name="to_location_id" defaultValue={saleLoc === receiptLoc ? otherLoc : saleLoc} className={`${input} bg-white`}>
                {p.locations.map((l) => (
                  <option key={l.location_id} value={l.location_id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {act === "receipt" && (
            <>
              <label className="flex flex-col gap-1 text-sm font-semibold">
                {s.m_cost}
                <input name="unit_cost" inputMode="decimal" autoComplete="off" className={input} />
                <span className="text-[13px] font-normal text-muted">{s.m_cost_hint}</span>
              </label>
              <label className="flex flex-col gap-1 text-sm font-semibold">
                {s.m_ref}
                <input name="ref" maxLength={80} autoComplete="off" className={input} />
              </label>
            </>
          )}
        </div>
        <label className="flex flex-col gap-1 text-sm font-semibold">
          {act === "writeoff" || act === "correction" ? s.m_reason_required : s.m_reason}
          <input name="reason" maxLength={200} required={act === "writeoff" || act === "correction"} autoComplete="off" className={input} />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <PendingButton pending={dict.owner.saving}>{s.m_save}</PendingButton>
          <Link href={href(`/products/${p.id}`)} className="inline-flex min-h-11 items-center px-2 text-sm underline underline-offset-4">
            {s.cancel}
          </Link>
        </div>
      </form>
    </section>
  );

  return (
    <SkladShell lang={L} s={s} dict={dict} shops={shops} shop={shop} current="products" source={source}>
      <div className="flex items-center justify-between">
        <Link href={href("/products")} className="inline-flex min-h-11 items-center gap-1 text-[15px] font-semibold">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
          {s.tab_products}
        </Link>
        {!editing && (
          <Link href={href(`/products/${p.id}`, { edit: "1" })} className={`${btnGhost} min-h-11`} data-sklad-edit>
            {s.edit}
          </Link>
        )}
      </div>
      <Notice s={s} ok={first(sp.ok)} err={first(sp.err)} />

      {editing ? (
        <ProductForm s={s} hidden={hidden} p={p} saving={dict.owner.saving} cancelHref={href(`/products/${p.id}`)} />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <h2 className="text-2xl font-bold leading-tight">{p.name}</h2>
              <span className="text-sm text-muted">{[t(s.code_line, { code: p.code }), p.ean ? t(s.ean_line, { ean: p.ean }) : ""].filter(Boolean).join(" · ")}</span>
              <div className="mt-1 flex items-center gap-2">
                <span
                  role="img"
                  aria-label={p.total > 0 ? dict.stock.dot_available : dict.stock.dot_sold_out}
                  className={`size-3 flex-none rounded-full shadow-[0_0_0_1px_rgba(0,0,0,.25)] ${p.total > 0 ? "bg-[#22C55E]" : "bg-[#EF4444]"}`}
                />
                <strong className="text-xl">{p.total > 0 ? t(s.in_stock, { qty: q(p.total) }) : s.sold_out}</strong>
              </div>
              <span className="text-[13px] text-muted">
                {p.public ? t(s.on_page, { text: p.total > 0 ? t(s.in_stock, { qty: q(p.total) }) : s.sold_out }) : s.no_price}
              </span>
            </div>

            <div role="group" aria-label={s.moves_label} className="grid grid-cols-2 gap-2">
              {actionButton("receipt", <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>)}
              {actionButton("sale", <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M5 12h14" /></svg>)}
              {actionButton("writeoff", <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>)}
              {actionButton("transfer", <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 8h13l-3-3M20 16H7l3 3" /></svg>)}
            </div>
            <Link href={href(`/products/${p.id}`, { act: "correction" })} className="-mt-2 inline-flex min-h-11 items-center self-start text-sm underline underline-offset-4" data-sklad-act="correction">
              {s.correction_link}
            </Link>
            {moveForm}

            <section className={card} aria-labelledby="sk-loc">
              <h3 id="sk-loc" className="text-[17px] font-bold">{s.by_location}</h3>
              <div className="flex flex-col">
                {p.locations.map((l) => (
                  <div key={l.location_id} className="flex items-center justify-between border-b border-line py-2.5">
                    <span className="flex flex-col">
                      <strong className="text-[15px]">{l.name}</strong>
                      {(l.note || p.shelf) && <span className="text-[13px] text-muted">{[l.note, l.sale_default ? p.shelf : ""].filter(Boolean).join(" · ")}</span>}
                    </span>
                    <strong className="text-lg">{q(l.qty)}</strong>
                  </div>
                ))}
                <div className="flex items-center justify-between pt-2.5">
                  <strong className="text-[15px]">{s.total_public}</strong>
                  <strong className="text-lg">{q(p.total)}</strong>
                </div>
              </div>
              <div className="flex items-baseline justify-between border-t border-line pt-3 text-[15px]">
                <span className="text-muted">{s.min_stock}</span>
                <strong>{q(p.min_qty)}</strong>
              </div>
              <span className="text-[13px] text-muted">{s.min_hint}</span>
            </section>
          </div>

          <div className="flex flex-col gap-4">
            <section className={card} aria-labelledby="sk-sale">
              <h3 id="sk-sale" className="text-[17px] font-bold">{s.sale_card}</h3>
              <dl className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-2 text-[15px]">
                <dt className="text-muted">{s.price_gross}</dt>
                <dd className="text-right text-lg font-bold">{p.sale_price === null ? s.no_price_short : formatPrice(p.sale_price, L, "EUR")}</dd>
                <dt className="text-muted">{s.vat_rate}</dt>
                <dd className="text-right font-bold">{p.vat_rate} %</dd>
                <dt className="text-muted">{s.price_net}</dt>
                <dd className="text-right font-bold">{p.sale_price === null ? s.no_price_short : formatPrice(netPrice(p.sale_price, p.vat_rate), L, "EUR")}</dd>
                <dt className="text-muted">{s.unit}</dt>
                <dd className="text-right font-bold">{p.unit}</dd>
                {p.brand && (
                  <>
                    <dt className="text-muted">{s.brand}</dt>
                    <dd className="text-right font-bold">{p.brand}</dd>
                  </>
                )}
              </dl>
            </section>

            <section className={card} aria-labelledby="sk-buy" data-sklad-private>
              <div className="flex items-center justify-between gap-2">
                <h3 id="sk-buy" className="text-[17px] font-bold">{s.buy_card}</h3>
                <span className="inline-flex h-[26px] items-center gap-1 rounded-full bg-[#F2F2F2] px-2.5 text-xs font-bold">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
                  {s.only_you}
                </span>
              </div>
              <dl className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-2 text-[15px]">
                <dt className="text-muted">
                  {s.last_cost}
                  <br />
                  <span className="text-xs">{p.last_cost_at ? t(s.net_on, { date: formatDate(p.last_cost_at, L, tz) }) : s.net}</span>
                </dt>
                <dd className="text-right font-bold">{p.last_cost === null ? s.none_dash : formatPrice(p.last_cost, L, "EUR")}</dd>
                <dt className="text-muted">
                  {s.avg_cost}
                  <br />
                  <span className="text-xs">{s.avg_cost_hint}</span>
                </dt>
                <dd className="text-right font-bold">{p.avg_cost === null ? s.none_dash : formatPrice(p.avg_cost, L, "EUR")}</dd>
                {p.margin_reports && (
                  <>
                    <dt className="text-muted">{s.margin}</dt>
                    <dd className="text-right font-bold">{m ? `${formatPrice(m.amount, L, "EUR")} · ${new Intl.NumberFormat(L, { maximumFractionDigits: 1 }).format(m.percent)} %` : s.none_dash}</dd>
                    <dt className="text-muted">{s.stock_value}</dt>
                    <dd className="text-right font-bold">{value === null ? s.none_dash : formatPrice(value, L, "EUR")}</dd>
                  </>
                )}
                <dt className="text-muted">{s.supplier}</dt>
                <dd className="text-right font-bold">{p.supplier ?? s.none_dash}</dd>
              </dl>
              <span className="text-[13px] text-muted">{p.margin_reports ? s.buy_hint_margin : s.buy_hint}</span>
            </section>

            <section className={card} aria-labelledby="sk-page">
              <h3 id="sk-page" className="text-[17px] font-bold">{s.page_card}</h3>
              <dl className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-2 text-[15px]">
                <dt className="text-muted">{s.description}</dt>
                <dd className="text-right font-semibold">{p.description ? s.description_yes : s.description_no}</dd>
              </dl>
              <div className="flex gap-2">
                <Link href={href(`/products/${p.id}`, { edit: "1" })} className={`${btnGhost} flex-1`}>
                  {p.description ? s.description_edit : s.description_add}
                </Link>
                {p.public && (
                  <Link href={shopPage} className={`${btnGhost} flex-1`}>
                    {s.view_page}
                  </Link>
                )}
              </div>
              <span className="text-[13px] text-muted">{s.page_hint}</span>
            </section>

            {/* The product's one photo (database update 78): only on its product page. */}
            <ProductPhotoField lang={L} itemId={p.id} photo={photo} labels={productPhotoLabels(dict)} />

            <section className={`${card} gap-0`} aria-labelledby="sk-mv">
              <h3 id="sk-mv" className="mb-1 text-[17px] font-bold">{s.tab_movements}</h3>
              {p.movements.length === 0 ? (
                <p className="py-2 text-sm text-muted">{s.movements_none}</p>
              ) : (
                p.movements.map((mv) => (
                  <div key={mv.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 gap-y-0.5 border-b border-line py-2.5 text-sm last:border-b-0">
                    <strong>
                      {kindText(mv.kind)}
                      {mv.ref ? ` ${mv.ref}` : ""} · {mv.kind === "transfer" ? `${mv.location} → ${mv.to_location}` : mv.location}
                    </strong>
                    <strong>{signedQty(mv.kind, mv.qty, L)}</strong>
                    <span className="text-muted">
                      {[formatDateTime(mv.created_at, L, tz), mv.reason, mv.unit_cost !== null ? t(s.per_unit, { price: formatPrice(mv.unit_cost, L, "EUR"), unit: p.unit }) : "", mv.device_label]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    <span />
                  </div>
                ))
              )}
              <Link href={href("/movements", { item: p.id })} className="flex min-h-11 items-center pt-2 text-sm font-semibold underline underline-offset-4">
                {t(s.all_movements, { n: p.movement_count })}
              </Link>
            </section>
          </div>
        </div>
      )}
    </SkladShell>
  );
}
