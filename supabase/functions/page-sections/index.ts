/// <reference lib="deno.ns" />
// PPI · page-sections Edge Function
//
// Page sections from PDFs ("Novinky október", "Leták", "Jedálny lístok" …), a paid feature
// (database update 28). Only the shop's owners, with their own login, except the hourly job.
// The owner's browser reads the PDF with pdf.js (every page as a picture 800 and 1600 px wide,
// the text page by page; Edge Functions cannot draw PDFs) and sends it here step by step:
//   POST ?action=pdf&section_id=…                       body: the PDF → {version, pages, removed}
//        a real PDF (its first bytes), at most 10 MB and 20 pages, not encrypted; cleaned with
//        pdf-lib: JavaScript, open and other actions, launch actions, links to programs, embedded
//        and attached files are removed (a PDF that cannot be cleaned is refused). Only the
//        cleaned file is stored, in the private bucket "shop-sections".
//   POST ?action=page&section_id=…&version=…&page=…&size=800|1600   body: one page picture
//        WebP or JPEG (by its first bytes), at most 5 MB, exactly 800 or 1600 px wide
//   POST {action: "text", section_id, version, pages: [{page, text}]}   the text as written
//   POST {action: "finish", section_id, version}  → the new PDF goes live (the old one's files go)
//   POST {action: "work", section_id}              → the AI writes out pages without text (as written)
//   POST {action: "sync", section_id}              → after "Zverejniť", "Skryť", "Zobraziť" or new dates:
//        the page pictures go into the public bucket "shop-sections-public" while the section is
//        visible, and leave it when it is not (section_visible() in the database decides)
//   POST {action: "preview", section_id, which?: "live" | "upload"} → 10-minute addresses (owner only)
//   POST {action: "delete", section_id}            → every file first, then the section and its text
//   POST {action: "tick"} with header x-ppi-cron   → the hourly job: dates and the paid plan, AI retries
// PPI never changes the owner's text and never translates it.
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name
// "page-sections" → paste this file → Deploy, then switch OFF "Verify JWT" (this function checks
// its callers itself). Secrets: ANTHROPIC_API_KEY (already set); optional AI_MODEL.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@0.131.0";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from "npm:pdf-lib@1.17.1";

export const PRIVATE = "shop-sections";
export const PUBLIC = "shop-sections-public";
const DEFAULT_MODEL = "claude-haiku-5-5";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The limits of a PDF: the shop's plan's, from the database (update 30: section_limits). */
export interface Limits {
  maxPages: number;
  maxBytes: number;
}
/** Pro's limits before update 30 (the database then gives none). */
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_PAGES = 20;
export const DEFAULT_LIMITS: Limits = { maxPages: MAX_PAGES, maxBytes: MAX_PDF_BYTES };
/** Never more, whatever the settings say (the database allows the admin at most these). */
export const CAP_PAGES = 50;
export const CAP_BYTES = 20 * 1024 * 1024;
export const MAX_PICTURE_BYTES = 5 * 1024 * 1024;
export const SIZES = [800, 1600] as const;
const SIGNED_SECONDS = 600;
/** Public copies are cached for at most 5 minutes, so hiding takes effect soon. */
const PUBLIC_CACHE = "300";
const AI_BATCH = 3;

// ---------------------------------------------------------------- cleaning the PDF

export type RejectCode = "not_pdf" | "too_big" | "encrypted" | "unreadable" | "too_many_pages" | "unclean";

/** Why a PDF is refused (shown to the owner in the page language by the website). */
export class PdfRejected extends Error {
  constructor(readonly code: RejectCode, message: string) {
    super(message);
  }
}

