import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale, locales } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { pageAlternates } from "@/lib/site";

export async function generateMetadata({ params }: PageProps<"/[lang]/sukromie-asistent">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const dict = await getDictionary(lang);
  return { title: dict.privacy_assistant.title, alternates: pageAlternates(lang, "/sukromie-asistent", locales) };
}

/**
 * What the shop assistant's archive keeps, who sees it, for how long and how to delete it
 * (linked from the line under the chat box). TODO: the final legal text from Cacadoo
 * replaces this draft (texts in privacy_assistant.* in the three message files).
 */
export default async function AssistantPrivacyPage({ params }: PageProps<"/[lang]/sukromie-asistent">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const p = (await getDictionary(lang)).privacy_assistant;
  const parts: [string, string][] = [
    [p.what_title, p.what],
    [p.who_title, p.who],
    [p.time_title, p.time],
    [p.delete_title, p.delete],
  ];
  return (
    <article className="mx-auto flex max-w-2xl flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{p.title}</h1>
      <p className="text-sm text-muted">{p.draft}</p>
      {parts.map(([heading, text]) => (
        <section key={heading} className="flex flex-col gap-1">
          <h2 className="font-semibold">{heading}</h2>
          <p>{text}</p>
        </section>
      ))}
    </article>
  );
}
