import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary, t, type Dictionary } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { formatDateTime, formatTime, localDay } from "@/lib/format";
import type { MyShop } from "@/lib/myShops";
import { DbError } from "@/components/DbError";
import { PendingButton } from "@/components/PendingButton";
import { deleteConversation } from "../../conversationActions";
import { countText, languageName } from "../../Conversations";

export const metadata: Metadata = { robots: { index: false } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Card {
  name?: string;
  price?: string;
  availability?: string;
  data_time?: string;
  quantity?: number;
  note?: string;
}

interface Message {
  id: number;
  role: "shopper" | "assistant";
  body: string;
  body_owner: string | null;
  lang: string | null;
  cards: Card[];
  attachment_ids: string[];
  created_at: string;
}

interface Attachment {
  id: string;
  name: string;
  kind: "jpeg" | "png" | "webp" | "heic" | "pdf";
  bytes: number;
}

type Links = Record<string, { original: string | null; preview: string | null }>;

const size = (bytes: number, lang: Locale) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toLocaleString(lang, { maximumFractionDigits: 1 })} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} kB`;

/**
 * One conversation of the shop's assistant, for the shop's owners only (RLS): every message
 * with its time, the Slovak version of foreign messages, the item cards as the shopper saw
 * them and the shopper's files (pictures shown here; files open in the browser through
 * 10-minute links). View only: no download buttons; the owner can delete it.
 */
export default async function ConversationPage({ params, searchParams }: PageProps<"/[lang]/dashboard/conversations/[id]">) {
  const { lang, id } = await params;
  if (!isLocale(lang) || !UUID.test(id)) notFound();
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const c = dict.conversations;
  const err = (await searchParams).err;

  const { data: conv, error } = await supabase
    .from("assistant_conversations")
    .select("id, shop_id, page_lang, shopper_lang, started_at, last_message_at, ended_at, message_count, attachment_count, pdf_status")
    .eq("id", id)
    .maybeSingle();
  if (error) return <DbError message={error.message} dict={dict} />;
  const back = (slug?: string) => `/${lang}/dashboard?${new URLSearchParams({ ...(slug ? { shop: slug } : {}), at: "conversations" })}#conversations`;
  if (!conv) {
    return (
      <div className="flex max-w-3xl flex-col gap-4">
        <Link href={back()} className="text-sm underline underline-offset-4">
          {c.back}
        </Link>
        <p>{c.not_found}</p>
      </div>
    );
  }

  const [shopsRes, messagesRes, attachmentsRes, linksRes] = await Promise.all([
    supabase.rpc("my_shops"),
    supabase
      .from("assistant_messages")
      .select("id, role, body, body_owner, lang, cards, attachment_ids, created_at")
      .eq("conversation_id", id)
      .order("created_at")
      .order("id"),
    supabase.from("assistant_attachments").select("id, name, kind, bytes").eq("conversation_id", id).order("created_at"),
    // 10-minute addresses of the pictures and files; the function checks the owner's login again.
    conv.attachment_count > 0
      ? supabase.functions.invoke<{ files?: Links }>("assistant-archive", { body: { action: "owner_links", conversation_id: id } })
      : Promise.resolve({ data: { files: {} as Links }, error: null }),
  ]);
  if (messagesRes.error) return <DbError message={messagesRes.error.message} dict={dict} />;
  const shop = ((shopsRes.data ?? []) as MyShop[]).find((s) => s.id === conv.shop_id);
  if (!shop) notFound();
  const messages = (messagesRes.data ?? []) as Message[];
  const attachments = (attachmentsRes.data ?? []) as Attachment[];
  const links: Links | null = linksRes.error ? null : (linksRes.data?.files ?? {});
  const byId = new Map(attachments.map((a) => [a.id, a]));
  const linked = new Set(messages.flatMap((m) => m.attachment_ids ?? []));
  const loose = attachments.filter((a) => !linked.has(a.id));
  const tz = shop.timezone;
  const started = new Date(conv.started_at);
  // A time on the conversation's day is written as time only.
  const when = (iso: string) => {
    const date = new Date(iso);
    return localDay(date, tz) === localDay(started, tz) ? formatTime(date, tz) : formatDateTime(date, lang, tz);
  };
  const pdfText = conv.pdf_status === "ready" ? c.pdf_ready : conv.pdf_status === "failed" ? c.pdf_failed : c.pdf_waiting;

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link href={back(shop.slug)} className="text-sm underline underline-offset-4">
          {c.back}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{t(c.heading, { date: formatDateTime(started, lang, tz) })}</h1>
        <p className="text-sm text-muted">{shop.name}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-muted">{c.started}</dt>
          <dd>{formatDateTime(started, lang, tz)}</dd>
          <dt className="text-muted">{c.ended}</dt>
          <dd>{conv.ended_at ? when(conv.ended_at) : c.running}</dd>
          <dt className="text-muted">{c.language}</dt>
          <dd>{languageName(conv.shopper_lang, lang, c.unknown)}</dd>
          <dt className="text-muted">{c.page_language}</dt>
          <dd>{languageName(conv.page_lang, lang, c.unknown)}</dd>
          <dt className="text-muted">{dict.conversations.pdf}</dt>
          <dd>{pdfText}</dd>
        </dl>
        <p className="text-sm text-muted">
          {countText(c, "messages", conv.message_count, lang)}
          {conv.attachment_count > 0 && ` · ${t(c.files, { n: conv.attachment_count })}`}
        </p>
      </header>

      {err && <p className="border border-line p-3">{err === "delete" ? c.delete_failed : c.delete_confirm}</p>}
      {conv.attachment_count > 0 && !links && <p className="border border-line p-3 text-sm">{c.links_failed}</p>}

      <ol className="flex flex-col border-t border-line" data-messages>
        {messages.map((m) => (
          <li key={m.id} className="flex flex-col gap-2 border-b border-line py-4" data-role={m.role}>
            <span className="text-xs font-semibold text-muted">
              {when(m.created_at)} · {m.role === "shopper" ? c.shopper : c.assistant}
            </span>
            {m.body && <p className="whitespace-pre-line break-words">{m.body}</p>}
            {m.body_owner && (
              <p className="whitespace-pre-line break-words text-sm text-muted" data-owner-version>
                {c.in_slovak} {m.body_owner}
              </p>
            )}
            {m.role === "shopper" && (m.attachment_ids ?? []).length > 0 && (
              <Files
                files={m.attachment_ids.map((a) => byId.get(a)).filter((a): a is Attachment => Boolean(a))}
                links={links}
                lang={lang}
                dict={dict}
              />
            )}
            {m.role === "assistant" && (m.cards ?? []).length > 0 && <Cards cards={m.cards} when={when} dict={dict} />}
          </li>
        ))}
      </ol>

      {loose.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="font-semibold">{c.other_files}</h2>
          <Files files={loose} links={links} lang={lang} dict={dict} />
        </section>
      )}
      {conv.attachment_count > 0 && links && <p className="text-xs text-muted">{c.links_note}</p>}

      <form action={deleteConversation} className="flex flex-col gap-3 border-t border-line pt-4">
        <input type="hidden" name="lang" value={lang} />
        <input type="hidden" name="shop_id" value={shop.id} />
        <input type="hidden" name="shop_slug" value={shop.slug} />
        <input type="hidden" name="conversation_id" value={conv.id} />
        <h2 className="font-semibold">{c.delete_title}</h2>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="confirm" required />
          {c.delete_confirm}
        </label>
        <PendingButton pending={dict.owner.saving}>{c.delete_button}</PendingButton>
      </form>
    </div>
  );
}

