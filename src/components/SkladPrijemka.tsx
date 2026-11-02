"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Locale } from "@/i18n/config";
import { formatPrice } from "@/lib/format";
import { findProducts, formatQty, type Invoice, parsePrice, productByCode, receiptTotals, type ReceiptLine, type SaleProduct } from "@/lib/sklad";
import {
  confirmReceipt,
  type InvoiceMatch,
  lookupSaleProducts,
  readInvoiceLines,
  type ReceiptJson,
  saveReceipt,
} from "@/app/[lang]/(account)/dashboard/sklad/actions";

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));
const MAX_SIDE = 1568;

export type PrijemkaLabels = Record<string, string>;

interface Line extends ReceiptLine {
  key: string;
  costText: string;
  priceText: string;
}

interface AiRow {
  key: string;
  on: boolean;
  text: string;
  qty: number;
  unit: number;
  ean: string;
  goods: boolean;
  match: InvoiceMatch;
  /** the product chosen (a match or a candidate), or "new" */
  pick: string;
  name: string;
  priceText: string;
}

interface Props {
  lang: Locale;
  shopId: string;
  shopSlug: string;
  receipt: ReceiptJson | null;
  newId: string;
  products: SaleProduct[];
  complete: boolean;
  locations: { id: string; name: string }[];
  defaultLocation: string;
  suppliers: string[];
  links: { list: string; receiptPath: string; query: string; movements: string };
  labels: PrijemkaLabels;
}

let seq = 0;
const key = () => `l${++seq}`;
const toText = (n: number | null | undefined, locale: string) =>
  n === null || n === undefined ? "" : new Intl.NumberFormat(locale, { maximumFractionDigits: 4, useGrouping: false }).format(n);

/** A JPEG copy of a picture, at most `side` px (white behind transparent parts, none of the photo's data). */
async function jpegBase64(source: Blob, side = MAX_SIDE): Promise<string> {
  const bitmap = await createImageBitmap(source, { imageOrientation: "from-image" });
  try {
    const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) throw new Error("no JPEG");
    const url = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
    return url.slice(url.indexOf(",") + 1);
  } finally {
    bitmap.close();
  }
}

/** A PDF in this browser: the text of its first 3 pages, or (a scan) the first page as a picture. */
async function pdfInput(file: File): Promise<{ text?: string; image?: string }> {
  const { openPdf, readText, pagePicture } = await import("@/lib/pdfRead");
  const { doc, close } = await openPdf(file);
  try {
    const parts: string[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, 3); n++) parts.push(await readText(doc, n));
    const text = parts.join("\n\n").trim();
    if (text.length >= 50) return { text };
    const page = await pagePicture(doc, 1);
    return { image: await jpegBase64(page.blob) };
  } finally {
    await close();
  }
}

/**
 * A Príjemka (database update 69; screens "Príjemka", "Príjemka – faktúra AI", "Príjemka (počítač)"): supplier,
 * invoice number, delivery date, the location to stock into; lines from the scanner / camera (`sklad:scan`), the
 * search, "+ Nový produkt" or the AI's reading of an invoice photo / PDF. Each line: pieces, the purchase price per
 * piece without VAT; a new product also its name, EAN and sale price. "Uložiť koncept" keeps the draft; "Potvrdiť
 * príjemku" stocks everything once (owner_sklad_receipt_confirm). The sums are only shown here; SQL decides.
 */
