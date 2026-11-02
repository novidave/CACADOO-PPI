"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Locale } from "@/i18n/config";
import { formatPrice } from "@/lib/format";
import {
  addToBasket,
  type Basket,
  basketView,
  findProducts,
  formatQty,
  type Payment,
  productByCode,
  readBasket,
  type SaleProduct,
  setBasketQty,
} from "@/lib/sklad";
import { lookupSaleProducts, sellBasket } from "@/app/[lang]/(account)/dashboard/sklad/actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: string) => UUID.test(v);
const newId = () => crypto.randomUUID();
const serverBasket: Basket = { id: "", lines: [], pay: "cash", pending: null };

/**
 * The basket kept in this browser (localStorage, try/catch: a blocked storage keeps it for the visit). Read once on
 * first use: a QR sale finished meanwhile (here or on the terminal) clears it, a cancelled one frees it.
 */
function basketStore(key: string, statuses: Record<string, string>, qrReady: boolean) {
  let cache: Basket | null = null;
  const subs = new Set<() => void>();
  const get = (): Basket => {
    if (cache) return cache;
    let b: Basket | null = null;
    try {
      b = readBasket(window.localStorage.getItem(key), isId);
    } catch {}
    if (!b) b = { id: newId(), lines: [], pay: "cash", pending: null };
    if (b.pending && statuses[b.pending] === "done") b = { id: newId(), lines: [], pay: "cash", pending: null };
    else if (b.pending && statuses[b.pending] === "cancelled") b = { ...b, pending: null };
    if (!qrReady && b.pay === "qr") b = { ...b, pay: "cash" };
    cache = b;
    return b;
  };
  const update = (next: Basket | ((b: Basket) => Basket)) => {
    cache = typeof next === "function" ? next(get()) : next;
    try {
      window.localStorage.setItem(key, JSON.stringify(cache));
    } catch {}
    subs.forEach((f) => f());
  };
  const subscribe = (f: () => void) => {
    subs.add(f);
    return () => {
      subs.delete(f);
    };
  };
  return { get, update, subscribe };
}

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));

export type PredajLabels = Record<
  | "sale_search" | "sale_search_ph" | "sale_results" | "sale_none" | "sale_add" | "sale_scanned" | "sale_added" | "sale_unknown"
  | "sale_unknown_add" | "sale_no_price_short" | "sale_no_price" | "sale_basket" | "sale_empty" | "sale_empty_hint" | "sale_stock"
  | "sale_sold_out" | "sale_warn" | "sale_low" | "sale_per_unit" | "sale_less" | "sale_more" | "sale_remove" | "sale_qty"
  | "sale_from" | "sale_clear" | "sale_pay_label" | "pay_cash" | "pay_card" | "pay_qr" | "sale_note_ekasa" | "sale_note_qr"
  | "sale_qr_off" | "sale_qr_off_link" | "sale_total" | "items_one" | "items_few" | "items_other" | "sale_confirm"
  | "sale_confirm_empty" | "sale_show_qr" | "sale_saving" | "sale_offline" | "sale_done_title" | "sale_done_text"
  | "sale_done_ekasa" | "sale_new" | "sale_show_moves" | "sale_pending_banner" | "sale_pending_open" | "err_failed"
  | "err_no_price" | "err_empty" | "err_no_iban" | "err_not_found" | "err_qty",
  string
>;

interface Props {
  lang: Locale;
  shopId: string;
  shopSlug: string;
  products: SaleProduct[];
  complete: boolean;
  location: string;
  qrReady: boolean;
  /** today's sales by id → status (a QR sale finished or cancelled elsewhere clears or frees the basket) */
  statuses: Record<string, string>;
  links: { settings: string; movements: string; newProduct: string; salePath: string; query: string };
  labels: PredajLabels;
}

