import type { Locale } from "@/i18n/config";
import { t, type Dictionary } from "@/i18n/dictionaries";
import { formatDateTime } from "@/lib/format";
import { HEALTH_COLORS } from "@/lib/adminOverview";
import { cardClass, ghostClass } from "@/components/owner/ui";
import { SaveBar } from "@/components/owner/SaveBar";
import { saveTelegramSettings, setTelegramWebhook } from "./actions";
import { DotText, numClass, saveLabels, SettingRow } from "./common";

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
 * "Telegram bot" (database update 66; artboard 7 since 2026-11-05): whether the telegram function has its secrets, the
 * webhook's state at Telegram ("Nastaviť webhook" sends the secret header's value from the function, never through the
 * website), the waiting messages and the last error, how many owners linked it, and the limits (AI answers — also the
 * AI pomocník's on the website —, notifications) with the save bar.
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
  return (
    <section id="telegram" className={`${cardClass} min-w-0 !gap-0`} aria-labelledby="telegram-heading" data-admin-telegram>
      <h2 id="telegram-heading" className="text-[19px] font-bold">
        {a.title}
      </h2>
      <p className="pb-3 pt-1 text-sm text-[#5C5C5C]">{a.intro}</p>
      {info === null ? (
        <SettingRow label={a.webhook_label}>
          <DotText color={HEALTH_COLORS.off}>{dict.admin_home.svc_silent}</DotText>
        </SettingRow>
      ) : !info.configured ? (
        <SettingRow label={a.webhook_label} hint={a.not_configured} data-telegram-off="">
          <DotText color={HEALTH_COLORS.off}>{dict.admin_home.svc_not_set}</DotText>
        </SettingRow>
      ) : (
        <>
          {info.username && (
            <SettingRow label={a.bot_label}>
              <strong>@{info.username}</strong>
            </SettingRow>
          )}
          <SettingRow label={a.webhook_label}>
            <DotText color={info.url_ok ? HEALTH_COLORS.ok : HEALTH_COLORS.bad}>{info.url_ok ? a.webhook_on : a.webhook_none}</DotText>
            <form action={setTelegramWebhook}>
              {hidden}
              <button type="submit" className={`${ghostClass} !min-h-11 !px-4 !text-[15px]`} data-telegram-webhook>
                {a.set_webhook}
              </button>
            </form>
          </SettingRow>
          <SettingRow label={a.pending_label}>
            <strong>{info.pending ?? 0}</strong>
          </SettingRow>
          <SettingRow label={a.last_error_label}>
            {info.last_error && info.last_error_at ? (
              <span className="max-w-xs break-words text-right text-sm">
                {info.last_error}
                <span className="block text-[13px] text-[#5C5C5C]">{formatDateTime(info.last_error_at, lang, "UTC")}</span>
              </span>
            ) : (
              <span className="text-[#5C5C5C]">{a.no_error}</span>
            )}
          </SettingRow>
        </>
      )}
      {settings && (
        <>
          <SettingRow label={a.links_label}>
            <strong>{t(a.links_value, { n: settings.links, g: settings.granted })}</strong>
          </SettingRow>
          <form action={saveTelegramSettings} className="flex flex-col" data-telegram-settings>
            {hidden}
            <SettingRow label={a.ai_enabled_label} hint={a.ai_enabled_hint}>
              <input type="checkbox" name="ai_enabled" aria-label={a.ai_enabled_label} defaultChecked={settings.ai_enabled} className="ppi-toggle" />
            </SettingRow>
            <SettingRow label={a.ai_daily_limit}>
              <input name="ai_daily_limit" type="number" min={0} max={1000} required aria-label={a.ai_daily_limit} defaultValue={settings.ai_daily_limit} className={numClass} />
            </SettingRow>
            <SettingRow label={a.notify_daily_cap}>
              <input name="notify_daily_cap" type="number" min={0} max={200} required aria-label={a.notify_daily_cap} defaultValue={settings.notify_daily_cap} className={numClass} />
            </SettingRow>
            <SaveBar labels={saveLabels(dict, a.save)} />
          </form>
        </>
      )}
    </section>
  );
}
