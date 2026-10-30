import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { forwardUrl, movedFrom } from "@/lib/dashboardPages";
import type { MyShop } from "@/lib/myShops";
import { DbError } from "@/components/DbError";
import { saveAssistantTexts } from "../actions";
import { CloudFolder, cloudSummary, loadCloud } from "../CloudFolder";
import { conversationFilter, Conversations, conversationsSummary, loadConversations, newConversations } from "../Conversations";
import { Field, hiddenFields, inputClass, messages, ProOnly, ShopSwitcher, SubmitButton } from "../shared";
import { loadShopDocs, ShopDocuments } from "../ShopDocuments";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/assistant">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).account.assistant_page };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The page's three tabs (update 55): every section name of the page belongs to one of them. */
const TABS = ["assistant", "conversations", "docs"] as const;
type Tab = (typeof TABS)[number];
const tabOf = (at: string): Tab => (at === "conversations" || at === "cloud" ? "conversations" : at === "docs" ? "docs" : "assistant");

/**
 * "Asistent": everything about the shop's assistant on one page, each part once, as three tabs since update 55 (plain
 * links, `?at=`, so they work without JavaScript and every old address still lands on its part): 1) "Nastavenia" (its
 * button text and welcome), 2) "Konverzácie" (status, star, filters, search, bulk actions, exports, the keep time and
 * the cloud folder they are copied to; the tab shows how many wait as "Nové"), 3) "Súkromné priečinky" (the documents
 * it answers from, the folders, their access keys and "Len zobraziť" / "Zobraziť a stiahnuť"). "Posledné nahrané
 * súbory" moved to "Priečinok s exportom" (update 43); its old address is forwarded there. A free shop sees "Dostupné
 * v Pro" where it has nothing yet; what it already has stays reachable. Every paid part checks shop_has_plan() in SQL.
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
  const [hasPlan, docsData, conversations, cloud, newCount] = await Promise.all([
    supabase.rpc("shop_has_plan", { p_shop_id: shop.id }),
    tab === "docs" ? loadShopDocs(supabase, shop.id) : Promise.resolve(null),
    // The assistant's conversations (database update 22, filters update 55): owners only.
    tab === "conversations" ? loadConversations(supabase, shop.id, conversationFilter(sp)) : Promise.resolve(null),
    // The shop's cloud folder (database update 23): owners only, never the tokens.
    tab === "conversations" ? loadCloud(supabase, shop.id) : Promise.resolve(null),
    newConversations(supabase, shop.id),
  ]);
  const planActive = !hasPlan.error && hasPlan.data === true;
  const number = (key: string) => Math.max(0, Math.floor(Number(first(sp[key])) || 0));
  const m = messages(dict, sp, {
    retention: conversations?.retention ?? 90,
    backfilled: number("n"),
    n: number("n"),
    failed: number("failed"),
  });
  const hidden = hiddenFields(lang, shop);
  const planUrl = `/${lang}/dashboard/plan?${new URLSearchParams({ shop: shop.slug })}`;
  const tabUrl = (to: Tab) => `/${lang}/dashboard/assistant?${new URLSearchParams({ shop: shop.slug, at: to })}`;
  const tabLabels: Record<Tab, string> = { assistant: c.tab_settings, conversations: c.tab_conversations, docs: c.tab_docs };

  // What a free shop still has (from its Pro time) stays reachable; otherwise "Dostupné v Pro".
  const showConversations = planActive || (conversations?.all ?? 0) > 0;
  const showCloud = Boolean(cloud && (planActive || cloud.connection));
  const showDocs = Boolean(
    docsData && (planActive || docsData.docs.length > 0 || docsData.pictures.length > 0 || docsData.keys.length > 0),
  );

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{dict.account.assistant_page}</h1>
        <ShopSwitcher
          shops={shops}
          current={shop}
          label={d.shop}
          href={(slug) => `/${lang}/dashboard/assistant?${new URLSearchParams({ shop: slug, ...(at ? { at: tab } : {}) })}`}
        />
        <p className="text-muted">{shop.name}</p>
        <p className="text-sm">{dict.account.assistant_page_intro}</p>
        {m.top}
      </header>

      <nav aria-label={c.tabs} className="flex flex-wrap gap-1 border-b border-line" data-assistant-tabs>
        {TABS.map((to) => (
          <Link
            key={to}
            href={tabUrl(to)}
            aria-current={tab === to ? "page" : undefined}
            className={`-mb-px flex min-h-11 items-center gap-2 border-b-2 px-3 text-sm ${
              tab === to ? "border-foreground font-semibold" : "border-transparent text-muted hover:text-foreground"
            }`}
            data-tab={to}
          >
            {tabLabels[to]}
            {to === "conversations" && newCount > 0 && (
              <span className="rounded-full border border-foreground px-2 text-xs font-semibold" data-new-count>
                <span aria-hidden="true">{newCount > 99 ? "99+" : newCount}</span>
                <span className="sr-only">{t(c.tab_new, { n: newCount })}</span>
              </span>
            )}
          </Link>
        ))}
      </nav>

      {/* 1. Nastavenia asistenta */}
      {tab === "assistant" && (
        <section id="assistant" className="flex scroll-mt-4 flex-col gap-3" data-tab-panel="assistant">
          <h2 className="text-lg font-semibold">{d.assistant_title}</h2>
          {m.notice("assistant")}
          <p className="text-sm">{d.assistant_intro}</p>
          {planActive ? (
            <form action={saveAssistantTexts} className="flex flex-col gap-3">
              {hidden({ at: "assistant" })}
              <Field label={d.assistant_label}>
                <input
                  name="assistant_label"
                  maxLength={40}
                  defaultValue={shop.assistant_label ?? ""}
                  placeholder={dict.chat.title}
                  className={inputClass}
                />
              </Field>
              <Field label={d.assistant_welcome}>
                <textarea
                  name="assistant_welcome"
                  maxLength={300}
                  rows={3}
                  defaultValue={shop.assistant_welcome ?? ""}
                  placeholder={dict.chat.intro}
                  className={inputClass}
                />
              </Field>
              <p className="text-sm text-muted">{d.assistant_hint}</p>
              <SubmitButton pending={dict.owner.saving}>{dict.account.save}</SubmitButton>
            </form>
          ) : (
            <ProOnly dict={dict} href={planUrl} />
          )}
        </section>
      )}

      {/* 2. Konverzácie, with the cloud folder they are copied to */}
      {tab === "conversations" && (
        <section id="conversations" className="flex scroll-mt-4 flex-col gap-4" data-tab-panel="conversations">
          <h2 className="text-lg font-semibold">
            {c.title} <span className="text-sm font-normal text-muted">· {conversationsSummary(conversations, dict, lang)}</span>
          </h2>
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

      {/* 3. Súkromné priečinky: documents, folders, access keys, "Len zobraziť" / "Zobraziť a stiahnuť" */}
      {tab === "docs" && (
        <section id="docs" className="flex scroll-mt-4 flex-col gap-3" data-tab-panel="docs">
          <h2 className="text-lg font-semibold">
            {d.private_folders_title}
            {docsData && showDocs && (
              <span className="text-sm font-normal text-muted">
                {" · "}
                {t(d.summary_docs, { documents: docsData.docs.length, pictures: docsData.pictures.length })}
              </span>
            )}
          </h2>
          {!docsData || showDocs ? (
            <ShopDocuments supabase={supabase} data={docsData} shop={shop} lang={lang} dict={dict} hasPlan={planActive} notice={m.notice("docs")} />
          ) : (
            <>
              {m.notice("docs")}
              <p className="text-sm">{dict.docs.intro}</p>
              <ProOnly dict={dict} href={planUrl} />
            </>
          )}
        </section>
      )}
    </div>
  );
}
