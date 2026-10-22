"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import { functionFailure } from "@/lib/functionError";
import { createClient } from "@/lib/supabase/client";
import { canvasBlob, fitCanvas, openPdf, pagePicture, readPage, type PdfPicture } from "@/lib/pdfRead";

type Labels = Dictionary["docs"];
export interface FolderOption {
  id: string;
  name: string;
}

const BUCKET = "shop-docs";
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_PICTURE_BYTES = 10 * 1024 * 1024;
/** Text is sent every 40 pages (or 300 000 characters), pictures 8 at a time. */
const TEXT_PAGES = 40;
const TEXT_CHARS = 300_000;
const PICTURE_BATCH = 8;
/** At most this many pictures are taken out of one PDF. */
const PICTURES_PER_PDF = 100;
/** The viewer's page pictures are registered and confirmed 10 at a time. */
const PAGE_BATCH = 10;

type Supabase = ReturnType<typeof createClient>;

/** An answer of doc-ingest, or its reason as {error, message} (thrown). */
class IngestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function ingest<T>(supabase: Supabase, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>("doc-ingest", { body });
  if (!error) return data as T;
  const failure = await functionFailure(error);
  throw new IngestError(failure.error ?? "failed", failure.error ? (failure.message ?? failure.error) : `doc-ingest ${failure.detail}`);
}

function errorText(labels: Labels, e: unknown): string {
  if (e instanceof IngestError) {
    const known = (labels as Record<string, string>)[`error_${e.code}`];
    if (known && !known.includes("{message}")) return known;
    return labels.error_failed.replace("{message}", e.message);
  }
  const name = (e as { name?: string } | null)?.name;
  if (name === "PasswordException") return labels.error_password;
  if (name === "InvalidPDFException") return labels.error_not_pdf;
  return labels.error_failed.replace("{message}", e instanceof Error ? e.message : String(e));
}

type PdfDoc = Awaited<ReturnType<typeof openPdf>>["doc"];

/**
 * Every page as a picture for shoppers with an access key (the viewer shows pages, never the
 * PDF itself; database update 24). Made here, uploaded straight to storage, then confirmed.
 */
export async function sendPagePictures(supabase: Supabase, documentId: string, doc: PdfDoc, progress: (n: number, total: number) => void) {
  for (let first = 1; first <= doc.numPages; first += PAGE_BATCH) {
    const made: { page: number; blob: Blob; width: number; height: number }[] = [];
    for (let n = first; n < first + PAGE_BATCH && n <= doc.numPages; n++) {
      progress(n, doc.numPages);
      made.push({ page: n, ...(await pagePicture(doc, n)) });
    }
    const registered = await ingest<{ pages: { page: number; path: string }[] }>(supabase, {
      action: "register_pages",
      document_id: documentId,
      pages: made.map((p) => ({ page: p.page, bytes: p.blob.size, type: p.blob.type, width: p.width, height: p.height })),
    });
    for (const { page, path } of registered.pages) {
      const picture = made.find((p) => p.page === page);
      if (picture) await upload(supabase, path, picture.blob, picture.blob.type);
    }
    await ingest(supabase, { action: "pages_uploaded", document_id: documentId, pages: registered.pages.map((p) => p.page) });
  }
}

async function upload(supabase: Supabase, path: string, blob: Blob, type: string) {
  // Storage takes the type from the file itself (a PDF may come without one).
  const body = blob.type === type ? blob : new Blob([blob], { type });
  const { error } = await supabase.storage.from(BUCKET).upload(path, body, { contentType: type, upsert: false });
  if (error) throw new IngestError("storage", error.message);
}

/** Registers, uploads and marks pictures; returns how many were taken (the shop limit may stop some). */
async function sendPictures(
  supabase: Supabase,
  where: { shop_id: string; folder_id?: string; document_id?: string; lang: string },
  items: { blob: Blob; page?: number; kind?: "picture" | "scan"; title?: string; caption?: string }[],
): Promise<number> {
  if (items.length === 0) return 0;
  const { pictures } = await ingest<{ pictures: { idx: number; picture_id: string | null; path: string | null }[] }>(supabase, {
    action: "register_pictures",
    ...where,
    items: items.map((p) => ({
      page: p.page ?? null,
      kind: p.kind ?? "picture",
      title: p.title ?? "",
      caption: p.caption ?? "",
      bytes: p.blob.size,
      type: p.blob.type,
    })),
  });
  const done: string[] = [];
  for (const row of pictures) {
    if (!row.picture_id || !row.path) continue;
    const item = items[row.idx];
    await upload(supabase, row.path, item.blob, item.blob.type);
    done.push(row.picture_id);
  }
  if (done.length) await ingest(supabase, { action: "pictures_uploaded", shop_id: where.shop_id, picture_ids: done });
  return done.length;
}

