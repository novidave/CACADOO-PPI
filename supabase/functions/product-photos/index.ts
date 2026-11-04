/// <reference lib="deno.ns" />
// PPI · product-photos Edge Function (database update 78)
//
// ONE photo per product, shown only on that product's page. The pictures are WebP (JPEG where the owner's browser
// cannot write WebP), 1600 and 800 px wide, never larger than the original, without the photo's own data (place,
// camera), in the public bucket "product-photos" under random names. A new photo replaces the old one: the old files
// are deleted. One file, pasted into the Supabase editor with "Verify JWT" OFF: it checks every caller itself.
//
//   The shop's owners (their login; membership checked by the database, owner_product_photo_item):
//     POST ?action=upload   multipart: item_id, large (≤ 1600 px), small (≤ 800 px; optional for a small photo) —
//                           drawn in the owner's browser (HEIC opened there too); checked here by their bytes
//     POST {action: "remove", item_id}       "Odstrániť fotku"
//     POST {action: "kick", job_id}          a bulk file was saved (owner_product_photo_job): start its downloads
//   Itself (Authorization: Bearer <service role key>): POST {action: "work"} — one step of a bulk file: download the
//                           image (https only, public hosts only — every address and forward checked, at most 3
//                           forwards, 15 MB, 20 s, its type by its bytes: JPEG, PNG or WebP), make the 1600 px WebP;
//                           in the next call the 800 px one, then the photo is replaced. Then the next row.
//   The job (pg_cron every 5 minutes, header x-ppi-cron): tick — a bulk file whose chain broke off goes on; files
//                           nothing uses any more are deleted.
//
// Never: a picture from a private or local address, an image URL or a file in the logs (only the row's number).
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name "product-photos" → paste this file →
// Deploy, then switch OFF "Verify JWT". No new secrets (SITE_URL and REVALIDATE_SECRET, already set, refresh the
// product page at once; without them it refreshes within a minute).

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import decodeJpeg, { init as initJpegDecode } from "npm:@jsquash/jpeg@1.6.0/decode.js";
import decodePng, { init as initPngDecode } from "npm:@jsquash/png@3.1.1/decode.js";
import decodeWebp, { init as initWebpDecode } from "npm:@jsquash/webp@1.5.0/decode.js";
import encodeWebp, { init as initWebpEncode } from "npm:@jsquash/webp@1.5.0/encode.js";

export const BUCKET = "product-photos";
/** A downloaded image (a bulk file's image_url) at most. */
export const MAX_SOURCE_BYTES = 15 * 1024 * 1024;
/** A stored picture at most (the bucket's own limit too). */
export const MAX_STORED_BYTES = 5 * 1024 * 1024;
/** Larger pictures are refused before they are opened (they would not fit the function's memory and time). */
export const MAX_PIXELS = 30_000_000;
export const MAX_REDIRECTS = 3;
export const SIZES = [1600, 800] as const;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_AGENT = "CacaduuPPI-ProductPhotos/1.0 (+https://cacaduu.com)";

type Json = Record<string, unknown>;

// ---------------------------------------------------------------- answers

/** Môj obchod calls this function straight from the owner's browser: CORS on every answer (as shop-blog). */
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

function reply(status: number, data: unknown) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS },
  });
}

const failText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/[\r\n]+/g, " ").slice(0, 200);

