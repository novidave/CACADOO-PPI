/// <reference lib="deno.ns" />
// PPI · bookings Edge Function (database update 57, CRM phase 3)
//
// Bookings through the shop assistant, the shop's Google Calendar, the SMS code and the day-before reminder:
//   - website (header x-ppi-website = ASSISTANT_ARCHIVE_SECRET, the secret the website already shares with Supabase):
//       slots  {slug, from?, days?}  the free times (booking_slots: inside the opening hours, no other booking) minus the
//                                    busy times of the shop's Google Calendar (free/busy only)
//       start  {slug, starts_at, name, phone, email?, address?, note?, consent, consent_version, lang, caller,
//               conversation_id?, conversation_token?}  holds the time 10 minutes (booking_start) and sends the 6-digit
//                                    code by SMS; the code is never stored or logged, the message log masks it
//       resend {id, token}           a new code (at most 3 per booking)
//       verify {id, token, code}     the right code confirms at once: Google is checked again, the event inserted
//                                    (calendar.events.owned; nothing else is ever changed or read in the calendar),
//                                    then booking_confirm (contact by the number, conversation linked). No confirmation SMS.
//   - owners (their login): google_connect {shop_id, return_url} → {url}; google_disconnect {shop_id}
//   - GET /bookings/oauth: Google's answer (code + PKCE, state SHA-256, single use, 10 minutes)
//   - website, update 63 (the shop assistant's tools; every rule is in SQL, nothing is trusted from the browser or the AI):
//       code_start  {slug, purpose contact|delete_all, phone, name?, consent_version?, caller, conversation_id?,
//                    conversation_token?, lang?}  a 6-digit SMS code (sms_code_start: 10 min, 5 tries, 3/number and
//                    10/caller an hour, the booking SMS quota); the code is typed into the page's own field, never
//                    sent to the AI, never stored or logged (the message log masks it)
//       code_verify {id, code, conversation_id?, conversation_token?}  sms_code_verify: contact made or merged by the
//                    number, the conversation may book for it
//       services    {slug}  the services the assistant may offer
//       offer       {slug, conversation_id, conversation_token, service_id, from, to, people?}  free starts with short
//                    refs (booking_offer_slots = booking_free_slots); a connected calendar's busy times are read first
//       book        {slug, conversation_id, conversation_token, ref, people?}  booking_assistant_book → booking_create
//                    checks the slot again; confirmed at once (no confirmation SMS, no cancel link)
//   - the job every 5 minutes (x-ppi-cron = Vault ppi_bookings_cron): tick → reminders (2 h before, or the day before
//     from 18:00 — crm_settings), the customer's SMS when the owner moved or cancelled (3 tries), the calendar pushes
//     (only events Cacaduu made: create / update / delete by google_event_id; 3 tries; a failure never blocks a
//     booking) and the busy times of connected calendars (booking_calendar_busy)
// SMS go through the SmsProvider interface (SMS_PROVIDER: brevo, twilio; unset = "test": written down, never sent).
// Every SMS is written down first and takes its parts of the shop's monthly "booking" quota (database update 58:
// booking_sms_claim → send → booking_sms_settle; at the limit nothing is sent: sms_quota). For testing without a
// provider, BOOKING_TEST_CODES=on returns the code to the chat; it is ignored while a real provider is set.
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name "bookings" → paste this file → Deploy,
// then switch OFF "Verify JWT". Secrets: GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET (optional: without
// them bookings work without Google), BOOKING_TOKEN_ENCRYPTION_KEY (32+ characters; else EXPORT_TOKEN_ENCRYPTION_KEY),
// ASSISTANT_ARCHIVE_SECRET (already set), SMS_PROVIDER + its secrets and SMS_SENDER (below).

import { createClient } from "npm:@supabase/supabase-js@2";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";
export const CALENDAR = "https://www.googleapis.com/calendar/v3";
/** Free/busy to read, events on calendars the shop owns to insert — nothing more. */
export const SCOPE = "https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.events.owned";
/** The database's own refusals, passed to the chat as they are. */
export const REASONS = ["not_available", "consent", "name", "phone", "email", "too_many", "slot_taken"] as const;

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
export const hashText = async (text: string) => hex(await sha256(enc.encode(text)));

