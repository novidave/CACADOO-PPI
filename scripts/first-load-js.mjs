// The exact first-load JavaScript budget (performance pass): for each public page, every script the first HTML loads
// (<script src> without noModule, modulepreload), gzip-compressed — must stay under 150 kB. Run by the "Performance"
// workflow on every Vercel preview; locally: `LHCI_BASE_URL=http://localhost:3000 node scripts/first-load-js.mjs`.
import { gzipSync } from "node:zlib";

const base = (process.env.LHCI_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const shop = process.env.LHCI_SHOP || "potraviny-centrum";
const item = process.env.LHCI_ITEM || "";
const LIMIT_KB = 150;
const headers = { "x-vercel-skip-toolbar": "1" };
if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

const pages = ["/sk", "/sk?q=k%C3%A1va", `/sk/shops/${shop}`, `/sk/shops/${shop}/blog`, ...(item ? [`/sk/items/${item}`] : [])];
const sizes = new Map();
let failed = false;
for (const path of pages) {
  const response = await fetch(base + path, { headers });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const html = await response.text();
  const found = [
    ...html.matchAll(/<script(?![^>]*noModule)[^>]+src="([^"]+\.js[^"]*)"/g),
    ...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+\.js[^"]*)"/g),
  ].map((m) => new URL(m[1].replace(/&amp;/g, "&"), base).href);
  let total = 0;
  for (const url of new Set(found)) {
    if (!sizes.has(url)) sizes.set(url, gzipSync(Buffer.from(await (await fetch(url, { headers })).arrayBuffer())).length);
    total += sizes.get(url);
  }
  const kb = Math.round(total / 1024);
  const ok = kb < LIMIT_KB;
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} ${kb} kB first-load JS  ${path}`);
}
if (failed) {
  console.error(`First-load JavaScript over ${LIMIT_KB} kB (gzip) on a page above.`);
  process.exit(1);
}
