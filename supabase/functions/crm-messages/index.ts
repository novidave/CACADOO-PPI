/// <reference lib="deno.ns" />
// PPI · crm-messages Edge Function (database update 56, CRM phase 2)
//
// Sends one SMS or e-mail from a contact card in Môj obchod → Kontakty. Called by the website's server action with the
// owner's own login:
//   - action "config": what can be sent here ({email, sms, sms_live}) so the page can say it.
//   - action "send" {contact_id, channel "sms" | "email", template_id?, subject?, body?}: the database writes the
//     message down first (owner_message_queue: members of the shop with the paid plan, the contact's own number or
//     address, the variables filled in, at most 100 per channel and day), then this function sends it and reports the
//     result once (crm_message_result: sent / failed / test). Nothing is sent that is not in the log.
//   - action "alerts" (x-ppi-cron = Vault ppi_crm_cron; database update 59): the e-mails to the shop's owners that wait
//     in shop_owner_alerts — "Nový zákazník, prosím odpovedzte" when a shopper left a phone or e-mail after a question
//     the assistant could not answer — in each owner's language, with the question and a link to the conversation
//     (SITE_URL); never the shopper's number or address. Sent once (crm_alert_result), retried with a pause.
// E-mail goes through Brevo from ALERT_EMAIL_FROM with the shop's name as the sender's name and the shop's e-mail as
// "reply to". SMS goes through one provider behind the SmsProvider interface (SMS_PROVIDER: brevo, twilio; unset or
// "test" = written down as "test", not sent) and takes its parts of the shop's monthly "owner" quota first (database
// update 58: owner_message_queue refuses with sms_quota at the limit). Never logged: numbers, addresses, texts, keys.
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name "crm-messages" → paste this file →
// Deploy, then switch OFF "Verify JWT" (it checks its callers itself). Secrets: BREVO_API_KEY and ALERT_EMAIL_FROM
// (already set for the other functions); SMS_PROVIDER (+ that provider's secrets, below) and SMS_SENDER for real SMS;
// SITE_URL (already set) for the links in the owner e-mails.

import { createClient } from "npm:@supabase/supabase-js@2";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** The database's own reasons, passed on to the page as they are. */
export const REASONS = ["no_plan", "no_recipient", "empty", "subject", "too_long", "too_many", "channel", "sms_quota"] as const;

// ---------------------------------------------------------------- SMS providers (the same block in crm-messages and bookings)
//
// One SMS gateway behind one interface, chosen by the secret SMS_PROVIDER (database update 58, CRM phase 4):
//   - unset or "test": nothing leaves; every SMS is written down as "test" (it still counts in the monthly quota);
//   - "brevo": Brevo transactional SMS (POST https://api.brevo.com/v3/transactionalSMS/send) with BREVO_API_KEY — the
//     key the e-mails already use; sends to Slovakia and the rest of Europe; the account needs SMS credits;
//   - "twilio": Twilio Programmable Messaging (POST /2010-04-01/Accounts/<sid>/Messages.json) with TWILIO_ACCOUNT_SID,
//     TWILIO_AUTH_TOKEN and TWILIO_FROM (a number or an alphanumeric sender) or TWILIO_MESSAGING_SERVICE_SID.
// SMS_SENDER = the sender's name shown on the phone (letters and digits, ≤ 11; default "Cacaduu"). A provider without
// its secrets fails every SMS ("failed", which never counts in the quota) instead of pretending to send. Errors carry
// only the provider's status and code — never the number or the text.

export interface SmsResult {
  ok: boolean;
  ref?: string;
  error?: string;
}

/** One SMS gateway. `live` false = nothing leaves (the message is written down as "test"). */
export interface SmsProvider {
  name: string;
  live: boolean;
  send(to: string, text: string): Promise<SmsResult>;
}

/** No gateway connected: every SMS is written down as "test" and not sent. */
export const testSms: SmsProvider = { name: "test", live: false, send: () => Promise.resolve({ ok: true }) };

// The GSM 03.38 alphabet (as smsParts() in src/lib/crm.ts and crm_sms_parts() in SQL); anything else is Unicode.
const SMS_GSM =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà" +
  "^{}\\[~]|€\f";

/** True when the text fits the GSM alphabet (no Unicode SMS needed). */
export const isGsm = (text: string) => [...text].every((c) => SMS_GSM.includes(c));

/** The sender's name as a phone shows it: letters and digits only, ≤ 11 (or a number of up to 15 digits). */
export function smsSender(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (/^\+?\d{3,15}$/.test(raw)) return raw.replace(/^\+/, "");
  const name = raw.normalize("NFD").replace(/[^A-Za-z0-9]/g, "").slice(0, 11);
  return name || "Cacaduu";
}

