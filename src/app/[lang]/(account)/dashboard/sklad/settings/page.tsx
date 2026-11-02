import type { Metadata } from "next";
import Link from "next/link";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { formatDateTime } from "@/lib/format";
import { DbError } from "@/components/DbError";
import { PendingButton } from "@/components/PendingButton";
import { saveLocation, savePayment, saveSettings, setSaleSource, setSource } from "../actions";
import { btnGhost, card, first, loadSklad, Notice, PlanCounter, SkladShell } from "../parts";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/sklad/settings">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const s = (await getDictionary(lang)).sklad;
  return { title: `${s.tab_settings} · ${s.title}` };
}

interface Overview {
  source: string;
  products: number;
  limit: number | null;
  locations: { id: string; name: string; note: string | null; sale_default: boolean; receipt_default: boolean }[];
  settings: { margin_reports: boolean; reminder_on: boolean; reminder_time: string } | null;
}

const input = "min-h-11 rounded-xl border border-[#D6D6D6] px-3 text-[15px] outline-none focus:border-foreground";

/**
 * Sklad → Nastavenia (screen 15, phase A): "Zdroj zásob" (Sklad v Cacaduu on / back to files — nothing of Sklad is
 * deleted), Miesta skladu (rename, note, which one sales and receipts use, + Pridať miesto), Aktuálnosť (the daily
 * reminder and its time), Maržové prehľady, the plan, and the exports (products, movements as XLSX).
 */
