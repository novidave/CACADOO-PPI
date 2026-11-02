import { assert, assertEquals } from "jsr:@std/assert@1";
import { type Deps, handle, indexNowUrls, reminderMail } from "./index.ts";

const ok = (data: unknown) => Promise.resolve({ data, error: null });

function deps(over: Partial<Deps> & { calls?: string[]; mails?: unknown[] } = {}): Deps {
  const calls = over.calls ?? [];
  const mails = over.mails ?? [];
  return {
    db: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push(name);
        if (name === "sklad_cron_ok") return ok(args.p_secret === "x".repeat(40));
        if (name === "sklad_reminders_due") {
          return ok([{ shop_id: "s", shop_name: "Davide paint shop", shop_slug: "davide", recipients: [{ email: "owner@example.com", lang: "sk" }] }]);
        }
        if (name === "sklad_indexnow_shops") return ok([]);
        return ok(null);
      },
    },
    email: { apiKey: "key", from: "noreply@example.com" },
    siteUrl: "https://cacaduu.com",
    indexNowKey: null,
    mainHost: "cacaduu.com",
    fetch: ((_url: string, init: RequestInit) => {
      mails.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response("{}", { status: 201 }));
    }) as unknown as typeof fetch,
    ...over,
  };
}

const tick = (secret?: string) =>
  new Request("https://x/functions/v1/sklad", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret ? { "x-ppi-cron": secret } : {}) },
    body: JSON.stringify({ action: "tick" }),
  });

Deno.test("only the job with its Vault secret", async () => {
  assertEquals((await handle(tick(), deps())).status, 401);
  assertEquals((await handle(tick("wrong".repeat(10)), deps())).status, 403);
  assertEquals((await handle(new Request("https://x", { method: "GET" }), deps())).status, 405);
});

Deno.test("a due reminder → one e-mail in the owner's language with the Sklad link", async () => {
  const mails: { subject: string; textContent: string; to: { email: string }[] }[] = [];
  const res = await handle(tick("x".repeat(40)), deps({ mails }));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).reminders, { shops: 1, sent: 1 });
  assertEquals(mails.length, 1);
  assertEquals(mails[0].to[0].email, "owner@example.com");
  assertEquals(mails[0].subject, "Potvrďte stav skladu – Davide paint shop");
  assert(mails[0].textContent.includes("https://cacaduu.com/sk/dashboard/sklad?shop=davide"));
});

Deno.test("without Brevo the e-mail is skipped, nothing fails", async () => {
  const res = await handle(tick("x".repeat(40)), deps({ email: null }));
  assertEquals((await res.json()).reminders, { shops: 1, sent: 0 });
});

Deno.test("the e-mail texts: sk, hu, else en; no link without SITE_URL", () => {
  assertEquals(reminderMail("A", "a", "hu", null).subject, "Erősítse meg a készletet – A");
  assertEquals(reminderMail("A", "a", "de", null).subject, "Confirm your stock – A");
  assert(!reminderMail("A", "a", "sk", null).text.includes("http"));
});

Deno.test("IndexNow addresses: every language, the own domain's first", () => {
  const id = "80d9f48f-7e5f-4aa6-9f5e-b0bc84025e58";
  assertEquals(indexNowUrls({ host: "davide.sk", kind: "site", lang: "hu", items: [{ id, slug: "x" }] }), [
    `https://davide.sk/hu/items/${id}`,
    `https://davide.sk/sk/items/${id}`,
    `https://davide.sk/en/items/${id}`,
  ]);
  assertEquals(indexNowUrls({ host: "cacaduu.com", kind: "main", items: [{ id: "not-a-uuid", slug: "x" }] }), []);
});
