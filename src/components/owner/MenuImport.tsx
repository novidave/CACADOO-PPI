"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { saveImport } from "@/app/[lang]/(account)/dashboard/assistant/orders/menu/actions";
import { allergensFromText, type ImportRow } from "@/lib/menuRules";
import { buttonClass, fieldClass, ghostClass } from "./ui";

const MAX_SIDE = 1568;
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));
const isHeic = (file: File) => /^image\/hei[cf]/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);

/** The photo upright, at most 1568 px, as a JPEG (white behind see-through parts, none of the photo's data). */
async function jpegBase64(source: Blob): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source, { imageOrientation: "from-image" });
  } catch (e) {
    if (!(source instanceof File) || !isHeic(source)) throw e;
    const { heicTo } = await import("heic-to/next");
    bitmap = (await heicTo({ blob: source, type: "bitmap", options: { imageOrientation: "from-image" } })) as ImageBitmap;
  }
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) throw new Error("no JPEG");
    const url = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
    return url.slice(url.indexOf(",") + 1);
  } finally {
    bitmap.close();
  }
}

/** A PDF in this browser: the text of its first 5 pages, or (a scan) the first page as a picture. */
async function pdfInput(file: File): Promise<{ text?: string; image?: string }> {
  const { openPdf, readText, pagePicture } = await import("@/lib/pdfRead");
  const { doc, close } = await openPdf(file);
  try {
    const parts: string[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, 5); n++) parts.push(await readText(doc, n));
    const text = parts.join("\n\n").trim();
    if (text.length >= 40) return { text };
    const page = await pagePicture(doc, 1);
    return { image: await jpegBase64(page.blob) };
  } finally {
    await close();
  }
}

interface Row extends ImportRow {
  key: string;
  on: boolean;
  allergensText: string;
}

let seq = 0;

/**
 * "Nahrať jedálny lístok" (update 80): a PDF or a photo of the menu, read in this browser (the PDF's text, or the
 * photo shrunk to ≤ 1568 px) and sent to /api/owner/menu/read (Claude proposes; 10 a day per shop). The review table:
 * every row editable (category, name, description, price or sizes, allergens, tags) and its own "Pridať" tick.
 * "Uložiť do menu" saves the ticked rows in ONE transaction (owner_menu_import_save); nothing is stored before it,
 * and the prices are exactly what the owner confirmed here.
 */
