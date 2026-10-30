// Unit tests of crm-messages: who may send, what is written down first, what goes to Brevo, SMS in test mode.
// Run: npm run test:functions
import { brevoBody, type Deps, handle, reason, smsProvider, testSms } from "./index.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}

const CONTACT = "11111111-2222-4333-8444-555555555555";
const MESSAGE = "99999999-2222-4333-8444-555555555555";

function setup(o: { queueError?: { message: string; code?: string }; channel?: "sms" | "email"; brevo?: number; email?: boolean; sms?: Deps["sms"] } = {}) {
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
