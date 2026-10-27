#!/usr/bin/env node
// A stand-in for the Cacaduu POS Sync Agent, for testing the Cacaduu Cloud API (docs/CONNECTOR_CLOUD_API.md) only.
// It is NOT the agent: the real one stores its token in the operating system's secure storage; this script keeps it
// in a file you name (delete it after testing).
//
//   node scripts/connector-test-agent.mjs pair --url <pairing URL> --code K7QM-4WXP --token-file /tmp/agent.json
//   node scripts/connector-test-agent.mjs heartbeat --token-file /tmp/agent.json [--count 3] [--every 60] [--error "text"]
//   node scripts/connector-test-agent.mjs status --token-file /tmp/agent.json
//   node scripts/connector-test-agent.mjs rotate --token-file /tmp/agent.json
//
// The pairing URL: https://<project-ref>.supabase.co/functions/v1/connector (later the api_base_url it returns).
import { readFileSync, writeFileSync } from "node:fs";
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

async function main() {
  const { command, options } = args();
  const file = options["token-file"];
  if (!command || !file) {
    console.error("usage: pair|heartbeat|status|rotate --token-file <file> [--url <pairing URL> --code <code>]");
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
  console.error(`unknown command ${command}`);
  process.exit(2);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
