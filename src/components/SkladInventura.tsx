"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Locale } from "@/i18n/config";
import { findProducts, formatQty, productByCode, type SaleProduct } from "@/lib/sklad";
import { countMine, countSet, type CountItem, lookupSaleProducts } from "@/app/[lang]/(account)/dashboard/sklad/actions";

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));
const NAME_KEY = "ppi.sklad.counter";

// the phone's name, kept on this phone (try/catch: blocked storage keeps it for the visit)
const nameSubs = new Set<() => void>();
let nameMemory = "";
const readName = () => {
  try {
    return window.localStorage.getItem(NAME_KEY) ?? nameMemory;
  } catch {
    return nameMemory;
  }
};
const writeName = (v: string) => {
  nameMemory = v;
  try {
    window.localStorage.setItem(NAME_KEY, v);
  } catch {}
  nameSubs.forEach((f) => f());
};
const subscribeName = (f: () => void) => {
  nameSubs.add(f);
  return () => {
    nameSubs.delete(f);
  };
};

export type InventuraLabels = Record<string, string>;

/** A product as the counting phone knows it: name, code, EAN — never the expected quantity. */
type Product = Pick<SaleProduct, "id" | "name" | "code" | "ean">;

interface Props {
  lang: Locale;
  shopId: string;
  countId: string;
  title: string;
  subtitle: string;
  blind: boolean;
  inScope: number;
  counted: number;
  products: Product[];
  uncounted: { item_id: string; name: string; code: string | null }[];
  diffHref: string;
  labels: InventuraLabels;
}

/**
 * The counting phone of an Inventúra (database update 70; screen "Inventúra (mobil, slepá)"): every scan adds one
 * piece of that product to this phone's count, − / + and "Zadať počet naraz" change it; each change sends the total
 * (owner_sklad_count_set), under this phone's name. When another phone already counted the product: "Sčítať" (both
 * counts stay) or "Platí môj počet" (the others' become 0). A blind count never shows the expected quantity.
 */
