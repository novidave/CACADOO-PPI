"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import type { ChatCard, ChatDocPrice, ChatListItem, ChatReply, ChatSource, ChatTurn } from "@/lib/shopChat";

/** Anthropic's recommended longest side for photos; larger ones only cost more. */
const MAX_SIDE = 1568;
/** A picture for the AI over this (base64 characters) is made smaller, so four fit in one request. */
const MAX_PHOTO_CHARS = 900_000;
/** The small copy kept in the shop's archive (the owner's view and the PDF). */
const PREVIEW_SIDE = 800;
/** Earlier messages sent along with a new one (the server keeps at most this many too). */
const HISTORY = 8;
const MAX_FILE = 10 * 1024 * 1024;
const PER_MESSAGE = 4;
const PER_CONVERSATION = 10;
/** The first pages of a PDF are read in this browser; only their text goes to the AI. */
const PDF_PAGES = 5;
const PDF_TEXT = 12_000;

type Labels = Dictionary["chat"];
type Kind = "jpeg" | "png" | "webp" | "heic" | "pdf";

interface Conversation {
  id: string;
  token: string;
}

/** A file chosen for the next message. */
interface Attachment {
  key: number;
  file: File;
  name: string;
  kind: Kind;
  /** Local address of the small copy (pictures this browser can read). */
  preview: string | null;
  previewBlob: Blob | null;
  /** What the AI gets: the picture as a JPEG (base64) or the PDF's text. */
  image: string | null;
  text: string | null;
  /** The file's id in the shop's archive, once stored. */
  id: string | null;
  ready: boolean;
}

interface SentFile {
  name: string;
  kind: Kind;
  preview: string | null;
}

type Entry =
  | { role: "user"; text: string; files: SentFile[] }
  | { role: "assistant"; reply: ChatReply }
  | { role: "error"; text: string }
  | { role: "notice"; text: string };

const ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,application/pdf,.pdf";

/** The type from the browser or the name; the archive checks the real content again. */
function kindOf(file: File): Kind | null {
  const type = file.type.toLowerCase();
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  if (type === "image/jpeg" || ext === "jpg" || ext === "jpeg") return "jpeg";
  if (type === "image/png" || ext === "png") return "png";
  if (type === "image/webp" || ext === "webp") return "webp";
  if (type === "image/heic" || type === "image/heif" || ext === "heic" || ext === "heif") return "heic";
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  return null;
}

/** A JPEG copy of the picture, at most `side` px (white behind transparent parts). */
async function jpeg(bitmap: ImageBitmap, side: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new Error("no JPEG");
  return blob;
}

async function base64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

/**
 * The picture for the AI (at most 1568 px) and a small copy for the archive, both new
 * JPEGs without any of the photo's data (GPS included). Null when this browser cannot
 * read the picture (e.g. HEIC outside Safari): it is then only stored.
 */
async function pictureCopies(file: File): Promise<{ image: string; preview: Blob } | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return null;
  }
  try {
    let image = await base64(await jpeg(bitmap, MAX_SIDE, 0.85));
    if (image.length > MAX_PHOTO_CHARS) image = await base64(await jpeg(bitmap, 1100, 0.8));
    return { image, preview: await jpeg(bitmap, PREVIEW_SIDE, 0.8) };
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}

/** The text of a PDF's first pages, read in this browser with pdf.js; null when it cannot be read. */
async function pdfText(file: File): Promise<string | null> {
  try {
    const { openPdf, readText } = await import("@/lib/pdfRead");
    const { doc, close } = await openPdf(file);
    try {
      const parts: string[] = [];
      let length = 0;
      for (let n = 1; n <= Math.min(doc.numPages, PDF_PAGES) && length < PDF_TEXT; n++) {
        const text = await readText(doc, n);
        if (text) {
          parts.push(text);
          length += text.length;
        }
      }
      return parts.join("\n\n").slice(0, PDF_TEXT);
    } finally {
      await close();
    }
  } catch {
    return null;
  }
}

const isConversation = (value: unknown): value is Conversation =>
  Boolean(value) && typeof (value as Conversation).id === "string" && typeof (value as Conversation).token === "string";

