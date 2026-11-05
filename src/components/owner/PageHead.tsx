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

/** An owner page's title (28 px bold): the h1 of every Môj obchod page (PageHead uses it too). */
export function PageTitle({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <h1 className={`text-[28px] font-bold leading-tight ${className}`}>{children}</h1>;
}

/**
 * The head of every owner page with tabs (back-end layout, 2026-11-03; one place for the tabs since 2026-11-04): ONE
 * block, the first thing in the content area, the same on every tab of the item and on the pages under them — the
 * title (28 px) in a 52 px row with the item's actions on the right (Sklad's "Skenovať"), `children` under it (only
 * what is the same on every tab: the shop switcher), then the tab row: plain links (they work without JavaScript),
 * 56 px high, 16 px semibold grey, the open one black with a 3 px line under it and `aria-current="page"`; on a phone
 * the row scrolls sideways inside itself (no scrollbar), never the page. Anything that differs between tabs —
 * messages after a save, plan boxes, banners, state strips, SMS usage — goes UNDER this block, so switching a tab
 * never moves the title or the tabs (e2e owner-shell.spec.ts measures the tab row on every tab).
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
    <div className="flex w-full flex-col" data-page-head={item ?? ""}>
      <header className="flex flex-col gap-2">
        <div className="flex min-h-[52px] flex-wrap items-center justify-between gap-3">
          <PageTitle>{title}</PageTitle>
          {actions}
        </div>
        {children}
      </header>
      {tabs && tabs.length > 0 && (
        <nav
          aria-label={tabsLabel ?? title}
          className="ppi-item-tabs -mx-4 mt-3 flex gap-6 overflow-x-auto whitespace-nowrap border-b border-[#E4E4E4] px-4 md:mx-0 md:px-0"
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
    </div>
  );
}