/** "%PDF-" in the first kilobyte (some files have a few bytes before it). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

/** Every action type of the PDF standard (other dictionaries use /S too: groups, masks, borders …). */
const ACTION_TYPES = new Set([
  "GoTo", "GoToR", "GoToE", "GoToDp", "Launch", "Thread", "URI", "Sound", "Movie", "Hide", "Named", "SubmitForm",
  "ResetForm", "ImportData", "JavaScript", "ECMAScript", "SetOCGState", "Rendition", "Trans", "GoTo3DView",
  "RichMediaExecute",
]);
/** Actions a page may keep: go to a page, a web or e-mail link (checked), named page moves, threads. */
const SAFE_ACTIONS = new Set(["GoTo", "URI", "Named", "Thread"]);
/** Keys that carry scripts, automatic actions or files: removed wherever they are. */
const REMOVE_KEYS: [string, string][] = [
  ["OpenAction", "open action"],
  ["AA", "automatic actions"],
  ["JS", "JavaScript"],
  ["JavaScript", "JavaScript"],
  ["EmbeddedFiles", "embedded files"],
  ["EF", "embedded files"],
  ["RF", "embedded files"],
  ["RichMediaContent", "media"],
  ["XFA", "XFA form scripts"],
  ["AF", "embedded files"],
];
/** Annotations that hold files or media: removed from the pages. */
const REMOVE_ANNOTATIONS = new Set(["FileAttachment", "RichMedia", "Movie", "Sound", "Screen", "3D"]);
const PROGRAM = /\.(exe|com|bat|cmd|scr|pif|msi|msp|jar|js|jse|vbs|vbe|wsf|wsh|ps1|psm1|sh|app|dmg|pkg|apk|deb|rpm|cpl|lnk|reg|hta|dll)(?:$|[?#])/i;

const nameOf = (value: unknown): string | null => (value instanceof PDFName ? value.decodeText() : null);
const textOf = (value: unknown): string =>
  value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : "";

/** A link the page may keep: https, http or mailto, never to a program. */
export function safeUri(uri: string): boolean {
  const u = uri.trim();
  return /^(https?:\/\/|mailto:)/i.test(u) && !PROGRAM.test(u) && !/[\u0000-\u001f]/.test(u);
}

export interface Cleaned {
  bytes: Uint8Array;
  pages: number;
  /** What was taken out ("JavaScript", "embedded files" …), for the owner. */
  removed: string[];
}

const mb = (bytes: number) => Math.round(bytes / 1048576);

/**
 * Checks and cleans a PDF: refuses what is not a PDF, too big, encrypted (password), unreadable
 * or longer than the plan allows (default: Pro's 20 pages, 10 MB); removes JavaScript, open and
 * automatic actions, launch and other unsafe actions, links to programs, embedded and attached
 * files, media and XFA scripts. A PDF where any of it is still found afterwards is refused.
 */
export async function cleanPdf(input: Uint8Array, limits: Limits = DEFAULT_LIMITS): Promise<Cleaned> {
  const tooBig = () => new PdfRejected("too_big", `A PDF may have at most ${mb(limits.maxBytes)} MB`);
  if (input.length > limits.maxBytes) throw tooBig();
  if (!looksLikePdf(input)) throw new PdfRejected("not_pdf", "This file is not a PDF");
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(input, { updateMetadata: false });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/encrypt/i.test(message)) throw new PdfRejected("encrypted", "The PDF is protected by a password or encrypted");
    throw new PdfRejected("unreadable", "The PDF cannot be read");
  }
  if (doc.isEncrypted) throw new PdfRejected("encrypted", "The PDF is protected by a password or encrypted");
  let pages: number;
  try {
    pages = doc.getPageCount();
  } catch {
    throw new PdfRejected("unreadable", "The PDF cannot be read");
  }
  if (pages < 1) throw new PdfRejected("unreadable", "The PDF has no pages");
  if (pages > limits.maxPages) throw new PdfRejected("too_many_pages", `A PDF may have at most ${limits.maxPages} pages`);

  const ctx = doc.context;
  const removed = new Set<string>();
  const drop = new Set<string>();

  /** An action that may not stay (anything but a page move or a safe link). */
  const unsafeAction = (value: unknown): string | null => {
    const dict = ctx.lookup(value as PDFRef);
    if (!(dict instanceof PDFDict)) return null;
    const type = nameOf(dict.get(PDFName.of("S")));
    if (!type || (!ACTION_TYPES.has(type) && nameOf(dict.get(PDFName.of("Type"))) !== "Action")) return null;
    if (!SAFE_ACTIONS.has(type)) return type;
    if (type === "URI" && !safeUri(textOf(ctx.lookup(dict.get(PDFName.of("URI")) as PDFRef)))) return "links to programs";
    return null;
  };

  // 1. Objects that go: unsafe actions, embedded files.
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    const inner = (obj as unknown as { dict?: unknown }).dict;
    const dict = obj instanceof PDFDict ? obj : inner instanceof PDFDict ? inner : null;
    if (!dict) continue;
    const type = nameOf(dict.get(PDFName.of("Type")));
    if (type === "EmbeddedFile" || (type === "Filespec" && dict.has(PDFName.of("EF")))) {
      drop.add(ref.tag);
      removed.add("embedded files");
    }
    if (obj instanceof PDFDict) {
      const unsafe = unsafeAction(obj);
      if (unsafe) {
        drop.add(ref.tag);
        removed.add(unsafe === "links to programs" ? unsafe : `${unsafe} actions`);
      }
    }
  }

  // 2. Keys that carry them, everywhere (also inside direct dictionaries and arrays).
  const seen = new Set<unknown>();
  const cleanDict = (dict: PDFDict) => {
    for (const [key, label] of REMOVE_KEYS) {
      const name = PDFName.of(key);
      if (!dict.has(name)) continue;
      const value = dict.get(name);
      if (value instanceof PDFRef && key !== "AA") drop.add(value.tag);
      dict.delete(name);
      removed.add(label);
    }
    for (const key of ["A", "Next"]) {
      const name = PDFName.of(key);
      const value = dict.get(name);
      if (value === undefined) continue;
      const gone = (value instanceof PDFRef && drop.has(value.tag)) || unsafeAction(value);
      if (gone) {
        dict.delete(name);
        if (typeof gone === "string") removed.add(gone === "links to programs" ? gone : `${gone} actions`);
      }
    }
  };
  const visit = (obj: unknown) => {
    if (!obj || seen.has(obj)) return;
    if (obj instanceof PDFDict) {
      seen.add(obj);
      cleanDict(obj);
      for (const [, value] of obj.entries()) visit(value);
    } else if (obj instanceof PDFArray) {
      seen.add(obj);
      for (const value of obj.asArray()) visit(value);
    } else if ((obj as { dict?: unknown }).dict instanceof PDFDict) {
      visit((obj as { dict: PDFDict }).dict);
    }
  };
  for (const [, obj] of ctx.enumerateIndirectObjects()) visit(obj);

  // 3. Annotations with files or media leave the pages.
  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) continue;
    const keep = annots.asArray().filter((a) => {
      const dict = ctx.lookup(a);
      if (!(dict instanceof PDFDict)) return true;
      const subtype = nameOf(dict.get(PDFName.of("Subtype")));
      if (subtype && REMOVE_ANNOTATIONS.has(subtype)) {
        if (a instanceof PDFRef) drop.add(a.tag);
        removed.add("attached files and media");
        return false;
      }
      return true;
    });
    if (keep.length !== annots.size()) page.node.set(PDFName.of("Annots"), ctx.obj(keep));
  }

  // 4. The dropped objects, and every object the document no longer reaches (leftovers of
  //    scripts and attached files), are not written at all.
  const reached = new Set<string>();
  const follow = (o: unknown) => {
    if (o instanceof PDFRef) {
      if (reached.has(o.tag) || drop.has(o.tag)) return;
      reached.add(o.tag);
      follow(ctx.lookup(o));
    } else if (o instanceof PDFDict) for (const [, v] of o.entries()) follow(v);
    else if (o instanceof PDFArray) for (const v of o.asArray()) follow(v);
    else if ((o as { dict?: unknown })?.dict instanceof PDFDict) follow((o as { dict: PDFDict }).dict);
  };
  follow(ctx.trailerInfo.Root);
  follow(ctx.trailerInfo.Info);
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!reached.has(ref.tag)) ctx.delete(ref);

  // 5. Nothing of it may be left.
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const dicts: PDFDict[] = [];
    const collect = (o: unknown, depth: number) => {
      if (depth > 50) return;
      if (o instanceof PDFDict) {
        dicts.push(o);
        for (const [, v] of o.entries()) collect(v, depth + 1);
      } else if (o instanceof PDFArray) for (const v of o.asArray()) collect(v, depth + 1);
      else if ((o as { dict?: unknown })?.dict instanceof PDFDict) collect((o as { dict: PDFDict }).dict, depth + 1);
    };
    collect(obj, 0);
    for (const dict of dicts) {
      if (REMOVE_KEYS.some(([key]) => dict.has(PDFName.of(key))) || nameOf(dict.get(PDFName.of("Type"))) === "EmbeddedFile" ||
          (nameOf(dict.get(PDFName.of("S"))) !== null && unsafeAction(dict))) {
        throw new PdfRejected("unclean", "The PDF could not be cleaned");
      }
    }
  }

  let bytes: Uint8Array;
  try {
    bytes = await doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  } catch {
    throw new PdfRejected("unclean", "The PDF could not be cleaned");
  }
  if (bytes.length > limits.maxBytes) throw tooBig();
  return { bytes, pages, removed: [...removed].sort() };
}

