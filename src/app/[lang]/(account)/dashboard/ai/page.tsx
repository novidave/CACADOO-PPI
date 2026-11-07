import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { McpKeyForm } from "@/components/McpKeyForm";
import { formatDateTime } from "@/lib/format";
import { MCP_PATH } from "@/lib/ownerMcpRules";
import { siteUrl } from "@/lib/site";
import Link from "next/link";
import { telegramForwardScript } from "@/lib/dashboardPages";
import { cardClass } from "@/components/owner/ui";
import { createMcpKey, disconnectMcp } from "./actions";
import { PageTitle } from "@/components/owner/PageHead";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/ai">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).nav.ai };
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

/**
 * "Súkromné priečinky a MCP" (2026-11-07; "AI asistenti a Telegram" before — Telegram moved to "SMS a Telegram"): first
 * a card "Súkromné priečinky" (one line + the way to AI asistent → Súkromné priečinky of the open shop), then the owner's
 * MCP server (database update 61; Pro): its address, how to connect Claude, ChatGPT, Gemini, Grok and others, the
 * assistants and keys connected (with "Odpojiť"), and a personal key for clients without OAuth. What an assistant may
 * do is decided in the database for every call. The bot's old links (/dashboard/ai#telegram) and the old forms'
 * ?tg_ok= / ?tg_err= go on to "SMS a Telegram" → Telegram (telegramForwardScript; a plain link without JavaScript).
 */
export default async function AiPage({ params, searchParams }: PageProps<"/[lang]/dashboard/ai">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const m = dict.owner_mcp;
  const [shopsRes, grantsRes, myShops] = await Promise.all([
    session.supabase.rpc("owner_mcp_shops"),
    session.supabase.rpc("owner_mcp_grants"),
    session.supabase.rpc("my_shops"),
  ]);
  // the open shop (?shop=, else the first): its private folders; Telegram's way on keeps the query
  const mine = (myShops.data ?? []) as { slug: string }[];
  const openShop = mine.find((x) => x.slug === first(sp.shop))?.slug ?? mine[0]?.slug ?? null;
  const telegramHref = `/${lang}/dashboard/sms-telegram?${new URLSearchParams({ ...(openShop ? { shop: openShop } : {}), tab: "telegram" })}#telegram`;
  const forward = (
    <>
      <script dangerouslySetInnerHTML={{ __html: telegramForwardScript(lang) }} />
      <p className="text-sm text-muted" data-telegram-moved>
        {dict.smstg.telegram_moved}{" "}
        <Link href={telegramHref} className="font-semibold underline underline-offset-4">
          {dict.nav.sms_tg}
        </Link>
      </p>
    </>
  );
  const folders = (
    <section className={cardClass} data-private-folders-card>
      <h2 className="text-[19px] font-bold">{dict.smstg.folders_title}</h2>
      <p className="text-sm">{dict.smstg.folders_line}</p>
      {openShop && (
        <Link
          href={`/${lang}/dashboard/assistant/folders?${new URLSearchParams({ shop: openShop })}`}
          className="self-start text-sm font-semibold underline underline-offset-4"
          data-private-folders-link
        >
          {dict.smstg.folders_open}
        </Link>
      )}
    </section>
  );
  if (shopsRes.error) {
    return (
      <div className="flex max-w-3xl flex-col gap-4">
        <PageTitle>{dict.nav.ai}</PageTitle>
        {forward}
        {folders}
        <p className="text-sm text-muted">{m.unavailable}</p>
      </div>
    );
  }
  const shops = (shopsRes.data ?? []) as { shop_id: string; slug: string; name: string; has_plan: boolean }[];
  const pro = shops.filter((s) => s.has_plan);
  const grants = (grantsRes.data ?? []) as GrantRow[];
  const url = `${siteUrl()}${MCP_PATH}`;
  const scopeText: Record<string, string> = { "shop.read": m.scope_read_short, "shop.write": m.scope_write_short, "messages.send": m.scope_messages_short };
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
        <PageTitle>{dict.nav.ai}</PageTitle>
        {forward}
      </header>
      {folders}
      <header className="flex flex-col gap-2">
        <h2 className="text-[19px] font-bold">{m.title}</h2>
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
