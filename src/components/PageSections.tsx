import { t, type Dictionary } from "@/i18n/dictionaries";
import type { SectionPosition, ShownSection } from "@/lib/sections";

/** The column of a section's pages: at most 760 px, the full width minus 16 px margins on a phone. */
const SIZES = "(min-width: 792px) 760px, calc(100vw - 32px)";

/**
 * The page sections of one position (database update 28): each a titled dropdown, or an open
 * block for "Vždy otvorené". Pages are pictures one under another (srcset 800 / 1600 px, their
 * own proportions, the first page of an open section at once, the others lazily), each a link to
 * its 1600 px picture (SectionZoom opens it over the page; without JavaScript in a new tab). The
 * text as written is in the HTML under "Zobraziť text" (screen readers, search engines and AI
 * read it). The PDF itself is never loaded here; "Stiahnuť PDF" only when the owner allows it.
 */
export function PageSections({
  sections,
  position,
  slug,
  dict,
}: {
  sections: ShownSection[];
  position: SectionPosition;
  slug: string;
  dict: Dictionary;
}) {
  const here = sections.filter((s) => s.position === position);
  if (here.length === 0) return null;
  return (
    <div className="flex flex-col gap-4" data-sections={position}>
      {here.map((section) => (
        <PageSection key={section.id} section={section} slug={slug} dict={dict} />
      ))}
    </div>
  );
}

function PageSection({ section, slug, dict }: { section: ShownSection; slug: string; dict: Dictionary }) {
  const s = dict.sections;
  const open = section.display === "open";
  const total = section.pages.length;
  const body = (
    <div className="flex flex-col gap-3 pt-3">
      <ol className="mx-auto flex w-full max-w-[760px] flex-col gap-3" aria-label={section.title}>
        {section.pages.map((p, i) => (
          <li key={p.page} className="flex flex-col gap-1" data-section-page={p.page}>
            <a
              href={p.large}
              target="_blank"
              rel="noopener"
              data-zoom={p.large}
              data-zoom-label={t(s.page_of, { n: p.page, total })}
              aria-label={t(s.zoom_page, { n: p.page })}
              className="block border border-line"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- pictures are already 800/1600 px: srcset, no optimisation */}
              <img
                src={p.small}
                srcSet={`${p.small} 800w, ${p.large} 1600w`}
                sizes={SIZES}
                width={p.width}
                height={p.height}
                alt={t(s.page_alt, { title: section.title, n: p.page })}
                loading={open && i === 0 ? "eager" : "lazy"}
                decoding="async"
                className="block h-auto w-full"
              />
            </a>
            <span className="text-right text-xs text-muted">{t(s.page_of, { n: p.page, total })}</span>
          </li>
        ))}
      </ol>
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-2">
        {section.allow_download && (
          <a
            href={`/api/shops/${slug}/sections/${section.id}/pdf`}
            className="self-start underline underline-offset-4"
            rel="nofollow"
            data-section-download
          >
            {s.download}
          </a>
        )}
        <details className="border-t border-line pt-2" data-section-text>
          <summary className="cursor-pointer text-sm">{s.show_text}</summary>
          <div className="flex flex-col gap-3 pt-2 text-sm">
            {section.pages
              .filter((p) => p.text.trim())
              .map((p) => (
                <div key={p.page}>
                  <p className="text-xs text-muted">{t(s.page_n, { n: p.page })}</p>
                  <p className="whitespace-pre-line">{p.text}</p>
                </div>
              ))}
          </div>
        </details>
      </div>
    </div>
  );

  return open ? (
    <section id={`section-${section.id}`} aria-labelledby={`section-${section.id}-title`} data-section={section.id} data-display="open">
      <h2 id={`section-${section.id}-title`} className="text-lg font-semibold">
        {section.title}
      </h2>
      {body}
    </section>
  ) : (
    <details id={`section-${section.id}`} className="border border-line p-3" data-section={section.id} data-display="collapsed">
      <summary className="cursor-pointer text-lg font-semibold">{section.title}</summary>
      {body}
    </details>
  );
}
