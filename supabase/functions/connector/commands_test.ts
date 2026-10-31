// Tests of the connector function's phase C (Sync Now commands) against a fake database: commands ride along with the
// heartbeat (shorter poll while one waits), GET /v1/commands, claim once (409 for the second agent), the result rules
// (running / failed / completed, snapshot_not_applied, not_claimed), confirm with a command_id, bad bodies.
// Run: npm run test:functions
import { assert, assertEquals } from "jsr:@std/assert@1";
import { COMMAND_POLL_SECONDS, DEFAULT_POLL_SECONDS, type Deps, handle, sha256Hex } from "./index.ts";

const BASE = "https://example.supabase.co/functions/v1/connector";
const TOKEN_1 = "cdt_" + "a".repeat(43);
const TOKEN_2 = "cdt_" + "b".repeat(43);
const D1 = "11111111-1111-4111-8111-111111111111";
const D2 = "33333333-3333-4333-8333-333333333333";
const SHOP = "22222222-2222-4222-8222-222222222222";
const CMD = "44444444-4444-4444-8444-444444444444";
const SNAP = "55555555-5555-4555-8555-555555555555";

type Call = { name: string; args: Record<string, unknown> };

/** The SQL side in memory: two devices of one shop, one command, the rules connector_command_*() apply. */
async function fakeDb(type: "sync_inventory" | "ping" = "sync_inventory") {
  const calls: Call[] = [];
  const hashes = new Map([[await sha256Hex(TOKEN_1), D1], [await sha256Hex(TOKEN_2), D2]]);
  const cmd = { id: CMD, type, state: "pending", attempt: 0, claimed_by: null as string | null, confirmed: false, snapshot: null as string | null, reason: null as string | null };
  const applied = new Set([SNAP]);
  let lists = 0;
  const view = () => ({ id: cmd.id, type: cmd.type, state: cmd.state, created_at: "2026-10-27T11:58:00Z",
    expires_at: "2026-10-27T12:08:00Z", lease_expires_at: cmd.claimed_by ? "2026-10-27T12:02:00Z" : null, attempt: cmd.attempt });
  const ok = (data: unknown) => Promise.resolve({ data, error: null });
  const rpc = (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "connector_auth") {
      const id = hashes.get(args.p_token_hash as string);
      return ok(id ? [{ device_id: id, shop_id: SHOP, shop_name: "Paint", shop_slug: "paint" }] : []);
    }
    if (name === "connector_heartbeat") return ok({ status: "ok", shop_name: "Paint" });
    if (name === "connector_commands_list") {
      if (args.p_count && ++lists > 6) return ok({ status: "too_many" });
      return ok({ status: "ok", commands: cmd.state === "pending" ? [view()] : [] });
    }
    if (name === "connector_command_claim") {
      if (args.p_command_id !== CMD) return ok({ status: "not_found" });
      if (cmd.state !== "pending") return ok({ status: "already_claimed", command: view() });
      Object.assign(cmd, { state: "claimed", claimed_by: args.p_device_id, attempt: cmd.attempt + 1 });
      return ok({ status: "claimed", command: view() });
    }
    if (name === "connector_command_result") {
      if (args.p_command_id !== CMD) return ok({ status: "not_found" });
      if (cmd.claimed_by !== args.p_device_id || !["claimed", "running"].includes(cmd.state)) return ok({ status: "not_claimed", command: view() });
      if (args.p_state === "running") cmd.state = "running";
      else if (args.p_state === "failed") Object.assign(cmd, { state: "failed", reason: args.p_reason });
      else {
        const snap = args.p_snapshot_id as string | null;
        if (cmd.type === "sync_inventory" && !((snap && applied.has(snap)) || (!snap && cmd.confirmed))) {
          return ok({ status: "snapshot_not_applied", command: view() });
        }
        Object.assign(cmd, { state: "completed", snapshot: snap });
      }
      return ok({ status: "ok", command: view() });
    }
    if (name === "connector_confirm") return ok({ status: "confirmed", shop_id: SHOP });
    if (name === "connector_command_confirmed") {
      const held = cmd.claimed_by === args.p_device_id && args.p_command_id === CMD;
      if (held) cmd.confirmed = true;
      return ok(held);
    }
    return Promise.resolve({ data: null, error: { message: `unknown ${name}` } });
  };
  return { calls, cmd, rpc };
}

function deps(db: Awaited<ReturnType<typeof fakeDb>>): Deps {
  return {
    rpc: db.rpc,
    minAgentVersion: "1.0.0",
    apiBaseUrl: BASE,
    salt: "test",
    now: () => new Date("2026-10-27T12:00:00Z"),
    randomBytes: () => new Uint8Array(32).fill(7),
  };
}

function call(path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  return new Request(`${BASE}${path}`, {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", "cacaduu-agent-version": "1.2.0", authorization: `Bearer ${init.token ?? TOKEN_1}` },
    body: init.method === "GET" ? undefined : JSON.stringify(init.body ?? {}),
  });
}

