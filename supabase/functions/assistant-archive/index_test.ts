// Unit tests of assistant-archive: real file types, GPS and places out of pictures, the PDF
// (Slovak letters, pictures, cards, footer), who may do what, ending, deleting, the jobs.
// Run: npm run test:functions
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from "npm:pdf-lib@1.17.1";
import {
  blankXmpPlaces,
  buildPdf,
  crc32,
  type Deps,
  detectKind,
  handle,
  heifMetadata,
  logoPaths,
  MAX_FILE,
  type PdfData,
  pdfFileName,
  shortId,
  stripLocation,
} from "./index.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}

function assert(condition: unknown, label: string) {
  if (!condition) throw new Error(label);
}

const SHOP = "11111111-2222-4333-8444-555555555555";
const CONV = "3f2a9c1b-7d4e-4a5b-9c6d-0e1f2a3b4c5d";
const TOKEN = "a".repeat(64);
const SECRET = "website-secret-0123456789abcdef0123456789";
const CRON = "cron-secret-0123456789abcdef0123456789abcdef";
const IMG = "aaaaaaaa-0000-4000-8000-000000000001";
const DOC = "aaaaaaaa-0000-4000-8000-000000000002";
const HEIC = "aaaaaaaa-0000-4000-8000-000000000003";
const LOOSE = "aaaaaaaa-0000-4000-8000-000000000004";

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
/** A real 32×24 colour JPEG and a 40×20 grey PNG. */
const TINY_JPEG = fromBase64(
  "/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAYACADASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAAAAQF/8QAFRABAQAAAAAAAAAAAAAAAAAAABP/xAAWAQEBAQAAAAAAAAAAAAAAAAAABgL/xAAZEQACAwEAAAAAAAAAAAAAAAAAAhMUYVH/2gAMAwEAAhEDEQA/AM2hRLQo3Rwpr2lVCiWhQo4L2klCgKyJCRmfooUAiQTP0//Z",
);
const TINY_PNG = fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAAAAADaLSBnAAAAF0lEQVQoz2NUYCAOMBGpblThqMJhrhAAqaQASAhak08AAAAASUVORK5CYII=",
);

// ---------------------------------------------------------------- bytes for the tests

