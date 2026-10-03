import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";

// Private pages: never indexed, never cached.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function AccountLayout({ children, params }: LayoutProps<"/[lang]">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);

  return (
    <div className="flex flex-col gap-6">
      <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line pb-3 text-sm">
        <Link href={`/${lang}/dashboard`} className="font-medium underline-offset-4 hover:underline">
          {dict.account.dashboard}
        </Link>
        {session.isAdmin && (
          <Link href={`/${lang}/admin`} className="font-medium underline-offset-4 hover:underline">
            {dict.account.admin}
          </Link>
        )}
        <span className="ml-auto text-muted">{t(dict.account.signed_in_as, { email: session.user.email ?? "" })}</span>
        <form action="/auth/signout" method="post">
          <button type="submit" className="underline underline-offset-4">
            {dict.account.sign_out}
          </button>
        </form>
      </nav>
      {children}
    </div>
  );
}
