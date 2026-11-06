// Unit tests of crm-messages: who may send, what is written down first, what goes to Brevo, SMS in test mode.
// Run: npm run test:functions
import { alertMail, brevoBody, type Deps, foodAlertMail, handle, inboundWays, reason, smsProvider, testSms } from "./index.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}

const CONTACT = "11111111-2222-4333-8444-555555555555";
const MESSAGE = "99999999-2222-4333-8444-555555555555";

function setup(o: { queueError?: { message: string; code?: string }; channel?: "sms" | "email"; brevo?: number; email?: boolean; sms?: Deps["sms"]; siteUrl?: string | null } = {}) {
  const log: string[] = [];
  const deps: Deps = {
    db: {
      rpc: (name, args) => {
        log.push(`db ${name} ${JSON.stringify(args)}`);
        return Promise.resolve({ data: true, error: null });
      },
    },
    asCaller: () => ({
      auth: { getUser: (token: string) => Promise.resolve({ data: { user: token === "owner-jwt" ? { id: "u" } : null } }) },
      rpc: (name: string, args: Record<string, unknown>) => {
        log.push(`caller ${name} ${JSON.stringify(args)}`);
        if (o.queueError) return Promise.resolve({ data: null, error: o.queueError });
        return Promise.resolve({
          data: {
            id: MESSAGE,
            channel: o.channel ?? "email",
            recipient: o.channel === "sms" ? "+421905123456" : "jana@example.invalid",
            subject: o.channel === "sms" ? null : "Dobrý deň",
            body: "Ahoj Jana",
            shop_name: 'Farby "Kováč"',
            reply_to: "obchod@example.invalid",
          },
          error: null,
        });
      },
    }),
    siteUrl: o.siteUrl === undefined ? "https://cacaduu.example" : o.siteUrl,
    email: o.email === false ? null : { apiKey: "key", from: "noreply@cacaduu.example" },
    sms: o.sms ?? testSms,
    fetch: ((url: string, init: RequestInit) => {
      log.push(`fetch ${url} ${init.body}`);
      return Promise.resolve(new Response(JSON.stringify({ messageId: "<m1>" }), { status: o.brevo ?? 201 }));
    }) as unknown as typeof fetch,
  };
  return { deps, log };
}

