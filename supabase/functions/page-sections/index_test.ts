// Unit tests of page-sections: PDF limits and cleaning, page pictures, who may do what, the
// public bucket follows the database, deleting removes every file.
// Run: npm run test:functions
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from "npm:pdf-lib@1.17.1";
import { cleanPdf, type Deps, handle, limitsOf, looksLikePdf, MAX_PDF_BYTES, PdfRejected, PRIVATE, PUBLIC, safeUri, sniffPicture } from "./index.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}
function ok(value: unknown, label: string) {
  if (!value) throw new Error(label);
}

const SHOP = "11111111-2222-4333-8444-555555555555";
const SECTION = "66666666-2222-4333-8444-555555555555";

// ---------------------------------------------------------------- test PDFs

/** A PDF with everything a cleaned file must not have, plus things it must keep. */
async function dangerousPdf(pages = 3): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Novinky október – strana ${i + 1}`, { x: 40, y: 780, size: 14 });
    // a transparency group (/S /Transparency) is not an action and stays
    page.node.set(PDFName.of("Group"), ctx.obj({ S: "Transparency", CS: "DeviceRGB" }));
  }
  const first = doc.getPage(0);
  const js = (code: string) => ctx.obj({ Type: "Action", S: "JavaScript", JS: PDFString.of(code) });
  doc.catalog.set(PDFName.of("OpenAction"), js("app.alert('open')"));
  doc.catalog.set(PDFName.of("Names"), ctx.obj({
    JavaScript: ctx.register(ctx.obj({ Names: [PDFString.of("init"), ctx.register(js("app.launchURL('x')"))] })),
  }));
  first.node.set(PDFName.of("AA"), ctx.obj({ O: js("this.print()") }));
  const link = (action: PDFDict) => ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 50, 50], A: action }));
  const annots = [
    link(ctx.obj({ S: "Launch", F: PDFString.of("calc.exe") })),
    link(ctx.obj({ S: "URI", URI: PDFString.of("https://evil.example/setup.exe") })),
    link(ctx.obj({ S: "URI", URI: PDFString.of("https://www.obchod.sk/akcie") })),
    link(ctx.obj({ S: "SubmitForm", F: PDFString.of("https://evil.example/collect") })),
    ctx.register(ctx.obj({ Type: "Annot", Subtype: "FileAttachment", Rect: [0, 0, 10, 10], FS: PDFString.of("x.exe") })),
  ];
  first.node.set(PDFName.of("Annots"), ctx.obj(annots));
  await doc.attach(new TextEncoder().encode("MZ fake program"), "setup.exe", { mimeType: "application/octet-stream" });
  return await doc.save({ useObjectStreams: true });
}

async function plainPdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]).drawText(`Strana ${i + 1}`, { x: 40, y: 780, size: 12 });
  return await doc.save();
}

/** A tiny PDF with an /Encrypt entry, as a password-protected file has. */
function encryptedPdf(): Uint8Array {
  return new TextEncoder().encode(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\n" +
      "4 0 obj<</Filter/Standard/V 1/R 2/O(xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx)/U(yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy)/P -4>>endobj\n" +
      "trailer<</Root 1 0 R/Size 5/Encrypt 4 0 R>>\n%%EOF\n",
  );
}

async function rejected(bytes: Uint8Array, limits?: Parameters<typeof cleanPdf>[1]): Promise<string> {
  try {
    await cleanPdf(bytes, limits);
  } catch (e) {
    if (e instanceof PdfRejected) return e.code;
    throw e;
  }
  return "accepted";
}

Deno.test("PDF limits: not a PDF, too big, encrypted, more than 20 pages", async () => {
  eq(await rejected(new TextEncoder().encode("GIF89a not a pdf")), "not_pdf", "not a PDF");
  eq(looksLikePdf(new TextEncoder().encode("garbage\n%PDF-1.7\n")), true, "%PDF- a little later");
  eq(await rejected(new Uint8Array(MAX_PDF_BYTES + 1)), "too_big", "more than 10 MB");
  eq(await rejected(encryptedPdf()), "encrypted", "a password-protected PDF");
  eq(await rejected(await plainPdf(21)), "too_many_pages", "21 pages");
  eq(await rejected(new TextEncoder().encode("%PDF-1.4\n%%EOF")), "unreadable", "no pages");
  const twenty = await cleanPdf(await plainPdf(20));
  eq(twenty.pages, 20, "20 pages are fine");
});

Deno.test("limits per plan from the database (update 30): free 5 pages, the admin's numbers, the caps", async () => {
  const free = limitsOf({ has_plan: false, max_pages: 5, max_bytes: 10 * 1048576 })!;
  eq(free, { maxPages: 5, maxBytes: 10 * 1048576 }, "a free shop's limits");
  eq(await rejected(await plainPdf(6), free), "too_many_pages", "6 pages on a free shop");
  eq((await cleanPdf(await plainPdf(5), free)).pages, 5, "5 pages are fine");
  eq(await rejected(new Uint8Array(3 * 1048576 + 1), { maxPages: 5, maxBytes: 3 * 1048576 }), "too_big", "over the admin's 3 MB");
  eq(limitsOf({ has_plan: true, max_pages: 500, max_bytes: 500 * 1048576 }), { maxPages: 50, maxBytes: 20 * 1048576 }, "never over the caps");
  eq(limitsOf({ has_plan: true }), { maxPages: 20, maxBytes: MAX_PDF_BYTES }, "before update 30: Pro's old limits");
  eq(limitsOf({ has_plan: false }), null, "before update 30: no sections without the plan");
});

Deno.test("cleaning removes JavaScript, actions, launch, links to programs and embedded files", async () => {
  const cleaned = await cleanPdf(await dangerousPdf());
  eq(cleaned.pages, 3, "pages");
  for (const label of ["JavaScript", "open action", "automatic actions", "embedded files", "attached files and media", "links to programs"]) {
    ok(cleaned.removed.includes(label), `reported: ${label} (got ${cleaned.removed.join(", ")})`);
  }
  ok(cleaned.removed.some((r) => r.startsWith("Launch")), "Launch reported");

  const doc = await PDFDocument.load(cleaned.bytes);
  const catalog = doc.catalog;
  eq(catalog.has(PDFName.of("OpenAction")), false, "no open action");
  const names = catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  eq(Boolean(names?.has(PDFName.of("JavaScript"))), false, "no document JavaScript");
  eq(Boolean(names?.has(PDFName.of("EmbeddedFiles"))), false, "no embedded files");
  const page = doc.getPage(0);
  eq(page.node.has(PDFName.of("AA")), false, "no page actions");
  eq(page.node.has(PDFName.of("Group")), true, "the transparency group stays");
  const annots = page.node.lookup(PDFName.of("Annots"), PDFArray).asArray().map((a) => doc.context.lookup(a) as PDFDict);
  eq(annots.length, 4, "the file attachment is gone, the links stay");
  const actions = annots.map((a) => {
    const action = a.lookupMaybe(PDFName.of("A"), PDFDict);
    return action ? `${action.get(PDFName.of("S"))} ${action.lookupMaybe(PDFName.of("URI"), PDFString)?.decodeText() ?? ""}`.trim() : null;
  });
  eq(actions, [null, null, "/URI https://www.obchod.sk/akcie", null], "only the safe web link keeps its action");

  // nothing of it anywhere in the file (no object streams in the cleaned file)
  const text = new TextDecoder("latin1").decode(cleaned.bytes);
  for (const token of ["/JavaScript", "/JS ", "/JS(", "/Launch", "/EmbeddedFile", "/OpenAction", "/SubmitForm", "setup.exe", "app.alert"]) {
    eq(text.includes(token), false, `no ${token} in the file`);
  }
  // a clean file stays as it is (nothing reported)
  eq((await cleanPdf(await plainPdf(2))).removed, [], "nothing removed from a clean PDF");
});

Deno.test("links: only https, http and mailto, never to a program", () => {
  eq(safeUri("https://obchod.sk/letak"), true, "https");
  eq(safeUri("mailto:info@obchod.sk"), true, "mailto");
  eq(safeUri("javascript:alert(1)"), false, "javascript:");
  eq(safeUri("file:///C:/Windows/calc.exe"), false, "file:");
  eq(safeUri("https://x.sk/a.EXE?x=1"), false, "a program");
  eq(safeUri("https://x.sk/a.ps1"), false, "a script");
});

// ---------------------------------------------------------------- page pictures

function webpVp8(width: number, height: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set(new TextEncoder().encode("RIFF"), 0);
  b.set(new TextEncoder().encode("WEBPVP8 "), 8);
  b.set([0, 0, 0, 0x9d, 0x01, 0x2a, width & 0xff, width >> 8, height & 0xff, height >> 8], 20);
  return b;
}
function webpVp8l(width: number, height: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set(new TextEncoder().encode("RIFF"), 0);
  b.set(new TextEncoder().encode("WEBPVP8L"), 8);
  const bits = (width - 1) | ((height - 1) << 14);
  b.set([0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff], 20);
  return b;
}
function webpVp8x(width: number, height: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set(new TextEncoder().encode("RIFF"), 0);
  b.set(new TextEncoder().encode("WEBPVP8X"), 8);
  const w = width - 1;
  const h = height - 1;
  b.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 24);
  return b;
}
function jpeg(width: number, height: number): Uint8Array {
  // SOI, APP0 (16 bytes), SOF0 with the size
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
    0xff, 0xd9,
  ]);
}

Deno.test("page pictures: WebP or JPEG by their first bytes, with their pixel size", () => {
  eq(sniffPicture(webpVp8(1600, 2263)), { type: "webp", width: 1600, height: 2263 }, "lossy WebP");
  eq(sniffPicture(webpVp8l(800, 1131)), { type: "webp", width: 800, height: 1131 }, "lossless WebP");
  eq(sniffPicture(webpVp8x(1600, 1131)), { type: "webp", width: 1600, height: 1131 }, "extended WebP");
  eq(sniffPicture(jpeg(800, 566)), { type: "jpg", width: 800, height: 566 }, "JPEG");
  eq(sniffPicture(new TextEncoder().encode("<svg onload=alert(1)>")), null, "SVG is not a picture here");
  eq(sniffPicture(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), null, "PNG is not taken");
});

// ---------------------------------------------------------------- requests

type Result = { data: unknown; error: { message: string; code?: string } | null };
interface Setup {
  owner?: boolean;
  plan?: boolean;
  /** The limits owner_section gives (update 30); absent: the database before it. */
  limits?: { plan: string; max_pages: number; max_bytes: number };
  uploadVersion?: number | null;
  service?: (name: string, args: Record<string, unknown>) => Result | undefined;
  copyFails?: boolean;
  read?: Deps["read"];
}

function fakes(setup: Setup = {}) {
  const log: string[] = [];
  const uploads = new Map<string, Uint8Array>();
  const ok = (data: unknown): Result => ({ data, error: null });
  const asCaller = {
    auth: { getUser: (token: string) => Promise.resolve({ data: { user: token === "owner-jwt" ? { id: "u1" } : null } }) },
    rpc: (name: string, args: Record<string, unknown>) => {
      log.push(`caller ${name}`);
      if (setup.owner === false) return Promise.resolve({ data: null, error: { message: "Not your shop", code: "42501" } });
      if (name === "owner_section") {
        return Promise.resolve(ok([{ shop_id: SHOP, version: 1, upload_version: setup.uploadVersion === undefined ? 2 : setup.uploadVersion, upload_pages: 3, has_plan: setup.plan ?? true, ...setup.limits }]));
      }
      if (name === "owner_section_files") {
        return Promise.resolve(ok([
          { bucket: PRIVATE, path: `${SHOP}/${SECTION}/v1/section.pdf` },
          { bucket: PRIVATE, path: `${SHOP}/${SECTION}/v1/1-800.webp` },
          { bucket: PUBLIC, path: `${SHOP}/${SECTION}/v1/1-800.webp` },
        ]));
      }
      return Promise.resolve(ok(null));
      void args;
    },
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => {
          log.push(`caller read ${table}`);
          return Promise.resolve(ok([
            { page: 1, width: 1600, height: 2263, ext: "webp", text: "Novinky", small_bytes: 1, large_bytes: 2 },
            { page: 2, width: 1600, height: 2263, ext: null, text: "", small_bytes: null, large_bytes: null },
          ]));
        },
      };
      return chain;
    },
  };
  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      log.push(`service ${name} ${JSON.stringify(args)}`);
      const custom = setup.service?.(name, args);
      if (custom) return Promise.resolve(custom);
      if (name === "assistant_cron_ok") return Promise.resolve(ok(args.p_secret === "cron-secret"));
      if (name === "sections_begin_upload") {
        return Promise.resolve(ok([{ version: 2, pdf_path: `${SHOP}/${SECTION}/v2/section.pdf`, stale_paths: [`${SHOP}/${SECTION}/v2/old.pdf`] }]));
      }
      if (name === "sections_to_sync") return Promise.resolve(ok([]));
      if (name === "sections_claim_ai") return Promise.resolve(ok([]));
      return Promise.resolve(ok(null));
    },
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        lt: () => Promise.resolve({ count: 0, error: null }),
        delete: () => ({
          eq: (_c: string, id: string) => {
            log.push(`service delete ${table} ${id}`);
            return Promise.resolve(ok(null));
          },
        }),
      };
      return chain;
    },
    storage: {
      from: (bucket: string) => ({
        upload: (path: string, body: Uint8Array | Blob) => {
          log.push(`storage upload ${bucket} ${path}`);
          if (body instanceof Uint8Array) uploads.set(`${bucket}/${path}`, body);
          return Promise.resolve(ok({ path }));
        },
        copy: (from: string, to: string, o: { destinationBucket: string }) => {
          log.push(`storage copy ${bucket}/${from} → ${o.destinationBucket}/${to}`);
          return Promise.resolve(setup.copyFails ? { data: null, error: { message: "exists" } } : ok({ path: to }));
        },
        download: (path: string) => {
          log.push(`storage download ${bucket} ${path}`);
          return Promise.resolve(ok(new Blob([new Uint8Array([1, 2, 3])])));
        },
        remove: (paths: string[]) => {
          if (paths.length) log.push(`storage remove ${bucket} ${paths.join(",")}`);
          return Promise.resolve(ok(null));
        },
        createSignedUrls: (paths: string[], seconds: number) =>
          Promise.resolve(ok(paths.map((p) => ({ signedUrl: `https://signed/${p}?s=${seconds}` })))),
      }),
    },
  };
  const deps: Deps = {
    asCaller: asCaller as unknown as SupabaseClient,
    db: db as unknown as SupabaseClient,
    read: setup.read ?? null,
  };
  return { deps, log, uploads };
}

