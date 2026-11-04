import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { forwardUrl, movedFrom } from "@/lib/dashboardPages";
import type { MyShop } from "@/lib/myShops";
import { DbError } from "@/components/DbError";
import { AssistantOverview, loadOverview } from "../AssistantOverview";
import { CrmHead, waitingCount } from "../AssistantTabs";
import { Callbacks, loadCallbacks } from "../Callbacks";
import { CloudFolder, cloudSummary, loadCloud } from "../CloudFolder";
import { conversationFilter, Conversations, conversationsSummary, loadConversations } from "../Conversations";
import { hiddenFields, messages, ProOnly } from "../shared";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/crm">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).nav.crm };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * CRM (back-end layout L2, 2026-11-03; it was Asistent's Prehľad and Konverzácie, update 63): one row of tabs —
 * Prehľad · Konverzácie · Kontakty · Šablóny — plain links. "Prehľad" (who waits for an answer, today's numbers, the next
 * bookings, this month's SMS), "Konverzácie" (`?at=conversations`: who waits, status, star, filters, search, bulk
 * actions, exports and the cloud folder `#cloud`; kept until the owner deletes them); Kontakty and Šablóny keep their
 * page /dashboard/contacts. A free shop sees "Dostupné v Pro" where it has nothing yet; what it already has stays
 * reachable. Every paid part checks shop_has_plan() in SQL. Old addresses (`/dashboard/assistant?at=overview|
 * conversations|cloud`) are forwarded here with their query.
 */
export default async function CrmPage({ params, searchParams }: PageProps<"/[lang]/dashboard/crm">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const at = first(sp.at) ?? "";
  if (movedFrom("crm", at)) redirect(forwardUrl(lang, at, sp));
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const c = dict.conversations;
  const tab = at === "conversations" || at === "cloud" ? "conversations" : "overview";

  const { data: shopRows, error: shopsError } = await supabase.rpc("my_shops");
  if (shopsError) return <DbError message={shopsError.message} dict={dict} />;
  const shops = (shopRows ?? []) as MyShop[];
  if (!shops.length) redirect(`/${lang}/dashboard`);
  const shop = shops.find((s) => s.slug === first(sp.shop)) ?? shops[0];

  // Only the open tab's data is loaded (the badge of "Konverzácie" is one count).
  const [hasPlan, conversations, cloud, waiting, callbacks, overview] = await Promise.all([
    supabase.rpc("shop_has_plan", { p_shop_id: shop.id }),
    // The assistant's conversations (database update 22, filters update 55): owners only.
    tab === "conversations" ? loadConversations(supabase, shop.id, conversationFilter(sp)) : Promise.resolve(null),
    // The shop's cloud folder (database update 23): owners only, never the tokens.
    tab === "conversations" ? loadCloud(supabase, shop.id) : Promise.resolve(null),
    waitingCount(supabase, shop.id),
    // Shoppers who left a contact after an unanswered question (database update 59).
    tab === "conversations" ? loadCallbacks(supabase, shop.id) : Promise.resolve(null),
    tab === "overview" ? loadOverview(supabase, shop.id, shop.timezone) : Promise.resolve(null),
  ]);
  const planActive = !hasPlan.error && hasPlan.data === true;
  const number = (key: string) => Math.max(0, Math.floor(Number(first(sp[key])) || 0));
  const m = messages(dict, sp, {
    backfilled: number("n"),
    n: number("n"),
    failed: number("failed"),
  });
  const hidden = hiddenFields(lang, shop);
  const planUrl = `/${lang}/dashboard/plan?${new URLSearchParams({ shop: shop.slug })}`;
  // What a free shop still has (from its Pro time) stays reachable; otherwise "Dostupné v Pro".
  const showConversations = planActive || (conversations?.all ?? 0) > 0;
  const showCloud = Boolean(cloud && (planActive || cloud.connection));

  return (
    <div className="flex w-full flex-col gap-5">
      <CrmHead
        dict={dict}
        lang={lang}
        shops={shops}
        shop={shop}
        current={tab}
        waiting={waiting}
        switchHref={(slug) => `/${lang}/dashboard/crm?${new URLSearchParams({ shop: slug, ...(tab !== "overview" ? { at: tab } : {}) })}`}
      />
      <div className="flex max-w-3xl flex-col gap-5">
      {m.top}
      {!planActive && tab === "overview" && <ProOnly dict={dict} href={planUrl} />}

      {tab === "overview" && overview && <AssistantOverview data={overview} lang={lang} dict={dict} shop={shop.slug} timeZone={shop.timezone} />}

      {/* Konverzácie, with the cloud folder they are copied to */}
      {tab === "conversations" && (
        <section id="conversations" className="flex scroll-mt-4 flex-col gap-4" data-tab-panel="conversations">
          <h2 className="text-lg font-semibold">
            {c.title} <span className="text-sm font-normal text-muted">· {conversationsSummary(conversations, dict, lang)}</span>
          </h2>
          {callbacks && callbacks.length > 0 && (
            <Callbacks rows={callbacks} lang={lang} timeZone={shop.timezone} dict={dict} hidden={hidden} />
          )}
          {showConversations ? (
            <Conversations
              data={conversations}
              shop={shop}
              lang={lang}
              dict={dict}
              hasPlan={planActive}
              cloudConnected={Boolean(cloud?.connection)}
              hidden={hidden}
              notice={m.notice("conversations")}
            />
          ) : (
            <ProOnly dict={dict} href={planUrl} />
          )}
          {showCloud && cloud && (
            <div id="cloud" className="flex scroll-mt-4 flex-col gap-3 border-t border-line pt-4" data-cloud-part>
              <h3 className="font-semibold">
                {dict.cloud.title} <span className="font-normal text-muted">· {cloudSummary(cloud, dict)}</span>
              </h3>
              <CloudFolder cloud={cloud} shop={shop} lang={lang} dict={dict} hasPlan={planActive} hidden={hidden} notice={m.notice("cloud")} />
            </div>
          )}
        </section>
      )}
      </div>
    </div>
  );
}
