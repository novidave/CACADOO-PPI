import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { hoursSmsForward } from "@/lib/dashboardPages";

/**
 * "Otváracie hodiny cez SMS" moved to "SMS a Telegram" → SMS (2026-11-07). This address stays because the hours-sms
 * function sends the Google sign-in back here (?ok=google_connected / ?err=…) and old links name it: every query
 * parameter goes along.
 */
export default async function HoursSmsForward({ params, searchParams }: PageProps<"/[lang]/dashboard/hours-sms">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  redirect(hoursSmsForward(lang, await searchParams));
}
