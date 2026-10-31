"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import type { FolderFile, OpenFolder, OpenSession } from "@/lib/docsAccess";
import { KeyForm } from "./KeyForm";

type Labels = Dictionary["chat"];

export interface ViewTarget {
  kind: "document" | "picture";
  id: string;
  name: string;
}

/**
 * "Mám prístupový kľúč" and, once a private folder is open, its files: "Otvoriť" (the viewer,
 * pages with a watermark), "Stiahnuť" and "Stiahnuť celý priečinok (ZIP)" only for files the
 * owner lets shoppers download. The key goes only to the shop's system (never to the AI);
 * the folder stays open for 24 hours, until "Znova zamknúť" or until the page is left.
 * inline: the key field is shown at once (inside the "Mám prístupový kľúč" dropdown).
 */
export function FolderAccess({
  session,
  labels,
  lang,
  timeZone,
  busy,
  problem,
  onUnlock,
  onLock,
  onOpen,
  onDownload,
  onZip,
  inline = false,
}: {
  session: OpenSession | null;
  labels: Labels;
  lang: string;
  timeZone: string;
  busy: boolean;
  problem: string | null;
  onUnlock: (key: string) => Promise<boolean>;
  onLock: () => void;
  onOpen: (file: FolderFile) => void;
  onDownload: (file: FolderFile) => void;
  onZip: (folder: OpenFolder) => void;
  inline?: boolean;
}) {
  const [show, setShow] = useState(inline);
  // "Otvorené" with the vortex's ending for a moment after the right key, then the folder's files.
  const [celebrate, setCelebrate] = useState(false);
  const until = (iso: string) => new Intl.DateTimeFormat(lang, { timeZone, dateStyle: "short", timeStyle: "short" }).format(new Date(iso));

  async function submit(key: string) {
    if (busy) return;
    const ok = await onUnlock(key);
    if (ok) {
      setCelebrate(true);
      window.setTimeout(() => {
        setCelebrate(false);
        setShow(inline);
      }, 1600);
    }
  }

  if (session && !celebrate) {
    return (
      <div className="flex flex-col gap-3 border-t border-line pt-3 text-sm" data-folder-access>
        {session.open.map((folder) => (
          <section key={folder.id} className="flex flex-col gap-2" data-folder={folder.name}>
            <h3 className="font-semibold">
              {labels.folder_title.replace("{name}", folder.name)}{" "}
              <span className="font-normal text-muted">· {folder.mode === "download" ? labels.mode_download : labels.mode_view}</span>
            </h3>
            {folder.files.length === 0 ? (
              <p className="text-muted">{labels.folder_empty}</p>
            ) : (
              <ul className="divide-y divide-line border-y border-line">
                {folder.files.map((file) => (
                  <li key={file.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2" data-folder-file={file.name || labels.picture_untitled}>
                    <span className="min-w-0 flex-1 break-words">
                      {file.name || labels.picture_untitled}
                      {file.kind === "document" && <span className="text-muted"> · {labels.file_pages.replace("{n}", String(file.pages))}</span>}
                    </span>
                    {file.viewable ? (
                      <button type="button" onClick={() => onOpen(file)} className="underline underline-offset-4" data-open>
                        {labels.file_open}
                      </button>
                    ) : (
                      <span className="text-muted">{labels.file_preparing}</span>
                    )}
                    {file.can_download && (
                      <button type="button" onClick={() => onDownload(file)} disabled={busy} className="underline underline-offset-4 disabled:text-muted" data-download>
                        {labels.file_download}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {folder.files.some((f) => f.can_download) && (
              <button
                type="button"
                onClick={() => onZip(folder)}
                disabled={busy}
                className="self-start rounded border border-line px-3 py-1 disabled:text-muted"
                data-zip
              >
                {labels.folder_zip}
              </button>
            )}
          </section>
        ))}
        {problem && <p role="alert">{problem}</p>}
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted" role="status">
          <span>{labels.key_until.replace("{time}", until(session.expires_at))}</span>
          {session.open.some((f) => f.files.some((x) => x.can_download)) && (
            <span>{labels.downloads_left.replace("{n}", String(session.downloads_left))}</span>
          )}
          <button type="button" onClick={onLock} className="text-foreground underline underline-offset-4">
            {labels.key_lock}
          </button>
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 text-sm">
      {!show ? (
        <button type="button" onClick={() => setShow(true)} className="self-start underline underline-offset-4">
          {labels.key_have}
        </button>
      ) : (
        <KeyForm phase={celebrate ? "ok" : busy ? "busy" : "idle"} problem={celebrate ? null : problem} onSubmit={submit} labels={labels} />
      )}
    </div>
  );
}

interface Manifest {
  name: string;
  can_download: boolean;
  pages: { page: number; url: string; width: number | null; height: number | null }[];
}

/**
 * The built-in viewer: the file's pages as pictures with the watermark (made on the server),
 * never the original file. Addresses last 10 minutes; a page that fails after that gets fresh
 * ones once. "Stiahnuť" only when the owner allows it.
 */
export function FolderViewer({
  base,
  lang,
  target,
  labels,
  onClose,
  onDownload,
}: {
  base: string;
  lang: string;
  target: ViewTarget;
  labels: Labels;
  onClose: () => void;
  onDownload: () => void;
}) {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [failed, setFailed] = useState(false);
  const renewed = useRef(false);
  const close = useRef<HTMLButtonElement>(null);
  const address = `${base}/folder/view/${target.kind}/${target.id}?lang=${encodeURIComponent(lang)}`;

  const fetchManifest = useCallback(
    (again: boolean) =>
      fetch(again ? `${address}&again=1` : address, { cache: "no-store" }).then((response) => {
        if (!response.ok) throw new Error("not available");
        return response.json() as Promise<Manifest>;
      }),
    [address],
  );

  useEffect(() => {
    let live = true;
    fetchManifest(false)
      .then((m) => live && setManifest(m))
      .catch(() => live && setFailed(true));
    close.current?.focus();
    const keydown = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", keydown);
    return () => {
      live = false;
      window.removeEventListener("keydown", keydown);
    };
  }, [fetchManifest, onClose]);

  // The page addresses last 10 minutes: one failure renews them once.
  const pageFailed = () => {
    if (renewed.current) return;
    renewed.current = true;
    fetchManifest(true).then(setManifest, () => setFailed(true));
  };
  const viewOnly = manifest ? !manifest.can_download : true;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={target.name || labels.picture_untitled}
      className="fixed inset-0 z-50 flex flex-col bg-white"
      data-viewer
      onContextMenu={(event) => viewOnly && event.preventDefault()}
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-line p-3">
        <span className="min-w-0 flex-1 truncate font-semibold">{target.name || labels.picture_untitled}</span>
        {manifest?.can_download && (
          <button type="button" onClick={onDownload} className="underline underline-offset-4" data-viewer-download>
            {labels.file_download}
          </button>
        )}
        <button ref={close} type="button" onClick={onClose} className="rounded border border-foreground px-3 py-1 font-medium">
          {labels.viewer_close}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto bg-white p-3">
        {failed ? (
          <p role="alert">{labels.viewer_failed}</p>
        ) : !manifest ? (
          <p role="status" className="text-muted">
            {labels.viewer_loading}
          </p>
        ) : (
          <ol className="mx-auto flex max-w-3xl flex-col gap-4">
            {manifest.pages.map((page) => (
              <li key={page.page} className="flex flex-col gap-1">
                {/* eslint-disable-next-line @next/next/no-img-element -- watermarked page from this website, 10-minute address */}
                <img
                  src={page.url}
                  alt={labels.viewer_page.replace("{n}", String(page.page)).replace("{total}", String(manifest.pages.length))}
                  width={page.width ?? undefined}
                  height={page.height ?? undefined}
                  loading={page.page <= 2 ? "eager" : "lazy"}
                  draggable={!viewOnly}
                  onError={pageFailed}
                  className="h-auto w-full select-none border border-line"
                  data-viewer-page={page.page}
                />
                {manifest.pages.length > 1 && (
                  <span className="text-center text-xs text-muted">
                    {labels.viewer_page.replace("{n}", String(page.page)).replace("{total}", String(manifest.pages.length))}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
