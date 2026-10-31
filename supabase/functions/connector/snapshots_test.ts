// Tests of the connector function's phase B (inventory snapshots) against a fake database and a fake staging bucket:
// announce → signed upload → complete; the file's hash, count, format and rows; only the contract's fields reach the
// database; skipped rows keep their stock; size limits; confirm unchanged.
// Run: npm run test:functions
import { assert, assertEquals } from "jsr:@std/assert@1";
import { checkRows, type Deps, gunzip, handle, maxBytesFrom, sha256Hex, skippedText, type Staging } from "./index.ts";

const BASE = "https://example.supabase.co/functions/v1/connector";
const TOKEN = "cdt_" + "a".repeat(43);
const DEVICE = "11111111-1111-4111-8111-111111111111";
const SHOP = "22222222-2222-4222-8222-222222222222";

type Call = { name: string; args: Record<string, unknown> };

/** The SQL side in memory: one device, its shop's snapshots, the decisions connector_snapshot_apply() would make. */
function fakeDb(options: { source?: "agent" | "file"; last?: string } = {}) {
  const calls: Call[] = [];
  const snaps = new Map<string, Record<string, unknown>>();
  let lastTime = options.last ?? null;
  const view = (s: Record<string, unknown>) => ({ snapshot_id: s.id, state: s.state, ...(s.error ? { error: s.error } : {}) });
  const ok = (data: unknown) => Promise.resolve({ data, error: null });
  const rpc = (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "connector_auth") {
      return ok(args.p_token_hash === tokenHash ? [{ device_id: DEVICE, shop_id: SHOP, shop_name: "Paint", shop_slug: "paint" }] : []);
    }
    if (name === "connector_snapshot_announce") {
      const id = args.p_snapshot_id as string;
      const old = snaps.get(id);
      if (old) return ok({ status: "existing", shop_id: SHOP, snapshot: view(old) });
      if (lastTime && (args.p_source_time as string) <= lastTime) return ok({ status: "stale" });
      const s = { id, state: args.p_complete ? "awaiting_upload" : "rejected", error: args.p_complete ? null : "incomplete",
        source_id: args.p_source_id, source_time: args.p_source_time, product_count: args.p_count, content_hash: args.p_hash };
      snaps.set(id, s);
      return ok({ status: "new", shop_id: SHOP, snapshot: view(s) });
    }
    if (name === "connector_snapshot_begin") {
      const s = snaps.get(args.p_snapshot_id as string);
      if (!s) return ok({ status: "not_found" });
      if (s.state !== "awaiting_upload") return ok({ status: "existing", shop_id: SHOP, snapshot: view(s) });
      s.state = "processing";
      return ok({ status: "begin", shop_id: SHOP, source_id: s.source_id, source_time: s.source_time,
        product_count: s.product_count, content_hash: s.content_hash, upload_expires_at: "2026-10-27T12:15:00Z" });
    }
    if (name === "connector_snapshot_wait") {
      snaps.get(args.p_snapshot_id as string)!.state = "awaiting_upload";
      return ok(null);
    }
    if (name === "connector_snapshot_reject") {
      const s = snaps.get(args.p_snapshot_id as string)!;
      Object.assign(s, { state: "rejected", error: args.p_error });
      return ok({ ...view(s), message: args.p_message });
    }
    if (name === "connector_snapshot_apply") {
      const s = snaps.get(args.p_snapshot_id as string)!;
      if ((options.source ?? "agent") !== "agent") {
        s.state = "test_ok";
        return ok({ state: "test_ok" });
      }
      if ((args.p_rows as unknown[]).length === 0) {
        s.state = "held";
        return ok({ state: "held", reason: "empty" });
      }
      s.state = "applied";
      lastTime = s.source_time as string;
      return ok({ state: "applied", result: { products: s.product_count, imported: (args.p_rows as unknown[]).length, zeroed: 0,
        skipped: (args.p_result as { skipped: number }).skipped } });
    }
    if (name === "connector_snapshot_get") {
      const s = snaps.get(args.p_snapshot_id as string);
      return ok(s ? view(s) : null);
    }
    if (name === "connector_confirm") {
      if (args.p_hash === "f".repeat(64)) return ok({ status: "confirmed", shop_id: SHOP });
      return ok({ status: "send_full" });
    }
    return Promise.resolve({ data: null, error: { message: `unknown ${name}` } });
  };
  let tokenHash = "";
  return { calls, snaps, rpc, init: async () => (tokenHash = await sha256Hex(TOKEN)) };
}

