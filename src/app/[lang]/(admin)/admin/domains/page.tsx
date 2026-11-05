import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { euros } from "@/lib/domains";
import { adminHref, forwardDomainsQuery, forwardScript } from "@/lib/adminPages";
import { PendingButton } from "@/components/PendingButton";
import { deleteDomainPrice, saveDomainPrice, saveDomainSettings } from "../_parts/actions";
import { AdminHead, AdminNotice, adminStart, adminTitle, Hidden } from "../_parts/common";

export async function generateMetadata({ params }: PageProps<"/[lang]/admin/domains">): Promise<Metadata> {
  return adminTitle(params, "domains");
}

interface PriceRow {
  tld: string;
  price_cents: number;
  renewal_cents: number;
  vat_included: boolean;
  sort_order: number;
  active: boolean;
}

const input = "rounded border border-line px-2 py-1 outline-none focus:border-foreground";

/**
 * Admin → Domény a cenník (2026-11-05): the domain settings (admin_save_domain_settings) and the price table shops see
 * and pay (admin_save_domain_price / admin_delete_domain_price). The old long page lived here: e-mails and functions
 * that link to /admin/domains still land here; its old filters go to their page (the holidays' country and year →
 * Sviatky, the shops' filters → Obchody a domény) and a small script sends a moved #section to its new page.
 */
export default async function AdminDomainsPage({ params, searchParams }: PageProps<"/[lang]/admin/domains">) {
  const { lang, dict, session } = await adminStart(params);
  const sp = await searchParams;
  const moved = forwardDomainsQuery(sp);
  if (moved) {
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(sp)) if (typeof v === "string") query[k] = v;
    redirect(adminHref(lang, moved, query));
  }
  const a = dict.admin_domains;
  const [stats, prices] = await Promise.all([
    session.supabase.rpc("admin_domain_stats"),
    session.supabase.from("domain_prices").select("tld, price_cents, renewal_cents, vat_included, sort_order, active").order("sort_order"),
  ]);
  const s = (stats.data ?? {}) as Record<string, unknown>;
  const priceRows = (prices.data ?? []) as PriceRow[];
  const hidden = <Hidden lang={lang} keep="" />;

  return (
    <div className="flex flex-col gap-8">
      {/* an old link to a section that moved (#shops, #sms, …) goes to its page */}
      <script dangerouslySetInnerHTML={{ __html: forwardScript("/admin/domains") }} />
      <div>
        <AdminHead dict={dict} page="domains" />
        <AdminNotice dict={dict} sp={sp} />
      </div>

      <section id="settings" className="flex flex-col gap-3" aria-labelledby="settings-heading">
        <h2 id="settings-heading" className="text-lg font-semibold">
          {a.settings_title}
        </h2>
        <form action={saveDomainSettings} className="flex max-w-xl flex-col gap-3 text-sm">
          {hidden}
          <label className="flex flex-col gap-1">
            <span>{a.search_url}</span>
            <input name="search_url" type="url" required defaultValue={String(s.search_url ?? "https://www.websupport.sk")} className={input} />
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" name="same_price" defaultChecked={s.same_price_as_registrar === true} className="mt-1" />
            <span>{a.same_price}</span>
          </label>
          <label className="flex flex-col gap-1">
            <span>{a.low_credit}</span>
            <input name="low_credit" inputMode="decimal" defaultValue={String(s.low_credit_eur ?? 50)} className={`${input} w-32`} />
          </label>
          <label className="flex flex-col gap-1">
            <span>{a.test_domain}</span>
            <input name="test_domain" defaultValue={String(s.test_domain ?? "")} className={input} />
          </label>
          <PendingButton pending={a.done}>{a.save_settings}</PendingButton>
        </form>
      </section>

      <section id="prices" className="flex flex-col gap-3" aria-labelledby="prices-heading">
        <h2 id="prices-heading" className="text-lg font-semibold">
          {a.prices_title}
        </h2>
        <p className="text-sm text-muted">{a.prices_note}</p>
        <div className="flex flex-col gap-2 text-sm" data-prices>
          {[...priceRows, null].map((p) => (
            <div key={p?.tld ?? "new"} className="flex flex-wrap items-end gap-2 border-b border-line pb-2">
              <form action={saveDomainPrice} className="flex flex-wrap items-end gap-2">
                {hidden}
                <label className="flex flex-col gap-1">
                  <span>{a.tld}</span>
                  <input name="tld" required defaultValue={p?.tld ?? ""} readOnly={Boolean(p)} placeholder={p ? undefined : "sk"} className={`${input} w-24`} />
                </label>
                <label className="flex flex-col gap-1">
                  <span>{a.price}</span>
                  <input name="price" required inputMode="decimal" defaultValue={p ? (p.price_cents / 100).toFixed(2) : ""} className={`${input} w-24`} />
                </label>
                <label className="flex flex-col gap-1">
                  <span>{a.renewal}</span>
                  <input name="renewal" required inputMode="decimal" defaultValue={p ? (p.renewal_cents / 100).toFixed(2) : ""} className={`${input} w-24`} />
                </label>
                <label className="flex items-center gap-1 pb-1">
                  <input type="checkbox" name="vat_included" defaultChecked={p ? p.vat_included : true} />
                  {a.vat_included}
                </label>
                <label className="flex flex-col gap-1">
                  <span>{a.sort}</span>
                  <input name="sort" inputMode="numeric" defaultValue={String(p?.sort_order ?? 100)} className={`${input} w-16`} />
                </label>
                <label className="flex items-center gap-1 pb-1">
                  <input type="checkbox" name="active" defaultChecked={p ? p.active : true} />
                  {a.active}
                </label>
                <button type="submit" className="rounded border border-foreground px-3 py-1 font-medium">
                  {p ? a.save_price : a.add_price}
                </button>
              </form>
              {p && (
                <form action={deleteDomainPrice}>
                  {hidden}
                  <input type="hidden" name="tld" value={p.tld} />
                  <button type="submit" className="px-1 py-1 underline underline-offset-4">
                    {a.delete_price}
                  </button>
                </form>
              )}
              {p && <span className="pb-1 text-xs text-muted">{euros(p.price_cents, lang)}</span>}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
