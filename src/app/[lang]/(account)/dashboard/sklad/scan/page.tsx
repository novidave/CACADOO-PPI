import { redirect } from "next/navigation";
import { SCAN_CODE } from "@/lib/sklad";
import { DbError } from "@/components/DbError";
import { first, loadSklad } from "../parts";

/**
 * Where a scan goes (the USB scanner anywhere on the Sklad pages, or the camera): a known code or EAN opens its product
 * card (?act= keeps the form that was open), an unknown one "Nový produkt" with the EAN filled in.
 */
export default async function SkladScan({ params, searchParams }: PageProps<"/[lang]/dashboard/sklad/scan">) {
  const { lang } = await params;
  const sp = await searchParams;
  const ctx = await loadSklad(lang, sp);
  if (!ctx.ok) return <DbError message={ctx.error} dict={ctx.dict} />;
  const code = (first(sp.code) ?? "").trim();
  if (!SCAN_CODE.test(code)) redirect(ctx.href("/products"));
  const { data, error } = await ctx.session.supabase.rpc("owner_sklad_find", { p_shop_id: ctx.shop.id, p_code: code });
  if (error) return <DbError message={error.message} dict={ctx.dict} />;
  if (data) redirect(ctx.href(`/products/${String(data)}`, { ok: "scanned" }));
  redirect(ctx.href("/products/new", { ean: code }));
}
