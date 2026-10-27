"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import { functionFailure } from "@/lib/functionError";
import { DEFAULT_RATIO, ratioSize, type ContentLimits, type SliderRatio } from "@/lib/pageContent";
import { createClient } from "@/lib/supabase/client";
import { openPdf, PictureProblem, preparePicture, sectionPage } from "@/lib/pdfRead";
import { createItem } from "@/app/[lang]/(account)/dashboard/sectionActions";

type Labels = Dictionary["sections"];
type Text = Dictionary["content"];
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

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

function errorText(labels: Labels, text: Text, limits: ContentLimits, e: unknown): string {
  const numbers = { pages: limits.maxPages, mb: Math.round(limits.maxBytes / 1048576), max: limits.maxItems };
  if (e instanceof PictureProblem) {
    return fill(e.code === "too_small" ? text.error_too_small : e.code === "too_big" ? text.error_picture_big : labels.error_picture, { name: e.message, ...numbers });
  }
  const code = e instanceof SectionError ? e.code : (e as { name?: string } | null)?.name === "PasswordException" ? "encrypted" : null;
  const known = code ? ((text as Record<string, string>)[`error_${code}`] ?? (labels as Record<string, string>)[`error_${code}`]) : null;
  if (known && !known.includes("{message}")) return fill(known, numbers);
  if ((e as { name?: string } | null)?.name === "InvalidPDFException") return text.error_not_pdf;
  return fill(labels.error_failed, { message: e instanceof Error ? e.message : String(e) });
}

type PagePictures = { small: Blob; large: Blob; text: string };

/**
 * Sends a new version's pages to page-sections: every page as a picture (a PDF's at 800 and 1600 px, a picture's
 * never larger than it is), the text of every page as written, then "finish" (the new version goes live; until then
 * visitors see the old one). Pages without text (and pictures) are written out by the AI afterwards, a picture also
 * gets its short alt text when the owner gave none.
 */
async function sendPages(
  supabase: Supabase,
  itemId: string,
  version: number,
  count: number,
  draw: (n: number) => Promise<PagePictures>,
  progress: (text: string) => void,
  labels: Labels,
) {
  const texts: { page: number; text: string }[] = [];
  for (let n = 1; n <= count; n++) {
    progress(fill(labels.page_progress, { n, total: count }));
    const page = await draw(n);
    for (const [size, blob] of [[800, page.small], [1600, page.large]] as const) {
      await call(supabase, `page-sections?action=page&section_id=${itemId}&version=${version}&page=${n}&size=${size}`, blob, {
        "Content-Type": blob.type,
      });
    }
    texts.push({ page: n, text: page.text });
  }
  await call(supabase, "page-sections", { action: "text", section_id: itemId, version, pages: texts });
  await call(supabase, "page-sections", { action: "finish", section_id: itemId, version });
  let waiting = texts.filter((t) => !t.text.trim()).length;
  for (let round = 0; waiting > 0 && round < 20; round++) {
    progress(fill(labels.reading_ai, { n: waiting }));
    const work = await call<{ remaining: number; ai?: boolean }>(supabase, "page-sections", { action: "work", section_id: itemId });
    if (work.ai === false) break;
    waiting = work.remaining;
  }
}

/**
 * A PDF, read in the owner's browser (pdf.js: Edge Functions cannot draw PDFs): first the PDF itself (checked and
 * cleaned by page-sections; only the cleaned file is kept), then its pages.
 */
async function sendPdf(supabase: Supabase, itemId: string, file: File, doc: PdfDoc, progress: (text: string) => void, labels: Labels) {
  progress(labels.uploading);
  const sent = await call<{ version: number; pages: number; removed: string[] }>(
    supabase,
    `page-sections?action=pdf&section_id=${itemId}`,
    file,
    { "Content-Type": "application/pdf" },
  );
  await sendPages(supabase, itemId, sent.version, sent.pages, (n) => sectionPage(doc, n), progress, labels);
  return sent.removed.length > 0;
}

/**
 * One picture (update 38): drawn in this browser (upright, place and camera data gone, never cropped, stretched or
 * enlarged; transparency kept in WebP), its original kept privately for "Stiahnuť", then its pictures as one page.
 */
async function sendPicture(
  supabase: Supabase,
  itemId: string,
  prepared: Awaited<ReturnType<typeof preparePicture>>,
  progress: (text: string) => void,
  labels: Labels,
) {
  progress(labels.uploading);
  const sent = await call<{ version: number }>(supabase, "page-sections", {
    action: "pictures",
    section_id: itemId,
    pages: 1,
    bytes: prepared.original.size,
  });
  await call(supabase, `page-sections?action=original&section_id=${itemId}&version=${sent.version}`, prepared.original, {
    "Content-Type": prepared.original.type,
  });
  await sendPages(supabase, itemId, sent.version, 1, async () => ({ small: prepared.small, large: prepared.large, text: "" }), progress, labels);
}

