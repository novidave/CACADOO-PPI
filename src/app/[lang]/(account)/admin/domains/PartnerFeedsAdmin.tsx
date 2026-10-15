import type { ReactNode } from "react";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/dictionaries";
import { t } from "@/i18n/dictionaries";
import { formatDateTime } from "@/lib/format";
import { partnerLogoUrl } from "@/lib/partners";
import { supabaseEnv } from "@/lib/supabase/env";
import { europeanTimeZones } from "@/lib/timezones";
import { ConfirmButton } from "@/components/ConfirmButton";
import { PartnerFileUpload } from "@/components/PartnerFileUpload";
import { PendingButton } from "@/components/PendingButton";
import {
  deletePartner,
  importPartnerNow,
  removePartnerLogo,
  savePartner,
  savePartnerStores,
  uploadPartnerLogo,
  registerPartnerFile,
} from "./partnerActions";

/** admin_partner_settings() (database update 35). */
export interface PartnerSettings {
  partners: AdminPartner[];
}

interface AdminPartner {
  id: string;
  name: string;
  logo_path: string | null;
  feed_url: string | null;
  feed_file_path: string | null;
  feed_file_at: string | null;
  feed_format: string;
  inventory_url: string | null;
  inventory_file_path: string | null;
  inventory_file_at: string | null;
  inventory_format: string | null;
  currency: string | null;
  timezone: string;
  schedule: string;
  affiliate: boolean;
  enabled: boolean;
  next_run_at: string;
  products: number;
  products_fresh: number;
  data_time: string | null;
  store_stock: number;
  stores: { code: string; name: string; address: string | null; city: string | null; postal_code: string | null; country: string | null; lat: number | null; lng: number | null }[];
  imports: {
    id: string;
    kind: "products" | "inventory";
    status: "download" | "parse" | "done" | "unchanged" | "error";
    error: string | null;
    error_detail: string | null;
    feed_time: string | null;
    parts: number;
    part_index: number;
    rows_read: number;
    rows_bad: number;
    rows_kept: number | null;
    started_at: string;
  }[];
}

/** The partner-feeds function's settings (admin_status; never a key). */
export interface PartnerEnv {
  max_mb?: number;
  ceiling_mb?: number;
  part_mb?: number;
}

const input = "rounded border border-line px-2 py-1 outline-none focus:border-foreground";
const FORMATS = ["google_xml", "google_csv", "heureka_xml", "csv"];
const LOCAL_FORMATS = ["google_local_xml", "google_local_csv"];
const SCHEDULES = ["hourly", "6h", "daily", "weekly"];

/**
 * "Partnerské feedy" on the admin page: every partner with its feed (an https address or an
 * uploaded file), format, local inventory feed, schedule, affiliate switch, logo and store list,
 * the counts and the last imports, "Importovať teraz". Reads and writes only through admin_*
 * functions (is_admin() in SQL); feed files go from the browser straight to the private bucket.
 */