function fakeStorage(): Staging & { files: Map<string, Uint8Array>; removed: string[] } {
  const files = new Map<string, Uint8Array>();
  const removed: string[] = [];
  return {
    files,
    removed,
    signedUploadUrl: (path) => Promise.resolve(`https://example.supabase.co/storage/v1/object/upload/sign/connector-staging/${path}?token=t`),
    size: (path) => Promise.resolve(files.has(path) ? files.get(path)!.length : null),
    read: (path) => Promise.resolve(files.get(path)!),
    remove: (path) => {
      removed.push(path);
      files.delete(path);
      return Promise.resolve();
    },
  };
}

function deps(db: ReturnType<typeof fakeDb>, storage: Staging, applied: string[] = [], maxBytes = 1024 * 1024): Deps {
  return {
    rpc: db.rpc,
    minAgentVersion: "1.0.0",
    apiBaseUrl: BASE,
    salt: "test",
    now: () => new Date("2026-10-27T12:00:00Z"),
    randomBytes: () => new Uint8Array(32).fill(7),
    storage,
    maxBytes,
    afterApply: (shop) => applied.push(shop),
  };
}

function call(path: string, init: { method?: string; body?: unknown } = {}) {
  return new Request(`${BASE}${path}`, {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", "cacaduu-agent-version": "1.2.0", authorization: `Bearer ${TOKEN}` },
    body: init.method === "GET" ? undefined : JSON.stringify(init.body ?? {}),
  });
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice().buffer as ArrayBuffer]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const product = (code: string, extra: Record<string, unknown> = {}) => ({
  source_code: code, name: `Farba ${code}`, ean: "2000000000015", brand: "Primalex", price: 54.9, currency: "EUR", quantity: 7,
  availability_status: "in_stock", warehouse: "Hlavný sklad", source_updated_at: "2026-10-27T10:12:00Z", ...extra,
});

async function snapshot(id: string, products: unknown[], over: Record<string, unknown> = {}) {
  const doc = { format: "cacaduu.inventory.v1", snapshot_id: id, source_id: "pohoda-xml-main", source_time: "2026-10-27T11:59:30Z", products, ...over };
  const raw = new TextEncoder().encode(JSON.stringify(doc));
  return { raw, gz: await gzip(raw), hash: await sha256Hex(new TextDecoder().decode(raw)) };
}

/** announce → PUT (into the fake bucket) → complete; returns the complete answer. */
async function send(d: Deps, storage: ReturnType<typeof fakeStorage>, id: string, products: unknown[],
                    opts: { count?: number; hash?: string; over?: Record<string, unknown>; upload?: boolean } = {}) {
  const snap = await snapshot(id, products, opts.over);
  const ann = await handle(call("/v1/inventory/snapshots", { body: {
    snapshot_id: id, source_id: "pohoda-xml-main", source_time: "2026-10-27T11:59:30Z", complete: true,
    product_count: opts.count ?? products.length, content_hash: opts.hash ?? snap.hash, command_id: null,
  } }), d);
  assertEquals(ann.status, 201, await ann.clone().text());
  const body = await ann.json();
  assert(String(body.upload_url).includes(`/connector-staging/${SHOP}/${id}.json.gz`), body.upload_url);
  if (opts.upload !== false) storage.files.set(`${SHOP}/${id}.json.gz`, snap.gz);
  return await handle(call(`/v1/inventory/snapshots/${id}/complete`), d);
}

const id = (n: number) => `0f6d2b8e-3c41-4e8a-9b0a-6a8f2d7c1e${String(n).padStart(2, "0")}`;

