import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { formatDateTime, formatTime, localDay } from "@/lib/format";
import type { MyShop } from "@/lib/myShops";
import { folderSyncLabels } from "@/lib/syncLabels";
import { DashboardSection } from "@/components/DashboardSection";
import { ConversationFolderSync } from "@/components/ConversationFolderSync";
import { DbError } from "@/components/DbError";
import { FolderSync } from "@/components/FolderSync";
import { InstallApp } from "@/components/InstallApp";
import { RecentImports, type ImportView } from "@/components/RecentImports";
import { PrivateFiles, privateFiles } from "../dashboard/PrivateFiles";
import { messages, ShopSwitcher } from "../dashboard/shared";
import { loadShopDocs } from "../dashboard/ShopDocuments";

export async function generateMetadata({ params }: PageProps<"/[lang]/sync">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).sync.title };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** One stock file report (public.stock_imports, written only by stock-pull). */
interface ImportRow {
  id: number;
  file_name: string | null;
  file_time: string | null;
  received_at: string;
  status: "ok" | "errors" | "waiting";
  total_rows: number;
  imported: number;
  zeroed: number;
  skipped: number;
  error: string | null;
  columns: string[] | null;
  preview: Record<string, unknown>[] | null;
}

/**
 * "Priečinok s exportom" — also the shop PC's PPI window (the installed app starts here):
 * connect the folder the stock software exports to (while open, the newest file is sent
 * every 15 minutes), with the paid plan a folder the assistant's finished conversations are
 * saved to as PDFs (every 5 minutes), the files in private folders, and the last 10 stock
 * files received.
 * One shop at a time (a shop switcher with more shops; one window per shop on the PC).
 */
export default async function SyncPage({ params, searchParams }: PageProps<"/[lang]/sync">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const [dict, { supabase }] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const sp = await searchParams;
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
  const [hasPlan, itemCount, importRows, docsData] = await Promise.all([
    supabase.rpc("shop_has_plan", { p_shop_id: shop.id }),
    supabase.from("shop_items").select("id", { count: "exact", head: true }).eq("shop_id", shop.id),
    // The last 10 stock files: written only by stock-pull, read only by the shop's owners (RLS).
    supabase
      .from("stock_imports")
      .select("id, file_name, file_time, received_at, status, total_rows, imported, zeroed, skipped, error, columns, preview")
      .eq("shop_id", shop.id)
      .order("received_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(10),
    loadShopDocs(supabase, shop.id),
  ]);
  const planActive = !hasPlan.error && hasPlan.data === true;
  // Before database update 21 there are no stock file reports yet: that section is left out.
  const importList = importRows.error ? null : ((importRows.data ?? []) as ImportRow[]);
  const files = privateFiles(docsData);
  const m = messages(dict, sp);

  const when = (iso: string | null) => (iso ? formatDateTime(iso, lang, shop.timezone) : dict.account.never);
  // "today 14:20" / "yesterday 14:20" / the date, in the shop's time zone.
  const now = new Date();
  const recently = (iso: string) => {
    const date = new Date(iso);
    const day = localDay(date, shop.timezone);
    const time = formatTime(date, shop.timezone);
    if (day === localDay(now, shop.timezone)) return t(d.today_at, { time });
    if (day === localDay(new Date(now.getTime() - 86_400_000), shop.timezone)) return t(d.yesterday_at, { time });
    return formatDateTime(iso, lang, shop.timezone);
  };
  const products = itemCount.count ?? 0;
  const productCount = (n: number) => {
    const forms = d as Record<string, string>;
    return t(forms[`products_${new Intl.PluralRules(lang).select(n)}`] ?? d.products_other, { n });
  };
  const latestImport = importList?.[0] ?? null;
  const lastUpload = latestImport?.received_at ?? shop.latest_file_time;
  const summaries = {
    export: lastUpload ? t(d.summary_export, { when: recently(lastUpload), products: productCount(products) }) : d.summary_no_file,
    private: t(dict.docs.folder_count, { n: files.length }),
    imports: latestImport
      ? t(dict.imports.summary, { status: dict.imports[`status_${latestImport.status}`], when: recently(latestImport.received_at) })
      : d.summary_no_file,
  };
  const imports: ImportView[] | null =
    importList?.map((row) => ({
      id: row.id,
      fileName: row.file_name ?? "",
      received: formatDateTime(row.received_at, lang, shop.timezone),
      fileTime: row.file_time ? formatDateTime(row.file_time, lang, shop.timezone) : null,
      status: row.status,
      total: row.total_rows,
      imported: row.imported,
      zeroed: row.zeroed,
      skipped: row.skipped,
      error: row.error,
      columns: row.columns ?? [],
      preview: Array.isArray(row.preview) ? row.preview : [],
    })) ?? null;

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
        {docsData && (planActive || files.length > 0) && (
          <DashboardSection {...m.section("private")} title={d.private_title} summary={summaries.private}>
            <PrivateFiles files={files} shop={shop} lang={lang} dict={dict} notice={m.notice("private")} />
          </DashboardSection>
        )}

        {imports && (
          <DashboardSection {...m.section("imports")} title={dict.imports.title} summary={summaries.imports}>
            <p className="text-sm text-muted">{dict.imports.intro}</p>
            <RecentImports imports={imports} labels={dict.imports} />
          </DashboardSection>
        )}
      </div>
    </div>
  );
}