type SmsEnv = (name: string) => string | undefined;

const failing = (name: string, error: string): SmsProvider => ({
  name,
  live: true,
  send: () => Promise.resolve({ ok: false, error }),
});

/** Brevo: the request for one transactional SMS. */
export function brevoSmsBody(to: string, text: string, sender: string) {
  return {
    sender,
    recipient: to.replace(/^\+/, ""),
    content: text,
    type: "transactional",
    tag: "cacaduu",
    unicodeEnabled: !isGsm(text),
  };
}

/** Twilio: the form of one message. */
export function twilioSmsForm(to: string, text: string, from: { from?: string; service?: string }) {
  const form = new URLSearchParams({ To: to, Body: text });
  if (from.service) form.set("MessagingServiceSid", from.service);
  else if (from.from) form.set("From", from.from);
  return form;
}

/** The provider named by SMS_PROVIDER, with its secrets read through `env`. */
export function smsProvider(name: string | undefined, env: SmsEnv = () => undefined, fetchImpl: typeof fetch = fetch): SmsProvider {
  const key = (name ?? "").trim().toLowerCase();
  if (key === "" || key === "test") return testSms;
  const timeout = () => AbortSignal.timeout(15_000);
  if (key === "brevo") {
    const apiKey = env("BREVO_API_KEY")?.trim();
    if (!apiKey) return failing("brevo", "brevo is not set up (BREVO_API_KEY)");
    const sender = smsSender(env("SMS_SENDER"));
    return {
      name: "brevo",
      live: true,
      async send(to, text) {
        const res = await fetchImpl("https://api.brevo.com/v3/transactionalSMS/send", {
          method: "POST",
          headers: { "api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(brevoSmsBody(to, text, sender)),
          signal: timeout(),
        }).catch(() => null);
        if (!res) return { ok: false, error: "brevo network" };
        const answer = (await res.json().catch(() => ({}))) as { messageId?: number | string; reference?: string; code?: string };
        if (!res.ok) {
          const why = res.status === 402 ? "no SMS credits" : String(answer.code ?? "").slice(0, 40);
          return { ok: false, error: `brevo ${res.status} ${why}`.trim() };
        }
        const ref = answer.messageId ?? answer.reference;
        return { ok: true, ref: ref === undefined ? undefined : String(ref).slice(0, 100) };
      },
    };
  }
  if (key === "twilio") {
    const sid = env("TWILIO_ACCOUNT_SID")?.trim();
    const token = env("TWILIO_AUTH_TOKEN")?.trim();
    const from = env("TWILIO_FROM")?.trim();
    const service = env("TWILIO_MESSAGING_SERVICE_SID")?.trim();
    if (!sid || !/^AC[0-9a-f]{32}$/i.test(sid) || !token || (!from && !service)) {
      return failing("twilio", "twilio is not set up (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM)");
    }
    return {
      name: "twilio",
      live: true,
      async send(to, text) {
        const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
          method: "POST",
          headers: { Authorization: `Basic ${btoa(`${sid}:${token}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
          body: twilioSmsForm(to, text, { from, service }),
          signal: timeout(),
        }).catch(() => null);
        if (!res) return { ok: false, error: "twilio network" };
        const answer = (await res.json().catch(() => ({}))) as { sid?: string; code?: number | string };
        if (!res.ok) return { ok: false, error: `twilio ${res.status} ${String(answer.code ?? "").slice(0, 20)}`.trim() };
        return { ok: true, ref: answer.sid?.slice(0, 100) };
      },
    };
  }
  return failing(key.slice(0, 20), `unknown SMS_PROVIDER "${key.slice(0, 20)}"`);
}
// ---------------------------------------------------------------- end of the SMS providers

// ---------------------------------------------------------------- e-mail

export interface EmailConfig {
  apiKey: string;
  from: string;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  shopName: string;
  replyTo: string | null;
}

/** Brevo's request for one e-mail: the shop's name as the sender's name, its e-mail as "reply to". */
export function brevoBody(mail: Mail, from: string) {
  const name = mail.shopName.replace(/["<>\r\n]/g, "").trim().slice(0, 70) || "Cacaduu";
  return {
    sender: { name, email: from },
    to: [{ email: mail.to }],
    ...(mail.replyTo && EMAIL.test(mail.replyTo) ? { replyTo: { email: mail.replyTo, name } } : {}),
    subject: mail.subject,
    textContent: mail.text,
  };
}

async function sendEmail(deps: Deps, mail: Mail): Promise<SmsResult> {
  if (!deps.email) return { ok: false, error: "e-mail is not set up (BREVO_API_KEY, ALERT_EMAIL_FROM)" };
  const res = await deps
    .fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": deps.email.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(brevoBody(mail, deps.email.from)),
      signal: AbortSignal.timeout(15_000),
    })
    .catch(() => null);
  if (!res) return { ok: false, error: "network" };
  const answer = (await res.json().catch(() => ({}))) as { messageId?: string; code?: string };
  return res.ok ? { ok: true, ref: answer.messageId } : { ok: false, error: `brevo ${res.status} ${String(answer.code ?? "").slice(0, 40)}`.trim() };
}

