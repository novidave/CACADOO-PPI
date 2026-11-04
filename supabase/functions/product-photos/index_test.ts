// Unit tests of product-photos against an in-memory database, bucket and web: public https addresses only (private
// and local addresses refused, every forward checked, at most 3), 15 MB, image types; the pictures checked by their
// bytes; the photo's own data removed; EXIF orientation; the owner's upload replaces the old photo (the old files
// deleted) and only for their own products; "Odstrániť fotku"; a bulk file's two steps per row and its report.
// Run: npm run test:functions
import {
  BUCKET,
  type Deps,
  download,
  handle,
  isPrivateIp,
  jpegOrientation,
  MAX_SOURCE_BYTES,
  orient,
  RowProblem,
  safeUrl,
  shrink,
  sniffPicture,
  stripMetadata,
  tick,
  workStep,
} from "./index.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}

function assert(condition: unknown, label: string) {
  if (!condition) throw new Error(label);
}

async function rejects(p: Promise<unknown>, status: string, label: string) {
  try {
    await p;
  } catch (e) {
    if (e instanceof RowProblem && e.status === status) return;
    throw new Error(`${label}: expected ${status}, got ${e instanceof RowProblem ? e.status : String(e)}`);
  }
  throw new Error(`${label}: no error`);
}

const SHOP = "11111111-2222-4333-8444-555555555555";
const ITEM = "22222222-2222-4333-8444-555555555555";
const OTHER_ITEM = "99999999-2222-4333-8444-555555555555";
const JOB = "33333333-2222-4333-8444-555555555555";
const SERVICE_KEY = "service-role-key-0123456789abcdefghijklmnop";
const OWNER_TOKEN = "owner-token-0123456789";

/** The first bytes of a WebP (VP8X) of w × h. */
function webp(w: number, h: number, extra: Uint8Array[] = []): Uint8Array {
  const head = new Uint8Array(30);
  head.set([0x52, 0x49, 0x46, 0x46], 0);
  head.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 8);
  head[16] = 10; // VP8X chunk size
  head[20] = 0x0c; // flags: EXIF + XMP announced
  const W = w - 1;
  const H = h - 1;
  head.set([W & 0xff, (W >> 8) & 0xff, (W >> 16) & 0xff, H & 0xff, (H >> 8) & 0xff, (H >> 16) & 0xff], 24);
  const out = new Uint8Array(30 + extra.reduce((n, e) => n + e.length, 0));
  out.set(head);
  let at = 30;
  for (const e of extra) {
    out.set(e, at);
    at += e.length;
  }
  const size = out.length - 8;
  out.set([size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >> 24) & 0xff], 4);
  return out;
}

/** A RIFF chunk. */
function chunk(id: string, data: number[]): Uint8Array {
  const out = new Uint8Array(8 + data.length + (data.length % 2));
  out.set([...id].map((c) => c.charCodeAt(0)), 0);
  out.set([data.length & 0xff, (data.length >> 8) & 0xff, 0, 0], 4);
  out.set(data, 8);
  return out;
}

/** A JPEG of w × h with an EXIF segment saying `orientation` (little-endian TIFF), a comment and then the frame. */
function jpeg(w: number, h: number, orientation = 1): Uint8Array {
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0];
  const app1 = [0xff, 0xe1, ((exif.length + 2) >> 8) & 0xff, (exif.length + 2) & 0xff, ...exif];
  const com = [0xff, 0xfe, 0, 6, 0x47, 0x50, 0x53, 0x21]; // "GPS!"
  const sof = [0xff, 0xc0, 0, 17, 8, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, ...app1, ...com, ...sof, 0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]);
}

function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  b.set([(w >>> 24) & 0xff, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff, (h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff], 16);
  return b;
}

// ---------------------------------------------------------------- addresses

Deno.test("Addresses: public https only — no IP address, local name, password or other port", () => {
  assert(safeUrl("https://www.obchod.sk/img/a.jpg"), "a public address");
  assert(safeUrl("https://cdn.obchod.sk:443/a.jpg"), "port 443");
  for (const bad of [
    "http://www.obchod.sk/a.jpg",
    "https://127.0.0.1/a.jpg",
    "https://10.0.0.5/a.jpg",
    "https://[::1]/a.jpg",
    "https://localhost/a.jpg",
    "https://printer.local/a.jpg",
    "https://intranet/a.jpg",
    "https://user:pass@obchod.sk/a.jpg",
    "https://obchod.sk:8443/a.jpg",
    "ftp://obchod.sk/a.jpg",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://metadata.google.internal/x",
    "nonsense",
  ]) {
    assert(!safeUrl(bad), `refused: ${bad}`);
  }
});

