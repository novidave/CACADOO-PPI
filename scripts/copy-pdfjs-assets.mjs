// The dashboard reads PDFs in the owner's browser with pdf.js (text, pictures, scanned
// pages). Its worker and data files are served unchanged from /pdfjs/<version>/
// (public/pdfjs is generated on every dev/build and not committed).
import { cpSync, copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkgPath = require.resolve("pdfjs-dist/package.json");
const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));
const root = dirname(pkgPath);
const target = join(process.cwd(), "public", "pdfjs");

rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, version), { recursive: true });
// The "legacy" build works in older browsers too (src/lib/pdfRead.ts uses it as well).
copyFileSync(join(root, "legacy", "build", "pdf.worker.min.mjs"), join(target, version, "pdf.worker.min.mjs"));
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  cpSync(join(root, dir), join(target, version, dir), { recursive: true });
}
console.log(`pdf.js ${version} -> public/pdfjs/${version}/`);
