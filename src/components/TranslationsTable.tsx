"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  acceptTranslation,
  deleteTranslations,
  loadTranslations,
  restoreTranslations,
  saveTranslation,
  suggestTranslation,
  translateNow,
} from "@/app/[lang]/(account)/dashboard/translationActions";
import { cellKey, replaceable, STATES, type Cell, type CellRow, type CellState } from "@/lib/translations";

export interface TranslationsLabels {
  filter_lang: string;
  filter_kind: string;
  filter_state: string;
  search: string;
  all: string;
  kind_items: string;
  kind_texts: string;
  kind_blog: string;
  kinds: Record<string, string>;
  states: Record<CellState, string>;
  original: string;
  translation: string;
  empty: string;
  none_text: string;
  view: string;
  hide: string;
  edit: string;
  save: string;
  cancel: string;
  retranslate: string;
  suggest_new: string;
  old_text: string;
  new_text: string;
  use_new: string;
  delete: string;
  delete_title: string;
  delete_again: string;
  delete_never: string;
  delete_confirm: string;
  select_all: string;
  selected: string;
  bulk_delete: string;
  bulk_retranslate: string;
  bulk_never: string;
  progress: string;
  undo: string;
  deleted: string;
  add: string;
  add_lang: string;
  add_kind: string;
  add_text: string;
  failed: string;
  page_of: string;
  prev: string;
  next: string;
  loading: string;
}

interface Lang {
  code: string;
  native: string;
}

const UNDO_MS = 30_000;

/**
 * The owner's translations (update 40): every text of the shop × every language it keeps, with its state as a chip —
 * "Od obchodu", "AI", "Upravené ručne", "Zastaraný", "Chýba", "Neprekladať". Per text: Zobraziť / Upraviť / Preložiť
 * znova (old and new side by side; a shop's or the owner's own text only gets "Navrhnúť nový preklad") / Zmazať (then
 * translated again on the next visit, or "Neprekladať"). Ticks for many at once with a progress bar, "Späť" for 30 s.
 * `item` = a product's tab (only its texts, "+ Pridať preklad").
 */