// ---------------------------------------------------------------- page pictures

export interface Picture {
  type: "webp" | "jpg";
  width: number;
  height: number;
}

/** The type (by the first bytes) and pixel size of a WebP or JPEG picture, or null. */
export function sniffPicture(b: Uint8Array): Picture | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    const chunk = ascii(12, 16);
    if (chunk === "VP8X") {
      const width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
      const height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
      return { type: "webp", width, height };
    }
    if (chunk === "VP8L" && b[20] === 0x2f) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { type: "webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { type: "webp", width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
    }
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const length = (b[i + 2] << 8) | b[i + 3];
      // SOF0–SOF15 except DHT (c4), JPG (c8) and DAC (cc)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: "jpg", width: (b[i + 7] << 8) | b[i + 8], height: (b[i + 5] << 8) | b[i + 6] };
      }
      i += 2 + length;
    }
    return null;
  }
  return null;
}

export const pagePath = (shop: string, section: string, version: number, page: number, size: number, ext: string) =>
  `${shop}/${section}/v${version}/${page}-${size}.${ext}`;

// ---------------------------------------------------------------- text as written (as in doc-ingest)

/** Only the layout is tidied; every word, number and price stays as the PDF has it. */
export function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t\u00a0]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Short, common words that give a language away (as in doc-ingest). */
const LANGUAGE_WORDS: Record<string, string[]> = {
  sk: ["a", "je", "na", "sa", "pre", "alebo", "ktorý", "ktoré", "nie", "aj", "so", "pri", "až", "už", "však", "ako", "sú", "bez", "cena", "výrobok"],
  cs: ["a", "je", "na", "se", "pro", "nebo", "který", "které", "není", "jsou", "při", "až", "už", "však", "jako", "také", "cena", "výrobek"],
  hu: ["a", "az", "és", "egy", "hogy", "nem", "is", "van", "vagy", "csak", "meg", "már", "ez", "mint", "ár", "termék", "nagyon", "minden"],
  en: ["the", "and", "of", "to", "is", "for", "with", "on", "are", "this", "or", "be", "from", "your", "price", "product"],
  de: ["der", "die", "und", "das", "ist", "mit", "für", "von", "den", "nicht", "ein", "eine", "auf", "oder", "preis", "zu"],
  pl: ["i", "w", "na", "się", "jest", "z", "do", "nie", "dla", "lub", "oraz", "że", "jak", "cena", "przy", "być"],
};
const LANGUAGE_LETTERS: Record<string, RegExp> = { sk: /[ľĺŕôä]/g, cs: /[řěů]/g, hu: /[őű]/g, pl: /[łąęśźżń]/g, de: /[ßü]/g };

