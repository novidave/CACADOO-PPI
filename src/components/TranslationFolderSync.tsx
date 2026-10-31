"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Locale } from "@/i18n/config";
import { formatDateTime } from "@/lib/format";
import { fileHash, fileName, type ExportFileLabels, type ExportInfo, type FileEdits } from "@/lib/exportFiles";
import { downloadZip, exportInfo, fileEdits, workbookFor } from "@/lib/exportClient";
import {
  fileIn,
  folderPickerSupported,
  pickTranslationFolder,
  storeDelete,
  storeGet,
  storeSet,
  type FolderHandle,
  type TranslationFolder,
} from "@/lib/folderStore";
import { createClient } from "@/lib/supabase/client";
import { applyExportEdits, describeItems, exportAuto } from "@/app/[lang]/(account)/sync/exportActions";

const CHECK_EVERY_MS = 15 * 60_000;
/** A file the owner saved is read only when it was untouched this long (Excel may still be writing it). */
const SETTLE_MS = 60_000;
const RECHECK_SOON_MS = 60_000;
const TICK_MS = 20_000;

/** A file Cacaduu wrote (only these are ever written again, read or deleted). */
interface Tracked {
  lang: string | null;
  lastModified: number;
  size: number;
  hash: string;
}

/** What this computer remembers per shop (IndexedDB, never sent anywhere). */
interface Saved {
  folder: TranslationFolder;
  files: Record<string, Tracked>;
  /** owner_export_info().version of the last complete write */
  version: string | null;
  writtenAt: number | null;
  /** the last "Vymazať celý sklad" request handled */
  deletedFor: string | null;
  /** folders chosen before (their files stay Cacaduu's when the owner goes back to one) */
  earlier?: { folder: TranslationFolder; files: Record<string, Tracked> }[];
}

type Phase = "starting" | "other_window" | "signed_out" | "no_folder" | "needs_permission" | "watching";

export type TranslationFolderLabels = ExportFileLabels & Record<string, string>;

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

const noSubscription = () => () => undefined;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Excel (and other programs) keep a file locked while it is open. */
const isLocked = (e: unknown) =>
  e instanceof DOMException && ["NoModificationAllowedError", "InvalidModificationError", "NotReadableError", "InvalidStateError"].includes(e.name);

/**
 * "Preklady v priečinku" (database update 45): a folder on the shop PC (Edge or Chrome) where Cacaduu keeps
 * sklad.<main>.xlsx and sklad.<lang>.xlsx. On every check (every 15 minutes, when the window opens, "Skontrolovať
 * teraz", after a stock file was sent) it first reads the owner's edits of its own files (untouched for 60 s; a file
 * open in Excel waits), applies them, handles new products as remembered, and only then writes the files again —
 * when something changed — through a temporary file that replaces the old one. It never touches a file it did not
 * write, and the stock folder is never this folder. Without the folder (any browser): the files as a ZIP, and an
 * edited file uploaded by hand.
 */
