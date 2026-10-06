import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { getSession } from "@/lib/auth";
import { authErrorText } from "@/lib/authErrors";
import { AuthField, AuthNotice } from "@/components/AuthField";
import { signIn } from "./actions";

export const metadata: Metadata = { robots: { index: false } };

export default async function LoginPage({ params, searchParams }: PageProps<"/[lang]/login">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const dict = await getDictionary(lang);

  const session = await getSession().catch(() => null);
  if (session) redirect(`/${lang}/dashboard`);

  const sp = await searchParams;
  const errorText = authErrorText(dict, sp.error, sp.message);

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{dict.login.title}</h1>
      <p className="text-muted">{dict.login.intro}</p>
      {errorText && <AuthNotice text={errorText} />}

      <form action={signIn} className="flex flex-col gap-3">
        <input type="hidden" name="lang" value={lang} />
        <AuthField label={dict.login.email} type="email" name="email" required autoComplete="email" />
        <AuthField label={dict.login.password} type="password" name="password" required autoComplete="current-password" />
        <button type="submit" className="rounded border border-foreground px-4 py-2 font-medium">
          {dict.login.login}
        </button>
      </form>
      <Link href={`/${lang}/forgot`} className="text-sm underline underline-offset-4">
        {dict.login.forgot_link}
      </Link>
      <p className="border-t border-line pt-4">
        {dict.login.no_account}{" "}
        <Link href={`/${lang}/signup`} className="font-semibold underline underline-offset-4">
          {dict.login.signup_link}
        </Link>
      </p>
    </div>
  );
}
