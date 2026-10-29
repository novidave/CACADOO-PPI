/**
 * What the shop page's "Produkty" tab needs only once the page is there (loaded right after it appears or with the
 * first key / tap — the shop page's first JavaScript stays within its budget): the visitor's list (`@/lib/shoppingList`)
 * and the small movements (`@/lib/listMotion`).
 */
export { addOne, listStore, pluralForm } from "@/lib/shoppingList";
export { dip, flyBall, pop, shake, wiggle } from "@/lib/listMotion";

import type { ProductRows } from "@/lib/shopRows";

const DEBOUNCE_MS = 200;
const MIN_CHARS = 2;

/**
 * The live search of "Produkty": 200 ms after the last key it asks /api/shops/<slug>/search (only the newest answer
 * counts, older requests are cancelled), puts the words in the address (replaceState: a reload keeps them) and hands
 * the rows over. Under 2 characters = the whole list (kept from the first answer without words). While searching the
 * list keeps the height it had, so fewer rows never pull the page up under the visitor's finger.
 */
export function searcher(opts: {
  slug: string;
  lang: string;
  path: string;
  /** The first rows, when they were the whole list (no words). */
  unfiltered: ProductRows | null;
  box: () => HTMLElement | null;
  show: (data: ProductRows) => void;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let request: AbortController | null = null;
  let unfiltered = opts.unfiltered;
  const show = (data: ProductRows) => {
    opts.show(data);
    try {
      window.history.replaceState(window.history.state, "", data.q ? `${opts.path}?${new URLSearchParams({ q: data.q })}` : opts.path);
    } catch {
      // the address stays; the list is right
    }
  };
  const run = (text: string) => {
    if (timer) clearTimeout(timer);
    request?.abort();
    const q = text.trim().length >= MIN_CHARS ? text.trim() : "";
    const box = opts.box();
    if (!q && unfiltered) {
      if (box) box.style.minHeight = "";
      show(unfiltered);
      return;
    }
    if (q && box && !box.style.minHeight) box.style.minHeight = `${box.offsetHeight}px`;
    const controller = new AbortController();
    request = controller;
    fetch(`/api/shops/${encodeURIComponent(opts.slug)}/search?${new URLSearchParams({ q, lang: opts.lang })}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
      .then((res) => (res.ok ? (res.json() as Promise<ProductRows>) : null))
      .then((data) => {
        if (!data || controller.signal.aborted || request !== controller) return;
        if (!data.q) unfiltered = data;
        show(data);
      })
      .catch(() => {
        // cancelled or offline: the rows stay as they are
      });
  };
  return {
    /** A key was typed: search 200 ms after the last one. */
    typed(text: string) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => run(text), DEBOUNCE_MS);
    },
    /** Enter, ×, Esc: search (or show the whole list) now. */
    now: run,
  };
}