function sameText(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---------------------------------------------------------------- tokens, encrypted

/** AES-GCM key (HKDF-SHA-256) from BOOKING_TOKEN_ENCRYPTION_KEY (or EXPORT_TOKEN_ENCRYPTION_KEY), 32+ characters. */
export async function tokenKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error("BOOKING_TOKEN_ENCRYPTION_KEY must have at least 32 characters");
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("ppi-bookings"), info: enc.encode("google tokens v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** "v1.<iv>.<data>", bound to its shop and use (the same text elsewhere does not open). */
export async function encryptToken(key: CryptoKey, plain: string, bind: string): Promise<string> {
  const iv = random(12);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: enc.encode(bind) }, key, enc.encode(plain));
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(data))}`;
}

export async function decryptToken(key: CryptoKey, text: string, bind: string): Promise<string> {
  const [version, iv, data] = text.split(".");
  if (version !== "v1" || !iv || !data) throw new Error("unknown token format");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64url(iv) as BufferSource, additionalData: enc.encode(bind) },
    key,
    fromB64url(data) as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

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

/** The texts the shopper gets by SMS, in the booking's language (Slovak, Hungarian, else English). */
export function smsText(
  kind: "code" | "reminder" | "contact_code" | "forget_code" | "moved" | "cancelled" | "reminder_at",
  lang: string | null,
  v: { shop: string; code?: string; time?: string; day?: string; service?: string | null; phone?: string | null },
) {
  const l = (lang ?? "").slice(0, 2);
  const shop = v.shop.slice(0, 40);
  const what = v.service ? ` (${v.service.slice(0, 40)})` : "";
  const call = v.phone ? (l === "hu" ? ` Kérdés: ${v.phone}` : l === "sk" ? ` Otázky: ${v.phone}` : ` Questions: ${v.phone}`) : "";
  if (kind === "contact_code") {
    if (l === "sk") return `${shop}: váš overovací kód je ${v.code}. Platí 10 minút. Nikomu ho neposielajte.`;
    if (l === "hu") return `${shop}: az ellenőrző kódja ${v.code}. 10 percig érvényes. Ne adja tovább senkinek.`;
    return `${shop}: your verification code is ${v.code}. Valid for 10 minutes. Do not share it.`;
  }
  if (kind === "forget_code") {
    if (l === "sk") return `${shop}: kód na vymazanie vašich údajov je ${v.code}. Platí 10 minút.`;
    if (l === "hu") return `${shop}: az adatai törlésének kódja ${v.code}. 10 percig érvényes.`;
    return `${shop}: the code to delete your data is ${v.code}. Valid for 10 minutes.`;
  }
  if (kind === "moved") {
    if (l === "sk") return `${shop}: vaša rezervácia${what} bola presunutá na ${v.day} o ${v.time}.${call}`;
    if (l === "hu") return `${shop}: foglalását${what} áthelyeztük: ${v.day}, ${v.time}.${call}`;
    return `${shop}: your booking${what} was moved to ${v.day} at ${v.time}.${call}`;
  }
  if (kind === "cancelled") {
    if (l === "sk") return `${shop}: vaša rezervácia${what} ${v.day} o ${v.time} bola zrušená.${call}`;
    if (l === "hu") return `${shop}: foglalását${what} (${v.day}, ${v.time}) lemondtuk.${call}`;
    return `${shop}: your booking${what} on ${v.day} at ${v.time} was cancelled.${call}`;
  }
  if (kind === "reminder_at") {
    if (l === "sk") return `${shop}: pripomíname vašu rezerváciu${what} ${v.day} o ${v.time}.`;
    if (l === "hu") return `${shop}: emlékeztetjük a foglalására${what}: ${v.day}, ${v.time}.`;
    return `${shop}: a reminder of your booking${what} on ${v.day} at ${v.time}.`;
  }
  if (kind === "code") {
    if (l === "sk") return `${shop}: kód pre vašu rezerváciu je ${v.code}. Platí 10 minút.`;
    if (l === "hu") return `${shop}: a foglalás kódja ${v.code}. 10 percig érvényes.`;
    return `${shop}: your booking code is ${v.code}. Valid for 10 minutes.`;
  }
  if (l === "sk") return `${shop}: pripomíname vašu rezerváciu${what} zajtra o ${v.time}.`;
  if (l === "hu") return `${shop}: emlékeztetjük a holnapi foglalására${what}, ${v.time}.`;
  return `${shop}: a reminder of your booking${what} tomorrow at ${v.time}.`;
}

/** "14:30" in the shop's time zone. */
export const localTime = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

/** "10. 11." in the shop's time zone (day and month, the shopper's own date). */
export const localDay = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("sk-SK", { timeZone, day: "numeric", month: "numeric" }).format(new Date(iso)).replace(/\s/g, " ");

/** "+421 ••• ••• 222": enough for the shopper to recognise the number. */
export const maskPhone = (phone: string) => `${phone.slice(0, 4)} ••• ••• ${phone.slice(-3)}`;

// ---------------------------------------------------------------- Google Calendar

export interface Busy {
  start: string;
  end: string;
}

/** Busy intervals of the shop's primary calendar between two instants (free/busy only; never the events). */
export async function freeBusy(fetchImpl: typeof fetch, access: string, timeMin: string, timeMax: string): Promise<Busy[]> {
  const res = await fetchImpl(`${CALENDAR}/freeBusy`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin, timeMax, items: [{ id: "primary" }] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`freeBusy ${res.status}`);
  const data = (await res.json()) as { calendars?: Record<string, { busy?: Busy[]; errors?: unknown[] }> };
  const cal = data.calendars?.primary;
  if (cal?.errors?.length) throw new Error("freeBusy calendar error");
  return cal?.busy ?? [];
}

export const overlaps = (aStart: string, aEnd: string, busy: Busy[]) =>
  busy.some((b) => new Date(b.start) < new Date(aEnd) && new Date(b.end) > new Date(aStart));

export interface Confirmed {
  shop_name: string;
  timezone: string;
  starts_at: string;
  ends_at: string;
  name: string;
  phone: string;
  email: string | null;
  address: string | null;
  note: string | null;
  service_name: string | null;
}

/** The event as Google gets it: the shop's own words, no attendees, no e-mails from Google. */
export function eventBody(b: Confirmed) {
  const lines = [
    `Telefón / Phone: ${b.phone}`,
    b.email ? `E-mail: ${b.email}` : "",
    b.address ? `Adresa / Address: ${b.address}` : "",
    b.note ? `Poznámka / Note: ${b.note}` : "",
    "Cacaduu",
  ].filter(Boolean);
  return {
    summary: `${b.service_name ?? "Rezervácia"}: ${b.name}`.slice(0, 200),
    description: lines.join("\n"),
    start: { dateTime: b.starts_at, timeZone: b.timezone },
    end: { dateTime: b.ends_at, timeZone: b.timezone },
    reminders: { useDefault: true },
  };
}

// ---------------------------------------------------------------- dependencies

interface RpcResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}
interface Db {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<RpcResult>;
  /** the service client's table reads (only the job's list of connected calendars) */
  from?(table: string): {
    select(columns: string): { eq(column: string, value: unknown): { limit(n: number): PromiseLike<{ data: unknown }> } };
  };
}
interface Caller extends Db {
  auth: { getUser(token: string): PromiseLike<{ data: { user: { id: string } | null } | null }> };
}

export interface Deps {
  db: Db;
  asCaller: (authorization: string) => Caller;
  websiteSecret: string | null;
  google: { clientId: string; clientSecret: string } | null;
  key: CryptoKey | null;
  /** https://<project>.supabase.co/functions/v1/bookings */
  selfUrl: string;
  sms: SmsProvider;
  showTestCodes: boolean;
  fetch: typeof fetch;
}

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const reasonOf = (error: { message: string }) => REASONS.find((r) => r === error.message) ?? "failed";

// ---------------------------------------------------------------- the shop's Google access

/** A working access token for the shop (renewed when it runs out), or null (not connected, expired, failing). */
export async function googleAccess(deps: Deps, shopId: string): Promise<string | null> {
  if (!deps.google || !deps.key) return null;
  const { data } = await deps.db.rpc("booking_google_token", { p_shop_id: shopId });
  const row = (Array.isArray(data) ? data[0] : data) as
    | { access_token_enc: string; refresh_token_enc: string; access_expires_at: string | null; status: string }
    | undefined;
  if (!row || row.status !== "ok") return null;
  try {
    if (row.access_expires_at && new Date(row.access_expires_at).getTime() > Date.now() + 60_000) {
      return await decryptToken(deps.key, row.access_token_enc, `${shopId}:google:access`);
    }
    const refresh = await decryptToken(deps.key, row.refresh_token_enc, `${shopId}:google:refresh`);
    const res = await deps.fetch(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: deps.google.clientId,
        client_secret: deps.google.clientSecret,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const answer = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !answer.access_token) {
      const expired = answer.error === "invalid_grant";
      await deps.db.rpc("booking_google_failed", {
        p_shop_id: shopId,
        p_status: expired ? "expired" : "error",
        p_error: `token ${res.status} ${String(answer.error ?? "").slice(0, 40)}`,
      });
      return null;
    }
    await deps.db.rpc("booking_google_refreshed", {
      p_shop_id: shopId,
      p_access_enc: await encryptToken(deps.key, answer.access_token, `${shopId}:google:access`),
      p_expires_at: new Date(Date.now() + (answer.expires_in ?? 3600) * 1000).toISOString(),
    });
    return answer.access_token;
  } catch (e) {
    console.error("bookings: google access", shopId, (e instanceof Error ? e.message : String(e)).slice(0, 120));
    return null;
  }
}

interface Shop {
  shop_id: string;
  timezone: string;
  shop_name: string;
  service_name: string | null;
  duration_minutes: number;
  google: boolean;
}

async function bookableShop(deps: Deps, slug: string): Promise<Shop | null> {
  const { data } = await deps.db.rpc("booking_shop", { p_slug: slug });
  return ((Array.isArray(data) ? data[0] : data) as Shop | undefined) ?? null;
}

// ---------------------------------------------------------------- website actions

async function slots(body: Record<string, unknown>, deps: Deps) {
  const slug = String(body.slug ?? "");
  if (!SLUG.test(slug)) return reply(400, { error: "bad_request" });
  const shop = await bookableShop(deps, slug);
  if (!shop) return reply(200, { available: false, slots: [] });
  const from = DAY.test(String(body.from ?? "")) ? String(body.from) : null;
  const days = Math.min(Math.max(Math.floor(Number(body.days) || 7), 1), 14);
  const { data, error } = await deps.db.rpc("booking_slots", { p_slug: slug, p_from: from, p_days: days });
  if (error) return reply(500, { error: "failed" });
  let list = ((data ?? []) as { starts_at: string; ends_at: string }[]).slice(0, 300);
  if (shop.google && list.length) {
    const access = await googleAccess(deps, shop.shop_id);
    if (access) {
      try {
        const busy = await freeBusy(deps.fetch, access, list[0].starts_at, list[list.length - 1].ends_at);
        list = list.filter((s) => !overlaps(s.starts_at, s.ends_at, busy));
      } catch (e) {
        // Without Google's answer the times stay (the time is checked again before the booking is confirmed).
        console.error("bookings: freeBusy", shop.shop_id, (e instanceof Error ? e.message : String(e)).slice(0, 80));
      }
    }
  }
  return reply(200, {
    available: true,
    timezone: shop.timezone,
    service_name: shop.service_name,
    duration_minutes: shop.duration_minutes,
    slots: list,
  });
}

/**
 * One SMS of a booking: written down first (its parts of the "booking" quota taken — "quota" when the month's SMS are
 * used up, nothing sent), then sent, then its result stored once.
 */
async function sendSms(
  deps: Deps,
  booking: string,
  kind: "booking_code" | "booking_reminder",
  phone: string,
  text: string,
): Promise<"sent" | "test" | "failed" | "quota"> {
  const claimed = await deps.db.rpc("booking_sms_claim", { p_booking_id: booking, p_kind: kind, p_body: text });
  if (claimed.error) return claimed.error.message === "sms_quota" ? "quota" : "failed";
  const result = await deps.sms.send(phone, text).catch((e) => ({ ok: false, error: String(e).slice(0, 200) }) as SmsResult);
  const status = !result.ok ? "failed" : deps.sms.live ? "sent" : "test";
  await deps.db.rpc("booking_sms_settle", {
    p_id: claimed.data as string,
    p_status: status,
    p_provider: deps.sms.name,
    p_ref: result.ref ?? null,
    p_error: result.error ?? null,
  });
  if (status === "failed") console.error("bookings: SMS not sent", booking, deps.sms.name, (result.error ?? "").slice(0, 80));
  return status;
}

async function start(body: Record<string, unknown>, deps: Deps) {
  const slug = String(body.slug ?? "");
  const startsAt = String(body.starts_at ?? "");
  if (!SLUG.test(slug) || Number.isNaN(Date.parse(startsAt))) return reply(400, { error: "bad_request" });
  const shop = await bookableShop(deps, slug);
  if (!shop) return reply(400, { error: "not_available" });
  // Busy in Google already: nothing is held.
  if (shop.google) {
    const access = await googleAccess(deps, shop.shop_id);
    if (access) {
      const end = new Date(Date.parse(startsAt) + shop.duration_minutes * 60_000).toISOString();
      const busy = await freeBusy(deps.fetch, access, new Date(startsAt).toISOString(), end).catch(() => [] as Busy[]);
      if (overlaps(startsAt, end, busy)) return reply(400, { error: "slot_taken" });
    }
  }
  const str = (k: string, max: number) => (typeof body[k] === "string" ? (body[k] as string).slice(0, max) : null);
  const conversation = UUID.test(String(body.conversation_id ?? "")) ? String(body.conversation_id) : null;
  const { data, error } = await deps.db.rpc("booking_start", {
    p_slug: slug,
    p_starts_at: new Date(startsAt).toISOString(),
    p_name: str("name", 120),
    p_phone: str("phone", 40),
    p_email: str("email", 254),
    p_address: str("address", 300),
    p_note: str("note", 500),
    p_consent: body.consent === true,
    p_consent_version: str("consent_version", 40),
    p_lang: str("lang", 12),
    p_caller_hash: str("caller", 128),
    p_conversation_id: conversation,
    p_conversation_token: conversation ? str("conversation_token", 128) : null,
  });
  if (error) return reply(400, { error: reasonOf(error) });
  const held = data as { id: string; token: string; code: string; phone: string; shop_name: string; expires_at: string; lang: string | null };
  const sms = await sendSms(deps, held.id, "booking_code", held.phone, smsText("code", held.lang, { shop: held.shop_name, code: held.code }));
  if (sms === "failed" || sms === "quota") {
    await deps.db.rpc("booking_release", { p_id: held.id, p_reason: "code_expired" });
    return sms === "quota" ? reply(429, { error: "sms_quota" }) : reply(502, { error: "sms_failed" });
  }
  return reply(200, {
    id: held.id,
    token: held.token,
    expires_at: held.expires_at,
    phone: maskPhone(held.phone),
    sms,
    ...(sms === "test" && deps.showTestCodes ? { test_code: held.code } : {}),
  });
}

async function resend(body: Record<string, unknown>, deps: Deps) {
  const id = String(body.id ?? "");
  if (!UUID.test(id)) return reply(400, { error: "bad_request" });
  const { data, error } = await deps.db.rpc("booking_resend", { p_id: id, p_token: String(body.token ?? "") });
  if (error) return reply(500, { error: "failed" });
  const r = data as { ok: boolean; reason?: string; code?: string; phone?: string; shop_name?: string; lang?: string | null; expires_at?: string };
  if (!r.ok) return reply(400, { error: r.reason ?? "failed" });
  const sms = await sendSms(deps, id, "booking_code", r.phone!, smsText("code", r.lang ?? null, { shop: r.shop_name ?? "", code: r.code }));
  if (sms === "quota") return reply(429, { error: "sms_quota" });
  if (sms === "failed") return reply(502, { error: "sms_failed" });
  return reply(200, { ok: true, expires_at: r.expires_at, sms, ...(sms === "test" && deps.showTestCodes ? { test_code: r.code } : {}) });
}

async function verify(body: Record<string, unknown>, deps: Deps) {
  const id = String(body.id ?? "");
  if (!UUID.test(id)) return reply(400, { error: "bad_request" });
  const { data, error } = await deps.db.rpc("booking_verify", {
    p_id: id,
    p_token: String(body.token ?? ""),
    p_code: String(body.code ?? "").replace(/\s/g, "").slice(0, 12),
  });
  if (error) return reply(500, { error: "failed" });
  const v = data as { ok: boolean; reason?: string; attempts_left?: number; shop_id?: string; google?: boolean } & Partial<Confirmed>;
  if (!v.ok) return reply(400, { error: v.reason ?? "failed", attempts_left: v.attempts_left ?? null });
  let eventId: string | null = null;
  let google: "none" | "created" | "failed" = "none";
  if (v.google) {
    const access = await googleAccess(deps, v.shop_id!);
    if (!access) {
      google = "failed";
    } else {
      try {
        const busy = await freeBusy(deps.fetch, access, v.starts_at!, v.ends_at!);
        if (overlaps(v.starts_at!, v.ends_at!, busy)) {
          await deps.db.rpc("booking_release", { p_id: id, p_reason: "slot_taken" });
          return reply(409, { error: "slot_taken" });
        }
      } catch {
        // Google did not answer: the booking is confirmed; the event is tried once below.
      }
      const res = await deps
        .fetch(`${CALENDAR}/calendars/primary/events?sendUpdates=none`, {
          method: "POST",
          headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
          body: JSON.stringify(eventBody(v as Confirmed)),
          signal: AbortSignal.timeout(10_000),
        })
        .catch(() => null);
      const created = res?.ok ? ((await res.json().catch(() => ({}))) as { id?: string }) : null;
      eventId = created?.id ?? null;
      google = eventId ? "created" : "failed";
      if (!eventId) console.error("bookings: event not inserted", id, res?.status ?? "network");
    }
  }
  const confirmed = await deps.db.rpc("booking_confirm", { p_id: id, p_google_event_id: eventId, p_google_status: google });
  if (confirmed.error) return reply(500, { error: "failed" });
  return reply(200, {
    ok: true,
    booking: { starts_at: v.starts_at, ends_at: v.ends_at, timezone: v.timezone, shop_name: v.shop_name, service_name: v.service_name ?? null },
  });
}

// ---------------------------------------------------------------- owners: Google Calendar

/** Where Google's answer goes back to: the owner's own page on an https address (localhost for development). */
export function cleanReturnUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value ?? ""));
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    if (!/\/dashboard\/bookings/.test(url.pathname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function owner(req: Request, body: Record<string, unknown>, deps: Deps) {
  const authorization = req.headers.get("Authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) return reply(401, { error: "login" });
  const caller = deps.asCaller(authorization);
  const { data: auth } = await caller.auth.getUser(token);
  const user = auth?.user;
  if (!user) return reply(401, { error: "login" });
  const shopId = String(body.shop_id ?? "");
  if (!UUID.test(shopId)) return reply(400, { error: "bad_request" });

  if (body.action === "google_connect") {
    if (!deps.google || !deps.key) return reply(400, { error: "google_off" });
    const check = await caller.rpc("crm_owner_check", { p_shop_id: shopId });
    if (check.error) return reply(403, { error: check.error.message === "no_plan" ? "no_plan" : "forbidden" });
    const back = cleanReturnUrl(body.return_url);
    if (!back) return reply(400, { error: "bad_request" });
    const state = b64url(random(32));
    const verifier = b64url(random(48));
    await deps.db.rpc("booking_oauth_begin", {
      p_shop_id: shopId,
      p_user_id: user.id,
      p_state_hash: await hashText(state),
      p_verifier: verifier,
      p_return_url: back,
    });
    const url = `${GOOGLE_AUTH}?${new URLSearchParams({
      client_id: deps.google.clientId,
      redirect_uri: `${deps.selfUrl}/oauth`,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      state,
      code_challenge: b64url(await sha256(enc.encode(verifier))),
      code_challenge_method: "S256",
    })}`;
    return reply(200, { url });
  }

  if (body.action === "google_disconnect") {
    const member = await caller.rpc("is_shop_member", { p_shop_id: shopId });
    if (member.error || member.data !== true) return reply(403, { error: "forbidden" });
    const { data } = await deps.db.rpc("booking_google_token", { p_shop_id: shopId });
    const row = (Array.isArray(data) ? data[0] : data) as { refresh_token_enc: string } | undefined;
    if (row && deps.key) {
      try {
        const refresh = await decryptToken(deps.key, row.refresh_token_enc, `${shopId}:google:refresh`);
        await deps.fetch(`${GOOGLE_REVOKE}?${new URLSearchParams({ token: refresh })}`, { method: "POST", signal: AbortSignal.timeout(10_000) });
      } catch {
        // Revoking is best effort; the token is deleted here either way.
      }
    }
    await deps.db.rpc("booking_google_remove", { p_shop_id: shopId, p_user_id: user.id });
    return reply(200, { ok: true });
  }
  return reply(400, { error: "bad_request" });
}

const backTo = (url: string, query: string) =>
  new Response(null, { status: 303, headers: { Location: `${url}${url.includes("?") ? "&" : "?"}${query}`, "Cache-Control": "no-store" } });

async function oauthBack(url: URL, deps: Deps) {
  const state = url.searchParams.get("state") ?? "";
  if (!state || !deps.google || !deps.key) return reply(400, { error: "bad_request" });
  const { data } = await deps.db.rpc("booking_oauth_take", { p_state_hash: await hashText(state) });
  const st = (Array.isArray(data) ? data[0] : data) as { shop_id: string; user_id: string; verifier: string; return_url: string } | undefined;
  if (!st) return reply(400, { error: "state" });
  const code = url.searchParams.get("code");
  if (!code) return backTo(st.return_url, "err=calendar_denied");
  const res = await deps.fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${deps.selfUrl}/oauth`,
      client_id: deps.google.clientId,
      client_secret: deps.google.clientSecret,
      code_verifier: st.verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const t = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!res.ok || !t.access_token || !t.refresh_token) return backTo(st.return_url, "err=calendar_failed");
  const granted = (t.scope ?? "").split(" ");
  if (!SCOPE.split(" ").every((s) => granted.includes(s))) return backTo(st.return_url, "err=calendar_scope");
  await deps.db.rpc("booking_google_save", {
    p_shop_id: st.shop_id,
    p_access_enc: await encryptToken(deps.key, t.access_token, `${st.shop_id}:google:access`),
    p_refresh_enc: await encryptToken(deps.key, t.refresh_token, `${st.shop_id}:google:refresh`),
    p_expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(),
    p_scope: t.scope ?? SCOPE,
    p_user_id: st.user_id,
  });
  return backTo(st.return_url, "ok=calendar_connected");
}

