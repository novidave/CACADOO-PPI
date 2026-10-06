import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { getSession } from "@/lib/auth";
import { authErrorText } from "@/lib/authErrors";
import { AuthField, AuthNotice } from "@/components/AuthField";
import { signUp } from "../login/actions";

export const metadata: Metadata = { robots: { index: false } };

/** Self-service sign-up for shop owners. */
export default async function SignupPage({ params, searchParams }: PageProps<"/[lang]/signup">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const dict = await getDictionary(lang);

  const session = await getSession().catch(() => null);
  if (session) redirect(`/${lang}/dashboard`);

  const sp = await searchParams;
  const errorText = authErrorText(dict, sp.error, sp.message);

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{dict.login.signup_title}</h1>
      <p className="text-muted">{dict.login.signup_intro}</p>
      {sp.sent === "1" ? (
        <AuthNotice text={dict.login.signup_sent} strong />
      ) : (
        <>
          {errorText && <AuthNotice text={errorText} />}
          <form action={signUp} className="flex flex-col gap-3">
            <input type="hidden" name="lang" value={lang} />
            <AuthField label={dict.login.email} type="email" name="email" required autoComplete="email" />
            <AuthField
              label={dict.login.password}
              hint={dict.login.password_hint}
              type="password"
              name="password"
              required
              minLength={8}
              maxLength={72}
              autoComplete="new-password"
            />
            <AuthField
              label={dict.login.password_repeat}
              type="password"
              name="password_repeat"
              required
              minLength={8}
              maxLength={72}
              autoComplete="new-password"
            />
            <button type="submit" className="rounded border border-foreground px-4 py-2 font-medium">
              {dict.login.signup_button}
            </button>
          </form>
        </>
      )}
      <p className="border-t border-line pt-4">
        {dict.login.have_account}{" "}
        <Link href={`/${lang}/login`} className="font-semibold underline underline-offset-4">
          {dict.login.login_link}
        </Link>
      </p>
    </div>
  );
}
