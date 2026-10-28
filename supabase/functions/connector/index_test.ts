// Tests of the connector function (the Cacaduu Cloud API for the POS Sync Agent, phase A) against a fake database
// (phase B: snapshots_test.ts, phase C: commands_test.ts).
// Run: npm run test:functions
import { assert, assertEquals, assertMatch, assertNotEquals } from "jsr:@std/assert@1";
import { type Deps, handle, matchRoute, normalizeCode, routePath, sha256Hex, versionBelow } from "./index.ts";

type Call = { name: string; args: Record<string, unknown> };

/** A small stand-in for the connector_* SQL functions: one shop, one valid code, devices by token hash. */
function fakeDb() {
  const calls: Call[] = [];
  const devices = new Map<string, { id: string; shop: string; revoked: boolean; next?: string }>();
  let codeHash = "";
  let wrong = 0;
  let beats = 0;
  const db = {
    calls,
    devices,
    setCode: async (code: string) => (codeHash = await sha256Hex(code)),
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "connector_pair") {
        if (wrong >= 5) return Promise.resolve({ data: { status: "locked", retry_after: 900 }, error: null });
        if (args.p_code_hash !== codeHash) {
          wrong++;
          return Promise.resolve({ data: { status: "invalid" }, error: null });
        }
        codeHash = "used";
        const id = "11111111-1111-4111-8111-111111111111";
        devices.set(args.p_token_hash as string, { id, shop: "shop-a", revoked: false });
        return Promise.resolve({ data: { status: "ok", device_id: id, shop_name: "Cacaduu Paint" }, error: null });
      }
      if (name === "connector_auth") {
        const hash = args.p_token_hash as string;
        for (const [h, d] of devices) {
          if (!d.revoked && (h === hash || d.next === hash)) {
            return Promise.resolve({ data: [{ device_id: d.id, shop_id: d.shop, shop_name: "Cacaduu Paint", shop_slug: "paint" }], error: null });
          }
        }
        return Promise.resolve({ data: [], error: null });
      }
      if (name === "connector_heartbeat") {
        const d = [...devices.values()].find((x) => x.id === args.p_device_id);
        if (!d || d.revoked) return Promise.resolve({ data: { status: "revoked" }, error: null });
        beats++;
        return Promise.resolve({ data: beats > 4 ? { status: "too_many" } : { status: "ok", shop_name: "Cacaduu Paint" }, error: null });
      }
      if (name === "connector_commands_list") {
        return Promise.resolve({ data: { status: "ok", commands: [] }, error: null });
      }
      if (name === "connector_status") {
        return Promise.resolve({ data: { shop: { name: "Cacaduu Paint", slug: "paint" }, state: "never_synced" }, error: null });
      }
      if (name === "connector_rotate") {
        const d = [...devices.values()].find((x) => x.id === args.p_device_id);
        if (d) d.next = args.p_new_hash as string;
        return Promise.resolve({ data: d ? "ok" : "revoked", error: null });
      }
      return Promise.resolve({ data: null, error: { message: `unknown ${name}` } });
    },
  };
  return db;
}

let counter = 0;
function deps(db: ReturnType<typeof fakeDb>, min = "1.0.0"): Deps {
  return {
    rpc: db.rpc,
    minAgentVersion: min,
    apiBaseUrl: "https://example.supabase.co/functions/v1/connector",
    salt: "test",
    now: () => new Date("2026-10-27T12:00:00Z"),
    randomBytes: () => new Uint8Array(32).fill(++counter),
  };
}

const BASE = "https://example.supabase.co/functions/v1/connector";
function call(path: string, init: { method?: string; body?: unknown; token?: string; version?: string | null } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" };
  if (init.version !== null) headers["cacaduu-agent-version"] = init.version ?? "1.2.0";
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  return new Request(`${BASE}${path}`, {
    method: init.method ?? "POST",
    headers,
    body: init.method === "GET" ? undefined : JSON.stringify(init.body ?? {}),
  });
}

async function paired(db: ReturnType<typeof fakeDb>, d: Deps): Promise<string> {
  await db.setCode("ABCDEFGH");
  const res = await handle(call("/v1/pair", { body: { code: "abcd-efgh", device_name: "Pokladňa", agent_version: "1.2.0", os: "Windows 11" } }), d);
  assertEquals(res.status, 201);
  return (await res.json()).device_token;
}

Deno.test("paths: with or without the function prefix, ids, unknown ones", () => {
  assertEquals(routePath(new URL(`${BASE}/v1/pair`)), "/v1/pair");
  assertEquals(routePath(new URL("https://x.test/connector/v1/heartbeat/")), "/v1/heartbeat");
  assertEquals(matchRoute("POST", "/v1/commands/11111111-1111-4111-8111-111111111111/claim")?.id, "11111111-1111-4111-8111-111111111111");
  assertEquals(matchRoute("GET", "/v1/pair"), null);
  assertEquals(normalizeCode(" abcd-efgh "), "ABCDEFGH");
  assert(versionBelow("0.9.9", "1.0.0"));
  assert(!versionBelow("1.10.0", "1.9.0"));
  assert(!versionBelow("1.0.0-beta", "1.0.0"), "pre-release suffixes are ignored");
});

