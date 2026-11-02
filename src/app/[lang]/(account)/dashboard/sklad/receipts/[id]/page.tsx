import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { DbError } from "@/components/DbError";
import type { ReceiptJson } from "../../actions";
import { discardReceipt } from "../../actions";
import { loadSklad, UUID } from "../../parts";
import { ReceiptEditor } from "../editor";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/sklad/receipts/[id]">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const s = (await getDictionary(lang)).sklad;
  return { title: `${s.tab_receipts} · ${s.title}` };
}

/** A saved receipt: a draft to finish, or a confirmed one to read (never changed). */
export default async function SkladReceipt({ params, searchParams }: PageProps<"/[lang]/dashboard/sklad/receipts/[id]">) {
  const { lang, id } = await params;
  const sp = await searchParams;
  if (!UUID.test(id)) notFound();
  const ctx = await loadSklad(lang, sp);
  if (!ctx.ok) return <DbError message={ctx.error} dict={ctx.dict} />;
  const { data, error } = await ctx.session.supabase.rpc("owner_sklad_receipt", { p_shop_id: ctx.shop.id, p_id: id });
  if (error) return <DbError message={error.message} dict={ctx.dict} />;
  if (!data) notFound();
  const receipt = data as ReceiptJson;
  return (
    <>
      <ReceiptEditor ctx={ctx} receipt={receipt} sp={sp} />
      {receipt.status === "draft" && (
        <form action={discardReceipt} className="mt-4 max-w-5xl">
          {ctx.hidden({ receipt_id: receipt.id, back: `/receipts/${receipt.id}` })}
          <button type="submit" className="min-h-11 font-semibold underline underline-offset-4">
            {ctx.s.rc_discard}
          </button>
        </form>
      )}
    </>
  );
}
