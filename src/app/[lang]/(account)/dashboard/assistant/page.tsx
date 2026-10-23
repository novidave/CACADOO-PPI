import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { forwardUrl, movedFrom } from "@/lib/dashboardPages";
import type { MyShop } from "@/lib/myShops";
import { DashboardSection } from "@/components/DashboardSection";
import { DbError } from "@/components/DbError";
import { saveAssistantTexts } from "../actions";
import { CloudFolder, cloudSummary, loadCloud } from "../CloudFolder";
import { conversationFilter, Conversations, conversationsSummary, loadConversations } from "../Conversations";
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

/**
 * "Asistent": everything about the shop's assistant on one page, each part once (update 38), as dropdowns like Môj
 * obchod: 1) "Nastavenia asistenta" (its button text and welcome), 2) "Konverzácie asistenta" (the list with its
 * search, and the cloud folder they are copied to), 3) "Súkromné priečinky" (the documents it answers from, the
 * folders, their access keys and "Len zobraziť" / "Zobraziť a stiahnuť"). "Posledné nahrané súbory" moved to
 * "Priečinok s exportom" (update 43); its old address is forwarded there. A free shop sees "Dostupné v Pro" where it
 * has nothing yet; what it already has stays reachable. Every paid part checks shop_has_plan() in SQL.
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

  const { data: shopRows, error: shopsError } = await supabase.rpc("my_shops");
  if (shopsError) return <DbError message={shopsError.message} dict={dict} />;
  const shops = (shopRows ?? []) as MyShop[];
  if (!shops.length) redirect(`/${lang}/dashboard`);
  const shop = shops.find((s) => s.slug === first(sp.shop)) ?? shops[0];

  const [hasPlan, docsData, conversations, cloud] = await Promise.all([
    supabase.rpc("shop_has_plan", { p_shop_id: shop.id }),
    loadShopDocs(supabase, shop.id),
    // The assistant's conversations (database update 22): owners only.
    loadConversations(supabase, shop.id, conversationFilter(sp)),
    // The shop's cloud folder (database update 23): owners only, never the tokens.
    loadCloud(supabase, shop.id),
  ]);
  const planActive = !hasPlan.error && hasPlan.data === true;
  const m = messages(dict, sp, {
    retention: conversations?.retention ?? 90,
    backfilled: Math.max(0, Math.floor(Number(first(sp.n)) || 0)),
  });
  const hidden = hiddenFields(lang, shop);
  const planUrl = `/${lang}/dashboard/plan?${new URLSearchParams({ shop: shop.slug })}`;

  // What a free shop still has (from its Pro time) stays reachable; otherwise "Dostupné v Pro".
  const showConversations = planActive || (conversations?.all ?? 0) > 0;
  const showCloud = Boolean(cloud && (planActive || cloud.connection));
  const showDocs = Boolean(
    docsData && (planActive || docsData.docs.length > 0 || docsData.pictures.length > 0 || docsData.keys.length > 0),
  );
  const summaries = {
    assistant: planActive ? t(d.summary_assistant, { label: shop.assistant_label || dict.chat.title }) : d.pro_only,
    conversations: showConversations ? conversationsSummary(conversations, dict, lang) : d.pro_only,
    docs: !docsData
      ? dict.docs.unavailable
      : showDocs
        ? t(d.summary_docs, { documents: docsData.docs.length, pictures: docsData.pictures.length })
        : d.pro_only,
  };

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{dict.account.assistant_page}</h1>
        <ShopSwitcher
          shops={shops}
          current={shop}
          label={d.shop}
          href={(slug) => `/${lang}/dashboard/assistant?${new URLSearchParams({ shop: slug })}`}
        />
        <p className="text-muted">{shop.name}</p>
        <p className="text-sm">{dict.account.assistant_page_intro}</p>
        {m.top}
      </header>

      <div className="flex flex-col border-t border-line" data-assistant-sections>
        {/* 1. Nastavenia asistenta */}
        <DashboardSection {...m.section("assistant")} first title={d.assistant_title} summary={summaries.assistant}>
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
        </DashboardSection>

        {/* 2. Konverzácie asistenta, with the cloud folder they are copied to */}
        <DashboardSection
          id="conversations"
          forceOpen={at === "conversations" || at === "cloud"}
          title={dict.conversations.title}
          summary={summaries.conversations}
        >
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
        </DashboardSection>

        {/* 3. Súkromné priečinky: documents, folders, access keys, "Len zobraziť" / "Zobraziť a stiahnuť" */}
        <DashboardSection {...m.section("docs")} title={d.private_folders_title} summary={summaries.docs}>
          {!docsData || showDocs ? (
            <ShopDocuments supabase={supabase} data={docsData} shop={shop} lang={lang} dict={dict} hasPlan={planActive} notice={m.notice("docs")} />
          ) : (
            <>
              {m.notice("docs")}
              <p className="text-sm">{dict.docs.intro}</p>
              <ProOnly dict={dict} href={planUrl} />
            </>
          )}
        </DashboardSection>
      </div>
    </div>
  );
}
