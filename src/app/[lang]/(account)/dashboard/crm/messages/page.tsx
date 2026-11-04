import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { ownerAiReady } from "@/lib/grammar";
import { loadSmsUsage } from "@/lib/smsUsage";
import { DbError } from "@/components/DbError";
import { SmsUsage } from "@/components/SmsUsage";
import type { ComposerTemplate } from "@/components/MessageComposer";
import { MessageCenter } from "@/components/owner/MessageCenter";
import { fieldClass, ghostClass } from "@/components/owner/ui";
import { CrmHead, waitingCount } from "../../AssistantTabs";
import { ProOnly } from "../../shared";
import { chooseShop, ContactFields } from "../../contacts/parts";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/crm/messages">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const dict = await getDictionary(lang);
  return { title: `${dict.nav.tabs.crm_messages} · ${dict.nav.crm}` };
}

const PAGE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

interface LogRow {
  id: string;
  created_at: string;
  contact_id: string | null;
  contact_name: string | null;
  recipient: string;
  channel: "sms" | "email";
  status: "queued" | "sent" | "failed" | "test";
  kind: string | null;
  subject: string | null;
  first_line: string | null;
  total_count: number;
}

/**
 * CRM → Správy (2026-11-04, database update 76): one place to write to any of the shop's contacts — the head and the
 * tabs as on every CRM tab, "SMS tento mesiac" under them, then "Komu" (a live search, "+ Nový kontakt") and the
 * composer (the tags, "Opraviť gramatiku", "Náhľad", "Odoslať" through crm-messages), and every message the shop sent
 * to its contacts (owner_messages_log: channel, status, words). A row opens the contact's own Správy.
 */
