import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { McpKeyForm } from "@/components/McpKeyForm";
import { formatDateTime } from "@/lib/format";
import { MCP_PATH } from "@/lib/ownerMcpRules";
import { siteUrl } from "@/lib/site";
import { TelegramLinkForm } from "@/components/TelegramLinkForm";
import { telegramBotUsername } from "@/lib/telegram";
import { createMcpKey, disconnectMcp, saveTelegramConsent, saveTelegramPrefs, sendTelegramTest, startTelegramLink, unlinkTelegram } from "./actions";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/ai">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).owner_mcp.title };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

interface GrantRow {
  id: string;
  kind: "oauth" | "personal";
  name: string;
  scopes: string[];
  shops: { slug: string; name: string }[];
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  active: boolean;
}

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
 * "AI asistenti" (database update 61; Pro): the address of the owner's MCP server, how to connect Claude, ChatGPT,
 * Gemini, Grok and others, the assistants and keys connected (with "Odpojiť"), and a personal key for clients without
 * OAuth. What an assistant may do is decided in the database for every call.
 */
export default async function AiPage({ params, searchParams }: PageProps<"/[lang]/dashboard/ai">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const m = dict.owner_mcp;
  const [shopsRes, grantsRes, telegramRes, prefsRes] = await Promise.all([
    session.supabase.rpc("owner_mcp_shops"),
    session.supabase.rpc("owner_mcp_grants"),
    // Telegram (database update 66; before it the section is not shown)
    session.supabase.rpc("owner_telegram_status"),
    session.supabase.rpc("owner_telegram_prefs"),
  ]);
  if (shopsRes.error) {
    return (
      <div className="flex max-w-3xl flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">{m.title}</h1>
        <p className="text-sm text-muted">{m.unavailable}</p>
      </div>
    );
  }
  const shops = (shopsRes.data ?? []) as { shop_id: string; slug: string; name: string; has_plan: boolean }[];
  const pro = shops.filter((s) => s.has_plan);
  const grants = (grantsRes.data ?? []) as GrantRow[];
  const url = `${siteUrl()}${MCP_PATH}`;
  const scopeText: Record<string, string> = { "shop.read": m.scope_read_short, "shop.write": m.scope_write_short, "messages.send": m.scope_messages_short };
  const tg = dict.owner_tg;
  const tgTexts = tg as Record<string, string>;
  const bot = telegramBotUsername();
  const telegram = telegramRes.error ? undefined : (telegramRes.data as TelegramStatus | null);
  const tgOk = first(sp.tg_ok);
  const tgErr = first(sp.tg_err);
  const tgShops = new Set((telegram?.shops ?? []).map((s) => s.id));
  const tgScopes = new Set(telegram?.scopes ?? ["shop.read", "shop.write"]);
  const tgPrefs = new Map(((prefsRes.data ?? []) as TelegramPrefs[]).map((p) => [p.shop_id, p]));
  const ok = first(sp.ok);
  const err = first(sp.err);
  const howTo: [string, string][] = [
    ["Claude", m.how_claude],
    ["ChatGPT", m.how_chatgpt],
    ["Gemini", m.how_gemini],
    ["Grok", m.how_grok],
    [m.how_other_title, m.how_other],
  ];

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{m.title}</h1>
        <p className="text-sm">{m.intro}</p>
        {ok === "disconnected" && <p role="status" className="border border-foreground p-3 font-medium">{m.ok_disconnected}</p>}
        {err && <p className="border border-line p-3">{m.err_failed}</p>}
        {pro.length === 0 && <p className="border border-line p-3 text-sm">{m.consent_no_pro}</p>}
      </header>

      <section className="flex flex-col gap-2" data-mcp-url>
        <h2 className="font-semibold">{m.url_title}</h2>
        <code className="select-all break-all border border-line p-3 font-mono text-sm">{url}</code>
        <p className="text-xs text-muted">{m.url_hint}</p>
      </section>

      <section className="flex flex-col gap-2 border-t border-line pt-4">
        <h2 className="font-semibold">{m.how_title}</h2>
        {howTo.map(([name, text]) => (
          <details key={name} className="border border-line p-3">
            <summary className="min-h-11 cursor-pointer py-2 font-medium">{name}</summary>
            <p className="whitespace-pre-line text-sm">{t(text, { url })}</p>
          </details>
        ))}
        <p className="text-xs text-muted">{m.what_it_can}</p>
      </section>

      <section className="flex flex-col gap-3 border-t border-line pt-4" data-mcp-grants>
        <h2 className="font-semibold">{m.grants_title}</h2>
        {grants.length === 0 ? (
          <p className="text-sm text-muted">{m.grants_none}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {grants.map((g) => (
              <li key={g.id} className="flex flex-col gap-1 py-3 text-sm" data-mcp-grant={g.active ? "active" : "ended"}>
                <span className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-semibold">{g.name}</span>
                  <span className="text-muted">{g.kind === "oauth" ? m.kind_oauth : m.kind_key}</span>
                  {!g.active && <span className="text-muted">{m.ended}</span>}
                </span>
                <span>{g.scopes.map((s) => scopeText[s] ?? s).join(" · ")}</span>
                <span className="text-muted">{g.shops.map((s) => s.name).join(", ")}</span>
                <span className="text-xs text-muted">
                  {t(m.created, { date: formatDateTime(g.created_at, lang) })}
                  {g.last_used_at && ` · ${t(m.last_used, { date: formatDateTime(g.last_used_at, lang) })}`}
                  {g.expires_at && g.active && ` · ${t(m.expires, { date: formatDateTime(g.expires_at, lang) })}`}
                </span>
                {g.active && (
                  <form action={disconnectMcp}>
                    <input type="hidden" name="lang" value={lang} />
                    <input type="hidden" name="grant_id" value={g.id} />
                    <button type="submit" className="min-h-11 text-sm underline underline-offset-4" data-mcp-disconnect>
                      {m.disconnect}
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {telegram !== undefined && (
        <section id="telegram" className="flex scroll-mt-20 flex-col gap-3 border-t border-line pt-4" data-telegram>
          <h2 className="font-semibold">{tg.title}</h2>
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
      )}
      {pro.length > 0 && (
        <section className="flex flex-col gap-2 border-t border-line pt-4">
          <h2 className="font-semibold">{m.key_title}</h2>
          <p className="text-sm">{m.key_intro}</p>
          <McpKeyForm action={createMcpKey} shops={pro.map((s) => ({ id: s.shop_id, name: s.name }))} labels={m} />
        </section>
      )}
    </div>
  );
}
