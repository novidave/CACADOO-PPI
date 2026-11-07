import Link from "next/link";
import type { Locale } from "@/i18n/config";
import { t, type Dictionary } from "@/i18n/dictionaries";
import { formatDateTime, formatTime, localDay } from "@/lib/format";
import { ownerAiReady } from "@/lib/grammar";
import { bookingWhen, draftWords, inboxHref, type InboxFilter, rowTags, shopLanguage, timeWord } from "@/lib/crmInbox";
import type { MyShop } from "@/lib/myShops";
import { loadSmsUsage, quotaLeft } from "@/lib/smsUsage";
import { PendingButton } from "@/components/PendingButton";
import type { ComposerTemplate } from "@/components/MessageComposer";
import { DialogButton, InboxList, MessagesScroll } from "@/components/owner/InboxParts";
import { ReplyBox, type ReplyDraft } from "@/components/owner/ReplyBox";
import { fieldClass } from "@/components/owner/ui";
import { markCallback } from "../callbackActions";
import { bulkConversations, deleteConversation, markConversation, saveConversationNote } from "../conversationActions";
import { linkConversation } from "../contacts/actions";
import { type ConversationFilter, conversationPdfUrl, ExportState, type ExportStatus, filterQuery, languageName } from "../Conversations";
import type { Supabase } from "../ShopDocuments";

/**
 * CRM → Konverzácie, the two-pane inbox (2026-11-07; canvas "Cacaduu – webová aplikácia (Môj obchod)", artboards 8
 * = SMS reply, 8b = e-mail reply). The LIST (left, 320 px): search, "Všetky · Čaká n · Rezerv.", "Filtre" (update 55's
 * days, status, star, files, language and the CSV of a date range), the rows (name, time in the shop's zone, the last
 * message or "Koncept: …", tags), "Zobraziť ďalšie", "Vybrať" for the bulk actions. The CONVERSATION (right): the head
 * (name, masked phone, "overené SMS", "n konverzácie", Stiahnuť PDF, Rezervácia, "⋯"), the callback strip while it
 * waits, the messages with their event pills, and the reply (@/components/owner/ReplyBox: SMS / e-mail, grammar,
 * templates, drafts). Every row is a real link (the same query + `c`); every value comes from SQL
 * (owner_conversations_inbox, owner_conversation_head, owner_draft_get: members only).
 */

export const INBOX_TICKS = "inbox-ticks";
export const PAGE = 30;

export interface InboxRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  last_at: string;
  page_lang: string;
  shopper_lang: string | null;
  message_count: number;
  attachment_count: number;
  first_question: string | null;
  pdf_status: "none" | "ready" | "failed";
  export_status: ExportStatus | null;
  shopper_deleted_at: string | null;
  status: "new" | "read" | "archived";
  starred: boolean;
  unanswered: boolean | null;
  waiting: boolean;
  last_text: string | null;
  last_role: string | null;
  next_booking_at: string | null;
  contact_id: string | null;
  contact_name: string | null;
  contact_conversations: number;
  phone_masked: string | null;
  phone_verified: boolean;
  draft_text: string | null;
  total_count: number;
}

export interface InboxData {
  rows: InboxRow[];
  total: number;
  counts: { all: number; waiting: number; booked: number; new: number };
  languages: string[];
  ready: boolean;
}

/** The list (update 90's owner_conversations_inbox); `ready` false before update 90 (the page says so). */
export async function loadInbox(supabase: Supabase, shopId: string, filter: ConversationFilter, f: InboxFilter): Promise<InboxData> {
  const [list, counts, languages] = await Promise.all([
    supabase.rpc("owner_conversations_inbox", {
      p_shop_id: shopId,
      p_q: filter.q || null,
      p_from: filter.from || null,
      p_to: filter.to || null,
      p_status: filter.status || null,
      p_starred: filter.starred || null,
      p_unanswered: filter.unanswered || null,
      p_attachments: filter.attachments || null,
      p_lang: filter.lang || null,
      p_filter: f || null,
      p_limit: PAGE * filter.page,
      p_offset: 0,
    }),
    supabase.rpc("owner_conversations_inbox_counts", { p_shop_id: shopId }),
    supabase.rpc("owner_conversation_languages", { p_shop_id: shopId }),
  ]);
  const rows = (list.error ? [] : (list.data ?? [])) as InboxRow[];
  return {
    rows,
    total: Number(rows[0]?.total_count ?? 0),
    counts: (counts.error ? { all: 0, waiting: 0, booked: 0, new: 0 } : counts.data) as InboxData["counts"],
    languages: languages.error ? [] : ((languages.data ?? []) as { lang: string | null }[]).flatMap((l) => (l.lang ? [l.lang] : [])),
    ready: !list.error,
  };
}

const plural = (forms: Record<string, string>, prefix: string, n: number, lang: Locale) =>
  t(forms[`${prefix}_${new Intl.PluralRules(lang).select(n)}`] ?? forms[`${prefix}_other`], { n });