export function PartnerFeedsAdmin({
  settings,
  env,
  lang,
  dict,
  hidden,
}: {
  settings: PartnerSettings | null;
  env: PartnerEnv | null;
  lang: Locale;
  dict: Dictionary;
  hidden: ReactNode;
}) {
  const x = dict.admin_partners as Record<string, string>;
  const heading = (
    <h2 id="partner-feeds-heading" className="text-lg font-semibold">
      {x.title}
    </h2>
  );
  if (!settings) {
    return (
      <section id="partner-feeds" className="flex flex-col gap-2" aria-labelledby="partner-feeds-heading">
        {heading}
        <p className="text-sm text-muted">{x.unavailable}</p>
      </section>
    );
  }
  const zones = europeanTimeZones();
  const base = supabaseEnv()?.url ?? "";
  const uploadLabels = {
    uploading: x.uploading,
    failed: x.upload_failed,
    errors: Object.fromEntries(Object.entries(x).filter(([k]) => k.startsWith("err_")).map(([k, v]) => [`partner_${k.slice(4)}`, v])),
  };
  const when = (iso: string | null, tz: string) => (iso ? formatDateTime(iso, lang, tz) : "–");

  const fields = (p: AdminPartner | null) => (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span>{x.name}</span>
          <input name="name" required maxLength={80} defaultValue={p?.name ?? ""} className={`${input} w-56`} />
        </label>
        <label className="flex flex-col gap-1">
          <span>{x.format}</span>
          <select name="feed_format" required defaultValue={p?.feed_format ?? "google_xml"} className={`${input} bg-white`}>
            {FORMATS.map((f) => (
              <option key={f} value={f}>
                {x[`format_${f}`]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{x.schedule}</span>
          <select name="schedule" defaultValue={p?.schedule ?? "daily"} className={`${input} bg-white`}>
            {SCHEDULES.map((s) => (
              <option key={s} value={s}>
                {x[`schedule_${s}`]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{x.timezone}</span>
          <select name="timezone" required defaultValue={p?.timezone ?? ""} className={`${input} bg-white`}>
            <option value="">{x.timezone_pick}</option>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{x.currency}</span>
          <input name="currency" maxLength={3} defaultValue={p?.currency ?? ""} className={`${input} w-20 uppercase`} />
        </label>
      </div>
      <p className="text-xs text-muted">{x.currency_hint} {x.csv_hint}</p>
      <label className="flex flex-col gap-1">
        <span>{x.feed_url}</span>
        <input name="feed_url" type="url" defaultValue={p?.feed_url ?? ""} placeholder="https://" className={`${input} w-full max-w-2xl`} />
        <span className="text-xs text-muted">{x.feed_url_hint}</span>
      </label>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span>{x.inventory_url}</span>
          <input name="inventory_url" type="url" defaultValue={p?.inventory_url ?? ""} placeholder="https://" className={`${input} w-96 max-w-full`} />
        </label>
        <label className="flex flex-col gap-1">
          <span>{x.inventory_format}</span>
          <select name="inventory_format" defaultValue={p?.inventory_format ?? "google_local_xml"} className={`${input} bg-white`}>
            {LOCAL_FORMATS.map((f) => (
              <option key={f} value={f}>
                {x[`format_${f}`]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-xs text-muted">{x.inventory_hint}</p>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-1">
          <input type="checkbox" name="affiliate" defaultChecked={p?.affiliate ?? false} />
          {x.affiliate}
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" name="enabled" defaultChecked={p?.enabled ?? true} />
          {x.enabled}
        </label>
      </div>
    </>
  );

  return (
    <section id="partner-feeds" className="flex flex-col gap-3" aria-labelledby="partner-feeds-heading">
      {heading}
      <p className="max-w-2xl text-sm text-muted">{x.intro}</p>
      <p className="text-sm" data-partner-env>
        {env
          ? t(x.env, { max: env.max_mb ?? "?", ceiling: env.ceiling_mb ?? "?", part: env.part_mb ?? "?" })
          : <span className="font-semibold">{x.env_unknown}</span>}
      </p>
      {settings.partners.length === 0 && <p className="text-sm text-muted">{x.none}</p>}

      {settings.partners.map((p) => {
        const logo = partnerLogoUrl(base, p.logo_path);
        const latest = p.imports[0];
        const statusOf = (i: AdminPartner["imports"][number]) =>
          i.status === "parse" ? t(x.status_parse, { part: Math.min(i.part_index + 1, Math.max(i.parts, 1)), parts: Math.max(i.parts, 1) }) : x[`status_${i.status}`];
        return (
          <details key={p.id} id={`partner-${p.id}`} className="border-b border-line pb-3 text-sm" data-partner={p.name}>
            <summary className="cursor-pointer py-2">
              <span className="font-semibold">{p.name}</span>
              <span className="text-muted">
                {" · "}
                {x[`format_${p.feed_format}`]}
                {" · "}
                {t(x.stats, { products: p.products, fresh: p.products_fresh, stores: p.stores.length, stock: p.store_stock })}
                {latest && (
                  <>
                    {" · "}
                    <span data-partner-status={latest.status}>{statusOf(latest)}</span>
                  </>
                )}
                {!p.enabled && ` · ${x.enabled}: –`}
              </span>
            </summary>
            <div className="flex flex-col gap-4 pt-2">
              <p data-partner-summary>
                {t(x.data_time, { time: when(p.data_time, p.timezone) })}
                {" · "}
                {t(x.next_run, { time: when(p.next_run_at, p.timezone) })}
                {p.affiliate && ` · ${dict.search.partner_affiliate}`}
              </p>
              {!p.feed_url && !p.feed_file_path && <p className="font-semibold">{x.no_source}</p>}

              <form action={savePartner} className="flex flex-col gap-3">
                {hidden}
                <input type="hidden" name="partner_id" value={p.id} />
                {fields(p)}
                <PendingButton pending={dict.admin_domains.done}>{x.save}</PendingButton>
              </form>

              <div className="flex flex-wrap gap-6">
                <div className="flex flex-col gap-1">
                  <PartnerFileUpload partnerId={p.id} kind="products" label={x.feed_file} labels={uploadLabels} register={registerPartnerFile} />
                  {p.feed_file_path && <span className="text-xs text-muted">{t(x.file_now, { time: when(p.feed_file_at, p.timezone) })}</span>}
                </div>
                <div className="flex flex-col gap-1">
                  <PartnerFileUpload partnerId={p.id} kind="inventory" label={x.inventory_file} labels={uploadLabels} register={registerPartnerFile} />
                  {p.inventory_file_path && <span className="text-xs text-muted">{t(x.file_now, { time: when(p.inventory_file_at, p.timezone) })}</span>}
                </div>
              </div>

              <div className="flex flex-wrap items-end gap-3">
                {logo && (
                  // eslint-disable-next-line @next/next/no-img-element -- the partner's logo straight from storage
                  <img src={logo} alt="" className="h-8 w-auto grayscale" />
                )}
                <form action={uploadPartnerLogo} className="flex flex-wrap items-end gap-2">
                  {hidden}
                  <input type="hidden" name="partner_id" value={p.id} />
                  <label className="flex flex-col gap-1">
                    <span>{x.logo}</span>
                    <input type="file" name="logo" required accept="image/png,image/jpeg,image/webp" className="text-sm" />
                  </label>
                  <PendingButton pending={dict.admin_domains.done}>{x.logo_save}</PendingButton>
                </form>
                {logo && (
                  <form action={removePartnerLogo}>
                    {hidden}
                    <input type="hidden" name="partner_id" value={p.id} />
                    <button type="submit" className="px-1 py-2 underline underline-offset-4">
                      {x.logo_remove}
                    </button>
                  </form>
                )}
              </div>

              <form action={savePartnerStores} className="flex flex-col gap-1">
                {hidden}
                <input type="hidden" name="partner_id" value={p.id} />
                <label className="flex flex-col gap-1">
                  <span className="font-medium">{x.stores_title}</span>
                  <span className="text-xs text-muted">{x.stores_hint}</span>
                  <textarea
                    name="stores"
                    rows={Math.min(Math.max(p.stores.length + 1, 3), 12)}
                    defaultValue={p.stores
                      .map((s) => [s.code, s.name, s.address ?? "", s.city ?? "", s.postal_code ?? "", s.country ?? "", s.lat ?? "", s.lng ?? ""].join(";").replace(/;+$/, ""))
                      .join("\n")}
                    className={`${input} w-full max-w-2xl font-mono text-xs`}
                  />
                </label>
                <PendingButton pending={dict.admin_domains.done}>{x.stores_save}</PendingButton>
              </form>

              {p.imports.length > 0 && (
                <div className="flex flex-col gap-1" data-partner-imports>
                  <h3 className="font-medium">{x.imports}</h3>
                  <ul className="flex flex-col gap-1">
                    {p.imports.map((i) => (
                      <li key={i.id} data-import-status={i.status} data-import-kind={i.kind}>
                        {t(x.import_row, { when: when(i.started_at, p.timezone), kind: x[`kind_${i.kind}`], status: statusOf(i) })}
                        {(i.status === "done" || i.rows_read > 0) && (
                          <span className="text-muted"> · {t(x.import_rows, { read: i.rows_read, bad: i.rows_bad, kept: i.rows_kept ?? "–" })}</span>
                        )}
                        {i.error && (
                          <span className="block" data-import-error={i.error}>
                            <span className="font-semibold">{x[`err_import_${i.error}`] ?? i.error}</span>
                            {i.error_detail && <span className="text-xs text-muted"> ({i.error_detail})</span>}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex flex-wrap gap-4">
                <form action={importPartnerNow}>
                  {hidden}
                  <input type="hidden" name="partner_id" value={p.id} />
                  <PendingButton pending={dict.admin_domains.done}>{x.import_now}</PendingButton>
                </form>
                <form action={deletePartner}>
                  {hidden}
                  <input type="hidden" name="partner_id" value={p.id} />
                  <ConfirmButton question={x.delete_confirm} className="px-1 py-2 underline underline-offset-4">
                    {x.delete}
                  </ConfirmButton>
                </form>
              </div>
            </div>
          </details>
        );
      })}

      <details className="text-sm" id="partner-new" open={settings.partners.length === 0}>
        <summary className="cursor-pointer py-2 font-semibold">{x.add_title}</summary>
        <form action={savePartner} className="flex flex-col gap-3 pt-2" data-partner-new>
          {hidden}
          {fields(null)}
          <PendingButton pending={dict.admin_domains.done}>{x.add}</PendingButton>
        </form>
      </details>
    </section>
  );
}
