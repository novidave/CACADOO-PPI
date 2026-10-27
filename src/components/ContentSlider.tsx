"use client";

import { useEffect, useRef, useState } from "react";
import { cropPosition, DEFAULT_RATIO, ratioCss, ratioValue, srcSet, type SliderRatio, type SlideImage, type SlideView } from "@/lib/pageContent";
import { PlayMark } from "./YouTubePlay";

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
  open_pdf: string;
  open_picture: string;
  page_of: string;
  page_alt: string;
  play_post: string;
  play_facebook: string;
  video: string;
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

/**
 * The frame every slide shares (update 44): the ratio, as wide as the slider, at most 80 % of the screen high (then
 * narrower, centred). The caption, the arrows and the counter use the same width, so nothing moves between slides.
 */
export function frameStyle(ratio: SliderRatio): React.CSSProperties {
  return { aspectRatio: ratioCss(ratio), width: `min(100%, calc(80vh * ${ratioValue(ratio)}))` };
}

function Picture({
  image,
  alt,
  load,
  priority,
  position,
}: {
  image: SlideImage;
  alt: string;
  load: boolean;
  priority?: boolean;
  position: string;
}) {
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
      // The frame is filled (never stretched): the owner's "Výrez" keeps the top, the middle or the bottom.
      className="absolute inset-0 h-full w-full object-cover"
      style={{ objectPosition: position }}
    />
  );
  // Only the slides that are needed get their picture; without JavaScript every picture is there.
  return load ? img : <noscript>{img}</noscript>;
}

/** ▶ in black and white (no colours), always the same size in the middle of the frame. */
const PlayIcon = () => <PlayMark size={64} />;

/**
 * "Obsah stránky" (database update 38): ONE slider on the shop page with blog posts, PDFs and pictures in the owner's
 * order — at most 10 slides. Update 44: every slide has the same frame (the shop's "Pomer strán slidera", 4:5 by
 * default) filled by its picture (object-fit cover, the owner's "Výrez" top / middle / bottom), and the same caption
 * below it with fixed places — the title (2 lines at most), one meta line (the date, or "5 strán"), one action ("Čítať",
 * "Stiahnuť PDF", "Stiahnuť") — that keep their space when empty. So the slider never changes height, and the arrows
 * (centred on the frame), ▶, the counter and the dots stay where they are on every slide. A swipe (native scroll
 * snapping, also without JavaScript), ‹ › and the ← → keys; only the current and the next slide's pictures load.
 * A PDF or a picture opens uncropped in the full-screen viewer (SectionZoom); its text is the slide's description for
 * screen readers (and the viewer's), with no visible "Zobraziť text". `preview`: the editor's live preview.
 */
