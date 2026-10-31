import Link from "next/link";
import type { Locale } from "@/i18n/config";
import { t, type Dictionary } from "@/i18n/dictionaries";
import { formatDateTime } from "@/lib/format";
import type { MyShop } from "@/lib/myShops";
import { ConversationDownloadBar } from "@/components/ConversationDownloadBar";
import { PendingButton } from "@/components/PendingButton";
import { retryCloudExport } from "./cloudActions";
import { bulkConversations, deleteConversation, saveAssistantRetention, saveShopperPdf, starConversation } from "./conversationActions";
import type { Supabase } from "./ShopDocuments";

/**
 * How long a shop keeps its assistant's conversations (shop_assistant_settings): "Neobmedzene" (null, the default since
 * database update 55: kept until the owner deletes them) or 30 / 90 / 365 days (deleted every night after that).
 */
export const RETENTION_DAYS = [30, 90, 365] as const;
const PAGE_SIZE = 20;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The list's status filter (update 55): "" = new and read (not archived). */
export const STATUS_FILTERS = ["", "new", "read", "archived", "all"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];
export type ConversationStatus = "new" | "read" | "archived";
/** The form all the list's ticks belong to: "Stiahnuť vybrané" and the bulk actions read the same ticks. */
export const TICKS_FORM = "conversation-ticks";

/** One row of owner_assistant_conversations (members of the shop only). */
export interface ConversationRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  page_lang: string;
  shopper_lang: string | null;
  message_count: number;
  attachment_count: number;
  first_question: string | null;
  pdf_status: "none" | "ready" | "failed";
  /** Database update 23: the copy in the shop's cloud folder. */
  export_status?: ExportStatus;
  export_error?: string | null;
  export_path?: string | null;
  /** The shopper deleted it after it was copied: only this line is left, for the owner. */
  shopper_deleted_at?: string | null;
  /** Database update 55: Nové / Prečítané / Archivované, the star, the flags (null = before update 55, unknown). */
  status?: ConversationStatus;
  starred?: boolean;
  unanswered?: boolean | null;
  access_key_used?: boolean | null;
  has_note?: boolean;
  item_count?: number;
  total_count: number;
}

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

