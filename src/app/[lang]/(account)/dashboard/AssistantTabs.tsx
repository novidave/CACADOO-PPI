import Link from "next/link";
import { t, type Dictionary } from "@/i18n/dictionaries";
import { ASSISTANT_TABS, assistantTabUrl, type AssistantTab } from "@/lib/dashboardPages";

/**
 * Update 63 (the approved screens): the heading "Asistent" and one row of tabs — Prehľad · Konverzácie · Kontakty ·
 * Rezervácie · Šablóny · Nastavenia — the same on the Asistent, Kontakty and Rezervácie pages. Plain links (they work
 * without JavaScript), 44 px high, scrolling sideways on a phone; the badge on Konverzácie = shoppers waiting for an answer.
 */
export function AssistantTabs({
  lang,
  dict,
  shop,
  current,
  waiting,
  children,
}: {
  lang: string;
  dict: Dictionary;
  shop: string;
  current: AssistantTab;
  waiting: number;
  children?: React.ReactNode;
}) {
  const a = dict.asst;
  const labels: Record<AssistantTab, string> = {
    overview: a.tab_overview,
    conversations: a.tab_conversations,
    contacts: a.tab_contacts,
    bookings: a.tab_bookings,
    templates: a.tab_templates,
    settings: a.tab_settings,
  };
  return (
    <>
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{dict.account.assistant_page}</h1>
        <p className="text-sm text-muted">{a.subtitle}</p>
        {children}
      </header>
      <nav
        aria-label={a.tabs}
        className="-mx-4 flex gap-5 overflow-x-auto whitespace-nowrap border-b border-line px-4 sm:mx-0 sm:px-0"
        data-assistant-tabs
      >
        {ASSISTANT_TABS.map((tab) => (
          <Link
            key={tab}
            href={assistantTabUrl(lang, tab, shop)}
            aria-current={tab === current ? "page" : undefined}
            className={`-mb-px flex min-h-11 flex-none items-center gap-1.5 border-b-2 text-[15px] font-semibold ${
              tab === current ? "border-foreground" : "border-transparent text-muted hover:text-foreground"
            }`}
            data-tab={tab}
          >
            {labels[tab]}
            {tab === "conversations" && waiting > 0 && (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-foreground px-1.5 text-xs font-bold text-white">
                <span aria-hidden="true">{waiting > 99 ? "99+" : waiting}</span>
                <span className="sr-only">{t(a.waiting_badge, { n: waiting })}</span>
              </span>
            )}
          </Link>
        ))}
      </nav>
    </>
  );
}

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