export function SkladInventura(p: Props) {
  const L = p.labels;
  const name = useSyncExternalStore(subscribeName, readName, () => "");
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [mine, setMine] = useState<Map<string, number>>(() => new Map());
  const [order, setOrder] = useState<string[]>([]);
  const [cur, setCur] = useState<string | null>(null);
  const [typing, setTyping] = useState<string | null>(null);
  const [shared, setShared] = useState<{ itemId: string; who: string; qty: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [showUncounted, setShowUncounted] = useState(false);
  const busy = useRef(0);

  const known = useMemo(() => {
    const m = new Map<string, Product>();
    for (const x of p.products) m.set(x.id, x);
    for (const x of p.uncounted) if (!m.has(x.item_id)) m.set(x.item_id, { id: x.item_id, name: x.name, code: x.code, ean: null });
    return m;
  }, [p.products, p.uncounted]);
  const list = useMemo(() => [...known.values()].map((x) => ({ ...x, price: null, total: 0, min: 0, unit: "ks" })), [known]);
  const counter = name.trim() || L.ic_phone_default;

  // this phone's earlier counts (after a reload or a new name): read by its name, merged under what changed since
  useEffect(() => {
    let live = true;
    void countMine({ lang: p.lang, shopId: p.shopId, countId: p.countId, counter }).then((rows) => {
      if (!live) return;
      setMine((m) => {
        const next = new Map(rows.map((r) => [r.item_id, r.qty] as [string, number]));
        for (const [k, v] of m) next.set(k, v);
        return next;
      });
      setOrder((o) => [...o, ...rows.map((r) => r.item_id).filter((id) => !o.includes(id))]);
    });
    return () => {
      live = false;
    };
  }, [counter, p.lang, p.shopId, p.countId]);

  const send = useCallback(
    async (itemId: string, qty: number, onlyMine = false) => {
      const before = mine.get(itemId);
      setMine((m) => new Map(m).set(itemId, qty));
      setOrder((o) => [itemId, ...o.filter((x) => x !== itemId)]);
      setCur(itemId);
      setError(null);
      const n = ++busy.current;
      try {
        const res = await countSet({ lang: p.lang, shopId: p.shopId, countId: p.countId, itemId, counter, qty, onlyMine });
        if (!res.ok || !res.item) {
          setError(L[`err_${res.error}`] ?? L.ic_offline);
          return;
        }
        const item: CountItem = res.item;
        if (n === busy.current && before === undefined && !onlyMine) {
          const other = item.counters.filter((c) => c.counter !== counter && Number(c.qty) > 0);
          if (other.length) setShared({ itemId, who: other.map((c) => c.counter).join(", "), qty: other.reduce((s, c) => s + Number(c.qty), 0) });
        }
      } catch {
        setError(L.ic_offline);
      }
    },
    [mine, counter, p.lang, p.shopId, p.countId, L],
  );

  const [extra, setExtra] = useState<Product[]>([]);
  const onCode = useCallback(
    async (code: string) => {
      // the page has the first 500 products; a bigger shop's other products are asked for (names and codes only)
      let hit: Product | null = productByCode(list, code) ?? extra.find((x) => x.ean === code || x.code === code) ?? null;
      if (!hit) {
        const more = await lookupSaleProducts({ lang: p.lang, shopId: p.shopId, q: code }).catch(() => [] as SaleProduct[]);
        const found = productByCode(more, code);
        if (found) {
          hit = { id: found.id, name: found.name, code: found.code, ean: found.ean };
          setExtra((e) => [...e, hit!]);
        }
      }
      if (!hit) {
        setError(fill(L.ic_unknown, { code }));
        return;
      }
      void send(hit.id, (mine.get(hit.id) ?? 0) + 1);
    },
    [list, extra, mine, send, p.lang, p.shopId, L.ic_unknown],
  );

  useEffect(() => {
    const onScan = (e: Event) => {
      e.preventDefault();
      setQ("");
      void onCode(String((e as CustomEvent<string>).detail ?? ""));
    };
    window.addEventListener("sklad:scan", onScan);
    return () => window.removeEventListener("sklad:scan", onScan);
  }, [onCode]);

  const curProduct = cur ? (known.get(cur) ?? extra.find((x) => x.id === cur) ?? null) : null;
  const curQty = cur ? (mine.get(cur) ?? 0) : 0;
  const uncounted = p.uncounted.filter((u) => !mine.has(u.item_id));
  const countedNow = Math.max(p.counted, p.inScope - uncounted.length);
  const results = q.trim() ? findProducts(list, q, 8) : [];
  const pct = p.inScope ? Math.min(100, Math.round((countedNow / p.inScope) * 100)) : 0;
  const btn = "flex size-16 items-center justify-center rounded-2xl border border-[#D6D6D6] text-3xl font-bold";

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4" data-sklad-count>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-sm text-muted">{p.title}</span>
          <strong className="text-lg">{p.subtitle}</strong>
        </div>
        <button
          type="button"
          onClick={() => {
            setNameDraft(name);
            setRenaming(true);
          }}
          aria-label={L.ic_rename}
          className="min-h-11 rounded-xl border border-[#D6D6D6] px-3 text-sm font-semibold"
          data-sklad-counter
        >
          {counter}
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-sm">
          <span>{fill(L.ic_counted_n, { n: countedNow, total: p.inScope })}</span>
          {p.blind && <span className="font-semibold">{L.ic_blind}</span>}
        </div>
        <div aria-hidden="true" className="h-2 rounded bg-[#EDEDED]">
          <div className="h-2 rounded bg-foreground" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <p className="text-sm text-muted">{L.ic_scan_hint}</p>
      <label className="flex min-h-12 items-center gap-2 rounded-xl border border-[#D6D6D6] px-3 focus-within:border-foreground">
        <span className="sr-only">{L.ic_search}</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L.ic_search} className="min-w-0 flex-1 bg-transparent py-2 text-base outline-none" data-scan-ok autoComplete="off" />
      </label>
      {results.length > 0 && (
        <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
          {results.map((x) => (
            <li key={x.id}>
              <button
                type="button"
                onClick={() => {
                  setCur(x.id);
                  setQ("");
                }}
                aria-label={fill(L.ic_pick, { name: x.name })}
                className="flex min-h-12 w-full items-center justify-between gap-3 px-3 text-left"
              >
                <span className="font-semibold">{x.name}</span>
                <span className="text-[13px] text-muted">{x.code}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {shared && (
        <div role="alert" className="flex flex-col gap-2 rounded-xl border border-[#F2B705] bg-[#FFF6D6] p-3" data-sklad-shared>
          <strong>{fill(L.ic_shared, { who: shared.who, qty: formatQty(shared.qty, "ks", p.lang) })}</strong>
          <span className="text-sm">{L.ic_shared_hint}</span>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setShared(null)} className="min-h-11 rounded-xl border border-[#D6D6D6] bg-white font-bold">
              {L.ic_add_up}
            </button>
            <button
              type="button"
              onClick={() => {
                void send(shared.itemId, mine.get(shared.itemId) ?? 0, true);
                setShared(null);
              }}
              className="min-h-11 rounded-xl bg-foreground font-bold text-white"
            >
              {L.ic_mine}
            </button>
          </div>
        </div>
      )}

      {curProduct && (
        <section aria-label={L.ic_current} className="flex flex-col items-center gap-3 rounded-2xl border border-line p-4" data-sklad-current>
          <div className="flex flex-col items-center text-center">
            <strong className="text-lg">{curProduct.name}</strong>
            <span className="text-[13px] text-muted">{curProduct.code}</span>
          </div>
          <div className="flex items-center gap-4">
            <button type="button" onClick={() => void send(curProduct.id, Math.max(0, curQty - 1))} aria-label={L.sale_less} className={btn}>
              −
            </button>
            <div className="flex min-w-24 flex-col items-center">
              <span className="text-[13px] text-muted">{L.ic_counted}</span>
              <strong role="status" className="text-[44px] leading-none tabular-nums">
                {new Intl.NumberFormat(p.lang, { maximumFractionDigits: 3 }).format(curQty)}
              </strong>
            </div>
            <button type="button" onClick={() => void send(curProduct.id, curQty + 1)} aria-label={L.sale_more} className={btn}>
              +
            </button>
          </div>
          {typing === null ? (
            <button type="button" onClick={() => setTyping(String(curQty || ""))} className="min-h-11 font-semibold underline underline-offset-4">
              {L.ic_type}
            </button>
          ) : (
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const v = Number(typing.replace(",", "."));
                if (Number.isFinite(v) && v >= 0) void send(curProduct.id, Math.round(v * 1000) / 1000);
                setTyping(null);
              }}
            >
              <label className="flex flex-col gap-1 text-sm font-semibold">
                {L.ic_total}
                <input value={typing} onChange={(e) => setTyping(e.target.value)} inputMode="decimal" autoFocus className="h-12 w-28 rounded-xl border border-[#D6D6D6] text-center text-lg" />
              </label>
              <button type="submit" className="min-h-12 rounded-xl bg-foreground px-4 font-bold text-white">
                {L.ic_save}
              </button>
            </form>
          )}
        </section>
      )}

      {error && (
        <p role="alert" className="rounded-xl border border-foreground p-3 text-sm font-medium">
          {error}
        </p>
      )}

      {order.filter((id) => id !== cur).length > 0 && (
        <section aria-labelledby="ic-recent" className="flex flex-col gap-1">
          <h2 id="ic-recent" className="text-sm font-bold">
            {L.ic_recent}
          </h2>
          <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
            {order
              .filter((id) => id !== cur)
              .slice(0, 10)
              .map((id) => (
                <li key={id}>
                  <button type="button" onClick={() => setCur(id)} className="flex min-h-11 w-full items-center justify-between gap-3 px-3 text-left">
                    <span>{known.get(id)?.name ?? id}</span>
                    <strong>{formatQty(mine.get(id) ?? 0, "ks", p.lang)}</strong>
                  </button>
                </li>
              ))}
          </ul>
        </section>
      )}

      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => setShowUncounted((v) => !v)} aria-expanded={showUncounted} className="min-h-12 rounded-xl border border-[#D6D6D6] px-3 font-bold">
          {fill(L.ic_uncounted, { n: uncounted.length })}
        </button>
        <Link href={p.diffHref} className="inline-flex min-h-12 items-center justify-center rounded-xl bg-foreground px-3 font-bold text-white" data-sklad-submit>
          {L.ic_submit}
        </Link>
      </div>
      {showUncounted && (
        <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
          {uncounted.map((u) => (
            <li key={u.item_id}>
              <button type="button" onClick={() => setCur(u.item_id)} aria-label={fill(L.ic_pick, { name: u.name })} className="flex min-h-11 w-full items-center justify-between gap-3 px-3 text-left">
                <span>{u.name}</span>
                <span className="text-[13px] text-muted">{u.code}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {renaming && (
        <div role="dialog" aria-labelledby="ic-rename" className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center">
          <form
            className="flex w-full max-w-sm flex-col gap-3 rounded-2xl bg-white p-5"
            onSubmit={(e) => {
              e.preventDefault();
              writeName(nameDraft.trim().slice(0, 60));
              setRenaming(false);
            }}
          >
            <h2 id="ic-rename" className="text-lg font-bold">
              {L.ic_phone}
            </h2>
            <span className="text-sm text-muted">{L.ic_phone_hint}</span>
            <label className="flex flex-col gap-1 text-sm font-semibold">
              {L.ic_phone_name}
              <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} maxLength={60} autoFocus className="min-h-11 rounded-xl border border-[#D6D6D6] px-3 text-base" />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setRenaming(false)} className="min-h-11 rounded-xl border border-[#D6D6D6] font-bold">
                {L.ic_close}
              </button>
              <button type="submit" className="min-h-11 rounded-xl bg-foreground font-bold text-white">
                {L.ic_save}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
