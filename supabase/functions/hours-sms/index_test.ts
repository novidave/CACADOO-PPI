// Unit tests of the hours-sms function: who may send hours, reading and checking them, the reply SMS, the shop page's
// refresh, Google Business Profile's hours, the owner's phone code and the Google connection.
// Run: npm run test:functions
import {
  BUSINESS_SCOPE, checkParsed, cleanReturnUrl, type Deps, describeChange, encryptToken, googleRegular, googleSpecial, handle,
  localToday, type ParsedHours, readInbound, replyLang, replyText, testSms, tokenKey, twilioSignature,
} from "./index.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}

const SHOP = "11111111-2222-4333-8444-555555555555";
const SHOP2 = "22222222-2222-4333-8444-555555555555";
const SMS_ID = "99999999-2222-4333-8444-555555555555";
const KEY_TEXT = "k".repeat(40);
const TWILIO_TOKEN = "twilio-auth-token";
const TWILIO_URL = "https://p.supabase.co/functions/v1/hours-sms/inbound/twilio";
const GENERIC = "g".repeat(40);
const PHONE = "+421905111222";
const NOW = new Date("2026-11-04T10:00:00Z"); // a Wednesday

const parsed = (p: Partial<ParsedHours>): ParsedHours => ({ intent: "hours", shop: null, language: "sk", regular: [], special: [], ...p });

const shopRow = (id: string, name: string) => ({
  shop_id: id,
  name,
  slug: name.toLowerCase().replace(/\s+/g, "-"),
  timezone: "Europe/Bratislava",
  opening_hours: { mon: [["08:00", "17:00"]] },
  user_id: "u1",
});

interface Setup {
  shops?: ReturnType<typeof shopRow>[];
  status?: string;
  duplicate?: boolean;
  parse?: ParsedHours | null;
  connected?: boolean;
  location?: string | null;
  rpc?: Record<string, { data?: unknown; error?: { message: string; code?: string } }>;
  sms?: Deps["sms"];
  showTestCodes?: boolean;
  googleStatus?: number;
}

