"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import { functionFailure } from "@/lib/functionError";
import { createClient } from "@/lib/supabase/client";
import { openPdf, picturePage, sectionPage } from "@/lib/pdfRead";
import { POSITIONS, type SectionLimits } from "@/lib/sectionLimits";
import { createSection } from "@/app/[lang]/(account)/dashboard/sectionActions";

type Labels = Dictionary["sections"];
type Supabase = ReturnType<typeof createClient>;
type PdfDoc = Awaited<ReturnType<typeof openPdf>>["doc"];

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
  if (code === "picture") return labels.error_picture.replace("{name}", (e as SectionError).message);
  const known = code ? (labels as Record<string, string>)[`error_${code}`] : null;
  if (known && !known.includes("{message}")) return known;
  if ((e as { name?: string } | null)?.name === "InvalidPDFException") return labels.error_not_pdf;
  return labels.error_failed.replace("{message}", e instanceof Error ? e.message : String(e));
}

type PagePictures = { small: Blob; large: Blob; text: string };

/**
 * Sends a new version's pages to page-sections: every page as a picture 800 and 1600 px wide, the
 * text of every page as written, then "finish" (the new version goes live; until then visitors
 * see the old one). Pages without text are written out by the AI afterwards.
 */
async function sendPages(
  supabase: Supabase,
  sectionId: string,
  version: number,
  count: number,
  draw: (n: number) => Promise<PagePictures>,
  progress: (text: string) => void,
  labels: Labels,
) {
  const texts: { page: number; text: string }[] = [];
  for (let n = 1; n <= count; n++) {
    progress(labels.page_progress.replace("{n}", String(n)).replace("{total}", String(count)));
    const page = await draw(n);
    for (const [size, blob] of [[800, page.small], [1600, page.large]] as const) {
      await call(supabase, `page-sections?action=page&section_id=${sectionId}&version=${version}&page=${n}&size=${size}`, blob, {
        "Content-Type": blob.type,
      });
    }
    texts.push({ page: n, text: page.text });
  }
  await call(supabase, "page-sections", { action: "text", section_id: sectionId, version, pages: texts });
  await call(supabase, "page-sections", { action: "finish", section_id: sectionId, version });
  // Pages without a text layer (and pictures): the AI writes them out (as written), a few at a time.
  let waiting = texts.filter((t) => !t.text.trim()).length;
  for (let round = 0; waiting > 0 && round < 20; round++) {
    progress(labels.reading_ai.replace("{n}", String(waiting)));
    const work = await call<{ remaining: number; ai?: boolean }>(supabase, "page-sections", { action: "work", section_id: sectionId });
    if (work.ai === false) break;
    waiting = work.remaining;
  }
}

/**
 * A PDF, read in the owner's browser (pdf.js: Edge Functions cannot draw PDFs): first the PDF
 * itself (checked and cleaned by page-sections; only the cleaned file is kept), then its pages.
 */
async function sendPdf(supabase: Supabase, sectionId: string, file: File, doc: PdfDoc, progress: (text: string) => void, labels: Labels) {
  progress(labels.uploading);
  const sent = await call<{ version: number; pages: number; removed: string[] }>(
    supabase,
    `page-sections?action=pdf&section_id=${sectionId}`,
    file,
    { "Content-Type": "application/pdf" },
  );
  await sendPages(supabase, sectionId, sent.version, sent.pages, (n) => sectionPage(doc, n), progress, labels);
  return sent.removed.length > 0;
}

/**
 * Pictures (database update 31): one picture = one page, in the order of their file names. Only
 * the page pictures drawn here are stored (no PDF; the photo's place data does not survive the
 * redraw); the AI writes out their text for screen readers and search engines.
 */
async function sendPictures(supabase: Supabase, sectionId: string, files: File[], progress: (text: string) => void, labels: Labels) {
  progress(labels.uploading);
  const sent = await call<{ version: number; pages: number }>(supabase, "page-sections", {
    action: "pictures",
    section_id: sectionId,
    pages: files.length,
    bytes: Math.max(...files.map((f) => f.size)),
  });
  await sendPages(supabase, sectionId, sent.version, files.length, async (n) => ({ ...(await picturePage(files[n - 1])), text: "" }), progress, labels);
}

const PICTURE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const isPdf = (f: File) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
const isPicture = (f: File) => PICTURE_TYPES.includes(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name);
type Chosen = { kind: "pdf"; file: File } | { kind: "pictures"; files: File[] };

/**
 * First checks in the browser (the server checks again): one PDF, or pictures (JPG, PNG, WebP;
 * not both), within the plan's pages and MB per file.
 */
