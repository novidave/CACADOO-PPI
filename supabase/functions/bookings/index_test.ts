// Unit tests of the bookings function: who may call what, the code SMS, Google free/busy and the event, the reminder.
// Run: npm run test:functions
import {
  cleanReturnUrl, decryptToken, type Deps, encryptToken, eventBody, handle, hashText, localTime, maskPhone, overlaps,
  SCOPE, smsProvider, smsText, testSms, tokenKey,
} from "./index.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}

const SHOP = "11111111-2222-4333-8444-555555555555";
const BOOKING = "99999999-2222-4333-8444-555555555555";
const SECRET = "website-secret-0123456789abcdef0123456789";
const KEY_TEXT = "k".repeat(40);

interface Setup {
  google?: boolean;
  connected?: boolean;
  busy?: { start: string; end: string }[];
  rpc?: Record<string, { data?: unknown; error?: { message: string; code?: string } }>;
  sms?: Deps["sms"];
  showTestCodes?: boolean;
  eventStatus?: number;
}

async function setup(o: Setup = {}) {
  const log: string[] = [];
  const key = await tokenKey(KEY_TEXT);
  const tokenRow = o.connected
    ? {
      access_token_enc: await encryptToken(key, "access-1", `${SHOP}:google:access`),
      refresh_token_enc: await encryptToken(key, "refresh-1", `${SHOP}:google:refresh`),
      access_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      status: "ok",
    }
    : null;
  const defaults: Record<string, { data?: unknown; error?: { message: string; code?: string } | null }> = {
    booking_shop: { data: [{ shop_id: SHOP, timezone: "Europe/Bratislava", shop_name: "Kaderníctvo Eva", service_name: "Strih", duration_minutes: 30, google: Boolean(o.connected) }] },
    booking_slots: { data: [
      { starts_at: "2026-11-10T08:00:00Z", ends_at: "2026-11-10T08:30:00Z" },
      { starts_at: "2026-11-10T08:30:00Z", ends_at: "2026-11-10T09:00:00Z" },
    ] },
    booking_google_token: { data: tokenRow ? [tokenRow] : [] },
    booking_start: { data: { id: BOOKING, token: "tok", code: "123456", phone: "+421905111222", shop_name: "Kaderníctvo Eva", expires_at: "x", lang: "sk" } },
    booking_verify: { data: { ok: true, shop_id: SHOP, google: Boolean(o.connected), shop_name: "Kaderníctvo Eva", timezone: "Europe/Bratislava",
      starts_at: "2026-11-10T08:00:00Z", ends_at: "2026-11-10T08:30:00Z", name: "Jana", phone: "+421905111222", email: null, address: null, note: null, service_name: "Strih" } },
    bookings_cron_ok: { data: true },
    booking_sms_claim: { data: "msg-1" },
    booking_sms_settle: { data: true },
    booking_reminders_due: { data: [{ id: BOOKING, shop_name: "Kaderníctvo Eva", timezone: "Europe/Bratislava", phone: "+421905111222", starts_at: "2026-11-10T08:00:00Z", lang: "sk", service_name: "Strih" }] },
  };
  const answer = (name: string) => ({ data: null, error: null, ...(defaults[name] ?? {}), ...(o.rpc?.[name] ?? {}) });
  const deps: Deps = {
    db: { rpc: (name, args) => { log.push(`db ${name} ${JSON.stringify(args ?? {})}`); return Promise.resolve(answer(name) as never); } },
    asCaller: () => ({
      auth: { getUser: (t: string) => Promise.resolve({ data: { user: t === "owner-jwt" ? { id: "u1" } : null } }) },
      rpc: (name: string, args?: Record<string, unknown>) => {
        log.push(`caller ${name} ${JSON.stringify(args ?? {})}`);
        return Promise.resolve(answer(`caller:${name}`) as never);
      },
    }),
    websiteSecret: SECRET,
    google: o.google === false ? null : { clientId: "cid", clientSecret: "csecret" },
    key,
    selfUrl: "https://p.supabase.co/functions/v1/bookings",
    sms: o.sms ?? testSms,
    showTestCodes: o.showTestCodes ?? false,
    fetch: ((url: string, init: RequestInit) => {
      log.push(`fetch ${url} ${typeof init?.body === "string" ? init.body : String(init?.body ?? "")}`);
      if (url.endsWith("/freeBusy")) return Promise.resolve(new Response(JSON.stringify({ calendars: { primary: { busy: o.busy ?? [] } } })));
      if (url.includes("/events")) return Promise.resolve(new Response(JSON.stringify({ id: "evt_9" }), { status: o.eventStatus ?? 200 }));
      if (url.includes("oauth2.googleapis.com/token")) {
        return Promise.resolve(new Response(JSON.stringify({ access_token: "a2", refresh_token: "r2", expires_in: 3600, scope: SCOPE })));
      }
      return Promise.resolve(new Response("{}"));
    }) as unknown as typeof fetch,
  };
  return { deps, log };
}

