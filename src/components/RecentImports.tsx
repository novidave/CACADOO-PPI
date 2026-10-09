"use client";

import { useRef, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries";

/** One stock file report (public.stock_imports), with its times already written in the shop's time zone. */
export interface ImportView {
  id: number;
  fileName: string;
  received: string;
  fileTime: string | null;
  status: "ok" | "errors" | "waiting";
  total: number;
  imported: number;
  zeroed: number;
  skipped: number;
  error: string | null;
  /** The approved columns only: never a private column. */
  columns: string[];
  /** The first rows of those columns, exactly as in the file. */
  preview: Record<string, unknown>[];
}

type Labels = Dictionary["imports"];

const fill = (text: string, n: number | string) => text.replace("{n}", String(n));

/**
 * "Recently uploaded files": a card per received stock file (swipe on a phone, arrows on a
 * computer). A tap on a card shows its full report below the cards.
 */
export function RecentImports({ imports, labels }: { imports: ImportView[]; labels: Labels }) {
  const track = useRef<HTMLDivElement>(null);
  const report = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const chosen = imports.find((i) => i.id === selected) ?? null;
  const status = (s: ImportView["status"]) => labels[`status_${s}`];

  if (imports.length === 0) return <p className="text-sm text-muted">{labels.none}</p>;

  function move(direction: 1 | -1) {
    const el = track.current;
    if (!el) return;
    const card = el.querySelector<HTMLElement>("[data-import]");
    el.scrollBy({ left: direction * ((card?.offsetWidth ?? 280) + 12), behavior: "smooth" });
  }

  function open(id: number) {
    setSelected(id);
    requestAnimationFrame(() => report.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="hidden justify-end gap-2 sm:flex">
        <button type="button" onClick={() => move(-1)} aria-label={labels.previous} className="rounded border border-line px-3 py-1">
          ←
        </button>
        <button type="button" onClick={() => move(1)} aria-label={labels.next} className="rounded border border-line px-3 py-1">
          →
        </button>
      </div>
      <div ref={track} className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2" aria-label={labels.title}>
        {imports.map((imp) => (
          <article
            key={imp.id}
            data-import={imp.id}
            onClick={() => open(imp.id)}
            className={`flex w-[85%] shrink-0 cursor-pointer snap-start flex-col gap-2 border p-3 text-sm sm:w-72 ${
              selected === imp.id ? "border-foreground" : "border-line"
            }`}
          >
            <span className="truncate font-semibold" title={imp.fileName}>
              {imp.fileName || "–"}
            </span>
            <span className="text-muted">{imp.received}</span>
            <span>
              {labels.status}: <span className="font-semibold">{status(imp.status)}</span>
            </span>
            <span>{fill(labels.imported, imp.imported)}</span>
            <span>{fill(labels.skipped, imp.skipped)}</span>
            <Preview rows={imp.preview} columns={imp.columns} compact empty={labels.no_preview} />
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                open(imp.id);
              }}
              aria-expanded={selected === imp.id}
              className="self-start underline underline-offset-4"
            >
              {labels.open_report}
            </button>
          </article>
        ))}
      </div>

      {chosen && (
        <div ref={report} className="flex flex-col gap-3 border border-foreground p-3 text-sm" role="region" aria-label={labels.report_title}>
          <div className="flex items-start justify-between gap-3">
            <h3 className="font-semibold">{labels.report_title}</h3>
            <button type="button" onClick={() => setSelected(null)} className="underline underline-offset-4">
              {labels.close}
            </button>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted">{labels.file}</dt>
            <dd className="break-all">{chosen.fileName || "–"}</dd>
            <dt className="text-muted">{labels.received}</dt>
            <dd>{chosen.received}</dd>
            <dt className="text-muted">{labels.file_time}</dt>
            <dd>{chosen.fileTime ?? "–"}</dd>
            <dt className="text-muted">{labels.status}</dt>
            <dd className="font-semibold">{status(chosen.status)}</dd>
            <dt className="text-muted">{labels.total_rows}</dt>
            <dd className="tabular-nums">{chosen.total}</dd>
            <dt className="text-muted">{labels.imported_label}</dt>
            <dd className="tabular-nums">{chosen.imported}</dd>
            <dt className="text-muted">{labels.zeroed}</dt>
            <dd className="tabular-nums">{chosen.zeroed}</dd>
            <dt className="text-muted">{labels.skipped_label}</dt>
            <dd className="tabular-nums">{chosen.skipped}</dd>
            {chosen.error && (
              <>
                <dt className="text-muted">{labels.error}</dt>
                <dd>{chosen.error}</dd>
              </>
            )}
          </dl>
          <span className="text-muted">{labels.preview}</span>
          <Preview rows={chosen.preview} columns={chosen.columns} empty={labels.no_preview} />
        </div>
      )}
    </div>
  );
}

/** The first rows of the approved columns, as in the file; small and cut short on a card. */
function Preview({
  rows,
  columns,
  compact = false,
  empty,
}: {
  rows: Record<string, unknown>[];
  columns: string[];
  compact?: boolean;
  empty: string;
}) {
  if (rows.length === 0 || columns.length === 0) return <span className="text-xs text-muted">{empty}</span>;
  return (
    <div className={compact ? "overflow-hidden" : "overflow-x-auto"}>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-line text-left">
            {columns.map((c) => (
              <th key={c} className="whitespace-nowrap py-1 pr-2 font-semibold">
                <Cell text={c} compact={compact} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-line">
              {columns.map((c) => (
                <td key={c} className="whitespace-nowrap py-1 pr-2">
                  <Cell text={String(row[c] ?? "")} compact={compact} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cell({ text, compact }: { text: string; compact: boolean }) {
  return compact ? <span className="block max-w-20 truncate">{text}</span> : <>{text}</>;
}
