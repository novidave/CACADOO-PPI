import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { authErrorText } from "@/lib/authErrors";
import { AuthNotice } from "@/components/AuthField";
import { buttonClass, cardClass, Field, fieldClass } from "@/components/owner/ui";
import { changePassword } from "./actions";
import { PageTitle } from "@/components/owner/PageHead";

export async function generateMetadata({ params }: PageProps<"/[lang]/password">): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { title: (await getDictionary(lang)).login.password_title };
}

/** Change password; the "forgot password" e-mail link lands here, already logged in. */
export default async function PasswordPage({ params, searchParams }: PageProps<"/[lang]/password">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const [dict] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  const sp = await searchParams;
  const errorText = authErrorText(dict, sp.error, sp.message);

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <PageTitle>{dict.login.password_title}</PageTitle>
      {sp.ok === "1" && <AuthNotice text={dict.login.password_saved} strong />}
      {errorText && <AuthNotice text={errorText} />}
      {/* artboard 17: one card, 52 px fields, the black main button */}
      <form action={changePassword} className={cardClass}>
        <input type="hidden" name="lang" value={lang} />
        <Field label={dict.login.password_new} hint={dict.login.password_hint}>
          <input type="password" name="password" required minLength={8} maxLength={72} autoComplete="new-password" className={fieldClass} />
        </Field>
        <Field label={dict.login.password_repeat}>
          <input type="password" name="password_repeat" required minLength={8} maxLength={72} autoComplete="new-password" className={fieldClass} />
        </Field>
        <button type="submit" className={`self-start ${buttonClass}`}>
          {dict.login.password_button}
        </button>
      </form>
    </div>
  );
}
