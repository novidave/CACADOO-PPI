import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { formatDateTime, formatPrice } from "@/lib/format";
import { formatQty } from "@/lib/sklad";
import { DbError } from "@/components/DbError";
import { approveCount, cancelCount, countMark, undoCount } from "../../../actions";
import { btn, btnGhost, card, first, loadSklad, Notice, SkladShell, UUID } from "../../../parts";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/sklad/counts/[id]/diff">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const s = (await getDictionary(lang)).sklad;
  return { title: `${s.ic_diff_title} · ${s.title}` };
}

interface DiffRow {
  item_id: string;
  name: string;
  code: string | null;
  unit: string;
  counted: number;
  expected: number;
  diff: number;
  at: string;
  who: string | null;
  recount: boolean;
  value: number | null;
}
interface Diff {
  count: {
    id: string;
    number: string;
    name: string | null;
    status: "open" | "approved" | "cancelled" | "undone";
    shelf: string | null;
    location: string | null;
    started_at: string;
    approved_at: string | null;
    in_scope: number;
    counted: number;
    counters: { counter: string; products: number }[];
    uncounted: { item_id: string; name: string }[];
    result: { fixes: number; pieces: number; value: number } | null;
    can_undo: boolean;
  };
  rows: DiffRow[];
  with_diff: number;
  value: number;
  sales_during: number;
  zero_allowed: boolean;
}

/**
 * "Rozdiely inventúry" (screen "Inventúra – rozdiely"; the owner's screen): the summary, who counted, sales during the
 * count, every product with a difference (V Cacaduu = the stock when it was counted · Napočítané · Rozdiel · its value)
 * with "Prepočítať" / "Prijať napočítané", the products not counted (keep or — a whole location — set to 0) and
 * "Schváliť inventúru". Approved: the result, the XLSX report and "Vrátiť späť" within 24 hours.
 */
