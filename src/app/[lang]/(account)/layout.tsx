import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/i18n/config";
import { getDictionary, t } from "@/i18n/dictionaries";
import { requireUser } from "@/lib/auth";
import { AccountNav } from "@/components/AccountNav";

// Private pages: never indexed, never cached.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function AccountLayout({ children, params }: LayoutProps<"/[lang]">) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const [dict, session] = await Promise.all([getDictionary(lang), requireUser(lang)]);
  // "My shop" only for people linked to a shop; the admin may have none.
  const { count } = await session.supabase
    .from("shop_members")
    .select("shop_id", { count: "exact", head: true })
    .eq("user_id", session.user.id);
  const links = [
    ...(count ? [{ href: `/${lang}/dashboard`, label: dict.account.dashboard }] : []),
    ...(session.isAdmin ? [{ href: `/${lang}/admin`, label: dict.account.admin }] : []),
  ];

  return (
    <div className="flex flex-col gap-6">
      <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line pb-3 text-sm">
        <AccountNav links={links} />
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
