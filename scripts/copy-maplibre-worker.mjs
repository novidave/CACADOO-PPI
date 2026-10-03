// MapLibre's map worker imports "./maplibre-gl-shared.mjs" by name, but the Next.js
// bundler renames that file. Serve both files unchanged from /maplibre/<version>/
// (public/maplibre is generated on every dev/build and not committed).
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkgPath = require.resolve("maplibre-gl/package.json");
const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));
const dist = join(dirname(pkgPath), "dist");
const target = join(process.cwd(), "public", "maplibre");

rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, version), { recursive: true });
for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  copyFileSync(join(dist, file), join(target, version, file));
}
console.log(`maplibre worker ${version} -> public/maplibre/${version}/`);
