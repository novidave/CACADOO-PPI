"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { StockDot } from "@/components/StockDot";
import type { ListEntry } from "@/lib/shoppingList";
import type { ProductRow, ProductRows } from "@/lib/shopRows";
import { STOCK_WORDS } from "@/lib/stockDot";

// The Zoznam tab (stepper, swipe, copy) loads when it is first opened or something is added: the shop page's first
// JavaScript budget.
const loadList = () => import("@/components/ShopList");
const ShopList = dynamic(loadList, { ssr: false });

// The list's store and the ball, pop, wiggle… load right after the page appears (@/lib/shopProductsEngine).
const engine = () => import("@/lib/shopProductsEngine");
type Engine = Awaited<ReturnType<typeof engine>>;
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const ADD_BLUE = "#2563EB";
const REMOVE_ORANGE = "#F97316";

const qtyOf = (list: readonly ListEntry[], id: string) => list.find((e) => e.id === id)?.qty ?? 0;
/** A counter's text: "9+" above `max` (the same rule as @/lib/shoppingList's badgeText). */
const badgeText = (n: number, max = 9) => (n > max ? `${max}+` : String(n));
/** Slovak 1 produkt · 2–4 produkty · 5+ produktov (@/lib/shoppingList's pluralForm, kept here for the first paint). */
function pluralForm(n: number, lang: string): "one" | "few" | "other" {
  let rule = "other";
  try {
    rule = new Intl.PluralRules(lang).select(n);
  } catch {
    rule = n === 1 ? "one" : "other";
  }
  return rule === "one" ? "one" : rule === "few" ? "few" : "other";
}

const fill = (text: string, vars: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

export interface ShopProductsLabels {
  tabs: string;
  products: string;
  list: string;
  listCount: string;
  placeholder: string;
  clear: string;
  button: string;
  found: { one: string; few: string; other: string };
  none: string;
  similar: string;
  add: string;
  addMore: string;
  status: Record<(typeof STOCK_WORDS)[keyof typeof STOCK_WORDS], string>;
  prev: string;
  next: string;
  pageOf: string;
  said: { added: string; less: string; removed: string; copied: string; copyFailed: string };
  shopList: {
    title: string;
    empty: string;
    total: string;
    minus: string;
    plus: string;
    remove: string;
    qty: string;
    swipe: string;
    copy: string;
    copied: string;
    copyManual: string;
  };
}

/** A name with the search's words marked on the server (every odd piece; @/lib/shopRows `marks`). */
function Marked({ text, marks }: { text: string; marks: string[] | null }) {
  if (!marks) return <>{text}</>;
  return (
    <>
      {marks.map((piece, i) =>
        i % 2 ? (
          <mark key={i} className="ppi-mark">
            {piece}
          </mark>
        ) : (
          piece
        ),
      )}
    </>
  );
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r="1" fill="currentColor" />
      <circle cx="4.5" cy="12" r="1" fill="currentColor" />
      <circle cx="4.5" cy="18" r="1" fill="currentColor" />
    </svg>
  );
}

/**
 * The shop page's products (2026-10-29, at the owner's request): two tabs, "Produkty" and "Zoznam" (real radio inputs,
 * visually hidden). Produkty: the forgiving search (update 54, shop_item_search through /api/shops/<slug>/search)
 * filters the rows while the visitor types (200 ms after the last key, only the newest answer), × or Esc clears; each
 * row is the name, the stock dot (a button: one more piece on the list, its counter on the dot) and the price — no
 * stock sentence (only the product page has it). Zoznam (`@/components/ShopList`): the visitor's list in this browser.
 * The rows come in the first HTML; without JavaScript the search is the plain GET form and only Produkty shows.
 */