// ---------------------------------------------------------------- update 63: the assistant's tools (website)

export const CODE_REASONS = ["not_available", "purpose", "phone", "name", "conversation", "too_many", "sms_quota"] as const;
export const BOOK_REASONS = ["not_available", "conversation", "not_verified", "ref", "people", "contact_limit", "slot_taken", "service", "contact"] as const;

const str = (body: Record<string, unknown>, k: string, max: number) =>
  typeof body[k] === "string" ? (body[k] as string).slice(0, max) : null;
const conversationOf = (body: Record<string, unknown>) => ({
  p_conversation_id: UUID.test(String(body.conversation_id ?? "")) ? String(body.conversation_id) : null,
  p_conversation_token: str(body, "conversation_token", 200),
});

/** One SMS that is not a booking's own (a code; an owner change): claimed by the caller's RPC, sent, settled once. */
async function sendClaimed(deps: Deps, claim: RpcResult, phone: string, text: string): Promise<"sent" | "test" | "failed" | "quota"> {
  if (claim.error) return claim.error.message === "sms_quota" ? "quota" : "failed";
  const result = await deps.sms.send(phone, text).catch((e) => ({ ok: false, error: String(e).slice(0, 200) }) as SmsResult);
  const status = !result.ok ? "failed" : deps.sms.live ? "sent" : "test";
  await deps.db.rpc("booking_sms_settle", {
    p_id: claim.data as string,
    p_status: status,
    p_provider: deps.sms.name,
    p_ref: result.ref ?? null,
    p_error: result.error ?? null,
  });
  return status;
}