/** Equal strings, compared in constant time. */
export function sameSecret(given: string | null, expected: string | null): boolean {
  if (!given || !expected || expected.length < 20) return false;
  const enc = new TextEncoder();
  const a = enc.encode(given);
  const b = enc.encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

/** Why a row of a bulk file did not become a photo (its status in the report, and a short reason). */
export class RowProblem extends Error {
  constructor(readonly status: "bad_url" | "bad_image" | "too_big" | "failed", readonly detail: string) {
    super(detail);
  }
}

// ---------------------------------------------------------------- pictures: what a file is

export interface Picture {
  type: "webp" | "jpg" | "png" | "heic";
  width: number;
  height: number;
}

/** The type (by the first bytes) and pixel size of a WebP, JPEG or PNG picture; HEIC without its size; else null. */
export function sniffPicture(b: Uint8Array): Picture | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    const chunk = ascii(12, 16);
    if (chunk === "VP8X") {
      return { type: "webp", width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    }
    if (chunk === "VP8L" && b[20] === 0x2f) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { type: "webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { type: "webp", width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
    }
    return null;
  }
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 4) === "PNG" && ascii(12, 16) === "IHDR") {
    const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    return { type: "png", width: u32(16), height: u32(20) };
  }
  if (b.length >= 12 && ascii(4, 8) === "ftyp" && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif)$/.test(ascii(8, 12))) {
    return { type: "heic", width: 0, height: 0 };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const length = (b[i + 2] << 8) | b[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: "jpg", width: (b[i + 7] << 8) | b[i + 8], height: (b[i + 5] << 8) | b[i + 6] };
      }
      i += 2 + length;
    }
  }
  return null;
}

/** A JPEG's EXIF orientation (1–8; 1 = upright, also when it has none). */
export function jpegOrientation(b: Uint8Array): number {
  if (!(b[0] === 0xff && b[1] === 0xd8)) return 1;
  let i = 2;
  while (i + 4 < b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    const length = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xda) break; // the picture's data begins: no EXIF before it
    if (marker === 0xe1 && String.fromCharCode(...b.subarray(i + 4, i + 10)) === "Exif\u0000\u0000") {
      const t = i + 10;
      const little = b[t] === 0x49;
      const u16 = (o: number) => (little ? b[t + o] | (b[t + o + 1] << 8) : (b[t + o] << 8) | b[t + o + 1]);
      const u32 = (o: number) => (little ? u16(o) | (u16(o + 2) << 16) : (u16(o) << 16) | u16(o + 2)) >>> 0;
      const ifd = u32(4);
      const count = u16(ifd);
      for (let e = 0; e < count; e++) {
        const at = ifd + 2 + e * 12;
        if (t + at + 10 > b.length) break;
        if (u16(at) === 0x0112) {
          const o = u16(at + 8);
          return o >= 1 && o <= 8 ? o : 1;
        }
      }
      return 1;
    }
    i += 2 + length;
  }
  return 1;
}

/**
 * The picture without its own data: a JPEG without its APP1–APP13 / APP15 segments and comments (EXIF, XMP, GPS,
 * camera; JFIF and Adobe's colour segment stay), a WebP without its EXIF and XMP chunks. The pixels are not touched.
 */