export function MenuImport({ shopId, slug, labels }: { shopId: string; slug: string; labels: Record<string, string> }) {
  const L = labels;
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"" | "reading" | "saving">("");
  const [problem, setProblem] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [left, setLeft] = useState<number | null>(null);

  const read = async (file: File) => {
    setProblem("");
    setRows(null);
    const pdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    if (!pdf && !/^image\//.test(file.type) && !isHeic(file)) return setProblem(L.err_file);
    setBusy("reading");
    try {
      const body = pdf ? await pdfInput(file) : { image: await jpegBase64(file) };
      const response = await fetch("/api/owner/menu/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop_id: shopId, ...body }),
      });
      const data = await response.json().catch(() => ({ error: "failed" }));
      if (!response.ok || data.error) {
        setProblem(data.error === "import_limit" ? L.err_import_limit : data.error === "ai_off" ? L.err_ai_off : L.err_import_failed);
        return;
      }
      const found = (Array.isArray(data.rows) ? data.rows : []) as ImportRow[];
      setLeft(typeof data.left === "number" ? data.left : null);
      if (!found.length) return setProblem(L.im_none);
      setRows(found.map((r) => ({ ...r, key: `r${++seq}`, on: true, allergensText: r.allergens.join(", ") })));
    } catch {
      setProblem(L.err_import_failed);
    } finally {
      setBusy("");
      if (input.current) input.current.value = "";
    }
  };

  const edit = (key: string, change: Partial<Row>) => setRows((now) => now && now.map((r) => (r.key === key ? { ...r, ...change } : r)));
  const chosen = rows?.filter((r) => r.on) ?? [];

  const save = async () => {
    if (!chosen.length) return setProblem(L.err_rows);
    setBusy("saving");
    setProblem("");
    const result = await saveImport(
      shopId,
      slug,
      chosen.map((r) => ({
        category: r.category,
        name: r.name,
        description: r.description,
        price: r.variants.length ? "" : r.price,
        variants: r.variants.filter((v) => v.label || v.price),
        allergens: allergensFromText(r.allergensText),
        tags: r.tags,
      })),
    ).catch(() => ({ ok: false as const, error: "err_failed" }));
    setBusy("");
    if (!result.ok) return setProblem(L[result.error] ?? L.err_failed);
    setRows(null);
    router.replace(`?${new URLSearchParams({ shop: slug, ok: "ok_imported", n: String(result.dishes) })}`, { scroll: false });
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-3" data-menu-import>
      <p className="text-sm text-muted">{L.im_intro}</p>
      <div className="flex flex-wrap items-center gap-3">
        <label className={`${buttonClass} cursor-pointer ${busy ? "pointer-events-none opacity-60" : ""}`}>
          {busy === "reading" ? L.im_reading : L.im_pick}
          <input
            ref={input}
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
            className="sr-only"
            disabled={Boolean(busy)}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void read(file);
            }}
            data-menu-import-file
          />
        </label>
        {left !== null && <span className="text-sm text-muted">{fill(L.im_left, { n: left })}</span>}
      </div>
      {problem && (
        <p role="alert" className="rounded-lg border border-[#D64545] p-3" data-menu-import-problem>
          {problem}
        </p>
      )}
      {rows && (
        <div className="flex flex-col gap-3" data-menu-import-review>
          <h3 className="text-[17px] font-bold">{L.im_review}</h3>
          <p className="text-sm">{L.im_price_check}</p>
          <ol className="flex flex-col gap-3">
            {rows.map((r, i) => (
              <li key={r.key} className={`flex flex-col gap-2 rounded-xl border p-3 ${r.on ? "border-[#E4E4E4]" : "border-dashed border-[#D6D6D6] opacity-70"}`} data-import-row={i + 1}>
                <label className="flex min-h-11 items-center gap-2 font-semibold">
                  <input type="checkbox" checked={r.on} onChange={(e) => edit(r.key, { on: e.target.checked })} className="h-5 w-5" />
                  {fill(L.im_row, { n: i + 1 })} · {L.im_include}
                </label>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-sm font-semibold">
                    {L.im_col_category}
                    <input value={r.category} maxLength={60} onChange={(e) => edit(r.key, { category: e.target.value })} className={fieldClass} />
                  </label>
                  <label className="flex flex-col gap-1 text-sm font-semibold">
                    {L.im_col_name}
                    <input value={r.name} maxLength={200} onChange={(e) => edit(r.key, { name: e.target.value })} className={fieldClass} data-import-name />
                  </label>
                </div>
                <label className="flex flex-col gap-1 text-sm font-semibold">
                  {L.im_col_description}
                  <input value={r.description} maxLength={600} onChange={(e) => edit(r.key, { description: e.target.value })} className={fieldClass} />
                </label>
                {r.variants.length === 0 ? (
                  <label className="flex w-40 flex-col gap-1 text-sm font-semibold">
                    {L.im_col_price}
                    <input value={r.price} inputMode="decimal" maxLength={12} onChange={(e) => edit(r.key, { price: e.target.value })} className={fieldClass} data-import-price />
                  </label>
                ) : (
                  <fieldset className="flex flex-col gap-2">
                    <legend className="text-sm font-semibold">{L.im_col_sizes}</legend>
                    {r.variants.map((v, j) => (
                      <div key={j} className="flex items-end gap-2">
                        <span className="min-w-0 flex-1">
                          <input
                            aria-label={`${L.ed_size_label} ${j + 1}`}
                            value={v.label}
                            maxLength={40}
                            onChange={(e) => edit(r.key, { variants: r.variants.map((x, k) => (k === j ? { ...x, label: e.target.value } : x)) })}
                            className={fieldClass}
                          />
                        </span>
                        <span className="w-28 flex-none">
                          <input
                            aria-label={`${L.im_col_price} ${j + 1}`}
                            value={v.price}
                            inputMode="decimal"
                            maxLength={12}
                            onChange={(e) => edit(r.key, { variants: r.variants.map((x, k) => (k === j ? { ...x, price: e.target.value } : x)) })}
                            className={fieldClass}
                            data-import-size-price
                          />
                        </span>
                        <button
                          type="button"
                          className="flex h-[52px] w-11 flex-none items-center justify-center rounded-lg border border-[#E4E4E4]"
                          aria-label={`${L.ed_size_remove} ${j + 1}`}
                          onClick={() => edit(r.key, { variants: r.variants.filter((_, k) => k !== j) })}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                    <p className="text-[13px] text-muted">{L.im_sizes_hint}</p>
                  </fieldset>
                )}
                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex w-40 flex-col gap-1 text-sm font-semibold">
                    {L.im_col_allergens}
                    <input value={r.allergensText} maxLength={60} onChange={(e) => edit(r.key, { allergensText: e.target.value })} className={fieldClass} placeholder="1, 7" />
                  </label>
                  <fieldset className="flex flex-wrap items-center gap-3">
                    <legend className="sr-only">{L.im_col_tags}</legend>
                    {(["veg", "spicy"] as const).map((tag) => (
                      <label key={tag} className="flex min-h-11 items-center gap-2 text-sm font-semibold">
                        <input
                          type="checkbox"
                          checked={r.tags.includes(tag)}
                          onChange={(e) => edit(r.key, { tags: e.target.checked ? [...r.tags, tag] : r.tags.filter((t) => t !== tag) })}
                          className="h-5 w-5"
                        />
                        {tag === "veg" ? L.tag_veg : L.tag_spicy}
                      </label>
                    ))}
                  </fieldset>
                </div>
                <p className="text-[13px] text-muted">{L.im_allergens_hint}</p>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-3">
            <button type="button" className={buttonClass} onClick={() => void save()} disabled={busy === "saving" || chosen.length === 0} data-menu-import-save>
              {fill(L.im_save, { n: chosen.length })}
            </button>
            <button type="button" className={ghostClass} onClick={() => setRows(null)}>
              {L.im_discard}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