Deno.test("Private, local and special IP addresses are recognised (v4 and v6)", () => {
  for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2001:db8::1", "999.1.1.1"]) {
    assert(isPrivateIp(ip), `private: ${ip}`);
  }
  for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2a00:1450:4001:80b::200e", "2606:4700::6810:84e5"]) {
    assert(!isPrivateIp(ip), `public: ${ip}`);
  }
});

function web(pages: Record<string, () => Response>, dns: Record<string, string[]>): Pick<Deps, "fetch" | "resolve"> & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    resolve: async (host) => dns[host] ?? [],
    fetch: (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      asked.push(url);
      const page = pages[url];
      return page ? page() : new Response("not found", { status: 404 });
    }) as typeof fetch,
  };
}

const PUBLIC = ["93.184.216.34"];
/** Bytes as a response body. */
const body = (b: Uint8Array) => new Blob([b.slice().buffer as ArrayBuffer]);

Deno.test("Downloads: forwards checked, private hosts refused, at most 3 forwards, 15 MB, image types only", async () => {
  const image = jpeg(10, 10);
  const ok = web(
    {
      "https://shop.example.com/a.jpg": () => new Response(null, { status: 302, headers: { location: "/b.jpg" } }),
      "https://shop.example.com/b.jpg": () => new Response(body(image), { headers: { "content-type": "image/jpeg" } }),
    },
    { "shop.example.com": PUBLIC },
  );
  // ".example" names are refused by safeUrl; the tests use example.com (a real public suffix)
  eq((await download("https://shop.example.com/a.jpg", ok)).length, image.length, "a forward on the same host");
  // a name that points inside, or a forward to one
  await rejects(download("https://inside.example.com/a.jpg", web({}, { "inside.example.com": ["10.0.0.7"] })), "bad_url", "a private address");
  await rejects(download("https://both.example.com/a.jpg", web({}, { "both.example.com": ["93.184.216.34", "127.0.0.1"] })), "bad_url", "one private address among public ones");
  await rejects(
    download("https://shop.example.com/a.jpg", web({ "https://shop.example.com/a.jpg": () => new Response(null, { status: 301, headers: { location: "http://shop.example.com/a.jpg" } }) }, { "shop.example.com": PUBLIC })),
    "bad_url",
    "a forward to http",
  );
  await rejects(
    download("https://shop.example.com/a.jpg", web({ "https://shop.example.com/a.jpg": () => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" } }) }, { "shop.example.com": PUBLIC })),
    "bad_url",
    "a forward to the cloud's metadata address",
  );
  const loop = web({ "https://shop.example.com/a.jpg": () => new Response(null, { status: 302, headers: { location: "https://shop.example.com/a.jpg" } }) }, { "shop.example.com": PUBLIC });
  await rejects(download("https://shop.example.com/a.jpg", loop), "failed", "forwards for ever");
  eq(loop.asked.length, 4, "the first request and 3 forwards, no more");
  await rejects(download("https://none.example.com/a.jpg", web({}, {})), "failed", "a name without addresses");
  await rejects(
    download("https://shop.example.com/a.jpg", web({ "https://shop.example.com/a.jpg": () => new Response("<html>", { headers: { "content-type": "text/html" } }) }, { "shop.example.com": PUBLIC })),
    "bad_image",
    "a web page instead of a picture",
  );
  await rejects(
    download("https://shop.example.com/a.jpg", web({ "https://shop.example.com/a.jpg": () => new Response("x", { headers: { "content-type": "image/jpeg", "content-length": String(MAX_SOURCE_BYTES + 1) } }) }, { "shop.example.com": PUBLIC })),
    "too_big",
    "announced over 15 MB",
  );
  const big = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < 16; i++) c.enqueue(new Uint8Array(1024 * 1024));
      c.close();
    },
  });
  await rejects(
    download("https://shop.example.com/a.jpg", web({ "https://shop.example.com/a.jpg": () => new Response(big, { headers: { "content-type": "image/jpeg" } }) }, { "shop.example.com": PUBLIC })),
    "too_big",
    "more than 15 MB arrives",
  );
  await rejects(
    download("https://shop.example.com/a.jpg", web({ "https://shop.example.com/a.jpg": () => new Response("gone", { status: 404 }) }, { "shop.example.com": PUBLIC })),
    "failed",
    "not found",
  );
});

