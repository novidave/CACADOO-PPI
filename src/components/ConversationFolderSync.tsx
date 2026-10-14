"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Locale } from "@/i18n/config";
import { formatDateTime } from "@/lib/format";
import {
  folderPickerSupported,
  pickWritableFolder,
  storeDelete,
  storeGet,
  storeSet,
  writeNewFile,
  type WritableFolder,
} from "@/lib/folderStore";
import { createClient } from "@/lib/supabase/client";

const CHECK_EVERY_MS = 5 * 60_000;
const TICK_MS = 20_000;
/** At most this many conversations are looked at and saved per check (the rest follow). */
const BATCH = 50;
/** An ended conversation whose PDF is still being made is waited for this long. */
const PDF_WAIT_MS = 60 * 60_000;
/**
 * Each check also looks this far back before where saving got to: a conversation that ends by
 * itself after 30 idle minutes gets the time of its last message as its end (up to ~35 minutes
 * earlier). What was saved in that time is skipped (remembered by id).
 */
const LOOK_BACK_MS = 45 * 60_000;
/** At most this many remembered ids are sent along to be left out of the list. */
const MAX_SKIP_IDS = 300;

/** What this computer remembers per shop (IndexedDB, never sent anywhere). */
interface Saved {
  folder: WritableFolder;
  /** Conversations that ended after this time are saved (null: every one still kept). */
  since: string | null;
  /** Everything up to here is done; ids done after it minus the look-back (their end time), so nothing is saved twice. */
  cursor: string | null;
  done: Record<string, string>;
  count: number;
}

interface Row {
  id: string;
  ended_at: string;
  pdf_status: "none" | "ready" | "failed";
  pdf_name: string | null;
}

type Phase = "starting" | "other_window" | "signed_out" | "no_folder" | "needs_permission" | "watching";

