import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { DevicePairScreen } from "@/components/DevicePairScreen";

export async function generateMetadata({ params }: PageProps<"/[lang]/zariadenie/pripojit">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).device.pair_title };
}

/** The address of the QR code from Sklad → Nastavenia → Zariadenia (database update 72). */
export default async function DevicePair({ params }: PageProps<"/[lang]/zariadenie/pripojit">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = (await getDictionary(lang)).device as Record<string, string>;
  return <DevicePairScreen lang={lang} labels={d} />;
}
