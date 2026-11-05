import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { enabledLocales, getDictionary, t } from "@/i18n/dictionaries";
import { languageOf, MAIN_RECOMMENDED } from "@/i18n/languages";
import { requireUser } from "@/lib/auth";
import { loadLiveSites, shopHref } from "@/lib/customDomain";
import { OWNER_MENU } from "@/lib/dashboardPages";
import { foodTab } from "@/lib/foodOwner";
import type { MyShop } from "@/lib/myShops";
import { LanguagePicker } from "@/components/LanguagePicker";
import { NAV_BOOT, OwnerNav, type NavItemView, type NavShop } from "@/components/owner/OwnerNav";
import { AssistantPanel } from "@/components/owner/AssistantPanel";
import { ownerAiReady } from "@/lib/grammar";

// Private pages: never indexed, never cached.
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * The owner area's one shell (back-end layout, 2026-11-03): the menu (@/components/owner/OwnerNav; the map is
 * @/lib/dashboardPages OWNER_MENU) beside the page from 1024 px, a top bar with the menu button under it; the AI
 * pomocník's panel on the right (@/components/owner/AssistantPanel, computer only, when the server has the AI key). The site's own header is not shown here (globals.css,
 * `[data-owner-shell]`); its language picker moves to the end of "Účet a nastavenia". Badges per shop: CRM = new
 * conversations + shoppers waiting for an answer, Objednávky jedla = orders still new.
 */
export default async function AccountLayout({ children, params }: LayoutProps<"/[lang]">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const [dict, session, enabled] = await Promise.all([getDictionary(lang), requireUser(lang), enabledLocales()]);
  const { supabase } = session;
  const [shopsRes, waitingRes, sites] = await Promise.all([
    supabase.rpc("my_shops"),
    // shoppers waiting for an answer (database update 59)
    supabase.rpc("owner_callbacks_waiting"),
    loadLiveSites(supabase),
  ]);
  const shops = (shopsRes.error ? [] : (shopsRes.data ?? [])) as MyShop[];
  const waiting = (waitingRes.error ? [] : (waitingRes.data ?? [])) as { shop_id?: string; waiting: number }[];
  const counts = await Promise.all(
    shops.map(async (s) => {
      const [fresh, food] = await Promise.all([supabase.rpc("owner_conversations_new", { p_shop_id: s.id }), foodTab(supabase, s.id)]);
      const waits = waiting.filter((w) => w.shop_id === s.id).reduce((n, w) => n + Number(w.waiting), 0);
      return { slug: s.slug, crm: (fresh.error ? 0 : Number(fresh.data ?? 0)) + waits, food: food?.new ?? 0 };
    }),
  );

  const n = dict.nav;
  // the AI pomocník only when the server has the AI key (its switch, its page and its panel)
  const aiReady = ownerAiReady();
  const items: NavItemView[] = OWNER_MENU.filter((m) => (!m.admin || session.isAdmin) && (m.key !== "pomocnik" || aiReady)).map((m) => ({
    key: m.key,
    label: n[m.key],
    ...(m.badge ? { badges: Object.fromEntries(counts.map((c) => [c.slug, c[m.badge!]])), badgeLabel: m.badge === "food" ? n.badge_food : n.badge_crm } : {}),
  }));
  // the kind of each shop (update 79; a shop without it = goods): the menu of a restaurant differs
  const navShops: NavShop[] = shops.map((s) => ({
    slug: s.slug,
    name: s.name,
    page: s.is_active ? shopHref(sites, lang, s.slug, s.country) : null,
    kind: s.kind === "food" ? "food" : "goods",
  }));

  return (
    <div className="flex min-h-svh flex-col lg:flex-row" data-owner-shell>
      {/* a menu collapsed on this device starts collapsed, before the first paint (OwnerNav) */}
      <script dangerouslySetInnerHTML={{ __html: NAV_BOOT }} suppressHydrationWarning />
      <OwnerNav
        lang={lang}
        items={items}
        shops={navShops}
        labels={{
          nav: n.label,
          groups: { main: n.group_main, page: n.group_page, account: n.group_account },
          shop: n.shop_label,
          shops: n.shops,
          add_shop: n.add_shop,
          view_page: n.view_page,
          open_menu: n.open_menu,
          close_menu: n.close_menu,
          collapse_menu: n.collapse_menu,
          expand_menu: n.expand_menu,
          sign_out: n.sign_out,
          signed_in: n.signed_in,
        }}
        account={
          <>
            <LanguagePicker current={lang} currentNative={languageOf(lang)?.native ?? lang} enabled={enabled} recommended={MAIN_RECOMMENDED} labels={dict.languages} />
            <span className="text-sm text-[#5C5C5C] [overflow-wrap:anywhere]">{t(n.signed_in, { email: session.user.email ?? "" })}</span>
          </>
        }
      />
      <div className="min-w-0 flex-1 px-4 py-5 md:px-6 lg:px-8" data-owner-page>
        {children}
      </div>
      {aiReady && <AssistantPanel lang={lang} shops={shops.map((s) => s.slug)} texts={dict.pomocnik as Record<string, string>} />}
    </div>
  );
}