export function stripMetadata(b: Uint8Array): Uint8Array {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    const parts: Uint8Array[] = [b.subarray(0, 2)];
    let i = 2;
    while (i + 4 <= b.length && b[i] === 0xff) {
      const marker = b[i + 1];
      if (marker === 0xda) break;
      const length = (b[i + 2] << 8) | b[i + 3];
      const end = i + 2 + length;
      const drop = (marker >= 0xe1 && marker <= 0xed) || marker === 0xef || marker === 0xfe;
      if (!drop) parts.push(b.subarray(i, end));
      i = end;
    }
    parts.push(b.subarray(i));
    return concat(parts);
  }
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    const parts: Uint8Array[] = [];
    let vp8x: Uint8Array | null = null;
    let i = 12;
    while (i + 8 <= b.length) {
      const id = ascii(i, i + 4);
      const size = (b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24)) >>> 0;
      const end = Math.min(b.length, i + 8 + size + (size % 2));
      if (id === "EXIF" || id === "XMP ") {
        i = end;
        continue;
      }
      const chunk = b.slice(i, end);
      if (id === "VP8X") vp8x = chunk;
      parts.push(chunk);
      i = end;
    }
    // the VP8X flags no longer announce EXIF (bit 3) or XMP (bit 2)
    if (vp8x && vp8x.length > 8) vp8x[8] &= ~0x0c;
    const body = concat(parts);
    const out = new Uint8Array(12 + body.length);
    out.set(b.subarray(0, 12));
    out.set(body, 12);
    const size = out.length - 8;
    out[4] = size & 0xff;
    out[5] = (size >>> 8) & 0xff;
    out[6] = (size >>> 16) & 0xff;
    out[7] = (size >>> 24) & 0xff;
    return out;
  }
  return b;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- pictures: smaller, upright, WebP

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Smaller by area averaging (each new pixel = the mean of the pixels it covers); never larger. */
export function shrink(src: Pixels, width: number): Pixels {
  if (width >= src.width) return src;
  const height = Math.max(1, Math.round((src.height * width) / src.width));
  const sw = src.width;
  const sh = src.height;
  const s = src.data;
  const out = new Uint8ClampedArray(width * height * 4);
  const fx = sw / width;
  const fy = sh / height;
  const row = new Float32Array(width * 4);
  for (let y = 0; y < height; y++) {
    row.fill(0);
    const y0 = y * fy;
    const y1 = y0 + fy;
    let wsum = 0;
    for (let sy = Math.floor(y0); sy < Math.min(sh, Math.ceil(y1)); sy++) {
      const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
      wsum += wy;
      const base = sy * sw * 4;
      for (let x = 0; x < width; x++) {
        const x0 = x * fx;
        const x1 = x0 + fx;
        let r = 0, g = 0, bl = 0, a = 0, wx = 0;
        for (let sx = Math.floor(x0); sx < Math.min(sw, Math.ceil(x1)); sx++) {
          const w = Math.min(x1, sx + 1) - Math.max(x0, sx);
          const i = base + sx * 4;
          r += s[i] * w;
          g += s[i + 1] * w;
          bl += s[i + 2] * w;
          a += s[i + 3] * w;
          wx += w;
        }
        const o = x * 4;
        row[o] += (r / wx) * wy;
        row[o + 1] += (g / wx) * wy;
        row[o + 2] += (bl / wx) * wy;
        row[o + 3] += (a / wx) * wy;
      }
    }
    const ob = y * width * 4;
    for (let i = 0; i < width * 4; i++) out[ob + i] = row[i] / wsum;
  }
  return { data: out, width, height };
}

/** Upright by the EXIF orientation (2–8: mirrored and/or turned); 1 = as it is. */
export function orient(src: Pixels, orientation: number): Pixels {
  if (orientation < 2 || orientation > 8) return src;
  const { width: w, height: h, data } = src;
  const turned = orientation >= 5;
  const ow = turned ? h : w;
  const oh = turned ? w : h;
  const out = new Uint8ClampedArray(ow * oh * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number, ny: number;
      switch (orientation) {
        case 2: nx = w - 1 - x; ny = y; break;
        case 3: nx = w - 1 - x; ny = h - 1 - y; break;
        case 4: nx = x; ny = h - 1 - y; break;
        case 5: nx = y; ny = x; break;
        case 6: nx = h - 1 - y; ny = x; break;
        case 7: nx = h - 1 - y; ny = w - 1 - x; break;
        default: nx = y; ny = w - 1 - x; break; // 8
      }
      const si = (y * w + x) * 4;
      const di = (ny * ow + nx) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = data[si + 3];
    }
  }
  return { data: out, width: ow, height: oh };
}

/** Turns a picture into a WebP at most `width` px wide (injectable: the tests use a stand-in). */
export interface Images {
  webp(bytes: Uint8Array, width: number): Promise<{ bytes: Uint8Array; width: number; height: number }>;
}

let codecs: Promise<void> | null = null;