/** The language a text is written in (ISO 639-1), or null when too short or unclear. */
export function detectLang(text: string): string | null {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 8) return null;
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  const lower = text.toLowerCase();
  let best: string | null = null;
  let bestScore = 0;
  let second = 0;
  for (const [lang, list] of Object.entries(LANGUAGE_WORDS)) {
    let score = list.reduce((sum, w) => sum + (counts.get(w) ?? 0), 0);
    score += 2 * (lower.match(LANGUAGE_LETTERS[lang] ?? /$^/g)?.length ?? 0);
    if (score > bestScore) {
      second = bestScore;
      bestScore = score;
      best = lang;
    } else if (score > second) second = score;
  }
  return bestScore >= 3 && bestScore > second * 1.2 ? best : null;
}

// ---------------------------------------------------------------- the AI reads pages without text

/** A page picture → its text as written. */
export type Reader = (image: Uint8Array, mediaType: "image/webp" | "image/jpeg") => Promise<string>;

const READ_PROMPT =
  "You get one page of a shop's own document (a newsletter, a leaflet, a menu, a price list). Write out all its " +
  "text exactly as written, in its own language and in reading order: every number, price, unit and code " +
  "unchanged. Put each table row on its own line with cells separated by \" | \". Never translate, correct, " +
  "shorten or add anything. Return an empty text when the page has no readable text.";

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Claude (AI_MODEL) with structured output, as doc-ingest reads scanned pages. */
export function claudeReader(apiKey: string, model: string): Reader {
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 90_000 });
  return async (image, mediaType) => {
    const message = await client.messages.create({
      model,
      max_tokens: 16000,
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
        },
      },
      system: READ_PROMPT,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: toBase64(image) } },
          { type: "text", text: "Write out the text of this page." },
        ],
      }],
    });
    if (message.stop_reason !== "end_turn") throw new Error(`the AI stopped: ${message.stop_reason}`);
    const block = message.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") throw new Error("the AI returned no text");
    return String((JSON.parse(block.text) as { text?: unknown }).text ?? "");
  };
}

