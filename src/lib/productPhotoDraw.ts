/**
 * A product photo drawn in the owner's browser (database update 78): opened upright (EXIF orientation), HEIC/HEIF
 * opened through heic-to where the browser cannot (loaded only then, only in Môj obchod), drawn again at most 1600 px
 * wide and an 800 px copy when it is wider — never larger, never cropped, the aspect ratio kept — as WebP 0.82 (JPEG
 * where the browser cannot write WebP). Drawing again drops the photo's own data (place, camera); the function strips
 * anything left by its bytes too.
 */
import { MAX_PHOTO_FILE_BYTES } from "./productPhotos";

export interface DrawnProductPhoto {
  large: Blob;
  small: Blob | null;
  width: number;
  height: number;
}

export class ProductPhotoProblem extends Error {
  constructor(readonly code: "too_big" | "picture") {
    super(code);
  }
}

const isHeic = (file: File) => /^image\/hei[cf]/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);

async function open(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    if (!isHeic(file)) throw new ProductPhotoProblem("picture");
    try {
      const { heicTo } = await import("heic-to/next");
      return await heicTo({ blob: file, type: "bitmap", options: { imageOrientation: "from-image" } });
    } catch {
      throw new ProductPhotoProblem("picture");
    }
  }
}

async function encode(canvas: HTMLCanvasElement): Promise<Blob> {
  const as = (type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.82));
  const webp = await as("image/webp");
  const blob = webp && webp.type === "image/webp" ? webp : await as("image/jpeg");
  if (!blob) throw new ProductPhotoProblem("picture");
  return blob;
}

export async function drawProductPhoto(file: File): Promise<DrawnProductPhoto> {
  if (file.size > MAX_PHOTO_FILE_BYTES) throw new ProductPhotoProblem("too_big");
  const bitmap = await open(file);
  try {
    if (bitmap.width < 1 || bitmap.height < 1) throw new ProductPhotoProblem("picture");
    const draw = async (max: number) => {
      const width = Math.min(max, bitmap.width);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = Math.max(1, Math.round((bitmap.height * width) / bitmap.width));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new ProductPhotoProblem("picture");
      // a see-through PNG gets a white background (the product page's cards are white)
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return { blob: await encode(canvas), width: canvas.width, height: canvas.height };
    };
    const large = await draw(1600);
    const small = bitmap.width > 800 ? (await draw(800)).blob : null;
    return { large: large.blob, small, width: large.width, height: large.height };
  } finally {
    bitmap.close();
  }
}
