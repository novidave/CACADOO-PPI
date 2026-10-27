"use client";

import { usePathname } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { LOCALE_COOKIE } from "@/i18n/config";
import { fold, languageMatches, languageOf, pickerPath, type Language } from "@/i18n/languages";

export interface LanguagePickerLabels {
  button: string;
  title: string;
  recommended: string;
  all: string;
  other: string;
  search: string;
  none: string;
  close: string;
}

/** The visitor's choice, in the functional cookie ppi_lang (a year). */
function remember(code: string) {
  try {
    document.cookie = `${LOCALE_COOKIE}=${code}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  } catch {
    // the link works without it
  }
}

const byOwnName = (a: Language, b: Language) => fold(a.native).localeCompare(fold(b.native));

/**
 * The language picker's list (update 40), loaded by `LanguagePicker` the first time its button is pointed at, focused
 * or tapped (the list and the 42 languages' names are not part of the page's first JavaScript). It opens the list — "Odporúčané" (the shop's preferred languages, or SK HU EN CS UK PL DE on PPI's own
 * pages), "Všetky jazyky" (the European ones, alphabetically, each in its own name) and "Ďalšie jazyky" (Chinese,
 * Vietnamese), with a search that also knows the English, Slovak and Hungarian names ("chinese", "čínština",
 * "kínai"). A dialog: Esc closes, focus stays inside, ↑ ↓ move through the list; on a phone it is a bottom sheet.
 * The choice is remembered in the functional cookie ppi_lang (src/proxy.ts sets it on PPI's pages too).
 */
export function LanguagePickerDialog({
  current,
  enabled,
  recommended,
  labels,
  site = null,
  onReady,
  openNow = false,
}: {
  current: string;
  /** The languages the admin switched on. */
  enabled: string[];
  recommended: string[];
  labels: LanguagePickerLabels;
  /** On a shop's own domain: its home language ("/" is that language). */
  site?: { homeLang: string } | null;
  /** Called with the dialog's "open" once it is on the page (the button opens it at once on the first tap). */
  onReady?: (open: () => void) => void;
  /** Open right away (the first tap that loaded the list). */
  openNow?: boolean;
}) {
  const pathname = usePathname() ?? "/";
  const dialog = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const listId = useId();

  const langs = useMemo(() => enabled.map((c) => languageOf(c)).filter((l): l is Language => Boolean(l)), [enabled]);
  const rec = recommended.map((c) => langs.find((l) => l.code === c)).filter((l): l is Language => Boolean(l));
  const european = langs.filter((l) => l.group !== "other").sort(byOwnName);
  const others = langs.filter((l) => l.group === "other").sort(byOwnName);
  const found = query.trim() ? langs.filter((l) => languageMatches(l, query)).sort(byOwnName) : null;

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    const close = () => setQuery("");
    d.addEventListener("close", close);
    return () => d.removeEventListener("close", close);
  }, []);

  const open = () => {
    if (!dialog.current?.open) dialog.current?.showModal();
    searchRef.current?.focus();
  };
  useEffect(() => {
    onReady?.(open);
    if (openNow) open();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the list is on the page
  }, []);
  // ↑ ↓ through the links (and from the search field into the list)
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const links = [...(dialog.current?.querySelectorAll<HTMLAnchorElement>("a[data-language]") ?? [])];
    if (!links.length) return;
    e.preventDefault();
    const i = links.indexOf(document.activeElement as HTMLAnchorElement);
    const next = e.key === "ArrowDown" ? (i < 0 ? 0 : Math.min(links.length - 1, i + 1)) : i <= 0 ? -1 : i - 1;
    if (next < 0) searchRef.current?.focus();
    else links[next].focus();
  };

  const item = (l: Language, group: string) => (
    <li key={`${group}-${l.code}`}>
      <a
        href={pickerPath(pathname, l.code, current, site)}
        hrefLang={l.code}
        lang={l.code}
        onClick={() => remember(l.code)}
        aria-current={l.code === current ? "true" : undefined}
        className={`flex items-baseline justify-between gap-3 rounded px-3 py-2 hover:bg-line/40 focus:bg-line/40 focus:outline-none ${l.code === current ? "font-semibold" : ""}`}
        data-language={l.code}
      >
        <span className="min-w-0 break-words">{l.native}</span>
        <span className="shrink-0 text-xs uppercase text-muted">{l.code}</span>
      </a>
    </li>
  );
  const group = (title: string, list: Language[], key: string) =>
    list.length > 0 && (
      <section aria-label={title} data-language-group={key}>
        <h3 className="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
        <ul>{list.map((l) => item(l, key))}</ul>
      </section>
    );

  return (
    <>
      <dialog
        ref={dialog}
        aria-labelledby={`${listId}-title`}
        onKeyDown={onKeyDown}
        onClick={(e) => e.target === dialog.current && dialog.current?.close()}
        className="ppi-sheet m-0 mt-auto w-full max-w-none rounded-t-lg border border-line bg-white p-0 text-foreground backdrop:bg-black/30 sm:m-auto sm:max-w-sm sm:rounded-lg"
        data-language-dialog
      >
        <div className="flex max-h-[80vh] flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <h2 id={`${listId}-title`} className="font-semibold">
              {labels.title}
            </h2>
            <button type="button" onClick={() => dialog.current?.close()} className="text-sm underline underline-offset-4" data-language-close>
              {labels.close}
            </button>
          </div>
          <div className="px-4 pt-3">
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={labels.search}
              aria-label={labels.search}
              aria-controls={listId}
              className="w-full rounded border border-line px-3 py-2 outline-none focus:border-foreground"
              data-language-search
            />
          </div>
          <div id={listId} className="overflow-y-auto overscroll-contain px-1 pb-4">
            {found ? (
              found.length ? (
                <ul data-language-results>{found.map((l) => item(l, "found"))}</ul>
              ) : (
                <p className="px-3 py-4 text-sm text-muted" role="status">
                  {labels.none}
                </p>
              )
            ) : (
              <>
                {group(labels.recommended, rec, "recommended")}
                {group(labels.all, european, "all")}
                {group(labels.other, others, "other")}
              </>
            )}
          </div>
        </div>
      </dialog>
    </>
  );
}