// ---------------------------------------------------------------- requests

export interface Deps {
  /** The caller's own login: owner_* functions and RLS decide what it may reach. */
  asCaller: SupabaseClient;
  /** Service role: the sections_* steps and both buckets. */
  db: SupabaseClient;
  /** null when no ANTHROPIC_API_KEY is set: pages without text wait. */
  read: Reader | null;
}

type Body = Record<string, unknown>;
interface Owned {
  id: string;
  shop_id: string;
  version: number;
  upload_version: number | null;
  upload_pages: number | null;
  has_plan: boolean;
  /** The shop's plan's limits (update 30; absent before it). */
  plan?: string | null;
  max_pages?: number | null;
  max_bytes?: number | null;
}

/**
 * The limits for this section's shop: its plan's from the database (every shop since update
 * 30), within the caps; before update 30 only shops with the paid plan, with Pro's old limits.
 */
export function limitsOf(section: Pick<Owned, "has_plan" | "max_pages" | "max_bytes">): Limits | null {
  if (section.max_pages && section.max_bytes) {
    return { maxPages: Math.min(section.max_pages, CAP_PAGES), maxBytes: Math.min(section.max_bytes, CAP_BYTES) };
  }
  return section.has_plan ? DEFAULT_LIMITS : null;
}

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Max-Age": "86400",
    },
  });
}
const notMember = () => reply(403, { error: "not_member", message: "Only this shop's owners can do this" });
const uuidOrNull = (value: unknown) => (typeof value === "string" && UUID.test(value) ? value : null);
const int = (value: unknown) => (Number.isInteger(Number(value)) ? Number(value) : null);

/** The caller's own section (owner_section() checks the shop's membership), or null. */
async function owned(deps: Deps, id: unknown): Promise<Owned | null> {
  const sectionId = uuidOrNull(id);
  if (!sectionId) return null;
  const { data, error } = await deps.asCaller.rpc("owner_section", { p_section_id: sectionId });
  const row = (data as Omit<Owned, "id">[] | null)?.[0];
  return error || !row ? null : { id: sectionId, ...row };
}

/** Reads a request body of at most `max` bytes (null when longer). */
async function readBody(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > max) return null;
  const bytes = new Uint8Array(await req.arrayBuffer());
  return bytes.length > max ? null : bytes;
}

async function removeFiles(db: SupabaseClient, bucket: string, paths: string[]) {
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await db.storage.from(bucket).remove(paths.slice(i, i + 100));
    if (error) throw new Error(`storage: ${error.message}`);
  }
}

const REJECT_STATUS: Record<RejectCode, number> = {
  not_pdf: 415,
  too_big: 413,
  encrypted: 422,
  unreadable: 422,
  too_many_pages: 413,
  unclean: 422,
};

async function receivePdf(req: Request, url: URL, deps: Deps) {
  const section = await owned(deps, url.searchParams.get("section_id"));
  if (!section) return notMember();
  const limits = limitsOf(section);
  if (!limits) return reply(409, { error: "no_plan", message: "This shop has no paid plan" });
  const limitInfo = { max_pages: limits.maxPages, max_mb: mb(limits.maxBytes) };
  const body = await readBody(req, limits.maxBytes);
  if (!body) return reply(413, { error: "too_big", message: `A PDF may have at most ${mb(limits.maxBytes)} MB`, ...limitInfo });
  let cleaned: Cleaned;
  try {
    cleaned = await cleanPdf(body, limits);
  } catch (e) {
    if (e instanceof PdfRejected) {
      await deps.db.rpc("sections_upload_failed", { p_section_id: section.id, p_error: e.code });
      return reply(REJECT_STATUS[e.code], { error: e.code, message: e.message, ...limitInfo });
    }
    throw e;
  }
  const { data, error } = await deps.db.rpc("sections_begin_upload", {
    p_section_id: section.id,
    p_pages: cleaned.pages,
    p_bytes: cleaned.bytes.length,
  });
  if (error) return reply(409, { error: error.message, message: "The section takes no PDF now" });
  const row = (data as { version: number; pdf_path: string; stale_paths: string[] }[])[0];
  if (row.stale_paths?.length) await removeFiles(deps.db, PRIVATE, row.stale_paths);
  const { error: uploadError } = await deps.db.storage.from(PRIVATE).upload(row.pdf_path, cleaned.bytes, {
    contentType: "application/pdf",
    upsert: true,
  });
  if (uploadError) return reply(502, { error: "storage", message: uploadError.message });
  return reply(200, { version: row.version, pages: cleaned.pages, removed: cleaned.removed });
}

