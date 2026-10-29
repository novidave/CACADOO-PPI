"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
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
 * "Tovar v obchode" search on the shop page (database update 54). A plain GET form (works without JavaScript: `#items`
 * brings the list into view after the reload). With JavaScript: from 2 characters, 200 ms after the last key, up to 8
 * suggestions of the forgiving search (shop_item_search() through /api/shops/<slug>/search; only the newest answer is
 * shown, older requests are cancelled); ↑ ↓ choose, Enter opens the chosen product or filters the whole list, Esc
 * closes. Filtering replaces the list in place — the page stays where it is (`scroll: false`, the list never gets
 * shorter than it was), nothing else on the page reloads.
 */
export function ItemSearch({
  path,
  q,
  slug,
  lang,
  itemBase,
  labels,
}: {
  path: string;
  q: string;
  slug: string;
  lang: string;
  /** Where a product's page is: itemBase + id. */
  itemBase: string;
  labels: { placeholder: string; button: string; suggestions: string; all: string; similar: string; count: string };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(q);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [open, setOpen] = useState(false);
  // -1 = the field itself; 0..n-1 = a suggestion; n = "Zobraziť všetky výsledky"
  const [active, setActive] = useState(-1);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const request = useRef<AbortController | null>(null);
  const listId = useId();
  const optionId = (i: number) => `${listId}-o${i}`;

  // the newest request only: every new one cancels the one before
  const ask = (text: string) => {
    if (timer.current) clearTimeout(timer.current);
    request.current?.abort();
    const query = text.trim();
    if (query.length < MIN_CHARS) {
      setAnswer(null);
      setOpen(false);
      return;
    }
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
          setOpen(true);
        })
        .catch(() => {
          // cancelled or offline: the form still works
        });
    }, DEBOUNCE_MS);
  };

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      request.current?.abort();
    },
    [],
  );

  const close = () => {
    setOpen(false);
    setActive(-1);
  };

  // Filters the whole list ("Výsledky pre „…“ (N)"), in place.
  const filter = (text: string) => {
    if (timer.current) clearTimeout(timer.current);
    request.current?.abort();
    close();
    // Fewer results make the page shorter, and a shorter page pulls the view up: the list keeps at least the
    // height it had, so the screen does not move (any space left over is below the results).
    const list = document.getElementById("items");
    if (list) list.style.minHeight = `${list.offsetHeight}px`;
    const query = text.trim();
    // the phone's keyboard closes, so the results are not hidden under it
    inputRef.current?.blur();
    const url = query ? `${path}?${new URLSearchParams({ q: query })}` : path;
    startTransition(() => router.replace(url, { scroll: false }));
  };

  const items = open && answer ? answer.items : [];
  const shown = open && answer !== null && answer.items.length > 0 && value.trim().length >= MIN_CHARS;
  const allIndex = items.length;

  return (
    <form
      ref={formRef}
      method="get"
      action={`${path}#items`}
      className="relative flex gap-2"
      role="search"
      aria-busy={pending}
      onSubmit={(e) => {
        e.preventDefault();
        filter(String(new FormData(e.currentTarget).get("q") ?? ""));
      }}
      onBlur={(e) => {
        if (!formRef.current?.contains(e.relatedTarget as Node | null)) close();
      }}
    >
      <input
        ref={inputRef}
        type="search"
        name="q"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          ask(e.target.value);
        }}
        onFocus={() => {
          if (answer && value.trim().length >= MIN_CHARS) setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            if (shown) {
              e.preventDefault();
              close();
            }
            return;
          }
          if (!shown) {
            if (e.key === "ArrowDown" && answer && value.trim().length >= MIN_CHARS) {
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
          // Enter on the field or on "Zobraziť všetky výsledky": the form filters the whole list
        }}
        placeholder={labels.placeholder}
        aria-label={labels.placeholder}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={shown && active >= 0 ? optionId(active) : undefined}
        autoComplete="off"
        enterKeyHint="search"
        className="min-w-0 flex-1 rounded border border-line px-3 py-2 outline-none focus:border-foreground"
      />
      <button
        type="submit"
        className="rounded border border-foreground px-4 py-2 font-medium aria-disabled:opacity-60"
        aria-disabled={pending}
        data-tap-busy
      >
        {labels.button}
      </button>

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
    </form>
  );
}
