import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { adminHref, forwardDomainsQuery, forwardScript } from "@/lib/adminPages";
import { cardClass, Field, fieldClass, ghostClass, Toggle } from "@/components/owner/ui";
import { SaveBar } from "@/components/owner/SaveBar";
import { deleteDomainPrice, saveDomainPrices, saveDomainSettings } from "../_parts/actions";
import { AdminHead, AdminNotice, adminStart, adminTitle, Hidden, saveLabels, tableBox, tdClass, thClass } from "../_parts/common";

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

/**
 * Admin → Domény a cenník (2026-11-05): the domain settings (admin_save_domain_settings) and the price table shops see
 * and pay (admin_save_domain_price for every row at once / admin_delete_domain_price; artboard 4: two cards, each
 * with the save bar). The old long page lived here: e-mails and functions
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

  const cell = `${fieldClass} !min-h-11 !w-24 !py-2 text-right !text-[15px] tabular-nums`;

  return (
    <div className="flex flex-col gap-4">
      {/* an old link to a section that moved (#shops, #sms, …) goes to its page */}
      <script dangerouslySetInnerHTML={{ __html: forwardScript("/admin/domains") }} />
      <div>
        <AdminHead dict={dict} page="domains" />
        <AdminNotice dict={dict} sp={sp} />
      </div>

      <form action={saveDomainSettings} className={`${cardClass} min-w-0 !gap-0`}>
        {hidden}
        <section id="settings" aria-labelledby="settings-heading" className="flex min-w-0 flex-col gap-3.5 pb-1">
          <h2 id="settings-heading" className="text-[19px] font-bold">
            {a.settings_title}
          </h2>
          <div className="grid gap-3.5 md:grid-cols-3">
            <Field label={a.search_url}>
              <input name="search_url" type="url" required defaultValue={String(s.search_url ?? "https://www.websupport.sk")} className={fieldClass} />
            </Field>
            <Field label={a.low_credit}>
              <input name="low_credit" inputMode="decimal" defaultValue={String(s.low_credit_eur ?? 50)} className={fieldClass} />
            </Field>
            <Field label={a.test_domain}>
              <input name="test_domain" defaultValue={String(s.test_domain ?? "")} className={fieldClass} />
            </Field>
          </div>
          <Toggle name="same_price" label={a.same_price_label} hint={a.same_price_hint} defaultChecked={s.same_price_as_registrar === true} />
        </section>
        <SaveBar labels={saveLabels(dict, a.save_settings)} />
      </form>

      <form action={saveDomainPrices} className={`${cardClass} min-w-0 !gap-0`} data-prices>
        {hidden}
        <section id="prices" aria-labelledby="prices-heading" className="flex min-w-0 flex-col gap-3.5 pb-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="prices-heading" className="text-[19px] font-bold">
              {a.prices_title}
            </h2>
            <span className="text-sm text-[#5C5C5C]">{a.volume}</span>
          </div>
          <p className="text-sm text-[#5C5C5C]">{a.prices_note}</p>
          <div className={tableBox}>
            <table className="w-full min-w-[44rem] border-collapse text-[15px]">
              <thead>
                <tr>
                  <th className={thClass}>{a.tld}</th>
                  <th className={thClass}>{a.price}</th>
                  <th className={thClass}>{a.renewal}</th>
                  <th className={thClass}>{a.vat_included}</th>
                  <th className={thClass}>{a.sort}</th>
                  <th className={thClass}>{a.active}</th>
                  <th className={thClass}>
                    <span className="sr-only">{a.delete_price}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {priceRows.map((p) => (
                  <tr key={p.tld} data-price={p.tld}>
                    <td className={tdClass}>
                      <input type="hidden" name="tlds" value={p.tld} />
                      <strong>.{p.tld.replace(/^\./, "")}</strong>
                    </td>
                    <td className={tdClass}>
                      <input name={`${p.tld}:price`} inputMode="decimal" aria-label={`${a.price} .${p.tld}`} defaultValue={(p.price_cents / 100).toFixed(2)} className={cell} />
                    </td>
                    <td className={tdClass}>
                      <input name={`${p.tld}:renewal`} inputMode="decimal" aria-label={`${a.renewal} .${p.tld}`} defaultValue={(p.renewal_cents / 100).toFixed(2)} className={cell} />
                    </td>
                    <td className={tdClass}>
                      <input type="checkbox" name={`${p.tld}:vat_included`} aria-label={`${a.vat_included} .${p.tld}`} defaultChecked={p.vat_included} className="ppi-toggle" />
                    </td>
                    <td className={tdClass}>
                      <input name={`${p.tld}:sort`} inputMode="numeric" aria-label={`${a.sort} .${p.tld}`} defaultValue={String(p.sort_order)} className={`${cell} !w-20`} />
                    </td>
                    <td className={tdClass}>
                      <input type="checkbox" name={`${p.tld}:active`} aria-label={`${a.active} .${p.tld}`} defaultChecked={p.active} className="ppi-toggle" />
                    </td>
                    <td className={`${tdClass} text-right`}>
                      <button type="submit" formAction={deleteDomainPrice} formNoValidate name="tld" value={p.tld} className={`${ghostClass} !min-h-11 !px-4 !text-[15px]`} data-delete-price={p.tld}>
                        {a.delete_price}
                      </button>
                    </td>
                  </tr>
                ))}
                <tr data-price-new>
                  <td className={tdClass}>
                    <input name="new:tld" aria-label={a.tld} placeholder={a.tld_example} className={`${cell} !w-20 text-left`} />
                  </td>
                  <td className={tdClass}>
                    <input name="new:price" inputMode="decimal" aria-label={a.price} placeholder="0,00" className={cell} />
                  </td>
                  <td className={tdClass}>
                    <input name="new:renewal" inputMode="decimal" aria-label={a.renewal} placeholder="0,00" className={cell} />
                  </td>
                  <td className={`${tdClass} text-sm text-[#5C5C5C]`} colSpan={4}>
                    {a.add_hint}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
        <SaveBar labels={saveLabels(dict, a.save_price)} />
      </form>
    </div>
  );
}
