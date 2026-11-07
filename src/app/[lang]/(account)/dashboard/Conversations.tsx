import type { Locale } from "@/i18n/config";
import { t, type Dictionary } from "@/i18n/dictionaries";
import { retryCloudExport } from "./cloudActions";

/**
 * update 55's conversation helpers, shared by CRM → Konverzácie (`crm/Inbox.tsx`, the two-pane inbox of 2026-11-07,
 * which replaced the old list here) and the contact pages: the list's filters from the address and back, plural
 * counts, language names, the cloud copy's state and the PDF's address.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The list's status filter (update 55): "" = new and read (not archived). */
export const STATUS_FILTERS = ["", "new", "read", "archived", "all"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];
export type ConversationStatus = "new" | "read" | "archived";

export type ExportStatus = "none" | "pending" | "running" | "done" | "failed";

export interface ConversationFilter {
  q: string;
  from: string;
  to: string;
  page: number;
  /** Update 55's filters. */
  status: StatusFilter;
  starred: boolean;
  unanswered: boolean;
  attachments: boolean;
  lang: string;
}

type Params = Record<string, string | string[] | undefined>;

/**
 * The list's search words, days and filters from the address (?cq=&cfrom=&cto=&cpage=&cstatus=&cstar=1&cna=1&cfiles=1
 * &clang=).
 */
export function conversationFilter(sp: Params): ConversationFilter {
  const one = (key: string) => {
    const value = sp[key];
    return ((Array.isArray(value) ? value[0] : value) ?? "").trim();
  };
  const status = one("cstatus") as StatusFilter;
  return {
    q: one("cq").slice(0, 100),
    from: DAY.test(one("cfrom")) ? one("cfrom") : "",
    to: DAY.test(one("cto")) ? one("cto") : "",
    page: Math.max(1, Math.floor(Number(one("cpage")) || 1)),
    status: STATUS_FILTERS.includes(status) ? status : "",
    starred: one("cstar") === "1",
    unanswered: one("cna") === "1",
    attachments: one("cfiles") === "1",
    lang: /^[a-z]{2,3}$/.test(one("clang")) ? one("clang") : "",
  };
}

/** The filter as address parameters (only what is set), for the page links and the forms' way back. */
export function filterQuery(filter: ConversationFilter, page = filter.page): Record<string, string> {
  return {
    ...(filter.q ? { cq: filter.q } : {}),
    ...(filter.from ? { cfrom: filter.from } : {}),
    ...(filter.to ? { cto: filter.to } : {}),
    ...(filter.status ? { cstatus: filter.status } : {}),
    ...(filter.starred ? { cstar: "1" } : {}),
    ...(filter.unanswered ? { cna: "1" } : {}),
    ...(filter.attachments ? { cfiles: "1" } : {}),
    ...(filter.lang ? { clang: filter.lang } : {}),
    ...(page > 1 ? { cpage: String(page) } : {}),
  };
}

/** "6 správ" / "1 správa" in the page language. */
export function countText(forms: Record<string, string>, prefix: string, n: number, lang: Locale): string {
  return t(forms[`${prefix}_${new Intl.PluralRules(lang).select(n)}`] ?? forms[`${prefix}_other`], { n });
}

/** A language code as a name in the page language ("maďarčina"). */
export function languageName(code: string | null, lang: Locale, unknown: string): string {
  if (!code) return unknown;
  try {
    return new Intl.DisplayNames([lang], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * The copy in the shop's cloud folder: "Cloud: čaká" / "Uložené v cloude" / "Cloud: chyba – …"
 * with "Uložiť znova" (owners; the database and cloud-export decide whether it goes).
 */
export function ExportState({
  status,
  error,
  path,
  canRetry,
  hidden,
  dict,
}: {
  status: ExportStatus | undefined;
  error: string | null | undefined;
  path: string | null | undefined;
  canRetry: boolean;
  hidden: React.ReactNode;
  dict: Dictionary;
}) {
  const c = dict.conversations;
  if (!status || status === "none") return null;
  const text =
    status === "done" ? c.export_done : status === "failed" ? t(c.export_failed, { reason: error || "–" }) : c.export_pending;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-export={status}>
      <span className={status === "failed" ? "font-semibold" : "text-muted"}>{text}</span>
      {status === "done" && path && <span className="break-all text-xs text-muted">{t(c.export_path, { path })}</span>}
      {canRetry && (status === "failed" || status === "done") && (
        <form action={retryCloudExport}>
          {hidden}
          <button type="submit" className="text-sm underline underline-offset-4" data-export-retry>
            {c.export_retry}
          </button>
        </form>
      )}
    </span>
  );
}

/** Where "Stiahnuť PDF" of one conversation leads (a 10-minute download address of its PDF). */
export const conversationPdfUrl = (id: string) => `/api/owner/conversations/${id}/pdf`;