export interface ConversationsData {
  rows: ConversationRow[];
  /** Conversations that match the filter. */
  total: number;
  /** All the shop's conversations. */
  all: number;
  /** Days, or null = "Neobmedzene". */
  retention: number | null;
  /** Conversations waiting as "Nové" (update 55; 0 before it). */
  newCount: number;
  /** The shoppers' languages for the filter, most used first (update 55). */
  languages: string[];
  /** Database update 55 is in: status, star, flags, note, bulk actions, CSV. */
  full: boolean;
  /** "Zákazníci si môžu stiahnuť svoju konverzáciu (PDF)"; null before database update 24. */
  shopperPdf: boolean | null;
  filter: ConversationFilter;
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

/** Whether a query failed only because database update 55 is not in yet (an unknown function). */
const missingFunction = (error: { code?: string } | null) => error?.code === "PGRST202" || error?.code === "42883";

/** How many conversations wait as "Nové" (the tab's badge); 0 before database update 55. */
export async function newConversations(supabase: Supabase, shopId: string): Promise<number> {
  const { data, error } = await supabase.rpc("owner_conversations_new", { p_shop_id: shopId });
  return error ? 0 : Number(data ?? 0);
}

/**
 * The shop's conversations, newest first, with update 55's filters (status, star, no answer, files, language); before
 * that update the old list (search and days only). null before database update 22.
 */
export async function loadConversations(
  supabase: Supabase,
  shopId: string,
  filter: ConversationFilter,
): Promise<ConversationsData | null> {
  const page = { p_limit: PAGE_SIZE, p_offset: (filter.page - 1) * PAGE_SIZE };
  const base = { p_shop_id: shopId, p_q: filter.q || null, p_from: filter.from || null, p_to: filter.to || null };
  const [full, count, settings, pdfSetting, languages, newCount] = await Promise.all([
    supabase.rpc("owner_conversations", {
      ...base,
      p_status: filter.status || null,
      p_starred: filter.starred || null,
      p_unanswered: filter.unanswered || null,
      p_attachments: filter.attachments || null,
      p_lang: filter.lang || null,
      ...page,
    }),
    supabase.from("assistant_conversations").select("id", { count: "exact", head: true }).eq("shop_id", shopId).gt("message_count", 0),
    supabase.from("shop_assistant_settings").select("retention_days").eq("shop_id", shopId).maybeSingle(),
    supabase.from("shop_assistant_settings").select("shopper_pdf").eq("shop_id", shopId).maybeSingle(),
    supabase.rpc("owner_conversation_languages", { p_shop_id: shopId }),
    newConversations(supabase, shopId),
  ]);
  const before55 = missingFunction(full.error);
  const list = before55 ? await supabase.rpc("owner_assistant_conversations", { ...base, ...page }) : full;
  if (list.error || count.error || settings.error) return null;
  const rows = (list.data ?? []) as ConversationRow[];
  const days = settings.data ? settings.data.retention_days : before55 ? 90 : null;
  return {
    rows,
    total: Number(rows[0]?.total_count ?? 0),
    all: count.count ?? 0,
    retention: days === null || days === undefined ? null : Number(days),
    newCount,
    languages: languages.error ? [] : ((languages.data ?? []) as { lang: string | null }[]).flatMap((l) => (l.lang ? [l.lang] : [])),
    full: !before55,
    shopperPdf: pdfSetting.error ? null : (pdfSetting.data?.shopper_pdf ?? true),
    filter,
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

/** One line about the list: "12 konverzácií · nové: 3 · uchovávanie 90 dní" (or "uchovávanie neobmedzene"). */
export function conversationsSummary(data: ConversationsData | null, dict: Dictionary, lang: Locale): string {
  const c = dict.conversations;
  if (!data) return c.unavailable;
  const count = countText(c, "count", data.all, lang) + (data.newCount > 0 ? ` · ${t(c.summary_new, { n: data.newCount })}` : "");
  return data.retention === null ? t(c.summary_unlimited, { count }) : t(c.summary, { count, days: data.retention });
}

/** Where "Stiahnuť PDF" of one conversation leads (a 10-minute download address of its PDF). */
export const conversationPdfUrl = (id: string) => `/api/owner/conversations/${id}/pdf`;

/** The flags of a conversation as words (never colour alone): "Bez odpovede · Prístupový kľúč · Poznámka · …". */
function Flags({ row, dict }: { row: ConversationRow; dict: Dictionary }) {
  const c = dict.conversations;
  const words = [
    row.unanswered ? c.flag_unanswered : null,
    row.access_key_used ? c.flag_access_key : null,
    row.has_note ? c.flag_note : null,
    row.item_count ? t(c.products_count, { n: row.item_count }) : null,
  ].filter((w): w is string => Boolean(w));
  if (!words.length) return null;
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-1 text-xs" data-flags>
      {words.map((w, i) => (
        <span key={w} className={i === 0 && row.unanswered ? "font-semibold" : "text-muted"}>
          {i > 0 && <span aria-hidden="true">· </span>}
          {w}
        </span>
      ))}
    </span>
  );
}

const statusText = (status: ConversationStatus | undefined, dict: Dictionary) =>
  status === "new" ? dict.conversations.status_new : status === "archived" ? dict.conversations.status_archived : dict.conversations.status_read;

/**
 * "Konverzácie" (Asistent page, its own tab since update 55): how long they are kept ("Neobmedzene" or 30 / 90 / 365
 * days), search, days, status (Nové / Prečítané / Archivované), star, "bez odpovede", files and language, the list
 * (newest first) with a link to read each one, ticks for "Stiahnuť vybrané" (each conversation its own PDF) and the bulk
 * actions (prečítané / nové / archivovať / hviezdička / vymazať with a confirmation), and the CSV of a date range. Every
 * change goes through the owner_* functions (members of the shop only) and is written in the activity log.
 */
export function Conversations({
  data,
  shop,
  lang,
  dict,
  hasPlan,
  cloudConnected = false,
  hidden,
  notice,
}: {
  data: ConversationsData | null;
  shop: MyShop;
  lang: Locale;
  dict: Dictionary;
  hasPlan: boolean;
  cloudConnected?: boolean;
  hidden: (extra?: Record<string, string>) => React.ReactNode;
  notice: React.ReactNode;
}) {
  const c = dict.conversations;
  if (!data) return <p className="text-sm text-muted">{c.unavailable}</p>;
  const { filter } = data;
  const filtered = Boolean(
    filter.q || filter.from || filter.to || filter.status || filter.starred || filter.unanswered || filter.attachments || filter.lang,
  );
  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const listUrl = (page: number) =>
    `/${lang}/dashboard/assistant?${new URLSearchParams({ shop: shop.slug, at: "conversations", ...filterQuery(filter, page) })}#conversations`;
  // The forms come back to the same list (filters and page kept).
  const back = new URLSearchParams(filterQuery(filter)).toString();
  const input = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";
  const check = "h-4 w-4 accent-foreground";
  const action = "rounded border border-line px-3 py-1 text-sm font-medium";

  return (
    <>
      {notice}
      <p className="text-sm">{c.intro}</p>
      {!hasPlan && <p className="border border-line p-3 text-sm">{c.needs_plan}</p>}

      {(hasPlan || data.all > 0) && (
        <form action={saveAssistantRetention} className="flex flex-wrap items-end gap-3" data-retention>
          {hidden({ at: "conversations" })}
          <label className="flex flex-col gap-1">
            <span className="text-sm">{c.retention}</span>
            <select name="retention_days" defaultValue={data.retention === null ? "" : String(data.retention)} className={`${input} bg-white`}>
              {data.full && <option value="">{c.retention_unlimited}</option>}
              {RETENTION_DAYS.map((days) => (
                <option key={days} value={days}>
                  {t(c.days, { n: days })}
                </option>
              ))}
            </select>
          </label>
          <PendingButton pending={dict.owner.saving}>{dict.account.save}</PendingButton>
          <p className="w-full text-xs text-muted">{c.retention_hint}</p>
        </form>
      )}

      {hasPlan && data.shopperPdf !== null && (
        <form action={saveShopperPdf} className="flex flex-col gap-2" data-shopper-pdf-setting>
          {hidden({ at: "conversations" })}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="shopper_pdf" defaultChecked={data.shopperPdf} />
            {c.shopper_pdf}
          </label>
          <p className="text-xs text-muted">{c.shopper_pdf_hint}</p>
          <PendingButton pending={dict.owner.saving}>{dict.account.save}</PendingButton>
        </form>
      )}

      {data.all > 0 && (
        <form method="get" action={`/${lang}/dashboard/assistant#conversations`} className="flex flex-col gap-3" role="search" data-conversation-filter>
          <input type="hidden" name="shop" value={shop.slug} />
          <input type="hidden" name="at" value="conversations" />
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-48 flex-1 flex-col gap-1">
              <span className="text-sm">{c.search}</span>
              <input type="search" name="cq" defaultValue={filter.q} maxLength={100} className={input} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm">{c.from}</span>
              <input type="date" name="cfrom" defaultValue={filter.from} className={input} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm">{c.to}</span>
              <input type="date" name="cto" defaultValue={filter.to} className={input} />
            </label>
          </div>
          {data.full && (
            <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
              <label className="flex flex-col gap-1">
                <span className="text-sm">{c.status}</span>
                <select name="cstatus" defaultValue={filter.status} className={`${input} bg-white`} data-filter-status>
                  <option value="">{c.status_active}</option>
                  <option value="new">{c.status_new}</option>
                  <option value="read">{c.status_read}</option>
                  <option value="archived">{c.status_archived}</option>
                  <option value="all">{c.status_all}</option>
                </select>
              </label>
              {data.languages.length > 0 && (
                <label className="flex flex-col gap-1">
                  <span className="text-sm">{c.filter_language}</span>
                  <select name="clang" defaultValue={filter.lang} className={`${input} bg-white`}>
                    <option value="">{c.all_languages}</option>
                    {data.languages.map((code) => (
                      <option key={code} value={code}>
                        {languageName(code, lang, code)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" name="cstar" value="1" defaultChecked={filter.starred} className={check} />
                {c.only_starred}
              </label>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" name="cna" value="1" defaultChecked={filter.unanswered} className={check} data-filter-unanswered />
                {c.only_unanswered}
              </label>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" name="cfiles" value="1" defaultChecked={filter.attachments} className={check} />
                {c.only_attachments}
              </label>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className="rounded border border-foreground px-4 py-2 font-medium">
              {c.filter}
            </button>
            {filtered && (
              <Link href={`/${lang}/dashboard/assistant?shop=${shop.slug}&at=conversations#conversations`} className="py-2 text-sm underline underline-offset-4">
                {c.reset}
              </Link>
            )}
          </div>
        </form>
      )}

      {data.rows.length === 0 ? (
        <p className="text-sm text-muted">{filtered ? c.none_found : c.none}</p>
      ) : (
        <>
          <ConversationDownloadBar
            formId={TICKS_FORM}
            labels={{
              select_all: c.select_all,
              download_selected: c.download_selected,
              downloading: c.downloading,
              download_done: c.download_done,
              download_missing: c.download_missing,
              download_failed: c.download_failed,
            }}
          />
          {data.full && (
            <form id={TICKS_FORM} action={bulkConversations} className="flex flex-col gap-2 border border-line p-3" data-bulk>
              {hidden({ at: "conversations", back })}
              <p className="text-sm">
                <span className="font-semibold">{c.bulk_title}</span> <span className="text-muted">· {c.bulk_hint}</span>
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="submit" name="op" value="read" className={action}>
                  {c.mark_read}
                </button>
                <button type="submit" name="op" value="new" className={action}>
                  {c.mark_new}
                </button>
                <button type="submit" name="op" value="star" className={action}>
                  {c.star}
                </button>
                <button type="submit" name="op" value="unstar" className={action}>
                  {c.unstar}
                </button>
                {filter.status === "archived" ? (
                  <button type="submit" name="op" value="unarchive" className={action}>
                    {c.unarchive}
                  </button>
                ) : (
                  <button type="submit" name="op" value="archive" className={action}>
                    {c.archive}
                  </button>
                )}
              </div>
              <details className="text-sm" data-bulk-delete>
                <summary className="cursor-pointer underline underline-offset-4">{c.delete_selected}</summary>
                <div className="mt-2 flex flex-col gap-2">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name="confirm" className={check} />
                    {c.bulk_confirm}
                  </label>
                  <button type="submit" name="op" value="delete" className={`${action} self-start border-foreground`}>
                    {c.delete_button}
                  </button>
                </div>
              </details>
            </form>
          )}
          <ul className="flex flex-col divide-y divide-line border-y border-line" data-conversations>
            {data.rows.map((row) =>
              row.shopper_deleted_at ? (
                <li key={row.id} className="flex flex-col gap-1 py-3" data-conversation={row.id} data-shopper-deleted>
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="font-semibold">{formatDateTime(row.started_at, lang, shop.timezone)}</span>
                    <span className="font-semibold">{c.shopper_deleted}</span>
                  </span>
                  {row.export_path && <span className="break-all text-sm">{t(c.shopper_deleted_hint, { path: row.export_path })}</span>}
                  <form action={deleteConversation}>
                    {hidden({ at: "conversations", conversation_id: row.id, confirm: "on" })}
                    <button type="submit" className="text-sm underline underline-offset-4">
                      {c.stub_remove}
                    </button>
                  </form>
                </li>
              ) : (
                <li key={row.id} className="flex gap-3 py-3" data-status={row.status ?? "read"}>
                  <span className="w-4 shrink-0 pt-0.5">
                    {/* One tick for the PDFs and the bulk actions (a running conversation has no PDF yet: listed as missing). */}
                    {(data.full || row.pdf_status === "ready") && (
                      <input
                        type="checkbox"
                        name="ids"
                        value={row.id}
                        form={TICKS_FORM}
                        aria-label={t(c.select_conversation, { date: formatDateTime(row.started_at, lang, shop.timezone) })}
                        className={check}
                        data-conversation-tick={row.id}
                      />
                    )}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <Link href={`/${lang}/dashboard/conversations/${row.id}`} className="group/conv flex flex-col gap-1" data-conversation={row.id}>
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        <span className="font-semibold">{formatDateTime(row.started_at, lang, shop.timezone)}</span>
                        {data.full && (
                          <span className={row.status === "new" ? "font-semibold" : "text-muted"} data-status-text>
                            {statusText(row.status, dict)}
                          </span>
                        )}
                        <span>{languageName(row.shopper_lang ?? row.page_lang, lang, c.unknown)}</span>
                        <span className="text-muted">{countText(c, "messages", row.message_count, lang)}</span>
                        {row.attachment_count > 0 && (
                          <span className="inline-flex items-center gap-1 text-muted" title={t(c.files, { n: row.attachment_count })}>
                            <PaperclipIcon />
                            <span className="sr-only">{t(c.files, { n: row.attachment_count })}</span>
                            <span aria-hidden="true">{row.attachment_count}</span>
                          </span>
                        )}
                        {!row.ended_at && <span className="text-muted">{c.running}</span>}
                      </span>
                      <span className={`line-clamp-2 break-words group-hover/conv:underline ${row.status === "new" ? "font-semibold" : ""}`}>
                        {row.first_question || c.no_text}
                      </span>
                    </Link>
                    <Flags row={row} dict={dict} />
                    <ExportState
                      status={row.export_status}
                      error={row.export_error}
                      path={row.export_path}
                      canRetry={cloudConnected && hasPlan}
                      hidden={hidden({ at: "conversations", conversation_id: row.id })}
                      dict={dict}
                    />
                    {row.pdf_status === "ready" && (
                      <a href={conversationPdfUrl(row.id)} download className="self-start text-sm underline underline-offset-4" data-conversation-pdf={row.id}>
                        {c.download_pdf}
                      </a>
                    )}
                  </span>
                  {data.full && (
                    <form action={starConversation} className="shrink-0">
                      {hidden({ at: "conversations", back, conversation_id: row.id, op: row.starred ? "unstar" : "star" })}
                      <button
                        type="submit"
                        aria-pressed={Boolean(row.starred)}
                        aria-label={row.starred ? c.unstar : c.star}
                        title={row.starred ? c.unstar : c.star}
                        className="flex h-11 w-11 items-center justify-center text-xl leading-none"
                        data-star={row.starred ? "on" : "off"}
                      >
                        <span aria-hidden="true">{row.starred ? "★" : "☆"}</span>
                      </button>
                    </form>
                  )}
                </li>
              ),
            )}
          </ul>
        </>
      )}

      {pages > 1 && (
        <nav className="flex items-center justify-between text-sm">
          {filter.page > 1 ? (
            <a href={listUrl(filter.page - 1)} className="underline">
              {dict.shop.prev}
            </a>
          ) : (
            <span />
          )}
          <span className="text-muted">{t(dict.shop.page_of, { page: filter.page, pages })}</span>
          {filter.page < pages ? (
            <a href={listUrl(filter.page + 1)} className="underline">
              {dict.shop.next}
            </a>
          ) : (
            <span />
          )}
        </nav>
      )}

      {data.full && data.all > 0 && (
        <form method="get" action="/api/owner/conversations/export" className="flex flex-col gap-2 border-t border-line pt-4" data-conversation-export>
          <h3 className="font-semibold">{c.export_title}</h3>
          <p className="text-xs text-muted">{c.export_hint}</p>
          <input type="hidden" name="shop" value={shop.id} />
          <input type="hidden" name="lang" value={lang} />
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-sm">{c.from}</span>
              <input type="date" name="from" required defaultValue={filter.from} className={input} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm">{c.to}</span>
              <input type="date" name="to" required defaultValue={filter.to} className={input} />
            </label>
            <button type="submit" className="rounded border border-foreground px-4 py-2 font-medium" data-export-csv>
              {c.export_csv}
            </button>
          </div>
        </form>
      )}
    </>
  );
}

function PaperclipIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="m20.5 11.5-8.4 8.4a5 5 0 0 1-7.1-7.1l8.4-8.4a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
    </svg>
  );
}
