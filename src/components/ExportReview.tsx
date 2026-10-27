"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { describeItems, saveExportReview } from "@/app/[lang]/(account)/sync/exportActions";

/** owner_export_review() */
export interface ReviewState {
  needed: boolean;
  confirmed: boolean;
  new_columns: string[];
  free_fields: string[];
  new_products: number;
  changed_products: number;
  langs: string[];
  saved_langs: string[];
  main_lang: string;
  max_langs: number;
  remember: boolean;
  describe: boolean;
}

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

/**
 * "Nový súbor – skontrolujte" (database update 45), shown only when something waits for a decision: the file's new
 * columns (a free field or "Súkromné – nezobrazovať"; nothing is approved by itself), the new or changed products (the
 * languages they are translated into — the plan's number —, "Vygenerovať popisy" for them) and "Zapamätať a už sa
 * nepýtať". The database checks everything again (owner_save_export_review).
 */
export function ExportReview({
  shopId,
  slug,
  review,
  languages,
  fieldLabels,
  labels,
}: {
  shopId: string;
  slug: string;
  review: ReviewState;
  languages: { code: string; native: string }[];
  fieldLabels: Record<string, string>;
  labels: Record<string, string>;
}) {
  const router = useRouter();
  const [columns, setColumns] = useState<Record<string, string>>(() => Object.fromEntries(review.new_columns.map((c) => [c, "private"])));
  const [langs, setLangs] = useState<string[]>(() => (review.saved_langs.length ? review.saved_langs : review.langs).slice(0, review.max_langs));
  const [describe, setDescribe] = useState(review.describe);
  const [remember, setRemember] = useState(review.remember);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const products = review.new_products + review.changed_products;
  const others = languages.filter((l) => l.code !== review.main_lang);
  const taken = (column: string) => new Set(Object.entries(columns).filter(([c, f]) => c !== column && f !== "private").map(([, f]) => f));

  async function save() {
    setBusy(true);
    setMessage(null);
    const result = await saveExportReview({ shopId, slug, columns, langs: products ? langs : null, describe: products ? describe : review.describe, remember }).catch(
      () => ({ ok: false as const, error: "failed" }),
    );
    if (!result.ok) {
      setBusy(false);
      setMessage({ ok: false, text: labels[`error_${result.error}`] ?? labels.error_failed });
      return;
    }
    const ids = result.value.describeIds;
    let made = 0;
    for (let i = 0; i < ids.length; i += 20) {
      setMessage({ ok: true, text: fill(labels.describing, { done: i, total: ids.length }) });
      const r = await describeItems(slug, ids.slice(i, i + 20)).catch(() => null);
      if (r?.ok) made += r.value.made;
    }
    setBusy(false);
    setMessage({ ok: true, text: ids.length ? fill(labels.described, { n: made }) : labels.saved });
    router.refresh();
  }

  return (
    <section className="flex flex-col gap-4 border border-foreground p-4" aria-labelledby="export-review-title" data-export-review aria-busy={busy}>
      <div className="flex flex-col gap-1">
        <h3 id="export-review-title" className="text-lg font-semibold">
          {labels.title}
        </h3>
        <p className="text-sm">{labels.intro}</p>
      </div>

      {review.new_columns.length > 0 && (
        <fieldset className="flex flex-col gap-2" data-review-columns>
          <legend className="font-semibold">{labels.columns_title}</legend>
          <p className="text-sm text-muted">{labels.columns_hint}</p>
          {review.new_columns.map((column) => {
            const used = taken(column);
            return (
              <label key={column} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="min-w-32 font-medium break-all">{column}</span>
                <select
                  value={columns[column] ?? "private"}
                  onChange={(e) => setColumns((old) => ({ ...old, [column]: e.target.value }))}
                  className="rounded border border-line bg-white px-3 py-2"
                  data-review-column={column}
                >
                  <option value="private">{labels.private}</option>
                  {review.free_fields.map((f) => (
                    <option key={f} value={f} disabled={used.has(f)}>
                      {fieldLabels[`col_${f}`] ?? f}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </fieldset>
      )}

      {products > 0 && (
        <div className="flex flex-col gap-3" data-review-products>
          <p className="font-semibold" data-review-count>
            {fill(labels.products, { new: review.new_products, changed: review.changed_products })}
          </p>
          <fieldset className="flex flex-col gap-2" data-review-langs>
            <legend className="text-sm font-semibold">{labels.langs_title}</legend>
            <span className="text-sm text-muted">{fill(labels.langs_hint, { max: review.max_langs })}</span>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
              {others.map((l) => {
                const checked = langs.includes(l.code);
                return (
                  <label key={l.code} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && langs.length >= review.max_langs}
                      onChange={(e) => setLangs((old) => (e.target.checked ? [...old, l.code] : old.filter((c) => c !== l.code)))}
                      data-review-lang={l.code}
                    />
                    <span lang={l.code}>{l.native}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={describe} onChange={(e) => setDescribe(e.target.checked)} className="mt-1" data-review-describe />
            <span>{labels.describe}</span>
          </label>
        </div>
      )}

      <label className="flex items-start gap-2">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="mt-1" data-review-remember />
        <span className="flex flex-col">
          <span>{labels.remember}</span>
          <span className="text-sm text-muted">{labels.remember_hint}</span>
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={save} disabled={busy} className="rounded border border-foreground bg-foreground px-4 py-2 font-medium text-white disabled:opacity-60" data-review-save>
          {busy ? labels.saving : labels.save}
        </button>
        {message && (
          <span role={message.ok ? "status" : "alert"} className={message.ok ? "font-medium" : ""} data-review-message={message.ok ? "ok" : "error"}>
            {message.text}
          </span>
        )}
      </div>
    </section>
  );
}
