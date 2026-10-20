import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale, locales } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { pageAlternates } from "@/lib/site";

export async function generateMetadata({ params }: PageProps<"/[lang]/sukromie/vymazanie-udajov">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const dict = await getDictionary(lang);
  return { title: dict.privacy.deletion_title, alternates: pageAlternates(lang, "/sukromie/vymazanie-udajov", locales) };
}

/** How to delete the data Cacaduu PPI got from a Facebook Page: the Meta app's "Data Deletion Instructions URL". */
export default async function DataDeletionPage({ params }: PageProps<"/[lang]/sukromie/vymazanie-udajov">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const p = (await getDictionary(lang)).privacy;
  return (
    <article className="mx-auto flex max-w-2xl flex-col gap-4" data-data-deletion>
      <h1 className="text-2xl font-semibold tracking-tight">{p.deletion_title}</h1>
      <p>{p.deletion_intro}</p>
      <ol className="flex list-decimal flex-col gap-2 pl-6">
        <li>{p.deletion_step1}</li>
        <li>{p.deletion_step2}</li>
        <li>{p.deletion_step3}</li>
      </ol>
      <p>{p.deletion_contact}</p>
    </article>
  );
}
