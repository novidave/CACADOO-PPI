import { t, type Dictionary } from "@/i18n/dictionaries";
import type { MyShop } from "@/lib/myShops";
import { itemTabs, PageHead } from "@/components/owner/PageHead";
import { ShopSwitcher } from "./shared";

/**
 * The Asistent tab row of update 63 became the menu items CRM, Rezervácie, Objednávky jedla and AI asistent with their
 * own tabs (back-end layout L2, @/components/owner/PageHead); what stays here is the count their badges show and
 * CRM's head.
 */

/**
 * Konverzácie's badge (2026-11-07): how many conversations are new (owner_conversations_new, database update 55; 0
 * before it). The menu's CRM badge keeps new + waiting callbacks.
 */
export async function crmBadgeCount(
  supabase: { rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> },
  shopId: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("owner_conversations_new", { p_shop_id: shopId });
  return error ? 0 : Math.max(0, Number(data ?? 0));
}

/**
 * CRM's head on every tab (Konverzácie · Kontakty · Šablóny · Správy · Prehľad) and on the pages under them (a
 * contact): the title, the shop switcher and the tabs with Konverzácie's badge (new conversations) — one block, the same
 * everywhere (back-end layout: the tabs never move). Messages, the plan box and "SMS tento mesiac" go under it.
 */
export function CrmHead({
  dict,
  lang,
  shops,
  shop,
  current,
  badge,
  switchHref,
}: {
  dict: Dictionary;
  lang: string;
  shops: MyShop[];
  shop: MyShop;
  current: "overview" | "conversations" | "contacts" | "templates" | "messages";
  badge: number;
  switchHref: (slug: string) => string;
}) {
  const tabs = itemTabs(dict, lang, "crm", shop.slug, { conversations: badge }).map((x) =>
    x.key === "conversations" && badge > 0 ? { ...x, badgeLabel: t((dict.crm_inbox as Record<string, string>).badge_new, { n: badge }) } : x,
  );
  return (
    <PageHead title={dict.nav.crm} item="crm" tabs={tabs} current={current} tabsLabel={dict.nav.tabs_label}>
      <ShopSwitcher shops={shops} current={shop} label={dict.dashboard.shop} href={switchHref} />
      {shops.length > 1 && <p className="text-muted">{shop.name}</p>}
    </PageHead>
  );
}
