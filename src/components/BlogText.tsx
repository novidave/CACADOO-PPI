import { textBlocks } from "@/lib/blogFormat";

/** A post's text as written: its paragraphs and lines, links clickable, hashtags kept (never edited or translated). */
export function BlogText({ body }: { body: string }) {
  const blocks = textBlocks(body);
  if (!blocks.length) return null;
  return (
    <div className="ppi-blog-body flex flex-col gap-4" data-blog-text>
      {blocks.map((parts, i) => (
        <p key={i} className="break-words">
          {parts.map((part, j) =>
            part.type === "br" ? (
              <br key={j} />
            ) : part.type === "link" ? (
              <a key={j} href={part.href} className="underline underline-offset-4" target="_blank" rel="noopener">
                {part.text}
              </a>
            ) : part.type === "tag" ? (
              <span key={j} className="font-medium" data-hashtag>
                {part.text}
              </span>
            ) : (
              <span key={j}>{part.text}</span>
            ),
          )}
        </p>
      ))}
    </div>
  );
}
