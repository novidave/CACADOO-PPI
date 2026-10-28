#!/usr/bin/env node
// A stand-in for the Cacaduu POS Sync Agent, for testing the Cacaduu Cloud API (docs/CONNECTOR_CLOUD_API.md) only.
// It is NOT the agent: the real one stores its token in the operating system's secure storage; this script keeps it
// in a file you name (delete it after testing).
//
//   node scripts/connector-test-agent.mjs pair --url <pairing URL> --code K7QM-4WXP --token-file /tmp/agent.json
//   node scripts/connector-test-agent.mjs heartbeat --token-file /tmp/agent.json [--count 3] [--every 60] [--error "text"]
//   node scripts/connector-test-agent.mjs status --token-file /tmp/agent.json
//   node scripts/connector-test-agent.mjs rotate --token-file /tmp/agent.json
//   node scripts/connector-test-agent.mjs snapshot --token-file /tmp/agent.json (--csv stock.csv | --json products.json | --generate 25)
//   node scripts/connector-test-agent.mjs confirm --token-file /tmp/agent.json        (the last snapshot's content, unchanged)
//
// A snapshot (phase B): announce → PUT the gzipped JSON to the signed upload_url → complete. --csv reads a file with the
// header source_code;name;ean;brand;price;currency;quantity (semicolons, UTF-8); --source-time <ISO> sets the time.
//
// The pairing URL: https://<project-ref>.supabase.co/functions/v1/connector (later the api_base_url it returns).
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { hostname, release, type } from "node:os";

const VERSION = "0.1.0-test";

function args() {
  const [command, ...rest] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < rest.length; i += 2) options[rest[i].replace(/^--/, "")] = rest[i + 1];
  return { command, options };
}

async function call(base, method, path, { token, body } = {}) {
  const headers = { "cacaduu-agent-version": VERSION };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base.replace(/\/+$/, "")}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const load = (file) => JSON.parse(readFileSync(file, "utf8"));
const save = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
// never print a whole token
const masked = (json) => JSON.stringify(json, (k, v) => (k === "device_token" && typeof v === "string" ? `${v.slice(0, 8)}…` : v));

/** "source_code;name;ean;brand;price;currency;quantity" lines → products (empty cells → null). */
function fromCsv(text) {
  const [head, ...lines] = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  const cols = head.split(";").map((c) => c.trim());
  return lines.map((line) => {
    const cells = line.split(";");
    const row = Object.fromEntries(cols.map((c, i) => [c, (cells[i] ?? "").trim() || null]));
    return { ...row, price: Number(String(row.price).replace(",", ".")), quantity: Number(String(row.quantity).replace(",", ".")) };
  });
}

function generated(n) {
  return Array.from({ length: n }, (_, i) => ({
    source_code: `T${String(i + 1).padStart(4, "0")}`, name: `Testovací produkt ${i + 1}`, ean: null, brand: null,
    price: Math.round((1 + i * 1.37) * 100) / 100, currency: "EUR", quantity: i % 5,
  }));
}

async function main() {
  const { command, options } = args();
  const file = options["token-file"];
  if (!command || !file) {
    console.error("usage: pair|heartbeat|status|rotate|snapshot|confirm --token-file <file> [--url <pairing URL> --code <code>]");
    process.exit(2);
  }
  if (command === "pair") {
    const { status, json } = await call(options.url, "POST", "/v1/pair", {
      body: { code: options.code, device_name: options.name ?? `Test agent (${hostname()})`, agent_version: VERSION, os: `${type()} ${release()}` },
    });
    console.log(status, masked(json));
    if (status === 201) save(file, { api_base_url: json.api_base_url, device_id: json.device_id, device_token: json.device_token });
    process.exit(status === 201 ? 0 : 1);
  }
  const state = load(file);
  if (command === "heartbeat") {
    const count = Number(options.count ?? 1);
    for (let i = 0; i < count; i++) {
      const { status, json } = await call(state.api_base_url, "POST", "/v1/heartbeat", {
        token: state.device_token,
        body: {
          agent_version: VERSION,
          os: `${type()} ${release()}`,
          source_label: options.label ?? "Test agent",
          last_read: options.error ? { result: "error", error: options.error } : { result: "ok", at: new Date().toISOString() },
        },
      });
      console.log(new Date().toISOString(), status, masked(json));
      if (status === 401 || status === 426) process.exit(1);
      if (json.api_base_url && json.api_base_url !== state.api_base_url) save(file, { ...state, api_base_url: json.api_base_url });
      if (i < count - 1) await new Promise((r) => setTimeout(r, 1000 * Number(options.every ?? json.next_poll_seconds ?? 60)));
    }
    return;
  }
  if (command === "status") {
    const { status, json } = await call(state.api_base_url, "GET", "/v1/status", { token: state.device_token });
    console.log(status, masked(json));
    process.exit(status === 200 ? 0 : 1);
  }
  if (command === "rotate") {
    const { status, json } = await call(state.api_base_url, "POST", "/v1/credentials/rotate", { token: state.device_token, body: {} });
    console.log(status, masked(json));
    if (status === 200) save(file, { ...state, device_token: json.device_token, previous_token: state.device_token });
    process.exit(status === 200 ? 0 : 1);
  }
  if (command === "snapshot") {
    const products = options.csv ? fromCsv(readFileSync(options.csv, "utf8")) : options.json ? JSON.parse(readFileSync(options.json, "utf8"))
      : generated(Number(options.generate ?? 10));
    const snapshotId = randomUUID();
    const sourceTime = options["source-time"] ?? new Date().toISOString();
    const raw = Buffer.from(JSON.stringify({
      format: "cacaduu.inventory.v1", snapshot_id: snapshotId, source_id: options.source ?? "test-agent", source_time: sourceTime, products,
    }), "utf8");
    const hash = createHash("sha256").update(raw).digest("hex");
    const announced = await call(state.api_base_url, "POST", "/v1/inventory/snapshots", {
      token: state.device_token,
      body: { snapshot_id: snapshotId, source_id: options.source ?? "test-agent", source_time: sourceTime, complete: true,
              product_count: products.length, content_hash: hash, command_id: null },
    });
    console.log("announce", announced.status, masked({ ...announced.json, upload_url: announced.json.upload_url ? "(signed)" : undefined }));
    if (!announced.json.upload_url) process.exit(announced.status < 300 ? 0 : 1);
    const put = await fetch(announced.json.upload_url, { method: "PUT", headers: { "content-type": "application/gzip", "x-upsert": "true" }, body: gzipSync(raw) });
    console.log("upload", put.status);
    await put.body?.cancel();
    let done = await call(state.api_base_url, "POST", `/v1/inventory/snapshots/${snapshotId}/complete`, { token: state.device_token, body: {} });
    for (let i = 0; done.status === 202 && i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      done = await call(state.api_base_url, "GET", `/v1/inventory/snapshots/${snapshotId}`, { token: state.device_token });
    }
    console.log("complete", done.status, masked(done.json));
    if (done.json.state === "applied" || done.json.state === "test_ok" || done.json.state === "held") save(file, { ...state, last_hash: hash });
    process.exit(done.status === 200 ? 0 : 1);
  }
  if (command === "confirm") {
    const { status, json } = await call(state.api_base_url, "POST", "/v1/inventory/confirm", {
      token: state.device_token,
      body: { content_hash: options.hash ?? state.last_hash, source_time: options["source-time"] ?? new Date().toISOString(), command_id: null },
    });
    console.log(status, masked(json));
    process.exit(status === 200 ? 0 : 1);
  }
  console.error(`unknown command ${command}`);
  process.exit(2);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
