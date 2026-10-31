"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  acceptTranslation,
  deleteTranslations,
  loadPageTexts,
  restoreTranslations,
  saveTranslation,
  suggestTranslation,
} from "@/app/[lang]/(account)/dashboard/translationActions";
import { cellKey, lacking, PAGE_TEXT_GROUPS, replaceable, STATES, type Cell, type CellState, type PageTextRow } from "@/lib/translations";
import type { TranslationsLabels } from "./TranslationsTable";

export interface PageTextsLabels extends TranslationsLabels {
  groups: Record<string, string>;
  show_langs: string;
  hide_langs: string;
  langs_count: string;
  lacking: string;
  unavailable: string;
}

interface Lang {
  code: string;
  native: string;
}

const UNDO_MS = 30_000;
const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

/**
 * Môj obchod → Jazyky a inventár → "Texty stránky" (database update 62): every text of the page that is not a
 * product — the assistant's label and welcome text, notes of special days, the slider's title, section titles and
 * alt texts, blog posts — one row per original with its languages underneath (opened and closed). The same states
 * and actions as the products' "Preklady" tab (Zobraziť / Upraviť / Preložiť znova / Zmazať with "Späť" for 30 s);
 * filters Jazyk, Čo, Stav and words of the original. The database decides (owner_page_texts(), owner_*_translation[s]).
 */
