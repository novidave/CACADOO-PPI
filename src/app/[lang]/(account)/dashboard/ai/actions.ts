"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isLocale, type Locale } from "@/i18n/config";
import { getSession } from "@/lib/auth";
import { SCOPES } from "@/lib/ownerMcpRules";
import { telegramBotUsername, telegramDeepLink } from "@/lib/telegram";
import QRCode from "qrcode";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface McpKeyState {
  key?: string;
  name?: string;
  error?: string;
}

/** "Vytvoriť kľúč": a personal key for AI assistants without OAuth (shown once; only its hash is kept). */
export async function createMcpKey(_previous: McpKeyState, formData: FormData): Promise<McpKeyState> {
  const session = await getSession();
  if (!session) return { error: "login" };
  const name = String(formData.get("name") ?? "").trim().slice(0, 100);
  if (!name) return { error: "key_name_missing" };
  const shops = formData.getAll("shop").map(String).filter((v) => UUID.test(v));
  if (shops.length === 0) return { error: "key_shops" };
  const scopes = SCOPES.filter((s) => s === "shop.read" || formData.get(`scope_${s}`) === "on");
  const { data, error } = await session.supabase.rpc("owner_mcp_create_key", { p_name: name, p_shop_ids: shops, p_scopes: scopes });
  if (error) return { error: ["no_plan", "too_many", "forbidden"].includes(error.message) ? `key_${error.message}` : "key_failed" };
  revalidatePath("/[lang]/dashboard/ai", "page");
  return { key: (data as { key: string }).key, name };
}

/** "Odpojiť": the assistant or key stops at once. */
export async function disconnectMcp(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const id = String(formData.get("grant_id") ?? "");
  const { error } = UUID.test(id) ? await session.supabase.rpc("owner_mcp_disconnect", { p_id: id }) : { error: { message: "bad" } };
  redirect(`/${lang}/dashboard/ai?${new URLSearchParams(error ? { err: "failed" } : { ok: "disconnected" })}`);
}

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

const tgBack = (lang: Locale, query: Record<string, string>): never => {
  revalidatePath("/[lang]/dashboard/ai", "page");
  redirect(`/${lang}/dashboard/ai?${new URLSearchParams(query)}#telegram`);
};

/** "Uložiť povolenia": the bot's shops and scopes — a new owner-MCP grant (update 61's rules), its token in the Vault. */
export async function saveTelegramConsent(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const shops = formData.getAll("shop").map(String).filter((v) => UUID.test(v));
  if (shops.length === 0) tgBack(lang, { tg_err: "err_shops" });
  const scopes = SCOPES.filter((s) => s === "shop.read" || formData.get(`scope_${s}`) === "on");
  const { error } = await session.supabase.rpc("owner_telegram_consent", { p_shop_ids: shops, p_scopes: scopes });
  if (error) {
    tgBack(lang, { tg_err: error.message === "not_linked" ? "err_not_linked" : ["no_plan", "forbidden"].includes(error.message) ? "err_shops" : "err_failed" });
  }
  tgBack(lang, { tg_ok: "saved" });
}

/** "Odpojiť Telegram": the link and its grant end at once. */
export async function unlinkTelegram(formData: FormData) {
  const langValue = String(formData.get("lang") ?? "");
  const lang: Locale = isLocale(langValue) ? langValue : "en";
  const session = await getSession();
  if (!session) redirect(`/${lang}/login`);
  const { error } = await session.supabase.rpc("owner_telegram_unlink");
  tgBack(lang, error ? { tg_err: "err_failed" } : { tg_ok: "unlinked" });
}
