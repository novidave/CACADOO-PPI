import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";

export async function generateMetadata({ params }: PageProps<"/[lang]/podmienky-domeny">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).terms.domain_title };
}

/**
 * Podmienky registrácie domény: a placeholder until the operator adds the full text. What is
 * already true is stated: Websupport is the registrar and the shop is the domain's owner.
 */
export default async function DomainTermsPage({ params }: PageProps<"/[lang]/podmienky-domeny">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const t = (await getDictionary(lang)).terms;
  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{t.domain_title}</h1>
      <p>{t.domain_todo}</p>
      <ul className="flex list-disc flex-col gap-1 pl-6">
        <li>{t.domain_p1}</li>
        <li>{t.domain_p2}</li>
        <li>{t.domain_p3}</li>
        <li>{t.domain_p4}</li>
      </ul>
    </article>
  );
}
