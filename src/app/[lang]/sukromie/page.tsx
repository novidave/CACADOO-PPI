import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale, locales } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { pageAlternates } from "@/lib/site";

export async function generateMetadata({ params }: PageProps<"/[lang]/sukromie">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const dict = await getDictionary(lang);
  return { title: dict.privacy.title, alternates: pageAlternates(lang, "/sukromie", locales) };
}

/**
 * Cacaduu PPI's privacy policy (the Meta app's "Privacy Policy URL"), with what happens to the data of a connected
 * Facebook Page (database update 37). TODO: the final legal text from Cacaduu replaces this draft (texts in privacy.*
 * in the three message files).
 */
export default async function PrivacyPage({ params }: PageProps<"/[lang]/sukromie">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  const p = dict.privacy;
  const parts: [string, string, string][] = [
    ["who", p.who_title, p.who],
    ["visitors", p.visitors_title, p.visitors],
    ["owners", p.owners_title, p.owners],
    ["facebook", p.facebook_title, p.facebook],
    ["contact", p.contact_title, p.contact],
  ];
  return (
    <article className="mx-auto flex max-w-2xl flex-col gap-4" data-privacy>
      <h1 className="text-2xl font-semibold tracking-tight">{p.title}</h1>
      <p className="text-sm text-muted" data-privacy-todo>
        {p.draft}
      </p>
      {parts.map(([id, heading, text]) => (
        <section key={id} id={id} className="flex flex-col gap-1">
          <h2 className="font-semibold">{heading}</h2>
          <p>{text}</p>
          {id === "facebook" && (
            <p>
              <Link href={`/${lang}/sukromie/vymazanie-udajov`} className="underline underline-offset-4">
                {p.deletion_link}
              </Link>
            </p>
          )}
          {id === "visitors" && (
            <p>
              <Link href={`/${lang}/sukromie-asistent`} className="underline underline-offset-4">
                {dict.privacy_assistant.title}
              </Link>
            </p>
          )}
        </section>
      ))}
    </article>
  );
}