export function ShopProducts({
  shopId,
  slug,
  lang,
  path,
  itemBase,
  shopName,
  address,
  initial,
  page,
  pageSize,
  emptyNote,
  labels,
}: {
  shopId: string;
  slug: string;
  lang: string;
  /** The shop page's address (search and page links). */
  path: string;
  /** Where a product's page is: itemBase + id. */
  itemBase: string;
  shopName: string;
  /** Only for the copied list (never shown in this section). */
  address: string | null;
  initial: ProductRows;
  page: number;
  pageSize: number;
  /** What an empty shop shows (no products yet / "Sortiment sa práve aktualizuje."). */
  emptyNote: { text: string; kind: string };
  labels: ShopProductsLabels;
}) {
  // The visitor's list: empty in the first HTML, read from this browser as soon as the store has loaded.
  const [list, setList] = useState<readonly ListEntry[]>([]);
  useEffect(() => {
    let alive = true;
    let off = () => {};
    void engine().then(({ listStore }) => {
      if (!alive) return;
      const store = listStore(shopId);
      setList(store.get());
      off = store.subscribe(() => setList(store.get()));
    });
    return () => {
      alive = false;
      off();
    };
  }, [shopId]);
  const [tab, setTab] = useState<"products" | "list">("products");
  const [tabMoved, setTabMoved] = useState(false);
  const [value, setValue] = useState(initial.q);
  const [results, setResults] = useState<{ data: ProductRows; first: boolean }>({ data: initial, first: true });
  // pieces still flying to the list icon: the counters change when the ball lands
  const [flying, setFlying] = useState<Record<string, number>>({});
  const [said, setSaid] = useState("");
  const listIcon = useRef<HTMLSpanElement>(null);
  const tabBadge = useRef<HTMLSpanElement>(null);
  const rowsBox = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const name = useId();

  const say = useCallback((text: string) => setSaid((before) => (before === text ? `${text} ` : text)), []);
  const statusOf = (row: ProductRow) => labels.status[STOCK_WORDS[row.stock]];

  // ---- search (the logic loads with the store: @/lib/shopProductsEngine `searcher`) ----
  const search = useRef<ReturnType<Engine["searcher"]> | null>(null);
  const searching = () =>
    search.current
      ? Promise.resolve(search.current)
      : engine().then(({ searcher }) => {
          search.current ??= searcher({
            slug,
            lang,
            path,
            unfiltered: initial.q ? null : initial,
            box: () => rowsBox.current,
            show: (data) => setResults({ data, first: false }),
          });
          return search.current;
        });
  const typed = (text: string) => {
    setValue(text);
    void searching().then((s) => s.typed(text));
  };
  const run = (text: string) => void searching().then((s) => s.now(text));
  const clear = () => {
    setValue("");
    run("");
    inputRef.current?.focus();
  };

  // ---- the list ----
  const showLater = (id: string, n: number) =>
    setFlying((f) => {
      const left = (f[id] ?? 0) + n;
      const next = { ...f };
      if (left > 0) next[id] = left;
      else delete next[id];
      return next;
    });
  const inFlight = Object.values(flying).reduce((a, b) => a + b, 0);
  const total = list.reduce((n, e) => n + e.qty, 0) - inFlight;

  const add = (row: ProductRow, button: HTMLButtonElement) => {
    const still = !reducedMotion();
    if (still) showLater(row.id, 1);
    void loadList();
    void engine()
      .then(({ addOne, flyBall, listStore, pop, wiggle }) => {
        const store = listStore(shopId);
        const n = qtyOf(store.get(), row.id) + 1;
        store.set(addOne(store.get(), { id: row.id, name: row.name, original: row.original, price: row.price, currency: row.currency }));
        say(fill(labels.said.added, { name: row.name, n }));
        if (!still) return;
        return flyBall(button, listIcon.current, ADD_BLUE).then(() => {
          wiggle(listIcon.current);
          requestAnimationFrame(() => {
            pop(tabBadge.current);
            pop(button.querySelector("[data-list-badge]"));
          });
        });
      })
      .finally(() => {
        if (still) showLater(row.id, -1);
      });
  };

  // The Zoznam tab tells what it changed: the counter dips (and the ball flies back to a removed row).
  const changed = useCallback(
    (entry: ListEntry, n: number, row: HTMLElement | null) => {
      say(n > 0 ? fill(labels.said.less, { name: entry.name, n }) : fill(labels.said.removed, { name: entry.name }));
      if (reducedMotion()) return Promise.resolve();
      return engine().then(({ dip, flyBall, shake }) => {
        dip(tabBadge.current);
        if (n > 0) return;
        shake(listIcon.current);
        return flyBall(listIcon.current, row, REMOVE_ORANGE, 620);
      });
    },
    [labels.said.less, labels.said.removed, say],
  );

  const pick = (next: "products" | "list") => {
    setTab(next);
    setTabMoved(true);
  };

  const data = results.data;
  const rows = data.rows;
  const pages = Math.max(1, Math.ceil(data.total / pageSize));
  const shownPage = results.first ? page : 1;
  const pageUrl = (n: number) => `${path}?${new URLSearchParams({ ...(data.q ? { q: data.q } : {}), page: String(n) })}#items`;
  const form = pluralForm(data.total, lang);

  return (
    <div className="ppi-list flex flex-col gap-3">
      <noscript>
        <style>{".ppi-tabs{display:none}"}</style>
      </noscript>
      <div className="ppi-tabs" role="radiogroup" aria-label={labels.tabs}>
        <label className="ppi-tab" data-active={tab === "products" || undefined} data-moved={(tabMoved && tab === "products") || undefined}>
          <input type="radio" name={name} value="products" checked={tab === "products"} onChange={() => pick("products")} className="sr-only" />
          <span className="ppi-tab-icon">
            <SearchIcon />
          </span>
          {labels.products}
        </label>
        <label
          className="ppi-tab"
          data-active={tab === "list" || undefined}
          data-moved={(tabMoved && tab === "list") || undefined}
          onPointerEnter={() => void loadList()}
          onFocus={() => void loadList()}
          data-list-tab
        >
          <input type="radio" name={name} value="list" checked={tab === "list"} onChange={() => pick("list")} className="sr-only" />
          <span className="ppi-tab-icon" ref={listIcon} data-counted={total > 0 || undefined}>
            <ListIcon />
            {total > 0 && (
              <span className="ppi-tab-badge" ref={tabBadge} aria-hidden="true" data-tab-count>
                {badgeText(total, 99)}
              </span>
            )}
          </span>
          {labels.list}
          {total > 0 && <span className="sr-only">{` (${fill(labels.listCount, { n: total })})`}</span>}
        </label>
      </div>

      <p className="sr-only" aria-live="polite" data-list-said>
        {said}
      </p>

      <div hidden={tab !== "products"} className="flex flex-col gap-3" data-panel="products">
        <form
          method="get"
          action={`${path}#items`}
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            run(value);
            // the phone's keyboard closes, so the rows are not hidden under it
            inputRef.current?.blur();
          }}
        >
          <div className="ppi-search">
            <SearchIcon />
            <input
              ref={inputRef}
              type="search"
              name="q"
              value={value}
              onChange={(e) => typed(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && value) {
                  e.preventDefault();
                  clear();
                }
              }}
              placeholder={labels.placeholder}
              aria-label={labels.placeholder}
              autoComplete="off"
              enterKeyHint="search"
            />
            {value && (
              <button type="button" className="ppi-search-clear" onClick={clear} aria-label={labels.clear} data-search-clear>
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            )}
            <noscript>
              <button type="submit" className="ppi-search-go">
                {labels.button}
              </button>
            </noscript>
          </div>
        </form>

        {data.q && (
          <p className="text-sm" data-search-results={data.kind ?? "none"}>
            {rows.length === 0 || data.kind === "similar" ? (
              <span className="font-medium">{fill(labels.none, { q: data.q })}</span>
            ) : (
              <span className="font-medium">{fill(labels.found[form], { n: data.total })}</span>
            )}
            {data.kind === "similar" && rows.length > 0 && <span className="block text-muted">{labels.similar}</span>}
            <noscript>
              {" · "}
              <a href={`${path}#items`} className="underline underline-offset-4">
                {labels.clear}
              </a>
            </noscript>
          </p>
        )}

        <div ref={rowsBox}>
          {rows.length === 0 && !data.q ? (
            <p data-stock-note={emptyNote.kind}>{emptyNote.text}</p>
          ) : (
            <ul className="ppi-rows" data-product-rows>
              {rows.map((row) => {
                const inList = qtyOf(list, row.id) - (flying[row.id] ?? 0);
                const status = statusOf(row);
                return (
                  <li key={row.id} className="ppi-row" data-product={row.id}>
                    <div className="min-w-0 flex-1">
                      <Link href={`${itemBase}${row.id}`} className="ppi-row-name">
                        <Marked text={row.name} marks={row.nameMarks} />
                      </Link>
                      {row.original && (
                        <p className="ppi-row-original">
                          <Marked text={row.original} marks={row.originalMarks} />
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      className="ppi-add"
                      aria-label={inList > 0 ? fill(labels.addMore, { name: row.name, status, n: inList }) : fill(labels.add, { name: row.name, status })}
                      onClick={(e) => add(row, e.currentTarget)}
                      data-add-to-list
                    >
                      <StockDot state={row.stock} size={20} />
                      {inList > 0 && (
                        <span className="ppi-badge" aria-hidden="true" data-list-badge>
                          {badgeText(inList)}
                        </span>
                      )}
                    </button>
                    <span className="ppi-row-price">{row.priceText}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {pages > 1 && (
          <nav className="flex items-center justify-between text-sm" aria-label={fill(labels.pageOf, { page: shownPage, pages })}>
            {shownPage > 1 ? (
              <a href={pageUrl(shownPage - 1)} className="underline underline-offset-4">
                {labels.prev}
              </a>
            ) : (
              <span />
            )}
            <span className="text-muted">{fill(labels.pageOf, { page: shownPage, pages })}</span>
            {shownPage < pages ? (
              <a href={pageUrl(shownPage + 1)} className="underline underline-offset-4">
                {labels.next}
              </a>
            ) : (
              <span />
            )}
          </nav>
        )}
      </div>

      {tab === "list" && (
        <div data-panel="list">
          <ShopList shopId={shopId} lang={lang} shopName={shopName} address={address} itemBase={itemBase} labels={labels.shopList} said={labels.said} say={say} changed={changed} />
        </div>
      )}
    </div>
  );
}
