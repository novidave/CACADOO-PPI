"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import { createClient } from "@/lib/supabase/client";
import { canvasBlob, fitCanvas, openPdf, readPage, type PdfPicture } from "@/lib/pdfRead";

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
  const context = (error as { context?: unknown }).context;
  const reply = context instanceof Response ? await context.json().catch(() => null) : null;
  throw new IngestError(String(reply?.error ?? "failed"), String(reply?.message ?? error.message));
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

/** "Upload a PDF": read here, uploaded unchanged, its text and pictures sent for the assistant. */
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
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const work = useWork(shopId, labels);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return;
    if (file.size > MAX_PDF_BYTES) return work.setStatus(labels.error_too_big);
    if (file.type && file.type !== "application/pdf") return work.setStatus(labels.error_not_pdf);
    setBusy(true);
    const supabase = createClient();
    let documentId: string | null = null;
    let pdf: Awaited<ReturnType<typeof openPdf>> | null = null;
    try {
      work.setStatus(labels.reading_start);
      pdf = await openPdf(file);
      const { lib, doc } = pdf;
      const registered = await ingest<{ document_id: string; path: string }>(supabase, {
        action: "register_document",
        shop_id: shopId,
        folder_id: String(form.get("folder")),
        name: String(form.get("name") || file.name.replace(/\.pdf$/i, "")).slice(0, 200),
        description: String(form.get("description") ?? "").slice(0, 500),
        pages: doc.numPages,
        bytes: file.size,
      });
      documentId = registered.document_id;
      work.setStatus(labels.uploading_pdf);
      await upload(supabase, registered.path, file, "application/pdf");
      await ingest(supabase, { action: "document_uploaded", document_id: documentId });

      const seen = new Set<string>();
      let text: { page: number; text: string }[] = [];
      let chars = 0;
      let queue: PdfPicture[] = [];
      let taken = 0;
      const allowed = Math.min(PICTURES_PER_PDF, Math.max(0, picturesLeft));
      const flushText = async () => {
        if (!text.length) return;
        await ingest(supabase, { action: "text", document_id: documentId, pages: text });
        text = [];
        chars = 0;
      };
      const flushPictures = async () => {
        if (!queue.length) return;
        await flushText(); // the document's language is known first
        taken += await sendPictures(supabase, { shop_id: shopId, document_id: documentId!, lang }, queue);
        queue = [];
      };
      for (let n = 1; n <= doc.numPages; n++) {
        work.setStatus(labels.reading.replace("{n}", String(n)).replace("{total}", String(doc.numPages)));
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
      await ingest(supabase, { action: "document_done", document_id: documentId });
      documentId = null;
      formElement.reset();
      setName("");
      setBusy(false);
      await work.start();
    } catch (e) {
      work.setStatus(errorText(labels, e));
      // An upload stopped half-way is removed again (files and text).
      if (documentId) await ingest(supabase, { action: "delete", kind: "document", id: documentId }).catch(() => {});
      setBusy(false);
    } finally {
      await pdf?.close().catch(() => {});
    }
  };

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-3 border border-line p-3">
      <span className="font-medium">{labels.upload_pdf}</span>
      <label className="flex flex-col gap-1">
        <span className="text-sm">{labels.pdf_file}</span>
        <input
          type="file"
          name="file"
          accept="application/pdf,.pdf"
          required
          className="max-w-full text-sm"
          disabled={busy}
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            if (f && !name) setName(f.name.replace(/\.pdf$/i, "").slice(0, 200));
          }}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm">{labels.name}</span>
        <input name="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} className={inputClass} disabled={busy} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm">{labels.description}</span>
        <textarea name="description" maxLength={500} rows={2} className={inputClass} disabled={busy} />
      </label>
      <FolderSelect folders={folders} labels={labels} />
      <p className="text-sm text-muted">{labels.pdf_hint}</p>
      <button type="submit" disabled={busy} className="self-start rounded border border-foreground px-4 py-2 font-medium disabled:text-muted">
        {busy ? labels.uploading : labels.upload}
      </button>
      {work.status && (
        <p role="status" className="text-sm">
          {work.status}
        </p>
      )}
    </form>
  );
}

/** Pictures the owner adds: made smaller here (at most 1568 px, WebP), never changed otherwise. */
export function PictureUpload({
  shopId,
  folders,
  lang,
  labels,
}: {
  shopId: string;
  folders: FolderOption[];
  lang: string;
  labels: Labels;
}) {
  const [busy, setBusy] = useState(false);
  const work = useWork(shopId, labels);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length === 0) return;
    if (files.some((f) => f.size > MAX_PICTURE_BYTES)) return work.setStatus(labels.error_picture_too_big);
    if (files.some((f) => !["image/jpeg", "image/png", "image/webp"].includes(f.type))) {
      return work.setStatus(labels.error_picture_type);
    }
    setBusy(true);
    const supabase = createClient();
    try {
      const title = String(form.get("title") ?? "").trim();
      const caption = String(form.get("caption") ?? "").trim();
      const items = [];
      for (const [i, file] of files.entries()) {
        work.setStatus(labels.preparing.replace("{n}", String(i + 1)).replace("{total}", String(files.length)));
        const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
        const blob = await canvasBlob(fitCanvas(bitmap, bitmap.width, bitmap.height));
        bitmap.close();
        items.push({
          blob,
          title: (files.length === 1 && title ? title : title ? `${title} ${i + 1}` : file.name.replace(/\.[a-z]+$/i, "")).slice(0, 200),
          caption,
        });
      }
      work.setStatus(labels.uploading);
      let taken = 0;
      for (let i = 0; i < items.length; i += PICTURE_BATCH) {
        taken += await sendPictures(supabase, { shop_id: shopId, folder_id: String(form.get("folder")), lang }, items.slice(i, i + PICTURE_BATCH));
      }
      formElement.reset();
      setBusy(false);
      if (taken < items.length) work.setStatus(labels.error_limit_pictures);
      await work.start();
    } catch (e) {
      work.setStatus(errorText(labels, e));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-3 border border-line p-3">
      <span className="font-medium">{labels.upload_pictures}</span>
      <label className="flex flex-col gap-1">
        <span className="text-sm">{labels.picture_files}</span>
        <input type="file" name="files" accept="image/jpeg,image/png,image/webp" multiple required disabled={busy} className="max-w-full text-sm" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm">{labels.picture_title}</span>
        <input name="title" maxLength={200} className={inputClass} disabled={busy} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm">{labels.caption}</span>
        <textarea name="caption" maxLength={500} rows={2} className={inputClass} disabled={busy} />
      </label>
      <FolderSelect folders={folders} labels={labels} />
      <p className="text-sm text-muted">{labels.pictures_hint}</p>
      <button type="submit" disabled={busy} className="self-start rounded border border-foreground px-4 py-2 font-medium disabled:text-muted">
        {busy ? labels.uploading : labels.upload}
      </button>
      {work.status && (
        <p role="status" className="text-sm">
          {work.status}
        </p>
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
