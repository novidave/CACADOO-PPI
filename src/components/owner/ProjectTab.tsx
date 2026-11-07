"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import { folderPickerSupported, storeDelete, storeGet, storeSet, type FolderHandle } from "@/lib/folderStore";
import { functionFailure } from "@/lib/functionError";
import { KB_EVERY_MS, kbAction, planCheck, projectFileKind, type KbEntry, type KbKnown, type KbSeen } from "@/lib/kbFolder";
import { openPdf, readText } from "@/lib/pdfRead";
import { createClient } from "@/lib/supabase/client";
import { shrinkPicture } from "@/components/DocUpload";
import { buttonClass, cardClass, fieldClass, ghostClass } from "@/components/owner/ui";

type Labels = Dictionary["project"];

export interface ProjectDoc {
  id: string;
  kind: "pdf" | "picture" | "text";
  name: string;
  hash: string;
  bytes: number;
  pages: number;
  status: "uploading" | "ready" | "error";
  missing_since: string | null;
}

export interface ProjectState {
  contact_id: string;
  shop_id: string;
  has_phone: boolean;
  verified: boolean;
  phone_masked: string | null;
  plan: boolean;
  limits: { files: number; bytes: number };
  project: null | {
    id: string;
    status_text: string | null;
    enabled: boolean;
    folder_linked_at: string | null;
    synced_at: string | null;
    files: number;
    bytes: number;
    sessions_open: number;
    docs: ProjectDoc[];
  };
}

interface Saved {
  folder: FolderHandle & { isSameEntry(other: unknown): Promise<boolean> };
  seen: Record<string, KbSeen>;
}

type Picker = Window & { showDirectoryPicker?: (o?: { id?: string; mode?: "read"; startIn?: string }) => Promise<Saved["folder"]> };

const TICK_MS = 30_000;
const noSubscribe = () => () => {};
const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? `{${k}}`));

