import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { enabledLocales, getDictionary, t } from "@/i18n/dictionaries";
import { languageOf } from "@/i18n/languages";
import { requireUser } from "@/lib/auth";
import { forwardUrl, movedFrom } from "@/lib/dashboardPages";
import { formatDate, formatDateTime } from "@/lib/format";
import { backupHref, readPreview, readState } from "@/lib/inventoryReset";
import type { MyShop } from "@/lib/myShops";
import { requestTime } from "@/lib/requestTime";
import { loadImports } from "@/lib/stockImports";
import { folderSyncLabels } from "@/lib/syncLabels";
import { DashboardSection } from "@/components/DashboardSection";
import { ExportReview, type ReviewState } from "@/components/ExportReview";
import { LanguageFileUpload } from "@/components/LanguageFileUpload";
import { TranslationFolderSync } from "@/components/TranslationFolderSync";
import { ConversationFolderSync } from "@/components/ConversationFolderSync";
import { DbError } from "@/components/DbError";
import { FolderSync } from "@/components/FolderSync";
import { InstallApp } from "@/components/InstallApp";
import { InventoryConnect, type InventoryApiState } from "@/components/InventoryConnect";
import { PosAgentPanel } from "@/components/PosAgentPanel";
import { StockSourcePanel } from "@/components/StockSourcePanel";
import type { ConnectorSnapshot, ConnectorState, StockSource } from "./connectorActions";
import { BackupDownload, DeleteFilesButton, InventoryResetOptions } from "@/components/InventoryDangerZone";
import { PendingButton } from "@/components/PendingButton";
import { RecentImports } from "@/components/RecentImports";
import { ColumnsForm, columnsSummary } from "../dashboard/Inventory";
import { LanguagesForm, type LanguageSettings } from "../dashboard/LanguagesForm";
import { hiddenFields, messages, recentlyText, ShopSwitcher } from "../dashboard/shared";
import { languageList } from "../dashboard/translationShared";
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
 * "Priečinok s exportom" — also the shop PC's PPI window (the installed app starts here), in this order:
 * 0. "Pripojiť skladový program (API)" (update 49): the stock read straight from the shop's inventory program; while
 *    one is connected it is the only source, so the folder and the uploads below say so instead of sending files;
 * 1. "Priečinok so skladom": the folder the stock software exports to (read only; while open, the newest file is sent
 *    every 15 minutes);
 * 2. "Po nahratí súboru" (update 45): "Nový súbor – skontrolujte" when a file brought new columns or products, the
 *    shop's languages and the stock file's columns (both moved here from "Jazyky a inventár");
 * 3. "Preklady v priečinku" (update 45): the translations folder with sklad.<lang>.xlsx (written and read back), the
 *    ZIP and the upload of an edited file for any browser, and the stock files in other languages;
 * 4. "Posledné nahrané súbory" with "Vymazať všetky nahrané súbory" (update 43);
 * then, with the paid plan, the folder the assistant's conversations are saved to, and, collapsed at the bottom,
 * 5. "Nebezpečná zóna – sklad" (remove the missing products, delete the whole stock — and the translation files —,
 *    restore it, the backups, the last actions). Old addresses of moved sections are forwarded here.
 * One shop at a time (a shop switcher with more shops; one window per shop on the PC).
 */