function bin(...parts: (Uint8Array | number[] | string)[]): Uint8Array {
  const arrays = parts.map((p) => typeof p === "string" ? Uint8Array.from(p, (c) => c.charCodeAt(0)) : Uint8Array.from(p));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

function text(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
}

const u16 = (n: number, le = false) => (le ? [n & 255, n >> 8] : [n >> 8, n & 255]);
const u32 = (n: number, le = false) => {
  const b = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return le ? b.reverse() : b;
};

/** A TIFF (EXIF) block: orientation 6 and a GPS directory with 48°8'30" N, 17°6'45" E. */
function tiff(le: boolean): Uint8Array {
  const b = new Uint8Array(140);
  const v = new DataView(b.buffer);
  b.set(le ? [0x49, 0x49] : [0x4d, 0x4d]);
  v.setUint16(2, 42, le);
  v.setUint32(4, 8, le);
  v.setUint16(8, 2, le);
  v.setUint16(10, 0x0112, le); // orientation, SHORT
  v.setUint16(12, 3, le);
  v.setUint32(14, 1, le);
  v.setUint16(18, 6, le);
  v.setUint16(22, 0x8825, le); // the GPS directory, LONG → 38
  v.setUint16(24, 4, le);
  v.setUint32(26, 1, le);
  v.setUint32(30, 38, le);
  v.setUint16(38, 4, le);
  const entry = (n: number, tag: number, type: number, count: number, value: (at: number) => void) => {
    const at = 40 + n * 12;
    v.setUint16(at, tag, le);
    v.setUint16(at + 2, type, le);
    v.setUint32(at + 4, count, le);
    value(at + 8);
  };
  entry(0, 1, 2, 2, (at) => (b[at] = 0x4e)); // "N"
  entry(1, 2, 5, 3, (at) => v.setUint32(at, 92, le));
  entry(2, 3, 2, 2, (at) => (b[at] = 0x45)); // "E"
  entry(3, 4, 5, 3, (at) => v.setUint32(at, 116, le));
  [48, 1, 8, 1, 3000, 100].forEach((n, i) => v.setUint32(92 + i * 4, n, le));
  [17, 1, 6, 1, 4500, 100].forEach((n, i) => v.setUint32(116 + i * 4, n, le));
  return b;
}

/** What is left of the TIFF block that starts at `t`: orientation, GPS entries and coordinates. */
function readTiff(b: Uint8Array, t: number) {
  const le = b[t] === 0x49;
  const v = new DataView(b.buffer, b.byteOffset + t);
  return {
    orientation: v.getUint16(18, le),
    gpsEntries: v.getUint16(38, le),
    coordinates: Array.from(b.subarray(t + 40, t + 140)).every((x) => x === 0) ? "gone" : "present",
  };
}

const XMP_TEXT = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description exif:GPSLatitude="48,8.5N" ' +
  'exif:GPSLongitude="17,6.75E" photoshop:City="Bratislava" xmp:Rating="5"><photoshop:Country>Slovensko' +
  "</photoshop:Country></rdf:Description></rdf:RDF></x:xmpmeta>";

function jpegSegment(marker: number, body: Uint8Array) {
  return bin([0xff, marker, ...u16(body.length + 2)], body);
}

/** The tiny JPEG with EXIF (GPS), XMP (GPS, city) and IPTC (city) added after its start. */
function jpegWithPlace(exif = tiff(true)): Uint8Array {
  return bin(
    TINY_JPEG.subarray(0, 2),
    jpegSegment(0xe1, bin("Exif\0\0", exif)),
    jpegSegment(0xe1, bin("http://ns.adobe.com/xap/1.0/\0", XMP_TEXT)),
    jpegSegment(0xed, bin("Photoshop 3.0\0", "8BIM", [4, 4, 0, 0, 0, 0, 0, 14], [0x1c, 2, 90, 0, 10], "Bratislava")),
    TINY_JPEG.subarray(2),
  );
}

function pngChunk(type: string, data: Uint8Array) {
  const body = bin(type, data);
  return bin(u32(data.length), body, u32(crc32(body)));
}

function pngWithPlace(): Uint8Array {
  return bin(
    TINY_PNG.subarray(0, 33), // signature + IHDR
    pngChunk("eXIf", tiff(false)),
    pngChunk("iTXt", bin("XML:com.adobe.xmp\0\0\0\0\0", XMP_TEXT)),
    pngChunk("tEXt", bin("Comment\0", "Vzorka farby")),
    TINY_PNG.subarray(33),
  );
}

function riffChunk(type: string, data: Uint8Array) {
  return bin(type, u32(data.length, true), data, data.length & 1 ? [0] : []);
}

function webpWithPlace(exifPrefix = ""): Uint8Array {
  const vp8x = bin([0x08 | 0x04, 0, 0, 0], [31, 0, 0], [23, 0, 0]); // EXIF and XMP flags, 32×24
  const body = bin(
    "WEBP",
    riffChunk("VP8X", vp8x),
    riffChunk("VP8 ", bin([1, 2, 3, 4, 5, 6, 7, 8, 9])),
    riffChunk("EXIF", bin(exifPrefix, tiff(true))),
    riffChunk("XMP ", bin(XMP_TEXT)),
  );
  return bin("RIFF", u32(body.length, true), body);
}

function box(type: string, ...content: (Uint8Array | number[] | string)[]) {
  const body = bin(...content);
  return bin(u32(body.length + 8), type, body);
}

/** A HEIC file: ftyp, meta (hdlr, iinf with a picture, an Exif and an XMP item, iloc) and mdat. */
function heicWithPlace(): { file: Uint8Array; exifAt: number } {
  const ftyp = box("ftyp", "heic", u32(0), "mif1", "heic");
  const infe = (id: number, type: string, extra = "") => box("infe", [2, 0, 0, 0], u16(id), u16(0), type, "\0", extra);
  const iinf = box("iinf", [0, 0, 0, 0], u16(3), infe(1, "hvc1"), infe(2, "Exif"), infe(3, "mime", "application/rdf+xml\0"));
  const hdlr = box("hdlr", [0, 0, 0, 0], u32(0), "pict", new Uint8Array(12), "\0");
  const picture = bin(new Uint8Array(16).fill(7));
  const exifItem = bin(u32(6), "Exif\0\0", tiff(false));
  const xmpItem = bin(XMP_TEXT);
  const iloc = (offsets: number[]) =>
    box(
      "iloc",
      [0, 0, 0, 0],
      [0x44, 0x00],
      u16(3),
      ...[picture, exifItem, xmpItem].flatMap((item, i) => [u16(i + 1), u16(0), u16(1), u32(offsets[i]), u32(item.length)]),
    );
  const metaSize = box("meta", [0, 0, 0, 0], hdlr, iinf, iloc([0, 0, 0])).length;
  const mdatStart = ftyp.length + metaSize + 8;
  const offsets = [mdatStart, mdatStart + picture.length, mdatStart + picture.length + exifItem.length];
  const meta = box("meta", [0, 0, 0, 0], hdlr, iinf, iloc(offsets));
  const file = bin(ftyp, meta, box("mdat", picture, exifItem, xmpItem));
  return { file, exifAt: offsets[1] + 4 + 6 };
}

// ---------------------------------------------------------------- the real type

Deno.test("The real type comes from the content, never the name: JPEG, PNG, WebP, HEIC, PDF; nothing else", () => {
  eq(detectKind(TINY_JPEG), "jpeg", "jpeg");
  eq(detectKind(TINY_PNG), "png", "png");
  eq(detectKind(webpWithPlace()), "webp", "webp");
  eq(detectKind(heicWithPlace().file), "heic", "heic");
  eq(detectKind(bin(box("ftyp", "mif1", u32(0), "mif1", "heic"))), "heic", "heic by its compatible brand");
  eq(detectKind(bin("%PDF-1.7\n%âãÏÓ\n")), "pdf", "pdf");
  eq(detectKind(bin(box("ftyp", "avif", u32(0), "mif1", "avif"))), null, "AVIF refused");
  eq(detectKind(bin("GIF89a", new Uint8Array(20))), null, "GIF refused");
  eq(detectKind(bin("<svg xmlns='http://www.w3.org/2000/svg'/>")), null, "SVG refused");
  eq(detectKind(bin("PK\x03\x04", new Uint8Array(20))), null, "ZIP / Office refused");
  eq(detectKind(new Uint8Array([0xff, 0xd8])), null, "too short");
});

// ---------------------------------------------------------------- GPS and places

Deno.test("JPEG: GPS emptied, XMP and IPTC dropped, orientation and the picture itself kept", async () => {
  const original = jpegWithPlace();
  const clean = stripLocation(original, "jpeg");
  const s = text(clean);
  assert(!s.includes("Bratislava") && !s.includes("Slovensko") && !s.includes("GPSLatitude"), "no place left");
  const t = s.indexOf("Exif\0\0") + 6;
  assert(t > 6, "EXIF kept");
  eq(readTiff(clean, t), { orientation: 6, gpsEntries: 0, coordinates: "gone" }, "EXIF after");
  eq(readTiff(original, text(original).indexOf("Exif\0\0") + 6), { orientation: 6, gpsEntries: 4, coordinates: "present" }, "EXIF before");
  eq(text(clean.subarray(clean.length - 200)), text(TINY_JPEG.subarray(TINY_JPEG.length - 200)), "picture data unchanged");
  eq(detectKind(clean), "jpeg", "still a JPEG");
  const doc = await PDFDocument.create();
  const image = await doc.embedJpg(clean);
  eq([image.width, image.height], [32, 24], "still readable");
});

Deno.test("JPEG: an EXIF block that cannot be read is dropped whole", () => {
  const broken = tiff(true);
  broken[2] = 0; // not TIFF any more
  const clean = stripLocation(jpegWithPlace(broken), "jpeg");
  assert(!text(clean).includes("Exif\0\0"), "EXIF dropped");
  assert(!text(clean).includes("Bratislava"), "no place left");
});

Deno.test("PNG: eXIf GPS emptied with a correct checksum, XMP text dropped, other text kept", () => {
  const clean = stripLocation(pngWithPlace(), "png");
  const s = text(clean);
  assert(!s.includes("Bratislava") && !s.includes("XML:com.adobe.xmp"), "XMP dropped");
  assert(s.includes("Vzorka farby"), "a plain comment stays");
  const at = s.indexOf("eXIf");
  assert(at > 0, "eXIf kept");
  const length = new DataView(clean.buffer).getUint32(at - 4);
  eq(readTiff(clean, at + 4), { orientation: 6, gpsEntries: 0, coordinates: "gone" }, "EXIF after");
  eq(new DataView(clean.buffer).getUint32(at + 4 + length), crc32(clean.subarray(at, at + 4 + length)), "checksum");
  eq(detectKind(clean), "png", "still a PNG");
  assert(s.endsWith(text(TINY_PNG.subarray(TINY_PNG.length - 12))), "ends with IEND");
});

Deno.test("WebP: EXIF GPS emptied, XMP dropped, the header's flags and size fixed", () => {
  for (const prefix of ["", "Exif\0\0"]) {
    const clean = stripLocation(webpWithPlace(prefix), "webp");
    const s = text(clean);
    assert(!s.includes("Bratislava") && !s.includes("XMP "), `${prefix || "plain"}: XMP dropped`);
    eq(new DataView(clean.buffer).getUint32(4, true), clean.length - 8, "RIFF size");
    eq(clean[20] & 0x0c, 0x08, "VP8X: EXIF yes, XMP no");
    const at = s.indexOf("EXIF") + 8 + prefix.length;
    eq(readTiff(clean, at), { orientation: 6, gpsEntries: 0, coordinates: "gone" }, `${prefix || "plain"}: EXIF after`);
    eq(detectKind(clean), "webp", "still a WebP");
  }
});

Deno.test("HEIC: Exif item's GPS emptied and XMP places blanked in place (same size)", () => {
  const { file, exifAt } = heicWithPlace();
  const places = heifMetadata(file);
  eq([places?.exif.length, places?.xmp.length], [1, 1], "items found through iinf and iloc");
  const clean = stripLocation(file, "heic");
  eq(clean.length, file.length, "same size: the file's offsets stay valid");
  eq(readTiff(clean, exifAt), { orientation: 6, gpsEntries: 0, coordinates: "gone" }, "EXIF after");
  const s = text(clean);
  assert(!s.includes("Bratislava") && !s.includes("Slovensko") && !s.includes("48,8.5N"), "XMP places blanked");
  assert(s.includes('xmp:Rating="5"'), "other XMP stays");
  eq(readTiff(file, exifAt).gpsEntries, 4, "the original is not changed");
});

Deno.test("HEIC with a layout we cannot read: EXIF and XMP are still found and cleaned", () => {
  const exif = bin("Exif\0\0", tiff(true));
  const file = bin(box("ftyp", "heic", u32(0), "heic"), box("mdat", new Uint8Array(40), exif, XMP_TEXT));
  const clean = stripLocation(file, "heic");
  const at = text(clean).indexOf("Exif\0\0") + 6;
  eq(readTiff(clean, at), { orientation: 6, gpsEntries: 0, coordinates: "gone" }, "EXIF after");
  assert(!text(clean).includes("Bratislava"), "XMP places blanked");
});

Deno.test("XMP place values are replaced by spaces of the same length", () => {
  const blank = blankXmpPlaces(XMP_TEXT);
  eq(blank.length, XMP_TEXT.length, "same length");
  assert(blank.includes(`exif:GPSLatitude="${" ".repeat(7)}"`) && blank.includes(`<photoshop:Country>${" ".repeat(9)}</photoshop:Country>`), blank);
  assert(blank.includes('xmp:Rating="5"'), "other values stay");
  eq(blankXmpPlaces("<x:xmpmeta>no place</x:xmpmeta>"), "<x:xmpmeta>no place</x:xmpmeta>", "nothing to do");
});

Deno.test("A PDF is stored as it is", () => {
  const pdf = bin("%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF");
  eq(stripLocation(pdf, "pdf"), pdf, "unchanged");
});

// ---------------------------------------------------------------- names

Deno.test("File name <YYYY-MM-DD>_<HH-MM>_<short id>.pdf in the shop's time zone", () => {
  eq(shortId(CONV), "3f2a9c1b", "short id");
  eq(pdfFileName("2026-10-10T12:05:00Z", "Europe/Bratislava", CONV), "2026-10-10_14-05_3f2a9c1b.pdf", "summer time");
  eq(pdfFileName("2026-12-31T23:30:00Z", "Europe/Lisbon", CONV), "2026-12-31_23-30_3f2a9c1b.pdf", "Lisbon");
  eq(pdfFileName("2026-12-31T23:30:00Z", "Europe/Athens", CONV), "2027-01-01_01-30_3f2a9c1b.pdf", "Athens, next year");
  eq(pdfFileName("2026-10-10T12:05:00Z", "Not/AZone", CONV), "2026-10-10_12-05_3f2a9c1b.pdf", "unknown zone → UTC");
});

Deno.test("The logo for the PDF: the PNG twin of a WebP logo, or the logo itself", () => {
  const base = "https://p.supabase.co/storage/v1/object/public/logos";
  eq(logoPaths(`${base}/${SHOP}/logo.webp?v=1712`), [`${SHOP}/logo.png`], "webp → png twin");
  eq(logoPaths(`${base}/${SHOP}/logo.png`), [`${SHOP}/logo.png`], "png");
  eq(logoPaths(`${base}/${SHOP}/m%C3%B4j%20logo.jpg`), [`${SHOP}/môj logo.jpg`], "decoded");
  eq(logoPaths("https://elsewhere.example/logo.png"), [], "not our bucket");
  eq(logoPaths(null), [], "no logo");
});

// ---------------------------------------------------------------- the PDF

/** The PDF read back: each page's text (through the fonts' ToUnicode maps), pictures, title. */
async function readPdf(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const decode = (obj: unknown) => (obj instanceof PDFRawStream ? text(decodePDFRawStream(obj).decode()) : "");
  const pages = doc.getPages().map((page) => {
    const maps = new Map<string, Map<string, string>>();
    const fonts = page.node.Resources()?.lookup(PDFName.of("Font"), PDFDict);
    for (const [name, ref] of fonts?.entries() ?? []) {
      const font = doc.context.lookup(ref, PDFDict);
      const map = new Map<string, string>();
      for (const m of decode(doc.context.lookup(font.get(PDFName.of("ToUnicode")))).matchAll(/<([0-9a-f]{4})> <([0-9a-f]+)>/gi)) {
        map.set(m[1].toLowerCase(), String.fromCharCode(...m[2].match(/.{4}/g)!.map((h) => parseInt(h, 16))));
      }
      maps.set(name.asString(), map);
    }
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
    let font = new Map<string, string>();
    const lines: string[] = [];
    for (const m of streams.map(decode).join("\n").matchAll(/(\/\S+) [\d.]+ Tf|<([0-9a-fA-F]*)> Tj/g)) {
      if (m[1]) font = maps.get(m[1]) ?? new Map();
      else lines.push((m[2].match(/.{4}/g) ?? []).map((g) => font.get(g.toLowerCase()) ?? "�").join(""));
    }
    return lines.join("\n");
  });
  let images = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")) images++;
  }
  return { pages, images, title: doc.getTitle() };
}

