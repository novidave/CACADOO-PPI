/// <reference lib="deno.ns" />
// PPI · doc-ingest Edge Function
//
// Documents (PDFs) and pictures for a shop's assistant — a paid feature. Only the shop's
// owners, with their own login. The owner's browser reads the PDF (text page by page,
// the pictures in it, scanned pages rendered as images: pdf.js) and sends it here in
// small steps, POST {action, ...}:
//   register_document  {shop_id, folder_id, name, description, pages, bytes} → {document_id, path}
//                      (then the browser uploads the PDF to that path in the bucket "shop-docs")
//   document_uploaded  {document_id}                 the PDF is in storage
//   text               {document_id, pages: [{page, text}]}  text as written → excerpts
//   register_pictures  {shop_id, folder_id | document_id, lang, items: [{page, kind, title,
//                      caption, bytes, type}]} → [{idx, picture_id, path}] (then uploaded)
//   pictures_uploaded  {shop_id, picture_ids}
//   document_done      {document_id}                 everything of the PDF was sent
//   work               {shop_id} → {remaining}       the AI looks at the next few pictures
//                      (describes a picture once; writes out a scanned page's text as written)
//   links              {shop_id, picture_ids} → signed addresses (10 minutes) for the
//                      owner's thumbnails, and the shop's limits
//   delete             {kind: "document" | "picture", id}   files first, then text and rows
// The browser does the PDF reading because Edge Functions get only 2 seconds of CPU per
// request; here there is only light work and waiting for the AI.
// PPI never changes the owner's files or text and never translates them: the text is
// stored as written; the AI only writes a short description of each picture, which the
// owner may correct (then it is the owner's and never written again).
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name
// "doc-ingest" → paste this file → Deploy, then switch OFF "Verify JWT" (this function
// checks its callers itself). Secrets: ANTHROPIC_API_KEY (already set for stock-pull);
// optional AI_MODEL (default claude-haiku-5-5), SHOP_DOCS_MAX_FILES (30),
// SHOP_DOCS_MAX_PAGES (500), SHOP_DOCS_MAX_PICTURES (300) — limits per shop.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@0.131.0";

export const BUCKET = "shop-docs";
const DEFAULT_MODEL = "claude-haiku-5-5";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_PICTURE_BYTES = 10 * 1024 * 1024;
/** Text of at most this many pages / characters per "text" call. */
const MAX_TEXT_PAGES = 100;
const MAX_TEXT_CHARS = 2_000_000;
const MAX_ITEMS = 100;
/** Pictures the AI looks at per "work" call (side by side). */
const WORK_BATCH = 4;
const PICTURE_TYPES = ["image/webp", "image/jpeg", "image/png"];

export interface Limits {
  files: number;
  pages: number;
  pictures: number;
}

function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** The shop limits from the secrets (defaults 30 files, 500 pages, 300 pictures). */
export function readLimits(get: (name: string) => string | undefined = (n) => Deno.env.get(n)): Limits {
  return {
    files: positive(get("SHOP_DOCS_MAX_FILES"), 30),
    pages: positive(get("SHOP_DOCS_MAX_PAGES"), 500),
    pictures: positive(get("SHOP_DOCS_MAX_PICTURES"), 300),
  };
}

// ---------------------------------------------------------------- text as written

export interface PageText {
  page: number;
  text: string;
}

/**
 * Only the layout is tidied (line ends, spaces at line ends, runs of empty lines, control
 * characters); every word, number and price stays exactly as the PDF has it.
 */
export function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t ]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Splits text into pieces of up to `max` words at paragraph, then sentence, then word ends. */
function splitText(text: string, target: number, max: number, maxChars: number): string[] {
  const fits = (t: string) => wordCount(t) <= max && t.length <= maxChars;
  if (fits(text)) return [text];
  const units: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    if (fits(paragraph)) {
      units.push(paragraph);
      continue;
    }
    for (const sentence of paragraph.split(/(?<=[.!?…:;])\s+|\n/)) {
      if (fits(sentence)) {
        units.push(sentence);
        continue;
      }
      const words = sentence.split(/\s+/).filter(Boolean);
      let piece: string[] = [];
      for (const word of words) {
        if (piece.length >= target || (piece.join(" ").length + word.length + 1 > maxChars && piece.length)) {
          units.push(piece.join(" "));
          piece = [];
        }
        piece.push(word.slice(0, maxChars));
      }
      if (piece.length) units.push(piece.join(" "));
    }
  }
  const out: string[] = [];
  let current = "";
  for (const unit of units) {
    const joined = current ? `${current}\n\n${unit}` : unit;
    if (current && (wordCount(joined) > target || joined.length > maxChars)) {
      out.push(current);
      current = unit;
    } else current = joined;
  }
  if (current) out.push(current);
  return out;
}

