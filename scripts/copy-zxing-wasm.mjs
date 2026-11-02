// Sklad's camera scanner (update 67) reads barcodes with zxing-wasm (through barcode-detector). Its WebAssembly file is
// served from our own site, /zxing/<version>/zxing_reader.wasm — never from a CDN (public/zxing is generated on every
// dev/build and not committed).
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// zxing-wasm does not export its package.json: walk up from its reader entry to the package root
let dir = dirname(require.resolve("zxing-wasm/reader"));
while (!existsSync(join(dir, "package.json")) || JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name !== "zxing-wasm") {
  const up = dirname(dir);
  if (up === dir) throw new Error("zxing-wasm not found");
  dir = up;
}
const pkgPath = join(dir, "package.json");
const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));
const target = join(process.cwd(), "public", "zxing");

rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, version), { recursive: true });
copyFileSync(join(dirname(pkgPath), "dist", "reader", "zxing_reader.wasm"), join(target, version, "zxing_reader.wasm"));
console.log(`zxing-wasm ${version} -> public/zxing/${version}/`);
