import type { Locale } from "@/i18n/config";
import { t, type Dictionary } from "@/i18n/dictionaries";
import type { requireUser } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { telegramBotUsername } from "@/lib/telegram";
import { TelegramLinkForm } from "@/components/TelegramLinkForm";
import { cardClass } from "@/components/owner/ui";
import { saveTelegramConsent, saveTelegramPrefs, sendTelegramTest, startTelegramLink, unlinkTelegram } from "./telegramActions";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

interface TelegramPrefs {
  shop_id: string;
  ai_on: boolean;
  notify: Record<string, boolean>;
  quiet_from: string | null;
  quiet_to: string | null;
}

interface TelegramStatus {
  username: string | null;
  linked_at: string;
  last_seen_at: string | null;
  scopes: string[] | null;
  shops: { id: string; slug: string; name: string; has_plan: boolean }[] | null;
}

/**
 * "SMS a Telegram" → Telegram (database update 66; until 2026-11-07 the "#telegram" part of AI asistenti, unchanged in
 * behaviour): the link (button + QR code), the shops and scopes the bot may use (an owner-MCP grant), per shop the AI
 * and the notifications with the quiet hours, a test message and "Odpojiť". Without TELEGRAM_BOT_USERNAME only the
 * "nie je nastavené" line. The account's Telegram covers every shop; the open shop only keeps ?shop= on the way back.
 */