async function codeStart(body: Record<string, unknown>, deps: Deps) {
  const slug = String(body.slug ?? "");
  const purpose = body.purpose === "delete_all" ? "delete_all" : body.purpose === "contact" ? "contact" : null;
  const caller = String(body.caller ?? "");
  if (!SLUG.test(slug) || !purpose || caller.length < 16 || caller.length > 128) return reply(400, { error: "bad_request" });
  const started = await deps.db.rpc("sms_code_start", {
    p_slug: slug,
    p_purpose: purpose,
    p_phone: str(body, "phone", 40),
    p_name: str(body, "name", 80),
    p_caller_hash: caller,
    ...conversationOf(body),
    p_consent_version: str(body, "consent_version", 40),
  });
  if (started.error) {
    const why = CODE_REASONS.find((r) => r === started.error!.message) ?? "failed";
    return reply(why === "failed" ? 500 : why === "too_many" || why === "sms_quota" ? 429 : 400, { error: why });
  }
  const c = started.data as { id: string; code: string; phone: string; shop_name: string; expires_at: string };
  const text = smsText(purpose === "delete_all" ? "forget_code" : "contact_code", str(body, "lang", 12), { shop: c.shop_name, code: c.code });
  const claim = await deps.db.rpc("sms_code_claim", { p_code_id: c.id, p_body: text });
  const status = await sendClaimed(deps, claim as RpcResult, c.phone, text);
  if (status === "quota") return reply(429, { error: "sms_quota" });
  if (status === "failed") return reply(502, { error: "sms_failed" });
  return reply(200, {
    id: c.id,
    expires_at: c.expires_at,
    phone: maskPhone(c.phone),
    // test mode only (no SMS provider and BOOKING_TEST_CODES=on): the code goes back to the page, never to the AI
    ...(status === "test" && deps.showTestCodes ? { test_code: c.code } : {}),
  });
}

