// The SMS providers (database update 58, CRM phase 4): one block of code in crm-messages and bookings (each function is
// one file pasted by hand) and hours-sms (update 60), so every copy must stay the same; Brevo and Twilio requests, missing secrets, the sender.
// Run: npm run test:functions
import * as crm from "./crm-messages/index.ts";
import * as bookings from "./bookings/index.ts";
import * as hours from "./hours-sms/index.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}

const START = "// ---------------------------------------------------------------- SMS providers (the same block in crm-messages and bookings)";
const END = "// ---------------------------------------------------------------- end of the SMS providers";

async function block(name: string) {
  const source = await Deno.readTextFile(new URL(`./${name}/index.ts`, import.meta.url));
  const a = source.indexOf(START);
  const b = source.indexOf(END);
  if (a < 0 || b < a) throw new Error(`${name}: the SMS providers block is missing`);
  return source.slice(a, b);
}

Deno.test("crm-messages and bookings carry the same SMS providers", async () => {
  eq(await block("crm-messages") === await block("bookings"), true, "copy the block from one file to the other");
});

Deno.test("hours-sms carries the same SMS providers (update 60)", async () => {
  eq(await block("crm-messages") === await block("hours-sms"), true, "copy the block from crm-messages into hours-sms");
});

interface Call {
  url: string;
  init: RequestInit;
}
function fake(status: number, body: unknown) {
  const calls: Call[] = [];
  const f = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as unknown as typeof fetch;
  return { f, calls };
}
const env = (values: Record<string, string>) => (name: string) => values[name];

for (const [label, m] of [["crm-messages", crm], ["bookings", bookings], ["hours-sms", hours]] as const) {
  Deno.test(`${label}: Brevo sends a transactional SMS, Unicode only when needed`, async () => {
    const { f, calls } = fake(201, { messageId: 1511882900176220, smsCount: 1 });
    const p = m.smsProvider("Brevo", env({ BREVO_API_KEY: "xkeysib-1", SMS_SENDER: "Kaderníctvo Eva!" }), f);
    eq([p.name, p.live], ["brevo", true], "live");
    eq(await p.send("+421905111222", "Kod 123456"), { ok: true, ref: "1511882900176220" }, "sent");
    eq(calls[0].url, "https://api.brevo.com/v3/transactionalSMS/send", "endpoint");
    eq((calls[0].init.headers as Record<string, string>)["api-key"], "xkeysib-1", "key header");
    eq(JSON.parse(calls[0].init.body as string), {
      sender: "Kadernictvo",
      recipient: "421905111222",
      content: "Kod 123456",
      type: "transactional",
      tag: "cacaduu",
      unicodeEnabled: false,
    }, "body");
    await p.send("+421905111222", "Dobrý deň");
    eq(JSON.parse(calls[1].init.body as string).unicodeEnabled, true, "accents need Unicode");
    const broke = m.smsProvider("brevo", env({ BREVO_API_KEY: "k" }), fake(402, { code: "not_enough_credits", message: "+421905111222" }).f);
    const r = await broke.send("+421905111222", "x");
    eq([r.ok, r.error], [false, "brevo 402 no SMS credits"], "no credits, no number in the error");
    eq((await m.smsProvider("brevo", env({}), f).send("+421905111222", "x")).ok, false, "no key: fails, never pretends");
  });

  Deno.test(`${label}: Twilio sends with a sender or a messaging service`, async () => {
    const sid = "AC" + "0".repeat(32);
    const { f, calls } = fake(201, { sid: "SM123" });
    const p = m.smsProvider("twilio", env({ TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: "t0k", TWILIO_FROM: "Cacaduu" }), f);
    eq(await p.send("+421905111222", "Ahoj"), { ok: true, ref: "SM123" }, "sent");
    eq(calls[0].url, `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, "endpoint");
    eq((calls[0].init.headers as Record<string, string>).Authorization, `Basic ${btoa(`${sid}:t0k`)}`, "basic auth");
    eq(String(calls[0].init.body), "To=%2B421905111222&Body=Ahoj&From=Cacaduu", "form");
    eq(m.twilioSmsForm("+1", "x", { from: "A", service: "MG1" }).toString(), "To=%2B1&Body=x&MessagingServiceSid=MG1", "service wins");
    const bad = m.smsProvider("twilio", env({ TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: "t", TWILIO_FROM: "A" }),
      fake(400, { code: 21211, message: "The 'To' number +421905111222 is not valid" }).f);
    eq(await bad.send("+421905111222", "x"), { ok: false, error: "twilio 400 21211" }, "only the code, never the number");
    eq((await m.smsProvider("twilio", env({ TWILIO_ACCOUNT_SID: "x" }), f).send("+4219", "x")).ok, false, "not set up");
  });

  Deno.test(`${label}: test mode, unknown names, senders, GSM`, async () => {
    eq([m.smsProvider(undefined).live, m.smsProvider(" TEST ").name], [false, "test"], "test by default");
    const unknown = m.smsProvider("nope");
    eq([unknown.live, (await unknown.send("+1", "x")).ok], [true, false], "unknown fails");
    eq([m.smsSender(undefined), m.smsSender("  "), m.smsSender("Cacaduu PPI"), m.smsSender("+421905111222")],
      ["Cacaduu", "Cacaduu", "CacaduuPPI", "421905111222"], "senders");
    eq([m.isGsm("Hello {x} €"), m.isGsm("čau"), m.isGsm("a\nb")], [true, false, true], "GSM");
  });
}