/** A row's tags, drawn (24 px, radius 6, 1 px #D6D6D6, 12 / 700; "Čaká na odpoveď" with a #111 line; the draft dashed). */
function Tags({ row, shopLang, lang, timeZone, x }: { row: InboxRow; shopLang: string; lang: Locale; timeZone: string; x: Record<string, string> }) {
  const tags = rowTags(row, shopLang);
  if (!tags.length) return null;
  const base = "inline-flex h-6 items-center rounded-md border px-2 text-xs font-bold";
  return (
    <span className="relative flex flex-wrap gap-1.5">
      {tags.map((tag) => {
        if (tag.kind === "waiting") return <span key="w" className={`${base} border-[#111]`} data-row-tag="waiting">{x.tag_waiting}</span>;
        if (tag.kind === "booking") {
          const w = bookingWhen(tag.at, timeZone, lang);
          return <span key="b" className={`${base} border-[#D6D6D6]`} data-row-tag="booking">{t(x.tag_booking, w)}</span>;
        }
        if (tag.kind === "lang") return <span key="l" className={`${base} border-[#D6D6D6]`} data-row-tag="lang">{tag.code}</span>;
        if (tag.kind === "star") return <span key="s" className={`${base} border-[#D6D6D6]`} data-row-tag="star" aria-label={x.tag_star}>★</span>;
        if (tag.kind === "new") return <span key="n" className={`${base} border-[#D6D6D6]`} data-row-tag="new">{x.tag_new}</span>;
        return <span key="d" className={`${base} border-dashed border-[#111]`} data-row-tag="draft">{x.tag_draft}</span>;
      })}
    </span>
  );
}

