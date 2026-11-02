// PPI · Edge Function "sklad" (database update 67: "Sklad v Cacaduu"). One file, paste-deployable; Verify JWT OFF —
// it checks its caller itself.
//
// Only the job calls it: pg_cron "ppi-sklad-tick" every 15 minutes, header x-ppi-cron = Vault "ppi_sklad_cron"
// (checked in SQL by sklad_cron_ok), body {"action": "tick"}. Each tick:
//   1. reminders — sklad_reminders_due() claims the shops whose reminder time has come today (shop's time zone) with no
//      movement and no "Stav je správny" today, and gives their owners' e-mails and languages; one Brevo e-mail each:
//      "Potvrďte stav skladu – <shop>" with the link to Môj obchod → Sklad. Without BREVO_API_KEY / ALERT_EMAIL_FROM the
//      e-mails are skipped (the banner in Môj obchod still shows);
//   2. IndexNow — for the shops in Sklad mode whose products changed, the same ping stock-pull sends after a file
//      (indexnow_claim_host: at most once an hour per host; INDEXNOW_KEY + SITE_URL, else skipped).
// Never logs an address, a key or a shop's data; only counts.

import { createClient } from "npm:@supabase/supabase-js@2";

const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[a-z]{2,24}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------- the reminder e-mail (sk / hu / else en)

const TEXTS = {
  sk: {
    subject: "Potvrďte stav skladu – {shop}",
    body:
      "Dobrý deň,\n\nv Sklade obchodu {shop} dnes ešte nebol žiadny pohyb. Ak zásoba sedí, potvrďte ju jedným ťuknutím na „Stav je správny“ – inak sa zásoba na stránke obchodu po 24 hodinách od posledného pohybu skryje, aby zákazníci nevideli starý stav.\n\n{link}\n\nPripomienku vypnete alebo zmeníte jej čas v Môj obchod → Sklad → Nastavenia.\n\nCacaduu",
  },
  hu: {
    subject: "Erősítse meg a készletet – {shop}",
    body:
      "Jó napot!\n\nA(z) {shop} üzlet Raktárában ma még nem volt mozgás. Ha a készlet rendben van, erősítse meg egy koppintással: „A készlet rendben van” – különben az utolsó mozgás után 24 órával elrejtjük az üzlet oldalán, hogy a vásárlók ne lássanak régi állapotot.\n\n{link}\n\nAz emlékeztetőt a Saját üzlet → Raktár → Beállítások részben kapcsolhatja ki vagy módosíthatja.\n\nCacaduu",
  },
  en: {
    subject: "Confirm your stock – {shop}",
    body:
      "Hello,\n\nthere has been no movement in the Stock of {shop} today. If the stock is right, confirm it with one tap on “Stock is correct” – otherwise it is hidden on your shop page 24 hours after the last movement, so shoppers never see an old state.\n\n{link}\n\nTurn the reminder off or change its time in My shop → Stock → Settings.\n\nCacaduu",
  },
} as const;

type Lang = keyof typeof TEXTS;
const langOf = (l: unknown): Lang => (l === "sk" || l === "hu" ? l : "en");
const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (all, k: string) => values[k] ?? all);

export function reminderMail(shopName: string, shopSlug: string, lang: unknown, siteUrl: string | null) {
  const l = langOf(lang);
  const name = shopName.replace(/[\r\n]/g, " ").trim().slice(0, 120);
  const link = siteUrl ? `${siteUrl}/${l}/dashboard/sklad?${new URLSearchParams({ shop: shopSlug })}` : "";
  return { subject: fill(TEXTS[l].subject, { shop: name }), text: fill(TEXTS[l].body, { shop: name, link }).replace("\n\n\n\n", "\n\n") };
}

// ---------------------------------------------------------------- IndexNow (as stock-pull, update 36)

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const INDEXNOW_MAX_URLS = 10_000;
const SITE_LANGS = ["sk", "hu", "en"];
const INDEXNOW_MAX_ITEMS = Math.floor(INDEXNOW_MAX_URLS / SITE_LANGS.length);
const INDEXNOW_KEY = /^[A-Za-z0-9-]{8,128}$/;
const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

interface IndexNowHostClaim {
  host: string;
  kind: "site" | "main";
  items?: { id: string; slug: string }[];
  lang?: string | null;
  upto?: string;
  upto_id?: string;
  skip?: "hour" | "nothing";
}

export function indexNowUrls(claim: IndexNowHostClaim): string[] {
  const items = claim.items ?? [];
  if (!items.length || !HOST.test(claim.host)) return [];
  const base = `https://${claim.host}`;
  const langs = claim.kind === "site" && claim.lang && SITE_LANGS.includes(claim.lang)
    ? [claim.lang, ...SITE_LANGS.filter((l) => l !== claim.lang)]
    : SITE_LANGS;
  const urls: string[] = [];
  for (const item of items) {
    if (!UUID.test(item.id)) continue;
    for (const lang of langs) urls.push(`${base}/${lang}/items/${item.id}`);
  }
  return urls.slice(0, INDEXNOW_MAX_URLS);
}

