import { smsParts } from "./crm";

/**
 * Variables as tags (CRM → Správy, Šablóny, every message composer; 2026-11-04) and the checks around "Opraviť
 * gramatiku". The text is always stored as written — {meno}, {{shop_phone}} — and crm_render() fills it in; these only
 * help the owner put a variable where the cursor is and see that nothing broke. Tests: messageTags_test.ts (test:crm).
 */

/** The tags under a message or template text, in their order; `key` = the `contacts.var_*` text that explains it. */
export const MESSAGE_TAGS = [
  { token: "{meno}", key: "meno" },
  { token: "{obchod}", key: "obchod" },
  { token: "{produkt}", key: "produkt" },
  { token: "{datum}", key: "datum" },
  { token: "{cas}", key: "cas" },
  { token: "{{shop_phone}}", key: "shop_phone" },
  { token: "{{shop_email}}", key: "shop_email" },
  { token: "{{shop_address}}", key: "shop_address" },
  { token: "{{shop_web}}", key: "shop_web" },
] as const;

/** Every variable crm_render() knows (the tags above + the older {{name}} {{first_name}} {{shop}}). */
const KNOWN = new Set(["meno", "obchod", "produkt", "datum", "cas", "name", "first_name", "shop", "shop_phone", "shop_email", "shop_address", "shop_web"]);

