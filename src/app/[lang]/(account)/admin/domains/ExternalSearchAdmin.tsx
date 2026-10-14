import type { ReactNode } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import { t } from "@/i18n/dictionaries";
import { PendingButton } from "@/components/PendingButton";
import { deleteWebDomain, saveSearchLayer, saveWebDomain } from "./actions";

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

const input = "rounded border border-line px-2 py-1 outline-none focus:border-foreground";

/**
 * "Vyhľadávanie mimo Cacadoo" on the admin page: a switch per outside layer (with the function's
 * environment switch next to it — a layer runs only when both are on), the estimated prices, the
 * allowed web domains with their search addresses (deep links), and the calls and estimated cost
 * per day and layer. Every read and write goes through the admin_* functions (is_admin() in SQL).
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
      <section id="external-search" className="flex flex-col gap-2" aria-labelledby="external-search-heading">
        <h2 id="external-search-heading" className="text-lg font-semibold">
          {x.title}
        </h2>
        <p className="text-sm text-muted">{x.unavailable}</p>
      </section>
    );
  }
  const envLine = (on: boolean | undefined, name: string) =>
    env === null ? null : on ? x.env_on : t(x.env_off, { name });
  const envOf: Record<string, string | null> = {
    osm: env === null ? null : env.contact_set ? x.env_on : x.env_contact,
    google_places: envLine(env?.google_places_enabled && env?.google_key_set, env?.google_places_enabled ? "GOOGLE_PLACES_API_KEY" : "GOOGLE_PLACES_ENABLED"),
    web: envLine(env?.web_search_enabled && env?.anthropic_key_set, env?.web_search_enabled ? "ANTHROPIC_API_KEY" : "WEB_SEARCH_ENABLED"),
  };
  const layerName: Record<string, string> = {
    geocode: x.layer_geocode,
    osm: x.layer_osm,
    google_places: x.layer_google_places,
    web: x.layer_web,
  };
  const usd = (n: number) => Number(n).toFixed(4);

  return (
    <>
      <section id="external-search" className="flex flex-col gap-3" aria-labelledby="external-search-heading">
        <h2 id="external-search-heading" className="text-lg font-semibold">
          {x.title}
        </h2>
        <p className="max-w-2xl text-sm text-muted">{x.intro}</p>
        {env === null && <p className="text-sm font-semibold">{x.env_unknown}</p>}
        {(!websiteSecret || (env && !env.secret_set)) && <p className="text-sm font-semibold" data-search-secret>{x.env_secret}</p>}
        <div className="flex flex-col gap-2 text-sm" data-search-layers>
          {settings.layers.map((layer) => (
            <form key={layer.layer} action={saveSearchLayer} className="flex flex-wrap items-end gap-3 border-b border-line pb-2" data-layer={layer.layer}>
              {hidden}
              <input type="hidden" name="layer" value={layer.layer} />
              <div className="flex w-64 flex-col gap-1">
                <span className="font-medium">{layerName[layer.layer]}</span>
                {envOf[layer.layer] && (
                  <span className="text-xs text-muted" data-env>
                    {envOf[layer.layer]}
                  </span>
                )}
              </div>
              <label className="flex items-center gap-1 pb-1">
                <input type="checkbox" name="enabled" defaultChecked={layer.enabled} />
                {x.enabled}
              </label>
              <label className="flex flex-col gap-1">
                <span>{x.cost_per_call}</span>
                <input name="cost_per_call" inputMode="decimal" required defaultValue={String(layer.cost_per_call_usd)} className={`${input} w-24`} />
              </label>
              {layer.layer === "web" && (
                <>
                  <label className="flex flex-col gap-1">
                    <span>{x.input_per_mtok}</span>
                    <input name="input_per_mtok" inputMode="decimal" defaultValue={String(layer.input_usd_per_mtok)} className={`${input} w-24`} />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span>{x.output_per_mtok}</span>
                    <input name="output_per_mtok" inputMode="decimal" defaultValue={String(layer.output_usd_per_mtok)} className={`${input} w-24`} />
                  </label>
                </>
              )}
              <PendingButton pending={dict.admin_domains.done}>{x.save}</PendingButton>
            </form>
          ))}
        </div>

        <h3 className="pt-2 font-semibold">{x.usage_title}</h3>
        <p className="text-sm" data-usage-today>
          {t(x.usage_today, { calls: Number(settings.today_calls), limit: env?.daily_limit ?? "?", cost: usd(settings.today_cost_usd) })}
        </p>
        {settings.usage.length === 0 ? (
          <p className="text-sm text-muted">{x.usage_none}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm" data-search-usage>
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  {[x.col_day, x.col_layer, x.col_service, x.col_calls, x.col_cost].map((h) => (
                    <th key={h} className="py-2 pr-3 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {settings.usage.map((u) => (
                  <tr key={`${u.day}-${u.layer}-${u.service}`} className="border-b border-line" data-usage-row={`${u.layer}/${u.service}`}>
                    <td className="py-1 pr-3">{u.day}</td>
                    <td className="py-1 pr-3">{layerName[u.layer] ?? u.layer}</td>
                    <td className="py-1 pr-3 font-mono text-xs">{u.service}</td>
                    <td className="py-1 pr-3">{u.calls}</td>
                    <td className="py-1 pr-3">{usd(u.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section id="web-domains" className="flex flex-col gap-3" aria-labelledby="web-domains-heading">
        <h2 id="web-domains-heading" className="text-lg font-semibold">
          {x.domains_title}
        </h2>
        <p className="max-w-2xl text-sm text-muted">{x.domains_hint}</p>
        <div className="flex flex-col gap-2 text-sm" data-web-domains>
          {[...settings.domains, null].map((d) => (
            <div key={d?.domain ?? "new"} className="flex flex-wrap items-end gap-2 border-b border-line pb-2" data-web-domain={d?.domain ?? "new"}>
              <form action={saveWebDomain} className="flex flex-wrap items-end gap-2">
                {hidden}
                <label className="flex flex-col gap-1">
                  <span>{x.domain}</span>
                  <input name="domain" required defaultValue={d?.domain ?? ""} readOnly={Boolean(d)} placeholder={d ? undefined : "obchod.sk"} className={`${input} w-40`} />
                </label>
                <label className="flex flex-col gap-1">
                  <span>{x.label}</span>
                  <input name="label" required defaultValue={d?.label ?? ""} className={`${input} w-36`} />
                </label>
                <label className="flex flex-col gap-1">
                  <span>{x.search_url}</span>
                  <input name="search_url" type="url" defaultValue={d?.search_url ?? ""} placeholder="https://www.obchod.sk/hladat?q={query}" className={`${input} w-80`} />
                </label>
                <label className="flex flex-col gap-1">
                  <span>{x.sort}</span>
                  <input name="sort" inputMode="numeric" defaultValue={String(d?.sort_order ?? 100)} className={`${input} w-16`} />
                </label>
                <label className="flex items-center gap-1 pb-1">
                  <input type="checkbox" name="enabled" defaultChecked={d ? d.enabled : true} />
                  {x.domain_enabled}
                </label>
                <button type="submit" className="rounded border border-foreground px-3 py-1 font-medium">
                  {d ? x.save : x.add_domain}
                </button>
              </form>
              {d && (
                <form action={deleteWebDomain}>
                  {hidden}
                  <input type="hidden" name="domain" value={d.domain} />
                  <button type="submit" className="px-1 py-1 underline underline-offset-4">
                    {x.delete_domain}
                  </button>
                </form>
              )}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
