import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { forwardUrl, movedFrom } from "@/lib/dashboardPages";
import type { MyShop } from "@/lib/myShops";
import { DbError } from "@/components/DbError";
import { AssistantOverview, loadOverview } from "../AssistantOverview";
import { AssistantSettings, type BookingSetup } from "../AssistantSettings";
import { AssistantTabs, waitingCount } from "../AssistantTabs";
import { Callbacks, loadCallbacks } from "../Callbacks";
import { CloudFolder, cloudSummary, loadCloud } from "../CloudFolder";
import { conversationFilter, Conversations, conversationsSummary, loadConversations } from "../Conversations";
import { hiddenFields, messages, ProOnly, ShopSwitcher } from "../shared";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/assistant">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).account.assistant_page };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The tabs this page shows (update 63); Kontakty, Rezervácie and Šablóny are tabs on their own pages. */
type Tab = "overview" | "conversations" | "settings";
const tabOf = (at: string): Tab => (at === "conversations" || at === "cloud" ? "conversations" : at === "settings" ? "settings" : "overview");

/**
 * "Asistent" (update 63, the approved screens): one row of tabs — Prehľad · Konverzácie · Kontakty · Rezervácie ·
 * Šablóny · Nastavenia — plain links (`?at=`), so they work without JavaScript and every old address still lands on its
 * part: "Prehľad" (who waits for an answer, today's numbers, the next bookings, this month's SMS), "Konverzácie" (status,
 * star, filters, search, bulk actions, exports, the cloud folder; kept until the owner deletes them), "Nastavenia" (the
 * assistant's texts, the automatic messages, the bookings' setup, the way to "Súkromné priečinky", which have their own
 * page /dashboard/assistant/folders). A free shop sees "Dostupné v Pro" where it has nothing yet; what it already has
 * stays reachable. Every paid part checks shop_has_plan() in SQL.
 */
export default async function AssistantPage({ params, searchParams }: PageProps<"/[lang]/dashboard/assistant">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const at = first(sp.at) ?? "";
  if (movedFrom("assistant", at)) redirect(forwardUrl(lang, at, sp));
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const d = dict.dashboard;
  const c = dict.conversations;
  const tab = tabOf(at);

  const { data: shopRows, error: shopsError } = await supabase.rpc("my_shops");
  if (shopsError) return <DbError message={shopsError.message} dict={dict} />;
  const shops = (shopRows ?? []) as MyShop[];
  if (!shops.length) redirect(`/${lang}/dashboard`);
  const shop = shops.find((s) => s.slug === first(sp.shop)) ?? shops[0];

  // Only the open tab's data is loaded (the badge of "Konverzácie" is one count).
  const [hasPlan, conversations, cloud, waiting, callbacks, overview, setup] = await Promise.all([
    supabase.rpc("shop_has_plan", { p_shop_id: shop.id }),
    // The assistant's conversations (database update 22, filters update 55): owners only.
    tab === "conversations" ? loadConversations(supabase, shop.id, conversationFilter(sp)) : Promise.resolve(null),
    // The shop's cloud folder (database update 23): owners only, never the tokens.
    tab === "conversations" ? loadCloud(supabase, shop.id) : Promise.resolve(null),
    waitingCount(supabase, shop.id),
    // Shoppers who left a contact after an unanswered question (database update 59).
    tab === "conversations" ? loadCallbacks(supabase, shop.id) : Promise.resolve(null),
    tab === "overview" ? loadOverview(supabase, shop.id, shop.timezone) : Promise.resolve(null),
    tab === "settings"
      ? supabase.rpc("owner_booking_setup", { p_shop_id: shop.id }).then((r) => (r.error ? null : (r.data as BookingSetup)))
      : Promise.resolve(null),
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
  // Nastavenia's forms come back with ?part= (texts, messages, rules, services, …); its own messages are `asst.*`.
  const part = first(sp.part) ?? "texts";
  const asstTexts = dict.asst as Record<string, string>;
  const settingsNotice = (which: string) => {
    if (tab !== "settings" || which !== part) return null;
    const ok = first(sp.ok);
    const err = first(sp.err);
    if (ok) return <p role="status" className="border border-foreground p-3 font-medium">{asstTexts[ok] ?? dict.account.saved}</p>;
    if (err) return <p role="alert" className="border border-line p-3">{asstTexts[err] ?? asstTexts.err_failed}</p>;
    return null;
  };

  // What a free shop still has (from its Pro time) stays reachable; otherwise "Dostupné v Pro".
  const showConversations = planActive || (conversations?.all ?? 0) > 0;
  const showCloud = Boolean(cloud && (planActive || cloud.connection));

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <AssistantTabs lang={lang} dict={dict} shop={shop.slug} current={tab} waiting={waiting}>
        <ShopSwitcher
          shops={shops}
          current={shop}
          label={d.shop}
          href={(slug) => `/${lang}/dashboard/assistant?${new URLSearchParams({ shop: slug, ...(tab !== "overview" ? { at: tab } : {}) })}`}
        />
        {shops.length > 1 && <p className="text-muted">{shop.name}</p>}
        {tab !== "settings" && m.top}
        {!planActive && tab === "overview" && <ProOnly dict={dict} href={planUrl} />}
      </AssistantTabs>

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

      {tab === "settings" && (
        <AssistantSettings
          setup={setup}
          shop={shop}
          lang={lang}
          dict={dict}
          planActive={planActive}
          planUrl={planUrl}
          hidden={hidden}
          notice={(which) => (which === "texts" && m.notice("settings")) || settingsNotice(which)}
          googleOn
        />
      )}
    </div>
  );
}
