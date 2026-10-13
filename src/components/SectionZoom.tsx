"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Tap or click a page of a page section: its 1600 px picture over the page. A tap on the
 * picture switches between "fit the screen" and full size (scroll to move); on a phone pinch
 * works as on any page. Close: the button, Esc or a tap outside. One listener for the whole
 * page (links with data-zoom); without JavaScript the links open the picture in a new tab.
 */
export function SectionZoom({ labels }: { labels: { close: string; zoom_in: string; zoom_out: string } }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [shown, setShown] = useState<{ src: string; label: string } | null>(null);
  const [full, setFull] = useState(false);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest<HTMLAnchorElement>("a[data-zoom]");
      if (!link) return;
      e.preventDefault();
      setShown({ src: link.dataset.zoom ?? link.href, label: link.dataset.zoomLabel ?? "" });
      setFull(false);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  useEffect(() => {
    const d = dialog.current;
    if (shown && d && !d.open) d.showModal();
  }, [shown]);

  return (
    <dialog
      ref={dialog}
      onClose={() => setShown(null)}
      onClick={(e) => {
        if (e.target === dialog.current) dialog.current?.close();
      }}
      className="m-0 h-full max-h-none w-full max-w-none bg-white p-0 backdrop:bg-black/60"
      aria-label={shown?.label}
      data-zoom-dialog
    >
      {shown && (
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2 text-sm">
            <span>{shown.label}</span>
            <span className="flex gap-4">
              <button type="button" onClick={() => setFull((f) => !f)} className="underline underline-offset-4">
                {full ? labels.zoom_out : labels.zoom_in}
              </button>
              <button type="button" onClick={() => dialog.current?.close()} className="underline underline-offset-4" autoFocus>
                {labels.close}
              </button>
            </span>
          </div>
          <div className="flex-1 overflow-auto" style={{ touchAction: "pinch-zoom pan-x pan-y" }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- the page's own 1600 px picture */}
            <img
              src={shown.src}
              alt={shown.label}
              onClick={() => setFull((f) => !f)}
              className={full ? "block w-[1600px] max-w-none cursor-zoom-out" : "mx-auto block h-auto max-h-full w-auto max-w-full cursor-zoom-in"}
            />
          </div>
        </div>
      )}
    </dialog>
  );
}
