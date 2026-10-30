import { t, type Dictionary } from "@/i18n/dictionaries";
import type { Locale } from "@/i18n/config";
import { formatDate } from "@/lib/format";
import { quotaLeft, type SmsQuota, type SmsUsage as Usage } from "@/lib/smsUsage";

/**
 * "SMS tento mesiac" (database update 58): the shop's two monthly quotas — the booking's codes and reminders, and the
 * owner's own SMS — with a thin bar each, written out ("23 zo 100 SMS"), and when the month starts again (in the
 * shop's time zone). The database decides; this only shows it.
 */
export function SmsUsage({
  usage,
  lang,
  timeZone,
  dict,
  only,
}: {
  usage: Usage;
  lang: Locale;
  timeZone: string;
  dict: Dictionary;
  only?: "booking" | "owner";
}) {
  const s = dict.sms_usage;
  const row = (key: "booking" | "owner", label: string, q: SmsQuota) => {
    const full = quotaLeft(q) === 0;
    const width = q.limit > 0 ? Math.min(100, Math.round((q.used / q.limit) * 100)) : 100;
    return (
      <li key={key} className="flex flex-col gap-1" data-sms-quota={key} data-sms-full={full}>
        <span className="flex flex-wrap justify-between gap-x-3 text-sm">
          <span>{label}</span>
          <span className={full ? "font-semibold" : undefined}>{t(s.used, { used: q.used, limit: q.limit })}</span>
        </span>
        <span className="h-1.5 w-full overflow-hidden rounded bg-line" aria-hidden="true">
          <span className="block h-full bg-foreground" style={{ width: `${width}%` }} />
        </span>
        {full && <span className="text-xs font-semibold">{key === "booking" ? s.full_booking : s.full_owner}</span>}
      </li>
    );
  };
  return (
    <section className="flex flex-col gap-2 border border-line p-3" aria-labelledby="sms-usage-heading" data-sms-usage>
      <h2 id="sms-usage-heading" className="text-sm font-semibold">
        {s.title}
      </h2>
      <ul className="flex flex-col gap-3">
        {only !== "owner" && row("booking", s.booking, usage.booking)}
        {only !== "booking" && row("owner", s.owner, usage.owner)}
      </ul>
      <p className="text-xs text-muted">
        {t(s.resets, { date: formatDate(usage.resets_at, lang, timeZone) })} {s.parts_hint}
      </p>
    </section>
  );
}
