"use client";

import Link from "next/link";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Locale } from "@/i18n/config";
import { formatPrice } from "@/lib/format";
import { reducedMotion } from "@/lib/listMotion";
import { addOne, lineAmount, type ListEntry, listStore, listText, serverList, setQty, totals } from "@/lib/shoppingList";

/** Past this share of the row's width a swipe deletes the row. */
const SWIPE_DELETE = 0.35;
const COPIED_MS = 2200;

const fill = (text: string, vars: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

function TrashIcon({ size = 16 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    </svg>
  );
}

/** Copies through the old way (a selected text field + execCommand) when the clipboard API is missing or refused. */
function legacyCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  Object.assign(area.style, { position: "fixed", top: "0", left: "-9999px", opacity: "0" });
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/**
 * The "Zoznam" tab of the shop page (loaded when it is first needed, `@/components/ShopProducts`): the visitor's list
 * of this shop's products, kept in this browser only (`@/lib/shoppingList`). Each row: the name, quantity × price and
 * − / quantity / + (the minus is a bin at 1); a row swiped left or right past 35 % of its width is removed (it slides
 * out and closes), a shorter swipe springs back; a swipe never starts on a button or link and vertical scrolling stays
 * (touch-action: pan-y). "Spolu" and "Kopírovať zoznam": plain text with the shop's name and address.
 */
export default function ShopList({
  shopId,
  lang,
  shopName,
  address,
  itemBase,
  labels,
  said,
  say,
  changed,
}: {
  shopId: string;
  lang: string;
  shopName: string;
  address: string | null;
  itemBase: string;
  labels: {
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
  said: { added: string; copied: string; copyFailed: string };
  say: (text: string) => void;
  /** Tells the tabs what changed (n = the new quantity, 0 = removed); resolves when its animation is done. */
  changed: (entry: ListEntry, n: number, row: HTMLElement | null) => Promise<void>;
}) {
  const store = listStore(shopId);
  const list = useSyncExternalStore(store.subscribe, store.get, serverList);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualArea = useRef<HTMLTextAreaElement>(null);
  const price = (amount: number, currency: string) => formatPrice(amount, lang as Locale, currency);

  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);
  useEffect(() => {
    if (!manual) return;
    manualArea.current?.focus();
    manualArea.current?.select();
  }, [manual]);

  const plus = (entry: ListEntry) => {
    store.set(addOne(store.get(), entry));
    say(fill(said.added, { name: entry.name, n: entry.qty + 1 }));
  };

  /** Off the list: the row slides out sideways (a swipe: already out) and closes; the store changes at the end. */
  const remove = (entry: ListEntry, row: HTMLElement | null, slid: number) => {
    if (leaving.has(entry.id)) return;
    setLeaving((s) => new Set(s).add(entry.id));
    const done = () => {
      store.set(setQty(store.get(), entry.id, 0));
      setLeaving((s) => {
        const next = new Set(s);
        next.delete(entry.id);
        return next;
      });
    };
    const flight = changed(entry, 0, row);
    if (!row || reducedMotion()) {
      done();
      return;
    }
    const content = row.querySelector<HTMLElement>("[data-swipe-content]");
    const width = row.offsetWidth;
    const out = content?.animate([{ transform: `translateX(${slid}px)` }, { transform: `translateX(${slid < 0 ? -width : width}px)` }], { duration: 180, easing: "ease-in", fill: "forwards" });
    const close = () =>
      row.animate([{ height: `${row.offsetHeight}px`, opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 220, easing: "ease-in-out", fill: "forwards" }).finished;
    void Promise.all([flight, (out ? out.finished : Promise.resolve()).then(close)]).then(done, done);
  };

  const minus = (entry: ListEntry, row: HTMLElement | null) => {
    if (entry.qty <= 1) return remove(entry, row, 0);
    store.set(setQty(store.get(), entry.id, entry.qty - 1));
    void changed(entry, entry.qty - 1, row);
  };

  // ---- swipe ----
  const swiped = useRef(false);
  const drag = useRef<{ id: number; x: number; y: number; dx: number; locked: boolean; row: HTMLElement; content: HTMLElement } | null>(null);
  const onDown = (e: ReactPointerEvent<HTMLLIElement>) => {
    // never from a button (the stepper); from the name it may start, its click is then dropped (onClickCapture)
    if (e.button !== 0 || (e.target as Element).closest("button, input, textarea")) return;
    const content = e.currentTarget.querySelector<HTMLElement>("[data-swipe-content]");
    if (!content) return;
    swiped.current = false;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, locked: false, row: e.currentTarget, content };
  };
  const onMove = (e: ReactPointerEvent<HTMLLIElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.locked) {
      // a vertical move is the page scrolling: no swipe
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        drag.current = null;
        return;
      }
      if (Math.abs(dx) < 8) return;
      d.locked = true;
      swiped.current = true;
      d.row.setPointerCapture(e.pointerId);
      d.row.dataset.swiping = "";
    }
    d.dx = dx;
    d.content.style.transform = `translateX(${dx}px)`;
    d.row.dataset.side = dx < 0 ? "right" : "left";
    if (Math.abs(dx) > d.row.offsetWidth * SWIPE_DELETE) d.row.dataset.armed = "";
    else delete d.row.dataset.armed;
  };
  const onUp = (entry: ListEntry) => (e: ReactPointerEvent<HTMLLIElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.locked) return;
    delete d.row.dataset.swiping;
    const far = e.type === "pointerup" && Math.abs(d.dx) > d.row.offsetWidth * SWIPE_DELETE;
    if (far) return remove(entry, d.row, d.dx);
    delete d.row.dataset.armed;
    const back = () => {
      d.content.style.transform = "";
      delete d.row.dataset.side;
    };
    if (reducedMotion()) return back();
    d.content.animate([{ transform: `translateX(${d.dx}px)` }, { transform: "translateX(0)" }], { duration: 260, easing: "cubic-bezier(.2,1.4,.4,1)" }).finished.then(back, back);
    d.content.style.transform = "translateX(0)";
  };

  // ---- copy ----
  const copy = async () => {
    const text = listText(list, { title: labels.title, shopName, address, total: labels.total, format: price });
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = legacyCopy(text);
    }
    if (ok) {
      setManual(null);
      setCopied(true);
      say(said.copied);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } else {
      setManual(text);
      say(said.copyFailed);
    }
  };

  const sum = totals(list);

  if (list.length === 0) {
    return (
      <p className="ppi-list-empty" data-list-empty>
        {labels.empty}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="ppi-rows" data-list-rows>
        {list.map((entry) => {
          const line = lineAmount(entry);
          return (
            <li
              key={entry.id}
              className="ppi-list-row"
              data-list-row={entry.id}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp(entry)}
              onPointerCancel={onUp(entry)}
              onClickCapture={(e) => {
                if (!swiped.current) return;
                swiped.current = false;
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <div className="ppi-swipe-bg" aria-hidden="true">
                <TrashIcon />
                <TrashIcon />
              </div>
              <div className="ppi-swipe-content" data-swipe-content>
                <div className="min-w-0 flex-1">
                  <Link href={`${itemBase}${entry.id}`} className="ppi-row-name" draggable={false}>
                    {entry.name}
                  </Link>
                  {entry.original && <p className="ppi-row-original">{entry.original}</p>}
                  {line !== null && (
                    <p className="ppi-line-price" data-line-price>
                      {price(line, entry.currency)}
                    </p>
                  )}
                </div>
                <div className="ppi-stepper">
                  <button
                    type="button"
                    className="ppi-step ppi-step-minus"
                    onClick={(e) => minus(entry, e.currentTarget.closest("li"))}
                    aria-label={entry.qty <= 1 ? fill(labels.remove, { name: entry.name }) : fill(labels.minus, { name: entry.name })}
                    data-step={entry.qty <= 1 ? "remove" : "minus"}
                  >
                    {entry.qty <= 1 ? (
                      <TrashIcon />
                    ) : (
                      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
                        <path d="M6 12h12" />
                      </svg>
                    )}
                  </button>
                  <span className="ppi-step-qty" aria-label={fill(labels.qty, { name: entry.name, n: entry.qty })} data-qty>
                    {entry.qty}
                  </span>
                  <button type="button" className="ppi-step ppi-step-plus" onClick={() => plus(entry)} aria-label={fill(labels.plus, { name: entry.name })} data-step="plus">
                    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
                      <path d="M6 12h12M12 6v12" />
                    </svg>
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {sum.length > 0 && (
        <p className="ppi-list-total" data-list-total>
          <span>{labels.total}</span>
          <span>{sum.map((s) => price(s.amount, s.currency)).join(" + ")}</span>
        </p>
      )}
      <p className="text-[13px] text-muted">{labels.swipe}</p>

      <button type="button" className="ppi-copy" data-copied={copied || undefined} onClick={() => void copy()} data-list-copy>
        {copied ? (
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path className="ppi-check" d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        ) : (
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h8" />
          </svg>
        )}
        {copied ? labels.copied : labels.copy}
      </button>
      {manual && (
        <label className="flex flex-col gap-1 text-sm">
          {labels.copyManual}
          <textarea ref={manualArea} readOnly value={manual} rows={Math.min(12, manual.split("\n").length + 1)} className="ppi-copy-manual" onFocus={(e) => e.currentTarget.select()} data-list-manual />
        </label>
      )}
    </div>
  );
}
