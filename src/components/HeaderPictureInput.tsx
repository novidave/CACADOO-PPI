"use client";

import { useRef } from "react";
import { useFormStatus } from "react-dom";

/**
 * The header picture of the shop's own domain (database update 28): once chosen, the browser
 * makes it exactly 1600 and 800 px wide (its own proportions; WebP, JPEG where the browser cannot
 * write WebP; the photo's place data does not survive the redraw) and sends the form straight
 * away. The server checks both again. Must be placed inside the header picture <form>.
 */
async function resized(file: File, width: number, name: string): Promise<File | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.max(1, Math.round((bitmap.height * width) / bitmap.width));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const encode = (type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.82));
    const webp = await encode("image/webp");
    const blob = webp && webp.type === "image/webp" ? webp : await encode("image/jpeg");
    if (!blob) return null;
    return new File([blob], `${name}.${blob.type === "image/webp" ? "webp" : "jpg"}`, { type: blob.type });
  } catch {
    return null;
  }
}

export function HeaderPictureInput({ label, busy }: { label: string; busy: string }) {
  const input = useRef<HTMLInputElement>(null);
  const large = useRef<HTMLInputElement>(null);
  const small = useRef<HTMLInputElement>(null);
  const { pending } = useFormStatus();

  async function chosen(event: React.ChangeEvent<HTMLInputElement>) {
    const field = event.currentTarget;
    const file = field.files?.[0];
    if (!file) return;
    const [big, little] = await Promise.all([resized(file, 1600, "header"), resized(file, 800, "header-800")]);
    const put = (target: HTMLInputElement | null, value: File | null) => {
      if (!target || !value) return;
      const files = new DataTransfer();
      files.items.add(value);
      target.files = files.files;
    };
    put(large.current, big);
    put(small.current, little);
    field.value = "";
    field.form?.requestSubmit();
  }

  return (
    <>
      <input ref={input} type="file" accept="image/*" onChange={chosen} className="sr-only" tabIndex={-1} data-header-file />
      <input ref={large} name="header" type="file" className="hidden" tabIndex={-1} aria-hidden="true" />
      <input ref={small} name="header_small" type="file" className="hidden" tabIndex={-1} aria-hidden="true" />
      <button
        type="button"
        disabled={pending}
        onClick={() => input.current?.click()}
        className="self-start rounded border border-foreground px-3 py-1.5 font-medium disabled:border-line disabled:text-muted"
      >
        {pending ? busy : label}
      </button>
    </>
  );
}
