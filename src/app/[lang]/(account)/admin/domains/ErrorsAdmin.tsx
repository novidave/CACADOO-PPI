import { t, type Dictionary } from "@/i18n/dictionaries";
import type { Locale } from "@/i18n/config";
import { formatDateTime } from "@/lib/format";

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
 * "Chyby za posledných 7 dní" (database update 42): the website's server errors, grouped — where (the route's file
 * path), what (a cleaned message), how often and when. No visitor data is stored (src/lib/errorLog.ts); only the
 * admin reads them (admin_server_errors() checks is_admin()). null = update 42 not run yet.
 */
export function ErrorsAdmin({ rows, lang, dict }: { rows: ServerErrorRow[] | null; lang: string; dict: Dictionary }) {
  const a = dict.admin_errors;
  const when = (iso: string) => formatDateTime(iso, lang as Locale, "UTC");
  return (
    <section id="errors" className="flex flex-col gap-3" aria-labelledby="errors-heading" data-admin-errors>
      <h2 id="errors-heading" className="text-lg font-semibold">
        {a.title}
      </h2>
      <p className="text-sm text-muted">{a.intro}</p>
      {rows === null ? (
        <p className="text-sm text-muted">{a.unavailable}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm font-medium">{a.none}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th className="py-2 pr-3 font-medium">{a.where}</th>
                <th className="py-2 pr-3 font-medium">{a.what}</th>
                <th className="py-2 pr-3 font-medium">{a.count}</th>
                <th className="py-2 pr-3 font-medium">{a.last}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-line align-top">
                  <td className="py-2 pr-3">
                    <span className="font-mono text-xs">{r.route}</span>
                    <span className="block text-xs text-muted">{r.kind}</span>
                  </td>
                  <td className="max-w-md break-words py-2 pr-3 text-xs">
                    {r.message}
                    {r.digest && <span className="block font-mono text-muted">{t(a.digest, { digest: r.digest })}</span>}
                  </td>
                  <td className="py-2 pr-3 font-semibold">{r.hits}</td>
                  <td className="py-2 pr-3 text-xs">
                    {when(r.last_at)}
                    <span className="block text-muted">{t(a.first, { when: when(r.first_at) })}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
