import type { ReactNode } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import { t } from "@/i18n/dictionaries";
import { HEALTH_COLORS } from "@/lib/adminOverview";
import { cardClass, fieldClass, ghostClass } from "@/components/owner/ui";
import { SaveBar } from "@/components/owner/SaveBar";
import { deleteWebDomain, saveSearchLayers, saveWebDomains } from "./actions";
import { DotText, saveLabels, tableBox, tdClass, thClass } from "./common";

/** admin_search_settings() (database update 34). */
export interface SearchSettings {
  layers: { layer: "osm" | "google_places" | "web"; enabled: boolean; cost_per_call_usd: number; input_usd_per_mtok: number; output_usd_per_mtok: number }[];
  domains: { domain: string; label: string; search_url: string | null; enabled: boolean; sort_order: number }[];
  usage: { day: string; layer: string; service: string; calls: number; cost_usd: number }[];
  today_calls: number;
  today_cost_usd: number;
}

/** The product-sources function's own switches (admin_status; never a key). */
export interface SourcesEnv {
  web_search_enabled?: boolean;
  google_places_enabled?: boolean;
  google_key_set?: boolean;
  anthropic_key_set?: boolean;
  contact_set?: boolean;
  secret_set?: boolean;
  daily_limit?: number;
}

/**
 * "Vyhľadávanie mimo Cacaduu" (database update 34; artboard 9 since 2026-11-05): "Vrstvy" — a switch per outside layer
 * with the function's environment switch next to it as a dot + words (a layer runs only when both are on) and the
 * estimated prices, one form with the save bar —; "Použitie" — today's calls of the daily limit and the cost, the
 * calls and estimated cost per day and layer —; the allowed web domains with their search addresses (deep links), one
 * form with the save bar ("Odstrániť" per row, a new one in the last row). Every read and write goes through the
 * admin_* functions (is_admin() in SQL).
 */