export interface ConversationFolderLabels {
  folder: string;
  not_connected: string;
  connect: string;
  change: string;
  stop: string;
  allow: string;
  allow_hint: string;
  older: string;
  older_done: string;
  since: string;
  since_all: string;
  saved_count: string;
  last_check: string;
  next_check: string;
  checking: string;
  check_now: string;
  result: string;
  result_saved: string;
  result_none: string;
  result_waiting: string;
  result_error: string;
  picker_failed: string;
  other_window: string;
  signed_out: string;
  sign_in: string;
  unsupported: string;
  layout: string;
}

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`));
const noSubscription = () => () => undefined;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const PDF_NAME = /^(\d{4}-\d{2})-\d{2}_\d{2}-\d{2}_[0-9a-f]{8}\.pdf$/;

/**
 * "Konverzácie do počítača" on the shop PC's PPI window: every finished conversation of the
 * shop's assistant is saved as its PDF (with the shopper's pictures) into a folder the owner
 * picked, <folder>/<YYYY-MM>/<YYYY-MM-DD_HH-MM_id>.pdf, every 5 minutes while the page is open.
 * Nothing is ever replaced or deleted there; what was saved is remembered in this browser, so a
 * PDF moved away is not saved again. The PDFs come from /api/owner/conversations/pdf (10-minute
 * addresses; the archive function checks the owner's login). Edge and Chrome on a computer.
 */
export function ConversationFolderSync({
  shopId,
  lang,
  timeZone,
  loginHref,
  labels,
}: {
  shopId: string;
  lang: Locale;
  timeZone: string;
  loginHref: string;
  labels: ConversationFolderLabels;
}) {
  const supported = useSyncExternalStore(noSubscription, folderPickerSupported, () => true);
  const [phase, setPhase] = useState<Phase>("starting");
  const [state, setState] = useState<Omit<Saved, "folder" | "done"> & { folderName: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lastCheck, setLastCheck] = useState<number | null>(null);
  const [nextCheck, setNextCheck] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const active = useRef(false);
  const nextAt = useRef(0);
  const key = `conversations:${shopId}`;

  const schedule = useCallback((ms: number) => {
    nextAt.current = Date.now() + ms;
    setNextCheck(nextAt.current);
  }, []);

  const show = useCallback((saved: Saved | undefined) => {
    setState(saved ? { folderName: saved.folder.name, since: saved.since, cursor: saved.cursor, count: saved.count } : null);
  }, []);

  const check = useCallback(async () => {
    if (running.current || !active.current) return;
    running.current = true;
    setBusy(true);
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        setPhase("signed_out");
        schedule(CHECK_EVERY_MS);
        return;
      }
      const saved = await storeGet<Saved>(key);
      show(saved);
      if (!saved) {
        setPhase("no_folder");
        schedule(CHECK_EVERY_MS);
        return;
      }
      if ((await saved.folder.queryPermission({ mode: "readwrite" })) !== "granted") {
        setPhase("needs_permission");
        schedule(CHECK_EVERY_MS);
        return;
      }
      setPhase("watching");

      // The shop's ended conversations after the cursor, oldest first (RLS: the owner's own shop).
      const lower = saved.cursor
        ? new Date(Date.parse(saved.cursor) - LOOK_BACK_MS).toISOString()
        : (saved.since ?? "1970-01-01T00:00:00Z");
      const skip = Object.keys(saved.done).slice(-MAX_SKIP_IDS);
      const base = supabase
        .from("assistant_conversations")
        .select("id, ended_at, pdf_status, pdf_name")
        .eq("shop_id", shopId)
        .not("ended_at", "is", null)
        .gt("message_count", 0)
        .gte("ended_at", lower);
      const { data, error } = await (skip.length ? base.not("id", "in", `(${skip.join(",")})`) : base)
        .order("ended_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(BATCH);
      if (error) throw new Error(error.message);
      const rows = ((data ?? []) as Row[]).filter((r) => !saved.done[r.id]);

      const ready = rows.filter((r) => r.pdf_status === "ready" && r.pdf_name && PDF_NAME.test(r.pdf_name));
      const links = new Map<string, string>();
      if (ready.length) {
        const res = await fetch("/api/owner/conversations/pdf", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: ready.map((r) => r.id) }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const answer = (await res.json()) as { files?: { id: string; url: string }[] };
        for (const f of answer.files ?? []) links.set(f.id, f.url);
      }

      // In order: a conversation still waiting for its PDF (or one that failed to save) holds
      // the cursor; everything before it is done.
      let newSaved = 0;
      let waiting = 0;
      let failed: string | null = null;
      let cursor = saved.cursor;
      let held = false;
      const done = { ...saved.done };
      for (const row of rows) {
        const ended = Date.parse(row.ended_at);
        let finished = false;
        if (row.pdf_status === "ready" && row.pdf_name && links.has(row.id)) {
          try {
            const pdf = await fetch(links.get(row.id)!);
            if (!pdf.ok) throw new Error(`HTTP ${pdf.status}`);
            const blob = await pdf.blob();
            if (await writeNewFile(saved.folder, PDF_NAME.exec(row.pdf_name)![1], row.pdf_name, blob)) newSaved++;
            finished = true;
          } catch (e) {
            failed = errorText(e);
          }
        } else if (row.pdf_status === "none" && Date.now() - ended < PDF_WAIT_MS) {
          waiting++;
        } else {
          finished = true; // no PDF and none coming (failed, or deleted by the shopper)
        }
        if (finished) done[row.id] = row.ended_at;
        if (!finished) held = true;
        if (!held && (!cursor || Date.parse(row.ended_at) > Date.parse(cursor))) cursor = row.ended_at;
      }
      // Ids before the next query's start are not needed any more.
      const forget = cursor ? Date.parse(cursor) - LOOK_BACK_MS : null;
      for (const [id, endedAt] of Object.entries(done)) if (forget !== null && Date.parse(endedAt) < forget) delete done[id];
      const next: Saved = { ...saved, cursor, done, count: saved.count + newSaved };
      await storeSet(key, next);
      show(next);

      if (failed) setMessage(fill(labels.result_error, { error: failed }));
      else if (newSaved) setMessage(fill(labels.result_saved, { n: newSaved }));
      else if (waiting) setMessage(labels.result_waiting);
      else setMessage(labels.result_none);
      // More than one batch waiting (e.g. "Uložiť aj staršie"): the next one right away.
      schedule((data ?? []).length === BATCH && !failed ? 1_000 : CHECK_EVERY_MS);
    } catch (e) {
      setMessage(fill(labels.result_error, { error: errorText(e) }));
      schedule(CHECK_EVERY_MS);
    } finally {
      running.current = false;
      setBusy(false);
      setLastCheck(Date.now());
    }
  }, [key, labels, schedule, shopId, show]);

  const checkRef = useRef(check);
  useEffect(() => {
    checkRef.current = check;
  }, [check]);

  // One window per shop saves (a second one waits and takes over when the first closes).
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
    const name = `ppi-conversations-${shopId}`;
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

  useEffect(() => {
    const tick = () => {
      if (active.current && Date.now() >= nextAt.current) void checkRef.current();
    };
    const id = window.setInterval(tick, TICK_MS);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("online", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("online", tick);
    };
  }, []);

  async function connect() {
    try {
      const folder = await pickWritableFolder();
      const before = await storeGet<Saved>(key);
      // From now on (looking back as far as a check does, so a conversation going on now is
      // saved however it ends); a folder changed later keeps where saving got to.
      await storeSet(key, {
        folder,
        since: before?.since ?? new Date(Date.now() - LOOK_BACK_MS).toISOString(),
        cursor: before?.cursor ?? null,
        done: before?.done ?? {},
        count: before?.count ?? 0,
      } satisfies Saved);
      setMessage(null);
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

  /** "Uložiť aj staršie konverzácie": every conversation still kept; files already there stay. */
  async function older() {
    const saved = await storeGet<Saved>(key);
    if (!saved) return;
    await storeSet(key, { ...saved, since: null, cursor: null });
    setMessage(labels.older_done);
    nextAt.current = 0;
    await check();
  }

  async function stop() {
    await storeDelete(key);
    setState(null);
    setMessage(null);
    setPhase("no_folder");
  }

  const when = (ms: number | string) => formatDateTime(new Date(ms), lang, timeZone);
  const button = "self-start rounded border px-4 py-2";

  if (!supported) {
    return (
      <p className="border border-foreground p-4 font-semibold" data-conversation-folder="unsupported">
        {labels.unsupported}
      </p>
    );
  }

  return (
    <section className="flex flex-col gap-4 border border-line p-4" aria-busy={busy} data-conversation-folder={phase}>
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
        <dd className="font-semibold" data-conversation-folder-name>
          {state?.folderName ?? labels.not_connected}
        </dd>
        {state && (
          <>
            <dt className="text-muted">{labels.saved_count}</dt>
            <dd data-conversation-folder-count>{state.count}</dd>
          </>
        )}
        <dt className="text-muted">{labels.last_check}</dt>
        <dd>{busy ? labels.checking : lastCheck ? when(lastCheck) : "–"}</dd>
        <dt className="text-muted">{labels.next_check}</dt>
        <dd>{nextCheck && phase === "watching" && !busy ? when(nextCheck) : "–"}</dd>
        <dt className="text-muted">{labels.result}</dt>
        <dd className="font-semibold" role="status" data-conversation-folder-result>
          {message ?? "–"}
        </dd>
      </dl>
      {state && (
        <p className="text-sm text-muted" data-conversation-folder-since>
          {state.since ? fill(labels.since, { when: when(state.since) }) : labels.since_all} {labels.layout}
        </p>
      )}

      {phase === "needs_permission" && (
        <div className="flex flex-col gap-2">
          <button type="button" onClick={allow} className={`${button} border-foreground font-medium`} data-conversation-folder-allow>
            {labels.allow}
          </button>
          <p className="text-sm text-muted">{labels.allow_hint}</p>
        </div>
      )}

      {phase !== "other_window" && phase !== "signed_out" && phase !== "starting" && (
        <div className="flex flex-wrap gap-2">
          {phase === "no_folder" ? (
            <button type="button" onClick={connect} className={`${button} border-foreground font-medium`} data-conversation-folder-connect>
              {labels.connect}
            </button>
          ) : (
            <>
              {phase === "watching" && (
                <button type="button" onClick={() => void check()} disabled={busy} className={`${button} border-foreground font-medium`}>
                  {labels.check_now}
                </button>
              )}
              {phase === "watching" && state?.since && (
                <button type="button" onClick={older} disabled={busy} className={`${button} border-line`} data-conversation-folder-older>
                  {labels.older}
                </button>
              )}
              <button type="button" onClick={connect} className={`${button} border-line`}>
                {labels.change}
              </button>
              <button type="button" onClick={stop} className={`${button} border-line`} data-conversation-folder-stop>
                {labels.stop}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
