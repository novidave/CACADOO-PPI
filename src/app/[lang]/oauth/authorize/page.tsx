import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { getSession } from "@/lib/auth";
import { authorizeQuery, readAuthorize, SCOPES } from "@/lib/ownerMcpRules";
import { createPublicClient } from "@/lib/supabase/public";
import { approveMcp, denyMcp } from "./actions";

export const metadata: Metadata = { robots: { index: false, follow: false } };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * "Prepojiť AI asistenta" (database update 61): the owner allows an AI assistant (Claude, ChatGPT, Gemini, …) to work
 * with the shops and scopes they tick. Shown by /api/oauth/authorize after its checks; needs the owner's login.
 */
export default async function AuthorizePage({ params, searchParams }: PageProps<"/[lang]/oauth/authorize">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const query = new URLSearchParams(
    Object.entries(sp).flatMap(([k, v]) => (typeof v === "string" ? [[k, v] as [string, string]] : [])),
  );
  const asked = readAuthorize(query);
  const dict = await getDictionary(lang);
  const m = dict.owner_mcp;
  if ("error" in asked) {
    return <p className="mx-auto max-w-md border border-line p-3">{m.consent_invalid}</p>;
  }
  const session = await getSession().catch(() => null);
  if (!session) redirect(`/${lang}/login?${new URLSearchParams({ next: `/${lang}/oauth/authorize?${authorizeQuery(asked)}` })}`);

  const db = createPublicClient();
  const [{ data: clientData }, { data: shopData }] = await Promise.all([
    db ? db.rpc("owner_mcp_client", { p_client_id: asked.client_id }) : Promise.resolve({ data: null }),
    session.supabase.rpc("owner_mcp_shops"),
  ]);
  const client = clientData as { client_name: string; redirect_uris: string[] } | null;
  if (!client || !client.redirect_uris.includes(asked.redirect_uri)) {
    return <p className="mx-auto max-w-md border border-line p-3">{m.consent_invalid}</p>;
  }
  const shops = (shopData ?? []) as { shop_id: string; slug: string; name: string; has_plan: boolean }[];
  const usable = shops.filter((s) => s.has_plan);
  const host = new URL(asked.redirect_uri).host;
  const err = first(sp.err);
  const scopeText: Record<string, string> = { "shop.read": m.scope_read, "shop.write": m.scope_write, "messages.send": m.scope_messages };
  const hidden = (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="request" value={authorizeQuery(asked)} />
    </>
  );

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4" data-mcp-consent>
      <h1 className="text-2xl font-semibold tracking-tight">{m.consent_title}</h1>
      <p>{t(m.consent_intro, { client: client.client_name })}</p>
      <p className="text-sm text-muted">{t(m.consent_host, { host })}</p>
      {err && <p className="border border-line p-3">{(m as Record<string, string>)[`consent_err_${err}`] ?? m.consent_err_failed}</p>}
      {usable.length === 0 ? (
        <p className="border border-line p-3">{m.consent_no_pro}</p>
      ) : (
        <form action={approveMcp} className="flex flex-col gap-4">
          {hidden}
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 font-semibold">{m.consent_shops}</legend>
            {shops.map((s) => (
              <label key={s.shop_id} className={`flex min-h-11 items-center gap-2 ${s.has_plan ? "" : "text-muted"}`}>
                <input type="checkbox" name="shop" value={s.shop_id} defaultChecked={s.has_plan} disabled={!s.has_plan} className="h-4 w-4 accent-foreground" />
                {s.name}
                {!s.has_plan && <span className="text-xs">({m.pro_only})</span>}
              </label>
            ))}
          </fieldset>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 font-semibold">{m.consent_scopes}</legend>
            {SCOPES.map((s) => (
              <label key={s} className="flex min-h-11 items-start gap-2 py-1">
                <input
                  type="checkbox"
                  name={`scope_${s}`}
                  defaultChecked={asked.scope.includes(s)}
                  disabled={s === "shop.read"}
                  className="mt-1 h-4 w-4 accent-foreground"
                />
                <span className="text-sm">{scopeText[s]}</span>
              </label>
            ))}
          </fieldset>
          <p className="text-xs text-muted">{m.consent_hint}</p>
          <button type="submit" className="min-h-11 rounded border border-foreground px-4 py-2 font-medium" data-mcp-approve>
            {m.consent_allow}
          </button>
        </form>
      )}
      <form action={denyMcp}>
        {hidden}
        <button type="submit" className="min-h-11 text-sm underline underline-offset-4" data-mcp-deny>
          {m.consent_deny}
        </button>
      </form>
    </div>
  );
}