export default async function SyncPage({ params, searchParams }: PageProps<"/[lang]/sync">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const at = typeof sp.at === "string" ? sp.at : "";
  if (movedFrom("sync", at)) redirect(forwardUrl(lang, at, sp));
  const [dict, { supabase }, enabled] = await Promise.all([getDictionary(lang), requireUser(lang), enabledLocales()]);
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
  const [hasPlan, itemCount, importData, stateData, previewData, reviewData, settingsData, apiData, posData, sourceData, snapData] = await Promise.all([
    supabase.rpc("shop_has_plan", { p_shop_id: shop.id }),
    supabase.from("shop_items").select("id", { count: "exact", head: true }).eq("shop_id", shop.id),
    // The last 10 stock files (none before update 21).
    loadImports(supabase, shop, lang),
    // "Začať sklad odznova" (update 43): files, removals, backups, the last actions; the dialogs' counts.
    supabase.rpc("owner_inventory_state", { p_shop_id: shop.id }),
    supabase.rpc("owner_inventory_preview", { p_shop_id: shop.id }),
    // "Nový súbor – skontrolujte" (update 45; nothing before it)
    supabase.rpc("owner_export_review", { p_shop_id: shop.id }),
    // the shop's languages (update 40)
    supabase.rpc("owner_language_settings", { p_shop_id: shop.id }),
    // the connected inventory program (update 49; nothing before it)
    supabase.rpc("owner_inventory_api", { p_shop_id: shop.id }),
    // the paired POS agents (update 50; nothing before it)
    supabase.rpc("owner_connector_devices", { p_shop_id: shop.id }),
    // "Zdroj zásob" and the POS agent's stock snapshots (update 52; nothing before it)
    supabase.rpc("owner_stock_source", { p_shop_id: shop.id }),
    supabase.rpc("owner_connector_snapshots", { p_shop_id: shop.id }),
  ]);
  const source = sourceData.error ? null : (sourceData.data as StockSource | null);
  const snapshots = snapData.error ? [] : ((snapData.data as ConnectorSnapshot[] | null) ?? []);
  const sst = dict.stock_source;
  const pos = posData.error ? null : (posData.data as ConnectorState | null);
  const pa = dict.pos_agent;
  const posSummary = !pos || pos.devices.length === 0
    ? pa.summary_none
    : t(pa.summary_devices, {
        n: pos.devices.length,
        state: (pa as Record<string, string>)[`state_${pos.devices[0].state}`] ?? pos.devices[0].state,
      });
  const api = apiData.error ? null : (apiData.data as InventoryApiState | null);
  const apiConn = api?.connection ?? null;
  const ia = dict.inventory_api;
  const programName = apiConn ? ((ia as Record<string, string>)[`name_${apiConn.provider}`] ?? apiConn.provider) : "";
  const apiTimes = apiData.error ? null : ((apiData.data as { connection?: Record<string, string | null> | null } | null)?.connection ?? null);
  const review = reviewData.error ? null : (reviewData.data as ReviewState | null);
  const settings = settingsData.error ? null : ((Array.isArray(settingsData.data) ? settingsData.data[0] : settingsData.data) as LanguageSettings | undefined) ?? null;
  const all = languageList(enabled);
  const hiddenField = hiddenFields(lang, shop);
  const ex = dict.export_folder;
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
  const apiTime = (key: string) => {
    const iso = apiTimes?.[key];
    return iso ? formatDateTime(iso, lang, shop.timezone) : null;
  };
  const apiSummary = !apiConn
    ? ia.summary_none
    : apiConn.status === "preview"
      ? t(ia.summary_preview, { program: programName })
      : apiConn.last_error_code && apiConn.status !== "active"
        ? t(ia.summary_error, { program: programName })
        : t(ia.summary_connected, { program: programName, when: apiTimes?.last_success_at ? recentlyText(apiTimes.last_success_at, lang, shop.timezone, dict, now) : ia.never });
  // While a program or the POS agent is the source, the folder and the uploads say so instead (one source at a time).
  const apiLock = apiConn ? (
    <div className="flex flex-col gap-1 border border-foreground p-3 text-sm" data-api-lock>
      <p className="font-semibold">{t(ia.lock_note, { program: programName })}</p>
      <p>{ia.lock_text}</p>
    </div>
  ) : source?.active === "agent" ? (
    <div className="flex flex-col gap-1 border border-foreground p-3 text-sm" data-agent-lock>
      <p className="font-semibold">{sst.agent_lock_note}</p>
      <p>{sst.agent_lock_text}</p>
    </div>
  ) : null;
  const sourceSummary = !source
    ? ""
    : source.active === "api"
      ? t(sst.summary_api, { program: programName })
      : source.active === "agent" ? sst.summary_agent : sst.summary_file;
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
        {source && (
          <DashboardSection {...m.section("source")} first title={sst.title} summary={sourceSummary}>
            <StockSourcePanel shopId={shop.id} initial={source} programName={apiConn ? programName : null} labels={sst} />
          </DashboardSection>
        )}

        {api && source?.active === "agent" && !apiConn ? (
          <DashboardSection {...m.section("api")} title={ia.title} summary={ia.summary_none}>
            <p className="text-sm" data-api-blocked>
              {sst.api_blocked}
            </p>
          </DashboardSection>
        ) : api && (
          <DashboardSection {...m.section("api")} first={!source} title={ia.title} summary={apiSummary}>
            <InventoryConnect
              key={`${apiConn?.provider ?? ""}:${apiConn?.status ?? ""}:${(apiConn?.fields ?? []).join(",")}:${JSON.stringify(apiConn?.mapping ?? {})}`}
              shopId={shop.id}
              state={api}
              dates={{ connected: apiTime("connected_at"), keyChanged: apiTime("key_changed_at"), lastSuccess: apiTime("last_success_at"), nextRun: apiTime("next_run_at") }}
              planHref={`/${lang}/dashboard/plan?${new URLSearchParams({ shop: shop.slug })}`}
              labels={ia}
              fieldLabels={o as unknown as Record<string, string>}
            />
          </DashboardSection>
        )}

        {pos && (
          <DashboardSection {...m.section("pos")} title={pa.title} summary={posSummary}>
            <PosAgentPanel shopId={shop.id} initial={pos} initialSnapshots={snapshots} lang={lang} timeZone={shop.timezone} labels={pa} />
          </DashboardSection>
        )}

        <DashboardSection {...m.section("export")} first={!api && !source} title={ex.stock_title} summary={summaries.export}>
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
          {apiLock ?? (
            <FolderSync
              shopId={shop.id}
              shopName={shop.name}
              showName={false}
              lang={lang}
              timeZone={shop.timezone}
              loginHref={`/${lang}/login`}
              labels={folderSyncLabels(dict)}
            />
          )}
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

        {/* 2. After a stock file: the review card, the languages, the columns */}
        <DashboardSection
          {...m.section("review")}
          title={ex.review_title}
          summary={review?.needed ? dict.export_review.title : `${columnsSummary(shop, dict)}${settings ? ` · ${t(dict.owner_tr.languages_summary, { main: languageOf(settings.main_lang)?.native ?? settings.main_lang, preferred: settings.preferred_langs.map((c) => languageOf(c)?.native ?? c).join(", ") || dict.owner_tr.none })}` : ""}`}
        >
          {m.notice("review")}
          <p className="text-sm">{ex.review_intro}</p>
          {review === null ? (
            <p className="text-sm text-muted" data-review-unavailable>
              {dict.export_review.unavailable}
            </p>
          ) : review.needed ? (
            <ExportReview
              shopId={shop.id}
              slug={shop.slug}
              review={review}
              languages={all}
              fieldLabels={o as unknown as Record<string, string>}
              labels={dict.export_review}
            />
          ) : (
            <p className="text-sm font-semibold" data-review-done>
              {dict.export_review.nothing}
            </p>
          )}
          {settings && (
            <section className="flex flex-col gap-3 border-t border-line pt-4" aria-labelledby="languages-title">
              <h3 id="languages-title" className="font-semibold">
                {dict.owner_tr.languages_title}
              </h3>
              <LanguagesForm settings={settings} all={all} dict={dict} hidden={() => hiddenField()} />
            </section>
          )}
          <section className="flex flex-col gap-3 border-t border-line pt-4" aria-labelledby="columns-title">
            <h3 id="columns-title" className="font-semibold">
              {o.columns_title}
            </h3>
            <ColumnsForm shop={shop} dict={dict} hidden={hiddenField} />
          </section>
        </DashboardSection>

        {/* 3. The translations folder on this PC (and the same files by hand), the stock files in other languages */}
        <DashboardSection {...m.section("trfolder")} title={ex.folder_title} summary={ex.folder_summary}>
          {m.notice("trfolder")}
          <p className="text-sm">{ex.folder_intro}</p>
          {review === null ? (
            <p className="text-sm text-muted">{dict.export_review.unavailable}</p>
          ) : (
            <TranslationFolderSync shopId={shop.id} slug={shop.slug} lang={lang} timeZone={shop.timezone} loginHref={`/${lang}/login`} labels={ex} />
          )}
          {settings && (
            <section className="flex flex-col gap-3 border-t border-line pt-4" aria-labelledby="files-title" id="files">
              <h3 id="files-title" className="font-semibold">
                {dict.owner_tr.files_title}
              </h3>
              {apiLock ?? (
                <LanguageFileUpload
                  shopId={shop.id}
                  langs={languageList(settings.inventory_langs.filter((c) => c !== settings.main_lang))}
                  mainLabel={languageOf(settings.main_lang)?.native ?? settings.main_lang}
                  labels={dict.owner_tr.files}
                />
              )}
            </section>
          )}
        </DashboardSection>

        {/* 4. The last 10 stock files and "Vymazať všetky nahrané súbory" (the inventory stays). */}
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
