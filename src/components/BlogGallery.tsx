import { t, type Dictionary } from "@/i18n/dictionaries";
import type { BlogPhoto as Photo } from "@/lib/blogFormat";
import { youtubeId } from "@/lib/video";
import { BlogPhoto } from "./BlogPhoto";
import { PlayMark, YouTubePlay } from "./YouTubePlay";

/**
 * A post's photos: the first one large, the others in a grid. A tap opens the 1600 px picture in the full-screen viewer
 * (SectionZoom: swipe, ← →, pinch). A Facebook video stays on Facebook: its picture with a ▶ links there ("Video na
 * Facebooku"); a YouTube video (update 39) plays here after a tap (YouTubePlay). The first video has id="video" (the
 * slider's ▶ leads to it). Without JavaScript the links open the picture or the video's own page.
 */
export function BlogGallery({ photos, group, title, src, dict }: { photos: Photo[]; group: string; title: string; src: (path: string) => string; dict: Dictionary }) {
  if (!photos.length) return null;
  const b = dict.blog;
  const zoomable = photos.filter((p) => p.kind === "photo");
  const firstVideo = photos.find((p) => p.kind === "video")?.id;
  let n = 0;
  return (
    <div className={photos.length > 1 ? "grid grid-cols-2 gap-2 sm:grid-cols-3" : "flex"} data-blog-gallery>
      {photos.map((p, i) => {
        const first = i === 0;
        const large = src(p.large);
        const small = src(p.small);
        const box = first && photos.length > 1 ? "col-span-2 sm:col-span-3" : "";
        if (p.kind === "video") {
          const id = p.id === firstVideo ? "video" : undefined;
          const picture = (
            <BlogPhoto large={large} small={small} width={p.width} height={p.height} shown={first ? 750 : 380} alt={t(b.video_label, { n: i + 1 })} className="h-auto w-full border border-line" preload={first} />
          );
          const yt = youtubeId(p.link);
          if (yt) {
            return (
              <div key={p.id} id={id} className={`scroll-mt-4 ${box}`} data-blog-video="youtube">
                <YouTubePlay id={yt} label={b.play_youtube} title={title}>
                  {picture}
                </YouTubePlay>
              </div>
            );
          }
          return (
            <a key={p.id} id={id} href={p.link ?? large} target="_blank" rel="noopener" className={`relative block scroll-mt-4 ${box}`} data-blog-video="facebook">
              {picture}
              <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
                <PlayMark />
              </span>
              <span className="absolute bottom-2 left-2 bg-white px-2 py-1 text-sm font-medium underline underline-offset-4">{b.video}</span>
            </a>
          );
        }
        n++;
        const label = t(b.photo, { n, total: zoomable.length });
        return (
          <a key={p.id} href={large} data-zoom={large} data-zoom-group={group} data-zoom-label={label} className={`block ${box}`} aria-label={label}>
            <BlogPhoto
              large={large}
              small={small}
              width={p.width}
              height={p.height}
              shown={first ? 750 : 380}
              alt={zoomable.length > 1 ? `${title} – ${label}` : title}
              className={`h-auto w-full border border-line ${first ? "" : "aspect-square object-cover"}`}
              preload={first}
            />
          </a>
        );
      })}
    </div>
  );
}