/**
 * Excerpts for the assistant's search: each page on its own (so that the page named as
 * the source is always right), a long page in pieces of about 500 to 800 words.
 */
export function chunkPages(pages: PageText[], options = { target: 650, max: 800, maxChars: 8000 }): PageText[] {
  const out: PageText[] = [];
  for (const { page, text } of pages) {
    const clean = cleanText(text);
    if (!clean) continue;
    for (const piece of splitText(clean, options.target, options.max, options.maxChars)) out.push({ page, text: piece });
  }
  return out;
}

/** Short, common words that give a language away (no outside service, no AI). */
const LANGUAGE_WORDS: Record<string, string[]> = {
  sk: ["a", "je", "na", "sa", "pre", "alebo", "ktorý", "ktoré", "nie", "aj", "so", "pri", "až", "už", "však", "ako", "sú", "bez", "cena", "výrobok"],
  cs: ["a", "je", "na", "se", "pro", "nebo", "který", "které", "není", "jsou", "při", "až", "už", "však", "jako", "také", "cena", "výrobek"],
  hu: ["a", "az", "és", "egy", "hogy", "nem", "is", "van", "vagy", "csak", "meg", "már", "ez", "mint", "ár", "termék", "nagyon", "minden"],
  en: ["the", "and", "of", "to", "is", "for", "with", "on", "are", "this", "or", "be", "from", "your", "price", "product"],
  de: ["der", "die", "und", "das", "ist", "mit", "für", "von", "den", "nicht", "ein", "eine", "auf", "oder", "preis", "zu"],
  pl: ["i", "w", "na", "się", "jest", "z", "do", "nie", "dla", "lub", "oraz", "że", "jak", "cena", "przy", "być"],
  it: ["il", "di", "che", "e", "la", "per", "con", "non", "una", "sono", "del", "della", "le", "gli", "prezzo", "anche"],
  fr: ["le", "la", "les", "et", "de", "des", "du", "est", "pour", "avec", "une", "dans", "sur", "pas", "prix", "ou"],
  es: ["el", "la", "los", "las", "y", "de", "que", "es", "para", "con", "una", "por", "del", "precio", "no", "en"],
  ro: ["și", "de", "la", "în", "este", "pentru", "cu", "un", "o", "sau", "nu", "din", "care", "preț", "pe", "sunt"],
  hr: ["i", "je", "u", "na", "za", "se", "da", "od", "ili", "nije", "su", "kao", "cijena", "sa", "proizvod", "koji"],
  sl: ["in", "je", "v", "na", "za", "se", "da", "ali", "so", "pri", "kot", "cena", "izdelek", "ki", "tudi", "brez"],
  nl: ["de", "het", "een", "en", "van", "is", "voor", "met", "op", "niet", "zijn", "of", "prijs", "te", "bij", "ook"],
  pt: ["o", "a", "os", "as", "e", "de", "que", "é", "para", "com", "uma", "do", "da", "preço", "não", "em"],
};
/** Letters only one or two of these languages use. */
const LANGUAGE_LETTERS: Record<string, RegExp> = {
  sk: /[ľĺŕôä]/g,
  cs: /[řěů]/g,
  hu: /[őű]/g,
  pl: /[łąęśźżń]/g,
  ro: /[ășțâî]/g,
  de: /[ßü]/g,
  hr: /[đć]/g,
};

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

// ---------------------------------------------------------------- the AI looks at pictures

export interface LookInput {
  kind: "picture" | "scan";
  image: Uint8Array;
  mediaType: string;
  /** Write the description in this language (the document's, else the owner's page language). */
  lang: string | null;
  /** The owner's own title and caption, for context. */
  title: string;
  caption: string;
}
/** A picture's description, or a scanned page's text as written. */
export type Looker = (input: LookInput) => Promise<{ description?: string; text?: string }>;

