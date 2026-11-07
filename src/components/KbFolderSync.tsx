"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import { folderPickerSupported, storeDelete, storeGet, storeSet, type FolderHandle } from "@/lib/folderStore";
import { KB_EVERY_MS, kbAction, kbDocName, kbFileKind, planCheck, type KbEntry, type KbKnown, type KbSeen } from "@/lib/kbFolder";
import { createClient } from "@/lib/supabase/client";
import { errorText, ingest, runWork, sendPdf, sendPictureIds, shrinkPicture } from "@/components/DocUpload";
import { ghostClass } from "@/components/owner/ui";

type Labels = Dictionary["kbfolder"];
type DocLabels = Dictionary["docs"];

/** What this browser keeps for one linked folder (IndexedDB `kbfolder:<shop>:<folder>`). */
interface Saved {
  folder: FolderHandle & { isSameEntry(other: unknown): Promise<boolean> };
  seen: Record<string, KbSeen>;
}

interface FolderState {
  linked: boolean;
  synced_at: string | null;
  files: number | null;
  remove_missing: boolean;
  items: KbKnown[];
}

type Picker = Window & { showDirectoryPicker?: (o?: { id?: string; mode?: "read"; startIn?: string }) => Promise<Saved["folder"]> };

const TICK_MS = 30_000;
const noSubscribe = () => () => {};

