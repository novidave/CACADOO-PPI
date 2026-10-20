// Unit tests of shop-files: a signed address only when the database allows the file.
// Run: npm run test:functions
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { crc32, type Deps, handle, signFile, uniqueNames, zipName, zipStream } from "./index.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}

const ID = "44444444-2222-4333-8444-555555555555";

function fake(path: string | null) {
  const log: string[] = [];
  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      log.push(`${name} ${JSON.stringify(args)}`);
      return Promise.resolve({ data: path, error: null });
    },
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: (p: string, seconds: number) => {
          log.push(`sign ${bucket} ${p} ${seconds}`);
          return Promise.resolve({ data: { signedUrl: `https://project.supabase.co/storage/v1/object/sign/${p}?token=t` }, error: null });
        },
      }),
    },
  };
  return { db: db as unknown as SupabaseClient, log };
}

const request = (body: Record<string, unknown>) =>
  new Request("http://localhost/shop-files", { method: "POST", body: JSON.stringify(body) });

Deno.test("A file the database allows: a 10-minute signed address", async () => {
  const { db, log } = fake("shop/pictures/x.webp");
  const response = await signFile(request({ slug: "potraviny-centrum", kind: "picture", id: ID, token: "T".repeat(40) }), db);
  eq([response.status, await response.json()], [200, {
    url: "https://project.supabase.co/storage/v1/object/sign/shop/pictures/x.webp?token=t",
    expires_in: 600,
  }], "signed");
  eq(log, [
    `shop_file_path {"p_slug":"potraviny-centrum","p_kind":"picture","p_id":"${ID}","p_session_token":"${"T".repeat(40)}"}`,
    "sign shop-docs shop/pictures/x.webp 600",
  ], "the database decides, then storage signs");
});

Deno.test("A private file without a valid session, or anything else not allowed: 404 and nothing signed", async () => {
  const { db, log } = fake(null);
  const response = await signFile(request({ slug: "potraviny-centrum", kind: "document", id: ID, token: null }), db);
  eq(response.status, 404, "refused");
  eq(log.some((l) => l.startsWith("sign")), false, "nothing signed");
});

Deno.test("Bad requests never reach the database", async () => {
  const { db, log } = fake("x");
  for (const body of [
    { slug: "Potraviny Centrum", kind: "picture", id: ID },
    { slug: "potraviny-centrum", kind: "stock", id: ID },
    { slug: "potraviny-centrum", kind: "picture", id: "1 or 1=1" },
  ]) {
    eq((await signFile(request(body), db)).status, 400, JSON.stringify(body));
  }
  eq(log, [], "no calls");
  const long = fake(null);
  await signFile(request({ slug: "a", kind: "picture", id: ID, token: "x".repeat(500) }), long.db);
  eq(long.log[0].includes('"p_session_token":null'), true, "an over-long token counts as none");
});

// ---------------------------------------------------------------- update 24: viewer, downloads, ZIP


const DOC = "11111111-2222-4333-8444-555555555555";
const FOLDER = "66666666-2222-4333-8444-555555555555";
const TOKEN = "T".repeat(40);
const TICKET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789ABCDEFGHJ";

interface World {
  rpc?: Record<string, (args: Record<string, unknown>) => unknown>;
  files?: Record<string, Uint8Array>;
}

function fakes(world: World = {}) {
  const log: string[] = [];
  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      log.push(`${name} ${JSON.stringify(args)}`);
      return Promise.resolve({ data: world.rpc?.[name]?.(args) ?? null, error: null });
    },
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: (p: string, seconds: number, options?: { download?: string }) => {
          log.push(`sign ${bucket} ${p} ${seconds}${options?.download ? ` download=${options.download}` : ""}`);
          return Promise.resolve({ data: { signedUrl: `https://p.supabase.co/sign/${p}${options?.download ? "?download" : ""}` }, error: null });
        },
        download: (p: string) => {
          log.push(`read ${bucket} ${p}`);
          const bytes = world.files?.[p];
          return Promise.resolve(bytes ? { data: new Blob([bytes as BlobPart]), error: null } : { data: null, error: { message: "missing" } });
        },
      }),
    },
  };
  const deps: Deps = { db: db as unknown as SupabaseClient, selfUrl: "https://p.supabase.co/functions/v1/shop-files", now: () => new Date("2026-10-10T12:34:56Z") };
  return { deps, log };
}

const post = (deps: Deps, body: Record<string, unknown>) =>
  handle(new Request("http://localhost/shop-files", { method: "POST", body: JSON.stringify(body) }), deps).then(async (r) => [r.status, await r.json()] as const);

const viewData = {
  name: "Cenník VIP",
  can_download: false,
  shop: { name: "Cacaduu Paint shop", timezone: "Europe/Bratislava" },
  pages: [
    { page: 1, path: "s/d/pages/1-a.webp", width: 1100, height: 1568 },
    { page: 2, path: "s/d/pages/2-b.webp", width: 1100, height: 1568 },
  ],
};