export function languageName(lang: string | null): string | null {
  if (!lang) return null;
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(lang) ?? null;
  } catch {
    return null;
  }
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const DESCRIBE_PROMPT =
  "You describe one picture from a shop for the shop's assistant, which answers shoppers' questions and may " +
  "show the picture when it fits. Write a short, factual description (1 to 4 sentences): what is shown, any " +
  "visible text exactly as written, brand, model and part numbers. Describe only what you see; never guess " +
  "prices, stock or availability. Never name or describe who a person is. The owner's title and caption, when " +
  "given, are only context; do not repeat them.";
const READ_PROMPT =
  "You get one scanned page of a shop's document. Write out all its text exactly as written, in its own " +
  "language and in reading order: every number, price, unit and code unchanged. Put each table row on its own " +
  "line with cells separated by \" | \". Never translate, correct, shorten or add anything. Return an empty text " +
  "when the page has no readable text.";

/** Claude (AI_MODEL) with structured output: always one JSON object. */
export function claudeLooker(apiKey: string, model: string): Looker {
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 90_000 });
  return async (input) => {
    const scan = input.kind === "scan";
    const property = scan ? "text" : "description";
    const language = languageName(input.lang);
    const note = scan
      ? "Write out the text of this page."
      : [
        `Write the description in ${language ?? "the language of the visible text, else English"}.`,
        input.title ? `The owner's title: ${input.title}` : "",
        input.caption ? `The owner's caption: ${input.caption}` : "",
      ].filter(Boolean).join("\n");
    const message = await client.messages.create({
      model,
      max_tokens: scan ? 16000 : 2000,
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { [property]: { type: "string" } },
            required: [property],
            additionalProperties: false,
          },
        },
      },
      system: scan ? READ_PROMPT : DESCRIBE_PROMPT,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: input.mediaType as "image/jpeg" | "image/png" | "image/webp",
              data: toBase64(input.image),
            },
          },
          { type: "text", text: note },
        ],
      }],
    });
    if (message.stop_reason !== "end_turn") throw new Error(`the AI stopped: ${message.stop_reason}`);
    const block = message.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") throw new Error("the AI returned no text");
    const value = String((JSON.parse(block.text) as Record<string, unknown>)[property] ?? "");
    return scan ? { text: value } : { description: value.trim().slice(0, 2000) };
  };
}

// ---------------------------------------------------------------- requests

export interface Deps {
  /** The caller's own login: is_shop_member() and RLS decide what it may reach. */
  asCaller: SupabaseClient;
  /** Service role: registering, saving text, storage. */
  db: SupabaseClient;
  limits: Limits;
  /** null when no ANTHROPIC_API_KEY is set: pictures wait. */
  look: Looker | null;
}

type Body = Record<string, unknown>;

const clean = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
const uuidOrNull = (value: unknown) => (typeof value === "string" && UUID.test(value) ? value : null);
const uuids = (value: unknown) =>
  Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string" && UUID.test(v)))] : [];

const REGISTER_ERRORS: Record<string, string> = {
  no_plan: "This shop has no paid plan",
  terms: "Tick the box about who can see documents first",
  folder: "Choose a folder of this shop",
  document: "That document cannot take more pictures",
  limit_files: "The shop has reached its number of documents",
  limit_pages: "The shop has reached its number of pages",
};

function registerError(error: { message?: string; code?: string } | null) {
  const code = error?.message ?? "";
  if (error?.code === "P0001" && REGISTER_ERRORS[code]) return reply(409, { error: code, message: REGISTER_ERRORS[code] });
  return reply(500, { error: "database", message: error?.message ?? "Not saved" });
}

async function isMember(deps: Deps, shopId: string | null): Promise<boolean> {
  if (!shopId) return false;
  const { data } = await deps.asCaller.rpc("is_shop_member", { p_shop_id: shopId });
  return data === true;
}

interface DocumentRow {
  id: string;
  shop_id: string;
  status: string;
  extracted: boolean;
  storage_path: string;
  pages: number;
}

/** A document of the caller's own shop (RLS: members read), or null. */
async function ownDocument(deps: Deps, id: unknown): Promise<DocumentRow | null> {
  const documentId = uuidOrNull(id);
  if (!documentId) return null;
  const { data } = await deps.asCaller
    .from("shop_documents")
    .select("id, shop_id, status, extracted, storage_path, pages")
    .eq("id", documentId)
    .maybeSingle();
  return (data as DocumentRow | null) ?? null;
}

