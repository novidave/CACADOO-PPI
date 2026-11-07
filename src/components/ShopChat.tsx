"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { AssistantHeading } from "./AssistantHeading";
import { ListHeadButton } from "./ListHeadButton";
import { BookingPanel } from "./BookingPanel";
import { CallbackPanel } from "./CallbackPanel";
import { ContactCodePanel } from "./ContactCodePanel";
import { ForgetDialog } from "./ForgetDialog";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import { looksLikeKey } from "@/lib/accessKey";
import { bubbleText, type ChatListLine, listLine, listPieces, toChatList, welcomePieces } from "@/lib/chatList";
import { dropBubble } from "@/lib/listDrop";
import { listStore, type ListStore, pieces as listCount, serverList } from "@/lib/shoppingList";
import type { FolderFile, OpenFolder, OpenSession } from "@/lib/docsAccess";
import type { ChatCard, ChatDocPrice, ChatListItem, ChatReply, ChatSource, ChatTurn } from "@/lib/shopChat";
import { FolderAccess, FolderViewer, type ViewTarget } from "./FolderAccess";
import { KeyRow } from "./KeyRow";
import { StockDot } from "./StockDot";
import { MENU_ORDER_EVENT, type MenuOrderEvent } from "@/lib/menuOrder";
import { addNode, branchCount, type Branches, choose as chooseBranch, emptyBranches, pathOf, pathUpTo, pluralKey, versionsOf } from "@/lib/chatBranches";

/** The food order form (database update 73): loaded only when an answer brings its first cart card. */
const OrderPanel = dynamic(() => import("./OrderPanel"), { ssr: false });

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
  | { role: "user"; text: string; files: SentFile[]; list?: ChatListLine[] }
  | { role: "assistant"; reply: ChatReply }
  | { role: "error"; text: string }
  | { role: "notice"; text: string };

/** Which side a message is on (a run of one side shows "Vy" / "Asistent" once); a notice breaks a run. */
const sideOf = (entry: Entry): "user" | "assistant" | null =>
  entry.role === "user" ? "user" : entry.role === "notice" ? null : "assistant";
const isQuestion = (entry: Entry) => entry.role === "user";
const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

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
      const list = entry.list?.length ? ` [shopping list: ${entry.list.map(listLine).join("; ")}]` : "";
      turns.push({ role: "user", text: `${entry.text}${names ? ` [files: ${names}]` : ""}${list}`.trim() });
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

/** No shop id (never on a shop page): no list. */
const NO_LIST: ListStore = { subscribe: () => () => {}, get: serverList, set: () => {} };

/**
 * The visitor's shopping list in the owner's welcome text ({zoznam}, 2026-11-04): the round blue bubble with the pieces
 * of the page's "Zoznam" (the same store, so it changes live with every tap on a stock dot, also from another tab), "0"
 * when empty. It does what the header's list button does (`ListHeadButton`, 2026-11-05): pressing it drops the bubble
 * onto the list chip and the list goes with the next message (`onPress`); at 0 it explains how to add products.
 */
function ListBubble({ count, labels, onPress }: { count: number; labels: Labels; onPress: (bubble: Element | null) => void }) {
  const text = bubbleText(count, "welcome");
  const dot = useRef<HTMLSpanElement>(null);
  return (
    <button
      type="button"
      onClick={() => onPress(dot.current)}
      aria-label={labels.list_attach_n.replace("{n}", String(count))}
      title={labels.list_attach}
      className="ppi-ai-listbtn ppi-ai-listbtn-inline"
      data-chat-list-button="welcome"
    >
      <span ref={dot} className="ppi-ai-bubble" data-list-bubble>
        {text}
      </span>
    </button>
  );
}

/**
 * The shop's AI assistant on the shop page (paid plan only), always open: answers about this
 * shop's items, makes shopping lists and reads photos and PDFs. The conversation scrolls in
 * its own area (the rest of the page stays reachable on a phone). With the archive on, every
 * conversation is kept for the shop (files go straight to the archive function; GPS is
 * removed there); it ends with "Nová konverzácia", when the page is left or after 30 minutes
 * without a message, and the shopper can delete it. Under it, "Mám prístupový kľúč" is a
 * closed dropdown. Everything else on the page is rendered on the server without it.
 */