/** The WebAssembly codecs (mozjpeg, libpng, libwebp), read from their npm packages once per worker. */
function loadCodecs(): Promise<void> {
  codecs ??= (async () => {
    // The decoders expect the browser's ImageData.
    const g = globalThis as unknown as { ImageData?: unknown };
    g.ImageData ??= class {
      constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {}
    };
    const wasm = async (spec: string, file: string) => await WebAssembly.compile(await Deno.readFile(new URL(file, import.meta.resolve(spec))));
    await initJpegDecode(await wasm("npm:@jsquash/jpeg@1.6.0/decode.js", "./codec/dec/mozjpeg_dec.wasm"));
    await initPngDecode(await wasm("npm:@jsquash/png@3.1.1/decode.js", "./codec/pkg/squoosh_png_bg.wasm"));
    await initWebpDecode(await wasm("npm:@jsquash/webp@1.5.0/decode.js", "./codec/dec/webp_dec.wasm"));
    const simd = await wasm("npm:@jsquash/webp@1.5.0/encode.js", "./codec/enc/webp_enc_simd.wasm").catch(() => null);
    await initWebpEncode(simd ?? (await wasm("npm:@jsquash/webp@1.5.0/encode.js", "./codec/enc/webp_enc.wasm")));
  })().catch((e) => {
    codecs = null;
    throw e;
  });
  return codecs;
}

export const wasmImages: Images = {
  async webp(bytes, width) {
    const info = sniffPicture(bytes);
    if (!info) throw new RowProblem("bad_image", "not a JPEG, PNG or WebP picture");
    if (info.type === "heic") throw new RowProblem("bad_image", "heic");
    if (info.width < 1 || info.height < 1) throw new RowProblem("bad_image", "no size");
    if (info.width * info.height > MAX_PIXELS) throw new RowProblem("too_big", "pixels");
    await loadCodecs();
    const buffer = bytes.slice().buffer as ArrayBuffer;
    const decoded = (info.type === "jpg" ? await decodeJpeg(buffer) : info.type === "png" ? await decodePng(buffer) : await decodeWebp(buffer)) as unknown as Pixels;
    const o = info.type === "jpg" ? jpegOrientation(bytes) : 1;
    // the width the page shows: a turned photo's height is its width
    const shownWidth = o >= 5 ? decoded.height : decoded.width;
    const target = Math.min(width, shownWidth);
    const small = o >= 5 ? shrink(decoded, Math.max(1, Math.round((decoded.width * target) / decoded.height))) : shrink(decoded, target);
    const upright = orient(small, o);
    const out = await encodeWebp(upright as unknown as ImageData, { quality: 80, method: 4 });
    return { bytes: new Uint8Array(out), width: upright.width, height: upright.height };
  },
};

// ---------------------------------------------------------------- addresses: public https only

/** A public https address (no IP address, no local names, no user:password, no other port), else null. */
export function safeUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return null;
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|arpa|test|invalid|example|onion|localdomain)$/.test(host)) return null;
  return url;
}

/** Whether an IP address (v4 or v6) is private, local, shared or otherwise not on the public internet. */
export function isPrivateIp(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const [a, b, c] = v4.slice(1, 4).map(Number);
    if (v4.slice(1).some((n) => Number(n) > 255)) return true;
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (!v6.includes(":")) return true; // not an address at all
  const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateIp(mapped[1]);
  if (v6 === "::" || v6 === "::1" || /^0*(:0*)*:0*1?$/.test(v6)) return true;
  const first = parseInt(v6.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link local
    (first & 0xff00) === 0xff00 || // multicast
    v6.startsWith("64:ff9b:") || // NAT64
    v6.startsWith("2001:db8:") || v6.startsWith("2001:0db8:") || // documentation
    v6.startsWith("100::") || // discard
    first === 0
  );
}

/** The host's addresses (A and AAAA). Throws when the name has none. */
export type Resolve = (host: string) => Promise<string[]>;

/** Deno's own lookup; DNS over HTTPS (Cloudflare) where the runtime has none. */
export const resolveHost: Resolve = async (host) => {
  const found: string[] = [];
  const native = (Deno as unknown as { resolveDns?: (h: string, t: "A" | "AAAA") => Promise<string[]> }).resolveDns;
  if (typeof native === "function") {
    for (const type of ["A", "AAAA"] as const) found.push(...(await native(host, type).catch(() => [] as string[])));
    if (found.length) return found;
  }
  for (const type of ["A", "AAAA"]) {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    const data = res?.ok ? ((await res.json().catch(() => null)) as { Answer?: { type: number; data: string }[] } | null) : null;
    for (const a of data?.Answer ?? []) if (a.type === 1 || a.type === 28) found.push(a.data);
  }
  return found;
};

