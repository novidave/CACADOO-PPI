import type { Metadata } from "next";
import Link from "next/link";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { formatDateTime } from "@/lib/format";
import { formatQty, hoursMinutes, minutesLeft } from "@/lib/sklad";
import { DbError } from "@/components/DbError";
import { PendingButton } from "@/components/PendingButton";
import { confirmStock, setSource } from "./actions";
import { btn, btnGhost, card, first, loadSklad, Notice, PlanCounter, SkladShell } from "./parts";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/sklad">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).sklad.title };
}

interface Overview {
  source: string;
  timezone: string;
  last_movement_at: string | null;
  last_movement_kind: string | null;
  confirmed_at: string | null;
  needs_check: boolean;
  fresh_until: string | null;
  freshness_state: "current" | "recent" | "stale";
  yesterday: { sales: number; sold: number; receipts: number; received: number };
  low: { id: string; name: string; min_qty: number; unit: string; total: number }[];
  low_count: number;
  out_count: number;
  no_price_count: number;
  products: number;
  limit: number | null;
  has_plan: boolean;
}

/**
 * Sklad → Prehľad (screen 13): "Potvrďte dnešný stav skladu" with the time left until the stock on the shop page is
 * hidden and "Stav je správny" (or the green "Zásoba na stránke je aktuálna"); yesterday's numbers; "Doobjednať"
 * (below the minimum); quick actions; the plan counter. Before Sklad is the stock source: what it is and one button.
 */