const AT = (minute: number) => new Date(Date.UTC(2026, 9, 10, 12, minute)).toISOString();

function pdfData(extra: Partial<PdfData> = {}): PdfData {
  return {
    conversation: {
      id: CONV,
      shop_id: SHOP,
      page_lang: "sk",
      shopper_lang: "hu",
      started_at: AT(5),
      ended_at: AT(31),
      message_count: 6,
    },
    shop: { name: "Farby Ľubica – Košice", logo_url: null, timezone: "Europe/Bratislava" },
    messages: [
      {
        role: "shopper",
        body: "Dobrý deň, máte bielu farbu na drevo? Ďakujem – čšťžýáíéúäôňľĺŕ ČŠŤŽÝÁÍÉÚÄÔŇĽĹŔ",
        body_owner: null,
        lang: "sk",
        cards: [],
        attachment_ids: [IMG, DOC, HEIC],
        created_at: AT(5),
      },
      {
        role: "assistant",
        body: "Áno, máme bielu farbu Dulux 0,75 l.",
        body_owner: null,
        lang: "sk",
        cards: [
          { name: "Dulux biela 0,75 l", price: "12,90 €", availability: "12 ks na sklade", data_time: AT(1), quantity: 2 },
          { name: "Lazúra na drevo", price: "8,50 €", availability: "Vypredané", data_time: "2026-10-09T08:00:00Z" },
        ],
        attachment_ids: [],
        created_at: AT(6),
      },
      {
        role: "shopper",
        body: "Van zöld festékük? Őszintén szólva sürgős.",
        body_owner: "Máte zelenú farbu? Úprimne, je to súrne.",
        lang: "hu",
        cards: [],
        attachment_ids: [],
        created_at: AT(10),
      },
      {
        role: "assistant",
        body: "Igen, van zöld festékünk.",
        body_owner: "Áno, máme zelenú farbu.",
        lang: "hu",
        cards: [],
        attachment_ids: [],
        created_at: AT(11),
      },
      {
        role: "shopper",
        body: "Добрий день! ґ є і ї — Καλημέρα 😀 你好",
        body_owner: "Dobrý deň!",
        lang: "uk",
        cards: [],
        attachment_ids: [],
        created_at: AT(30),
      },
      {
        role: "assistant",
        body: "Dobrý deň, ako vám môžem pomôcť?",
        body_owner: null,
        lang: "sk",
        cards: [],
        attachment_ids: [],
        created_at: AT(31),
      },
    ],
    attachments: [
      { id: IMG, name: "IMG_0042.jpg", kind: "jpeg", bytes: 2_400_000, path: "x/img.jpg", preview_path: "x/img.preview.jpg" },
      { id: DOC, name: "ponuka_č.12.pdf", kind: "pdf", bytes: 180_000, path: "x/doc.pdf", preview_path: null },
      { id: HEIC, name: "farba.heic", kind: "heic", bytes: 3_100_000, path: "x/farba.heic", preview_path: null },
      { id: LOOSE, name: "neodoslané.png", kind: "png", bytes: 12_000, path: "x/n.png", preview_path: "x/n.preview.jpg" },
    ],
    ...extra,
  };
}