async function sha256(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * AI asistent → Dokumenty → "Priečinok na počítači" of one folder (update 94): the owner links a folder on the shop's
 * PC (Edge / Chrome, read only; never the stock or translations folder). While this window is open it checks the
 * folder on start, every 15 minutes and on "Skontrolovať teraz" (one window per shop and folder: Web Locks): new or
 * changed PDFs and pictures go through the usual upload (doc-ingest) and are marked as the folder's files
 * (owner_kb_mark_source); a changed file replaces its own document; a file gone from the folder is "Chýba v priečinku"
 * and stays until the owner removes it — or, with the switch on, it is removed at the next check. Subfolders are
 * ignored; nothing is ever written to the PC folder.
 */
export function KbFolderSync({
  shopId,
  folderId,
  lang,
  picturesLeft,
  state: initial,
  labels,
  docLabels,
}: {
  shopId: string;
  folderId: string;
  lang: string;
  picturesLeft: number;
  state: FolderState;
  labels: Labels;
  docLabels: DocLabels;
}) {
  const router = useRouter();
  const key = `kbfolder:${shopId}:${folderId}`;
  const [state, setState] = useState<FolderState>(initial);
  const [folderName, setFolderName] = useState<string | null>(null);
  // the picker exists only in Edge / Chrome on a computer (the server draws the supported state)
  const supported = useSyncExternalStore(noSubscribe, folderPickerSupported, () => true);
  const [needsPermission, setNeedsPermission] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [notes, setNotes] = useState<{ unsupported: string[]; waiting: string[] }>({ unsupported: [], waiting: [] });
  const [message, setMessage] = useState<string | null>(null);
  const [otherWindow, setOtherWindow] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const active = useRef(false);
  const running = useRef(false);
  const nextAt = useRef(0);

  const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? `{${k}}`));

  const reload = useCallback(async (): Promise<FolderState | null> => {
    const { data, error } = await createClient().rpc("owner_kb_folder_files", { p_folder_id: folderId });
    if (error || !data) return null;
    const next = data as FolderState;
    setState(next);
    return next;
  }, [folderId]);

  const check = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    nextAt.current = Date.now() + KB_EVERY_MS;
    const supabase = createClient();
    const failed: string[] = [];
    let changed = 0;
    let removedReplaced = 0;
    let uploaded = false;
    try {
      const saved = await storeGet<Saved>(key);
      if (!saved) return;
      setFolderName(saved.folder.name);
      if ((await saved.folder.queryPermission({ mode: "read" })) !== "granted") {
        setNeedsPermission(true);
        return;
      }
      setNeedsPermission(false);
      setBusy(labels.checking);
      const current = (await reload()) ?? state;
      // the folder's own files (subfolders ignored)
      const handles = new Map<string, { getFile(): Promise<File> }>();
      const entries: KbEntry[] = [];
      for await (const entry of saved.folder.values()) {
        if (entry.kind !== "file" || kbFileKind(entry.name) === undefined) continue;
        try {
          const file = await entry.getFile();
          handles.set(entry.name, entry);
          entries.push({ name: entry.name, size: file.size, mtime: file.lastModified });
        } catch {
          // a file locked by another program: next time
        }
      }
      // e2e: the tests write files "now" and set a shorter wait (window.__ppiKbSettleMs)
      const settle = (window as { __ppiKbSettleMs?: number }).__ppiKbSettleMs;
      const plan = planCheck(entries, saved.seen ?? {}, Date.now(), typeof settle === "number" ? settle : undefined);
      setNotes({ unsupported: plan.unsupported, waiting: plan.waiting });
      const seen: Record<string, KbSeen> = {};
      for (const u of plan.unchanged) seen[u.name] = saved.seen[u.name];
      let left = picturesLeft;
      const todo: { name: string; hash: string; file: File | null }[] = plan.unchanged.map((u) => ({ ...u, file: null }));
      for (const name of plan.read) {
        try {
          const file = await handles.get(name)!.getFile();
          const hash = await sha256(file);
          seen[name] = { size: file.size, mtime: file.lastModified, hash };
          todo.push({ name, hash, file });
        } catch (e) {
          failed.push(`${name}: ${errorText(docLabels, e)}`);
        }
      }
      for (const item of todo) {
        const decision = kbAction(item.name, item.hash, current.items);
        if (decision.action === "same") continue;
        // an unchanged file whose document is gone or different: read it now
        const file = item.file ?? (await handles.get(item.name)?.getFile().catch(() => null)) ?? null;
        if (!file) continue;
        setBusy(fill(labels.uploading, { name: item.name }));
        try {
          let id: string;
          let kind: "document" | "picture";
          if (kbFileKind(item.name) === "pdf") {
            const r = await sendPdf(
              supabase,
              file,
              { shopId, folderId, lang, name: kbDocName(item.name), description: "", picturesLeft: left },
              () => {},
              docLabels,
            );
            left -= r.taken;
            id = r.documentId;
            kind = "document";
          } else {
            const ids = await sendPictureIds(supabase, { shop_id: shopId, folder_id: folderId, lang }, [
              { blob: await shrinkPicture(file), title: kbDocName(item.name) },
            ]);
            if (!ids.length) throw new Error(docLabels.error_limit_pictures);
            id = ids[0];
            kind = "picture";
          }
          const { error } = await supabase.rpc("owner_kb_mark_source", { p_kind: kind, p_id: id, p_name: item.name, p_hash: item.hash });
          if (error) throw new Error(error.message);
          uploaded = true;
          changed++;
          // the old document of the same file goes only after the new one is in
          for (const old of decision.old) {
            await ingest(supabase, { action: "delete", kind: old.kind, id: old.id });
            removedReplaced++;
          }
        } catch (e) {
          delete seen[item.name];
          failed.push(`${item.name}: ${errorText(docLabels, e)}`);
        }
      }
      await storeSet(key, { folder: saved.folder, seen } satisfies Saved);
      if (removedReplaced) await supabase.rpc("owner_kb_removed", { p_folder_id: folderId, p_count: removedReplaced, p_reason: "replaced" });
      const { data: synced, error } = await supabase.rpc("owner_kb_folder_synced", {
        p_folder_id: folderId,
        p_present: plan.present,
        p_files: plan.present.length,
        p_changed: changed,
      });
      if (error) throw new Error(error.message);
      const result = synced as { remove_missing: boolean; missing: { kind: "document" | "picture"; id: string }[] };
      if (result.remove_missing && result.missing.length) {
        let removed = 0;
        for (const m of result.missing) {
          await ingest(supabase, { action: "delete", kind: m.kind, id: m.id }).then(() => removed++).catch(() => {});
        }
        if (removed) await supabase.rpc("owner_kb_removed", { p_folder_id: folderId, p_count: removed, p_reason: "missing" });
      }
      await reload();
      setMessage(null);
    } catch (e) {
      setMessage(fill(labels.error, { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setProblems(failed);
      setBusy(null);
      running.current = false;
    }
    if (uploaded) {
      // the AI describes new pictures and reads scanned pages
      void runWork(supabase, shopId, () => {}).catch(() => {});
    }
    router.refresh();
  }, [docLabels, folderId, key, labels, lang, picturesLeft, reload, router, shopId, state]);

  const checkRef = useRef(check);
  useEffect(() => {
    checkRef.current = check;
  }, [check]);

  // one window per shop and folder checks it (Web Locks); the others say so
  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | undefined;
    const controller = new AbortController();
    const hold = () => {
      if (cancelled) return undefined;
      active.current = true;
      setOtherWindow(false);
      void checkRef.current();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    void storeGet<Saved>(key).then((saved) => {
      if (cancelled || !saved) return;
      setFolderName(saved.folder.name);
      const name = `ppi-kb-${shopId}-${folderId}`;
      if (!navigator.locks) {
        void hold();
        return;
      }
      navigator.locks
        .request(name, { ifAvailable: true }, (lock) => {
          if (lock) return hold();
          if (!cancelled) {
            setOtherWindow(true);
            navigator.locks.request(name, { signal: controller.signal }, hold).catch(() => undefined);
          }
          return undefined;
        })
        .catch(() => undefined);
    });
    const tick = () => {
      if (active.current && Date.now() >= nextAt.current) void checkRef.current();
    };
    const id = window.setInterval(tick, TICK_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      cancelled = true;
      active.current = false;
      controller.abort();
      release?.();
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [folderId, key, shopId]);

  async function link() {
    setMessage(null);
    const picker = (window as Picker).showDirectoryPicker;
    if (!picker) return;
    let folder: Saved["folder"];
    try {
      folder = await picker.call(window, { id: "ppi-kb", mode: "read", startIn: "documents" });
    } catch {
      return; // the owner closed the picker
    }
    // never the stock folder or the translations folder
    const stock = await storeGet<Saved["folder"]>(`folder:${shopId}`);
    const translations = await storeGet<{ folder: Saved["folder"] }>(`trfolder:${shopId}`);
    for (const other of [stock, translations?.folder]) {
      if (other && (await folder.isSameEntry(other).catch(() => false))) {
        setMessage(labels.same_folder);
        return;
      }
    }
    const { error } = await createClient().rpc("owner_kb_folder_link", { p_folder_id: folderId, p_linked: true });
    if (error) {
      setMessage(fill(labels.error, { message: error.message }));
      return;
    }
    await storeSet(key, { folder, seen: {} } satisfies Saved);
    setFolderName(folder.name);
    active.current = true;
    await check();
  }

  async function unlink() {
    const { error } = await createClient().rpc("owner_kb_folder_link", { p_folder_id: folderId, p_linked: false });
    if (error) {
      setMessage(fill(labels.error, { message: error.message }));
      return;
    }
    await storeDelete(key);
    active.current = false;
    setFolderName(null);
    setProblems([]);
    setNotes({ unsupported: [], waiting: [] });
    await reload();
    router.refresh();
  }

  async function allow() {
    const saved = await storeGet<Saved>(key);
    if (saved && (await saved.folder.requestPermission({ mode: "read" })) === "granted") {
      setNeedsPermission(false);
      await check();
    }
  }

  async function setRemoveMissing(on: boolean) {
    setConfirming(false);
    const { error } = await createClient().rpc("owner_kb_folder_settings", { p_folder_id: folderId, p_remove_missing: on });
    if (error) setMessage(fill(labels.error, { message: error.message }));
    await reload();
  }

  async function remove(item: KbKnown) {
    try {
      const supabase = createClient();
      await ingest(supabase, { action: "delete", kind: item.kind, id: item.id });
      await supabase.rpc("owner_kb_removed", { p_folder_id: folderId, p_count: 1, p_reason: "owner" });
    } catch (e) {
      setMessage(errorText(docLabels, e));
    }
    await reload();
    router.refresh();
  }

  const missing = state.items.filter((i) => i.missing_since);
  const time = state.synced_at
    ? new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit" }).format(new Date(state.synced_at))
    : null;
  const here = Boolean(folderName);

  return (
    <div className="flex flex-col gap-2 text-sm" data-kb-folder={folderId}>
      {!supported ? (
        <p className="text-muted" data-kb-unsupported>{labels.unsupported_browser}</p>
      ) : !state.linked ? (
        <div>
          <button type="button" onClick={link} className={ghostClass} data-kb-link>
            {labels.link}
          </button>
        </div>
      ) : (
        <>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {here && <span className="font-medium" data-kb-name>{fill(labels.folder, { name: folderName ?? "" })}</span>}
            <span className="text-muted" data-kb-status aria-live="polite">
              {busy ?? (time ? fill(labels.synced, { time, n: state.files ?? 0 }) : labels.not_synced)}
            </span>
          </p>
          {!here && <p className="text-muted">{labels.linked_elsewhere}</p>}
          {otherWindow && <p className="text-muted">{labels.other_window}</p>}
          <div className="flex flex-wrap gap-2">
            {here ? (
              needsPermission ? (
                <button type="button" onClick={allow} className={ghostClass} data-kb-allow>{labels.allow}</button>
              ) : (
                <button type="button" onClick={() => void check()} disabled={Boolean(busy) || otherWindow} className={ghostClass} data-kb-check>
                  {labels.check_now}
                </button>
              )
            ) : (
              <button type="button" onClick={link} className={ghostClass} data-kb-link>{labels.link}</button>
            )}
            <button type="button" onClick={unlink} className={ghostClass} data-kb-unlink>{labels.unlink}</button>
          </div>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={state.remove_missing}
              onChange={(e) => (e.currentTarget.checked ? setConfirming(true) : void setRemoveMissing(false))}
              className="mt-1"
              data-kb-remove-missing
            />
            <span>
              {labels.remove_missing}
              <span className="block text-muted">{labels.remove_missing_hint}</span>
            </span>
          </label>
          {confirming && (
            <div className="flex flex-col gap-2 rounded-xl border border-line p-3" role="alertdialog" data-kb-confirm>
              <p>{labels.remove_missing_confirm}</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => void setRemoveMissing(true)} className={ghostClass} data-kb-confirm-yes>{labels.confirm_yes}</button>
                <button type="button" onClick={() => setConfirming(false)} className={ghostClass}>{labels.cancel}</button>
              </div>
            </div>
          )}
          {missing.length > 0 && (
            <ul className="flex flex-col gap-1" data-kb-missing>
              {missing.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-2">
                  <span>{m.name}</span>
                  <span className="rounded-full bg-[#FFF6D6] px-2 py-0.5 text-xs font-semibold">{labels.missing}</span>
                  <button type="button" onClick={() => void remove(m)} className="underline underline-offset-4" data-kb-remove={m.id}>
                    {labels.remove}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {(notes.unsupported.length > 0 || notes.waiting.length > 0) && (
            <ul className="flex flex-col gap-0.5 text-muted" data-kb-notes>
              {notes.unsupported.map((n) => <li key={`u-${n}`}>{n} · {labels.unsupported}</li>)}
              {notes.waiting.map((n) => <li key={`w-${n}`}>{n} · {labels.waiting}</li>)}
            </ul>
          )}
          {problems.length > 0 && (
            <div data-kb-problems>
              <p className="font-medium">{labels.errors_title}</p>
              <ul className="list-disc pl-5">
                {problems.map((p) => <li key={p}>{p}</li>)}
              </ul>
            </div>
          )}
        </>
      )}
      {message && <p role="alert" className="text-[#B91C1C]">{message}</p>}
    </div>
  );
}
