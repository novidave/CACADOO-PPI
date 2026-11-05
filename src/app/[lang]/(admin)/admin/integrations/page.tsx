import type { Metadata } from "next";
import type { Locale } from "@/i18n/config";
import { ownerAiReady } from "@/lib/grammar";
import { type BlogAdminInfo, FacebookAppAdmin } from "../_parts/FacebookAppAdmin";
import { OwnerAiAdmin, type OwnerAiInfo } from "../_parts/OwnerAiAdmin";
import { TelegramAdmin, type TelegramSettings, type TelegramWebhookInfo } from "../_parts/TelegramAdmin";
import { AdminHead, AdminNotice, adminStart, adminTitle, Hidden } from "../_parts/common";

export async function generateMetadata({ params }: PageProps<"/[lang]/admin/integrations">): Promise<Metadata> {
  return adminTitle(params, "integrations");
}

/**
 * Admin → AI a prepojenia (2026-11-05): the Telegram bot (database update 66: the webhook through the telegram function,
 * the limits), AI for owners (update 76) and the Facebook app for Novinky (update 37: the shop-blog function's addresses
 * and verify token). Every function checks is_admin itself.
 */
export default async function AdminIntegrationsPage({ params, searchParams }: PageProps<"/[lang]/admin/integrations">) {
  const { lang, dict, session } = await adminStart(params);
  const sp = await searchParams;
  const [telegramInfo, telegramSettings, ownerAi, blogInfo] = await Promise.all([
    session.supabase.functions
      .invoke<TelegramWebhookInfo>("telegram", { body: { action: "webhook_info" } })
      .then(({ data, error }) => (error || !data ? null : data))
      .catch(() => null),
    session.supabase.rpc("admin_telegram_settings"),
    // "AI pre majiteľov" (database update 76; unavailable before it)
    session.supabase.rpc("admin_owner_ai"),
    session.supabase.functions
      .invoke<BlogAdminInfo>("shop-blog", { body: { action: "admin_info" } })
      .then(({ data, error }) => (error || !data ? null : data))
      .catch(() => null),
  ]);
  const hidden = <Hidden lang={lang} keep="" />;
  return (
    <div className="flex flex-col gap-8">
      <div>
        <AdminHead dict={dict} page="integrations" />
        <AdminNotice dict={dict} sp={sp} />
      </div>
      <TelegramAdmin
        info={telegramInfo}
        settings={telegramSettings.error ? null : (telegramSettings.data as TelegramSettings | null)}
        lang={lang as Locale}
        dict={dict}
        hidden={hidden}
      />

      <OwnerAiAdmin info={ownerAi.error ? null : (ownerAi.data as OwnerAiInfo | null)} aiKey={ownerAiReady()} dict={dict} hidden={hidden} />

      <FacebookAppAdmin info={blogInfo} dict={dict} />
    </div>
  );
}
