"use client";

import { useEffect, useRef, useState } from "react";
import { MENU_ORDER_EVENT, type MenuOrderEvent } from "@/lib/menuOrder";

const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k) => String(values[k] ?? ""));

/**
 * The Menu's small client part (update 80): "Hľadať v menu" filters the dishes already in the page (the server drew
 * every one) with the ids shop_menu_search() returns — 200 ms after typing, only the newest answer, the address keeps
 * ?mq= (replaceState); without JavaScript the plain GET form (?mq=#menu) does the same on the server. And "Objednať":
 * with the assistant on the page, the link's click becomes the MENU_ORDER_EVENT (the assistant sends that dish with
 * its question) and the assistant scrolls into view; without it the link itself starts the question.
 */
export function MenuTools({
  slug,
  path,
  q,
  count,
  labels,
}: {
  slug: string;
  path: string;
  q: string;
  /** Dishes found by the server's search (a ?mq= address), null without one. */
  count: number | null;
  labels: { label: string; placeholder: string; go: string; clear: string; found: string; none: string };
}) {
  const [value, setValue] = useState(q);
  const [result, setResult] = useState<{ q: string; n: number } | null>(count === null ? null : { q, n: count });
  const timer = useRef(0);
  const latest = useRef(0);
  const root = useRef<HTMLFormElement>(null);

  // "Objednať" → the assistant (when it is on this page)
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.("[data-menu-order]");
      const assistant = document.getElementById("assistant");
      if (!link || !assistant) return;
      e.preventDefault();
      const detail: MenuOrderEvent = { id: link.getAttribute("data-menu-order") ?? "", text: link.getAttribute("data-order-text") ?? "" };
      window.dispatchEvent(new CustomEvent(MENU_ORDER_EVENT, { detail }));
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      assistant.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  const show = (ids: string[] | null) => {
    const menu = root.current?.closest("[data-shop-menu]");
    if (!menu) return 0;
    const keep = ids ? new Set(ids) : null;
    let n = 0;
    menu.querySelectorAll<HTMLElement>("[data-menu-dish]").forEach((el) => {
      const on = !keep || keep.has(el.dataset.menuDish ?? "");
      el.hidden = !on;
      if (on) n++;
    });
    menu.querySelectorAll<HTMLElement>("[data-menu-section]").forEach((section) => {
      const empty = !section.querySelector("[data-menu-dish]:not([hidden])");
      section.hidden = empty;
      const chip = menu.querySelector<HTMLElement>(`[data-menu-chip="${section.dataset.menuSection}"]`);
      if (chip) chip.hidden = empty;
    });
    return n;
  };

  const run = (text: string) => {
    window.clearTimeout(timer.current);
    const query = text.trim();
    const url = new URL(window.location.href);
    if (query.length >= 2) url.searchParams.set("mq", query);
    else url.searchParams.delete("mq");
    window.history.replaceState(window.history.state, "", url);
    if (query.length < 2) {
      show(null);
      setResult(null);
      return;
    }
    const ticket = ++latest.current;
    timer.current = window.setTimeout(async () => {
      const answer = await fetch(`/api/shops/${encodeURIComponent(slug)}/menu-search?${new URLSearchParams({ q: query })}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (ticket !== latest.current || !answer || !Array.isArray(answer.ids)) return;
      setResult({ q: query, n: show(answer.ids as string[]) });
    }, 200);
  };

  const clear = () => {
    setValue("");
    run("");
  };

  return (
    <form
      ref={root}
      method="get"
      action={`${path}#menu`}
      role="search"
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(value);
        (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.blur();
      }}
    >
      <label className="ppi-search">
        <span className="sr-only">{labels.label}</span>
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          type="search"
          name="mq"
          value={value}
          placeholder={labels.placeholder}
          autoComplete="off"
          enterKeyHint="search"
          onChange={(e) => {
            setValue(e.target.value);
            run(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && value) {
              e.preventDefault();
              clear();
            }
          }}
          data-menu-search
        />
        {value && (
          <button type="button" className="ppi-menu-clear" onClick={clear} aria-label={labels.clear}>
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        )}
        <noscript>
          <button type="submit" className="ppi-menu-go">
            {labels.go}
          </button>
        </noscript>
      </label>
      <p className="text-sm font-medium" aria-live="polite" data-menu-results={result ? result.n : undefined}>
        {result ? (result.n ? fill(labels.found, { n: result.n }) : fill(labels.none, { q: result.q })) : ""}
      </p>
    </form>
  );
}