// ---------------------------------------------------------------- pictures

Deno.test("Pictures by their bytes: WebP, JPEG and PNG with their size, HEIC known, anything else refused", () => {
  eq(sniffPicture(webp(1600, 1200)), { type: "webp", width: 1600, height: 1200 }, "webp");
  eq(sniffPicture(jpeg(1024, 768)), { type: "jpg", width: 1024, height: 768 }, "jpeg after EXIF and a comment");
  eq(sniffPicture(png(640, 480)), { type: "png", width: 640, height: 480 }, "png");
  const heic = new Uint8Array(16);
  heic.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
  eq(sniffPicture(heic)?.type, "heic", "heic");
  eq(sniffPicture(new TextEncoder().encode("<html><body>not a picture")), null, "html");
});

Deno.test("EXIF orientation is read; the picture is turned upright; smaller never larger", () => {
  eq(jpegOrientation(jpeg(10, 10, 6)), 6, "turned 90°");
  eq(jpegOrientation(jpeg(10, 10)), 1, "upright");
  eq(jpegOrientation(webp(10, 10)), 1, "not a JPEG");
  // a 3 × 2 picture with distinct pixels, turned (6 = 90° clockwise): 2 × 3, the first row becomes the last column
  const px = new Uint8ClampedArray(3 * 2 * 4);
  for (let i = 0; i < 6; i++) px[i * 4] = i + 1;
  const turned = orient({ data: px, width: 3, height: 2 }, 6);
  eq([turned.width, turned.height], [2, 3], "turned size");
  eq([turned.data[0], turned.data[4]], [4, 1], "the left column of the bottom row comes first");
  eq(orient({ data: px, width: 3, height: 2 }, 1).width, 3, "upright stays");
  const small = shrink({ data: new Uint8ClampedArray(8 * 4 * 4).fill(200), width: 8, height: 4 }, 4);
  eq([small.width, small.height, small.data[0]], [4, 2, 200], "half the size, the same colour");
  eq(shrink({ data: px, width: 3, height: 2 }, 10).width, 3, "never larger");
});

Deno.test("The photo's own data go: EXIF, XMP and comments out of a JPEG, EXIF and XMP chunks out of a WebP", () => {
  const j = stripMetadata(jpeg(20, 10, 6));
  const text = String.fromCharCode(...j);
  assert(!text.includes("Exif") && !text.includes("GPS!"), "no EXIF, no comment");
  eq(sniffPicture(j), { type: "jpg", width: 20, height: 10 }, "still the same JPEG");
  const w = stripMetadata(webp(40, 30, [chunk("EXIF", [1, 2, 3, 4]), chunk("XMP ", [5, 6]), chunk("ALPH", [7])]));
  const wt = String.fromCharCode(...w);
  assert(!wt.includes("EXIF") && !wt.includes("XMP ") && wt.includes("ALPH"), "only the metadata chunks go");
  eq(w[20] & 0x0c, 0, "the VP8X flags no longer announce them");
  eq((w[4] | (w[5] << 8) | (w[6] << 16) | (w[7] << 24)) >>> 0, w.length - 8, "the RIFF size is right");
  eq(sniffPicture(w), { type: "webp", width: 40, height: 30 }, "still the same WebP");
});

// ---------------------------------------------------------------- the owner's upload and removal

interface Fake {
  deps: Deps;
  files: Map<string, Uint8Array>;
  removed: string[];
  photos: Map<string, { large: string; small: string; width: number; height: number }>;
  rows: { n: number; url: string; status: string; detail?: string | null; part_path?: string | null; part_width?: number; part_height?: number; tries: number }[];
  chained: unknown[];
  refreshed: string[];
}

