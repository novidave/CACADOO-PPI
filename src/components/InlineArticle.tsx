import { BlogText } from "@/components/BlogText";
import type { SlideImage } from "@/lib/pageContent";

/**
 * A post's article under the news slider (Screen 11): written on the server, so its text is in the page's HTML; the
 * slider shows it when "Čítať" is tapped. The meta line ("BLOG · 23. 10. 2026 · 3 MIN ČÍTANIA"), the title, the text
 * exactly as written (the first paragraph as the lead) and one photo that fades in with a slow zoom when opened.
 * The post's own page (canonical, JSON-LD) stays as it is.
 */
export function InlineArticle({ meta, title, body, photo }: { meta: string; title: string; body: string; photo: SlideImage | null }) {
  return (
    <div data-inline-article>
      <p className="ppi-post-meta">{meta}</p>
      <h3 className="ppi-post-title">{title}</h3>
      <div className="ppi-post-text">
        <BlogText body={body} />
      </div>
      {photo && (
        <div className="ppi-post-fig">
          {/* eslint-disable-next-line @next/next/no-img-element -- blog photos are already 800/1600 px */}
          <img src={photo.width > 800 ? photo.small : photo.large} alt="" width={photo.width} height={photo.height} loading="lazy" decoding="async" />
        </div>
      )}
    </div>
  );
}