export async function TelegramPart({
  supabase,
  lang,
  dict,
  sp,
  slug,
}: {
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"];
  lang: Locale;
  dict: Dictionary;
  sp: Record<string, string | string[] | undefined>;
  slug: string;
}) {
  const m = dict.owner_mcp;
  const tg = dict.owner_tg;
  const tgTexts = tg as Record<string, string>;
  const [shopsRes, telegramRes, prefsRes] = await Promise.all([
    supabase.rpc("owner_mcp_shops"),
    supabase.rpc("owner_telegram_status"),
    supabase.rpc("owner_telegram_prefs"),
  ]);
  // before update 66 (or 61) there is nothing to show but the line that it is not ready
  if (shopsRes.error || telegramRes.error) {
    return (
      <section id="telegram" className={`${cardClass} scroll-mt-4`} data-telegram>
        <h2 className="text-[19px] font-bold">{tg.title}</h2>
        <p className="text-sm text-muted">{m.unavailable}</p>
      </section>
    );
  }
  const pro = ((shopsRes.data ?? []) as { shop_id: string; slug: string; name: string; has_plan: boolean }[]).filter((s) => s.has_plan);
  const bot = telegramBotUsername();
  const telegram = telegramRes.data as TelegramStatus | null;
  const tgOk = first(sp.tg_ok);
  const tgErr = first(sp.tg_err);
  const tgShops = new Set((telegram?.shops ?? []).map((s) => s.id));
  const tgScopes = new Set(telegram?.scopes ?? ["shop.read", "shop.write"]);
  const tgPrefs = new Map(((prefsRes.data ?? []) as TelegramPrefs[]).map((p) => [p.shop_id, p]));
  const slugField = <input type="hidden" name="shop_slug" value={slug} />;

  return (
    <section id="telegram" className={`${cardClass} scroll-mt-4`} data-telegram>
        <h2 className="text-[19px] font-bold">{tg.title}</h2>
        <p className="text-sm">{tg.intro}</p>
        {tgOk && <p role="status" className="border border-foreground p-3 font-medium">{tgTexts[tgOk] ?? tg.saved}</p>}
        {tgErr && <p role="alert" className="border border-line p-3 text-sm">{tgTexts[tgErr] ?? tg.err_failed}</p>}
        {!bot ? (
          <p className="text-sm text-muted" data-telegram-off>{tg.not_configured}</p>
        ) : pro.length === 0 ? (
          <p className="text-sm text-muted">{tg.no_pro}</p>
        ) : (
          <>
            <h3 className="text-sm font-semibold">{tg.step_link}</h3>
            {telegram ? (
              <div className="flex flex-col gap-2 text-sm" data-telegram-linked>
                <span>
                  {t(tg.linked_as, { name: telegram.username ? `@${telegram.username}` : tg.no_username })}
                  {" · "}
                  {t(tg.linked_since, { date: formatDateTime(telegram.linked_at, lang) })}
                  {telegram.last_seen_at && ` · ${t(tg.last_seen, { date: formatDateTime(telegram.last_seen_at, lang) })}`}
                </span>
                <form action={unlinkTelegram}>
                  <input type="hidden" name="lang" value={lang} />
                  {slugField}
                  <button type="submit" className="min-h-11 text-sm underline underline-offset-4" data-telegram-unlink>
                    {tg.unlink}
                  </button>
                </form>
              </div>
            ) : (
              <>
                <p className="text-sm">{tg.link_hint}</p>
                <TelegramLinkForm action={startTelegramLink} bot={bot} labels={tg} lang={lang} />
              </>
            )}
            {telegram && (
              <form action={saveTelegramConsent} className="flex flex-col gap-3" data-telegram-consent>
                <input type="hidden" name="lang" value={lang} />
                {slugField}
                <h3 className="text-sm font-semibold">{tg.step_consent}</h3>
                {!telegram.scopes && <p className="border border-line p-3 text-sm">{tg.waiting}</p>}
                <p className="text-xs text-muted">{tg.consent_hint}</p>
                <fieldset className="flex flex-col gap-1">
                  <legend className="text-sm">{m.consent_shops}</legend>
                  {pro.map((s) => (
                    <label key={s.shop_id} className="flex min-h-11 items-center gap-2 text-sm">
                      <input type="checkbox" name="shop" value={s.shop_id} defaultChecked={!telegram.scopes || tgShops.has(s.shop_id)} className="h-4 w-4 accent-foreground" />
                      {s.name}
                    </label>
                  ))}
                </fieldset>
                <fieldset className="flex flex-col gap-1">
                  <legend className="text-sm">{m.consent_scopes}</legend>
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input type="checkbox" checked disabled className="h-4 w-4 accent-foreground" />
                    {m.scope_read}
                  </label>
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input type="checkbox" name="scope_shop.write" defaultChecked={tgScopes.has("shop.write")} className="h-4 w-4 accent-foreground" />
                    {m.scope_write}
                  </label>
                </fieldset>
                <button type="submit" className="min-h-11 self-start rounded border border-foreground px-4 font-medium" data-telegram-save>
                  {tg.save}
                </button>
              </form>
            )}
            {telegram?.scopes && (telegram.shops ?? []).length > 0 && (
              <div className="flex flex-col gap-3" data-telegram-prefs>
                <h3 className="text-sm font-semibold">{tg.prefs_title}</h3>
                {(telegram.shops ?? []).map((shop) => {
                  const p = tgPrefs.get(shop.id);
                  return (
                    <div key={shop.id} className="flex flex-col gap-2 border border-line p-3">
                      <form action={saveTelegramPrefs} className="flex flex-col gap-2 text-sm">
                        <input type="hidden" name="lang" value={lang} />
                        {slugField}
                        <input type="hidden" name="shop_id" value={shop.id} />
                        <span className="font-semibold">{shop.name}</span>
                        <label className="flex min-h-11 items-center gap-2">
                          <input type="checkbox" name="ai_on" defaultChecked={p?.ai_on ?? true} className="h-4 w-4 shrink-0 accent-foreground" />
                          {tg.ai_on}
                        </label>
                        <span>{tg.notify_title}</span>
                        {(["booking_new", "booking_cancelled", "callback"] as const).map((k) => (
                          <label key={k} className="flex min-h-11 items-center gap-2">
                            <input type="checkbox" name={`n_${k}`} defaultChecked={p?.notify?.[k] === true} className="h-4 w-4 shrink-0 accent-foreground" />
                            {tgTexts[`n_${k}`]}
                          </label>
                        ))}
                        <span>{tg.quiet}</span>
                        <span className="flex flex-wrap items-center gap-2">
                          <label className="flex items-center gap-2">
                            {tg.quiet_from}
                            <input type="time" name="quiet_from" defaultValue={p?.quiet_from ?? ""} className="min-h-11 rounded border border-line px-2 text-base" />
                          </label>
                          <label className="flex items-center gap-2">
                            {tg.quiet_to}
                            <input type="time" name="quiet_to" defaultValue={p?.quiet_to ?? ""} className="min-h-11 rounded border border-line px-2 text-base" />
                          </label>
                        </span>
                        <button type="submit" className="min-h-11 self-start rounded border border-foreground px-4 font-medium" data-telegram-prefs-save>
                          {tg.save_prefs}
                        </button>
                      </form>
                      <form action={sendTelegramTest}>
                        <input type="hidden" name="lang" value={lang} />
                        {slugField}
                        <input type="hidden" name="shop_id" value={shop.id} />
                        <button type="submit" className="min-h-11 text-sm underline underline-offset-4" data-telegram-test>
                          {tg.test}
                        </button>
                      </form>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="text-xs text-muted">{tg.note}</p>
          </>
        )}
      </section>
  );
}
