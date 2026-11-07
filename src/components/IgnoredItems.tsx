"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ignoreItems,
  loadCandidates,
  loadIgnored,
  undoIgnore,
  unignoreItems,
  type CandidatePage,
  type IgnoredPage,
} from "@/app/[lang]/(account)/sync/ignoredActions";
import { syncNow } from "@/app/[lang]/(account)/sync/connectorActions";
import { functionFailure } from "@/lib/functionError";
import {
  codeLine,
  deleteButton,
  errorKey,
  nameConfirmed,
  pluralKey,
  restoredKey,
  selectAllLabel,
  stockWord,
  toggle,
  TOAST_MS,
  type IgnoreCandidate,
} from "@/lib/ignoredItems";
import { createClient } from "@/lib/supabase/client";
import { buttonClass, fieldClass, ghostClass } from "@/components/owner/ui";

type Labels = Record<string, string>;

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

const small = "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-4 text-[15px] font-bold";
const smallGhost = `${small} border border-[#D6D6D6] bg-white text-[#111] disabled:text-[#9A9A9A]`;
const smallMain = `${small} border border-[#111] bg-[#111] text-white disabled:border-[#EDEDED] disabled:bg-[#EDEDED] disabled:text-[#5C5C5C]`;

/** The round tick of edit mode: 24 px, a 2 px #2563EB ring; ticked = filled #2563EB with a white check. */
function Tick({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      data-ignore-tick={on ? "on" : "off"}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-[#2563EB] ${on ? "bg-[#2563EB]" : "bg-white"}`}
    >
      {on && (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 8.5l3 3 6-7" />
        </svg>
      )}
    </span>
  );
}

/**
 * One row in a list with an edit mode: in edit mode the content slides 44 px to the right (200 ms; not with
 * prefers-reduced-motion), the round tick appears on the left and the whole row ticks (a real checkbox).
 */
function Row({
  editing,
  checked,
  onToggle,
  label,
  children,
  testId,
}: {
  editing: boolean;
  checked: boolean;
  onToggle: () => void;
  label: string;
  children: React.ReactNode;
  testId: string;
}) {
  const body = (
    <>
      <span
        className={`absolute left-2.5 top-1/2 -translate-y-1/2 transition-opacity duration-200 motion-reduce:transition-none ${editing ? "opacity-100" : "pointer-events-none opacity-0"}`}
      >
        <Tick on={checked} />
      </span>
      <span
        className={`flex min-w-0 flex-1 flex-col gap-0.5 transition-[padding] duration-200 motion-reduce:transition-none ${editing ? "pl-11" : "pl-0"}`}
        data-ignore-row-body
      >
        {children}
      </span>
    </>
  );
  return (
    <li className="relative border-b border-[#F1EDE6] last:border-b-0" data-ignore-row={testId}>
      {editing ? (
        <label className="relative flex min-h-[56px] cursor-pointer items-center py-2.5 pr-2">
          <input type="checkbox" className="sr-only" checked={checked} onChange={onToggle} aria-label={label} />
          {body}
        </label>
      ) : (
        <div className="relative flex min-h-[56px] items-center py-2.5 pr-2">{body}</div>
      )}
    </li>
  );
}

/**
 * Môj obchod → Priečinok s exportom → Nebezpečná zóna – sklad → "Ignorované produkty" (database update 88): the shop's
 * products from its file (all, or what the shop page's search finds), "Upraviť" → round ticks → "Vymazať (n)" /
 * "Vymazať všetko (n)" → a dialog (the whole list needs the shop's name typed) → the products leave the page at once
 * and no later file brings them back; the toast's "Späť" (8 s) puts them back. "Ignorované (n)": "Obnoviť (n)" lets
 * the next file / sync bring them back. A shop whose stock is "Sklad v Cacaduu" (or a restaurant) sees a note.
 */
export function IgnoredItems({
  shopId,
  slug,
  lang,
  timeZone,
  labels,
  skladHref,
  menuHref,
}: {
  shopId: string;
  slug: string;
  lang: string;
  timeZone: string;
  labels: Labels;
  skladHref: string;
  menuHref: string;
}) {
  const l = labels;
  const [q, setQ] = useState("");
  const [page, setPage] = useState<CandidatePage | null>(null);
  const [items, setItems] = useState<IgnoreCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ask, setAsk] = useState<{ all: boolean; n: number } | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [toast, setToast] = useState<{ n: number; resetId: number } | null>(null);
  const [ignored, setIgnored] = useState<IgnoredPage | null>(null);
  const [ignEditing, setIgnEditing] = useState(false);
  const [ignSelected, setIgnSelected] = useState<Set<string>>(new Set());
  const [restored, setRestored] = useState<{ n: number; source: string } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const latest = useRef(0);

  const plural = (base: string, n: number) => fill(l[`${base}_${pluralKey(n, lang)}`] ?? l[`${base}_other`], { n });
  const errorText = (e: string) => l[errorKey(e)] ?? l.err_failed;

  const readCandidates = useCallback(
    async (query: string, offset: number) => {
      const ticket = ++latest.current;
      setLoading(true);
      const r = await loadCandidates(shopId, query, offset);
      if (ticket !== latest.current) return; // only the newest answer
      setLoading(false);
      if (!r.ok) {
        setMessage(l[errorKey(r.error)] ?? l.err_failed);
        return;
      }
      setPage(r.value);
      setItems((before) => (offset === 0 ? r.value.items : [...before, ...r.value.items]));
    },
    [shopId, l],
  );
  const readIgnored = useCallback(async () => {
    const r = await loadIgnored(shopId);
    if (r.ok) setIgnored(r.value);
  }, [shopId]);

  // the first view; the search waits 200 ms after the last key
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSelected(new Set());
      void readCandidates(q, 0);
    }, q ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [q, readCandidates]);
  useEffect(() => {
    let live = true;
    void loadIgnored(shopId).then((r) => {
      if (live && r.ok) setIgnored(r.value);
    });
    return () => {
      live = false;
    };
  }, [shopId]);

  // Esc leaves edit mode (a dialog closes itself first)
  useEffect(() => {
    if (!editing && !ignEditing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || dialog.current?.open) return;
      setEditing(false);
      setSelected(new Set());
      setIgnEditing(false);
      setIgnSelected(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, ignEditing]);

  // the toast stays 8 s
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (ask) dialog.current?.showModal();
    else if (dialog.current?.open) dialog.current.close();
  }, [ask]);

  const refusal = page?.refusal ?? null;
  const food = page?.shop_kind === "food";
  if (refusal || food) {
    return (
      <div className="flex flex-col gap-2 rounded-2xl border border-[#E4E4E4] bg-white p-4 text-sm" data-ignore-note={refusal ?? "food"}>
        <p>{refusal ? l.sklad_note : l.food_note}</p>
        <a href={refusal ? skladHref : menuHref} className="font-semibold underline underline-offset-4">
          {refusal ? l.sklad_open : l.food_open}
        </a>
      </div>
    );
  }

  const shownIds = items.map((i) => i.id);
  const del = deleteButton(selected.size, page?.matched ?? 0);
  const delLabel = fill(del.all ? l.delete_all_n : l.delete_n, { n: del.n });

  async function confirmDelete() {
    if (!ask || !page) return;
    if (ask.all && !nameConfirmed(typed, page.shop_name)) {
      setMessage(l.err_name);
      return;
    }
    setBusy(true);
    const r = await ignoreItems({ shopId, slug, ids: ask.all ? null : [...selected], q, expected: ask.n });
    setBusy(false);
    setAsk(null);
    setTyped("");
    if (!r.ok) {
      setMessage(errorText(r.error));
      void readCandidates(q, 0);
      return;
    }
    setMessage(null);
    setSelected(new Set());
    setEditing(false);
    setToast({ n: r.value.count, resetId: r.value.reset_id });
    void readCandidates(q, 0);
    void readIgnored();
  }

  async function undo() {
    if (!toast) return;
    const resetId = toast.resetId;
    setToast(null);
    const r = await undoIgnore({ slug, resetId });
    setMessage(r.ok ? fill(l.undone, { n: r.value.count }) : errorText(r.error));
    void readCandidates(q, 0);
    void readIgnored();
  }

  async function restore() {
    if (!ignored) return;
    const all = ignSelected.size === ignored.total && ignored.items.length === ignored.total;
    setBusy(true);
    const r = await unignoreItems({ shopId, keys: all ? null : [...ignSelected], expected: ignSelected.size });
    setBusy(false);
    if (!r.ok) {
      setMessage(errorText(r.error));
      return;
    }
    setRestored({ n: r.value.count, source: r.value.source });
    setMessage(null);
    setIgnSelected(new Set());
    setIgnEditing(false);
    void readIgnored();
  }

  async function syncAgain() {
    if (!restored) return;
    setBusy(true);
    let ok = false;
    if (restored.source === "agent") {
      ok = (await syncNow(shopId)).ok;
    } else {
      const { error } = await createClient().functions.invoke("inventory-connect", {
        body: { action: "sync_now", shop_id: shopId },
        method: "POST",
      });
      ok = !error;
      if (error) await functionFailure(error);
    }
    setBusy(false);
    setMessage(ok ? l.sync_queued : l.err_failed);
  }

  const dateText = (iso: string) =>
    new Intl.DateTimeFormat(lang, { timeZone, day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(
      new Date(iso),
    );

  return (
    <div className="flex min-w-0 flex-col gap-4" data-ignored-items>
      <p className="text-sm">{l.intro}</p>

      {/* "Produkty zo súboru" */}
      <section className="flex min-w-0 flex-col gap-3" aria-labelledby="ignore-from-file">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 id="ignore-from-file" className="font-semibold">
            {l.from_file}
          </h4>
          {!editing && items.length > 0 && (
            <button type="button" className={smallGhost} onClick={() => setEditing(true)} data-ignore-edit>
              {l.edit}
            </button>
          )}
        </div>
        <div className="relative">
          <input
            type="search"
            className={`${fieldClass} pr-12 text-[16px]`}
            placeholder={l.search}
            aria-label={l.search_label}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && q) {
                e.stopPropagation();
                setQ("");
              }
            }}
            data-ignore-search
          />
        </div>
        {page && q.trim() && (
          <p className="text-sm text-muted" aria-live="polite">
            {page.total === 0 ? fill(l.none_found, { q: q.trim() }) : page.kind === "similar" ? l.similar_note : plural("found", page.total)}
          </p>
        )}

        {editing && (
          <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label={l.edit} data-ignore-toolbar>
            <button
              type="button"
              className={smallGhost}
              onClick={() =>
                setSelected(selectAllLabel(shownIds, selected) === "select_all" ? new Set([...selected, ...shownIds]) : new Set())
              }
              data-ignore-select-all
            >
              {l[selectAllLabel(shownIds, selected)]}
            </button>
            <button
              type="button"
              className={`${smallMain.replace("inline-flex ", "")} hidden sm:inline-flex`}
              disabled={del.disabled || busy}
              onClick={() => setAsk({ all: del.all, n: del.n })}
              data-ignore-delete
            >
              {delLabel}
            </button>
            <button
              type="button"
              className={smallGhost}
              onClick={() => {
                setEditing(false);
                setSelected(new Set());
              }}
              data-ignore-done
            >
              {l.done}
            </button>
          </div>
        )}

        {items.length === 0 && !loading && !q.trim() ? (
          <p className="text-sm">{l.empty}</p>
        ) : (
          <ul className="flex min-w-0 flex-col rounded-2xl border border-[#E4E4E4] bg-white px-2" aria-busy={loading} data-ignore-list>
            {items.map((item) => {
              const word = stockWord(item.quantity, page?.stale ?? false);
              return (
                <Row
                  key={item.id}
                  testId={item.code}
                  editing={editing}
                  checked={selected.has(item.id)}
                  onToggle={() => setSelected((s) => toggle(s, item.id))}
                  label={fill(l.select_row, { name: item.name })}
                >
                  <span className="break-words text-[15px] font-medium">{item.name}</span>
                  <span className="flex flex-wrap gap-x-3 text-[13px] text-[#5B6670]">
                    <span className="break-all">{codeLine(item.code, item.ean, l as { code: string; ean: string })}</span>
                    <span>{fill(l[word.key], { n: word.n })}</span>
                  </span>
                </Row>
              );
            })}
          </ul>
        )}
        {page && items.length < page.total && (
          <button type="button" className={smallGhost} disabled={loading} onClick={() => void readCandidates(q, items.length)}>
            {loading ? l.loading : l.more}
          </button>
        )}

        {/* on a phone the delete button sits in a bar at the bottom of the screen */}
        {editing && (
          <div
            className="sticky bottom-0 z-10 -mx-1 flex items-center justify-between gap-3 border-t border-[#E4E4E4] bg-white px-1 py-2 sm:hidden"
            data-ignore-phone-bar
          >
            <span className="text-sm font-semibold" aria-live="polite">
              {fill(l.selected_n, { n: selected.size })}
            </span>
            <button
              type="button"
              className={smallMain}
              disabled={del.disabled || busy}
              onClick={() => setAsk({ all: del.all, n: del.n })}
              data-ignore-delete-phone
            >
              {delLabel}
            </button>
          </div>
        )}
      </section>

      {/* "Ignorované (n)" */}
      <section className="flex min-w-0 flex-col gap-3" aria-labelledby="ignore-list" data-ignored-list>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 id="ignore-list" className="font-semibold">
            {fill(l.ignored_title, { n: ignored?.total ?? 0 })}
          </h4>
          {!ignEditing && (ignored?.items.length ?? 0) > 0 && (
            <button type="button" className={smallGhost} onClick={() => setIgnEditing(true)} data-ignored-edit>
              {l.edit}
            </button>
          )}
        </div>
        {ignEditing && ignored && (
          <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label={l.edit}>
            <button
              type="button"
              className={smallGhost}
              onClick={() => {
                const keys = ignored.items.map((i) => i.key);
                setIgnSelected(selectAllLabel(keys, ignSelected) === "select_all" ? new Set(keys) : new Set());
              }}
            >
              {l[selectAllLabel(ignored.items.map((i) => i.key), ignSelected)]}
            </button>
            <button
              type="button"
              className={smallMain}
              disabled={ignSelected.size === 0 || busy}
              onClick={() => void restore()}
              data-ignored-restore
            >
              {fill(l.restore_n, { n: ignSelected.size })}
            </button>
            <button
              type="button"
              className={smallGhost}
              onClick={() => {
                setIgnEditing(false);
                setIgnSelected(new Set());
              }}
            >
              {l.done}
            </button>
          </div>
        )}
        {!ignored || ignored.items.length === 0 ? (
          <p className="text-sm">{l.ignored_none}</p>
        ) : (
          <ul className="flex min-w-0 flex-col rounded-2xl border border-[#E4E4E4] bg-white px-2">
            {ignored.items.map((entry) => (
              <Row
                key={entry.key}
                testId={entry.key}
                editing={ignEditing}
                checked={ignSelected.has(entry.key)}
                onToggle={() => setIgnSelected((s) => toggle(s, entry.key))}
                label={fill(l.select_row, { name: entry.name ?? entry.key })}
              >
                <span className="break-words text-[15px] font-medium">{entry.name ?? entry.key}</span>
                <span className="flex flex-wrap gap-x-3 text-[13px] text-[#5B6670]">
                  <span className="break-all">{fill(l.code, { code: entry.key })}</span>
                  <span>
                    {fill(l.ignored_row, {
                      date: dateText(entry.created_at),
                      who: entry.by_me ? l.by_you : (entry.by ?? l.by_other),
                    })}
                  </span>
                </span>
              </Row>
            ))}
          </ul>
        )}
        {restored && (
          <div className="flex flex-col gap-2 rounded-2xl border border-[#E4E4E4] bg-white p-4 text-sm" data-ignored-restored>
            <p>{fill(l[restoredKey(restored.source)], { n: restored.n })}</p>
            {(restored.source === "agent" || restored.source === "api") && (
              <button type="button" className={smallGhost} disabled={busy} onClick={() => void syncAgain()} data-ignored-sync>
                {l.sync_now}
              </button>
            )}
          </div>
        )}
      </section>

      <p className="text-sm" role="status" aria-live="polite" data-ignore-message>
        {message}
      </p>

      {/* the toast: "Vymazané: 3 · Späť" (8 s) */}
      {toast && (
        <div
          className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-md items-center justify-between gap-3 rounded-xl bg-[#111] px-4 py-3 text-[15px] text-white shadow-lg"
          role="status"
          data-ignore-toast
        >
          <span>{fill(l.toast, { n: toast.n })}</span>
          <button type="button" className="min-h-[44px] px-2 font-bold underline underline-offset-4" onClick={() => void undo()} data-ignore-undo>
            {l.undo}
          </button>
        </div>
      )}

      <dialog
        ref={dialog}
        className="m-auto w-[min(92vw,30rem)] rounded-2xl p-0 backdrop:bg-black/40"
        onCancel={(e) => {
          e.preventDefault();
          setAsk(null);
          setTyped("");
        }}
        aria-labelledby="ignore-dialog-title"
        data-ignore-dialog
      >
        {ask && page && (
          <form
            method="dialog"
            className="flex flex-col gap-4 p-5"
            onSubmit={(e) => {
              e.preventDefault();
              void confirmDelete();
            }}
          >
            <h3 id="ignore-dialog-title" className="text-lg font-bold">
              {plural("dialog_title", ask.n)}
            </h3>
            <p className="text-sm">{l.dialog_text}</p>
            {ask.all && (
              <label className="flex flex-col gap-1 text-sm">
                <span>{l.dialog_all_text}</span>
                <input
                  className={fieldClass}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  aria-label={l.dialog_name}
                  placeholder={page.shop_name}
                  autoComplete="off"
                  data-ignore-name
                />
              </label>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className={ghostClass}
                onClick={() => {
                  setAsk(null);
                  setTyped("");
                }}
              >
                {l.back}
              </button>
              <button
                type="submit"
                className={buttonClass}
                disabled={busy || (ask.all && !nameConfirmed(typed, page.shop_name))}
                data-ignore-confirm
              >
                {busy ? l.working : l.dialog_confirm}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}
