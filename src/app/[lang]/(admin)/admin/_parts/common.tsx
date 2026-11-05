import "server-only";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary, t, type Dictionary } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import type { AdminKey } from "@/lib/adminPages";
import { fieldClass } from "@/components/owner/ui";

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
    limits: dict.admin_nav.limits_saved,
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

/** The save bar's words (@/components/owner/SaveBar), as on the owner pages. */
export function saveLabels(dict: Dictionary, save: string = dict.account.save) {
  return { unsaved: dict.owner.unsaved, cancel: dict.owner.cancel_changes, save, saving: dict.owner.saving };
}

/** A small number field (the shared 52 px field, narrow and right-aligned). */
export const numClass = `${fieldClass} !w-24 text-right tabular-nums`;

/**
 * The admin tables (artboards 2–12): a real <table> that scrolls sideways inside its own box when the screen is
 * narrower than `min` — never the page.
 */
export const tableBox = "relative -mx-[18px] overflow-x-auto px-[18px]";
export const thClass = "pb-2 pr-4 text-left text-xs font-bold uppercase tracking-[.04em] text-[#5C5C5C]";
export const tdClass = "border-t border-[#E4E4E4] py-3 pr-4 align-middle";

/** One line of a settings card: the label (and a hint under it) on the left, the value or the control on the right. */
export function SettingRow({ label, hint, children, ...data }: { label: ReactNode; hint?: ReactNode; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <div className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t border-[#E4E4E4] py-2 text-[15px]" {...data}>
      <span className="flex min-w-0 flex-1 basis-48 flex-col">
        <span className="font-semibold">{label}</span>
        {hint && <span className="text-[13px] text-[#5C5C5C]">{hint}</span>}
      </span>
      <span className="flex flex-none items-center gap-2">{children}</span>
    </div>
  );
}

/** A status: the dot and its words (never the colour alone). */
export function DotText({ color, children, ...data }: { color: string; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <span className="inline-flex items-center gap-[7px] font-bold" {...data}>
      <span aria-hidden="true" className="inline-block size-2.5 flex-none rounded-full shadow-[0_0_0_1px_rgba(0,0,0,.25)]" style={{ background: color }} />
      {children}
    </span>
  );
}