Deno.test("PDF: Slovak and other letters read back exactly; times, both versions, cards, files, footer", async () => {
  const started = performance.now();
  const bytes = await buildPdf(pdfData(), { previews: new Map([[IMG, TINY_JPEG], [LOOSE, TINY_JPEG]]), logo: TINY_PNG });
  const ms = performance.now() - started;
  eq(text(bytes.subarray(0, 5)), "%PDF-", "a PDF");
  const { pages, images, title } = await readPdf(bytes);
  const all = pages.join("\n");
  const has = (s: string) => assert(all.includes(s), `missing "${s}" in:\n${all}`);
  has("Farby Ľubica – Košice");
  has("Konverzácia s asistentom obchodu");
  has("Začiatok: 10. 10. 2026 14:05 · Koniec: 14:31");
  has("Jazyk zákazníka: maďarčina (stránka: slovenčina)");
  has("14:05 · Zákazník");
  has("Dobrý deň, máte bielu farbu na drevo? Ďakujem – čšťžýáíéúäôňľĺŕ ČŠŤŽÝÁÍÉÚÄÔŇĽĹŔ");
  has("14:06 · Asistent");
  has("Van zöld festékük? Őszintén szólva sürgős.");
  has("Po slovensky: Máte zelenú farbu? Úprimne, je to súrne.");
  has("Po slovensky: Áno, máme zelenú farbu.");
  has("Добрий день! ґ є і ї — Καλημέρα ? ??");
  // the cards table
  has("Tovar");
  has("Dostupnosť");
  has("Údaje k");
  has("Dulux biela 0,75 l (2 ks)");
  has("12,90 €");
  has("12 ks na sklade");
  has("14:01");
  has("Vypredané");
  has("9. 10. 2026 10:00");
  // files: the picture with its name, the others listed
  has("IMG_0042.jpg");
  has("Súbor: ponuka_č.12.pdf (PDF, 176 kB)");
  has("Súbor: farba.heic (HEIC, 3,0 MB) – náhľad nie je k dispozícii");
  has("Ďalšie súbory");
  has("neodoslané.png");
  has(`Vytvorené Cacadoo PPI · konverzácia 3f2a9c1b · strana 1/${pages.length}`);
  assert(!all.includes("�"), "every character has its glyph");
  eq(images, 3, "logo + the two previews");
  eq(title, "Konverzácia s asistentom obchodu 3f2a9c1b – Farby Ľubica – Košice", "title");
  console.log(`    PDF: ${pages.length} page(s), ${bytes.length} bytes, ${ms.toFixed(0)} ms`);
});

