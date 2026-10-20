/**
 * A blog photo drawn in the owner's browser (database update 37): at most 1600 px wide, and an 800 px copy when it is
 * wider than that; never made larger. WebP at quality 0.82 (JPEG where the browser cannot write WebP). Redrawing also
 * drops the photo's own data (place, camera). Throws when the browser cannot open the picture (e.g. HEIC outside Safari).
 */
export interface DrawnPhoto {
  large: Blob;
  small: Blob | null;
  width: number;
  height: number;
}

async function encode(canvas: HTMLCanvasElement): Promise<Blob> {
  const as = (type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.82));
  const webp = await as("image/webp");
  const blob = webp && webp.type === "image/webp" ? webp : await as("image/jpeg");
  if (!blob) throw new Error("The photo could not be drawn");
  return blob;
}

export async function drawBlogPhoto(file: Blob): Promise<DrawnPhoto> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const draw = async (max: number) => {
      const width = Math.min(max, bitmap.width);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = Math.max(1, Math.round((bitmap.height * width) / bitmap.width));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("The photo could not be drawn");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
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