// ---------------------------------------------------------------- the request

interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}
interface Db {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<RpcResult>;
}

export interface Deps {
  db: Db;
  email: { apiKey: string; from: string } | null;
  siteUrl: string | null;
  indexNowKey: string | null;
  mainHost: string | null;
  fetch: typeof fetch;
}

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function sendMail(deps: Deps, to: string, mail: { subject: string; text: string }): Promise<boolean> {
  if (!deps.email || !EMAIL.test(to)) return false;
  const res = await deps
    .fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": deps.email.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ sender: { name: "Cacaduu", email: deps.email.from }, to: [{ email: to }], subject: mail.subject, textContent: mail.text }),
      signal: AbortSignal.timeout(15_000),
    })
    .catch(() => null);
  await res?.body?.cancel().catch(() => {});
  return !!res?.ok;
}

async function reminders(deps: Deps) {
  const { data, error } = await deps.db.rpc("sklad_reminders_due", {});
  if (error) {
    console.error("sklad: reminders", error.message.slice(0, 80));
    return { shops: 0, sent: 0 };
  }
  const due = (data ?? []) as { shop_id: string; shop_name: string; shop_slug: string; recipients: { email: string; lang: string }[] }[];
  let sent = 0;
  for (const shop of due) {
    for (const r of shop.recipients ?? []) {
      if (await sendMail(deps, r.email, reminderMail(shop.shop_name, shop.shop_slug, r.lang, deps.siteUrl))) sent++;
    }
  }
  return { shops: due.length, sent };
}

async function indexNow(deps: Deps) {
  if (!deps.indexNowKey) return { pinged: 0 };
  const { data, error } = await deps.db.rpc("sklad_indexnow_shops", {});
  if (error) return { pinged: 0 };
  let pinged = 0;
  for (const shopId of (data ?? []) as string[]) {
    const claimed = await deps.db.rpc("indexnow_claim_host", { p_shop_id: shopId, p_main_host: deps.mainHost, p_max_items: INDEXNOW_MAX_ITEMS });
    if (claimed.error || !claimed.data) continue;
    const claim = claimed.data as IndexNowHostClaim;
    if (claim.skip) continue;
    const urls = indexNowUrls(claim);
    if (!urls.length) continue;
    let status: number | null = null;
    let result = "failed";
    try {
      const res = await deps.fetch(INDEXNOW_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ host: claim.host, key: deps.indexNowKey, keyLocation: `https://${claim.host}/${deps.indexNowKey}.txt`, urlList: urls }),
        signal: AbortSignal.timeout(15_000),
      });
      status = res.status;
      await res.body?.cancel().catch(() => {});
      result = String(res.status);
    } catch (e) {
      result = `failed: ${e instanceof Error ? e.name : "error"}`;
    }
    await deps.db.rpc("indexnow_done", {
      p_host: claim.host, p_kind: claim.kind, p_upto: claim.upto ?? null, p_upto_id: claim.upto_id ?? null,
      p_urls: urls.length, p_status: status, p_result: result,
    });
    if (status !== null && status < 400) pinged++;
  }
  return { pinged };
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== "POST") return reply(405, { error: "method" });
  const cron = req.headers.get("x-ppi-cron");
  if (!cron) return reply(401, { error: "unauthorized" });
  const { data: ok } = await deps.db.rpc("sklad_cron_ok", { p_secret: cron });
  if (ok !== true) return reply(403, { error: "forbidden" });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (body?.action !== "tick") return reply(400, { error: "bad_request" });
  const r = await reminders(deps);
  const i = await indexNow(deps);
  if (r.shops || i.pinged) console.log(`sklad: reminders ${r.shops} shops, ${r.sent} e-mails; IndexNow ${i.pinged}`);
  return reply(200, { reminders: r, indexnow: i });
}

export async function handler(req: Request): Promise<Response> {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return reply(500, { error: "config" });
  const apiKey = Deno.env.get("BREVO_API_KEY")?.trim();
  const from = Deno.env.get("ALERT_EMAIL_FROM")?.trim();
  const site = (Deno.env.get("SITE_URL") ?? "").trim().replace(/\/+$/, "");
  let mainHost: string | null = null;
  try {
    const u = new URL(site);
    if (u.protocol === "https:" && HOST.test(u.hostname.toLowerCase())) mainHost = u.hostname.toLowerCase();
  } catch {
    // no SITE_URL
  }
  const key = (Deno.env.get("INDEXNOW_KEY") ?? "").trim();
  return await handle(req, {
    db: createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } }),
    email: apiKey && from ? { apiKey, from } : null,
    siteUrl: site.startsWith("https://") ? site : null,
    indexNowKey: INDEXNOW_KEY.test(key) ? key : null,
    mainHost,
    fetch,
  });
}

if (!Deno.env.get("PPI_FUNCTION_TEST")) Deno.serve(handler);