/** The stored file's size, or null when it is not in storage. */
async function storedSize(db: SupabaseClient, path: string): Promise<number | null> {
  const slash = path.lastIndexOf("/");
  const { data, error } = await db.storage.from(BUCKET).list(path.slice(0, slash), {
    search: path.slice(slash + 1),
    limit: 10,
  });
  if (error) throw new Error(error.message);
  const file = (data ?? []).find((f) => f.name === path.slice(slash + 1));
  return file ? Number(file.metadata?.size ?? 0) : null;
}

async function registerDocument(body: Body, deps: Deps) {
  const shopId = uuidOrNull(body.shop_id);
  const folderId = uuidOrNull(body.folder_id);
  const name = clean(body.name, 200);
  const pages = Number(body.pages);
  const bytes = Number(body.bytes);
  if (!shopId || !folderId || !name || !Number.isInteger(pages) || pages < 1 || pages > 5000 || !(bytes > 0)) {
    return reply(400, { error: "bad_request", message: "shop_id, folder_id, name, pages and bytes are required" });
  }
  if (bytes > MAX_PDF_BYTES) return reply(413, { error: "too_big", message: "A PDF may have at most 20 MB" });
  if (!(await isMember(deps, shopId))) return notMember();
  const { data, error } = await deps.db.rpc("docs_register_document", {
    p_shop_id: shopId,
    p_folder_id: folderId,
    p_name: name,
    p_description: clean(body.description, 500) || null,
    p_pages: pages,
    p_bytes: bytes,
    p_max_files: deps.limits.files,
    p_max_pages: deps.limits.pages,
  });
  if (error) return registerError(error);
  const row = (data as { document_id: string; storage_path: string }[])[0];
  return reply(200, { document_id: row.document_id, path: row.storage_path, bucket: BUCKET });
}

async function documentUploaded(body: Body, deps: Deps) {
  const doc = await ownDocument(deps, body.document_id);
  if (!doc) return notMember();
  const size = await storedSize(deps.db, doc.storage_path);
  if (size === null) return reply(409, { error: "not_uploaded", message: "The PDF is not in storage" });
  if (size > MAX_PDF_BYTES) {
    await deps.db.storage.from(BUCKET).remove([doc.storage_path]);
    return reply(413, { error: "too_big", message: "A PDF may have at most 20 MB" });
  }
  const { error } = await deps.db.rpc("docs_document_uploaded", { p_document_id: doc.id });
  if (error) return reply(500, { error: "database", message: error.message });
  return reply(200, { ok: true });
}

async function saveText(body: Body, deps: Deps) {
  const doc = await ownDocument(deps, body.document_id);
  if (!doc) return notMember();
  if (doc.status !== "processing" || doc.extracted) {
    return reply(409, { error: "document", message: "This document takes no more text" });
  }
  const raw = Array.isArray(body.pages) ? body.pages : [];
  if (raw.length > MAX_TEXT_PAGES) return reply(413, { error: "too_big", message: "Send at most 100 pages at once" });
  const pages: PageText[] = [];
  let chars = 0;
  for (const item of raw as Body[]) {
    const page = Number(item?.page);
    const text = typeof item?.text === "string" ? item.text : "";
    if (!Number.isInteger(page) || page < 1 || page > doc.pages) continue;
    chars += text.length;
    pages.push({ page, text });
  }
  if (chars > MAX_TEXT_CHARS) return reply(413, { error: "too_big", message: "Too much text at once" });
  const chunks = chunkPages(pages);
  const lang = detectLang(pages.map((p) => p.text).join("\n").slice(0, 50_000));
  const { data, error } = await deps.db.rpc("docs_save_text", {
    p_document_id: doc.id,
    p_chunks: chunks,
    p_lang: lang,
  });
  if (error) return reply(500, { error: "database", message: error.message });
  return reply(200, { chunks: data, lang });
}