export function ContentSlider({
  views,
  title,
  showTitle,
  display,
  allNews,
  labels,
  lang,
  ratio = DEFAULT_RATIO,
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
  ratio?: SliderRatio;
  preview?: boolean;
  /** Right under the shop's opening hours on a phone: the first picture asks to load first. */
  first?: boolean;
}) {
  const region = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLOListElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(0);
  const near = useRef(false);
  const total = views.length;
  const [wanted, setWanted] = useState<ReadonlySet<number>>(() => new Set(display === "open" || preview ? [0] : []));
  const want = (i: number) => setWanted((prev) => withNeighbours(prev, i, total));
  const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const frame = frameStyle(ratio);

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

  const go = (index: number) => {
    const el = track.current;
    if (!el) return;
    const i = Math.max(0, Math.min(total - 1, index));
    el.scrollTo({ left: i * el.clientWidth, behavior: reduced() ? "auto" : "smooth" });
    setCurrent(i);
    want(i);
    // ‹ on the first slide or › on the last is hidden and would drop the focus: the keys keep working.
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
  const frameClass = "relative mx-auto overflow-hidden bg-[#f4f4f4]";
  const action = "rounded border border-foreground px-3 py-1.5 text-sm font-medium";

  /** The caption under every frame: three fixed places (8 + 44 + 6 + 20 + 6 + 36 = 120 px), each keeps its height when empty. */
  const caption = (titleNode: React.ReactNode, meta: React.ReactNode, act: React.ReactNode) => (
    <div className="mx-auto grid h-[7.5rem] grid-rows-[2.75rem_1.25rem_2.25rem] content-start gap-1.5 pt-2" style={{ width: frame.width }} data-slide-caption>
      <div className="line-clamp-2 font-semibold leading-snug" data-slide-title>
        {titleNode}
      </div>
      <div className="truncate text-sm leading-5 text-muted" data-slide-meta>
        {meta}
      </div>
      <div className="flex items-end" data-slide-action-slot>
        {act}
      </div>
    </div>
  );

  const slide = (view: SlideView, i: number) => {
    const load = wanted.has(i);
    const focus = i === current ? 0 : -1;
    if (view.kind === "post") {
      // A video post (update 39): a ▶ that leads where the owner chose (the article, or the post on Facebook).
      const video = view.video;
      const play = video
        ? {
            href: video.href,
            ...(video.external ? { target: "_blank", rel: "noopener" } : {}),
            "aria-label": video.facebook ? labels.play_facebook : labels.play_post,
            tabIndex: focus,
            "data-slide-play": video.facebook ? "facebook" : "post",
            ...inert,
          }
        : null;
      return (
        <article data-slide-kind="post" data-slide-video={video ? "" : undefined}>
          <div className={frameClass} style={frame} data-slide-frame>
            <a href={view.href} tabIndex={-1} aria-hidden="true" {...inert} className="absolute inset-0 block">
              {view.image ? (
                <Picture image={view.image} alt="" load={load} priority={first && i === 0} position={cropPosition("center")} />
              ) : (
                // No photo: a neutral frame with the title.
                <span className="absolute inset-0 flex items-center justify-center p-6 text-center text-lg font-semibold" data-slide-no-photo>
                  {view.title}
                </span>
              )}
            </a>
            {play && (
              <a {...play} className="absolute inset-0 flex items-center justify-center" data-slide-play-mark>
                <PlayIcon />
              </a>
            )}
          </div>
          {caption(
            <a href={view.href} tabIndex={focus} {...inert} className="hover:underline">
              {view.title}
            </a>,
            <time dateTime={view.dateTime}>{view.date}</time>,
            <a href={view.href} tabIndex={focus} {...inert} className="font-medium underline underline-offset-4" data-slide-read>
              {labels.read}
            </a>,
          )}
        </article>
      );
    }
    const textId = `slide-text-${view.key}`;
    const zoom = (image: SlideImage, index: number, label: string, text: string) =>
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
            ...(text.trim() ? { "data-zoom-text": text } : {}),
            ...(view.kind === "pdf" && view.layout === "stacked" ? { "data-zoom-mode": "stacked" } : {}),
          };
    const text = view.kind === "pdf" ? view.pages.map((p) => p.text).filter((t) => t.trim()).join("\n\n") : view.text;
    const described = text.trim() ? { "aria-describedby": textId } : {};
    const download = view.download && !preview && (
      <a href={view.download} rel="nofollow" tabIndex={focus} className={action} data-slide-download>
        {view.kind === "pdf" ? labels.download_pdf : labels.download}
      </a>
    );
    return (
      <figure data-slide-kind={view.kind} data-slide-crop={view.crop}>
        <div className={frameClass} style={frame} data-slide-frame>
          {view.kind === "pdf" ? (
            <>
              <a
                {...zoom(view.pages[0], 0, fill(labels.page_of, { n: 1, total: view.pages.length }), view.pages[0].text)}
                {...described}
                tabIndex={focus}
                aria-label={fill(labels.open_pdf, { title: view.title })}
                className="absolute inset-0 block"
              >
                <Picture image={view.pages[0]} alt={fill(labels.page_alt, { title: view.title, n: 1 })} load={load} priority={first && i === 0} position={cropPosition(view.crop)} />
              </a>
              {/* The other pages for the viewer (never loaded here). */}
              {!preview &&
                view.pages.slice(1).map((p, k) => (
                  <a key={p.large} {...zoom(p, k + 1, fill(labels.page_of, { n: k + 2, total: view.pages.length }), p.text)} hidden tabIndex={-1}>
                    {fill(labels.page_alt, { title: view.title, n: k + 2 })}
                  </a>
                ))}
            </>
          ) : (
            <a {...zoom(view.image, 0, view.title ?? view.alt, view.text)} {...described} tabIndex={focus} aria-label={labels.open_picture} className="absolute inset-0 block">
              <Picture image={view.image} alt={view.alt} load={load} priority={first && i === 0} position={cropPosition(view.crop)} />
            </a>
          )}
        </div>
        {/* The text as written: the slide's description for screen readers and search engines (no visible button). */}
        {text.trim() && (
          <p id={textId} className="sr-only" data-slide-text>
            {text}
          </p>
        )}
        <figcaption>
          {caption(view.title, view.kind === "pdf" ? plural(view.pages.length) : null, download || null)}
        </figcaption>
      </figure>
    );
  };

  const arrow =
    "pointer-events-auto absolute top-1/2 z-10 -translate-y-1/2 rounded-full border border-line bg-white/90 px-3 py-1.5 text-xl leading-none shadow-sm disabled:invisible";
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
      data-ratio={ratio}
    >
      <div ref={box} className="relative w-full overflow-hidden" data-slider-box>
        <ol
          ref={track}
          onScroll={onScroll}
          className="flex items-start snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] motion-safe:scroll-smooth [&::-webkit-scrollbar]:hidden"
        >
          {views.map((view, i) => (
            <li
              key={view.key}
              className="w-full shrink-0 snap-start snap-always px-px"
              aria-hidden={i !== current}
              aria-roledescription="slide"
              data-slide={i}
            >
              {slide(view, i)}
            </li>
          ))}
        </ol>
        {total > 1 && (
          // Over the frame (same width and ratio): ‹ › in its vertical middle, a hidden one keeps its place.
          <div className="pointer-events-none absolute inset-x-0 top-0 mx-auto" style={frame} data-slider-arrows>
            <button type="button" onClick={() => go(current - 1)} disabled={current === 0} aria-label={labels.prev} className={`${arrow} left-2`} data-slider-prev>
              ‹
            </button>
            <button type="button" onClick={() => go(current + 1)} disabled={current === total - 1} aria-label={labels.next} className={`${arrow} right-2`} data-slider-next>
              ›
            </button>
          </div>
        )}
      </div>
      {total > 1 && (
        <div className="flex h-6 items-center justify-center gap-3 text-sm" data-slider-nav>
          <span className="inline-block w-[7ch] text-center tabular-nums" aria-live="polite" data-slider-counter>
            {current + 1} / {total}
          </span>
          <span className="flex gap-1.5">
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
    </div>
  );

  // "Všetky novinky": its fixed place in the header row, right of the title (never inside a slide).
  const news = allNews && (
    <a href={allNews} {...inert} className="shrink-0 text-sm underline underline-offset-4" data-all-news>
      {labels.all_news}
    </a>
  );

  // "Vždy otvorené" (default) or "Rozbaľovacie"; the title can be hidden (screen readers still get it).
  return display === "collapsed" ? (
    <details className="border border-line p-3" data-page-content="collapsed">
      <summary className="cursor-pointer text-lg font-semibold">{title}</summary>
      <div className="flex flex-col gap-2 pt-3">
        {news && <div className="flex justify-end">{news}</div>}
        {slider}
      </div>
    </details>
  ) : (
    <section aria-label={title} className="flex flex-col gap-3" data-page-content="open">
      <div className="flex items-baseline justify-between gap-3" data-slider-header>
        <h2 className={showTitle ? "text-lg font-semibold" : "sr-only"}>{title}</h2>
        {news}
      </div>
      {slider}
    </section>
  );
}