/** The conversation so far as plain text for the next message (files are never sent again). */
function toHistory(entries: Entry[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const entry of entries) {
    if (entry.role === "user") {
      const names = entry.files.map((f) => f.name).join(", ");
      turns.push({ role: "user", text: `${entry.text}${names ? ` [files: ${names}]` : ""}`.trim() });
    }
    if (entry.role === "assistant") {
      const { reply } = entry;
      const shown = [...reply.cards, ...reply.list].map((item) => item.name);
      const sources = (reply.sources ?? []).map((s) => (s.page ? `${s.name} p. ${s.page}` : s.name));
      turns.push({
        role: "assistant",
        text: [
          reply.photo ? `(Read from the photo: ${reply.photo.read}; match: ${reply.photo.match})` : "",
          reply.answer,
          shown.length ? `(Items shown: ${[...new Set(shown)].join("; ")})` : "",
          sources.length ? `(Sources: ${sources.join("; ")})` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      });
    }
  }
  return turns.slice(-HISTORY);
}

/**
 * The shop's AI assistant: a collapsible box on the shop page (paid plan only). Answers
 * about this shop's items, makes shopping lists and reads photos and PDFs. With the
 * archive on, every conversation is kept for the shop (files go straight to the archive
 * function; GPS is removed there); it ends when the box is closed, the page is left or
 * after 30 minutes without a message, and the shopper can delete it while the box is open.
 * Everything else on the page is rendered on the server without it.
 */
export function ShopChat({
  slug,
  lang,
  shopName,
  timeZone,
  keys,
  labels,
  buttonLabel,
  welcome,
  archive = false,
}: {
  slug: string;
  lang: string;
  shopName: string;
  timeZone: string;
  /** "I have an access key" for the shop's private folders (when the website can keep sessions). */
  keys: boolean;
  labels: Labels;
  /** The owner's own button label and welcome text (plain text, as written); empty = the default texts. */
  buttonLabel?: string | null;
  welcome?: string | null;
  /** Conversations and files are kept for the shop (the archive is on). */
  archive?: boolean;
}) {
  const title = buttonLabel?.trim() || labels.title;
  const intro = welcome?.trim() || labels.intro;
  const base = `/api/shops/${encodeURIComponent(slug)}`;
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [text, setText] = useState("");
  const [files, setFilesState] = useState<Attachment[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const filesRef = useRef<Attachment[]>([]);
  const conv = useRef<Conversation | null>(null);
  const uploadUrl = useRef<string | null>(null);
  const starting = useRef<Promise<Conversation | null> | null>(null);
  /** Files stored in this conversation so far (10 at most). */
  const used = useRef(0);
  const removed = useRef(new Set<number>());
  const nextKey = useRef(1);
  const fileInput = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);

  const putFiles = (next: Attachment[]) => {
    filesRef.current = next;
    setFilesState(next);
  };
  const remember = useCallback((next: Conversation | null) => {
    if (next?.id !== conv.current?.id) used.current = 0;
    conv.current = next;
    setConversation(next);
  }, []);

  /** Ends the conversation on the server (its PDF is made there); a beacon when the page is going away. */
  const finish = useCallback(
    (reason: "closed" | "new", beacon = false) => {
      const current = conv.current;
      conv.current = null;
      used.current = 0;
      if (!current) return;
      const body = JSON.stringify({ action: "end", reason, ...current });
      if (beacon && typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon(`${base}/conversation`, new Blob([body], { type: "application/json" }));
      } else {
        fetch(`${base}/conversation`, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(
          () => {},
        );
      }
    },
    [base],
  );

  // Leaving the page (or this box going away) closes the chat.
  useEffect(() => {
    if (!archive) return;
    const hide = () => finish("closed", true);
    window.addEventListener("pagehide", hide);
    return () => {
      window.removeEventListener("pagehide", hide);
      finish("closed", true);
    };
  }, [archive, finish]);

  useEffect(() => {
    if (entries.length || busy) end.current?.scrollIntoView({ block: "nearest" });
  }, [entries, busy]);

  const errorText = (code: unknown) => {
    if (code === "caller_limit") return labels.error_caller_limit;
    if (code === "shop_limit") return labels.error_shop_limit;
    if (code === "bad_photo") return labels.error_photo;
    return labels.error_failed;
  };

  function reset() {
    for (const entry of entries) {
      if (entry.role === "user") for (const f of entry.files) if (f.preview) URL.revokeObjectURL(f.preview);
    }
    for (const f of filesRef.current) {
      removed.current.add(f.key);
      if (f.preview) URL.revokeObjectURL(f.preview);
    }
    putFiles([]);
    setEntries([]);
    setProblem(null);
    setConversation(null);
  }

  function toggle() {
    // Closing the box ends the conversation: it is kept for the shop as it is.
    if (open && archive) {
      finish("closed");
      reset();
    }
    setOpen(!open);
  }

  function startOver() {
    finish("new");
    reset();
  }

  /** The conversation the files go into: started on the first file or message. */
  function ensureConversation(): Promise<Conversation | null> {
    if (conv.current) return Promise.resolve(conv.current);
    starting.current ??= fetch(`${base}/conversation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start", lang }),
    })
      .then(async (response) => {
        const data = (await response.json().catch(() => null)) as (Conversation & { upload?: unknown }) | null;
        if (!response.ok || !isConversation(data)) return null;
        uploadUrl.current = typeof data.upload === "string" ? data.upload : null;
        remember({ id: data.id, token: data.token });
        return conv.current;
      })
      .catch(() => null)
      .finally(() => {
        starting.current = null;
      });
    return starting.current;
  }

  /** Stores one file in the shop's archive (straight to the archive function, not through this website). */
  async function store(item: Attachment, again = true): Promise<{ id: string; kind: Kind } | { error: string }> {
    const current = await ensureConversation();
    if (!current || !uploadUrl.current) return { error: "failed" };
    const form = new FormData();
    form.set("id", current.id);
    form.set("token", current.token);
    form.set("file", item.file, item.name);
    if (item.previewBlob) form.set("preview", item.previewBlob, "preview.jpg");
    try {
      const response = await fetch(uploadUrl.current, { method: "POST", body: form });
      const data = await response.json().catch(() => ({}));
      if (response.ok && typeof data.id === "string") {
        used.current++;
        return { id: data.id, kind: (data.kind as Kind) ?? item.kind };
      }
      // Ended meanwhile (30 minutes without a message): a new conversation takes the file,
      // unless the shopper took it back or closed the chat in the meantime.
      if (data.error === "ended" && again && !removed.current.has(item.key)) {
        remember(null);
        return store(item, false);
      }
      return { error: typeof data.error === "string" ? data.error : "failed" };
    } catch {
      return { error: "failed" };
    }
  }

  /** A stored file taken back before sending: deleted from the archive too. */
  function discard(id: string) {
    const current = conv.current;
    if (!current) return;
    used.current = Math.max(0, used.current - 1);
    fetch(`${base}/conversation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "discard", ...current, attachment: id }),
    }).catch(() => {});
  }

  function remove(key: number) {
    const item = filesRef.current.find((f) => f.key === key);
    removed.current.add(key);
    if (item?.preview) URL.revokeObjectURL(item.preview);
    if (item?.id) discard(item.id);
    putFiles(filesRef.current.filter((f) => f.key !== key));
  }

  /** Makes the AI's copy (picture or PDF text) and, with the archive, stores the file; null = left out. */
  async function prepare(item: Attachment): Promise<Attachment | null> {
    const done: Attachment = { ...item };
    if (item.kind === "pdf") {
      done.text = await pdfText(item.file);
    } else {
      const copies = await pictureCopies(item.file);
      if (copies) {
        done.image = copies.image;
        done.previewBlob = copies.preview;
        done.preview = URL.createObjectURL(copies.preview);
      } else if (!archive) {
        // Not stored and not readable here: of no use to the assistant.
        setProblem(labels.error_photo);
        return null;
      }
    }
    if (archive) {
      const stored = await store(done);
      if ("error" in stored) {
        if (done.preview) URL.revokeObjectURL(done.preview);
        setProblem(
          stored.error === "too_big"
            ? labels.file_too_big
            : stored.error === "type"
              ? labels.file_type
              : stored.error === "too_many_files"
                ? labels.file_limit
                : labels.file_failed,
        );
        return null;
      }
      done.id = stored.id;
      // The content decides: a "photo" that is really a PDF is not shown to the AI as a picture.
      if (stored.kind === "pdf" && done.kind !== "pdf") done.image = null;
      done.kind = stored.kind;
    }
    done.ready = true;
    return done;
  }

  async function choose(event: React.ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    setProblem(null);
    const waiting = filesRef.current.filter((f) => !f.id).length;
    const room = Math.min(
      PER_MESSAGE - filesRef.current.length,
      archive ? PER_CONVERSATION - used.current - waiting : PER_MESSAGE,
    );
    const accepted: Attachment[] = [];
    let issue: string | null = null;
    for (const file of chosen) {
      const kind = kindOf(file);
      if (!kind) issue = labels.file_type;
      else if (file.size > MAX_FILE) issue = labels.file_too_big;
      else if (accepted.length >= room) issue = labels.file_limit;
      else
        accepted.push({
          key: nextKey.current++,
          file,
          name: file.name,
          kind,
          preview: null,
          previewBlob: null,
          image: null,
          text: null,
          id: null,
          ready: false,
        });
    }
    setProblem(issue);
    if (!accepted.length) return;
    putFiles([...filesRef.current, ...accepted]);
    for (const item of accepted) {
      const ready = await prepare(item);
      if (removed.current.has(item.key)) {
        // Taken back (or the chat was closed) while it was being stored.
        if (ready?.id) discard(ready.id);
        if (ready?.preview) URL.revokeObjectURL(ready.preview);
        continue;
      }
      putFiles(ready ? filesRef.current.map((f) => (f.key === item.key ? ready : f)) : filesRef.current.filter((f) => f.key !== item.key));
    }
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const message = text.trim();
    const ready = filesRef.current.filter((f) => f.ready);
    if (busy || filesRef.current.some((f) => !f.ready) || (!message && ready.length === 0)) return;
    const history = toHistory(entries);
    setEntries((now) => [
      ...now,
      { role: "user", text: message, files: ready.map((f) => ({ name: f.name, kind: f.kind, preview: f.preview })) },
    ]);
    setText("");
    putFiles([]);
    setProblem(null);
    setBusy(true);
    try {
      const response = await fetch(`${base}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The files go once, with this message only.
        body: JSON.stringify({
          lang,
          history,
          message,
          conversation: archive ? conv.current : null,
          attachments: ready.map((f) => ({ id: f.id, name: f.name, kind: f.kind, image: f.image, text: f.text })),
        }),
      });
      const data = await response.json().catch(() => ({ error: "failed" }));
      if (response.ok && !data.error) {
        if (archive) remember(isConversation(data.conversation) ? data.conversation : null);
        setEntries((now) => [...now, { role: "assistant", reply: data as ChatReply }]);
      } else {
        setEntries((now) => [...now, { role: "error", text: `${errorText(data.error)}${data.reason ? ` (${data.reason})` : ""}` }]);
      }
    } catch {
      setEntries((now) => [...now, { role: "error", text: labels.error_failed }]);
    } finally {
      setBusy(false);
    }
  }

  /** "Vymazať moju konverzáciu": the conversation and its files are deleted for good. */
  async function deleteMine() {
    const current = conv.current;
    if (!current || busy || !window.confirm(labels.delete_confirm)) return;
    setBusy(true);
    try {
      const response = await fetch(`${base}/conversation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", ...current }),
      });
      if (!response.ok) throw new Error("not deleted");
      conv.current = null;
      used.current = 0;
      reset();
      setEntries([{ role: "notice", text: labels.deleted }]);
    } catch {
      setEntries((now) => [...now, { role: "error", text: labels.delete_failed }]);
    } finally {
      setBusy(false);
    }
  }

  const preparing = files.some((f) => !f.ready);

  return (
    <section className="border border-line" aria-label={title}>
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex w-full items-center justify-between gap-3 p-3 text-left font-semibold"
      >
        <span>{title}</span>
        <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-line p-3">
          <p className="text-sm text-muted" data-chat-welcome>
            {intro}
          </p>
          {archive && (
            <p className="text-xs text-muted" data-chat-privacy>
              {labels.privacy_notice.replace("{shop}", shopName)}{" "}
              <Link href={`/${lang}/sukromie-asistent`} className="underline underline-offset-4">
                {labels.privacy_more}
              </Link>
            </p>
          )}
          {entries.length > 0 && (
            <ol className="flex flex-col gap-4" aria-live="polite">
              {entries.map((entry, i) => (
                <li key={i} className="flex flex-col gap-2">
                  {entry.role === "user" && (
                    <>
                      <span className="text-xs text-muted">{labels.you}</span>
                      {entry.files.length > 0 && <FileList files={entry.files} labels={labels} />}
                      {entry.text && <p className="whitespace-pre-line">{entry.text}</p>}
                    </>
                  )}
                  {entry.role === "assistant" && <Answer reply={entry.reply} labels={labels} shopName={shopName} />}
                  {entry.role === "error" && <p className="border border-line p-2 text-sm">{entry.text}</p>}
                  {entry.role === "notice" && (
                    <p role="status" className="border border-foreground p-2 text-sm font-medium">
                      {entry.text}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
          {busy && (
            <p role="status" className="text-sm text-muted">
              {labels.thinking}
            </p>
          )}
          <div ref={end} />
          <form onSubmit={send} className="flex flex-col gap-2">
            {files.length > 0 && (
              <ul className="flex flex-wrap gap-3" aria-label={labels.photo}>
                {files.map((f) => (
                  <li key={f.key} className="flex items-center gap-2 text-sm" data-chat-file={f.ready ? "ready" : "working"}>
                    {f.preview ? (
                      // eslint-disable-next-line @next/next/no-img-element -- local preview of the chosen picture
                      <img src={f.preview} alt="" className="h-14 w-14 border border-line object-cover" />
                    ) : (
                      <span className="max-w-40 truncate border border-line px-2 py-1" title={f.name}>
                        {f.name}
                      </span>
                    )}
                    {!f.ready && <span className="text-muted">{labels.file_working}</span>}
                    <button type="button" onClick={() => remove(f.key)} className="underline underline-offset-4">
                      {labels.file_remove}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {problem && (
              <p className="text-sm" role="alert">
                {problem}
              </p>
            )}
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              rows={2}
              maxLength={1500}
              placeholder={labels.placeholder}
              aria-label={labels.placeholder}
              className="rounded border border-line px-3 py-2 outline-none focus:border-foreground"
            />
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInput}
                type="file"
                accept={ACCEPT}
                multiple
                onChange={choose}
                className="sr-only"
                tabIndex={-1}
                data-chat-input
              />
              <button type="button" onClick={() => fileInput.current?.click()} className="rounded border border-line px-3 py-2">
                {labels.photo}
              </button>
              <button
                type="submit"
                disabled={busy || preparing || (!text.trim() && files.length === 0)}
                className="rounded border border-foreground px-4 py-2 font-medium disabled:text-muted"
              >
                {labels.send}
              </button>
              {entries.length > 0 && (
                <button type="button" onClick={startOver} className="text-sm underline underline-offset-4">
                  {labels.clear}
                </button>
              )}
              {archive && conversation && (
                <button type="button" onClick={deleteMine} className="text-sm underline underline-offset-4">
                  {labels.delete_mine}
                </button>
              )}
            </div>
            <p className="text-xs text-muted">
              {archive ? labels.files_note : labels.photo_note} {labels.note}
            </p>
          </form>
          {keys && <AccessKey slug={slug} lang={lang} timeZone={timeZone} labels={labels} />}
        </div>
      )}
    </section>
  );
}

/** Files sent with a message: pictures as small previews, others by name. */
function FileList({ files, labels }: { files: SentFile[]; labels: Labels }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {files.map((f, i) => (
        <li key={i} className="text-sm">
          {f.preview ? (
            // eslint-disable-next-line @next/next/no-img-element -- local preview of the sent picture
            <img src={f.preview} alt={f.name} className="h-20 w-20 border border-line object-cover" />
          ) : (
            <span className="text-muted">{(f.kind === "pdf" ? labels.file_pdf : labels.file_other).replace("{name}", f.name)}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * "I have an access key": separate from the chat. The key goes only to the website and
 * the database, never to the AI, and is not kept in the conversation; the session stays
 * in an HttpOnly cookie for this shop (12 hours, or until "Lock again").
 */
function AccessKey({ slug, lang, timeZone, labels }: { slug: string; lang: string; timeZone: string; labels: Labels }) {
  const [open, setOpen] = useState<{ folders: string[]; expires_at: string } | null>(null);
  const [show, setShow] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const address = `/api/shops/${encodeURIComponent(slug)}/access`;

  useEffect(() => {
    let live = true;
    fetch(address)
      .then((r) => r.json())
      .then((data) => live && setOpen(data?.open ?? null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [address]);

  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    if (!key.trim() || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch(address, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: key.trim() }),
      });
      const data = await response.json().catch(() => ({ status: "unavailable" }));
      if (data.status === "ok") {
        setOpen({ folders: data.folders ?? [], expires_at: data.expires_at });
        setShow(false);
      } else {
        setProblem(data.status === "wrong" ? labels.key_wrong : data.status === "too_many" ? labels.key_too_many : labels.key_unavailable);
      }
    } catch {
      setProblem(labels.key_unavailable);
    } finally {
      setKey("");
      setBusy(false);
    }
  }

  async function relock() {
    await fetch(address, { method: "DELETE" }).catch(() => {});
    setOpen(null);
  }

  const until = (iso: string) =>
    new Intl.DateTimeFormat(lang, { timeZone, dateStyle: "short", timeStyle: "short" }).format(new Date(iso));

  if (open) {
    return (
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-sm" role="status">
        <span>{labels.key_opened.replace("{folders}", open.folders.join(", ")).replace("{time}", until(open.expires_at))}</span>
        <button type="button" onClick={relock} className="underline underline-offset-4">
          {labels.key_lock}
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3 text-sm">
      {!show ? (
        <button type="button" onClick={() => setShow(true)} className="self-start underline underline-offset-4">
          {labels.key_have}
        </button>
      ) : (
        <form onSubmit={unlock} className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span>{labels.key_label}</span>
            <input
              value={key}
              onChange={(event) => setKey(event.target.value)}
              maxLength={100}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="characters"
              className="rounded border border-line px-3 py-2 font-mono outline-none focus:border-foreground"
            />
          </label>
          <button type="submit" disabled={busy || !key.trim()} className="self-start rounded border border-foreground px-3 py-1 font-medium disabled:text-muted">
            {busy ? labels.key_opening : labels.key_open}
          </button>
          <p className="text-xs text-muted">{labels.key_note}</p>
        </form>
      )}
      {problem && <p>{problem}</p>}
    </div>
  );
}

function Answer({ reply, labels, shopName }: { reply: ChatReply; labels: Labels; shopName: string }) {
  const match = reply.photo
    ? { found: labels.match_found, not_found: labels.match_not_found, unsure: labels.match_unsure }[reply.photo.match]
    : null;
  return (
    <>
      <span className="text-xs text-muted">{labels.assistant}</span>
      {reply.photo && (
        <p className="text-sm">
          <span className="text-muted">{labels.photo_read} </span>
          {reply.photo.read || "–"} · <strong>{match}</strong>
        </p>
      )}
      {reply.answer && <p className="whitespace-pre-line">{reply.answer}</p>}
      {reply.cards.length > 0 && (
        <ul className="divide-y divide-line border-y border-line">
          {reply.cards.map((card) => (
            <li key={card.href} className="py-2">
              <ItemLine item={card} labels={labels} />
            </li>
          ))}
        </ul>
      )}
      {reply.list.length > 0 && <ShoppingList list={reply.list} labels={labels} shopName={shopName} />}
      {(reply.docPrices ?? []).length > 0 && (
        <ul className="text-sm">
          {reply.docPrices.map((p, i) => (
            <li key={i}>
              <DocPrice price={p} labels={labels} />
            </li>
          ))}
        </ul>
      )}
      {(reply.pictures ?? []).length > 0 && (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label={labels.pictures}>
          {reply.pictures.map((picture) => (
            <li key={picture.src} className="flex flex-col gap-1 text-xs">
              <a href={picture.src} target="_blank" rel="noopener noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element -- signed address of the shop's own picture */}
                <img src={picture.src} alt={picture.alt} loading="lazy" className="aspect-square w-full border border-line object-contain" />
              </a>
              <span className="text-muted">
                <SourceText source={{ name: picture.name, page: picture.page, href: null }} labels={labels} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {(reply.sources ?? []).length > 0 && (
        <ul className="flex flex-col text-sm text-muted">
          {reply.sources.map((source, i) => (
            <li key={i}>
              <SourceText source={source} labels={labels} />
              {source.href && (
                <>
                  {" · "}
                  <a href={source.href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
                    {labels.open_document}
                  </a>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {reply.callShop && (
        <p className="text-sm">
          <a href={`tel:${reply.callShop.replace(/[^+\d]/g, "")}`} className="font-medium underline underline-offset-4">
            {labels.call_shop.replace("{phone}", reply.callShop)}
          </a>
        </p>
      )}
    </>
  );
}

function SourceText({ source, labels }: { source: ChatSource; labels: Labels }) {
  return (
    <>
      {source.page
        ? labels.source_page.replace("{name}", source.name).replace("{page}", String(source.page))
        : labels.source.replace("{name}", source.name)}
    </>
  );
}

/** A price as one of the shop's documents writes it: never shown as the shop's price. */
function DocPrice({ price, labels }: { price: ChatDocPrice; labels: Labels }) {
  return (
    <span className="text-muted">
      {labels.doc_price
        .replace("{name}", price.name)
        .replace("{page}", String(price.page ?? "–"))
        .replace("{price}", price.price)}
    </span>
  );
}

function ItemLine({ item, quantity, labels }: { item: ChatCard; quantity?: number; labels: Labels }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          {quantity !== undefined && <span className="font-medium">{quantity}× </span>}
          <Link href={item.href} className="font-medium hover:underline">
            {item.name}
          </Link>
          {item.translated && <p className="text-sm text-muted">{item.translated}</p>}
        </div>
        <span className="whitespace-nowrap font-medium">{item.price}</span>
      </div>
      <p className="text-sm">
        {item.availability && <strong>{item.availability} · </strong>}
        <span className="text-muted">{item.freshness}</span>
      </p>
      {(item.docPrices ?? []).map((p, i) => (
        <p key={i} className="text-sm">
          <DocPrice price={p} labels={labels} />
        </p>
      ))}
    </div>
  );
}

/** The shopping list with each item's availability; copy as text or print only the list. */
function ShoppingList({ list, labels, shopName }: { list: ChatListItem[]; labels: Labels; shopName: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<boolean | null>(null);

  const plain = () =>
    [
      `${labels.list_title} – ${shopName}`,
      ...list.map(
        (item) =>
          `${item.quantity}× ${item.name}${item.translated ? ` (${item.translated})` : ""} – ${item.price} – ` +
          `${item.availability ?? item.freshness}${item.note ? ` – ${item.note}` : ""}`,
      ),
      window.location.href.split("#")[0],
    ].join("\n");

  function copy() {
    navigator.clipboard.writeText(plain()).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  }

  function print() {
    const root = document.documentElement;
    const area = box.current;
    if (!area) return;
    root.setAttribute("data-print-list", "");
    area.setAttribute("data-print-area", "");
    const done = () => {
      root.removeAttribute("data-print-list");
      area.removeAttribute("data-print-area");
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    window.print();
  }

  return (
    <div ref={box} className="flex flex-col gap-2 border border-foreground p-3">
      <h3 className="font-semibold">
        {labels.list_title} – {shopName}
      </h3>
      <ul className="divide-y divide-line">
        {list.map((item) => (
          <li key={item.href} className="py-2">
            <ItemLine item={item} quantity={item.quantity} labels={labels} />
            {item.note && <p className="text-sm text-muted">{item.note}</p>}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2" data-print-hide="">
        <button type="button" onClick={copy} className="rounded border border-line px-3 py-1 text-sm">
          {copied === true ? labels.copied : copied === false ? labels.copy_failed : labels.copy}
        </button>
        <button type="button" onClick={print} className="rounded border border-line px-3 py-1 text-sm">
          {labels.print}
        </button>
      </div>
    </div>
  );
}
