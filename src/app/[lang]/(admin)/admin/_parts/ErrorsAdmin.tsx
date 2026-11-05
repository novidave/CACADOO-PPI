import { t, type Dictionary } from "@/i18n/dictionaries";
import type { Locale } from "@/i18n/config";
import { formatDateTime } from "@/lib/format";
import { errorPlace } from "@/lib/adminOverview";
import { cardClass } from "@/components/owner/ui";
import { tableBox, tdClass, thClass } from "./common";

export interface ServerErrorRow {
  kind: string;
  route: string;
  message: string;
  digest: string | null;
  hits: number;
  first_at: string;
  last_at: string;
}

/**
 * "Chyby za posledných 7 dní" (database update 42; artboard 3 since 2026-11-05): the website's server errors, grouped —
 * Kde (a friendly name of the place — errorPlace() in @/lib/adminOverview, e.g. "Stránka obchodu" — with the route's
 * file path and its kind under it), Čo (a cleaned message and its code), Počet, Naposledy (and the first time).
 * No visitor data is stored (src/lib/errorLog.ts); only the admin reads them (admin_server_errors() checks
 * is_admin()). null = update 42 not run yet. The table scrolls inside its own box on a narrow screen.
 */
export function ErrorsAdmin({ rows, lang, dict }: { rows: ServerErrorRow[] | null; lang: string; dict: Dictionary }) {
  const a = dict.admin_errors;
  const when = (iso: string) => formatDateTime(iso, lang as Locale, "UTC");
  const places = Object.fromEntries(Object.entries(a).filter(([k]) => k.startsWith("place_")).map(([k, v]) => [k.slice(6), v])) as Record<string, string>;
  return (
    <section id="errors" className={`${cardClass} min-w-0`} aria-label={a.title} data-admin-errors>
      {rows === null ? (
        <p className="text-[15px] text-[#5C5C5C]">{a.unavailable}</p>
      ) : rows.length === 0 ? (
        <p className="text-base font-semibold" data-errors-none>
          {a.none}
        </p>
      ) : (
        <div className={tableBox}>
          <table className="w-full min-w-[46rem] border-collapse text-[15px]">
            <thead>
              <tr>
                <th className={`${thClass} w-[28%]`}>{a.where}</th>
                <th className={thClass}>{a.what}</th>
                <th className={`${thClass} w-20`}>{a.count}</th>
                <th className={`${thClass} w-44`}>{a.last}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} data-error-row>
                  <td className={tdClass}>
                    <span className="flex flex-col gap-0.5" data-error-place={errorPlace(r.route, r.kind)}>
                      <strong className="text-[15px]">{places[errorPlace(r.route, r.kind)] ?? a.place_other}</strong>
                      <span className="break-all font-mono text-[13px] text-[#5C5C5C]">
                        {r.route} · {r.kind}
                      </span>
                    </span>
                  </td>
                  <td className={tdClass}>
                    <span className="flex flex-col gap-0.5">
                      <span className="break-words font-mono text-[13px]">{r.message}</span>
                      {r.digest && <span className="text-[13px] text-[#5C5C5C]">{t(a.digest, { digest: r.digest })}</span>}
                    </span>
                  </td>
                  <td className={tdClass}>
                    <strong className="text-base">{r.hits}</strong>
                  </td>
                  <td className={tdClass}>
                    <span className="flex flex-col gap-0.5 text-sm">
                      <span>{when(r.last_at)}</span>
                      <span className="text-[13px] text-[#5C5C5C]">{t(a.first, { when: when(r.first_at) })}</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-sm text-[#5C5C5C]">{a.intro}</p>
    </section>
  );
}