export function TranslationFolderSync({
  shopId,
  slug,
  lang,
  timeZone,
  loginHref,
  labels,
}: {
  shopId: string;
  slug: string;
  lang: Locale;
  timeZone: string;
  loginHref: string;
  labels: TranslationFolderLabels;
}) {
  const supported = useSyncExternalStore(noSubscription, folderPickerSupported, () => true);
  const [phase, setPhase] = useState<Phase>("starting");
  const [folderName, setFolderName] = useState<string | null>(null);
  const [writtenAt, setWrittenAt] = useState<number | null>(null);
  const [lastCheck, setLastCheck] = useState<number | null>(null);
  const [nextCheck, setNextCheck] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [handMessage, setHandMessage] = useState<string[]>([]);
  const [handBusy, setHandBusy] = useState<"download" | "upload" | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);

  const running = useRef(false);
  const active = useRef(false);
  const nextAt = useRef(0);
  const forceNext = useRef(false);
  const key = `trfolder:${shopId}`;

  const schedule = useCallback((ms: number) => {
    nextAt.current = Date.now() + ms;
    setNextCheck(nextAt.current);
  }, []);

  /** The result line of an applied file. */
  const appliedText = useCallback(
    (file: string, edits: FileEdits, result: { applied: number; unknown: unknown[]; skipped: unknown[] }) => {
      const parts = [result.applied ? fill(labels.file_applied, { file, n: result.applied }) : fill(labels.file_no_changes, { file })];
      if (edits.readonly.length) {
        const columns = [...new Set(edits.readonly.map((r) => r.column))].slice(0, 3).join(", ");
        parts.push(fill(labels.file_readonly, { n: edits.readonly.length, columns }));
      }
      const unknown = edits.unknown.length + result.unknown.length;
      if (unknown) parts.push(fill(labels.file_unknown, { n: unknown, codes: edits.unknown.slice(0, 3).join(", ") || "–" }));
      if (result.skipped.length) parts.push(fill(labels.file_skipped, { n: result.skipped.length }));
      return parts.join(" · ");
    },
    [labels],
  );

  /** Applies one file's edits (from the folder or uploaded by hand). */
  const apply = useCallback(
    async (file: string, bytes: Uint8Array): Promise<{ text: string; applied: number }> => {
      const read = await fileEdits(bytes, shopId);
      if (!read.ok) {
        if (read.error === "other_shop") return { text: fill(labels.file_other_shop, { file }), applied: 0 };
        return { text: fill(read.error === "not_ours" ? labels.file_not_cacaduu : labels.file_failed, { file, error: read.detail }), applied: 0 };
      }
      const edits = read.edits;
      if (!edits.edits.length) return { text: appliedText(file, edits, { applied: 0, unknown: [], skipped: [] }), applied: 0 };
      const result = await applyExportEdits({ shopId, slug, lang: edits.lang, file, edits: edits.edits });
      if (!result.ok) return { text: fill(labels.file_failed, { file, error: result.error }), applied: 0 };
      return { text: appliedText(file, edits, result.value), applied: result.value.applied };
    },
    [appliedText, labels, shopId, slug],
  );

  /** "Vygenerovať popisy" for the new products, 20 per call. */
  const describe = useCallback(
    async (ids: string[]) => {
      let made = 0;
      for (let i = 0; i < ids.length; i += 20) {
        setMessage(fill(labels.describing, { done: i, total: ids.length }));
        const r = await describeItems(slug, ids.slice(i, i + 20));
        if (r.ok) made += r.value.made;
      }
      setMessage(fill(labels.described, { n: made }));
    },
    [labels, slug],
  );

  const check = useCallback(async () => {
    if (running.current || !active.current) return;
    running.current = true;
    setBusy(true);
    const force = forceNext.current;
    forceNext.current = false;
    let soon = false;
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        setPhase("signed_out");
        return;
      }
      const saved = await storeGet<Saved>(key);
      if (!saved) {
        setFolderName(null);
        setPhase("no_folder");
        return;
      }
      setFolderName(saved.folder.name);
      setWrittenAt(saved.writtenAt);
      if ((await saved.folder.queryPermission({ mode: "readwrite" })) !== "granted") {
        setPhase("needs_permission");
        return;
      }
      setPhase("watching");
      const next: Record<string, string> = {};
      /** files whose edits are not read yet (being saved, open in Excel): never written over */
      const unread = new Set<string>();
      const folder = saved.folder;
      const files = { ...saved.files };
      let rewrite = force;

      const { data: infoData, error: infoError } = await supabase.rpc("owner_export_info", { p_shop_id: shopId });
      if (infoError) throw new Error(infoError.message);
      let info = infoData as ExportInfo;

      // 0. "Vymazať celý sklad" asked for these files to go (only the files Cacaduu wrote)
      if (info.delete_files_at && info.delete_files_at !== saved.deletedFor) {
        let deleted = 0;
        // this folder and the ones used before (only the files Cacaduu wrote there)
        for (const place of [{ folder, files }, ...(saved.earlier ?? [])]) {
          if (place.folder !== folder && (await place.folder.queryPermission({ mode: "readwrite" }).catch(() => "denied")) !== "granted") continue;
          for (const name of Object.keys(place.files)) {
            if (await fileIn(place.folder, name)) {
              await place.folder.removeEntry(name);
              deleted++;
            }
          }
        }
        await supabase.rpc("owner_log_export_files_deleted", { p_shop_id: shopId, p_files: deleted });
        await storeSet(key, { ...saved, files: {}, earlier: [], version: null, deletedFor: info.delete_files_at } satisfies Saved);
        setLines({});
        setMessage(fill(labels.deleted, { n: deleted }));
        return;
      }

      // 1. the owner's edits of Cacaduu's files
      for (const [name, tracked] of Object.entries(files)) {
        try {
          const handle = await fileIn(folder, name);
          if (!handle) {
            delete files[name]; // deleted by the owner: written again below
            rewrite = true;
            continue;
          }
          const file = await handle.getFile();
          if (file.lastModified === tracked.lastModified && file.size === tracked.size) continue;
          if (Date.now() - file.lastModified < SETTLE_MS) {
            next[name] = fill(labels.file_settling, { file: name });
            unread.add(name);
            soon = true;
            continue;
          }
          const bytes = new Uint8Array(await file.arrayBuffer());
          const hash = await fileHash(bytes);
          if (hash !== tracked.hash) {
            const result = await apply(name, bytes);
            next[name] = result.text;
            rewrite = true;
          }
          files[name] = { ...tracked, lastModified: file.lastModified, size: file.size, hash };
        } catch (e) {
          unread.add(name);
          if (isLocked(e)) {
            next[name] = fill(labels.file_locked_read, { file: name });
            soon = true;
          } else next[name] = fill(labels.file_failed, { file: name, error: errorText(e) });
        }
      }
      await storeSet(key, { ...saved, files } satisfies Saved);

      // 2. new products as remembered ("Zapamätať a už sa nepýtať")
      const auto = await exportAuto(shopId);
      if (auto.ok && auto.value.describeIds.length) await describe(auto.value.describeIds);

      // 3. the files written again when anything in them changed (the stock file came through the stock folder)
      const { data: again } = await supabase.rpc("owner_export_info", { p_shop_id: shopId });
      if (again) info = again as ExportInfo;
      if (!info.confirmed || info.items === 0) {
        setMessage(labels.nothing_yet);
      } else {
        const wanted: (string | null)[] = [null, ...info.langs];
        const missing = wanted.some((l) => !files[fileName(l ?? info.main_lang)]);
        if (rewrite || missing || info.version !== saved.version) {
          let complete = true;
          for (const l of wanted) {
            const name = fileName(l ?? info.main_lang);
            const tracked = files[name];
            if (unread.has(name)) {
              complete = false;
              continue; // the owner's edits first
            }
            try {
              const existing = await fileIn(folder, name);
              if (existing && !tracked) {
                next[name] = fill(labels.file_not_ours, { file: name });
                continue; // never a file Cacaduu did not write
              }
              if (existing && tracked) {
                const now = await existing.getFile();
                if (now.lastModified !== tracked.lastModified || now.size !== tracked.size) {
                  next[name] = next[name] ?? fill(labels.file_settling, { file: name });
                  complete = false;
                  soon = true;
                  continue; // edited again since it was read: read first
                }
              }
              const { bytes, rows } = await workbookFor(shopId, info, l, labels, lang);
              const handle = existing ?? (await folder.getFileHandle(name, { create: true }));
              // createWritable() writes a temporary file that replaces the old one only when closed
              const writable = await handle.createWritable({ keepExistingData: false });
              try {
                await writable.write(new Blob([bytes as BlobPart]));
                await writable.close();
              } catch (e) {
                await writable.abort?.().catch(() => undefined);
                throw e;
              }
              const written = await handle.getFile();
              files[name] = { lang: l, lastModified: written.lastModified, size: written.size, hash: await fileHash(bytes) };
              next[name] = next[name] ? `${next[name]} · ${fill(labels.file_written_short, { rows })}` : fill(labels.file_written, { file: name, rows });
            } catch (e) {
              complete = false;
              if (isLocked(e)) {
                next[name] = fill(labels.file_locked, { file: name });
                soon = true;
              } else next[name] = fill(labels.file_failed, { file: name, error: errorText(e) });
            }
          }
          const at = Date.now();
          await storeSet(key, { ...saved, files, version: complete ? info.version : null, writtenAt: at } satisfies Saved);
          setWrittenAt(at);
        }
        setMessage(null);
      }
      setLines((old) => ({ ...old, ...next }));
    } catch (e) {
      setMessage(fill(labels.check_failed, { error: errorText(e) }));
    } finally {
      schedule(soon ? RECHECK_SOON_MS : CHECK_EVERY_MS);
      running.current = false;
      setBusy(false);
      setLastCheck(Date.now());
    }
  }, [apply, describe, key, labels, lang, schedule, shopId]);

  const checkRef = useRef(check);
  useEffect(() => {
    checkRef.current = check;
  }, [check]);

  // One window per shop (like the stock folder): a second one waits and takes over when the first closes.
  useEffect(() => {
    if (!folderPickerSupported()) return;
    let cancelled = false;
    let release: (() => void) | undefined;
    const controller = new AbortController();
    const hold = (lock: Lock | null) => {
      if (!lock || cancelled) return undefined;
      active.current = true;
      nextAt.current = 0;
      void checkRef.current();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const name = `ppi-translations-${shopId}`;
    if (!navigator.locks) {
      void hold({ name, mode: "exclusive" } as Lock);
    } else {
      navigator.locks
        .request(name, { ifAvailable: true }, (lock) => {
          if (lock) return hold(lock);
          if (!cancelled) {
            setPhase("other_window");
            navigator.locks.request(name, { signal: controller.signal }, hold).catch(() => undefined);
          }
          return undefined;
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
      active.current = false;
      controller.abort();
      release?.();
    };
  }, [shopId]);

  // The 15-minute rhythm, and soon after a stock file was sent from the stock folder.
  useEffect(() => {
    const tick = () => {
      if (active.current && Date.now() >= nextAt.current) void checkRef.current();
    };
    const sent = () => {
      nextAt.current = Math.min(nextAt.current, Date.now() + 5_000);
    };
    const id = window.setInterval(tick, TICK_MS);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("online", tick);
    window.addEventListener("ppi:stock-sent", sent);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("online", tick);
      window.removeEventListener("ppi:stock-sent", sent);
    };
  }, []);

  async function connect() {
    try {
      const folder = await pickTranslationFolder();
      // never the stock folder: the files there are the stock software's
      const stock = await storeGet<FolderHandle>(`folder:${shopId}`);
      if (stock && (await folder.isSameEntry(stock))) {
        setMessage(labels.same_folder);
        return;
      }
      const old = await storeGet<Saved>(key);
      const same = old ? await folder.isSameEntry(old.folder) : false;
      // the folders used before, this one's files found again when the owner comes back to it
      const known = old && !same ? [{ folder: old.folder, files: old.files }, ...(old.earlier ?? [])] : (old?.earlier ?? []);
      let files = same && old ? old.files : {};
      const earlier: NonNullable<Saved["earlier"]> = [];
      for (const e of known) {
        if (!same && (await folder.isSameEntry(e.folder))) files = e.files;
        else earlier.push(e);
      }
      await storeSet(key, {
        folder,
        files,
        version: null,
        writtenAt: same && old ? old.writtenAt : null,
        deletedFor: old?.deletedFor ?? null,
        earlier: earlier.slice(0, 5),
      } satisfies Saved);
      setFolderName(folder.name);
      setLines({});
      setMessage(null);
      forceNext.current = true;
      await check();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setMessage(fill(labels.picker_failed, { error: errorText(e) }));
    }
  }

  async function allow() {
    const saved = await storeGet<Saved>(key);
    if (saved && (await saved.folder.requestPermission({ mode: "readwrite" })) === "granted") await check();
  }

  async function disconnect() {
    await storeDelete(key);
    setFolderName(null);
    setLines({});
    setMessage(null);
    setWrittenAt(null);
    setPhase("no_folder");
  }

  function writeNow() {
    forceNext.current = true;
    void check();
  }

  /** Without the folder: every file in one ZIP. */
  async function download() {
    setHandBusy("download");
    setHandMessage([]);
    try {
      const info = await exportInfo(shopId);
      if (!info.confirmed || info.items === 0) {
        setHandMessage([labels.nothing_yet]);
        return;
      }
      const n = await downloadZip({ shopId, info, langs: [null, ...info.langs], labels, pageLang: lang, name: slug });
      setHandMessage([fill(labels.downloaded, { n })]);
    } catch (e) {
      setHandMessage([fill(labels.check_failed, { error: errorText(e) })]);
    } finally {
      setHandBusy(null);
    }
  }

  /** "Nahrať upravený súbor": one or more edited files, each read against what Cacaduu wrote into it. */
  async function upload(event: React.ChangeEvent<HTMLInputElement>) {
    const field = event.currentTarget;
    const chosen = [...(field.files ?? [])];
    field.value = "";
    if (!chosen.length) return;
    setHandBusy("upload");
    const out: string[] = [];
    for (const file of chosen) {
      try {
        out.push((await apply(file.name, new Uint8Array(await file.arrayBuffer()))).text);
      } catch (e) {
        out.push(fill(labels.file_failed, { file: file.name, error: errorText(e) }));
      }
    }
    setHandMessage(out);
    setHandBusy(null);
  }

  const when = (ms: number) => formatDateTime(new Date(ms), lang, timeZone);
  const button = "self-start rounded border px-4 py-2";
  const lineList = Object.entries(lines);

  const byHand = (
    <section className="flex flex-col gap-2 border-t border-line pt-3" data-translation-hand aria-busy={handBusy !== null}>
      <h4 className="font-semibold">{labels.hand_title}</h4>
      <p className="text-sm text-muted">{labels.hand_hint}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={download} disabled={handBusy !== null} className={`${button} border-foreground font-medium`} data-translation-download>
          {handBusy === "download" ? labels.downloading : labels.download}
        </button>
        <input
          ref={uploadInput}
          type="file"
          multiple
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={upload}
          className="sr-only"
          tabIndex={-1}
          data-translation-upload-input
        />
        <button type="button" onClick={() => uploadInput.current?.click()} disabled={handBusy !== null} className={`${button} border-foreground font-medium`}>
          {handBusy === "upload" ? labels.uploading : labels.upload}
        </button>
      </div>
      {handMessage.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" role="status" data-translation-hand-result>
          {handMessage.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}
    </section>
  );

  if (!supported) {
    return (
      <div className="flex flex-col gap-3">
        <p className="font-semibold">{labels.unsupported}</p>
        {byHand}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-4 border border-line p-4" aria-busy={busy} data-translation-folder={phase}>
        {phase === "signed_out" && (
          <p className="font-semibold">
            {labels.signed_out}{" "}
            <a href={loginHref} className="underline underline-offset-4">
              {labels.sign_in}
            </a>
          </p>
        )}
        {phase === "other_window" && <p className="font-semibold">{labels.other_window}</p>}

        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-muted">{labels.folder}</dt>
          <dd className="font-semibold" data-translation-folder-name>
            {folderName ?? labels.not_connected}
          </dd>
          <dt className="text-muted">{labels.last_written}</dt>
          <dd data-translation-written>{writtenAt ? when(writtenAt) : "–"}</dd>
          <dt className="text-muted">{labels.last_check}</dt>
          <dd>{busy ? labels.checking : lastCheck ? when(lastCheck) : "–"}</dd>
          <dt className="text-muted">{labels.next_check}</dt>
          <dd>{nextCheck && phase === "watching" && !busy ? when(nextCheck) : "–"}</dd>
        </dl>

        {message && (
          <p className="font-semibold" role="status" data-translation-message>
            {message}
          </p>
        )}
        {lineList.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm" aria-live="polite" data-translation-lines>
            {lineList.map(([name, text]) => (
              <li key={name} data-translation-line={name}>
                {text}
              </li>
            ))}
          </ul>
        )}

        {phase === "needs_permission" && (
          <div className="flex flex-col gap-2">
            <button type="button" onClick={allow} className={`${button} border-foreground font-medium`}>
              {labels.allow}
            </button>
            <p className="text-sm text-muted">{labels.allow_hint}</p>
          </div>
        )}

        {phase !== "other_window" && phase !== "signed_out" && phase !== "starting" && (
          <div className="flex flex-wrap gap-2">
            {phase === "no_folder" ? (
              <button type="button" onClick={connect} className={`${button} border-foreground font-medium`} data-translation-connect>
                {labels.choose}
              </button>
            ) : (
              <>
                {phase === "watching" && (
                  <>
                    <button type="button" onClick={() => void check()} disabled={busy} className={`${button} border-foreground font-medium`} data-translation-check>
                      {labels.check_now}
                    </button>
                    <button type="button" onClick={writeNow} disabled={busy} className={`${button} border-foreground font-medium`} data-translation-write>
                      {labels.write_now}
                    </button>
                  </>
                )}
                <button type="button" onClick={connect} className={`${button} border-line`}>
                  {labels.change}
                </button>
                <button type="button" onClick={disconnect} className={`${button} border-line`}>
                  {labels.disconnect}
                </button>
              </>
            )}
          </div>
        )}
      </section>
      {byHand}
    </div>
  );
}
