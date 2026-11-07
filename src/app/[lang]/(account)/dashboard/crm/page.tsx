import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { defaultOpen, INBOX_FILTERS, inboxHref, type InboxFilter } from "@/lib/crmInbox";
import { crmCloudScript, crmForward, forwardUrl, movedFrom } from "@/lib/dashboardPages";
import type { MyShop } from "@/lib/myShops";
import { requestTime } from "@/lib/requestTime";
import { DbError } from "@/components/DbError";
import { PendingButton } from "@/components/PendingButton";
import { InboxFrame } from "@/components/owner/InboxParts";
import { cardClass } from "@/components/owner/ui";
import { AssistantOverview, loadOverview } from "../AssistantOverview";
import { CrmHead, crmBadgeCount } from "../AssistantTabs";
import { CloudFolder, cloudSummary, loadCloud } from "../CloudFolder";
import { saveShopperPdf } from "../conversationActions";
import { conversationFilter, filterQuery } from "../Conversations";
import { hiddenFields, messages, ProOnly } from "../shared";
import { ConversationPane, InboxEmpty, InboxListPane, loadInbox } from "./Inbox";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/crm">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).nav.crm };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * CRM (back-end layout L2; 2026-11-07 the two-pane inbox): tabs Konverzácie · Kontakty · Šablóny · Správy · Prehľad.
 * **Konverzácie** = this address without `at` (canvas "Cacaduu – webová aplikácia (Môj obchod)", artboards 8 / 8b): the
 * list on the left (`./Inbox` InboxListPane), the open conversation `c` on the right (ConversationPane: head, messages,
 * reply with drafts); ≥ 1024 px both panes fill the window under the tabs, below one pane at a time ("‹ Konverzácie").
 * Without `c` a computer opens the newest waiting conversation, else the newest (not marked read: only a chosen one
 * is). **Prehľad** = `?at=overview`: who waits, today's numbers, the next bookings, "Zákazníci si môžu stiahnuť…" and
 * the cloud folder as its last card. Old addresses: `?at=conversations` → here, `?at=cloud` / `#cloud` → Prehľad,
 * /dashboard/conversations/<id> → `?c=<id>`, Asistent's old tabs (`movedFrom`). Every paid part checks shop_has_plan()
 * in SQL; what a free shop already has stays reachable.
 */
