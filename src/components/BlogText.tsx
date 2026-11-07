import { formatBlocks, ratioValue, type Inline } from "@/lib/blogMarks";

/** One of this post's photos, ready to draw where the text places it ([[foto:<id>]]). */
export interface TextPhoto {
  id: string;
  small: string;
  large: string;
  width: number | null;
  height: number | null;
}

function Parts({ parts }: { parts: Inline[] }) {
  return parts.map((part, j) => {
    if (part.type === "br") return <br key={j} />;
    const inner =
      part.type === "link" ? (
        <a href={part.href} className="underline underline-offset-4" target="_blank" rel="noopener">
          {part.text}
        </a>
      ) : part.type === "tag" ? (
        <span className="font-medium" data-hashtag>
          {part.text}
        </span>
      ) : (
        part.text
      );
    return part.bold ? <strong key={j}>{inner}</strong> : <span key={j}>{inner}</span>;
  });
}

/**
 * A post's text as written: paragraphs and lines, links clickable, hashtags kept (never edited or translated). With
 * `formatted` (written in Cacaduu, or the owner's own text — update 77) the safe format's marks are drawn as
 * subheadings, lists, quotes, bold and this post's photos (`@/lib/blogMarks`); every text stays text, never HTML.
 */
export function BlogText({
  body,
  formatted = false,
  photos = [],
  onPhoto,
}: {
  body: string;
  formatted?: boolean;
  photos?: TextPhoto[];
  /** The editor's live preview (2026-11-07): a tap on a photo in the text opens its toolbar (a real button). */
  onPhoto?: { open: (id: string) => void; label: string };
}) {
  const blocks = formatBlocks(body, { formatted, photoIds: photos.map((p) => p.id) });
  if (!blocks.length) return null;
  const photoOf = new Map(photos.map((p) => [p.id.toLowerCase(), p]));
  return (
    <div className="ppi-blog-body flex flex-col gap-4" data-blog-text>
      {blocks.map((block, i) => {
        if (block.type === "h2")
          return (
            <h2 key={i} className="ppi-blog-sub break-words" data-blog-sub>
              <Parts parts={block.parts} />
            </h2>
          );
        if (block.type === "ul")
          return (
            <ul key={i} className="ppi-blog-list list-disc" data-blog-list>
              {block.items.map((item, j) => (
                <li key={j} className="break-words">
                  <Parts parts={item} />
                </li>
              ))}
            </ul>
          );
        if (block.type === "ol")
          return (
            <ol key={i} start={block.start} className="ppi-blog-list list-decimal" data-blog-list>
              {block.items.map((item, j) => (
                <li key={j} className="break-words">
                  <Parts parts={item} />
                </li>
              ))}
            </ol>
          );
        if (block.type === "quote")
          return (
            <blockquote key={i} className="ppi-blog-quote break-words" data-blog-quote>
              <Parts parts={block.parts} />
            </blockquote>
          );
        if (block.type === "photo") {
          const photo = photoOf.get(block.id);
          if (!photo) return null;
          const wide = (photo.width ?? 0) > 800;
          // 2026-11-07: a ratio + crop from the photo line ("[[foto:id|1:1|hore]]"); orig = the photo's own, uncut
          const ratio = ratioValue(block.ratio);
          const cut = ratio
            ? { aspectRatio: String(ratio), width: "100%", height: "auto", objectFit: "cover" as const, objectPosition: `center ${block.crop}` }
            : undefined;
          return (
            <figure key={i} className="ppi-blog-fig" data-blog-photo={photo.id} data-photo-ratio={block.ratio} data-photo-crop={block.crop}>
              {onPhoto ? (
                <button type="button" className="block w-full" onClick={() => onPhoto.open(photo.id)} aria-label={onPhoto.label} data-photo-open={photo.id}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- the editor's preview */}
                  <img src={photo.small} width={photo.width ?? undefined} height={photo.height ?? undefined} alt="" style={cut} />
                </button>
              ) : (
              // eslint-disable-next-line @next/next/no-img-element -- blog photos are already 800/1600 px (srcset)
              <img
                src={wide ? photo.small : photo.large}
                srcSet={wide ? `${photo.small} 800w, ${photo.large} ${photo.width}w` : undefined}
                sizes="(min-width: 768px) 768px, 100vw"
                width={photo.width ?? undefined}
                height={photo.height ?? undefined}
                alt=""
                loading="lazy"
                decoding="async"
                style={cut}
              />
              )}
            </figure>
          );
        }
        return (
          <p key={i} className="break-words">
            <Parts parts={block.parts} />
          </p>
        );
      })}
    </div>
  );
}