export default async function CrmMessagesPage({ params, searchParams }: PageProps<"/[lang]/dashboard/crm/messages">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const m = dict.crm_msg as Record<string, string>;
  const c = dict.contacts as Record<string, string>;
  const chosen = await chooseShop(supabase, first(sp.shop));
  if (chosen.error) return <DbError message={chosen.error} dict={dict} />;
  const shop = chosen.shop;
  if (!shop) redirect(`/${lang}/dashboard`);

  const channel = ["sms", "email"].includes(first(sp.ch) ?? "") ? (first(sp.ch) as string) : "";
  const status = ["queued", "sent", "failed", "test"].includes(first(sp.st) ?? "") ? (first(sp.st) as string) : "";
  const q = (first(sp.q) ?? "").trim().slice(0, 100);
  const page = Math.max(1, Math.floor(Number(first(sp.page)) || 1));
  const to = first(sp.to) ?? "";

  const [plan, sms, waiting, templates, config, log, initial] = await Promise.all([
    supabase.rpc("shop_has_plan", { p_shop_id: shop.id }),
    loadSmsUsage(supabase, shop.id),
    waitingCount(supabase, shop.id),
    supabase.from("shop_email_templates").select("id, name, channel, subject, body").eq("shop_id", shop.id).order("name"),
    supabase.functions.invoke<{ email?: boolean; sms_live?: boolean }>("crm-messages", { body: { action: "config" } }),
    supabase.rpc("owner_messages_log", { p_shop_id: shop.id, p_channel: channel || null, p_status: status || null, p_q: q || null, p_limit: PAGE, p_offset: (page - 1) * PAGE }),
    UUID.test(to)
      ? supabase.from("shop_contacts").select("id, name, phone, email").eq("id", to).eq("shop_id", shop.id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const hasPlan = !plan.error && plan.data === true;
  const rows = (log.error ? [] : (log.data ?? [])) as LogRow[];
  const total = Number(rows[0]?.total_count ?? 0);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const base = { shop: shop.slug, ...(channel ? { ch: channel } : {}), ...(status ? { st: status } : {}), ...(q ? { q } : {}) };
  const url = (extra: Record<string, string>) => `/${lang}/dashboard/crm/messages?${new URLSearchParams({ ...base, ...extra })}`;
  const statusText = (s: string) => m[`status_${s}`] ?? s;

  return (
    <div className="flex w-full flex-col gap-5">
      <CrmHead
        dict={dict}
        lang={lang}
        shops={chosen.shops}
        shop={shop}
        current="messages"
        waiting={waiting}
        switchHref={(slug) => `/${lang}/dashboard/crm/messages?shop=${slug}`}
      />
      <div className="flex max-w-3xl flex-col gap-5">
        {/* right under the tabs: this month's SMS of the shop's own messages */}
        {hasPlan && sms && <SmsUsage usage={sms} lang={lang} timeZone={shop.timezone} dict={dict} only="owner" />}
        {!hasPlan && <ProOnly dict={dict} href={`/${lang}/dashboard/plan?${new URLSearchParams({ shop: shop.slug })}`} />}

        <MessageCenter
          lang={lang}
          shopId={shop.id}
          shopSlug={shop.slug}
          texts={m}
          composerTexts={c}
          newContactFields={<ContactFields dict={dict} contact={null} />}
          templates={(templates.data ?? []) as ComposerTemplate[]}
          emailReady={config.data?.email === true}
          smsLive={config.data?.sms_live === true}
          grammarOn={hasPlan && ownerAiReady()}
          canWrite={hasPlan}
          initial={(initial.data ?? null) as { id: string; name: string | null; phone: string | null; email: string | null } | null}
        />

        <section className="flex flex-col gap-3" aria-labelledby="sent-log" data-messages-log>
          <h2 id="sent-log" className="text-[17px] font-bold">
            {m.log_title}
          </h2>
          <form method="get" action={`/${lang}/dashboard/crm/messages`} role="search" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="shop" value={shop.slug} />
            <label className="flex min-w-48 flex-1 flex-col gap-1">
              <span className="text-sm">{m.log_search}</span>
              <input type="search" name="q" defaultValue={q} maxLength={100} className={fieldClass} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm">{m.log_channel}</span>
              <select name="ch" defaultValue={channel} className={`${fieldClass} w-auto`}>
                <option value="">{m.log_all}</option>
                <option value="sms">{c.channel_sms}</option>
                <option value="email">{c.channel_email}</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm">{m.log_status}</span>
              <select name="st" defaultValue={status} className={`${fieldClass} w-auto`}>
                <option value="">{m.log_all}</option>
                {["sent", "test", "queued", "failed"].map((s) => (
                  <option key={s} value={s}>
                    {statusText(s)}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className={ghostClass}>
              {m.log_filter}
            </button>
          </form>
          {rows.length === 0 ? (
            <p className="text-sm text-[#5C5C5C]">{m.log_empty}</p>
          ) : (
            <>
              <p className="text-sm text-[#5C5C5C]">{t(m.log_count, { n: total })}</p>
              <ul className="flex flex-col divide-y divide-[#E4E4E4] rounded-2xl border border-[#E4E4E4]">
                {rows.map((r) => {
                  const who = r.contact_name || r.recipient;
                  const line = (
                    <>
                      <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <strong className="text-[15px]">{r.contact_id ? who : `${who} (${m.deleted_contact})`}</strong>
                        <span className="text-xs text-[#5C5C5C]">{formatDateTime(r.created_at, lang, shop.timezone)}</span>
                      </span>
                      <span className="text-xs font-semibold text-[#5C5C5C]">
                        {r.channel === "sms" ? c.channel_sms : c.channel_email} · {statusText(r.status)}
                      </span>
                      <span className="truncate text-sm">{r.subject ? `${r.subject} – ` : ""}{r.first_line}</span>
                    </>
                  );
                  return (
                    <li key={r.id} data-log-row={r.channel}>
                      {r.contact_id ? (
                        <Link
                          href={`/${lang}/dashboard/contacts/${r.contact_id}?tab=messages`}
                          aria-label={t(m.log_open, { name: who })}
                          className="flex min-h-11 flex-col gap-0.5 px-3 py-2.5 hover:bg-[#F6F6F6]"
                        >
                          {line}
                        </Link>
                      ) : (
                        <div className="flex flex-col gap-0.5 px-3 py-2.5">{line}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {pages > 1 && (
                <nav className="flex gap-2" aria-label={m.log_title}>
                  {page > 1 && (
                    <Link href={url({ page: String(page - 1) })} className={ghostClass}>
                      ←
                    </Link>
                  )}
                  {page < pages && (
                    <Link href={url({ page: String(page + 1) })} className={ghostClass}>
                      {m.log_more}
                    </Link>
                  )}
                </nav>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
