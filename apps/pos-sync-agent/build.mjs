import { build } from "esbuild";
import { build as vite } from "vite";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url));
await vite({
  root: root + "src/renderer",
  base: "./",
  build: { outDir: root + "dist/renderer", emptyOutDir: true },
});
await build({
  entryPoints: [root + "src/main/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: root + "dist/main.cjs",
  external: ["electron"],
  packages: "external",
});
await build({
  entryPoints: [root + "src/main/preload.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: root + "dist/preload.cjs",
  external: ["electron"],
});
