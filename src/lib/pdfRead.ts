/**
 * Reads a PDF in the owner's browser with pdf.js (the dashboard only): the text of each
 * page as written, the pictures in it (at least 200 px, each picture once) and scanned
 * pages (pages without text) as images for the AI to read. Nothing is changed in the
 * PDF; it is uploaded as it is. Done here because Supabase Edge Functions get only 2
 * seconds of CPU per request.
 */

/** Longest side of a stored picture or scanned page (what Claude reads best). */
export const MAX_SIDE = 1568;
const MIN_PICTURE = 200;
/** A page with less text than this is read as a scan. */
const MIN_TEXT = 20;

export interface PdfPicture {
  page: number;
  kind: "picture" | "scan";
  blob: Blob;
}

export interface PdfPage {
  page: number;
  text: string;
  pictures: PdfPicture[];
}

interface ImageObject {
  width: number;
  height: number;
  kind?: number;
  data?: Uint8ClampedArray | Uint8Array;
  bitmap?: ImageBitmap;
}

// The "legacy" build: the same pdf.js with what older browsers lack added (the modern
// build needs very new browser features).
type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let loaded: Promise<PdfJs> | null = null;

/** pdf.js and its worker, data files and decoders from /pdfjs/<version>/ (copied there at build). */
function pdfjs(): Promise<PdfJs> {
  loaded ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = `/pdfjs/${lib.version}/pdf.worker.min.mjs`;
    return lib;
  });
  return loaded;
}

/** Opens a PDF; the caller must call close() when done (it stops the worker). */
export async function openPdf(file: Blob) {
  const lib = await pdfjs();
  const base = `/pdfjs/${lib.version}/`;
  const task = lib.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
  });
  try {
    return { lib, doc: await task.promise, close: () => task.destroy() };
  } catch (e) {
    await task.destroy().catch(() => {});
    throw e;
  }
}

/** WebP where the browser can write it (Safari cannot: JPEG then). */
export async function canvasBlob(canvas: HTMLCanvasElement, preferJpeg = false): Promise<Blob> {
  const encode = (type: string) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, type === "image/png" ? undefined : 0.85));
  if (!preferJpeg) {
    const webp = await encode("image/webp");
    if (webp && webp.type === "image/webp") return webp;
  }
  const jpeg = await encode("image/jpeg");
  if (!jpeg) throw new Error("The picture could not be saved");
  return jpeg;
}

/** A canvas of at most MAX_SIDE px holding the image (pictures are only made smaller). */
export function fitCanvas(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** pdf.js image data (already decoded) → a canvas, as pdf.js itself paints it. */
function imageCanvas(img: ImageObject, kinds: PdfJs["ImageKind"]): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  if (img.bitmap) {
    ctx.drawImage(img.bitmap, 0, 0);
    return canvas;
  }
  const src = img.data;
  if (!src) return null;
  const out = ctx.createImageData(img.width, img.height);
  const dest = out.data;
  const pixels = img.width * img.height;
  if (img.kind === kinds.RGBA_32BPP) {
    dest.set(src.subarray(0, dest.length));
  } else if (img.kind === kinds.RGB_24BPP) {
    for (let i = 0, j = 0; i < pixels; i++, j += 3) {
      dest[i * 4] = src[j];
      dest[i * 4 + 1] = src[j + 1];
      dest[i * 4 + 2] = src[j + 2];
      dest[i * 4 + 3] = 255;
    }
  } else if (img.kind === kinds.GRAYSCALE_1BPP) {
    // one bit per pixel, rows padded to whole bytes; 1 = white
    const rowBytes = (img.width + 7) >> 3;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const bit = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const k = (y * img.width + x) * 4;
        dest[k] = dest[k + 1] = dest[k + 2] = bit ? 255 : 0;
        dest[k + 3] = 255;
      }
    }
  } else return null;
  ctx.putImageData(out, 0, 0);
  return canvas;
}