const json = (body: unknown, token = "owner-jwt") =>
  new Request("https://fn/page-sections", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const binary = (query: string, body: Uint8Array, token = "owner-jwt") =>
  new Request(`https://fn/page-sections?${query}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: body as unknown as BodyInit });

Deno.test("only the shop's owners, logged in; the job only with its secret", async () => {
  const { deps } = fakes();
  eq((await handle(json({ action: "sync", section_id: SECTION }, "nobody"), deps)).status, 401, "no login");
  const notOwner = fakes({ owner: false });
  eq((await handle(json({ action: "sync", section_id: SECTION }), notOwner.deps)).status, 403, "another shop's owner");
  eq((await handle(binary(`action=pdf&section_id=${SECTION}`, await plainPdf(1)), notOwner.deps)).status, 403, "PDF of another shop");
  const job = (secret: string) => new Request("https://fn/page-sections", { method: "POST", headers: { "x-ppi-cron": secret }, body: "{}" });
  eq((await handle(job("wrong"), deps)).status, 401, "wrong job secret");
  const tick = fakes();
  eq((await handle(job("cron-secret"), tick.deps)).status, 200, "the hourly job");
  ok(tick.log.some((l) => l.startsWith("service sections_to_sync")), "the job syncs every section");
});

Deno.test("a PDF: refused when encrypted (noted for the owner), stored only cleaned", async () => {
  const bad = fakes();
  const response = await handle(binary(`action=pdf&section_id=${SECTION}`, encryptedPdf()), bad.deps);
  eq(response.status, 422, "encrypted");
  eq((await response.json()).error, "encrypted", "the reason");
  ok(bad.log.some((l) => l.includes("sections_upload_failed")), "noted for the owner");
  ok(!bad.log.some((l) => l.startsWith("storage upload")), "nothing stored");

  const noPlan = fakes({ plan: false });
  eq((await handle(binary(`action=pdf&section_id=${SECTION}`, await plainPdf(1)), noPlan.deps)).status, 409, "no paid plan (before update 30)");

  // update 30: a free shop takes a PDF within its plan's limits; over them it is refused, with the numbers
  const free = { plan: "free", max_pages: 5, max_bytes: 10 * 1048576 };
  const freeOk = fakes({ plan: false, limits: free });
  eq((await handle(binary(`action=pdf&section_id=${SECTION}`, await plainPdf(5)), freeOk.deps)).status, 200, "free: 5 pages taken");
  const freeLong = fakes({ plan: false, limits: free });
  const long = await handle(binary(`action=pdf&section_id=${SECTION}`, await plainPdf(6)), freeLong.deps);
  eq(long.status, 413, "free: 6 pages refused");
  const longBody = await long.json();
  eq([longBody.error, longBody.max_pages, longBody.max_mb], ["too_many_pages", 5, 10], "the reason and the free limits");
  ok(!freeLong.log.some((l) => l.startsWith("storage upload")), "nothing stored");
  const small = fakes({ plan: false, limits: { plan: "free", max_pages: 5, max_bytes: 1048576 } });
  eq((await handle(binary(`action=pdf&section_id=${SECTION}`, new Uint8Array(1048577)), small.deps)).status, 413, "over the admin's 1 MB");

  const good = fakes();
  const stored = await handle(binary(`action=pdf&section_id=${SECTION}`, await dangerousPdf()), good.deps);
  eq(stored.status, 200, "a dangerous PDF is cleaned and taken");
  const body = await stored.json();
  eq([body.version, body.pages], [2, 3], "version and pages");
  ok(good.log.some((l) => l === `storage remove ${PRIVATE} ${SHOP}/${SECTION}/v2/old.pdf`), "a half-made upload is removed");
  const file = good.uploads.get(`${PRIVATE}/${SHOP}/${SECTION}/v2/section.pdf`);
  ok(file, "the cleaned PDF is stored privately");
  eq(new TextDecoder("latin1").decode(file!).includes("/JavaScript"), false, "only the cleaned file");
  ok(!good.log.some((l) => l.includes(PUBLIC)), "never in the public bucket");
});

Deno.test("pictures instead of a PDF (update 31): within the plan's pictures and MB, no PDF stored", async () => {
  const free = { plan: "free", max_pages: 5, max_bytes: 10 * 1048576 };
  const f = fakes({ plan: false, limits: free });
  const ok3 = await handle(json({ action: "pictures", section_id: SECTION, pages: 3, bytes: 2_000_000 }), f.deps);
  eq(ok3.status, 200, "3 pictures taken");
  eq((await ok3.json()).version, 2, "the new version");
  ok(f.log.some((l) => l.startsWith("service sections_begin_upload") && l.includes('"p_source":"pictures"') && l.includes('"p_pages":3')), "begun as pictures");
  ok(f.log.some((l) => l === `storage remove ${PRIVATE} ${SHOP}/${SECTION}/v2/old.pdf`), "a half-made upload is removed");
  ok(!f.log.some((l) => l.startsWith("storage upload")), "no PDF stored");
  const six = fakes({ plan: false, limits: free });
  const r6 = await handle(json({ action: "pictures", section_id: SECTION, pages: 6, bytes: 1000 }), six.deps);
  eq([r6.status, (await r6.json()).error], [413, "too_many_pages"], "6 pictures on a free shop");
  const big = fakes({ plan: false, limits: free });
  eq((await handle(json({ action: "pictures", section_id: SECTION, pages: 1, bytes: 10 * 1048576 + 1 }), big.deps)).status, 413, "a picture over 10 MB");
  const none = fakes({ plan: false });
  eq((await handle(json({ action: "pictures", section_id: SECTION, pages: 1, bytes: 1000 }), none.deps)).status, 409, "before update 30: no plan, no sections");
  const old = fakes({
    service: (name, args) =>
      name === "sections_begin_upload" && "p_source" in args ? { data: null, error: { message: "Could not find the function", code: "PGRST202" } } : undefined,
  });
  const r = await handle(json({ action: "pictures", section_id: SECTION, pages: 1, bytes: 1000 }), old.deps);
  eq([r.status, (await r.json()).error], [409, "pictures_unavailable"], "before update 31");
  eq((await handle(json({ action: "pictures", section_id: SECTION, pages: 1, bytes: 1000 }), fakes({ owner: false }).deps)).status, 403, "only the owner");
});

Deno.test("page pictures: right width and type, of the PDF being uploaded", async () => {
  const q = (page: number, size: number, version = 2) => `action=page&section_id=${SECTION}&version=${version}&page=${page}&size=${size}`;
  const f = fakes();
  eq((await handle(binary(q(1, 1600), webpVp8(1200, 1700)), f.deps)).status, 400, "wrong width");
  eq((await handle(binary(q(1, 800), new TextEncoder().encode("<svg/>")), f.deps)).status, 415, "not a picture");
  eq((await handle(binary(q(4, 800), webpVp8(800, 1131)), f.deps)).status, 400, "page 4 of 3");
  eq((await handle(binary(q(1, 800, 1), webpVp8(800, 1131)), f.deps)).status, 400, "not the version being uploaded");
  eq((await handle(binary(q(1, 1000), webpVp8(1000, 1131)), f.deps)).status, 400, "only 800 or 1600");
  eq((await handle(binary(q(1, 800), webpVp8(800, 1131)), f.deps)).status, 200, "a good picture");
  ok(f.log.includes(`storage upload ${PRIVATE} ${SHOP}/${SECTION}/v2/1-800.webp`), "stored privately");
  ok(f.log.some((l) => l.startsWith("service sections_page_stored") && l.includes('"p_width":800') && l.includes('"p_ext":"webp"')), "noted");
  eq((await handle(binary(q(2, 1600), jpeg(1600, 2263)), f.deps)).status, 200, "JPEG (Safari)");
  ok(f.log.includes(`storage upload ${PRIVATE} ${SHOP}/${SECTION}/v2/2-1600.jpg`), "JPEG stored");
});

Deno.test("text as written: layout tidied only", async () => {
  const f = fakes();
  const r = await handle(json({
    action: "text", section_id: SECTION, version: 2,
    pages: [{ page: 1, text: "Novinky október\r\n\r\n\r\n\r\nFarba 19,90 €   \n" }, { page: 2, text: "" }, { page: 9, text: "x" }],
  }), f.deps);
  eq(r.status, 200, "saved");
  const call = f.log.find((l) => l.startsWith("service sections_save_text"))!;
  ok(call.includes('{"page":1,"text":"Novinky október\\n\\nFarba 19,90 €"}'), `as written (${call})`);
  ok(!call.includes('"page":9'), "a page the PDF does not have is left out");
});

Deno.test("finish: the new PDF goes live, the old files go, a visible section's pictures go public", async () => {
  const pages = [{ page: 1, ext: "webp" }, { page: 2, ext: "jpg" }];
  const f = fakes({
    service: (name) => {
      if (name === "sections_finish") {
        return { data: [{ old_paths: [`${SHOP}/${SECTION}/v1/section.pdf`], old_public_paths: [`${SHOP}/${SECTION}/v1/1-800.webp`] }], error: null };
      }
      if (name === "sections_to_sync") {
        return { data: [{ id: SECTION, shop_id: SHOP, version: 2, public_version: null, visible: true, pages }], error: null };
      }
    },
  });
  const r = await handle(json({ action: "finish", section_id: SECTION, version: 2 }), f.deps);
  eq(r.status, 200, "finished");
  ok(f.log.includes(`storage remove ${PUBLIC} ${SHOP}/${SECTION}/v1/1-800.webp`), "old public copies removed");
  ok(f.log.includes(`storage remove ${PRIVATE} ${SHOP}/${SECTION}/v1/section.pdf`), "old private files removed");
  eq(f.log.filter((l) => l.startsWith("storage copy")).length, 4, "2 pages × 2 sizes copied");
  ok(f.log.includes(`storage copy ${PRIVATE}/${SHOP}/${SECTION}/v2/2-1600.jpg → ${PUBLIC}/${SHOP}/${SECTION}/v2/2-1600.jpg`), "same path");
  ok(f.log.some((l) => l.startsWith("service sections_mark_public") && l.includes('"p_version":2')), "noted as public");

  const incomplete = fakes({ service: (name) => (name === "sections_finish" ? { data: null, error: { message: "incomplete" } } : undefined) });
  eq((await (await handle(json({ action: "finish", section_id: SECTION, version: 2 }), incomplete.deps)).json()).error, "incomplete", "pages missing");
});

Deno.test("sync: hidden, expired or no plan → the pictures leave the public bucket", async () => {
  const f = fakes({
    service: (name) =>
      name === "sections_to_sync"
        ? { data: [{ id: SECTION, shop_id: SHOP, version: 2, public_version: 2, visible: false, pages: [{ page: 1, ext: "webp" }] }], error: null }
        : undefined,
  });
  eq((await handle(json({ action: "sync", section_id: SECTION }), f.deps)).status, 200, "synced");
  ok(f.log.includes(`storage remove ${PUBLIC} ${SHOP}/${SECTION}/v2/1-800.webp,${SHOP}/${SECTION}/v2/1-1600.webp`), "removed");
  ok(f.log.some((l) => l.startsWith("service sections_mark_public") && l.includes('"p_version":null')), "noted");

  // a copy that fails (already there) is downloaded and uploaded instead
  const again = fakes({
    copyFails: true,
    service: (name) =>
      name === "sections_to_sync"
        ? { data: [{ id: SECTION, shop_id: SHOP, version: 2, public_version: null, visible: true, pages: [{ page: 1, ext: "webp" }] }], error: null }
        : undefined,
  });
  await handle(json({ action: "sync", section_id: SECTION }), again.deps);
  ok(again.log.includes(`storage upload ${PUBLIC} ${SHOP}/${SECTION}/v2/1-1600.webp`), "uploaded instead of copied");

  // update 30: an owner's action syncs the whole shop (on a free shop the next section may show)
  ok(f.log.some((l) => l.startsWith("service sections_to_sync") && l.includes(`"p_shop_id":"${SHOP}"`)), "the whole shop");
  // before update 30 (no p_shop_id): the one section
  const old = fakes({
    service: (name, args) =>
      name === "sections_to_sync" && "p_shop_id" in args ? { data: null, error: { message: "Could not find the function", code: "PGRST202" } } : undefined,
  });
  eq((await handle(json({ action: "sync", section_id: SECTION }), old.deps)).status, 200, "synced before update 30");
  ok(old.log.some((l) => l === `service sections_to_sync {"p_section_id":"${SECTION}"}`), "the one section");
});

Deno.test("the AI reads a page without text from its 1600 px picture; failures are noted", async () => {
  const seen: string[] = [];
  const f = fakes({
    read: (_image, mediaType) => {
      seen.push(mediaType);
      return Promise.resolve("Akcia: valček 4,50 €\n\n\n\nkoniec");
    },
    service: (name) =>
      name === "sections_claim_ai"
        ? { data: [{ page_id: 7, shop_id: SHOP, section_id: SECTION, version: 2, page: 3, ext: "jpg" }], error: null }
        : undefined,
  });
  const r = await (await handle(json({ action: "work", section_id: SECTION }), f.deps)).json();
  eq([r.done, r.failed], [1, 0], "read");
  eq(seen, ["image/jpeg"], "the picture's type");
  ok(f.log.includes(`storage download ${PRIVATE} ${SHOP}/${SECTION}/v2/3-1600.jpg`), "the large picture");
  ok(f.log.some((l) => l.startsWith("service sections_save_ai_text") && l.includes("Akcia: valček 4,50 €\\n\\nkoniec")), "as written");

  const noAi = fakes();
  eq((await (await handle(json({ action: "work", section_id: SECTION }), noAi.deps)).json()).ai, false, "without a key: waits");
});

Deno.test("preview: 10-minute addresses of the owner's private pictures", async () => {
  const f = fakes();
  const r = await (await handle(json({ action: "preview", section_id: SECTION, which: "upload" }), f.deps)).json();
  eq(r.version, 2, "the PDF being uploaded");
  eq(r.pages.length, 1, "only complete pages");
  eq(r.pages[0].small, `https://signed/${SHOP}/${SECTION}/v2/1-800.webp?s=600`, "signed, 10 minutes");
  eq(r.pages[0].large, `https://signed/${SHOP}/${SECTION}/v2/1-1600.webp?s=600`, "large");
});

Deno.test("delete: every file in both buckets first, then the section", async () => {
  const f = fakes();
  eq((await handle(json({ action: "delete", section_id: SECTION }), f.deps)).status, 200, "deleted");
  const publicAt = f.log.indexOf(`storage remove ${PUBLIC} ${SHOP}/${SECTION}/v1/1-800.webp`);
  const privateAt = f.log.indexOf(`storage remove ${PRIVATE} ${SHOP}/${SECTION}/v1/section.pdf,${SHOP}/${SECTION}/v1/1-800.webp`);
  const rowAt = f.log.indexOf(`service delete shop_page_sections ${SECTION}`);
  ok(publicAt >= 0 && privateAt >= 0 && rowAt > privateAt && rowAt > publicAt, `files first (${f.log.join(" | ")})`);
  ok(f.log.slice(rowAt).some((l) => l.startsWith("service sections_to_sync") && l.includes(`"p_shop_id":"${SHOP}"`)), "then the shop's pictures follow");
  const notOwner = fakes({ owner: false });
  eq((await handle(json({ action: "delete", section_id: SECTION }), notOwner.deps)).status, 403, "only the owner");
});