export function ExternalSearchAdmin({
  settings,
  env,
  websiteSecret,
  dict,
  hidden,
}: {
  settings: SearchSettings | null;
  env: SourcesEnv | null;
  /** Whether EXTERNAL_SEARCH_SECRET is set on the website. */
  websiteSecret: boolean;
  dict: Dictionary;
  hidden: ReactNode;
}) {
  const x = dict.admin_search;
  if (!settings) {
    return (
      <section id="external-search" className={`${cardClass} min-w-0`} aria-labelledby="external-search-heading">
        <h2 id="external-search-heading" className="text-[19px] font-bold">
          {x.layers_title}
        </h2>
        <p className="text-sm text-[#5C5C5C]">{x.unavailable}</p>
      </section>
    );
  }
  /** The function's environment for a layer: [on, words]; null = the function did not answer. */
  const envOf = (layer: string): [boolean, string] | null => {
    if (env === null) return null;
    if (layer === "osm") return env.contact_set ? [true, x.env_on] : [false, x.env_contact];
    if (layer === "google_places") {
      const on = Boolean(env.google_places_enabled && env.google_key_set);
      return [on, on ? x.env_on : t(x.env_off, { name: env.google_places_enabled ? "GOOGLE_PLACES_API_KEY" : "GOOGLE_PLACES_ENABLED" })];
    }
    const on = Boolean(env.web_search_enabled && env.anthropic_key_set);
    return [on, on ? x.env_on : t(x.env_off, { name: env.web_search_enabled ? "ANTHROPIC_API_KEY" : "WEB_SEARCH_ENABLED" })];
  };
  const layerName: Record<string, string> = {
    geocode: x.layer_geocode,
    osm: x.layer_osm,
    google_places: x.layer_google_places,
    web: x.layer_web,
  };
  const usd = (n: number) => Number(n).toFixed(4);
  const small = `${fieldClass} !min-h-11 !w-28 !py-2 text-right !text-[15px] tabular-nums`;
  const priceField = (name: string, label: string, value: number | string) => (
    <label className="flex flex-col gap-1 text-[13px] font-semibold text-[#5C5C5C]">
      {label}
      <input name={name} inputMode="decimal" defaultValue={String(value)} className={small} />
    </label>
  );

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-4">
        <form action={saveSearchLayers} className={`${cardClass} min-w-0 !gap-0`}>
          {hidden}
          <section id="external-search" className="flex min-w-0 scroll-mt-4 flex-col" aria-labelledby="external-search-heading" data-search-layers>
            <h2 id="external-search-heading" className="pb-2 text-[19px] font-bold">
              {x.layers_title}
            </h2>
            {env === null && <p className="pb-2 text-sm font-semibold">{x.env_unknown}</p>}
            {(!websiteSecret || (env && !env.secret_set)) && (
              <p className="pb-2 text-sm font-semibold" data-search-secret>
                {x.env_secret}
              </p>
            )}
            {settings.layers.map((layer) => {
              const e = envOf(layer.layer);
              return (
                <div key={layer.layer} className="flex flex-col gap-2.5 border-t border-[#E4E4E4] py-3" data-layer={layer.layer}>
                  <input type="hidden" name="layers" value={layer.layer} />
                  <div className="flex items-start justify-between gap-3">
                    <span className="flex min-w-0 flex-col gap-1">
                      <strong className="text-[15px]">{layerName[layer.layer]}</strong>
                      <span className="text-[13px]" data-env>
                        <DotText color={e === null ? HEALTH_COLORS.off : e[0] ? HEALTH_COLORS.ok : HEALTH_COLORS.warn}>
                          <span className="font-medium">{e === null ? dict.admin_home.svc_silent : e[1]}</span>
                        </DotText>
                      </span>
                    </span>
                    <input type="checkbox" name={`${layer.layer}:enabled`} aria-label={`${x.enabled}: ${layerName[layer.layer]}`} defaultChecked={layer.enabled} className="ppi-toggle" />
                  </div>
                  <div className="flex flex-wrap gap-2.5">
                    {priceField(`${layer.layer}:cost_per_call`, x.cost_per_call, layer.cost_per_call_usd)}
                    {layer.layer === "web" && (
                      <>
                        {priceField("web:input_per_mtok", x.input_per_mtok, layer.input_usd_per_mtok)}
                        {priceField("web:output_per_mtok", x.output_per_mtok, layer.output_usd_per_mtok)}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </section>
          <SaveBar labels={saveLabels(dict, x.save)} />
        </form>

        <div className={`${cardClass} min-w-0`} data-search-usage-card>
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-[19px] font-bold">{x.usage_title}</h2>
            <strong className="text-[15px]" data-usage-today>
              {t(x.usage_today, { calls: Number(settings.today_calls), limit: env?.daily_limit ?? "?", cost: usd(settings.today_cost_usd) })}
            </strong>
          </div>
          {settings.usage.length === 0 ? (
            <p className="text-sm text-[#5C5C5C]">{x.usage_none}</p>
          ) : (
            <div className={tableBox}>
              <table className="w-full min-w-[30rem] border-collapse text-[15px]" data-search-usage>
                <thead>
                  <tr>
                    {[x.col_day, x.col_layer, x.col_service, x.col_calls, x.col_cost].map((h) => (
                      <th key={h} className={thClass}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {settings.usage.map((u) => (
                    <tr key={`${u.day}-${u.layer}-${u.service}`} data-usage-row={`${u.layer}/${u.service}`}>
                      <td className={`${tdClass} whitespace-nowrap`}>{u.day}</td>
                      <td className={tdClass}>{layerName[u.layer] ?? u.layer}</td>
                      <td className={`${tdClass} font-mono text-[13px]`}>{u.service}</td>
                      <td className={`${tdClass} tabular-nums`}>{u.calls}</td>
                      <td className={`${tdClass} tabular-nums`}>{usd(u.cost_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <form action={saveWebDomains} className={`${cardClass} min-w-0 !gap-0`}>
        {hidden}
        <section id="web-domains" className="flex min-w-0 scroll-mt-4 flex-col" aria-labelledby="web-domains-heading" data-web-domains>
          <h2 id="web-domains-heading" className="text-[19px] font-bold">
            {x.domains_title}
          </h2>
          <p className="pb-3 pt-1 text-sm text-[#5C5C5C]">{x.domains_hint}</p>
          {settings.domains.map((d) => (
            <div key={d.domain} className="flex flex-col gap-2.5 border-t border-[#E4E4E4] py-3" data-web-domain={d.domain}>
              <input type="hidden" name="domains" value={d.domain} />
              <div className="flex items-center justify-between gap-3">
                <strong className="min-w-0 break-all text-[15px]">{d.domain}</strong>
                <span className="flex flex-none items-center gap-2.5">
                  <input type="checkbox" name={`${d.domain}:enabled`} aria-label={`${x.domain_enabled}: ${d.domain}`} defaultChecked={d.enabled} className="ppi-toggle" />
                  <button type="submit" formAction={deleteWebDomain} formNoValidate name="domain" value={d.domain} className={`${ghostClass} !min-h-11 !px-4 !text-[15px]`} data-delete-domain={d.domain}>
                    {x.delete_domain}
                  </button>
                </span>
              </div>
              <div className="grid gap-2.5 sm:grid-cols-[minmax(0,1fr)_6rem]">
                <label className="flex flex-col gap-1 text-[13px] font-semibold text-[#5C5C5C]">
                  {x.label}
                  <input name={`${d.domain}:label`} required defaultValue={d.label} className={`${fieldClass} !min-h-11 !py-2 !text-[15px]`} />
                </label>
                <label className="flex flex-col gap-1 text-[13px] font-semibold text-[#5C5C5C]">
                  {x.sort}
                  <input name={`${d.domain}:sort`} inputMode="numeric" defaultValue={String(d.sort_order)} className={`${fieldClass} !min-h-11 !py-2 text-right !text-[15px]`} />
                </label>
              </div>
              <label className="flex flex-col gap-1 text-[13px] font-semibold text-[#5C5C5C]">
                {x.search_url}
                <input name={`${d.domain}:search_url`} type="url" defaultValue={d.search_url ?? ""} placeholder="https://www.obchod.sk/hladat?q={query}" className={`${fieldClass} !min-h-11 !py-2 font-mono !text-[13px]`} />
              </label>
            </div>
          ))}
          <div className="flex flex-col gap-2.5 border-t border-[#E4E4E4] py-3" data-web-domain="new">
            <strong className="text-[15px]">{x.add_domain}</strong>
            <div className="grid gap-2.5 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-[13px] font-semibold text-[#5C5C5C]">
                {x.domain}
                <input name="new:domain" placeholder={x.domain_example} className={`${fieldClass} !min-h-11 !py-2 !text-[15px]`} />
              </label>
              <label className="flex flex-col gap-1 text-[13px] font-semibold text-[#5C5C5C]">
                {x.label}
                <input name="new:label" className={`${fieldClass} !min-h-11 !py-2 !text-[15px]`} />
              </label>
            </div>
            <label className="flex flex-col gap-1 text-[13px] font-semibold text-[#5C5C5C]">
              {x.search_url}
              <input name="new:search_url" type="url" placeholder="https://www.obchod.sk/hladat?q={query}" className={`${fieldClass} !min-h-11 !py-2 font-mono !text-[13px]`} />
            </label>
          </div>
        </section>
        <SaveBar labels={saveLabels(dict, x.save)} />
      </form>
    </div>
  );
}