async function codeVerify(body: Record<string, unknown>, deps: Deps) {
  const id = String(body.id ?? "");
  if (!UUID.test(id)) return reply(400, { error: "bad_request" });
  const { data, error } = await deps.db.rpc("sms_code_verify", {
    p_code_id: id,
    p_code: String(body.code ?? "").replace(/\s/g, "").slice(0, 12),
    ...conversationOf(body),
  });
  if (error) return reply(500, { error: "failed" });
  const v = data as { ok: boolean; reason?: string; attempts_left?: number; purpose?: string };
  if (!v.ok) return reply(400, { error: v.reason ?? "failed", attempts_left: v.attempts_left ?? null });
  return reply(200, { ok: true, purpose: v.purpose });
}

async function services(body: Record<string, unknown>, deps: Deps) {
  const slug = String(body.slug ?? "");
  if (!SLUG.test(slug)) return reply(400, { error: "bad_request" });
  const { data, error } = await deps.db.rpc("shop_booking_services", { p_slug: slug });
  if (error) return reply(500, { error: "failed" });
  return reply(200, { services: data ?? [] });
}

/** Reads a connected calendar's busy times for a window into booking_calendar_busy (failures only logged). */
export async function refreshBusy(deps: Deps, shopId: string, from: string, to: string): Promise<boolean> {
  const access = await googleAccess(deps, shopId);
  if (!access) return false;
  try {
    const busy = await freeBusy(deps.fetch, access, from, to);
    await deps.db.rpc("booking_calendar_busy_set", { p_shop_id: shopId, p_from: from, p_to: to, p_ranges: busy });
    return true;
  } catch (e) {
    console.error("bookings: busy times", shopId, (e instanceof Error ? e.message : String(e)).slice(0, 80));
    return false;
  }
}