Deno.test("Viewer: the page list (one opening counted), then one page's 10-minute address; never the original", async () => {
  const { deps, log } = fakes({ rpc: { shop_view_file: () => viewData } });
  eq(await post(deps, { action: "view", slug: "potraviny-centrum", kind: "document", id: DOC, token: TOKEN, count: true }), [200, {
    name: "Cenník VIP",
    can_download: false,
    shop: viewData.shop,
    pages: [{ page: 1, width: 1100, height: 1568 }, { page: 2, width: 1100, height: 1568 }],
  }], "pages without addresses");
  eq(log, [`shop_view_file {"p_slug":"potraviny-centrum","p_kind":"document","p_id":"${DOC}","p_token":"${TOKEN}","p_count":true}`], "counted, nothing signed");
  const one = fakes({ rpc: { shop_view_file: () => viewData } });
  eq(await post(one.deps, { action: "view", slug: "potraviny-centrum", kind: "document", id: DOC, token: TOKEN, page: 2, count: true }), [200, {
    name: "Cenník VIP",
    shop: viewData.shop,
    page: 2,
    url: "https://p.supabase.co/sign/s/d/pages/2-b.webp",
    expires_in: 600,
  }], "one page");
  eq(one.log.some((l) => l.includes('"p_count":true')), false, "a page is not another opening");
  eq(one.log.at(-1), "sign shop-docs s/d/pages/2-b.webp 600", "10 minutes, no download");
  eq((await post(one.deps, { action: "view", slug: "potraviny-centrum", kind: "document", id: DOC, token: TOKEN, page: 9 }))[0], 404, "no such page");
  eq((await post(one.deps, { action: "view", slug: "potraviny-centrum", kind: "document", id: DOC, token: TOKEN, page: "1;x" }))[0], 400, "bad page");
  const none = fakes();
  eq((await post(none.deps, { action: "view", slug: "potraviny-centrum", kind: "document", id: DOC, token: null }))[0], 404, "no key, no viewer");
});

Deno.test("Download: only what the database allows, as a download with its name, at most 20 per session", async () => {
  const { deps, log } = fakes({ rpc: { shop_download_file: () => ({ status: "ok", path: "s/docs/x.pdf", name: "Cenník: VIP.pdf" }) } });
  eq(await post(deps, { action: "download", slug: "potraviny-centrum", kind: "document", id: DOC, token: TOKEN }), [200, {
    url: "https://p.supabase.co/sign/s/docs/x.pdf?download",
    expires_in: 600,
  }], "signed");
  eq(log.at(-1), "sign shop-docs s/docs/x.pdf 600 download=Cenník_ VIP.pdf", "Content-Disposition: attachment with a safe name");
  const limit = fakes({ rpc: { shop_download_file: () => ({ status: "limit" }) } });
  eq(await post(limit.deps, { action: "download", slug: "potraviny-centrum", kind: "document", id: DOC, token: TOKEN }), [429, {
    error: "limit",
    message: "At most 20 downloads per unlocked session",
  }], "the 21st");
  eq(limit.log.some((l) => l.startsWith("sign")), false, "nothing signed");
  const view = fakes({ rpc: { shop_download_file: () => ({ status: "not_found" }) } });
  eq((await post(view.deps, { action: "download", slug: "potraviny-centrum", kind: "document", id: DOC, token: TOKEN }))[0], 404, "view only");
});

Deno.test("ZIP: a single-use link of this function; empty, too big and the limit are refused", async () => {
  const { deps, log } = fakes({ rpc: { shop_zip_ticket: () => ({ status: "ok", ticket: TICKET }) } });
  eq(await post(deps, { action: "zip", slug: "potraviny-centrum", folder_id: FOLDER, token: TOKEN }), [200, {
    url: `https://p.supabase.co/functions/v1/shop-files?zip=${TICKET}`,
    expires_in: 600,
  }], "a link");
  eq(log, [`shop_zip_ticket {"p_slug":"potraviny-centrum","p_folder_id":"${FOLDER}","p_token":"${TOKEN}"}`], "the database decides");
  for (const [status, code] of [["empty", 404], ["too_big", 413], ["limit", 429], ["not_found", 404]] as const) {
    const f = fakes({ rpc: { shop_zip_ticket: () => ({ status }) } });
    eq((await post(f.deps, { action: "zip", slug: "potraviny-centrum", folder_id: FOLDER, token: TOKEN }))[0], code, status);
  }
  eq((await post(deps, { action: "zip", slug: "potraviny-centrum", folder_id: "x", token: TOKEN }))[0], 400, "bad folder");
});

/** Reads a stored ZIP back from its central directory (an independent reader). */
function readZip(zip: Uint8Array): { name: string; data: Uint8Array; crc: number; utf8: boolean }[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  if (v.getUint32(end, true) !== 0x06054b50) throw new Error("no end record");
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error("bad central record");
    const flags = v.getUint16(at + 8, true);
    const crc = v.getUint32(at + 16, true);
    const size = v.getUint32(at + 24, true);
    const nameLength = v.getUint16(at + 28, true);
    const local = v.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
    if (v.getUint32(local, true) !== 0x04034b50 || v.getUint16(local + 8, true) !== 0) throw new Error("bad local header");
    const start = local + 30 + v.getUint16(local + 26, true);
    out.push({ name, data: zip.slice(start, start + size), crc, utf8: (flags & 0x0800) !== 0 });
    at += 46 + nameLength;
  }
  return out;
}