// ---------------------------------------------------------------- the request

interface RpcResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}
interface Db {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<RpcResult>;
}
interface Caller extends Db {
  auth: { getUser(token: string): PromiseLike<{ data: { user: { id: string } | null } | null }> };
}

export interface Deps {
  db: Db;
  /** The website's address for links in the owner e-mails (SITE_URL), without a trailing slash. */
  siteUrl?: string | null;
  asCaller: (authorization: string) => Caller;
  email: EmailConfig | null;
  sms: SmsProvider;
  fetch: typeof fetch;
}

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : null);

/** A database refusal as the page's reason: its own words, "forbidden" for another shop, else "failed". */
export function reason(error: { message: string; code?: string }): string {
  const known = REASONS.find((r) => r === error.message);
  if (known) return known;
  if (error.code === "42501") return "forbidden";
  return "failed";
}

interface Queued {
  id: string;
  channel: "sms" | "email";
  recipient: string;
  subject: string | null;
  body: string;
  shop_name: string;
  reply_to: string | null;
}

// ---------------------------------------------------------------- owner e-mails (unanswered questions)

export interface AlertRow {
  id: string;
  shop_name: string;
  kind: "callback";
  conversation_id: string | null;
  question: string | null;
  has_phone: boolean;
  has_email: boolean;
  recipients: { email: string; lang: string }[];
}

const ALERT_TEXTS = {
  sk: {
    subject: "Nový zákazník, prosím odpovedzte – {shop}",
    intro: "Asistent na stránke obchodu {shop} nevedel odpovedať a zákazník vám nechal kontakt.",
    question: "Otázka zákazníka:",
    left: "Zákazník nechal: {what}.",
    phone: "telefón",
    email: "e-mail",
    open: "Otvoriť konverzáciu a odpovedať (SMS alebo e-mailom):",
    footer: "Táto správa prišla z Cacaduu, pretože ste majiteľom obchodu {shop}.",
  },
  hu: {
    subject: "Új ügyfél, kérjük, válaszoljon – {shop}",
    intro: "A(z) {shop} üzlet oldalán az asszisztens nem tudott válaszolni, és az ügyfél elérhetőséget hagyott.",
    question: "Az ügyfél kérdése:",
    left: "Az ügyfél ezt hagyta meg: {what}.",
    phone: "telefonszám",
    email: "e-mail",
    open: "Nyissa meg a beszélgetést és válaszoljon (SMS-ben vagy e-mailben):",
    footer: "Ezt az üzenetet a Cacaduu küldte, mert Ön a(z) {shop} üzlet tulajdonosa.",
  },
  en: {
    subject: "New customer, please reply – {shop}",
    intro: "The assistant on the page of {shop} could not answer, and the customer left you a contact.",
    question: "The customer's question:",
    left: "The customer left: {what}.",
    phone: "a phone number",
    email: "an e-mail address",
    open: "Open the conversation and reply (SMS or e-mail):",
    footer: "This message comes from Cacaduu because you own the shop {shop}.",
  },
} as const;

const fillText = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (all, k: string) => values[k] ?? all);

/** The owner e-mail for one waiting shopper, in the owner's language (Slovak, Hungarian, else English). */
export function alertMail(row: AlertRow, lang: string, siteUrl: string | null) {
  const code = lang === "sk" || lang === "hu" ? lang : lang === "cs" ? "sk" : "en";
  const t = ALERT_TEXTS[code];
  const shop = row.shop_name.replace(/[\r\n]/g, " ").trim().slice(0, 80);
  const what = [row.has_phone ? t.phone : null, row.has_email ? t.email : null].filter(Boolean).join(" + ");
  const link = siteUrl && row.conversation_id ? `${siteUrl}/${code}/dashboard/conversations/${row.conversation_id}` : null;
  const lines = [
    fillText(t.intro, { shop }),
    "",
    ...(row.question ? [t.question, `„${row.question.slice(0, 500)}“`, ""] : []),
    ...(what ? [fillText(t.left, { what }), ""] : []),
    ...(link ? [t.open, link, ""] : []),
    fillText(t.footer, { shop }),
  ];
  return { subject: fillText(t.subject, { shop }), text: lines.join("\n") };
}

