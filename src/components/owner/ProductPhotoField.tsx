"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { functionFailure } from "@/lib/functionError";
import { drawProductPhoto, ProductPhotoProblem } from "@/lib/productPhotoDraw";
import { productPhotoChanged } from "@/app/[lang]/(account)/dashboard/items/photoActions";

export interface ProductPhotoLabels {
  title: string;
  help: string;
  upload: string;
  change: string;
  remove: string;
  remove_confirm: string;
  uploading: string;
  removing: string;
  saved: string;
  removed: string;
  none: string;
  error_too_big: string;
  error_picture: string;
  error_failed: string;
  preview_alt: string;
}

/**
 * "Fotka produktu" (database update 78): ONE photo per product, shown only on its product page. "Nahrať fotku" /
 * "Zmeniť fotku" (a new one replaces the old one — its files are deleted) and "Odstrániť fotku". The picture is drawn
 * here (1600 + 800 px WebP, upright, without its own data; HEIC too) and sent to the product-photos function, which
 * checks it by its bytes and the owner's membership. On a phone the picker offers the camera too.
 */
export function ProductPhotoField({
  lang,
  itemId,
  photo,
  labels,
}: {
  lang: string;
  itemId: string;
  /** The current photo's 800 px address, or null. */
  photo: { src: string; width: number; height: number } | null;
  labels: ProductPhotoLabels;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState(photo);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [, startRefresh] = useTransition();

  const failed = async (e: unknown) => {
    if (e instanceof ProductPhotoProblem) return e.code === "too_big" ? labels.error_too_big : labels.error_picture;
    const f = await functionFailure(e);
    return f.error === "picture" ? labels.error_picture : `${labels.error_failed} (${f.error ?? f.detail})`;
  };

  const upload = async (file: File) => {
    setStatus(null);
    setBusy("upload");
    try {
      const drawn = await drawProductPhoto(file);
      const form = new FormData();
      form.set("item_id", itemId);
      form.set("large", drawn.large, "large");
      if (drawn.small) form.set("small", drawn.small, "small");
      const { error } = await createClient().functions.invoke("product-photos?action=upload", { body: form, method: "POST" });
      if (error) throw error;
      setPreview({ src: URL.createObjectURL(drawn.small ?? drawn.large), width: drawn.width, height: drawn.height });
      setStatus({ ok: true, text: labels.saved });
      await productPhotoChanged(lang, itemId);
      startRefresh(() => router.refresh());
    } catch (e) {
      setStatus({ ok: false, text: await failed(e) });
    } finally {
      setBusy(null);
      if (input.current) input.current.value = "";
    }
  };

  const remove = async () => {
    if (!window.confirm(labels.remove_confirm)) return;
    setStatus(null);
    setBusy("remove");
    try {
      const { error } = await createClient().functions.invoke("product-photos", { body: { action: "remove", item_id: itemId }, method: "POST" });
      if (error) throw error;
      setPreview(null);
      setStatus({ ok: true, text: labels.removed });
      await productPhotoChanged(lang, itemId);
      startRefresh(() => router.refresh());
    } catch (e) {
      setStatus({ ok: false, text: await failed(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-[#E4E4E4] bg-white p-[18px]" aria-labelledby="product-photo-title" data-product-photo-field>
      <h2 id="product-photo-title" className="text-[17px] font-bold">
        {labels.title}
      </h2>
      <p className="text-sm text-muted">{labels.help}</p>
      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element -- the shop's own photo (800 px) or the picture just drawn
        <img
          src={preview.src}
          alt={labels.preview_alt}
          width={Math.min(800, preview.width)}
          height={Math.round((preview.height * Math.min(800, preview.width)) / preview.width)}
          className="h-auto max-h-72 w-auto max-w-full self-start rounded-xl border border-[#ECE7DE] object-contain"
          data-product-photo-preview
        />
      ) : (
        <p className="text-sm" data-product-photo-none>
          {labels.none}
        </p>
      )}
      <div className="flex flex-wrap gap-2.5">
        <label className={`inline-flex min-h-12 cursor-pointer items-center justify-center rounded-xl bg-[#111] px-5 text-[15px] font-bold text-white ${busy ? "pointer-events-none opacity-60" : ""}`}>
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
            className="sr-only"
            disabled={busy !== null}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
            data-product-photo-input
          />
          {busy === "upload" ? labels.uploading : preview ? labels.change : labels.upload}
        </label>
        {preview && (
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy !== null}
            className="inline-flex min-h-12 items-center justify-center rounded-xl border border-[#D6D6D6] bg-white px-5 text-[15px] font-bold disabled:opacity-60"
            data-product-photo-remove
          >
            {busy === "remove" ? labels.removing : labels.remove}
          </button>
        )}
      </div>
      <p role="status" aria-live="polite" className={`text-sm ${status?.ok === false ? "font-semibold text-[#B91C1C]" : ""}`} data-product-photo-status>
        {status?.text ?? ""}
      </p>
    </section>
  );
}
