"use client";

import { useRef } from "react";
import { useFormStatus } from "react-dom";

const MAX_SIDE = 512;

/** Shrinks a picture in the browser (at most 512 px, WebP), so photos of any size upload well under 1 MB. */
async function shrink(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
    return blob && blob.type === "image/webp" ? new File([blob], "logo.webp", { type: "image/webp" }) : file;
  } catch {
    return file; // the browser cannot read it: send as is, the server explains
  }
}

/**
 * One button for the logo: it opens the picture window and, once a picture is
 * chosen, shrinks it and uploads it straight away (no second click).
 * Must be placed inside the logo <form>.
 */
export function LogoInput({ label, busy }: { label: string; busy: string }) {
  const input = useRef<HTMLInputElement>(null);
  const { pending } = useFormStatus();

  async function chosen(event: React.ChangeEvent<HTMLInputElement>) {
    const field = event.currentTarget;
    const file = field.files?.[0];
    if (!file) return;
    if (file.type.startsWith("image/")) {
      const files = new DataTransfer();
      files.items.add(await shrink(file));
      field.files = files.files;
    }
    field.form?.requestSubmit();
  }

  return (
    <>
      <input ref={input} name="logo" type="file" accept="image/*" onChange={chosen} className="sr-only" tabIndex={-1} />
      <button
        type="button"
        disabled={pending}
        onClick={() => input.current?.click()}
        className="self-start rounded border border-foreground px-4 py-2 font-medium disabled:text-muted"
      >
        {pending ? busy : label}
      </button>
    </>
  );
}
