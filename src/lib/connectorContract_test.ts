// The POS Sync Agent's contract stays in step with the connector function: every route of the function is in the
// OpenAPI file with the same method and phase (and nothing else is), the written contract names every path and keeps
// the separation sentence word for word, and the copyable client calls every path.
// Run: npm run test:connector
import { assert, assertEquals } from "jsr:@std/assert@1";

const root = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, root));

async function functionRoutes(): Promise<string[]> {
  const source = await read("supabase/functions/connector/index.ts");
  const found = [...source.matchAll(/\{ method: "(GET|POST)", path: "([^"]+)", phase: "([ABC])" \}/g)];
  return found.map((m) => `${m[1]} ${m[2]} ${m[3]}`).sort();
}

async function openApiRoutes(): Promise<string[]> {
  const doc = JSON.parse(await read("docs/connector-openapi.json"));
  const out: string[] = [];
  for (const [path, ops] of Object.entries(doc.paths as Record<string, Record<string, { "x-cacaduu-phase": string }>>)) {
    for (const [method, op] of Object.entries(ops)) out.push(`${method.toUpperCase()} ${path} ${op["x-cacaduu-phase"]}`);
  }
  return out.sort();
}

Deno.test("the OpenAPI file has exactly the function's routes, methods and phases", async () => {
  const fn = await functionRoutes();
  assert(fn.length >= 11, `routes found in the function: ${fn.length}`);
  assertEquals(await openApiRoutes(), fn);
});

Deno.test("the written contract names every path and keeps the separation sentence", async () => {
  const md = await read("docs/CONNECTOR_CLOUD_API.md");
  for (const line of await functionRoutes()) {
    const path = line.split(" ")[1];
    assert(md.includes(path), `missing in CONNECTOR_CLOUD_API.md: ${path}`);
  }
  assert(md.includes(
    "The desktop app's \"Own API (JSON/CSV URL + API key)\" feature is an external POS data source. It is not the Cacaduu Cloud Connection. POS Own API → Desktop Connector → Cacaduu Cloud API → Marketplace. The Cacaduu Cloud API is the destination and remote-control channel, not another POS input.",
  ));
  assert(md.includes("safeStorage"), "recommends the OS secure storage");
});

Deno.test("the copyable client calls every path and imports nothing", async () => {
  const client = await read("docs/connector-client/client.ts");
  assert(!/^\s*import\s/m.test(client), "no imports");
  for (const line of await functionRoutes()) {
    const path = line.split(" ")[1];
    for (const part of path.split("{id}").filter(Boolean)) assert(client.includes(part), `client misses ${path}`);
  }
});
