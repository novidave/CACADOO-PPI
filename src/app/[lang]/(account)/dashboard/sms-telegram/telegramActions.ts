"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { SCOPES } from "@/lib/ownerMcpRules";
import { telegramBotUsername, telegramDeepLink } from "@/lib/telegram";
import QRCode from "qrcode";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------- Telegram (database update 66)

export interface TelegramLinkState {
  url?: string;
  qr?: string;
  expiresAt?: string;
  error?: string;
}

/** "Vytvoriť odkaz na prepojenie": a one-time code (10 minutes) as t.me/<bot>?start=<code> and its QR code. */
export async function startTelegramLink(): Promise<TelegramLinkState> {
  const session = await getSession();
  if (!session) return { error: "err_failed" };
  const bot = telegramBotUsername();
  if (!bot) return { error: "not_configured" };
  const { data, error } = await session.supabase.rpc("owner_telegram_link_start");
  if (error) return { error: error.message === "too_many" ? "err_too_many" : "err_failed" };
  const { code, expires_at } = data as { code: string; expires_at: string };
  const url = telegramDeepLink(bot, code);
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return { url, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, expiresAt: expires_at };
}

/** Back to "SMS a Telegram" → Telegram with the open shop (2026-11-07; it was AI asistenti#telegram). */
function tgBack(lang: Locale, query: Record<string, string>, formData?: FormData): never {
  revalidatePath("/[lang]/dashboard/sms-telegram", "page");
  const slug = String(formData?.get("shop_slug") ?? "");
  redirect(`/${lang}/dashboard/sms-telegram?${new URLSearchParams({ ...(slug ? { shop: slug } : {}), tab: "telegram", ...query })}#telegram`);
}

/** "Uložiť povolenia": the bot's shops and scopes — a new owner-MCP grant (update 61's rules), its token in the Vault. */
export async function saveTelegramConsent(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shops = formData.getAll("shop").map(String).filter((v) => UUID.test(v));
  if (shops.length === 0) tgBack(lang, { tg_err: "err_shops" }, formData);
  const scopes = SCOPES.filter((s) => s === "shop.read" || formData.get(`scope_${s}`) === "on");
  const { error } = await session.supabase.rpc("owner_telegram_consent", { p_shop_ids: shops, p_scopes: scopes });
  if (error) {
    tgBack(lang, { tg_err: error.message === "not_linked" ? "err_not_linked" : ["no_plan", "forbidden"].includes(error.message) ? "err_shops" : "err_failed" }, formData);
  }
  tgBack(lang, { tg_ok: "saved" }, formData);
}

/** "Odpojiť Telegram": the link and its grant end at once. */
export async function unlinkTelegram(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const { error } = await session.supabase.rpc("owner_telegram_unlink");
  tgBack(lang, error ? { tg_err: "err_failed" } : { tg_ok: "unlinked" }, formData);
}

const TIME_FIELD = /^(|([01]\d|2[0-3]):[0-5]\d)$/;

/** "Upozornenia a AI" per shop: the AI on/off, the notifications ticked and the quiet hours (owner_telegram_save_prefs). */
export async function saveTelegramPrefs(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shop = String(formData.get("shop_id") ?? "");
  const from = String(formData.get("quiet_from") ?? "");
  const to = String(formData.get("quiet_to") ?? "");
  if (!UUID.test(shop)) tgBack(lang, { tg_err: "err_failed" }, formData);
  if (!TIME_FIELD.test(from) || !TIME_FIELD.test(to) || !from !== !to) tgBack(lang, { tg_err: "err_quiet" }, formData);
  const notify = Object.fromEntries(["booking_new", "booking_cancelled", "callback"].map((k) => [k, formData.get(`n_${k}`) === "on"]));
  const { error } = await session.supabase.rpc("owner_telegram_save_prefs", {
    p_shop_id: shop,
    p_ai_on: formData.get("ai_on") === "on",
    p_notify: notify,
    p_quiet_from: from,
    p_quiet_to: to,
  });
  tgBack(lang, error ? { tg_err: error.message === "quiet" ? "err_quiet" : "err_failed" } : { tg_ok: "prefs_saved" }, formData);
}

/** "Poslať skúšobné upozornenie": one message to the owner's Telegram now (5 an hour). */
export async function sendTelegramTest(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shop = String(formData.get("shop_id") ?? "");
  const { error } = UUID.test(shop) ? await session.supabase.rpc("owner_telegram_test", { p_shop_id: shop }) : { error: { message: "bad" } };
  tgBack(lang, error ? { tg_err: error.message === "too_many" ? "err_too_many" : "err_failed" } : { tg_ok: "test_sent" }, formData);
}