function objectOf(page: { objs: { get(id: string, cb: (v: unknown) => void): unknown }; commonObjs: typeof page.objs }, id: string) {
  const store = id.startsWith("g_") ? page.commonObjs : page.objs;
  return new Promise<ImageObject | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 10_000);
    try {
      store.get(id, (value: unknown) => {
        clearTimeout(timer);
        resolve((value as ImageObject) ?? null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

async function digest(blob: Blob): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

type Doc = Awaited<ReturnType<typeof openPdf>>["doc"];

/** The whole page as an image (scanned pages, and pages whose pictures cannot be taken out). */
async function renderPage(doc: Doc, pageNumber: number): Promise<Blob> {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(3, MAX_SIDE / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  await page.render({ canvas, viewport }).promise;
  return canvasBlob(canvas, true);
}

/**
 * One page: its text as written (lines kept), its pictures (each picture of the PDF only
 * once: `seen` holds what earlier pages had) or, without text, the page as a scan.
 * `wantPictures` false: text only (the shop's picture limit is reached).
 */
export async function readPage(
  lib: PdfJs,
  doc: Doc,
  pageNumber: number,
  seen: Set<string>,
  wantPictures: boolean,
): Promise<PdfPage> {
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  // pdf.js gives the text in pieces; a space or a line break goes between two pieces only
  // where the page has a gap or a new line (a word split in two pieces stays one word).
  let text = "";
  let lastEnd: number | null = null;
  let lastY: number | null = null;
  for (const item of content.items) {
    if (!("str" in item)) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    const size = Math.abs(item.transform[3]) || item.height || 10;
    if (lastY !== null && text && !text.endsWith("\n") && item.str) {
      if (Math.abs(y - lastY) > size * 0.6) text += "\n";
      else if (lastEnd !== null && x - lastEnd > size * 0.12 && !text.endsWith(" ") && !item.str.startsWith(" ")) text += " ";
    }
    text += item.str;
    if (item.hasEOL) text += "\n";
    if (item.str) {
      lastEnd = x + item.width;
      lastY = y;
    }
  }
  text = text.replace(/[ \t]+\n/g, "\n").trim();

  const ops = await page.getOperatorList();
  const imageOps: { id?: string; inline?: ImageObject }[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as unknown[];
    if (fn === lib.OPS.paintImageXObject || fn === lib.OPS.paintImageXObjectRepeat) imageOps.push({ id: String(args[0]) });
    else if (fn === lib.OPS.paintInlineImageXObject) imageOps.push({ inline: args[0] as ImageObject });
  }

  const pictures: PdfPicture[] = [];
  if (text.replace(/\s/g, "").length < MIN_TEXT) {
    // No text layer: a scanned page. The AI writes out its text; it is never shown.
    if (imageOps.length) pictures.push({ page: pageNumber, kind: "scan", blob: await renderPage(doc, pageNumber) });
  } else if (wantPictures && imageOps.length) {
    let unreadable = 0;
    let repeated = 0;
    for (const op of imageOps) {
      const img = op.inline ?? (op.id ? await objectOf(page, op.id) : null);
      if (!img) {
        unreadable++;
        continue;
      }
      if (img.width < MIN_PICTURE || img.height < MIN_PICTURE) continue;
      const canvas = imageCanvas(img, lib.ImageKind);
      if (!canvas) {
        unreadable++;
        continue;
      }
      const blob = await canvasBlob(fitCanvas(canvas, img.width, img.height));
      const key = await digest(blob);
      if (seen.has(key)) {
        repeated++;
        continue;
      }
      seen.add(key);
      pictures.push({ page: pageNumber, kind: "picture", blob });
    }
    // Pictures that could not be taken out: the page itself, as a picture.
    if (unreadable > 0 && pictures.length === 0 && repeated === 0) {
      const blob = await renderPage(doc, pageNumber);
      const key = await digest(blob);
      if (!seen.has(key)) {
        seen.add(key);
        pictures.push({ page: pageNumber, kind: "picture", blob });
      }
    }
  }
  page.cleanup();
  return { page: pageNumber, text, pictures };
}
