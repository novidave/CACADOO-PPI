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
 * Every owner page's head (back-end layout, 2026-11-03): the title (28 px) with optional actions on the right, then the
 * item's tabs — plain links (they work without JavaScript), 56 px high, 16 px semibold grey, the open one black with
 * a 3 px line under it and `aria-current="page"`; on a phone the row scrolls sideways inside itself, never the page.
 * `compact` = a work screen (Predaj, the Príjemka editor, Inventúra counting, the food board): ONE row — the title
 * 20 px, the tabs 60 px, the actions / status chips on the right.
 */
export function PageHead({
  title,
  item,
  tabs,
  current,
  tabsLabel,
  actions,
  compact = false,
  children,
}: {
  title: string;
  item?: string;
  tabs?: HeadTab[];
  current?: string;
  tabsLabel?: string;
  actions?: React.ReactNode;
  compact?: boolean;
  children?: React.ReactNode;
}) {
  const tabRow = (high: string) =>
    tabs && tabs.length > 0 ? (
      <nav
        aria-label={tabsLabel ?? title}
        className={
          compact
            ? "flex min-w-0 flex-1 gap-5 overflow-x-auto whitespace-nowrap"
            : "-mx-4 flex gap-6 overflow-x-auto whitespace-nowrap border-b border-[#E4E4E4] px-4 md:mx-0 md:px-0"
        }
        data-item-tabs={item}
      >
        {tabs.map((tab) => {
          const on = tab.key === current;
          return (
            <Link
              key={tab.key}
              href={tab.href}
              aria-current={on ? "page" : undefined}
              className={`-mb-px flex ${high} flex-none items-center gap-1.5 border-b-[3px] text-base font-semibold ${
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
    ) : null;

  if (compact) {
    return (
      <>
        <header
          className="-mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-[#E4E4E4]"
          data-page-head="compact"
        >
          <h1 className="flex min-h-[60px] flex-none items-center text-xl font-bold">{title}</h1>
          {tabRow("min-h-[60px]")}
          {actions && <div className="flex flex-none flex-wrap items-center gap-2 py-2">{actions}</div>}
        </header>
        {children}
      </>
    );
  }
  return (
    <>
      <header className="flex flex-col gap-2" data-page-head>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PageTitle>{title}</PageTitle>
          {actions}
        </div>
        {children}
      </header>
      {tabRow("min-h-14")}
    </>
  );
}
