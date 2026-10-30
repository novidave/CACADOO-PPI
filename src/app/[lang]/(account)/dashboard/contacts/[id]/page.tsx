import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import type { MyShop } from "@/lib/myShops";
import { DbError } from "@/components/DbError";
import { MessageComposer, type ComposerTemplate } from "@/components/MessageComposer";
import { PendingButton } from "@/components/PendingButton";
import { countText, languageName } from "../../Conversations";
import { hiddenFields } from "../../shared";
import { deleteContact, saveContact } from "../actions";
import { ContactFields, Notice } from "../parts";

export const metadata: Metadata = { robots: { index: false } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABS = ["overview", "conversations", "bookings", "messages"] as const;
type Tab = (typeof TABS)[number];

interface Contact {
  id: string;
  shop_id: string;
  name: string | null;
  phone: string | null;
  phone_verified_at: string | null;
  email: string | null;
  address: string | null;
  tags: string[];
  note: string | null;
  source: "owner" | "chat" | "booking";
  created_at: string;
  updated_at: string;
}

interface Sent {
  id: string;
  channel: "sms" | "email";
  recipient: string;
  subject: string | null;
  body: string;
  status: "queued" | "sent" | "failed" | "test";
  created_at: string;
}

/**
 * One contact (database update 56; owners of its shop only, RLS): "Prehľad" (the details to edit, delete), "Konverzácie"
 * (the assistant's conversations that belong to it), "Rezervácie" (phase 3) and "Správy" (send an SMS or e-mail with a
 * preview first; every message sent, as written down).
 */
export default async function ContactPage({ params, searchParams }: PageProps<"/[lang]/dashboard/contacts/[id]">) {
  const { lang, id } = await params;
  if (!isLocale(lang) || !UUID.test(id)) notFound();
  const sp = await searchParams;
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const c = dict.contacts;
  const tabParam = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const tab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : "overview";

  const { data: contact, error } = await supabase.from("shop_contacts").select("*").eq("id", id).maybeSingle<Contact>();
  if (error) return <DbError message={error.message} dict={dict} />;
  if (!contact) {
    return (
      <div className="flex max-w-3xl flex-col gap-4">
        <Link href={`/${lang}/dashboard/contacts`} className="text-sm underline underline-offset-4">
          {c.back}
        </Link>
        <p>{c.not_found}</p>
      </div>
    );
  }
  const [shopsRes, plan, conversations, messages, templates, config, bookingsRes] = await Promise.all([
    supabase.rpc("my_shops"),
    supabase.rpc("shop_has_plan", { p_shop_id: contact.shop_id }),
    supabase
      .from("assistant_conversations")
      .select("id, started_at, shopper_lang, page_lang, message_count, first_question")
      .eq("contact_id", id)
      .order("started_at", { ascending: false })
      .limit(100),
    supabase.from("shop_outgoing_messages").select("id, channel, recipient, subject, body, status, created_at").eq("contact_id", id).order("created_at", { ascending: false }).limit(100),
    tab === "messages"
      ? supabase.from("shop_email_templates").select("id, name, subject, body").eq("shop_id", contact.shop_id).order("name")
      : Promise.resolve({ data: [], error: null }),
    tab === "messages"
      ? supabase.functions.invoke<{ email?: boolean; sms_live?: boolean }>("crm-messages", { body: { action: "config" } })
      : Promise.resolve({ data: null, error: null }),
    // Its bookings (database update 57; none before it).
    supabase
      .from("shop_bookings")
      .select("id, starts_at, ends_at, status, service_name")
      .eq("contact_id", id)
      .in("status", ["confirmed", "cancelled", "no_show"])
      .order("starts_at", { ascending: false })
      .limit(100),
  ]);
  const shop = ((shopsRes.data ?? []) as MyShop[]).find((s) => s.id === contact.shop_id);
  if (!shop) notFound();
  const hasPlan = !plan.error && plan.data === true;
  const tz = shop.timezone;
  const hidden = hiddenFields(lang, shop);
  const convRows = (conversations.data ?? []) as { id: string; started_at: string; shopper_lang: string | null; page_lang: string; message_count: number; first_question: string | null }[];
  const sent = (messages.data ?? []) as Sent[];
  const bookingRows = (bookingsRes.error ? [] : bookingsRes.data ?? []) as { id: string; starts_at: string; ends_at: string; status: string; service_name: string | null }[];
  const counts: Record<Tab, number | null> = { overview: null, conversations: convRows.length, bookings: bookingRows.length, messages: sent.length };
  const labels: Record<Tab, string> = { overview: c.tab_overview, conversations: c.tab_conversations, bookings: c.tab_bookings, messages: c.tab_messages };
  const title = contact.name || contact.phone || contact.email || c.no_name;
  const statusText: Record<Sent["status"], string> = { sent: c.status_sent, failed: c.status_failed, test: c.status_test, queued: c.status_queued };

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link href={`/${lang}/dashboard/contacts?shop=${shop.slug}`} className="text-sm underline underline-offset-4">
          {c.back}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight break-words">{title}</h1>
        <p className="text-sm text-muted">{shop.name}</p>
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
          {contact.phone && (
            <span>
              {contact.phone}{" "}
              <span className={contact.phone_verified_at ? "font-semibold" : "text-muted"} title={c.verified_hint} data-verified={Boolean(contact.phone_verified_at)}>
                · {contact.phone_verified_at ? c.verified : c.not_verified}
              </span>
            </span>
          )}
          {contact.email && <span className="break-all">{contact.email}</span>}
        </p>
        <Notice sp={sp} dict={dict} />
      </header>

      <nav aria-label={c.tabs} className="flex flex-wrap gap-1 border-b border-line" data-contact-detail-tabs>
        {TABS.map((to) => (
          <Link
            key={to}
            href={`/${lang}/dashboard/contacts/${id}${to === "overview" ? "" : `?tab=${to}`}`}
            aria-current={tab === to ? "page" : undefined}
            className={`-mb-px flex min-h-11 items-center gap-1 border-b-2 px-3 text-sm ${tab === to ? "border-foreground font-semibold" : "border-transparent text-muted"}`}
            data-tab={to}
          >
            {labels[to]}
            {counts[to] ? <span className="text-xs text-muted">({counts[to]})</span> : null}
          </Link>
        ))}
      </nav>

      {tab === "overview" && (
        <section className="flex flex-col gap-4" data-tab-panel="overview">
          <form action={saveContact} className="flex flex-col gap-3">
            {hidden({ contact_id: contact.id })}
            <ContactFields dict={dict} contact={contact} />
            <p className="text-xs text-muted">{c.verified_hint}</p>
            {hasPlan && <PendingButton pending={dict.owner.saving}>{c.save}</PendingButton>}
          </form>
          <p className="text-xs text-muted">
            {(c as Record<string, string>)[`source_${contact.source}`]} · {formatDateTime(contact.created_at, lang as Locale, tz)}
          </p>
          <form action={deleteContact} className="flex flex-col gap-3 border-t border-line pt-4">
            {hidden({ contact_id: contact.id })}
            <h2 className="font-semibold">{c.delete_title}</h2>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="confirm" required className="h-4 w-4 accent-foreground" />
              {c.delete_confirm}
            </label>
            <PendingButton pending={dict.owner.saving}>{c.delete_button}</PendingButton>
          </form>
        </section>
      )}

      {tab === "conversations" && (
        <section className="flex flex-col gap-3" data-tab-panel="conversations">
          <p className="text-xs text-muted">{c.conversations_hint}</p>
          {convRows.length === 0 ? (
            <p className="text-sm text-muted">{c.conversations_none}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line border-y border-line">
              {convRows.map((row) => (
                <li key={row.id}>
                  <Link href={`/${lang}/dashboard/conversations/${row.id}`} className="group flex flex-col gap-1 py-3" data-contact-conversation={row.id}>
                    <span className="flex flex-wrap gap-x-3 text-sm">
                      <span className="font-semibold">{formatDateTime(row.started_at, lang as Locale, tz)}</span>
                      <span>{languageName(row.shopper_lang ?? row.page_lang, lang as Locale, dict.conversations.unknown)}</span>
                      <span className="text-muted">{countText(dict.conversations as Record<string, string>, "messages", row.message_count, lang as Locale)}</span>
                    </span>
                    <span className="line-clamp-2 break-words group-hover:underline">{row.first_question || dict.conversations.no_text}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === "bookings" && (
        <section className="flex flex-col gap-3" data-tab-panel="bookings">
          {bookingsRes.error ? (
            <p className="text-sm text-muted">{c.bookings_none}</p>
          ) : bookingRows.length === 0 ? (
            <p className="text-sm text-muted">{dict.bookings.contact_none}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line border-y border-line">
              {bookingRows.map((row) => (
                <li key={row.id} className="flex flex-wrap gap-x-3 py-3 text-sm" data-contact-booking={row.status}>
                  <span className="font-semibold">{formatDateTime(row.starts_at, lang as Locale, tz)}</span>
                  <span className={row.status === "confirmed" ? "" : "text-muted"}>
                    {(dict.bookings as Record<string, string>)[`status_${row.status}`] ?? row.status}
                  </span>
                  {row.service_name && <span className="text-muted">{row.service_name}</span>}
                </li>
              ))}
            </ul>
          )}
          <Link href={`/${lang}/dashboard/bookings?shop=${shop.slug}`} className="self-start text-sm underline underline-offset-4">
            {dict.bookings.title}
          </Link>
        </section>
      )}

      {tab === "messages" && (
        <section className="flex flex-col gap-4" data-tab-panel="messages">
          {hasPlan ? (
            <MessageComposer
              lang={lang}
              contactId={contact.id}
              hasPhone={Boolean(contact.phone)}
              hasEmail={Boolean(contact.email)}
              emailReady={config.data?.email === true}
              smsLive={config.data?.sms_live === true}
              templates={(templates.data ?? []) as ComposerTemplate[]}
              texts={c as Record<string, string>}
            />
          ) : (
            <p className="border border-line p-3 text-sm">{c.needs_plan}</p>
          )}
          <h2 className="font-semibold">{c.log_title}</h2>
          {sent.length === 0 ? (
            <p className="text-sm text-muted">{c.log_none}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line border-y border-line" data-message-log>
              {sent.map((m) => (
                <li key={m.id} className="flex flex-col gap-1 py-3" data-message={m.status}>
                  <span className="flex flex-wrap gap-x-3 text-sm">
                    <span className="font-semibold">{formatDateTime(m.created_at, lang as Locale, tz)}</span>
                    <span>{m.channel === "sms" ? c.channel_sms : c.channel_email}</span>
                    <span className="break-all text-muted">{m.recipient}</span>
                    <span className={m.status === "sent" ? "" : "font-semibold"}>{statusText[m.status]}</span>
                  </span>
                  {m.subject && <span className="text-sm font-medium break-words">{m.subject}</span>}
                  <p className="whitespace-pre-line break-words text-sm">{m.body}</p>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted">{t(c.messages_count, { n: sent.length })}</p>
        </section>
      )}
    </div>
  );
}
