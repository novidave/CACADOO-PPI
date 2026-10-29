import "server-only";
import { supabaseEnv } from "./supabase/env";

/**
 * Searching across languages (update 40). Item names are searchable in every language they are translated into
 * (name_i18n), so most searches find them directly. When a search finds nothing — or is written in Chinese (no word
 * gaps, other letters) — Claude's translation of the search ("白色油漆" → "biela farba", "white paint") is searched
 * too: cached 30 days in the database (query_expansion()), made by the translate function. Only the search words go
 * out, never anything about the visitor.
 */

/** Chinese, Japanese or Korean letters. */
export function hasCjk(text: string): boolean {
  return /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/.test(text);
}

/** The search in other words; [] when not set up, on any error or after 4 s. */
export async function expandQuery(q: string): Promise<string[]> {
  const env = supabaseEnv();
  const query = q.trim().slice(0, 100);
  if (!env || !query) return [];
  const res = await fetch(`${env.url}/functions/v1/translate`, {
    method: "POST",
    headers: { apikey: env.key, Authorization: `Bearer ${env.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "query", q: query }),
    cache: "no-store",
    signal: AbortSignal.timeout(4_000),
  }).catch(() => null);
  const data = res?.ok ? ((await res.json().catch(() => null)) as { words?: unknown } | null) : null;
  return Array.isArray(data?.words) ? (data.words as unknown[]).filter((w): w is string => typeof w === "string" && w.trim() !== "").slice(0, 4) : [];
}

/** The forgiving search (update 54) finds most things itself: Claude's words only when it found fewer than this. */
export const FEW_RESULTS = 3;

/**
 * Runs a search, and — when it found fewer than 3 rows, or the search is Chinese — the same search with Claude's words
 * too (once; cached 30 days); the rows of every run once each, the direct hits first.
 */
export async function searchAcrossLanguages<T>(q: string, run: (q: string) => Promise<T[]>, key: (row: T) => string): Promise<T[]> {
  const direct = await run(q);
  if (!q.trim() || (direct.length >= FEW_RESULTS && !hasCjk(q))) return direct;
  const words = await expandQuery(q);
  if (!words.length) return direct;
  const seen = new Set(direct.map(key));
  const out = [...direct];
  for (const rows of await Promise.all(words.map((w) => run(w).catch(() => [] as T[])))) {
    for (const row of rows) {
      const k = key(row);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(row);
    }
  }
  return out;
}
