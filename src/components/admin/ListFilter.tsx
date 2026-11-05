"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * A search box that narrows a long list on the page (2026-11-05: Admin → Preklady → Jazyky): every row of the element
 * `target` with `data-filter-text` is hidden unless it contains the typed words (case and accents ignored). Rows are
 * only hidden, never removed, so a form around them still sends every field. Without JavaScript the box is not shown
 * and the whole list stays.
 */
const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const noop = () => () => {};

export function ListFilter({ target, label, placeholder, none }: { target: string; label: string; placeholder: string; none: string }) {
  const [q, setQ] = useState("");
  const [empty, setEmpty] = useState(false);
  // false in the server's HTML, true once the page runs (the box only makes sense with JavaScript)
  const ready = useSyncExternalStore(noop, () => true, () => false);
  const apply = (value: string) => {
    setQ(value);
    const list = document.getElementById(target);
    if (!list) return;
    const words = fold(value).split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const row of list.querySelectorAll<HTMLElement>("[data-filter-text]")) {
      const hit = words.every((w) => fold(row.dataset.filterText ?? "").includes(w));
      row.hidden = !hit;
      if (hit) shown++;
    }
    setEmpty(words.length > 0 && shown === 0);
  };
  // "Zrušiť" of the form around the list (a reset) shows every row again
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const form = box.current?.closest("form");
    if (!form) return;
    const onReset = () => {
      for (const row of document.getElementById(target)?.querySelectorAll<HTMLElement>("[data-filter-text]") ?? []) row.hidden = false;
      setQ("");
      setEmpty(false);
    };
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [ready, target]);
  if (!ready) return null;
  return (
    <div className="flex flex-col gap-1.5 pb-2" data-list-filter={target}>
      <label className="sr-only" htmlFor={`${target}-filter`}>
        {label}
      </label>
      <input
        ref={box}
        id={`${target}-filter`}
        type="search"
        value={q}
        onChange={(e) => apply(e.target.value)}
        onKeyDown={(e) => {
          // Enter would send the form around the list
          if (e.key === "Enter") e.preventDefault();
          if (e.key === "Escape") apply("");
        }}
        placeholder={placeholder}
        autoComplete="off"
        className="min-h-12 w-full rounded-xl border border-[#D6D6D6] px-3.5 text-base outline-none focus:border-[#111]"
      />
      {empty && (
        <p role="status" className="text-sm text-[#5C5C5C]">
          {none}
        </p>
      )}
    </div>
  );
}
