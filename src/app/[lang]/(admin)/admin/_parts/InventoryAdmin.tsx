import type { Locale } from "@/i18n/config";
import { formatDateTime } from "@/lib/format";
import { t, type Dictionary } from "@/i18n/dictionaries";
import { HEALTH_COLORS, type Health } from "@/lib/adminOverview";
import { cardClass } from "@/components/owner/ui";
import { setInventoryProvider } from "./actions";
import { DotText, tableBox, tdClass, thClass } from "./common";

/** admin_inventory_overview() (database update 49): never a key or a key hint. */
export interface InventoryOverview {
  plans: { plan: "free" | "pro"; allowed: boolean; interval_minutes: number }[] | null;
  providers: { code: string; built: boolean; enabled: boolean; min_interval_minutes: number; connections: number }[] | null;
  connections: { shop: string; slug: string; timezone: string; provider: string; status: string; last_success_at: string | null; fail_count: number; last_error: string | null }[];
}

/** A connection's dot: running = green, waiting for the owner's approval = yellow, a bad key or an error = red. */
const STATUS_HEALTH: Record<string, Health> = { active: "ok", preview: "warn", invalid_key: "bad", error: "bad" };

/**
 * "Skladové programy (API)" (database update 49; its own page since 2026-11-05, artboard 11): which programs can be
 * connected — one tile each (built ones can be switched on or off: admin_set_inventory_provider; the rest are
 * "pripravujeme") with the shortest interval and the number of connections — and the connections (shop, program,
 * state as a dot + words, last sync, last error) without any key. The intervals per plan are on Limity plánov (one form
 * with every limit; `limitsNote` links there).
 */
export function InventoryAdmin({ overview, lang, dict, hidden, limitsNote }: { overview: InventoryOverview | null; lang: Locale; dict: Dictionary; hidden: React.ReactNode; limitsNote?: React.ReactNode }) {
  const a = dict.admin_inventory;
  const ia = dict.inventory_api as Record<string, string>;
  const s = a as Record<string, string>;
  const live = overview?.connections.filter((c) => c.status === "active").length ?? 0;
  return (
    <section id="inventory" className="flex flex-col gap-4" aria-label={a.title} data-admin-inventory>
      {limitsNote}
      {!overview ? (
        <p className={`${cardClass} text-sm text-[#5C5C5C]`}>{dict.owner_blog.unavailable}</p>
      ) : (
        <>
          <div className={`${cardClass} min-w-0`}>
            <h2 className="text-[19px] font-bold">{a.providers}</h2>
            <ul className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
              {(overview.providers ?? []).map((p) => (
                <li key={p.code} className="flex flex-col gap-1.5 rounded-[14px] border border-[#E4E4E4] p-3.5" data-admin-provider={p.code}>
                  <span className="flex items-start justify-between gap-2">
                    <strong className="text-base">{ia[`name_${p.code}`] ?? p.code}</strong>
                    <DotText color={!p.built ? HEALTH_COLORS.off : p.enabled ? HEALTH_COLORS.ok : HEALTH_COLORS.off}>
                      <span className="text-sm">{!p.built ? a.provider_coming : p.enabled ? a.provider_enabled : a.provider_disabled}</span>
                    </DotText>
                  </span>
                  <span className="text-[13px] text-[#5C5C5C]">
                    {p.built ? a.provider_built : a.provider_coming}
                    {p.min_interval_minutes ? ` · ${t(a.provider_min, { minutes: p.min_interval_minutes })}` : ""}
                  </span>
                  <span className="text-sm">{p.built ? t(a.provider_connections, { n: p.connections }) : "—"}</span>
                  {p.built && (
                    <form action={setInventoryProvider} className="pt-1">
                      {hidden}
                      <input type="hidden" name="code" value={p.code} />
                      <input type="hidden" name="enabled" value={p.enabled ? "0" : "1"} />
                      {/* a switch (2026-11-05): one tap sends the opposite state; the server answers with the page again */}
                      <button
                        type="submit"
                        role="switch"
                        aria-checked={p.enabled}
                        aria-label={`${ia[`name_${p.code}`] ?? p.code}: ${p.enabled ? a.provider_turn_off : a.provider_turn_on}`}
                        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl px-1 text-left text-[15px] font-semibold"
                        data-provider-toggle={p.code}
                      >
                        <span>{a.provider_switch}</span>
                        <span aria-hidden="true" className={`relative h-8 w-14 flex-none rounded-full transition-colors motion-reduce:transition-none ${p.enabled ? "bg-[#111]" : "bg-[#D6D6D6]"}`}>
                          <span className={`absolute top-1 size-6 rounded-full bg-white transition-[left] motion-reduce:transition-none ${p.enabled ? "left-7" : "left-1"}`} />
                        </span>
                      </button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <div className={`${cardClass} min-w-0`} data-inventory-connections>
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="text-[19px] font-bold">{a.connections}</h2>
              {overview.connections.length > 0 && <span className="text-sm text-[#5C5C5C]">{t(a.connections_count, { n: overview.connections.length, live })}</span>}
            </div>
            {overview.connections.length === 0 ? (
              <p className="text-[15px]">{a.none}</p>
            ) : (
              <div className={tableBox}>
                <table className="w-full min-w-[44rem] border-collapse text-[15px]">
                  <thead>
                    <tr>
                      {[a.col_shop, a.col_program, a.col_status, a.col_last, a.col_error].map((h) => (
                        <th key={h} className={thClass}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {overview.connections.map((c) => (
                      <tr key={`${c.slug}-${c.provider}`} data-connection={c.slug}>
                        <td className={tdClass}>
                          <strong>{c.shop}</strong>
                        </td>
                        <td className={tdClass}>{ia[`name_${c.provider}`] ?? c.provider}</td>
                        <td className={tdClass}>
                          <DotText color={HEALTH_COLORS[STATUS_HEALTH[c.status] ?? "off"]}>
                            <span className="font-medium">{s[`status_${c.status}`] ?? c.status}</span>
                          </DotText>
                        </td>
                        <td className={`${tdClass} text-sm`}>{c.last_success_at ? formatDateTime(c.last_success_at, lang, c.timezone) : ia.never}</td>
                        <td className={`${tdClass} break-all text-sm`}>{c.last_error ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-sm text-[#5C5C5C]">{a.connections_note}</p>
          </div>
        </>
      )}
    </section>
  );
}
