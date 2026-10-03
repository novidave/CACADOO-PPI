import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { getSession } from "@/lib/auth";
import { sendLoginLink } from "./actions";

export const metadata: Metadata = { robots: { index: false } };

const ERRORS = ["link", "rate", "email", "config"] as const;

export default async function LoginPage({ params, searchParams }: PageProps<"/[lang]/login">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const dict = await getDictionary(lang);

  const session = await getSession().catch(() => null);
  if (session) redirect(`/${lang}/${session.isAdmin ? "admin" : "dashboard"}`);

  const sp = await searchParams;
  const sent = sp.sent === "1";
  const errorKey = ERRORS.find((e) => e === sp.error);
  const errorText = errorKey ? dict.login[`error_${errorKey}`] : null;

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{dict.login.title}</h1>
      <p className="text-muted">{dict.login.intro}</p>

      {sent && <p className="border border-foreground p-3 font-medium">{dict.login.sent}</p>}
      {errorText && <p className="border border-line p-3">{errorText}</p>}

      <form action={sendLoginLink} className="flex flex-col gap-3">
        <input type="hidden" name="lang" value={lang} />
        <label className="flex flex-col gap-1">
          <span className="text-sm">{dict.login.email}</span>
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            className="rounded border border-line px-3 py-2 outline-none focus:border-foreground"
          />
        </label>
        <button type="submit" className="rounded border border-foreground px-4 py-2 font-medium">
          {dict.login.send}
        </button>
      </form>
      <p className="text-sm text-muted">{dict.login.no_signup}</p>
    </div>
  );
}