/** Every address of the host must be public (a name that also points inside is refused). */
async function publicHost(url: URL, resolve: Resolve): Promise<void> {
  const addresses = await resolve(url.hostname.replace(/\.$/, "")).catch(() => [] as string[]);
  if (!addresses.length) throw new RowProblem("failed", "dns");
  if (addresses.some(isPrivateIp)) throw new RowProblem("bad_url", "private address");
}

const IMAGE_TYPES = /^(image\/(jpeg|jpg|pjpeg|png|webp|heic|heif)|application\/octet-stream|binary\/octet-stream)$/;

/**
 * An image of a bulk file, downloaded on the server: https of a public host only (every address the name has and every
 * forward checked, at most 3 forwards), at most 15 MB (the announced size and what arrives), 20 s, an image type.
 */
export async function download(url: string, deps: Pick<Deps, "fetch" | "resolve">): Promise<Uint8Array> {
  const start = safeUrl(url);
  if (!start) throw new RowProblem("bad_url", "not public https");
  let current: URL = start;
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  for (let hop = 0; ; hop++) {
    await publicHost(current, deps.resolve);
    const res: Response = await deps.fetch(current.href, {
      headers: { "User-Agent": USER_AGENT, Accept: "image/webp,image/jpeg,image/png;q=0.9,*/*;q=0.1" },
      redirect: "manual",
      signal,
    }).catch((e) => {
      throw new RowProblem("failed", e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network");
    });
    if (res.status >= 300 && res.status < 400) {
      const location: string | null = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) throw new RowProblem("failed", "too many redirects");
      const forward: URL | null = location ? safeUrl(new URL(location, current).href) : null;
      if (!forward) throw new RowProblem("bad_url", "redirect not public https");
      current = forward;
      continue;
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      throw new RowProblem("failed", `HTTP ${res.status}`);
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type && !IMAGE_TYPES.test(type)) {
      await res.body.cancel().catch(() => {});
      throw new RowProblem("bad_image", `content-type ${type.slice(0, 60)}`);
    }
    const announced = Number(res.headers.get("content-length") ?? "0");
    if (announced > MAX_SOURCE_BYTES) {
      await res.body.cancel().catch(() => {});
      throw new RowProblem("too_big", "15 MB");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read().catch(() => {
        throw new RowProblem("failed", "network");
      });
      if (done) break;
      size += value.length;
      if (size > MAX_SOURCE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new RowProblem("too_big", "15 MB");
      }
      chunks.push(value);
    }
    return concat(chunks);
  }
}

// ---------------------------------------------------------------- dependencies

export interface Storage {
  put(path: string, bytes: Uint8Array, type: string): Promise<void>;
  get(path: string): Promise<Uint8Array | null>;
  remove(paths: string[]): Promise<void>;
}

export interface Deps {
  /** Service role: the database functions and the bucket. */
  db: Pick<SupabaseClient, "rpc">;
  /** The caller's own login: the database decides what they may do. */
  asCaller: (authorization: string) => Pick<SupabaseClient, "rpc" | "from" | "auth">;
  serviceKey: string | null;
  storage: Storage;
  images: Images;
  fetch: typeof fetch;
  resolve: Resolve;
  /** The next step, in a new call of this function (each call has its own 2 s of CPU). */
  chain: (body: Json) => Promise<void>;
  background: (task: Promise<unknown>) => void;
  /** POST SITE_URL/api/revalidate for the shop (null: SITE_URL / REVALIDATE_SECRET not set). */
  refresh: ((slug: string) => Promise<void>) | null;
  /** A random file name (the tests use fixed ones). */
  name: () => string;
}

async function rpc<T>(deps: Deps, name: string, args: Json = {}): Promise<T> {
  const { data, error } = await deps.db.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as T;
}

