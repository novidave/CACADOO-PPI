"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Edit, ExportFileLabels, ExportInfo } from "@/lib/exportFiles";
import { downloadZip, exportInfo, fileEdits } from "@/lib/exportClient";
import type { Cell } from "@/lib/translations";
import {
  deleteTranslations,
  describeChosen,
  filteredItemIds,
  itemCells,
  restoreTranslations,
  translateItems,
} from "@/app/[lang]/(account)/dashboard/translationActions";
import { applyExportEdits } from "@/app/[lang]/(account)/sync/exportActions";

const UNDO_MS = 30_000;
const PART = 1000;
const PREVIEW_ROWS = 50;

export type ItemsBulkLabels = Record<string, string>;

interface Lang {
  code: string;
  native: string;
}

interface FilePreview {
  file: string;
  /** null = the main file */
  lang: string | null;
  edits: Edit[];
  readonly: number;
  unknown: number;
  error: string | null;
}

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

const parts = <T,>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

/**
 * Môj obchod → Tovar (database update 62): the one place for products and their translations. Wraps the list (the
 * server renders the rows with a tick each, `data-item-pick`) with:
 *  - "Vygenerovať popisy (max. 20)": the ticked products, or up to 20 without a description (drafts unless the shop
 *    publishes them automatically; the translate function checks the budget);
 *  - with ticks: "Preložiť chýbajúce", "Preložiť znova", "Zmazať preklady" (then translated again on the next visit,
 *    or "Neprekladať") — in the chosen language or in all of them, a progress bar, "Späť" for 30 s;
 *  - "Stiahnuť preklady": update 45's files (the same code) narrowed to the ticked products or the filtered list;
 *  - "Nahrať opravené preklady": the same reader (matched by Kód, then EAN; only the text columns, never quantity or
 *    price), every change shown before it is saved; saved texts become "Upravené ručne".
 */
