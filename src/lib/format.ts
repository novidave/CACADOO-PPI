import type { Locale } from "@/i18n/config";

export const TIME_ZONE = "Europe/Bratislava";

/** 12,90 € in Slovak and Hungarian, €12.90 in English. */
export function formatPrice(value: number | null | undefined, locale: Locale, currency = "EUR"): string {
  if (value === null || value === undefined) return "";
  const amount = Number(value);
  if (locale === "en") {
    const symbol = currency === "EUR" ? "€" : `${currency} `;
    return `${symbol}${amount.toFixed(2)}`;
  }
  const symbol = currency === "EUR" ? "€" : currency;
  return `${amount.toFixed(2).replace(".", ",")} ${symbol}`;
}

/** "14:05" in Bratislava time. */
export function formatTime(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** "2026-10-01" in Bratislava time, for comparing calendar days. */
export function bratislavaDay(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
