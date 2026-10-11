"use client";

import { useEffect, useRef, useState } from "react";
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

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

/**
 * "Recently uploaded files": a card per received stock file (swipe on a phone, arrows on a
 * computer). A tap on a card opens the quick view: that file's full report as a slideshow,
 * newest first — arrows, the ← → keys or a swipe go to the newer or older file, Esc closes.
 */
export function RecentImports({ imports, labels }: { imports: ImportView[]; labels: Labels }) {
  const track = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const [index, setIndex] = useState<number | null>(null);
  const chosen = index === null ? null : (imports[index] ?? null);
  const status = (s: ImportView["status"]) => labels[`status_${s}`];

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (chosen && !el.open) el.showModal();
    if (!chosen && el.open) el.close();
  }, [chosen]);

  if (imports.length === 0) return <p className="text-sm text-muted">{labels.none}</p>;

  function move(direction: 1 | -1) {
    const el = track.current;
    if (!el) return;
    const card = el.querySelector<HTMLElement>("[data-import]");
    el.scrollBy({ left: direction * ((card?.offsetWidth ?? 280) + 12), behavior: "smooth" });
  }

  /** In the quick view: 1 = the older file, -1 = the newer one (the list is newest first). */
  function step(direction: 1 | -1) {
    setIndex((i) => (i === null ? i : Math.min(imports.length - 1, Math.max(0, i + direction))));
  }

  function close() {
    // The card the quick view ended on stays in sight.
    if (index !== null) track.current?.querySelector(`[data-import="${imports[index]?.id}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    setIndex(null);
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
        {imports.map((imp, i) => (
          <article
            key={imp.id}
            data-import={imp.id}
            onClick={() => setIndex(i)}
            className={`flex w-[85%] shrink-0 cursor-pointer snap-start flex-col gap-2 border p-3 text-sm sm:w-72 ${
              index === i ? "border-foreground" : "border-line"
            }`}
          >
            <span className="truncate font-semibold" title={imp.fileName}>
              {imp.fileName || "–"}
            </span>
            <span className="text-muted">{imp.received}</span>
            <span>
              {labels.status}: <span className="font-semibold">{status(imp.status)}</span>
            </span>
            <span>{fill(labels.imported, { n: imp.imported })}</span>
            <span>{fill(labels.skipped, { n: imp.skipped })}</span>
            <Preview rows={imp.preview} columns={imp.columns} compact empty={labels.no_preview} />
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setIndex(i);
              }}
              aria-haspopup="dialog"
              className="self-start underline underline-offset-4"
            >
              {labels.open_report}
            </button>
          </article>
        ))}
      </div>

      <dialog
        ref={dialog}
        aria-labelledby="import-quick-view-title"
        onClose={() => setIndex(null)}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") step(-1);
          if (event.key === "ArrowRight") step(1);
        }}
        onTouchStart={(event) => {
          const t = event.touches[0];
          touch.current = t ? { x: t.clientX, y: t.clientY } : null;
        }}
        onTouchEnd={(event) => {
          const start = touch.current;
          const t = event.changedTouches[0];
          touch.current = null;
          if (!start || !t) return;
          const dx = t.clientX - start.x;
          if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(t.clientY - start.y)) step(dx < 0 ? 1 : -1);
        }}
        className="m-0 h-full max-h-none w-full max-w-none bg-background p-0 text-foreground backdrop:bg-black/40 sm:m-auto sm:h-auto sm:max-h-[90vh] sm:max-w-2xl sm:border sm:border-foreground"
        data-import-quick-view
      >
        {chosen && index !== null && (
          <div className="flex h-full flex-col gap-3 overflow-y-auto p-4 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <h3 id="import-quick-view-title" className="font-semibold">
                  {labels.report_title}
                </h3>
                <span className="text-muted" data-position>
                  {fill(labels.position, { n: index + 1, total: imports.length })}
                </span>
              </div>
              <button type="button" onClick={close} className="underline underline-offset-4">
                {labels.close}
              </button>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted">{labels.file}</dt>
              <dd className="break-all font-semibold">{chosen.fileName || "–"}</dd>
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
            <div className="mt-auto flex justify-between gap-3 border-t border-line pt-3">
              <button
                type="button"
                onClick={() => step(-1)}
                disabled={index === 0}
                className="rounded border border-line px-3 py-2 disabled:opacity-40"
              >
                ← {labels.newer}
              </button>
              <button
                type="button"
                onClick={() => step(1)}
                disabled={index === imports.length - 1}
                className="rounded border border-line px-3 py-2 disabled:opacity-40"
              >
                {labels.older} →
              </button>
            </div>
          </div>
        )}
      </dialog>
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
