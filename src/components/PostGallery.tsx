"use client";

import { useState } from "react";
import { PlayMark, YouTubePlay } from "./YouTubePlay";

export interface GalleryPhoto {
  id: string;
  kind: "photo" | "video";
  small: string;
  large: string;
  width: number | null;
  height: number | null;
  /** A video's own page (Facebook or YouTube). */
  link: string | null;
  /** The YouTube video id (plays here after a tap), else null. */
  youtube: string | null;
  alt: string;
}

export interface GalleryLabels {
  /** "{n} / {total}" */
  counter: string;
  /** "Fotka {n} z {total}" for each thumbnail */
  show: string;
  video: string;
  play_youtube: string;
}

/**
 * A post's photos (the unified design, 2026-11-04): one big picture (260 px, radius 18) with "1 / 3", thumbnails under
 * it (the chosen one with an orange border). A photo opens the full-screen viewer (SectionZoom: every photo of the post
 * is a zoom link, so the viewer goes through them all); a YouTube video plays here after a tap (YouTubePlay), a
 * Facebook video opens on Facebook. Without JavaScript the first picture and the links are there.
 */
export function PostGallery({ photos, group, title, labels }: { photos: GalleryPhoto[]; group: string; title: string; labels: GalleryLabels }) {
  const [at, setAt] = useState(0);
  if (!photos.length) return null;
  const current = photos[Math.min(at, photos.length - 1)];
  const total = photos.length;
  const firstVideo = photos.find((p) => p.kind === "video")?.id;
  const frame = "relative block h-[260px] w-full overflow-hidden rounded-[18px] border border-[#ECE7DE] bg-white";
  const picture = (p: GalleryPhoto, eager: boolean) => (
    // eslint-disable-next-line @next/next/no-img-element -- the stored 800 / 1600 px WebP straight from the bucket
    <img
      src={p.small}
      srcSet={p.width && p.width > 800 ? `${p.small} 800w, ${p.large} ${p.width}w` : undefined}
      sizes="(min-width: 768px) 768px, 100vw"
      width={Math.min(800, p.width ?? 800)}
      height={p.width && p.height ? Math.round((p.height * Math.min(800, p.width)) / p.width) : 600}
      alt={p.alt}
      loading={eager ? "eager" : "lazy"}
      {...(eager ? { fetchPriority: "high" as const } : {})}
      decoding="async"
      className="h-full w-full object-cover"
    />
  );
  return (
    <div className="flex flex-col gap-2.5" data-blog-gallery>
      <div className="relative">
        {current.kind === "video" ? (
          current.youtube ? (
            <div id={current.id === firstVideo ? "video" : undefined} className={`${frame} scroll-mt-4`} data-blog-video="youtube">
              <YouTubePlay id={current.youtube} label={labels.play_youtube} title={title} className="h-full w-full">
                {picture(current, at === 0)}
              </YouTubePlay>
            </div>
          ) : (
            <a id={current.id === firstVideo ? "video" : undefined} href={current.link ?? current.large} target="_blank" rel="noopener" className={`${frame} scroll-mt-4`} data-blog-video="facebook">
              {picture(current, at === 0)}
              <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
                <PlayMark />
              </span>
              <span className="absolute bottom-3 left-3 rounded-full bg-white px-3 py-1 text-sm font-semibold underline underline-offset-4">{labels.video}</span>
            </a>
          )
        ) : (
          <a href={current.large} data-zoom={current.large} data-zoom-group={group} data-zoom-label={current.alt} aria-label={current.alt} className={frame}>
            {picture(current, at === 0)}
          </a>
        )}
        {total > 1 && (
          <span className="pointer-events-none absolute top-3 right-3 rounded-full bg-black/60 px-2.5 py-0.5 text-[13px] font-bold text-white tabular-nums" data-gallery-counter>
            {labels.counter.replace("{n}", String(at + 1)).replace("{total}", String(total))}
          </span>
        )}
      </div>
      {total > 1 && (
        <ul className="flex gap-2 overflow-x-auto pb-1" aria-label={title}>
          {photos.map((p, i) => (
            <li key={p.id} className="shrink-0">
              <button
                type="button"
                onClick={() => setAt(i)}
                aria-pressed={i === at}
                aria-label={labels.show.replace("{n}", String(i + 1)).replace("{total}", String(total))}
                className={`relative block h-16 w-16 overflow-hidden rounded-xl border-2 ${i === at ? "border-[#F57C20]" : "border-transparent"}`}
                data-gallery-thumb={i}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- the stored 800 px file */}
                <img src={p.small} alt="" width={64} height={64} loading="lazy" decoding="async" className="h-full w-full object-cover" />
                {p.kind === "video" && (
                  <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
                    <PlayMark size={28} />
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* Every photo is a zoom link (hidden but the current one), so the viewer goes through them all. */}
      <div hidden>
        {photos.map((p) =>
          p.kind === "photo" && p.id !== current.id ? <a key={p.id} href={p.large} data-zoom={p.large} data-zoom-group={group} data-zoom-label={p.alt} tabIndex={-1} aria-hidden="true" /> : null,
        )}
      </div>
    </div>
  );
}