export function PageTextsTable({ shopId, langs, labels }: { shopId: string; langs: Lang[]; labels: PageTextsLabels }) {
  const [filters, setFilters] = useState({ lang: "", kind: "", state: "", q: "", page: 1 });
  const [rows, setRows] = useState<PageTextRow[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [full, setFull] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ key: string; text: string } | null>(null);
  const [suggestion, setSuggestion] = useState<{ key: string; text: string | null } | null>(null);
  /** one text, or the ticked originals (their cells are taken when the choice is made) */
  const [deleting, setDeleting] = useState<{ cell: Cell } | { rows: PageTextRow[] } | null>(null);
  const [never, setNever] = useState(false);
  const [undo, setUndo] = useState<{ rows: unknown[]; n: number } | null>(null);
  const [loading, startLoading] = useTransition();
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const langName = useMemo(() => new Map(langs.map((l) => [l.code, l.native])), [langs]);
  const groupKey = (r: { kind: string; ref: string }) => `${r.kind}:${r.ref}`;

  // Only the newest request's answer is shown.
  const latest = useRef(0);
  const reload = useCallback(() => {
    const request = ++latest.current;
    startLoading(async () => {
      const result = await loadPageTexts(shopId, filters);
      if (request !== latest.current) return;
      if (!result.ok) {
        setError(result.error === "unavailable" ? labels.unavailable : result.error);
        return;
      }
      setError(null);
      setRows(result.value.rows);
      setTotal(result.value.total);
    });
  }, [shopId, filters, labels.unavailable]);

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
  const pages = Math.max(1, Math.ceil(total / 30));
  const chosen = rows.filter((r) => selected.has(groupKey(r)));

  const doDelete = async (cells: Cell[], asNever: boolean) => {
    const result = await deleteTranslations(shopId, cells, asNever);
    setDeleting(null);
    if (!result.ok) return setError(result.error);
    setSelected(new Set());
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo({ rows: result.value, n: cells.length });
    undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
    reload();
  };

  const doUndo = async () => {
    if (!undo) return;
    const result = await restoreTranslations(shopId, undo.rows);
    setUndo(null);
    if (!result.ok) return setError(result.error);
    reload();
  };

  /** The texts of the ticked originals that can be deleted (with "Neprekladať" also the missing ones). */
  const cellsOf = (list: PageTextRow[], asNever: boolean): Cell[] =>
    list.flatMap((r) => r.cells.filter((c) => (asNever ? c.state !== "none" : c.state !== "missing")).map((c) => ({ kind: r.kind, ref: r.ref, lang: c.lang })));

  const suggest = async (cell: Cell) => {
    setSuggestion({ key: cellKey(cell), text: null });
    const result = await suggestTranslation(shopId, cell);
    if (!result.ok) {
      setSuggestion(null);
      return setError(result.error);
    }
    setSuggestion({ key: cellKey(cell), text: result.value });
  };

  const chip = (state: CellState) => (
    <span className="whitespace-nowrap rounded-full border border-line px-2 py-0.5 text-xs font-semibold" data-translation-state={state}>
      {labels.states[state]}
    </span>
  );

  return (
    <div className="flex flex-col gap-3" data-page-texts>
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
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">{labels.filter_kind}</span>
          <select value={filters.kind} onChange={(e) => set({ kind: e.target.value })} className="rounded border border-line px-2 py-2" data-filter="kind">
            <option value="">{labels.all}</option>
            {PAGE_TEXT_GROUPS.map((g) => (
              <option key={g} value={g}>
                {labels.groups[g]}
              </option>
            ))}
          </select>
        </label>
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
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">{labels.search}</span>
          <input
            type="search"
            defaultValue={filters.q}
            onKeyDown={(e) => e.key === "Enter" && set({ q: e.currentTarget.value })}
            onBlur={(e) => e.currentTarget.value !== filters.q && set({ q: e.currentTarget.value })}
            className="rounded border border-line px-2 py-2"
            data-filter="q"
          />
        </label>
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

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            checked={rows.length > 0 && chosen.length === rows.length}
            onChange={(e) => setSelected(e.target.checked ? new Set(rows.map(groupKey)) : new Set())}
            data-select-all
          />
          {labels.select_all}
        </label>
        {chosen.length > 0 && (
          <>
            <span className="text-muted">{labels.selected.replace("{n}", String(chosen.length))}</span>
            <button type="button" className="underline underline-offset-4" onClick={() => setDeleting({ rows: chosen })} data-bulk="delete">
              {labels.bulk_delete}
            </button>
            <button type="button" className="underline underline-offset-4" onClick={() => doDelete(cellsOf(chosen, true), true)} data-bulk="never">
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
            const gk = groupKey(row);
            const open = expanded.has(gk);
            const missing = lacking(row);
            return (
              <li key={gk} className="flex flex-col gap-2 py-3" data-page-text={gk}>
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.has(gk)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(gk);
                      else next.delete(gk);
                      setSelected(next);
                    }}
                    aria-label={row.source}
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-xs text-muted">{labels.kinds[row.kind] ?? row.kind}</span>
                    <p className={`break-words font-medium ${full === gk ? "" : "line-clamp-2"}`} data-page-text-source>
                      {row.source}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                      <span className="text-muted">
                        {fill(labels.langs_count, { n: row.cells.length })}
                        {missing > 0 && ` · ${fill(labels.lacking, { n: missing })}`}
                      </span>
                      <button
                        type="button"
                        className="min-h-11 underline underline-offset-4"
                        aria-expanded={open}
                        onClick={() => {
                          const next = new Set(expanded);
                          if (open) next.delete(gk);
                          else next.add(gk);
                          setExpanded(next);
                        }}
                        data-page-text-toggle
                      >
                        {open ? labels.hide_langs : fill(labels.show_langs, { n: row.cells.length })}
                      </button>
                      {row.source.length > 120 && (
                        <button type="button" className="min-h-11 underline underline-offset-4" onClick={() => setFull(full === gk ? null : gk)}>
                          {full === gk ? labels.hide : labels.view}
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {open && (
                  <ul className="flex flex-col gap-2 border-l border-line pl-4 sm:ml-7" data-page-text-langs>
                    {row.cells.map((c) => {
                      const cell: Cell = { kind: row.kind, ref: row.ref, lang: c.lang };
                      const key = cellKey(cell);
                      const isEditing = editing?.key === key;
                      const suggested = suggestion?.key === key ? suggestion : null;
                      const own = !replaceable(c.state);
                      return (
                        <li key={key} className="flex flex-col gap-1" data-cell={key}>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs uppercase text-muted" title={langName.get(c.lang) ?? c.lang}>
                              {c.lang}
                            </span>
                            {chip(c.state)}
                          </div>
                          <p className={`break-words ${full === key ? "" : "line-clamp-2"}`} lang={c.lang} data-cell-text>
                            {c.text ?? <span className="text-muted">{c.state === "none" ? labels.states.none : labels.none_text}</span>}
                          </p>
                          {isEditing && (
                            <div className="flex flex-col gap-2">
                              <textarea
                                value={editing.text}
                                onChange={(e) => setEditing({ key, text: e.target.value })}
                                rows={Math.min(8, Math.max(2, Math.ceil(row.source.length / 60)))}
                                lang={c.lang}
                                className="rounded border border-line px-3 py-2"
                                data-edit-text
                              />
                              <div className="flex gap-3 text-sm">
                                <button
                                  type="button"
                                  className="rounded border border-foreground px-3 py-1 font-medium"
                                  onClick={async () => {
                                    const result = await saveTranslation(shopId, cell, editing.text);
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
                            <div className="grid gap-2 sm:grid-cols-2" data-suggestion>
                              <div className="border border-line p-2 text-sm">
                                <p className="text-xs text-muted">{labels.old_text}</p>
                                <p lang={c.lang}>{c.text ?? "—"}</p>
                              </div>
                              <div className="border border-foreground p-2 text-sm">
                                <p className="text-xs text-muted">{labels.new_text}</p>
                                <p lang={c.lang} data-suggestion-text>
                                  {suggested.text ?? labels.loading}
                                </p>
                              </div>
                              {suggested.text && (
                                <div className="flex gap-3 text-sm sm:col-span-2">
                                  <button
                                    type="button"
                                    className="rounded border border-foreground px-3 py-1 font-medium"
                                    onClick={async () => {
                                      const result = await acceptTranslation(shopId, cell, suggested.text!, own);
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
                          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                            <button type="button" className="underline underline-offset-4" onClick={() => setFull(full === key ? null : key)} data-action="view">
                              {full === key ? labels.hide : labels.view}
                            </button>
                            <button type="button" className="underline underline-offset-4" onClick={() => setEditing({ key, text: c.text ?? "" })} data-action="edit">
                              {labels.edit}
                            </button>
                            <button type="button" className="underline underline-offset-4" onClick={() => suggest(cell)} data-action="retranslate">
                              {own ? labels.suggest_new : labels.retranslate}
                            </button>
                            {c.state !== "missing" && (
                              <button type="button" className="underline underline-offset-4" onClick={() => setDeleting({ cell })} data-action="delete">
                                {labels.delete}
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
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

      <dialog ref={dialog} onClose={() => setDeleting(null)} className="ppi-sheet m-0 mt-auto w-full max-w-none rounded-t-lg border border-line bg-white p-0 backdrop:bg-black/30 sm:m-auto sm:max-w-md sm:rounded-lg" data-delete-dialog>
        <form
          method="dialog"
          className="flex flex-col gap-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (deleting) doDelete("cell" in deleting ? [deleting.cell] : cellsOf(deleting.rows, never), never);
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