/** The left pane: search, the segmented filter, "Filtre", the rows, "Zobraziť ďalšie", the bulk form. */
export function InboxListPane({
  data,
  shop,
  lang,
  dict,
  filter,
  f,
  open,
  query,
  now,
}: {
  data: InboxData;
  shop: MyShop;
  lang: Locale;
  dict: Dictionary;
  filter: ConversationFilter;
  f: InboxFilter;
  open: string | null;
  /** the list's own query (shop, filters, page) every row link keeps */
  query: Record<string, string>;
  now: number;
}) {
  const x = dict.crm_inbox as Record<string, string>;
  const c = dict.conversations;
  const base = `/${lang}/dashboard/crm`;
  const tz = shop.timezone;
  const shopLang = shopLanguage(shop.country);
  const segment = (value: InboxFilter, label: string) => {
    const on = f === value;
    const q = { ...query, f: value };
    delete (q as Record<string, string>).cpage;
    return (
      <Link
        key={value || "all"}
        href={inboxHref(base, q, null)}
        aria-current={on ? "page" : undefined}
        className={`flex min-h-12 flex-1 items-center justify-center rounded-[10px] px-1 text-center text-[15px] font-bold ${on ? "bg-[#111] text-white" : "text-[#3D3D3D]"}`}
        data-inbox-filter={value || "all"}
      >
        {label}
      </Link>
    );
  };
  const filtered = Boolean(filter.from || filter.to || filter.status || filter.starred || filter.unanswered || filter.attachments || filter.lang);
  const more = data.total > data.rows.length;

  const head = (
    <>
      <h2 id="inbox-list-title" className="sr-only">{x.list_title}</h2>
      <form method="get" action={base} role="search" className="flex flex-col" data-inbox-search>
        {Object.entries(query).map(([k, v]) => (k === "cq" || k === "cpage" ? null : <input key={k} type="hidden" name={k} value={v} />))}
        <label className="flex flex-col">
          <span className="sr-only">{x.search}</span>
          <input
            type="search"
            name="cq"
            defaultValue={filter.q}
            maxLength={100}
            placeholder={x.search}
            className="h-[52px] rounded-xl border border-[#D6D6D6] px-3.5 text-base"
            data-inbox-q
          />
        </label>
      </form>
      <nav aria-label={x.filter_label} className="flex gap-1 rounded-xl border border-[#D6D6D6] p-1" data-inbox-filters>
        {segment("", x.filter_all)}
        {segment("waiting", t(x.filter_waiting, { n: data.counts.waiting }))}
        {segment("booked", x.filter_booked)}
      </nav>
      <details className="text-sm" data-inbox-more-filters {...(filtered ? { open: true } : {})}>
        <summary className="flex min-h-11 cursor-pointer items-center font-bold">{x.filters}</summary>
        <form method="get" action={base} className="flex flex-col gap-2 pb-2" data-conversation-filter>
          {Object.entries(query).map(([k, v]) =>
            ["shop", "f", "cq"].includes(k) ? <input key={k} type="hidden" name={k} value={v} /> : null,
          )}
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span>{c.from}</span>
              <input type="date" name="cfrom" defaultValue={filter.from} className={fieldClass} />
            </label>
            <label className="flex flex-col gap-1">
              <span>{c.to}</span>
              <input type="date" name="cto" defaultValue={filter.to} className={fieldClass} />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span>{c.status}</span>
            <select name="cstatus" defaultValue={filter.status} className={`${fieldClass} bg-white`} data-filter-status>
              <option value="">{c.status_active}</option>
              <option value="new">{c.status_new}</option>
              <option value="read">{c.status_read}</option>
              <option value="archived">{c.status_archived}</option>
              <option value="all">{c.status_all}</option>
            </select>
          </label>
          {data.languages.length > 0 && (
            <label className="flex flex-col gap-1">
              <span>{c.filter_language}</span>
              <select name="clang" defaultValue={filter.lang} className={`${fieldClass} bg-white`}>
                <option value="">{c.all_languages}</option>
                {data.languages.map((code) => (
                  <option key={code} value={code}>
                    {languageName(code, lang, code)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" name="cstar" value="1" defaultChecked={filter.starred} className="h-4 w-4 accent-foreground" />
            {c.only_starred}
          </label>
          <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" name="cna" value="1" defaultChecked={filter.unanswered} className="h-4 w-4 accent-foreground" data-filter-unanswered />
            {c.only_unanswered}
          </label>
          <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" name="cfiles" value="1" defaultChecked={filter.attachments} className="h-4 w-4 accent-foreground" />
            {c.only_attachments}
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className="min-h-11 rounded-xl border border-[#111] bg-[#111] px-4 font-bold text-white">
              {c.filter}
            </button>
            {filtered && (
              <Link href={inboxHref(base, { shop: shop.slug, ...(f ? { f } : {}) }, null)} className="text-sm underline underline-offset-4">
                {c.reset}
              </Link>
            )}
          </div>
        </form>
        <form method="get" action="/api/owner/conversations/export" className="flex flex-col gap-2 border-t border-[#E4E4E4] pt-2" data-conversation-export>
          <span className="font-bold">{c.export_title}</span>
          <span className="text-xs text-[#5C5C5C]">{c.export_hint}</span>
          <input type="hidden" name="shop" value={shop.id} />
          <input type="hidden" name="lang" value={lang} />
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span>{c.from}</span>
              <input type="date" name="from" required defaultValue={filter.from} className={fieldClass} />
            </label>
            <label className="flex flex-col gap-1">
              <span>{c.to}</span>
              <input type="date" name="to" required defaultValue={filter.to} className={fieldClass} />
            </label>
          </div>
          <button type="submit" className="min-h-11 self-start rounded-xl border border-[#D6D6D6] px-4 font-bold" data-export-csv>
            {c.export_csv}
          </button>
        </form>
      </details>
    </>
  );

  return (
    <InboxList
      shop={shop.slug}
      formId={INBOX_TICKS}
      head={head}
      labels={{
        select: x.select,
        select_all: x.select_all,
        download: x.download,
        archive: c.archive,
        delete: x.delete,
        done: x.done,
        delete_confirm: c.bulk_confirm,
        downloading: c.downloading,
        download_failed: c.download_failed,
      }}
    >
      {/* the bulk actions' form: the rows' circles belong to it */}
      <form id={INBOX_TICKS} action={bulkConversations} hidden>
        <input type="hidden" name="lang" value={lang} />
        <input type="hidden" name="shop_id" value={shop.id} />
        <input type="hidden" name="shop_slug" value={shop.slug} />
        <input type="hidden" name="back" value={new URLSearchParams({ ...filterQuery(filter), ...(f ? { f } : {}), ...(open ? { c: open } : {}) }).toString()} />
        <input type="hidden" name="op" value="" />
        <input type="hidden" name="confirm" value="" />
      </form>
      {!data.ready ? (
        <p className="px-2 text-sm text-[#5C5C5C]">{c.unavailable}</p>
      ) : data.rows.length === 0 ? (
        <p className="px-2 py-4 text-sm text-[#5C5C5C]" data-inbox-none>
          {filter.q || filtered || f ? c.none_found : c.none}
        </p>
      ) : (
        data.rows.map((row) => {
          const isOpen = row.id === open;
          const when = timeWord(row.last_at ?? row.started_at, now, tz, lang);
          const draft = row.draft_text ? draftWords(row.draft_text) : "";
          const name = row.contact_name ?? (row.phone_masked ? row.phone_masked : null);
          return (
            <div key={row.id} className="ppi-inbox-row" data-inbox-row={row.id} data-status={row.status}>
              <Link href={inboxHref(base, query, row.id)} aria-current={isOpen ? "true" : undefined} aria-label={name ?? x.no_contact} data-inbox-link={row.id} />
              <label className="ppi-inbox-tick">
                <span className="sr-only">{t(c.select_conversation, { date: formatDateTime(row.started_at, lang, tz) })}</span>
                <input type="checkbox" name="ids" value={row.id} form={INBOX_TICKS} data-conversation-tick={row.id} />
              </label>
              <span className="pointer-events-none relative flex items-baseline justify-between gap-2">
                <strong className={`min-w-0 truncate text-base ${name ? "" : "text-[#5C5C5C]"}`}>{name ?? x.no_contact}</strong>
                <span className="flex-none text-[13px] text-[#5C5C5C]">{when.kind === "yesterday" ? x.yesterday : when.text}</span>
              </span>
              <span className="pointer-events-none relative truncate text-sm">
                {row.shopper_deleted_at ? (
                  <em className="not-italic text-[#5C5C5C]">{c.shopper_deleted}</em>
                ) : draft ? (
                  <>
                    <em className="font-bold not-italic">{x.draft_prefix}</em> {draft}
                  </>
                ) : (
                  (row.last_text ?? row.first_question ?? c.no_text)
                )}
              </span>
              <span className="pointer-events-none">
                <Tags row={row} shopLang={shopLang} lang={lang} timeZone={tz} x={x} />
              </span>
            </div>
          );
        })
      )}
      {more && (
        <Link
          href={inboxHref(base, { ...query, cpage: String(filter.page + 1) }, open)}
          className="flex min-h-11 items-center justify-center rounded-xl text-[15px] font-bold underline underline-offset-4"
          scroll={false}
          data-inbox-more
        >
          {x.more}
        </Link>
      )}
    </InboxList>
  );
}

// ------------------------------------------------------------------ the conversation (right pane)

interface Card {
  item_id?: string;
  name?: string;
  price?: string;
  availability?: string;
  data_time?: string;
  quantity?: number;
  note?: string;
}

interface Message {
  id: number;
  role: "shopper" | "assistant" | "owner";
  channel?: "sms" | "email" | null;
  body: string;
  body_owner: string | null;
  lang: string | null;
  cards: Card[];
  attachment_ids: string[];
  created_at: string;
  unanswered?: boolean;
}

interface Attachment {
  id: string;
  name: string;
  kind: "jpeg" | "png" | "webp" | "heic" | "pdf";
  bytes: number;
}

type Links = Record<string, { original: string | null; preview: string | null }>;

interface Head {
  contact_id: string | null;
  contact_name: string | null;
  phone_masked: string | null;
  phone_verified: boolean;
  has_phone: boolean;
  has_email: boolean;
  contact_conversations: number;
  waiting: boolean;
  next_booking_at: string | null;
  events: { kind: "contact_left" | "booking_confirmed" | "booking_made" | "food_order"; at: string; starts_at?: string; number?: number }[];
  access_key_used: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const size = (bytes: number, lang: Locale) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toLocaleString(lang, { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`;

/** The empty state on the right (a shop with no conversation yet, or none fits the filter). */
export function InboxEmpty({ dict }: { dict: Dictionary }) {
  const x = dict.crm_inbox as Record<string, string>;
  return (
    <section className="ppi-inbox-pane items-center justify-center p-8 text-center" data-inbox-empty>
      <strong className="text-lg">{x.empty_title}</strong>
      <p className="max-w-sm text-sm text-[#5C5C5C]">{x.empty_text}</p>
    </section>
  );
}

/**
 * The open conversation: its head, the callback strip, the messages (newest at the bottom) with the event pills, and
 * the reply. Opening a new one marks it read (not logged). Every action form comes back here (the old
 * /dashboard/conversations/<id> forwards to `?c=`).
 */
export async function ConversationPane({
  supabase,
  id,
  shop,
  lang,
  dict,
  listHref,
  notice,
  markRead,
}: {
  supabase: Supabase;
  id: string;
  shop: MyShop;
  lang: Locale;
  dict: Dictionary;
  /** "‹ Konverzácie": the list with the same filters (phones and tablets) */
  listHref: string;
  notice: React.ReactNode;
  /** only a conversation the owner chose (`c`) is marked read — not the one a computer opens by itself */
  markRead: boolean;
}) {
  const x = dict.crm_inbox as Record<string, string>;
  const c = dict.conversations;
  const k = dict.contacts;
  const { data: conv } = await supabase
    .from("assistant_conversations")
    .select("id, shop_id, page_lang, shopper_lang, started_at, last_message_at, ended_at, message_count, attachment_count, pdf_status, status, starred, owner_note, unanswered, export_status, export_error, export_path, callback_at, callback_name, callback_email, callback_answered_at, item_ids")
    .eq("id", id)
    .eq("shop_id", shop.id)
    .maybeSingle();
  if (!conv) {
    return (
      <section className="ppi-inbox-pane p-6" data-inbox-pane>
        <Link href={listHref} className="ppi-inbox-back flex min-h-12 items-center font-bold">{x.back}</Link>
        <p>{c.not_found}</p>
      </section>
    );
  }
  const tz = shop.timezone;
  const [messagesRes, attachmentsRes, linksRes, headRes, draftRes, cloudRes, contactsRes] = await Promise.all([
    supabase.from("assistant_messages").select("*").eq("conversation_id", id).order("created_at").order("id"),
    supabase.from("assistant_attachments").select("id, name, kind, bytes").eq("conversation_id", id).order("created_at"),
    conv.attachment_count > 0
      ? supabase.functions.invoke<{ files?: Links }>("assistant-archive", { body: { action: "owner_links", conversation_id: id } })
      : Promise.resolve({ data: { files: {} as Links }, error: null }),
    supabase.rpc("owner_conversation_head", { p_conversation_id: id }),
    supabase.rpc("owner_draft_get", { p_conversation_id: id }),
    supabase.from("cloud_connections").select("provider").eq("shop_id", shop.id).maybeSingle(),
    supabase.from("shop_contacts").select("id, name, phone, email").eq("shop_id", shop.id).order("updated_at", { ascending: false }).limit(200),
  ]);
  // Opening a new conversation marks it read (not in the activity log: only the owner's own changes are).
  if (markRead && conv.status === "new") {
    const { error } = await supabase.rpc("owner_conversations_mark", { p_shop_id: shop.id, p_ids: [id], p_action: "read", p_log: false });
    if (!error) conv.status = "read";
  }
  const head = (headRes.error ? null : headRes.data) as Head | null;
  const messages = (messagesRes.data ?? []) as Message[];
  const attachments = (attachmentsRes.data ?? []) as Attachment[];
  const links: Links | null = linksRes.error ? null : (linksRes.data?.files ?? {});
  const byId = new Map(attachments.map((a) => [a.id, a]));
  const linked = new Set(messages.flatMap((m) => m.attachment_ids ?? []));
  const loose = attachments.filter((a) => !linked.has(a.id));
  const contacts = (contactsRes.data ?? []) as { id: string; name: string | null; phone: string | null; email: string | null }[];
  const contactId = head?.contact_id ?? null;
  const cloudConnected = !cloudRes.error && Boolean(cloudRes.data);

  // the reply needs the plan, the contact and a channel
  const [planRes, templatesRes, configRes, sms] = contactId
    ? await Promise.all([
        supabase.rpc("shop_has_plan", { p_shop_id: shop.id }),
        supabase.from("shop_email_templates").select("id, name, channel, subject, body").eq("shop_id", shop.id).order("name"),
        supabase.functions.invoke<{ email?: boolean; sms_live?: boolean }>("crm-messages", { body: { action: "config" } }),
        loadSmsUsage(supabase, shop.id),
      ])
    : [null, null, null, null];
  const hasPlan = planRes?.data === true;

  // the products still offered (a deleted one keeps its card, without the link)
  const cardIds = [...new Set(messages.flatMap((m) => (m.cards ?? []).flatMap((card) => (card.item_id ? [card.item_id] : []))))].filter((v) => UUID.test(v)).slice(0, 200);
  const { data: liveRows } = cardIds.length
    ? await supabase.from("public_stock").select("item_id").eq("shop_id", shop.id).in("item_id", cardIds)
    : { data: [] as { item_id: string }[] };
  const live = new Set(((liveRows ?? []) as { item_id: string }[]).map((r) => r.item_id));
  const itemHref = (itemId: string | undefined) => (itemId && live.has(itemId) ? `/${lang}/items/${itemId}` : null);

  const started = new Date(conv.started_at);
  const hm = (iso: string) => formatTime(new Date(iso), tz);
  const when = (iso: string) => (localDay(new Date(iso), tz) === localDay(started, tz) ? hm(iso) : formatDateTime(iso, lang, tz));
  const name = head?.contact_name ?? null;
  const sub = [
    head?.phone_masked,
    head?.phone_verified ? x.verified : null,
  ].filter(Boolean) as string[];
  const hidden = (extra: Record<string, string> = {}) => (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="shop_id" value={shop.id} />
      <input type="hidden" name="shop_slug" value={shop.slug} />
      <input type="hidden" name="conversation_id" value={id} />
      {Object.entries(extra).map(([key, v]) => (
        <input key={key} type="hidden" name={key} value={v} />
      ))}
    </>
  );
  const menuItem = "flex min-h-11 w-full items-center rounded-lg px-3 text-left text-[15px] font-semibold hover:bg-[#F2F2F2]";
  const ghost = "inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-[#D6D6D6] bg-white px-3.5 text-[15px] font-bold text-[#111]";

  // the event pills: only from the conversation's own data, at their time among the messages
  type Item = { at: string; node: React.ReactNode; key: string };
  const pill = (text: string, kind: string) => (
    <div className="self-center rounded-[14px] border border-[#111] px-3 py-1.5 text-[13px] font-bold" data-inbox-event={kind}>
      {text}
    </div>
  );
  const events: Item[] = (head?.events ?? []).map((e, i) => {
    const w = e.starts_at ? bookingWhen(e.starts_at, tz, lang) : null;
    const text =
      e.kind === "contact_left"
        ? x.event_contact_left
        : e.kind === "food_order"
          ? t(x.event_food_order, { n: e.number ?? "" })
          : t(e.kind === "booking_confirmed" ? x.event_booking_confirmed : x.event_booking_made, w ?? { day: "", time: "" });
    return { at: e.at, key: `e${i}`, node: pill(text, e.kind) };
  });
  const bubbles: Item[] = messages.map((m) => {
    const who =
      m.role === "shopper"
        ? t(x.who_shopper, { time: when(m.created_at) })
        : m.role === "owner"
          ? t(x.who_owner, { channel: m.channel === "email" ? x.channel_email : x.channel_sms, time: when(m.created_at) })
          : t(x.who_assistant, { time: when(m.created_at) });
    const box =
      m.role === "shopper"
        ? "self-end max-w-[75%] rounded-[16px_16px_4px_16px] bg-[#F2F2F2] px-3.5 py-3"
        : m.role === "owner"
          ? "self-start max-w-[80%] rounded-[16px_16px_16px_4px] border border-[#111] bg-white px-3.5 py-3"
          : "self-start max-w-[80%]";
    return {
      at: m.created_at,
      key: `m${m.id}`,
      node: (
        <div className={`flex flex-col gap-1 text-base ${box}`} data-role={m.role}>
          <span className="text-xs font-bold text-[#5C5C5C]">{who}</span>
          {m.body && <p className="whitespace-pre-line break-words">{m.body}</p>}
          {m.body_owner && (
            <p className="whitespace-pre-line break-words text-sm text-[#5C5C5C]" data-owner-version>
              {c.in_slovak} {m.body_owner}
            </p>
          )}
          {m.role === "shopper" && (m.attachment_ids ?? []).length > 0 && (
            <Files files={m.attachment_ids.map((a) => byId.get(a)).filter((a): a is Attachment => Boolean(a))} links={links} lang={lang} dict={dict} />
          )}
          {m.role === "assistant" && m.unanswered && (
            <p className="text-sm font-bold" data-unanswered>
              {c.unanswered_message}
            </p>
          )}
          {m.role === "assistant" && (m.cards ?? []).length > 0 && <Cards cards={m.cards} when={when} dict={dict} href={itemHref} />}
        </div>
      ),
    };
  });
  const timeline = [...bubbles, ...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const draft = (draftRes.error ? null : draftRes.data) as ReplyDraft | null;

  return (
    <section className="ppi-inbox-pane" aria-label={name ?? x.no_contact} data-inbox-pane={id}>
      <Link href={listHref} className="ppi-inbox-back flex min-h-12 flex-none items-center px-5 text-[15px] font-bold" data-inbox-back>
        {x.back}
      </Link>
      {/* the head: name and one muted line on the left, the buttons on the right (never pushed) */}
      <div className="flex flex-none items-center justify-between gap-2.5 border-b border-[#E4E4E4] px-5 py-3" data-inbox-head>
        <span className="flex min-w-0 flex-col">
          <strong className={`truncate text-lg ${name ? "" : "text-[#5C5C5C]"}`}>{name ?? x.no_contact}</strong>
          <span className="truncate text-sm text-[#5C5C5C]">
            {contactId ? (
              <>
                {sub.join(" · ")}
                {sub.length > 0 && head && head.contact_conversations > 0 ? " · " : ""}
                {head && head.contact_conversations > 0 && (
                  <Link href={`/${lang}/dashboard/contacts/${contactId}`} className="underline underline-offset-4" data-inbox-contact>
                    {plural(x, "conversations", head.contact_conversations, lang)}
                  </Link>
                )}
              </>
            ) : (
              [languageName(conv.shopper_lang ?? conv.page_lang, lang, c.unknown), t(x.started, { time: formatDateTime(started, lang, tz) })].join(" · ")
            )}
          </span>
        </span>
        <span className="flex flex-none items-center gap-2">
          {conv.pdf_status === "ready" ? (
            <a href={conversationPdfUrl(id)} download className={ghost} data-conversation-pdf={id}>
              {c.download_pdf}
            </a>
          ) : (
            <span className="hidden whitespace-nowrap text-[13px] text-[#5C5C5C] md:inline" data-pdf-state={conv.pdf_status}>
              {c.pdf}: {conv.pdf_status === "failed" ? c.pdf_failed : c.pdf_waiting}
            </span>
          )}
          {contactId && (
            <Link href={`/${lang}/dashboard/bookings?${new URLSearchParams({ shop: shop.slug, new: "1", contact: contactId })}`} className={ghost} data-inbox-booking>
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="5" width="18" height="16" rx="2" />
                <path d="M16 3v4M8 3v4M3 10h18M12 13v5M9.5 15.5h5" />
              </svg>
              <span className="hidden sm:inline">{x.booking}</span>
            </Link>
          )}
          <details className="relative" data-inbox-menu>
            <summary className={`${ghost} w-11 cursor-pointer list-none px-0 [&::-webkit-details-marker]:hidden`} aria-label={x.menu}>
              ⋯
            </summary>
            <div className="absolute right-0 top-12 z-30 flex w-72 flex-col gap-0.5 rounded-2xl border border-[#E4E4E4] bg-white p-2 shadow-lg">
              <form action={markConversation}>
                {hidden({ op: conv.starred ? "unstar" : "star" })}
                <button type="submit" className={menuItem} data-mark={conv.starred ? "unstar" : "star"}>
                  {conv.starred ? c.unstar : x.star}
                </button>
              </form>
              <form action={markConversation}>
                {hidden({ op: "new" })}
                <button type="submit" className={menuItem} data-mark="new">
                  {x.mark_unread}
                </button>
              </form>
              <form action={markConversation}>
                {hidden({ op: conv.status === "archived" ? "unarchive" : "archive" })}
                <button type="submit" className={menuItem} data-mark={conv.status === "archived" ? "unarchive" : "archive"}>
                  {conv.status === "archived" ? c.unarchive : c.archive}
                </button>
              </form>
              <DialogButton label={x.note} title={c.note_title} close={x.close} attr="data-inbox-note">
                <form action={saveConversationNote} className="flex flex-col gap-2" data-note>
                  {hidden()}
                  <textarea name="note" rows={4} maxLength={2000} defaultValue={conv.owner_note ?? ""} className={fieldClass} aria-label={c.note_title} />
                  <p className="text-xs text-[#5C5C5C]">{c.note_hint}</p>
                  <PendingButton pending={dict.owner.saving}>{c.note_save}</PendingButton>
                </form>
              </DialogButton>
              <a href={`/api/owner/conversations/${id}/txt?lang=${lang}`} download className={menuItem} data-conversation-txt>
                {c.download_txt}
              </a>
              <DialogButton label={x.link_contact} title={k.link_title} close={x.close} attr="data-inbox-link-contact">
                <form action={linkConversation} className="flex flex-col gap-2">
                  {hidden()}
                  <label className="flex flex-col gap-1 text-sm">
                    {k.link_select}
                    <select name="contact_id" defaultValue={contactId ?? ""} className={`${fieldClass} bg-white`}>
                      <option value="">–</option>
                      {contacts.map((o) => (
                        <option key={o.id} value={o.id}>
                          {[o.name, o.phone, o.email].filter(Boolean).join(" · ") || k.no_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <PendingButton pending={dict.owner.saving}>{k.link_button}</PendingButton>
                  <Link href={`/${lang}/dashboard/contacts?${new URLSearchParams({ shop: shop.slug, new: "1", conversation: id })}#new`} className="text-sm underline underline-offset-4">
                    {k.create_from}
                  </Link>
                </form>
              </DialogButton>
              {conv.export_status && conv.export_status !== "none" && (
                <div className="px-3 py-2" data-inbox-cloud>
                  <ExportState
                    status={conv.export_status as ExportStatus}
                    error={conv.export_error}
                    path={conv.export_path}
                    canRetry={cloudConnected && hasPlan}
                    hidden={hidden({ from: "detail" })}
                    dict={dict}
                  />
                </div>
              )}
              <DialogButton label={x.delete} title={c.delete_title} close={x.close} attr="data-inbox-delete-one">
                <form action={deleteConversation} className="flex flex-col gap-3">
                  {hidden()}
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="confirm" required />
                    {c.delete_confirm}
                  </label>
                  <PendingButton pending={dict.owner.saving}>{c.delete_button}</PendingButton>
                </form>
              </DialogButton>
            </div>
          </details>
        </span>
      </div>

      {notice}
      {conv.callback_at && !conv.callback_answered_at && (
        <div className="flex flex-none flex-wrap items-center justify-between gap-2 border-b border-[#E4E4E4] bg-[#FAFAFA] px-5 py-2 text-sm" data-conversation-callback data-answered="false">
          <span className="min-w-0">
            <strong>{dict.callbacks.waiting_title}</strong> · {t(dict.callbacks.left_at, { when: formatDateTime(conv.callback_at, lang, tz) })}
            {conv.callback_name ? ` · ${conv.callback_name}` : ""}
            {conv.callback_email ? ` · ${conv.callback_email}` : ""}
          </span>
          <form action={markCallback}>
            <input type="hidden" name="lang" value={lang} />
            <input type="hidden" name="shop_slug" value={shop.slug} />
            <input type="hidden" name="conversation_id" value={id} />
            <input type="hidden" name="from" value="conversation" />
            <input type="hidden" name="done" value="1" />
            <button type="submit" className="min-h-11 rounded-xl border border-[#111] px-3 font-bold">
              {dict.callbacks.done}
            </button>
          </form>
        </div>
      )}
      {conv.attachment_count > 0 && !links && <p className="flex-none px-5 py-2 text-sm">{c.links_failed}</p>}

      <MessagesScroll id={id} count={messages.length}>
        {timeline.map((item) => (
          <div key={item.key} className="contents">
            {item.node}
          </div>
        ))}
        {head?.access_key_used && pill(x.event_access_key, "access_key")}
        {loose.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-bold text-[#5C5C5C]">{c.other_files}</span>
            <Files files={loose} links={links} lang={lang} dict={dict} />
          </div>
        )}
        {conv.attachment_count > 0 && links && <p className="text-xs text-[#5C5C5C]">{c.links_note}</p>}
      </MessagesScroll>

      {!contactId || !(head?.has_phone || head?.has_email) ? (
        <p className="flex-none border-t border-[#E4E4E4] px-5 py-4 text-sm text-[#5C5C5C]" data-reply="none">
          {x.no_reply}
        </p>
      ) : !hasPlan ? (
        <p className="flex-none border-t border-[#E4E4E4] px-5 py-4 text-sm" data-reply="no_plan">
          {k.needs_plan}{" "}
          <Link href={`/${lang}/dashboard/plan?shop=${shop.slug}`} className="font-bold underline underline-offset-4">
            {x.plan_link}
          </Link>
        </p>
      ) : (
        <ReplyBox
          key={id}
          lang={lang}
          conversationId={id}
          contactId={contactId}
          hasPhone={Boolean(head?.has_phone)}
          hasEmail={Boolean(head?.has_email)}
          emailReady={configRes?.data?.email === true}
          smsLive={configRes?.data?.sms_live === true}
          templates={(templatesRes?.data ?? []) as ComposerTemplate[]}
          texts={{ ...(k as Record<string, string>), ...x, grammar: k.grammar }}
          shopId={shop.id}
          grammarOn={ownerAiReady()}
          draft={draft}
          smsLeft={sms ? { left: quotaLeft(sms.owner), limit: sms.owner.limit } : null}
          timeZone={tz}
        />
      )}
    </section>
  );
}

/** The shopper's files: pictures as previews (opened large in a new tab), other files by name (10-minute links). */
function Files({ files, links, lang, dict }: { files: Attachment[]; links: Links | null; lang: Locale; dict: Dictionary }) {
  const c = dict.conversations;
  return (
    <ul className="flex flex-wrap gap-3" data-files>
      {files.map((file) => {
        const link = links?.[file.id];
        const open = link?.original ?? link?.preview ?? null;
        return (
          <li key={file.id} className="flex max-w-40 flex-col gap-1 text-xs">
            {link?.preview ? (
              <a href={open ?? link.preview} target="_blank" rel="noopener noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element -- 10-minute address of the shopper's picture */}
                <img src={link.preview} alt={file.name} loading="lazy" className="h-28 w-28 rounded-lg border border-[#E4E4E4] object-cover" />
              </a>
            ) : (
              <span className="flex h-28 w-28 items-center justify-center rounded-lg border border-[#E4E4E4] p-2 text-center text-[#5C5C5C]">
                {file.kind.toUpperCase()}
                {file.kind !== "pdf" && ` · ${c.no_preview}`}
              </span>
            )}
            <span className="break-all">{file.name}</span>
            <span className="text-[#5C5C5C]">
              {file.kind.toUpperCase()}, {size(file.bytes, lang)}
              {open && (
                <>
                  {" · "}
                  <a href={open} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
                    {c.view}
                  </a>
                </>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The item cards as the shopper saw them: name, price, availability and the time of the shop's data. */
function Cards({ cards, when, dict, href }: { cards: Card[]; when: (iso: string) => string; dict: Dictionary; href: (itemId: string | undefined) => string | null }) {
  const c = dict.conversations;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-cards>
        <thead>
          <tr className="border-b border-[#E4E4E4] text-left text-[#5C5C5C]">
            <th className="py-1 pr-2 font-normal">{c.item}</th>
            <th className="py-1 pr-2 font-normal">{c.price}</th>
            <th className="py-1 pr-2 font-normal">{c.availability}</th>
            <th className="py-1 font-normal">{c.data_at}</th>
          </tr>
        </thead>
        <tbody>
          {cards.map((card, i) => (
            <tr key={i} className="border-b border-[#E4E4E4] align-top">
              <td className="py-1 pr-2">
                {href(card.item_id) ? (
                  <Link href={href(card.item_id)!} className="underline underline-offset-4" data-card-item={card.item_id}>
                    {card.name}
                  </Link>
                ) : (
                  card.name
                )}
                {card.item_id && !href(card.item_id) && <span className="text-xs text-[#5C5C5C]"> · {c.item_gone}</span>}
                {card.quantity ? <span className="text-[#5C5C5C]"> · {t(c.quantity, { n: card.quantity })}</span> : null}
                {card.note && <span className="block text-xs text-[#5C5C5C]">{card.note}</span>}
              </td>
              <td className="whitespace-nowrap py-1 pr-2">{card.price}</td>
              <td className="py-1 pr-2 font-semibold">{card.availability ?? "–"}</td>
              <td className="whitespace-nowrap py-1">{card.data_time ? when(card.data_time) : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