async function registerPictures(body: Body, deps: Deps) {
  const shopId = uuidOrNull(body.shop_id);
  const documentId = uuidOrNull(body.document_id);
  const folderId = uuidOrNull(body.folder_id);
  const raw = Array.isArray(body.items) ? (body.items as Body[]) : [];
  if (!shopId || (!documentId && !folderId) || raw.length === 0) {
    return reply(400, { error: "bad_request", message: "shop_id, folder_id or document_id, and items are required" });
  }
  if (raw.length > MAX_ITEMS) return reply(413, { error: "too_big", message: "Send at most 100 pictures at once" });
  const items = [];
  for (const item of raw) {
    const bytes = Number(item?.bytes);
    const type = String(item?.type ?? "");
    if (!(bytes > 0) || !PICTURE_TYPES.includes(type)) {
      return reply(400, { error: "bad_request", message: "Each picture needs its size and type (WebP, JPEG or PNG)" });
    }
    if (bytes > MAX_PICTURE_BYTES) return reply(413, { error: "too_big", message: "A picture may have at most 10 MB" });
    items.push({
      page: Number.isInteger(Number(item?.page)) ? Number(item.page) : null,
      kind: item?.kind === "scan" ? "scan" : "picture",
      title: clean(item?.title, 200),
      caption: clean(item?.caption, 500),
      bytes,
      type,
    });
  }
  if (!(await isMember(deps, shopId))) return notMember();
  const lang = typeof body.lang === "string" && /^[a-z]{2}$/.test(body.lang) ? body.lang : null;
  const { data, error } = await deps.db.rpc("docs_register_pictures", {
    p_shop_id: shopId,
    p_folder_id: documentId ? null : folderId,
    p_document_id: documentId,
    p_items: items,
    p_lang: lang,
    p_max_pictures: deps.limits.pictures,
  });
  if (error) return registerError(error);
  const pictures = (data as { idx: number; picture_id: string | null; storage_path: string | null }[]).map((r) => ({
    idx: r.idx,
    picture_id: r.picture_id,
    path: r.storage_path,
  }));
  return reply(200, { pictures, bucket: BUCKET });
}

async function picturesUploaded(body: Body, deps: Deps) {
  const shopId = uuidOrNull(body.shop_id);
  const ids = uuids(body.picture_ids).slice(0, MAX_ITEMS);
  if (!(await isMember(deps, shopId))) return notMember();
  const { data, error } = await deps.db.rpc("docs_pictures_uploaded", { p_shop_id: shopId, p_picture_ids: ids });
  if (error) return reply(500, { error: "database", message: error.message });
  return reply(200, { count: data });
}

async function documentDone(body: Body, deps: Deps) {
  const doc = await ownDocument(deps, body.document_id);
  if (!doc) return notMember();
  const { error } = await deps.db.rpc("docs_document_extracted", { p_document_id: doc.id });
  if (error) return reply(500, { error: "database", message: error.message });
  const { data: remaining } = await deps.db.rpc("docs_finish", { p_shop_id: doc.shop_id });
  return reply(200, { ok: true, remaining });
}

interface PictureRow {
  id: string;
  kind: "picture" | "scan";
  storage_path: string;
  lang: string | null;
  title: string;
  caption: string | null;
}

/** The AI looks at one picture or scanned page; the result (or the failure) is saved. */
async function lookAt(row: PictureRow, deps: Deps, look: Looker): Promise<boolean> {
  try {
    const { data, error } = await deps.db.storage.from(BUCKET).download(row.storage_path);
    if (error || !data) throw new Error(`file missing: ${error?.message ?? row.storage_path}`);
    const image = new Uint8Array(await data.arrayBuffer());
    const mediaType = row.storage_path.endsWith(".jpg")
      ? "image/jpeg"
      : row.storage_path.endsWith(".png")
      ? "image/png"
      : "image/webp";
    const seen = await look({ kind: row.kind, image, mediaType, lang: row.lang, title: row.title, caption: row.caption ?? "" });
    const chunks = row.kind === "scan" ? chunkPages([{ page: 1, text: seen.text ?? "" }]).map((c) => c.text) : null;
    const { error: saveError } = await deps.db.rpc("docs_save_work", {
      p_picture_id: row.id,
      p_description: row.kind === "picture" ? seen.description ?? "" : null,
      p_chunks: chunks,
      p_error: null,
    });
    if (saveError) throw new Error(saveError.message);
    return true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("doc-ingest: picture", row.id, message);
    await deps.db.rpc("docs_save_work", { p_picture_id: row.id, p_description: null, p_chunks: null, p_error: message });
    return false;
  }
}