export function ItemsBulk({
  shopId,
  slug,
  pageLang,
  q,
  filter,
  itemLang,
  langs,
  labels,
  fileLabels,
  children,
}: {
  shopId: string;
  slug: string;
  pageLang: string;
  q: string;
  filter: string;
  /** the "Jazyk" dropdown (null = every preferred language) */
  itemLang: string | null;
  /** the shop's preferred languages (Y) */
  langs: Lang[];
  labels: ItemsBulkLabels;
  /** the files' texts (update 45's "export_folder") */
  fileLabels: ExportFileLabels & Record<string, string>;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const list = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [onPage, setOnPage] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; all: number } | null>(null);
  const [undo, setUndo] = useState<{ rows: unknown[]; text: string } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [never, setNever] = useState(false);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const [download, setDownload] = useState<{ info: ExportInfo; ids: string[]; chosen: (string | null)[] } | null>(null);
  const downloadDialog = useRef<HTMLDialogElement>(null);
  const [previews, setPreviews] = useState<FilePreview[] | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const langName = (code: string | null) => (code ? (langs.find((l) => l.code === code)?.native ?? code.toUpperCase()) : "");

  // the ticks are in the server's rows; this keeps the list of ticked ones (and how many rows the page has)
  useEffect(() => {
    const root = list.current;
    if (!root) return;
    const read = () => {
      const boxes = [...root.querySelectorAll<HTMLInputElement>("input[data-item-pick]")];
      setOnPage(boxes.length);
      setSelected(boxes.filter((b) => b.checked).map((b) => b.value));
    };
    read();
    root.addEventListener("change", read);
    return () => root.removeEventListener("change", read);
  }, [children]);

  useEffect(() => () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
  }, []);
  useEffect(() => {
    if (deleting) deleteDialog.current?.showModal();
    else deleteDialog.current?.close();
  }, [deleting]);
  useEffect(() => {
    if (download) downloadDialog.current?.showModal();
    else downloadDialog.current?.close();
  }, [download]);

  const pickAll = (on: boolean) => {
    for (const box of list.current?.querySelectorAll<HTMLInputElement>("input[data-item-pick]") ?? []) box.checked = on;
    setSelected(on ? [...(list.current?.querySelectorAll<HTMLInputElement>("input[data-item-pick]") ?? [])].map((b) => b.value) : []);
  };

  const startUndo = (rows: unknown[], text: string) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo({ rows, text });
    undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
  };

  const run = async (name: string, task: () => Promise<void>) => {
    setBusy(name);
    setMessage(null);
    try {
      await task();
    } catch (e) {
      setMessage(fill(labels.failed, { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  /** The languages to work in: the chosen one, else every preferred one. */
  const workLangs = () => (itemLang ? [itemLang] : langs.map((l) => l.code));

  /** Translates the ticked products' missing texts language by language, a part per call, with the progress bar. */
  const translateMissing = async (all: number, inLangs: string[]) => {
    let done = 0;
    setProgress({ done, all });
    for (const l of inLangs) {
      for (let round = 0; round < 50; round++) {
        const step = await translateItems(shopId, l, selected);
        if (!step.ok) throw new Error(step.error);
        done = Math.min(all, done + step.value.saved);
        setProgress({ done, all });
        if (step.value.left === 0 || step.value.saved === 0) break;
      }
    }
    return done;
  };

  const cellsOf = async () => {
    const result = await itemCells(shopId, selected, itemLang);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };

  /** Deletes cells in parts of 1 000 (update 40's function); returns the rows as they were, for "Späť". */
  const remove = async (cells: Cell[], asNever: boolean) => {
    const before: unknown[] = [];
    for (const part of parts(cells, PART)) {
      const result = await deleteTranslations(shopId, part, asNever);
      if (!result.ok) throw new Error(result.error);
      before.push(...result.value);
    }
    return before;
  };

  const describe = () =>
    run("describe", async () => {
      const result = await describeChosen(shopId, slug, selected.slice(0, 20));
      if (!result.ok) {
        setMessage(result.error === "none" ? labels.describe_none : fill(labels.failed, { error: result.error }));
        return;
      }
      const { made, asked, fewFacts } = result.value;
      setMessage([fill(labels.described, { n: made, asked }), fewFacts ? fill(labels.described_few, { n: fewFacts }) : null].filter(Boolean).join(" · "));
      router.refresh();
    });

  const translate = () =>
    run("translate", async () => {
      const inLangs = workLangs();
      const cells = (await cellsOf()).filter((c) => (c.state === "missing" || c.state === "stale") && inLangs.includes(c.lang));
      if (!cells.length) {
        setMessage(labels.nothing_missing);
        return;
      }
      const done = await translateMissing(cells.length, [...new Set(cells.map((c) => c.lang))]);
      setMessage(fill(labels.translated, { n: done }));
      router.refresh();
    });

  const retranslate = () =>
    run("retranslate", async () => {
      // the AI's texts go and are made again; a shop's, the owner's own and "Neprekladať" stay
      const cells = (await cellsOf()).filter((c) => c.state === "ai" || c.state === "stale" || c.state === "missing");
      if (!cells.length) {
        setMessage(labels.nothing_retranslate);
        return;
      }
      const before = await remove(cells.filter((c) => c.state !== "missing").map(({ kind, ref, lang }) => ({ kind, ref, lang })), false);
      const done = await translateMissing(cells.length, [...new Set(cells.map((c) => c.lang))]);
      startUndo(before, fill(labels.retranslated, { n: done }));
      setMessage(null);
      router.refresh();
    });

  const confirmDelete = () =>
    run("delete", async () => {
      setDeleting(false);
      const all = await cellsOf();
      // "preložiť znova pri ďalšej návšteve": the texts that exist go; "neprekladať": every one is marked so
      const cells = (never ? all.filter((c) => c.state !== "none") : all.filter((c) => c.state !== "missing")).map(({ kind, ref, lang }) => ({ kind, ref, lang }));
      if (!cells.length) {
        setMessage(labels.nothing_delete);
        return;
      }
      setProgress({ done: 0, all: cells.length });
      const before = await remove(cells, never);
      startUndo(before, fill(labels.deleted, { n: cells.length }));
      router.refresh();
    });

  const doUndo = () =>
    run("undo", async () => {
      if (!undo) return;
      const rows = undo.rows;
      setUndo(null);
      for (const part of parts(rows, PART)) {
        const result = await restoreTranslations(shopId, part);
        if (!result.ok) throw new Error(result.error);
      }
      setMessage(labels.undone);
      router.refresh();
    });

  const openDownload = () =>
    run("download", async () => {
      const info = await exportInfo(shopId);
      if (!info.confirmed || info.items === 0) {
        setMessage(fileLabels.nothing_yet);
        return;
      }
      let ids = selected;
      if (!ids.length) {
        const result = await filteredItemIds(shopId, { q, filter, lang: itemLang });
        if (!result.ok) throw new Error(result.error);
        ids = result.value;
      }
      const preferred = langs.map((l) => l.code).filter((c) => info.langs.includes(c));
      setDownload({ info, ids, chosen: [null, ...(itemLang && info.langs.includes(itemLang) ? [itemLang] : preferred)] });
    });

  const doDownload = () =>
    run("download", async () => {
      if (!download) return;
      if (!download.chosen.length) {
        setMessage(labels.download_pick);
        return;
      }
      const { info, ids, chosen } = download;
      setDownload(null);
      const n = await downloadZip({ shopId, info, langs: chosen, labels: fileLabels, pageLang, name: slug, only: new Set(ids) });
      setMessage(fill(labels.downloaded, { n, items: ids.length }));
    });

  const readFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const field = event.currentTarget;
    const files = [...(field.files ?? [])];
    field.value = "";
    if (!files.length) return;
    void run("upload", async () => {
      const out: FilePreview[] = [];
      for (const file of files) {
        const read = await fileEdits(new Uint8Array(await file.arrayBuffer()), shopId);
        if (!read.ok) {
          out.push({ file: file.name, lang: null, edits: [], readonly: 0, unknown: 0, error: read.error === "other_shop" ? labels.upload_other_shop : read.error === "not_ours" ? labels.upload_not_ours : fill(labels.failed, { error: read.detail }) });
          continue;
        }
        const { edits } = read;
        out.push({ file: file.name, lang: edits.lang, edits: edits.edits, readonly: edits.readonly.length, unknown: edits.unknown.length, error: null });
      }
      setPreviews(out);
    });
  };

  const save = () =>
    run("upload", async () => {
      if (!previews) return;
      const lines: string[] = [];
      for (const p of previews) {
        if (p.error || !p.edits.length) continue;
        const result = await applyExportEdits({
          shopId,
          slug,
          lang: p.lang,
          file: p.file,
          edits: p.edits.map(({ code, ean, field, text }) => ({ code, ean, field, text })),
        });
        if (!result.ok) throw new Error(result.error);
        lines.push(fill(labels.upload_saved, { file: p.file, n: result.value.applied }));
      }
      setPreviews(null);
      setMessage(lines.join(" · ") || labels.upload_none);
      router.refresh();
    });

  const button = "min-h-11 rounded border border-foreground px-3 py-2 text-sm font-medium disabled:border-line disabled:text-muted";
  const link = "min-h-11 text-sm underline underline-offset-4 disabled:text-muted disabled:no-underline";
  const fieldName = (f: Edit["field"]) => labels[`field_${f}`] ?? f;
  const changes = previews?.reduce((n, p) => n + p.edits.length, 0) ?? 0;

  return (
    <div className="flex flex-col gap-3" data-items-bulk aria-busy={busy !== null}>
      <div className="flex flex-wrap items-center gap-2" data-items-tools>
        <button type="button" className={button} onClick={describe} disabled={busy !== null} data-items-describe>
          {busy === "describe" ? labels.describing : labels.describe}
        </button>
        <button type="button" className={button} onClick={openDownload} disabled={busy !== null} data-items-download>
          {labels.download}
        </button>
        <input
          ref={uploadInput}
          type="file"
          multiple
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={readFiles}
          className="sr-only"
          tabIndex={-1}
          data-items-upload-input
        />
        <button type="button" className={button} onClick={() => uploadInput.current?.click()} disabled={busy !== null} data-items-upload>
          {labels.upload}
        </button>
      </div>
      <p className="text-xs text-muted">{selected.length ? fill(labels.describe_selected, { n: Math.min(selected.length, 20) }) : labels.describe_hint}</p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" checked={onPage > 0 && selected.length === onPage} onChange={(e) => pickAll(e.target.checked)} data-items-pick-all />
          {labels.select_page}
        </label>
        {selected.length > 0 && (
          <>
            <span className="text-muted" data-items-selected>
              {fill(labels.selected, { n: selected.length })}
              {itemLang ? ` · ${langName(itemLang)}` : ""}
            </span>
            <button type="button" className={link} onClick={translate} disabled={busy !== null || langs.length + (itemLang ? 1 : 0) === 0} data-bulk="translate">
              {labels.translate_missing}
            </button>
            <button type="button" className={link} onClick={retranslate} disabled={busy !== null} data-bulk="retranslate">
              {labels.retranslate}
            </button>
            <button type="button" className={link} onClick={() => setDeleting(true)} disabled={busy !== null} data-bulk="delete">
              {labels.delete}
            </button>
          </>
        )}
      </div>

      {progress && (
        <div className="flex flex-col gap-1" role="status" data-progress>
          <span className="text-sm">{fill(labels.progress, { done: progress.done, all: progress.all })}</span>
          <div className="h-2 w-full border border-line" aria-hidden>
            <div className="h-full bg-foreground" style={{ width: `${Math.round((progress.done / Math.max(progress.all, 1)) * 100)}%` }} />
          </div>
        </div>
      )}
      {undo && (
        <p role="status" className="flex flex-wrap items-center gap-3 border border-foreground p-3 text-sm" data-undo>
          <span>{undo.text}</span>
          <button type="button" onClick={doUndo} className="font-semibold underline underline-offset-4" data-undo-button>
            {labels.undo}
          </button>
        </p>
      )}
      {message && (
        <p role="status" className="border border-line p-3 text-sm" data-items-message>
          {message}
        </p>
      )}

      {previews && (
        <section className="flex flex-col gap-3 border border-foreground p-3" data-upload-preview aria-labelledby="items-upload-title">
          <h3 id="items-upload-title" className="font-semibold">
            {labels.upload_title}
          </h3>
          {previews.map((p) => (
            <div key={p.file} className="flex flex-col gap-1 text-sm" data-upload-file={p.file}>
              <p className="font-medium">
                {p.file}
                {p.lang ? ` · ${langName(p.lang)}` : ` · ${labels.upload_main}`}
              </p>
              {p.error ? (
                <p>{p.error}</p>
              ) : p.edits.length === 0 ? (
                <p className="text-muted">{labels.upload_no_changes}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-line text-left text-muted">
                        <th className="py-1 pr-2 font-normal">{labels.col_code}</th>
                        <th className="py-1 pr-2 font-normal">{labels.col_what}</th>
                        <th className="py-1 pr-2 font-normal">{labels.col_before}</th>
                        <th className="py-1 font-normal">{labels.col_after}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.edits.slice(0, PREVIEW_ROWS).map((e, i) => (
                        <tr key={i} className="border-b border-line align-top" data-upload-change>
                          <td className="py-1 pr-2 tabular-nums">{e.code}</td>
                          <td className="py-1 pr-2">{fieldName(e.field)}</td>
                          <td className="py-1 pr-2 text-muted">{e.before || "–"}</td>
                          <td className="py-1 font-medium" lang={p.lang ?? undefined}>
                            {e.text}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {p.edits.length > PREVIEW_ROWS && <p className="text-muted">{fill(labels.upload_more, { n: p.edits.length - PREVIEW_ROWS })}</p>}
                </div>
              )}
              {p.readonly > 0 && <p className="text-muted">{fill(labels.upload_readonly, { n: p.readonly })}</p>}
              {p.unknown > 0 && <p className="text-muted">{fill(labels.upload_unknown, { n: p.unknown })}</p>}
            </div>
          ))}
          <div className="flex flex-wrap gap-3">
            <button type="button" className={button} onClick={save} disabled={busy !== null || changes === 0} data-upload-save>
              {fill(labels.upload_save, { n: changes })}
            </button>
            <button type="button" className={link} onClick={() => setPreviews(null)} disabled={busy !== null}>
              {labels.cancel}
            </button>
          </div>
        </section>
      )}

      <div ref={list}>{children}</div>

      <dialog ref={deleteDialog} onClose={() => setDeleting(false)} className="ppi-sheet m-0 mt-auto w-full max-w-none rounded-t-lg border border-line bg-white p-0 backdrop:bg-black/30 sm:m-auto sm:max-w-md sm:rounded-lg" data-items-delete-dialog>
        <form
          method="dialog"
          className="flex flex-col gap-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            confirmDelete();
          }}
        >
          <h2 className="font-semibold">{fill(labels.delete_title, { n: selected.length })}</h2>
          <p className="text-sm text-muted">{itemLang ? fill(labels.delete_in_lang, { lang: langName(itemLang) }) : labels.delete_all_langs}</p>
          <label className="flex items-start gap-2">
            <input type="radio" name="after" checked={!never} onChange={() => setNever(false)} data-after="again" />
            <span>{labels.delete_again}</span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" name="after" checked={never} onChange={() => setNever(true)} data-after="never" />
            <span>{labels.delete_never}</span>
          </label>
          <div className="flex gap-3">
            <button type="submit" className="rounded border border-foreground px-4 py-2 font-medium" data-items-delete-confirm>
              {labels.delete_confirm}
            </button>
            <button type="button" className="underline underline-offset-4" onClick={() => setDeleting(false)}>
              {labels.cancel}
            </button>
          </div>
        </form>
      </dialog>

      <dialog ref={downloadDialog} onClose={() => setDownload(null)} className="ppi-sheet m-0 mt-auto w-full max-w-none rounded-t-lg border border-line bg-white p-0 backdrop:bg-black/30 sm:m-auto sm:max-w-md sm:rounded-lg" data-items-download-dialog>
        {download && (
          <form
            method="dialog"
            className="flex flex-col gap-3 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              doDownload();
            }}
          >
            <h2 className="font-semibold">{labels.download_title}</h2>
            <p className="text-sm" data-download-scope>
              {fill(selected.length ? labels.download_selected : labels.download_filtered, { n: download.ids.length })}
            </p>
            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm text-muted">{labels.download_langs}</legend>
              {[null, ...download.info.langs].map((l) => {
                const on = download.chosen.includes(l);
                return (
                  <label key={l ?? "main"} className="flex min-h-11 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => setDownload({ ...download, chosen: on ? download.chosen.filter((c) => c !== l) : [...download.chosen, l] })}
                      data-download-lang={l ?? "main"}
                    />
                    {l ? langName(l) : fill(labels.download_main, { lang: langName(download.info.main_lang) })}
                  </label>
                );
              })}
            </fieldset>
            <div className="flex flex-wrap gap-3 text-sm">
              <button type="button" className="underline underline-offset-4" onClick={() => setDownload({ ...download, chosen: [null, ...langs.map((x) => x.code).filter((c) => download.info.langs.includes(c))] })}>
                {labels.download_preferred}
              </button>
              <button type="button" className="underline underline-offset-4" onClick={() => setDownload({ ...download, chosen: [null, ...download.info.langs] })} data-download-all>
                {labels.download_all}
              </button>
            </div>
            <p className="text-xs text-muted">{labels.download_hint}</p>
            <div className="flex gap-3">
              <button type="submit" className="rounded border border-foreground px-4 py-2 font-medium" disabled={download.ids.length === 0} data-download-go>
                {labels.download_go}
              </button>
              <button type="button" className="underline underline-offset-4" onClick={() => setDownload(null)}>
                {labels.cancel}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}
