"use client";

import { useEffect, useRef, useState } from "react";
import { srcSet, type SlideImage, type SlideView } from "@/lib/pageContent";

export interface ContentSliderLabels {
  slider: string;
  prev: string;
  next: string;
  go_to: string;
  read: string;
  all_news: string;
  pages_one: string;
  pages_few: string;
  pages_other: string;
  download_pdf: string;
  download: string;
  show_text: string;
  open_pdf: string;
  open_picture: string;
  page_of: string;
  page_alt: string;
}

/** The slide and the ones on either side of it (once the slider is near the screen). */
function withNeighbours(prev: ReadonlySet<number>, i: number, total: number): ReadonlySet<number> {
  const add = [i - 1, i, i + 1].filter((n) => n >= 0 && n < total && !prev.has(n));
  return add.length ? new Set([...prev, ...add]) : prev;
}

/** The slider's width: the content column (≤ 760 px), the full width minus 16 px margins on a phone. */
const SIZES = "(min-width: 792px) 760px, calc(100vw - 32px)";

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

function Picture({ image, alt, load, priority, className }: { image: SlideImage; alt: string; load: boolean; priority?: boolean; className: string }) {
  const img = (
    // eslint-disable-next-line @next/next/no-img-element -- pictures are already 800/1600 px: srcset, no optimisation
    <img
      src={image.width > 800 ? image.small : image.large}
      srcSet={srcSet(image)}
      sizes={SIZES}
      width={image.width}
      height={image.height}
      alt={alt}
      loading={load ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : undefined}
      decoding="async"
      draggable={false}
      className={className}
    />
  );
  // Only the slides that are needed get their picture; without JavaScript every picture is there.
  return load ? img : <noscript>{img}</noscript>;
}

/**
 * "Obsah stránky" (database update 38): ONE slider on the shop page with blog posts, PDFs and pictures in the owner's
 * order — at most 10 slides. A swipe on a touch screen (native scroll snapping, so it also works without JavaScript),
 * ‹ › buttons and the ← → keys on a computer, "3 / 10" and a dot per slide. The box follows the current slide's
 * height (each picture at most 80 % of the screen high, never cropped or stretched). Only the current and the next
 * slide's pictures load (once the slider is near the screen); the rest when they are next. A PDF or a picture opens
 * in the full-screen viewer (SectionZoom: a PDF "Slider" page by page, or "Pod sebou" all pages one under another).
 * Reduced motion: no smooth scrolling, no height animation. The texts of PDFs and pictures are in the HTML under
 * "Zobraziť text" (screen readers, search engines). `preview`: the editor's live preview (nothing opens).
 */
