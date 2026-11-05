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
import { HEALTH_COLORS, type Health } from "@/lib/adminOverview";
import { adminHref } from "@/lib/adminPages";
import { buttonClass, cardClass, fieldClass, ghostClass } from "@/components/owner/ui";
import { DotText, tableBox, tdClass, thClass } from "./common";
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

const input = `${fieldClass} !min-h-11 !w-auto !py-2 !text-[15px]`;
/** The newest import's dot: done / unchanged = green, still running = yellow, an error = red. */
const IMPORT_HEALTH: Record<string, Health> = { done: "ok", unchanged: "ok", download: "warn", parse: "warn", error: "bad" };
const FORMATS = ["google_xml", "google_csv", "heureka_xml", "csv"];
const LOCAL_FORMATS = ["google_local_xml", "google_local_csv"];
const SCHEDULES = ["hourly", "6h", "daily", "weekly"];

/**
 * "Partnerské feedy" (database update 35; artboard 10 since 2026-11-05): the partner-feeds function's state (a dot +
 * words), then one card per partner — its letter or logo, name, format · schedule · time zone, on / off, the newest
 * import as a dot + words (and its error), the counts, "Údaje z … · Ďalší import …", the links "Posledné importy (n)"
 * and "Predajne (n)" (each opens its own panel above the cards for that partner: ?imports=<id> / ?stores=<id>,
 * #partner-panel, "Zavrieť" goes back), "Importovať teraz" and "Upraviť" (the same forms as before: feed address or file, format, local inventory feed,
 * schedule, affiliate switch, logo, store list, delete). "+ Pridať partnera" in the page's head opens the form
 * (?add=1#partner-new). Reads and writes only through admin_* functions (is_admin() in SQL); feed files go from the
 * browser straight to the private bucket.
 */