async function setup(o: Setup = {}) {
  const log: string[] = [];
  const sent: string[] = [];
  const parses: unknown[] = [];
  const key = await tokenKey(KEY_TEXT);
  const tokenRow = o.connected
    ? {
      access_token_enc: await encryptToken(key, "access-1", `${SHOP}:business:access`),
      refresh_token_enc: await encryptToken(key, "refresh-1", `${SHOP}:business:refresh`),
      access_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      status: "ok",
      location_name: o.location === undefined ? "locations/123" : o.location,
    }
    : null;
  const defaults: Record<string, { data?: unknown; error?: { message: string; code?: string } | null }> = {
    hours_sms_receive: {
      data: o.duplicate
        ? { duplicate: true }
        : { id: SMS_ID, status: o.status ?? "received", phone: o.status && o.status !== "received" ? null : PHONE, shops: o.shops ?? [shopRow(SHOP, "Kvety Eva")] },
    },
    hours_sms_apply: { data: { mon: [["09:00", "17:00"]], sun: [] } },
    hours_sms_claim: { data: "msg-1" },
    hours_special_days: { data: [{ date: "2026-12-24", closed: true, ranges: [] }] },
    business_token: { data: tokenRow ? [tokenRow] : [] },
    hours_phone_start: { data: { id: "ph-1", phone: PHONE, code: "123456" } },
    "caller:is_shop_member": { data: true },
    "caller:shop_has_plan": { data: true },
    "caller:my_shops": { data: [{ id: SHOP, opening_hours: { tue: [["08:00", "12:00"]] } }] },
  };
  const answer = (name: string) => ({ data: null, error: null, ...(defaults[name] ?? {}), ...(o.rpc?.[name] ?? {}) });
  const sms = o.sms ?? {
    ...testSms,
    send: (to: string, text: string) => {
      sent.push(`${to} ${text}`);
      return Promise.resolve({ ok: true });
    },
  };
  const deps: Deps = {
    db: { rpc: (name, args) => { log.push(`db ${name} ${JSON.stringify(args ?? {})}`); return Promise.resolve(answer(name) as never); } },
    asCaller: () => ({
      auth: { getUser: (t: string) => Promise.resolve({ data: { user: t === "owner-jwt" ? { id: "u1" } : null } }) },
      rpc: (name: string, args?: Record<string, unknown>) => {
        log.push(`caller ${name} ${JSON.stringify(args ?? {})}`);
        return Promise.resolve(answer(`caller:${name}`) as never);
      },
    }),
    parse: o.parse === null ? null : (input) => {
      parses.push(input);
      return Promise.resolve(o.parse ?? parsed({ regular: [{ day: "mon", closed: false, ranges: [{ from: "9", to: "17" }] }, { day: "sun", closed: true, ranges: [] }] }));
    },
    sms,
    showTestCodes: o.showTestCodes ?? false,
    inbound: { twilioToken: TWILIO_TOKEN, twilioUrl: TWILIO_URL, genericSecret: GENERIC },
    number: "+421900000000",
    google: { clientId: "cid", clientSecret: "csecret" },
    key,
    selfUrl: "https://p.supabase.co/functions/v1/hours-sms",
    revalidate: { url: "https://cacaduu.com", secret: "revalidate-secret-123" },
    fetch: ((url: string, init: RequestInit) => {
      log.push(`fetch ${init?.method ?? "GET"} ${url} ${typeof init?.body === "string" ? init.body : String(init?.body ?? "")}`);
      if (url.includes("mybusinessbusinessinformation") && init?.method === "PATCH") {
        return Promise.resolve(new Response("{}", { status: o.googleStatus ?? 200 }));
      }
      if (url.includes("mybusinessaccountmanagement")) return Promise.resolve(new Response(JSON.stringify({ accounts: [{ name: "accounts/77" }, { name: "bad name" }] })));
      if (url.includes("/locations?")) {
        return Promise.resolve(new Response(JSON.stringify({
          locations: [
            { name: "locations/123", title: "Kvety Eva", storefrontAddress: { addressLines: ["Hlavná 1"], locality: "Senec" } },
            { name: "../evil", title: "x" },
          ],
        })));
      }
      return Promise.resolve(new Response("{}"));
    }) as unknown as typeof fetch,
    now: () => NOW,
  };
  return { deps, log, sent, parses };
}