export function ContentSlider({
  views,
  title,
  showTitle,
  display,
  allNews,
  labels,
  lang,
  preview = false,
  first = false,
}: {
  views: SlideView[];
  title: string;
  showTitle: boolean;
  display: "open" | "collapsed";
  /** "Všetky novinky" → the blog (only when the shop has posts). */
  allNews: string | null;
  labels: ContentSliderLabels;
  lang: string;
  preview?: boolean;
  /** Right under the shop's opening hours on a phone: the first picture asks to load first. */
  first?: boolean;
}) {
  const region = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLOListElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const slides = useRef<(HTMLLIElement | null)[]>([]);
  const [current, setCurrent] = useState(0);
  const [height, setHeight] = useState<number | null>(null);
  const near = useRef(false);
  const total = views.length;
  const [wanted, setWanted] = useState<ReadonlySet<number>>(() => new Set(display === "open" || preview ? [0] : []));
  const want = (i: number) => setWanted((prev) => withNeighbours(prev, i, total));
  const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Near the screen (or a closed dropdown opened): the current and the next slide may load.
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

  // The box is as high as the current slide (a picture loading or "Zobraziť text" opened changes it).
  useEffect(() => {
    const el = slides.current[current];
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [current, total]);

  const go = (index: number) => {
    const el = track.current;
    if (!el) return;
    const i = Math.max(0, Math.min(total - 1, index));
    el.scrollTo({ left: i * el.clientWidth, behavior: reduced() ? "auto" : "smooth" });
    setCurrent(i);
    want(i);
    // ‹ on the first slide or › on the last is disabled and would drop the focus: the keys keep working.
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
    if (near.current || preview) want(i);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("summary, input, textarea")) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      go(current + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(current - 1);
    }
  };

  const plural = (n: number) => {
    const form = new Intl.PluralRules(lang).select(n);
    return fill(form === "one" ? labels.pages_one : form === "few" ? labels.pages_few : labels.pages_other, { n });
  };
  const inert = preview ? { tabIndex: -1, onClick: (e: React.MouseEvent) => e.preventDefault() } : {};
  const media = "mx-auto block h-auto max-h-[80vh] w-auto max-w-full object-contain";

  const slide = (view: SlideView, i: number) => {
    const load = wanted.has(i);
    const focus = i === current ? 0 : -1;
    if (view.kind === "post") {
      return (
        <article className="flex flex-col gap-2" data-slide-kind="post">
          {view.image && (
            <a href={view.href} tabIndex={-1} aria-hidden="true" {...inert} className="block">
              <Picture image={view.image} alt="" load={load} priority={first && i === 0} className="mx-auto block h-auto max-h-[55vh] w-auto max-w-full object-contain" />
            </a>
          )}
          <time dateTime={view.dateTime} className="text-sm text-muted">
            {view.date}
          </time>
          <h3 className="text-lg font-semibold leading-snug">
            <a href={view.href} tabIndex={focus} {...inert} className="hover:underline">
              {view.title}
            </a>
          </h3>
          {view.excerpt && <p className="line-clamp-2 text-sm">{view.excerpt}</p>}
          <a href={view.href} tabIndex={focus} {...inert} className="self-start font-medium underline underline-offset-4" data-slide-read>
            {labels.read}
          </a>
        </article>
      );
    }
    const text = view.kind === "pdf" ? view.pages.map((p) => p.text).filter((t) => t.trim()).join("\n\n") : view.text;
    const zoom = (image: SlideImage, index: number, label: string, extra: React.AnchorHTMLAttributes<HTMLAnchorElement> = {}) =>
      preview
        ? {}
        : {
            href: image.large,
            target: "_blank",
            rel: "noopener",
            "data-zoom": image.large,
            "data-zoom-group": view.key,
            "data-zoom-index": index,
            "data-zoom-label": label,
            ...(view.kind === "pdf" && view.layout === "stacked" ? { "data-zoom-mode": "stacked" } : {}),
            ...extra,
          };
    return (
      <figure className="flex flex-col gap-2" data-slide-kind={view.kind}>
        {view.kind === "pdf" ? (
          <>
            <a
              {...zoom(view.pages[0], 0, fill(labels.page_of, { n: 1, total: view.pages.length }))}
              tabIndex={focus}
              aria-label={fill(labels.open_pdf, { title: view.title })}
              className="block border border-line"
            >
              <Picture image={view.pages[0]} alt={fill(labels.page_alt, { title: view.title, n: 1 })} load={load} priority={first && i === 0} className={media} />
            </a>
            {/* The other pages for the viewer (never loaded here). */}
            {!preview &&
              view.pages.slice(1).map((p, k) => (
                <a key={p.large} {...zoom(p, k + 1, fill(labels.page_of, { n: k + 2, total: view.pages.length }))} hidden tabIndex={-1}>
                  {fill(labels.page_alt, { title: view.title, n: k + 2 })}
                </a>
              ))}
          </>
        ) : (
          <a {...zoom(view.image, 0, view.title ?? view.alt)} tabIndex={focus} aria-label={labels.open_picture} className="block">
            <Picture image={view.image} alt={view.alt} load={load} priority={first && i === 0} className={media} />
          </a>
        )}
        <figcaption className="flex flex-col gap-1.5">
          {view.kind === "pdf" ? (
            <span>
              <span className="font-semibold">{view.title}</span> <span className="text-sm text-muted">· {plural(view.pages.length)}</span>
            </span>
          ) : (
            view.title && <span className="font-semibold">{view.title}</span>
          )}
          {view.download && !preview && (
            <a href={view.download} rel="nofollow" tabIndex={focus} className="self-start rounded border border-foreground px-3 py-1.5 text-sm font-medium" data-slide-download>
              {view.kind === "pdf" ? labels.download_pdf : labels.download}
            </a>
          )}
          {text.trim() && (
            <details className="text-sm" data-slide-text>
              <summary className="cursor-pointer" tabIndex={focus}>
                {labels.show_text}
              </summary>
              <p className="whitespace-pre-line pt-1">{text}</p>
            </details>
          )}
        </figcaption>
      </figure>
    );
  };

  const arrow =
    "absolute top-1/2 z-10 -translate-y-1/2 rounded-full border border-line bg-white/90 px-3 py-1.5 text-xl leading-none shadow-sm disabled:opacity-0";
  const slider = (
    <div
      ref={region}
      className="flex flex-col gap-2 outline-none focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-foreground"
      role="region"
      aria-roledescription={labels.slider}
      aria-label={title}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-content-slider
    >
      <div
        ref={box}
        className="relative w-full overflow-hidden transition-[height] duration-200 motion-reduce:transition-none"
        style={height ? { height } : undefined}
        data-slider-box
      >
        <ol
          ref={track}
          onScroll={onScroll}
          className="flex items-start snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] motion-safe:scroll-smooth [&::-webkit-scrollbar]:hidden"
        >
          {views.map((view, i) => (
            <li
              key={view.key}
              ref={(el) => {
                slides.current[i] = el;
              }}
              className="w-full shrink-0 snap-start snap-always px-px pb-1"
              aria-hidden={i !== current}
              aria-roledescription="slide"
              data-slide={i}
            >
              {slide(view, i)}
            </li>
          ))}
        </ol>
        {total > 1 && (
          <>
            <button type="button" onClick={() => go(current - 1)} disabled={current === 0} aria-label={labels.prev} className={`${arrow} left-2`} data-slider-prev>
              ‹
            </button>
            <button type="button" onClick={() => go(current + 1)} disabled={current === total - 1} aria-label={labels.next} className={`${arrow} right-2`} data-slider-next>
              ›
            </button>
          </>
        )}
      </div>
      {total > 1 && (
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm">
          <span className="tabular-nums" aria-live="polite" data-slider-counter>
            {current + 1} / {total}
          </span>
          <span className="flex flex-wrap gap-1.5">
            {views.map((view, i) => (
              <button
                key={view.key}
                type="button"
                onClick={() => go(i)}
                aria-label={fill(labels.go_to, { n: i + 1 })}
                aria-current={i === current ? "true" : undefined}
                className={`h-2.5 w-2.5 rounded-full border border-foreground ${i === current ? "bg-foreground" : "bg-white"}`}
                data-slider-dot={i}
              />
            ))}
          </span>
        </div>
      )}
      {allNews && (
        <a href={allNews} {...inert} className="self-end text-sm underline underline-offset-4" data-all-news>
          {labels.all_news}
        </a>
      )}
    </div>
  );

  // "Vždy otvorené" (default) or "Rozbaľovacie"; the title can be hidden (screen readers still get it).
  return display === "collapsed" ? (
    <details className="border border-line p-3" data-page-content="collapsed">
      <summary className="cursor-pointer text-lg font-semibold">{title}</summary>
      <div className="pt-3">{slider}</div>
    </details>
  ) : (
    <section aria-label={title} className="flex flex-col gap-3" data-page-content="open">
      <h2 className={showTitle ? "text-lg font-semibold" : "sr-only"}>{title}</h2>
      {slider}
    </section>
  );
}