export function ShopChat({
  slug,
  shopId,
  lang,
  shopName,
  timeZone,
  keys,
  labels,
  buttonLabel,
  welcome,
  archive = false,
  shopperPdf = false,
  initialText = "",
  focusInput = false,
  keysOpen = false,
  sendNow = false,
  orderNow = null,
  listButton = false,
  listNow = false,
}: {
  slug: string;
  /** The shop's id: its page's shopping list ("Zoznam", `ppi.list.<id>`) can go into a message. */
  shopId?: string;
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
  /** "Stiahnuť túto konverzáciu (PDF)": the shop lets shoppers download their own conversation. */
  shopperPdf?: boolean;
  /** What the shopper typed into the light first view (ShopAssistant) before this loaded; focus goes back there. */
  initialText?: string;
  focusInput?: boolean;
  /** "Mám prístupový kľúč" was opened in that first view. */
  keysOpen?: boolean;
  /** "Poslať" was tapped in the first view: the typed question goes out at once. */
  sendNow?: boolean;
  /** "Objednať" on a restaurant's Menu (update 80) loaded the assistant: that dish goes out with its question. */
  orderNow?: MenuOrderEvent | null;
  /** The header's list button (2026-11-05): a page with the Zoznam (a shop with goods); a restaurant has none. */
  listButton?: boolean;
  /** The header's list button was pressed before the chat's code was here: the list is attached at once. */
  listNow?: boolean;
}) {
  const title = buttonLabel?.trim() || labels.title;
  const intro = welcome?.trim() || labels.intro;
  const base = `/api/shops/${encodeURIComponent(slug)}`;
  // The page's own shopping list (the same store as "Zoznam"): its pieces live, and the list attached to the message.
  const listing = shopId ? listStore(shopId) : NO_LIST;
  const myList = useSyncExternalStore(listing.subscribe, listing.get, serverList);
  const count = listCount(myList);
  const [listSent, setListSent] = useState<ChatListLine[] | null>(null);
  const [listNote, setListNote] = useState<"" | "empty" | "attached">("");
  const [dropping, setDropping] = useState(false);
  const listChip = useRef<HTMLLIElement>(null);
  const headBubble = useRef<HTMLSpanElement>(null);
  const dropFrom = useRef<{ el: Element | null; text: string } | null>(null);
  // 2026-11-06: the conversation as branches (this tab only, as before); `shown` = the path on the screen
  const [tree, setTree] = useState<Branches<Entry>>(emptyBranches);
  const treeRef = useRef(tree);
  const putTree = (next: Branches<Entry>) => {
    treeRef.current = next;
    setTree(next);
  };
  /** Adds a message after the shown path's last one, or after `parent` (an answer: its question; an edit). */
  const add = (entry: Entry, parent?: number | null) => {
    const r = addNode(treeRef.current, entry, parent);
    putTree(r.tree);
    return r.id;
  };
  const shown = pathOf(tree);
  // "Upraviť správu": the question being edited in its bubble
  const [editing, setEditing] = useState<number | null>(null);
  // answers whose order was placed, booking confirmed or callback sent: the questions before them stay as they are
  const [finished, setFinished] = useState<ReadonlySet<number>>(() => new Set());
  const box = useRef<HTMLElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const welcomeRef = useRef<HTMLParagraphElement>(null);
  /** The box went to the top of a phone's screen once in this conversation (the first sent message). */
  const scrolled = useRef(false);
  const [text, setText] = useState(initialText);
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
  const textInput = useRef<HTMLTextAreaElement>(null);
  // Loaded by a tap in ShopAssistant's first view: the cursor stays in the text field (after what was typed).
  useEffect(() => {
    const input = textInput.current;
    if (!focusInput || !input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the assistant replaced its first view
  }, []);
  // "Poslať" tapped in the first view: the typed question goes out now.
  useEffect(() => {
    if (sendNow) form.current?.requestSubmit();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the assistant replaced its first view
  }, []);
  // Private folders opened with an access key (database update 24).
  const [folders, setFolders] = useState<OpenSession | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyProblem, setKeyProblem] = useState<string | null>(null);
  const [viewing, setViewing] = useState<ViewTarget | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const foldersOpen = useRef(false);
  // Screen 11: "Napíšte otázku alebo pridajte fotku" under the field; "Poslať" → the plane flies, "Odoslané".
  const [emptyAsk, setEmptyAsk] = useState(false);
  const [sendPhase, setSendPhase] = useState<"" | "fly" | "ok">("");
  const sendTimers = useRef<number[]>([]);
  const [keyOpen, setKeyOpen] = useState(keysOpen);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => () => sendTimers.current.forEach((t) => window.clearTimeout(t)), []);

  /** The bubble pressed: an empty list explains itself; else the list is attached (pressed again: the newest list). */
  const attachList = (bubble: Element | null) => {
    if (count === 0) {
      setListNote("empty");
      return;
    }
    const moving = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    dropFrom.current = moving ? { el: bubble, text: bubbleText(count, "head") } : null;
    setDropping(moving);
    setListSent(toChatList(myList));
    setListNote("attached");
    setEmptyAsk(false);
  };
  // Pressed in the first view (before this code was here): the same as pressing it now.
  const pressedFirst = useRef(listNow);
  useEffect(() => {
    if (!pressedFirst.current) return;
    pressedFirst.current = false;
    attachList(headBubble.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, with the list as it is when the chat arrives
  }, []);
  // The chip is drawn: the bubble flies onto it (decoration only; the chip shows as it lands).
  useEffect(() => {
    const from = dropFrom.current;
    if (!from || !listSent) return;
    dropFrom.current = null;
    dropBubble(from.el, listChip.current, from.text);
    const t = window.setTimeout(() => setDropping(false), 800);
    return () => window.clearTimeout(t);
  }, [listSent]);

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

  // The newest message stays in view — the log scrolls, never the page: a long answer from its start, else the end.
  const nodeCount = tree.nodes.length;
  useEffect(() => {
    const el = log.current;
    if (!el || (!nodeCount && !busy)) return;
    const items = el.querySelectorAll<HTMLElement>("[data-chat-entry]:not([hidden])");
    const last = items[items.length - 1];
    const top = busy || !last || last.offsetHeight <= el.clientHeight ? el.scrollHeight : last.offsetTop - 8;
    const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
  }, [nodeCount, busy]);
  // The chat bar's real height (the field grows with the text) and the static welcome's: the log takes the rest.
  useEffect(() => {
    const section = box.current;
    const bar = form.current;
    const welcome = welcomeRef.current;
    if (!section || !bar || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      section.style.setProperty("--ppi-chat-bar", `${Math.round(bar.offsetHeight)}px`);
      if (welcome) section.style.setProperty("--ppi-chat-welcome", `${Math.round(welcome.offsetHeight)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    if (welcome) observer.observe(welcome);
    return () => observer.disconnect();
  }, []);

  /** The first sent message on a phone: the box's top goes to the top of the screen (below a sticky header), once. */
  function toTopOnce() {
    if (scrolled.current) return;
    scrolled.current = true;
    if (window.innerWidth >= 768) return;
    window.requestAnimationFrame(() => {
      const section = box.current;
      if (!section) return;
      const header = document.querySelector<HTMLElement>("[data-site-header]");
      const position = header ? getComputedStyle(header).position : "";
      const offset = header && (position === "sticky" || position === "fixed") ? header.getBoundingClientRect().height : 0;
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({ top: section.getBoundingClientRect().top + window.scrollY - offset, behavior: reduce ? "auto" : "smooth" });
    });
  }

  const showFolders = useCallback((next: OpenSession | null) => {
    foldersOpen.current = Boolean(next);
    setFolders(next);
  }, []);

  /** Locks the private folders again: when the chat box closes or the page is left ("Znova zamknúť" too). */
  const lockFolders = useCallback(
    (beacon = false) => {
      if (!foldersOpen.current) return;
      foldersOpen.current = false;
      setFolders(null);
      setViewing(null);
      const body = JSON.stringify({ action: "lock" });
      if (beacon && typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon(`${base}/access`, new Blob([body], { type: "application/json" }));
      } else {
        fetch(`${base}/access`, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
      }
    },
    [base, setViewing],
  );

  // The folders opened in this browser (the HttpOnly cookie); leaving the page locks them.
  useEffect(() => {
    if (!keys) return;
    let live = true;
    fetch(`${base}/access`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => live && showFolders(data?.open ?? null))
      .catch(() => {});
    const hide = () => lockFolders(true);
    window.addEventListener("pagehide", hide);
    return () => {
      live = false;
      window.removeEventListener("pagehide", hide);
    };
  }, [keys, base, showFolders, lockFolders]);

  /** The key goes only to the shop's system, never to the AI or into the conversation. */
  async function unlockFolders(key: string): Promise<boolean> {
    setKeyBusy(true);
    setKeyProblem(null);
    try {
      const response = await fetch(`${base}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const data = await response.json().catch(() => ({ status: "unavailable" }));
      if (data.status === "ok") {
        setKeyOpen(true);
        showFolders(data.open ?? { folders: data.folders ?? [], expires_at: data.expires_at, downloads_left: 20, open: [] });
        const names: string[] = data.folders ?? [];
        add({
          role: "notice",
          text: (names.length > 1 ? labels.key_unlocked_many : labels.key_unlocked).replace("{name}", names.join(", ")),
        });
        return true;
      }
      setKeyProblem(data.status === "wrong" ? labels.key_wrong : data.status === "too_many" ? labels.key_too_many : labels.key_unavailable);
      return false;
    } catch {
      setKeyProblem(labels.key_unavailable);
      return false;
    } finally {
      setKeyBusy(false);
    }
  }

  async function refreshFolders() {
    const data = await fetch(`${base}/access`, { cache: "no-store" }).then((r) => r.json()).catch(() => null);
    if (data) showFolders(data.open ?? null);
  }

  /** "Stiahnuť" / "Stiahnuť celý priečinok (ZIP)": a 10-minute address from the shop's system. */
  async function getFile(body: Record<string, unknown>) {
    setKeyBusy(true);
    setKeyProblem(null);
    try {
      const response = await fetch(`${base}/folder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({ error: "unavailable" }));
      if (typeof data.url === "string") {
        window.location.assign(data.url);
      } else {
        setKeyProblem(
          data.error === "limit"
            ? labels.download_limit
            : data.error === "too_big"
              ? labels.zip_too_big
              : data.error === "not_found" || data.error === "empty"
                ? labels.download_not_allowed
                : labels.download_failed,
        );
      }
    } catch {
      setKeyProblem(labels.download_failed);
    } finally {
      setKeyBusy(false);
      refreshFolders();
    }
  }
  const downloadFile = (file: { kind: "document" | "picture"; id: string }) => getFile({ action: "download", kind: file.kind, id: file.id });
  const zipFolder = (folder: OpenFolder) => getFile({ action: "zip", folder_id: folder.id });
  const openFile = (file: FolderFile) => setViewing({ kind: file.kind, id: file.id, name: file.name });

  /** "Stiahnuť túto konverzáciu (PDF)": made by the archive from this conversation only. */
  async function downloadConversation() {
    const current = conv.current;
    if (!current || !uploadUrl.current || pdfBusy) return;
    setPdfBusy(true);
    try {
      const response = await fetch(uploadUrl.current, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "shopper_pdf", id: current.id, token: current.token }),
      });
      if (!response.ok || response.headers.get("content-type") !== "application/pdf") throw new Error("no PDF");
      const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "konverzacia.pdf";
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch {
      add({ role: "error", text: labels.conversation_pdf_failed });
    } finally {
      setPdfBusy(false);
    }
  }

  const errorText = (code: unknown) => {
    if (code === "caller_limit") return labels.error_caller_limit;
    if (code === "shop_limit") return labels.error_shop_limit;
    if (code === "bad_photo") return labels.error_photo;
    return labels.error_failed;
  };

  function reset() {
    for (const { entry } of treeRef.current.nodes) {
      if (entry.role === "user") for (const f of entry.files) if (f.preview) URL.revokeObjectURL(f.preview);
    }
    for (const f of filesRef.current) {
      removed.current.add(f.key);
      if (f.preview) URL.revokeObjectURL(f.preview);
    }
    putFiles([]);
    setListSent(null);
    setListNote("");
    putTree(emptyBranches());
    setEditing(null);
    setFinished(new Set());
    scrolled.current = false;
    setProblem(null);
    setConversation(null);
  }

  function startOver() {
    finish("new");
    reset();
  }

  /** The GDPR panel (2026-11-07): an action closes it and returns the focus to the pill; Esc closes it too. */
  const gdprPanel = () => (box.current?.querySelector("[data-chat-gdpr]") as HTMLDetailsElement | null | undefined) ?? null;
  function fromPanel(action: () => void) {
    const panel = gdprPanel();
    if (panel) panel.open = false;
    panel?.querySelector<HTMLElement>("summary")?.focus();
    action();
  }
  useEffect(() => {
    const panel = gdprPanel();
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !panel.open) return;
      e.preventDefault();
      panel.open = false;
      panel.querySelector<HTMLElement>("summary")?.focus();
    };
    panel.addEventListener("keydown", onKey);
    return () => panel.removeEventListener("keydown", onKey);
  }, []);

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

  /**
   * Sends a question. `edit` (2026-11-06, "Upraviť správu"): the edited text goes as a sibling of the old question —
   * after the same message, with the history up to it only; the field, its files and the list are left as they are.
   */
  async function send(event: React.FormEvent | null, override?: string, order: string[] = [], edit?: { parent: number | null }) {
    event?.preventDefault();
    const message = (override ?? text).trim();
    const ready = edit ? [] : filesRef.current.filter((f) => f.ready);
    // the attached shopping list goes with a typed message only (an automatic message never takes it)
    const list = override === undefined ? (listSent ?? []) : [];
    if (busy || (!edit && filesRef.current.some((f) => !f.ready))) return;
    if (!message && ready.length === 0 && list.length === 0) {
      setEmptyAsk(true);
      textInput.current?.focus();
      return;
    }
    setEmptyAsk(false);
    // A message that is nothing but an access key is checked as a key: never sent to the AI or kept.
    if (!edit && keys && ready.length === 0 && list.length === 0 && looksLikeKey(message)) {
      setText("");
      const ok = await unlockFolders(message);
      if (!ok) add({ role: "error", text: labels.key_wrong });
      setKeyProblem(null);
      return;
    }
    // only the shown path goes along (an edit: the path before the edited question)
    const before = edit ? pathUpTo(treeRef.current, edit.parent) : pathOf(treeRef.current);
    const history = toHistory(before.map((n) => n.entry));
    if (!edit) {
      sendTimers.current.forEach((t) => window.clearTimeout(t));
      setSendPhase("fly");
      sendTimers.current = [
        window.setTimeout(() => setSendPhase("ok"), 550),
        window.setTimeout(() => setSendPhase(""), 2550),
      ];
    }
    const asked = add(
      { role: "user", text: message, files: ready.map((f) => ({ name: f.name, kind: f.kind, preview: f.preview })), list },
      edit ? edit.parent : undefined,
    );
    setEditing(null);
    toTopOnce();
    if (!edit) {
      setText("");
      putFiles([]);
    }
    if (list.length) {
      setListSent(null);
      setListNote("");
    }
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
          // pieces and names only: never a price, a total or the shop's address
          ...(list.length ? { list: list.map((l) => ({ id: l.id, name: l.name, original: l.original, qty: l.qty })) } : {}),
          // "Objednať" on the Menu: the menu line's id only (the server prices it with food_quote)
          ...(order.length ? { order } : {}),
        }),
      });
      const data = await response.json().catch(() => ({ error: "failed" }));
      if (response.ok && !data.error) {
        if (archive) remember(isConversation(data.conversation) ? data.conversation : null);
        if (typeof data.upload === "string") uploadUrl.current = data.upload;
        add({ role: "assistant", reply: data as ChatReply }, asked);
      } else {
        add({ role: "error", text: `${errorText(data.error)}${data.reason ? ` (${data.reason})` : ""}` }, asked);
      }
    } catch {
      add({ role: "error", text: labels.error_failed }, asked);
    } finally {
      setBusy(false);
    }
  }

  // "Objednať" on the Menu (update 80): the dish (its id) goes with its question — the server puts it in the cart card.
  const sendOrder = useRef<(order: MenuOrderEvent) => void>(() => {});
  useEffect(() => {
    sendOrder.current = (order) => void send(null, order.text, [order.id]);
  });
  useEffect(() => {
    if (orderNow) sendOrder.current(orderNow);
    const onOrder = (e: Event) => {
      const detail = (e as CustomEvent<MenuOrderEvent>).detail;
      if (detail?.id && detail.text) sendOrder.current(detail);
    };
    window.addEventListener(MENU_ORDER_EVENT, onOrder);
    return () => window.removeEventListener(MENU_ORDER_EVENT, onOrder);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once; the latest send is read through the ref
  }, []);

  /** "Vymazať moje údaje" (update 63): the dialog offers this conversation or everything about the shopper. */
  const [forgetOpen, setForgetOpen] = useState(false);

  /** "Len túto konverzáciu": the conversation and its files are deleted for good. */
  async function deleteMine(): Promise<boolean> {
    const current = conv.current;
    if (!current || busy) return false;
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
      add({ role: "notice", text: labels.deleted });
      return true;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  }

  const preparing = files.some((f) => !f.ready);
  // a conversation is "on" from its first question; "2 vetvy" in the header only with more than one branch
  const chatOn = tree.nodes.some((n) => n.entry.role === "user");
  const forks = branchCount(tree);
  const onPath = new Map(shown.map((n, i) => [n.id, i] as const));
  // the questions before an order placed, a booking confirmed or a callback sent are never edited
  const lockedAt = shown.reduce(
    (last, n, i) => (finished.has(n.id) || (n.entry.role === "assistant" && n.entry.reply.booked) ? i : last),
    -1,
  );

  return (
    <div className="flex flex-col gap-[18px]">
      {forgetOpen && (
        <ForgetDialog
          base={base}
          lang={lang}
          shopName={shopName}
          hasConversation={Boolean(conversation)}
          labels={labels}
          onOnlyThis={deleteMine}
          onDone={() => {
            conv.current = null;
            used.current = 0;
            reset();
            add({ role: "notice", text: labels.forget_done });
          }}
          onClose={() => setForgetOpen(false)}
        />
      )}
    <section
      ref={box}
      id="assistant"
      className="ppi-ai scroll-mt-4"
      aria-labelledby="assistant-heading"
      data-assistant
      // 2026-11-06: "idle" until the first question of this conversation (a taller field), then "on" (the log takes the room)
      data-chat={chatOn ? "on" : "idle"}
    >
      <AssistantHeading
        title={title}
        lang={lang}
        shopName={shopName}
        archive={archive}
        labels={labels}
        list={
          listButton && shopId ? (
            <ListHeadButton
              label={labels.list_attach_n.replace("{n}", String(count))}
              title={labels.list_attach}
              bubble={bubbleText(count, "head")}
              bubbleRef={headBubble}
              onPress={() => attachList(headBubble.current)}
            />
          ) : undefined
        }
        actions={
          // 2026-11-07: the conversation's actions live in the GDPR panel (no link row under the chat); the same
          // conditions as before decide each row
          tree.nodes.length > 0 || (archive && conversation) ? (
            <>
              {tree.nodes.length > 0 && (
                <button type="button" onClick={() => fromPanel(startOver)} className="ppi-gdpr-action" data-chat-action="clear">
                  <ActionIcon kind="clear" />
                  {labels.clear}
                </button>
              )}
              {archive && shopperPdf && conversation && tree.nodes.some((n) => n.entry.role === "assistant") && (
                <button
                  type="button"
                  onClick={() => fromPanel(() => void downloadConversation())}
                  disabled={pdfBusy}
                  className="ppi-gdpr-action"
                  data-chat-action="pdf"
                  data-conversation-pdf
                >
                  <ActionIcon kind="pdf" />
                  {pdfBusy ? labels.conversation_pdf_busy : labels.conversation_pdf}
                </button>
              )}
              {archive && (
                <button type="button" onClick={() => fromPanel(() => setForgetOpen(true))} className="ppi-gdpr-action" data-chat-action="forget" data-forget-open>
                  <ActionIcon kind="forget" />
                  {labels.forget_open}
                </button>
              )}
            </>
          ) : undefined
        }
        badge={
          forks > 1 ? (
            <span className="ppi-ai-branches" data-chat-branches={forks}>
              {fill(labels[`branches_count_${pluralKey(forks, lang)}`], { n: forks })}
            </span>
          ) : undefined
        }
      />
        <div className="ppi-ai-body flex flex-col px-[13px] py-[14px]">
          {/* 2026-11-07: the welcome is static — the first block, never in the scrolling log (the messages scroll under it) */}
          <p ref={welcomeRef} className="ppi-ai-welcome text-sm leading-normal text-[#5B6472]" data-chat-welcome>
            {welcomePieces(intro).map((piece, i) =>
              piece.kind === "text" ? (
                <span key={i}>{piece.text}</span>
              ) : (
                <ListBubble key={i} count={count} labels={labels} onPress={attachList} />
              ),
            )}
          </p>
          <div ref={log} className="ppi-ai-log" data-chat-log>
          {tree.nodes.length > 0 && (
            <ol className="flex flex-col gap-3 pt-3" aria-live="polite">
              {/* every message of every branch stays drawn (a branch keeps its panels' state); only the shown path is visible */}
              {tree.nodes.map((node) => {
                const at = onPath.get(node.id);
                const entry = node.entry;
                const side = sideOf(entry);
                const label = at !== undefined && side !== null && (at === 0 || sideOf(shown[at - 1].entry) !== side);
                return (
                  <li key={node.id} hidden={at === undefined} className="flex flex-col gap-2" data-chat-entry={entry.role}>
                    {entry.role === "user" && (
                      <div className="ppi-msg-col ppi-msg-col-user">
                        {label && <span className="ppi-msg-label">{labels.you}</span>}
                        {entry.files.length > 0 && <FileList files={entry.files} labels={labels} />}
                        {entry.list && entry.list.length > 0 && <SentList lines={entry.list} labels={labels} />}
                        {editing === node.id ? (
                          <EditBox
                            initial={entry.text}
                            labels={labels}
                            onCancel={() => {
                              setEditing(null);
                              window.requestAnimationFrame(() =>
                                log.current?.querySelector<HTMLElement>(`[data-chat-edit-open="${node.id}"]`)?.focus(),
                              );
                            }}
                            onSend={(edited) => void send(null, edited, [], { parent: node.parent })}
                          />
                        ) : (
                          entry.text && (
                            <p className="ppi-msg ppi-msg-user" data-chat-bubble="user">
                              {entry.text}
                            </p>
                          )
                        )}
                        {at !== undefined && editing !== node.id && (
                          <MessageTools
                            node={node.id}
                            versions={versionsOf(tree, node, isQuestion).map((v) => v.id)}
                            editable={!busy && at > lockedAt && entry.files.length === 0 && !entry.list?.length && Boolean(entry.text)}
                            busy={busy}
                            labels={labels}
                            onEdit={() => setEditing(node.id)}
                            onPick={(id) => {
                              const pick = treeRef.current.nodes.find((n) => n.id === id);
                              if (pick) putTree(chooseBranch(treeRef.current, pick));
                            }}
                          />
                        )}
                      </div>
                    )}
                    {entry.role === "assistant" && (
                      <Answer
                        reply={entry.reply}
                        labels={labels}
                        shopName={shopName}
                        showLabel={label}
                        onView={folders ? setViewing : null}
                        onDone={() => setFinished((now) => new Set(now).add(node.id))}
                        booking={{
                          base,
                          lang,
                          conversation: () => (archive ? conv.current : null),
                          // the number is checked: the assistant books the chosen time (the code never goes to it)
                          verified: () => void send(null, labels.contact_verified_message),
                        }}
                      />
                    )}
                    {entry.role === "error" && <p className="border border-line p-2 text-sm">{entry.text}</p>}
                    {entry.role === "notice" && (
                      <p role="status" className="border border-foreground p-2 text-sm font-medium">
                        {entry.text}
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {busy && (
            <p role="status" className="mt-3 text-sm text-muted">
              {labels.thinking}
            </p>
          )}
          </div>
          <form ref={form} onSubmit={send} className="flex flex-col">
            <label htmlFor="assistant-question" className="sr-only">
              {labels.placeholder}
            </label>
            <textarea
              id="assistant-question"
              ref={textInput}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setEmptyAsk(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              rows={2}
              maxLength={1500}
              placeholder={labels.placeholder}
              aria-invalid={emptyAsk || undefined}
              aria-describedby={emptyAsk ? "assistant-empty" : undefined}
              className="ppi-ai-input mt-4"
            />
            {emptyAsk && (
              <p id="assistant-empty" role="alert" className="mt-1.5 text-[13px] font-semibold text-[#DC2626]" data-chat-empty>
                {labels.empty_question}
              </p>
            )}
            {problem && (
              <p className="mt-1.5 text-sm" role="alert">
                {problem}
              </p>
            )}
            {listNote === "empty" && (
              <p role="status" className="mt-1.5 text-[13px] font-semibold text-[#1D4ED8]" data-chat-list-empty>
                {labels.list_empty_hint}
              </p>
            )}
            <p className="sr-only" aria-live="polite">
              {listNote === "attached" ? labels.list_attached : ""}
            </p>
            {(files.length > 0 || listSent) && (
              <ul className="mt-2.5 flex flex-wrap gap-2" aria-label={labels.photo}>
                {listSent && (
                  <li ref={listChip} className="ppi-ai-chip ppi-ai-listchip" data-list-chip data-drop={dropping || undefined}>
                    <span className="ppi-ai-bubble" aria-hidden="true">
                      {bubbleText(listPieces(listSent), "head")}
                    </span>
                    <span className="truncate" title={listSent.map(listLine).join("\n")}>
                      {labels.list_mine} · {labels.list_pieces.replace("{n}", String(listPieces(listSent)))}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setListSent(null);
                        setListNote("");
                      }}
                      aria-label={labels.list_remove_attached}
                      data-list-chip-remove
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true" focusable="false">
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </li>
                )}
                {files.map((f) => (
                  <li key={f.key} className="ppi-ai-chip" data-chat-file={f.ready ? "ready" : "working"}>
                    {f.preview ? (
                      // eslint-disable-next-line @next/next/no-img-element -- local preview of the chosen picture
                      <img src={f.preview} alt="" className="h-5 w-5 shrink-0 rounded object-cover" />
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                        <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
                        <path d="M14 3v5h5" />
                      </svg>
                    )}
                    <span className="truncate" title={f.name}>
                      {f.name}
                    </span>
                    {!f.ready && <span className="shrink-0 font-normal">· {labels.file_working}</span>}
                    <button type="button" onClick={() => remove(f.key)} aria-label={`${labels.file_remove}: ${f.name}`}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true" focusable="false">
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2.5 flex items-center gap-[9px]" data-chat-bar>
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
              <button type="button" onClick={() => fileInput.current?.click()} className="ppi-ai-attach" data-chat-attach>
                <AttachIcon />
                {labels.photo}
              </button>
              <button type="submit" disabled={busy || preparing} className="ppi-ai-send" data-phase={sendPhase || undefined} data-chat-send>
                {sendPhase === "ok" ? labels.sent : labels.send}
                <PlaneIcon />
              </button>
            </div>
          </form>
        </div>
    </section>
      {keys && (
        // "Mám prístupový kľúč": closed until the shopper opens it; open while a folder is unlocked.
        <KeyRow label={labels.key_have} open={keyOpen || Boolean(folders)} onToggle={setKeyOpen}>
          <FolderAccess
            session={folders}
            labels={labels}
            lang={lang}
            timeZone={timeZone}
            busy={keyBusy}
            problem={keyProblem}
            onUnlock={unlockFolders}
            onLock={() => lockFolders()}
            onOpen={openFile}
            onDownload={downloadFile}
            onZip={zipFolder}
            inline
          />
        </KeyRow>
      )}
      {viewing && (
        <FolderViewer
          base={base}
          lang={lang}
          target={viewing}
          labels={labels}
          onClose={() => setViewing(null)}
          onDownload={() => downloadFile(viewing)}
        />
      )}
    </div>
  );
}

/** The orange paperclip of "Pridať fotku alebo súbor". */
export function AttachIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#F57C20" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M21.4 11.1l-9.2 9.2a6 6 0 01-8.5-8.5l9.2-9.2a4 4 0 015.7 5.7l-9.2 9.2a2 2 0 01-2.8-2.8l8.5-8.5" />
    </svg>
  );
}

/** The paper plane of "Poslať" (it flies off when a question goes out). */
export function PlaneIcon() {
  return (
    <svg className="ppi-ai-plane" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4z" />
    </svg>
  );
}

/**
 * "Upraviť správu" (2026-11-06): the question edited inside its bubble. Enter sends (not while an IME composes),
 * Shift+Enter makes a new line, Esc cancels; empty = "Napíšte otázku."; the same text only closes.
 */
function EditBox({ initial, labels, onCancel, onSend }: { initial: string; labels: Labels; onCancel: () => void; onSend: (text: string) => void }) {
  const [value, setValue] = useState(initial);
  const [empty, setEmpty] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const submit = () => {
    const edited = value.trim();
    if (!edited) {
      setEmpty(true);
      field.current?.focus();
      return;
    }
    if (edited === initial.trim()) return onCancel();
    onSend(edited);
  };
  return (
    <form
      className="ppi-msg ppi-msg-user ppi-msg-edit"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-chat-edit
    >
      <label htmlFor={id} className="sr-only">
        {labels.edit_label}
      </label>
      <textarea
        id={id}
        ref={field}
        value={value}
        rows={2}
        maxLength={1500}
        onChange={(e) => {
          setValue(e.target.value);
          setEmpty(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        aria-invalid={empty || undefined}
        aria-describedby={`${id}-hint${empty ? ` ${id}-empty` : ""}`}
        className="ppi-msg-edit-field"
        data-chat-edit-field
      />
      {empty && (
        <p id={`${id}-empty`} role="alert" className="ppi-msg-edit-error" data-chat-edit-empty>
          {labels.edit_empty}
        </p>
      )}
      <p id={`${id}-hint`} className="ppi-msg-edit-hint">
        {labels.edit_hint}
      </p>
      <div className="ppi-msg-edit-bar">
        <button type="button" onClick={onCancel} className="ppi-msg-edit-cancel" data-chat-edit-cancel>
          {labels.edit_cancel}
        </button>
        <button type="submit" className="ppi-msg-edit-send" data-chat-edit-send>
          {labels.edit_send}
        </button>
      </div>
    </form>
  );
}

/** Under a question: "‹ 1/2 ›" when it has versions, and the pencil "Upraviť správu" when it may be edited. */
function MessageTools({
  node,
  versions,
  editable,
  busy,
  labels,
  onEdit,
  onPick,
}: {
  node: number;
  versions: number[];
  editable: boolean;
  busy: boolean;
  labels: Labels;
  onEdit: () => void;
  onPick: (id: number) => void;
}) {
  const at = versions.indexOf(node);
  if (!editable && versions.length < 2) return null;
  return (
    <div className="ppi-msg-tools">
      {versions.length > 1 && (
        <span className="ppi-msg-pager" data-chat-pager>
          <button type="button" aria-label={labels.branch_prev} title={labels.branch_prev} disabled={busy || at <= 0}
            onClick={() => onPick(versions[at - 1])} data-chat-branch-prev>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </button>
          <span className="tabular-nums" data-chat-branch-pos>
            {fill(labels.branch_pos, { n: at + 1, m: versions.length })}
          </span>
          <button type="button" aria-label={labels.branch_next} title={labels.branch_next} disabled={busy || at >= versions.length - 1}
            onClick={() => onPick(versions[at + 1])} data-chat-branch-next>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
        </span>
      )}
      {editable && (
        <button type="button" className="ppi-msg-pencil" aria-label={labels.edit_message} title={labels.edit_message} onClick={onEdit}
          data-chat-edit-open={node}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M4 20h4L19 9l-4-4L4 16v4z" />
            <path d="M13.5 6.5l4 4" />
          </svg>
        </button>
      )}
    </div>
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

/** The list a message took, as the assistant got it: pieces and names, no prices. */
function SentList({ lines, labels }: { lines: ChatListLine[]; labels: Labels }) {
  return (
    <div className="ppi-ai-sentlist" data-chat-sent-list>
      <span className="font-semibold">{labels.list_mine}</span>
      <ul>
        {lines.map((line) => (
          <li key={line.id}>{listLine(line)}</li>
        ))}
      </ul>
    </div>
  );
}

function Answer({
  reply,
  labels,
  shopName,
  showLabel,
  onView,
  onDone,
  booking,
}: {
  reply: ChatReply;
  labels: Labels;
  shopName: string;
  /** "Asistent" above the bubble: only on the first message of a run from the assistant's side. */
  showLabel: boolean;
  /** An order placed, a booking confirmed or a callback sent from this answer's panel (the questions before it stay). */
  onDone: () => void;
  /** Opens a private folder's document in the viewer (only while folders are open). */
  onView: ((target: ViewTarget) => void) | null;
  /** What the booking form needs (database update 57) and, update 63, what follows a checked number. */
  booking: { base: string; lang: string; conversation: () => Conversation | null; verified: () => void };
}) {
  const match = reply.photo
    ? { found: labels.match_found, not_found: labels.match_not_found, unsure: labels.match_unsure }[reply.photo.match]
    : null;
  return (
    <>
      {showLabel && <span className="ppi-msg-label">{labels.assistant}</span>}
      {(reply.photo || reply.answer) && (
        <div className="ppi-msg ppi-msg-bot" data-chat-bubble="assistant">
          {reply.photo && (
            <p className="text-sm">
              <span className="text-[#5B6670]">{labels.photo_read} </span>
              {reply.photo.read || "–"} · <strong>{match}</strong>
            </p>
          )}
          {reply.answer && <p className="whitespace-pre-line">{reply.answer}</p>}
        </div>
      )}
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
      {/* Update 78: a product photo only when the shopper asked to see one (the 800 px picture, the product page). */}
      {(reply.productPhotos ?? []).map((p) => (
        <figure key={p.href} className="flex flex-col gap-1.5" data-chat-product-photo={p.src ? "photo" : "none"}>
          {p.src ? (
            <a href={p.href} className="block self-start overflow-hidden rounded-xl border border-[#ECE7DE] bg-white">
              {/* eslint-disable-next-line @next/next/no-img-element -- the shop's own photo, already 800 px (no optimisation) */}
              <img src={p.src} alt={labels.product_photo_alt.replace("{name}", p.name)} width={p.width ?? undefined} height={p.height ?? undefined} loading="lazy" decoding="async" className="h-auto max-h-80 w-auto max-w-full object-contain" />
            </a>
          ) : (
            <p className="text-sm">{labels.product_photo_none.replace("{name}", p.name)}</p>
          )}
          <figcaption className="text-sm">
            <a href={p.href} className="font-medium underline underline-offset-4">
              {labels.product_photo_open.replace("{name}", p.name)}
            </a>
          </figcaption>
        </figure>
      ))}
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
              {!source.href && source.view && onView && (
                <>
                  {" · "}
                  <button type="button" onClick={() => onView({ ...source.view!, name: source.name })} className="underline underline-offset-4">
                    {labels.file_open}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {reply.booking && reply.booking.slots.length > 0 && (
        <BookingPanel
          base={booking.base}
          lang={booking.lang}
          shopName={shopName}
          timeZone={reply.booking.timezone}
          service={reply.booking.service}
          slots={reply.booking.slots}
          conversation={booking.conversation}
          privacyHref={`/${booking.lang}/sukromie-asistent#rezervacie`}
          labels={labels}
          onDone={onDone}
        />
      )}
      {reply.order && booking.conversation() && (
        <OrderPanel
          base={booking.base}
          lang={booking.lang}
          shopName={shopName}
          order={reply.order}
          conversation={booking.conversation}
          privacyHref={`/${booking.lang}/sukromie-asistent`}
          labels={labels}
          onDone={onDone}
        />
      )}
      {reply.callShop && (
        <p className="text-sm">
          <a href={`tel:${reply.callShop.replace(/[^+\d]/g, "")}`} className="font-medium underline underline-offset-4">
            {labels.call_shop.replace("{phone}", reply.callShop)}
          </a>
        </p>
      )}
      {reply.booked && (
        <p role="status" className="border border-foreground p-3 text-sm font-semibold" data-booked>
          {labels.booked_line
            .replace("{service}", reply.booked.service_name ?? labels.booked_default)
            .replace("{when}", new Intl.DateTimeFormat(booking.lang, {
              timeZone: reply.booked.timezone, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
            }).format(new Date(reply.booked.starts_at)))
            .replace("{with}", reply.booked.resource_name ? ` · ${reply.booked.resource_name}` : "")}
        </p>
      )}
      {reply.requestContact && !reply.booked && booking.conversation() && (
        <ContactCodePanel
          base={booking.base}
          lang={booking.lang}
          shopName={shopName}
          conversation={booking.conversation}
          privacyHref={`/${booking.lang}/sukromie-asistent#rezervacie`}
          labels={labels}
          onVerified={booking.verified}
        />
      )}
      {reply.askContact && booking.conversation() && (
        <CallbackPanel
          base={booking.base}
          shopName={shopName}
          conversation={booking.conversation}
          privacyHref={`/${booking.lang}/sukromie-asistent#kontakt`}
          labels={labels}
          onDone={onDone}
        />
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
            {item.translated ?? item.name}
          </Link>
          {item.translated && <p className="text-sm text-muted">{item.name}</p>}
        </div>
        <span className="flex items-center gap-2 whitespace-nowrap font-medium">
          {item.stock && <StockDot state={item.stock} label={item.stockLabel} />}
          {item.price}
        </span>
      </div>
      {/* No stock sentence in listings (only the product page has it): the dot says it. */}
      {item.freshness && <p className="text-sm text-muted">{item.freshness}</p>}
      {(item.docPrices ?? []).map((p, i) => (
        <p key={i} className="text-sm">
          <DocPrice price={p} labels={labels} />
        </p>
      ))}
    </div>
  );
}

/** The shopping list (the stock dot on each line); copy as text or print only the list. */
function ShoppingList({ list, labels, shopName }: { list: ChatListItem[]; labels: Labels; shopName: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<boolean | null>(null);

  const plain = () =>
    [
      `${labels.list_title} – ${shopName}`,
      ...list.map(
        (item) =>
          `${item.quantity}× ${item.name}${item.translated ? ` (${item.translated})` : ""} – ${item.price}${item.note ? ` – ${item.note}` : ""}`,
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

/** The GDPR panel's action icons (2026-11-07): refresh, download, shield; 20 px, stroke 2, currentColor. */
function ActionIcon({ kind }: { kind: "clear" | "pdf" | "forget" }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {kind === "clear" ? (
        <>
          <path d="M20 11a8 8 0 10-2.3 5.7" />
          <path d="M20 4v7h-7" />
        </>
      ) : kind === "pdf" ? (
        <>
          <path d="M12 4v11" />
          <path d="M7 10l5 5 5-5" />
          <path d="M5 20h14" />
        </>
      ) : (
        <>
          <path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z" />
          <path d="M9.5 12.5l2 2 3.5-4" />
        </>
      )}
    </svg>
  );
}
