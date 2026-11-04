"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import { functionFailure } from "@/lib/functionError";
import { wordDiff } from "@/lib/messageTags";
import { createClient } from "@/lib/supabase/client";
import { BlogText, type TextPhoto } from "./BlogText";
import { ghostClass } from "./owner/ui";

type Labels = Dictionary["owner_blog"];
type Style = "short" | "friendly" | "sales";
type Proposal =
  | { kind: "fix"; title: string; body: string; left: number }
  | { kind: "beautify"; body: string; titleSuggestion: string; left: number };

const fill = (text: string, values: Record<string, string | number>) =>
  String(text ?? "").replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

/** A box drawn at `width` px and scaled down to the column (never cut, never scrolled sideways). */
function Scaled({ width, label, children }: { width: number; label: string; children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const s = Math.min(1, o.clientWidth / width);
      setScale(s);
      setHeight(i.offsetHeight * s);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(o);
    observer.observe(i);
    return () => observer.disconnect();
  }, [width]);
  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      <figcaption className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</figcaption>
      <div ref={outer} className="overflow-hidden rounded-xl border border-line bg-white" style={{ height: height ?? undefined }}>
        <div ref={inner} style={{ width, transform: `scale(${scale})`, transformOrigin: "top left" }} className="p-4">
          {children}
        </div>
      </div>
    </figure>
  );
}

/** The changed words of a correction marked: the old words struck on the left, the new ones marked on the right. */
function Diff({ before, after }: { before: string; after: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <p className="whitespace-pre-wrap break-words rounded-xl bg-[#F6F6F6] p-3 text-sm" data-ai-before>
        {wordDiff(after, before).map((p, i) => (
          <span key={i} className={p.changed ? "bg-[#FDE2E2] line-through" : undefined}>
            {p.text}
          </span>
        ))}
      </p>
      <p className="whitespace-pre-wrap break-words rounded-xl bg-[#F6F6F6] p-3 text-sm" data-ai-after>
        {wordDiff(before, after).map((p, i) => (
          <span key={i} className={p.changed ? "bg-[#FEF3C7] font-semibold" : undefined}>
            {p.text}
          </span>
        ))}
      </p>
    </div>
  );
}

/**
 * The blog editor's AI (update 77, paid): "Opraviť gramatiku" (spelling, grammar, punctuation; before → after with
 * the changed words marked) and "Skrášliť článok" (the same content restructured in a chosen style, this post's photos
 * placed; side by side). Nothing is saved or published: "Použiť" puts the text into the editor ("Späť" takes it back),
 * the owner saves as always. The AI runs in the translate function with the owner's login (owner_blog_ai_hit: members
 * with the plan, the admin's daily limit; the monthly AI budget). Plus the live preview at phone and computer widths.
 */
