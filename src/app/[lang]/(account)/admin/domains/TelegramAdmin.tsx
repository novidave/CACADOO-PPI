import type { Locale } from "@/i18n/config";
import { t, type Dictionary } from "@/i18n/dictionaries";
import { formatDateTime } from "@/lib/format";
import { saveTelegramSettings, setTelegramWebhook } from "./actions";

export interface TelegramWebhookInfo {
  configured: boolean;
  username?: string | null;
  url_ok?: boolean;
  pending?: number;
  last_error_at?: string | null;
  last_error?: string | null;
}

export interface TelegramSettings {
  ai_enabled: boolean;
  ai_daily_limit: number;
  notify_daily_cap: number;
  links: number;
  granted: number;
}

/**
 * "Telegram bot" on the admin page (database update 66): whether the telegram function has its secrets, the webhook's
 * state at Telegram ("Nastaviť webhook" sends the secret header's value from the function, never through the website),
 * how many owners linked it, and the limits for the later phases (AI answers, notifications).
 */
export function TelegramAdmin({
  info,
  settings,
  lang,
  dict,
  hidden,
}: {
  info: TelegramWebhookInfo | null;
  settings: TelegramSettings | null;
  lang: Locale;
  dict: Dictionary;
  hidden: React.ReactNode;
}) {
  const a = dict.admin_telegram;
  const input = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";
  return (
    <section id="telegram" className="flex flex-col gap-3" aria-labelledby="telegram-heading" data-admin-telegram>
      <h2 id="telegram-heading" className="text-lg font-semibold">
        {a.title}
      </h2>
      <p className="text-sm text-muted">{a.intro}</p>
      {info === null ? (
        <p className="text-sm text-muted">{a.unavailable}</p>
      ) : !info.configured ? (
        <p className="text-sm" data-telegram-off>{a.not_configured}</p>
      ) : (
        <div className="flex flex-col gap-1 text-sm">
          {info.username && <span>{t(a.bot, { name: info.username })}</span>}
          <span className="font-semibold">{info.url_ok ? a.webhook_ok : a.webhook_off}</span>
          <span>{t(a.pending, { n: info.pending ?? 0 })}</span>
          {info.last_error && info.last_error_at && (
            <span className="text-muted">{t(a.last_error, { date: formatDateTime(info.last_error_at, lang, "UTC"), text: info.last_error })}</span>
          )}
          <form action={setTelegramWebhook}>
            {hidden}
            <button type="submit" className="mt-2 min-h-11 rounded border border-foreground px-3 font-medium" data-telegram-webhook>
              {a.set_webhook}
            </button>
          </form>
        </div>
      )}
      {settings && (
        <>
          <p className="text-sm">{t(a.links, { n: settings.links, g: settings.granted })}</p>
          <form action={saveTelegramSettings} className="flex flex-wrap items-end gap-3 text-sm" data-telegram-settings>
            {hidden}
            <label className="flex min-h-11 items-center gap-2">
              <input type="checkbox" name="ai_enabled" defaultChecked={settings.ai_enabled} className="h-4 w-4 accent-foreground" />
              {a.ai_enabled}
            </label>
            <label className="flex flex-col gap-1">
              <span>{a.ai_daily_limit}</span>
              <input name="ai_daily_limit" type="number" min={0} max={1000} required defaultValue={settings.ai_daily_limit} className={`${input} w-28`} />
            </label>
            <label className="flex flex-col gap-1">
              <span>{a.notify_daily_cap}</span>
              <input name="notify_daily_cap" type="number" min={0} max={200} required defaultValue={settings.notify_daily_cap} className={`${input} w-28`} />
            </label>
            <button type="submit" className="rounded border border-foreground px-3 py-2 font-medium">
              {a.save}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
