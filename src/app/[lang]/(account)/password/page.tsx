import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { authErrorText } from "@/lib/authErrors";
import { AuthField, AuthNotice } from "@/components/AuthField";
import { changePassword } from "./actions";

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
    <div className="flex max-w-md flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{dict.login.password_title}</h1>
      {sp.ok === "1" && <AuthNotice text={dict.login.password_saved} strong />}
      {errorText && <AuthNotice text={errorText} />}
      <form action={changePassword} className="flex flex-col gap-3">
        <input type="hidden" name="lang" value={lang} />
        <AuthField
          label={dict.login.password_new}
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
        <button type="submit" className="self-start rounded border border-foreground px-4 py-2 font-medium">
          {dict.login.password_button}
        </button>
      </form>
    </div>
  );
}
