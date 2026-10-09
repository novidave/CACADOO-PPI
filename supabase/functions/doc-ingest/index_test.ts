// Unit tests of doc-ingest: excerpts as written, language, who may do what, deleting.
// Run: npm run test:functions
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { chunkPages, cleanText, type Deps, detectLang, ingest, type LookInput, readLimits } from "./index.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}

const SHOP = "11111111-2222-4333-8444-555555555555";
const FOLDER = "22222222-2222-4333-8444-555555555555";
const DOC = "33333333-2222-4333-8444-555555555555";
const PIC = "44444444-2222-4333-8444-555555555555";
const SCAN = "55555555-2222-4333-8444-555555555555";

type Result = { data: unknown; error: { message: string; code?: string } | null };
interface Setup {
  member?: boolean;
  document?: Record<string, unknown> | null;
  service?: (name: string, args: Record<string, unknown>) => Result;
  caller?: (name: string, args: Record<string, unknown>) => Result;
  files?: Record<string, number>;
  look?: Deps["look"];
  removeError?: string;
}

/** Fakes for the caller's client and the service-role client; every call is logged in order. */
function fakes(setup: Setup = {}) {
  const log: string[] = [];
  const ok = (data: unknown): Result => ({ data, error: null });
  const document = setup.document === undefined
    ? { id: DOC, shop_id: SHOP, status: "processing", extracted: false, storage_path: `${SHOP}/docs/${DOC}.pdf`, pages: 10 }
    : setup.document;
  const asCaller = {
    auth: { getUser: (token: string) => Promise.resolve({ data: { user: token === "owner-jwt" ? { id: "u1" } : null } }) },
    rpc: (name: string, args: Record<string, unknown>) => {
      log.push(`caller ${name}`);
      if (setup.caller) return Promise.resolve(setup.caller(name, args));
      return Promise.resolve(ok(name === "is_shop_member" ? setup.member ?? true : null));
    },
    from: (table: string) => ({
      select: () => ({
        eq: (_c: string, id: string) => ({
          maybeSingle: () => {
            log.push(`caller read ${table}`);
            return Promise.resolve(ok(setup.member === false || id !== DOC ? null : document));
          },
        }),
      }),
    }),
  };
  const files = setup.files ?? {};
  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      log.push(`service ${name} ${JSON.stringify(args)}`);
      return Promise.resolve(setup.service ? setup.service(name, args) : ok(null));
    },
    from: (table: string) => ({
      delete: () => ({
        eq: (_c: string, id: string) => {
          log.push(`service delete ${table} ${id}`);
          return Promise.resolve(ok(null));
        },
      }),
    }),
    storage: {
      from: (bucket: string) => ({
        list: (dir: string, o: { search: string }) => {
          log.push(`storage list ${bucket} ${dir}`);
          const path = `${dir}/${o.search}`;
          return Promise.resolve(ok(path in files ? [{ name: o.search, metadata: { size: files[path] } }] : []));
        },
        remove: (paths: string[]) => {
          log.push(`storage remove ${paths.join(",")}`);
          return Promise.resolve({ data: null, error: setup.removeError ? { message: setup.removeError } : null });
        },
        download: (path: string) => {
          log.push(`storage download ${path}`);
          return Promise.resolve(ok(new Blob([new Uint8Array([1, 2, 3])])));
        },
        createSignedUrl: (path: string, seconds: number) => Promise.resolve(ok({ signedUrl: `https://signed/${path}?s=${seconds}` })),
        createSignedUrls: (paths: string[], seconds: number) =>
          Promise.resolve(ok(paths.map((p) => ({ signedUrl: `https://signed/${p}?s=${seconds}` })))),
      }),
    },
  };
  const deps: Deps = {
    asCaller: asCaller as unknown as SupabaseClient,
    db: db as unknown as SupabaseClient,
    limits: { files: 30, pages: 500, pictures: 300 },
    look: setup.look === undefined ? null : setup.look,
  };
  return { deps, log };
}