export function SkladPrijemka(p: Props) {
  const L = p.labels;
  const router = useRouter();
  const r = p.receipt;
  const readOnly = r?.status === "done" || r?.status === "discarded";
  const [id] = useState(r?.id ?? p.newId);
  const [number, setNumber] = useState(r?.number ?? "");
  const [supplier, setSupplier] = useState(r?.supplier ?? "");
  const [invoiceNo, setInvoiceNo] = useState(r?.invoice_no ?? "");
  const [date, setDate] = useState(r?.delivered_on ?? "");
  const [loc, setLoc] = useState(r?.location_id ?? p.defaultLocation);
  const [lines, setLines] = useState<Line[]>(() =>
    (r?.lines ?? []).map((l) => ({
      ...l,
      qty: Number(l.qty),
      unit_cost: l.unit_cost === null ? null : Number(l.unit_cost),
      sale_price: l.sale_price === null || l.sale_price === undefined ? null : Number(l.sale_price),
      vat_rate: Number(l.vat_rate ?? 23),
      key: key(),
      costText: toText(l.unit_cost === null ? null : Number(l.unit_cost), p.lang),
      priceText: toText(l.sale_price === null || l.sale_price === undefined ? null : Number(l.sale_price), p.lang),
    })),
  );
  const [extra, setExtra] = useState<SaleProduct[]>([]);
  const [q, setQ] = useState("");
  const [remote, setRemote] = useState<{ q: string; rows: SaleProduct[] } | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "confirm" | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [done, setDone] = useState<ReceiptJson | null>(null);
  const [ai, setAi] = useState<{ state: "reading" } | { state: "result"; invoice: Invoice; addsUp: boolean | null; rows: AiRow[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef<HTMLDialogElement>(null);

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

  const addProduct = useCallback((prod: SaleProduct, n = 1) => {
    setLines((ls) => {
      const at = ls.findIndex((l) => l.item_id === prod.id);
      if (at >= 0) return ls.map((l, i) => (i === at ? { ...l, qty: Math.min(99_999, l.qty + n) } : l));
      if (ls.length >= 200) return ls;
      return [...ls, { item_id: prod.id, name: prod.name, code: prod.code, ean: null, qty: n, unit_cost: null, sale_price: null, vat_rate: 23, src: null, key: key(), costText: "", priceText: "" }];
    });
    setLast(prod.name);
  }, []);

  // a scan: into this receipt (a known code), else a new product with that EAN
  const onCode = useCallback(
    async (code: string) => {
      let hit = productByCode(list, code);
      if (!hit && !p.complete) {
        const more = await lookupSaleProducts({ lang: p.lang, shopId: p.shopId, q: code });
        hit = productByCode(more, code);
        if (hit) setExtra((e) => [...e, hit!]);
      }
      if (hit) return addProduct(hit);
      setLines((ls) => [...ls, { item_id: null, name: "", code: null, ean: code, qty: 1, unit_cost: null, sale_price: null, vat_rate: 23, src: null, key: key(), costText: "", priceText: "" }]);
      setLast(code);
    },
    [addProduct, list, p.complete, p.lang, p.shopId],
  );

  useEffect(() => {
    if (readOnly) return;
    const onScan = (e: Event) => {
      e.preventDefault();
      setQ("");
      void onCode(String((e as CustomEvent<string>).detail ?? ""));
    };
    window.addEventListener("sklad:scan", onScan);
    return () => window.removeEventListener("sklad:scan", onScan);
  }, [onCode, readOnly]);

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
  const results = !words ? [] : p.complete ? findProducts(list, words, 12) : remote?.q === words ? remote.rows.slice(0, 12) : [];

  const change = (k: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  const totals = receiptTotals(lines);
  const badCost = lines.some((l) => l.costText.trim() !== "" && Number.isNaN(parsePrice(l.costText)));
  const badNew = lines.some((l) => !l.item_id && !l.name.trim());

  const input = () => ({
    lang: p.lang,
    shopId: p.shopId,
    shopSlug: p.shopSlug,
    id,
    supplier,
    invoice_no: invoiceNo,
    delivered_on: date,
    location_id: loc,
    lines: lines.map((l): ReceiptLine => ({
      item_id: l.item_id, name: l.name, code: l.code, ean: l.ean, qty: l.qty, unit_cost: l.unit_cost,
      sale_price: l.sale_price, vat_rate: l.vat_rate, src: l.src,
    })),
  });

  const run = async (what: "save" | "confirm") => {
    if (busy || readOnly) return;
    if (badCost || badNew) {
      setMessage({ kind: "err", text: badNew ? L.err_name : L.err_unit_cost });
      return;
    }
    setBusy(what);
    setMessage(null);
    try {
      const res = what === "save" ? await saveReceipt(input()) : await confirmReceipt(input());
      if (!res.ok || !res.receipt) {
        setMessage({ kind: "err", text: L[`err_${res.error}`] ?? L.err_failed });
        return;
      }
      setNumber(res.receipt.number);
      if (what === "save") {
        setMessage({ kind: "ok", text: L.rc_saved });
        if (!r) router.replace(`${p.links.receiptPath}/${res.receipt.id}?${p.links.query}`, { scroll: false });
        return;
      }
      setDone(res.receipt);
    } catch {
      setMessage({ kind: "err", text: L.sale_offline });
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (done) doneRef.current?.showModal();
  }, [done]);

  // ---------------------------------------------------------------- the AI's reading of an invoice
  const readFile = async (file: File) => {
    setAi({ state: "reading" });
    setMessage(null);
    try {
      const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      const payload = isPdf ? await pdfInput(file) : { image: await jpegBase64(file) };
      const res = await readInvoiceLines({ lang: p.lang, shopId: p.shopId, ...payload });
      if (!res.ok || !res.invoice || !res.matches) {
        setAi(null);
        setMessage({ kind: "err", text: L[`err_${res.error}`] ?? L.err_ai_failed });
        return;
      }
      const inv = res.invoice;
      const rows: AiRow[] = inv.lines.map((l, i) => {
        const m = res.matches![i] ?? { kind: "new", item_id: null, name: null, code: null, candidates: [] };
        return {
          key: key(),
          on: l.goods,
          text: l.text,
          qty: l.qty,
          unit: l.unit_net,
          ean: l.ean,
          goods: l.goods,
          match: m,
          pick: m.item_id ?? (m.kind === "unsure" && m.candidates[0] ? m.candidates[0].id : "new"),
          name: l.text,
          priceText: "",
        };
      });
      setAi({ state: "result", invoice: inv, addsUp: res.addsUp ?? null, rows });
      if (!supplier && inv.supplier) setSupplier(inv.supplier);
      if (!invoiceNo && inv.invoice_no) setInvoiceNo(inv.invoice_no);
      if (!date && inv.date) setDate(inv.date);
    } catch {
      setAi(null);
      setMessage({ kind: "err", text: L.err_ai_unreadable });
    }
  };

  const aiAdd = () => {
    if (ai?.state !== "result") return;
    const chosen = ai.rows.filter((x) => x.on && x.goods);
    setLines((ls) => {
      let next = [...ls];
      for (const x of chosen) {
        if (next.length >= 200) break;
        if (x.pick !== "new") {
          const prod = all.get(x.pick) ?? (x.match.item_id === x.pick ? { id: x.pick, name: x.match.name ?? x.text, code: x.match.code } : x.match.candidates.find((c) => c.id === x.pick));
          const at = next.findIndex((l) => l.item_id === x.pick);
          if (at >= 0) {
            next = next.map((l, i) => (i === at ? { ...l, qty: l.qty + x.qty, unit_cost: x.unit, costText: toText(x.unit, p.lang), src: x.text } : l));
            continue;
          }
          next.push({ item_id: x.pick, name: prod?.name ?? x.text, code: prod?.code ?? null, ean: null, qty: x.qty, unit_cost: x.unit, sale_price: null, vat_rate: 23, src: x.text, key: key(), costText: toText(x.unit, p.lang), priceText: "" });
        } else {
          const price = parsePrice(x.priceText);
          next.push({ item_id: null, name: x.name.trim() || x.text, code: null, ean: x.ean || null, qty: x.qty, unit_cost: x.unit, sale_price: price === null || Number.isNaN(price) ? null : price, vat_rate: 23, src: x.text, key: key(), costText: toText(x.unit, p.lang), priceText: x.priceText });
        }
      }
      return next;
    });
    setAi(null);
  };
  const aiChange = (k: string, patch: Partial<AiRow>) =>
    setAi((a) => (a?.state === "result" ? { ...a, rows: a.rows.map((x) => (x.key === k ? { ...x, ...patch } : x)) } : a));

  const chip = (x: AiRow) => {
    if (!x.goods) return { text: L.ai_k_skip, cls: "bg-[#EDEDED] text-[#3D3D3D]" };
    if (x.pick === "new") return { text: L.ai_k_new, cls: "bg-[#FFF1E0] text-[#8A3B00]" };
    if (x.match.kind === "unsure") return { text: L.ai_k_unsure, cls: "bg-[#FFF6D6] text-[#6B4E00]" };
    const t = x.match.kind === "ean" ? L.ai_k_ean : x.match.kind === "code" ? L.ai_k_code : L.ai_k_name;
    return { text: t, cls: "bg-[#E3F4EA] text-[#146C37]" };
  };

  const field = "min-h-11 w-full rounded-xl border border-[#D6D6D6] px-3 text-base outline-none focus:border-foreground disabled:bg-[#F7F7F7]";

  return (
    <div className="flex flex-col gap-4" data-sklad-receipt={r?.status ?? "new"}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-bold">{number ? number : L.rc_new_title}</h2>
        {number && <span className="text-sm text-muted">· {r?.status === "done" ? L.rc_done : L.rc_draft}</span>}
      </div>
      {readOnly && <p className="rounded-xl border border-line bg-[#F7F7F7] p-3 text-sm">{L.rc_readonly}</p>}

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm font-semibold">
          {L.rc_supplier}
          <input value={supplier} onChange={(e) => setSupplier(e.target.value)} list="rc-suppliers" maxLength={120} placeholder={L.rc_supplier_ph} disabled={readOnly} className={field} />
          <datalist id="rc-suppliers">
            {p.suppliers.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold">
          {L.rc_invoice}
          <input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} maxLength={60} placeholder={L.rc_invoice_ph} disabled={readOnly} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold">
          {L.rc_date}
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={readOnly} className={field} />
        </label>
      </div>

      <div role="group" aria-label={L.rc_into} className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{L.rc_into}</span>
        {p.locations.map((l) => (
          <button
            key={l.id}
            type="button"
            aria-pressed={loc === l.id}
            disabled={readOnly}
            onClick={() => setLoc(l.id)}
            className={`min-h-11 rounded-xl border px-4 text-[15px] font-bold ${loc === l.id ? "border-foreground bg-foreground text-white" : "border-[#D6D6D6] bg-white"}`}
          >
            {l.name}
          </button>
        ))}
      </div>

      {!readOnly && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={ai?.state === "reading"}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#D6D6D6] px-4 text-[15px] font-bold disabled:opacity-50"
              data-sklad-ai
            >
              {ai?.state === "reading" ? L.ai_reading : L.rc_ai}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void readFile(f);
              }}
            />
            <button
              type="button"
              onClick={() =>
                setLines((ls) => [...ls, { item_id: null, name: "", code: null, ean: null, qty: 1, unit_cost: null, sale_price: null, vat_rate: 23, src: null, key: key(), costText: "", priceText: "" }])
              }
              className="inline-flex min-h-11 items-center rounded-xl border border-[#D6D6D6] px-4 text-[15px] font-bold"
            >
              {L.rc_add_new}
            </button>
          </div>
          <span className="text-[13px] text-muted">{L.rc_ai_hint}</span>
          <label className="flex min-h-12 items-center gap-2 rounded-xl border border-[#D6D6D6] px-3 focus-within:border-foreground">
            <span className="sr-only">{L.rc_search}</span>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={L.rc_search_ph}
              className="min-w-0 flex-1 bg-transparent py-2 text-base outline-none"
              data-scan-ok
              autoComplete="off"
            />
          </label>
          {results.length > 0 && (
            <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
              {results.map((prod) => (
                <li key={prod.id}>
                  <button
                    type="button"
                    onClick={() => {
                      addProduct(prod);
                      setQ("");
                    }}
                    className="flex min-h-12 w-full items-center justify-between gap-3 px-3 text-left"
                  >
                    <span className="font-semibold">{prod.name}</span>
                    <span className="text-[13px] text-muted">{prod.code}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {last && (
            <p role="status" className="text-sm">
              <strong>{L.rc_scanned}</strong> {last} +1
            </p>
          )}
        </div>
      )}

      {ai?.state === "result" && (
        <section aria-label={L.ai_title} className="flex flex-col gap-3 rounded-xl border border-foreground p-4" data-sklad-ai-result>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-lg font-bold">{L.ai_title}</h3>
            <button type="button" onClick={() => setAi(null)} className="min-h-11 font-semibold underline underline-offset-4">
              {L.ai_close}
            </button>
          </div>
          <div className="flex flex-col text-sm">
            {(ai.invoice.supplier || ai.invoice.invoice_no) && (
              <span>
                {[ai.invoice.supplier, ai.invoice.invoice_no, ai.invoice.date].filter(Boolean).join(" · ")}
              </span>
            )}
            {ai.invoice.total_net !== null && (
              <span>
                {L.ai_total} <strong>{money(ai.invoice.total_net)}</strong>
              </span>
            )}
            {ai.addsUp !== null && <span className="font-semibold">{ai.addsUp ? L.ai_adds_up : L.ai_not_adds_up}</span>}
          </div>
          <p role="status" className="text-sm">
            {fill(L.ai_count, { n: ai.rows.length })}
          </p>
          <ul className="flex flex-col gap-2">
            {ai.rows.map((x) => {
              const c = chip(x);
              return (
                <li key={x.key} className={`flex flex-col gap-2 rounded-xl border border-line p-3 ${x.on ? "" : "opacity-60"}`}>
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={x.on}
                      disabled={!x.goods}
                      onChange={(e) => aiChange(x.key, { on: e.target.checked })}
                      aria-label={fill(L.ai_pick, { name: x.text })}
                      className="mt-1 size-5 flex-none accent-foreground"
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="text-[13px] text-muted">
                        {L.rc_from_invoice} {x.text}
                      </span>
                      <strong className="text-[15px]">
                        {x.pick === "new" ? x.name : (all.get(x.pick)?.name ?? x.match.candidates.find((cnd) => cnd.id === x.pick)?.name ?? x.match.name ?? x.text)}
                      </strong>
                      <span className={`self-start rounded-full px-2 py-0.5 text-[12px] font-semibold ${c.cls}`}>{c.text}</span>
                    </div>
                    <strong className="whitespace-nowrap">{money(Math.round(x.qty * x.unit * 100) / 100)}</strong>
                  </div>
                  <span className="text-[13px] text-muted">{x.goods ? fill(L.ai_qty_line, { qty: formatQty(x.qty, "ks", p.lang), price: money(x.unit) }) : L.ai_skip_line}</span>
                  {x.goods && x.match.kind === "unsure" && (
                    <label className="flex flex-col gap-1 text-sm">
                      {L.ai_unsure}
                      <select value={x.pick} onChange={(e) => aiChange(x.key, { pick: e.target.value })} className={field}>
                        {x.match.candidates.map((cnd) => (
                          <option key={cnd.id} value={cnd.id}>
                            {cnd.name}
                            {cnd.code ? ` (${cnd.code})` : ""}
                          </option>
                        ))}
                        <option value="new">{L.ai_as_new}</option>
                      </select>
                    </label>
                  )}
                  {x.goods && x.pick === "new" && (
                    <div className="flex flex-col gap-2 rounded-xl bg-[#FFF8F0] p-3">
                      <span className="text-[13px]">{L.ai_new_hint}</span>
                      <label className="flex flex-col gap-1 text-sm font-semibold">
                        {L.rc_new_name}
                        <input value={x.name} onChange={(e) => aiChange(x.key, { name: e.target.value })} maxLength={300} className={field} />
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        <label className="flex flex-col gap-1 text-sm font-semibold">
                          {L.rc_new_ean}
                          <input value={x.ean} onChange={(e) => aiChange(x.key, { ean: e.target.value })} inputMode="numeric" maxLength={32} className={field} />
                        </label>
                        <label className="flex flex-col gap-1 text-sm font-semibold">
                          {L.rc_new_price}
                          <input value={x.priceText} onChange={(e) => aiChange(x.key, { priceText: e.target.value })} inputMode="decimal" placeholder={L.rc_new_price_ph} className={field} />
                        </label>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm">{fill(L.ai_selected, { n: ai.rows.filter((x) => x.on && x.goods).length, total: ai.rows.length })}</span>
            <button type="button" onClick={aiAdd} className="inline-flex min-h-12 items-center rounded-xl bg-foreground px-4 font-bold text-white" data-sklad-ai-add>
              {fill(L.ai_add, { n: ai.rows.filter((x) => x.on && x.goods).length })}
            </button>
          </div>
        </section>
      )}

      <section aria-label={L.rc_lines} className="flex flex-col divide-y divide-line rounded-xl border border-line">
        {lines.length === 0 && <p className="p-4 text-sm text-muted">{L.rc_empty}</p>}
        {lines.map((l) => {
          const cost = parsePrice(l.costText);
          const lineNet = cost === null || Number.isNaN(cost) ? 0 : Math.round(cost * l.qty * 100) / 100;
          return (
            <div key={l.key} className="flex flex-col gap-2 p-3" data-sklad-rc-line={l.item_id ?? "new"}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col">
                  {l.item_id ? (
                    <strong className="text-[15px] font-semibold">{l.name}</strong>
                  ) : (
                    <span className="self-start rounded-full bg-[#FFF1E0] px-2 py-0.5 text-[12px] font-semibold text-[#8A3B00]">{L.rc_new_product}</span>
                  )}
                  <span className="text-[13px] text-muted">{[l.code, l.src ? `${L.rc_from_invoice} ${l.src}` : ""].filter(Boolean).join(" · ")}</span>
                </div>
                <strong className="whitespace-nowrap">{money(lineNet)}</strong>
              </div>
              {!l.item_id && (
                <div className="grid gap-2 sm:grid-cols-3">
                  <label className="flex flex-col gap-1 text-sm font-semibold sm:col-span-3">
                    {L.rc_new_name}
                    <input value={l.name} onChange={(e) => change(l.key, { name: e.target.value })} maxLength={300} disabled={readOnly} required className={field} />
                  </label>
                  <label className="flex flex-col gap-1 text-sm font-semibold">
                    {L.rc_new_ean}
                    <input value={l.ean ?? ""} onChange={(e) => change(l.key, { ean: e.target.value || null })} inputMode="numeric" maxLength={32} disabled={readOnly} className={field} />
                  </label>
                  <label className="flex flex-col gap-1 text-sm font-semibold sm:col-span-2">
                    {L.rc_new_price}
                    <input
                      value={l.priceText}
                      onChange={(e) => {
                        const v = parsePrice(e.target.value);
                        change(l.key, { priceText: e.target.value, sale_price: v === null || Number.isNaN(v) ? null : v });
                      }}
                      inputMode="decimal"
                      placeholder={L.rc_new_price_ph}
                      disabled={readOnly}
                      className={field}
                    />
                  </label>
                  <span className="text-[13px] text-muted sm:col-span-3">{L.rc_new_hint}</span>
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-sm font-semibold">
                  {L.rc_cost}
                  <input
                    value={l.costText}
                    onChange={(e) => {
                      const v = parsePrice(e.target.value);
                      change(l.key, { costText: e.target.value, unit_cost: v === null || Number.isNaN(v) ? null : v });
                    }}
                    inputMode="decimal"
                    aria-label={L.rc_cost_label}
                    aria-invalid={l.costText.trim() !== "" && Number.isNaN(cost)}
                    disabled={readOnly}
                    className={`${field} w-28 text-right`}
                  />
                </label>
                {readOnly ? (
                  <strong>{formatQty(l.qty, "ks", p.lang)}</strong>
                ) : (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => (l.qty <= 1 ? setLines((ls) => ls.filter((x) => x.key !== l.key)) : change(l.key, { qty: l.qty - 1 }))}
                      aria-label={l.qty <= 1 ? L.sale_remove : L.sale_less}
                      className="flex size-11 items-center justify-center rounded-xl border border-[#D6D6D6] text-xl"
                    >
                      {l.qty <= 1 ? "×" : "−"}
                    </button>
                    <input
                      value={String(l.qty)}
                      onChange={(e) => {
                        const v = Number(e.target.value.replace(",", "."));
                        if (Number.isFinite(v) && v > 0 && v <= 99_999) change(l.key, { qty: Math.round(v * 1000) / 1000 });
                      }}
                      inputMode="decimal"
                      aria-label={L.sale_qty}
                      className="h-11 w-16 rounded-xl border border-[#D6D6D6] text-center text-[17px] font-bold"
                    />
                    <button type="button" onClick={() => change(l.key, { qty: l.qty + 1 })} aria-label={L.sale_more} className="flex size-11 items-center justify-center rounded-xl border border-[#D6D6D6] text-xl">
                      +
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </section>

      <section aria-label={L.rc_gross} className="flex flex-col gap-2 rounded-xl border border-line p-4">
        <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-[15px]">
          <span>{fill(L.rc_sum, { items: items(totals.products), pieces: formatQty(totals.pieces, "ks", p.lang) })}</span>
          <span />
          <span>
            {L.rc_net}
          </span>
          <strong className="text-right">{money(totals.net)}</strong>
          <span>{L.rc_vat}</span>
          <span className="text-right">{money(totals.vat)}</span>
          <span>{L.rc_gross}</span>
          <strong className="text-right">{money(totals.gross)}</strong>
        </div>
        {totals.newWithoutPrice > 0 && <span className="text-[13px]">{fill(L.rc_missing_price, { n: totals.newWithoutPrice })}</span>}
        {message && (
          <p role={message.kind === "err" ? "alert" : "status"} className="rounded-xl border border-foreground p-3 text-sm font-medium" data-sklad-rc-msg={message.kind}>
            {message.text}
          </p>
        )}
        {!readOnly && (
          <div className="grid gap-2 sm:grid-cols-2">
            <button type="button" onClick={() => void run("save")} disabled={!!busy} className="inline-flex min-h-12 items-center justify-center rounded-xl border border-[#D6D6D6] px-4 font-bold disabled:opacity-50" data-sklad-rc-save>
              {busy === "save" ? L.rc_saving : L.rc_save}
            </button>
            <button
              type="button"
              onClick={() => void run("confirm")}
              disabled={!!busy || lines.length === 0}
              className="inline-flex min-h-12 items-center justify-center rounded-xl bg-foreground px-4 font-bold text-white disabled:opacity-40"
              data-sklad-rc-confirm
            >
              {busy === "confirm" ? L.rc_saving : L.rc_confirm}
            </button>
          </div>
        )}
      </section>

      <dialog ref={doneRef} aria-labelledby="rc-done-title" className="m-auto w-[min(100vw-32px,420px)] rounded-2xl border border-line p-6 backdrop:bg-black/50" data-sklad-rc-done>
        {done && (
          <div className="flex flex-col items-center gap-3 text-center">
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#1E9E5A" strokeWidth="2.4" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <path d="m7.5 12.5 3 3 6-6.5" />
            </svg>
            <h2 id="rc-done-title" className="text-xl font-bold">
              {fill(L.rc_done_title, { number: done.number })}
            </h2>
            <p>
              {fill(L.rc_done_text, { location: done.location ?? "" })}{" "}
              <strong>
                +{formatQty(Number(done.pieces), "ks", p.lang)} · {money(Number(done.total))} {L.rc_net}
              </strong>
            </p>
            <p className="text-sm text-muted">{L.rc_done_note}</p>
            <Link href={`${p.links.receiptPath}/new?${p.links.query}`} className="inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-foreground px-4 font-bold text-white">
              {L.rc_new_again}
            </Link>
            <Link href={`${p.links.receiptPath}/${done.id}?${p.links.query}`} className="min-h-11 font-semibold underline underline-offset-4" onClick={() => doneRef.current?.close()}>
              {L.rc_show}
            </Link>
          </div>
        )}
      </dialog>
    </div>
  );
}