Deno.test("ZIP: CRC-32 check value; safe and unique names", () => {
  eq(crc32(new TextEncoder().encode("123456789")).toString(16), "cbf43926", "the standard check value");
  eq(zipName('../a/b:c*?"<>|.pdf'), ".._a_b_c______.pdf".replace(/^\.+/, ""), "never a path");
  eq(uniqueNames(["Cenník.pdf", "cenník.pdf", "Cenník.pdf", "README"]), ["Cenník.pdf", "cenník (2).pdf", "Cenník (3).pdf", "README"], "unique");
});

Deno.test("ZIP: streamed from storage, only the ticket's files, stored with UTF-8 names; a used ticket gets nothing", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.7 cenník");
  const pic = new Uint8Array(200_000).map((_, i) => (i * 7) & 255);
  const { deps, log } = fakes({
    rpc: {
      shop_zip_take: () => ({ folder: "VIP: Veľkoobchod", files: [{ path: "s/docs/a.pdf", name: "Cenník VIP.pdf" }, { path: "s/pictures/b.webp", name: "Vzorkovník.webp" }] }),
    },
    files: { "s/docs/a.pdf": pdf, "s/pictures/b.webp": pic },
  });
  const response = await handle(new Request(`http://localhost/shop-files?zip=${TICKET}`), deps);
  eq([response.status, response.headers.get("content-type")], [200, "application/zip"], "a ZIP");
  eq(response.headers.get("content-disposition"), `attachment; filename="VIP_ Velkoobchod.zip"; filename*=UTF-8''${encodeURIComponent("VIP_ Veľkoobchod.zip")}`, "a download with the folder's name");
  const entries = readZip(new Uint8Array(await response.arrayBuffer()));
  eq(entries.map((e) => [e.name, e.data.length, e.utf8]), [["Cenník VIP.pdf", pdf.length, true], ["Vzorkovník.webp", pic.length, true]], "both files, as they are");
  eq(entries.every((e) => e.crc === crc32(e.data)), true, "checksums");
  eq(entries[1].data, pic, "the picture unchanged");
  eq(log.filter((l) => l.startsWith("read")), ["read shop-docs s/docs/a.pdf", "read shop-docs s/pictures/b.webp"], "only the ticket's files");
  const used = fakes();
  eq((await handle(new Request(`http://localhost/shop-files?zip=${TICKET}`), used.deps)).status, 404, "used or expired");
  eq((await handle(new Request("http://localhost/shop-files?zip=../../x"), used.deps)).status, 404, "a made-up ticket");
  eq(used.log.filter((l) => l.startsWith("shop_zip_take")).length, 1, "a malformed ticket never reaches the database");
});

Deno.test("ZIP: a stream of many files keeps only one in memory and ends with a valid directory", async () => {
  const files = Array.from({ length: 30 }, (_, i) => new Uint8Array(1000 + i).fill(i));
  let reads = 0;
  const stream = zipStream(files.map((_, i) => `f${i}.bin`), (i) => {
    reads++;
    return Promise.resolve(files[i]);
  }, new Date("2026-10-10T12:00:00Z"));
  const zip = new Uint8Array(await new Response(stream).arrayBuffer());
  const entries = readZip(zip);
  eq([entries.length, reads], [30, 30], "every file once");
  eq(entries.every((e, i) => e.data.length === 1000 + i && e.data.every((b) => b === i)), true, "contents");
});

// ---------------------------------------------------------------- update 28: page sections

Deno.test("Section PDF: only when the database allows it, from the sections' bucket, as a download", async () => {
  const SECTION = "77777777-2222-4333-8444-555555555555";
  const { deps, log } = fakes({ rpc: { shop_section_pdf: () => [{ path: "s/sec/v2/section.pdf", title: "Novinky: október" }] } });
  eq(await post(deps, { action: "section_pdf", slug: "potraviny-centrum", section_id: SECTION }), [200, {
    url: "https://p.supabase.co/sign/s/sec/v2/section.pdf?download",
    expires_in: 600,
  }], "signed for 10 minutes");
  eq(log.at(-1), "sign shop-sections s/sec/v2/section.pdf 600 download=Novinky_ október.pdf", "the cleaned PDF, as a download");
  const off = fakes({ rpc: { shop_section_pdf: () => [] } });
  eq((await post(off.deps, { action: "section_pdf", slug: "potraviny-centrum", section_id: SECTION }))[0], 404, "download off, hidden or expired");
  eq(off.log.some((l) => l.startsWith("sign")), false, "nothing signed");
  const bad = fakes();
  eq((await post(bad.deps, { action: "section_pdf", slug: "Potraviny Centrum", section_id: "x" }))[0], 400, "bad request");
  eq(bad.log, [], "never reaches the database");
});
