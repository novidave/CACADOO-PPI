"use server";

import { createHash } from "node:crypto";
import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { forgetDatabaseTexts } from "@/i18n/dictionaries";
import { HANDWRITTEN } from "@/i18n/languages";
import { flatten } from "@/i18n/messages";
import en from "@/i18n/messages/en.json";
import sk from "@/i18n/messages/sk.json";
import { getSession } from "@/lib/auth";
import { refreshAll } from "@/lib/publicCache";

/**
 * "Admin → Preklady" (database update 40): the languages, the interface texts and the limits. The page is shown only
 * to is_admin; every action is checked again where it runs (the admin_* SQL functions and the translate function
 * ask is_admin() with the caller's own login).
 */

const LANG = /^[a-z]{2}(-(cyrl|hans|hant))?$/;
const KEY = /^[a-z0-9_]+(\.[a-z0-9_]+){1,3}$/;

/** md5 of a Slovak text: another Slovak text makes its translations "zastaraný". */
export async function sourceHash(text: string): Promise<string> {
  return createHash("md5").update(text, "utf8").digest("hex");
}

async function start(formData: FormData) {
  const value = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(value) ? value : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const keep = String(formData.get("keep") ?? "");
  const back = (query: Record<string, string>, at: string): never => {
    const params = new URLSearchParams(keep.startsWith("?") ? keep.slice(1) : keep);
    for (const [k, v] of Object.entries(query)) params.set(k, v);
    // A saved setting can change every shop's page (holidays, limits, languages): read again at once.
    if (query.ok) refreshAll();
    redirect(`/${lang}/admin/translations?${params}#${at}`);
  };
  return { session, back };
}

export async function saveLanguage(formData: FormData) {
  const { session, back } = await start(formData);
  const code = String(formData.get("code") ?? "");
  const { error } = await session.supabase.rpc("admin_save_language", {
    p_code: code,
    p_enabled: formData.get("enabled") === "on",
    p_indexed: formData.get("indexed") === "on",
  });
  if (error) back({ err: error.message }, "languages");
  back({ ok: "language" }, "languages");
}

export async function saveLimits(formData: FormData) {
  const { session, back } = await start(formData);
  const { error } = await session.supabase.rpc("admin_save_translation_limits", {
    p_free: Number(formData.get("free")),
    p_pro: Number(formData.get("pro")),
  });
  if (error) back({ err: error.message }, "limits");
  back({ ok: "limits" }, "limits");
}

/** "Uložiť" of one text (the admin's own: never replaced by Claude) and "Skontrolované". */
export async function saveUiText(formData: FormData) {
  const { session, back } = await start(formData);
  const target = String(formData.get("target") ?? "");
  const key = String(formData.get("key") ?? "");
  const source = (flatten(sk as never) as Record<string, string>)[key];
  if (!LANG.test(target) || !KEY.test(key) || source === undefined) back({ err: "key" }, "ui");
  const text = String(formData.get("text") ?? "").trim();
  const { error } = await session.supabase.rpc("admin_save_ui_text", {
    p_lang: target,
    p_key: key,
    p_text: text || null,
    p_source_hash: await sourceHash(source),
    p_checked: formData.get("checked") === "on",
  });
  if (error) back({ err: error.message }, "ui");
  forgetDatabaseTexts(target);
  back({ ok: "ui_text" }, `key-${key}`);
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** The keys of a language Claude should (re)write: none stored yet, or made from another Slovak text (never the admin's own of the same text). */
async function todo(supabase: NonNullable<Awaited<ReturnType<typeof getSession>>>["supabase"], target: string) {
  const { data, error } = await supabase.rpc("admin_ui_translations", { p_lang: target });
  if (error) throw new Error(error.message);
  const stored = new Map(((data ?? []) as { key: string; source_hash: string; status: string }[]).map((r) => [r.key, r]));
  const skFlat = flatten(sk as never) as Record<string, string>;
  const enFlat = flatten(en as never) as Record<string, string>;
  const out: { key: string; sk: string; en: string; hash: string }[] = [];
  for (const [key, text] of Object.entries(skFlat)) {
    if (!text.trim()) continue;
    const hash = await sourceHash(text);
    const row = stored.get(key);
    if (row && row.source_hash === hash) continue;
    out.push({ key, sk: text, en: enFlat[key] ?? "", hash });
  }
  return out;
}

/** "Preložiť chýbajúce texty": one part (≤ 150 texts) per call; the page calls again until nothing is left. */
export async function translateUiPart(target: string): Promise<Result<{ saved: number; left: number }>> {
  const session = await getSession();
  if (!session?.isAdmin) return { ok: false, error: "admin" };
  if (!LANG.test(target) || (HANDWRITTEN as readonly string[]).includes(target)) return { ok: false, error: "lang" };
  try {
    const items = (await todo(session.supabase, target)).slice(0, 150);
    if (!items.length) return { ok: true, value: { saved: 0, left: 0 } };
    const { data, error } = await session.supabase.functions.invoke<{ saved?: number; error?: string }>("translate", {
      body: { action: "ui", lang: target, items },
    });
    if (error || !data) return { ok: false, error: data?.error ?? "failed" };
    forgetDatabaseTexts(target);
    const left = (await todo(session.supabase, target)).length;
    return { ok: true, value: { saved: Number(data.saved ?? 0), left } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