async function receivePage(req: Request, url: URL, deps: Deps) {
  const section = await owned(deps, url.searchParams.get("section_id"));
  if (!section) return notMember();
  const version = int(url.searchParams.get("version"));
  const page = int(url.searchParams.get("page"));
  const size = int(url.searchParams.get("size"));
  if (version === null || version !== section.upload_version || page === null || page < 1 ||
      page > (section.upload_pages ?? 0) || !SIZES.includes(size as 800 | 1600)) {
    return reply(400, { error: "bad_request", message: "A page of the PDF being uploaded, 800 or 1600 px" });
  }
  const body = await readBody(req, MAX_PICTURE_BYTES);
  if (!body) return reply(413, { error: "too_big", message: "A page picture may have at most 5 MB" });
  const picture = sniffPicture(body);
  if (!picture) return reply(415, { error: "type", message: "A page picture must be WebP or JPEG" });
  if (picture.width !== size || picture.height < 100 || picture.height > (size === 1600 ? 8000 : 4000)) {
    return reply(400, { error: "pixels", message: `The picture must be ${size} px wide` });
  }
  const path = pagePath(section.shop_id, section.id, version, page, size!, picture.type);
  const { error: uploadError } = await deps.db.storage.from(PRIVATE).upload(path, body, {
    contentType: picture.type === "webp" ? "image/webp" : "image/jpeg",
    upsert: true,
  });
  if (uploadError) return reply(502, { error: "storage", message: uploadError.message });
  const { error } = await deps.db.rpc("sections_page_stored", {
    p_section_id: section.id,
    p_version: version,
    p_page: page,
    p_size: size,
    p_ext: picture.type,
    p_bytes: body.length,
    p_width: picture.width,
    p_height: picture.height,
  });
  if (error) return reply(409, { error: "page", message: "Both pictures of a page must be of one type" });
  return reply(200, { ok: true });
}

async function saveText(body: Body, deps: Deps) {
  const section = await owned(deps, body.section_id);
  if (!section) return notMember();
  const version = int(body.version);
  if (version === null || version !== section.upload_version) {
    return reply(409, { error: "version", message: "This PDF takes no text now" });
  }
  const raw = Array.isArray(body.pages) ? (body.pages as Body[]) : [];
  const pages: { page: number; text: string }[] = [];
  for (const item of raw.slice(0, CAP_PAGES)) {
    const page = int(item?.page);
    if (page === null || page < 1 || page > (section.upload_pages ?? 0)) continue;
    pages.push({ page, text: cleanText(typeof item?.text === "string" ? item.text : "").slice(0, 20000) });
  }
  const lang = detectLang(pages.map((p) => p.text).join("\n").slice(0, 50_000));
  const { data, error } = await deps.db.rpc("sections_save_text", {
    p_section_id: section.id,
    p_version: version,
    p_pages: pages,
    p_lang: lang,
  });
  if (error) return reply(500, { error: "database", message: error.message });
  return reply(200, { pages: data, lang, without_text: pages.filter((p) => !p.text).length });
}

interface SyncRow {
  id: string;
  shop_id: string;
  version: number;
  public_version: number | null;
  visible: boolean;
  pages: { page: number; ext: string }[];
}

/** Copies a private picture into the public bucket (a copy, or download and upload). */
async function publish(db: SupabaseClient, path: string, ext: string) {
  const { error } = await db.storage.from(PRIVATE).copy(path, path, { destinationBucket: PUBLIC });
  if (!error) return;
  const { data, error: downloadError } = await db.storage.from(PRIVATE).download(path);
  if (downloadError || !data) throw new Error(`storage: ${downloadError?.message ?? "missing " + path}`);
  const { error: uploadError } = await db.storage.from(PUBLIC).upload(path, data, {
    contentType: ext === "webp" ? "image/webp" : "image/jpeg",
    cacheControl: PUBLIC_CACHE,
    upsert: true,
  });
  if (uploadError) throw new Error(`storage: ${uploadError.message}`);
}

/**
 * Puts sections' pictures into (or takes them out of) the public bucket, as the database says:
 * every section (the job), or every section of one shop (after an owner's action: on a free shop
 * one section's change can show or hide another; update 30), or one section (before update 30).
 */
