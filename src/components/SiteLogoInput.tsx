"use client";

import { useRef } from "react";
import { useFormStatus } from "react-dom";

/** The header logo's size: at most 120 px high (40 px shown, sharp on 3× screens) and 600 px wide. */
const MAX_HEIGHT = 120;
const MAX_WIDTH = 600;

/**
 * The header logo of the shop's own domain (database update 31): once chosen, the browser makes
 * it at most 120 px high and 600 px wide (its own proportions, never larger than it is), keeps a
 * transparent background (WebP, PNG where the browser cannot write WebP; the picture's own data
 * does not survive the redraw) and sends the form straight away. The server checks it again.
 * Must be placed inside the header logo <form>.
 */
async function resized(file: File): Promise<File | null> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX_HEIGHT / bitmap.height, MAX_WIDTH / bitmap.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const encode = (type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.9));
    const webp = await encode("image/webp");
    const blob = webp && webp.type === "image/webp" ? webp : await encode("image/png");
    if (!blob) return null;
    return new File([blob], `site-logo.${blob.type === "image/webp" ? "webp" : "png"}`, { type: blob.type });
  } catch {
    return null;
  }
}

export function SiteLogoInput({ label, busy }: { label: string; busy: string }) {
  const input = useRef<HTMLInputElement>(null);
  const logo = useRef<HTMLInputElement>(null);
  const { pending } = useFormStatus();

  async function chosen(event: React.ChangeEvent<HTMLInputElement>) {
    const field = event.currentTarget;
    const file = field.files?.[0];
    if (!file) return;
    const made = await resized(file);
    if (made && logo.current) {
      const files = new DataTransfer();
      files.items.add(made);
      logo.current.files = files.files;
    }
    field.value = "";
    field.form?.requestSubmit();
  }

  return (
    <>
      <input ref={input} type="file" accept="image/png,image/webp,image/jpeg" onChange={chosen} className="sr-only" tabIndex={-1} data-site-logo-file />
      <input ref={logo} name="site_logo" type="file" className="hidden" tabIndex={-1} aria-hidden="true" />
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
