"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import type { ChatCard, ChatListItem, ChatReply, ChatTurn } from "@/lib/shopChat";

/** Anthropic's recommended longest side for photos; larger ones only cost more. */
const MAX_SIDE = 1568;
/** Earlier messages sent along with a new one (the server keeps at most this many too). */
const HISTORY = 8;

type Labels = Dictionary["chat"];
type Entry =
  | { role: "user"; text: string; preview: string | null }
  | { role: "assistant"; reply: ChatReply }
  | { role: "error"; text: string };

/** The photo shrunk in the browser: at most 1568 px, JPEG, as base64 plus a local preview. */
async function shrinkPhoto(file: File): Promise<{ data: string; preview: string }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  if (!blob) throw new Error("no JPEG");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return { data: dataUrl.slice(dataUrl.indexOf(",") + 1), preview: URL.createObjectURL(blob) };
}

/** The conversation so far as plain text for the next message (photos are never sent again). */
function toHistory(entries: Entry[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const entry of entries) {
    if (entry.role === "user") turns.push({ role: "user", text: `${entry.text}${entry.preview ? " [photo]" : ""}`.trim() });
    if (entry.role === "assistant") {
      const { reply } = entry;
      const shown = [...reply.cards, ...reply.list].map((item) => item.name);
      turns.push({
        role: "assistant",
        text: [
          reply.photo ? `(Read from the photo: ${reply.photo.read}; match: ${reply.photo.match})` : "",
          reply.answer,
          shown.length ? `(Items shown: ${[...new Set(shown)].join("; ")})` : "",
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
 * about this shop's items, makes shopping lists and reads photos of parts or model plates.
 * Everything else on the page is rendered on the server without it.
 */
export function ShopChat({ slug, lang, shopName, labels }: { slug: string; lang: string; shopName: string; labels: Labels }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [text, setText] = useState("");
  const [photo, setPhoto] = useState<{ data: string; preview: string } | null>(null);
  const [photoProblem, setPhotoProblem] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (entries.length || busy) end.current?.scrollIntoView({ block: "nearest" });
  }, [entries, busy]);

  const errorText = (code: unknown) => {
    if (code === "caller_limit") return labels.error_caller_limit;
    if (code === "shop_limit") return labels.error_shop_limit;
    if (code === "bad_photo") return labels.error_photo;
    return labels.error_failed;
  };

  async function choose(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setPhotoProblem(false);
    if (photo) URL.revokeObjectURL(photo.preview);
    try {
      setPhoto(await shrinkPhoto(file));
    } catch {
      setPhoto(null);
      setPhotoProblem(true);
    }
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const message = text.trim();
    if (busy || (!message && !photo)) return;
    const history = toHistory(entries);
    const sent = photo;
    setEntries((now) => [...now, { role: "user", text: message, preview: sent?.preview ?? null }]);
    setText("");
    setPhoto(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/shops/${encodeURIComponent(slug)}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The photo goes once, with this message only.
        body: JSON.stringify({ lang, history, message, photo: sent?.data ?? null }),
      });
      const data = await response.json().catch(() => ({ error: "failed" }));
      setEntries((now) => [
        ...now,
        response.ok && !data.error
          ? { role: "assistant", reply: data as ChatReply }
          : { role: "error", text: `${errorText(data.error)}${data.reason ? ` (${data.reason})` : ""}` },
      ]);
    } catch {
      setEntries((now) => [...now, { role: "error", text: labels.error_failed }]);
    } finally {
      setBusy(false);
    }
  }

  function clear() {
    for (const entry of entries) if (entry.role === "user" && entry.preview) URL.revokeObjectURL(entry.preview);
    setEntries([]);
  }

  return (
    <section className="border border-line" aria-label={labels.title}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-3 p-3 text-left font-semibold"
      >
        <span>{labels.title}</span>
        <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-line p-3">
          <p className="text-sm text-muted">{labels.intro}</p>
          {entries.length > 0 && (
            <ol className="flex flex-col gap-4" aria-live="polite">
              {entries.map((entry, i) => (
                <li key={i} className="flex flex-col gap-2">
                  {entry.role === "user" && (
                    <>
                      <span className="text-xs text-muted">{labels.you}</span>
                      {entry.preview && (
                        // eslint-disable-next-line @next/next/no-img-element -- local preview of the sent photo
                        <img src={entry.preview} alt="" className="h-20 w-20 border border-line object-cover" />
                      )}
                      {entry.text && <p className="whitespace-pre-line">{entry.text}</p>}
                    </>
                  )}
                  {entry.role === "assistant" && <Answer reply={entry.reply} labels={labels} shopName={shopName} />}
                  {entry.role === "error" && <p className="border border-line p-2 text-sm">{entry.text}</p>}
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
            {photo && (
              <div className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element -- local preview of the chosen photo */}
                <img src={photo.preview} alt="" className="h-14 w-14 border border-line object-cover" />
                <button
                  type="button"
                  onClick={() => {
                    URL.revokeObjectURL(photo.preview);
                    setPhoto(null);
                  }}
                  className="text-sm underline underline-offset-4"
                >
                  {labels.photo_remove}
                </button>
              </div>
            )}
            {photoProblem && <p className="text-sm">{labels.error_photo}</p>}
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
              <input ref={fileInput} type="file" accept="image/*" onChange={choose} className="sr-only" tabIndex={-1} />
              <button type="button" onClick={() => fileInput.current?.click()} className="rounded border border-line px-3 py-2">
                {labels.photo}
              </button>
              <button
                type="submit"
                disabled={busy || (!text.trim() && !photo)}
                className="rounded border border-foreground px-4 py-2 font-medium disabled:text-muted"
              >
                {labels.send}
              </button>
              {entries.length > 0 && (
                <button type="button" onClick={clear} className="text-sm underline underline-offset-4">
                  {labels.clear}
                </button>
              )}
            </div>
            <p className="text-xs text-muted">
              {labels.photo_note} {labels.note}
            </p>
          </form>
        </div>
      )}
    </section>
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
              <ItemLine item={card} />
            </li>
          ))}
        </ul>
      )}
      {reply.list.length > 0 && <ShoppingList list={reply.list} labels={labels} shopName={shopName} />}
    </>
  );
}

function ItemLine({ item, quantity }: { item: ChatCard; quantity?: number }) {
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
            <ItemLine item={item} quantity={item.quantity} />
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
