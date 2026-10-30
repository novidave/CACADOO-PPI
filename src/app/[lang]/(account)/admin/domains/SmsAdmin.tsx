import { t, type Dictionary } from "@/i18n/dictionaries";
import { saveSmsQuotas } from "./actions";

export interface SmsQuotaRow {
  quota: "booking" | "owner";
  monthly: number;
  used_this_month: number;
  shops_at_limit: number;
}

/**
 * "SMS" on the admin page (database update 58): the two monthly quotas every shop gets (only admin_save_sms_quotas()),
 * this month's SMS parts of all shops and how many shops are at a limit, and which SMS provider the functions use.
 */
export function SmsAdmin({
  rows,
  provider,
  dict,
  hidden,
}: {
  rows: SmsQuotaRow[] | null;
  provider: { name: string; live: boolean } | null;
  dict: Dictionary;
  hidden: React.ReactNode;
}) {
  const a = dict.admin_sms;
  const input = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";
  const row = (quota: "booking" | "owner") => rows?.find((r) => r.quota === quota);
  return (
    <section id="sms" className="flex flex-col gap-3" aria-labelledby="sms-heading" data-admin-sms>
      <h2 id="sms-heading" className="text-lg font-semibold">
        {a.title}
      </h2>
      <p className="text-sm text-muted">{a.intro}</p>
      <p className="text-sm" data-sms-provider={provider?.name ?? "unknown"}>
        {provider === null ? a.provider_unknown : provider.live ? t(a.provider_live, { name: provider.name }) : a.provider_test}
      </p>
      {!rows ? (
        <p className="text-sm text-muted">{a.unavailable}</p>
      ) : (
        <>
          <form action={saveSmsQuotas} className="flex flex-wrap items-end gap-3 text-sm" data-sms-limits>
            {hidden}
            <label className="flex flex-col gap-1">
              <span>{a.booking}</span>
              <input name="booking" type="number" min={0} max={100000} required defaultValue={row("booking")?.monthly ?? 100} className={`${input} w-28`} />
            </label>
            <label className="flex flex-col gap-1">
              <span>{a.owner}</span>
              <input name="owner" type="number" min={0} max={100000} required defaultValue={row("owner")?.monthly ?? 100} className={`${input} w-28`} />
            </label>
            <button type="submit" className="rounded border border-foreground px-3 py-2 font-medium">
              {a.save}
            </button>
          </form>
          <ul className="flex flex-col gap-1 text-sm">
            {(["booking", "owner"] as const).map((q) => (
              <li key={q}>
                {t(a.month, {
                  quota: q === "booking" ? a.booking : a.owner,
                  used: row(q)?.used_this_month ?? 0,
                  shops: row(q)?.shops_at_limit ?? 0,
                })}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