Deno.test("pairing: a valid code gives a token for one shop; only its hash goes to the database", async () => {
  const db = fakeDb();
  const d = deps(db);
  await db.setCode("ABCDEFGH");
  const res = await handle(call("/v1/pair", { body: { code: "abcd-efgh", device_name: "Pokladňa 1", agent_version: "1.2.0", os: "Windows 11" } }), d);
  assertEquals(res.status, 201);
  const body = await res.json();
  assertMatch(body.device_token, /^cdt_[A-Za-z0-9_-]{43}$/);
  assertEquals(body.api_base_url, "https://example.supabase.co/functions/v1/connector");
  assertEquals(body.next_poll_seconds, 60);
  assertEquals(body.min_agent_version, "1.0.0");
  const pairCall = db.calls.find((c) => c.name === "connector_pair")!;
  assertEquals(pairCall.args.p_token_hash, await sha256Hex(body.device_token));
  assertEquals(pairCall.args.p_code_hash, await sha256Hex("ABCDEFGH"));
  assert(!JSON.stringify(db.calls).includes(body.device_token), "the token itself never reaches the database");
  assert(!JSON.stringify(pairCall.args).includes("203.0.113.7"), "no IP address, only a hash");
  // the code is single use
  const again = await handle(call("/v1/pair", { body: { code: "ABCDEFGH" } }), d);
  assertEquals(again.status, 400);
  assertEquals((await again.json()).error, "invalid_code");
});

Deno.test("pairing: wrong codes lock the caller (429 with Retry-After)", async () => {
  const db = fakeDb();
  const d = deps(db);
  await db.setCode("ABCDEFGH");
  for (let i = 0; i < 5; i++) assertEquals((await handle(call("/v1/pair", { body: { code: "ZZZZ-ZZZZ" } }), d)).status, 400);
  const locked = await handle(call("/v1/pair", { body: { code: "ABCD-EFGH" } }), d);
  assertEquals(locked.status, 429);
  assertEquals(locked.headers.get("retry-after"), "900");
  // a code with look-alike letters can never be valid, and still counts as a try
  const o0 = await handle(call("/v1/pair", { body: { code: "O0O0-1111" } }), deps(fakeDb()));
  assertEquals(o0.status, 400);
});

Deno.test("versions: the header is required; older agents get 426", async () => {
  const db = fakeDb();
  assertEquals((await handle(call("/v1/heartbeat", { version: null }), deps(db))).status, 400);
  const old = await handle(call("/v1/heartbeat", { version: "0.9.0" }), deps(db, "1.0.0"));
  assertEquals(old.status, 426);
  assertEquals((await old.json()).min_agent_version, "1.0.0");
});

Deno.test("tokens: missing, wrong and revoked tokens get 401; the shop comes from the token", async () => {
  const db = fakeDb();
  const d = deps(db);
  const token = await paired(db, d);
  assertEquals((await handle(call("/v1/heartbeat"), d)).status, 401);
  assertEquals((await handle(call("/v1/heartbeat", { token: "cdt_" + "x".repeat(43) }), d)).status, 401);
  assertEquals((await handle(call("/v1/heartbeat", { token: "not-a-token" }), d)).status, 401);
  // a shop id in the body is ignored: only the token decides
  const ok = await handle(call("/v1/heartbeat", { token, body: { shop_id: "someone-else", agent_version: "1.2.0" } }), d);
  assertEquals(ok.status, 200);
  const hb = db.calls.find((c) => c.name === "connector_heartbeat")!;
  assertEquals(Object.keys(hb.args).includes("p_shop_id"), false);
  for (const dev of db.devices.values()) dev.revoked = true;
  assertEquals((await handle(call("/v1/heartbeat", { token }), d)).status, 401);
});

Deno.test("heartbeat: polling info, plain-text error cut to 500, at most 4 a minute", async () => {
  const db = fakeDb();
  const d = deps(db);
  const token = await paired(db, d);
  const res = await handle(call("/v1/heartbeat", {
    token,
    body: { agent_version: "1.2.0", os: "Windows 11", source_label: "POHODA XML", last_read: { result: "error", error: "chyba\u0007" + "x".repeat(900) } },
  }), d);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.commands, []);
  assertEquals(body.next_poll_seconds, 60);
  assertEquals(body.shop.name, "Cacaduu Paint");
  const args = db.calls.filter((c) => c.name === "connector_heartbeat")[0].args;
  assertEquals((args.p_error as string).length, 500);
  assert(!(args.p_error as string).includes("\u0007"));
  assertEquals(args.p_result, "error");
  assertEquals(args.p_label, "POHODA XML");
  for (let i = 0; i < 3; i++) await handle(call("/v1/heartbeat", { token }), d);
  const limited = await handle(call("/v1/heartbeat", { token }), d);
  assertEquals(limited.status, 429);
});

Deno.test("rotation: a new token, different from the old; both work until the new one is used", async () => {
  const db = fakeDb();
  const d = deps(db);
  const token = await paired(db, d);
  const res = await handle(call("/v1/credentials/rotate", { token }), d);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertNotEquals(body.device_token, token);
  assertEquals(body.old_token_valid_until, "2026-10-28T12:00:00.000Z");
  assertEquals(db.calls.find((c) => c.name === "connector_rotate")!.args.p_new_hash, await sha256Hex(body.device_token));
  assertEquals((await handle(call("/v1/status", { method: "GET", token: body.device_token }), d)).status, 200);
});

Deno.test("phases B and C need a token; wrong methods 405; unknown 404; bad JSON 400", async () => {
  const db = fakeDb();
  const d = deps(db);
  assertEquals((await handle(call("/v1/inventory/snapshots", { body: {} }), d)).status, 401);
  assertEquals((await handle(call("/v1/commands", { method: "GET" }), d)).status, 401);
  assertEquals((await handle(call("/v1/commands/11111111-1111-4111-8111-111111111111/claim"), d)).status, 401);
  assertEquals((await handle(call("/v1/pair", { method: "GET" }), d)).status, 405);
  assertEquals((await handle(call("/v2/pair"), d)).status, 404);
  const bad = new Request(`${BASE}/v1/pair`, { method: "POST", headers: { "cacaduu-agent-version": "1.2.0" }, body: "[1,2]" });
  assertEquals((await handle(bad, d)).status, 400);
});
