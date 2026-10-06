import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { authErrorText } from "@/lib/authErrors";
import { AuthField, AuthNotice } from "@/components/AuthField";
import { sendPasswordReset } from "../login/actions";

export const metadata: Metadata = { robots: { index: false } };

/** "Forgot password": sends a link that opens the change-password page. */
export default async function ForgotPage({ params, searchParams }: PageProps<"/[lang]/forgot">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  const sp = await searchParams;
  const errorText = authErrorText(dict, sp.error);

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{dict.login.forgot_title}</h1>
      <p className="text-muted">{dict.login.forgot_intro}</p>
      {sp.sent === "1" && <AuthNotice text={dict.login.forgot_sent} strong />}
      {errorText && <AuthNotice text={errorText} />}
      <form action={sendPasswordReset} className="flex flex-col gap-3">
        <input type="hidden" name="lang" value={lang} />
        <AuthField label={dict.login.email} type="email" name="email" required autoComplete="email" />
        <button type="submit" className="rounded border border-foreground px-4 py-2 font-medium">
          {dict.login.forgot_button}
        </button>
      </form>
      <Link href={`/${lang}/login`} className="text-sm underline underline-offset-4">
        {dict.login.login_link}
      </Link>
    </div>
  );
}