Deno.test("rows: the contract's fields only; bad rows skipped with their line; their products kept", () => {
  const out = checkRows([
    product("A1", { purchase_price: 30, supplier: "Firma s.r.o.", note: "interné" }),
    product("A2", { price: -1 }),
    product("A3", { currency: "euro" }),
    product("A4", { quantity: "7" }),
    product("A1"),
    { name: "bez kódu", price: 1, currency: "EUR", quantity: 1 },
    product("A5", { name: "x".repeat(301) }),
    product("A6", { currency: "huf", price: 0, quantity: -2, ean: null, brand: null }),
  ]);
  assertEquals(out.rows.map((r) => r.source_code), ["A1", "A6"]);
  assertEquals(Object.keys(out.rows[0]).sort(), ["brand", "currency", "ean", "name", "price", "quantity", "source_code"]);
  assertEquals(out.rows[1].currency, "HUF");
  assertEquals(out.skipped, [
    { line: 2, reason: "price" }, { line: 3, reason: "currency" }, { line: 4, reason: "quantity" },
    { line: 5, reason: "duplicate" }, { line: 6, reason: "source_code" }, { line: 7, reason: "name" },
  ]);
  assertEquals(out.keep.sort(), ["A2", "A3", "A4", "A5"]);
  assertEquals(skippedText(out.skipped).startsWith("riadok 2: price; riadok 3: currency"), true);
});

Deno.test("gzip: only gzip; a size cap while unpacking", async () => {
  assertEquals(await gunzip(new TextEncoder().encode("{\"x\":1} not gzip at all"), 1000), null);
  const big = await gzip(new Uint8Array(100_000));
  assertEquals(await gunzip(big, 50_000), "too_large");
  assertEquals((await gunzip(big, 200_000) as Uint8Array).length, 100_000);
  assertEquals(maxBytesFrom(undefined), 20 * 1024 * 1024);
  assertEquals(maxBytesFrom("80"), 50 * 1024 * 1024, "never over the bucket's 50 MB");
  assertEquals(maxBytesFrom("nonsense"), 20 * 1024 * 1024);
});

Deno.test("a snapshot: announced, uploaded to the signed address, applied; private fields never reach the database", async () => {
  const db = fakeDb();
  await db.init();
  const storage = fakeStorage();
  const applied: string[] = [];
  const d = deps(db, storage, applied);
  const res = await send(d, storage, id(1), [product("A1", { purchase_price: 30, supplier: "Tajný dodávateľ" }), product("A2")]);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.state, "applied");
  assertEquals(body.result.imported, 2);
  assertEquals(body.api_base_url, BASE);
  const apply = db.calls.find((c) => c.name === "connector_snapshot_apply")!;
  assertEquals(apply.args.p_shop_id, SHOP, "the shop comes from the token");
  assert(!JSON.stringify(db.calls).includes("Tajný"), "a supplier never reaches the database");
  assert(!JSON.stringify(db.calls).includes("purchase_price"));
  assertEquals(storage.removed, [`${SHOP}/${id(1)}.json.gz`], "the staging file is deleted");
  assertEquals(applied, [SHOP], "the website's cache is refreshed");
  // the same snapshot again: its state, nothing applied twice
  const again = await handle(call(`/v1/inventory/snapshots/${id(1)}/complete`), d);
  assertEquals((await again.json()).state, "applied");
  assertEquals(db.calls.filter((c) => c.name === "connector_snapshot_apply").length, 1);
  assertEquals((await (await handle(call(`/v1/inventory/snapshots/${id(1)}`, { method: "GET" }), d)).json()).state, "applied");
  assertEquals((await handle(call(`/v1/inventory/snapshots/${id(9)}`, { method: "GET" }), d)).status, 404);
});

Deno.test("refused: wrong hash, wrong count, wrong file, too many bad rows — the previous stock stays", async () => {
  const db = fakeDb();
  await db.init();
  const storage = fakeStorage();
  const d = deps(db, storage);
  const products = Array.from({ length: 20 }, (_, i) => product(`P${i}`));
  const hash = await send(d, storage, id(2), products, { hash: "0".repeat(64) });
  assertEquals((await hash.json()).error, "hash_mismatch");
  const count = await send(d, storage, id(3), products, { count: 21 });
  assertEquals((await count.json()).error, "count_mismatch");
  const format = await send(d, storage, id(4), products, { over: { source_id: "other" } });
  assertEquals((await format.json()).error, "bad_format");
  const bad = products.map((p, i) => (i < 2 ? { ...p, price: "x" } : p));
  const rows = await send(d, storage, id(5), bad);
  const rowsBody = await rows.json();
  assertEquals(rowsBody.error, "invalid_rows");
  assert(String(rowsBody.message).includes("riadok 1: price"), rowsBody.message);
  assertEquals(db.calls.filter((c) => c.name === "connector_snapshot_apply").length, 0, "nothing applied");
  assertEquals(storage.files.size, 0, "every refused file is deleted");
});

