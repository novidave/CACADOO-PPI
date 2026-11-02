import type { Metadata } from "next";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { DbError } from "@/components/DbError";
import { loadSklad } from "../../parts";
import { ReceiptEditor } from "../editor";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/sklad/receipts/new">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const s = (await getDictionary(lang)).sklad;
  return { title: `${s.rc_new_title} · ${s.title}` };
}

/** "+ Nová príjemka": an empty receipt with its own id; the draft is made on the first "Uložiť koncept" / "Potvrdiť". */
export default async function SkladReceiptNew({ params, searchParams }: PageProps<"/[lang]/dashboard/sklad/receipts/new">) {
  const { lang } = await params;
  const sp = await searchParams;
  const ctx = await loadSklad(lang, sp);
  if (!ctx.ok) return <DbError message={ctx.error} dict={ctx.dict} />;
  return <ReceiptEditor ctx={ctx} receipt={null} sp={sp} />;
}
