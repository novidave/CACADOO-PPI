import type { Metadata } from "next";
import Link from "next/link";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { formatDateTime, formatPrice } from "@/lib/format";
import { isKind, signedQty, SKLAD_KINDS, type MovementRow } from "@/lib/sklad";
import { DbError } from "@/components/DbError";
import { btn, btnGhost, first, loadSklad, SkladShell, UUID } from "../parts";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/sklad/movements">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const s = (await getDictionary(lang)).sklad;
  return { title: `${s.tab_movements} · ${s.title}` };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PAGE = 100;
const input = "min-h-11 rounded-xl border border-[#D6D6D6] bg-white px-3 text-[15px]";

/**
 * Sklad → Pohyby: every movement, newest first, filtered by product (from its card), kind, location and the shop's
 * days; "Stiahnuť (XLSX)" with the same filters. Movements are never changed or deleted — a mistake is an "Oprava".
 */
export default async function SkladMovements({ params, searchParams }: PageProps<"/[lang]/dashboard/sklad/movements">) {
  const { lang } = await params;
  const sp = await searchParams;
  const ctx = await loadSklad(lang, sp);
  if (!ctx.ok) return <DbError message={ctx.error} dict={ctx.dict} />;
  const { dict, s, session, shop, shops, href } = ctx;
  const item = UUID.test(first(sp.item) ?? "") ? first(sp.item)! : "";
  const kind = isKind(first(sp.kind)) ? first(sp.kind)! : "";
  const location = UUID.test(first(sp.loc) ?? "") ? first(sp.loc)! : "";
  const from = DAY.test(first(sp.from) ?? "") ? first(sp.from)! : "";
  const to = DAY.test(first(sp.to) ?? "") ? first(sp.to)! : "";
  const offset = Math.max(0, Math.floor(Number(first(sp.page)) || 0)) * PAGE;
  const [list, overview, source] = await Promise.all([
    session.supabase.rpc("owner_sklad_movements", {
      p_shop_id: shop.id,
      p_item_id: item || null,
      p_kind: kind || null,
      p_location_id: location || null,
      p_from: from || null,
      p_to: to || null,
      p_limit: PAGE,
      p_offset: offset,
    }),
    session.supabase.rpc("owner_sklad_overview", { p_shop_id: shop.id }),
    session.supabase.rpc("owner_stock_source", { p_shop_id: shop.id }),
  ]);
  if (list.error) return <DbError message={list.error.message} dict={dict} />;
  const res = list.data as { total: number; rows: MovementRow[] };
  const locations = ((overview.data as { locations?: { id: string; name: string }[] } | null)?.locations ?? []);
  const kindText = (k: string) => (s as Record<string, string>)[`kind_${k}`] ?? k;
  const filters = { ...(item ? { item } : {}), ...(kind ? { kind } : {}), ...(location ? { loc: location } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const exportHref = `/api/owner/sklad/export?${new URLSearchParams({ shop: shop.id, kind: "movements", lang: ctx.lang, ...(item ? { item } : {}), ...(kind ? { mkind: kind } : {}), ...(location ? { loc: location } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) })}`;
  const pageNo = offset / PAGE;

  return (
    <SkladShell lang={ctx.lang} s={s} dict={dict} shops={shops} shop={shop} current="movements" source={(source.data as { active?: string } | null)?.active ?? null}>
      <form method="get" action={`/${ctx.lang}/dashboard/sklad/movements`} className="flex flex-wrap items-end gap-2" data-sklad-mv-filter>
        <input type="hidden" name="shop" value={shop.slug} />
        {item && <input type="hidden" name="item" value={item} />}
        <label className="flex flex-col gap-1 text-sm">
          {s.mv_kind}
          <select name="kind" defaultValue={kind} className={input}>
            <option value="">{s.mv_all}</option>
            {SKLAD_KINDS.map((k) => (
              <option key={k} value={k}>
                {kindText(k)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {s.mv_location}
          <select name="loc" defaultValue={location} className={input}>
            <option value="">{s.mv_all}</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {s.mv_from}
          <input type="date" name="from" defaultValue={from} className={input} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {s.mv_to}
          <input type="date" name="to" defaultValue={to} className={input} />
        </label>
        <button type="submit" className={`${btn} min-h-11`}>
          {s.mv_show}
        </button>
        <a href={exportHref} className={`${btnGhost} min-h-11`} data-sklad-export="movements">
          {s.export_movements}
        </a>
      </form>
      {item && (
        <p className="text-sm">
          {s.mv_one_product}{" "}
          <Link href={href("/movements", { ...filters, item: "" })} className="underline underline-offset-4">
            {s.mv_all_products}
          </Link>
        </p>
      )}
      <p className="text-sm text-muted">{s.mv_total.replace("{n}", String(res.total))}</p>

      {res.rows.length === 0 ? (
        <p className="py-6 text-center text-[15px] text-muted">{s.movements_none}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-foreground">
                <th className="py-2 pr-3 font-semibold">{s.mv_time}</th>
                <th className="py-2 pr-3 font-semibold">{s.mv_product}</th>
                <th className="py-2 pr-3 font-semibold">{s.mv_kind}</th>
                <th className="py-2 pr-3 text-right font-semibold">{s.mv_qty}</th>
                <th className="py-2 pr-3 font-semibold">{s.mv_location}</th>
                <th className="py-2 font-semibold">{s.mv_note}</th>
              </tr>
            </thead>
            <tbody>
              {res.rows.map((m) => (
                <tr key={m.id} className="border-b border-line align-top" data-sklad-mv={m.kind}>
                  <td className="whitespace-nowrap py-2 pr-3">{formatDateTime(m.created_at, ctx.lang, shop.timezone)}</td>
                  <td className="py-2 pr-3">
                    <Link href={href(`/products/${m.item_id}`)} className="underline underline-offset-4">
                      {m.item_name}
                    </Link>
                    <span className="block text-[13px] text-muted">{m.code}</span>
                  </td>
                  <td className="py-2 pr-3">{kindText(m.kind)}</td>
                  <td className="py-2 pr-3 text-right font-bold">{signedQty(m.kind, m.qty, ctx.lang)}</td>
                  <td className="py-2 pr-3">{m.kind === "transfer" ? `${m.location} → ${m.to_location}` : m.location}</td>
                  <td className="py-2 text-muted">
                    {[m.ref, m.reason, m.unit_cost !== null ? formatPrice(m.unit_cost, ctx.lang, "EUR") : "", m.device_label].filter(Boolean).join(" · ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(pageNo > 0 || offset + PAGE < res.total) && (
        <div className="flex justify-between text-sm">
          {pageNo > 0 ? (
            <Link href={href("/movements", { ...filters, page: String(pageNo - 1) })} className="flex min-h-11 items-center underline underline-offset-4">
              {s.prev}
            </Link>
          ) : (
            <span />
          )}
          {offset + PAGE < res.total && (
            <Link href={href("/movements", { ...filters, page: String(pageNo + 1) })} className="flex min-h-11 items-center underline underline-offset-4">
              {s.next}
            </Link>
          )}
        </div>
      )}
    </SkladShell>
  );
}
