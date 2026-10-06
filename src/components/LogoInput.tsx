"use client";

const MAX_SIDE = 512;

/**
 * Logo file field that shrinks the picture in the browser (at most 512 px, WebP)
 * before the form is sent, so photos of any size upload well under the 1 MB limit.
 * If the browser cannot read the image, the original file is sent and the server explains.
 */
export function LogoInput() {
  async function shrink(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
      if (!blob || blob.type !== "image/webp") return;
      const files = new DataTransfer();
      files.items.add(new File([blob], "logo.webp", { type: "image/webp" }));
      input.files = files.files;
    } catch {
      // keep the original file
    }
  }

  return <input name="logo" type="file" accept="image/*" required onChange={shrink} className="text-sm" />;
}