export function BlogAiTools({
  postId,
  ensurePost,
  title,
  body,
  photos,
  formatted,
  imported,
  ai,
  labels,
  onApply,
}: {
  postId: string | null;
  /** Saves a new post first (the AI needs its id). */
  ensurePost: () => Promise<string | null>;
  title: string;
  body: string;
  photos: TextPhoto[];
  formatted: boolean;
  imported: boolean;
  ai: { enabled: boolean; plan: boolean };
  labels: Labels;
  onApply: (next: { title: string; body: string }) => void;
}) {
  const [style, setStyle] = useState<Style>("friendly");
  const [busy, setBusy] = useState<"" | "fix" | "beautify">("");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [useTitle, setUseTitle] = useState(true);
  const [undo, setUndo] = useState<{ title: string; body: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const errorText = (code: string | null | undefined) =>
    (labels as Record<string, string>)[`error_${code ?? ""}`] ?? labels.error_ai_failed;

  const ask = async (kind: "fix" | "beautify") => {
    setProblem(null);
    setNote(null);
    if (!body.trim()) {
      setProblem(labels.error_body_empty);
      return;
    }
    setBusy(kind);
    try {
      const id = postId ?? (await ensurePost());
      if (!id) return;
      const { data, error } = await createClient().functions.invoke<Record<string, unknown>>("translate", {
        body: { action: kind === "fix" ? "blog_fix" : "blog_beautify", post_id: id, title, body, ...(kind === "beautify" ? { style } : {}) },
      });
      if (error) {
        const f = await functionFailure(error);
        setProblem(errorText(f.error));
        return;
      }
      const left = Number(data?.left ?? 0);
      if (kind === "fix") {
        const next = { title: String(data?.title ?? title), body: String(data?.body ?? body) };
        if (next.title === title && next.body === body) {
          setNote(labels.ai_nothing);
          return;
        }
        setProposal({ kind, ...next, left });
      } else {
        setUseTitle(true);
        setProposal({ kind, body: String(data?.body ?? ""), titleSuggestion: String(data?.title_suggestion ?? ""), left });
      }
    } catch {
      setProblem(labels.error_ai_failed);
    } finally {
      setBusy("");
    }
  };

  const apply = () => {
    if (!proposal) return;
    setUndo({ title, body });
    const nextTitle = proposal.kind === "fix" ? proposal.title : useTitle && proposal.titleSuggestion ? proposal.titleSuggestion : title;
    onApply({ title: nextTitle, body: proposal.body });
    setProposal(null);
    setNote(labels.ai_applied);
  };

  const preview = (text: string, asFormatted: boolean) => <BlogText body={text} formatted={asFormatted} photos={photos} />;
  const styles: [Style, string][] = [
    ["short", labels.ai_style_short],
    ["friendly", labels.ai_style_friendly],
    ["sales", labels.ai_style_sales],
  ];

  return (
    <div className="flex flex-col gap-5">
      {ai.enabled && (
        <section className="flex flex-col gap-3 rounded-2xl border border-line p-4" aria-labelledby="blog-ai" data-blog-ai>
          <h2 id="blog-ai" className="text-[17px] font-bold">
            {labels.ai_title}
          </h2>
          {!ai.plan ? (
            <p className="text-sm" data-blog-ai-pro>
              {labels.ai_pro}
            </p>
          ) : (
            <>
              <p className="text-sm text-muted">{labels.ai_note}</p>
              {imported && <p className="border border-line p-3 text-sm" data-blog-ai-imported>{labels.ai_imported_note}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" disabled={Boolean(busy)} onClick={() => void ask("fix")} className={ghostClass} data-blog-ai-fix>
                  {busy === "fix" ? labels.ai_working : labels.ai_fix}
                </button>
                <button type="button" disabled={Boolean(busy)} onClick={() => void ask("beautify")} className={ghostClass} data-blog-ai-beautify>
                  {busy === "beautify" ? labels.ai_working : labels.ai_beautify}
                </button>
              </div>
              <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <legend className="sr-only">{labels.ai_style}</legend>
                <span className="font-semibold">{labels.ai_style}:</span>
                {styles.map(([value, label]) => (
                  <label key={value} className="flex min-h-11 items-center gap-1.5">
                    <input type="radio" name="blog-ai-style" checked={style === value} onChange={() => setStyle(value)} /> {label}
                  </label>
                ))}
              </fieldset>
              {photos.length === 0 && <p className="text-sm text-muted" data-blog-ai-no-photos>{labels.ai_no_photos}</p>}
              {problem && <p role="alert" className="text-sm font-semibold">{problem}</p>}
              {note && <p role="status" className="text-sm">{note}</p>}
              {undo && !proposal && (
                <button
                  type="button"
                  className="self-start text-sm underline underline-offset-4"
                  onClick={() => {
                    onApply(undo);
                    setUndo(null);
                    setNote(null);
                  }}
                  data-blog-ai-undo
                >
                  {labels.ai_undo}
                </button>
              )}
              {proposal && (
                <div className="flex flex-col gap-3" role="region" aria-label={labels.ai_title} data-blog-ai-proposal={proposal.kind}>
                  {proposal.kind === "fix" ? (
                    <>
                      {proposal.title !== title && <Diff before={title} after={proposal.title} />}
                      <Diff before={body} after={proposal.body} />
                    </>
                  ) : (
                    <>
                      {proposal.titleSuggestion && proposal.titleSuggestion !== title && (
                        <label className="flex items-start gap-2 text-sm">
                          <input type="checkbox" checked={useTitle} onChange={(e) => setUseTitle(e.target.checked)} className="mt-1" />
                          <span>{fill(labels.ai_title_suggestion, { title: proposal.titleSuggestion })}</span>
                        </label>
                      )}
                      <div className="grid gap-3 md:grid-cols-2">
                        <Scaled width={390} label={labels.ai_original}>
                          {preview(body, formatted)}
                        </Scaled>
                        <Scaled width={390} label={labels.ai_new}>
                          {preview(proposal.body, true)}
                        </Scaled>
                      </div>
                    </>
                  )}
                  <p className="text-xs text-muted">{fill(labels.ai_left, { n: proposal.left })}</p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={apply} className="rounded border border-foreground bg-foreground px-4 py-2 font-medium text-white" data-blog-ai-apply>
                      {labels.ai_apply}
                    </button>
                    {proposal.kind === "beautify" && (
                      <button type="button" disabled={Boolean(busy)} onClick={() => void ask("beautify")} className={ghostClass} data-blog-ai-retry>
                        {labels.ai_retry}
                      </button>
                    )}
                    <button type="button" onClick={() => setProposal(null)} className={ghostClass} data-blog-ai-discard>
                      {labels.ai_discard}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {body.trim() && (
        <section className="flex flex-col gap-2" aria-labelledby="blog-preview" data-blog-preview>
          <h2 id="blog-preview" className="text-[17px] font-bold">
            {labels.preview_title}
          </h2>
          <div className="grid gap-3 md:grid-cols-[minmax(0,390px)_minmax(0,1fr)]">
            <Scaled width={390} label={labels.preview_phone}>
              <h3 className="ppi-blog-h2 mb-3">{title}</h3>
              {preview(body, formatted)}
            </Scaled>
            <Scaled width={768} label={labels.preview_computer}>
              <h3 className="ppi-blog-h2 mb-3">{title}</h3>
              {preview(body, formatted)}
            </Scaled>
          </div>
        </section>
      )}
    </div>
  );
}
