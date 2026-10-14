"use client";

import { useState } from "react";
import { SelectAllBox, useTicks } from "@/components/BulkSelectBar";

interface Labels {
  select_all: string;
  /** Contains {n}: the number of ticked conversations. */
  download_selected: string;
  /** Contains {n}. */
  downloading: string;
  download_done: string;
  /** Contains {n}: conversations without a finished PDF. */
  download_missing: string;
  download_failed: string;
}

type Answer = { files?: { id: string; url: string; name: string }[]; missing?: string[] };

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * "Vybrať všetko" and "Stiahnuť vybrané (n)" above the owner's conversations: every ticked
 * conversation downloads as its own PDF (with the shopper's pictures), one after another, from
 * 10-minute addresses that /api/owner/conversations/pdf asks the archive for with the owner's
 * login. The browser may ask once whether this page may download several files.
 */
export function ConversationDownloadBar({ formId, labels }: { formId: string; labels: Labels }) {
  const ticks = useTicks(formId);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function download() {
    const ids = ticks.values();
    if (ids.length === 0 || busy) return;
    setBusy(true);
    setMessage(labels.downloading.replace("{n}", String(ids.length)));
    try {
      const res = await fetch("/api/owner/conversations/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const answer = (res.ok ? await res.json() : null) as Answer | null;
      if (!answer) throw new Error(String(res.status));
      for (const [i, file] of (answer.files ?? []).entries()) {
        if (i > 0) await pause(700);
        // The address answers "attachment" with the PDF's name: the browser saves it, the page stays.
        const link = document.createElement("a");
        link.href = file.url;
        link.rel = "noopener";
        link.download = file.name;
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
      const missing = answer.missing?.length ?? 0;
      setMessage(missing ? labels.download_missing.replace("{n}", String(missing)) : labels.download_done);
    } catch {
      setMessage(labels.download_failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 text-sm" data-download-bar={formId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SelectAllBox ticks={ticks} label={labels.select_all} />
        <button
          type="button"
          onClick={download}
          disabled={ticks.count === 0 || busy}
          className="rounded border border-foreground px-3 py-1 font-medium disabled:border-line disabled:text-muted"
          data-download-selected
        >
          {labels.download_selected.replace("{n}", String(ticks.count))}
        </button>
      </div>
      {message && (
        <p role="status" className="text-muted" data-download-message>
          {message}
        </p>
      )}
    </div>
  );
}
