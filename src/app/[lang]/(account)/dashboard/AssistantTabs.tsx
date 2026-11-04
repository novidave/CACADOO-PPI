import { t, type Dictionary } from "@/i18n/dictionaries";
import type { MyShop } from "@/lib/myShops";
import { itemTabs, PageHead } from "@/components/owner/PageHead";
import { ShopSwitcher } from "./shared";

/**
 * The Asistent tab row of update 63 became the menu items CRM, Rezervácie, Objednávky jedla and AI asistent with their
 * own tabs (back-end layout L2, @/components/owner/PageHead); what stays here is the count their badges show and
 * CRM's head.
 */

/** How many shoppers wait for an answer in this shop (database update 59), for the tab's badge. */
export async function waitingCount(
  supabase: { rpc: (name: string) => PromiseLike<{ data: unknown; error: unknown }> },
  shopId: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("owner_callbacks_waiting");
  if (error) return 0;
  return ((data ?? []) as { shop_id?: string; waiting: number }[])
    .filter((r) => !r.shop_id || r.shop_id === shopId)
    .reduce((n, r) => n + Number(r.waiting), 0);
}

/**
 * CRM's head on every tab (Prehľad · Konverzácie · Kontakty · Šablóny) and on the pages under them (a contact, a
 * conversation): the title, the shop switcher and the tabs with the waiting shoppers' badge — one block, the same
 * everywhere (back-end layout: the tabs never move). Messages, the plan box and "SMS tento mesiac" go under it.
 */
export function CrmHead({
  dict,
  lang,
  shops,
  shop,
  current,
  waiting,
  switchHref,
}: {
  dict: Dictionary;
  lang: string;
  shops: MyShop[];
  shop: MyShop;
  current: "overview" | "conversations" | "contacts" | "templates" | "messages";
  waiting: number;
  switchHref: (slug: string) => string;
}) {
  const tabs = itemTabs(dict, lang, "crm", shop.slug, { conversations: waiting }).map((x) =>
    x.key === "conversations" && waiting > 0 ? { ...x, badgeLabel: t(dict.asst.waiting_badge, { n: waiting }) } : x,
  );
  return (
    <PageHead title={dict.nav.crm} item="crm" tabs={tabs} current={current} tabsLabel={dict.nav.tabs_label}>
      <ShopSwitcher shops={shops} current={shop} label={dict.dashboard.shop} href={switchHref} />
      {shops.length > 1 && <p className="text-muted">{shop.name}</p>}
    </PageHead>
  );
}
