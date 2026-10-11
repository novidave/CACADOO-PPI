import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import type { MyShop } from "@/lib/myShops";
import { DashboardSection } from "@/components/DashboardSection";
import { DbError } from "@/components/DbError";
import { saveAssistantTexts } from "../actions";
import { CloudFolder, cloudSummary, loadCloud } from "../CloudFolder";
import { conversationFilter, Conversations, conversationsSummary, loadConversations } from "../Conversations";
import { Field, hiddenFields, inputClass, messages, ShopSwitcher, SubmitButton } from "../shared";
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
 * "AI asistent": everything about the shop's assistant on one page, as dropdowns like Môj
 * obchod: its button text and welcome, the conversations, the cloud folder they are copied
 * to, and the documents it answers from. Every paid part checks shop_has_plan() in SQL.
 */
export default async function AssistantPage({ params, searchParams }: PageProps<"/[lang]/dashboard/assistant">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const sp = await searchParams;
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
  const summaries = {
    assistant: planActive ? t(d.summary_assistant, { label: shop.assistant_label || dict.chat.title }) : d.assistant_plan_only,
    conversations: conversationsSummary(conversations, dict, lang),
    cloud: cloudSummary(cloud, dict),
    docs: docsData ? t(d.summary_docs, { documents: docsData.docs.length, pictures: docsData.pictures.length }) : dict.docs.unavailable,
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

      <div className="flex flex-col border-t border-line">
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
            <p className="border border-line p-3 text-sm">{d.assistant_needs_plan}</p>
          )}
        </DashboardSection>

        {(planActive || (conversations?.all ?? 0) > 0) && (
          <DashboardSection {...m.section("conversations")} title={dict.conversations.title} summary={summaries.conversations}>
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
          </DashboardSection>
        )}

        {cloud && (planActive || cloud.connection) && (
          <DashboardSection {...m.section("cloud")} title={dict.cloud.title} summary={summaries.cloud}>
            <CloudFolder cloud={cloud} shop={shop} lang={lang} dict={dict} hasPlan={planActive} hidden={hidden} notice={m.notice("cloud")} />
          </DashboardSection>
        )}

        <DashboardSection {...m.section("docs")} title={dict.docs.title} summary={summaries.docs}>
          <ShopDocuments supabase={supabase} data={docsData} shop={shop} lang={lang} dict={dict} hasPlan={planActive} notice={m.notice("docs")} />
        </DashboardSection>
      </div>
    </div>
  );
}
