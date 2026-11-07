/**
 * The blog's small safe text format (2026-11-04, at the owner's request): a post written in Cacaduu (or a Facebook post
 * the owner rewrote with "Skrášliť článok" / "Opraviť gramatiku") may use a few marks, drawn on the server — never raw
 * HTML (the marks become React elements; every text stays text):
 *   "## Podnadpis"      a subheading (a line of its own)
 *   "- položka"         a bulleted list (lines next to each other)
 *   "1. položka"        a numbered list (starts at its first number)
 *   "> citát"           a quote (lines next to each other)
 *   "**tučné**"         bold inside a line
 *   "[[foto:<id>]]"     one of THIS post's photos, on a line of its own; unknown ids are dropped, each photo once;
 *                       since 2026-11-07 with options "[[foto:<id>|16:9]]" / "[[foto:<id>|1:1|hore]]": a ratio (orig ·
 *                       1:1 · 4:5 · 3:4 · 16:9; default orig = the photo's own, no crop) and a crop (hore · stred ·
 *                       dole; default stred); anything else is ignored (the photo is drawn as orig)
 * Links and hashtags are found as before; a text without marks reads exactly as before (paragraphs at empty lines,
 * line breaks kept). Every other use (excerpts, the slider, RSS, llms.txt, JSON-LD, search, reading time) takes
 * `plainBody()`; the Facebook message takes `facebookBody()` ("• " bullets, no markers).
 * No imports: used by the pages, the editor's preview and `blog_test.ts` (Deno).
 */

export type Inline =
  | { type: "text"; text: string; bold?: boolean }
  | { type: "link"; href: string; text: string; bold?: boolean }
  | { type: "tag"; text: string; bold?: boolean }
  | { type: "br" };

export type Block =
  | { type: "p"; parts: Inline[] }
  | { type: "h2"; parts: Inline[] }
  | { type: "ul"; items: Inline[][] }
  | { type: "ol"; start: number; items: Inline[][] }
  | { type: "quote"; parts: Inline[] }
  | { type: "photo"; id: string; ratio: PhotoRatio; crop: PhotoCrop };

/** A photo line's ratio (2026-11-07): "orig" = the photo's own (never cropped). */
export const PHOTO_RATIOS = ["orig", "1:1", "4:5", "3:4", "16:9"] as const;
export type PhotoRatio = (typeof PHOTO_RATIOS)[number];
/** Where a cropped photo is cut: the words as the owner writes them in the line. */
export const PHOTO_CROPS = { hore: "top", stred: "center", dole: "bottom" } as const;
export type PhotoCrop = (typeof PHOTO_CROPS)[keyof typeof PHOTO_CROPS];