/**
 * Sklad → Predaj (database update 68): the basket for the counter on a phone, a tablet or a computer.
 * - The USB scanner (anywhere on the page) and the camera ("Skenovať", the Sklad scanner) put a product into the
 *   basket: SkladScanner sends `sklad:scan`, this screen takes it (an unknown code offers "Nový produkt").
 * - Search by name without accents, code or EAN; on a wide screen the products are tiles beside the basket.
 * - The basket lives in this browser (localStorage `ppi.sklad.basket.<shop id>`, try/catch; a blocked storage keeps it
 *   for the visit) with its own sale id, so a second tap or a retry is the same sale in the database.
 * - Hotovosť / Karta: "Potvrdiť predaj" takes the goods off at once (the receipt comes from the shop's eKasa).
 *   QR platba: the sale waits on its QR page until the owner confirms "Zaplatené".
 * Stock, prices and what is allowed are decided in SQL (owner_sklad_sell); the screen only shows what will happen.
 */
export function SkladPredaj(p: Props) {
  const L = p.labels;
  const router = useRouter();
  const key = `ppi.sklad.basket.${p.shopId}`;
  const store = useMemo(() => basketStore(key, p.statuses, p.qrReady), [key, p.statuses, p.qrReady]);
  const basket = useSyncExternalStore(store.subscribe, store.get, () => serverBasket);
  const setBasket = store.update;
  const [extra, setExtra] = useState<SaleProduct[]>([]);
  const [q, setQ] = useState("");
  const [remote, setRemote] = useState<{ q: string; rows: SaleProduct[] } | null>(null);
  const [last, setLast] = useState<{ kind: "scanned" | "added" | "unknown" | "no_price"; text: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ text: string; location: string } | null>(null);
  const doneRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const all = useMemo(() => {
    const m = new Map<string, SaleProduct>();
    for (const x of [...p.products, ...extra]) m.set(x.id, x);
    return m;
  }, [p.products, extra]);
  const list = useMemo(() => [...all.values()], [all]);
  const money = useCallback((n: number) => formatPrice(n, p.lang, "EUR"), [p.lang]);
  const plural = useMemo(() => new Intl.PluralRules(p.lang), [p.lang]);
  const items = (n: number) => {
    const c = plural.select(n);
    return fill(c === "one" ? L.items_one : c === "few" ? L.items_few : L.items_other, { n });
  };

  const add = useCallback((prod: SaleProduct, kind: "scanned" | "added") => {
    if (prod.price === null) {
      setLast({ kind: "no_price", text: fill(L.sale_no_price, { name: prod.name }) });
      return;
    }
    setError(null);
    setBasket((b) => ({ ...b, lines: addToBasket(b.lines, prod.id) }));
    setLast({ kind, text: prod.name });
  }, [L.sale_no_price, setBasket]);

  // a scan: the local list first, else the database (a big shop's list is only the first 500)
  const onCode = useCallback(
    async (code: string) => {
      const local = productByCode(list, code);
      if (local) return add(local, "scanned");
      if (!p.complete) {
        const more = await lookupSaleProducts({ lang: p.lang, shopId: p.shopId, q: code });
        const hit = productByCode(more, code);
        if (hit) {
          setExtra((e) => [...e, hit]);
          return add(hit, "scanned");
        }
      }
      setLast({ kind: "unknown", text: fill(L.sale_unknown, { code }), code });
    },
    [add, list, p.complete, p.lang, p.shopId, L.sale_unknown],
  );

  useEffect(() => {
    const onScan = (e: Event) => {
      e.preventDefault();
      if (searchRef.current && document.activeElement === searchRef.current) setQ("");
      void onCode(String((e as CustomEvent<string>).detail ?? ""));
    };
    window.addEventListener("sklad:scan", onScan);
    return () => window.removeEventListener("sklad:scan", onScan);
  }, [onCode]);

  // the search: in the list, or (a big shop) in the database, only the newest answer
  const asked = useRef(0);
  useEffect(() => {
    const words = q.trim();
    if (!words || p.complete) return;
    const n = ++asked.current;
    const timer = window.setTimeout(async () => {
      const more = await lookupSaleProducts({ lang: p.lang, shopId: p.shopId, q: words }).catch(() => [] as SaleProduct[]);
      if (n !== asked.current) return;
      setExtra((e) => [...e.filter((x) => !more.some((m) => m.id === x.id)), ...more]);
      setRemote({ q: words, rows: more });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [q, p.complete, p.lang, p.shopId]);
  const words = q.trim();
  const results = !words ? [] : p.complete ? findProducts(list, words, 30) : remote?.q === words ? remote.rows : [];

  const view = basketView(basket.lines, all);
  const has = view.rows.length > 0;
  const isQr = basket.pay === "qr";

  const confirm = async () => {
    if (!has || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await sellBasket({
        lang: p.lang,
        shopId: p.shopId,
        shopSlug: p.shopSlug,
        saleId: basket.id,
        lines: basket.lines,
        payment: basket.pay,
        replaces: basket.pending,
      });
      if (!res.ok && res.error === "done") {
        // the waiting QR sale was paid meanwhile (e.g. on the terminal): this basket is sold
        setBasket({ id: newId(), lines: [], pay: "cash", pending: null });
        router.refresh();
      }
      if (!res.ok || !res.sale) {
        const k = `err_${res.error}` as keyof PredajLabels;
        setError(L[k] ?? L.err_failed);
        return;
      }
      if (res.sale.status === "pending") {
        // the QR sale waits; a later attempt (another payment) is a new sale
        setBasket((b) => ({ ...b, id: newId(), pending: res.sale!.id }));
        router.push(`${p.links.salePath}/${res.sale.id}?${p.links.query}`);
        return;
      }
      if (res.sale.status === "cancelled") {
        setBasket((b) => ({ ...b, id: newId() }));
        setError(L.err_failed);
        return;
      }
      setDone({ text: `${formatQty(res.sale.pieces, "ks", p.lang)} · ${money(res.sale.total)}`, location: res.sale.location ?? p.location });
      setBasket({ id: newId(), lines: [], pay: basket.pay === "qr" ? "cash" : basket.pay, pending: null });
      setLast(null);
      router.refresh();
    } catch {
      setError(L.sale_offline);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (done) doneRef.current?.showModal();
  }, [done]);

  const closeDone = () => {
    doneRef.current?.close();
    setDone(null);
    searchRef.current?.focus();
  };

  const stockText = (prod: SaleProduct) =>
    prod.total <= 0 ? L.sale_sold_out : fill(L.sale_stock, { n: formatQty(prod.total, prod.unit, p.lang) });
  const dot = (prod: SaleProduct) => (prod.total <= 0 ? "#D64545" : "#1E9E5A");
  const opts: { k: Payment; label: string }[] = [
    { k: "cash", label: L.pay_cash },
    { k: "card", label: L.pay_card },
    { k: "qr", label: L.pay_qr },
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]" data-sklad-predaj>
      <section aria-label={L.sale_results} className="flex min-w-0 flex-col gap-3">
        <label className="flex min-h-12 items-center gap-2 rounded-xl border border-[#D6D6D6] px-3 focus-within:border-foreground">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <span className="sr-only">{L.sale_search}</span>
          <input
            ref={searchRef}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={L.sale_search_ph}
            className="min-w-0 flex-1 bg-transparent py-2 text-base outline-none"
            data-scan-ok
            autoComplete="off"
            enterKeyHint="search"
            onKeyDown={(e) => {
              if (e.key === "Enter" && results.length === 1) {
                add(results[0], "added");
                setQ("");
              }
            }}
          />
        </label>

        {last && (
          <div role="status" className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-[#F7F7F7] p-3 text-sm" data-sklad-last={last.kind}>
            {last.kind === "scanned" && <strong>{L.sale_scanned}</strong>}
            {last.kind === "added" && <strong>{L.sale_added}</strong>}
            <span>{last.text}</span>
            {last.kind === "unknown" && last.code && (
              <Link href={`${p.links.newProduct}&${new URLSearchParams({ ean: last.code })}`} className="font-semibold underline underline-offset-4">
                {L.sale_unknown_add}
              </Link>
            )}
          </div>
        )}

        {/* the products: on a phone only while searching, on a wide screen always as tiles */}
        <div className={q.trim() ? "" : "hidden lg:block"}>
          {words && results.length === 0 && (p.complete || remote?.q === words) && <p className="text-muted">{L.sale_none}</p>}
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {(q.trim() ? results : list.slice(0, 60)).map((prod) => {
              const inBasket = basket.lines.find((l) => l.item_id === prod.id)?.qty ?? 0;
              return (
                <li key={prod.id}>
                  <button
                    type="button"
                    onClick={() => {
                      add(prod, "added");
                      if (q.trim()) setQ("");
                    }}
                    aria-label={fill(L.sale_add, { name: prod.name })}
                    className="relative flex min-h-[76px] w-full flex-col justify-between gap-1 rounded-xl border border-line p-3 text-left active:bg-[#F2F2F2]"
                    data-sklad-tile={prod.code ?? prod.id}
                  >
                    <span className="flex flex-col pr-8">
                      <strong className="text-[15px] font-semibold leading-snug">{prod.name}</strong>
                      <span className="text-[13px] text-muted">{prod.code}</span>
                    </span>
                    <span className="flex items-center justify-between gap-2 text-[13px]">
                      <span className="flex items-center gap-1.5">
                        <span aria-hidden="true" className="inline-block size-2.5 rounded-full" style={{ background: dot(prod) }} />
                        {stockText(prod)}
                      </span>
                      <strong className="text-[15px]">{prod.price === null ? L.sale_no_price_short : money(prod.price)}</strong>
                    </span>
                    {inBasket > 0 && (
                      <span className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-full bg-foreground text-[13px] font-bold text-white">
                        {inBasket}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <aside aria-label={L.sale_basket} className="flex flex-col gap-3 lg:sticky lg:top-4 lg:self-start">
        {basket.pending && (
          <p role="status" className="rounded-xl border border-foreground p-3 text-sm" data-sklad-pending>
            {L.sale_pending_banner}{" "}
            <Link href={`${p.links.salePath}/${basket.pending}?${p.links.query}`} className="font-semibold underline underline-offset-4">
              {L.sale_pending_open}
            </Link>
          </p>
        )}
        <h2 className="text-lg font-bold">
          {L.sale_basket} {has && <span className="font-medium text-muted">· {items(view.rows.length)}</span>}
        </h2>
        <div className="flex flex-col divide-y divide-line rounded-xl border border-line">
          {view.rows.map((r) => (
            <div key={r.product.id} className="flex flex-col gap-1.5 p-3" data-sklad-line={r.product.code ?? r.product.id}>
              <div className="flex items-start justify-between gap-3">
                <strong className="text-[15px] font-semibold leading-snug">{r.product.name}</strong>
                <strong className="whitespace-nowrap text-[15px]">{money(r.lineTotal)}</strong>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted">
                <span>{r.product.code}</span>
                <span aria-hidden="true">·</span>
                <span aria-hidden="true" className="inline-block size-2.5 rounded-full" style={{ background: dot(r.product) }} />
                <span>{stockText(r.product)}</span>
              </div>
              {r.short && (
                <span className="text-[13px] font-semibold text-[#B91C1C]">{fill(L.sale_warn, { n: formatQty(r.after, r.product.unit, p.lang) })}</span>
              )}
              {r.low && (
                <span className="text-[13px] font-semibold">
                  {fill(L.sale_low, { n: formatQty(r.after, r.product.unit, p.lang), min: formatQty(r.product.min, r.product.unit, p.lang) })}
                </span>
              )}
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] text-muted">{fill(L.sale_per_unit, { price: money(r.product.price ?? 0), unit: r.product.unit })}</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setBasket((b) => ({ ...b, lines: setBasketQty(b.lines, r.product.id, r.line.qty - 1) }))}
                    aria-label={r.line.qty <= 1 ? L.sale_remove : L.sale_less}
                    className="flex size-11 items-center justify-center rounded-xl border border-[#D6D6D6]"
                  >
                    {r.line.qty <= 1 ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
                      </svg>
                    ) : (
                      <span aria-hidden="true" className="text-xl leading-none">−</span>
                    )}
                  </button>
                  <span aria-label={L.sale_qty} className="min-w-10 text-center text-[17px] font-bold tabular-nums">
                    {new Intl.NumberFormat(p.lang, { maximumFractionDigits: 3 }).format(r.line.qty)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setBasket((b) => ({ ...b, lines: setBasketQty(b.lines, r.product.id, r.line.qty + 1) }))}
                    aria-label={L.sale_more}
                    className="flex size-11 items-center justify-center rounded-xl border border-[#D6D6D6]"
                  >
                    <span aria-hidden="true" className="text-xl leading-none">+</span>
                  </button>
                </div>
              </div>
            </div>
          ))}
          {!has && (
            <div className="flex flex-col items-center gap-1 p-6 text-center">
              <strong>{L.sale_empty}</strong>
              <span className="text-sm text-muted">{L.sale_empty_hint}</span>
            </div>
          )}
        </div>

        <section className="flex flex-col gap-3 rounded-xl border border-line p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              {L.sale_from} <strong>{p.location}</strong>
            </span>
            {has && (
              <button type="button" onClick={() => setBasket((b) => ({ ...b, lines: [] }))} className="min-h-11 font-semibold underline underline-offset-4">
                {L.sale_clear}
              </button>
            )}
          </div>
          <div role="group" aria-label={L.sale_pay_label} className="grid grid-cols-3 gap-2">
            {opts.map((o) => (
              <button
                key={o.k}
                type="button"
                aria-pressed={basket.pay === o.k}
                disabled={o.k === "qr" && !p.qrReady}
                onClick={() => setBasket((b) => ({ ...b, pay: o.k }))}
                className={`min-h-12 rounded-xl border px-2 text-[15px] font-bold disabled:opacity-40 ${
                  basket.pay === o.k ? "border-foreground bg-foreground text-white" : "border-[#D6D6D6] bg-white"
                }`}
                data-sklad-pay={o.k}
              >
                {o.label}
              </button>
            ))}
          </div>
          <span className="text-[13px] text-muted">{isQr ? L.sale_note_qr : L.sale_note_ekasa}</span>
          {!p.qrReady && (
            <span className="text-[13px]">
              {L.sale_qr_off}{" "}
              <Link href={p.links.settings} className="font-semibold underline underline-offset-4">
                {L.sale_qr_off_link}
              </Link>
            </span>
          )}
          <div className="flex items-baseline justify-between gap-2">
            <span>{fill(L.sale_total, { items: items(view.rows.length) })}</span>
            <strong className="text-[26px]">{money(view.total)}</strong>
          </div>
          {error && (
            <p role="alert" className="rounded-xl border border-foreground p-3 text-sm font-medium" data-sklad-sale-error>
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={!has || busy || view.noPrice}
            aria-busy={busy}
            className="inline-flex min-h-14 items-center justify-center gap-2 rounded-xl border border-foreground bg-foreground px-4 text-[17px] font-bold text-white disabled:opacity-40"
            data-sklad-confirm
          >
            {busy ? L.sale_saving : !has ? L.sale_confirm_empty : fill(isQr ? L.sale_show_qr : L.sale_confirm, { total: money(view.total) })}
          </button>
        </section>
      </aside>

      <dialog
        ref={doneRef}
        onClose={() => setDone(null)}
        aria-labelledby="sklad-done-title"
        className="m-auto w-[min(100vw-32px,420px)] rounded-2xl border border-line p-6 backdrop:bg-black/50"
        data-sklad-done
      >
        {done && (
          <div className="flex flex-col items-center gap-3 text-center">
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#1E9E5A" strokeWidth="2.4" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <path d="m7.5 12.5 3 3 6-6.5" />
            </svg>
            <h2 id="sklad-done-title" className="text-xl font-bold">
              {L.sale_done_title}
            </h2>
            <p>
              {fill(L.sale_done_text, { location: done.location })} <strong>{done.text}</strong>
            </p>
            <p className="text-sm text-muted">{L.sale_done_ekasa}</p>
            <button type="button" onClick={closeDone} className="inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-foreground px-4 font-bold text-white" autoFocus>
              {L.sale_new}
            </button>
            <Link href={p.links.movements} className="min-h-11 font-semibold underline underline-offset-4">
              {L.sale_show_moves}
            </Link>
          </div>
        )}
      </dialog>
    </div>
  );
}
