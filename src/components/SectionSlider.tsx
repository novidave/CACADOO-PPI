"use client";

import { useEffect, useRef, useState } from "react";

export interface SliderPage {
  page: number;
  width: number;
  height: number;
  small: string;
  large: string;
  alt: string;
  /** "Strana 2 / 5" for the full-screen viewer. */
  label: string;
}

/** The page and the pages on either side of it (the one before is there already, unless a dot jumped). */
function withNeighbours(prev: ReadonlySet<number>, i: number, total: number): ReadonlySet<number> {
  const add = [i - 1, i, i + 1].filter((n) => n >= 0 && n < total && !prev.has(n));
  return add.length ? new Set([...prev, ...add]) : prev;
}

/** The column of a section's pages: the full content width (≤ 760 px), the width minus 16 px margins on a phone. */
const SIZES = "(min-width: 792px) 760px, calc(100vw - 32px)";

/**
 * "Zobrazenie strán: Slider" (database update 29): one page at a time at the content width.
 * A swipe on a touch screen (native scroll snapping, so it works even without JavaScript),
 * ‹ › buttons and the ← → keys on a computer, "2 / 5" and a dot per page. The box keeps one
 * height for every page (the tallest page's proportions, at most 80 % of the screen; each page
 * fits inside), so nothing jumps. A page's picture is put in only when it is needed: the current
 * and the next page once the slider is near the screen (the browser's own lazy loading would fetch
 * pages up to ~1250 px away, sideways too), a page stays once loaded; a <noscript> copy for
 * browsers without JavaScript. A tap opens the full-screen viewer (SectionZoom) at that page.
 */
export function SectionSlider({
  group,
  title,
  pages,
  eager,
  priority = false,
  labels,
}: {
  /** The section's id: the viewer moves through the pages of one group. */
  group: string;
  title: string;
  pages: SliderPage[];
  /**
   * An open section ("Vždy otvorené"): its first page loads with the page (the next one as soon
   * as the slider is near the screen, so it does not compete with the page's first load).
   */
  eager: boolean;
  /** The first section under the shop's details: its first page with fetchpriority high. */
  priority?: boolean;
  labels: { prev_page: string; next_page: string; go_to_page: string; slider: string; zoom_page: string };
}) {
  const region = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLOListElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(0);
  const near = useRef(false);
  // The pages whose picture is in the page (an open section: the first one at once).
  const [wanted, setWanted] = useState<ReadonlySet<number>>(() => new Set(eager ? [0] : []));
  const total = pages.length;
  const want = (i: number) => setWanted((prev) => withNeighbours(prev, i, total));
  // One height for every page: the tallest proportions.
  const ratio = Math.max(...pages.map((p) => p.height / p.width));

  // Near the screen (or opened in a closed dropdown): the current and the next page may load.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      near.current = true;
      const i = Math.round((track.current?.scrollLeft ?? 0) / (track.current?.clientWidth || 1));
      setWanted((prev) => withNeighbours(prev, i, total));
      io.disconnect();
    }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [total]);

  const go = (index: number) => {
    const el = track.current;
    if (!el) return;
    const i = Math.max(0, Math.min(total - 1, index));
    el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
    setCurrent(i);
    want(i);
    // ‹ on the first page or › on the last is disabled and would drop the focus: the keys keep working.
    const active = document.activeElement as HTMLElement | null;
    if ((i === 0 && active?.dataset.sliderPrev !== undefined) || (i === total - 1 && active?.dataset.sliderNext !== undefined)) {
      region.current?.focus({ preventScroll: true });
    }
  };

  const onScroll = () => {
    const el = track.current;
    if (!el || !el.clientWidth) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    if (i === current || i < 0 || i >= total) return;
    setCurrent(i);
    if (near.current) want(i);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      go(current + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(current - 1);
    }
  };

  const arrow = "absolute top-1/2 -translate-y-1/2 rounded-full border border-line bg-white/90 px-3 py-1.5 text-xl leading-none shadow-sm disabled:opacity-0";
  return (
    <div
      ref={region}
      className="flex flex-col gap-2 outline-none focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-foreground"
      role="region"
      aria-roledescription={labels.slider}
      aria-label={title}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-slider={group}
    >
      <div ref={box} className="relative w-full border border-line" style={{ aspectRatio: `1 / ${ratio}`, maxHeight: "80vh" }} data-slider-box>
        <ol
          ref={track}
          onScroll={onScroll}
          className="absolute inset-0 flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {pages.map((p, i) => {
            const picture = (
              // eslint-disable-next-line @next/next/no-img-element -- pictures are already 800/1600 px: srcset, no optimisation
              <img
                src={p.small}
                srcSet={`${p.small} 800w, ${p.large} 1600w`}
                sizes={SIZES}
                width={p.width}
                height={p.height}
                alt={p.alt}
                loading={wanted.has(i) ? "eager" : "lazy"}
                fetchPriority={priority && i === 0 ? "high" : undefined}
                decoding="async"
                draggable={false}
                className="h-full w-full object-contain"
              />
            );
            return (
              <li
                key={p.page}
                className="h-full w-full shrink-0 snap-center snap-always"
                aria-hidden={i !== current}
                data-section-page={p.page}
              >
                <a
                  href={p.large}
                  target="_blank"
                  rel="noopener"
                  tabIndex={i === current ? 0 : -1}
                  data-zoom={p.large}
                  data-zoom-group={group}
                  data-zoom-index={i}
                  data-zoom-label={p.label}
                  aria-label={labels.zoom_page.replace("{n}", String(p.page))}
                  className="block h-full w-full"
                >
                  {wanted.has(i) ? picture : <noscript>{picture}</noscript>}
                </a>
              </li>
            );
          })}
        </ol>
        <button type="button" onClick={() => go(current - 1)} disabled={current === 0} aria-label={labels.prev_page} className={`${arrow} left-2`} data-slider-prev>
          ‹
        </button>
        <button type="button" onClick={() => go(current + 1)} disabled={current === total - 1} aria-label={labels.next_page} className={`${arrow} right-2`} data-slider-next>
          ›
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm">
        <span className="tabular-nums" aria-live="polite" data-slider-counter>
          {current + 1} / {total}
        </span>
        <span className="flex flex-wrap gap-1.5">
          {pages.map((p, i) => (
            <button
              key={p.page}
              type="button"
              onClick={() => go(i)}
              aria-label={labels.go_to_page.replace("{n}", String(p.page))}
              aria-current={i === current ? "true" : undefined}
              className={`h-2.5 w-2.5 rounded-full border border-foreground ${i === current ? "bg-foreground" : "bg-white"}`}
              data-slider-dot={i}
            />
          ))}
        </span>
      </div>
    </div>
  );
}
