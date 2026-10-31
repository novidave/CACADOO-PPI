import type { Locale } from "@/i18n/config";
import { formatDateTime } from "@/lib/format";
import { t, type Dictionary } from "@/i18n/dictionaries";
import { saveInventorySettings, setInventoryProvider } from "./actions";

/** admin_inventory_overview() (database update 49): never a key or a key hint. */
export interface InventoryOverview {
  plans: { plan: "free" | "pro"; allowed: boolean; interval_minutes: number }[] | null;
  providers: { code: string; built: boolean; enabled: boolean; min_interval_minutes: number; connections: number }[] | null;
  connections: { shop: string; slug: string; timezone: string; provider: string; status: string; last_success_at: string | null; fail_count: number; last_error: string | null }[];
}

/**
 * "Skladové programy (API)" on the admin page: how often the stock is fetched per plan (Free off by default), which
 * programs can be connected (only built ones can be switched on; admin_set_inventory_provider) and the connections
 * — shop, program, state, last sync, last error — without any key.
 */
export function InventoryAdmin({ overview, lang, dict, hidden }: { overview: InventoryOverview | null; lang: Locale; dict: Dictionary; hidden: React.ReactNode }) {
  const a = dict.admin_inventory;
  const ia = dict.inventory_api as Record<string, string>;
  const s = a as Record<string, string>;
  const input = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";
  const plan = (p: "free" | "pro") => overview?.plans?.find((r) => r.plan === p);
  return (
    <section id="inventory" className="flex flex-col gap-3" aria-labelledby="inventory-heading" data-admin-inventory>
      <h2 id="inventory-heading" className="text-lg font-semibold">
        {a.title}
      </h2>
      <p className="text-sm text-muted">{a.intro}</p>
      {!overview ? (
        <p className="text-sm text-muted">{dict.owner_blog.unavailable}</p>
      ) : (
        <>
          <h3 className="font-semibold">{a.settings}</h3>
          <form action={saveInventorySettings} className="flex flex-wrap items-end gap-3 text-sm" data-inventory-settings>
            {hidden}
            <label className="flex flex-col gap-1">
              <span>{a.pro_interval}</span>
              <input name="pro_interval" type="number" min={5} max={10080} required defaultValue={plan("pro")?.interval_minutes ?? 15} className={`${input} w-28`} />
            </label>
            <label className="flex items-center gap-2">
              <input name="free_allowed" type="checkbox" defaultChecked={plan("free")?.allowed ?? false} />
              <span>{a.free_allowed}</span>
            </label>
            <label className="flex flex-col gap-1">
              <span>{a.free_interval}</span>
              <input name="free_interval" type="number" min={5} max={10080} required defaultValue={plan("free")?.interval_minutes ?? 1440} className={`${input} w-28`} />
            </label>
            <button type="submit" className="rounded border border-foreground px-3 py-2 font-medium">
              {a.save}
            </button>
          </form>

          <h3 className="font-semibold">{a.providers}</h3>
          <ul className="flex flex-col gap-2 text-sm">
            {(overview.providers ?? []).map((p) => (
              <li key={p.code} className="flex flex-wrap items-center gap-3 border border-line p-2" data-admin-provider={p.code}>
                <span className="font-medium">{ia[`name_${p.code}`] ?? p.code}</span>
                <span className="text-muted">
                  {p.built ? a.provider_built : a.provider_coming}
                  {p.min_interval_minutes ? ` · ${t(a.provider_min, { minutes: p.min_interval_minutes })}` : ""} · {p.connections}
                </span>
                {p.built && (
                  <form action={setInventoryProvider} className="ml-auto flex items-center gap-2">
                    {hidden}
                    <input type="hidden" name="code" value={p.code} />
                    <input type="hidden" name="enabled" value={p.enabled ? "0" : "1"} />
                    <span>{p.enabled ? a.provider_on : "–"}</span>
                    <button type="submit" className="rounded border border-line px-3 py-1">
                      {p.enabled ? ia.disconnect : ia.connect}
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>

          <h3 className="font-semibold">{a.connections}</h3>
          {overview.connections.length === 0 ? (
            <p className="text-sm">{a.none}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse text-sm">
                <thead>
                  <tr>
                    {[a.col_shop, a.col_program, a.col_status, a.col_last, a.col_error].map((h) => (
                      <th key={h} className="border-b border-line px-2 py-1 text-left font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {overview.connections.map((c) => (
                    <tr key={c.slug}>
                      <td className="border-b border-line px-2 py-1">{c.shop}</td>
                      <td className="border-b border-line px-2 py-1">{ia[`name_${c.provider}`] ?? c.provider}</td>
                      <td className="border-b border-line px-2 py-1">{s[`status_${c.status}`] ?? c.status}</td>
                      <td className="border-b border-line px-2 py-1">{c.last_success_at ? formatDateTime(c.last_success_at, lang, c.timezone) : ia.never}</td>
                      <td className="border-b border-line px-2 py-1 break-all">{c.last_error ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