async function offer(body: Record<string, unknown>, deps: Deps) {
  const slug = String(body.slug ?? "");
  const service = String(body.service_id ?? "");
  const from = Date.parse(String(body.from ?? ""));
  const to = Date.parse(String(body.to ?? ""));
  if (!SLUG.test(slug) || !UUID.test(service) || Number.isNaN(from) || Number.isNaN(to) || to <= from) {
    return reply(400, { error: "bad_request" });
  }
  const shop = await bookableShop(deps, slug);
  if (!shop) return reply(200, { available: false, slots: [] });
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(Math.min(to, from + 14 * 86_400_000)).toISOString();
  if (shop.google) await refreshBusy(deps, shop.shop_id, fromIso, toIso);
  const { data, error } = await deps.db.rpc("booking_offer_slots", {
    p_slug: slug,
    ...conversationOf(body),
    p_service_id: service,
    p_from: fromIso,
    p_to: toIso,
    p_people: Math.min(Math.max(Math.floor(Number(body.people) || 1), 1), 500),
  });
  if (error) return reply(500, { error: "failed" });
  return reply(200, { available: true, timezone: shop.timezone, slots: data ?? [] });
}

async function book(body: Record<string, unknown>, deps: Deps) {
  const slug = String(body.slug ?? "");
  const ref = String(body.ref ?? "");
  if (!SLUG.test(slug) || !/^s[0-9]{1,3}$/.test(ref)) return reply(400, { error: "bad_request" });
  const { data, error } = await deps.db.rpc("booking_assistant_book", {
    p_slug: slug,
    ...conversationOf(body),
    p_ref: ref,
    p_people: Math.min(Math.max(Math.floor(Number(body.people) || 1), 1), 500),
  });
  if (error) {
    const why = BOOK_REASONS.find((r) => r === error.message) ?? "failed";
    return reply(why === "failed" ? 500 : why === "slot_taken" ? 409 : 400, { error: why });
  }
  return reply(200, { ok: true, booking: data });
}

