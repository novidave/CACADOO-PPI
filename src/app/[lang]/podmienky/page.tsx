import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";

export async function generateMetadata({ params }: PageProps<"/[lang]/podmienky">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).terms.title };
}

/** Obchodné podmienky: a placeholder until the operator adds the full text. */
export default async function TermsPage({ params }: PageProps<"/[lang]/podmienky">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const t = (await getDictionary(lang)).terms;
  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{t.title}</h1>
      <p>{t.todo}</p>
    </article>
  );
}