async function work(body: Body, deps: Deps) {
  const shopId = uuidOrNull(body.shop_id);
  if (!(await isMember(deps, shopId))) return notMember();
  const finish = async () => Number((await deps.db.rpc("docs_finish", { p_shop_id: shopId })).data ?? 0);
  if (!deps.look) return reply(200, { done: 0, failed: 0, remaining: await finish(), ai: false });
  const { data: plan } = await deps.db.rpc("shop_has_plan", { p_shop_id: shopId });
  if (plan !== true) return reply(200, { done: 0, failed: 0, remaining: await finish(), plan: false });

  const { data, error } = await deps.db.rpc("docs_claim_work", { p_shop_id: shopId, p_limit: WORK_BATCH });
  if (error) return reply(500, { error: "database", message: error.message });
  const look = deps.look;
  const results = await Promise.all(((data ?? []) as PictureRow[]).map((row) => lookAt(row, deps, look)));
  const done = results.filter(Boolean).length;
  return reply(200, { done, failed: results.length - done, remaining: await finish() });
}

async function links(body: Body, deps: Deps) {
  const shopId = uuidOrNull(body.shop_id);
  if (!(await isMember(deps, shopId))) return notMember();
  const out: { pictures: Record<string, string>; limits: Limits } = { pictures: {}, limits: deps.limits };
  const ids = uuids(body.picture_ids).slice(0, 300);
  if (ids.length) {
    const { data: rows } = await deps.asCaller.rpc("owner_picture_paths", { p_shop_id: shopId, p_ids: ids });
    const list = (rows ?? []) as { id: string; storage_path: string }[];
    if (list.length) {
      const { data: signed } = await deps.db.storage.from(BUCKET).createSignedUrls(list.map((r) => r.storage_path), 600);
      for (const [i, row] of list.entries()) {
        const url = signed?.[i]?.signedUrl;
        if (url) out.pictures[row.id] = url;
      }
    }
  }
  return reply(200, out);
}

/** Files first (they would otherwise stay in storage), then the rows: text and pictures go with them. */
async function remove(body: Body, deps: Deps) {
  const kind = body.kind === "document" || body.kind === "picture" ? body.kind : null;
  const id = uuidOrNull(body.id);
  if (!kind || !id) return reply(400, { error: "bad_request", message: "kind and id are required" });
  const { data: paths, error } = await deps.asCaller.rpc("owner_docs_files", { p_kind: kind, p_id: id });
  if (error) return notMember();
  const files = ((paths ?? []) as string[]).filter(Boolean);
  if (files.length) {
    const { error: storageError } = await deps.db.storage.from(BUCKET).remove(files);
    if (storageError) return reply(502, { error: "storage", message: storageError.message });
  }
  const { error: deleteError } = await deps.db.from(kind === "document" ? "shop_documents" : "shop_pictures").delete().eq("id", id);
  if (deleteError) return reply(500, { error: "database", message: deleteError.message });
  return reply(200, { deleted: files.length });
}

const ACTIONS: Record<string, (body: Body, deps: Deps) => Promise<Response>> = {
  register_document: registerDocument,
  document_uploaded: documentUploaded,
  text: saveText,
  register_pictures: registerPictures,
  pictures_uploaded: picturesUploaded,
  document_done: documentDone,
  work,
  links,
  delete: remove,
};

export async function ingest(req: Request, deps: Deps): Promise<Response> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const { data: auth } = token ? await deps.asCaller.auth.getUser(token) : { data: null };
  if (!auth?.user) return reply(401, { error: "login", message: "Log in again" });

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: "bad_request", message: "JSON body expected" });
  }
  const action = ACTIONS[String(body?.action ?? "")];
  if (!action) return reply(400, { error: "bad_request", message: "Unknown action" });
  try {
    return await action(body, deps);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("doc-ingest:", body.action, message);
    return reply(500, { error: "failed", message });
  }
}

// ---------------------------------------------------------------- HTTP entry

function notMember() {
  return reply(403, { error: "not_member", message: "Only this shop's owners can do this" });
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

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return reply(200, {});
  if (req.method !== "POST") return reply(405, { error: "method", message: "POST only" });

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
  return await ingest(req, { asCaller, db, limits: readLimits(), look: apiKey ? claudeLooker(apiKey, model) : null });
}

if (!Deno.env.get("PPI_FUNCTION_TEST")) Deno.serve(handler);