export async function syncSections(deps: Deps, sectionId: string | null, shopId?: string): Promise<{ published: number; removed: number }> {
  let { data, error } = shopId
    ? await deps.db.rpc("sections_to_sync", { p_section_id: null, p_shop_id: shopId })
    : await deps.db.rpc("sections_to_sync", { p_section_id: sectionId });
  if (error && shopId) ({ data, error } = await deps.db.rpc("sections_to_sync", { p_section_id: sectionId }));
  if (error) throw new Error(error.message);
  let published = 0;
  let removed = 0;
  for (const row of (data ?? []) as SyncRow[]) {
    try {
      const paths = row.pages.flatMap((p) => SIZES.map((w) => ({ path: pagePath(row.shop_id, row.id, row.version, p.page, w, p.ext), ext: p.ext })));
      if (row.visible) {
        for (const { path, ext } of paths) await publish(deps.db, path, ext);
        await deps.db.rpc("sections_mark_public", { p_section_id: row.id, p_version: row.version });
        published++;
      } else {
        const old = row.public_version === row.version ? paths.map((p) => p.path) : [];
        await removeFiles(deps.db, PUBLIC, old);
        await deps.db.rpc("sections_mark_public", { p_section_id: row.id, p_version: null });
        removed++;
      }
    } catch (e) {
      console.error("page-sections: sync", row.id, e instanceof Error ? e.message : String(e));
    }
  }
  return { published, removed };
}

async function finish(body: Body, deps: Deps) {
  const section = await owned(deps, body.section_id);
  if (!section) return notMember();
  const version = int(body.version);
  const { data, error } = await deps.db.rpc("sections_finish", { p_section_id: section.id, p_version: version });
  if (error) {
    const code = error.message === "incomplete" ? "incomplete" : "version";
    return reply(409, { error: code, message: code === "incomplete" ? "Some pages are missing" : "This PDF is not being uploaded" });
  }
  const row = (data as { old_paths: string[]; old_public_paths: string[] }[])[0];
  await removeFiles(deps.db, PUBLIC, row.old_public_paths ?? []);
  await removeFiles(deps.db, PRIVATE, row.old_paths ?? []);
  const synced = await syncSections(deps, section.id, section.shop_id);
  return reply(200, { ok: true, public: synced.published > 0 });
}

/** The AI writes out pages without text (as written); `sectionId` null: any shop's (the hourly job). */
async function readPages(deps: Deps, sectionId: string | null, limit: number): Promise<{ done: number; failed: number }> {
  if (!deps.read) return { done: 0, failed: 0 };
  const { data, error } = await deps.db.rpc("sections_claim_ai", { p_section_id: sectionId, p_limit: limit });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { page_id: number; shop_id: string; section_id: string; version: number; page: number; ext: string }[];
  const read = deps.read;
  const results = await Promise.all(rows.map(async (row) => {
    try {
      const path = pagePath(row.shop_id, row.section_id, row.version, row.page, 1600, row.ext);
      const { data: file, error: downloadError } = await deps.db.storage.from(PRIVATE).download(path);
      if (downloadError || !file) throw new Error(`file missing: ${downloadError?.message ?? path}`);
      const text = cleanText(await read(new Uint8Array(await file.arrayBuffer()), row.ext === "webp" ? "image/webp" : "image/jpeg"));
      await deps.db.rpc("sections_save_ai_text", { p_page_id: row.page_id, p_text: text.slice(0, 20000), p_error: null });
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("page-sections: AI page", row.page_id, message);
      await deps.db.rpc("sections_save_ai_text", { p_page_id: row.page_id, p_text: null, p_error: message.slice(0, 500) });
      return false;
    }
  }));
  const done = results.filter(Boolean).length;
  return { done, failed: results.length - done };
}

async function work(body: Body, deps: Deps) {
  const section = await owned(deps, body.section_id);
  if (!section) return notMember();
  if (!deps.read) return reply(200, { done: 0, failed: 0, remaining: 0, ai: false });
  const result = await readPages(deps, section.id, AI_BATCH);
  const { count } = await deps.db
    .from("shop_section_pages")
    .select("id", { count: "exact", head: true })
    .eq("section_id", section.id)
    .eq("needs_ai", true)
    .lt("ai_attempts", 3);
  return reply(200, { ...result, remaining: count ?? 0 });
}

async function sync(body: Body, deps: Deps) {
  const section = await owned(deps, body.section_id);
  if (!section) return notMember();
  return reply(200, await syncSections(deps, section.id, section.shop_id));
}