function fake(web: Pick<Deps, "fetch" | "resolve"> = { fetch: fetch, resolve: async () => PUBLIC }): Fake {
  const files = new Map<string, Uint8Array>();
  const removed: string[] = [];
  const photos = new Map<string, { large: string; small: string; width: number; height: number }>();
  const rows: Fake["rows"] = [];
  const chained: unknown[] = [];
  const refreshed: string[] = [];
  let names = 0;
  const set = (item: string, large: string, small: string, width: number, height: number) => {
    const old = photos.get(item);
    photos.set(item, { large, small, width, height });
    return { old: old ? [old.large, old.small].filter((p) => p !== large && p !== small) : [], slug: "obchod" };
  };
  const db = {
    rpc: async (name: string, a: Record<string, unknown> = {}) => {
      if (name === "product_photo_set") return { data: set(String(a.p_item_id), String(a.p_large), String(a.p_small), Number(a.p_width), Number(a.p_height)), error: null };
      if (name === "product_photo_remove") {
        const old = photos.get(String(a.p_item_id));
        photos.delete(String(a.p_item_id));
        return { data: { old: old ? [old.large, old.small] : [], slug: "obchod" }, error: null };
      }
      if (name === "product_photo_claim") {
        const row = rows.find((r) => r.status === "pending");
        if (!row) return { data: null, error: null };
        row.status = "working";
        row.tries++;
        return { data: { job_id: JOB, n: row.n, url: row.url, item_id: ITEM, shop_id: SHOP, part_path: row.part_path ?? null, part_width: row.part_width ?? null, part_height: row.part_height ?? null }, error: null };
      }
      if (name === "product_photo_part") {
        const row = rows.find((r) => r.n === a.p_n)!;
        Object.assign(row, { status: "pending", part_path: a.p_path, part_width: a.p_width, part_height: a.p_height, tries: 0 });
        return { data: null, error: null };
      }
      if (name === "product_photo_row_done") {
        const row = rows.find((r) => r.n === a.p_n)!;
        let old: string[] = [];
        if (a.p_status === "done") old = set(ITEM, String(a.p_large), String(a.p_small), Number(a.p_width), Number(a.p_height)).old;
        Object.assign(row, { status: a.p_status, detail: a.p_detail, part_path: null });
        const finished = !rows.some((r) => r.status === "pending" || r.status === "working");
        return { data: { old, slug: "obchod", finished }, error: null };
      }
      if (name === "product_photo_due") return { data: rows.some((r) => r.status === "pending"), error: null };
      if (name === "product_photo_tidy") return { data: ["old/orphan-1600.webp"], error: null };
      if (name === "assistant_cron_ok") return { data: a.p_secret === "cron-secret-0123456789abcdef0123456789", error: null };
      return { data: null, error: { message: `unknown ${name}` } };
    },
  };
  const asCaller = (authorization: string) => ({
    auth: { getUser: async (token: string) => ({ data: { user: token === OWNER_TOKEN && authorization.endsWith(token) ? { id: "owner" } : null } }) },
    rpc: async (name: string, a: Record<string, unknown> = {}) => {
      if (name === "owner_product_photo_item" && a.p_item_id === ITEM) return { data: { item_id: ITEM, shop_id: SHOP, slug: "obchod" }, error: null };
      return { data: null, error: { message: "not_member" } };
    },
    from: () => ({
      select: () => ({
        eq: (_c: string, v: string) => ({ maybeSingle: async () => ({ data: v === JOB ? { id: JOB, status: "running" } : null }) }),
      }),
    }),
  });
  const deps = {
    db,
    asCaller,
    serviceKey: SERVICE_KEY,
    storage: {
      put: async (path: string, bytes: Uint8Array) => void files.set(path, bytes),
      get: async (path: string) => files.get(path) ?? null,
      remove: async (paths: string[]) => {
        removed.push(...paths);
        paths.forEach((p) => files.delete(p));
      },
    },
    // a stand-in for the WebAssembly codecs: a picture's own width, at most `width`
    images: {
      webp: async (bytes: Uint8Array, width: number) => {
        const info = sniffPicture(bytes);
        if (!info || info.type === "heic") throw new RowProblem("bad_image", info?.type ?? "not a picture");
        const w = Math.min(width, info.width);
        const h = Math.round((info.height * w) / info.width);
        return { bytes: webp(w, h), width: w, height: h };
      },
    },
    fetch: web.fetch,
    resolve: web.resolve,
    chain: async (body: unknown) => void chained.push(body),
    background: (task: Promise<unknown>) => void task,
    refresh: async (slug: string) => void refreshed.push(slug),
    name: () => `f${++names}`,
  } as unknown as Deps;
  return { deps, files, removed, photos, rows, chained, refreshed };
}