/** The shopper's files: pictures as previews (opened large in a new tab), other files by name. */
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
                <img src={link.preview} alt={file.name} loading="lazy" className="h-28 w-28 border border-line object-cover" />
              </a>
            ) : (
              <span className="flex h-28 w-28 items-center justify-center border border-line p-2 text-center text-muted">
                {file.kind.toUpperCase()}
                {file.kind !== "pdf" && ` · ${c.no_preview}`}
              </span>
            )}
            <span className="break-all">{file.name}</span>
            <span className="text-muted">
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
function Cards({ cards, when, dict }: { cards: Card[]; when: (iso: string) => string; dict: Dictionary }) {
  const c = dict.conversations;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-cards>
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th className="py-1 pr-2 font-normal">{c.item}</th>
            <th className="py-1 pr-2 font-normal">{c.price}</th>
            <th className="py-1 pr-2 font-normal">{c.availability}</th>
            <th className="py-1 font-normal">{c.data_at}</th>
          </tr>
        </thead>
        <tbody>
          {cards.map((card, i) => (
            <tr key={i} className="border-b border-line align-top">
              <td className="py-1 pr-2">
                {card.name}
                {card.quantity ? <span className="text-muted"> · {t(c.quantity, { n: card.quantity })}</span> : null}
                {card.note && <span className="block text-xs text-muted">{card.note}</span>}
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
