import "server-only";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary, t, type Dictionary } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import type { AdminKey } from "@/lib/adminPages";

/**
 * What every admin page shares (2026-11-05): the start (the language, the texts, the admin's login — notFound()
 * unless session.isAdmin; is_admin() in SQL still decides every read and write), the hidden fields every form carries
 * (the language and the page's own query, so @/lib/adminPages' adminBack returns to it), the page's head (28 px title +
 * one line) and the message after a save (?ok= / ?err=, the texts of the old long page).
 */

export type AdminSearch = Record<string, string | string[] | undefined>;

export const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

export async function adminStart(params: Promise<{ lang: string }>) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  if (!session.isAdmin) notFound();
  return { lang: lang as Locale, dict, session };
}

export async function adminTitle(params: Promise<{ lang: string }>, key: AdminKey) {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).admin_nav[key] };
}

/** The two hidden fields of every admin form: the language and the page's query ("?…") to return to. */
export function Hidden({ lang, keep }: { lang: string; keep: string }) {
  return (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="keep" value={keep} />
    </>
  );
}

/** "?a=1&b=2" of the given values (empty ones left out). */
export function keepOf(values: Record<string, string | number | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v !== null && v !== undefined && v !== "") params.set(k, String(v));
  const q = params.toString();
  return q ? `?${q}` : "";
}

/** The page's head: the 28 px title, one line of explanation, and whatever sits beside the title. */
export function AdminHead({ dict, page, intro, aside }: { dict: Dictionary; page: AdminKey; intro?: ReactNode; aside?: ReactNode }) {
  const n = dict.admin_nav as Record<string, string>;
  return (
    <header className="flex flex-col gap-1 pb-4" data-admin-head={page}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[28px] font-bold leading-tight">{n[page]}</h1>
        {aside}
      </div>
      <p className="max-w-3xl text-[15px] text-[#5C5C5C]">{intro ?? n[`${page}_intro`]}</p>
    </header>
  );
}

/** The message after a save: the same texts as the old long page had for each code. */
export function AdminNotice({ dict, sp }: { dict: Dictionary; sp: AdminSearch }) {
  const ok = first(sp.ok);
  const err = first(sp.err);
  if (!ok && !err) return null;
  const a = dict.admin_domains;
  const okText: Record<string, string> = {
    partner_queued: dict.admin_partners.queued,
    blog_limits: dict.admin_blog.saved,
    inventory: dict.admin_inventory.saved,
    sms: dict.admin_sms.saved,
    telegram: dict.admin_telegram.saved,
    telegram_webhook: dict.admin_telegram.webhook_set,
    language: dict.admin_tr.saved,
    ui_text: dict.admin_tr.saved,
    tr_limits: dict.admin_tr.saved,
  };
  const errText: Record<string, string> = {
    blog_limits: dict.admin_blog.error,
    inventory: dict.admin_inventory.error,
    sms: dict.admin_sms.error,
    telegram: dict.admin_telegram.error,
    telegram_webhook: dict.admin_telegram.webhook_failed,
  };
  const errMessage = err
    ? err.startsWith("search_")
      ? ((dict.admin_search as Record<string, string>)[`err_${err.slice(7)}`] ?? t(a.failed, { message: err }))
      : err.startsWith("partner_")
        ? t((dict.admin_partners as Record<string, string>)[`err_${err.slice(8)}`] ?? err, { line: first(sp.line) ?? "?" })
        : (errText[err] ?? t(a.failed, { message: err }))
    : "";
  return ok ? (
    <p role="status" className="mb-4 rounded-xl border border-[#111] p-3 font-semibold" data-admin-ok={ok}>
      {okText[ok] ?? a.done}
    </p>
  ) : (
    <p role="alert" className="mb-4 rounded-xl border border-[#D6D6D6] p-3" data-admin-err={err}>
      {errMessage}
    </p>
  );
}
