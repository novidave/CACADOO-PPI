"use server";

import { getSession } from "@/lib/auth";
import type { IgnoreCandidate, IgnoredEntry } from "@/lib/ignoredItems";
import { refreshShop } from "@/lib/publicCache";

/**
 * "Ignorované produkty" (database update 88), called from the owner's browser. Every read and write goes through an
 * owner_* function that checks the caller is a member of the shop (and the Sklad refusal, the counts, the limit);
 * a change reads the shop's public pages again at once (refreshShop).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9-]{1,80}$/;

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface CandidatePage {
  items: IgnoreCandidate[];
  total: number;
  kind: "all" | "match" | "similar";
  matched: number;
  stale: boolean;
  source: string;
  shop_kind: string;
  shop_name: string;
  refusal: string | null;
  ignored: number;
}

export interface IgnoredPage {
  items: IgnoredEntry[];
  total: number;
  source: string;
}

async function db() {
  const s = await getSession();
  return s?.supabase ?? null;
}

const fail = (message: string | undefined): { ok: false; error: string } => ({
  ok: false,
  error: (message ?? "failed").slice(0, 80),
});

/** "Produkty zo súboru": all products by name, or what the shop page's search finds for q (50 at a time). */
export async function loadCandidates(shopId: string, q: string, offset = 0): Promise<Result<CandidatePage>> {
  const supabase = await db();
  if (!supabase || !UUID.test(shopId)) return fail("login");
  const { data, error } = await supabase.rpc("owner_ignore_candidates", {
    p_shop_id: shopId,
    p_q: q.trim().slice(0, 200) || null,
    p_limit: 50,
    p_offset: Math.max(0, Math.floor(offset)),
  });
  if (error) return fail(error.message);
  return { ok: true, value: data as CandidatePage };
}

/** "Ignorované (n)": newest first, 200 at a time. */
export async function loadIgnored(shopId: string, offset = 0): Promise<Result<IgnoredPage>> {
  const supabase = await db();
  if (!supabase || !UUID.test(shopId)) return fail("login");
  const { data, error } = await supabase.rpc("owner_ignored_items", {
    p_shop_id: shopId,
    p_limit: 200,
    p_offset: Math.max(0, Math.floor(offset)),
  });
  if (error) return fail(error.message);
  return { ok: true, value: data as IgnoredPage };
}

/** "Vymazať (n)" (ids) or "Vymazať všetko (n)" (ids null = everything the search q shows); expected = n shown. */
export async function ignoreItems(input: {
  shopId: string;
  slug: string;
  ids: string[] | null;
  q: string;
  expected: number;
}): Promise<Result<{ count: number; reset_id: number }>> {
  const supabase = await db();
  if (!supabase || !UUID.test(input.shopId) || !SLUG.test(input.slug)) return fail("login");
  if (input.ids && (input.ids.length > 5000 || !input.ids.every((id) => UUID.test(id)))) return fail("too_many");
  const { data, error } = await supabase.rpc("owner_ignore_items", {
    p_shop_id: input.shopId,
    p_ids: input.ids,
    p_q: input.ids ? null : input.q.trim().slice(0, 200) || null,
    p_expected: Math.max(0, Math.floor(input.expected)),
  });
  if (error) return fail(error.message);
  refreshShop(input.slug);
  const out = data as { count: number; reset_id: number };
  return { ok: true, value: { count: out.count, reset_id: out.reset_id } };
}

/** The toast's "Späť": exactly back from the trash (10 minutes, before the next file). */
export async function undoIgnore(input: { slug: string; resetId: number }): Promise<Result<{ count: number }>> {
  const supabase = await db();
  if (!supabase || !SLUG.test(input.slug) || !Number.isSafeInteger(input.resetId)) return fail("login");
  const { data, error } = await supabase.rpc("owner_ignore_undo", { p_reset_id: input.resetId });
  if (error) return fail(error.message);
  refreshShop(input.slug);
  return { ok: true, value: data as { count: number } };
}

/** "Obnoviť (n)": the keys leave the list; the products come back with the next file / sync. keys null = all. */
export async function unignoreItems(input: {
  shopId: string;
  keys: string[] | null;
  expected: number;
}): Promise<Result<{ count: number; source: string }>> {
  const supabase = await db();
  if (!supabase || !UUID.test(input.shopId)) return fail("login");
  if (input.keys && (input.keys.length > 5000 || input.keys.some((k) => typeof k !== "string" || k.length > 100))) return fail("too_many");
  const { data, error } = await supabase.rpc("owner_unignore_items", {
    p_shop_id: input.shopId,
    p_keys: input.keys,
    p_expected: Math.max(0, Math.floor(input.expected)),
  });
  if (error) return fail(error.message);
  return { ok: true, value: data as { count: number; source: string } };
}