/** "{meno}" / "{{shop_web}}" / "{ meno }" as they appear in a text, with where they are. */
export function variablesIn(text: string): { token: string; name: string; double: boolean; start: number; end: number }[] {
  const out = [];
  const re = /\{\{\s*([A-Za-z_][\w]*)\s*\}\}|\{\s*([A-Za-z_][\w]*)\s*\}/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ token: m[0], name: (m[1] ?? m[2]).toLowerCase(), double: m[1] !== undefined, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** The variables crm_render() would leave as they are ("Neznáma premenná {xyz}"), each once. */
export function unknownVariables(text: string): string[] {
  const seen = new Set<string>();
  for (const v of variablesIn(text)) {
    const known = v.double ? KNOWN.has(v.name) && !["meno", "obchod", "produkt", "datum", "cas"].includes(v.name) : ["meno", "obchod", "produkt", "datum", "cas"].includes(v.name);
    if (!known) seen.add(v.token);
  }
  return [...seen];
}

const WORDY = /[\p{L}\p{N}]/u;

/**
 * A tag put into a text at the cursor (start = end) or over the selection (start < end), also at a drop point (its
 * index). A space is added where the tag would touch a word ("Dobrý deň{meno}" → "Dobrý deň {meno}"). Returns the new
 * text and where the cursor goes (right after the tag).
 */
export function insertToken(text: string, start: number, end: number, token: string): { text: string; caret: number } {
  const a = Math.max(0, Math.min(start, end, text.length));
  const b = Math.max(a, Math.min(Math.max(start, end), text.length));
  const before = text.slice(0, a);
  const after = text.slice(b);
  const lead = before && WORDY.test(before.slice(-1)) ? " " : "";
  const trail = after && WORDY.test(after.charAt(0)) ? " " : "";
  const piece = lead + token + trail;
  return { text: before + piece + after, caret: before.length + lead.length + token.length };
}

/** A text as pieces for the preview line under the field: plain text and variables (known or not). */
export function tagPieces(text: string): { text: string; tag?: "known" | "unknown" }[] {
  const unknown = new Set(unknownVariables(text));
  const out: { text: string; tag?: "known" | "unknown" }[] = [];
  let at = 0;
  for (const v of variablesIn(text)) {
    if (v.start > at) out.push({ text: text.slice(at, v.start) });
    out.push({ text: v.token, tag: unknown.has(v.token) ? "unknown" : "known" });
    at = v.end;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

// ---------------------------------------------------------------- "Opraviť gramatiku"

/** The variables of a text, sorted (the same multiset must come back from the AI). */
const variableBag = (text: string) => variablesIn(text).map((v) => v.token.replace(/\s+/g, "")).sort();

/**
 * Whether a corrected text kept every {variable} exactly (the same ones, each as often) and every line break (the same
 * number of lines, empty lines too). Anything else is refused and the owner keeps the original.
 */
export function keepsStructure(before: string, after: string): boolean {
  const a = variableBag(before);
  const b = variableBag(after);
  return a.length === b.length && a.every((x, i) => x === b[i]) && before.split("\n").length === after.split("\n").length;
}

/**
 * Word by word: the corrected text as pieces, `changed` where it differs from the original (the longest common
 * subsequence of the words; spaces and line breaks kept).
 */
export function wordDiff(before: string, after: string): { text: string; changed: boolean }[] {
  const split = (s: string) => s.split(/(\s+)/).filter((x) => x !== "");
  const a = split(before);
  const b = split(after);
  const n = a.length;
  const m = b.length;
  // LCS table on the word level (texts are ≤ 10 000 characters; SMS and e-mails are far smaller)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { text: string; changed: boolean }[] = [];
  let i = 0;
  let j = 0;
  while (j < m) {
    if (i < n && a[i] === b[j]) {
      out.push({ text: b[j], changed: false });
      i++;
      j++;
    } else if (i < n && dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      out.push({ text: b[j], changed: !/^\s+$/.test(b[j]) });
      j++;
    }
  }
  // neighbouring pieces of the same kind joined
  return out.reduce<{ text: string; changed: boolean }[]>((acc, p) => {
    const last = acc[acc.length - 1];
    if (last && last.changed === p.changed) last.text += p.text;
    else acc.push({ ...p });
    return acc;
  }, []);
}

/** "Bez diakritiky": letters without their accents (ä → a, ő → o, ß stays), the variables untouched. */
export function withoutAccents(text: string): string {
  let out = "";
  let at = 0;
  for (const v of variablesIn(text)) {
    out += plain(text.slice(at, v.start)) + v.token;
    at = v.end;
  }
  return out + plain(text.slice(at));
}
const plain = (s: string) => s.normalize("NFD").replace(/[\u{0300}-\u{036f}]/gu, "").normalize("NFC");

/** An SMS before and after the correction: parts and GSM-7 / Unicode; `accentsCost` = the accents add SMS parts. */
export function smsCompare(before: string, after: string) {
  const a = smsParts(before);
  const b = smsParts(after);
  const plainAfter = smsParts(withoutAccents(after));
  return { before: a, after: b, accentsCost: b.parts > a.parts && plainAfter.parts < b.parts };
}

/** What "Opraviť gramatiku" sends to the AI: the text (and an e-mail's subject) of a message or template. */
export interface GrammarInput {
  text: string;
  subject?: string | null;
  channel: "sms" | "email";
}

/** The AI's part (the server's Claude call; tests pass a fake). */
export type GrammarAi = (input: GrammarInput) => Promise<{ text: string; subject: string | null; language: string; usage?: { input: number; output: number } }>;

export type GrammarResult =
  | { ok: true; text: string; subject: string | null; language: string; usage: { input: number; output: number } }
  | { ok: false; reason: "structure" | "empty" };

/**
 * The corrected text, only when the AI kept every variable and line break exactly (else the owner keeps the original:
 * "structure"). Nothing is sent or saved here — the owner decides with "Použiť" / "Zahodiť".
 */
export async function fixGrammarWith(ai: GrammarAi, input: GrammarInput): Promise<GrammarResult> {
  const text = input.text.replace(/\r\n/g, "\n");
  if (!text.trim()) return { ok: false, reason: "empty" };
  const subject = input.channel === "email" ? (input.subject ?? "") : null;
  const out = await ai({ text, subject, channel: input.channel });
  const fixed = String(out.text ?? "").replace(/\r\n/g, "\n");
  const fixedSubject = subject === null ? null : String(out.subject ?? subject);
  if (!fixed.trim() || !keepsStructure(text, fixed) || (subject !== null && !keepsStructure(subject, fixedSubject ?? ""))) {
    return { ok: false, reason: "structure" };
  }
  return { ok: true, text: fixed, subject: fixedSubject, language: String(out.language ?? ""), usage: out.usage ?? { input: 0, output: 0 } };
}