export default async function SkladCountDiff({ params, searchParams }: PageProps<"/[lang]/dashboard/sklad/counts/[id]/diff">) {
  const { lang, id } = await params;
  const sp = await searchParams;
  if (!UUID.test(id)) notFound();
  const ctx = await loadSklad(lang, sp);
  if (!ctx.ok) return <DbError message={ctx.error} dict={ctx.dict} />;
  const { dict, s, session, shop, shops, hidden, href } = ctx;
  const { data, error } = await session.supabase.rpc("owner_sklad_count_diff", { p_shop_id: shop.id, p_count_id: id });
  if (error) return <DbError message={error.message} dict={dict} />;
  if (!data) notFound();
  const d = data as Diff;
  const c = d.count;
  const money = (n: number) => `${n > 0 ? "+" : ""}${formatPrice(n, ctx.lang, "EUR")}`;
  const signed = (n: number, unit: string) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${formatQty(Math.abs(n), unit, ctx.lang)}`;
  const rows = d.rows.filter((r) => Number(r.diff) !== 0);
  const waiting = rows.filter((r) => r.recount).length;
  const open = c.status === "open";
  const back = { back: `/counts/${id}/diff`, count_id: id };
  const report = `/api/owner/sklad/export?${new URLSearchParams({ shop: shop.id, kind: "count", count: id, lang: ctx.lang })}`;

  return (
    <SkladShell lang={ctx.lang} s={s} dict={dict} shops={shops} shop={shop} current="counts" source={null}>
      {open && (
        <Link href={href(`/counts/${id}`)} className="font-semibold underline underline-offset-4">
          {s.ic_back}
        </Link>
      )}
      <div className="flex flex-col">
        <h2 className="text-xl font-bold">{s.ic_diff_title}</h2>
        <span className="text-sm text-muted">
          {[c.number, c.name, c.location, c.shelf ? `${s.ic_shelf} ${c.shelf}` : null, formatDateTime(c.started_at, ctx.lang, shop.timezone)].filter(Boolean).join(" · ")}
        </span>
      </div>
      <Notice s={s} ok={first(sp.ok)} err={first(sp.err)} />

      {c.status === "approved" && c.result && (
        <section className={`${card} border-[#1E9E5A]`} data-sklad-count-approved>
          <h3 className="text-lg font-bold">{s.ic_approved_title.replace("{number}", c.number)}</h3>
          <p>
            <strong>
              {s.ic_approved_text
                .replace("{fixes}", String(c.result.fixes))
                .replace("{pieces}", signed(Number(c.result.pieces), "ks"))
                .replace("{value}", money(Number(c.result.value)))}
            </strong>
          </p>
          <p className="text-sm text-muted">{s.ic_approved_note}</p>
          <div className="flex flex-wrap gap-2">
            <a href={report} className={btnGhost}>
              {s.ic_report}
            </a>
            {c.can_undo && (
              <form action={undoCount}>
                {hidden(back)}
                <button type="submit" className={btnGhost}>
                  {s.ic_undo}
                </button>
              </form>
            )}
          </div>
        </section>
      )}
      {c.status === "undone" && <p className="rounded-xl border border-line bg-[#F7F7F7] p-3">{s.ic_undone}</p>}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          [`${c.counted} / ${c.in_scope}`, s.ic_stat_counted],
          [String(d.with_diff), s.ic_stat_diff],
          [String(Math.max(0, c.counted - d.with_diff)), s.ic_stat_same],
          [money(Number(d.value)), s.ic_stat_value],
        ].map(([v, l]) => (
          <div key={l} className="flex flex-col rounded-xl border border-line p-3">
            <strong className="text-xl">{v}</strong>
            <span className="text-[13px] text-muted">{l}</span>
          </div>
        ))}
      </div>
      {c.counters.length > 0 && (
        <p className="text-sm">{s.ic_who.replace("{list}", c.counters.map((x) => `${x.counter} (${x.products})`).join(", "))}</p>
      )}
      {d.sales_during > 0 && <p className="text-sm">{s.ic_sales.replace("{n}", String(d.sales_during))}</p>}

      <section aria-labelledby="ic-rows" className="flex flex-col gap-2">
        <h3 id="ic-rows" className="text-lg font-bold">
          {s.ic_rows}
        </h3>
        {rows.length === 0 && <p className="text-muted">{s.ic_no_diff}</p>}
        {rows.map((r) => {
          const diff = Number(r.diff);
          const chip = r.recount ? [s.ic_waiting, "bg-[#FFF6D6] text-[#6B4E00]"] : diff < 0 ? [s.ic_missing, "bg-[#FDECEA] text-[#9B1C14]"] : [s.ic_surplus, "bg-[#E3F4EA] text-[#146C37]"];
          return (
            <div key={r.item_id} className="flex flex-col gap-2 rounded-xl border border-line p-3" data-sklad-diff-row={r.recount ? "recount" : "accepted"}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex flex-col">
                  <strong>{r.name}</strong>
                  <span className="text-[13px] text-muted">
                    {[r.code, r.who, formatDateTime(r.at, ctx.lang, shop.timezone)].filter(Boolean).join(" · ")}
                  </span>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-[12px] font-semibold ${chip[1]}`}>{chip[0]}</span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="flex flex-col">
                  <span className="text-[12px] text-muted">{s.ic_expected}</span>
                  <strong>{formatQty(Number(r.expected), r.unit, ctx.lang)}</strong>
                </div>
                <div className="flex flex-col">
                  <span className="text-[12px] text-muted">{s.ic_counted_col}</span>
                  <strong>{formatQty(Number(r.counted), r.unit, ctx.lang)}</strong>
                </div>
                <div className="flex flex-col">
                  <span className="text-[12px] text-muted">{s.ic_diff}</span>
                  <strong>{signed(diff, r.unit)}</strong>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-muted">{r.value === null ? "" : s.ic_value.replace("{v}", money(Number(r.value)))}</span>
                {open && (
                  <form action={countMark}>
                    {hidden({ ...back, item_id: r.item_id, recount: r.recount ? "0" : "1" })}
                    <button type="submit" className="min-h-11 font-semibold underline underline-offset-4">
                      {r.recount ? s.ic_accept : s.ic_recount}
                    </button>
                  </form>
                )}
              </div>
            </div>
          );
        })}
      </section>

      {open && (
        <form action={approveCount} className={card} data-sklad-approve>
          {hidden(back)}
          {c.uncounted.length > 0 && (
            <fieldset className="flex flex-col gap-2">
              <legend className="font-bold">{s.ic_uncounted_title.replace("{n}", String(c.uncounted.length))}</legend>
              <span className="text-[13px] text-muted">
                {c.uncounted
                  .slice(0, 12)
                  .map((u) => u.name)
                  .join(" · ")}
                {c.uncounted.length > 12 ? " …" : ""}
              </span>
              <label className="flex min-h-11 items-start gap-2">
                <input type="radio" name="uncounted" value="keep" defaultChecked className="mt-1 size-5 accent-foreground" />
                <span className="flex flex-col">
                  <strong>{s.ic_keep}</strong>
                  <span className="text-[13px] text-muted">{s.ic_keep_hint}</span>
                </span>
              </label>
              <label className="flex min-h-11 items-start gap-2">
                <input type="radio" name="uncounted" value="zero" disabled={!d.zero_allowed} className="mt-1 size-5 accent-foreground" />
                <span className="flex flex-col">
                  <strong>{s.ic_zero}</strong>
                  <span className="text-[13px] text-muted">{s.ic_zero_hint}</span>
                </span>
              </label>
            </fieldset>
          )}
          {waiting > 0 && <span className="text-sm">{s.ic_waiting_note.replace("{n}", String(waiting))}</span>}
          <button type="submit" className={btn}>
            {s.ic_approve}
          </button>
        </form>
      )}
      {open && (
        <form action={cancelCount}>
          {hidden(back)}
          <button type="submit" className="min-h-11 font-semibold underline underline-offset-4">
            {s.ic_cancel}
          </button>
        </form>
      )}
    </SkladShell>
  );
}
