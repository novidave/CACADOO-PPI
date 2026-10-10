import Link from "next/link";
import type { Locale } from "@/i18n/config";
import { t, type Dictionary } from "@/i18n/dictionaries";
import { formatDateTime } from "@/lib/format";
import type { MyShop } from "@/lib/myShops";
import { PendingButton } from "@/components/PendingButton";
import { saveAssistantRetention } from "./conversationActions";
import type { Supabase } from "./ShopDocuments";

/** How long a shop keeps its assistant's conversations (shop_assistant_settings). */
export const RETENTION_DAYS = [30, 90, 365] as const;
const PAGE_SIZE = 20;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

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
  total_count: number;
}

export interface ConversationFilter {
  q: string;
  from: string;
  to: string;
  page: number;
}

export interface ConversationsData {
  rows: ConversationRow[];
  /** Conversations that match the filter. */
  total: number;
  /** All the shop's conversations. */
  all: number;
  retention: number;
  filter: ConversationFilter;
}

type Params = Record<string, string | string[] | undefined>;

/** The list's search words and days from the address (?cq=&cfrom=&cto=&cpage=). */
export function conversationFilter(sp: Params): ConversationFilter {
  const one = (key: string) => {
    const value = sp[key];
    return ((Array.isArray(value) ? value[0] : value) ?? "").trim();
  };
  return {
    q: one("cq").slice(0, 100),
    from: DAY.test(one("cfrom")) ? one("cfrom") : "",
    to: DAY.test(one("cto")) ? one("cto") : "",
    page: Math.max(1, Math.floor(Number(one("cpage")) || 1)),
  };
}

/** The shop's conversations, newest first; null before database update 22. */
export async function loadConversations(
  supabase: Supabase,
  shopId: string,
  filter: ConversationFilter,
): Promise<ConversationsData | null> {
  const [list, count, settings] = await Promise.all([
    supabase.rpc("owner_assistant_conversations", {
      p_shop_id: shopId,
      p_q: filter.q || null,
      p_from: filter.from || null,
      p_to: filter.to || null,
      p_limit: PAGE_SIZE,
      p_offset: (filter.page - 1) * PAGE_SIZE,
    }),
    supabase.from("assistant_conversations").select("id", { count: "exact", head: true }).eq("shop_id", shopId).gt("message_count", 0),
    supabase.from("shop_assistant_settings").select("retention_days").eq("shop_id", shopId).maybeSingle(),
  ]);
  if (list.error || count.error || settings.error) return null;
  const rows = (list.data ?? []) as ConversationRow[];
  return {
    rows,
    total: Number(rows[0]?.total_count ?? 0),
    all: count.count ?? 0,
    retention: Number(settings.data?.retention_days ?? 90),
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

/** One line while the section is closed: "12 konverzácií · uchovávanie 90 dní". */
export function conversationsSummary(data: ConversationsData | null, dict: Dictionary, lang: Locale): string {
  const c = dict.conversations;
  if (!data) return c.unavailable;
  return t(c.summary, { count: countText(c, "count", data.all, lang), days: data.retention });
}

/**
 * "Konverzácie asistenta" in Môj obchod: how long they are kept, search and days, the list
 * (newest first) and a link to read each one. View only: nothing here downloads a file.
 */
export function Conversations({
  data,
  shop,
  lang,
  dict,
  hasPlan,
  hidden,
  notice,
}: {
  data: ConversationsData | null;
  shop: MyShop;
  lang: Locale;
  dict: Dictionary;
  hasPlan: boolean;
  hidden: (extra?: Record<string, string>) => React.ReactNode;
  notice: React.ReactNode;
}) {
  const c = dict.conversations;
  if (!data) return <p className="text-sm text-muted">{c.unavailable}</p>;
  const { filter } = data;
  const filtered = Boolean(filter.q || filter.from || filter.to);
  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const listUrl = (page: number) =>
    `/${lang}/dashboard?${new URLSearchParams({
      shop: shop.slug,
      at: "conversations",
      ...(filter.q ? { cq: filter.q } : {}),
      ...(filter.from ? { cfrom: filter.from } : {}),
      ...(filter.to ? { cto: filter.to } : {}),
      cpage: String(page),
    })}#conversations`;
  const input = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";

  return (
    <>
      {notice}
      <p className="text-sm">{c.intro}</p>
      {!hasPlan && <p className="border border-line p-3 text-sm">{c.needs_plan}</p>}

      {(hasPlan || data.all > 0) && (
        <form action={saveAssistantRetention} className="flex flex-wrap items-end gap-3">
          {hidden({ at: "conversations" })}
          <label className="flex flex-col gap-1">
            <span className="text-sm">{c.retention}</span>
            <select name="retention_days" defaultValue={String(data.retention)} className={`${input} bg-white`}>
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

      {data.all > 0 && (
        <form method="get" action={`/${lang}/dashboard#conversations`} className="flex flex-wrap items-end gap-2" role="search">
          <input type="hidden" name="shop" value={shop.slug} />
          <input type="hidden" name="at" value="conversations" />
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
          <button type="submit" className="rounded border border-foreground px-4 py-2 font-medium">
            {c.filter}
          </button>
          {filtered && (
            <Link href={`/${lang}/dashboard?shop=${shop.slug}&at=conversations#conversations`} className="py-2 text-sm underline underline-offset-4">
              {c.reset}
            </Link>
          )}
        </form>
      )}

      {data.rows.length === 0 ? (
        <p className="text-sm text-muted">{filtered ? c.none_found : c.none}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line border-y border-line" data-conversations>
          {data.rows.map((row) => (
            <li key={row.id}>
              <Link href={`/${lang}/dashboard/conversations/${row.id}`} className="group flex flex-col gap-1 py-3" data-conversation={row.id}>
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="font-semibold">{formatDateTime(row.started_at, lang, shop.timezone)}</span>
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
                <span className="line-clamp-2 break-words group-hover:underline">{row.first_question || c.no_text}</span>
              </Link>
            </li>
          ))}
        </ul>
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
