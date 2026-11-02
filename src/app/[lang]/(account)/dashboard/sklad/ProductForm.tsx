import type { ReactNode } from "react";
import { PendingButton } from "@/components/PendingButton";
import { SKLAD_UNITS } from "@/lib/sklad";
import { saveProduct } from "./actions";
import type { SkladTexts } from "./parts";

export interface ProductFields {
  id?: string;
  name?: string;
  code?: string;
  ean?: string | null;
  brand?: string | null;
  description?: string | null;
  unit?: string;
  vat_rate?: number;
  sale_price?: number | null;
  min_qty?: number;
  shelf?: string | null;
  supplier?: string | null;
}

const input = "min-h-12 rounded-xl border border-[#D6D6D6] px-3 text-base outline-none focus:border-foreground";
const num = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n).replace(".", ","));

function F({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm font-semibold">
      {label}
      {children}
      {hint && <span className="text-[13px] font-normal text-muted">{hint}</span>}
    </label>
  );
}

/**
 * "Nový produkt" / "Upraviť" (screens 4–5): name, code (empty = the next free one), EAN (the scanner fills it in), brand,
 * the sale price with VAT (empty = not on the shop page), VAT rate, unit, minimum, shelf, description; the supplier
 * is private ("Vidíte len vy"). Purchase prices come from receipts, never typed here.
 */
export function ProductForm({
  s,
  hidden,
  p,
  saving,
  cancelHref,
}: {
  s: SkladTexts;
  hidden: (extra?: Record<string, string>) => ReactNode;
  p: ProductFields;
  saving: string;
  cancelHref: string;
}) {
  return (
    <form action={saveProduct} className="flex flex-col gap-4 rounded-xl border-2 border-foreground p-4" data-sklad-form>
      {hidden({ ...(p.id ? { item_id: p.id, back: `/products/${p.id}` } : { back: "/products/new" }) })}
      <F label={s.f_name}>
        <input name="name" required maxLength={300} defaultValue={p.name ?? ""} className={input} autoComplete="off" />
      </F>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <F label={s.f_code} hint={p.id ? undefined : s.f_code_hint}>
          <input name="code" maxLength={100} defaultValue={p.code ?? ""} className={input} autoComplete="off" />
        </F>
        <F label={s.f_ean}>
          <input name="ean" maxLength={32} inputMode="numeric" defaultValue={p.ean ?? ""} className={input} autoComplete="off" data-scan-fill />
        </F>
        <F label={s.f_price} hint={s.f_price_hint}>
          <input name="sale_price" inputMode="decimal" defaultValue={num(p.sale_price)} className={input} autoComplete="off" />
        </F>
        <F label={s.f_vat}>
          <input name="vat_rate" inputMode="decimal" defaultValue={num(p.vat_rate ?? 23)} className={input} required autoComplete="off" />
        </F>
        <F label={s.f_unit}>
          <select name="unit" defaultValue={p.unit ?? "ks"} className={`${input} bg-white`}>
            {SKLAD_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </F>
        <F label={s.f_min} hint={s.f_min_hint}>
          <input name="min_qty" inputMode="decimal" defaultValue={num(p.min_qty ?? 0)} className={input} autoComplete="off" />
        </F>
        <F label={s.f_brand}>
          <input name="brand" maxLength={100} defaultValue={p.brand ?? ""} className={input} autoComplete="off" />
        </F>
        <F label={s.f_shelf}>
          <input name="shelf" maxLength={80} defaultValue={p.shelf ?? ""} className={input} autoComplete="off" />
        </F>
      </div>
      <F label={s.f_description} hint={s.f_description_hint}>
        <textarea name="description" maxLength={5000} rows={3} defaultValue={p.description ?? ""} className={`${input} py-2`} />
      </F>
      <F label={s.f_supplier} hint={s.private_hint}>
        <input name="supplier" maxLength={120} defaultValue={p.supplier ?? ""} className={input} autoComplete="off" />
      </F>
      <div className="flex flex-wrap gap-2">
        <PendingButton pending={saving}>{p.id ? s.save : s.create}</PendingButton>
        <a href={cancelHref} className="inline-flex min-h-11 items-center px-2 text-sm underline underline-offset-4">
          {s.cancel}
        </a>
      </div>
    </form>
  );
}