const website = (body: unknown, secret = SECRET) =>
  new Request("https://x/functions/v1/bookings", { method: "POST", headers: { "x-ppi-website": secret, "Content-Type": "application/json" }, body: JSON.stringify(body) });

Deno.test("only the website with its secret, the job with its secret, owners with their login", async () => {
  const { deps } = await setup();
  eq((await handle(website({ action: "slots", slug: "eva" }, "wrong"), deps)).status, 403, "wrong website secret");
  eq((await handle(new Request("https://x/functions/v1/bookings", { method: "POST", headers: { "x-ppi-cron": "bad" }, body: "{}" }),
    (await setup({ rpc: { bookings_cron_ok: { data: false } } })).deps)).status, 403, "wrong job secret");
  eq((await handle(new Request("https://x/functions/v1/bookings", { method: "POST", body: JSON.stringify({ action: "google_connect", shop_id: SHOP }) }), deps)).status, 401, "no login");
  eq((await handle(new Request("https://x/functions/v1/bookings", { method: "PUT" }), deps)).status, 405, "method");
});

Deno.test("free times minus Google's busy times", async () => {
  const { deps, log } = await setup({ connected: true, busy: [{ start: "2026-11-10T08:15:00Z", end: "2026-11-10T08:20:00Z" }] });
  const res = await (await handle(website({ action: "slots", slug: "eva", days: 99 }), deps)).json();
  eq(res.slots.map((s: { starts_at: string }) => s.starts_at), ["2026-11-10T08:30:00Z"], "the busy one is gone");
  eq(log.find((l) => l.startsWith("db booking_slots")), 'db booking_slots {"p_slug":"eva","p_from":null,"p_days":14}', "at most 14 days");
  const fb = JSON.parse(log.find((l) => l.includes("/freeBusy"))!.split(" ").slice(2).join(" "));
  eq(fb.items, [{ id: "primary" }], "free/busy of the primary calendar only");
  const off = await setup({ rpc: { booking_shop: { data: [] } } });
  eq(await (await handle(website({ action: "slots", slug: "eva" }), off.deps)).json(), { available: false, slots: [] }, "not bookable");
});

Deno.test("start: the code goes by SMS (test mode: written down, shown only with BOOKING_TEST_CODES), never in a log", async () => {
  const { deps, log } = await setup();
  const body = { action: "start", slug: "eva", starts_at: "2026-11-10T08:00:00Z", name: "Jana", phone: "0905111222", consent: true, consent_version: "v1", lang: "sk", caller: "c".repeat(32) };
  const res = await (await handle(website(body), deps)).json();
  eq([res.id, res.sms, res.phone, "test_code" in res], [BOOKING, "test", "+421 ••• ••• 222", false], "held, no code returned");
  const claimed = log.find((l) => l.startsWith("db booking_sms_claim"))!;
  eq(claimed.includes('"p_kind":"booking_code"'), true, "written down first (the quota)");
  const settled = log.find((l) => l.startsWith("db booking_sms_settle"))!;
  eq(settled.includes('"p_id":"msg-1"') && settled.includes('"p_status":"test"'), true, "settled as a test code SMS");
  eq(log.findIndex((l) => l.startsWith("db booking_sms_claim")) < log.findIndex((l) => l.startsWith("db booking_sms_settle")), true, "claim before settle");
  const shown = await setup({ showTestCodes: true });
  eq((await (await handle(website(body), shown.deps)).json()).test_code, "123456", "shown in test mode when switched on");
  const refused = await setup({ rpc: { booking_start: { error: { message: "slot_taken", code: "P0001" } } } });
  eq(await (await handle(website(body), refused.deps)).json(), { error: "slot_taken" }, "the database's reason");
  const failing = await setup({ sms: { name: "x", live: true, send: () => Promise.resolve({ ok: false, error: "down" }) } });
  const r = await handle(website(body), failing.deps);
  eq(r.status, 502, "SMS failed");
  eq(failing.log.some((l) => l.startsWith("db booking_release")), true, "the time is let go");
  // the month's booking SMS used up: nothing sent, the time let go, the shopper told why
  let sentAtLimit = false;
  const full = await setup({
    rpc: { booking_sms_claim: { error: { message: "sms_quota", code: "54000" } } },
    sms: { name: "brevo", live: true, send: () => { sentAtLimit = true; return Promise.resolve({ ok: true }); } },
  });
  const atLimit = await handle(website(body), full.deps);
  eq([atLimit.status, (await atLimit.json()).error, sentAtLimit], [429, "sms_quota", false], "quota: nothing sent");
  eq(full.log.some((l) => l.startsWith("db booking_release")), true, "quota: the time is let go");
  eq(full.log.some((l) => l.startsWith("db booking_sms_settle")), false, "quota: nothing to settle");
});

