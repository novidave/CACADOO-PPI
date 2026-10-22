"use client";

import { useEffect, useRef, useState } from "react";

interface Shown {
  pages: { src: string; label: string }[];
  index: number;
  /** A PDF set to "Pod sebou" (update 38): every page one under another, scrolled to the one tapped. */
  stacked: boolean;
}

const MAX_SCALE = 5;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The full-screen viewer of PDFs and pictures (the shop page's "Obsah stránky" and the blog's photos): a tap or click
 * on a link with data-zoom opens its 1600 px picture over the whole screen. Swipe, ‹ › or the ← → keys go through the
 * file's pages (links with the same data-zoom-group); pinch, the mouse wheel, + / − or a double tap zoom, and a
 * zoomed page moves with a finger or the mouse. A PDF set to "Pod sebou" (data-zoom-mode="stacked", update 38) shows
 * every page one under another instead (the screen's own pinch zoom). Close: the button or Esc. One listener for the
 * whole page; without JavaScript the links open the picture in a new tab.
 */
export function SectionZoom({
  labels,
}: {
  labels: { close: string; zoom_in: string; zoom_out: string; prev_page: string; next_page: string };
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // Pointers on the picture: one moves (or swipes), two pinch.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ startX: number; startY: number; dist: number; scale: number; ox: number; oy: number; moved: boolean } | null>(null);
  const lastTap = useRef(0);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest<HTMLAnchorElement>("a[data-zoom]");
      if (!link) return;
      e.preventDefault();
      const group = link.dataset.zoomGroup;
      const links = group
        ? [...document.querySelectorAll<HTMLAnchorElement>("a[data-zoom]")].filter((a) => a.dataset.zoomGroup === group)
        : [link];
      const pages = links.map((a) => ({ src: a.dataset.zoom ?? a.href, label: a.dataset.zoomLabel ?? "" }));
      setShown({ pages, index: Math.max(0, links.indexOf(link)), stacked: link.dataset.zoomMode === "stacked" });
      setScale(1);
      setOffset({ x: 0, y: 0 });
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  useEffect(() => {
    const d = dialog.current;
    if (shown && d && !d.open) d.showModal();
  }, [shown]);

  // The next page's picture is fetched while this one is looked at; "Pod sebou" starts at the page tapped.
  useEffect(() => {
    if (shown?.stacked) {
      dialog.current?.querySelector(`[data-stacked-page="${shown.index}"]`)?.scrollIntoView({ block: "start" });
      return;
    }
    const next = shown?.pages[shown.index + 1];
    if (next) new Image().src = next.src;
  }, [shown]);

  const move = (by: number) => {
    setShown((s) => (s ? { ...s, index: clamp(s.index + by, 0, s.pages.length - 1) } : s));
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };
  const scaleRef = useRef(1);
  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);
  const zoomTo = (next: number) => {
    const s = clamp(next, 1, MAX_SCALE);
    setScale(s);
    if (s === 1) setOffset({ x: 0, y: 0 });
  };

  // Keys on the whole page while the viewer is open: a button that was just disabled (› on the
  // last page) loses the focus, and the keys still work.
  useEffect(() => {
    if (!shown || shown.stacked) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!dialog.current?.open) return; // closed with Esc, its close event still on the way
      if (e.key === "ArrowRight") move(1);
      else if (e.key === "ArrowLeft") move(-1);
      else if (e.key === "+" || e.key === "=") zoomTo(scaleRef.current * 1.5);
      else if (e.key === "-") zoomTo(scaleRef.current / 1.5);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [shown]);

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest("button")) return; // ‹ › are pressed, not swiped
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    const dist = pts.length === 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    gesture.current = { startX: e.clientX, startY: e.clientY, dist, scale, ox: offset.x, oy: offset.y, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const pts = [...pointers.current.values()];
    if (pts.length === 2 && g.dist > 0) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      zoomTo((g.scale * dist) / g.dist);
      g.moved = true;
      return;
    }
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) g.moved = true;
    if (scale > 1) setOffset({ x: g.ox + dx, y: g.oy + dy });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    const wasPinch = pointers.current.size === 2;
    pointers.current.delete(e.pointerId);
    if (!g || wasPinch) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (scale === 1 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      move(dx < 0 ? 1 : -1); // a swipe
    } else if (!g.moved) {
      const now = Date.now();
      if (now - lastTap.current < 300) zoomTo(scale > 1 ? 1 : 2.5); // a double tap
      lastTap.current = now;
    }
    gesture.current = null;
  };
  const onWheel = (e: React.WheelEvent) => {
    zoomTo(scale * Math.exp(-e.deltaY * 0.002));
  };

  const page = shown?.pages[shown.index];
  const button = "rounded border border-line bg-white px-3 py-1.5 disabled:opacity-40";
  return (
    <dialog
      ref={dialog}
      onClose={() => setShown(null)}
      className="m-0 h-full max-h-none w-full max-w-none bg-white p-0 backdrop:bg-black/60"
      aria-label={page?.label}
      data-zoom-dialog
    >
      {shown && page && shown.stacked && (
        <div className="flex h-full flex-col" data-zoom-stacked>
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2 text-sm">
            <span>{shown.pages.length > 1 ? `1–${shown.pages.length}` : page.label}</span>
            <button type="button" onClick={() => dialog.current?.close()} className="underline underline-offset-4" autoFocus>
              {labels.close}
            </button>
          </div>
          <div className="flex-1 overflow-y-auto overscroll-contain bg-white">
            <ol className="mx-auto flex max-w-[1000px] flex-col gap-3 p-3">
              {shown.pages.map((p, i) => (
                <li key={p.src} data-stacked-page={i} className="flex flex-col gap-1">
                  {/* eslint-disable-next-line @next/next/no-img-element -- the page's own 1600 px picture */}
                  <img
                    src={p.src}
                    alt={p.label}
                    loading={Math.abs(i - shown.index) <= 1 ? "eager" : "lazy"}
                    decoding="async"
                    className="block h-auto w-full border border-line"
                  />
                  <span className="text-right text-xs text-muted">{p.label}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
      {shown && page && !shown.stacked && (
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2 text-sm">
            <span data-zoom-counter>{page.label}</span>
            <span className="flex items-center gap-2">
              <button type="button" onClick={() => zoomTo(scale / 1.5)} disabled={scale <= 1} aria-label={labels.zoom_out} className={button}>
                −
              </button>
              <button type="button" onClick={() => zoomTo(scale * 1.5)} disabled={scale >= MAX_SCALE} aria-label={labels.zoom_in} className={button}>
                +
              </button>
              <button type="button" onClick={() => dialog.current?.close()} className="underline underline-offset-4" autoFocus>
                {labels.close}
              </button>
            </span>
          </div>
          <div
            className="relative flex-1 touch-none select-none overflow-hidden"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
            data-zoom-area
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- the page's own 1600 px picture */}
            <img
              key={page.src}
              src={page.src}
              alt={page.label}
              draggable={false}
              className="absolute inset-0 m-auto h-full w-full object-contain"
              style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`, cursor: scale > 1 ? "grab" : "zoom-in" }}
              data-zoom-scale={scale.toFixed(2)}
            />
            {shown.pages.length > 1 && (
              <>
                <button
                  type="button"
                  onClick={() => move(-1)}
                  disabled={shown.index === 0}
                  aria-label={labels.prev_page}
                  className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full border border-line bg-white/90 px-3 py-1.5 text-xl leading-none disabled:opacity-0"
                  data-zoom-prev
                >
                  ‹
                </button>
                <button
                  type="button"
                  onClick={() => move(1)}
                  disabled={shown.index === shown.pages.length - 1}
                  aria-label={labels.next_page}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full border border-line bg-white/90 px-3 py-1.5 text-xl leading-none disabled:opacity-0"
                  data-zoom-next
                >
                  ›
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </dialog>
  );
}