Deno.test("heartbeat and GET /v1/commands: a waiting command rides along and the poll gets shorter", async () => {
  const db = await fakeDb();
  const d = deps(db);
  const beat = await (await handle(call("/v1/heartbeat", { body: { agent_version: "1.2.0" } }), d)).json();
  assertEquals(beat.commands.length, 1);
  assertEquals(beat.commands[0].type, "sync_inventory");
  assertEquals(beat.next_poll_seconds, COMMAND_POLL_SECONDS);
  // the heartbeat's listing never counts towards the GET limit
  assertEquals(db.calls.find((c) => c.name === "connector_commands_list")!.args.p_count, false);
  const listed = await handle(call("/v1/commands", { method: "GET" }), d);
  assertEquals(listed.status, 200);
  assertEquals((await listed.json()).commands[0].id, CMD);
  for (let i = 0; i < 5; i++) await handle(call("/v1/commands", { method: "GET" }), d);
  const limited = await handle(call("/v1/commands", { method: "GET" }), d);
  assertEquals(limited.status, 429);
  assertEquals(limited.headers.get("retry-after"), "60");
});

Deno.test("claim: one agent gets it, the other 409 already_claimed; nothing pending afterwards", async () => {
  const db = await fakeDb();
  const d = deps(db);
  const first = await handle(call(`/v1/commands/${CMD}/claim`), d);
  assertEquals(first.status, 200);
  const body = await first.json();
  assertEquals([body.state, body.attempt, body.lease_expires_at], ["claimed", 1, "2026-10-27T12:02:00Z"]);
  const second = await handle(call(`/v1/commands/${CMD}/claim`, { token: TOKEN_2 }), d);
  assertEquals(second.status, 409);
  assertEquals((await second.json()).error, "already_claimed");
  assertEquals((await handle(call(`/v1/commands/${SNAP}/claim`), d)).status, 404);
  const beat = await (await handle(call("/v1/heartbeat"), d)).json();
  assertEquals([beat.commands.length, beat.next_poll_seconds], [0, DEFAULT_POLL_SECONDS]);
  // the shop comes from the token: only the device id goes to the database
  assert(db.calls.filter((c) => c.name === "connector_command_claim").every((c) => !("p_shop_id" in c.args)));
});

Deno.test("result: running renews, completed needs an applied snapshot, only the holder reports", async () => {
  const db = await fakeDb();
  const d = deps(db);
  await handle(call(`/v1/commands/${CMD}/claim`), d);
  assertEquals((await handle(call(`/v1/commands/${CMD}/result`, { body: { state: "running" } }), d)).status, 200);
  const other = await handle(call(`/v1/commands/${CMD}/result`, { token: TOKEN_2, body: { state: "running" } }), d);
  assertEquals([other.status, (await other.json()).error], [409, "not_claimed"]);
  const early = await handle(call(`/v1/commands/${CMD}/result`, { body: { state: "completed", snapshot_id: "66666666-6666-4666-8666-666666666666" } }), d);
  assertEquals([early.status, (await early.json()).error], [409, "snapshot_not_applied"]);
  const done = await handle(call(`/v1/commands/${CMD}/result`, { body: { state: "completed", snapshot_id: SNAP.toUpperCase() } }), d);
  assertEquals(done.status, 200);
  assertEquals((await done.json()).state, "completed");
  assertEquals(db.cmd.snapshot, SNAP, "the id is passed in lower case");
});

Deno.test("result: failed keeps only plain text (≤ 500); bad bodies are 400", async () => {
  const db = await fakeDb();
  const d = deps(db);
  await handle(call(`/v1/commands/${CMD}/claim`), d);
  for (const body of [{}, { state: "paused" }, { state: "completed", snapshot_id: "x" }, { state: "failed", reason: 5 }]) {
    assertEquals((await handle(call(`/v1/commands/${CMD}/result`, { body }), d)).status, 400, JSON.stringify(body));
  }
  const res = await handle(call(`/v1/commands/${CMD}/result`, { body: { state: "failed", reason: "POS nie je\u0007 dostupný " + "x".repeat(900) } }), d);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).state, "failed");
  assertEquals((db.cmd.reason ?? "").length, 500);
  assert(!(db.cmd.reason ?? "").includes("\u0007"));
});

Deno.test("unchanged: confirm with the command_id, then completed without a snapshot; ping needs none", async () => {
  const db = await fakeDb();
  const d = deps(db);
  await handle(call(`/v1/commands/${CMD}/claim`), d);
  const bad = await handle(call("/v1/inventory/confirm", { body: { content_hash: "f".repeat(64), source_time: "2026-10-27T11:59:00Z", command_id: "x" } }), d);
  assertEquals(bad.status, 400);
  const confirmed = await handle(call("/v1/inventory/confirm", {
    body: { content_hash: "f".repeat(64), source_time: "2026-10-27T11:59:00Z", command_id: CMD },
  }), d);
  assertEquals((await confirmed.json()).state, "confirmed");
  assertEquals(db.calls.find((c) => c.name === "connector_command_confirmed")!.args.p_command_id, CMD);
  assertEquals((await handle(call(`/v1/commands/${CMD}/result`, { body: { state: "completed" } }), d)).status, 200);

  const ping = await fakeDb("ping");
  const pd = deps(ping);
  await handle(call(`/v1/commands/${CMD}/claim`), pd);
  assertEquals((await handle(call(`/v1/commands/${CMD}/result`, { body: { state: "completed" } }), pd)).status, 200);
});

Deno.test("a database error in the heartbeat's command list never fails the heartbeat", async () => {
  const db = await fakeDb();
  const d = deps({
    ...db,
    rpc: (name, args) => name === "connector_commands_list" ? Promise.resolve({ data: null, error: { message: "missing function" } }) : db.rpc(name, args),
  });
  const res = await handle(call("/v1/heartbeat"), d);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).commands, []);
});
