import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, indexedLocales } from "@/i18n/dictionaries";
import { pageAlternates } from "@/lib/site";

export async function generateMetadata({ params }: PageProps<"/[lang]/pravne-informacie">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const dict = await getDictionary(lang);
  return {
    title: dict.legal.title,
    description: dict.legal.intro,
    alternates: pageAlternates(lang, "/pravne-informacie", await indexedLocales()),
  };
}

/**
 * "Právne informácie" (2026-11-01, at the owner's request; linked from the footer): one page that leads to every legal
 * document of Cacaduu — privacy (GDPR), the shop assistant's privacy, deleting data, the terms
 * and the domain terms. It only points to the documents; their wording stays on their own pages (legal texts change only
 * with the owner's OK).
 */
export default async function LegalPage({ params }: PageProps<"/[lang]/pravne-informacie">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  const l = dict.legal;
  const docs: [string, string, string][] = [
    [`/${lang}/sukromie`, dict.privacy.title, l.privacy_desc],
    [`/${lang}/sukromie-asistent`, dict.privacy_assistant.title, l.assistant_desc],
    [`/${lang}/sukromie/vymazanie-udajov`, dict.privacy.deletion_title, l.deletion_desc],
    [`/${lang}/podmienky`, dict.terms.title, l.terms_desc],
    [`/${lang}/podmienky-domeny`, dict.terms.domain_title, l.domain_desc],
  ];
  return (
    <article className="mx-auto flex max-w-2xl flex-col gap-4" data-legal>
      <h1 className="text-2xl font-semibold tracking-tight">{l.title}</h1>
      <p>{l.intro}</p>
      <ul className="flex flex-col border-t border-line">
        {docs.map(([href, title, desc]) => (
          <li key={href} className="border-b border-line">
            <Link href={href} className="flex min-h-11 flex-col gap-0.5 py-3 hover:underline">
              <span className="font-semibold">{title}</span>
              <span className="text-sm text-muted">{desc}</span>
            </Link>
          </li>
        ))}
      </ul>
    </article>
  );
}