async function preview(body: Body, deps: Deps) {
  const section = await owned(deps, body.section_id);
  if (!section) return notMember();
  const version = body.which === "upload" && section.upload_version ? section.upload_version : section.version;
  if (!version) return reply(200, { version: 0, pages: [] });
  const { data: rows, error } = await deps.asCaller
    .from("shop_section_pages")
    .select("page, width, height, ext, text, small_bytes, large_bytes")
    .eq("section_id", section.id)
    .eq("version", version)
    .order("page");
  if (error) return reply(500, { error: "database", message: error.message });
  const pages = ((rows ?? []) as { page: number; width: number; height: number; ext: string | null; text: string; small_bytes: number | null; large_bytes: number | null }[])
    .filter((p) => p.ext && p.small_bytes && p.large_bytes);
  const paths = pages.flatMap((p) => SIZES.map((w) => pagePath(section.shop_id, section.id, version, p.page, w, p.ext!)));
  const { data: signed } = paths.length
    ? await deps.db.storage.from(PRIVATE).createSignedUrls(paths, SIGNED_SECONDS)
    : { data: [] };
  const url = (i: number) => (signed as { signedUrl?: string | null }[] | null)?.[i]?.signedUrl ?? null;
  return reply(200, {
    version,
    pages: pages.map((p, i) => ({ page: p.page, width: p.width, height: p.height, text: p.text, small: url(2 * i), large: url(2 * i + 1) })),
  });
}

async function remove(body: Body, deps: Deps) {
  const section = await owned(deps, body.section_id);
  if (!section) return notMember();
  const sectionId = section.id;
  const { data, error } = await deps.asCaller.rpc("owner_section_files", { p_section_id: sectionId });
  if (error) return notMember();
  const files = (data ?? []) as { bucket: string; path: string }[];
  for (const bucket of [PUBLIC, PRIVATE]) {
    await removeFiles(deps.db, bucket, files.filter((f) => f.bucket === bucket).map((f) => f.path));
  }
  const { error: deleteError } = await deps.db.from("shop_page_sections").delete().eq("id", sectionId);
  if (deleteError) return reply(500, { error: "database", message: deleteError.message });
  // On a free shop the next section may now be shown.
  await syncSections(deps, null, section.shop_id).catch((e) => console.error("page-sections: sync", e instanceof Error ? e.message : String(e)));
  return reply(200, { deleted: files.length });
}

const JSON_ACTIONS: Record<string, (body: Body, deps: Deps) => Promise<Response>> = {
  text: saveText,
  finish,
  work,
  sync,
  preview,
  delete: remove,
};

/** The hourly job (pg_cron, header x-ppi-cron = the Vault secret ppi_assistant_cron). */
async function tick(deps: Deps) {
  const synced = await syncSections(deps, null);
  const ai = await readPages(deps, null, 6);
  return reply(200, { ...synced, ai });
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return reply(200, {});
  if (req.method !== "POST") return reply(405, { error: "method", message: "POST only" });
  const url = new URL(req.url);

  const cron = req.headers.get("x-ppi-cron");
  if (cron !== null) {
    const { data: ok } = await deps.db.rpc("assistant_cron_ok", { p_secret: cron });
    if (ok !== true) return reply(401, { error: "cron", message: "Wrong job secret" });
    return await tick(deps);
  }

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const { data: auth } = token ? await deps.asCaller.auth.getUser(token) : { data: null };
  if (!auth?.user) return reply(401, { error: "login", message: "Log in again" });

  const query = url.searchParams.get("action");
  try {
    if (query === "pdf") return await receivePdf(req, url, deps);
    if (query === "page") return await receivePage(req, url, deps);
    let body: Body;
    try {
      body = await req.json();
    } catch {
      return reply(400, { error: "bad_request", message: "JSON body expected" });
    }
    const action = JSON_ACTIONS[String(body?.action ?? "")];
    if (!action) return reply(400, { error: "bad_request", message: "Unknown action" });
    return await action(body, deps);
  } catch (e) {
    console.error("page-sections:", query ?? "json", e instanceof Error ? e.message : String(e));
    return reply(500, { error: "failed", message: "Something went wrong; try again" });
  }
}

// ---------------------------------------------------------------- HTTP entry

export async function handler(req: Request): Promise<Response> {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return reply(500, { error: "config", message: "Function is missing Supabase settings" });
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const asCaller = createClient(url, anonKey, {
    ...options,
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const db = createClient(url, serviceKey, options);
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY")?.trim();
  const model = Deno.env.get("AI_MODEL")?.trim() || DEFAULT_MODEL;
  return await handle(req, { asCaller, db, read: apiKey ? claudeReader(apiKey, model) : null });
}

if (!Deno.env.get("PPI_FUNCTION_TEST")) Deno.serve(handler);
