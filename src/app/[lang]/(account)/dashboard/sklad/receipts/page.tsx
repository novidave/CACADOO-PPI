import type { Metadata } from "next";
import Link from "next/link";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { formatDate, formatPrice } from "@/lib/format";
import { formatQty } from "@/lib/sklad";
import { DbError } from "@/components/DbError";
import { btn, first, loadSklad, Notice, SkladShell } from "../parts";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/sklad/receipts">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const s = (await getDictionary(lang)).sklad;
  return { title: `${s.tab_receipts} · ${s.title}` };
}

interface Row {
  id: string;
  number: string;
  status: "draft" | "done";
  supplier: string | null;
  invoice_no: string | null;
  delivered_on: string | null;
  total: number;
  pieces: number;
  line_count: number;
  created_at: string;
  confirmed_at: string | null;
  location: string | null;
}

/** Sklad → Príjemky (database update 69): the drafts first, then the confirmed receipts; "+ Nová príjemka". */
export default async function SkladReceipts({ params, searchParams }: PageProps<"/[lang]/dashboard/sklad/receipts">) {
  const { lang } = await params;
  const sp = await searchParams;
  const ctx = await loadSklad(lang, sp);
  if (!ctx.ok) return <DbError message={ctx.error} dict={ctx.dict} />;
  const { dict, s, session, shop, shops, href } = ctx;
  const [list, src] = await Promise.all([
    session.supabase.rpc("owner_sklad_receipts", { p_shop_id: shop.id, p_limit: 100, p_offset: 0 }),
    session.supabase.rpc("owner_stock_source", { p_shop_id: shop.id }),
  ]);
  if (list.error) return <DbError message={list.error.message} dict={dict} />;
  const rows = (list.data as { rows: Row[] }).rows;
  const money = (n: number) => formatPrice(Number(n), ctx.lang, "EUR");
  return (
    <SkladShell lang={ctx.lang} s={s} dict={dict} shops={shops} shop={shop} current="receipts" source={(src.data as { active?: string } | null)?.active ?? null}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-bold">{s.rc_title}</h2>
        <Link href={href("/receipts/new")} className={btn} data-sklad-rc-new>
          {s.rc_new}
        </Link>
      </div>
      <Notice s={s} ok={first(sp.ok)} err={first(sp.err)} />
      {rows.length === 0 ? (
        <p className="text-muted">{s.rc_list_empty}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={href(`/receipts/${r.id}`)} className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3" data-sklad-rc-row={r.status}>
                <span className="flex flex-col">
                  <strong>
                    {r.number} <span className="font-medium text-muted">· {r.status === "draft" ? s.rc_draft : s.rc_done}</span>
                  </strong>
                  <span className="text-[13px] text-muted">
                    {[r.supplier, r.invoice_no, r.delivered_on ? formatDate(r.delivered_on, ctx.lang, shop.timezone) : null, r.location]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span className="flex flex-col items-end">
                  <strong>
                    {money(r.total)} <span className="text-[13px] font-medium text-muted">{s.rc_net}</span>
                  </strong>
                  <span className="text-[13px] text-muted">
                    {s.rc_lines_count.replace("{n}", String(r.line_count))} · +{formatQty(Number(r.pieces), "ks", ctx.lang)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SkladShell>
  );
}
