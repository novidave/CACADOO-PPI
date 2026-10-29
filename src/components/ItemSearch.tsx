"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";

// The dropdown loads with the first letter typed (not with the page): the shop page's first JavaScript budget.
const loadSuggestions = () => import("@/components/ItemSuggestions");
const ItemSuggestions = dynamic(loadSuggestions, { ssr: false });

/**
 * "Tovar v obchode" search on the shop page. A plain GET form (works without JavaScript: `#items` brings the list into
 * view after the reload). With JavaScript the dropdown of suggestions (update 54, `@/components/ItemSuggestions`)
 * loads as soon as the visitor types, and filtering replaces the list in place — the page stays where it is
 * (`scroll: false`, the list never gets shorter than it was), nothing else on the page reloads.
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
  const [typed, setTyped] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

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
        // Fewer results make the page shorter, and a shorter page pulls the view up: the list keeps at least the
        // height it had, so the screen does not move (any space left over is below the results).
        const list = document.getElementById("items");
        if (list) list.style.minHeight = `${list.offsetHeight}px`;
        const query = String(new FormData(e.currentTarget).get("q") ?? "").trim();
        // the phone's keyboard closes, so the results are not hidden under it
        inputRef.current?.blur();
        const url = query ? `${path}?${new URLSearchParams({ q: query })}` : path;
        startTransition(() => router.replace(url, { scroll: false }));
      }}
    >
      <input
        ref={inputRef}
        type="search"
        name="q"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setTyped(true);
        }}
        onFocus={() => void loadSuggestions()}
        placeholder={labels.placeholder}
        aria-label={labels.placeholder}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={false}
        aria-controls={listId}
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
      {typed && (
        <ItemSuggestions
          value={value}
          input={inputRef}
          form={formRef}
          slug={slug}
          lang={lang}
          itemBase={itemBase}
          listId={listId}
          labels={labels}
        />
      )}
    </form>
  );
}
