"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/dictionaries";
import { formatDateTime } from "@/lib/format";
import {
  compress,
  folderPickerSupported,
  newestStockFile,
  pickFolder,
  storeDelete,
  storeGet,
  storeSet,
  type FolderHandle,
} from "@/lib/folderStore";
import type { FreshnessState } from "@/lib/stock";
import { createClient } from "@/lib/supabase/client";
import { supabaseEnv } from "@/lib/supabase/env";

const CHECK_EVERY_MS = 15 * 60_000;
/** A file must be untouched this long before it is sent, so a half-written export is never sent. */
const SETTLE_MS = 60_000;
const RECHECK_SOON_MS = 60_000;
const TICK_MS = 20_000;

type Outcome =
  | { status: "updated"; items: number; zeroed: number; skipped: number }
  | { status: "unchanged" }
  | { status: "proposed" | "waiting_for_approval" | "layout_changed"; rows: number }
  | { status: "error"; error: string };

/** public.upload_check_in() */
interface ServerStatus {
  latest_file_time: string | null;
  mapping_status: "proposed" | "confirmed";
  freshness_state: FreshnessState;
}

/** The last file sent for this shop, so an unchanged situation is not sent again every 15 minutes. */
interface Attempt {
  name: string;
  lastModified: number;
  size: number;
  mappingStatus: string;
  result: Outcome;
}

type Phase = "starting" | "other_window" | "signed_out" | "no_folder" | "needs_permission" | "watching";

export type FolderSyncLabels = Dictionary["sync"] & {
  latest_file: string;
  never: string;
  state_current: string;
  state_recent: string;
  state_stale: string;
};

