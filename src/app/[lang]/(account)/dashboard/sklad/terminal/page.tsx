import type { Metadata } from "next";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { DbError } from "@/components/DbError";
import { SkladTerminal, type TerminalLabels } from "@/components/SkladTerminal";
import { loadSklad } from "../parts";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/sklad/terminal">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const s = (await getDictionary(lang)).sklad;
  return { title: `${s.term_title} · ${s.title}` };
}

const LABELS = [
  "term_connected", "term_awake", "term_welcome", "term_due", "term_ready", "term_ready_text", "term_tx", "term_tx_line",
  "term_confirm_text", "term_paid", "term_thanks", "term_saved", "term_next", "term_cancel", "term_offline", "term_divider",
  "term_customer", "term_shop", "qr_scan_hint", "qr_waiting", "qr_alt", "qr_close", "err_failed",
] as const satisfies readonly (keyof TerminalLabels)[];

/**
 * The QR terminal (database update 68): opened on a spare phone at the counter by an owner; the whole screen is the
 * terminal (SkladTerminal). Its state comes from SQL (owner_sklad_terminal) through /api/owner/sklad/terminal.
 */
export default async function SkladTerminalPage({ params, searchParams }: PageProps<"/[lang]/dashboard/sklad/terminal">) {
  const { lang } = await params;
  const sp = await searchParams;
  const ctx = await loadSklad(lang, sp);
  if (!ctx.ok) return <DbError message={ctx.error} dict={ctx.dict} />;
  const labels = Object.fromEntries(LABELS.map((k) => [k, (ctx.s as Record<string, string>)[k]])) as TerminalLabels;
  return <SkladTerminal lang={ctx.lang} shopId={ctx.shop.id} shopSlug={ctx.shop.slug} exitHref={ctx.href("/sale")} labels={labels} />;
}
