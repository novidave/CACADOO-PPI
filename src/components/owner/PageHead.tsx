import Link from "next/link";
import type { Dictionary } from "@/i18n/dictionaries";
import { ITEM_TABS, tabHref, type TabbedItem } from "@/lib/dashboardPages";

export interface HeadTab {
  key: string;
  href: string;
  label: string;
  badge?: number;
  /** The badge for screen readers ("{n} …" already filled). */
  badgeLabel?: string;
}

/** A menu item's tabs (@/lib/dashboardPages ITEM_TABS) with their labels and the open shop. */
export function itemTabs(dict: Dictionary, lang: string, item: TabbedItem, shop: string, badges: Record<string, number> = {}): HeadTab[] {
  const labels = dict.nav.tabs as Record<string, string>;
  const sklad = dict.sklad as Record<string, string>;
  return ITEM_TABS[item].map((tab) => ({
    key: tab.key,
    href: tabHref(lang, item, tab.key, shop),
    label: item === "sklad" ? (sklad[`tab_${tab.key}`] ?? tab.key) : (labels[`${item}_${tab.key}`] ?? tab.key),
    badge: badges[tab.key],
  }));
}

/**
 * Every owner page's head (back-end layout, 2026-11-03): the title (28 px) with optional actions on the right, then the
 * item's tabs — plain links (they work without JavaScript), 56 px high, 16 px semibold grey, the open one black with
 * a 3 px line under it and `aria-current="page"`; on a phone the row scrolls sideways inside itself, never the page.
 */
export function PageHead({
  title,
  item,
  tabs,
  current,
  tabsLabel,
  actions,
  children,
}: {
  title: string;
  item?: string;
  tabs?: HeadTab[];
  current?: string;
  tabsLabel?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <>
      <header className="flex flex-col gap-2" data-page-head>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-[28px] font-bold leading-tight">{title}</h1>
          {actions}
        </div>
        {children}
      </header>
      {tabs && tabs.length > 0 && (
        <nav
          aria-label={tabsLabel ?? title}
          className="-mx-4 flex gap-6 overflow-x-auto whitespace-nowrap border-b border-[#E4E4E4] px-4 md:mx-0 md:px-0"
          data-item-tabs={item}
        >
          {tabs.map((tab) => {
            const on = tab.key === current;
            return (
              <Link
                key={tab.key}
                href={tab.href}
                aria-current={on ? "page" : undefined}
                className={`-mb-px flex min-h-14 flex-none items-center gap-1.5 border-b-[3px] text-base font-semibold ${
                  on ? "border-[#111] text-[#111]" : "border-transparent text-[#5C5C5C] hover:text-[#111]"
                }`}
                data-tab={tab.key}
              >
                {tab.label}
                {(tab.badge ?? 0) > 0 && (
                  <span className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-[#111] px-1.5 text-xs font-bold text-white">
                    <span aria-hidden="true">{tab.badge! > 99 ? "99+" : tab.badge}</span>
                    {tab.badgeLabel && <span className="sr-only">{tab.badgeLabel}</span>}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      )}
    </>
  );
}