export default async function SkladOverview({ params, searchParams }: PageProps<"/[lang]/dashboard/sklad">) {
  const { lang } = await params;
  const sp = await searchParams;
  const ctx = await loadSklad(lang, sp);
  if (!ctx.ok) return <DbError message={ctx.error} dict={ctx.dict} />;
  const { dict, s, session, shop, shops, hidden, href } = ctx;
  await session.supabase.rpc("owner_sklad_start", { p_shop_id: shop.id });
  const { data, error } = await session.supabase.rpc("owner_sklad_overview", { p_shop_id: shop.id });
  if (error) return <DbError message={error.message} dict={dict} />;
  const o = data as Overview;
  const tz = shop.timezone;
  const now = new Date();
  const left = minutesLeft(o.fresh_until, now);
  const kindText = (k: string | null) => (k ? ((s as Record<string, string>)[`kind_${k}`] ?? k) : "");
  const planHref = `/${ctx.lang}/dashboard/plan?${new URLSearchParams({ shop: shop.slug })}`;

  return (
    <SkladShell lang={ctx.lang} s={s} dict={dict} shops={shops} shop={shop} current="overview" source={o.source}>
      <Notice s={s} ok={first(sp.ok)} err={first(sp.err)} />

      {o.source !== "sklad" ? (
        <section className={card} aria-labelledby="sk-start" data-sklad-start>
          <h2 id="sk-start" className="text-[17px] font-bold">{s.start_title}</h2>
          <p className="text-sm">{s.start_text}</p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            <li>{s.start_point_movements}</li>
            <li>{s.start_point_public}</li>
            <li>{s.start_point_private}</li>
            <li>{s.start_point_back}</li>
          </ul>
          {o.source === "api" || o.source === "agent" ? (
            <p className="text-sm font-semibold">{o.source === "api" ? s.start_blocked_api : s.start_blocked_agent}</p>
          ) : (
            <form action={setSource} className="flex flex-col gap-2">
              {hidden({ source: "sklad", back: "" })}
              <PendingButton pending={dict.owner.saving}>{s.start_button}</PendingButton>
              <p className="text-[13px] text-muted">{t(s.start_takeover, { n: o.products })}</p>
            </form>
          )}
        </section>
      ) : o.needs_check ? (
        <section className={`${card} border-2 border-[#F2B705] bg-[#FFFBEA]`} aria-labelledby="sk-fresh" data-sklad-check>
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="size-3 flex-none rounded-full bg-[#F2B705] shadow-[0_0_0_1px_rgba(0,0,0,.25)]" />
            <h2 id="sk-fresh" className="text-[17px] font-bold">{s.check_title}</h2>
          </div>
          <p className="text-sm">
            {o.last_movement_at
              ? t(s.check_text_last, { when: formatDateTime(o.last_movement_at, ctx.lang, tz), kind: kindText(o.last_movement_kind) })
              : s.check_text_none}{" "}
            {left > 0 ? t(s.check_hidden_in, { left: hoursMinutes(left) }) : s.check_hidden_now}
          </p>
          <form action={confirmStock}>
            {hidden({ back: "" })}
            <button type="submit" className={`${btn} min-h-14 w-full text-[17px]`} data-sklad-confirm>
              {s.confirm}
            </button>
          </form>
        </section>
      ) : (
        <section role="status" className={`${card} border-2 border-[#1E9E5A] bg-[#F2FAF5]`} aria-label={s.fresh_title} data-sklad-fresh>
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="size-3 flex-none rounded-full bg-[#1E9E5A] shadow-[0_0_0_1px_rgba(0,0,0,.25)]" />
            <h2 className="text-[17px] font-bold">{s.fresh_title}</h2>
          </div>
          <p className="text-sm">
            {o.fresh_until ? t(s.fresh_until, { when: formatDateTime(o.fresh_until, ctx.lang, tz) }) : ""}
          </p>
        </section>
      )}

      <section aria-labelledby="sk-y" className="flex flex-col gap-2">
        <h2 id="sk-y" className="text-[17px] font-bold">{s.yesterday}</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Link href={href("/movements", { kind: "sale" })} className={`${card} gap-0.5`}>
            <strong className="text-2xl">{formatQty(o.yesterday.sold, "ks", ctx.lang)}</strong>
            <span className="text-[13px] text-muted">{t(s.y_sales, { n: o.yesterday.sales })}</span>
          </Link>
          <Link href={href("/movements", { kind: "receipt" })} className={`${card} gap-0.5`}>
            <strong className="text-2xl">+{formatQty(o.yesterday.received, "ks", ctx.lang)}</strong>
            <span className="text-[13px] text-muted">{t(s.y_receipts, { n: o.yesterday.receipts })}</span>
          </Link>
          <Link href={href("/products", { f: "low" })} className={`${card} gap-0.5`}>
            <strong className="text-2xl">{o.low_count}</strong>
            <span className="text-[13px] text-muted">{s.y_low}</span>
          </Link>
          <Link href={href("/products", { f: "out" })} className={`${card} gap-0.5`}>
            <strong className="text-2xl">{o.out_count}</strong>
            <span className="text-[13px] text-muted">{s.y_out}</span>
          </Link>
        </div>
      </section>

      <section className={`${card} gap-0`} aria-labelledby="sk-low">
        <div className="mb-1 flex items-baseline justify-between">
          <h2 id="sk-low" className="text-[17px] font-bold">{s.reorder}</h2>
          <Link href={href("/products", { f: "low" })} className="flex min-h-11 items-center text-sm font-semibold underline underline-offset-4">
            {s.all}
          </Link>
        </div>
        {o.low.length === 0 ? (
          <p className="py-2 text-sm text-muted">{s.reorder_none}</p>
        ) : (
          o.low.map((p) => (
            <Link key={p.id} href={href(`/products/${p.id}`, { act: "receipt" })} className="flex items-center justify-between gap-3 border-b border-line py-2.5 last:border-b-0">
              <span className="flex min-w-0 flex-col gap-0.5">
                <strong className="text-[15px]">{p.name}</strong>
                <span className="flex items-center gap-1.5 text-[13px] text-muted">
                  <span aria-hidden="true" className={`size-2.5 flex-none rounded-full shadow-[0_0_0_1px_rgba(0,0,0,.25)] ${p.total > 0 ? "bg-[#1E9E5A]" : "bg-[#D64545]"}`} />
                  {p.total > 0
                    ? t(s.low_line, { qty: formatQty(p.total, p.unit, ctx.lang), min: formatQty(p.min_qty, p.unit, ctx.lang) })
                    : t(s.out_line, { min: formatQty(p.min_qty, p.unit, ctx.lang) })}
                </span>
              </span>
              <span className={`${btnGhost} min-h-10 flex-none px-3 text-[13px]`}>{s.receive}</span>
            </Link>
          ))
        )}
      </section>

      <section aria-label={s.quick} className="grid grid-cols-3 gap-2">
        <Link href={href("/products", { act: "receipt" })} className="flex min-h-[72px] flex-col items-center justify-center gap-1 rounded-xl border border-[#D6D6D6] text-sm font-bold">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          {s.quick_receive}
        </Link>
        <Link href={href("/products", { act: "sale" })} className="flex min-h-[72px] flex-col items-center justify-center gap-1 rounded-xl border border-[#D6D6D6] text-sm font-bold">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M5 12h14" /></svg>
          {s.quick_issue}
        </Link>
        <Link href={href("/products/new")} className="flex min-h-[72px] flex-col items-center justify-center gap-1 rounded-xl border border-[#D6D6D6] text-sm font-bold">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 4h16v16H4zM12 8v8M8 12h8" /></svg>
          {s.quick_new}
        </Link>
      </section>

      <section className={card} aria-label={s.plan}>
        <PlanCounter s={s} products={o.products} limit={o.limit} planHref={planHref} />
      </section>
    </SkladShell>
  );
}
