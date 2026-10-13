"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import { functionFailure } from "@/lib/functionError";
import { createClient } from "@/lib/supabase/client";
import { openPdf, sectionPage } from "@/lib/pdfRead";
import { MAX_PDF_BYTES, MAX_PDF_PAGES, POSITIONS } from "@/lib/sectionLimits";
import { createSection } from "@/app/[lang]/(account)/dashboard/sectionActions";

type Labels = Dictionary["sections"];
type Supabase = ReturnType<typeof createClient>;

/** An answer of page-sections, or its reason as {error, message} (thrown). */
class SectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(supabase: Supabase, name: string, body: unknown, headers?: Record<string, string>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, { body: body as never, headers, method: "POST" });
  if (!error) return data as T;
  const failure = await functionFailure(error);
  throw new SectionError(failure.error ?? "failed", failure.message ?? failure.detail);
}

function errorText(labels: Labels, e: unknown): string {
  const code = e instanceof SectionError ? e.code : (e as { name?: string } | null)?.name === "PasswordException" ? "encrypted" : null;
  const known = code ? (labels as Record<string, string>)[`error_${code}`] : null;
  if (known && !known.includes("{message}")) return known;
  if ((e as { name?: string } | null)?.name === "InvalidPDFException") return labels.error_not_pdf;
  return labels.error_failed.replace("{message}", e instanceof Error ? e.message : String(e));
}

/**
 * Reads the PDF in the owner's browser (pdf.js: Edge Functions cannot draw PDFs) and sends it to
 * page-sections step by step: the PDF (checked and cleaned there; only the cleaned file is
 * kept), every page as a picture 800 and 1600 px wide, the text of every page as written, then
 * "finish" (the new PDF goes live; until then visitors see the old one). Pages without text are
 * written out by the AI afterwards.
 */
async function sendPdf(supabase: Supabase, sectionId: string, file: File, progress: (text: string) => void, labels: Labels) {
  const { doc, close } = await openPdf(file);
  try {
    if (doc.numPages > MAX_PDF_PAGES) throw new SectionError("too_many_pages", "too many pages");
    progress(labels.uploading);
    const sent = await call<{ version: number; pages: number; removed: string[] }>(
      supabase,
      `page-sections?action=pdf&section_id=${sectionId}`,
      file,
      { "Content-Type": "application/pdf" },
    );
    const texts: { page: number; text: string }[] = [];
    for (let n = 1; n <= sent.pages; n++) {
      progress(labels.page_progress.replace("{n}", String(n)).replace("{total}", String(sent.pages)));
      const page = await sectionPage(doc, n);
      for (const [size, blob] of [[800, page.small], [1600, page.large]] as const) {
        await call(supabase, `page-sections?action=page&section_id=${sectionId}&version=${sent.version}&page=${n}&size=${size}`, blob, {
          "Content-Type": blob.type,
        });
      }
      texts.push({ page: n, text: page.text });
    }
    await call(supabase, "page-sections", { action: "text", section_id: sectionId, version: sent.version, pages: texts });
    await call(supabase, "page-sections", { action: "finish", section_id: sectionId, version: sent.version });
    // Pages without a text layer: the AI writes them out (as written), a few at a time.
    let waiting = texts.filter((t) => !t.text.trim()).length;
    for (let round = 0; waiting > 0 && round < 20; round++) {
      progress(labels.reading_ai.replace("{n}", String(waiting)));
      const work = await call<{ remaining: number; ai?: boolean }>(supabase, "page-sections", { action: "work", section_id: sectionId });
      if (work.ai === false) break;
      waiting = work.remaining;
    }
    return sent.removed.length > 0;
  } finally {
    await close();
  }
}

/** First checks in the browser (the server checks again): a PDF, at most 10 MB. */
function checkFile(file: File | null): string | null {
  if (!file) return "not_pdf";
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) return "not_pdf";
  if (file.size > MAX_PDF_BYTES) return "too_big";
  return null;
}

/**
 * "Pridať sekciu" (mode "new": the settings and the PDF) or "Nahradiť PDF" (mode "replace":
 * only a new PDF for an existing section; its settings and order stay).
 */
export function SectionUploader({
  mode,
  shopId,
  sectionId,
  labels,
}: {
  mode: "new" | "replace";
  shopId: string;
  sectionId?: string;
  labels: Labels;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get("pdf") instanceof File ? (data.get("pdf") as File) : null;
    const bad = checkFile(file && file.size > 0 ? file : null);
    setProblem(null);
    setStatus(null);
    if (bad) {
      setProblem((labels as Record<string, string>)[`error_${bad}`]);
      return;
    }
    setBusy(true);
    try {
      let id = sectionId ?? null;
      if (mode === "new") {
        const created = await createSection({
          shopId,
          title: String(data.get("title") ?? ""),
          display: String(data.get("display") ?? "collapsed"),
          position: String(data.get("position") ?? "after_details"),
          allowDownload: data.get("allow_download") === "on",
          from: String(data.get("from") ?? "") || null,
          until: String(data.get("until") ?? "") || null,
          pageLayout: String(data.get("page_layout") ?? "slider"),
        });
        if ("error" in created) throw new SectionError(created.error, created.error);
        id = created.id;
      }
      const removed = await sendPdf(createClient(), id!, file!, setStatus, labels);
      setStatus(removed ? `${labels.done} ${labels.removed}` : labels.done);
      form.reset();
      router.refresh();
    } catch (e) {
      setStatus(null);
      setProblem(errorText(labels, e));
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const input = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" data-section-upload={mode}>
      {mode === "new" && (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-sm">{labels.field_title}</span>
            <input name="title" required maxLength={80} placeholder={labels.title_hint} className={input} />
          </label>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm">{labels.display}</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="display" value="collapsed" defaultChecked />
              {labels.display_collapsed}
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="display" value="open" />
              {labels.display_open}
            </label>
          </fieldset>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm">{labels.page_layout}</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="page_layout" value="slider" defaultChecked />
              {labels.layout_slider}
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="page_layout" value="stacked" />
              {labels.layout_stacked}
            </label>
            <span className="text-sm text-muted">{labels.layout_hint}</span>
          </fieldset>
          <label className="flex flex-col gap-1">
            <span className="text-sm">{labels.position}</span>
            <select name="position" defaultValue="after_details" className={input}>
              {POSITIONS.map((p) => (
                <option key={p} value={p}>
                  {(labels as Record<string, string>)[`position_${p}`]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="allow_download" />
            {labels.allow_download}
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-sm">{labels.visible_from}</span>
              <input type="date" name="from" className={input} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm">{labels.visible_until}</span>
              <input type="date" name="until" className={input} />
            </label>
          </div>
        </>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-sm">{labels.file}</span>
        <input type="file" name="pdf" accept="application/pdf,.pdf" required className="text-sm" />
      </label>
      <p className="text-sm text-muted" data-format-hint>
        {labels.format_hint}
      </p>
      <button type="submit" disabled={busy} className="self-start rounded border border-foreground px-4 py-2 font-medium disabled:border-line disabled:text-muted">
        {busy ? labels.uploading : mode === "new" ? labels.save_upload : labels.replace}
      </button>
      {status && (
        <p role="status" className="border border-foreground p-3 font-medium" data-upload-status>
          {status}
        </p>
      )}
      {problem && (
        <p role="alert" className="border border-line p-3" data-upload-problem>
          {problem}
        </p>
      )}
    </form>
  );
}
