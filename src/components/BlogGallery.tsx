import { t, type Dictionary } from "@/i18n/dictionaries";
import type { BlogPhoto as Photo } from "@/lib/blogFormat";
import { BlogPhoto } from "./BlogPhoto";

/**
 * A post's photos: the first one large, the others in a grid. A tap opens the 1600 px picture in the full-screen viewer
 * (SectionZoom: swipe, ← →, pinch). A video stays on Facebook: its picture links there ("Video na Facebooku"). Without
 * JavaScript the links open the picture itself.
 */
export function BlogGallery({ photos, group, title, src, dict }: { photos: Photo[]; group: string; title: string; src: (path: string) => string; dict: Dictionary }) {
  if (!photos.length) return null;
  const b = dict.blog;
  const zoomable = photos.filter((p) => p.kind === "photo");
  let n = 0;
  return (
    <div className={photos.length > 1 ? "grid grid-cols-2 gap-2 sm:grid-cols-3" : "flex"} data-blog-gallery>
      {photos.map((p, i) => {
        const first = i === 0;
        const large = src(p.large);
        const small = src(p.small);
        const box = first && photos.length > 1 ? "col-span-2 sm:col-span-3" : "";
        if (p.kind === "video") {
          return (
            <a key={p.id} href={p.link ?? large} target="_blank" rel="noopener" className={`relative block ${box}`} data-blog-video>
              <BlogPhoto large={large} small={small} width={p.width} height={p.height} shown={first ? 750 : 380} alt={t(b.video_label, { n: i + 1 })} className="h-auto w-full border border-line" preload={first} />
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