export function PartnerFeedsAdmin({
  settings,
  env,
  lang,
  dict,
  hidden,
  adding = false,
  panel = null,
}: {
  settings: PartnerSettings | null;
  env: PartnerEnv | null;
  /** "Posledné importy" / "Predajne (n)" of one partner (?imports=<id> / ?stores=<id>, 2026-11-05): its own panel. */
  panel?: { kind: "imports" | "stores"; id: string } | null;
  /** "+ Pridať partnera" was pressed (?add=1): the form opens. */
  adding?: boolean;
  lang: Locale;
  dict: Dictionary;
  hidden: ReactNode;
}) {
  const x = dict.admin_partners as Record<string, string>;
  if (!settings) {
    return (
      <section id="partner-feeds" className={`${cardClass} min-w-0`} aria-label={x.title}>
        <p className="text-sm text-[#5C5C5C]">{x.unavailable}</p>
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
  const importStatus = (i: AdminPartner["imports"][number]) =>
    i.status === "parse" ? t(x.status_parse, { part: Math.min(i.part_index + 1, Math.max(i.parts, 1)), parts: Math.max(i.parts, 1) }) : x[`status_${i.status}`];
  const chosen = panel ? (settings.partners.find((p) => p.id === panel.id) ?? null) : null;

  const fields = (p: AdminPartner | null) => (
    <>
      <div className="flex flex-wrap items-end gap-3 text-sm font-semibold">
        <label className="flex flex-col gap-1">
          <span>{x.name}</span>
          <input name="name" required maxLength={80} defaultValue={p?.name ?? ""} className={`${input} !w-56`} />
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
          <input name="currency" maxLength={3} defaultValue={p?.currency ?? ""} className={`${input} !w-20 uppercase`} />
        </label>
      </div>
      <p className="text-[13px] text-[#5C5C5C]">{x.currency_hint} {x.csv_hint}</p>
      <label className="flex flex-col gap-1 text-sm font-semibold">
        <span>{x.feed_url}</span>
        <input name="feed_url" type="url" defaultValue={p?.feed_url ?? ""} placeholder="https://" className={`${input} !w-full max-w-2xl`} />
        <span className="text-[13px] font-normal text-[#5C5C5C]">{x.feed_url_hint}</span>
      </label>
      <div className="flex flex-wrap items-end gap-3 text-sm font-semibold">
        <label className="flex flex-col gap-1">
          <span>{x.inventory_url}</span>
          <input name="inventory_url" type="url" defaultValue={p?.inventory_url ?? ""} placeholder="https://" className={`${input} !w-96 max-w-full`} />
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
      <p className="text-[13px] text-[#5C5C5C]">{x.inventory_hint}</p>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <label className="flex min-h-11 items-center gap-3 text-[15px] font-semibold">
          <input type="checkbox" name="affiliate" defaultChecked={p?.affiliate ?? false} className="ppi-toggle" />
          {x.affiliate}
        </label>
        <label className="flex min-h-11 items-center gap-3 text-[15px] font-semibold">
          <input type="checkbox" name="enabled" defaultChecked={p?.enabled ?? true} className="ppi-toggle" />
          {x.enabled}
        </label>
      </div>
    </>
  );

  return (
    <section id="partner-feeds" className="flex scroll-mt-4 flex-col gap-4" aria-label={x.title}>
      <p className="text-[15px]" data-partner-env>
        {env ? (
          <DotText color={HEALTH_COLORS.ok}>
            <span className="font-medium">{t(x.env, { max: env.max_mb ?? "?", ceiling: env.ceiling_mb ?? "?", part: env.part_mb ?? "?" })}</span>
          </DotText>
        ) : (
          <DotText color={HEALTH_COLORS.off}>{x.env_unknown}</DotText>
        )}
      </p>
      {settings.partners.length === 0 && <p className={`${cardClass} text-[15px] text-[#5C5C5C]`}>{x.none}</p>}

      {chosen && panel && (
        <section id="partner-panel" className={`${cardClass} min-w-0 scroll-mt-4`} aria-labelledby="partner-panel-heading" data-partner-panel={panel.kind}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="partner-panel-heading" className="text-[19px] font-bold">
              {t(panel.kind === "imports" ? x.imports_title : x.stores_panel_title, { name: chosen.name, n: panel.kind === "imports" ? chosen.imports.length : chosen.stores.length })}
            </h2>
            <a href={adminHref(lang, "partners", undefined, `partner-${chosen.id}`)} className={`${ghostClass} !min-h-11 !px-4 !text-[15px] no-underline`} data-partner-panel-close>
              {x.panel_close}
            </a>
          </div>
          {panel.kind === "imports" ? (
            chosen.imports.length === 0 ? (
              <p className="text-sm text-[#5C5C5C]">{x.imports_none}</p>
            ) : (
              <ul className="flex flex-col">
                {chosen.imports.map((i) => (
                  <li key={i.id} className="flex flex-col gap-0.5 border-t border-[#E4E4E4] py-2.5 text-[15px]" data-import-status={i.status} data-import-kind={i.kind}>
                    <DotText color={HEALTH_COLORS[IMPORT_HEALTH[i.status] ?? "off"]}>
                      <span className="font-semibold">{t(x.import_row, { when: when(i.started_at, chosen.timezone), kind: x[`kind_${i.kind}`], status: importStatus(i) })}</span>
                    </DotText>
                    {(i.status === "done" || i.rows_read > 0) && (
                      <span className="text-[13px] text-[#5C5C5C]">{t(x.import_rows, { read: i.rows_read, bad: i.rows_bad, kept: i.rows_kept ?? "–" })}</span>
                    )}
                    {i.error && (
                      <span className="text-[13px]" data-import-error={i.error}>
                        <span className="font-semibold">{x[`err_import_${i.error}`] ?? i.error}</span>
                        {i.error_detail && <span className="text-[#5C5C5C]"> ({i.error_detail})</span>}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )
          ) : chosen.stores.length === 0 ? (
            <p className="text-sm text-[#5C5C5C]">{x.stores_none}</p>
          ) : (
            <div className={tableBox}>
              <table className="w-full min-w-[34rem] border-collapse text-[15px]">
                <thead>
                  <tr>
                    <th className={`${thClass} w-28`}>{x.store_code}</th>
                    <th className={thClass}>{x.store_name}</th>
                    <th className={thClass}>{x.store_address}</th>
                  </tr>
                </thead>
                <tbody>
                  {chosen.stores.map((st) => (
                    <tr key={st.code} data-partner-store={st.code}>
                      <td className={`${tdClass} font-mono text-[13px]`}>{st.code}</td>
                      <td className={tdClass}>
                        <strong>{st.name}</strong>
                      </td>
                      <td className={`${tdClass} text-sm`}>{[st.address, [st.postal_code, st.city].filter(Boolean).join(" "), st.country].filter(Boolean).join(", ") || "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        {settings.partners.map((p) => {
          const logo = partnerLogoUrl(base, p.logo_path);
          const latest = p.imports[0];
          const statusOf = importStatus;
          return (
            <section key={p.id} id={`partner-${p.id}`} className={`${cardClass} min-w-0 scroll-mt-4`} aria-label={p.name} data-partner={p.name}>
              <div className="flex items-start gap-3">
                {logo ? (
                  // eslint-disable-next-line @next/next/no-img-element -- the partner's logo straight from storage
                  <img src={logo} alt="" className="size-11 flex-none rounded-xl border border-[#E4E4E4] object-contain p-1 grayscale" />
                ) : (
                  <span aria-hidden="true" className="flex size-11 flex-none items-center justify-center rounded-xl bg-[#111] text-lg font-bold text-white">
                    {p.name.trim().charAt(0).toUpperCase()}
                  </span>
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <strong className="break-words text-base">{p.name}</strong>
                  <span className="text-[13px] text-[#5C5C5C]">
                    {x[`format_${p.feed_format}`]} · {x[`schedule_${p.schedule}`]} · {p.timezone}
                  </span>
                </span>
                <DotText color={p.enabled ? HEALTH_COLORS.ok : HEALTH_COLORS.off}>
                  <span className="text-sm">{p.enabled ? x.on : x.off}</span>
                </DotText>
              </div>
              {(latest || p.affiliate) && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  {latest && (
                    <span data-partner-status={latest.status}>
                      <DotText color={HEALTH_COLORS[IMPORT_HEALTH[latest.status] ?? "off"]}>{statusOf(latest)}</DotText>
                    </span>
                  )}
                  {p.affiliate && <span className="rounded-full border border-[#E4E4E4] px-2.5 py-0.5 text-[13px] font-semibold">{dict.search.partner_affiliate}</span>}
                </div>
              )}
              {latest?.error && (
                <p className="text-sm" data-import-error={latest.error}>
                  <span className="font-semibold">{x[`err_import_${latest.error}`] ?? latest.error}</span>
                  {latest.error_detail && <span className="text-[13px] text-[#5C5C5C]"> ({latest.error_detail})</span>}
                </p>
              )}
              <p className="text-sm">{t(x.stats, { products: p.products, fresh: p.products_fresh, stores: p.stores.length, stock: p.store_stock })}</p>
              <p className="text-sm text-[#5C5C5C]" data-partner-summary>
                {t(x.data_time, { time: when(p.data_time, p.timezone) })}
                {" · "}
                {t(x.next_run, { time: when(p.next_run_at, p.timezone) })}
              </p>
              {!p.feed_url && !p.feed_file_path && <p className="text-sm font-semibold">{x.no_source}</p>}

              <div className="flex flex-wrap gap-2" data-partner-links>
                {p.imports.length > 0 && (
                  <a
                    href={`?${new URLSearchParams({ imports: p.id })}#partner-panel`}
                    className={`${ghostClass} !min-h-11 !px-4 !text-[15px] no-underline aria-[current=true]:!border-[#111] aria-[current=true]:!bg-[#111] aria-[current=true]:!text-white`}
                    aria-current={panel?.kind === "imports" && panel.id === p.id ? "true" : undefined}
                    data-partner-imports-open
                  >
                    {t(x.imports_open, { n: p.imports.length })}
                  </a>
                )}
                <a
                  href={`?${new URLSearchParams({ stores: p.id })}#partner-panel`}
                  className={`${ghostClass} !min-h-11 !px-4 !text-[15px] no-underline aria-[current=true]:!border-[#111] aria-[current=true]:!bg-[#111] aria-[current=true]:!text-white`}
                  aria-current={panel?.kind === "stores" && panel.id === p.id ? "true" : undefined}
                  data-partner-stores-open
                >
                  {t(x.stores_open, { n: p.stores.length })}
                </a>
              </div>

              <div className="flex flex-wrap items-start gap-2.5 border-t border-[#E4E4E4] pt-3">
                <form action={importPartnerNow}>
                  {hidden}
                  <input type="hidden" name="partner_id" value={p.id} />
                  <button type="submit" className={`${buttonClass} !min-h-11 !px-4 !text-[15px]`} data-partner-import>
                    {x.import_now}
                  </button>
                </form>
                <details className="w-full" data-partner-edit>
                  <summary className={`${ghostClass} !min-h-11 w-fit cursor-pointer list-none !px-4 !text-[15px] [&::-webkit-details-marker]:hidden`}>{x.edit}</summary>
                  <div className="flex flex-col gap-4 pt-3">
                    <form action={savePartner} className="flex flex-col gap-3">
                      {hidden}
                      <input type="hidden" name="partner_id" value={p.id} />
                      {fields(p)}
                      <PendingButton pending={dict.admin_domains.done}>{x.save}</PendingButton>
                    </form>

                    <div className="flex flex-wrap gap-6 text-sm">
                      <div className="flex flex-col gap-1">
                        <PartnerFileUpload partnerId={p.id} kind="products" label={x.feed_file} labels={uploadLabels} register={registerPartnerFile} />
                        {p.feed_file_path && <span className="text-[13px] text-[#5C5C5C]">{t(x.file_now, { time: when(p.feed_file_at, p.timezone) })}</span>}
                      </div>
                      <div className="flex flex-col gap-1">
                        <PartnerFileUpload partnerId={p.id} kind="inventory" label={x.inventory_file} labels={uploadLabels} register={registerPartnerFile} />
                        {p.inventory_file_path && <span className="text-[13px] text-[#5C5C5C]">{t(x.file_now, { time: when(p.inventory_file_at, p.timezone) })}</span>}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-end gap-3 text-sm">
                      <form action={uploadPartnerLogo} className="flex flex-wrap items-end gap-2">
                        {hidden}
                        <input type="hidden" name="partner_id" value={p.id} />
                        <label className="flex flex-col gap-1 font-semibold">
                          <span>{x.logo}</span>
                          <input type="file" name="logo" required accept="image/png,image/jpeg,image/webp" className="text-sm font-normal" />
                        </label>
                        <PendingButton pending={dict.admin_domains.done}>{x.logo_save}</PendingButton>
                      </form>
                      {logo && (
                        <form action={removePartnerLogo}>
                          {hidden}
                          <input type="hidden" name="partner_id" value={p.id} />
                          <button type="submit" className="min-h-11 px-1 underline underline-offset-4">
                            {x.logo_remove}
                          </button>
                        </form>
                      )}
                    </div>

                    <form action={savePartnerStores} className="flex flex-col gap-1.5">
                      {hidden}
                      <input type="hidden" name="partner_id" value={p.id} />
                      <label className="flex flex-col gap-1">
                        <span className="text-sm font-semibold">{x.stores_title}</span>
                        <span className="text-[13px] text-[#5C5C5C]">{x.stores_hint}</span>
                        <textarea
                          name="stores"
                          rows={Math.min(Math.max(p.stores.length + 1, 3), 12)}
                          defaultValue={p.stores
                            .map((s) => [s.code, s.name, s.address ?? "", s.city ?? "", s.postal_code ?? "", s.country ?? "", s.lat ?? "", s.lng ?? ""].join(";").replace(/;+$/, ""))
                            .join("\n")}
                          className={`${input} !w-full font-mono !text-[13px]`}
                        />
                      </label>
                      <PendingButton pending={dict.admin_domains.done}>{x.stores_save}</PendingButton>
                    </form>

                    <form action={deletePartner}>
                      {hidden}
                      <input type="hidden" name="partner_id" value={p.id} />
                      <ConfirmButton question={x.delete_confirm} className="min-h-11 px-1 underline underline-offset-4">
                        {x.delete}
                      </ConfirmButton>
                    </form>
                  </div>
                </details>
              </div>
            </section>
          );
        })}
      </div>

      <details className={`${cardClass} min-w-0 scroll-mt-4`} id="partner-new" open={adding || settings.partners.length === 0}>
        <summary className="flex min-h-11 cursor-pointer items-center text-[19px] font-bold">{x.add_title}</summary>
        <form action={savePartner} className="flex flex-col gap-3 pt-2" data-partner-new>
          {hidden}
          {fields(null)}
          <PendingButton pending={dict.admin_domains.done}>{x.add}</PendingButton>
        </form>
      </details>
    </section>
  );
}