const URL_OR_TAG = /(https?:\/\/[^\s<>"]+|www\.[^\s<>"]+\.[^\s<>"]+)|(^|[\s(])(#[\p{L}\p{N}_]+)/gu;
const TRAILING = /[.,;:!?…'"»”)\]]+$/u;
const HEADING = /^##[ \t]+(\S.*)$/;
const BULLET = /^-[ \t]+(\S.*)$/;
const NUMBERED = /^(\d{1,3})\.[ \t]+(\S.*)$/;
const QUOTE = /^>[ \t]?(.*)$/;
const PHOTO_LINE = /^\[\[foto:([0-9a-f-]{36})((?:\|[^|\]\s]*){0,2})\]\]$/i;
/** A marker anywhere (also cut short at the end of an excerpt). */
const MARKER = /\[\[foto:[^\]\s]*(?:\]\])?/gi;

/** A photo line's options ("|1:1|hore"): unknown values fall back to orig / center. */
export function photoOptions(options: string): { ratio: PhotoRatio; crop: PhotoCrop } {
  const [rawRatio = "", rawCrop = ""] = options.replace(/^\|/, "").split("|").map((x) => x.trim().toLowerCase());
  const ratio = (PHOTO_RATIOS as readonly string[]).includes(rawRatio) ? (rawRatio as PhotoRatio) : "orig";
  const crop = (PHOTO_CROPS as Record<string, PhotoCrop>)[rawCrop] ?? "center";
  return { ratio, crop: ratio === "orig" ? "center" : crop };
}

/** The line for a photo: "[[foto:<id>]]" for its own ratio, else "[[foto:<id>|1:1]]" / "[[foto:<id>|1:1|hore]]". */
export function photoLine(id: string, ratio: PhotoRatio = "orig", crop: PhotoCrop = "center"): string {
  if (ratio === "orig") return `[[foto:${id}]]`;
  const word = (Object.entries(PHOTO_CROPS).find(([, v]) => v === crop) ?? ["stred"])[0];
  return `[[foto:${id}|${ratio}${word === "stred" ? "" : `|${word}`}]]`;
}

/** The id and options of a line that is a photo line (else null). */
export function readPhotoLine(line: string): { id: string; ratio: PhotoRatio; crop: PhotoCrop } | null {
  const m = PHOTO_LINE.exec(line.trim());
  return m ? { id: m[1].toLowerCase(), ...photoOptions(m[2] ?? "") } : null;
}

/** The text with every line of this photo rewritten (`ratio`/`crop`) or removed (`null`). */
export function rewritePhotoLines(body: string, id: string, next: { ratio: PhotoRatio; crop: PhotoCrop } | null): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const photo = readPhotoLine(line);
    if (!photo || photo.id !== id.toLowerCase()) {
      out.push(line);
      continue;
    }
    if (next) out.push(photoLine(photo.id, next.ratio, next.crop));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** The width / height of a ratio ("4:5" → 0.8), null for orig. */
export function ratioValue(ratio: PhotoRatio): number | null {
  if (ratio === "orig") return null;
  const [w, h] = ratio.split(":").map(Number);
  return w / h;
}

/** How much of a photo a ratio cuts away (0 = nothing, 0.25 = a quarter); 0 for orig or an unknown size. */
export function cropLoss(width: number | null | undefined, height: number | null | undefined, ratio: PhotoRatio): number {
  const target = ratioValue(ratio);
  if (!target || !width || !height) return 0;
  const own = width / height;
  return own > target ? 1 - target / own : 1 - own / target;
}

/** A photo's orientation for the AI (landscape ≥ 1.25, square 0.8–1.25, portrait < 0.8). */
export function orientationOf(width: number | null | undefined, height: number | null | undefined): "landscape" | "square" | "portrait" | "unknown" {
  if (!width || !height) return "unknown";
  const r = width / height;
  return r >= 1.25 ? "landscape" : r >= 0.8 ? "square" : "portrait";
}

/** Links and hashtags of one line, as before (a "." or ")" right after a link belongs to the sentence). */
function linksAndTags(line: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  const text = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last?.type === "text") last.text += t;
    else out.push({ type: "text", text: t });
  };
  for (const m of line.matchAll(URL_OR_TAG)) {
    const start = m.index ?? 0;
    if (m[1]) {
      let tail = TRAILING.exec(m[1])?.[0] ?? "";
      let url = m[1].slice(0, m[1].length - tail.length);
      const count = (s: string, c: string) => s.split(c).length - 1;
      while (tail.startsWith(")") && count(url, "(") > count(url, ")")) {
        url += ")";
        tail = tail.slice(1);
      }
      text(line.slice(at, start));
      out.push({ type: "link", href: url.startsWith("www.") ? `https://${url}` : url, text: url });
      text(tail);
    } else {
      text(line.slice(at, start) + m[2]);
      out.push({ type: "tag", text: m[3] });
    }
    at = start + m[0].length;
  }
  text(line.slice(at));
  return out;
}

/** One line's inline parts: links and hashtags, and **bold** in pairs (an unpaired "**" stays as written). */
export function inlineParts(line: string, marks = true): Inline[] {
  const clean = line.replace(MARKER, "");
  if (!marks) return linksAndTags(clean);
  const pieces = clean.split("**");
  // an odd number of "**" in the line: the last one has no partner and stays text
  const pairs = pieces.length % 2 === 1 ? pieces : [...pieces.slice(0, -2), `${pieces[pieces.length - 2]}**${pieces[pieces.length - 1]}`];
  const out: Inline[] = [];
  pairs.forEach((piece, i) => {
    const bold = i % 2 === 1 && piece.trim().length > 0;
    const parts = linksAndTags(i % 2 === 1 && !bold ? `**${piece}**` : piece);
    for (const p of parts) out.push(bold && p.type !== "br" ? { ...p, bold: true } : p);
  });
  return out;
}

