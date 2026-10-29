"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type RefObject, useEffect, useRef, useState } from "react";
import { StockDot } from "@/components/StockDot";
import { highlightParts } from "@/lib/searchWords";
import type { StockState } from "@/lib/stockDot";

/** One suggestion as /api/shops/<slug>/search writes it (names, price and availability already in the page language). */
interface Suggestion {
  id: string;
  name: string;
  original: string | null;
  price: string | null;
  stock: StockState;
  availability: string;
  category: string | null;
  matched: string[];
}

interface Answer {
  q: string;
  kind: "exact" | "match" | "similar" | null;
  total: number;
  items: Suggestion[];
}

const MIN_CHARS = 2;
const DEBOUNCE_MS = 200;

function Marked({ text, matched }: { text: string; matched: string[] }) {
  return (
    <>
      {highlightParts(text, matched).map((part, i) =>
        part.hit ? (
          <mark key={i} className="bg-transparent font-bold text-foreground">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

/**
 * The "Tovar v obchode" dropdown (database update 54), loaded only when the visitor starts typing (`ItemSearch`
 * imports it on demand, so the shop page's first JavaScript stays within the budget). From 2 characters, 200 ms after
 * the last key, up to 8 suggestions of the forgiving search (shop_item_search() through /api/shops/<slug>/search); only
 * the newest answer is shown, older requests are cancelled. ↑ ↓ choose, Enter opens the chosen product (Enter on the
 * field or on "Zobraziť všetky výsledky" lets the form filter the whole list), Esc closes. It works on the form's own
 * field (listeners on `input` / `form`), so typing never waits for this part to load.
 */
export default function ItemSuggestions({
  value,
  input,
  form,
  slug,
  lang,
  itemBase,
  listId,
  labels,
}: {
  value: string;
  input: RefObject<HTMLInputElement | null>;
  form: RefObject<HTMLFormElement | null>;
  slug: string;
  lang: string;
  itemBase: string;
  listId: string;
  labels: { suggestions: string; all: string; similar: string; count: string };
}) {
  const router = useRouter();
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [open, setOpen] = useState(false);
  // -1 = the field itself; 0..n-1 = a suggestion; n = "Zobraziť všetky výsledky"
  const [active, setActive] = useState(-1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const request = useRef<AbortController | null>(null);
  const optionId = (i: number) => `${listId}-o${i}`;
  const close = () => {
    setOpen(false);
    setActive(-1);
  };

  // the newest request only: every new one cancels the one before
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    request.current?.abort();
    const query = value.trim();
    // too short: nothing is asked, and the list stays hidden (it is shown only from 2 characters)
    if (query.length < MIN_CHARS) return;
    timer.current = setTimeout(() => {
      const controller = new AbortController();
      request.current = controller;
      fetch(`/api/shops/${encodeURIComponent(slug)}/search?${new URLSearchParams({ q: query, lang })}`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      })
        .then((res) => (res.ok ? (res.json() as Promise<Answer>) : null))
        .then((data) => {
          if (controller.signal.aborted || request.current !== controller || !data) return;
          setAnswer(data);
          setActive(-1);
          // only while the visitor is still in the field (after Enter the list was filtered and the field left)
          setOpen(document.activeElement === input.current);
        })
        .catch(() => {
          // cancelled or offline: the form still works
        });
    }, DEBOUNCE_MS);
  }, [value, slug, lang, input]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      request.current?.abort();
    },
    [],
  );

  const items = open && answer ? answer.items : [];
  const shown = open && answer !== null && answer.items.length > 0 && value.trim().length >= MIN_CHARS;
  const allIndex = items.length;

  // the field's ARIA state follows the list
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.setAttribute("aria-expanded", String(shown));
    if (shown && active >= 0) el.setAttribute("aria-activedescendant", optionId(active));
    else el.removeAttribute("aria-activedescendant");
  });

  // keys, focus and the form's own submit (the whole list is filtered: the dropdown closes)
  useEffect(() => {
    const el = input.current;
    const f = form.current;
    if (!el || !f) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (shown) {
          e.preventDefault();
          close();
        }
        return;
      }
      if (!shown) {
        if (e.key === "ArrowDown" && answer && answer.items.length && el.value.trim().length >= MIN_CHARS) {
          e.preventDefault();
          setOpen(true);
        }
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (i >= allIndex ? -1 : i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i <= -1 ? allIndex : i - 1));
      } else if (e.key === "Enter" && active >= 0 && active < items.length) {
        e.preventDefault();
        close();
        router.push(`${itemBase}${items[active].id}`);
      }
    };
    const onFocus = () => {
      if (answer && el.value.trim().length >= MIN_CHARS) setOpen(true);
    };
    const onOut = (e: FocusEvent) => {
      if (!f.contains(e.relatedTarget as Node | null)) close();
    };
    const onSubmit = () => {
      if (timer.current) clearTimeout(timer.current);
      request.current?.abort();
      close();
    };
    el.addEventListener("keydown", onKey);
    el.addEventListener("focus", onFocus);
    f.addEventListener("focusout", onOut);
    f.addEventListener("submit", onSubmit);
    return () => {
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("focus", onFocus);
      f.removeEventListener("focusout", onOut);
      f.removeEventListener("submit", onSubmit);
    };
  });

  return (
    <>
      <p className="sr-only" aria-live="polite">
        {shown && answer ? labels.count.replace("{n}", String(answer.items.length)) : ""}
      </p>
      <div
        hidden={!shown}
        className="absolute inset-x-0 top-full z-30 mt-1 max-h-[70vh] overflow-y-auto rounded border border-line bg-background"
        data-item-suggestions
      >
        {answer?.kind === "similar" && <p className="border-b border-line px-3 py-2 text-sm text-muted">{labels.similar}</p>}
        <ul id={listId} role="listbox" aria-label={labels.suggestions} className="divide-y divide-line">
          {items.map((item, i) => (
            <li
              key={item.id}
              id={optionId(i)}
              role="option"
              aria-selected={active === i}
              className={active === i ? "bg-line/40" : ""}
              onMouseEnter={() => setActive(i)}
            >
              <Link
                href={`${itemBase}${item.id}`}
                tabIndex={-1}
                className="flex min-h-11 flex-col gap-0.5 px-3 py-2"
                onMouseDown={(e) => e.preventDefault()}
                onClick={close}
                data-suggestion
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 font-medium">
                    <Marked text={item.name} matched={item.matched} />
                  </span>
                  {item.price && (
                    <span className="flex shrink-0 items-center gap-2 whitespace-nowrap font-medium">
                      <StockDot state={item.stock} />
                      {item.price}
                    </span>
                  )}
                </span>
                {item.original && (
                  <span className="text-sm text-muted">
                    <Marked text={item.original} matched={item.matched} />
                  </span>
                )}
                <span className="flex items-center gap-2 text-sm">
                  {!item.price && <StockDot state={item.stock} />}
                  <span className="font-semibold">{item.availability}</span>
                  {item.category && <span className="text-muted">· {item.category}</span>}
                </span>
              </Link>
            </li>
          ))}
          {answer && answer.total > 0 && (
            <li
              id={optionId(allIndex)}
              role="option"
              aria-selected={active === allIndex}
              className={active === allIndex ? "bg-line/40" : ""}
              onMouseEnter={() => setActive(allIndex)}
            >
              <button
                type="submit"
                tabIndex={-1}
                className="min-h-11 w-full px-3 py-2 text-left font-medium underline underline-offset-4"
                onMouseDown={(e) => e.preventDefault()}
                data-suggestions-all
              >
                {labels.all.replace("{n}", String(answer.total))}
              </button>
            </li>
          )}
        </ul>
      </div>
    </>
  );
}