async function sha256(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A doc-ingest answer, or its reason (thrown as an Error whose message is the reason code). */
async function call<T>(supabase: ReturnType<typeof createClient>, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>("doc-ingest", { body });
  if (!error) return data as T;
  const failure = await functionFailure(error);
  throw new Error(failure.error ?? failure.detail);
}

/** The file's text as written (a PDF page by page, a text note as one page; a picture has none). */
async function textOf(file: File, kind: "pdf" | "picture" | "text"): Promise<{ pages: number; text: { page: number; text: string }[] }> {
  if (kind === "text") return { pages: 1, text: [{ page: 1, text: (await file.text()).slice(0, 1_000_000) }] };
  if (kind === "picture") return { pages: 0, text: [] };
  const { doc, close } = await openPdf(file);
  try {
    const text: { page: number; text: string }[] = [];
    for (let page = 1; page <= doc.numPages; page++) text.push({ page, text: await readText(doc, page) });
    return { pages: doc.numPages, text };
  } finally {
    await close().catch(() => {});
  }
}

/**
 * CRM → a contact → "Projekt" (update 95): a verified customer's own project. Before the number is checked: the line
 * and "Poslať zákazníkovi overovací kód" (the code goes only into the SMS; the owner types what the customer reads
 * out). Then: "Stav projektu", the switch "Zákazník sa môže pýtať asistenta na svoj projekt" (off by default), a
 * folder on the shop's PC (Edge / Chrome, read only; checked on start, every 15 minutes, on "Skontrolovať teraz" and
 * when the tab is shown; one window per contact: Web Locks) whose PDFs, pictures and text notes go to the private
 * bucket (≤ 200 files, 50 MB), and the files with "Odstrániť" (after a confirmation). Nothing is written to the PC.
 */
export function ProjectTab({ initial, lang, labels }: { initial: ProjectState; lang: string; labels: Labels }) {
  const router = useRouter();
  const [state, setState] = useState<ProjectState>(initial);
  const contactId = state.contact_id;
  const shopId = state.shop_id;
  const key = `projfolder:${shopId}:${contactId}`;
  const project = state.project;
  const supported = useSyncExternalStore(noSubscribe, folderPickerSupported, () => true);
  const [message, setMessage] = useState<string | null>(null);
  const [code, setCode] = useState<{ id: string; phone: string; test?: string } | null>(null);
  const [status, setStatus] = useState(project?.status_text ?? "");
  const [saved, setSaved] = useState(false);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [needsPermission, setNeedsPermission] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [notes, setNotes] = useState<{ unsupported: string[]; waiting: string[] }>({ unsupported: [], waiting: [] });
  const [otherWindow, setOtherWindow] = useState(false);
  const [confirm, setConfirm] = useState<ProjectDoc | null>(null);
  const active = useRef(false);
  const running = useRef(false);
  const nextAt = useRef(0);

  const failText = useCallback(
    (reason: string) => (labels as Record<string, string>)[`err_${reason}`] ?? fill(labels.error, { message: reason }),
    [labels],
  );

  const reload = useCallback(async (): Promise<ProjectState | null> => {
    const { data, error } = await createClient().rpc("owner_project", { p_contact_id: contactId });
    if (error || !data) return null;
    setState(data as ProjectState);
    return data as ProjectState;
  }, [contactId]);

  async function rpc(name: string, args: Record<string, unknown>) {
    setMessage(null);
    const { data, error } = await createClient().rpc(name, args);
    if (error) {
      setMessage(failText(error.message));
      return null;
    }
    if (data && typeof data === "object" && "contact_id" in (data as object)) setState(data as ProjectState);
    return data;
  }

  // ---------------------------------------------------------------- the number's check

  async function sendCode() {
    setMessage(null);
    const { data, error } = await createClient().functions.invoke<{ id: string; phone: string; test_code?: string }>("bookings", {
      body: { action: "contact_verify_code", contact_id: contactId, lang },
    });
    if (error || !data) {
      const failure = await functionFailure(error);
      setMessage(failText(failure.error ?? "failed"));
      return;
    }
    setCode({ id: data.id, phone: data.phone, test: data.test_code });
  }

  async function checkCode(form: FormData) {
    if (!code) return;
    const result = (await rpc("owner_contact_verify", {
      p_contact_id: contactId,
      p_code_id: code.id,
      p_code: String(form.get("code") ?? "").replace(/\s/g, ""),
    })) as { ok: boolean; reason?: string; attempts_left?: number } | null;
    if (!result) return;
    if (!result.ok) {
      setMessage(result.reason === "wrong_code" ? fill(labels.code_wrong, { n: result.attempts_left ?? 0 }) : failText(`code_${result.reason}`));
      if (result.reason !== "wrong_code") setCode(null);
      return;
    }
    setCode(null);
    await reload();
    router.refresh();
  }

  // ---------------------------------------------------------------- the PC folder

  const check = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    nextAt.current = Date.now() + KB_EVERY_MS;
    const supabase = createClient();
    const failed: string[] = [];
    let changed = 0;
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
      const known: KbKnown[] = (current.project?.docs ?? []).map((d) => ({
        kind: "document",
        id: d.id,
        name: d.name,
        hash: d.hash,
        // a file whose upload stopped halfway is read again
        status: d.status === "ready" ? "ready" : "error",
      }));
      const handles = new Map<string, { getFile(): Promise<File> }>();
      const entries: KbEntry[] = [];
      for await (const entry of saved.folder.values()) {
        if (entry.kind !== "file" || projectFileKind(entry.name) === undefined) continue;
        try {
          const file = await entry.getFile();
          handles.set(entry.name, entry);
          entries.push({ name: entry.name, size: file.size, mtime: file.lastModified });
        } catch {
          // a file locked by another program: next time
        }
      }
      const settle = (window as { __ppiKbSettleMs?: number }).__ppiKbSettleMs;
      const plan = planCheck(entries, saved.seen ?? {}, Date.now(), typeof settle === "number" ? settle : undefined, projectFileKind);
      setNotes({ unsupported: plan.unsupported, waiting: plan.waiting });
      const seen: Record<string, KbSeen> = {};
      for (const u of plan.unchanged) seen[u.name] = saved.seen[u.name];
      const todo: { name: string; hash: string; file: File | null }[] = plan.unchanged.map((u) => ({ ...u, file: null }));
      for (const name of plan.read) {
        try {
          const file = await handles.get(name)!.getFile();
          const hash = await sha256(file);
          seen[name] = { size: file.size, mtime: file.lastModified, hash };
          todo.push({ name, hash, file });
        } catch (e) {
          failed.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      for (const item of todo) {
        const decision = kbAction(item.name, item.hash, known);
        if (decision.action === "same") continue;
        const file = item.file ?? (await handles.get(item.name)?.getFile().catch(() => null)) ?? null;
        const kind = projectFileKind(item.name);
        if (!file || !kind) continue;
        setBusy(fill(labels.uploading, { name: item.name }));
        let newId: string | null = null;
        try {
          const blob = kind === "picture" ? await shrinkPicture(file) : file;
          const text = await textOf(file, kind);
          const reg = await call<{ doc_id: string; path: string; token: string }>(supabase, {
            action: "project_register",
            contact_id: contactId,
            kind,
            name: item.name,
            hash: item.hash,
            bytes: blob.size,
            pages: text.pages,
          });
          newId = reg.doc_id;
          const contentType = kind === "pdf" ? "application/pdf" : kind === "text" ? "text/plain; charset=utf-8" : blob.type || "image/jpeg";
          const up = await supabase.storage.from("contact-docs").uploadToSignedUrl(reg.path, reg.token, blob, { contentType });
          if (up.error) throw new Error(up.error.message);
          await call(supabase, { action: "project_text", doc_id: reg.doc_id, pages: text.text });
          changed++;
          // the old version of the same file goes only after the new one is in
          for (const old of decision.old) await call(supabase, { action: "project_delete", doc_id: old.id, reason: "replaced" });
        } catch (e) {
          delete seen[item.name];
          if (newId) await call(supabase, { action: "project_delete", doc_id: newId, reason: "replaced" }).catch(() => {});
          const reason = e instanceof Error ? e.message : String(e);
          failed.push(`${item.name}: ${(labels as Record<string, string>)[`err_${reason}`] ?? reason}`);
        }
      }
      await storeSet(key, { folder: saved.folder, seen } satisfies Saved);
      const { data, error } = await supabase.rpc("owner_project_synced", {
        p_contact_id: contactId,
        p_present: plan.present,
        p_files: plan.present.length,
        p_changed: changed,
      });
      if (error) throw new Error(error.message);
      setState(data as ProjectState);
      setMessage(null);
    } catch (e) {
      setMessage(fill(labels.error, { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setProblems(failed);
      setBusy(null);
      running.current = false;
    }
  }, [contactId, key, labels, reload, state]);

  const checkRef = useRef(check);
  useEffect(() => {
    checkRef.current = check;
  }, [check]);

  const linked = Boolean(project?.folder_linked_at);
  useEffect(() => {
    if (!linked) return;
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
      const name = `ppi-proj-${shopId}-${contactId}`;
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
  }, [contactId, key, linked, shopId]);

  async function link() {
    setMessage(null);
    const picker = (window as Picker).showDirectoryPicker;
    if (!picker) return;
    let folder: Saved["folder"];
    try {
      folder = await picker.call(window, { id: "ppi-project", mode: "read", startIn: "documents" });
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
    if (!(await rpc("owner_project_link", { p_contact_id: contactId, p_linked: true }))) return;
    await storeSet(key, { folder, seen: {} } satisfies Saved);
    setFolderName(folder.name);
    active.current = true;
    await check();
  }

  async function unlink() {
    if (!(await rpc("owner_project_link", { p_contact_id: contactId, p_linked: false }))) return;
    await storeDelete(key);
    active.current = false;
    setFolderName(null);
    setProblems([]);
    setNotes({ unsupported: [], waiting: [] });
  }

  async function allow() {
    const s = await storeGet<Saved>(key);
    if (s && (await s.folder.requestPermission({ mode: "read" })) === "granted") {
      setNeedsPermission(false);
      await check();
    }
  }

  async function remove(doc: ProjectDoc) {
    setConfirm(null);
    try {
      await call(createClient(), { action: "project_delete", doc_id: doc.id, reason: "owner" });
    } catch (e) {
      setMessage(fill(labels.error, { message: e instanceof Error ? e.message : String(e) }));
    }
    await reload();
  }

  // ---------------------------------------------------------------- what the tab shows

  if (!state.verified) {
    return (
      <section className="flex flex-col gap-3 text-sm" data-tab-panel="project" data-project-unverified>
        <p>{labels.not_verified}</p>
        {!state.has_phone ? (
          <p className="text-muted">{labels.no_phone}</p>
        ) : !state.plan ? (
          <p className="border border-line p-3">{labels.needs_plan}</p>
        ) : code ? (
          <form action={checkCode} className="flex flex-col gap-2" data-project-code-form>
            <p>{fill(labels.code_sent, { phone: code.phone })}</p>
            {code.test && <p className="font-mono" data-project-test-code>{fill(labels.test_code, { code: code.test })}</p>}
            <label className="flex flex-col gap-1">
              <span className="font-medium">{labels.code_label}</span>
              <input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={8} required className={`${fieldClass} max-w-48`} />
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={buttonClass} data-project-code-check>{labels.code_check}</button>
              <button type="button" onClick={() => void sendCode()} className={ghostClass}>{labels.send_again}</button>
            </div>
          </form>
        ) : (
          <div>
            <button type="button" onClick={() => void sendCode()} className={ghostClass} data-project-send-code>
              {labels.send_code}
            </button>
          </div>
        )}
        {message && <p role="alert" className="text-[#B91C1C]">{message}</p>}
      </section>
    );
  }

  const docs = project?.docs ?? [];
  const missing = docs.filter((d) => d.missing_since);
  const mb = ((project?.bytes ?? 0) / 1_048_576).toLocaleString(lang, { maximumFractionDigits: 1 });
  const time = project?.synced_at ? new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit" }).format(new Date(project.synced_at)) : null;
  const here = Boolean(folderName);

  return (
    <section className="flex flex-col gap-4 text-sm" data-tab-panel="project">
      <p className="text-muted">{labels.intro}</p>
      {!state.plan && <p className="border border-line p-3">{labels.needs_plan}</p>}

      <form
        className={cardClass}
        action={async () => {
          setSaved(false);
          if (await rpc("owner_project_save", { p_contact_id: contactId, p_status_text: status })) setSaved(true);
        }}
        data-project-status-form
      >
        <label className="flex flex-col gap-1">
          <span className="text-base font-semibold">{labels.status_title}</span>
          <span className="text-muted">{labels.status_hint}</span>
          <textarea
            name="status"
            value={status}
            maxLength={1000}
            rows={4}
            onChange={(e) => {
              setStatus(e.currentTarget.value);
              setSaved(false);
            }}
            className={`${fieldClass} h-auto py-3 leading-snug`}
            disabled={!state.plan}
            data-project-status
          />
        </label>
        <div className="flex items-center gap-3">
          <button type="submit" className={buttonClass} disabled={!state.plan}>{labels.save}</button>
          {saved && <span role="status">{labels.saved}</span>}
        </div>
      </form>

      <div className={cardClass}>
        <label className="flex min-h-14 items-center justify-between gap-3 text-base font-semibold">
          <span className="flex flex-col">
            {labels.enabled}
            <span className="text-[13px] font-medium text-[#5C5C5C]">{labels.enabled_hint}</span>
          </span>
          <input
            type="checkbox"
            className="ppi-toggle"
            checked={Boolean(project?.enabled)}
            disabled={!state.plan}
            onChange={(e) => void rpc("owner_project_toggle", { p_contact_id: contactId, p_enabled: e.currentTarget.checked })}
            data-project-enabled
          />
        </label>
        {(project?.sessions_open ?? 0) > 0 && <p className="text-muted" data-project-open>{labels.sessions_open}</p>}
      </div>

      <div className={cardClass} data-project-folder>
        <h3 className="text-base font-semibold">{labels.folder_title}</h3>
        {!supported ? (
          <p className="text-muted">{labels.unsupported_browser}</p>
        ) : !linked ? (
          <div>
            <button type="button" onClick={() => void link()} className={ghostClass} disabled={!state.plan} data-project-link>
              {labels.link}
            </button>
          </div>
        ) : (
          <>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {here && <span className="font-medium">{fill(labels.folder, { name: folderName ?? "" })}</span>}
              <span className="text-muted" aria-live="polite" data-project-sync>
                {busy ?? (time ? fill(labels.synced, { time, n: project?.files ?? 0 }) : labels.not_synced)}
              </span>
            </p>
            {!here && <p className="text-muted">{labels.linked_elsewhere}</p>}
            {otherWindow && <p className="text-muted">{labels.other_window}</p>}
            <div className="flex flex-wrap gap-2">
              {here ? (
                needsPermission ? (
                  <button type="button" onClick={() => void allow()} className={ghostClass}>{labels.allow}</button>
                ) : (
                  <button type="button" onClick={() => void check()} disabled={Boolean(busy) || otherWindow} className={ghostClass} data-project-check>
                    {labels.check_now}
                  </button>
                )
              ) : (
                <button type="button" onClick={() => void link()} className={ghostClass}>{labels.link}</button>
              )}
              <button type="button" onClick={() => void unlink()} className={ghostClass} data-project-unlink>{labels.unlink}</button>
            </div>
            {(notes.unsupported.length > 0 || notes.waiting.length > 0) && (
              <ul className="flex flex-col gap-0.5 text-muted">
                {notes.unsupported.map((n) => <li key={`u-${n}`}>{n} · {labels.unsupported}</li>)}
                {notes.waiting.map((n) => <li key={`w-${n}`}>{n} · {labels.waiting}</li>)}
              </ul>
            )}
            {problems.length > 0 && (
              <div data-project-problems>
                <p className="font-medium">{labels.errors_title}</p>
                <ul className="list-disc pl-5">
                  {problems.map((p) => <li key={p}>{p}</li>)}
                </ul>
              </div>
            )}
          </>
        )}
      </div>

      <div className={cardClass} data-project-files>
        <h3 className="text-base font-semibold">{labels.files_title}</h3>
        <p className="text-muted">{fill(labels.files_count, { n: docs.length, mb })}</p>
        {docs.length === 0 ? (
          <p className="text-muted">{labels.files_none}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {docs.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 py-2" data-project-file={d.name}>
                <span className="min-w-0 flex-1 break-all">{d.name}</span>
                {d.missing_since && <span className="rounded-full bg-[#FFF6D6] px-2 py-0.5 text-xs font-semibold">{labels.missing}</span>}
                {d.status !== "ready" && <span className="text-xs text-muted">{labels.not_ready}</span>}
                <button type="button" onClick={() => setConfirm(d)} className="underline underline-offset-4" data-project-remove={d.id}>
                  {labels.remove}
                </button>
              </li>
            ))}
          </ul>
        )}
        {missing.length > 0 && <p className="text-muted">{labels.missing_hint}</p>}
        {confirm && (
          <div className="flex flex-col gap-2 rounded-xl border border-line p-3" role="alertdialog" data-project-confirm>
            <p>{fill(labels.remove_confirm, { name: confirm.name })}</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => void remove(confirm)} className={ghostClass} data-project-confirm-yes>{labels.confirm_yes}</button>
              <button type="button" onClick={() => setConfirm(null)} className={ghostClass}>{labels.cancel}</button>
            </div>
          </div>
        )}
      </div>
      {message && <p role="alert" className="text-[#B91C1C]">{message}</p>}
    </section>
  );
}
