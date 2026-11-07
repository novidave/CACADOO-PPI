"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { refreshShop } from "@/lib/publicCache";

/**
 * "SMS a Telegram" → SMS (2026-11-07): the booking SMS (moved from Rezervácie → Nastavenia) and the food orders' "na
 * ceste" SMS (moved from Objednávky jedla → Nastavenia). Each form sends ONLY its own keys: owner_save_crm_settings
 * (update 89) and owner_food_save_settings change only the keys they get, so the alert e-mail on Rezervácie and every
 * other food setting stay as they are. Members and the plan are checked by the database.
 */
async function start(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  const back = (anchor: string, query: Record<string, string>): never =>
    redirect(`/${lang}/dashboard/sms-telegram?${new URLSearchParams({ ...(slug ? { shop: slug } : {}), tab: "sms", ...query })}#${anchor}`);
  return { session, shopId, slug, back };
}

const failed = (message: string) => (message === "no_plan" ? "err_no_plan" : "err_save_failed");

/** "SMS pri rezerváciách": the reminder (on, 2 h before or the evening before) and the SMS when the owner moves or cancels. */
export async function saveBookingSms(formData: FormData) {
  const { session, shopId, back } = await start(formData);
  const { error } = await session.supabase.rpc("owner_save_crm_settings", {
    p_shop_id: shopId,
    p_settings: {
      reminder_on: formData.get("reminder_on") === "on",
      reminder_offset: formData.get("reminder_offset") === "2h" ? "2h" : "day_before_18",
      notify_on_owner_change: formData.get("notify_on_owner_change") === "on",
    },
  });
  back("booking-sms", error ? { err: failed(error.message) } : { ok: "ok_booking_sms" });
}

/** "SMS pri objednávkach jedla": "Objednávka je na ceste" offered when an order leaves (update 74's switch). */
export async function saveFoodSms(formData: FormData) {
  const { session, shopId, slug, back } = await start(formData);
  const { error } = await session.supabase.rpc("owner_food_save_settings", {
    p_shop_id: shopId,
    p: { sms_on_the_way: formData.get("sms_on_the_way") === "on" },
  });
  if (!error && slug) refreshShop(slug);
  back("food-sms", error ? { err: failed(error.message) } : { ok: "ok_food_sms" });
}