function uploadRequest(item: string, large: Uint8Array | null, small: Uint8Array | null, token = OWNER_TOKEN): Request {
  const form = new FormData();
  form.set("item_id", item);
  if (large) form.set("large", new Blob([large.slice().buffer as ArrayBuffer]));
  if (small) form.set("small", new Blob([small.slice().buffer as ArrayBuffer]));
  return new Request("https://x.supabase.co/functions/v1/product-photos?action=upload", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://x.supabase.co/functions/v1/product-photos", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

Deno.test("The owner's upload: checked by its bytes, stored, and a new photo replaces the old one (old files deleted)", async () => {
  const f = fake();
  let res = await handle(uploadRequest(ITEM, webp(1600, 1200), webp(800, 600)), f.deps);
  eq(res.status, 200, "uploaded");
  const first = f.photos.get(ITEM)!;
  assert(first.large.startsWith(`${SHOP}/${ITEM}/`) && first.large.endsWith("-1600.webp") && first.small.endsWith("-800.webp"), `paths: ${JSON.stringify(first)}`);
  assert(f.files.has(first.large) && f.files.has(first.small), "both files in the bucket");
  eq(f.refreshed, ["obchod"], "the product page refreshed");
  res = await handle(uploadRequest(ITEM, webp(1000, 1000), webp(800, 800)), f.deps);
  eq(res.status, 200, "replaced");
  eq(f.removed.sort(), [first.large, first.small].sort(), "the old files deleted");
  // a small photo has one size
  res = await handle(uploadRequest(ITEM, webp(700, 500), null), f.deps);
  eq(res.status, 200, "one size");
  eq(f.photos.get(ITEM)!.small, f.photos.get(ITEM)!.large, "the same file for both sizes");
  // the photo's own data go before storing
  res = await handle(uploadRequest(ITEM, jpeg(1200, 900, 1), jpeg(800, 600, 1)), f.deps);
  eq(res.status, 200, "a JPEG (Safari)");
  const stored = f.files.get(f.photos.get(ITEM)!.large)!;
  assert(!String.fromCharCode(...stored).includes("Exif") && f.photos.get(ITEM)!.large.endsWith(".jpg"), "stored without EXIF, as .jpg");
});

Deno.test("The owner's upload refuses: no login, another shop's product, too wide, not a picture, missing 800 px", async () => {
  const f = fake();
  eq((await handle(uploadRequest(ITEM, webp(1600, 1200), webp(800, 600), "stranger"), f.deps)).status, 401, "no login");
  eq((await handle(uploadRequest(OTHER_ITEM, webp(1600, 1200), webp(800, 600)), f.deps)).status, 403, "another shop's product");
  eq((await handle(uploadRequest(ITEM, webp(2400, 1200), webp(800, 400)), f.deps)).status, 400, "wider than 1600");
  eq((await handle(uploadRequest(ITEM, webp(1600, 1200), webp(1200, 900)), f.deps)).status, 400, "the small one wider than 800");
  eq((await handle(uploadRequest(ITEM, new TextEncoder().encode("<svg onload=alert(1)>"), null), f.deps)).status, 400, "not a picture");
  eq((await handle(uploadRequest(ITEM, png(1000, 800), null), f.deps)).status, 400, "the browser sends WebP or JPEG only");
  eq((await handle(uploadRequest(ITEM, webp(1600, 1200), null), f.deps)).status, 400, "a wide photo needs its 800 px copy");
  eq(f.files.size, 0, "nothing stored");
});

Deno.test("Odstrániť fotku: the row and both files go; only the owner", async () => {
  const f = fake();
  await handle(uploadRequest(ITEM, webp(1600, 1200), webp(800, 600)), f.deps);
  const photo = f.photos.get(ITEM)!;
  eq((await handle(json({ action: "remove", item_id: OTHER_ITEM }, { Authorization: `Bearer ${OWNER_TOKEN}` }), f.deps)).status, 403, "another shop's product");
  eq((await handle(json({ action: "remove", item_id: ITEM }), f.deps)).status, 401, "no login");
  eq((await handle(json({ action: "remove", item_id: ITEM }, { Authorization: `Bearer ${OWNER_TOKEN}` }), f.deps)).status, 200, "removed");
  assert(!f.photos.has(ITEM) && f.removed.includes(photo.large) && f.removed.includes(photo.small), "row and files gone");
});

// ---------------------------------------------------------------- bulk

Deno.test("A bulk file: each row in two steps (1600 px, then 800 px), replaces the photo, bad rows reported, never stuck", async () => {
  const w = web(
    {
      "https://shop.example.com/a.jpg": () => new Response(body(jpeg(3000, 2000)), { headers: { "content-type": "image/jpeg" } }),
      "https://shop.example.com/small.png": () => new Response(body(png(600, 400)), { headers: { "content-type": "image/png" } }),
      "https://shop.example.com/page.html": () => new Response("<html>", { headers: { "content-type": "text/html" } }),
    },
    { "shop.example.com": PUBLIC, "inside.example.com": ["192.168.0.10"] },
  );
  const f = fake(w);
  f.rows.push(
    { n: 1, url: "https://shop.example.com/a.jpg", status: "pending", tries: 0 },
    { n: 2, url: "https://shop.example.com/page.html", status: "pending", tries: 0 },
    { n: 3, url: "https://inside.example.com/x.jpg", status: "pending", tries: 0 },
    { n: 4, url: "https://shop.example.com/small.png", status: "pending", tries: 0 },
  );
  // the owner starts it (their own job only)
  eq((await handle(json({ action: "kick", job_id: JOB }, { Authorization: `Bearer ${OWNER_TOKEN}` }), f.deps)).status, 200, "kick");
  eq(f.chained, [{ action: "work" }], "the first step starts");
  eq((await handle(json({ action: "kick", job_id: "88888888-2222-4333-8444-555555555555" }, { Authorization: `Bearer ${OWNER_TOKEN}` }), f.deps)).status, 403, "another shop's job");
  eq((await handle(json({ action: "work" }, { Authorization: "Bearer nope" }), f.deps)).status, 401, "work only from itself");
  // row 1: step 1 stores the 1600 px picture and waits; step 2 makes the 800 px one and replaces the photo
  assert(await workStep(f.deps), "step 1");
  eq(f.rows[0].status, "pending", "waits for its 800 px step");
  assert(f.rows[0].part_path?.endsWith("-1600.webp") && f.rows[0].part_width === 1600, "the 1600 px part");
  assert(await workStep(f.deps), "step 2");
  eq(f.rows[0].status, "done", "row 1 done");
  eq([f.photos.get(ITEM)!.width, f.photos.get(ITEM)!.small.endsWith("-800.webp")], [1600, true], "the photo replaced");
  // a web page, a private host: reported, nothing stored
  assert(await workStep(f.deps), "row 2");
  eq([f.rows[1].status, f.rows[1].detail], ["bad_image", "content-type text/html"], "row 2");
  assert(await workStep(f.deps), "row 3");
  eq([f.rows[2].status, f.rows[2].detail], ["bad_url", "private address"], "row 3");
  // a small PNG: one size, done in one step
  assert(await workStep(f.deps), "row 4");
  eq(f.rows[3].status, "done", "row 4 done at once");
  eq(f.photos.get(ITEM)!.small, f.photos.get(ITEM)!.large, "one file for both sizes");
  assert(!(await workStep(f.deps)), "nothing waits");
  eq(f.refreshed.includes("obchod"), true, "the shop's pages refreshed when the file was done");
  // the addresses asked: never the private one
  assert(!w.asked.some((u) => u.includes("inside.example.com")), "no request to the private host");
});

Deno.test("The 5-minute job: a stopped file goes on, unused files go; only with the job's secret", async () => {
  const f = fake();
  f.rows.push({ n: 1, url: "https://shop.example.com/a.jpg", status: "pending", tries: 0 });
  const out = await tick(f.deps);
  eq(out, { resumed: true, swept: 1 }, "resumed and swept");
  eq(f.removed, ["old/orphan-1600.webp"], "the unused file deleted");
  eq((await handle(json({ action: "tick" }, { "x-ppi-cron": "wrong-secret-000000000000000000000" }), f.deps)).status, 401, "a wrong secret");
  eq((await handle(json({ action: "tick" }, { "x-ppi-cron": "cron-secret-0123456789abcdef0123456789" }), f.deps)).status, 200, "the job's secret");
  eq(BUCKET, "product-photos", "the bucket");
});