const generic = (body: unknown, secret = GENERIC) =>
  new Request("https://p.supabase.co/functions/v1/hours-sms/inbound/generic", {
    method: "POST",
    headers: { "x-ppi-inbound": secret, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const owner = (body: unknown, jwt = "owner-jwt") =>
  new Request("https://p.supabase.co/functions/v1/hours-sms", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const calls = (log: string[], name: string) => log.filter((l) => l.startsWith(`db ${name} `)).map((l) => JSON.parse(l.slice(`db ${name} `.length)));

// ---------------------------------------------------------------- inbound

Deno.test("Twilio: a signed SMS is read, a wrong signature is refused, the answer is TwiML", async () => {
  const form = new URLSearchParams({ From: PHONE, Body: "Po 9-17", MessageSid: "SM1", To: "+421900000000" });
  const signature = await twilioSignature(TWILIO_TOKEN, TWILIO_URL, form);
  const signed = (sig: string) => new Request(TWILIO_URL, { method: "POST", headers: { "X-Twilio-Signature": sig, "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
  const { deps, log } = await setup();
  const ok = await handle(signed(signature), deps);
  eq(ok.status, 200, "accepted");
  eq(ok.headers.get("Content-Type"), "text/xml", "TwiML");
  eq(calls(log, "hours_sms_receive")[0], { p_phone: PHONE, p_body: "Po 9-17", p_provider: "inbound", p_ref: "twilio:SM1" }, "ref per provider");
  const bad = await setup();
  eq((await handle(signed(signature.slice(1) + "A"), bad.deps)).status, 403, "wrong signature");
  eq(bad.log.length, 0, "nothing read or written");
  eq(await readInbound("twilio", signed(signature), form.toString(), { twilioToken: null, twilioUrl: TWILIO_URL, genericSecret: null }), null, "no token = no inbound");
});

Deno.test("Twilio's signature: the address + the sorted fields (Twilio's documented example)", async () => {
  const params = new URLSearchParams({ CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" });
  eq(await twilioSignature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", params), "0/KCTR6DLpKmkAf8muzZqo1nDgQ=", "signature");
});

Deno.test("generic gateway: the secret header decides; a short secret is never accepted", async () => {
  const { deps } = await setup();
  eq((await handle(generic({ from: PHONE, text: "Po 9-17" }, "wrong".repeat(8)), deps)).status, 403, "wrong secret");
  const short = { twilioToken: null, twilioUrl: TWILIO_URL, genericSecret: "short" };
  eq(await readInbound("generic", generic({ from: PHONE, text: "x" }, "short"), JSON.stringify({ from: PHONE, text: "x" }), short), null, "short secret");
  const res = await handle(generic({ from: PHONE, text: "Po 9-17", id: "g1" }), deps);
  eq([res.status, await res.json()], [200, { outcome: "applied" }], "applied");
  eq((await handle(generic({ from: PHONE }), deps)).status, 403, "no text");
});

Deno.test("an unknown number, a repeated SMS or too many: nothing read, no reply", async () => {
  for (const o of [{ status: "unknown_phone" }, { status: "too_many" }, { status: "no_plan" }, { duplicate: true }] as Setup[]) {
    const { deps, log, sent, parses } = await setup(o);
    const res = await handle(generic({ from: "+421999999999", text: "Po 9-17" }), deps);
    eq((await res.json()).outcome, o.duplicate ? "duplicate" : o.status, "outcome");
    eq([sent.length, parses.length, calls(log, "hours_sms_apply").length, calls(log, "hours_sms_claim").length], [0, 0, 0, 0], `nothing for ${o.status ?? "duplicate"}`);
  }
});

// ---------------------------------------------------------------- applying

Deno.test("hours: read in the shop's day, applied, the page refreshed, Google updated, one confirmation SMS", async () => {
  const { deps, log, sent, parses } = await setup({ connected: true });
  const res = await handle(generic({ from: PHONE, text: "Po 9-17, Ne zatvorene" }), deps);
  eq((await res.json()).outcome, "applied", "applied");
  eq(parses[0], { text: "Po 9-17, Ne zatvorene", today: "2026-11-04", weekday: "wed", timezone: "Europe/Bratislava", shops: ["Kvety Eva"], current: { mon: [["08:00", "17:00"]] } }, "Claude's input");
  eq(calls(log, "hours_sms_apply")[0], { p_shop_id: SHOP, p_user_id: "u1", p_regular: { mon: [["09:00", "17:00"]], sun: [] }, p_special: [], p_sms_id: SMS_ID }, "only the named days");
  const revalidate = log.find((l) => l.includes("/api/revalidate"));
  eq(revalidate, `fetch POST https://cacaduu.com/api/revalidate {"slug":"kvety-eva"}`, "page refreshed");
  const patch = log.find((l) => l.startsWith("fetch PATCH"))!;
  eq(patch.split(" ")[2], "https://mybusinessbusinessinformation.googleapis.com/v1/locations/123?updateMask=regularHours,specialHours", "Google location");
  eq(JSON.parse(patch.split(" ").slice(3).join(" ")), {
    regularHours: { periods: [{ openDay: "MONDAY", openTime: { hours: 9 }, closeDay: "MONDAY", closeTime: { hours: 17 } }] },
    specialHours: { specialHourPeriods: [{ startDate: { year: 2026, month: 12, day: 24 }, closed: true }] },
  }, "the whole week + special days");
  eq(calls(log, "business_pushed").length, 1, "pushed noted");
  eq(sent, [`${PHONE} Cacaduu: otváracie hodiny Kvety Eva zmenené: Po 9–17, Ne zatvorené. Google: aktualizované.`], "confirmation");
  eq(calls(log, "hours_sms_claim")[0].p_kind, "hours_reply", "owner quota kind");
  const result = calls(log, "hours_sms_result")[0];
  eq([result.p_status, result.p_google, result.p_shop_id], ["applied", "pushed", SHOP], "written down");
});

Deno.test("Google not connected or failing: the hours still apply, the SMS says so", async () => {
  const off = await setup();
  await handle(generic({ from: PHONE, text: "Po 9-17" }), off.deps);
  eq(off.sent[0].endsWith("zmenené: Po 9–17, Ne zatvorené."), true, "no Google line");
  eq(calls(off.log, "hours_sms_result")[0].p_google, "not_connected", "not connected");
  const noLocation = await setup({ connected: true, location: null });
  await handle(generic({ from: PHONE, text: "Po 9-17" }), noLocation.deps);
  eq(calls(noLocation.log, "hours_sms_result")[0].p_google, "not_connected", "no location chosen");
  const failing = await setup({ connected: true, googleStatus: 401 });
  await handle(generic({ from: PHONE, text: "Po 9-17" }), failing.deps);
  eq(failing.sent[0].endsWith("Google: nepodarilo sa, skúste v Môj obchod."), true, "failed line");
  eq(calls(failing.log, "business_failed")[0], { p_shop_id: SHOP, p_status: "expired", p_error: "google 401" }, "expired noted");
  eq(calls(failing.log, "hours_sms_apply").length, 1, "applied anyway");
});

Deno.test("not clear, not hours, bad times or refused by the database: ask again, change nothing", async () => {
  const cases: [Setup, string, string][] = [
    [{ parse: parsed({ intent: "unclear", language: "en" }) }, "unclear", "Cacaduu: I did not understand."],
    [{ parse: null }, "unclear", "Cacaduu: nerozumel som."],
    [{ parse: parsed({ intent: "other", language: "hu" }) }, "not_hours", "Cacaduu: SMS-ben csak a nyitvatartást módosíthatja."],
    [{ parse: parsed({ regular: [{ day: "mon", closed: false, ranges: [{ from: "25:00", to: "17:00" }] }] }) }, "unclear", "Cacaduu: nerozumel som."],
    [{ parse: parsed({ regular: [] }) }, "unclear", "Cacaduu: nerozumel som."],
    [{ rpc: { hours_sms_apply: { error: { message: "ranges" } } } }, "unclear", "Cacaduu: nerozumel som."],
  ];
  for (const [o, outcome, start] of cases) {
    const { deps, log, sent } = await setup(o);
    eq((await (await handle(generic({ from: PHONE, text: "?" }), deps)).json()).outcome, outcome, `outcome ${outcome}`);
    eq(sent.length === 1 && sent[0].startsWith(`${PHONE} ${start}`), true, `reply ${start}`);
    eq(log.some((l) => l.includes("PATCH") || l.includes("/api/revalidate")), false, "no Google, no refresh");
    eq(calls(log, "hours_sms_result")[0].p_status, outcome, "written down");
  }
});

Deno.test("several shops: the SMS must name one (accents and case ignored)", async () => {
  const shops = [shopRow(SHOP, "Kvety Eva"), shopRow(SHOP2, "Pekáreň Dub")];
  const ask = await setup({ shops });
  eq((await (await handle(generic({ from: PHONE, text: "Po 9-17" }), ask.deps)).json()).outcome, "which_shop", "which shop");
  eq(ask.sent[0], `${PHONE} Cacaduu: pre ktorý obchod? Napíšte jeho názov na začiatok: Kvety Eva, Pekáreň Dub.`, "lists the shops");
  eq(calls(ask.log, "hours_sms_apply").length, 0, "nothing applied");
  const named = await setup({ shops, parse: parsed({ shop: "pekaren dub", regular: [{ day: "sat", closed: false, ranges: [{ from: "7", to: "12" }] }] }) });
  eq((await (await handle(generic({ from: PHONE, text: "Pekaren Dub So 7-12" }), named.deps)).json()).outcome, "applied", "applied");
  eq(calls(named.log, "hours_sms_apply")[0].p_shop_id, SHOP2, "the named shop");
});

Deno.test("the owner's SMS quota is used up: hours apply, the reply is not sent", async () => {
  const { deps, log, sent } = await setup({ rpc: { hours_sms_claim: { error: { message: "sms_quota" } } } });
  eq((await (await handle(generic({ from: PHONE, text: "Po 9-17" }), deps)).json()).outcome, "applied", "applied");
  eq([sent.length, calls(log, "hours_sms_settle").length], [0, 0], "nothing sent");
});

// ---------------------------------------------------------------- the rules

Deno.test("checkParsed: the database's rules", () => {
  const today = "2026-11-04";
  const r = (from: string, to: string) => parsed({ regular: [{ day: "fri", closed: false, ranges: [{ from, to }] }] });
  eq(checkParsed(r("8", "17"), today)?.regular, { fri: [["08:00", "17:00"]] }, "8 → 08:00");
  eq(checkParsed(r("18:00", "02:00"), today)?.regular, { fri: [["18:00", "02:00"]] }, "past midnight");
  eq(checkParsed(r("08:00", "24:00"), today)?.regular, { fri: [["08:00", "24:00"]] }, "until midnight");
  eq(checkParsed(r("08:00", "08:00"), today), null, "same time");
  eq(checkParsed(r("24:00", "08:00"), today), null, "24:00 only as an end");
  eq(checkParsed(parsed({ regular: [{ day: "fri", closed: false, ranges: [] }] }), today), null, "open with no times");
  const s = (from: string, to: string | null) => parsed({ special: [{ from, to, closed: true, ranges: [] }] });
  eq(checkParsed(s("2026-12-24", null), today)?.special, [{ from: "2026-12-24", to: "2026-12-24", closed: true, ranges: [] }], "one day");
  eq(checkParsed(s("2026-11-02", null), today), null, "in the past");
  eq(checkParsed(s("2026-11-03", null), today) !== null, true, "yesterday allowed (time zones)");
  eq(checkParsed(s("2026-08-01", "2026-07-01"), today), null, "backwards");
  eq(checkParsed(s("2026-12-01", "2027-03-01"), today), null, "over 62 days");
  eq(checkParsed(s("2028-01-01", null), today), null, "over 400 days ahead");
  eq(checkParsed(s("2026-13-01", null), today), null, "no such date");
  eq(checkParsed(parsed({ special: Array.from({ length: 11 }, (_, i) => ({ from: `2026-12-${String(i + 1).padStart(2, "0")}`, to: null, closed: true, ranges: [] })) }), today), null, "≤ 10 rows");
});

Deno.test("the reply: neighbouring days joined, special days, languages", () => {
  const change = {
    regular: { mon: [["08:00", "17:00"]], tue: [["08:00", "17:00"]], wed: [["08:00", "17:00"]], thu: [["08:00", "12:00"], ["13:00", "17:30"]], sun: [] },
    special: [{ from: "2026-12-24", to: "2026-12-26", closed: true, ranges: [] }, { from: "2026-12-31", to: "2026-12-31", closed: false, ranges: [["08:00", "12:00"]] }],
  };
  eq(describeChange(change, "sk"), "Po–St 8–17, Št 8–12, 13–17:30, Ne zatvorené; 24.12.–26.12. zatvorené, 31.12. 8–12", "sk");
  eq(describeChange(change, "hu"), "H–Sze 8–17, Cs 8–12, 13–17:30, V zárva; 24.12.–26.12. zárva, 31.12. 8–12", "hu");
  eq(describeChange({ regular: { mon: [["08:00", "17:00"]], wed: [["08:00", "17:00"]] }, special: [] }, "en"), "Mon 8–17, Wed 8–17", "not neighbours");
  eq([replyLang("cs"), replyLang("hu"), replyLang("en"), replyLang("de"), replyLang(undefined)], ["sk", "hu", "en", "sk", "sk"], "languages");
  eq(replyText("applied", "en", { shop: "Eva", what: "Mon 8–17", google: "pushed" }), "Cacaduu: opening hours of Eva changed: Mon 8–17. Google: updated.", "en");
});

Deno.test("Google's hours: overnight closes the next day, Sunday wraps to Monday, special days", () => {
  eq(googleRegular({ fri: [["18:00", "02:00"]], sun: [["20:00", "01:30"]], sat: [["08:00", "24:00"]] }).periods, [
    { openDay: "FRIDAY", openTime: { hours: 18 }, closeDay: "SATURDAY", closeTime: { hours: 2 } },
    { openDay: "SATURDAY", openTime: { hours: 8 }, closeDay: "SATURDAY", closeTime: { hours: 24 } },
    { openDay: "SUNDAY", openTime: { hours: 20 }, closeDay: "MONDAY", closeTime: { hours: 1, minutes: 30 } },
  ], "periods");
  eq(googleSpecial([{ date: "2026-12-31", closed: false, ranges: [["20:00", "02:00"]] }, { date: "2026-12-25", closed: true, ranges: [] }]).specialHourPeriods, [
    { startDate: { year: 2026, month: 12, day: 31 }, openTime: { hours: 20 }, endDate: { year: 2027, month: 1, day: 1 }, closeTime: { hours: 2 } },
    { startDate: { year: 2026, month: 12, day: 25 }, closed: true },
  ], "special");
  eq(localToday("Pacific/Auckland", new Date("2026-11-04T12:00:00Z")), { today: "2026-11-05", weekday: "thu" }, "the shop's own day");
});

// ---------------------------------------------------------------- the owner

Deno.test("owner: login and membership first", async () => {
  const { deps } = await setup();
  eq((await handle(owner({ action: "config" }, "stranger"), deps)).status, 401, "no login");
  const config = await (await handle(owner({ action: "config" }), deps)).json();
  eq(config, { number: "+421900000000", google: true, sms_live: false, reading: true }, "config");
  eq((await handle(owner({ action: "phone_start", shop_id: "x" }), deps)).status, 400, "bad shop id");
  const other = await setup({ rpc: { "caller:is_shop_member": { data: false } } });
  eq((await handle(owner({ action: "phone_start", shop_id: SHOP, phone: PHONE }), other.deps)).status, 403, "not a member");
  eq(calls(other.log, "hours_phone_start").length, 0, "no code made");
});

Deno.test("phone_start: the code goes only by SMS (test mode shows it only with the switch)", async () => {
  const { deps, log, sent } = await setup();
  const res = await handle(owner({ action: "phone_start", shop_id: SHOP, phone: "0905 111 222" }), deps);
  eq(await res.json(), { id: "ph-1", phone: "+421 ••• ••• 222", sms: "test" }, "no code in the answer");
  eq(calls(log, "hours_phone_start")[0], { p_user_id: "u1", p_shop_id: SHOP, p_phone: "0905 111 222" }, "the owner from the login");
  eq(sent, [`${PHONE} Cacaduu: kod 123456 (10 min).`], "the code SMS");
  eq(calls(log, "hours_sms_claim")[0].p_kind, "phone_code", "kind");
  const shown = await setup({ showTestCodes: true });
  eq((await (await handle(owner({ action: "phone_start", shop_id: SHOP, phone: PHONE }), shown.deps)).json()).test_code, "123456", "test code");
  const live = await setup({ showTestCodes: true, sms: { name: "brevo", live: true, send: () => Promise.resolve({ ok: true, ref: "1" }) } });
  eq("test_code" in await (await handle(owner({ action: "phone_start", shop_id: SHOP, phone: PHONE }), live.deps)).json(), false, "never with a real provider");
  const quota = await setup({ rpc: { hours_sms_claim: { error: { message: "sms_quota" } } } });
  eq([(await handle(owner({ action: "phone_start", shop_id: SHOP, phone: PHONE }), quota.deps)).status], [429], "quota");
  const failed = await setup({ sms: { name: "brevo", live: true, send: () => Promise.resolve({ ok: false, error: "brevo 402" }) } });
  eq((await handle(owner({ action: "phone_start", shop_id: SHOP, phone: PHONE }), failed.deps)).status, 502, "failed");
  const many = await setup({ rpc: { hours_phone_start: { error: { message: "too_many" } } } });
  eq(await (await handle(owner({ action: "phone_start", shop_id: SHOP, phone: PHONE }), many.deps)).json(), { error: "too_many" }, "too many");
});

Deno.test("google_connect: only business.manage, PKCE, the owner's own page to come back to", async () => {
  const { deps, log } = await setup();
  eq((await handle(owner({ action: "google_connect", shop_id: SHOP, return_url: "https://evil.example/x" }), deps)).status, 400, "foreign page");
  const res = await handle(owner({ action: "google_connect", shop_id: SHOP, return_url: "https://cacaduu.com/sk/dashboard/hours-sms?shop=a" }), deps);
  const url = new URL((await res.json()).url);
  eq(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth", "Google");
  eq([url.searchParams.get("scope"), url.searchParams.get("code_challenge_method"), url.searchParams.get("redirect_uri"), url.searchParams.get("access_type")],
    [BUSINESS_SCOPE, "S256", "https://p.supabase.co/functions/v1/hours-sms/oauth", "offline"], "parameters");
  const begin = calls(log, "business_oauth_begin")[0];
  eq([begin.p_state_hash.length, begin.p_state_hash === url.searchParams.get("state")], [64, false], "only the state's hash stored");
  const noPlan = await setup({ rpc: { "caller:shop_has_plan": { data: false } } });
  eq((await handle(owner({ action: "google_connect", shop_id: SHOP, return_url: "https://cacaduu.com/sk/dashboard/hours-sms" }), noPlan.deps)).status, 403, "Pro only");
  eq([cleanReturnUrl("http://localhost:3000/sk/dashboard/hours-sms"), cleanReturnUrl("http://cacaduu.com/sk/dashboard/hours-sms"), cleanReturnUrl("javascript:alert(1)")],
    ["http://localhost:3000/sk/dashboard/hours-sms", null, null], "return addresses");
});

Deno.test("Google: locations listed (only well-formed names), push uses the shop's saved week", async () => {
  const { deps, log } = await setup({ connected: true });
  const list = await (await handle(owner({ action: "google_locations", shop_id: SHOP }), deps)).json();
  eq(list, { locations: [{ name: "locations/123", title: "Kvety Eva", address: "Hlavná 1, Senec" }] }, "locations");
  eq(log.filter((l) => l.includes("/locations?")).length, 1, "only the well-formed account");
  const push = await handle(owner({ action: "google_push", shop_id: SHOP }), deps);
  eq(await push.json(), { result: "pushed" }, "pushed");
  const body = JSON.parse(log.find((l) => l.startsWith("fetch PATCH"))!.split(" ").slice(3).join(" "));
  eq(body.regularHours.periods, [{ openDay: "TUESDAY", openTime: { hours: 8 }, closeDay: "TUESDAY", closeTime: { hours: 12 } }], "the saved week");
  const off = await setup();
  eq((await handle(owner({ action: "google_locations", shop_id: SHOP }), off.deps)).status, 400, "not connected");
});

Deno.test("Google's answer: state taken once, scope checked, tokens stored encrypted", async () => {
  const { deps, log } = await setup({
    rpc: { business_oauth_take: { data: [{ shop_id: SHOP, user_id: "u1", verifier: "v", return_url: "https://cacaduu.com/sk/dashboard/hours-sms" }] } },
  });
  const tokenFetch = deps.fetch;
  deps.fetch = ((url: string, init: RequestInit) =>
    url.includes("oauth2.googleapis.com/token")
      ? Promise.resolve(new Response(JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_in: 3600, scope: BUSINESS_SCOPE })))
      : tokenFetch(url, init)) as typeof fetch;
  const res = await handle(new Request("https://p.supabase.co/functions/v1/hours-sms/oauth?state=s1&code=c1"), deps);
  eq([res.status, res.headers.get("Location")], [303, "https://cacaduu.com/sk/dashboard/hours-sms?ok=google_connected"], "back");
  const saved = calls(log, "business_save")[0];
  eq([saved.p_access_enc.includes("a1"), saved.p_refresh_enc.includes("r1"), saved.p_user_id], [false, false, "u1"], "encrypted");
  const denied = await handle(new Request("https://p.supabase.co/functions/v1/hours-sms/oauth?state=s1&error=access_denied"), deps);
  eq(denied.headers.get("Location"), "https://cacaduu.com/sk/dashboard/hours-sms?err=google_denied", "denied");
  const unknown = await setup();
  eq((await handle(new Request("https://p.supabase.co/functions/v1/hours-sms/oauth?state=zzz&code=c1"), unknown.deps)).status, 400, "unknown state");
});