Deno.test("resend at the quota limit sends nothing", async () => {
  const { deps } = await setup({ rpc: { booking_resend: { data: { ok: false, reason: "sms_quota" } } } });
  const res = await handle(website({ action: "resend", id: BOOKING, token: "tok" }), deps);
  eq([res.status, (await res.json()).error], [400, "sms_quota"], "the database refused");
  const claimFull = await setup({
    rpc: {
      booking_resend: { data: { ok: true, code: "654321", phone: "+421905111222", shop_name: "Eva", lang: "sk" } },
      booking_sms_claim: { error: { message: "sms_quota", code: "54000" } },
    },
  });
  const r2 = await handle(website({ action: "resend", id: BOOKING, token: "tok" }), claimFull.deps);
  eq([r2.status, (await r2.json()).error], [429, "sms_quota"], "the claim refused");
});

Deno.test("start refuses a time Google already has busy, before anything is held", async () => {
  const { deps, log } = await setup({ connected: true, busy: [{ start: "2026-11-10T08:00:00Z", end: "2026-11-10T09:00:00Z" }] });
  const res = await handle(website({ action: "start", slug: "eva", starts_at: "2026-11-10T08:00:00Z", consent: true }), deps);
  eq(await res.json(), { error: "slot_taken" }, "busy");
  eq(log.some((l) => l.startsWith("db booking_start")), false, "nothing held");
});

Deno.test("verify: Google checked again, the event inserted without e-mails, then confirmed", async () => {
  const { deps, log } = await setup({ connected: true });
  const res = await (await handle(website({ action: "verify", id: BOOKING, token: "tok", code: "123 456" }), deps)).json();
  eq(res.ok, true, "confirmed");
  eq(log.find((l) => l.startsWith("db booking_verify")), `db booking_verify {"p_id":"${BOOKING}","p_token":"tok","p_code":"123456"}`, "spaces dropped");
  const insert = log.find((l) => l.includes("/events"))!;
  eq(insert.includes("calendars/primary/events?sendUpdates=none"), true, "no e-mails from Google");
  eq(log.at(-1), `db booking_confirm {"p_id":"${BOOKING}","p_google_event_id":"evt_9","p_google_status":"created"}`, "confirmed with the event");
  const busy = await setup({ connected: true, busy: [{ start: "2026-11-10T08:10:00Z", end: "2026-11-10T08:20:00Z" }] });
  const r = await handle(website({ action: "verify", id: BOOKING, token: "tok", code: "123456" }), busy.deps);
  eq([r.status, (await r.json()).error], [409, "slot_taken"], "busy meanwhile");
  eq(busy.log.some((l) => l.startsWith("db booking_confirm")), false, "not confirmed");
  const failed = await setup({ connected: true, eventStatus: 500 });
  await handle(website({ action: "verify", id: BOOKING, token: "tok", code: "123456" }), failed.deps);
  eq(failed.log.at(-1)!.includes('"p_google_status":"failed"'), true, "still confirmed, Google failed");
  const wrong = await setup({ rpc: { booking_verify: { data: { ok: false, reason: "wrong_code", attempts_left: 3 } } } });
  eq(await (await handle(website({ action: "verify", id: BOOKING, token: "t", code: "1" }), wrong.deps)).json(), { error: "wrong_code", attempts_left: 3 }, "wrong code");
});

