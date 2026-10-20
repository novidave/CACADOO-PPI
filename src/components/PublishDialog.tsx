"use client";

import { useEffect, useRef } from "react";

export type FacebookState = "connected" | "not_connected" | "expired";

export interface PublishDialogLabels {
  dialog_title: string;
  dialog_yes: string;
  dialog_web: string;
  dialog_back: string;
  dialog_not_connected: string;
  dialog_connect: string;
  dialog_expired: string;
  dialog_reconnect: string;
  dialog_scheduled: string;
  preview_label: string;
  preview_now: string;
  more_photos: string;
  fb_profiles: string;
}

/**
 * The question before "Zverejniť" / "Naplánovať" (asked every time; the last answer is pre-selected):
 *   connected      — "Zverejniť aj na Facebooku?" with the post as the Page will show it (the Page's name and picture,
 *                    the text, up to 4 photos + "+N", the last line "Čítať na webe: <address>"):
 *                    "Áno, zverejniť na webe aj na Facebooku" · "Len na web" · "Späť na úpravy"
 *   not_connected  — "Facebook nie je pripojený." "Pripojiť Facebook stránku" (then back here) · "Len na web" · "Späť"
 *   expired        — "Pripojenie k Facebooku vypršalo." "Pripojiť znova" · "Len na web" · "Späť"
 * A modal <dialog>: the rest of the page is inert (focus stays inside), Esc = "Späť na úpravy".
 */
export function PublishDialog({
  open,
  state,
  page,
  message,
  photos,
  when,
  preselect,
  busy,
  labels,
  onChoose,
  onConnect,
  onBack,
}: {
  open: boolean;
  state: FacebookState;
  page: { name: string; picture: string | null } | null;
  message: string;
  photos: string[];
  /** The scheduled time as the owner sees it; null = now. */
  when: string | null;
  preselect: "web" | "web_fb";
  busy: boolean;
  labels: PublishDialogLabels;
  onChoose: (choice: "web" | "web_fb") => void;
  onConnect: () => void;
  onBack: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const yes = useRef<HTMLButtonElement>(null);
  const web = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // The last answer is pre-selected (focused): Enter repeats it.
      (state === "connected" && preselect === "web_fb" ? yes.current : web.current)?.focus();
    }
    if (!open && d.open) d.close();
  }, [open, state, preselect]);

  const shown = photos.slice(0, 4);
  const more = photos.length - shown.length;
  const button = "rounded border px-4 py-2 text-left font-medium disabled:text-muted";
  const primary = (selected: boolean) => `${button} ${selected ? "border-foreground bg-foreground text-white" : "border-foreground"}`;

  return (
    <dialog
      ref={dialog}
      aria-labelledby="publish-dialog-title"
      className="m-auto w-[min(100%-2rem,34rem)] max-h-[90vh] overflow-y-auto border border-foreground bg-white p-0 text-foreground backdrop:bg-black/40"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onBack();
      }}
      data-publish-dialog={state}
    >
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <h2 id="publish-dialog-title" className="text-lg font-semibold">
          {state === "connected" ? labels.dialog_title : state === "expired" ? labels.dialog_expired : labels.dialog_not_connected}
        </h2>

        {state === "connected" && (
          <figure className="flex flex-col gap-2 border border-line p-3" aria-label={labels.preview_label} data-facebook-preview>
            <figcaption className="text-xs uppercase tracking-wide text-muted">{labels.preview_label}</figcaption>
            <div className="flex items-center gap-2">
              {page?.picture ? (
                // eslint-disable-next-line @next/next/no-img-element -- the Page's picture from Facebook, in Môj obchod only
                <img src={page.picture} alt="" width={40} height={40} className="h-10 w-10 rounded-full border border-line object-cover" />
              ) : (
                <span className="h-10 w-10 rounded-full border border-line" aria-hidden />
              )}
              <span className="flex flex-col">
                <span className="font-semibold">{page?.name}</span>
                <span className="text-xs text-muted">{when ?? labels.preview_now}</span>
              </span>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm" data-preview-text>
              {message}
            </p>
            {shown.length > 0 && (
              <div className="grid grid-cols-4 gap-1">
                {shown.map((src, i) => (
                  <span key={src} className="relative block">
                    {/* eslint-disable-next-line @next/next/no-img-element -- the post's own photos */}
                    <img src={src} alt="" className="aspect-square h-auto w-full border border-line object-cover" />
                    {i === shown.length - 1 && more > 0 && (
                      <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-lg font-semibold text-white" data-more-photos>
                        {labels.more_photos.replace("{n}", String(more))}
                      </span>
                    )}
                  </span>
                ))}
              </div>
            )}
          </figure>
        )}
        {state === "connected" && when && <p className="text-sm">{labels.dialog_scheduled.replace("{date}", when)}</p>}
        {state !== "connected" && <p className="text-sm text-muted">{labels.fb_profiles}</p>}

        <div className="flex flex-col gap-2">
          {state === "connected" ? (
            <button ref={yes} type="button" disabled={busy} className={primary(preselect === "web_fb")} onClick={() => onChoose("web_fb")} data-choice="web_fb">
              {labels.dialog_yes}
            </button>
          ) : (
            <button type="button" disabled={busy} className={primary(false)} onClick={onConnect} data-choice="connect">
              {state === "expired" ? labels.dialog_reconnect : labels.dialog_connect}
            </button>
          )}
          <button
            ref={web}
            type="button"
            disabled={busy}
            className={primary(state === "connected" && preselect === "web")}
            onClick={() => onChoose("web")}
            data-choice="web"
          >
            {labels.dialog_web}
          </button>
          <button type="button" disabled={busy} className="self-start px-1 py-2 underline underline-offset-4" onClick={onBack} data-choice="back">
            {labels.dialog_back}
          </button>
        </div>
      </div>
    </dialog>
  );
}
