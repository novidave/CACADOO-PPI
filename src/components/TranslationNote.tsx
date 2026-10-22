import type { ShopTexts } from "@/lib/contentTranslations";
import { TranslatingRefresh } from "./TranslatingRefresh";

export interface TranslationNoteLabels {
  machine: string;
  show_original: string;
  original_shown: string;
  show_translation: string;
  translating: string;
}

/**
 * Under the shop's details (update 40): "Preložené automaticky · Zobraziť originál" when a shop text on the page is
 * Claude's translation (the link shows the shop's own words, ?original=1, and back), "Prekladáme…" while some of
 * them are still being translated (the original is shown meanwhile; the page looks again once, after 20 s).
 * Nothing in the shop's own language.
 */
export function TranslationNote({
  texts,
  path,
  query = {},
  labels,
}: {
  texts: ShopTexts;
  path: string;
  query?: Record<string, string>;
  labels: TranslationNoteLabels;
}) {
  if (texts.same || (!texts.machine && !texts.missing && !texts.original)) return null;
  const href = (original: boolean) => {
    const params = new URLSearchParams({ ...query, ...(original ? { original: "1" } : {}) }).toString();
    return params ? `${path}?${params}` : path;
  };
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted" data-translation-note={texts.original ? "original" : texts.missing ? "translating" : "machine"}>
      {texts.original ? (
        <>
          <span>{labels.original_shown}</span>
          <a href={href(false)} className="underline underline-offset-4" data-show-translation>
            {labels.show_translation}
          </a>
        </>
      ) : (
        <>
          {texts.missing && (
            <span role="status" data-translating>
              {labels.translating}
            </span>
          )}
          {texts.machine && <span>{labels.machine}</span>}
          {(texts.machine || texts.missing) && (
            <a href={href(true)} className="underline underline-offset-4" data-show-original>
              {labels.show_original}
            </a>
          )}
          {texts.missing && <TranslatingRefresh />}
        </>
      )}
    </p>
  );
}