function request(body: Record<string, unknown>, token = "owner-jwt") {
  return new Request("http://localhost/doc-ingest", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function call(deps: Deps, body: Record<string, unknown>, token?: string) {
  const response = await ingest(request(body, token), deps);
  return [response.status, await response.json()] as const;
}

// ---------------------------------------------------------------- text as written

Deno.test("Text is kept as written: only line ends, trailing spaces and empty lines are tidied", () => {
  eq(cleanText("Cena: 18,40 €  \r\n\r\n\r\n\r\nĎalšia strana\t\n"), "Cena: 18,40 €\n\nĎalšia strana", "clean");
  eq(cleanText("A\u0000B"), "AB", "control characters dropped");
});

Deno.test("Each page is its own excerpt; a long page is split into pieces of at most 800 words", () => {
  eq(chunkPages([{ page: 1, text: "Katalóg 2026" }, { page: 2, text: "   " }, { page: 4, text: "Hadica Flexi 25 m" }]),
    [{ page: 1, text: "Katalóg 2026" }, { page: 4, text: "Hadica Flexi 25 m" }], "short pages");

  const sentences = Array.from({ length: 300 }, (_, i) => `Veta číslo ${i} má presne šesť slov.`);
  const long = sentences.slice(0, 150).join(" ") + "\n\n" + sentences.slice(150).join(" ");
  const chunks = chunkPages([{ page: 7, text: long }]);
  if (chunks.length < 2) throw new Error(`a 1800-word page should be split, got ${chunks.length}`);
  for (const c of chunks) {
    const words = c.text.split(/\s+/).length;
    if (c.page !== 7 || words > 800 || words < 100) throw new Error(`bad piece: page ${c.page}, ${words} words`);
  }
  eq(chunks.map((c) => c.text).join(" ").split(/\s+/), long.split(/\s+/), "no word lost, changed or added");

  const oneWord = "x".repeat(20000);
  for (const c of chunkPages([{ page: 1, text: oneWord }])) {
    if (c.text.length > 8000) throw new Error("an excerpt stays below 8000 characters");
  }
});

Deno.test("The document's language is found from its own words", () => {
  eq(detectLang("Záhradná hadica je odolná voči UV žiareniu a je vhodná pre každú záhradu, ktorá sa polieva."), "sk", "Slovak");
  eq(detectLang("A kerti tömlő nagyon tartós, és minden kertbe jó, mert az ára is kedvező."), "hu", "Hungarian");
  eq(detectLang("The garden hose is made for all gardens and is resistant to UV light for years."), "en", "English");
  eq(detectLang("Il tubo da giardino è resistente ai raggi UV e per questo la sua durata è molto lunga."), "it", "Italian");
  eq(detectLang("Zahradní hadice je odolná a vhodná pro každou zahradu, která se zalévá také večer."), "cs", "Czech");
  eq(detectLang("Der Gartenschlauch ist für jeden Garten und die Sonne geeignet und nicht teuer."), "de", "German");
  eq(detectLang("Hadica 25 m"), null, "too short");
});

Deno.test("Limits per shop come from the secrets", () => {
  eq(readLimits(() => undefined), { files: 30, pages: 500, pictures: 300 }, "defaults");
  const env: Record<string, string> = { SHOP_DOCS_MAX_FILES: "5", SHOP_DOCS_MAX_PAGES: "abc", SHOP_DOCS_MAX_PICTURES: "40" };
  eq(readLimits((n) => env[n]), { files: 5, pages: 500, pictures: 40 }, "set ones");
});

// ---------------------------------------------------------------- who may do what

Deno.test("No login, no access; another shop's owner gets nothing and nothing is written", async () => {
  const { deps, log } = fakes({ member: false });
  eq((await call(deps, { action: "work", shop_id: SHOP }, "nope"))[0], 401, "no login");
  eq((await call(deps, { action: "fly" }))[0], 400, "unknown action");
  for (const body of [
    { action: "register_document", shop_id: SHOP, folder_id: FOLDER, name: "Katalóg", pages: 3, bytes: 1000 },
    { action: "document_uploaded", document_id: DOC },
    { action: "text", document_id: DOC, pages: [{ page: 1, text: "x" }] },
    { action: "register_pictures", shop_id: SHOP, folder_id: FOLDER, items: [{ bytes: 10, type: "image/webp" }] },
    { action: "pictures_uploaded", shop_id: SHOP, picture_ids: [PIC] },
    { action: "document_done", document_id: DOC },
    { action: "work", shop_id: SHOP },
    { action: "links", shop_id: SHOP, picture_ids: [PIC] },
  ]) {
    eq((await call(deps, body))[0], 403, `not a member: ${body.action}`);
  }
  eq(log.filter((l) => l.startsWith("service") || l.startsWith("storage")), [], "the service role was never used");
});

Deno.test("Register a PDF: the shop's limits go to the database, its refusals come back", async () => {
  const { deps, log } = fakes({
    service: () => ({ data: [{ document_id: DOC, storage_path: `${SHOP}/docs/${DOC}.pdf` }], error: null }),
  });
  const body = { action: "register_document", shop_id: SHOP, folder_id: FOLDER, name: " Katalóg 2026 ", pages: 12, bytes: 5000 };
  eq(await call(deps, body), [200, { document_id: DOC, path: `${SHOP}/docs/${DOC}.pdf`, bucket: "shop-docs" }], "registered");
  const sent = JSON.parse(log.find((l) => l.startsWith("service docs_register_document"))!.slice(30));
  eq([sent.p_name, sent.p_max_files, sent.p_max_pages], ["Katalóg 2026", 30, 500], "name and limits");

  eq((await call(deps, { ...body, bytes: 21 * 1024 * 1024 }))[0], 413, "over 20 MB");
  const refused = fakes({ service: () => ({ data: null, error: { message: "limit_files", code: "P0001" } }) });
  eq(await call(refused.deps, body), [409, { error: "limit_files", message: "The shop has reached its number of documents" }], "limit");
});

Deno.test("Uploaded: the PDF must really be in storage", async () => {
  const path = `${SHOP}/docs/${DOC}.pdf`;
  const missing = fakes({ document: { id: DOC, shop_id: SHOP, status: "uploading", extracted: false, storage_path: path, pages: 3 } });
  eq((await call(missing.deps, { action: "document_uploaded", document_id: DOC }))[0], 409, "not uploaded");
  const there = fakes({
    files: { [path]: 1234 },
    document: { id: DOC, shop_id: SHOP, status: "uploading", extracted: false, storage_path: path, pages: 3 },
  });
  eq((await call(there.deps, { action: "document_uploaded", document_id: DOC }))[0], 200, "uploaded");
  eq(there.log.some((l) => l.startsWith("service docs_document_uploaded")), true, "marked");
});

Deno.test("Text: excerpts per page with the document's language; pages the PDF does not have are dropped", async () => {
  const { deps, log } = fakes({ service: () => ({ data: 2, error: null }) });
  const [status, body] = await call(deps, {
    action: "text",
    document_id: DOC,
    pages: [
      { page: 4, text: "Záhradná hadica Flexi 25 m je odolná voči UV žiareniu a je vhodná pre každú záhradu." },
      { page: 1, text: "Katalóg 2026" },
      { page: 99, text: "nie je v PDF" },
    ],
  });
  eq([status, body], [200, { chunks: 2, lang: "sk" }], "saved");
  const sent = JSON.parse(log.find((l) => l.startsWith("service docs_save_text"))!.slice(23));
  eq(sent.p_chunks.map((c: { page: number }) => c.page), [4, 1], "pages kept");
  eq(sent.p_chunks[0].text, "Záhradná hadica Flexi 25 m je odolná voči UV žiareniu a je vhodná pre každú záhradu.", "as written");

  const done = fakes({ document: { id: DOC, shop_id: SHOP, status: "ready", extracted: true, storage_path: "x", pages: 3 } });
  eq((await call(done.deps, { action: "text", document_id: DOC, pages: [] }))[0], 409, "finished documents take no text");
});

Deno.test("Pictures: only WebP, JPEG or PNG up to 10 MB", async () => {
  const { deps } = fakes({ service: () => ({ data: [{ idx: 0, picture_id: PIC, storage_path: `${SHOP}/pictures/${PIC}.webp` }], error: null }) });
  const base = { action: "register_pictures", shop_id: SHOP, folder_id: FOLDER, lang: "sk" };
  eq((await call(deps, { ...base, items: [{ bytes: 10, type: "image/gif" }] }))[0], 400, "gif refused");
  eq((await call(deps, { ...base, items: [{ bytes: 11 * 1024 * 1024, type: "image/webp" }] }))[0], 413, "too big");
  eq(await call(deps, { ...base, items: [{ bytes: 10, type: "image/webp", title: "Hotová záhrada" }] }),
    [200, { pictures: [{ idx: 0, picture_id: PIC, path: `${SHOP}/pictures/${PIC}.webp` }], bucket: "shop-docs" }], "registered");
});

// ---------------------------------------------------------------- the AI

Deno.test("Work: the AI describes a picture once and writes out a scanned page; failures are saved for a retry", async () => {
  const seen: LookInput[] = [];
  const rows = [
    { id: PIC, kind: "picture", storage_path: `${SHOP}/pictures/${PIC}.webp`, lang: "sk", title: "Hotová záhrada", caption: null },
    { id: SCAN, kind: "scan", storage_path: `${SHOP}/pictures/${SCAN}.jpg`, lang: "sk", title: "", caption: null },
  ];
  const { deps, log } = fakes({
    service: (name) => ({ data: name === "docs_claim_work" ? rows : name === "shop_has_plan" ? true : 0, error: null }),
    look: (input) => {
      seen.push(input);
      return Promise.resolve(input.kind === "scan" ? { text: "Návod na zapojenie hadice." } : { description: "Záhrada s hadicou." });
    },
  });
  eq(await call(deps, { action: "work", shop_id: SHOP }), [200, { done: 2, failed: 0, remaining: 0 }], "both done");
  eq(seen.map((s) => [s.kind, s.mediaType, s.lang, s.title]), [["picture", "image/webp", "sk", "Hotová záhrada"],
    ["scan", "image/jpeg", "sk", ""]], "what the AI got");
  const saved = log.filter((l) => l.startsWith("service docs_save_work")).map((l) => JSON.parse(l.slice(23)));
  eq(saved.map((s) => [s.p_picture_id, s.p_description, s.p_chunks, s.p_error]), [
    [PIC, "Záhrada s hadicou.", null, null],
    [SCAN, null, ["Návod na zapojenie hadice."], null],
  ], "saved");

  const failing = fakes({
    service: (name) => ({ data: name === "docs_claim_work" ? rows.slice(0, 1) : name === "shop_has_plan" ? true : 1, error: null }),
    look: () => Promise.reject(new Error("overloaded")),
  });
  eq(await call(failing.deps, { action: "work", shop_id: SHOP }), [200, { done: 0, failed: 1, remaining: 1 }], "failed");
  eq(JSON.parse(failing.log.find((l) => l.startsWith("service docs_save_work"))!.slice(23)).p_error, "overloaded", "kept for a retry");

  const noPlan = fakes({ service: (name) => ({ data: name === "shop_has_plan" ? false : 3, error: null }), look: () => Promise.resolve({}) });
  eq(await call(noPlan.deps, { action: "work", shop_id: SHOP }), [200, { done: 0, failed: 0, remaining: 3, plan: false }], "no plan");
  eq(noPlan.log.some((l) => l.includes("docs_claim_work")), false, "no AI without the plan");

  const noAi = fakes({ service: () => ({ data: 3, error: null }) });
  eq(await call(noAi.deps, { action: "work", shop_id: SHOP }), [200, { done: 0, failed: 0, remaining: 3, ai: false }], "no key");
});

// ---------------------------------------------------------------- deleting

Deno.test("Delete: the files go first, then the row (its text and pictures go with it)", async () => {
  const paths = [`${SHOP}/docs/${DOC}.pdf`, `${SHOP}/pictures/${PIC}.webp`];
  const { deps, log } = fakes({ caller: (name) => ({ data: name === "owner_docs_files" ? paths : true, error: null }) });
  eq(await call(deps, { action: "delete", kind: "document", id: DOC }), [200, { deleted: 2 }], "deleted");
  eq(log.filter((l) => !l.startsWith("caller")), [`storage remove ${paths.join(",")}`, `service delete shop_documents ${DOC}`], "order");

  const notMine = fakes({ caller: () => ({ data: null, error: { message: "Not your file", code: "42501" } }) });
  eq((await call(notMine.deps, { action: "delete", kind: "document", id: DOC }))[0], 403, "another shop's file");
  eq(notMine.log.filter((l) => !l.startsWith("caller")), [], "nothing removed");

  const storageDown = fakes({ caller: () => ({ data: paths, error: null }), removeError: "storage down" });
  eq((await call(storageDown.deps, { action: "delete", kind: "picture", id: PIC }))[0], 502, "storage failed");
  eq(storageDown.log.some((l) => l.startsWith("service delete")), false, "the row stays so that deleting can be tried again");
});

Deno.test("Links: the owner's own thumbnails, signed for 10 minutes", async () => {
  const { deps } = fakes({
    caller: (name) => ({ data: name === "owner_picture_paths" ? [{ id: PIC, storage_path: `${SHOP}/pictures/${PIC}.webp` }] : true, error: null }),
  });
  eq(await call(deps, { action: "links", shop_id: SHOP, picture_ids: [PIC, "not-an-id"] }),
    [200, {
      pictures: { [PIC]: `https://signed/${SHOP}/pictures/${PIC}.webp?s=600` },
      limits: { files: 30, pages: 500, pictures: 300 },
    }], "links and limits");
});
