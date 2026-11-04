import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { ownerAiReady } from "@/lib/grammar";
import { DbError } from "@/components/DbError";
import { AssistantChat } from "@/components/owner/AssistantChat";
import { chooseShop } from "../contacts/parts";

export async function generateMetadata({ params }: PageProps<"/[lang]/dashboard/pomocnik">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).pomocnik.title };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * The AI pomocník on a phone or a tablet (2026-11-04): ONLY the chat — under the shell's top bar (the menu button and
 * "AI pomocník") the conversation fills the screen and the question box stays at the bottom, above the keyboard and the
 * phone's safe area. The same conversation as the computer's side panel (@/lib/assistantStore).
 */
export default async function PomocnikPage({ params, searchParams }: PageProps<"/[lang]/dashboard/pomocnik">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const chosen = await chooseShop(session.supabase, first(sp.shop));
  if (chosen.error) return <DbError message={chosen.error} dict={dict} />;
  if (!chosen.shop) redirect(`/${lang}/dashboard`);
  const p = dict.pomocnik;
  return (
    <div className="-mx-4 -my-5 flex h-[calc(100dvh-56px)] flex-col md:-mx-6 lg:-mx-8 lg:h-svh" data-pomocnik-page>
      <h1 className="sr-only">{p.title}</h1>
      {ownerAiReady() ? (
        <AssistantChat lang={lang} shop={chosen.shop.slug} texts={p as Record<string, string>} variant="page" />
      ) : (
        <p className="p-4 text-sm">{p.err_ai_off}</p>
      )}
    </div>
  );
}
