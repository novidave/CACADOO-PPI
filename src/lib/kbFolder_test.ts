// "Priečinok na počítači" (update 94): which files of the PC folder the assistant reads, which wait, and what a
// check does with each. Run with `npm run test:content`.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { kbAction, kbDocName, kbFileKind, planCheck } from "./kbFolder.ts";

Deno.test("the types: PDF and pictures (HEIC too); others listed as unsupported; hidden and Office lock files ignored", () => {
  assertEquals(kbFileKind("Cenník 2026.PDF"), "pdf");
  for (const n of ["a.jpg", "b.JPEG", "c.png", "d.webp", "e.heic", "f.HEIF"]) assertEquals(kbFileKind(n), "picture", n);
  assertEquals(kbFileKind("tabulka.xlsx"), null);
  assertEquals(kbFileKind("readme.txt"), null);
  assertEquals(kbFileKind(".DS_Store"), undefined);
  assertEquals(kbFileKind("~$cennik.pdf"), undefined);
});

Deno.test("a check: new and changed files are read, unchanged ones keep their hash, fresh ones wait 60 s", () => {
  const now = 10_000_000;
  const plan = planCheck(
    [
      { name: "novy.pdf", size: 10, mtime: now - 120_000 },
      { name: "zmeneny.pdf", size: 11, mtime: now - 120_000 },
      { name: "rovnaky.jpg", size: 5, mtime: 42 },
      { name: "prave-kopirovany.pdf", size: 7, mtime: now - 5_000 },
      { name: "tabulka.xlsx", size: 3, mtime: 1 },
      { name: "~$lock.pdf", size: 1, mtime: 1 },
    ],
    { "zmeneny.pdf": { size: 10, mtime: now - 120_000, hash: "h1" }, "rovnaky.jpg": { size: 5, mtime: 42, hash: "h2" } },
    now,
  );
  assertEquals(plan.read, ["novy.pdf", "zmeneny.pdf"]);
  assertEquals(plan.unchanged, [{ name: "rovnaky.jpg", hash: "h2" }]);
  assertEquals(plan.waiting, ["prave-kopirovany.pdf"]);
  assertEquals(plan.unsupported, ["tabulka.xlsx"]);
  // a file still being copied is not missing: it is present
  assert(plan.present.includes("prave-kopirovany.pdf"));
  assert(!plan.present.includes("~$lock.pdf") && !plan.present.includes("tabulka.xlsx"));
});

Deno.test("the hash decides: the same content = nothing, new name = new document, other content = replace its own", () => {
  const known = [
    { kind: "document" as const, id: "d1", name: "cennik.pdf", hash: "aaa", status: "ready" },
    { kind: "picture" as const, id: "p1", name: "foto.jpg", hash: "bbb", status: "ready" },
  ];
  assertEquals(kbAction("cennik.pdf", "aaa", known).action, "same");
  assertEquals(kbAction("novy.pdf", "ccc", known).action, "new");
  const r = kbAction("cennik.pdf", "zzz", known);
  assertEquals(r.action, "replace");
  assertEquals(r.old.map((k) => k.id), ["d1"]);
  // a document whose upload failed is read again even with the same content
  assertEquals(kbAction("x.pdf", "h", [{ kind: "document", id: "e", name: "x.pdf", hash: "h", status: "error" }]).action, "replace");
});

Deno.test("a document's name is the file name without its extension", () => {
  assertEquals(kbDocName("Cenník 2026.pdf"), "Cenník 2026");
  assertEquals(kbDocName("foto.heic"), "foto");
});