// ---------------------------------------------------------------- the job

interface Due {
  id: string;
  shop_name: string;
  timezone: string;
  phone: string;
  starts_at: string;
  lang: string | null;
  service_name: string | null;
}

async function reminders(deps: Deps): Promise<number> {
  const { data } = await deps.db.rpc("booking_reminders_due", { p_limit: 50 });
  let sent = 0;
  for (const b of (data ?? []) as Due[]) {
    const text = smsText("reminder_at", b.lang, {
      shop: b.shop_name, day: localDay(b.starts_at, b.timezone), time: localTime(b.starts_at, b.timezone), service: b.service_name,
    });
    const status = await sendSms(deps, b.id, "booking_reminder", b.phone, text);
    if (status === "sent" || status === "test") sent++;
  }
  return sent;
}

/** The customer's SMS after the owner moved or cancelled (booking_notifications; 3 tries, then failed). */
async function ownerChanges(deps: Deps): Promise<number> {
  const { data } = await deps.db.rpc("booking_notifications_due", { p_limit: 50 });
  let sent = 0;
  for (const n of (data ?? []) as (Due & { kind: "moved" | "cancelled"; shop_phone: string | null })[]) {
    const text = smsText(n.kind, n.lang, {
      shop: n.shop_name, day: localDay(n.starts_at, n.timezone), time: localTime(n.starts_at, n.timezone), service: n.service_name,
      phone: n.shop_phone,
    });
    const claim = await deps.db.rpc("booking_notification_claim", { p_id: n.id, p_body: text });
    const status = await sendClaimed(deps, claim as RpcResult, n.phone, text);
    const ok = status === "sent" || status === "test";
    await deps.db.rpc("booking_notification_result", { p_id: n.id, p_ok: ok, p_error: ok ? null : status });
    if (ok) sent++;
  }
  return sent;
}

interface SyncJob {
  id: number;
  shop_id: string;
  booking_id: string | null;
  op: "create" | "update" | "delete";
  google_event_id: string | null;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string;
  summary: string;
  status: string | null;
}

/** The event Cacaduu keeps in the shop's calendar: the service, the first name and the resource only. */
export const syncEvent = (j: SyncJob) => ({
  summary: j.summary.slice(0, 200),
  description: "Cacaduu",
  start: { dateTime: j.starts_at, timeZone: j.timezone },
  end: { dateTime: j.ends_at, timeZone: j.timezone },
  reminders: { useDefault: true },
});