/**
 * The AI looks at the waiting pictures and scanned pages, a few per call, until none are
 * left (or the AI is not set up). Pictures not finished now are continued next time the
 * owner opens this page.
 */
async function runWork(supabase: Supabase, shopId: string, progress: (left: number) => void): Promise<"done" | "ai_off"> {
  let idle = 0;
  for (let round = 0; round < 500; round++) {
    const r = await ingest<{ done: number; failed: number; remaining: number; ai?: boolean; plan?: boolean }>(supabase, {
      action: "work",
      shop_id: shopId,
    });
    if (r.ai === false) return "ai_off";
    if (r.plan === false || r.remaining === 0) return "done";
    progress(r.remaining);
    // Another window may be working on them: wait a little.
    if (r.done + r.failed === 0) {
      if (++idle > 20) return "done";
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } else idle = 0;
  }
  return "done";
}

function useWork(shopId: string, labels: Labels) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const start = async () => {
    const supabase = createClient();
    try {
      const outcome = await runWork(supabase, shopId, (left) => setStatus(labels.ai_working.replace("{n}", String(left))));
      setStatus(outcome === "ai_off" ? labels.ai_off : null);
    } catch (e) {
      setStatus(errorText(labels, e));
    }
    router.refresh();
  };
  return { status, setStatus, start };
}

const inputClass = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";

function FolderSelect({ folders, labels, name = "folder" }: { folders: FolderOption[]; labels: Labels; name?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm">{labels.folder}</span>
      <select name={name} className={`${inputClass} w-full min-w-0 bg-white`} defaultValue={folders[0]?.id}>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** At most this many files are taken in one upload. */
const MAX_FILES = 20;
const PICTURE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const isPdf = (f: File) => f.type === "application/pdf" || (!f.type && /\.pdf$/i.test(f.name));
const isPicture = (f: File) => PICTURE_TYPES.includes(f.type);
const baseName = (f: File) => f.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 200);
const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? `{${k}}`));

/**
 * One PDF: read here, uploaded unchanged, its text and pictures sent for the assistant, then its page pictures for
 * the viewer. Returns how many pictures it took; an upload stopped half-way is removed again (files and text).
 */
async function sendPdf(
  supabase: Supabase,
  file: File,
  where: { shopId: string; folderId: string; lang: string; name: string; description: string; picturesLeft: number },
  status: (text: string) => void,
  labels: Labels,
): Promise<number> {
  let documentId: string | null = null;
  let pdf: Awaited<ReturnType<typeof openPdf>> | null = null;
  try {
    status(labels.reading_start);
    pdf = await openPdf(file);
    const { lib, doc } = pdf;
    const registered = await ingest<{ document_id: string; path: string }>(supabase, {
      action: "register_document",
      shop_id: where.shopId,
      folder_id: where.folderId,
      name: where.name,
      description: where.description,
      pages: doc.numPages,
      bytes: file.size,
    });
    documentId = registered.document_id;
    status(labels.uploading_pdf);
    await upload(supabase, registered.path, file, "application/pdf");
    await ingest(supabase, { action: "document_uploaded", document_id: documentId });

    const seen = new Set<string>();
    let text: { page: number; text: string }[] = [];
    let chars = 0;
    let queue: PdfPicture[] = [];
    let taken = 0;
    const allowed = Math.min(PICTURES_PER_PDF, Math.max(0, where.picturesLeft));
    const flushText = async () => {
      if (!text.length) return;
      await ingest(supabase, { action: "text", document_id: documentId, pages: text });
      text = [];
      chars = 0;
    };
    const flushPictures = async () => {
      if (!queue.length) return;
      await flushText(); // the document's language is known first
      taken += await sendPictures(supabase, { shop_id: where.shopId, document_id: documentId!, lang: where.lang }, queue);
      queue = [];
    };
    for (let n = 1; n <= doc.numPages; n++) {
      status(fill(labels.reading, { n, total: doc.numPages }));
      const page = await readPage(lib, doc, n, seen, taken + queue.filter((p) => p.kind === "picture").length < allowed);
      if (page.text) {
        text.push({ page: n, text: page.text });
        chars += page.text.length;
      }
      queue.push(...page.pictures);
      if (text.length >= TEXT_PAGES || chars >= TEXT_CHARS) await flushText();
      if (queue.length >= PICTURE_BATCH) await flushPictures();
    }
    await flushText();
    await flushPictures();
    await sendPagePictures(supabase, documentId!, doc, (n, total) => status(fill(labels.preparing_pages, { n, total })));
    await ingest(supabase, { action: "document_done", document_id: documentId });
    documentId = null;
    return taken;
  } catch (e) {
    if (documentId) await ingest(supabase, { action: "delete", kind: "document", id: documentId }).catch(() => {});
    throw e;
  } finally {
    await pdf?.close().catch(() => {});
  }
}

