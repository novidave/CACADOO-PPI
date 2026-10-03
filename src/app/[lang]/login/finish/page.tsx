import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { safeNextPath } from "@/lib/auth";
import { FinishLogin } from "@/components/FinishLogin";

export const metadata: Metadata = { robots: { index: false } };

export default async function FinishLoginPage({ params, searchParams }: PageProps<"/[lang]/login/finish">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  const sp = await searchParams;
  const next = safeNextPath(typeof sp.next === "string" ? sp.next : null, `/${lang}/dashboard`);

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{dict.login.title}</h1>
      <FinishLogin next={next} lang={lang} labels={{ working: dict.login.finishing, failed: dict.login.error_link }} />
    </div>
  );
}
