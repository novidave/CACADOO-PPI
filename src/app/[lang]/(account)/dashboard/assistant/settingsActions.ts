"use server";

import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { refreshShop } from "@/lib/publicCache";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * AI asistent → Nastavenia's ONE save bar (2026-11-07, artboard 12): every part runs the function it ran before, and
 * only for what changed against the page as drawn (`was_*` fields):
 *   texts            owner_set_assistant_texts (update 26/46; paid)
 *   ask_contact,
 *   alert_email_on   owner_save_assistant_flags (update 91; only the keys that changed)
 *   tg_callback      owner_telegram_save_prefs (update 66; the shop's prefs read again, only `callback` changes)
 *   bookings         owner_save_booking_rules (update 63; the rules read again, only `enabled` changes)
 *   food             owner_food_save_settings {enabled} (update 73/81; a shop of kind food)
 *   assistant_style,
 *   assistant_name   owner_set_assistant_style (update 92; paid; "Čašník" only for food — not_food)
 * The first refusal stops and comes back as ?err=; otherwise ?ok=saved.
 */
export async function saveAssistantPage(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const { supabase } = session;
  const shopId = String(formData.get("shop_id") ?? "");
  const slug = String(formData.get("shop_slug") ?? "");
  const back = (query: Record<string, string>) =>
    redirect(`/${lang}/dashboard/assistant?${new URLSearchParams({ shop: slug, ...query })}#settings`);
  if (!UUID.test(shopId)) back({ err: "err_failed" });

  const on = (name: string) => formData.get(name) === "on";
  const was = (name: string) => formData.get(`was_${name}`) === "1";
  const present = (name: string) => formData.get(`has_${name}`) === "1";

  // the texts (only when the form had them: a free shop sees "Dostupné v Pro" instead); like before, the owner hears when
  // links, e-mail addresses or HTML were taken out (plain_text())
  let cleaned = false;
  if (present("texts")) {
    const label = String(formData.get("assistant_label") ?? "").slice(0, 400);
    const welcome = String(formData.get("assistant_welcome") ?? "").slice(0, 3000);
    if (label !== String(formData.get("was_label") ?? "") || welcome !== String(formData.get("was_welcome") ?? "")) {
      const { data, error } = await supabase.rpc("owner_set_assistant_texts", { p_shop_id: shopId, p_label: label, p_welcome: welcome });
      if (error) back({ err: error.message === "no_plan" ? "no_plan" : "err_failed" });
      const saved = (data ?? {}) as { label?: string | null; welcome?: string | null };
      cleaned = label.trim().slice(0, 40) !== (saved.label ?? "") || welcome.trim().slice(0, 300) !== (saved.welcome ?? "");
    }
  }

  // "Štýl asistenta" + "Meno asistenta" (update 92): one call when either changed
  if (present("style")) {
    const style = String(formData.get("assistant_style") ?? "");
    const name = String(formData.get("assistant_name") ?? "").trim().slice(0, 40);
    if (style !== String(formData.get("was_style") ?? "") || name !== String(formData.get("was_assistant_name") ?? "")) {
      const { error } = await supabase.rpc("owner_set_assistant_style", { p_shop_id: shopId, p_style: style, p_name: name });
      if (error) {
        const code = error.message;
        back({ err: code === "no_plan" ? "no_plan" : code === "not_food" ? "err_not_food" : code === "name" ? "err_name" : "err_failed" });
      }
    }
  }

  // "Keď asistent nevie odpovedať": the two switches of update 91
  const flags: Record<string, boolean> = {};
  for (const key of ["ask_contact", "alert_email_on"]) if (present(key) && on(key) !== was(key)) flags[key] = on(key);
  if (Object.keys(flags).length) {
    const { error } = await supabase.rpc("owner_save_assistant_flags", { p_shop_id: shopId, p_flags: flags });
    if (error) back({ err: "err_failed" });
  }

  // "Upozorniť ma v Telegrame" = the shop's Telegram notice `callback` (the rest of the prefs as they are)
  if (present("tg_callback") && on("tg_callback") !== was("tg_callback")) {
    const { data } = await supabase.rpc("owner_telegram_prefs");
    const prefs = ((data ?? []) as { shop_id: string; ai_on: boolean; notify: Record<string, boolean>; quiet_from: string | null; quiet_to: string | null }[]).find(
      (p) => p.shop_id === shopId,
    );
    if (!prefs) back({ err: "err_telegram" });
    const { error } = await supabase.rpc("owner_telegram_save_prefs", {
      p_shop_id: shopId,
      p_ai_on: prefs!.ai_on,
      p_notify: { ...(prefs!.notify ?? {}), callback: on("tg_callback") },
      p_quiet_from: prefs!.quiet_from ?? "",
      p_quiet_to: prefs!.quiet_to ?? "",
    });
    if (error) back({ err: "err_failed" });
  }

  // "Ponúka voľné termíny z Rezervácií" = Rezervácie's "Prijímať rezervácie" (the other rules as they are)
  if (present("bookings") && on("bookings") !== was("bookings")) {
    const { data, error: readError } = await supabase.rpc("owner_booking_setup", { p_shop_id: shopId });
    const rules = (data as { rules?: { min_notice: number; max_days: number; step: number; max_per_contact_day: number | null } } | null)?.rules;
    if (readError || !rules) back({ err: "err_failed" });
    const { error } = await supabase.rpc("owner_save_booking_rules", {
      p_shop_id: shopId,
      p_enabled: on("bookings"),
      p_min_notice: rules!.min_notice,
      p_max_days: rules!.max_days,
      p_step: rules!.step,
      p_max_per_contact_day: rules!.max_per_contact_day ?? 2,
    });
    if (error) back({ err: error.message === "no_plan" ? "no_plan" : "err_failed" });
  }

  // "Prijíma objednávky jedla" = Objednávky jedla's "Prijímať objednávky" (a restaurant)
  if (present("food") && on("food") !== was("food")) {
    const { error } = await supabase.rpc("owner_food_save_settings", { p_shop_id: shopId, p: { enabled: on("food") } });
    if (error) back({ err: error.message === "no_plan" ? "no_plan" : "err_failed" });
  }

  if (slug) refreshShop(slug);
  back({ ok: cleaned ? "assistant_cleaned" : "saved" });
}