/** A picture made smaller here (at most 1568 px, WebP), never changed otherwise. */
async function shrinkPicture(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    return await canvasBlob(fitCanvas(bitmap, bitmap.width, bitmap.height));
  } finally {
    bitmap.close();
  }
}

/**
 * "Nahrať súbory": one box for PDFs and pictures, several at once (chosen or dropped, up to MAX_FILES). Each file goes
 * its own way — a PDF is read here and uploaded unchanged, a picture is made smaller — into the same folder with the
 * same description; a file that fails is listed and the others still go.
 */
export function DocUpload({
  shopId,
  folders,
  lang,
  picturesLeft,
  labels,
}: {
  shopId: string;
  folders: FolderOption[];
  lang: string;
  picturesLeft: number;
  labels: Labels;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const work = useWork(shopId, labels);

  const add = (chosen: Iterable<File>) => {
    const next = [...files];
    const refused: string[] = [];
    for (const file of chosen) {
      if (next.some((f) => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified)) continue;
      if (!isPdf(file) && !isPicture(file)) refused.push(fill(labels.error_file_type, { name: file.name }));
      else if (isPdf(file) && file.size > MAX_PDF_BYTES) refused.push(`${file.name}: ${labels.error_too_big}`);
      else if (isPicture(file) && file.size > MAX_PICTURE_BYTES) refused.push(`${file.name}: ${labels.error_picture_too_big}`);
      else if (next.length >= MAX_FILES) refused.push(fill(labels.error_too_many, { max: MAX_FILES }));
      else next.push(file);
    }
    setFiles(next);
    setProblems([...new Set(refused)]);
    setSummary(null);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (files.length === 0 || busy) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const folderId = String(form.get("folder"));
    const typed = String(form.get("name") ?? "").trim();
    const description = String(form.get("description") ?? "").trim().slice(0, 500);
    const nameOf = (file: File, i: number) => (typed ? (files.length === 1 ? typed : `${typed} ${i + 1}`) : baseName(file)).slice(0, 200);
    setBusy(true);
    setProblems([]);
    setSummary(null);
    const supabase = createClient();
    const failed: string[] = [];
    let done = 0;
    let left = picturesLeft;
    let limitReached = false;
    // PDFs one by one; pictures are made smaller and sent PICTURE_BATCH at a time.
    let batch: { file: File; blob: Blob; title: string }[] = [];
    const flush = async () => {
      if (!batch.length) return;
      const items = batch;
      batch = [];
      const taken = await sendPictures(
        supabase,
        { shop_id: shopId, folder_id: folderId, lang },
        items.map((p) => ({ blob: p.blob, title: p.title, caption: description })),
      );
      done += taken;
      left -= taken;
      if (taken < items.length) limitReached = true;
    };
    for (const [i, file] of files.entries()) {
      const step = (text: string) => work.setStatus(`${fill(labels.file_progress, { n: i + 1, total: files.length, name: file.name })} ${text}`);
      try {
        if (isPdf(file)) {
          await flush();
          left -= await sendPdf(supabase, file, { shopId, folderId, lang, name: nameOf(file, i), description, picturesLeft: left }, step, labels);
          done++;
        } else {
          step(fill(labels.preparing, { n: i + 1, total: files.length }));
          batch.push({ file, blob: await shrinkPicture(file), title: nameOf(file, i) });
          if (batch.length >= PICTURE_BATCH) await flush();
        }
      } catch (e) {
        if (!isPdf(file)) batch = batch.filter((p) => p.file !== file);
        failed.push(`${file.name}: ${errorText(labels, e)}`);
      }
    }
    try {
      work.setStatus(labels.uploading);
      await flush();
    } catch (e) {
      failed.push(errorText(labels, e));
    }
    if (limitReached) failed.push(labels.error_limit_pictures);
    setSummary(fill(labels.files_done, { n: done, total: files.length }));
    setProblems(failed);
    work.setStatus(null);
    if (done > 0) {
      setFiles([]);
      formElement.reset();
    }
    setBusy(false);
    await work.start();
  };

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-3 border border-line p-3" data-doc-upload>
      <span className="font-medium">{labels.upload_files}</span>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!busy) add(e.dataTransfer.files);
        }}
        className={`flex flex-col gap-2 border border-dashed p-3 ${dragging ? "border-foreground" : "border-line"}`}
      >
        <span className="text-sm">{labels.files_label}</span>
        <input
          ref={input}
          type="file"
          multiple
          accept="application/pdf,.pdf,image/jpeg,image/png,image/webp"
          className="sr-only"
          tabIndex={-1}
          data-doc-files
          onChange={(e) => {
            add(Array.from(e.currentTarget.files ?? []));
            e.currentTarget.value = "";
          }}
        />
        <div className="flex flex-wrap items-center gap-3">
          {/* Blue and underlined like "Vybrať súbor" of the page sections, as the owner asked. */}
          <button
            type="button"
            onClick={() => input.current?.click()}
            disabled={busy}
            className="text-blue-700 underline underline-offset-4 hover:text-blue-900 disabled:text-muted disabled:no-underline"
            data-doc-choose
          >
            {labels.choose_files}
          </button>
          <span className="text-sm text-muted">{fill(labels.drop_files, { max: MAX_FILES })}</span>
        </div>
        {files.length === 0 ? (
          <button type="button" onClick={() => input.current?.click()} disabled={busy} className="self-start text-sm text-blue-700 underline underline-offset-4 hover:text-blue-900">
            {labels.files_none}
          </button>
        ) : (
          <ul className="flex flex-col gap-1 text-sm" data-doc-chosen={files.length}>
            {files.map((file, i) => (
              <li key={`${file.name}-${file.size}-${file.lastModified}`} className="flex items-center justify-between gap-2 border-b border-line pb-1">
                <span className="min-w-0 break-words">
                  {file.name} <span className="text-muted">· {isPdf(file) ? "PDF" : file.type.replace("image/", "").toUpperCase()} · {file.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`}</span>
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setFiles(files.filter((_, j) => j !== i))}
                  aria-label={fill(labels.remove_file, { name: file.name })}
                  className="shrink-0 px-2 text-lg leading-none disabled:text-muted"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-sm">{labels.file_name}</span>
        <input name="name" maxLength={200} className={inputClass} disabled={busy} />
        <span className="text-xs text-muted">{labels.file_name_help}</span>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm">{labels.caption}</span>
        <textarea name="description" maxLength={500} rows={2} className={inputClass} disabled={busy} />
      </label>
      <FolderSelect folders={folders} labels={labels} />
      <p className="text-sm text-muted">{labels.pdf_hint}</p>
      <p className="text-sm text-muted">{labels.pictures_hint}</p>
      <button type="submit" disabled={busy || files.length === 0} className="self-start rounded border border-foreground px-4 py-2 font-medium disabled:text-muted" data-doc-submit>
        {busy ? labels.uploading : files.length > 1 ? fill(labels.upload_n, { n: files.length }) : labels.upload}
      </button>
      {work.status && (
        <p role="status" className="text-sm">
          {work.status}
        </p>
      )}
      {summary && (
        <p role="status" className="text-sm font-medium" data-doc-summary>
          {summary}
        </p>
      )}
      {problems.length > 0 && (
        <ul role="alert" className="flex list-disc flex-col gap-1 pl-5 text-sm" data-doc-problems>
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </form>
  );
}

/** Continues the AI's work left from an earlier visit (shown while something waits). */
export function DocsWork({ shopId, waiting, labels }: { shopId: string; waiting: number; labels: Labels }) {
  const work = useWork(shopId, labels);
  const started = useRef(false);
  useEffect(() => {
    if (started.current || waiting === 0) return;
    started.current = true;
    work.setStatus(labels.ai_working.replace("{n}", String(waiting)));
    void work.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per page load
  }, []);
  return work.status ? (
    <p role="status" className="text-sm">
      {work.status}
    </p>
  ) : null;
}

/**
 * "Pripraviť na zobrazenie" for a PDF uploaded before the viewer existed: this browser opens
 * the owner's own PDF (a 10-minute address) and makes its page pictures, as at upload.
 */
export function PreparePages({ documentId, labels }: { documentId: string; labels: Labels }) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function prepare() {
    setBusy(true);
    const supabase = createClient();
    let pdf: Awaited<ReturnType<typeof openPdf>> | null = null;
    try {
      setStatus(labels.reading_start);
      const { url } = await ingest<{ url: string }>(supabase, { action: "open_file", kind: "document", id: documentId });
      const response = await fetch(url);
      if (!response.ok) throw new Error(String(response.status));
      pdf = await openPdf(await response.blob());
      await sendPagePictures(supabase, documentId, pdf.doc, (n, total) =>
        setStatus(labels.preparing_pages.replace("{n}", String(n)).replace("{total}", String(total))),
      );
      setStatus(labels.pages_ready);
      router.refresh();
    } catch (e) {
      setStatus(errorText(labels, e));
    } finally {
      await pdf?.close().catch(() => {});
      setBusy(false);
    }
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={prepare} disabled={busy} className="underline underline-offset-4 disabled:text-muted" data-prepare-pages>
        {labels.prepare_pages}
      </button>
      {status && <span role="status">{status}</span>}
    </span>
  );
}