export default async function CrmPage({ params, searchParams }: PageProps<"/[lang]/dashboard/crm">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const at = first(sp.at) ?? "";
  const forward = crmForward(lang, sp);
  if (forward) redirect(forward);
  if (at !== "overview" && movedFrom("crm", at)) redirect(forwardUrl(lang, at, sp));
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const tab = at === "overview" ? "overview" : "conversations";

  const { data: shopRows, error: shopsError } = await supabase.rpc("my_shops");
  if (shopsError) return <DbError message={shopsError.message} dict={dict} />;
  const shops = (shopRows ?? []) as MyShop[];
  if (!shops.length) redirect(`/${lang}/dashboard`);
  const shop = shops.find((s) => s.slug === first(sp.shop)) ?? shops[0];

  const filter = conversationFilter(sp);
  const fValue = first(sp.f) ?? "";
  const f: InboxFilter = (INBOX_FILTERS as readonly string[]).includes(fValue) ? (fValue as InboxFilter) : "";

  // Only the open tab's data is loaded (the badge is one count).
  const [hasPlan, badge, inbox, overview, cloud, pdfSetting] = await Promise.all([
    supabase.rpc("shop_has_plan", { p_shop_id: shop.id }),
    crmBadgeCount(supabase, shop.id),
    tab === "conversations" ? loadInbox(supabase, shop.id, filter, f) : Promise.resolve(null),
    tab === "overview" ? loadOverview(supabase, shop.id, shop.timezone) : Promise.resolve(null),
    // The shop's cloud folder (database update 23): owners only, never the tokens.
    tab === "overview" ? loadCloud(supabase, shop.id) : Promise.resolve(null),
    tab === "overview" ? supabase.from("shop_assistant_settings").select("shopper_pdf").eq("shop_id", shop.id).maybeSingle() : Promise.resolve(null),
  ]);
  const planActive = !hasPlan.error && hasPlan.data === true;
  const number = (key: string) => Math.max(0, Math.floor(Number(first(sp[key])) || 0));
  const m = messages(dict, sp, { backfilled: number("n"), n: number("n"), failed: number("failed") });
  const hidden = hiddenFields(lang, shop);
  const planUrl = `/${lang}/dashboard/plan?${new URLSearchParams({ shop: shop.slug })}`;
  const head = (
    <CrmHead
      dict={dict}
      lang={lang}
      shops={shops}
      shop={shop}
      current={tab}
      badge={badge}
      switchHref={(slug) => `/${lang}/dashboard/crm?${new URLSearchParams({ shop: slug, ...(tab === "overview" ? { at: "overview" } : {}) })}`}
    />
  );

  if (tab === "overview") {
    const showCloud = Boolean(cloud && (planActive || cloud.connection));
    const shopperPdf = pdfSetting && !pdfSetting.error ? (pdfSetting.data?.shopper_pdf ?? true) : null;
    return (
      <div className="flex w-full flex-col gap-5">
        {head}
        <div className="flex max-w-3xl flex-col gap-5">
          {m.notice("overview") ?? m.top}
          {!planActive && <ProOnly dict={dict} href={planUrl} />}
          {overview && <AssistantOverview data={overview} lang={lang} dict={dict} shop={shop.slug} timeZone={shop.timezone} />}
          {planActive && shopperPdf !== null && (
            <form action={saveShopperPdf} className={`${cardClass} flex flex-col gap-2`} data-shopper-pdf-setting>
              {hidden({ at: "overview" })}
              <label className="flex items-center gap-2 font-semibold">
                <input type="checkbox" name="shopper_pdf" defaultChecked={shopperPdf} className="h-5 w-5 accent-foreground" />
                {dict.conversations.shopper_pdf}
              </label>
              <p className="text-sm text-muted">{dict.conversations.shopper_pdf_hint}</p>
              <p className="text-sm text-muted" data-kept>
                {dict.asst.kept_until_deleted}
              </p>
              <PendingButton pending={dict.owner.saving}>{dict.account.save}</PendingButton>
            </form>
          )}
          {/* the cloud folder the finished conversations are copied to: Prehľad's last card */}
          {showCloud && cloud && (
            <section id="cloud" className={`${cardClass} flex scroll-mt-4 flex-col gap-3`} data-cloud-part>
              <h2 className="text-lg font-semibold">
                {dict.cloud.title} <span className="text-sm font-normal text-muted">· {cloudSummary(cloud, dict)}</span>
              </h2>
              <CloudFolder cloud={cloud} shop={shop} lang={lang} dict={dict} hasPlan={planActive} hidden={hidden} notice={null} />
            </section>
          )}
        </div>
      </div>
    );
  }

  // ---- Konverzácie: the two-pane inbox
  const asked = first(sp.c) ?? "";
  const chosen = UUID.test(asked) ? asked : null;
  const data = inbox!;
  const open = chosen ?? defaultOpen(data.rows);
  const query: Record<string, string> = { shop: shop.slug, ...(f ? { f } : {}), ...filterQuery(filter) };
  const base = `/${lang}/dashboard/crm`;
  const listHref = inboxHref(base, query, null);
  const ok = first(sp.ok);
  const err = first(sp.err);
  const showInbox = planActive || data.counts.all > 0 || !data.ready;

  // a form's answer about the open conversation goes into its pane; the list's own (bulk, deleted) above the inbox
  const paneNotice = (() => {
    if (!chosen || (!ok && !err)) return null;
    const cloudErr = err?.startsWith("cloud_") ? err.slice("cloud_".length) : null;
    const text = ok
      ? ok === "note"
        ? dict.conversations.ok_note
        : ok === "linked"
          ? dict.contacts.ok_linked
          : ok === "cloud_retry"
            ? dict.cloud.ok_retry
            : m.okText
      : cloudErr
        ? ((dict.cloud as Record<string, string>)[`error_${cloudErr}`] ?? t(dict.cloud.error_other, { message: cloudErr.replace(/^other:/, "") }))
        : err === "note"
          ? dict.conversations.note_failed
          : err === "delete"
            ? dict.conversations.delete_failed
            : err === "confirm"
              ? dict.conversations.delete_confirm
              : err?.startsWith("err_")
                ? ((dict.contacts as Record<string, string>)[err] ?? dict.contacts.err_failed)
                : t(dict.account.error, { message: "–" });
    return (
      <p role="status" className={`flex-none border-b border-[#E4E4E4] px-5 py-2 text-sm ${ok ? "font-bold" : ""}`} data-inbox-notice>
        {text}
      </p>
    );
  })();

  return (
    <div className="flex w-full flex-col gap-4">
      {head}
      {/* #cloud never reaches the server: on to Prehľad's cloud card */}
      <script dangerouslySetInnerHTML={{ __html: crmCloudScript(lang) }} />
      {!chosen && (ok || err) && <div className="max-w-3xl">{m.top}</div>}
      {!showInbox ? (
        <div className="max-w-3xl">
          <ProOnly dict={dict} href={planUrl} />
        </div>
      ) : (
        <InboxFrame open={Boolean(chosen)}>
          <InboxListPane data={data} shop={shop} lang={lang} dict={dict} filter={filter} f={f} open={open} query={query} now={requestTime()} />
          {open ? (
            <ConversationPane
              supabase={supabase}
              id={open}
              shop={shop}
              lang={lang}
              dict={dict}
              listHref={listHref}
              notice={paneNotice}
              markRead={Boolean(chosen) && first(sp.unread) !== "1"}
            />
          ) : (
            <InboxEmpty dict={dict} />
          )}
        </InboxFrame>
      )}
    </div>
  );
}
