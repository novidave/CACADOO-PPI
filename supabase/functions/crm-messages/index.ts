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
// E-mail goes through Brevo from ALERT_EMAIL_FROM with the shop's name as the sender's name and the shop's e-mail as
// "reply to". SMS goes through one provider behind the SmsProvider interface; without SMS_PROVIDER (or "test") an SMS
// is written down as "test" and not sent (the real provider and the monthly quotas come in phase 4). Never logged:
// numbers, addresses, texts, keys.
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name "crm-messages" → paste this file →
// Deploy, then switch OFF "Verify JWT" (it checks its callers itself). Secrets: BREVO_API_KEY and ALERT_EMAIL_FROM
// (already set for the other functions); SMS_PROVIDER only from phase 4.

import { createClient } from "npm:@supabase/supabase-js@2";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** The database's own reasons, passed on to the page as they are. */
export const REASONS = ["no_plan", "no_recipient", "empty", "subject", "too_long", "too_many", "channel"] as const;

// ---------------------------------------------------------------- SMS providers

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

/** No gateway connected yet: every SMS is written down as "test" and not sent. */
export const testSms: SmsProvider = { name: "test", live: false, send: () => Promise.resolve({ ok: true }) };

/** The provider named by SMS_PROVIDER (phase 4 adds the real ones); an unknown name fails every SMS. */
export function smsProvider(name: string | undefined): SmsProvider {
  const key = (name ?? "").trim().toLowerCase();
  if (key === "" || key === "test") return testSms;
  return { name: key, live: true, send: () => Promise.resolve({ ok: false, error: `unknown SMS_PROVIDER "${key.slice(0, 20)}"` }) };
}

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

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== "POST") return reply(405, { error: "method" });
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
    sms: smsProvider(Deno.env.get("SMS_PROVIDER")),
    fetch,
  });
}

if (!Deno.env.get("PPI_FUNCTION_TEST")) Deno.serve(handler);
