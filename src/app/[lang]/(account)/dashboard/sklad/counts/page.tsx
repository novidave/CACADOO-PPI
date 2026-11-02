import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { formatDateTime, formatPrice } from "@/lib/format";
import { DbError } from "@/components/DbError";
import { startCount } from "../actions";
import { btn, card, first, loadSklad, Notice, SkladShell } from "../parts";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/sklad/counts">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const s = (await getDictionary(lang)).sklad;
  return { title: `${s.tab_counts} · ${s.title}` };
}

interface Row {
  id: string;
  number: string;
  name: string | null;
  status: "open" | "approved" | "cancelled" | "undone";
  shelf: string | null;
  blind: boolean;
  started_at: string;
  approved_at: string | null;
  result: { fixes: number; value: number } | null;
  location: string | null;
  counted: number;
}

const field = "min-h-11 rounded-xl border border-[#D6D6D6] px-3 text-base outline-none focus:border-foreground";

/**
 * Sklad → Inventúra (database update 70; screen "Inventúra (počítač)"): "Nová inventúra" (name, a whole location or
 * one shelf, blind by default), the counts running (continue / differences) and the earlier ones (fixes, value,
 * the XLSX report).
 */
export default async function SkladCounts({ params, searchParams }: PageProps<"/[lang]/dashboard/sklad/counts">) {
  const { lang } = await params;
  const sp = await searchParams;
  const ctx = await loadSklad(lang, sp);
  if (!ctx.ok) return <DbError message={ctx.error} dict={ctx.dict} />;
  const { dict, s, session, shop, shops, hidden, href } = ctx;
  const [list, ov] = await Promise.all([
    session.supabase.rpc("owner_sklad_counts", { p_shop_id: shop.id, p_limit: 50 }),
    session.supabase.rpc("owner_sklad_overview", { p_shop_id: shop.id }),
  ]);
  const error = list.error ?? ov.error;
  if (error) return <DbError message={error.message} dict={dict} />;
  const { rows, shelves } = list.data as { rows: Row[]; shelves: string[] };
  const o = ov.data as { source: string; locations: { id: string; name: string; sale_default: boolean }[] };
  const open = rows.filter((r) => r.status === "open");
  const done = rows.filter((r) => r.status !== "open");
  const statusText = (r: Row) => (s as Record<string, string>)[`ic_status_${r.status}`] ?? r.status;
  const where = (r: Row) => [r.location, r.shelf ? `${s.ic_shelf} ${r.shelf}` : null].filter(Boolean).join(" · ");
  const report = (id: string) => `/api/owner/sklad/export?${new URLSearchParams({ shop: shop.id, kind: "count", count: id, lang: ctx.lang })}`;

  return (
    <SkladShell lang={ctx.lang} s={s} dict={dict} shops={shops} shop={shop} current="counts" source={o.source}>
      <Notice s={s} ok={first(sp.ok)} err={first(sp.err)} />
      <div className="grid gap-4 lg:grid-cols-2">
        <form action={startCount} className={card} aria-labelledby="ic-new">
          {hidden({ count_id: randomUUID(), back: "/counts" })}
          <h2 id="ic-new" className="text-lg font-bold">
            {s.ic_new}
          </h2>
          <label className="flex flex-col gap-1 text-sm font-semibold">
            {s.ic_name}
            <input name="name" maxLength={80} placeholder={s.ic_name_ph} className={field} />
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold">
            {s.ic_location}
            <select name="location_id" defaultValue={o.locations.find((l) => l.sale_default)?.id} className={field}>
              {o.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-semibold">{s.ic_what}</legend>
            <label className="flex min-h-11 items-center gap-2">
              <input type="radio" name="scope" value="location" defaultChecked className="size-5 accent-foreground" />
              {s.ic_scope_location}
            </label>
            <label className="flex min-h-11 items-center gap-2">
              <input type="radio" name="scope" value="shelf" disabled={!shelves.length} className="size-5 accent-foreground" />
              {s.ic_scope_shelf}
            </label>
            {shelves.length ? (
              <label className="flex flex-col gap-1 text-sm font-semibold">
                {s.ic_shelf}
                <select name="shelf" className={field}>
                  {shelves.sort().map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <span className="text-[13px] text-muted">{s.ic_no_shelves}</span>
            )}
          </fieldset>
          <label className="flex min-h-12 items-center justify-between gap-3">
            <span className="flex flex-col">
              <strong className="text-[15px]">{s.ic_blind}</strong>
              <span className="text-[13px] text-muted">{s.ic_blind_hint}</span>
            </span>
            <input type="checkbox" role="switch" name="blind" defaultChecked className="h-[26px] w-11 flex-none accent-foreground" />
          </label>
          <p className="text-[13px] text-muted">{s.ic_open_note}</p>
          <p className="text-[13px] text-muted">{s.ic_phones_note}</p>
          <button type="submit" className={btn} data-sklad-count-start>
            {s.ic_start}
          </button>
        </form>

        <div className="flex flex-col gap-4">
          {open.map((r) => (
            <section key={r.id} className={card} aria-label={`${s.ic_running}: ${r.number}`} data-sklad-count-open>
              <div className="flex flex-col">
                <h2 className="text-lg font-bold">
                  {s.ic_running}: {r.number}
                  {r.name ? ` · ${r.name}` : ""}
                </h2>
                <span className="text-sm text-muted">
                  {where(r)} · {r.blind ? s.ic_blind : ""} · {formatDateTime(r.started_at, ctx.lang, shop.timezone)}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Link href={href(`/counts/${r.id}`)} className={btn}>
                  {s.ic_continue}
                </Link>
                <Link href={href(`/counts/${r.id}/diff`)} className="inline-flex min-h-12 items-center justify-center rounded-xl border border-[#D6D6D6] px-3 text-center font-bold">
                  {s.ic_show_diff}
                </Link>
              </div>
            </section>
          ))}
          <section className={card} aria-labelledby="ic-hist">
            <h2 id="ic-hist" className="text-lg font-bold">
              {s.ic_history}
            </h2>
            {done.length === 0 ? (
              <p className="text-sm text-muted">{s.ic_none}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {done.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <Link href={href(`/counts/${r.id}/diff`)} className="flex flex-col">
                      <strong>
                        {r.number} <span className="font-medium text-muted">· {statusText(r)}</span>
                      </strong>
                      <span className="text-[13px] text-muted">
                        {where(r)} · {formatDateTime(r.approved_at ?? r.started_at, ctx.lang, shop.timezone)}
                      </span>
                    </Link>
                    <span className="flex items-center gap-3 text-sm">
                      {r.result && (
                        <span>
                          {s.ic_fixes.replace("{n}", String(r.result.fixes))} · {formatPrice(Number(r.result.value), ctx.lang, "EUR")}
                        </span>
                      )}
                      <a href={report(r.id)} className="min-h-11 content-center font-semibold underline underline-offset-4">
                        {s.ic_report}
                      </a>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </SkladShell>
  );
}
