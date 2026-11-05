import { t, type Dictionary } from "@/i18n/dictionaries";
import { cardClass } from "@/components/owner/ui";
import { SaveBar } from "@/components/owner/SaveBar";
import { HEALTH_COLORS } from "@/lib/adminOverview";
import { saveSmsQuotas } from "./actions";
import { DotText, numClass, saveLabels } from "./common";

export interface SmsQuotaRow {
  quota: "booking" | "owner" | "order";
  monthly: number;
  used_this_month: number;
  shops_at_limit: number;
}

/** The busiest shop of a quota this month (database update 83: admin_sms_busiest()); no shop when nothing was sent. */
export interface SmsBusiestRow {
  quota: SmsQuotaRow["quota"];
  monthly: number;
  shop_name: string | null;
  shop_slug: string | null;
  used: number;
}

/**
 * Admin → SMS (database update 58; artboard 6 since 2026-11-05): which provider the functions send with; the monthly
 * quotas every shop gets (only admin_save_sms_quotas(); the food orders' quota of update 73 through
 * admin_save_sms_quota()) — each row with this month's total of all shops, the shops at the limit and a bar for the
 * busiest shop (used / limit, update 83) —; how SMS parts are counted.
 */
export function SmsAdmin({
  rows,
  busiest,
  provider,
  dict,
  hidden,
}: {
  rows: SmsQuotaRow[] | null;
  busiest: SmsBusiestRow[] | null;
  provider: { name: string; live: boolean } | null;
  dict: Dictionary;
  hidden: React.ReactNode;
}) {
  const a = dict.admin_sms;
  const row = (quota: SmsQuotaRow["quota"]) => rows?.find((r) => r.quota === quota);
  const names: Record<SmsQuotaRow["quota"], [string, string, string]> = {
    booking: [a.booking_name, a.booking_hint, a.booking],
    owner: [a.owner_name, a.owner_hint, a.owner],
    order: [a.order_name, a.order_hint, a.order],
  };
  const quotas = (["booking", "owner", "order"] as const).filter((q) => q !== "order" || row(q));
  return (
    <section id="sms" className="flex flex-col gap-4" aria-label={a.title} data-admin-sms>
      <div className={`${cardClass} !flex-row flex-wrap items-center gap-x-6 gap-y-2`} data-sms-provider={provider?.name ?? "unknown"}>
        {provider === null ? (
          <DotText color={HEALTH_COLORS.off}>{a.provider_unknown}</DotText>
        ) : provider.live ? (
          <DotText color={HEALTH_COLORS.ok}>{t(a.provider_live, { name: provider.name })}</DotText>
        ) : (
          <DotText color={HEALTH_COLORS.warn}>{a.provider_test}</DotText>
        )}
        <span className="text-sm text-[#5C5C5C]">{a.provider_hint}</span>
      </div>

      {!rows ? (
        <p className={`${cardClass} text-[15px] text-[#5C5C5C]`}>{a.unavailable}</p>
      ) : (
        <form action={saveSmsQuotas} className={`${cardClass} min-w-0 !gap-0`} data-sms-limits>
          {hidden}
          <h2 className="pb-2 text-[19px] font-bold">{a.quotas_title}</h2>
          {quotas.map((q) => {
            const r = row(q);
            const b = busiest?.find((x) => x.quota === q);
            const limit = b?.monthly ?? r?.monthly ?? 100;
            const share = b && limit > 0 ? Math.min(100, Math.round((b.used / limit) * 100)) : 0;
            const [name, hint, label] = names[q];
            return (
              <div key={q} className="grid items-center gap-x-5 gap-y-2.5 border-t border-[#E4E4E4] py-3.5 md:grid-cols-[minmax(0,14rem)_6rem_minmax(0,1fr)]" data-sms-quota={q}>
                <span className="flex min-w-0 flex-col">
                  <strong className="text-base">{name}</strong>
                  <span className="text-[13px] text-[#5C5C5C]">{hint}</span>
                </span>
                <label>
                  <span className="sr-only">{label}</span>
                  <input name={q} type="number" min={0} max={100000} required defaultValue={r?.monthly ?? 100} className={numClass} />
                </label>
                <span className="flex min-w-0 flex-col gap-1.5 text-sm">
                  <span>{t(a.row_month, { used: r?.used_this_month ?? 0, shops: r?.shops_at_limit ?? 0 })}</span>
                  {busiest && (
                    <>
                      <span aria-hidden="true" className="block h-2 overflow-hidden rounded-full bg-[#EDEDED]">
                        <span className="block h-full rounded-full bg-[#111]" style={{ width: `${share}%` }} />
                      </span>
                      <span className="text-[13px] text-[#5C5C5C]" data-sms-busiest={b?.shop_slug ?? ""}>
                        {b?.shop_name ? t(a.busiest, { shop: b.shop_name, used: b.used, limit }) : a.busiest_none}
                      </span>
                    </>
                  )}
                </span>
              </div>
            );
          })}
          <SaveBar labels={saveLabels(dict, a.save)} />
        </form>
      )}

      <div className={`${cardClass} min-w-0`}>
        <h2 className="text-[19px] font-bold">{a.how_title}</h2>
        <p className="text-[15px]">{a.how}</p>
      </div>
    </section>
  );
}