function checkFiles(all: File[], limits: SectionLimits): { chosen: Chosen } | { error: string } {
  const files = all.filter((f) => f.size > 0);
  if (files.length === 0) return { error: "not_pdf" };
  if (files.some(isPdf)) {
    if (files.length > 1) return { error: "mixed" };
    return files[0].size > limits.maxBytes ? { error: "too_big" } : { chosen: { kind: "pdf", file: files[0] } };
  }
  if (!files.every(isPicture)) return { error: "not_pdf" };
  if (files.length > limits.maxPages) return { error: "too_many_pictures" };
  if (files.some((f) => f.size > limits.maxBytes)) return { error: "too_big" };
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return { chosen: { kind: "pictures", files: sorted } };
}

/** Every picture must open in this browser (e.g. HEIC opens only in Safari): checked before a section is made. */
async function checkPictures(files: File[]) {
  for (const file of files) {
    try {
      (await createImageBitmap(file)).close();
    } catch {
      throw new SectionError("picture", file.name);
    }
  }
}

/**
 * "Pridať sekciu" (mode "new": the settings and a PDF or pictures) or "Nahradiť" (mode "replace":
 * only a new PDF or new pictures for an existing section; its settings and order stay). The limits are the
 * shop's plan's (the admin's settings, database update 30); the labels come with their numbers
 * filled in. A free shop chooses no position: its sections sit after the opening hours.
 */
export function SectionUploader({
  mode,
  shopId,
  sectionId,
  labels,
  limits,
}: {
  mode: "new" | "replace";
  shopId: string;
  sectionId?: string;
  labels: Labels;
  limits: SectionLimits;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const files = data.getAll("pdf").filter((f): f is File => f instanceof File);
    const checked = checkFiles(files, limits);
    setProblem(null);
    setStatus(null);
    if ("error" in checked) {
      setProblem((labels as Record<string, string>)[`error_${checked.error}`]);
      return;
    }
    const chosen = checked.chosen;
    setBusy(true);
    let opened: Awaited<ReturnType<typeof openPdf>> | null = null;
    let created: string | null = null;
    try {
      // Read and count first: a PDF with a password or too many pages, or a picture this browser
      // cannot open, creates no section.
      if (chosen.kind === "pdf") {
        opened = await openPdf(chosen.file);
        if (opened.doc.numPages > limits.maxPages) throw new SectionError("too_many_pages", "too many pages");
      } else {
        await checkPictures(chosen.files);
      }
      let id = sectionId ?? null;
      if (mode === "new") {
        const result = await createSection({
          shopId,
          title: String(data.get("title") ?? ""),
          display: String(data.get("display") ?? "collapsed"),
          position: String(data.get("position") ?? "after_details"),
          allowDownload: data.get("allow_download") === "on",
          from: String(data.get("from") ?? "") || null,
          until: String(data.get("until") ?? "") || null,
          pageLayout: String(data.get("page_layout") ?? "slider"),
        });
        if ("error" in result) throw new SectionError(result.error, result.error);
        id = created = result.id;
      }
      const removed =
        chosen.kind === "pdf" && opened
          ? await sendPdf(createClient(), id!, chosen.file, opened.doc, setStatus, labels)
          : (await sendPictures(createClient(), id!, (chosen as { files: File[] }).files, setStatus, labels), false);
      if (mode === "new") {
        // The list (and, at the plan's number of sections, the hint instead of this form) comes
        // back with the message: it stays even when this form is no longer there.
        backWith({ ok: removed ? "section_uploaded_removed" : "section_uploaded" });
        return;
      }
      setStatus(removed ? `${labels.done} ${labels.removed}` : labels.done);
      form.reset();
      router.refresh();
    } catch (e) {
      if (created) {
        backWith({ err: `sections_failed:${errorText(labels, e)}` });
        return;
      }
      setStatus(null);
      setProblem(errorText(labels, e));
      router.refresh();
    } finally {
      await opened?.close();
      setBusy(false);
    }
  }

  /** The dashboard again, at "Sekcie stránky (PDF)", with ?ok= or ?err= (shown in the section). */
  function backWith(query: Record<string, string>) {
    const url = new URL(window.location.href);
    for (const key of ["ok", "err", "section", "replace"]) url.searchParams.delete(key);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    url.searchParams.set("at", "sections");
    url.hash = "sections";
    router.replace(`${url.pathname}${url.search}${url.hash}`);
    router.refresh();
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
          {limits.plan === "free" ? (
            <input type="hidden" name="position" value="after_hours" />
          ) : (
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
          )}
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
        <input
          type="file"
          name="pdf"
          accept="application/pdf,.pdf,image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
          multiple
          required
          className="text-sm"
        />
      </label>
      <p className="text-sm text-muted" data-format-hint>
        {labels.format_hint}
      </p>
      <p className="text-sm text-muted" data-pictures-hint>
        {labels.pictures_hint}
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