Deno.test("Google connect: owners with the plan, PKCE, only the two scopes; the answer stores encrypted tokens", async () => {
  const { deps, log } = await setup();
  const req = (body: unknown) => new Request("https://x/functions/v1/bookings", { method: "POST", headers: { Authorization: "Bearer owner-jwt" }, body: JSON.stringify(body) });
  const res = await (await handle(req({ action: "google_connect", shop_id: SHOP, return_url: "https://cacaduu.example/sk/dashboard/bookings?shop=eva" }), deps)).json();
  const url = new URL(res.url);
  eq([url.searchParams.get("scope"), url.searchParams.get("code_challenge_method"), url.searchParams.get("access_type")], [SCOPE, "S256", "offline"], "consent page");
  eq(log[0].startsWith("caller crm_owner_check"), true, "membership and plan checked with the owner's login");
  const state = url.searchParams.get("state")!;
  const begun = JSON.parse(log.find((l) => l.startsWith("db booking_oauth_begin"))!.slice("db booking_oauth_begin ".length));
  eq(begun.p_state_hash, await hashText(state), "only the state's hash is stored");
  eq((await handle(req({ action: "google_connect", shop_id: SHOP, return_url: "https://evil.example/" }), deps)).status, 400, "a foreign page");
  const back = await setup({ rpc: { booking_oauth_take: { data: [{ shop_id: SHOP, user_id: "u1", verifier: "v", return_url: "https://cacaduu.example/sk/dashboard/bookings" }] } } });
  const cb = await handle(new Request(`https://p.supabase.co/functions/v1/bookings/oauth?state=${state}&code=abc`), back.deps);
  eq([cb.status, cb.headers.get("Location")], [303, "https://cacaduu.example/sk/dashboard/bookings?ok=calendar_connected"], "back to the page");
  const saved = JSON.parse(back.log.find((l) => l.startsWith("db booking_google_save"))!.slice("db booking_google_save ".length));
  eq(await decryptToken(back.deps.key!, saved.p_refresh_enc, `${SHOP}:google:refresh`), "r2", "the refresh token, encrypted and bound to the shop");
  eq(saved.p_refresh_enc.includes("r2"), false, "never in plain text");
});

Deno.test("the day-before reminder goes by SMS and is logged", async () => {
  const { deps, log } = await setup();
  const res = await handle(new Request("https://x/functions/v1/bookings", { method: "POST", headers: { "x-ppi-cron": "c".repeat(40) }, body: JSON.stringify({ action: "tick" }) }), deps);
  eq(await res.json(), { reminders: 1 }, "one");
  const logged = log.find((l) => l.startsWith("db booking_sms_claim"))!;
  eq(logged.includes('"p_kind":"booking_reminder"') && logged.includes("zajtra o 09:00"), true, "the shop's local time");
  eq(log.some((l) => l.startsWith("db booking_sms_settle")), true, "settled");
  const full = await setup({ rpc: { booking_sms_claim: { error: { message: "sms_quota" } } } });
  const r2 = await handle(new Request("https://x/functions/v1/bookings", { method: "POST", headers: { "x-ppi-cron": "c".repeat(40) }, body: JSON.stringify({ action: "tick" }) }), full.deps);
  eq(await r2.json(), { reminders: 0 }, "quota used up: none sent");
});

Deno.test("small rules", async () => {
  eq(smsText("code", "hu", { shop: "Bolt", code: "123456" }), "Bolt: a foglalás kódja 123456. 10 percig érvényes.", "Hungarian");
  eq(smsText("code", "de", { shop: "Laden", code: "1" }).startsWith("Laden: your booking code"), true, "English otherwise");
  eq(smsText("reminder", "sk", { shop: "Eva", time: "09:00", service: null }).includes("cancel") || smsText("reminder", "sk", { shop: "Eva", time: "09:00" }).includes("http"), false, "no cancel link");
  eq(localTime("2026-07-01T06:00:00Z", "Europe/Bratislava"), "08:00", "summer time");
  eq(maskPhone("+421905111222"), "+421 ••• ••• 222", "mask");
  eq(overlaps("2026-11-10T08:00:00Z", "2026-11-10T08:30:00Z", [{ start: "2026-11-10T08:30:00Z", end: "2026-11-10T09:00:00Z" }]), false, "touching is free");
  eq(eventBody({ shop_name: "x", timezone: "Europe/Bratislava", starts_at: "a", ends_at: "b", name: "Jana", phone: "+421", email: null, address: null, note: null, service_name: null }).summary, "Rezervácia: Jana", "summary");
  eq("attendees" in eventBody({ shop_name: "x", timezone: "t", starts_at: "a", ends_at: "b", name: "J", phone: "p", email: "e@x.y", address: null, note: null, service_name: "S" }), false, "no attendees");
  eq(cleanReturnUrl("http://localhost:3000/sk/dashboard/bookings"), "http://localhost:3000/sk/dashboard/bookings", "local");
  eq(cleanReturnUrl("http://cacaduu.example/sk/dashboard/bookings"), null, "plain http elsewhere");
  eq(smsProvider(undefined).live, false, "test by default");
});
