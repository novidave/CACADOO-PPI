import type { Locale } from "@/i18n/config";
import { t, type Dictionary } from "@/i18n/dictionaries";
import { dayName, openingStatus, type OpeningHours } from "@/lib/hours";

/** "Otvorené · Zatvára o 17:00" / "Zatvorené · Otvára zajtra o 08:00". Nothing if hours are unknown. */
export function OpenStatus({
  hours,
  timeZone,
  lang,
  dict,
  className = "",
}: {
  hours: OpeningHours | null;
  timeZone: string | null;
  lang: Locale;
  dict: Dictionary;
  className?: string;
}) {
  const status = openingStatus(hours, timeZone);
  if (!status) return null;

  let detail: string | null = null;
  if (status.open) detail = t(dict.shop.closes_at, { time: status.closesAt });
  else if (status.opensAt !== null) {
    detail =
      status.opensIn === 0
        ? t(dict.shop.opens_at, { time: status.opensAt })
        : status.opensIn === 1
          ? t(dict.shop.opens_tomorrow, { time: status.opensAt })
          : t(dict.shop.opens_day, { day: dayName(status.opensDay, lang), time: status.opensAt });
  }

  return (
    <span className={className}>
      <span className="font-semibold">{status.open ? dict.shop.open_now : dict.shop.closed}</span>
      {detail && <span className="text-muted"> · {detail}</span>}
    </span>
  );
}
