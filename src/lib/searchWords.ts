/**
 * The forgiving search's word rules (database update 54) as the browser and the server need them for one thing only:
 * marking the words of a result that the search matched. The search itself is decided in SQL (shop_item_search(),
 * item_search()); these functions mirror public.search_text() and public.search_stem() so the marks agree with it.
 * Shared with `searchWords_test.ts`.
 */

const ENDINGS = [
  "ovanie", "ovych", "oveho", "ovemu", "ovymi", "ovej", "ovou", "ovom", "iach",
  "ove", "ova", "ovy", "ovi", "ovu", "eho", "emu", "ych", "ich", "ymi", "imi", "ami", "ach", "och",
  "ies", "es", "ic", "ik", "ek", "ok", "ka", "ky", "ki", "ke", "ku", "ny", "na", "ne", "ni", "nu",
  "a", "e", "i", "o", "u", "y", "s",
].sort((a, b) => b.length - a.length);

/** Lower case without accents, like public.search_text() (unaccent + lower). */
export function searchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[łŁ]/g, "l")
    .replace(/[đĐ]/g, "d")
    .replace(/[øØ]/g, "o")
    .toLowerCase();
}

/** One word → its stem, like public.search_stem(): the longest known ending cut (≥ 4 letters stay), then c/k, y/i … */
export function searchStem(word: string): string {
  const v = searchText(word);
  if (/^[0-9]/.test(v)) return v;
  const ending = ENDINGS.find((s) => v.endsWith(s) && v.length - s.length >= 4);
  const cut = ending ? v.slice(0, v.length - ending.length) : v;
  return cut
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/[cyqw]/g, (ch) => ({ c: "k", y: "i", q: "k", w: "v" })[ch] as string);
}

/** Edit distance (small words only). */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

/** Whether a word of a result is one the search matched (the same rule as public.search_word_match(), any score). */
export function wordMatches(word: string, matched: readonly string[]): boolean {
  const s = searchStem(word);
  if (!s) return false;
  return matched.some((m) => {
    if (!m) return false;
    if (s === m) return true;
    if (m.length >= 3 && s.startsWith(m)) return true;
    if (s.length >= 4 && m.startsWith(s)) return true;
    if (/^[0-9]/.test(m) || /^[0-9]/.test(s)) return false;
    if (m.length >= 4 && Math.abs(s.length - m.length) <= 2 && distance(m, s) <= (m.length >= 7 ? 2 : 1)) return true;
    return m.length >= 5 && s.length > m.length && distance(m, s.slice(0, m.length)) <= 1;
  });
}

/** A text cut into parts, the matched words marked (for <mark>); the text itself is never changed. */
export function highlightParts(text: string, matched: readonly string[]): { text: string; hit: boolean }[] {
  if (!matched.length) return [{ text, hit: false }];
  const parts: { text: string; hit: boolean }[] = [];
  for (const piece of text.split(/([\p{L}\p{N}]+)/u)) {
    if (!piece) continue;
    const hit = /[\p{L}\p{N}]/u.test(piece) && wordMatches(piece, matched);
    const last = parts[parts.length - 1];
    if (last && last.hit === hit) last.text += piece;
    else parts.push({ text: piece, hit });
  }
  return parts;
}
