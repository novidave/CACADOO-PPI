import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { forwardUrl, movedFrom } from "@/lib/dashboardPages";
import { formatDate, formatDateTime } from "@/lib/format";
import { backupHref, readPreview, readState } from "@/lib/inventoryReset";
import type { MyShop } from "@/lib/myShops";
import { requestTime } from "@/lib/requestTime";
import { loadImports } from "@/lib/stockImports";
import { folderSyncLabels } from "@/lib/syncLabels";
import { DashboardSection } from "@/components/DashboardSection";
import { ConversationFolderSync } from "@/components/ConversationFolderSync";
import { DbError } from "@/components/DbError";
import { FolderSync } from "@/components/FolderSync";
import { InstallApp } from "@/components/InstallApp";
import { BackupDownload, DeleteFilesButton, InventoryResetOptions } from "@/components/InventoryDangerZone";
import { PendingButton } from "@/components/PendingButton";
import { RecentImports } from "@/components/RecentImports";
import { messages, recentlyText, ShopSwitcher } from "../dashboard/shared";
import { deleteStockFiles, resetInventory, restoreInventory } from "./inventoryActions";

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
 * are saved to as PDFs (every 5 minutes), the last 10 stock files ("Posledné nahrané súbory", back here with
 * "Vymazať všetky nahrané súbory" since update 43) and, collapsed at the bottom, "Nebezpečná zóna – sklad"
 * (remove the products missing from the last file, delete the whole stock, restore it, the backups, the last actions).
 * The files in private folders moved to "Asistent" (update 38): their old addresses are forwarded there.
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
  const [hasPlan, itemCount, importData, stateData, previewData] = await Promise.all([
    supabase.rpc("shop_has_plan", { p_shop_id: shop.id }),
    supabase.from("shop_items").select("id", { count: "exact", head: true }).eq("shop_id", shop.id),
    // The last 10 stock files (none before update 21).
    loadImports(supabase, shop, lang),
    // "Začať sklad odznova" (update 43): files, removals, backups, the last actions; the dialogs' counts.
    supabase.rpc("owner_inventory_state", { p_shop_id: shop.id }),
    supabase.rpc("owner_inventory_preview", { p_shop_id: shop.id }),
  ]);
  const planActive = !hasPlan.error && hasPlan.data === true;
  const m = messages(dict, sp, { n: Math.max(0, Math.floor(Number(first(sp.n)) || 0)) });
  const state = stateData.error ? null : readState(stateData.data);
  const preview = previewData.error ? null : readPreview(previewData.data);
  const r = dict.reset;
  const hidden = { lang, shop_id: shop.id, shop_slug: shop.slug };
  const backupId = Number(first(sp.backup));
  const justBackedUp = Number.isSafeInteger(backupId) && backupId > 0 && state?.backups.some((b) => b.id === backupId);

  const when = (iso: string | null) => (iso ? formatDateTime(iso, lang, shop.timezone) : dict.account.never);
  const now = new Date(requestTime());
  const products = itemCount.count ?? 0;
  const productCount = (n: number) => {
    const forms = d as Record<string, string>;
    return t(forms[`products_${new Intl.PluralRules(lang).select(n)}`] ?? d.products_other, { n });
  };
  const latestImport = importData?.latest ?? null;
  // Deleted files are not shown anywhere as present (update 43): "Žiadny nahraný súbor · nahrajte nový".
  const lastUpload = state?.files_cleared ? null : (latestImport?.received_at ?? shop.latest_file_time);
  const summaries = {
    export: state?.files_cleared
      ? r.files_none
      : lastUpload
        ? t(d.summary_export, { when: recentlyText(lastUpload, lang, shop.timezone, dict, now), products: productCount(products) })
        : d.summary_no_file,
    imports: !importData
      ? dict.imports.unavailable
      : latestImport
        ? t(dict.imports.summary, {
            status: dict.imports[`status_${latestImport.status}`],
            when: recentlyText(latestImport.received_at, lang, shop.timezone, dict, now),
          })
        : state?.files_cleared
          ? r.files_none
          : d.summary_no_file,
  };
  const activityText = (a: { action: string; details: Record<string, unknown> }) =>
    t((r as Record<string, string>)[`activity_${a.action}`] ?? a.action, {
      items: Number(a.details.items ?? 0),
      files: Number(a.details.files ?? 0),
    });

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{dict.sync.title}</h1>
        <ShopSwitcher shops={shops} current={shop} label={d.shop} href={(slug) => `/${lang}/sync?${new URLSearchParams({ shop: slug })}`} />
        <p className="text-muted">{shop.name}</p>
        <p className="text-sm">{dict.sync.intro}</p>
        {m.top}
        {state?.needs_file && (
          <div className="flex flex-col gap-1 border border-foreground p-3" data-needs-file>
            <p className="font-semibold">{r.upload_new_title}</p>
            <p className="text-sm">{r.upload_new_text}</p>
          </div>
        )}
      </header>

      <div className="flex flex-col border-t border-line">
        <DashboardSection {...m.section("export")} first title={o.export_title} summary={summaries.export}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-muted">{d.latest_file}</dt>
            <dd data-latest-file>{state?.files_cleared ? r.files_none : when(shop.latest_file_time)}</dd>
            <dt className="text-muted">{d.state}</dt>
            <dd className="font-semibold">{dict.account[`state_${shop.freshness_state}`]}</dd>
            <dt className="text-muted">{o.folder_seen}</dt>
            <dd>{when(shop.folder_seen_at)}</dd>
            <dt className="text-muted">{o.last_file_name}</dt>
            <dd className="break-all">{state?.files_cleared ? r.files_none : shop.last_file_name || "–"}</dd>
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

        {/* The last 10 stock files and "Vymazať všetky nahrané súbory" (the inventory stays). */}
        <DashboardSection {...m.section("imports")} title={dict.imports.title} summary={summaries.imports}>
          {m.notice("imports")}
          {importData ? (
            <>
              <p className="text-sm text-muted">{dict.imports.intro}</p>
              {state?.files_cleared && importData.imports.length === 0 && (
                <p className="text-sm font-semibold" data-files-cleared>
                  {r.files_none}
                </p>
              )}
              <RecentImports imports={importData.imports} labels={dict.imports} />
              {state && <DeleteFilesButton files={state.files} hidden={hidden} labels={r} action={deleteStockFiles} />}
            </>
          ) : (
            <p className="text-sm text-muted">{dict.imports.unavailable}</p>
          )}
        </DashboardSection>

        {planActive && (
          <DashboardSection {...m.section("conversations-pc")} title={dict.conv_folder.title} summary={dict.conv_folder.summary}>
            <p className="text-sm">{dict.conv_folder.intro}</p>
            <ConversationFolderSync shopId={shop.id} lang={lang} timeZone={shop.timezone} loginHref={`/${lang}/login`} labels={dict.conv_folder} />
          </DashboardSection>
        )}

        {/* "Nebezpečná zóna – sklad" (update 43): closed until the owner opens it; needs database update 43. */}
        {state && preview && (
          <DashboardSection {...m.section("danger")} collapsed title={r.danger_title} summary={r.danger_summary}>
            {m.notice("danger")}
            {justBackedUp && <BackupDownload href={backupHref(backupId)} label={r.backup_ready} link={r.backup_download} />}
            <p className="text-sm">{r.danger_intro}</p>
            <InventoryResetOptions preview={preview} hidden={hidden} labels={r} action={resetInventory} />

            <section className="flex flex-col gap-2" data-restore>
              <h3 className="font-semibold">{r.restore_title}</h3>
              <p className="text-sm text-muted">{r.restore_intro}</p>
              {state.resets.length === 0 ? (
                <p className="text-sm">{r.restore_none}</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {state.resets.map((reset) => (
                    <li key={reset.id} className="flex flex-col gap-1 border border-line p-3 text-sm" data-reset={reset.id} data-blocked={reset.blocked ?? ""}>
                      <span>
                        {t(r.restore_row, {
                          when: formatDateTime(reset.created_at, lang, shop.timezone),
                          what: reset.kind === "all" ? r.kind_all : r.kind_missing,
                          items: reset.items,
                        })}
                      </span>
                      {reset.blocked ? (
                        <span className="text-muted">{(r as Record<string, string>)[`blocked_${reset.blocked}`]}</span>
                      ) : (
                        <form action={restoreInventory} className="flex flex-col gap-1">
                          <input type="hidden" name="lang" value={lang} />
                          <input type="hidden" name="shop_id" value={shop.id} />
                          <input type="hidden" name="shop_slug" value={shop.slug} />
                          <input type="hidden" name="reset_id" value={reset.id} />
                          <span className="text-muted">{t(r.restore_until, { date: formatDate(reset.expires_at, lang, shop.timezone) })}</span>
                          <PendingButton pending={r.working}>{r.restore_button}</PendingButton>
                        </form>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="flex flex-col gap-2" data-backups>
              <h3 className="font-semibold">{r.backups_title}</h3>
              <p className="text-sm text-muted">{r.backups_intro}</p>
              {state.backups.length === 0 ? (
                <p className="text-sm">{r.backups_none}</p>
              ) : (
                <ul className="flex flex-col gap-1 text-sm">
                  {state.backups.map((b) => (
                    <li key={b.id} className="flex flex-wrap items-baseline gap-x-3">
                      <span>
                        {t(r.backup_row, {
                          when: formatDateTime(b.created_at, lang, shop.timezone),
                          rows: b.rows,
                          until: formatDate(b.expires_at, lang, shop.timezone),
                        })}
                      </span>
                      <a href={backupHref(b.id)} download className="underline underline-offset-4">
                        {r.backup_download}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="flex flex-col gap-2" data-activity>
              <h3 className="font-semibold">{r.activity_title}</h3>
              {state.activity.length === 0 ? (
                <p className="text-sm">{r.activity_none}</p>
              ) : (
                <ul className="flex flex-col gap-1 text-sm">
                  {state.activity.map((a) => (
                    <li key={`${a.at}-${a.action}`}>
                      <span className="text-muted">{formatDateTime(a.at, lang, shop.timezone)}</span> · {activityText(a)}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </DashboardSection>
        )}
      </div>
    </div>
  );
}
