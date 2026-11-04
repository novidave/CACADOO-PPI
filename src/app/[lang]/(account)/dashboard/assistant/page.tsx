import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { BOOKING_TAB_OF_PART, bookingPartUrl, forwardUrl, movedFrom } from "@/lib/dashboardPages";
import { foodTab } from "@/lib/foodOwner";
import type { MyShop } from "@/lib/myShops";
import { DbError } from "@/components/DbError";
import { itemTabs, PageHead } from "@/components/owner/PageHead";
import { ASSISTANT_PARTS, AssistantSettings } from "../AssistantSettings";
import { hiddenFields, messages, ShopSwitcher } from "../shared";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/assistant">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).nav.assistant };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * AI asistent → Nastavenia (back-end layout L2, 2026-11-03): the assistant's texts, the way to "Objednávky jedla v
 * asistentovi" and to the private folders. Its tabs: Nastavenia · Dokumenty (/dashboard/assistant/documents) ·
 * Súkromné priečinky (/dashboard/assistant/folders). What used to be here moved, and its old addresses are forwarded
 * with their query: Prehľad and Konverzácie (`?at=overview|conversations|cloud`) to CRM (/dashboard/crm); the
 * bookings' setup (`?at=settings&part=rules|services|resources|blocks|calendar|messages`) to its Rezervácie tab.
 */
export default async function AssistantPage({ params, searchParams }: PageProps<"/[lang]/dashboard/assistant">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const at = first(sp.at) ?? "";
  if (movedFrom("assistant", at)) redirect(forwardUrl(lang, at, sp));
  const part = first(sp.part) ?? "";
  if (BOOKING_TAB_OF_PART[part]) {
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(sp)) if (k !== "at" && k !== "part" && typeof first(v) === "string") query[k] = first(v)!;
    redirect(bookingPartUrl(lang, part, query));
  }
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const { supabase } = session;
  const d = dict.dashboard;

  const { data: shopRows, error: shopsError } = await supabase.rpc("my_shops");
  if (shopsError) return <DbError message={shopsError.message} dict={dict} />;
  const shops = (shopRows ?? []) as MyShop[];
  if (!shops.length) redirect(`/${lang}/dashboard`);
  const shop = shops.find((s) => s.slug === first(sp.shop)) ?? shops[0];

  const [hasPlan, food] = await Promise.all([
    supabase.rpc("shop_has_plan", { p_shop_id: shop.id }),
    // the switch of "Objednávky jedla v asistentovi" (database update 74) lives on its own settings page
    foodTab(supabase, shop.id),
  ]);
  const planActive = !hasPlan.error && hasPlan.data === true;
  const m = messages(dict, sp);
  const hidden = hiddenFields(lang, shop);
  const planUrl = `/${lang}/dashboard/plan?${new URLSearchParams({ shop: shop.slug })}`;
  // the forms come back with ?part= (texts); their own messages are `asst.*`
  const asstTexts = dict.asst as Record<string, string>;
  const settingsNotice = (which: string) => {
    if (which !== (part || "texts")) return null;
    const ok = first(sp.ok);
    const err = first(sp.err);
    if (ok) return <p role="status" className="border border-foreground p-3 font-medium">{asstTexts[ok] ?? dict.account.saved}</p>;
    if (err) return <p role="alert" className="border border-line p-3">{asstTexts[err] ?? asstTexts.err_failed}</p>;
    return null;
  };

  return (
    <div className="flex w-full flex-col gap-5">
      <PageHead title={dict.nav.assistant} item="assistant" tabs={itemTabs(dict, lang, "assistant", shop.slug)} current="settings" tabsLabel={dict.nav.tabs_label}>
        <ShopSwitcher shops={shops} current={shop} label={d.shop} href={(slug) => `/${lang}/dashboard/assistant?${new URLSearchParams({ shop: slug })}`} />
        {shops.length > 1 && <p className="text-muted">{shop.name}</p>}
      </PageHead>
      <div className="flex max-w-3xl flex-col gap-5">
      <AssistantSettings
        setup={null}
        shop={shop}
        lang={lang}
        dict={dict}
        planActive={planActive}
        planUrl={planUrl}
        hidden={hidden}
        notice={(which) => (which === "texts" && m.notice("settings")) || settingsNotice(which)}
        googleOn
        food={food}
        only={ASSISTANT_PARTS}
      />
      </div>
    </div>
  );
}
