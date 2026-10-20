import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { forwardUrl, movedFrom } from "@/lib/dashboardPages";
import { formatDateTime } from "@/lib/format";
import type { MyShop } from "@/lib/myShops";
import { requestTime } from "@/lib/requestTime";
import { folderSyncLabels } from "@/lib/syncLabels";
import { DashboardSection } from "@/components/DashboardSection";
import { ConversationFolderSync } from "@/components/ConversationFolderSync";
import { DbError } from "@/components/DbError";
import { FolderSync } from "@/components/FolderSync";
import { InstallApp } from "@/components/InstallApp";
import { messages, recentlyText, ShopSwitcher } from "../dashboard/shared";

export async function generateMetadata({ params }: PageProps<"/[lang]/sync">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).sync.title };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * "Priečinok s exportom" — also the shop PC's PPI window (the installed app starts here):
 * connect the folder the stock software exports to (while open, the newest file is sent
 * every 15 minutes) and, with the paid plan, a folder the assistant's finished conversations
 * are saved to as PDFs (every 5 minutes). The files in private folders and the last 10 stock
 * files moved to "Asistent" (update 38): their old addresses are forwarded there.
 * One shop at a time (a shop switcher with more shops; one window per shop on the PC).
 */
export default async function SyncPage({ params, searchParams }: PageProps<"/[lang]/sync">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const at = typeof sp.at === "string" ? sp.at : "";
  if (movedFrom("sync", at)) redirect(forwardUrl(lang, at, sp));
  const [dict, { supabase }] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const o = dict.owner;
  const d = dict.dashboard;

  const { data: shopRows, error: shopsError } = await supabase.rpc("my_shops");
  if (shopsError) return <DbError message={shopsError.message} dict={dict} />;
  const shops = (shopRows ?? []) as MyShop[];

  if (shops.length === 0) {
    return (
      <div className="flex max-w-3xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{dict.sync.title}</h1>
          <p className="text-sm">{dict.sync.intro}</p>
        </header>
        <p className="border border-line p-4">{dict.sync.no_shop}</p>
        <InstallApp labels={dict.sync} />
      </div>
    );
  }

  const shop = shops.find((s) => s.slug === first(sp.shop)) ?? shops[0];
  const [hasPlan, itemCount, latestImport] = await Promise.all([
    supabase.rpc("shop_has_plan", { p_shop_id: shop.id }),
    supabase.from("shop_items").select("id", { count: "exact", head: true }).eq("shop_id", shop.id),
    // The newest stock file (its report is under "Asistent" → "Posledné nahrané súbory"); none before update 21.
    supabase.from("stock_imports").select("received_at").eq("shop_id", shop.id).order("received_at", { ascending: false }).limit(1),
  ]);
  const planActive = !hasPlan.error && hasPlan.data === true;
  const m = messages(dict, sp);

  const when = (iso: string | null) => (iso ? formatDateTime(iso, lang, shop.timezone) : dict.account.never);
  const now = new Date(requestTime());
  const products = itemCount.count ?? 0;
  const productCount = (n: number) => {
    const forms = d as Record<string, string>;
    return t(forms[`products_${new Intl.PluralRules(lang).select(n)}`] ?? d.products_other, { n });
  };
  const lastUpload = (latestImport.data as { received_at: string }[] | null)?.[0]?.received_at ?? shop.latest_file_time;
  const summaries = {
    export: lastUpload
      ? t(d.summary_export, { when: recentlyText(lastUpload, lang, shop.timezone, dict, now), products: productCount(products) })
      : d.summary_no_file,
  };

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{dict.sync.title}</h1>
        <ShopSwitcher shops={shops} current={shop} label={d.shop} href={(slug) => `/${lang}/sync?${new URLSearchParams({ shop: slug })}`} />
        <p className="text-muted">{shop.name}</p>
        <p className="text-sm">{dict.sync.intro}</p>
        {m.top}
      </header>

      <div className="flex flex-col border-t border-line">
        <DashboardSection {...m.section("export")} first title={o.export_title} summary={summaries.export}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-muted">{d.latest_file}</dt>
            <dd>{when(shop.latest_file_time)}</dd>
            <dt className="text-muted">{d.state}</dt>
            <dd className="font-semibold">{dict.account[`state_${shop.freshness_state}`]}</dd>
            <dt className="text-muted">{o.folder_seen}</dt>
            <dd>{when(shop.folder_seen_at)}</dd>
            <dt className="text-muted">{o.last_file_name}</dt>
            <dd className="break-all">{shop.last_file_name || "–"}</dd>
            <dt className="text-muted">{d.last_error}</dt>
            <dd>{shop.last_error || dict.account.none}</dd>
          </dl>
          <FolderSync
            shopId={shop.id}
            shopName={shop.name}
            showName={false}
            lang={lang}
            timeZone={shop.timezone}
            loginHref={`/${lang}/login`}
            labels={folderSyncLabels(dict)}
          />
          <div className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{o.export_rules_title}</span>
            <ul className="list-disc pl-6">
              <li>{o.rule_folder}</li>
              <li>{o.rule_format}</li>
              <li>{o.rule_columns}</li>
              <li>{o.rule_all}</li>
              <li>{o.rule_schedule}</li>
              <li>{o.rule_public}</li>
              <li>{o.rule_pc}</li>
            </ul>
          </div>
          <InstallApp labels={dict.sync} />
        </DashboardSection>

        {planActive && (
          <DashboardSection {...m.section("conversations-pc")} title={dict.conv_folder.title} summary={dict.conv_folder.summary}>
            <p className="text-sm">{dict.conv_folder.intro}</p>
            <ConversationFolderSync shopId={shop.id} lang={lang} timeZone={shop.timezone} loginHref={`/${lang}/login`} labels={dict.conv_folder} />
          </DashboardSection>
        )}
      </div>
    </div>
  );
}