async function removeFiles(deps: Deps, paths: unknown) {
  const list = (Array.isArray(paths) ? paths : []).filter((p): p is string => typeof p === "string" && p.length > 0);
  if (list.length) await deps.storage.remove(list).catch(() => {});
}

function refreshLater(deps: Deps, slug: unknown) {
  if (deps.refresh && typeof slug === "string" && slug) deps.background(deps.refresh(slug).catch(() => {}));
}

const next = (deps: Deps, body: Json) => deps.background(deps.chain(body).catch(() => {}));

// ---------------------------------------------------------------- the owner: upload, remove, kick

async function caller(req: Request, deps: Deps): Promise<string | null> {
  const authorization = req.headers.get("Authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token || sameSecret(token, deps.serviceKey)) return null;
  const { data } = await deps.asCaller(authorization).auth.getUser(token);
  return data?.user ? authorization : null;
}

interface OwnItem {
  item_id: string;
  shop_id: string;
  slug: string;
}

async function ownItem(deps: Deps, authorization: string, itemId: string): Promise<OwnItem | null> {
  if (!UUID.test(itemId)) return null;
  const { data, error } = await deps.asCaller(authorization).rpc("owner_product_photo_item", { p_item_id: itemId });
  return error || !data ? null : (data as OwnItem);
}

/** One picture of the upload: WebP or JPEG by its bytes, at most `max` px wide and 5 MB; its own data removed. */
async function checkedPicture(file: FormDataEntryValue | null, max: number): Promise<{ bytes: Uint8Array; info: Picture } | "missing" | "bad"> {
  if (!(file instanceof Blob)) return "missing";
  if (file.size < 1 || file.size > MAX_STORED_BYTES) return "bad";
  const bytes = stripMetadata(new Uint8Array(await file.arrayBuffer()));
  const info = sniffPicture(bytes);
  if (!info || (info.type !== "webp" && info.type !== "jpg") || info.width < 1 || info.height < 1 || info.width > max || info.height > 12_800) return "bad";
  return { bytes, info };
}

const fileName = (deps: Deps, item: OwnItem, size: number, type: "webp" | "jpg") => `${item.shop_id}/${item.item_id}/${deps.name()}-${size}.${type}`;
const mime = (type: string) => (type === "jpg" ? "image/jpeg" : "image/webp");

export async function upload(req: Request, deps: Deps): Promise<Response> {
  const authorization = await caller(req, deps);
  if (!authorization) return reply(401, { error: "login" });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return reply(400, { error: "bad_request" });
  }
  const item = await ownItem(deps, authorization, String(form.get("item_id") ?? ""));
  if (!item) return reply(403, { error: "not_member" });
  const large = await checkedPicture(form.get("large"), 1600);
  if (large === "missing" || large === "bad") return reply(400, { error: "picture" });
  const small = await checkedPicture(form.get("small"), 800);
  if (small === "bad") return reply(400, { error: "picture" });
  if (small === "missing" && large.info.width > 800) return reply(400, { error: "picture" });
  const largePath = fileName(deps, item, 1600, large.info.type === "jpg" ? "jpg" : "webp");
  const smallPath = small === "missing" ? largePath : fileName(deps, item, 800, small.info.type === "jpg" ? "jpg" : "webp");
  await deps.storage.put(largePath, large.bytes, mime(large.info.type));
  if (small !== "missing") await deps.storage.put(smallPath, small.bytes, mime(small.info.type));
  let set: { old?: unknown; slug?: string };
  try {
    set = await rpc(deps, "product_photo_set", {
      p_item_id: item.item_id,
      p_large: largePath,
      p_small: smallPath,
      p_width: large.info.width,
      p_height: large.info.height,
      p_source: "owner",
      p_url: null,
    });
  } catch (e) {
    await removeFiles(deps, [largePath, smallPath]);
    throw e;
  }
  await removeFiles(deps, set.old);
  refreshLater(deps, set.slug ?? item.slug);
  return reply(200, { ok: true, large: largePath, small: smallPath, width: large.info.width, height: large.info.height });
}