Deno.test("5 % or less bad rows: skipped, reported, their products kept", async () => {
  const db = fakeDb();
  await db.init();
  const storage = fakeStorage();
  const d = deps(db, storage);
  const products = Array.from({ length: 20 }, (_, i) => (i === 3 ? product(`P${i}`, { currency: "" }) : product(`P${i}`)));
  const res = await send(d, storage, id(6), products);
  const body = await res.json();
  assertEquals(body.state, "applied");
  assertEquals(body.result.skipped, 1);
  const apply = db.calls.find((c) => c.name === "connector_snapshot_apply")!;
  assertEquals(apply.args.p_keep, ["P3"]);
  assertEquals((apply.args.p_rows as unknown[]).length, 19);
  assertEquals((apply.args.p_result as { skipped_text: string }).skipped_text, "riadok 4: currency");
});

Deno.test("held, test_ok, not uploaded yet, too large", async () => {
  const storage = fakeStorage();
  const db = fakeDb();
  await db.init();
  const held = await send(deps(db, storage), storage, id(7), []);
  assertEquals(await held.json(), { snapshot_id: id(7), state: "held", reason: "empty", api_base_url: BASE, next_poll_seconds: 60,
    min_agent_version: "1.0.0", server_time: "2026-10-27T12:00:00.000Z" });
  const other = fakeDb({ source: "file" });
  await other.init();
  const test = await send(deps(other, storage), storage, id(8), [product("A1")]);
  assertEquals((await test.json()).state, "test_ok");
  const db3 = fakeDb();
  await db3.init();
  const notYet = await send(deps(db3, storage), storage, id(11), [product("A1")], { upload: false });
  assertEquals(notYet.status, 409);
  assertEquals((await notYet.json()).error, "not_uploaded");
  assertEquals(db3.snaps.get(id(11))!.state, "awaiting_upload", "the agent may upload and complete again");
  const db4 = fakeDb();
  await db4.init();
  const big = Array.from({ length: 3000 }, (_, i) => product(`Q${i}`, { name: `Produkt s dlhým názvom ${i} ${crypto.randomUUID()}` }));
  const tooLarge = await send(deps(db4, storage, [], 2048), storage, id(12), big);
  assertEquals(tooLarge.status, 413);
  assertEquals((await tooLarge.json()).error, "too_large");
});

Deno.test("announce: bad bodies 400; stale 409; confirm unchanged or send a full one", async () => {
  const db = fakeDb({ last: "2026-10-27T12:00:00.000Z" });
  await db.init();
  const d = deps(db, fakeStorage());
  const bad = await handle(call("/v1/inventory/snapshots", { body: { snapshot_id: "x", complete: true } }), d);
  assertEquals(bad.status, 400);
  const noZone = await handle(call("/v1/inventory/snapshots", { body: {
    snapshot_id: id(13), source_id: "s", source_time: "2026-10-27T11:59:30", complete: true, product_count: 1, content_hash: "a".repeat(64),
  } }), d);
  assertEquals(noZone.status, 400, "a time without a zone is refused");
  const stale = await handle(call("/v1/inventory/snapshots", { body: {
    snapshot_id: id(14), source_id: "s", source_time: "2026-10-27T11:59:30Z", complete: true, product_count: 1, content_hash: "a".repeat(64),
  } }), d);
  assertEquals(stale.status, 409);
  assertEquals((await stale.json()).error, "stale");
  const same = await handle(call("/v1/inventory/confirm", { body: { content_hash: "f".repeat(64), source_time: "2026-10-27T12:00:00Z" } }), d);
  assertEquals((await same.json()).state, "confirmed");
  const changed = await handle(call("/v1/inventory/confirm", { body: { content_hash: "e".repeat(64), source_time: "2026-10-27T12:00:00Z" } }), d);
  assertEquals(changed.status, 409);
  assertEquals((await changed.json()).error, "send_full_snapshot");
});