/**
 * The post's text as blocks. `formatted`: the marks count (posts written in Cacaduu, or rewritten by the owner); off =
 * the text exactly as before (paragraphs, lines, links, hashtags). `photoIds`: this post's photos — a marker is drawn
 * only for one of them, each once.
 */
export function formatBlocks(body: string, opts: { formatted: boolean; photoIds?: readonly string[] }): Block[] {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const known = new Set((opts.photoIds ?? []).map((id) => id.toLowerCase()));
  const used = new Set<string>();
  const blocks: Block[] = [];
  let open: Block | null = null;
  const close = () => {
    if (open) blocks.push(open);
    open = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/[ \t]+$/, "");
    if (!line.trim()) {
      close();
      continue;
    }
    if (opts.formatted) {
      const photo = readPhotoLine(line);
      if (photo) {
        close();
        if (known.has(photo.id) && !used.has(photo.id)) {
          used.add(photo.id);
          blocks.push({ type: "photo", id: photo.id, ratio: photo.ratio, crop: photo.crop });
        }
        continue;
      }
      const heading = HEADING.exec(line);
      if (heading) {
        close();
        blocks.push({ type: "h2", parts: inlineParts(heading[1]) });
        continue;
      }
      const bullet = BULLET.exec(line);
      if (bullet) {
        if (open?.type !== "ul") {
          close();
          open = { type: "ul", items: [] };
        }
        (open as Extract<Block, { type: "ul" }>).items.push(inlineParts(bullet[1]));
        continue;
      }
      const numbered = NUMBERED.exec(line);
      if (numbered) {
        if (open?.type !== "ol") {
          close();
          open = { type: "ol", start: Number(numbered[1]), items: [] };
        }
        (open as Extract<Block, { type: "ol" }>).items.push(inlineParts(numbered[2]));
        continue;
      }
      const quote = QUOTE.exec(line);
      if (quote) {
        if (open?.type !== "quote") {
          close();
          open = { type: "quote", parts: [] };
        }
        const q = open as Extract<Block, { type: "quote" }>;
        if (q.parts.length) q.parts.push({ type: "br" });
        q.parts.push(...inlineParts(quote[1]));
        continue;
      }
    }
    const parts = inlineParts(line, opts.formatted);
    if (!parts.length) continue;
    if (open?.type !== "p") {
      close();
      open = { type: "p", parts: [] };
    }
    const p = open as Extract<Block, { type: "p" }>;
    if (p.parts.length) p.parts.push({ type: "br" });
    p.parts.push(...parts);
  }
  close();
  return blocks;
}

/** The ids of the photos the text places (each once, only this post's): the gallery leaves them out. */
export function placedPhotos(body: string, photoIds: readonly string[]): string[] {
  return formatBlocks(body, { formatted: true, photoIds }).flatMap((b) => (b.type === "photo" ? [b.id] : []));
}

/** The text without marks: for excerpts, the slider, RSS, llms.txt, JSON-LD, search and reading time. */
export function plainBody(body: string): string {
  return body
    .replace(/\r\n?/g, "\n")
    .replace(MARKER, "")
    .split("\n")
    .map((line) =>
      line
        .replace(/^##[ \t]+/, "")
        .replace(/^-[ \t]+/, "")
        .replace(/^>[ \t]?/, "")
        .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, "$1"),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The text for the Facebook post: "• " bullets, numbers kept, headings as plain lines, no bold marks, no markers. */
export function facebookBody(body: string): string {
  return body
    .replace(/\r\n?/g, "\n")
    .replace(MARKER, "")
    .split("\n")
    .map((line) =>
      line
        .replace(/^##[ \t]+/, "")
        .replace(/^-[ \t]+/, "• ")
        .replace(/^>[ \t]?/, "")
        .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, "$1"),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