const PICTURE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const isPdf = (f: File) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
const isPicture = (f: File) => PICTURE_TYPES.includes(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name);
const ACCEPT = {
  pdf: "application/pdf,.pdf",
  picture: "image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif",
};

/**
 * "Nahrať do knižnice" (mode "new": a PDF or pictures with their settings; each picture becomes one file) or
 * "Nahradiť súbor" (mode "replace": a new PDF or picture for an existing file; its settings and slot stay). The limits
 * are the shop's plan's (the admin's settings); the server checks everything again.
 */
export function SectionUploader({
  mode,
  shopId,
  itemId,
  itemKind,
  labels,
  text,
  limits,
  room,
  ratio = DEFAULT_RATIO,
}: {
  mode: "new" | "replace";
  shopId: string;
  itemId?: string;
  itemKind?: "pdf" | "picture";
  labels: Labels;
  text: Text;
  limits: ContentLimits;
  /** Files the library may still take (mode "new"). */
  room?: number;
  /** The slider's "Pomer strán slidera" (update 44): the hint names the picture size that fills it. */
  ratio?: SliderRatio;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [kind, setKind] = useState<"pdf" | "picture">(itemKind ?? "pdf");
  /** The chosen files' names, shown next to "Vybrať súbor" (the browser's own file box is hidden). */
  const [names, setNames] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const mb = Math.round(limits.maxBytes / 1048576);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const files = data.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
    setProblem(null);
    setStatus(null);
    if (files.length === 0) return setProblem(kind === "pdf" ? text.error_no_pdf : text.error_no_picture);
    if (kind === "pdf" && (files.length > 1 || !isPdf(files[0]))) return setProblem(text.error_not_pdf);
    if (kind === "picture" && !files.every(isPicture)) return setProblem(text.error_not_picture);
    if (mode === "replace" && files.length > 1) return setProblem(text.error_one_file);
    if (mode === "new" && room !== undefined && files.length > room) return setProblem(fill(text.error_library_full, { n: room }));
    const tooBig = files.find((f) => f.size > limits.maxBytes);
    if (tooBig) return setProblem(fill(labels.error_too_big, { mb }));

    setBusy(true);
    const supabase = createClient();
    let opened: Awaited<ReturnType<typeof openPdf>> | null = null;
    const created: string[] = [];
    try {
      const settings = {
        shopId,
        allowDownload: data.get("allow_download") === "on",
        pageLayout: String(data.get("page_layout") ?? "slider"),
        from: String(data.get("from") ?? "") || null,
        until: String(data.get("until") ?? "") || null,
        addSlot: data.get("add_slot") === "on",
      };
      if (kind === "pdf") {
        // Read and count first: a PDF with a password or too many pages creates no file.
        opened = await openPdf(files[0]);
        if (opened.doc.numPages > limits.maxPages) throw new SectionError("too_many_pages", "too many pages");
        let id = itemId ?? null;
        if (mode === "new") {
          const result = await createItem({ ...settings, kind: "pdf", title: String(data.get("title") ?? ""), fileName: files[0].name, alt: "" });
          if ("error" in result) throw new SectionError(result.error, result.error);
          id = result.id;
          created.push(id);
        }
        const removed = await sendPdf(supabase, id!, files[0], opened.doc, setStatus, labels);
        return done(removed ? "section_uploaded_removed" : "section_uploaded", form);
      }
      for (const [n, file] of files.entries()) {
        const progress = (t: string) => setStatus(files.length > 1 ? `${n + 1} / ${files.length}: ${t}` : t);
        // Opened and drawn first: a picture that is too small or cannot be opened creates nothing.
        progress(fill(text.preparing, { name: file.name }));
        const prepared = await preparePicture(file, limits.maxBytes);
        let id = itemId ?? null;
        if (mode === "new") {
          const one = files.length === 1;
          const result = await createItem({
            ...settings,
            kind: "picture",
            title: one ? String(data.get("title") ?? "") : "",
            fileName: file.name,
            alt: one ? String(data.get("alt") ?? "") : "",
          });
          if ("error" in result) throw new SectionError(result.error, result.error);
          id = result.id;
          created.push(id);
        }
        await sendPicture(supabase, id!, prepared, progress, labels);
      }
      return done("section_uploaded", form);
    } catch (e) {
      // A file made in the library but never finished is removed again (with whatever it stored).
      for (const id of created.slice(-1)) {
        await supabase.functions.invoke("page-sections", { body: { action: "delete", section_id: id } }).catch(() => null);
      }
      setStatus(null);
      setProblem(errorText(labels, text, limits, e));
      router.refresh();
    } finally {
      await opened?.close();
      setBusy(false);
    }
  }

  /** The editor again, with the message (it stays when this form is no longer there). */
  function done(ok: string, form: HTMLFormElement) {
    form.reset();
    setNames([]);
    const url = new URL(window.location.href);
    for (const key of ["ok", "err", "item", "replace"]) url.searchParams.delete(key);
    url.searchParams.set("ok", ok);
    url.searchParams.set("at", "library");
    url.hash = "library";
    router.replace(`${url.pathname}${url.search}${url.hash}`);
    router.refresh();
  }

  const input = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";
  const id = `${mode}-${itemId ?? "new"}`;
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" data-section-upload={mode}>
      {mode === "new" && (
        <fieldset className="flex flex-wrap gap-x-5 gap-y-1">
          <legend className="text-sm">{text.kind}</legend>
          {(["pdf", "picture"] as const).map((k) => (
            <label key={k} className="flex items-center gap-2">
              <input
                type="radio"
                name="kind"
                value={k}
                checked={kind === k}
                onChange={() => {
                  setKind(k);
                  setNames([]);
                  if (fileInput.current) fileInput.current.value = "";
                }}
              />
              {k === "pdf" ? text.kind_pdf : text.kind_pictures}
            </label>
          ))}
        </fieldset>
      )}
      <div className="flex flex-col gap-1">
        <span className="text-sm" id={`${id}-file-label`}>
          {kind === "pdf" ? text.file_pdf : mode === "new" ? text.file_pictures : text.file_picture}
        </span>
        <input
          ref={fileInput}
          type="file"
          name="file"
          accept={ACCEPT[kind]}
          multiple={kind === "picture" && mode === "new"}
          onChange={(event) => setNames(Array.from(event.currentTarget.files ?? []).map((f) => f.name))}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
        />
        {/* Blue and underlined like the shop logo's "Vybrať obrázok", as the owner asked; no "No file chosen". */}
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
            aria-labelledby={`${id}-file-label ${id}-file-choose`}
            id={`${id}-file-choose`}
            className="self-start text-blue-700 underline underline-offset-4 hover:text-blue-900 disabled:text-muted disabled:no-underline"
            data-choose-file
          >
            {labels.choose_file}
          </button>
          {names.length > 0 && (
            <span className="min-w-0 break-all text-sm text-muted" aria-live="polite" data-chosen-files>
              {names.join(", ")}
            </span>
          )}
        </span>
      </div>
      <p className="text-sm text-muted" data-format-hint>
        {kind === "pdf" ? fill(text.pdf_hint, { pages: limits.maxPages, mb }) : fill(text.picture_hint, { mb })}
      </p>
      <p className="text-sm text-muted" data-fill-hint>
        {fill(text.fill_hint, { ratio, size: ratioSize(ratio) })}
      </p>
      {mode === "new" && (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-sm">{kind === "pdf" ? text.title_pdf : text.title_picture}</span>
            <input name="title" required={kind === "pdf"} maxLength={80} placeholder={kind === "pdf" ? text.title_pdf_hint : ""} className={input} />
          </label>
          {kind === "picture" && (
            <label className="flex flex-col gap-1">
              <span className="text-sm">{text.alt_label}</span>
              <input name="alt" maxLength={250} className={input} aria-describedby={`${id}-alt-hint`} />
              <span id={`${id}-alt-hint`} className="text-sm text-muted">
                {text.alt_hint}
              </span>
            </label>
          )}
          {kind === "pdf" && (
            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm">{text.viewer}</legend>
              {(["slider", "stacked"] as const).map((l) => (
                <label key={l} className="flex items-center gap-2">
                  <input type="radio" name="page_layout" value={l} defaultChecked={l === "slider"} />
                  {l === "slider" ? labels.layout_slider : labels.layout_stacked}
                </label>
              ))}
              <span className="text-sm text-muted">{text.viewer_hint}</span>
            </fieldset>
          )}
          <label className="flex items-center gap-2">
            <input type="checkbox" name="allow_download" />
            {kind === "pdf" ? text.download_pdf_allow : text.download_picture_allow}
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
          <label className="flex items-center gap-2">
            <input type="checkbox" name="add_slot" defaultChecked />
            {text.add_to_slider}
          </label>
        </>
      )}
      <button type="submit" disabled={busy} className="self-start rounded border border-foreground px-4 py-2 font-medium disabled:border-line disabled:text-muted">
        {busy ? labels.uploading : mode === "new" ? text.upload : text.replace_file}
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
