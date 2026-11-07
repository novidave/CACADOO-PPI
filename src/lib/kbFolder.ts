/**
 * The rules of "Priečinok na počítači" (update 94): which files of the PC folder the assistant takes, which ones wait,
 * and what a check does with each — no imports (the browser component and kbFolder_test.ts in `npm run test:content`).
 *
 * Only the files directly in the folder (subfolders ignored). PDF / JPG / PNG / WebP / HEIC; others are listed as
 * "nepodporovaný typ". Hidden files and Office's "~$" lock files are not files of the folder at all. A file written in
 * the last 60 s waits for the next check (it may still be copied). A changed file (size or time) is read again and
 * its SHA-256 decides: the same content = nothing, else it replaces its own document (the same name in that folder).
 */

export type KbFileKind = "pdf" | "picture";

const PDF = /\.pdf$/i;
const PICTURE = /\.(jpe?g|png|webp|heic|heif)$/i;
/** How long a just-written file waits (it may still be copied into the folder). */
export const KB_SETTLE_MS = 60_000;
/** Between two checks of the folder. */
export const KB_EVERY_MS = 15 * 60_000;

/** "pdf" / "picture", null = not a type the assistant reads, undefined = not a file of the folder at all. */
export function kbFileKind(name: string): KbFileKind | null | undefined {
  if (!name || name.startsWith(".") || name.startsWith("~$")) return undefined;
  if (PDF.test(name)) return "pdf";
  if (PICTURE.test(name)) return "picture";
  return null;
}

/** A customer's project folder (update 95) also takes plain text notes (.txt, .md). */
export type ProjectFileKind = KbFileKind | "text";
const TEXT = /\.(txt|md)$/i;

export function projectFileKind(name: string): ProjectFileKind | null | undefined {
  const kind = kbFileKind(name);
  if (kind === null && TEXT.test(name)) return "text";
  return kind;
}

export interface KbEntry {
  name: string;
  size: number;
  /** lastModified (ms) */
  mtime: number;
}

/** What this browser remembers of a file it already read: its size, time and SHA-256. */
export interface KbSeen {
  size: number;
  mtime: number;
  hash: string;
}

/** A document or picture of the folder that came from the PC (owner_kb_folder_files). */
export interface KbKnown {
  kind: "document" | "picture";
  id: string;
  name: string | null;
  hash: string | null;
  status?: string | null;
  missing_since?: string | null;
}

export interface KbPlan {
  /** Supported files in the folder now (also the ones still waiting): what is not missing. */
  present: string[];
  /** Files to read and hash this time (new or changed since this browser last read them, and settled). */
  read: string[];
  /** Files whose size and time are as last read: their hash is known. */
  unchanged: { name: string; hash: string }[];
  /** Files written less than 60 s ago: next time. */
  waiting: string[];
  /** Not a type the assistant reads. */
  unsupported: string[];
}

/** One check's plan from the folder's files and what this browser saw last time. */
export function planCheck(
  entries: KbEntry[],
  seen: Record<string, KbSeen>,
  now: number,
  settleMs = KB_SETTLE_MS,
  kindOf: (name: string) => string | null | undefined = kbFileKind,
): KbPlan {
  const plan: KbPlan = { present: [], read: [], unchanged: [], waiting: [], unsupported: [] };
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const kind = kindOf(e.name);
    if (kind === undefined) continue;
    if (kind === null) {
      plan.unsupported.push(e.name);
      continue;
    }
    plan.present.push(e.name);
    const before = seen[e.name];
    if (before && before.size === e.size && before.mtime === e.mtime) {
      plan.unchanged.push({ name: e.name, hash: before.hash });
      continue;
    }
    if (now - e.mtime < settleMs) plan.waiting.push(e.name);
    else plan.read.push(e.name);
  }
  return plan;
}

/** What to do with a file whose SHA-256 is known: its document is the same, it is new, or it replaces one. */
export function kbAction(name: string, hash: string, known: KbKnown[]): { action: "same" | "new" | "replace"; old: KbKnown[] } {
  const mine = known.filter((k) => k.name === name);
  if (!mine.length) return { action: "new", old: [] };
  if (mine.some((k) => k.hash === hash && k.status !== "error")) return { action: "same", old: [] };
  return { action: "replace", old: mine };
}

/** A document's name in the assistant: the file name without its extension (as a hand upload names it). */
export function kbDocName(fileName: string): string {
  return fileName.replace(/\.[a-z0-9]+$/i, "").slice(0, 200) || fileName.slice(0, 200);
}