async function sendAlerts(deps: Deps): Promise<Response> {
  const { data, error } = await deps.db.rpc("crm_alerts_due", { p_limit: 20 });
  if (error) return reply(500, { error: "failed" });
  let sent = 0;
  for (const row of (data ?? []) as AlertRow[]) {
    const recipients = (row.recipients ?? []).filter((r) => EMAIL.test(r.email ?? ""));
    let result: SmsResult = { ok: false, error: recipients.length ? "e-mail is not set up" : "no owner e-mail" };
    for (const r of recipients) {
      const mail = alertMail(row, r.lang, deps.siteUrl ?? null);
      result = await sendEmail(deps, { to: r.email, subject: mail.subject, text: mail.text, shopName: "Cacaduu", replyTo: null });
      if (!result.ok) break;
    }
    await deps.db.rpc("crm_alert_result", { p_id: row.id, p_ok: result.ok, p_error: result.ok ? null : (result.error ?? "failed") });
    if (result.ok) sent++;
    else console.error("crm-messages: owner e-mail not sent", row.id, (result.error ?? "").slice(0, 80));
  }
  return reply(200, { alerts: sent });
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== "POST") return reply(405, { error: "method" });
  const cron = req.headers.get("x-ppi-cron");
  if (cron !== null) {
    const { data: ok } = await deps.db.rpc("crm_cron_ok", { p_secret: cron });
    if (ok !== true) return reply(403, { error: "forbidden" });
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (body?.action !== "alerts") return reply(400, { error: "bad_request" });
    return await sendAlerts(deps);
  }
  const authorization = req.headers.get("Authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) return reply(401, { error: "login" });
  const caller = deps.asCaller(authorization);
  const { data: auth } = await caller.auth.getUser(token);
  if (!auth?.user) return reply(401, { error: "login" });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = body?.action;

  if (action === "config") return reply(200, { email: Boolean(deps.email), sms: deps.sms.name, sms_live: deps.sms.live });
  if (action !== "send" || !body) return reply(400, { error: "bad_request" });

  const contact = String(body.contact_id ?? "");
  const channel = body.channel;
  const template = body.template_id ? String(body.template_id) : null;
  if (!UUID.test(contact) || (channel !== "sms" && channel !== "email") || (template !== null && !UUID.test(template))) {
    return reply(400, { error: "bad_request" });
  }
  const queued = await caller.rpc("owner_message_queue", {
    p_contact_id: contact,
    p_channel: channel,
    p_template_id: template,
    p_subject: text(body.subject, 400),
    p_body: text(body.body, 12_000),
  });
  if (queued.error) return reply(queued.error.code === "42501" ? 403 : 400, { error: reason(queued.error) });
  const message = queued.data as Queued;

  let result: SmsResult;
  let provider: string;
  let status: "sent" | "failed" | "test";
  if (message.channel === "email") {
    provider = "brevo";
    result = await sendEmail(deps, {
      to: message.recipient,
      subject: message.subject ?? "",
      text: message.body,
      shopName: message.shop_name,
      replyTo: message.reply_to,
    });
    status = result.ok ? "sent" : "failed";
  } else {
    provider = deps.sms.name;
    result = await deps.sms.send(message.recipient, message.body).catch((e) => ({ ok: false, error: String(e).slice(0, 200) }));
    status = !result.ok ? "failed" : deps.sms.live ? "sent" : "test";
  }
  const reported = await deps.db.rpc("crm_message_result", {
    p_id: message.id,
    p_status: status,
    p_provider: provider,
    p_ref: result.ref ?? null,
    p_error: result.error ?? null,
  });
  if (reported.error) console.error("crm-messages: result not stored", message.id, reported.error.code ?? "");
  if (status === "failed") console.error("crm-messages: not sent", message.id, provider, (result.error ?? "").slice(0, 120));
  return reply(200, { id: message.id, status });
}

export async function handler(req: Request): Promise<Response> {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return reply(500, { error: "config" });
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const apiKey = Deno.env.get("BREVO_API_KEY")?.trim();
  const from = Deno.env.get("ALERT_EMAIL_FROM")?.trim();
  return await handle(req, {
    db: createClient(url, serviceKey, options),
    asCaller: (authorization) =>
      createClient(url, anonKey, { ...options, global: { headers: { Authorization: authorization } } }) as unknown as Caller,
    email: apiKey && from ? { apiKey, from } : null,
    siteUrl: (Deno.env.get("SITE_URL") ?? "").trim().replace(/\/+$/, "") || null,
    sms: smsProvider(Deno.env.get("SMS_PROVIDER"), (name) => Deno.env.get(name), fetch),
    fetch,
  });
}

if (!Deno.env.get("PPI_FUNCTION_TEST")) Deno.serve(handler);