/** One push to Google: only the event Cacaduu made (its id), never another one; a deleted event counts as done. */
export async function pushSync(deps: Deps, j: SyncJob): Promise<{ ok: boolean; eventId: string | null; error: string | null }> {
  const access = await googleAccess(deps, j.shop_id);
  if (!access) return { ok: false, eventId: null, error: "Kalendár nie je pripojený" };
  const live = j.status === "confirmed" && j.starts_at && j.ends_at;
  const headers = { Authorization: `Bearer ${access}`, "Content-Type": "application/json" };
  const events = `${CALENDAR}/calendars/primary/events`;
  try {
    if (j.op === "delete" || !live) {
      if (!j.google_event_id) return { ok: true, eventId: null, error: null };
      const res = await deps.fetch(`${events}/${encodeURIComponent(j.google_event_id)}?sendUpdates=none`, {
        method: "DELETE", headers, signal: AbortSignal.timeout(10_000),
      });
      return res.ok || res.status === 404 || res.status === 410
        ? { ok: true, eventId: null, error: null }
        : { ok: false, eventId: null, error: `Google ${res.status}` };
    }
    if (j.op === "update" && j.google_event_id) {
      const res = await deps.fetch(`${events}/${encodeURIComponent(j.google_event_id)}?sendUpdates=none`, {
        method: "PATCH", headers, body: JSON.stringify(syncEvent(j)), signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { ok: true, eventId: j.google_event_id, error: null };
      if (res.status !== 404 && res.status !== 410) return { ok: false, eventId: null, error: `Google ${res.status}` };
      // the owner deleted it in Google: Cacaduu makes it again
    }
    const res = await deps.fetch(`${events}?sendUpdates=none`, {
      method: "POST", headers, body: JSON.stringify(syncEvent(j)), signal: AbortSignal.timeout(10_000),
    });
    const created = res.ok ? ((await res.json().catch(() => ({}))) as { id?: string }) : null;
    return created?.id ? { ok: true, eventId: created.id, error: null } : { ok: false, eventId: null, error: `Google ${res.status}` };
  } catch (e) {
    return { ok: false, eventId: null, error: (e instanceof Error ? e.message : String(e)).slice(0, 100) };
  }
}

async function calendarSync(deps: Deps): Promise<number> {
  const { data } = await deps.db.rpc("booking_sync_due", { p_limit: 50 });
  let done = 0;
  for (const j of (data ?? []) as SyncJob[]) {
    const r = await pushSync(deps, j);
    await deps.db.rpc("booking_sync_result", { p_id: j.id, p_ok: r.ok, p_event_id: r.eventId, p_error: r.error });
    if (r.ok) done++;
    else console.error("bookings: calendar push", j.shop_id, j.op, (r.error ?? "").slice(0, 60));
  }
  return done;
}

/** The busy times of every working calendar connection for the next 60 days (at most 20 shops a tick). */
async function busyTimes(deps: Deps): Promise<number> {
  if (!deps.google || !deps.key || !deps.db.from) return 0;
  const { data } = await deps.db.from("booking_google_connections").select("shop_id").eq("status", "ok").limit(20);
  const from = new Date().toISOString();
  const to = new Date(Date.now() + 60 * 86_400_000).toISOString();
  let n = 0;
  for (const row of (data ?? []) as { shop_id: string }[]) if (await refreshBusy(deps, row.shop_id, from, to)) n++;
  return n;
}

async function tick(deps: Deps) {
  const run = async (name: string, f: () => Promise<number>) => {
    try {
      return await f();
    } catch (e) {
      console.error("bookings: tick", name, (e instanceof Error ? e.message : String(e)).slice(0, 120));
      return 0;
    }
  };
  return reply(200, {
    reminders: await run("reminders", () => reminders(deps)),
    owner_changes: await run("owner_changes", () => ownerChanges(deps)),
    calendar: await run("calendar", () => calendarSync(deps)),
    busy: await run("busy", () => busyTimes(deps)),
  });
}

// ---------------------------------------------------------------- the request

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname.endsWith("/oauth")) return await oauthBack(url, deps);
  if (req.method !== "POST") return reply(405, { error: "method" });
  const body = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const action = String(body.action ?? "");
  try {
    const cron = req.headers.get("x-ppi-cron");
    if (cron) {
      const { data } = await deps.db.rpc("bookings_cron_ok", { p_secret: cron });
      if (data !== true) return reply(403, { error: "forbidden" });
      if (action === "tick") return await tick(deps);
      return reply(400, { error: "bad_request" });
    }
    const website = req.headers.get("x-ppi-website");
    if (website !== null) {
      if (!deps.websiteSecret || !sameText(website, deps.websiteSecret)) return reply(403, { error: "forbidden" });
      if (action === "slots") return await slots(body, deps);
      if (action === "start") return await start(body, deps);
      if (action === "resend") return await resend(body, deps);
      if (action === "verify") return await verify(body, deps);
      if (action === "code_start") return await codeStart(body, deps);
      if (action === "code_verify") return await codeVerify(body, deps);
      if (action === "services") return await services(body, deps);
      if (action === "offer") return await offer(body, deps);
      if (action === "book") return await book(body, deps);
      return reply(400, { error: "bad_request" });
    }
    if (action === "google_connect" || action === "google_disconnect") return await owner(req, body, deps);
    return reply(400, { error: "bad_request" });
  } catch (e) {
    console.error("bookings:", action, (e instanceof Error ? e.message : String(e)).slice(0, 200));
    return reply(500, { error: "failed" });
  }
}

export async function handler(req: Request): Promise<Response> {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return reply(500, { error: "config" });
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const clientId = Deno.env.get("GOOGLE_CALENDAR_CLIENT_ID")?.trim();
  const clientSecret = Deno.env.get("GOOGLE_CALENDAR_CLIENT_SECRET")?.trim();
  const secret = (Deno.env.get("BOOKING_TOKEN_ENCRYPTION_KEY") ?? Deno.env.get("EXPORT_TOKEN_ENCRYPTION_KEY") ?? "").trim();
  const sms = smsProvider(Deno.env.get("SMS_PROVIDER"), (name) => Deno.env.get(name), fetch);
  return await handle(req, {
    db: createClient(url, serviceKey, options) as unknown as Db,
    asCaller: (authorization) =>
      createClient(url, anonKey, { ...options, global: { headers: { Authorization: authorization } } }) as unknown as Caller,
    websiteSecret: Deno.env.get("ASSISTANT_ARCHIVE_SECRET")?.trim() || null,
    google: clientId && clientSecret ? { clientId, clientSecret } : null,
    key: secret.length >= 32 ? await tokenKey(secret) : null,
    selfUrl: `${url.replace(/\/$/, "")}/functions/v1/bookings`,
    sms,
    showTestCodes: !sms.live && (Deno.env.get("BOOKING_TEST_CODES") ?? "").trim().toLowerCase() === "on",
    fetch,
  });
}

if (!Deno.env.get("PPI_FUNCTION_TEST")) Deno.serve(handler);