async function ownerAction(action: string, req: Request, deps: Deps, body: Json): Promise<Response> {
  const authorization = await caller(req, deps);
  if (!authorization) return reply(401, { error: "login" });
  if (action === "remove") {
    const item = await ownItem(deps, authorization, String(body.item_id ?? ""));
    if (!item) return reply(403, { error: "not_member" });
    const out = await rpc<{ old?: unknown; slug?: string }>(deps, "product_photo_remove", { p_item_id: item.item_id });
    await removeFiles(deps, out.old);
    refreshLater(deps, out.slug ?? item.slug);
    return reply(200, { ok: true });
  }
  if (action === "kick") {
    const jobId = String(body.job_id ?? "");
    if (!UUID.test(jobId)) return reply(400, { error: "bad_request" });
    // the report is read with the owner's own login (RLS: members of the job's shop only)
    const { data } = await deps.asCaller(authorization).from("product_photo_jobs").select("id, status").eq("id", jobId).maybeSingle();
    if (!data) return reply(403, { error: "not_member" });
    if ((data as { status: string }).status === "running") next(deps, { action: "work" });
    return reply(200, { ok: true });
  }
  return reply(400, { error: "bad_request" });
}

// ---------------------------------------------------------------- bulk: one step per call

interface Claim {
  job_id: string;
  n: number;
  url: string;
  item_id: string;
  shop_id: string;
  part_path: string | null;
  part_width: number | null;
  part_height: number | null;
}

/**
 * One step of a bulk file: the next row's 1600 px picture (downloaded, made upright and smaller, WebP), or the 800 px
 * one of a row whose 1600 px picture is already stored, which then replaces the product's photo. The next step follows
 * in a new call. False: nothing waits.
 */
export async function workStep(deps: Deps): Promise<boolean> {
  const row = await rpc<Claim | null>(deps, "product_photo_claim");
  if (!row) return false;
  const done = async (status: string, extra: Json = {}) => {
    const out = await rpc<{ old?: unknown; slug?: string; finished?: boolean }>(deps, "product_photo_row_done", {
      p_job_id: row.job_id,
      p_n: row.n,
      p_status: status,
      p_detail: null,
      p_large: null,
      p_small: null,
      p_width: null,
      p_height: null,
      ...extra,
    });
    await removeFiles(deps, out.old);
    if (out.finished) refreshLater(deps, out.slug);
    else if (status === "done" && out.slug && deps.refresh && row.n % 50 === 0) refreshLater(deps, out.slug);
  };
  const base = `${row.shop_id}/${row.item_id}/`;
  try {
    if (!row.part_path) {
      const source = await download(row.url, deps);
      const large = await deps.images.webp(source, 1600);
      if (large.bytes.length > MAX_STORED_BYTES) throw new RowProblem("too_big", "5 MB");
      const path = `${base}${deps.name()}-1600.webp`;
      await deps.storage.put(path, large.bytes, "image/webp");
      if (large.width <= 800) {
        await done("done", { p_large: path, p_small: path, p_width: large.width, p_height: large.height });
      } else {
        await rpc(deps, "product_photo_part", { p_job_id: row.job_id, p_n: row.n, p_path: path, p_width: large.width, p_height: large.height });
      }
    } else {
      const largeBytes = await deps.storage.get(row.part_path);
      if (!largeBytes) throw new RowProblem("failed", "the 1600 px picture is missing");
      const small = await deps.images.webp(largeBytes, 800);
      const path = row.part_path.replace(/-1600\.webp$/, "-800.webp");
      await deps.storage.put(path, small.bytes, "image/webp");
      await done("done", { p_large: row.part_path, p_small: path, p_width: row.part_width, p_height: row.part_height });
    }
  } catch (e) {
    const problem = e instanceof RowProblem ? e : new RowProblem(/memory|too large/i.test(failText(e)) ? "too_big" : "failed", "error");
    if (row.part_path) await removeFiles(deps, [row.part_path]);
    // never the address or the file in the log: the job, the row and the reason
    console.error(`product-photos: job ${row.job_id.slice(0, 8)} row ${row.n}: ${problem.status} ${problem.detail}`);
    await done(problem.status, { p_detail: problem.detail });
  }
  return true;
}

