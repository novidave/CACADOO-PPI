import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { SkladTerminal, type TerminalLabels } from "@/components/SkladTerminal";
import { can, loadDevice, NotPaired } from "../device";

export async function generateMetadata({ params }: PageProps<"/[lang]/zariadenie/terminal">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).sklad.term_title };
}

/** The QR terminal on a phone paired with the "terminal" tick (database update 72): the whole screen is the terminal. */
export default async function DeviceTerminal({ params }: PageProps<"/[lang]/zariadenie/terminal">) {
  const { lang } = await params;
  const { s, d, device, lang: l } = await loadDevice(lang);
  if (!device) return <NotPaired lang={l} d={d} />;
  if (!can(device, "terminal")) notFound();
  const labels = Object.fromEntries(Object.entries(s as Record<string, string>).filter(([k]) => k.startsWith("term_") || k.startsWith("qr_") || k === "err_failed")) as TerminalLabels;
  return <SkladTerminal lang={l} shopId={device.shop.id} shopSlug={device.shop.slug} exitHref={`/${l}/zariadenie`} labels={labels} />;
}