Deno.test("PDF: a long conversation runs over pages, each with 'strana X/Y'", async () => {
  const base = pdfData();
  const messages = Array.from({ length: 80 }, (_, i) => ({
    ...base.messages[i % 2 === 0 ? 0 : 1],
    attachment_ids: [],
    body: `${i + 1}. správa: ${"Potrebujem farbu, štetec a valček na stenu v obývačke. ".repeat(3)}`,
    created_at: AT(5 + Math.floor(i / 4)),
  }));
  const started = performance.now();
  const bytes = await buildPdf({ ...base, messages, attachments: [] }, { previews: new Map(), logo: null });
  const ms = performance.now() - started;
  const { pages, images } = await readPdf(bytes);
  assert(pages.length >= 3, `expected several pages, got ${pages.length}`);
  pages.forEach((page, i) => assert(page.includes(`· strana ${i + 1}/${pages.length}`), `footer on page ${i + 1}`));
  assert(pages.join("\n").includes("80. správa:"), "the last message is there");
  eq(images, 0, "no logo, no pictures");
  console.log(`    PDF: ${pages.length} pages, ${bytes.length} bytes, ${ms.toFixed(0)} ms`);
});

// ---------------------------------------------------------------- the function: fakes

type Result = { data: unknown; error: { message: string; code?: string } | null };
const ok = (data: unknown): Result => ({ data, error: null });

interface World {
  rpc?: Record<string, (args: Record<string, unknown>) => Result>;
  files?: Map<string, Uint8Array>;
  member?: boolean;
  uploadError?: string;
  removeError?: string;
  attachments?: { id: string; kind: string; storage_path: string; preview_path: string | null }[];
  websiteSecret?: string | null;
  pushFails?: boolean;
}

/** Fake service-role and caller clients; every call is logged in order. */
function fakes(world: World = {}) {
  const log: string[] = [];
  const files = world.files ?? new Map<string, Uint8Array>();
  const tasks: Promise<unknown>[] = [];
  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      log.push(`rpc ${name} ${JSON.stringify(args)}`);
      return Promise.resolve(world.rpc?.[name]?.(args) ?? ok(null));
    },
    from: (table: string) => ({
      select: () => ({
        eq: (_column: string, id: string) => {
          log.push(`read ${table} ${id}`);
          return Promise.resolve(ok((world.attachments ?? []).filter(() => id === CONV)));
        },
      }),
    }),
    storage: {
      from: (bucket: string) => ({
        upload: (path: string, bytes: Uint8Array, options: { contentType: string; upsert: boolean }) => {
          log.push(`upload ${bucket}/${path} ${options.contentType}${options.upsert ? " upsert" : ""}`);
          if (world.uploadError) return Promise.resolve({ data: null, error: { message: world.uploadError } });
          files.set(`${bucket}/${path}`, bytes);
          return Promise.resolve(ok({ path }));
        },
        download: (path: string) => {
          const bytes = files.get(`${bucket}/${path}`);
          log.push(`download ${bucket}/${path}${bytes ? "" : " (missing)"}`);
          return Promise.resolve(bytes ? ok(new Blob([bytes as BlobPart])) : { data: null, error: { message: "Object not found" } });
        },
        remove: (paths: string[]) => {
          log.push(`remove ${bucket} ${paths.join(",")}`);
          if (world.removeError) return Promise.resolve({ data: null, error: { message: world.removeError } });
          for (const p of paths) files.delete(`${bucket}/${p}`);
          return Promise.resolve(ok([]));
        },
        createSignedUrls: (paths: string[], seconds: number) => {
          log.push(`sign ${bucket} ${paths.length} ${seconds}s`);
          return Promise.resolve(ok(paths.map((p) => ({ path: p, signedUrl: `https://signed/${p}?s=${seconds}` }))));
        },
      }),
    },
  };
  const caller = {
    auth: { getUser: (token: string) => Promise.resolve({ data: { user: token === "owner-jwt" ? { id: "u1" } : null } }) },
    from: (table: string) => ({
      select: () => ({
        eq: (_column: string, id: string) => ({
          maybeSingle: () => {
            log.push(`caller read ${table}`);
            return Promise.resolve(ok(world.member !== false && id === CONV ? { id } : null));
          },
        }),
      }),
    }),
  };
  const deps: Deps = {
    db: db as unknown as SupabaseClient,
    asCaller: () => caller as unknown as SupabaseClient,
    websiteSecret: world.websiteSecret === undefined ? SECRET : world.websiteSecret,
    background: (task) => tasks.push(task),
    pushToCloud: (id) => {
      log.push(`push ${id}`);
      return world.pushFails ? Promise.reject(new Error("cloud-export is down")) : Promise.resolve();
    },
  };
  return { deps, log, files, tasks };
}