/** The 5-minute job: a bulk file that stopped (no step for 2 minutes) goes on; unused files go. */
export async function tick(deps: Deps): Promise<Json> {
  const stalled = await rpc<boolean>(deps, "product_photo_due", { p_quiet: "2 minutes" });
  if (stalled) next(deps, { action: "work" });
  const orphans = ((await deps.db.rpc("product_photo_tidy", { p_limit: 200 })).data ?? []) as string[];
  await removeFiles(deps, orphans);
  return { resumed: stalled, swept: orphans.length };
}

// ---------------------------------------------------------------- the entry point

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return reply(405, { error: "method" });
  const url = new URL(req.url);
  if (url.searchParams.get("action") === "upload") {
    try {
      return await upload(req, deps);
    } catch (e) {
      console.error("product-photos: upload", failText(e).slice(0, 120));
      return reply(500, { error: "failed" });
    }
  }
  let body: Json;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return reply(400, { error: "bad_request" });
  }
  const action = String(body?.action ?? "");
  try {
    const cron = req.headers.get("x-ppi-cron");
    if (cron !== null) {
      const { data: ok } = await deps.db.rpc("assistant_cron_ok", { p_secret: cron });
      if (ok !== true) return reply(401, { error: "secret" });
      if (action !== "tick") return reply(400, { error: "bad_request" });
      return reply(200, await tick(deps));
    }
    if (action === "work") {
      const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!sameSecret(bearer, deps.serviceKey)) return reply(401, { error: "secret" });
      const more = await workStep(deps);
      if (more) next(deps, { action: "work" });
      return reply(200, { more });
    }
    return await ownerAction(action, req, deps, body);
  } catch (e) {
    console.error("product-photos:", action, failText(e).slice(0, 120));
    return reply(500, { error: "failed" });
  }
}

export async function handler(req: Request): Promise<Response> {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return reply(500, { error: "config" });
  const env = (name: string) => Deno.env.get(name)?.trim() || null;
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const db = createClient(url, serviceKey, options);
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  const base = url.replace(/\/+$/, "");
  const site = env("SITE_URL");
  const revalidate = env("REVALIDATE_SECRET");
  return await handle(req, {
    db,
    asCaller: (authorization) => createClient(url, anonKey, { ...options, global: { headers: { Authorization: authorization } } }),
    serviceKey,
    storage: {
      put: async (path, bytes, type) => {
        const { error } = await db.storage.from(BUCKET).upload(path, bytes, { contentType: type, upsert: false, cacheControl: "31536000" });
        if (error) throw new Error(`storage: ${error.message}`);
      },
      get: async (path) => {
        const { data } = await db.storage.from(BUCKET).download(path);
        return data ? new Uint8Array(await data.arrayBuffer()) : null;
      },
      remove: async (paths) => {
        for (let i = 0; i < paths.length; i += 100) await db.storage.from(BUCKET).remove(paths.slice(i, i + 100));
      },
    },
    images: wasmImages,
    fetch,
    resolve: resolveHost,
    chain: async (body) => {
      const res = await fetch(`${base}/functions/v1/product-photos`, {
        method: "POST",
        headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      await res?.body?.cancel().catch(() => {});
    },
    background: (task) => (runtime ? runtime.waitUntil(task) : void task),
    refresh: site && revalidate
      ? async (slug) => {
          const res = await fetch(`${site.replace(/\/+$/, "")}/api/revalidate`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-ppi-revalidate": revalidate },
            body: JSON.stringify({ slug }),
            signal: AbortSignal.timeout(10_000),
          }).catch(() => null);
          await res?.body?.cancel().catch(() => {});
        }
      : null,
    name: () => crypto.randomUUID(),
  });
}

if (!Deno.env.get("PPI_FUNCTION_TEST")) Deno.serve(handler);