function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`));
}

const noSubscription = () => () => undefined;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Watches the folder the shop's stock software exports to (picked once, remembered
 * in the browser) and sends the newest stock file to the stock-pull function every
 * 15 minutes while the page is open. Edge and Chrome on a computer only.
 */
export function FolderSync({
  shopId,
  shopName,
  showName,
  lang,
  timeZone,
  loginHref,
  labels,
}: {
  shopId: string;
  shopName: string;
  showName: boolean;
  lang: Locale;
  timeZone: string;
  loginHref: string;
  labels: FolderSyncLabels;
}) {
  // Rendered on the server as "supported"; Firefox/Safari switch to the message right after loading.
  const supported = useSyncExternalStore(noSubscription, folderPickerSupported, () => true);
  const [phase, setPhase] = useState<Phase>("starting");
  const [folderName, setFolderName] = useState<string | null>(null);
  const [newest, setNewest] = useState<{ name: string; time: number } | null>(null);
  const [server, setServer] = useState<ServerStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lastCheck, setLastCheck] = useState<number | null>(null);
  const [nextCheck, setNextCheck] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const running = useRef(false);
  const active = useRef(false); // true while this window holds the lock for this shop
  const nextAt = useRef(0);
  const folderKey = `folder:${shopId}`;
  const attemptKey = `attempt:${shopId}`;

  const schedule = useCallback((ms: number) => {
    nextAt.current = Date.now() + ms;
    setNextCheck(nextAt.current);
  }, []);

  const resultText = useCallback(
    (result: Outcome): string => {
      switch (result.status) {
        case "updated":
          return fill(labels.result_updated, { items: result.items, zeroed: result.zeroed });
        case "unchanged":
          return labels.result_unchanged;
        case "error":
          return fill(labels.result_error, { error: result.error });
        default:
          return fill(labels[`result_${result.status}`], { rows: result.rows });
      }
    },
    [labels],
  );

  const upload = useCallback(
    async (token: string, file: File, data: ArrayBuffer): Promise<Outcome> => {
      const env = supabaseEnv();
      if (!env) throw new Error("Supabase is not configured");
      const { body, gzip } = await compress(data);
      const params = new URLSearchParams({
        shop_id: shopId,
        file_time: new Date(file.lastModified).toISOString(),
        file_name: file.name,
        ...(gzip ? { gzip: "1" } : {}),
      });
      const response = await fetch(`${env.url}/functions/v1/stock-pull?${params}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, apikey: env.key, "Content-Type": "application/octet-stream" },
        body,
      });
      const json = (await response.json().catch(() => null)) as { result?: Outcome; error?: string; message?: string } | null;
      if (!response.ok || !json?.result) throw new Error(json?.error ?? json?.message ?? `HTTP ${response.status}`);
      return json.result;
    },
    [shopId],
  );

  const check = useCallback(async () => {
    if (running.current || !active.current) return;
    running.current = true;
    setBusy(true);
    try {
      const supabase = createClient();
      const checkIn = async () => {
        const { data, error } = await supabase.rpc("upload_check_in", { p_shop_id: shopId });
        if (error) throw new Error(error.message);
        return data as ServerStatus;
      };

      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        setPhase("signed_out");
        schedule(CHECK_EVERY_MS);
        return;
      }
      const folder = await storeGet<FolderHandle>(folderKey);
      if (!folder) {
        setFolderName(null);
        setPhase("no_folder");
        schedule(CHECK_EVERY_MS);
        return;
      }
      setFolderName(folder.name);
      if ((await folder.queryPermission({ mode: "read" })) !== "granted") {
        setPhase("needs_permission");
        schedule(CHECK_EVERY_MS);
        return;
      }
      setPhase("watching");
      // Tells PPI this window is watching the folder; returns what was applied last.
      const status = await checkIn();
      setServer(status);

      const found = await newestStockFile(folder);
      if (!found) {
        setNewest(null);
        setMessage(labels.no_file);
        schedule(CHECK_EVERY_MS);
        return;
      }
      const { file } = found;
      setNewest({ name: file.name, time: file.lastModified });
      if (Date.now() - file.lastModified < SETTLE_MS) {
        setMessage(labels.settling);
        schedule(RECHECK_SOON_MS);
        return;
      }
      const applied = status.latest_file_time ? Date.parse(status.latest_file_time) : 0;
      if (file.lastModified <= applied) {
        setMessage(labels.up_to_date);
        schedule(CHECK_EVERY_MS);
        return;
      }
      // Already sent and nothing changed on PPI's side (e.g. still waiting for the owner to approve the columns).
      const previous = await storeGet<Attempt>(attemptKey);
      if (
        previous &&
        previous.name === file.name &&
        previous.lastModified === file.lastModified &&
        previous.size === file.size &&
        previous.mappingStatus === status.mapping_status
      ) {
        setMessage(resultText(previous.result));
        schedule(CHECK_EVERY_MS);
        return;
      }

      const data = await file.arrayBuffer();
      const again = await found.handle.getFile();
      if (again.lastModified !== file.lastModified || again.size !== file.size) {
        setMessage(labels.settling); // the stock software wrote it again while we read it
        schedule(RECHECK_SOON_MS);
        return;
      }
      const result = await upload(session.access_token, file, data);
      const after = await checkIn();
      setServer(after);
      await storeSet(attemptKey, {
        name: file.name,
        lastModified: file.lastModified,
        size: file.size,
        mappingStatus: after.mapping_status,
        result,
      } satisfies Attempt);
      setMessage(resultText(result));
      schedule(CHECK_EVERY_MS);
    } catch (e) {
      setMessage(fill(labels.send_failed, { error: errorText(e) }));
      schedule(CHECK_EVERY_MS);
    } finally {
      running.current = false;
      setBusy(false);
      setLastCheck(Date.now());
    }
  }, [attemptKey, folderKey, labels, resultText, schedule, shopId, upload]);

  const checkRef = useRef(check);
  useEffect(() => {
    checkRef.current = check;
  }, [check]);

  // One window per shop: a second window (or tab) waits and takes over when the first closes.
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
    const name = `ppi-folder-${shopId}`;
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

  // The 15-minute rhythm (checked often, so a sleeping/throttled tab catches up quickly).
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
      const folder = await pickFolder();
      await storeSet(folderKey, folder);
      await storeDelete(attemptKey);
      setFolderName(folder.name);
      setNewest(null);
      setMessage(null);
      await check();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return; // closed the picker
      setMessage(fill(labels.picker_failed, { error: errorText(e) }));
    }
  }

  /** "Upload file": send one stock file by hand (any browser, no folder needed). */
  async function uploadChosenFile(event: React.ChangeEvent<HTMLInputElement>) {
    const field = event.currentTarget;
    const file = field.files?.[0];
    field.value = "";
    if (!file || running.current) return;
    running.current = true;
    setBusy(true);
    setUploadingFile(true);
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        setPhase("signed_out");
        return;
      }
      const result = await upload(session.access_token, file, await file.arrayBuffer());
      const { data: after } = await supabase.rpc("upload_check_in", { p_shop_id: shopId });
      if (after) setServer(after as ServerStatus);
      setNewest({ name: file.name, time: file.lastModified });
      setMessage(resultText(result));
    } catch (e) {
      setMessage(fill(labels.send_failed, { error: errorText(e) }));
    } finally {
      running.current = false;
      setBusy(false);
      setUploadingFile(false);
      setLastCheck(Date.now());
    }
  }

  async function allow() {
    const folder = await storeGet<FolderHandle>(folderKey);
    if (folder && (await folder.requestPermission({ mode: "read" })) === "granted") await check();
  }

  async function disconnect() {
    await storeDelete(folderKey);
    await storeDelete(attemptKey);
    setFolderName(null);
    setNewest(null);
    setMessage(null);
    setPhase("no_folder");
  }

  const when = (ms: number) => formatDateTime(new Date(ms), lang, timeZone);
  const stateLabel = server ? labels[`state_${server.freshness_state}`] : null;
  const button = "self-start rounded border px-4 py-2";
  const uploadButton = (
    <>
      <input
        ref={fileInput}
        type="file"
        accept=".csv,.txt,.xml,.xlsx,text/csv,application/xml,text/xml,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={uploadChosenFile}
        className="sr-only"
        tabIndex={-1}
      />
      <button type="button" onClick={() => fileInput.current?.click()} disabled={busy} className={`${button} border-foreground font-medium`}>
        {uploadingFile ? labels.uploading_file : labels.upload_file}
      </button>
    </>
  );

  if (!supported) {
    return (
      <section className="flex flex-col gap-2 border border-foreground p-4">
        {showName && <h2 className="text-lg font-semibold">{shopName}</h2>}
        <p className="font-semibold">{labels.unsupported}</p>
        {uploadButton}
        {message && (
          <p className="font-semibold" role="status">
            {message}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4 border border-line p-4" aria-busy={busy}>
      {showName && <h2 className="text-lg font-semibold">{shopName}</h2>}

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
        <dd className="font-semibold">{folderName ?? labels.not_connected}</dd>
        <dt className="text-muted">{labels.newest_file}</dt>
        <dd>{newest ? `${newest.name} · ${when(newest.time)}` : "–"}</dd>
        <dt className="text-muted">{labels.stock_state}</dt>
        <dd>
          {stateLabel ? <span className="font-semibold">{stateLabel}</span> : "–"}
          {server && (
            <>
              {" · "}
              {labels.latest_file}:{" "}
              {server.latest_file_time ? formatDateTime(server.latest_file_time, lang, timeZone) : labels.never}
            </>
          )}
        </dd>
        <dt className="text-muted">{labels.last_check}</dt>
        <dd>{busy ? labels.checking : lastCheck ? when(lastCheck) : "–"}</dd>
        <dt className="text-muted">{labels.next_check}</dt>
        <dd>{nextCheck && phase === "watching" && !busy ? when(nextCheck) : "–"}</dd>
        <dt className="text-muted">{labels.result}</dt>
        <dd className="font-semibold" role="status">
          {message ?? "–"}
        </dd>
      </dl>

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
            <>
              <button type="button" onClick={connect} className={`${button} border-foreground font-medium`}>
                {labels.connect}
              </button>
              {uploadButton}
            </>
          ) : (
            <>
              {phase === "watching" && (
                <button type="button" onClick={() => void check()} disabled={busy} className={`${button} border-foreground font-medium`}>
                  {labels.check_now}
                </button>
              )}
              {uploadButton}
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
  );
}