export default async function SkladSettings({ params, searchParams }: PageProps<"/[lang]/dashboard/sklad/settings">) {
  const { lang } = await params;
  const sp = await searchParams;
  const ctx = await loadSklad(lang, sp);
  if (!ctx.ok) return <DbError message={ctx.error} dict={ctx.dict} />;
  const { dict, s, session, shop, shops, hidden } = ctx;
  await session.supabase.rpc("owner_sklad_start", { p_shop_id: shop.id });
  const { data, error } = await session.supabase.rpc("owner_sklad_overview", { p_shop_id: shop.id });
  if (error) return <DbError message={error.message} dict={dict} />;
  const o = data as Overview;
  const pay = ((await session.supabase.rpc("owner_sklad_payment", { p_shop_id: shop.id })).data ?? {}) as {
    iban?: string | null;
    bic?: string | null;
    payee?: string | null;
    shop_name?: string;
  };
  const st = o.settings ?? { margin_reports: true, reminder_on: true, reminder_time: "08:00" };
  // update 71: where sales come from (before update 71 there is no such choice: the card is hidden)
  const ek = (await session.supabase.rpc("owner_sklad_ekasa_info", { p_shop_id: shop.id })).data as {
    sale_source: string;
    waiting_lines: number;
    imports: { at: string; docs: number; lines: number; pieces: number }[];
  } | null;
  const ekasaHref = `/${ctx.lang}/dashboard/sklad/ekasa?${new URLSearchParams({ shop: shop.slug })}`;
  const planHref = `/${ctx.lang}/dashboard/plan?${new URLSearchParams({ shop: shop.slug })}`;
  const syncHref = `/${ctx.lang}/sync?${new URLSearchParams({ shop: shop.slug, at: "source" })}#source`;
  const exportHref = (kind: string) => `/api/owner/sklad/export?${new URLSearchParams({ shop: shop.id, kind, lang: ctx.lang })}`;
  const back = { back: "/settings" };

  return (
    <SkladShell lang={ctx.lang} s={s} dict={dict} shops={shops} shop={shop} current="settings" source={o.source}>
      <Notice s={s} ok={first(sp.ok)} err={first(sp.err)} />

      <section id="source" className={`${card} bg-[#F7F7F7] sm:flex-row sm:items-center sm:justify-between`} aria-labelledby="st-src" data-sklad-source={o.source}>
        <div className="flex flex-col gap-0.5">
          <h2 id="st-src" className="text-lg font-bold">{o.source === "sklad" ? s.src_on_title : s.src_off_title}</h2>
          <span className="text-sm text-muted">
            {o.source === "sklad" ? s.src_on_text : o.source === "api" ? s.start_blocked_api : o.source === "agent" ? s.start_blocked_agent : s.src_off_text}
          </span>
        </div>
        {o.source === "sklad" ? (
          <form action={setSource} className="flex flex-col gap-1">
            {hidden({ source: "file", ...back })}
            <PendingButton pending={dict.owner.saving}>{s.src_back}</PendingButton>
            <span className="text-[13px] text-muted">{s.src_back_hint}</span>
          </form>
        ) : o.source === "file" ? (
          <form action={setSource} className="flex flex-col gap-1">
            {hidden({ source: "sklad", ...back })}
            <PendingButton pending={dict.owner.saving}>{s.start_button}</PendingButton>
          </form>
        ) : (
          <Link href={syncHref} className={btnGhost}>
            {s.src_change}
          </Link>
        )}
      </section>

      {ek && (
        <form action={setSaleSource} className={card} id="sales" aria-labelledby="st-sales" data-sklad-sale-source={ek.sale_source}>
          {hidden({ ...back })}
          <h2 id="st-sales" className="text-lg font-bold">{s.ss_title}</h2>
          <span className="text-sm text-muted">{s.ss_hint}</span>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {(["predaj", "ekasa"] as const).map((v) => (
              <label key={v} className="flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border border-line p-3 has-[:checked]:border-foreground">
                <input type="radio" name="sale_source" value={v} defaultChecked={ek.sale_source === v} className="mt-1 size-5 flex-none accent-foreground" />
                <span className="flex flex-col">
                  <strong className="text-[15px]">{v === "predaj" ? s.ss_predaj : s.ss_ekasa}</strong>
                  <span className="text-[13px] text-muted">{v === "predaj" ? s.ss_predaj_hint : s.ss_ekasa_hint}</span>
                </span>
              </label>
            ))}
          </div>
          {ek.sale_source === "ekasa" && (
            <p className="text-sm" data-sklad-ekasa-last>
              {ek.imports[0]
                ? s.ss_last
                    .replace("{at}", formatDateTime(ek.imports[0].at, ctx.lang, shop.timezone))
                    .replace("{docs}", String(ek.imports[0].docs))
                    .replace("{lines}", String(ek.imports[0].lines))
                    .replace("{pieces}", String(Number(ek.imports[0].pieces)))
                : s.ek_imports_none}
              {ek.waiting_lines ? ` · ${s.ek_import_waiting.replace("{n}", String(ek.waiting_lines))}` : ""}{" "}
              <Link href={ekasaHref} className="font-semibold underline underline-offset-4">
                {ek.waiting_lines ? s.ss_pair : s.ss_open}
              </Link>
            </p>
          )}
          <PendingButton pending={dict.owner.saving}>{s.save}</PendingButton>
        </form>
      )}

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <section className={card} aria-labelledby="st-loc">
          <h2 id="st-loc" className="text-lg font-bold">{s.locations}</h2>
          {o.locations.map((l) => (
            <details key={l.id} className="border-b border-line pb-2" data-sklad-location={l.name}>
              <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2">
                <span className="flex flex-col">
                  <strong>{l.name}</strong>
                  <span className="text-[13px] text-muted">
                    {[l.note, l.sale_default ? s.loc_sale_default : "", l.receipt_default ? s.loc_receipt_default : ""].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className={`${btnGhost} min-h-9 px-3 text-[13px]`}>{s.edit}</span>
              </summary>
              <form action={saveLocation} className="mt-2 flex flex-col gap-2">
                {hidden({ location_id: l.id, ...back })}
                <label className="flex flex-col gap-1 text-sm">
                  {s.loc_name}
                  <input name="name" required maxLength={80} defaultValue={l.name} className={input} />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  {s.loc_note}
                  <input name="note" maxLength={200} defaultValue={l.note ?? ""} className={input} />
                </label>
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input type="checkbox" name="sale_default" defaultChecked={l.sale_default} className="size-5 accent-foreground" />
                  {s.loc_sale_default}
                </label>
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input type="checkbox" name="receipt_default" defaultChecked={l.receipt_default} className="size-5 accent-foreground" />
                  {s.loc_receipt_default}
                </label>
                <PendingButton pending={dict.owner.saving}>{s.save}</PendingButton>
              </form>
            </details>
          ))}
          <details>
            <summary className={`${btnGhost} cursor-pointer self-start`}>{s.loc_add}</summary>
            <form action={saveLocation} className="mt-2 flex flex-col gap-2">
              {hidden({ ...back })}
              <label className="flex flex-col gap-1 text-sm">
                {s.loc_name}
                <input name="name" required maxLength={80} className={input} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {s.loc_note}
                <input name="note" maxLength={200} className={input} />
              </label>
              <PendingButton pending={dict.owner.saving}>{s.loc_add_save}</PendingButton>
            </form>
          </details>
          <span className="text-[13px] text-muted">{s.loc_hint}</span>
        </section>

        <form action={saveSettings} className="flex flex-col gap-4">
          {hidden({ ...back })}
          <section className={card} aria-labelledby="st-fresh">
            <h2 id="st-fresh" className="text-lg font-bold">{s.fresh_section}</h2>
            <p className="text-sm">{s.fresh_section_text}</p>
            <label className="flex min-h-12 items-center justify-between gap-3">
              <span className="flex flex-col">
                <strong className="text-[15px]">{s.reminder}</strong>
                <span className="text-[13px] text-muted">{s.reminder_hint}</span>
              </span>
              <input type="checkbox" role="switch" name="reminder_on" defaultChecked={st.reminder_on} className="h-[26px] w-11 flex-none accent-foreground" />
            </label>
            <label className="flex items-center justify-between gap-3 text-[15px]">
              <strong>{s.reminder_time}</strong>
              <input type="time" name="reminder_time" defaultValue={st.reminder_time} required className={`${input} w-28 text-center`} />
            </label>
          </section>
          <section className={card} aria-labelledby="st-margin">
            <h2 id="st-margin" className="text-lg font-bold">{s.margin_section}</h2>
            <label className="flex min-h-12 items-center justify-between gap-3">
              <span className="flex flex-col">
                <strong className="text-[15px]">{s.margin_switch}</strong>
                <span className="text-[13px] text-muted">{s.margin_switch_hint}</span>
              </span>
              <input type="checkbox" role="switch" name="margin_reports" defaultChecked={st.margin_reports} className="h-[26px] w-11 flex-none accent-foreground" />
            </label>
          </section>
          <PendingButton pending={dict.owner.saving}>{s.save}</PendingButton>
        </form>

        <form action={savePayment} className={card} aria-labelledby="st-pay" id="payment" data-sklad-payment>
          {hidden({ ...back })}
          <h2 id="st-pay" className="text-lg font-bold">{s.pay_title}</h2>
          <span className="text-sm text-muted">{s.pay_hint}</span>
          <label className="flex flex-col gap-1 text-[15px]">
            <strong>{s.pay_iban}</strong>
            <input name="iban" defaultValue={pay.iban ?? ""} autoComplete="off" spellCheck={false} placeholder="SK00 0000 0000 0000 0000 0000" className={`${input} font-mono uppercase`} />
          </label>
          <label className="flex flex-col gap-1 text-[15px]">
            <strong>{s.pay_bic}</strong>
            <input name="bic" defaultValue={pay.bic ?? ""} autoComplete="off" spellCheck={false} maxLength={11} className={`${input} font-mono uppercase`} />
          </label>
          <label className="flex flex-col gap-1 text-[15px]">
            <strong>{s.pay_payee}</strong>
            <input name="payee" defaultValue={pay.payee ?? ""} placeholder={pay.shop_name ?? ""} maxLength={70} className={input} />
          </label>
          <PendingButton pending={dict.owner.saving}>{s.pay_save}</PendingButton>
          <p className="text-[13px] text-muted">
            <Link href={`/${ctx.lang}/dashboard/sklad/terminal?${new URLSearchParams({ shop: shop.slug })}`} className="font-semibold text-foreground underline underline-offset-4">
              {s.pay_terminal_open}
            </Link>{" "}
            – {s.pay_terminal_hint}
          </p>
        </form>

        <section className={card} aria-labelledby="st-plan">
          <h2 id="st-plan" className="text-lg font-bold">{s.plan}</h2>
          <PlanCounter s={s} products={o.products} limit={o.limit} planHref={planHref} />
        </section>

        <section className={card} aria-labelledby="st-exp">
          <h2 id="st-exp" className="text-lg font-bold">{s.export_section}</h2>
          <span className="text-sm text-muted">{s.export_hint}</span>
          <div className="flex flex-wrap gap-2">
            <a href={exportHref("products")} className={btnGhost} data-sklad-export="products">
              {s.export_products}
            </a>
            <a href={exportHref("movements")} className={btnGhost} data-sklad-export="movements">
              {s.export_movements}
            </a>
            <a href={exportHref("suppliers")} className={btnGhost} data-sklad-export="suppliers">
              {s.export_suppliers}
            </a>
          </div>
          <span className="text-[13px] text-muted">{t(s.export_private, {})}</span>
        </section>
      </div>
    </SkladShell>
  );
}