export function TranslationsTable({
  shopId,
  langs,
  labels,
  item = null,
  addKinds = [],
}: {
  shopId: string;
  langs: Lang[];
  labels: TranslationsLabels;
  item?: string | null;
  addKinds?: string[];
}) {
  const [filters, setFilters] = useState({ lang: "", kind: "", state: "", q: "", page: 1 });
  const [rows, setRows] = useState<CellRow[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ key: string; text: string } | null>(null);
  const [suggestion, setSuggestion] = useState<{ key: string; text: string | null } | null>(null);
  const [deleting, setDeleting] = useState<Cell[] | null>(null);
  const [never, setNever] = useState(false);
  const [undo, setUndo] = useState<{ rows: unknown[]; n: number } | null>(null);
  const [progress, setProgress] = useState<{ done: number; all: number } | null>(null);
  const [loading, startLoading] = useTransition();
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const langName = useMemo(() => new Map(langs.map((l) => [l.code, l.native])), [langs]);

  // Only the newest request's answer is shown: a slower answer for filters already changed is dropped.
  const latest = useRef(0);
  const reload = useCallback(() => {
    const request = ++latest.current;
    startLoading(async () => {
      const result = await loadTranslations(shopId, { ...filters, ref: item ?? undefined });
      if (request !== latest.current) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setRows(result.value.rows);
      setTotal(result.value.total);
    });
  }, [shopId, filters, item]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
  }, []);

  useEffect(() => {
    if (deleting) dialog.current?.showModal();
    else dialog.current?.close();
  }, [deleting]);

  const set = (patch: Partial<typeof filters>) => setFilters((f) => ({ ...f, page: 1, ...patch }));
  const pages = Math.max(1, Math.ceil(total / 50));
  const chosen = rows.filter((r) => selected.has(cellKey(r)));

  const startUndo = (before: unknown[], n: number) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo({ rows: before, n });
    undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
  };

  const doDelete = async (cells: Cell[], asNever: boolean) => {
    const result = await deleteTranslations(shopId, cells, asNever);
    setDeleting(null);
    if (!result.ok) return setError(result.error);
    setSelected(new Set());
    startUndo(result.value, cells.length);
    reload();
  };

  const doUndo = async () => {
    if (!undo) return;
    const result = await restoreTranslations(shopId, undo.rows);
    setUndo(null);
    if (!result.ok) return setError(result.error);
    reload();
  };

  /** Many at once: Claude's texts go, then each language is translated now, a part per call, with a progress bar. */
  const bulkRetranslate = async () => {
    const cells = chosen.filter((r) => replaceable(r.state));
    if (!cells.length) return;
    const result = await deleteTranslations(shopId, cells.filter((c) => c.state !== "missing"), false);
    if (!result.ok) return setError(result.error);
    startUndo(result.value, cells.length);
    setSelected(new Set());
    const byLang = [...new Set(cells.map((c) => c.lang))];
    let done = 0;
    setProgress({ done, all: cells.length });
    for (const lang of byLang) {
      for (let round = 0; round < 50; round++) {
        const step = await translateNow(shopId, lang);
        if (!step.ok) {
          setError(step.error);
          break;
        }
        done = Math.min(cells.length, done + step.value.saved);
        setProgress({ done, all: cells.length });
        if (step.value.left === 0 || step.value.saved === 0) break;
      }
    }
    setProgress(null);
    reload();
  };

  const suggest = async (row: CellRow) => {
    setSuggestion({ key: cellKey(row), text: null });
    const result = await suggestTranslation(shopId, row);
    if (!result.ok) {
      setSuggestion(null);
      return setError(result.error);
    }
    setSuggestion({ key: cellKey(row), text: result.value });
  };

  const chip = (state: CellState) => (
    <span className="whitespace-nowrap rounded-full border border-line px-2 py-0.5 text-xs font-semibold" data-translation-state={state}>
      {labels.states[state]}
    </span>
  );

  return (
    <div className="flex flex-col gap-3" data-translations>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">{labels.filter_lang}</span>
          <select value={filters.lang} onChange={(e) => set({ lang: e.target.value })} className="rounded border border-line px-2 py-2" data-filter="lang">
            <option value="">{labels.all}</option>
            {langs.map((l) => (
              <option key={l.code} value={l.code}>
                {l.native}
              </option>
            ))}
          </select>
        </label>
        {!item && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">{labels.filter_kind}</span>
            <select value={filters.kind} onChange={(e) => set({ kind: e.target.value })} className="rounded border border-line px-2 py-2" data-filter="kind">
              <option value="">{labels.all}</option>
              <option value="items">{labels.kind_items}</option>
              <option value="texts">{labels.kind_texts}</option>
              <option value="blog">{labels.kind_blog}</option>
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">{labels.filter_state}</span>
          <select value={filters.state} onChange={(e) => set({ state: e.target.value })} className="rounded border border-line px-2 py-2" data-filter="state">
            <option value="">{labels.all}</option>
            {STATES.map((s) => (
              <option key={s} value={s}>
                {labels.states[s]}
              </option>
            ))}
          </select>
        </label>
        {!item && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">{labels.search}</span>
            <input type="search" defaultValue={filters.q} onKeyDown={(e) => e.key === "Enter" && set({ q: e.currentTarget.value })} onBlur={(e) => e.currentTarget.value !== filters.q && set({ q: e.currentTarget.value })} className="rounded border border-line px-2 py-2" data-filter="q" />
          </label>
        )}
      </div>

      {error && (
        <p role="alert" className="border border-line p-3 text-sm">
          {labels.failed} ({error})
        </p>
      )}
      {undo && (
        <p role="status" className="flex flex-wrap items-center gap-3 border border-foreground p-3 text-sm" data-undo>
          <span>{labels.deleted.replace("{n}", String(undo.n))}</span>
          <button type="button" onClick={doUndo} className="font-semibold underline underline-offset-4" data-undo-button>
            {labels.undo}
          </button>
        </p>
      )}
      {progress && (
        <div className="flex flex-col gap-1" role="status" data-progress>
          <span className="text-sm">{labels.progress.replace("{done}", String(progress.done)).replace("{all}", String(progress.all))}</span>
          <div className="h-2 w-full border border-line" aria-hidden>
            <div className="h-full bg-foreground" style={{ width: `${Math.round((progress.done / Math.max(progress.all, 1)) * 100)}%` }} />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={rows.length > 0 && chosen.length === rows.length}
            onChange={(e) => setSelected(e.target.checked ? new Set(rows.map(cellKey)) : new Set())}
            data-select-all
          />
          {labels.select_all}
        </label>
        {chosen.length > 0 && (
          <>
            <span className="text-muted">{labels.selected.replace("{n}", String(chosen.length))}</span>
            <button type="button" className="underline underline-offset-4" onClick={() => setDeleting(chosen.map(({ kind, ref, lang }) => ({ kind, ref, lang })))} data-bulk="delete">
              {labels.bulk_delete}
            </button>
            <button type="button" className="underline underline-offset-4" onClick={bulkRetranslate} disabled={Boolean(progress)} data-bulk="retranslate">
              {labels.bulk_retranslate}
            </button>
            <button type="button" className="underline underline-offset-4" onClick={() => doDelete(chosen, true)} data-bulk="never">
              {labels.bulk_never}
            </button>
          </>
        )}
        {loading && <span className="text-muted">{labels.loading}</span>}
      </div>

      {rows.length === 0 && !loading ? (
        <p className="text-sm text-muted">{labels.empty}</p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {rows.map((row) => {
            const key = cellKey(row);
            const isOpen = open === key;
            const isEditing = editing?.key === key;
            const suggested = suggestion?.key === key ? suggestion : null;
            const own = !replaceable(row.state);
            return (
              <li key={key} className="flex flex-col gap-2 py-3" data-cell={key}>
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.has(key)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(key);
                      else next.delete(key);
                      setSelected(next);
                    }}
                    aria-label={`${row.source} · ${langName.get(row.lang) ?? row.lang}`}
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs uppercase text-muted">{row.lang}</span>
                      {chip(row.state)}
                      {!item && <span className="text-xs text-muted">{labels.kinds[row.kind] ?? row.kind}</span>}
                    </div>
                    <p className={`break-words ${isOpen ? "" : "line-clamp-2"}`}>
                      <span className="text-muted">{labels.original}: </span>
                      {row.source}
                    </p>
                    <p className={`break-words font-medium ${isOpen ? "" : "line-clamp-2"}`} lang={row.lang} data-cell-text>
                      {row.text ?? <span className="font-normal text-muted">{row.state === "none" ? labels.states.none : labels.none_text}</span>}
                    </p>
                  </div>
                </div>

                {isEditing && (
                  <div className="flex flex-col gap-2 pl-7">
                    <textarea value={editing.text} onChange={(e) => setEditing({ key, text: e.target.value })} rows={Math.min(8, Math.max(2, Math.ceil(row.source.length / 60)))} lang={row.lang} className="rounded border border-line px-3 py-2" data-edit-text />
                    <div className="flex gap-3 text-sm">
                      <button
                        type="button"
                        className="rounded border border-foreground px-3 py-1 font-medium"
                        onClick={async () => {
                          const result = await saveTranslation(shopId, row, editing.text);
                          if (!result.ok) return setError(result.error);
                          setEditing(null);
                          reload();
                        }}
                        data-edit-save
                      >
                        {labels.save}
                      </button>
                      <button type="button" className="underline underline-offset-4" onClick={() => setEditing(null)}>
                        {labels.cancel}
                      </button>
                    </div>
                  </div>
                )}

                {suggested && (
                  <div className="grid gap-2 pl-7 sm:grid-cols-2" data-suggestion>
                    <div className="border border-line p-2 text-sm">
                      <p className="text-xs text-muted">{labels.old_text}</p>
                      <p lang={row.lang}>{row.text ?? "—"}</p>
                    </div>
                    <div className="border border-foreground p-2 text-sm">
                      <p className="text-xs text-muted">{labels.new_text}</p>
                      <p lang={row.lang} data-suggestion-text>
                        {suggested.text ?? labels.loading}
                      </p>
                    </div>
                    {suggested.text && (
                      <div className="flex gap-3 text-sm sm:col-span-2">
                        <button
                          type="button"
                          className="rounded border border-foreground px-3 py-1 font-medium"
                          onClick={async () => {
                            const result = await acceptTranslation(shopId, row, suggested.text!, own);
                            if (!result.ok) return setError(result.error);
                            setSuggestion(null);
                            reload();
                          }}
                          data-use-new
                        >
                          {labels.use_new}
                        </button>
                        <button type="button" className="underline underline-offset-4" onClick={() => setSuggestion(null)}>
                          {labels.cancel}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex flex-wrap gap-x-4 gap-y-1 pl-7 text-sm">
                  <button type="button" className="underline underline-offset-4" onClick={() => setOpen(isOpen ? null : key)} data-action="view">
                    {isOpen ? labels.hide : labels.view}
                  </button>
                  <button type="button" className="underline underline-offset-4" onClick={() => setEditing({ key, text: row.text ?? "" })} data-action="edit">
                    {labels.edit}
                  </button>
                  <button type="button" className="underline underline-offset-4" onClick={() => suggest(row)} data-action="retranslate">
                    {own ? labels.suggest_new : labels.retranslate}
                  </button>
                  {row.state !== "missing" && (
                    <button type="button" className="underline underline-offset-4" onClick={() => setDeleting([{ kind: row.kind, ref: row.ref, lang: row.lang }])} data-action="delete">
                      {labels.delete}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {pages > 1 && (
        <nav className="flex items-center justify-between text-sm">
          <button type="button" disabled={filters.page <= 1} onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))} className="underline underline-offset-4 disabled:no-underline disabled:text-muted">
            {labels.prev}
          </button>
          <span className="text-muted">{labels.page_of.replace("{page}", String(filters.page)).replace("{pages}", String(pages))}</span>
          <button type="button" disabled={filters.page >= pages} onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))} className="underline underline-offset-4 disabled:no-underline disabled:text-muted">
            {labels.next}
          </button>
        </nav>
      )}

      {item && addKinds.length > 0 && <AddTranslation shopId={shopId} item={item} langs={langs} kinds={addKinds} labels={labels} onDone={reload} onError={setError} />}

      <dialog ref={dialog} onClose={() => setDeleting(null)} className="ppi-sheet m-0 mt-auto w-full max-w-none rounded-t-lg border border-line bg-white p-0 backdrop:bg-black/30 sm:m-auto sm:max-w-md sm:rounded-lg" data-delete-dialog>
        <form
          method="dialog"
          className="flex flex-col gap-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (deleting) doDelete(deleting, never);
          }}
        >
          <h2 className="font-semibold">{labels.delete_title}</h2>
          <label className="flex items-start gap-2">
            <input type="radio" name="after" checked={!never} onChange={() => setNever(false)} data-after="again" />
            <span>{labels.delete_again}</span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" name="after" checked={never} onChange={() => setNever(true)} data-after="never" />
            <span>{labels.delete_never}</span>
          </label>
          <div className="flex gap-3">
            <button type="submit" className="rounded border border-foreground px-4 py-2 font-medium" data-delete-confirm>
              {labels.delete_confirm}
            </button>
            <button type="button" className="underline underline-offset-4" onClick={() => setDeleting(null)}>
              {labels.cancel}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

/** "+ Pridať preklad": the owner's own text of a product's name, description or category in a language. */
function AddTranslation({
  shopId,
  item,
  langs,
  kinds,
  labels,
  onDone,
  onError,
}: {
  shopId: string;
  item: string;
  langs: Lang[];
  kinds: string[];
  labels: TranslationsLabels;
  onDone: () => void;
  onError: (e: string) => void;
}) {
  const [show, setShow] = useState(false);
  const [lang, setLang] = useState(langs[0]?.code ?? "");
  const [kind, setKind] = useState(kinds[0]);
  const [text, setText] = useState("");
  if (!show) {
    return (
      <button type="button" className="self-start underline underline-offset-4" onClick={() => setShow(true)} data-add-translation>
        {labels.add}
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-2 border border-line p-3" data-add-form>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">{labels.add_lang}</span>
          <select value={lang} onChange={(e) => setLang(e.target.value)} className="rounded border border-line px-2 py-2" data-add-lang>
            {langs.map((l) => (
              <option key={l.code} value={l.code}>
                {l.native}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">{labels.add_kind}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="rounded border border-line px-2 py-2">
            {kinds.map((k) => (
              <option key={k} value={k}>
                {labels.kinds[k] ?? k}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">{labels.add_text}</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} lang={lang} className="rounded border border-line px-3 py-2" data-add-text />
      </label>
      <div className="flex gap-3 text-sm">
        <button
          type="button"
          className="rounded border border-foreground px-3 py-1 font-medium"
          onClick={async () => {
            const result = await saveTranslation(shopId, { kind, ref: item, lang }, text);
            if (!result.ok) return onError(result.error);
            setShow(false);
            setText("");
            onDone();
          }}
          data-add-save
        >
          {labels.save}
        </button>
        <button type="button" className="underline underline-offset-4" onClick={() => setShow(false)}>
          {labels.cancel}
        </button>
      </div>
    </div>
  );
}
