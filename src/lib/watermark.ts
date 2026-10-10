import "server-only";
import { parse, type Font } from "opentype.js";
import sharp from "sharp";
import { WATERMARK_FONT } from "./watermarkFont";

/**
 * The light watermark on every page a shopper views from a private folder (database update
 * 24): "<shop name> · VIP · <date>" repeated diagonally across the picture in light grey,
 * and once along the bottom. Drawn into the picture on the server (never an overlay the
 * browser could hide); the text is drawn as outlines, so the server needs no fonts.
 * View-only cannot stop screenshots: the watermark shows where a copy came from.
 */

const MAX_SIDE = 2000;
let font: Font | null = null;

function watermarkFont(): Font {
  if (!font) {
    const bytes = Buffer.from(WATERMARK_FONT, "base64");
    font = parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  }
  return font;
}

/** "Cacadoo Paint shop · VIP · 10. 10. 2026", the date in the shop's time zone. */
export function watermarkText(shopName: string, timeZone: string, now = new Date()): string {
  let zone = "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    zone = timeZone;
  } catch {
    // an unknown time zone: UTC
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const name = shopName.replace(/\s+/g, " ").trim().slice(0, 80);
  return `${name} · VIP · ${parts.day}. ${parts.month}. ${parts.year}`;
}

/** The SVG layer: the text as outlines, diagonally in rows, and once at the bottom. */
export function watermarkSvg(width: number, height: number, text: string): string {
  const f = watermarkFont();
  const size = Math.max(14, Math.round(Math.min(width, height) / 22));
  const textWidth = f.getAdvanceWidth(text, size);
  const d = f.getPath(text, 0, 0, size).toPathData(1);
  const small = Math.max(10, Math.round(size * 0.5));
  const footer = f.getPath(text, 0, 0, small).toPathData(1);
  const footerWidth = f.getAdvanceWidth(text, small);
  const diagonal = Math.hypot(width, height);
  const stepX = textWidth + size * 3;
  const stepY = size * 5;
  const uses: string[] = [];
  for (let y = -diagonal; y < diagonal; y += stepY) {
    const shift = (Math.round(y / stepY) % 2) * (stepX / 2);
    for (let x = -diagonal - shift; x < diagonal; x += stepX) uses.push(`<use href="#w" x="${Math.round(x)}" y="${Math.round(y)}"/>`);
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<defs><path id="w" d="${d}"/></defs>` +
    `<g transform="translate(${width / 2} ${height / 2}) rotate(-30)" fill="#000" fill-opacity="0.09">${uses.join("")}</g>` +
    `<path d="${footer}" transform="translate(${Math.max(4, (width - footerWidth) / 2)} ${height - small * 0.8})" fill="#000" fill-opacity="0.45"/>` +
    `</svg>`
  );
}

/** A page or picture with the watermark drawn in: a JPEG of at most 2000 px. */
export async function watermark(input: Uint8Array, text: string): Promise<Buffer> {
  const base = await sharp(input, { failOn: "none" })
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .toBuffer({ resolveWithObject: true });
  const { width, height } = base.info;
  return await sharp(base.data)
    .composite([{ input: Buffer.from(watermarkSvg(width, height, text)), top: 0, left: 0 }])
    .jpeg({ quality: 82, mozjpeg: true })
    .withMetadata({})
    .toBuffer();
}