async function call(deps: Deps, body: Record<string, unknown>, headers: Record<string, string> = { "x-ppi-archive": SECRET }) {
  const response = await handle(
    new Request("http://localhost/assistant-archive", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    deps,
  );
  return [response.status, await response.json()] as const;
}

async function send(deps: Deps, file: Uint8Array, name: string, preview?: Uint8Array) {
  const form = new FormData();
  form.set("id", CONV);
  form.set("token", TOKEN);
  form.set("file", new File([file as BlobPart], name, { type: "image/jpeg" }));
  if (preview) form.set("preview", new File([preview as BlobPart], "preview.jpg", { type: "image/jpeg" }));
  const response = await handle(new Request("http://localhost/assistant-archive", { method: "POST", body: form }), deps);
  return [response.status, await response.json()] as const;
}

const attachmentRpc = (args: Record<string, unknown>): Result =>
  ok({
    id: IMG,
    name: args.p_name,
    path: `${SHOP}/${CONV}/files/${IMG}.${args.p_kind === "jpeg" ? "jpg" : args.p_kind}`,
    preview_path: args.p_preview ? `${SHOP}/${CONV}/files/${IMG}.preview.jpg` : null,
  });

// ---------------------------------------------------------------- the website's actions

Deno.test("Only the website (its secret) starts, records, ends or deletes conversations", async () => {
  const refused: Record<string, string>[] = [{}, { "x-ppi-archive": "wrong-secret-0123456789abcdef0123456789" }, { "x-ppi-archive": "" }];
  for (const headers of refused) {
    const { deps, log } = fakes();
    eq(await call(deps, { action: "start", shop_id: SHOP }, headers), [401, { error: "secret" }], "refused");
    eq(log, [], "nothing done");
  }
  for (const websiteSecret of [null, "short"]) {
    const { deps } = fakes({ websiteSecret });
    eq((await call(deps, { action: "record", id: CONV, token: TOKEN }, { "x-ppi-archive": websiteSecret ?? "" }))[0], 401, `secret ${websiteSecret}`);
  }
  const { deps, log } = fakes({ rpc: { assistant_open: () => ok({ id: CONV, token: TOKEN }) } });
  eq(await call(deps, { action: "start", shop_id: SHOP, page_lang: "hu", caller: "h".repeat(64) }), [200, { id: CONV, token: TOKEN }], "start");
  eq(log, [`rpc assistant_open {"p_shop_id":"${SHOP}","p_page_lang":"hu","p_ip_hash":"${"h".repeat(64)}"}`], "args");
});

Deno.test("Database refusals become clear answers", async () => {
  const cases: [string, number, string][] = [
    ["no_plan", 403, "no_plan"],
    ["not_found", 404, "not_found"],
    ["too_many", 429, "too_many"],
    ["ended", 409, "ended"],
  ];
  for (const [message, status, error] of cases) {
    const { deps } = fakes({ rpc: { assistant_open: () => ({ data: null, error: { message } }), assistant_add_turn: () => ({ data: null, error: { message } }) } });
    eq(await call(deps, { action: "start", shop_id: SHOP, caller: "h".repeat(64) }), [status, { error }], `start ${message}`);
    eq(await call(deps, { action: "record", id: CONV, token: TOKEN, shopper: {}, assistant: {} }), [status, { error }], `record ${message}`);
  }
});

Deno.test("record passes one exchange as given", async () => {
  const { deps, log } = fakes();
  const shopper = { body: "Máte štetce?", lang: "sk", attachments: [IMG] };
  const assistant = { body: "Áno.", lang: "sk", cards: [{ name: "Štetec 50 mm", price: "3,20 €", availability: "5 ks na sklade" }] };
  eq(await call(deps, { action: "record", id: CONV, token: TOKEN, shop_id: SHOP, shopper, assistant }), [200, { ok: true }], "recorded");
  eq(log, [`rpc assistant_add_turn ${JSON.stringify({ p_id: CONV, p_token: TOKEN, p_shop_id: SHOP, p_shopper: shopper, p_assistant: assistant })}`], "args");
});

function archiveWorld(extra: World = {}): World {
  const files = new Map<string, Uint8Array>([
    [`shop-assistant-uploads/${SHOP}/${CONV}/files/${IMG}.preview.jpg`, TINY_JPEG],
    [`logos/${SHOP}/logo.png`, TINY_PNG],
  ]);
  const data = pdfData({
    shop: { name: "Cacadoo Paint shop", logo_url: `https://p.supabase.co/storage/v1/object/public/logos/${SHOP}/logo.webp?v=2`, timezone: "Europe/Bratislava" },
    attachments: [
      { id: IMG, name: "IMG_0042.jpg", kind: "jpeg", bytes: 2_400_000, path: `${SHOP}/${CONV}/files/${IMG}.jpg`, preview_path: `${SHOP}/${CONV}/files/${IMG}.preview.jpg` },
    ],
  });
  return {
    files,
    ...extra,
    rpc: {
      assistant_conversation: (args) => ok(args.p_token === TOKEN ? { id: CONV, shop_id: SHOP, open: true, messages: 6, attachments: 1 } : null),
      assistant_end: () => ok(true),
      assistant_pdf_data: () => ok(data),
      assistant_files: () => ok([`${SHOP}/${CONV}/files/${IMG}.jpg`, `${SHOP}/${CONV}/files/${IMG}.preview.jpg`]),
      assistant_forget: () => ok(true),
      ...extra.rpc,
    },
  };
}

Deno.test("Ending a conversation makes its PDF after the reply, named by the start time", async () => {
  const { deps, log, files, tasks } = fakes(archiveWorld());
  eq(await call(deps, { action: "end", id: CONV, token: TOKEN, reason: "closed" }), [200, { ended: true }], "ended");
  eq(tasks.length, 1, "the PDF is made in the background");
  await Promise.all(tasks);
  const path = `${SHOP}/${CONV}/2026-10-10_14-05_3f2a9c1b.pdf`;
  const pdf = files.get(`shop-assistant-uploads/${path}`);
  assert(pdf && text(pdf.subarray(0, 5)) === "%PDF-", "the PDF is stored");
  const { pages, images } = await readPdf(pdf!);
  assert(pages[0].includes("Cacadoo Paint shop"), "shop name");
  eq(images, 2, "logo (PNG twin) + the picture's preview");
  assert(log.includes(`download logos/${SHOP}/logo.png`), "the PNG twin of the WebP logo");
  assert(log.includes(`upload shop-assistant-uploads/${path} application/pdf upsert`), "stored");
  assert(log.includes(`rpc assistant_pdf_done {"p_id":"${CONV}","p_path":"${path}","p_name":"2026-10-10_14-05_3f2a9c1b.pdf","p_error":null}`), "noted");
  assert(!log.some((l) => l.startsWith("push")), "the shop has no cloud folder: nothing pushed");
});

Deno.test("A PDF queued for the shop's cloud folder is pushed to cloud-export at once; its failure does not matter", async () => {
  for (const pushFails of [false, true]) {
    const world = archiveWorld({ pushFails });
    world.rpc = { ...world.rpc, assistant_pdf_done: () => ok(true) };
    const { deps, log, tasks } = fakes(world);
    eq(await call(deps, { action: "end", id: CONV, token: TOKEN }), [200, { ended: true }], "ended");
    eq(await Promise.all(tasks), [undefined], "the background work finishes");
    const done = log.findIndex((l) => l.startsWith("rpc assistant_pdf_done"));
    eq(log.indexOf(`push ${CONV}`) > done, true, `pushed after the PDF was noted (${pushFails ? "push fails" : "push works"})`);
  }
  const world = archiveWorld({ uploadError: "storage down" });
  world.rpc = { ...world.rpc, assistant_pdf_done: () => ok(false) };
  const { deps, log, tasks } = fakes(world);
  await call(deps, { action: "end", id: CONV, token: TOKEN });
  await Promise.all(tasks);
  assert(!log.some((l) => l.startsWith("push")), "no PDF, no push");
});

Deno.test("Ending: the wrong token is refused; a conversation already ended makes no new PDF", async () => {
  {
    const { deps, tasks } = fakes(archiveWorld());
    eq(await call(deps, { action: "end", id: CONV, token: "b".repeat(64) }), [404, { error: "not_found" }], "wrong token");
    eq(tasks.length, 0, "nothing in the background");
  }
  const { deps, tasks } = fakes(archiveWorld({ rpc: { assistant_end: () => ok(false) } }));
  eq(await call(deps, { action: "end", id: CONV, token: TOKEN }), [200, { ended: false }], "already ended");
  eq(tasks.length, 0, "no second PDF");
});

Deno.test("A conversation that ends without a message is forgotten with its files", async () => {
  const { deps, log, tasks } = fakes(archiveWorld({
    rpc: { assistant_conversation: () => ok({ id: CONV, shop_id: SHOP, open: true, messages: 0, attachments: 1 }) },
  }));
  eq(await call(deps, { action: "end", id: CONV, token: TOKEN, reason: "new" }), [200, { ended: true }], "ended");
  await Promise.all(tasks);
  const removed = log.findIndex((l) => l.startsWith("remove shop-assistant-uploads"));
  const forgotten = log.findIndex((l) => l.startsWith("rpc assistant_forget"));
  assert(removed >= 0 && forgotten > removed, "files first, then the rows");
  assert(!log.some((l) => l.startsWith("rpc assistant_pdf_data")), "no PDF");
  assert(log.some((l) => l.includes(`"p_reason":"new"`)), "reason passed");
});

Deno.test("The shopper's 'Vymazať moju konverzáciu': files and rows deleted; a storage error keeps the rows", async () => {
  {
    const { deps, log, files } = fakes(archiveWorld());
    eq(await call(deps, { action: "delete", id: CONV, token: TOKEN }), [200, { deleted: true }], "deleted");
    eq(files.has(`shop-assistant-uploads/${SHOP}/${CONV}/files/${IMG}.preview.jpg`), false, "preview gone");
    const removed = log.findIndex((l) => l.startsWith("remove shop-assistant-uploads"));
    const forgotten = log.findIndex((l) => l === `rpc assistant_shopper_forget {"p_id":"${CONV}"}`);
    assert(removed >= 0 && forgotten > removed, "files first, then the rows (a line stays for the owner when already in the cloud)");
    assert(!log.some((l) => l.startsWith("rpc assistant_forget")), "the shopper's own deletion, not the owner's");
  }
  {
    const { deps, log } = fakes(archiveWorld({ removeError: "storage down" }));
    eq(await call(deps, { action: "delete", id: CONV, token: TOKEN }), [502, { error: "storage" }], "storage error");
    assert(!log.some((l) => l.startsWith("rpc assistant_shopper_forget")), "rows kept to try again");
  }
  const { deps, log } = fakes(archiveWorld());
  eq(await call(deps, { action: "delete", id: CONV, token: "b".repeat(64) }), [404, { error: "not_found" }], "wrong token");
  assert(!log.some((l) => l.startsWith("remove") || l.includes("forget")), "nothing deleted");
});

Deno.test("A file taken back before sending: its stored files, then its row; never someone else's", async () => {
  const paths = [`${SHOP}/${CONV}/files/${IMG}.jpg`, `${SHOP}/${CONV}/files/${IMG}.preview.jpg`];
  {
    const { deps, log, files } = fakes(archiveWorld({ rpc: { assistant_discardable: () => ok(paths) } }));
    eq(await call(deps, { action: "discard", id: CONV, token: TOKEN, attachment: IMG }), [200, { discarded: true }], "discarded");
    eq(files.has(`shop-assistant-uploads/${paths[1]}`), false, "preview gone");
    const removed = log.findIndex((l) => l.startsWith("remove shop-assistant-uploads"));
    const dropped = log.findIndex((l) => l.startsWith("rpc assistant_drop_attachment"));
    assert(removed >= 0 && dropped > removed, "files first, then the row");
  }
  {
    const { deps, log } = fakes(archiveWorld({ rpc: { assistant_discardable: () => ok(null) } }));
    eq(await call(deps, { action: "discard", id: CONV, token: "b".repeat(64), attachment: IMG }), [404, { error: "not_found" }], "not theirs");
    assert(!log.some((l) => l.startsWith("remove") || l.startsWith("rpc assistant_drop_attachment")), "nothing deleted");
  }
  const { deps } = fakes(archiveWorld({ rpc: { assistant_discardable: () => ok(paths) } }));
  eq(await call(deps, { action: "discard", id: CONV, token: TOKEN, attachment: IMG }, {}), [401, { error: "secret" }], "website only");
});

// ---------------------------------------------------------------- the shopper's files

Deno.test("Upload: the type by content, GPS removed before storing, a small preview kept", async () => {
  const { deps, log, files } = fakes({ rpc: { assistant_add_attachment: attachmentRpc } });
  const [status, body] = await send(deps, jpegWithPlace(), "IMG_0001.HEIC", jpegWithPlace());
  eq([status, body], [200, { id: IMG, name: "IMG_0001.HEIC", kind: "jpeg", preview: true }], "stored as JPEG");
  const stored = files.get(`shop-assistant-uploads/${SHOP}/${CONV}/files/${IMG}.jpg`)!;
  const preview = files.get(`shop-assistant-uploads/${SHOP}/${CONV}/files/${IMG}.preview.jpg`)!;
  for (const b of [stored, preview]) {
    assert(!text(b).includes("Bratislava"), "no place");
    eq(readTiff(b, text(b).indexOf("Exif\0\0") + 6).gpsEntries, 0, "no GPS");
  }
  const add = log.find((l) => l.startsWith("rpc assistant_add_attachment"))!;
  assert(add.includes(`"p_kind":"jpeg"`) && add.includes(`"p_bytes":${stored.length}`) && add.includes(`"p_preview":true`), add);
  assert(log.includes(`upload shop-assistant-uploads/${SHOP}/${CONV}/files/${IMG}.jpg image/jpeg`), "never overwrites (no upsert)");
});

Deno.test("Upload: other types, too big, too many, a PDF, a preview that is not a JPEG", async () => {
  {
    const { deps, log } = fakes({ rpc: { assistant_add_attachment: attachmentRpc } });
    eq(await send(deps, bin(box("ftyp", "avif", u32(0), "avif"), new Uint8Array(100)), "photo.heic"), [415, { error: "type" }], "AVIF");
    eq(await send(deps, bin("GIF89a", new Uint8Array(100)), "photo.jpg"), [415, { error: "type" }], "GIF named .jpg");
    eq(await send(deps, new Uint8Array(MAX_FILE + 1).fill(0xff), "big.jpg"), [413, { error: "too_big" }], "over 10 MB");
    eq(log, [], "nothing registered or stored");
  }
  {
    const { deps, files } = fakes({ rpc: { assistant_add_attachment: () => ({ data: null, error: { message: "too_many_files" } }) } });
    eq(await send(deps, TINY_JPEG, "11.jpg"), [409, { error: "too_many_files" }], "the 11th file");
    eq(files.size, 0, "not stored");
  }
  {
    const { deps, log } = fakes({ rpc: { assistant_add_attachment: attachmentRpc } });
    const pdf = bin("%PDF-1.4\n%%EOF");
    eq(await send(deps, pdf, "ponuka.pdf", TINY_JPEG), [200, { id: IMG, name: "ponuka.pdf", kind: "pdf", preview: false }], "PDF");
    assert(log.some((l) => l.includes(`"p_kind":"pdf"`) && l.includes(`"p_preview":false`)), "no preview for a PDF");
  }
  const { deps, log } = fakes({ rpc: { assistant_add_attachment: attachmentRpc } });
  eq((await send(deps, TINY_PNG, "a.png", TINY_PNG))[1], { id: IMG, name: "a.png", kind: "png", preview: false }, "PNG preview ignored");
  assert(log.some((l) => l.includes(`"p_kind":"png"`) && l.includes(`"p_preview":false`)), "args");
});

Deno.test("Upload: when storing fails, the file is forgotten again", async () => {
  const { deps, log } = fakes({ rpc: { assistant_add_attachment: attachmentRpc }, uploadError: "storage down" });
  eq(await send(deps, TINY_JPEG, "a.jpg", TINY_JPEG), [502, { error: "storage" }], "failed");
  assert(log.some((l) => l.startsWith("remove shop-assistant-uploads")), "partial files removed");
  assert(log.some((l) => l.startsWith(`rpc assistant_drop_attachment {"p_attachment":"${IMG}"}`)), "row dropped");
});

// ---------------------------------------------------------------- owners

Deno.test("Owners: login needed; only members of the shop get 10-minute links or delete", async () => {
  const world: World = {
    attachments: [{ id: IMG, kind: "jpeg", storage_path: `${SHOP}/${CONV}/files/${IMG}.jpg`, preview_path: `${SHOP}/${CONV}/files/${IMG}.preview.jpg` }],
  };
  {
    const { deps, log } = fakes(world);
    eq(await call(deps, { action: "owner_links", conversation_id: CONV }, {}), [401, { error: "login" }], "no login");
    eq(await call(deps, { action: "owner_links", conversation_id: CONV }, { Authorization: "Bearer someone-else" }), [401, { error: "login" }], "bad login");
    eq(log, [], "nothing read");
  }
  {
    const { deps, log } = fakes({ ...world, member: false });
    eq(await call(deps, { action: "owner_links", conversation_id: CONV }, { Authorization: "Bearer owner-jwt" }), [403, { error: "not_member" }], "other shop");
    eq(await call(deps, { action: "owner_delete", conversation_id: CONV }, { Authorization: "Bearer owner-jwt" }), [403, { error: "not_member" }], "other shop");
    assert(!log.some((l) => l.startsWith("sign") || l.startsWith("remove")), "nothing signed or deleted");
  }
  const { deps, log } = fakes(archiveWorld(world));
  eq(await call(deps, { action: "owner_links", conversation_id: CONV }, { Authorization: "Bearer owner-jwt" }), [200, {
    files: {
      [IMG]: {
        original: `https://signed/${SHOP}/${CONV}/files/${IMG}.jpg?s=600`,
        preview: `https://signed/${SHOP}/${CONV}/files/${IMG}.preview.jpg?s=600`,
      },
    },
  }], "links");
  eq(await call(deps, { action: "owner_delete", conversation_id: CONV }, { Authorization: "Bearer owner-jwt" }), [200, { deleted: true }], "deleted");
  assert(log.some((l) => l.startsWith("rpc assistant_forget")), "forgotten");
});

// ---------------------------------------------------------------- the jobs

Deno.test("Jobs: the Vault secret is checked; tick ends idle conversations and makes PDFs; retention deletes", async () => {
  const cronOk = (args: Record<string, unknown>) => ok(args.p_secret === CRON);
  {
    const { deps, log } = fakes(archiveWorld({ rpc: { assistant_cron_ok: cronOk } }));
    eq(await call(deps, { action: "tick" }, { "x-ppi-cron": "wrong" }), [401, { error: "secret" }], "wrong secret");
    eq(await call(deps, { action: "start" }, { "x-ppi-cron": CRON }), [400, { error: "bad_request" }], "jobs only");
    eq(log.filter((l) => !l.startsWith("rpc assistant_cron_ok")), [], "nothing else done");
  }
  {
    const { deps, log, files } = fakes(archiveWorld({
      rpc: {
        assistant_cron_ok: cronOk,
        assistant_end_idle: () => ok([CONV]),
        assistant_empty_ended: () => ok([DOC]),
        assistant_pdf_todo: () => ok([CONV]),
      },
    }));
    eq(await call(deps, { action: "tick" }, { "x-ppi-cron": CRON }), [200, { ended: 1, forgotten: 1, pdfs: 1 }], "tick");
    assert(log.some((l) => l === `rpc assistant_end_idle {"p_minutes":30}`), "30 minutes");
    assert(files.has(`shop-assistant-uploads/${SHOP}/${CONV}/2026-10-10_14-05_3f2a9c1b.pdf`), "PDF made");
  }
  const { deps, log } = fakes(archiveWorld({ rpc: { assistant_cron_ok: cronOk, assistant_expired: () => ok([CONV, DOC]) } }));
  eq(await call(deps, { action: "retention" }, { "x-ppi-cron": CRON }), [200, { deleted: 2 }], "retention");
  eq(log.filter((l) => l.startsWith("rpc assistant_forget")).length, 2, "both forgotten");
});

Deno.test("A PDF that cannot be stored is noted and tried again later", async () => {
  const { deps, log, tasks } = fakes(archiveWorld({ uploadError: "storage down" }));
  eq(await call(deps, { action: "end", id: CONV, token: TOKEN }), [200, { ended: true }], "ended");
  await Promise.all(tasks);
  assert(
    log.some((l) => l === `rpc assistant_pdf_done {"p_id":"${CONV}","p_path":null,"p_name":null,"p_error":"storing the PDF failed: storage down"}`),
    "failure noted",
  );
});