const post = (body: unknown, token = "owner-jwt") =>
  new Request("https://x/functions/v1/crm-messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

Deno.test("only a logged-in owner, only POST", async () => {
  const { deps } = setup();
  eq((await handle(new Request("https://x", { method: "GET" }), deps)).status, 405, "GET");
  eq((await handle(post({ action: "config" }, "nobody"), deps)).status, 401, "no login");
  eq(await (await handle(post({ action: "config" }), deps)).json(), { email: true, sms: "test", sms_live: false }, "config");
  const withInfo = { ...deps, smsInfo: { sender: "Cacaduu", inbound: ["infobip", "generic"], number: true } };
  eq(await (await handle(post({ action: "config" }), withInfo)).json(), {
    email: true, sms: "test", sms_live: false, sms_sender: "Cacaduu", sms_inbound: ["infobip", "generic"], sms_number: true,
  }, "config with the sender and the inbound ways");
  eq([inboundWays(() => undefined), inboundWays((n) => (n === "TWILIO_AUTH_TOKEN" ? "t" : n === "INBOUND_SMS_SECRET" ? "short" : undefined)),
    inboundWays((n) => (n === "INBOUND_SMS_SECRET" ? "s".repeat(32) : undefined))], [[], ["twilio"], ["infobip", "generic"]], "inbound ways");
});

Deno.test("an e-mail: written down first, sent through Brevo with the shop as the sender's name, result reported", async () => {
  const { deps, log } = setup();
  const res = await handle(post({ action: "send", contact_id: CONTACT, channel: "email", subject: "x", body: "y" }), deps);
  eq(await res.json(), { id: MESSAGE, status: "sent" }, "answer");
  eq(log[0].startsWith("caller owner_message_queue"), true, "the database first, with the owner's login");
  const sent = JSON.parse(log[1].slice(log[1].indexOf("{")));
  eq(sent.sender, { name: "Farby Kováč", email: "noreply@cacaduu.example" }, "sender");
  eq(sent.replyTo, { email: "obchod@example.invalid", name: "Farby Kováč" }, "reply to the shop");
  eq([sent.to, sent.subject, sent.textContent], [[{ email: "jana@example.invalid" }], "Dobrý deň", "Ahoj Jana"], "message as written down");
  eq(log[2], `db crm_message_result {"p_id":"${MESSAGE}","p_status":"sent","p_provider":"brevo","p_ref":"<m1>","p_error":null}`, "result");
});

Deno.test("Brevo refuses or e-mail is not set up: failed, still reported", async () => {
  const refused = setup({ brevo: 400 });
  eq(await (await handle(post({ action: "send", contact_id: CONTACT, channel: "email" }), refused.deps)).json(), { id: MESSAGE, status: "failed" }, "refused");
  eq(refused.log.at(-1)!.includes('"p_status":"failed"'), true, "reported failed");
  const none = setup({ email: false });
  eq(await (await handle(post({ action: "send", contact_id: CONTACT, channel: "email" }), none.deps)).json(), { id: MESSAGE, status: "failed" }, "no Brevo");
  eq(none.log.some((l) => l.startsWith("fetch")), false, "nothing fetched");
});

Deno.test("an SMS without a provider is written down as test and nothing leaves", async () => {
  const { deps, log } = setup({ channel: "sms" });
  eq(await (await handle(post({ action: "send", contact_id: CONTACT, channel: "sms", body: "Ahoj" }), deps)).json(), { id: MESSAGE, status: "test" }, "test");
  eq(log.some((l) => l.startsWith("fetch")), false, "nothing sent");
  eq(log.at(-1)!.includes('"p_status":"test","p_provider":"test"'), true, "reported test");
  const unknown = setup({ channel: "sms", sms: smsProvider("nope") });
  eq(await (await handle(post({ action: "send", contact_id: CONTACT, channel: "sms", body: "Ahoj" }), unknown.deps)).json(), { id: MESSAGE, status: "failed" }, "unknown provider");
  eq(smsProvider(undefined).live, false, "default is test");
});

Deno.test("bad requests and the database's refusals", async () => {
  const { deps, log } = setup();
  eq((await handle(post({ action: "send", contact_id: "x", channel: "email" }), deps)).status, 400, "bad id");
  eq((await handle(post({ action: "send", contact_id: CONTACT, channel: "fax" }), deps)).status, 400, "bad channel");
  eq(log.length, 0, "nothing asked");
  const plan = setup({ queueError: { message: "no_plan", code: "P0001" } });
  const res = await handle(post({ action: "send", contact_id: CONTACT, channel: "sms" }), plan.deps);
  eq([res.status, await res.json()], [400, { error: "no_plan" }], "no plan");
  eq(plan.log.some((l) => l.startsWith("db ") || l.startsWith("fetch")), false, "nothing sent or reported");
  const other = setup({ queueError: { message: "Not your shop", code: "42501" } });
  eq((await handle(post({ action: "send", contact_id: CONTACT, channel: "sms" }), other.deps)).status, 403, "another shop");
  eq(reason({ message: "boom" }), "failed", "unknown reason");
  const quota = setup({ queueError: { message: "sms_quota", code: "54000" } });
  const q = await handle(post({ action: "send", contact_id: CONTACT, channel: "sms", body: "Ahoj" }), quota.deps);
  eq([q.status, await q.json()], [400, { error: "sms_quota" }], "the month's SMS used up");
  eq(quota.log.some((l) => l.startsWith("fetch") || l.startsWith("db ")), false, "nothing sent at the quota limit");
});

Deno.test("the sender's name never breaks the header", () => {
  eq(brevoBody({ to: "a@b.c", subject: "s", text: "t", shopName: 'A"<b>\r\nc', replyTo: "bad" }, "f@x.y").sender.name, "Abc", "cleaned");
  eq("replyTo" in brevoBody({ to: "a@b.c", subject: "s", text: "t", shopName: "", replyTo: "bad" }, "f@x.y"), false, "bad reply-to left out");
});

function alertSetup(o: { cronOk?: boolean; rows?: unknown[]; brevo?: number } = {}) {
  const log: string[] = [];
  const rows = o.rows ?? [{
    id: "a1",
    shop_name: "Farby Kováč",
    kind: "callback",
    conversation_id: "c1",
    question: "Máte modré obkladačky?",
    has_phone: true,
    has_email: false,
    recipients: [{ email: "owner@example.invalid", lang: "sk" }, { email: "co-owner@example.invalid", lang: "hu" }],
  }];
  const deps: Deps = {
    db: {
      rpc: (name, args) => {
        log.push(`db ${name} ${JSON.stringify(args)}`);
        if (name === "crm_cron_ok") return Promise.resolve({ data: o.cronOk ?? true, error: null });
        if (name === "crm_alerts_due") return Promise.resolve({ data: rows, error: null });
        return Promise.resolve({ data: null, error: null });
      },
    },
    asCaller: () => {
      throw new Error("the job never acts as an owner");
    },
    siteUrl: "https://cacaduu.example",
    email: { apiKey: "key", from: "noreply@cacaduu.example" },
    sms: testSms,
    fetch: ((url: string, init: RequestInit) => {
      log.push(`fetch ${url} ${init.body}`);
      return Promise.resolve(new Response(JSON.stringify({ messageId: "<m1>" }), { status: o.brevo ?? 201 }));
    }) as unknown as typeof fetch,
  };
  return { deps, log };
}
const job = (body: unknown, secret = "s".repeat(40)) =>
  new Request("https://x/functions/v1/crm-messages", { method: "POST", headers: { "x-ppi-cron": secret }, body: JSON.stringify(body) });

Deno.test("owner e-mails: each owner in their language, the question and a link, never the shopper's number", async () => {
  const { deps, log } = alertSetup();
  eq(await (await handle(job({ action: "alerts" }), deps)).json(), { alerts: 1, food: 0 }, "one shopper waiting");
  const mails = log.filter((l) => l.startsWith("fetch"));
  eq(mails.length, 2, "both owners");
  const sk = JSON.parse(mails[0].slice(mails[0].indexOf("{")));
  eq(sk.to, [{ email: "owner@example.invalid" }], "first owner");
  eq(sk.subject, "Nový zákazník, prosím odpovedzte – Farby Kováč", "Slovak subject");
  eq(sk.textContent.includes("„Máte modré obkladačky?“") && sk.textContent.includes("https://cacaduu.example/sk/dashboard/conversations/c1"), true, "question + link");
  eq(sk.textContent.includes("telefón"), true, "says a phone was left");
  eq(JSON.stringify(mails).includes("+421"), false, "no number");
  eq(JSON.parse(mails[1].slice(mails[1].indexOf("{"))).subject.startsWith("Új ügyfél"), true, "Hungarian for the second owner");
  eq(log.some((l) => l.startsWith("db crm_alert_result") && l.includes('"p_ok":true')), true, "marked sent");
});

Deno.test("owner e-mails: wrong secret refused, a Brevo failure is retried later", async () => {
  const bad = alertSetup({ cronOk: false });
  eq((await handle(job({ action: "alerts" }), bad.deps)).status, 403, "wrong secret");
  eq(bad.log.some((l) => l.startsWith("db crm_alerts_due")), false, "nothing read");
  const down = alertSetup({ brevo: 500 });
  eq(await (await handle(job({ action: "alerts" }), down.deps)).json(), { alerts: 0, food: 0 }, "not sent");
  eq(down.log.some((l) => l.startsWith("db crm_alert_result") && l.includes('"p_ok":false')), true, "tried again later");
  const none = alertSetup({ rows: [{ id: "a2", shop_name: "X", kind: "callback", conversation_id: null, question: null, has_phone: false, has_email: true, recipients: [] }] });
  await handle(job({ action: "alerts" }), none.deps);
  eq(none.log.some((l) => l.includes("no owner e-mail")), true, "no owner address");
  eq((await handle(job({ action: "other" }), alertSetup().deps)).status, 400, "only alerts");
});

Deno.test("the owner e-mail in English for other languages, without a link when SITE_URL is missing", () => {
  const m = alertMail({ id: "a", shop_name: "Shop\nName", kind: "callback", conversation_id: "c", question: null, has_phone: false, has_email: true, recipients: [] }, "de", null);
  eq(m.subject, "New customer, please reply – Shop Name", "English, one line");
  eq(m.text.includes("http"), false, "no link");
  eq(m.text.includes("an e-mail address"), true, "says an e-mail was left");
});

// ---------------------------------------------------------------- the owner's MCP (database update 61)

function mcpSetup(error?: { message: string; code?: string }) {
  const log: string[] = [];
  const base = setup({ channel: "sms" });
  const deps: Deps = {
    ...base.deps,
    db: {
      rpc: (name, args) => {
        log.push(`db ${name} ${JSON.stringify(args)}`);
        if (name === "owner_mcp_message_queue") {
          if (error) return Promise.resolve({ data: null, error });
          return Promise.resolve({
            data: { id: MESSAGE, channel: "sms", recipient: "+421905123456", subject: null, body: "Ahoj", shop_name: "Farby", reply_to: null },
            error: null,
          });
        }
        return Promise.resolve({ data: true, error: null });
      },
    },
    asCaller: () => {
      throw new Error("the MCP path never uses an owner login");
    },
  };
  return { deps, log };
}
const mcpPost = (body: unknown, token = "cma_" + "a".repeat(64)) =>
  new Request("https://x/functions/v1/crm-messages", {
    method: "POST",
    headers: { "x-ppi-mcp": token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

Deno.test("MCP: a previewed message goes out through the database's check, then the provider, then the result", async () => {
  const { deps, log } = mcpSetup();
  const res = await handle(mcpPost({ action: "mcp_send", confirmation_id: CONTACT }), deps);
  eq([res.status, await res.json()], [200, { id: MESSAGE, status: "test" }], "sent in test mode");
  eq(log[0], `db owner_mcp_message_queue {"p_token":"cma_${"a".repeat(64)}","p_confirmation":"${CONTACT}"}`, "the token and the preview checked first");
  eq(log[1].startsWith(`db crm_message_result {"p_id":"${MESSAGE}","p_status":"test"`), true, "result stored once");
});

Deno.test("MCP: refusals are passed on; bad requests touch nothing", async () => {
  for (const [error, status, why] of [
    [{ message: "invalid_token", code: "28000" }, 401, "invalid_token"],
    [{ message: "scope: messages.send", code: "42501" }, 403, "scope"],
    [{ message: "preview_changed", code: "22023" }, 400, "preview_changed"],
    [{ message: "confirmation", code: "22023" }, 400, "confirmation"],
    [{ message: "sms_quota", code: "54000" }, 400, "sms_quota"],
  ] as const) {
    const { deps, log } = mcpSetup(error);
    const res = await handle(mcpPost({ action: "mcp_send", confirmation_id: CONTACT }), deps);
    eq([res.status, await res.json()], [status, { error: why }], why);
    eq(log.length, 1, `${why}: nothing sent`);
  }
  const { deps, log } = mcpSetup();
  eq((await handle(mcpPost({ action: "mcp_send", confirmation_id: "x" }), deps)).status, 400, "bad id");
  eq((await handle(mcpPost({ action: "send", confirmation_id: CONTACT }), deps)).status, 400, "other action");
  eq((await handle(mcpPost({ action: "mcp_send", confirmation_id: CONTACT }, "short"), deps)).status, 400, "short token");
  eq(log.length, 0, "nothing read");
});

// ---------------------------------------------------------------- update 63

Deno.test("reply: the owner answers in a conversation; refusals are passed on; the e-mail's reply-to is the shop", async () => {
  const { deps, log } = setup();
  const res = await handle(post({ action: "reply", conversation_id: CONTACT, channel: "email", body: "Áno, máme." }), deps);
  eq((await res.json()).status, "sent", "sent");
  eq(log.find((l) => l.startsWith("caller owner_reply"))!.includes(`"p_conversation_id":"${CONTACT}"`), true, "as the owner");
  const brevo = JSON.parse(log.find((l) => l.startsWith("fetch "))!.split(" ").slice(2).join(" "));
  eq(brevo.replyTo.email, "obchod@example.invalid", "reply-to = the shop's e-mail");
  eq((await handle(post({ action: "reply", conversation_id: "x", channel: "email" }), deps)).status, 400, "bad id");
  const none = setup({ queueError: { message: "no_contact", code: "22023" } });
  eq(await (await handle(post({ action: "reply", conversation_id: CONTACT, channel: "sms" }), none.deps)).json(), { error: "no_contact" },
    "a conversation without a contact");
  const quota = setup({ queueError: { message: "sms_quota", code: "54000" } });
  eq(await (await handle(post({ action: "reply", conversation_id: CONTACT, channel: "sms" }), quota.deps)).json(), { error: "sms_quota" },
    "over the quota: a clear reason");
});

Deno.test("Všetko o mne: the owners' e-mail says what was deleted and that copies outside Cacaduu are theirs to delete", () => {
  const row = { id: "a", shop_name: "Farby", kind: "forget_all" as const, conversation_id: null, question: null, has_phone: false,
    has_email: false, recipients: [] };
  const sk = alertMail(row, "sk", "https://cacaduu.com");
  eq(sk.subject, "Zákazník vymazal svoje údaje – Farby", "subject");
  eq(sk.text.includes("cloudovom priečinku") && sk.text.includes("zrušili jeho budúce rezervácie"), true, "copies + bookings");
  eq(/\+?\d{9,}|@/.test(sk.text), false, "no number or address of the shopper");
  eq(alertMail(row, "de", null).subject, "A customer deleted their data – Farby", "English otherwise");
});

// ---------------------------------------------------------------- update 74

Deno.test("a new food order: the owner e-mail has the number, the time, the items and the total — no phone or address", () => {
  const row = {
    id: "a", shop_name: "Ukážková pizzeria", order_id: CONTACT, number: 1047, kind: "delivery" as const, pay_method: "qr" as const,
    total_cents: 3560, created_at: "2026-11-03T17:35:00Z", ready_by: "2026-11-03T18:20:00Z", timezone: "Europe/Bratislava",
    items: "2× Margherita 32 cm (+ olivy), 2× Kofola 0,5 l", recipients: [],
  };
  const sk = foodAlertMail(row, "sk", "https://cacaduu.com");
  eq(sk.subject, "Nová objednávka č. 1047 – Ukážková pizzeria", "subject");
  eq(sk.text.includes("Donáška do 19:20") && sk.text.includes("2× Margherita 32 cm (+ olivy)"), true, "time in the shop's zone + items");
  eq(sk.text.includes("35,60") && sk.text.includes("(QR)"), true, "total + payment");
  eq(sk.text.includes(`https://cacaduu.com/sk/dashboard/assistant/orders/${CONTACT}`), true, "the order's page");
  eq(/\+?\d{9,}|@/.test(sk.text.replace(/https:\S+/g, "")), false, "no phone number or e-mail address");
  const en = foodAlertMail({ ...row, kind: "pickup" }, "de", null);
  eq(en.subject.startsWith("New order no. 1047") && en.text.includes("Pickup at 19:20"), true, "English otherwise, pickup");
  // update 81: a shop without payments in Cacaduu — no method, no empty brackets
  const none = foodAlertMail({ ...row, pay_method: null }, "sk", null);
  eq(none.text.includes("Spolu: 35,60") && none.text.includes("platba pri prevzatí") && !none.text.includes("()") && !none.text.includes("null"), true, "no method");

  // update 87: the zone the customer picked, after the delivery time (never for a pickup)
  eq(foodAlertMail({ ...row, zone: "Veľké Kapušany" }, "sk", null).text.includes("Donáška do 19:20 · Veľké Kapušany"), true, "the zone");
  eq(foodAlertMail({ ...row, kind: "pickup", zone: "Veľké Kapušany" }, "sk", null).text.includes("Kapušany"), false, "no zone for a pickup");
  eq(foodAlertMail({ ...row, zone: null }, "sk", null).text.includes("Donáška do 19:20\n"), true, "no zone: as before");
});

Deno.test("food_sms: written down as the owner first (owner_food_sms_queue), then sent; refusals passed on", async () => {
  const { deps, log } = setup({ channel: "sms" });
  const res = await handle(post({ action: "food_sms", shop_id: CONTACT, order_id: MESSAGE }), deps);
  eq((await res.json()).status, "test", "sent in test mode");
  eq(log.some((l) => l.startsWith("caller owner_food_sms_queue") && l.includes(`"p_order_id":"${MESSAGE}"`)), true, "as the owner");
  eq(log.some((l) => l.startsWith("db crm_message_result")), true, "the result stored");
  eq((await handle(post({ action: "food_sms", shop_id: "x", order_id: MESSAGE }), deps)).status, 400, "bad id");
  for (const why of ["already_sent", "sms_quota", "step", "no_plan"]) {
    const refused = setup({ queueError: { message: why, code: "P0001" } });
    eq(await (await handle(post({ action: "food_sms", shop_id: CONTACT, order_id: MESSAGE }), refused.deps)).json(), { error: why }, why);
  }
});

// ---------------------------------------------------------------- update 75

Deno.test("courier_invite: written down as the owner first with the site's address, then sent; refusals passed on", async () => {
  const { deps, log } = setup({ channel: "sms" });
  const res = await handle(post({ action: "courier_invite", shop_id: CONTACT, courier_id: MESSAGE, lang: "hu" }), deps);
  eq((await res.json()).status, "test", "sent in test mode");
  const call = log.find((l) => l.startsWith("caller owner_food_courier_invite"))!;
  eq(call.includes('"p_site":"https://cacaduu.example"') && call.includes('"p_lang":"hu"') && call.includes(`"p_id":"${MESSAGE}"`), true, "as the owner");
  eq(log.some((l) => l.startsWith("db crm_message_result")), true, "the result stored");
  eq((await handle(post({ action: "courier_invite", shop_id: CONTACT, courier_id: "x" }), deps)).status, 400, "bad id");
  const noSite = setup({ siteUrl: null });
  eq((await handle(post({ action: "courier_invite", shop_id: CONTACT, courier_id: MESSAGE }), noSite.deps)).status, 503, "no SITE_URL: nothing");
  eq(noSite.log.length, 0, "nothing written down");
  for (const why of ["too_many", "sms_quota", "inactive", "no_plan"]) {
    const refused = setup({ queueError: { message: why, code: "P0001" } });
    eq(await (await handle(post({ action: "courier_invite", shop_id: CONTACT, courier_id: MESSAGE }), refused.deps)).json(), { error: why }, why);
  }
});
