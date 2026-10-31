"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cropPosition, DEFAULT_RATIO, ratioCss, ratioValue, slideTag, srcSet, type SliderRatio, type SlideImage, type SlideView } from "@/lib/pageContent";
import { HoldLink } from "./HoldLink";
import { PlayMark } from "./PlayMark";
import "@/components/shopPage.css";

export interface ContentSliderLabels {
  slider: string;
  prev: string;
  next: string;
  go_to: string;
  read: string;
  all_news: string;
  all_news_done: string;
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
  tag_post: string;
  tag_offer: string;
  close: string;
  view: string;
  close_article: string;
  article: string;
  slide_of: string;
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
 * narrower, centred). The line under it (date and pills) uses the same width, so nothing moves between slides.
 */
export function frameStyle(ratio: SliderRatio): React.CSSProperties {
  return { aspectRatio: ratioCss(ratio), width: `min(100%, calc(80vh * ${ratioValue(ratio)}))` };
}

function Picture({ image, alt, load, priority, position }: { image: SlideImage; alt: string; load: boolean; priority?: boolean; position: string }) {
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

/** The orange chevron of "Čítať": down, bobbing gently; up while the article is open. */
const Chevron = () => (
  <span className="ppi-read-chev" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F57C20" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" focusable="false">
      <path d="M6 9l6 6 6-6" />
    </svg>
  </span>
);

/**
 * "Obsah stránky" (database update 38) in the shop page's news look (Screen 11, 2026-10-31): ONE slider of blog posts,
 * PDFs and pictures in the owner's order — the database decides the slides (`shop_content()`). Each slide is one
 * rounded frame of the shop's "Pomer strán slidera" (update 44, the owner's "Výrez"), with a dark gradient, a tag
 * ("Novinka" / "Ponuka"), the title and one white button: "Čítať" (a post: opens the article under the slider, the text
 * is in the HTML; without JavaScript the link goes to the post's page), "Zobraziť" (a PDF or a picture: the full-screen
 * viewer). Swipe only — scroll snapping, a mouse drag on a computer, ← → on the focused slider; under the frame the
 * date and one pill per slide. No arrows, no counter. Only the current and the next pictures load; a video post keeps
 * its ▶ (update 39). `preview`: the editor's live preview (nothing reacts).
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
  articles,
  hold,
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
  /** The posts' inline articles, written on the server (key = the slide's key). */
  articles?: Record<string, ReactNode>;
  /** "Držte stlačené" for "Všetky novinky". */
  hold?: string;
}) {
  const region = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLOListElement>(null);
  const [current, setCurrent] = useState(0);
  const [open, setOpen] = useState(false);
  const near = useRef(false);
  const drag = useRef<{ x: number; left: number; from: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const total = views.length;
  const [wanted, setWanted] = useState<ReadonlySet<number>>(() => new Set(display === "open" || preview ? [0] : []));
  const want = (i: number) => setWanted((prev) => withNeighbours(prev, i, total));
  const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const frame = frameStyle(ratio);
  const articleId = useId();

  // Near the screen (or a closed dropdown opened): the current and the next slide may load.
  useEffect(() => {
    const el = region.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        near.current = true;
        const i = Math.round((track.current?.scrollLeft ?? 0) / (track.current?.clientWidth || 1));
        setWanted((prev) => withNeighbours(prev, i, total));
        io.disconnect();
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [total]);

  const go = (index: number) => {
    const el = track.current;
    if (!el) return;
    const i = Math.max(0, Math.min(total - 1, index));
    el.scrollTo({ left: i * el.clientWidth, behavior: reduced() ? "auto" : "smooth" });
    if (i !== current) setOpen(false);
    setCurrent(i);
    want(i);
  };

  const onScroll = () => {
    const el = track.current;
    if (!el || !el.clientWidth || drag.current) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    if (i === current || i < 0 || i >= total) return;
    // another slide: its article is not the open one
    setOpen(false);
    setCurrent(i);
    if (near.current || preview) want(i);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("summary, input, textarea, [data-post-article]")) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      go(current + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(current - 1);
    }
  };

  // A mouse drag on a computer (fingers swipe natively): the track follows, then snaps to the nearest slide.
  const onPointerDown = (e: React.PointerEvent) => {
    const el = track.current;
    if (preview || !el || e.pointerType !== "mouse" || e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, [data-slide-read]")) return;
    drag.current = { x: e.clientX, left: el.scrollLeft, from: current, moved: false };
    const move = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = ev.clientX - d.x;
      if (!d.moved && Math.abs(dx) > 5) {
        d.moved = true;
        setDragging(true);
      }
      if (d.moved) el.scrollLeft = d.left - dx;
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const d = drag.current;
      drag.current = null;
      setDragging(false);
      if (!d?.moved) return;
      const dx = ev.clientX - d.x;
      const to = dx < -40 ? d.from + 1 : dx > 40 ? d.from - 1 : d.from;
      // the click that follows a drag is not a tap on the slide
      const swallow = (c: Event) => {
        c.preventDefault();
        c.stopPropagation();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      window.setTimeout(() => go(to), 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const plural = (n: number) => {
    const form = new Intl.PluralRules(lang).select(n);
    return fill(form === "one" ? labels.pages_one : form === "few" ? labels.pages_few : labels.pages_other, { n });
  };
  const inert = preview ? { tabIndex: -1, onClick: (e: React.MouseEvent) => e.preventDefault() } : {};
  const currentView = views[current];
  const hasArticle = (view: SlideView | undefined) => Boolean(view && view.kind === "post" && articles?.[view.key]);

  /** The text and the button over the picture's bottom. */
  const overlay = (view: SlideView, action: ReactNode) => {
    const name = view.title;
    return (
      <div className="ppi-slide-bottom">
        <div className="min-w-0">
          <span className="ppi-slide-tag">{labels[slideTag(view.kind)]}</span>
          {name && (
            <h3 className="ppi-slide-title" data-slide-title>
              {name}
            </h3>
          )}
        </div>
        {action}
      </div>
    );
  };

  const slide = (view: SlideView, i: number) => {
    const load = wanted.has(i);
    const focus = i === current ? 0 : -1;
    if (view.kind === "post") {
      const video = view.video;
      const article = hasArticle(view);
      const expanded = open && i === current && article;
      return (
        <article className="ppi-slide-frame" style={frame} data-slide-frame data-slide-kind="post" data-slide-video={video ? "" : undefined}>
          {view.image ? <Picture image={view.image} alt="" load={load} priority={first && i === 0} position={cropPosition("center")} /> : <span className="absolute inset-0 bg-[#2A2A2A]" data-slide-no-photo />}
          <span className="ppi-slide-shade" aria-hidden="true" />
          {video && (
            <a
              href={video.href}
              {...(video.external ? { target: "_blank", rel: "noopener" } : {})}
              aria-label={video.facebook ? labels.play_facebook : labels.play_post}
              tabIndex={focus}
              className="absolute inset-0 flex items-center justify-center"
              data-slide-play={video.facebook ? "facebook" : "post"}
              data-slide-play-mark
              {...inert}
            >
              <PlayMark size={64} />
            </a>
          )}
          {overlay(
            view,
            <a
              href={view.href}
              tabIndex={focus}
              className="ppi-read"
              data-slide-read
              {...(article ? { role: "button", "aria-expanded": expanded ? "true" : "false", "aria-controls": articleId } : {})}
              onClick={(e) => {
                if (preview) {
                  e.preventDefault();
                  return;
                }
                // Without its article (or without JavaScript) the link goes to the post's page.
                if (!article) return;
                e.preventDefault();
                if (i !== current) go(i);
                setOpen((o) => (i === current ? !o : true));
              }}
            >
              {expanded ? labels.close : labels.read}
              <Chevron />
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
    const image = view.kind === "pdf" ? view.pages[0] : view.image;
    const openLabel = view.kind === "pdf" ? fill(labels.open_pdf, { title: view.title }) : labels.open_picture;
    const zoomFirst = view.kind === "pdf" ? zoom(view.pages[0], 0, fill(labels.page_of, { n: 1, total: view.pages.length }), view.pages[0].text) : zoom(view.image, 0, view.title ?? view.alt, view.text);
    return (
      <figure className="ppi-slide-frame" style={frame} data-slide-frame data-slide-kind={view.kind} data-slide-crop={view.crop}>
        <Picture
          image={image}
          alt={view.kind === "pdf" ? fill(labels.page_alt, { title: view.title, n: 1 }) : view.alt}
          load={load}
          priority={first && i === 0}
          position={cropPosition(view.crop)}
        />
        <span className="ppi-slide-shade" aria-hidden="true" />
        {/* The other pages for the viewer (never loaded here). */}
        {!preview &&
          view.kind === "pdf" &&
          view.pages.slice(1).map((p, k) => (
            <a key={p.large} {...zoom(p, k + 1, fill(labels.page_of, { n: k + 2, total: view.pages.length }), p.text)} hidden tabIndex={-1}>
              {fill(labels.page_alt, { title: view.title, n: k + 2 })}
            </a>
          ))}
        {/* The text as written: the slide's description for screen readers and search engines. */}
        {text.trim() && (
          <p id={textId} className="sr-only" data-slide-text>
            {text}
          </p>
        )}
        {overlay(
          view,
          <a {...zoomFirst} {...described} tabIndex={focus} aria-label={openLabel} className="ppi-read" data-slide-view {...inert}>
            {labels.view}
          </a>,
        )}
      </figure>
    );
  };

  const meta = (view: SlideView | undefined) =>
    !view ? null : view.kind === "post" ? <time dateTime={view.dateTime}>{view.date}</time> : view.kind === "pdf" ? plural(view.pages.length) : null;
  const download = currentView && currentView.kind !== "post" && currentView.download && !preview && (
    <a href={currentView.download} rel="nofollow" className="ml-3 underline underline-offset-4" data-slide-download>
      {currentView.kind === "pdf" ? labels.download_pdf : labels.download}
    </a>
  );

  const slider = (
    <div
      ref={region}
      className="ppi-news flex flex-col outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#2563EB]"
      role="region"
      aria-roledescription={labels.slider}
      aria-label={title}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-content-slider
      data-ratio={ratio}
    >
      <ol
        ref={track}
        onScroll={onScroll}
        onPointerDown={onPointerDown}
        className="ppi-news-track"
        data-dragging={dragging || undefined}
        data-slider-track
      >
        {views.map((view, i) => (
          <li
            key={view.key}
            className="w-full shrink-0 snap-start snap-always"
            aria-hidden={i !== current}
            aria-roledescription="slide"
            aria-label={fill(labels.slide_of, { n: i + 1, total })}
            data-slide={i}
          >
            {slide(view, i)}
          </li>
        ))}
      </ol>
      <div className="mx-auto mt-3 flex min-h-[22px] items-center justify-between gap-3" style={{ width: frame.width }} data-slider-nav>
        <span className="truncate text-[13px] font-semibold text-[#6E6E6E]" data-slide-meta>
          {meta(currentView)}
          {download}
        </span>
        {total > 1 && (
          <span className="flex shrink-0 gap-2" data-slider-pills>
            {views.map((view, i) => (
              <button
                key={view.key}
                type="button"
                onClick={() => go(i)}
                aria-label={fill(labels.go_to, { n: i + 1 })}
                aria-pressed={i === current}
                aria-current={i === current ? "true" : undefined}
                className="ppi-pill-select"
                data-slider-dot={i}
                {...(preview ? { tabIndex: -1 } : {})}
              />
            ))}
          </span>
        )}
      </div>
      {articles && Object.keys(articles).length > 0 && (
        // Every article is in the HTML (crawlers, no JavaScript needed to read the post's page); the current one opens.
        <div id={articleId} className="ppi-post" data-open={(open && hasArticle(currentView)) || undefined} role="region" aria-label={labels.article} data-post-article>
          <div inert={!open || undefined}>
            {views.map((view) =>
              view.kind === "post" && articles[view.key] ? (
                <div key={view.key} hidden={view.key !== currentView?.key} data-post-for={view.key}>
                  <div className="mt-[18px] border-t border-[#EEEEEE] pt-5">
                    {articles[view.key]}
                    <div className="mt-[18px] flex flex-wrap gap-2.5">
                      {/* "Všetky novinky" → the blog, held like the one above the slider (artboard 12: orange) */}
                      {allNews && !preview && (
                        <HoldLink
                          href={allNews}
                          newTab={false}
                          label={labels.all_news}
                          holdLabel={hold ?? labels.all_news}
                          doneLabel={labels.all_news_done}
                          className="ppi-hold-news ppi-hold-pri"
                          data={{ "post-all-news": "" }}
                        />
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setOpen(false);
                          region.current?.querySelector<HTMLElement>(`[data-slide="${current}"] [data-slide-read]`)?.focus({ preventScroll: true });
                        }}
                        className="ppi-btn-plain"
                        data-post-close
                      >
                        {labels.close_article}
                      </button>
                    </div>
                  </div>
                </div>
              ) : null,
            )}
          </div>
        </div>
      )}
    </div>
  );

  // "Všetky novinky": right-aligned above the slider, press and hold (Screen 11).
  const news =
    allNews &&
    (preview ? (
      <span className="ppi-hold-news" data-all-news>
        {labels.all_news}
      </span>
    ) : (
      <HoldLink href={allNews} newTab={false} label={labels.all_news} holdLabel={hold ?? labels.all_news} doneLabel={labels.all_news_done} className="ppi-hold-news" data={{ "all-news": "" }} />
    ));

  // "Vždy otvorené" (default) or "Rozbaľovacie"; the section has no visible title (screen readers get it).
  return display === "collapsed" ? (
    <details className="rounded-[18px] border border-line p-3" data-page-content="collapsed">
      <summary className="cursor-pointer text-lg font-semibold">{title}</summary>
      <div className="flex flex-col gap-3 pt-3">
        {news && <div className="flex justify-end">{news}</div>}
        {slider}
      </div>
    </details>
  ) : (
    <section aria-label={title} className="flex flex-col" data-page-content="open">
      {/* No visible title in the news look; "Zobraziť nadpis" keeps it for screen readers only. */}
      <h2 className="sr-only" data-show-title={showTitle || undefined}>
        {title}
      </h2>
      {news && (
        <div className="mb-3 flex justify-end" data-slider-header>
          {news}
        </div>
      )}
      {slider}
    </section>
  );
}
