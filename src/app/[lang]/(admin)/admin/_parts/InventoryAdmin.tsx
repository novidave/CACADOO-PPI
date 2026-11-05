import type { Locale } from "@/i18n/config";
import { formatDateTime } from "@/lib/format";
import { t, type Dictionary } from "@/i18n/dictionaries";
import { setInventoryProvider } from "./actions";

/** admin_inventory_overview() (database update 49): never a key or a key hint. */
export interface InventoryOverview {
  plans: { plan: "free" | "pro"; allowed: boolean; interval_minutes: number }[] | null;
  providers: { code: string; built: boolean; enabled: boolean; min_interval_minutes: number; connections: number }[] | null;
  connections: { shop: string; slug: string; timezone: string; provider: string; status: string; last_success_at: string | null; fail_count: number; last_error: string | null }[];
}

/**
 * "Skladové programy (API)" (database update 49; since 2026-11-05 its own page): which programs can be connected
 * (only built ones can be switched on; admin_set_inventory_provider) and the connections — shop, program, state, last
 * sync, last error — without any key. The intervals per plan are on Limity plánov (InventoryLimitsAdmin).
 */
export function InventoryAdmin({ overview, lang, dict, hidden, limitsNote }: { overview: InventoryOverview | null; lang: Locale; dict: Dictionary; hidden: React.ReactNode; limitsNote?: React.ReactNode }) {
  const a = dict.admin_inventory;
  const ia = dict.inventory_api as Record<string, string>;
  const s = a as Record<string, string>;
  return (
    <section id="inventory" className="flex flex-col gap-3" aria-labelledby="inventory-heading" data-admin-inventory>
      <h2 id="inventory-heading" className="text-lg font-semibold">
        {a.title}
      </h2>
      <p className="text-sm text-muted">{a.intro}</p>
      {limitsNote}
      {!overview ? (
        <p className="text-sm text-muted">{dict.owner_blog.unavailable}</p>
      ) : (
        <>
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
