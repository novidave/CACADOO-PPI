"use client";

import { useRef, useState } from "react";
import type { LanguagePickerLabels } from "./LanguagePickerDialog";

export type { LanguagePickerLabels } from "./LanguagePickerDialog";

type Dialog = typeof import("./LanguagePickerDialog").LanguagePickerDialog;

/**
 * The language picker's button (update 40), on PPI's pages and in a shop's own header: the current language's code.
 * The list itself (LanguagePickerDialog: "Odporúčané", "Všetky jazyky", "Ďalšie jazyky", the search) is loaded when the
 * button is pointed at or focused, and opens on the tap — so it is not part of any page's first JavaScript.
 */
export function LanguagePicker({
  current,
  currentNative,
  enabled,
  recommended,
  labels,
  site = null,
}: {
  current: string;
  /** The current language's own name ("Slovenčina"), for the button's label. */
  currentNative: string;
  /** The languages the admin switched on. */
  enabled: string[];
  recommended: string[];
  labels: LanguagePickerLabels;
  /** On a shop's own domain: its home language ("/" is that language). */
  site?: { homeLang: string } | null;
}) {
  const [List, setList] = useState<Dialog | null>(null);
  const [openNow, setOpenNow] = useState(false);
  const opener = useRef<(() => void) | null>(null);
  const loading = useRef<Promise<void> | null>(null);

  const load = () => {
    loading.current ??= import("./LanguagePickerDialog").then((m) => setList(() => m.LanguagePickerDialog));
    return loading.current;
  };
  const open = () => {
    if (opener.current) return opener.current();
    setOpenNow(true);
    void load();
  };

  return (
    <>
      <button
        type="button"
        onClick={open}
        onPointerEnter={() => void load()}
        onFocus={() => void load()}
        aria-haspopup="dialog"
        aria-label={`${labels.button}: ${currentNative}`}
        className="flex shrink-0 items-center gap-1 rounded border border-line px-2 py-1 text-sm font-semibold uppercase"
        data-language-picker={current}
      >
        {current.toUpperCase()}
        <span aria-hidden="true" className="text-xs">▾</span>
      </button>
      {List && (
        <List
          current={current}
          enabled={enabled}
          recommended={recommended}
          labels={labels}
          site={site}
          openNow={openNow}
          onReady={(o) => (opener.current = o)}
        />
      )}
    </>
  );
}
